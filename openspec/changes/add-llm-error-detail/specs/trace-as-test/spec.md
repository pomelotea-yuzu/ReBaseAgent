# trace-as-test Delta

## ADDED Requirements

### Requirement: 卡带重放已录制的 LLM 失败

当卡带消费到的录制 `llm.call` 携带 `error` 时，卡带客户端 SHALL 以 `LlmRequestError(message, status)` 形式重现该失败（`status` 仅在录制中存在时传入，缺失时 SHALL NOT 补造任何默认值），SHALL NOT 返回占位 response、SHALL NOT 置 `exhausted`、SHALL NOT 发起任何真实网络请求。由此当前 `runLoop` SHALL 生成对应的 `error` outcome，使录制的失败调用被重现为失败，而 SHALL NOT 被当作"成功的空回答"。

消费计数 SHALL 先推进游标再抛错，保证一次录制失败调用**恰好消费一次**，且结构漂移（`request_drift`）照常记录。`exhausted` 与"存在未消费响应"两条既有配置错误判定 SHALL NOT 被该路径干扰：录制失败后若仍存在未消费的录制调用，编排层 SHALL 仍按既有规则返回配置错误。

卡带的错误自由文本 SHALL NOT 进入结构性轨迹对齐的判据；不含 `error` 的历史卡带 SHALL 保持既有行为（SHALL NOT 反推错误）。

#### Scenario: 录制失败被重现为 error outcome

- **WHEN** 消费一条含 `error: { message, status: 500 }` 的录制调用
- **THEN** 重跑以 `error` outcome 结束，新轨迹的该 `llm.call` span 带同样的 message 与 `status: 500`，无任何真实网络请求

#### Scenario: 缺失 status 不补造

- **WHEN** 录制 `error` 只含 `message`（无 `status`）
- **THEN** 新 span 的 `error` 同样无 `status` 字段（不写 0、不写 500 之类的默认值）

#### Scenario: 失败调用恰好消费一次

- **WHEN** 重跑消费到录制失败调用
- **THEN** 已消费数与录制总数按一次计入推进（不重复消费、不回退），结构漂移照常记录，`exhausted` 不被设置

#### Scenario: 失败后仍有剩余调用判为配置错误

- **WHEN** 录制在第 2 次调用即失败，而当前代码只发起了 1 次调用（卡带仍有剩余）
- **THEN** 编排层按既有"存在未消费响应"规则返回配置错误，SHALL NOT 静默通过

#### Scenario: 既有成功卡带不回归

- **WHEN** 以不含任何 `error` 字段的录制运行 card 带重跑
- **THEN** 行为与改动前逐字一致，结构对齐结论不变
