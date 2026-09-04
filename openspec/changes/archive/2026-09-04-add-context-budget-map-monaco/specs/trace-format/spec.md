# trace-format Delta: 上下文预算元数据

## ADDED Requirements

### Requirement: run.meta 可记录预算上限

`run.meta` SHALL 支持可选 `budget` 对象，结构为 `{ "max_total_tokens": number }`。当录制端的源配置声明了总 token 预算（`config.budget.maxTotalTokens`）时，`startRun` SHALL 将其实值写入该字段；未声明时 SHALL 省略 `budget`（缺省字段，仅 meta 层增量）。读取器 SHALL 接受缺失 `budget` 的 meta（老文件与手工构造数据合法），不得报错。该字段 SHALL NOT 影响 `format_version`（保持不变）。

#### Scenario: 声明预算的运行

- **WHEN** 一次 run 的源配置设置 `config.budget.maxTotalTokens = 60000`

- **THEN** 落盘的 `run.meta` 含 `budget: { "max_total_tokens": 60000 }`

#### Scenario: 未声明预算的运行

- **WHEN** 源配置未设置 `maxTotalTokens`

- **THEN** 落盘的 `run.meta` 不包含 `budget` 字段，其余字段与解析行为不变

#### Scenario: 无预算信息的老文件

- **WHEN** 读取一份 `run.meta` 无 `budget` 字段的既有 trace 文件

- **THEN** 校验通过，读取结果中该 run 无预算信息，调用方按"预算未知"处理

