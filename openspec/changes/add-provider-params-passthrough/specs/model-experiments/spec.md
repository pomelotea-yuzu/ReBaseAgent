# model-experiments Delta: 标量参数透传与生效性告警

## MODIFIED Requirements

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

## ADDED Requirements

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
