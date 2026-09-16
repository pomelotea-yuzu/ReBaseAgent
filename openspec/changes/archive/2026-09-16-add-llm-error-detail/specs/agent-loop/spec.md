# agent-loop Delta

## ADDED Requirements

### Requirement: LLM 调用失败的诊断详情经 Tracer 流出

loop SHALL 在 `llm.complete()` 失败时把诊断详情随该次 `llm.call` span 的 `span.end` 事件流出（由 Tracer 落盘），随后关闭步骤并以 `errored / error` 收尾——SHALL NOT 只打印日志、SHALL NOT 新开旁路写文件。错误文本 SHALL NOT 进入 `response.content`、`request.messages` 或任何后续上下文。

诊断详情的构造规则：

- `message` SHALL 经归一化（§脱敏与限长要求）产出，**恒为非空**；取不到有效文本时 SHALL 使用固定兜底文案 `LLM 调用失败，未提供有效错误信息`，SHALL NOT 让归一化本身抛错而丢失终止记录；
- `status` SHALL 只从 `LlmRequestError.status` 提取（须为整数且为正），普通异常、字符串或注入客户端抛出的其他错误 SHALL NOT 被用于猜造状态码；
- `message` SHALL 是脱敏后的文本（脱敏与长度口径见「诊断文本脱敏与限长」要求）；
- 保留的控制台日志 SHALL 复用同一个最终 `message`，SHALL NOT 另行拼接原始异常对象。

失败轮 SHALL 保持既有行为：不重试、不追加失败轮 assistant 消息、失败 span 的 `response` 沿用空占位结构（`content: null`、`tool_calls: []`、`usage: {in:0,out:0}`、`ttft_ms: 0`），run 以 `reason: "error"` 终止且 `runLoop` 仍正常返回而非抛错。经 `runLoop` 执行的全部入口（工具结果重跑、prompt fork、模型 A/B、原生创建）SHALL 共享该记录能力。

#### Scenario: HTTP 错误状态被保留

- **WHEN** 端点返回 HTTP 429，`OpenAiCompatClient` 抛出带 `status: 429` 的 `LlmRequestError`
- **THEN** 失败 span 的 `error` 含非空 `message` 与 `status: 429`；run 以 `errored / error` 终止；messages 不含失败轮 assistant 消息

#### Scenario: 无状态码的失败不写 status

- **WHEN** 注入客户端抛出普通 `Error("boom")` 或非 Error 值
- **THEN** 失败 span 的 `error` 只有 `message`（无 `status`），且 loop 照常写出终止事件

#### Scenario: 无效错误值使用兜底文案

- **WHEN** 注入客户端依次抛出 `{}`、`undefined`、`null`、空白字符串，或抛出 `String()` 转换即抛错的值
- **THEN** 每次失败 span 的 `error.message` 均为固定兜底文案，长度不超过 1024，且 trace SHALL NOT 缺失终止事件

#### Scenario: 失败不追加消息

- **WHEN** 首次 LLM 调用即失败
- **THEN** `RunResult.messages` 与初始 messages 逐条相等（无 assistant 追加），`event.event` 为 `errored`、`event.reason` 为 `error`

### Requirement: 诊断文本脱敏与限长

`agent-loop` SHALL 提供并导出一个纯函数负责诊断文本的脱敏，内置 LLM 客户端、loop 落盘路径与保留日志 SHALL 复用同一实现（同一语义只写一处）。该函数 SHALL NOT 读取全局 settings、SHALL NOT 依赖 Electron 或任何进程环境。

已知 secrets SHALL 取自本次配置：非空的 `config.apiKey`，以及 `config.baseURL` 经 URL 解析出的 userinfo 凭据（用户名/密码）。脱敏 SHALL 同时覆盖：已知 secret 的字面量出现（逐字替换，不做长度门槛）、`Bearer <token>` 形式的凭据、`Authorization` 键值对的值部分、以及 URL 内嵌凭据。替换结果 SHALL 不含任何原始凭据片段。

**顺序 SHALL 为先脱敏、后截断**：SHALL NOT 在脱敏前对候选文本做长度切片（提前切片会让密钥只剩前缀、无法按完整值替换，残留可识别片段）。既有 HTTP 错误的 200 字符切片与 SSE 解析失败的 100 字符切片 SHALL 被移除。

限长 SHALL 统一为 **1024 个 UTF-16 代码单元（含截断标记）**：超长时截断并追加截断标记，标记计入上限；函数对已满足上限的输入 SHALL 幂等（客户端脱敏结果再经 loop 兜底 SHALL 不产生二次变形）。SSE 聚合函数 SHALL 通过**可选**参数接收脱敏上下文，既有无参数调用 SHALL 保持兼容；内置客户端 SHALL 传入。

本要求 SHALL NOT 承诺识别任意业务文本中的所有秘密（如已被 provider 哈希回显、或用户自行粘入 prompt 的凭据）。

#### Scenario: 响应体回显 apiKey 时被脱敏

- **WHEN** 受控端点返回 401 且响应体回显了本次请求的 `apiKey`
- **THEN** 落盘的 `error.message`、保留日志与桌面提示中均不含该密钥，出现脱敏占位；长度不超过 1024

#### Scenario: 短密钥不被提前切片漏出

- **WHEN** 端点回显的凭据位于响应体前 200 字符之外，或 SSE 非法数据块长度超过 100 字符且尾部携带凭据
- **THEN** 凭据仍被完整替换（证明脱敏发生在截断之前），最终 `message` 长度不超过 1024

#### Scenario: baseURL 内嵌凭据被脱敏

- **WHEN** `baseURL` 为 `https://user:secret@host/v1` 且错误文本回显了该 URL 或其中的用户名/密码
- **THEN** 文本中的完整凭据片段被替换为脱敏占位

#### Scenario: Bearer 与 Authorization 文本被脱敏

- **WHEN** 注入客户端抛出的消息含 `Authorization: Bearer sk-live-xxx` 或 `Bearer sk-live-xxx`
- **THEN** 值部分被替换为脱敏占位，键名与 `Bearer` 前缀保留，消息仍可读

#### Scenario: 无凭据文本保持原样

- **WHEN** 错误文本不含任何凭据（如 `LLM 端点返回 HTTP 500：internal error`）
- **THEN** 文本内容不被改动，仅在超长时截断

#### Scenario: 无参数调用 SSE 聚合函数仍可用

- **WHEN** 直接以 `aggregateSseStream(body)`（不传脱敏上下文）聚合一段正常流
- **THEN** 聚合照常成功，行为与改动前一致
