# agent-loop Delta

## ADDED Requirements

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
