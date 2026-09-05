# llm-proxy Delta: 本地 LLM 录制代理

## ADDED Requirements

### Requirement: 仅监听本机回环并透明转发

代理 SHALL 仅监听 `127.0.0.1`（明文 HTTP）。对 `POST /v1/chat/completions` 请求，SHALL 将请求头与请求体**原样**转发到配置的 upstream（默认 `https://api.deepseek.com`），不修改任何字节；Authorization 头原样透传。upstream 响应 SHALL 原样回传客户端（逐字节）。非支持路径 SHALL 返回明确错误（404/501），不得静默透传。

#### Scenario: base_url 一行接入

- **WHEN** 用户把自己应用的 base\_url 改为 `http://127.0.0.1:<port>/v1` 并发起一次 chat.completions（key 与请求体一字不动）
- **THEN** 代理把请求原样转发到 upstream，客户端收到的响应与直连 upstream 逐字节一致（状态码、头、body）

#### Scenario: 不支持的路径

- **WHEN** 客户端请求 `POST /v1/embeddings`
- **THEN** 返回 501 与明确错误信息，不向 upstream 转发，不产生任何录制数据

#### Scenario: 端口被占用

- **WHEN** 用户启用代理但端口已被其他进程占用
- **THEN** 启用失败并报明确错误，桌面应用本身不受影响

### Requirement: 每个请求录制为一个 run

每个被代理的 `/v1/chat/completions` 请求 SHALL 录制为独立的 trace run（一 run 一 JSONL 文件）：`run.meta`（含 `source: { kind: "proxy", base_url }`、`task: "(llm-proxy)"`、**不含** `config_hash`）、一个 `agent.step`（n=1）内含一个 `llm.call` span、终止 `run.event`。`llm.call.request` SHALL 记录：`messages`、`tools`（无则空）、`model`；请求体顶层除 `model` / `messages` / `tools` / `stream` 外的字段（temperature、max\_tokens 等）SHALL 平铺收进 `params`（映射语义与 agent-loop 录制一致）。请求头一律不录制。响应 SHALL 按 agent-loop llm-client 同标准聚合出 `content` / `reasoning_content` / `tool_calls` / `usage`（对 `usage: null` 中间块容错；流式结束时仍无 usage 则兜底 `{0,0}`，诚实为零不臆造）。非流式响应无 TTFT 概念，`ttft_ms` SHALL 记 `0`（语义为「一次到货」，SHALL NOT 记总耗时冒充 TTFT）。

#### Scenario: 非流式请求录制

- **WHEN** 客户端发起非 stream 请求且 upstream 返回 200

- **THEN** 落盘 run 含 meta（source.kind="proxy"、task="(llm-proxy)"、无 config\_hash）、agent.step + llm.call（完整 request 含平铺 params，response 聚合完整、ttft\_ms=0）、`stopped/completed` 终止事件

#### Scenario: 流式请求录制

- **WHEN** 客户端发起 `stream: true` 请求

- **THEN** 客户端边收边得（代理逐 chunk 转发，不缓冲整响应），结束后 run 内 llm.call 的 response 为聚合出的完整内容，与客户端实际收到的最终内容一致

#### Scenario: upstream 失败

- **WHEN** upstream 返回 4xx/5xx

- **THEN** 错误响应原样回传客户端；run 只落 meta 与 `stopped/error` 终止事件，不写 llm.call span

#### Scenario: 客户端中途断连

- **WHEN** 客户端在流式转发过程中断开连接

- **THEN** 已转发字节不作补偿；run 无终止事件（crashed），已落盘行保持完整

### Requirement: key 不落盘且仅内存暂存

代理 SHALL NOT 在任何持久化位置（trace 文件、日志、settings、磁盘）存储 Authorization 凭据。 SHALL 仅在 main 进程内存中暂存最近一次捕获的 key，且 SHALL NOT 通过任何 IPC 通道把 key 回传渲染层。暂存语义为「最近捕获」：若用户应用中途更换 key，分叉重发 SHALL 使用最新捕获值（而非源 run 录制当时的值）——此差异可接受并在 UI 提示语中体现（key 属于用户应用，ReBaseAgent 只借用不保管）。

#### Scenario: trace 中无凭据

- **WHEN** 检查任一代理 run 的 JSONL 文件全文

- **THEN** 不含 Authorization 值（request 录制不含请求头，meta/span/event 均无 key 字段）

#### Scenario: 重启后暂存失效

- **WHEN** 用户重启桌面应用后尝试对历史代理 run 重发

- **THEN** 得到明确错误「本会话未捕获到 key，请先把你的应用经代理跑一次」，不使用任何持久化凭据

#### Scenario: 中途换 key 后重发

- **WHEN** 用户应用先以 key A 经代理跑出源 run，后改用 key B 又跑过一次，此时对源 run 重发

- **THEN** 重发使用 key B（最近捕获值），UI 提示语标明重发用的是「最近捕获的 key」

### Requirement: 单请求级最小分叉（方案 a）

对已封存的代理 run，用户 SHALL 能编辑其 `llm.call.request.messages` 中的内容并经代理重发：代理用暂存 key 构造请求（messages 用编辑后值，params/model/tools 用原录制值）发往 upstream，产物录为新 run，其 `run.meta` 含 `parent`（源 run id）与 `fork`（`at_span` = 源 llm.call span id；`edit.field` = `"messages"`；`edit.value` = 编辑后 messages）。该分叉 SHALL NOT 走 replay 包路径，SHALL 不要求工具表或 config\_hash。分叉产物与普通代理 run 一样可继续查看与再分叉。

#### Scenario: 编辑脏消息后重发

- **WHEN** 用户把 r\_proxy01 的第 1 条消息中脏内容改掉并确认重发
- **THEN** 代理向 upstream 发起一次真实调用（编辑后 messages + 原 model/params），产物 r\_proxy02 的 meta 含 `parent: "r_proxy01"`、`fork: { at_span: <llm.call id>, edit: { field: "messages", value: <编辑后 messages> } }`，r\_proxy02 仅含自己的新增 span

#### Scenario: 未修改拒绝重发

- **WHEN** 用户未对 messages 做任何修改即点击重发
- **THEN** 请求被拒绝（空 fork 防线），不产生 API 调用

#### Scenario: 分叉产物可再分叉

- **WHEN** 用户对 r\_proxy02 再次编辑 messages 重发
- **THEN** 产物 r\_proxy03 的 parent 指向 r\_proxy02，前缀链（parent 链）可被既有 resolveBranch 展开

### Requirement: 代理可暂停且状态可观测

代理 SHALL 提供启停开关；停止时 SHALL 拒绝新连接（明确错误），不影响已进行的转发。当前状态（running/stopped、端口、upstream、本会话是否已捕获 key）SHALL 可被 UI 查询（key 本身除外）。

#### Scenario: 暂停降噪

- **WHEN** 用户关闭代理开关后自己的应用继续发请求
- **THEN** 请求立即失败（连接被拒/明确错误），不产生录制数据；重新开启后录制恢复
