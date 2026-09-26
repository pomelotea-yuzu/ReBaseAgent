## ADDED Requirements

### Requirement: 实验编排暴露各臂真实身份且保留失败关联

`modelReplayRunMany` SHALL 提供可选 `onArmRunIdentified({experimentId,index,id})`，每臂实际写出 run.meta 后、该臂首次 LLM 前通知一次。臂结果 SHALL 保留已写出 meta 的 ID，即使后续执行抛错；未开始或未写出 meta 的臂 SHALL 为 null。回调 SHALL 只观察，不改变臂顺序、执行能力、费用确认、参数、失败继续和比较限制；观察者异常 SHALL 不影响执行/收尾。dry-run SHALL 不产生运行身份。

#### Scenario: 批次运行中可关联各臂

- **WHEN** 合法真实批次依次启动多臂
- **THEN** 每臂首次模型调用前已通知正确 experimentId/index/id，通知与该臂实际 meta 一致且恰一次，后续臂不覆盖前一臂身份

#### Scenario: 部分失败和异常臂保留已知 ID

- **WHEN** 一臂正常结束、一臂 LLM error、另一臂在写 meta 后抛错
- **THEN** 返回各臂真实 ID 与各自失败结局，失败不阻止既有规则允许的后续臂；桌面成功 ids 仍仅计成功臂，完整关联另外提供

#### Scenario: 未开始臂与 dry-run 不产生 ID

- **WHEN** dry-run、批次前置拒绝、某臂未开始或 meta 未写出
- **THEN** 无该臂身份通知，不编造 runId；dry-run 仍零网络/零文件，不消耗执行授权或占桌面主动槽

#### Scenario: 实验身份观察不改变原执行

- **WHEN** 省略观察者或令观察者抛错
- **THEN** 批次按原规则执行，调用次数和 trace 语义不变，订阅随每臂收尾释放；不改变参数透传和实验比较限制
