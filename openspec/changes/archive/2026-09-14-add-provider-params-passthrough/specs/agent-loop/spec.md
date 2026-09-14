# agent-loop Delta: 采样参数标量化与思维链字段兼容

## MODIFIED Requirements

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
