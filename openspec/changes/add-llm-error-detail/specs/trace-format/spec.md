# trace-format Delta

## ADDED Requirements

### Requirement: llm.call 可记录调用失败详情

`llm.call` span SHALL 支持可选的顶层 `error` 对象（与 `request` / `response` 平级），含 `message`（脱敏并限长后的**非空**诊断文本）与可选的 `status`（HTTP 错误状态码，SHALL 仅在实际取得该状态码时写入，SHALL NOT 从消息文本猜测）。成功调用 SHALL 省略 `error`；既有 trace 缺省该字段 SHALL 仍合法可读——**字段缺失只表示未记录错误详情，SHALL NOT 被解读为调用成功**，读取器与消费端 SHALL NOT 由空正文、零 token 或缺省字段反推失败原因。

`error` SHALL NOT 接受 `null`（与 `tool.invoke.error` 的 `string | null` 语义相反方向：后者 `null` 表示成功，前者 `undefined` 才表示未记录失败）。`error` 对象 SHALL NOT 承载 headers、完整响应体、stack 或任意异常对象。`format_version` SHALL 保持 `1`，历史文件 SHALL NOT 被改写；Tracer 的 `span.end` 事件与 JSONL 落盘/读取 SHALL 保留该字段（读取器逐行校验与分支解析 SHALL NOT 丢字段）。

#### Scenario: 失败调用记录错误详情并保留状态码

- **WHEN** 一次 LLM 调用因端点返回 HTTP 401 失败，loop 随该 span 流出 `error: { message: "LLM 端点返回 HTTP 401：…", status: 401 }`
- **THEN** 该 `llm.call` span 的 JSONL 行含顶层 `error` 对象，`status` 为 `401`；经 `span.end` 事件与读取器往返后字段逐字节一致

#### Scenario: 失败无状态码时不写 status

- **WHEN** 失败来自网络异常或流中断（无 HTTP 状态码）
- **THEN** `error` 只含 `message`，SHALL NOT 出现 `status` 字段（不写 0、不写占位）

#### Scenario: 缺省 error 的旧文件仍可读

- **WHEN** 读取一个不含任何 `error` 字段的历史 trace（成功或失败调用皆然）
- **THEN** 逐行校验通过，字段缺省；读取器 SHALL NOT 报错、SHALL NOT 以空正文或零 token 推断该调用失败

#### Scenario: error 为 null 被拒绝

- **WHEN** 解析一个 `llm.call` 上携带 `error: null` 的 span
- **THEN** 校验失败（LLM 错误的缺省态是 `undefined`，`null` 非法）

#### Scenario: 错误详情不混入响应与上下文

- **WHEN** 一次调用失败落盘
- **THEN** `response.content` 仍为空占位、`request.messages` SHALL NOT 含任何错误文本，失败轮 SHALL NOT 追加 assistant 消息
