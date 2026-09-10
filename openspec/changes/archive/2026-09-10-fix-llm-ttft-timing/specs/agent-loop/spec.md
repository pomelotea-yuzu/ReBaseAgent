# agent-loop Delta: 首 token 延迟的取值语义可测化

## MODIFIED Requirements

### Requirement: LLM 调用走 OpenAI 兼容协议流式直连

LLM 客户端 SHALL 通过 fetch 直连 OpenAI 兼容 chat completions 端点（SSE 流式），用 eventsource-parser 解析增量；SHALL 支持 `reasoning_content`（推理模型思维链）与 `tool_calls` 的增量聚合；SHALL 请求并记录 usage（`stream_options.include_usage`）。请求失败（网络/HTTP 错误）SHALL 记为一次失败的 llm.call 并由 loop 按 `error` 终止处理，不得静默重试超过配置上限。

`response.ttft_ms` SHALL 是**首个含内容 delta 的 chunk 到达时刻与请求发出时刻之差**（沿用 `archive/2026-09-03-add-agent-loop/design.md:40` 的既有定义）。该值 SHALL 在流式读取过程中采集，SHALL NOT 以"读完整条流之后遍历缓冲事件"的耗时充当；SHALL NOT 随响应分块数量增长。判定"含内容 delta"的谓词 SHALL 与聚合正文/思维链/tool_calls 所用谓词同源。流内无任何内容 delta 时 SHALL 记 `0`。

#### Scenario: 流式响应完整聚合

- **WHEN** 模型经多块 SSE 返回正文与 tool_calls
- **THEN** 聚合后的 response（content/reasoning_content/tool_calls/usage/ttft_ms）作为完整 llm.call span 经 Tracer 流出

#### Scenario: 首 token 延迟按首块到达时刻取值

- **WHEN** 端点先延迟 D 毫秒才发出首个含内容 delta 的 chunk（其后连续多块）
- **THEN** `response.ttft_ms` 不小于 D（扣除测量容差），且**不随其后分块数量变化**——分块再多也不会把它改写成"解析耗时"

#### Scenario: 请求失败

- **WHEN** 端点返回 401 或网络中断
- **THEN** loop 以 `run.event: errored`（reason: error）终止，错误信息经事件流出，messages 中已完成的轮次保持完整

#### Scenario: 无内容 delta 但流正常结束

- **WHEN** 流中只有 usage 块、没有任何正文 / 思维链 / tool_calls delta
- **THEN** `response.ttft_ms` 为 `0`，并按既有语义处理该次调用的结果（无内容且无 usage 时抛 `LlmRequestError`，行为不变）
