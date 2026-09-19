# model-experiments Specification

## Purpose
定义如何在既有 prompt fork 上扩展模型与采样参数实验：从同一已封存父 run 的首次请求上下文出发，创建多个真实模型 fork，并让现有分支树与 ComparePanel 使用统一的共同祖先比较语义。

## Requirements

### Requirement: 模型实验复用既有 prompt fork

系统 SHALL 在已封存且含 config_hash 的非隔离父 run 上创建模型实验；proxy 来源在满足指纹条件时 SHALL 与普通引擎 run 同等允许。每个 arm SHALL 通过 prompt fork 从头执行，直接 parent 相同，不建立第二套实验记录或把换模型伪装成 tool-result replay。空工具表父本 SHALL 允许实验，指纹按空表计算。首期带 workspace 的隔离父本 SHALL 在整批预检时拒绝，包括 dry-run 和显式 allowSideEffects，不能借此降级到普通 handler。

#### Scenario: 创建两个模型分支
- **WHEN** 用户从同一合法非隔离父 run 提交两个不同 model/params arm
- **THEN** 创建独立 fork run，edit.field=model_params，直接 parent 相同，既有分支树可展示

#### Scenario: 含 config_hash 的 proxy run 创建 A/B
- **WHEN** 已封存非隔离 proxy run 有 config_hash、字符串 system 且工具表为空
- **THEN** 每臂独立从头执行，config_hash 与父一致

#### Scenario: 拒绝不可 fork 父 run
- **WHEN** 父 run 未封存或缺 config_hash（含历史代理记录）
- **THEN** 在创建 tracer/文件/模型请求前拒绝；proxy 缺 hash 仍按 no_system/invalid_tool/未知给出重新录制、修正定义或重发提示

#### Scenario: 拒绝缺少 system 消息的父 run
- **WHEN** 首次请求不存在字符串 system 消息
- **THEN** 在任何文件写入和网络调用前拒绝，并说明启动上下文无法校验

#### Scenario: 带工具的代理父本沿用既有门禁
- **WHEN** 非隔离代理父本携带非空工具表
- **THEN** 未知桌面工具仍被拒绝；缺 sideEffect 仍按有副作用处理，未显式 allowSideEffects 前拒绝

#### Scenario: 隔离实验无降级逃生通道
- **WHEN** 父本带 workspace，无论 dry-run 或全部 arm 声明 allowSideEffects:true
- **THEN** 整批明确拒绝本期不支持隔离 A/B，零运行文件、零 LLM、零 handler 执行

### Requirement: model_params 编辑必须保持真实配置一致

`model_params` 的 edit value SHALL 是 `{ model: string, params?: Record<string, string | number | boolean>, experimentId?: string, allowSideEffects?: boolean }`。params 的每个值 SHALL 是 JSON 标量（string / number / boolean）；嵌套对象、数组、`null` SHALL 在任何文件写入和网络调用前拒绝。系统 SHALL 从父 run 首次 `llm.call.request.messages` 深拷贝启动 messages；system prompt、工具表、`exec.cwd`、`maxIterations` 和 `budget` SHALL 来自完整当前 `RunConfig`，不得从 `config_hash` 反推。模型实验 SHALL 只覆盖 model/params，且新 run 的 `config_hash` SHALL 与父 run 一致。

params 覆盖语义维持**整体替换不合并**：arm 给出 params 时父 run 录制值整体让位。父 run 录制 params 中的非标量项 SHALL 在派生父值时静默过滤（与既有数值过滤同义），空 fork 判据按过滤后的父值比较。

工具表 SHALL 与父 run 录制的定义逐字段相同，包含 `sideEffect` 字段的**有无**——`configHash` 计入该字段，"补齐缺失标记"会改变指纹并被拒绝。

#### Scenario: 同时修改 model 与 params

- **WHEN** arm 同时提供新 model 和标量 params（如 `reasoning_effort: "none"`），且至少一项与父配置不同
- **THEN** 系统使用组合值从头运行，trace 记录 model 和 params，`config_hash` 不因该编辑变化

#### Scenario: 父 run 未录制 params

- **WHEN** 父 run 首次请求不含 `params`，而 arm 提供了标量 params
- **THEN** 系统按父 params 为空对象判定"至少一项实际改变"，实验继续执行

#### Scenario: 拒绝双真相源或非法参数

- **WHEN** 当前 RunConfig.systemPrompt 与首次 messages 的 system 内容不一致，或 params 含非标量值（对象 / 数组 / null）、保留键（`model` / `messages` / `tools` / `stream` / `stream_options`）
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

每个 arm SHALL 传入与 config.tools 一一对应的 Tool[]。对非隔离父本，默认 SHALL 要求全部 sideEffect===false，缺标记按有副作用；不满足时在首个 run 前整批拒绝，不以卡带或桩冒充真实执行。非隔离父本保留显式 allowSideEffects 的既有授权路径；该授权 SHALL NOT 绕过隔离父本拒绝规则，也不承诺隔离外部文件、网络和数据库。

#### Scenario: pure 工具实验
- **WHEN** 非隔离工具表均明确 sideEffect:false 且 handler 一一对应
- **THEN** 每臂真实执行 handler，结果写入自己的 trace，比较继续

#### Scenario: 副作用工具阻断
- **WHEN** 非隔离工具表含 sideEffect:true 或缺标记，未显式 allowSideEffects
- **THEN** 返回不可执行错误并指出工具，不按 arm 顺序产生外部副作用

#### Scenario: 显式确认副作用后放行并留痕
- **WHEN** 非隔离父本的每个 arm 声明 allowSideEffects:true 且已确认费用
- **THEN** 仍按顺序真实执行，声明写入 fork.edit，UI 标注“顺序执行、外部状态可能已被前一臂改变”，比较判据不变

#### Scenario: CLI 遇到带工具的父 run
- **WHEN** CLI 对非空工具表父本发起实验
- **THEN** 返回配置错误，不以桩或空 handler 冒充真实结果；非隔离父本可提示改用桌面，隔离父本明确提示本期不支持隔离 A/B

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

dry-run 与执行前的确认展示 SHALL 包含每臂的**最终生效 params**：arm 显式给出的项 SHALL 标注为"覆盖"（父已有）或"新增"（父没有），父 run 录制值中因整体替换而被丢弃的项 SHALL 逐项列出。

plan 条目 SHALL 携带四个字段并由编排层计算一次：`params`（最终生效）/ `overridden`（arm 显式给出的键）/ `discarded`（被丢弃的父录项）/ `warnings`（知识库命中）。CLI 与桌面 SHALL 只读这些字段渲染，SHALL NOT 各自重算。没有调用方提供价格估算器时成本 SHALL 为 unknown，不得内置或臆造价格。

#### Scenario: 未确认时阻断真实调用

- **WHEN** 用户未提供确认参数或未在桌面确认
- **THEN** 系统不发起网络请求，返回可操作的确认错误

#### Scenario: dry-run 无密钥

- **WHEN** 用户使用 `--dry-run` 且未配置 apiKey
- **THEN** 系统显示校验后的执行计划（含每臂最终生效 params 与被丢弃的父参数项），不读写 trace、不调用 provider

#### Scenario: dry-run 暴露整体替换的代价

- **WHEN** 父 run 录制 `num_predict=768`，某臂 params 只给出 `temperature=0.7`
- **THEN** dry-run 明确列出该臂最终生效 params 不含 `num_predict`（已被整体替换丢弃，逐项列于 `discarded`），用户在真实执行前可见

#### Scenario: dry-run 每臂三段固定展示

- **WHEN** 某臂 params 含 `temperature=0.7` 与 `num_ctx=8192`，父 run 录制 `num_predict=768`，baseURL 指向本机 Ollama
- **THEN** CLI 与桌面在该臂下展示三段：`生效 params`（`temperature=0.7（覆盖）`）、`丢弃父录值`（`num_predict=768`）、`⚠ 告警`（`num_ctx` 静默忽略与绕行方式）；无丢弃项时省略第二段，无告警时省略第三段，两端的字段语义 SHALL 一致

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

### Requirement: 已知静默忽略参数必须告警

系统 SHALL 内置"已知静默忽略"知识库（首期两条实测记录：Ollama `/v1` 静默忽略 `num_ctx`；Ollama `/v1` 顶层 `think` 无效），并按运行配置的 baseURL 启发式识别 provider。当臂 params 或父 run 录制 params 含知识库命中的键时，系统 SHALL 在 CLI 输出警告、在桌面端编辑器与执行前展示警示，内容含参数名、风险描述与实测过的绕行方式。告警 SHALL NOT 阻断执行——知识库基于抽样实测，未命中 SHALL NOT 被解读为"参数已生效"。

#### Scenario: Ollama 臂带 num_ctx 告警

- **WHEN** baseURL 指向本机 Ollama（如 `http://127.0.0.1:11434/v1`）且某臂 params 含 `num_ctx`
- **THEN** CLI 与桌面端在该臂执行前输出警告：`num_ctx` 在 `/v1` 被静默忽略，绕行方式为派生模型（Modelfile `PARAMETER num_ctx`）；告警不阻止执行

#### Scenario: 非 Ollama 不误报

- **WHEN** baseURL 指向 DeepSeek 且臂 params 含 `num_ctx`
- **THEN** 不触发 Ollama 条目的告警（知识库条目按 provider 限定）

#### Scenario: 未命中不等于已生效

- **WHEN** 臂 params 含知识库未收录的键（如 `presence_penalty`）
- **THEN** 系统不告警也不承诺该参数生效；dry-run 的生效 params 展示仅陈述"请求将携带"，不陈述"provider 已采纳"

### Requirement: CLI arm 语法接受标量并显式区分类型

CLI 的 `--arm` 语法 `model;key=value` SHALL 按固定顺序解析值类型：`true`/`false`（严格小写）→ boolean；合法 JSON number → number；引号包裹 → 强制字符串；其余按原字符串。引号是字符串的唯一显式标记，SHALL 支持且仅支持 `\"` 与 `\\` 两种转义；其他转义序列（`\n`/`\t`/`\uXXXX`）SHALL 报该 arm 的中文错误而非静默按字面量处理。首字符为 `"` 但未包裹到值末尾、或值中间出现裸 `"`，SHALL 报错。空字符串（`k=""`）SHALL 是合法值。既有数值 arm（`model;temperature=0.2`）的解析结果 SHALL 不变。

#### Scenario: 四种标量解析

- **WHEN** arm 为 `m;think=false;temperature=0.2;level=high;k="123"`
- **THEN** 解析结果为 `think: false`（boolean）、`temperature: 0.2`（number）、`level: "high"`（string）、`k: "123"`（string，引号强制），四者语义稳定

#### Scenario: 支持与拒绝的转义

- **WHEN** arm 为 `m;k="a\"b\\c"`（合法转义）或 `m;k="a\nb"`（不支持转义）
- **THEN** 前者解析为字符串 `a"b\c` 并继续；后者报该 arm 的中文错误并给出示例，不静默按字面量处理

#### Scenario: 未闭合引号报错

- **WHEN** arm 为 `m;k="a"b"` 或 `m;k=a"b`
- **THEN** 解析失败并报该 arm 的中文错误（引号未包裹整个值 / 值中出现裸引号），不产生静默的字符串结果

#### Scenario: 既有数值 arm 回归

- **WHEN** arm 为既有形态 `m;temperature=0.2;top_p=0.9`
- **THEN** 解析结果与本次变更前逐字节相同（走 number 分支）
