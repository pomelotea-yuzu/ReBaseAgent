## ADDED Requirements

### Requirement: span 可记录墙上时钟区间

span 行 SHALL 支持可选 `timing` 对象，含 `started_at` 与 `ended_at`（ISO 8601 字符串，成对出现、不可只写其一）：Tracer 在 `startSpan` 时记录起始时刻，`endSpan` 落盘该行时一并写入终止时刻。读取器 SHALL 接受缺失 `timing` 的 span（老文件与手工构造数据合法），不得报错或以其他字段推断。

#### Scenario: 新产出的 span 带时间区间

- **WHEN** 一次运行中开启 span 并在 120ms 后结束
- **THEN** 落盘的 span 行含 `timing.started_at` 与 `timing.ended_at`，两者之差约为 120ms

#### Scenario: 缺失时间区间的老文件

- **WHEN** 读取一份 span 无 `timing` 字段的 trace 文件
- **THEN** 校验通过，读取结果中这些 span 无 `timing`，调用方须按"时间未知"处理
