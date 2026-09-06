## ADDED Requirements

### Requirement: 分支树区分 prompt fork 与共享前缀 fork

分支边 SHALL 将 system_prompt 映射为“改 system prompt”，将 user_message 映射为“改 user message”。prompt fork 的边 SHALL 显示“从头重跑”，不展示普通“分叉点 span id”标签；result 与 messages 的既有标签保持不变。

#### Scenario: prompt fork 边标注

- **WHEN** run B 的 parent 为 A，fork.edit.field 为 system_prompt
- **THEN** A 到 B 的边标注“改 system prompt · 从头重跑”，不显示首次 llm.call id

### Requirement: prompt fork 的指标口径保持诚实

prompt fork 的“本 run 增量”SHALL 只统计其自身完整执行；“累计增量（沿链求和）”仍按 parent 链代数求和，并 SHALL 明示这可能包含多次独立完整运行的花费，不得描述为一次连续执行的总消耗。

#### Scenario: prompt fork 的累计增量

- **WHEN** 父 run A 消耗 5k tokens，prompt fork B 从头运行消耗 6k tokens
- **THEN** B 显示“本 run 增量 6k tokens”“累计增量（沿链求和）11k tokens”，并说明累计可能包含独立完整运行，不使用“单次总消耗”措辞
