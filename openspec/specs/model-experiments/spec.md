# model-experiments Specification

## Purpose
定义如何在既有 prompt fork 上扩展模型与采样参数实验：从同一已封存父 run 的首次请求上下文出发，创建多个真实模型 fork，并让现有分支树与 ComparePanel 使用统一的共同祖先比较语义。

## Requirements

### Requirement: 模型实验复用既有 prompt fork

系统 SHALL 在已封存、非 proxy 且含 `config_hash` 的父 run 上创建模型实验。每个 arm SHALL 通过既有 prompt fork 的从头重跑语义生成独立 run，直接 parent SHALL 相同；不得创建第二套实验记录或把 model 替换伪装成 tool-result replay。

#### Scenario: 创建两个模型分支

- **WHEN** 用户从同一父 run 提交两个不同 model/params 的 arm
- **THEN** 系统为每个 arm 创建独立 fork run，`fork.edit.field` 为 `model_params`，两个 run 的直接 parent 相同，现有分支树可展示它们

#### Scenario: 拒绝不可 fork 父 run

- **WHEN** 父 run 未封存、来源为 proxy 或缺少 `config_hash`
- **THEN** 系统在创建 tracer、文件或模型请求前返回明确配置错误

#### Scenario: 拒绝缺少 system 消息的父 run

- **WHEN** 父 run 首次 `llm.call.request.messages` 中不存在 content 为字符串的 system 消息
- **THEN** 系统在任何文件写入和网络调用前拒绝，并说明启动上下文无法校验

### Requirement: model_params 编辑必须保持真实配置一致

`model_params` 的 edit value SHALL 是 `{ model: string, params?: Record<string, number>, experimentId?: string, allowSideEffects?: boolean }`。系统 SHALL 从父 run 首次 `llm.call.request.messages` 深拷贝启动 messages；system prompt、工具表、`exec.cwd`、`maxIterations` 和 `budget` SHALL 来自完整当前 `RunConfig`，不得从 `config_hash` 反推。模型实验 SHALL 只覆盖 model/params，且新 run 的 `config_hash` SHALL 与父 run 一致。

工具表 SHALL 与父 run 录制的定义逐字段相同，包含 `sideEffect` 字段的**有无**——`configHash` 计入该字段，"补齐缺失标记"会改变指纹并被拒绝。

#### Scenario: 同时修改 model 与 params

- **WHEN** arm 同时提供新 model 和数值 params，且至少一项与父配置不同
- **THEN** 系统使用组合值从头运行，trace 记录 model 和 params，`config_hash` 不因该编辑变化

#### Scenario: 父 run 未录制 params

- **WHEN** 父 run 首次请求不含 `params`，而 arm 提供了数值 params
- **THEN** 系统按父 params 为空对象判定"至少一项实际改变"，实验继续执行

#### Scenario: 拒绝双真相源或非法参数

- **WHEN** 当前 RunConfig.systemPrompt 与首次 messages 的 system 内容不一致，或 params 含非数值/非有限值
- **THEN** 系统在任何文件写入和网络调用前拒绝，且不产生 fork run

#### Scenario: 双真相源先校验后覆写

- **WHEN** 编排层派生出启动上下文后、构造 effectiveConfig 之前
- **THEN** 系统先比较 `RunConfig.systemPrompt` 与派生值并在不等时拒绝，仅在相等时才执行既有覆写，使覆写既不改变结果也不掩盖不一致

### Requirement: 每个 arm 必须使用完整合法的运行配置

系统 SHALL 在执行前构造并校验完整 `RunConfig`：`baseURL`、apiKey、model、systemPrompt、tools、params、`exec.cwd`、`maxIterations` 和 `budget` 均满足现有 agent-loop schema。桌面端 SHALL 使用当前 settings 的单一 baseURL/apiKey；CLI SHALL 使用显式 `REBASEAGENT_API_KEY`。apiKey SHALL NOT 出现在 edit value、trace、日志或错误文本。

#### Scenario: 补齐默认运行配置

- **WHEN** 调用方未提供 maxIterations、budget 或 cwd 的入口默认值
- **THEN** 编排层使用 maxIterations=10、budget.maxTotalTokens=100000 和当前工作目录，再经 RunConfig schema 校验

#### Scenario: 拒绝跨 provider 或缺少密钥

- **WHEN** arms 声明不同 baseURL，或真实执行没有可用 apiKey
- **THEN** 系统在调用模型前拒绝；dry-run 可以在没有 apiKey 时展示计划

### Requirement: 工具必须可执行且无副作用

每个 arm SHALL 传入与 `config.tools` 一一对应的含 handler `Tool[]`。首期实验 SHALL 要求所有工具 `sideEffect === false`；缺少该标记按有副作用处理。任一工具不满足时，系统 SHALL 在创建第一个 run 前拒绝整个实验，不得用 V3a 的 `CassetteLlmClient` 或 `StubToolTable` 冒充真实工具结果。

#### Scenario: pure 工具实验

- **WHEN** 当前工具表每项均明确标记 `sideEffect: false` 且 handler 与声明一一对应
- **THEN** 每个 arm 执行真实 handler，工具结果写入各自 trace，比较可继续进行

#### Scenario: 副作用工具阻断

- **WHEN** 工具表含 `sideEffect: true` 或缺少 sideEffect，且未显式声明 `allowSideEffects`
- **THEN** 系统返回不可执行错误，错误文本说明是哪个工具触发、首期仅支持无副作用工具表，不按 arm 顺序产生外部副作用

#### Scenario: 显式确认副作用后放行并留痕

- **WHEN** 每个 arm 均声明 `allowSideEffects: true` 且用户已确认费用
- **THEN** 系统按 arm 顺序真实执行，该声明随 edit value 写入 `fork.edit` 供审计，UI 在该实验分支标注"顺序执行、外部状态可能已被前一臂改变"；比较判据不变

#### Scenario: CLI 遇到带工具的父 run

- **WHEN** CLI 对含非空工具表的父 run 发起模型实验
- **THEN** 系统返回配置错误并提示改用桌面端，不得以桩工具或空 handler 冒充真实工具结果

### Requirement: 同一批实验必须可分组

一次编排调用 SHALL 视为一批实验，系统 SHALL 为其确定一个 `experimentId`（调用方传入或自动生成），同一批内所有 arm SHALL 相同。该字段 SHALL 随 edit value 写入 `fork.edit`，仅用于 UI 分组与 ComparePanel 默认配对，不参与校验、`config_hash` 或比较判据。

#### Scenario: 同批 arm 自动配对

- **WHEN** 用户在同一批实验下创建三个 arm
- **THEN** 三个 fork run 的 `fork.edit.value.experimentId` 相同，UI 将其归为一组并默认一起比较

#### Scenario: 多批实验共存

- **WHEN** 同一父 run 上先后进行两批实验，产生多个同父兄弟 run
- **THEN** UI 按 `experimentId` 分开展示，不把不同批的 arm 混为一组

### Requirement: 多臂执行隔离失败并保留分支

系统 SHALL 默认顺序执行至少两个 arm；每个 arm 使用独立 messages 深拷贝、tracer、LLM client、`AbortController` 和 run id，各 controller 挂到同一父 signal 上级联取消且不误伤已完成 arm。provider 错误、工具错误、预算耗尽或取消 SHALL 只影响当前 arm；已完成 run SHALL 保留，未开始 arm SHALL 不创建文件；系统 SHALL NOT 自动重试。

#### Scenario: 一臂失败

- **WHEN** arm A 完成而 arm B provider 报错
- **THEN** A 的 fork run 保留，B 记录已有 error outcome，其他 arm 仍可执行，命令返回部分失败状态

#### Scenario: 取消实验

- **WHEN** 用户在 arm B 运行期间取消
- **THEN** B 使用 AbortSignal 终止，后续未开始 arm 不创建 run，已完成 A 不受影响

### Requirement: 成本确认和 dry-run 必须显式

真实执行 SHALL 在 CLI 要求 `--confirm-cost`，在桌面端要求用户明确确认；确认提示 SHALL 列出当前单一 provider、每个 model/params arm、预计调用臂数和工具策略。CLI SHALL 以独立 bin `rebaseagent-model-ab` 暴露，不与 V3a 的 `rebaseagent-trace-test` 合并。`--dry-run` SHALL 只做校验和展示，不需要 apiKey、不联网、不创建文件。没有调用方提供的价格估算器时成本 SHALL 为 unknown，不得内置或臆造价格。

#### Scenario: 未确认时阻断真实调用

- **WHEN** 用户未提供确认参数或未在桌面确认
- **THEN** 系统不发起网络请求，返回可操作的确认错误

#### Scenario: dry-run 无密钥

- **WHEN** 用户使用 `--dry-run` 且未配置 apiKey
- **THEN** 系统显示校验后的执行计划，不读写 trace、不调用 provider

### Requirement: 比较沿用共同祖先和现有派生口径

模型实验 SHALL 复用现有 `deriveComparison` 的共同祖先判定、`deriveChainTotals` 的链路累计和 ComparePanel 的状态展示。只有直接 parent 相同、父链完整、run 已封存且配置/工具前置校验通过时，结果才可比较；不得在包层复制指标派生函数。原始 trace 内容 SHALL 保持完整，UI 使用折叠而非截断丢弃。

系统 SHALL 只展示各臂相对父 run 的累计增量，SHALL NOT 产出臂间差值、胜出臂或最佳模型结论；沿链数字沿用既有措辞纪律，禁用"总耗时 / 总成本"。

#### Scenario: 共同祖先可比

- **WHEN** 两个 model_params fork 均从同一父 run 创建并封存
- **THEN** ComparePanel 判定存在共同祖先，分别展示 outcome、tokens、duration、工具轨迹和各自相对父 run 的累计增量

#### Scenario: 父链缺失或结果未封存

- **WHEN** 任一 arm 的父链断裂、run 未封存或工具策略校验未通过
- **THEN** ComparePanel 显示不可比较及明确原因，不计算增量差值或最佳模型结论

### Requirement: 既有能力必须保持兼容

实现 SHALL 保持 trace v1、既有 `runs:fork`、`proxy:fork`、system/user prompt fork、`config_hash` 门禁和 JSONL reader 的行为不变。`ForkSchema` SHALL 无需迁移，旧的自由 string edit.field SHALL 继续可读。

#### Scenario: 既有 fork 回归

- **WHEN** 新增模型实验后运行既有 tool-result、prompt fork 和 proxy fork 测试
- **THEN** 原有 parent 链、config_hash 校验、真实工具/代理语义和 UI 展示保持通过
