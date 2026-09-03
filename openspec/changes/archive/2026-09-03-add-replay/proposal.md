# Proposal: add-replay

## Why

前三个 Spec 交付了"录制"能力：trace-sdk 定义格式、agent-loop 产生 trace、desktop-ui 让人**看见**一次运行。但产品的核心承诺尚未兑现——"不止回放，而是让你改变它"。当前所有 run 一经封存便不可触碰，调试者只能看录像，不能回到第 N 步、改一步的工具结果、看 Agent 会不会走出不一样的结局。此为路线图 MVP 的最后一块，也是产品灵魂：**时间旅行最小切片（replay）**。

本变更把"编辑已录制 span 的 tool_result、从该步重跑"从概念变成可运行的代码：从已完成 run 的文件出发，构造分叉 run（fork run）并落盘为新的 JSONL，全程前缀零 API 调用（复用录制请求做状态恢复），只在分叉点之后才真调 LLM。

## What Changes

- 新增 `packages/replay`：纯 TS 库（**零 Electron 依赖**，CI 可跑），时间旅行编排器
  - `deriveReplayState`（纯函数）：输入父 run 的解析记录（含 resolveBranch 展开后的完整轨迹）与分叉点（`at_span` + 编辑值），输出分叉后首次 LLM 调用的完整 messages 前缀 + 新的 fork 元数据
  - 核心洞察：**前缀零 API 不需要"重放"，而是"截断 + 拼接"**——取分叉点前最后一个 `llm.call` 的录制 `request.messages`（原样录制、可直接作为 loop 输入），把被编辑的 `tool.invoke` 的 result 替换为新值，即得"如果当时工具返回了 X，模型下一步会看到什么"的完整上下文。无需调用任何 LLM
  - `replayRun`（编排函数）：加载父 run → 校验（已封存、config_hash 一致、分叉点合法）→ 派生状态 → 以新 JsonlTracer 跑 agent-loop 的 `runLoop`（从分叉后的 messages 起跑，后续步骤真调 LLM）→ 落盘 fork run（`meta.parent` / `meta.fork` 正确写入）
- 修改 `packages/agent-loop`：
  - `runLoop` 增加可选 `forkRun` 注入：允许调用方指定新 run 的 `id` / `parent` / `fork`（当前写死 `parent: null, fork: null` 且 id 自动生成）。其余四不变量不变
  - `config_hash` 校验：fork 重跑前比对父 run 的 config_hash 与本次 config 指纹，不一致拒绝启动（源程序变了，重放无意义）
- 修改 `apps/desktop`：
  - IPC 增 `runs:fork`：请求体 = `{ parentRunId, atSpanId, edit: { field, value } }`，main 侧加载父 run → 校验 → 调 `replayRun` 真跑 → 返回新 run id
  - preload 暴露 `forkRun`；renderer 侧 DetailPanel 增加"在此重跑"入口：选中一个 `tool.invoke` span → 编辑其 result → 提交
  - 重跑需 LLM 接入（apiKey/baseURL/model）：新增最小"运行配置"对话框，safeStorage 加密持久化（Spec #3 的 Non-goal 至此解除，属 Spec #4 内）
  - 新 run 生成后列表自动刷新、自动选中分支 run，走既有 `resolveBranch` 展示合并轨迹
- trace-format：**无格式变更**。`fork` 字段与 `resolveBranch`（Spec #1/#3 已实现）本就是这个用途，本次只是第一次真正**创建** fork run（此前 r_02 分支 fixture 是手工编的）

### 从讨论定稿、本次必须落实的细节

1. **编辑目标限定 `tool.invoke` 的 `result` 字段**：README MVP 明确定义"编辑已录制 span 的 tool_result"。改 prompt / 编辑 llm.call / 多分支对照实验归 v2
2. **前缀零 API 的实现 = 截断拼接，不是重放**：deriveReplayState 只在分叉点**之前**最后一个 llm.call 的 request.messages 上做替换。分叉点之前任何一次 LLM 调用都不会真的发出（零 API、零成本、确定性）。分叉点后的第一次调用及后续步骤走真实 LLM
3. **config_hash 一致性是硬前提**：重跑使用与父 run 相同的 system prompt 与工具表才可重放；换了源码就是新的实验，不允许挂到旧 run 上做 fork（v2 的模型 A/B 再放开）
4. **只从已完成（封存）的 run 分叉**：沿用 `assertForkable`，crashed run 缺终止事件、前缀不稳定，禁止分叉
5. **父 run 可以是分支 run**：从 r_02（branch fixture）再分叉应得到以 r_02 为父的新 run，`resolveBranch` 展开三层链。递归合法性由既有链式解析保证
6. **真实 API 消耗纪律**：全仓自动化测试零真实 API（mock fetch）；真调只在用户手工冒烟与真实使用时发生
7. **safeStorage 最小化**：desktop 增"运行配置"对话框，apiKey 经 Electron safeStorage 加密后持久化到数据目录；不可用（如 Linux 无 keyring）时降级明文 + 明示风险。不进 AppData/注册表（延续便携策略）

## Capabilities

### New Capabilities

- `replay`：时间旅行最小切片——从已完成 run 派生 fork 状态、校验可重放性、经 agent-loop 重跑并落盘 fork run 的行为契约

### Modified Capabilities

- `agent-loop`：`runLoop` 支持 fork run 元数据注入（id/parent/fork）与 config_hash 一致性前置校验（新增可选入参，既有行为不变）
- `desktop-ui`：从只读查看升级为可发起分叉重跑——新增 `runs:fork` 通道与"在此重跑"交互、运行配置（safeStorage 持久化）

## Non-goals

- 不做改 prompt / 编辑 llm.call 请求（v2 完整时间旅行；本变更的 IPC 信封结构预留 `field` 扩展位，但只实现 `result`）
- 不做多分支对照实验 UI / 分支树（v2）
- 不做工具执行沙箱（chroot/容器/进程隔离）：重跑的工具调用与首次运行同权限、同 cwd，靠"错误是数据"兜底。真沙箱属后续安全增强
- 不做录制 SSE 原始 chunk / 字节级确定性重放（Trace-as-Test 属 v3，需要 chunk 级录制）
- 不做自动修复循环（编辑→重跑→看结果→再编辑是用户手工操作）
- 不新增 trace 格式字段、不改 format_version
- 不做 run 删除/归档 UI（删除保护已在 trace-sdk，UI 后置）

## 边界声明（保真度）

时间旅行只覆盖 **loop 内状态**（messages 演化），不承诺外部状态源：

- 重跑时工具**真实再次执行**：如果工具带副作用（写文件、调外部 API），分叉点后的行为可能与首次运行不同——这正是时间旅行的目的（看"如果当时返回 X 会怎样"），但**不保证**外部系统状态可回退。工具的 `sideEffect` 标注（Spec #2 预埋）本次仍不参与执行判定，仅随请求体原样透传
- 前缀状态来自录制文件：**父 run 文件不可变**（只读引用），新状态全部写入 fork run 自己的文件
- config_hash 不一致 → 拒绝 fork（诚实：换源码后的重跑不是"时间旅行"而是新实验，不允许伪装成分支）
- 只读阶段的桌面能力（浏览/派生统计）行为不变

## Impact

- 新增包：`packages/replay`（依赖 `@rebaseagent/trace-sdk`、`@rebaseagent/agent-loop`；测试用 vitest + mock fetch，零网络）
- 修改包：`packages/agent-loop`（runLoop 入参扩展，向后兼容）、`apps/desktop`（IPC/preload/UI/运行配置）
- 主 spec 同步：新增 `openspec/specs/replay/spec.md`；`agent-loop` / `desktop-ui` 主 spec 各加 delta
- 无破坏性变更：既有 run 文件、既有 UI 只读路径、既有测试全部不受影响；旧调用 `runLoop(config, messages, tracer, tools, llm)` 仍可用（新参数可选）
- 测试：replay 纯函数（deriveReplayState）与编排（replayRun，mock LLM）全零 API；desktop 增 fork 通道的派生层测试；冒烟阶段可用现有 fixtures（normal/branch）手工验证一次真实分叉
