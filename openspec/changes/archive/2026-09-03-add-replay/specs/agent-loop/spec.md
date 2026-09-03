## ADDED Requirements

### Requirement: runLoop 支持 fork run 元数据注入

`runLoop` SHALL 接受可选的第 6 参 `forkRun`（含 `id`、`parent`、`fork` 三字段）；注入后 `run.meta` 的对应字段 SHALL 使用注入值而非默认值（默认 `parent: null`、`fork: null`、id 自动生成）。`config_hash` SHALL 始终由本次 config 现算写入。未注入时行为与旧版完全一致（向后兼容）。

#### Scenario: fork run 元数据落盘

- **WHEN** 以 `forkRun = { id: "run_abc", parent: "run_xyz", fork: { at_span: "s_03", edit: { field: "result", value: "..." } } }` 调用 runLoop
- **THEN** 产出的 run.meta 含 `id: "run_abc"`、`parent: "run_xyz"`、`fork` 与注入值一致，`config_hash` 为本次 config 指纹

#### Scenario: 未注入时行为不变

- **WHEN** 按旧签名调用 runLoop（不传第 6 参）
- **THEN** run.meta 的 parent 为 null、fork 为 null、id 自动生成，与旧版一致

## MODIFIED Requirements

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
