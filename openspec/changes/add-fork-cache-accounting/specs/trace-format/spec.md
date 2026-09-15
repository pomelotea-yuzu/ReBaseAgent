# trace-format Delta

## ADDED Requirements

### Requirement: llm.call usage 记录缓存命中与未命中

`llm.call` span 的 `response.usage` SHALL 支持可选字段 `cache_hit` 与 `cache_miss`（非负整数，tokens 数）：provider 返回缓存命中信息时，记录端 SHALL 将其实值写入——**包括返回 `0` 的情形（`0` = 实测零命中，是有值，SHALL 如实记录为 `0`）**；仅在 provider **未返回**这两个字段时才 SHALL 整体省略（不得以 `0` 冒充"未知"）。读取器 SHALL 接受缺失这两个字段的 span（老文件与不支持缓存的 provider 合法），SHALL NOT 报错或从其他字段推断。字段"有值"的判据 SHALL 为存在性判断（`!== undefined`），SHALL NOT 使用 truthiness——否则 `0` 会被误判为缺失。该字段 SHALL NOT 影响 `format_version`（保持不变）；`in` 的口径 SHALL 不变（仍为 provider 返回的输入总量原值，缓存命中是其组成部分而非额外叠加）。

#### Scenario: 缓存命中写入落盘

- **WHEN** 一次 LLM 调用的 provider usage 返回命中 800 / 未命中 200
- **THEN** 落盘的 llm.call 行 `response.usage` 含 `cache_hit: 800` 与 `cache_miss: 200`，`format_version` 不变

#### Scenario: 零命中如实记录（不得省略）

- **WHEN** provider 返回 `prompt_cache_hit_tokens: 0`（本次全量计费）
- **THEN** 落盘的 `response.usage` 含 `cache_hit: 0`，SHALL NOT 省略该字段（`0` 与"字段缺失"语义不同）

#### Scenario: 老文件缺失缓存字段合法

- **WHEN** 读取一份 `response.usage` 只含 `{in, out}` 的既有 trace 文件
- **THEN** 校验通过，读取结果中 usage 无 `cache_hit` / `cache_miss`，调用方按"缓存命中未知"处理，不报错

#### Scenario: 非法值被拒绝

- **WHEN** 校验一份 `response.usage.cache_hit` 为负数或非整数（如 `-1` / `1.5`）的 trace 行
- **THEN** 校验失败并报错，SHALL NOT 静默接受或就地修正（与"老文件缺失合法"对称：**缺失合法，越界非法**）

