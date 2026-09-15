# agent-loop Specification

## Purpose

定义 Agent 执行循环的行为契约：如何配置一次运行、如何流式调用 OpenAI 兼容协议的 LLM、如何执行工具、何时终止，以及如何经 Tracer 输出全部观测。它是 trace 格式（Spec #1）的生产者，也是后续时间旅行/重放（Spec #4）的被观测对象。

## Requirements

### Requirement: RunConfig 定义一次运行的全部输入

`RunConfig` SHALL 包含：模型接入（`baseURL`、`apiKey`、`model`）、`systemPrompt`、工具表、采样 `params`、`exec = { cwd, signal }`（cwd 为工具执行落点，signal 为 AbortSignal）、`maxIterations`、预算上限（`maxTotalTokens` 或 `maxCost`，至少其一）。配置 SHALL 经 zod 校验，非法配置在运行开始前报错。

采样 `params` 的每个值 SHALL 是 JSON 标量（`string | number | boolean`）；嵌套对象、数组、`null` SHALL 在校验时拒绝。`params` 的键 SHALL NOT 与请求体保留键冲突；保留键集 SHALL 由单一导出常量 `RESERVED_BODY_KEYS`（定义于 `config.ts`，值 `["model","messages","tools","stream","stream_options"]`）定义，且 SHALL 是 `buildRequestBody` 构造的固定键集的唯一事实来源；冲突 SHALL 在运行配置校验阶段拒绝并指明冲突键——采样参数平铺进请求体顶层，保留键冲突等于请求体注入。既有数值 params SHALL 保持原样合法（纯类型放宽，无迁移）。

`buildRequestBody` SHALL NOT 在保留键上被 params 覆盖（守卫在校验阶段已保证，构造阶段不重复检查）；其文档注释 SHALL 引用 `RESERVED_BODY_KEYS`，声明"新增固定键必须同步该常量"。

#### Scenario: 缺少必填配置
- **WHEN** 构造 RunConfig 时缺失 `model` 或 `exec.cwd`
- **THEN** 配置校验失败并指明缺失字段，不发起任何 LLM 调用

#### Scenario: 合法配置
- **WHEN** 提供完整字段（signal 可为 null 表示不支持中止）
- **THEN** 校验通过，run 可启动

#### Scenario: 非数值标量参数合法

- **WHEN** `params` 含 `reasoning_effort: "none"` 或 `think: false`
- **THEN** 校验通过，运行时该键值原样平铺进请求体顶层，前缀稳定性语义不变

#### Scenario: 保留键冲突拒绝

- **WHEN** `params` 含键 `messages` 或 `stream`
- **THEN** 配置校验失败并指明冲突键，不发起任何 LLM 调用、不产生任何 trace 文件

#### Scenario: 非标量值拒绝

- **WHEN** `params` 某值为对象、数组或 `null`
- **THEN** 配置校验失败并说明只接受 string / number / boolean 标量

### Requirement: Loop 为纯函数式执行循环

`runLoop` 的输入 SHALL 只有 config + messages + tracer（另可传可选参数 tools / llm / forkRun）；运行中可变状态 SHALL 仅限 messages（只追加，不修改不删除）；迭代计数与累计成本 SHALL 从 messages（含 llm.call 的 usage）派生，禁止模块级可变状态与自增累积计数器。`forkRun` 仅携带新 run 的元数据（id/parent/fork），不引入任何可变状态。

#### Scenario: 同输入同轨迹
- **WHEN** 相同 config 与初始 messages 在 mock LLM 下运行两次
- **THEN** 产生的 messages 演化与 Tracer 事件流一致（确定性）

#### Scenario: 历史不可变
- **WHEN** 任一迭代发生
- **THEN** 已存在于 messages 中的消息不被修改或删除，新消息只追加

#### Scenario: fork 注入不改变循环语义
- **WHEN** 相同 config/messages 下分别以有无 forkRun 运行
- **THEN** 两者从分叉点起的 messages 演化与 span 序列一致，仅 run.meta 的 id/parent/fork 不同

### Requirement: runLoop 支持 fork run 元数据注入

`runLoop` SHALL 接受可选的第 6 参 `forkRun`（含 `id`、`parent`、`fork` 三字段）；注入后 `run.meta` 的对应字段 SHALL 使用注入值而非默认值（默认 `parent: null`、`fork: null`、id 自动生成）。`config_hash` SHALL 始终由本次 config 现算写入。未注入时行为与旧版完全一致（向后兼容）。

#### Scenario: fork run 元数据落盘
- **WHEN** 以 `forkRun = { id: "run_abc", parent: "run_xyz", fork: { at_span: "s_03", edit: { field: "result", value: "..." } } }` 调用 runLoop
- **THEN** 产出的 run.meta 含 `id: "run_abc"`、`parent: "run_xyz"`、`fork` 与注入值一致，`config_hash` 为本次 config 指纹

#### Scenario: 未注入时行为不变
- **WHEN** 按旧签名调用 runLoop（不传第 6 参）
- **THEN** run.meta 的 parent 为 null、fork 为 null、id 自动生成，与旧版一致

### Requirement: LLM 调用走 OpenAI 兼容协议流式直连

LLM 客户端 SHALL 通过 fetch 直连 OpenAI 兼容 chat completions 端点（SSE 流式），用 eventsource-parser 解析增量；SHALL 支持 `reasoning_content`（推理模型思维链）与 `tool_calls` 的增量聚合，请求失败（网络/HTTP 错误）SHALL 记为一次失败的 llm.call 并由 loop 按 `error` 终止处理，不得静默重试超过配置上限；SHALL 请求并记录 usage（`stream_options.include_usage`）。

客户端 SHALL 同时接受 `reasoning` 字段作为思维链增量的等价来源（Ollama `/v1` 实测发送 `reasoning`）。两字段 SHALL 聚合进同一思维链文本，trace 内部字段名恒为 `reasoning_content`。聚合语义 SHALL 是**按 SSE 到达顺序拼接，不做去重、不做内容比较**：同一 delta 块内两字段并存时 SHALL 取 `reasoning_content`（块内二选一，不拼接块内两份）；不同块分别携带两字段时 SHALL 按到达顺序依次追加进同一缓冲。真实 provider 不会在同一流并发两字段；若出现，拼接结果是最佳努力聚合，**不承诺语义正确**。SHALL NOT 引入前缀匹配 / 相似度等启发式去重。

`response.ttft_ms` SHALL 是**首个含内容 delta 的 chunk 到达时刻与请求发出时刻之差**（沿用 `archive/2026-09-03-add-agent-loop/design.md:40` 的既有定义）。该值 SHALL 在流式读取过程中采集，SHALL NOT 以"读完整条流之后遍历缓冲事件"的耗时充当；SHALL NOT 随响应分块数量增长。判定"含内容 delta"的谓词 SHALL 与聚合正文/思维链（含 `reasoning` 与 `reasoning_content` 两字段）/tool_calls 所用谓词同源。流内无任何内容 delta 时 SHALL 记 `0`。

#### Scenario: 流式响应完整聚合

- **WHEN** 模型经多块 SSE 返回正文与 tool_calls
- **THEN** 聚合后的 response（content/reasoning_content/tool_calls/usage/ttft_ms）作为完整 llm.call span 经 Tracer 流出

#### Scenario: Ollama 思维链字段兼容

- **WHEN** 端点的 SSE delta 携带 `reasoning` 字段（而非 `reasoning_content`）
- **THEN** 该增量聚合进 response 的 `reasoning_content`，思维链不丢失、不报错

#### Scenario: 两字段并存按到达顺序拼接

- **WHEN** 同一流中不同 delta 块分别携带 `reasoning` 与 `reasoning_content`（或同一块内两字段并存）
- **THEN** 不同块的增量按到达顺序依次追加进同一 `reasoning_content` 缓冲（不去重、不比较内容）；同一块内两字段并存时只取 `reasoning_content`，块内内容不翻倍

#### Scenario: 并存拼接的语义豁免

- **WHEN** provider 确实在同一流并发两字段（真实 provider 不会发生）
- **THEN** 聚合结果为按序拼接的最佳努力结果，系统 SHALL NOT 承诺语义正确，SHALL NOT 因此抛错或告警

#### Scenario: 首 token 延迟按首块到达时刻取值

- **WHEN** 端点先延迟 D 毫秒才发出首个含内容 delta 的 chunk（其后连续多块）
- **THEN** `response.ttft_ms` 不小于 D（扣除测量容差），且**不随其后分块数量变化**——分块再多也不会把它改写成"解析耗时"

#### Scenario: 请求失败

- **WHEN** 端点返回 401 或网络中断
- **THEN** loop 以 `run.event: errored`（reason: error）终止，错误信息经事件流出，messages 中已完成的轮次保持完整

#### Scenario: 无内容 delta 但流正常结束

- **WHEN** 流中只有 usage 块、没有任何正文 / 思维链 / tool_calls delta
- **THEN** `response.ttft_ms` 为 `0`，并按既有语义处理该次调用的结果（无内容且无 usage 时抛 `LlmRequestError`，行为不变）

### Requirement: 工具在执行上下文中运行且错误是数据

工具 SHALL 在 `exec.cwd` 落点执行；工具定义 SHALL 携带 `sideEffect` 标注（默认 true，供后续 replay 分级）；工具失败 SHALL 记录为带 `error` 的 tool_result 追加进 messages，loop 决定继续或停止——文件与循环本身不因工具错误中断。

#### Scenario: 工具报错但 loop 继续
- **WHEN** read_file 抛出 ENOENT
- **THEN** 失败以 tool_result（含 error 文本）追加进 messages，下一轮迭代照常发起

#### Scenario: 副作用标注
- **WHEN** 工具定义了 `sideEffect: false`
- **THEN** 该标注随工具表进入 trace 请求记录，replay 层可据此分级

### Requirement: 五种终止条件

loop SHALL 且仅 SHALL 在以下情况终止并写入对应 `run.event`：模型不再请求工具 → `completed`；迭代达 `maxIterations` → `max_iterations`；累计成本超预算 → `budget_exceeded`；`exec.signal` 触发中止 → `aborted`（优雅收尾：完成当前步的记录后封存，非硬杀）；loop 自身 bug → `error`（抛出异常属于实现错误的信号）。

#### Scenario: 任务完成
- **WHEN** 模型返回不含 tool_calls 的响应
- **THEN** 写入 `{ event: "stopped", reason: "completed", at: n }`，run 封存

#### Scenario: 死循环停止
- **WHEN** 迭代数达到 maxIterations
- **THEN** 写入 reason 为 max_iterations 的终止事件

#### Scenario: 用户中止
- **WHEN** 运行中 signal 被 abort
- **THEN** loop 在当前步记录完整后写入 reason 为 aborted 的终止事件，不产生半记录的 span

#### Scenario: 预算超限
- **WHEN** 派生的累计 token 超过 maxTotalTokens
- **THEN** 写入 reason 为 budget_exceeded 的终止事件

### Requirement: 观测全部经 Tracer 流出

loop 的所有观测 SHALL 经 Spec #1 的 Tracer 接口输出（agent.step / llm.call / tool.invoke / run.event），loop 不直接写文件；Tracer 由调用方注入（JsonlTracer 落盘或 NullTracer 无文件）。

#### Scenario: 无文件运行
- **WHEN** 注入 NullTracer
- **THEN** loop 正常运行至终止，事件流可被订阅断言，无文件产生

#### Scenario: 文件运行
- **WHEN** 注入 JsonlTracer
- **THEN** 产出的 trace 文件通过 trace-sdk readRun 校验，span 结构符合 trace-format spec

### Requirement: config 指纹写入 run.meta

run 启动时 SHALL 对 system prompt + 工具表定义计算 sha256 指纹作为 `config_hash` 写入 run.meta；采样参数与模型名不参与指纹（同一源代码换模型/温度属于合法对比实验）。

#### Scenario: 同源代码同指纹
- **WHEN** 两次运行使用相同 system prompt 与工具表（仅 model 或 temperature 不同）
- **THEN** 两者 config_hash 相同

#### Scenario: 源代码变化
- **WHEN** 工具表增删任一工具
- **THEN** config_hash 变化

### Requirement: 请求前缀稳定性

对相同 messages 前缀，loop 构造的 LLM 请求体 SHALL 逐字节一致（消息顺序、字段序列化稳定），使分支运行的前缀天然命中 provider 的 prompt caching。

#### Scenario: 分支前缀复现
- **WHEN** 以相同 config 与截断到第 N 步的 messages 重新构造请求
- **THEN** 请求体的 messages 序列化与前次运行第 N 步完全一致

### Requirement: 可注入的 LLM 传输层

LLM 客户端 SHALL 支持在测试中注入 mock fetch（返回编排好的 SSE 序列），使全部测试零真实 API 调用。

#### Scenario: 零 API 测试
- **WHEN** 测试注入 mock fetch 模拟多轮对话（含工具调用与错误路径）
- **THEN** runLoop 全流程可验证，无任何网络请求发出

### Requirement: usage 解析记录缓存命中 tokens

LLM 客户端聚合 SSE usage 块时，SHALL 额外读取 provider 返回的缓存命中字段并记录进聚合结果的 `response.usage`：DeepSeek 扁平形态（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）与 OpenAI 嵌套形态（`prompt_tokens_details.cached_tokens`）SHALL 均被接受，命中数写入 `cache_hit`，未命中数写入 `cache_miss`（嵌套形态只取命中数，`cache_miss` 省略）。两个缓存字段 SHALL 为可选：provider 未返回时 SHALL 省略（不得写 0 冒充未知），**provider 返回 `0` 时 SHALL 如实记录 `0`**（实测零命中，与缺失语义不同）。缓存字段 SHALL 与 `in` / `out` 在同一次 usage 块赋值中写入（覆盖式，不跨块累加）。既有 `{in, out}` 语义与派生（如 token 合计）SHALL 不受影响。同一 usage 块同时出现两种形态时 SHALL 以扁平形态优先。

#### Scenario: DeepSeek 扁平字段被记录

- **WHEN** 端点的 usage 块携带 `prompt_cache_hit_tokens: 800` 与 `prompt_cache_miss_tokens: 200`
- **THEN** 聚合结果的 `response.usage` 为 `{ in, out, cache_hit: 800, cache_miss: 200 }`，`in` 仍为 provider 返回的 `prompt_tokens` 原值

#### Scenario: 零命中如实记录

- **WHEN** 端点的 usage 块携带 `prompt_cache_hit_tokens: 0`
- **THEN** 聚合结果的 `response.usage` 含 `cache_hit: 0`（SHALL NOT 省略、SHALL NOT 因 0 为假值而丢弃）

#### Scenario: OpenAI 嵌套字段被记录

- **WHEN** 端点的 usage 块携带 `prompt_tokens_details: { cached_tokens: 800 }` 而无扁平字段
- **THEN** 聚合结果的 `response.usage` 含 `cache_hit: 800`，无 `cache_miss` 字段

#### Scenario: 两种形态并存时扁平优先

- **WHEN** 同一 usage 块同时携带扁平字段与 `prompt_tokens_details.cached_tokens`
- **THEN** `cache_hit` / `cache_miss` 取扁平形态的值，嵌套形态被忽略，不报错

#### Scenario: 未返回缓存字段时省略

- **WHEN** 端点的 usage 块只有 `prompt_tokens` 与 `completion_tokens`（如 Ollama）
- **THEN** `response.usage` 只含 `{in, out}`，无 `cache_hit` / `cache_miss` 字段，调用照常成功
