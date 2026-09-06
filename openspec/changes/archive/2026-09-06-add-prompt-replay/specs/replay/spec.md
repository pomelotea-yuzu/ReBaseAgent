## ADDED Requirements

### Requirement: prompt fork 与同源 tool_result replay 分流

replay 编排层 SHALL 保留既有 tool_result replay 的 config_hash 一致性校验、父前缀派生与 resolveBranch 语义；prompt fork SHALL 使用独立入口，从直接父 run 的首次 llm.call 派生启动上下文并从头运行。系统 SHALL NOT 通过放宽 replayRun 的字段类型或 config_hash 校验把两种语义合并。

#### Scenario: tool_result replay 行为不变

- **WHEN** 用户按既有流程编辑 tool.invoke.result
- **THEN** 系统仍要求 config_hash 与父 run 一致，并只记录分叉点后的新增 spans

#### Scenario: prompt fork 使用独立编排

- **WHEN** 用户编辑 system_prompt 或 user_message
- **THEN** 系统允许新 config_hash 与父 run 不同，从头记录完整 spans，且不改变 deriveReplayState 的 result-only 契约
