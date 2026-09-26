## ADDED Requirements

### Requirement: 启动上下文编排可观察真实运行身份

`promptReplayRun` SHALL 提供可选 `onRunIdentified`，在本次最终 run.meta 写出后、首次 LLM 调用前通知一次 ID，覆盖已支持的 system_prompt、user_message 和 model_params 调用。SHALL 保持既有父链/封存/配置与空编辑门禁、从头执行及独立轨迹语义，不新增隔离执行能力。省略或抛错的观察者 SHALL 不改变原执行结局或阻止收尾，真实 trace 写入错误 SHALL 继续传播。

#### Scenario: prompt 身份在后续失败时仍可关联

- **WHEN** 合法 system_prompt、user_message 或 model_params 调用写出 meta 后模型失败或编排抛错
- **THEN** 调用方已取得与实际新记录一致的 ID，回调恰一次，不通过解析异常取得身份，不修改父轨迹

#### Scenario: prompt 前置拒绝不报告假身份

- **WHEN** 隔离父本、缺父链、不可还原 system、空编辑或配置双真相源检查拒绝
- **THEN** 不调用身份回调，零模型调用且不创建子记录；既有隔离 prompt/model_params 拒绝不变

#### Scenario: prompt 观察者兼容且释放

- **WHEN** 省略回调或回调抛错后执行结束
- **THEN** 原执行、请求次数和文件语义保持，订阅随收尾释放，观察者不成为新增失败原因
