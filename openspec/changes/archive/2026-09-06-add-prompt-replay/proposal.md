# Proposal: add-prompt-replay

## Why

当前时间旅行只允许编辑 tool.invoke.result。这已经能回答“如果某个工具当时返回了另一份数据，Agent 会怎样”，但还不能回答另一类高频问题：

- system prompt 的约束是否写错了？
- 初始用户指令换一种写法，Agent 是否会选择另一条路径？
- 同一份 trace，修改上下文后结果是否改善？

这正是 v2 “完整时间旅行”的剩余核心。现有 config_hash 不一致时拒绝分叉，是为了防止把“源码已经变化”伪装成同源 replay；prompt fork 应该显式成为另一种语义，而不是放宽这个校验。

## What Changes

- 新增 prompt fork 能力：从一个已完成、含 config_hash 的 SDK / agent-loop run 出发，一次只编辑启动上下文中的 system prompt 或首条 user message，从头执行一次新的 run。
- prompt fork 保留 parent 与 fork 元数据，便于分支树展示探索关系；但新 run 记录完整的新 spans，不声明共享父 run 的可重放前缀。
- fork.edit.field 增加两个受支持的值：system_prompt、user_message。编辑值写入 fork 元数据，详情中可查看；列表仍只透传字段摘要，不透传 value。
- replay 编排层增加独立的 prompt fork 入口与校验，不改变现有 tool_result replay 的 config_hash 同源校验和前缀拼接语义。
- 调试台在 run 详情提供 prompt 编辑入口，确认前明确提示“将从头重跑，前缀不可复用”；完成后可从分支树进入新 run 查看结果。
- prompt fork 的新 run 在详情中按“独立新轨迹 + 父级溯源”呈现，禁止将父 run 的旧 spans 与新 spans 拼接成假时间线。
- prompt fork 的 at_span 固定锚定父 run 的首次 llm.call；该 span 的 request.messages 正是被编辑启动上下文的事实来源。

## Capabilities

### New Capabilities

- prompt-replay：启动上下文编辑、prompt fork 校验、从头重跑、父级溯源及详情呈现语义。

### Modified Capabilities

- replay：增加 prompt fork 分支；保留现有 tool_result replay 的 world-free 与同源校验。
- desktop-ui：增加 prompt 编辑入口、prompt fork 状态提示和独立轨迹呈现。
- branch-tree：识别并标注 prompt fork 的边；不把 prompt fork 当作共享前缀分支计算链路。

## Non-goals

- 不编辑任意中间历史消息。本 change 只支持首次 loop 请求中的 system prompt 和首条 user message；中间消息编辑需要另一个 change 定义定位与语义。
- 不在一次 fork 中同时修改 system prompt 与 user message。一次只改一个变量，组合实验通过连续 fork 完成。
- 不修改代理的 messages 单请求级分叉。代理 fork 继续走 proxy:fork，不接入 agent-loop replay。
- 不放宽既有 tool_result replay 的 config_hash 一致性校验。prompt fork 是显式的新实验，不是同源时间旅行。
- 不承诺 prompt fork 命中原 run 的 prompt cache；system prompt 变化时前缀天然不同，user message 变化时也只可能由 provider 自行决定缓存命中。
- 不执行副作用工具的回滚或隔离。prompt fork 沿用当前 agent-loop 的工具执行权限和 world-free 保真度边界；COW overlay / 快照另行处理。
- 不做自动 A/B 排名、胜负评判或最终文本相似度打分。只提供分支结果和已有指标。
- 不做预算地图“手术预览”。编辑期间的 token 预估和超预算预演单独作为后续 change。
- 不引入新的 tokenizer、模型 SDK 或外部服务依赖。

## 边界声明（保真度）

- prompt fork 只保证：新 run 使用用户确认后的启动上下文，从头经同一 agent-loop 执行，并完整记录新轨迹。
- 它不保证与父 run 的工具、副作用、外部 API、RAG、数据库状态一致；这些外部状态仍按现有 replay 约定属于 best-effort。
- 父 run 只作为溯源和对照基线，不作为新 run 的上下文事实源；新 run 的每个 span 都来自本次实际执行。
- proxy 录制 run 没有 config_hash，不允许走本 change 的 prompt fork；它仍只能编辑完整 messages 后经代理重发。
- 父 run 首次 llm.call 中不存在字符串形式的 system message 时，整个 prompt fork 不可用；桌面端无法重建 RunConfig.systemPrompt，系统不从 config_hash 反推，也不凭空假定空字符串。

## Impact

- packages/replay：增加 prompt fork 的纯数据构造和编排入口；现有 deriveReplayState 保持 field: result 语义不变。
- packages/agent-loop：复用现有 runLoop 与 forkRun 注入，不改变消息追加、计数派生和请求体稳定性不变量。
- packages/trace-sdk：优先复用现有自由字符串 fork.edit.field，不升级 format_version；仅补 schema / guard 的场景测试。
- apps/desktop：详情页 prompt 编辑器、main IPC 新入口、独立轨迹判断、分支树字段标签。
- 测试：replay 纯函数与编排测试、trace schema 兼容测试、desktop IPC / UI 派生测试、至少一条零 API 的端到端 fixture。

## 验收门禁

- 现有 tool_result replay 测试全部不变且通过。
- prompt fork 的父文件逐字节不变，新文件可被 readRun 读取。
- prompt fork 新轨迹不经过 resolveBranch 拼接父 spans；详情显示完整新轨迹，并展示父 run 与修改摘要。
- system prompt / 初始 user message 未变化时拒绝空 fork。
- system prompt fork 的新 config_hash 与首次真实请求中的 system message 必须对应同一编辑值，禁止出现双真相源。
- proxy run、缺失 config_hash、缺失字符串 system 消息、未封存父 run、非法编辑目标均在创建文件前明确拒绝。
- Biome、双端 TypeScript 检查、Vitest、electron-vite build 和 GUI 冒烟全部通过。

## 已确认决策

- 只允许编辑首次 llm.call 请求中的首条 role=user 消息。
- at_span 固定为首次 llm.call 的真实 span id；UI 对 prompt fork 显示“从头重跑”，不把该 id 呈现成普通分叉点。
- 一次 fork 只允许修改 system prompt 或 user message 其中一项；连续 fork 覆盖组合实验。
- prompt fork 从头真实调用模型并计费，不承诺复用父 run 的缓存前缀。
- prompt fork 保留 parent 用于溯源和对照，但详情不走 resolveBranch，不拼接父 spans。
- 缺失字符串 system 消息时，system prompt 与 user message 两种 prompt fork 均拒绝；仅有 config_hash 不足以重建 RunConfig.systemPrompt。
