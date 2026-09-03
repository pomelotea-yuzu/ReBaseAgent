# Design: add-replay

## Context

前三块（trace-format → agent-loop → desktop-ui）已交付"录制与查看"。现需落地 MVP 最后一块：时间旅行最小切片。动机见 proposal.md，行为要求见 specs/replay/spec.md（新 capability）与 specs/{agent-loop,desktop-ui}/spec.md（delta）。

关键既有事实（设计约束）：

- `resolveBranch`（trace-sdk）已能把父链前缀 + 分支新增 spans 展开为完整轨迹；fork run 文件自身只存"分叉点之后"的内容
- `llm.call` 的 `request.messages` 是**原样录制**（schema 注释明言"可直接作为 loop 输入（查表，无需重建）"）——这是前缀零 API 的地基
- `runLoop(config, messages, tracer, tools?, llm?)` 是纯函数式：给定任意初始 messages 都能续跑
- `run.meta.fork` schema 早已存在（Spec #1 定义），只差**创建** fork run 的代码
- desktop 只读 UI 齐全；IPC 信封 `{ ok, data | error }` 与 zod 校验贯通三层

## Goals / Non-Goals

**Goals:**

- 首次真正**产生** fork run 文件（此前 r_02 分支是手工 fixtures）
- 前缀零 API：deriveReplayState 纯数据变换（截断 + 单点替换），不重放、不调用
- config_hash 一致是 fork 的硬前提（换源码 = 新实验，不允许伪装分支）
- 桌面端唯一的写路径：`runs:fork`，用户显式编辑确认后才触发

**Non-Goals:**

- 不改 prompt / 编辑 llm.call（v2）；不做沙箱隔离（同权限重跑）；不做 chunk 级录制回放（v3）；不新增 trace 格式字段（见 proposal Non-goals）

## Decisions

### D1：前缀零 API = "截断拼接"而非"逐步重放"

派生起点状态只有两个操作：**截断**到分叉点前最后一个 llm.call 的 request.messages，**替换**其中被编辑 tool 消息的 content。为什么不是从 run 开头逐 span 重放？——录制 messages 本身就是 loop 的合法输入（原样性保证），重放反而要复刻 loop 内部消息构造逻辑，既重复又易漂移。截断拼接把"回到第 N 步"降为一次数组切片 + 一次对象替换。

被编辑 tool 消息的定位：分叉点 `at_span` 是该 tool.invoke 的 span id；对应 messages 中的 tool 消息通过**顺序对应**（父轨迹中该 tool.invoke 之前同 step 的 tool 结果 + 分叉点本身的 tool 结果按执行序排列在 messages 尾部）。实现细节：从分叉点 span 向前数到该 step 起点，用 step 内工具执行次序索引 messages 中 role=tool 的消息。

风险：若未来支持编辑 llm.call 内层消息，定位会变复杂——本次 `field` 只开放 `result`（v2 再加），把定位算法收窄到可验证的最小面。

### D2：fork run 元数据注入走 runLoop 可选第 6 参 `forkRun`

不改 runLoop 的纯函数内核：新增参数仅提供 `{ id, parent, fork }`，在 `startRun` 时覆盖默认值。既有五次调用（4 测试 + examples 若存在）全部不用改。备选：让 replay 自己写 meta 首行再交给 runLoop——破坏 Tracer"startRun 写首行"的封装，弃。

### D3：config_hash 校验在 replay 编排层做，不在 runLoop 内

runLoop 无父 run 概念（它不知道自己在被 fork）；replayRun 加载父 run 后先比对 `configHash(systemPrompt, tools)` 与 `parent.meta.config_hash`，不一致即拒绝。runLoop 的 forkRun 注入**信任调用方已校验**（编排层职责）。

### D4：桌面写路径 = 一个新增 IPC 通道，不扩散

只加 `runs:fork` 一个 handle；preload 只多暴露一个 `forkRun` 方法；renderer 触发点在 DetailPanel 的 tool.invoke 卡片。保持"renderer 零 fs、跨进程数据过 zod、错误收敛信封"三条既有纪律。运行配置（apiKey）不经过 IPC 返回给 renderer——设置写入走单向通道，读取时 main 只回 `{ configured: boolean }`，避免密钥进渲染层。

### D5：safeStorage 加密 + 明文降级

apiKey 持久化优先 `safeStorage.encryptString` 写 `<数据目录>/settings.json`（base64）；`isEncryptionAvailable()` 为 false（Linux 无 keyring）时降级明文并附 `"encrypted": false` 标记，UI 明示风险。数据目录内读写，不碰 AppData/注册表（便携策略）。

### D6：真实工具重跑但错误是数据

不实现沙箱（chroot/容器）。重跑工具与首次同权限同 cwd 执行——若副作用破坏环境导致后续工具失败，错误以 tool_result 流入 trace（既有语义），不中断 loop。诚实边界在 replay spec"分叉点后的工具真实执行且错误是数据"Requirement 写明。

## Risks / Trade-offs

- 前缀只读引用父文件 → fork 后父文件若被删，resolveBranch 报"父 run 缺失"：可接受（既有行为，trace-sdk 已处理），不额外做文件锁
- safeStorage 明文降级 → 数据目录明文存 apiKey 有泄露风险：以 UI 明示 + `encrypted: false` 标记缓解；便携数据目录本就在用户掌控内
- runLoop 第 6 参让签名变长 → 用 options 对象聚合（`forkRun` 单对象），不逐字段加参
