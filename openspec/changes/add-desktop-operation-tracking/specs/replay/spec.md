## ADDED Requirements

### Requirement: 重跑编排可观察真实运行身份

`replayRun`、`createIsolatedRun` 和 `replayIsolatedRun` SHALL 提供可选的 `onRunIdentified` 观察回调，在本次 trace 实际写出最终 run.meta 后、首次 LLM 调用前通知一次真实 ID。观察 SHALL 不改变 ID 生成、执行/授权门禁、文件格式、前缀及隔离世界语义；省略回调 SHALL 保持原有行为。已报告 ID SHALL 不因后续失败被撤销，也 SHALL NOT 被当作已归位/封存/成功证明。观察者异常 SHALL 与真实写入错误区分，不能中断原执行或收尾。

#### Scenario: 普通 result 编排暴露已创建身份

- **WHEN** 普通 result replay 通过全部预检并写出 run.meta
- **THEN** 回调只报告一次与实际 meta 相同的 ID，发生于首次 LLM 前；后续异常调用方仍持有该 ID，父前缀零调用和父文件不变

#### Scenario: 隔离编排报告最终世界身份

- **WHEN** 隔离根创建或隔离 result 续跑写出 checkpoint tracer 加工后的 meta
- **THEN** 回调 ID 等于最终 meta.id/workspace.world_id，不报告 loop 内被替换的 ID；临时文件归位或收尾失败不撤销已知身份，源/父/兄弟世界不变

#### Scenario: 拒绝和写入前失败没有运行身份

- **WHEN** 普通或隔离编排在预检、授权、源校验或首次 meta 写出前失败
- **THEN** 不调用身份回调，不把预分配 ID 当记录；原失败和零模型调用边界保持，观察接口不增加任何副作用

#### Scenario: 可选观察不改变执行结果

- **WHEN** 同一受控执行分别省略观察者、提供正常观察者或令观察者抛错
- **THEN** 运行调用次数、原执行结果与 trace 语义相同，观察异常不阻止清理且订阅在收尾释放；真实 tracer 写入错误仍按原语义传播
