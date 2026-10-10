# llm-proxy Specification

## Purpose
本地 LLM 录制代理：用户把自己的 Agent 应用 base_url 指到 ReBaseAgent 起的本地代理（`127.0.0.1`），key 一字不动，请求透明转发到 upstream 的同时被录成 run——把「看 span」入口的摩擦降到零。并支持「单请求级最小分叉」：编辑 messages 后用暂存 key 重发，让时间旅行在零改造接入的路径上同样成立。key 只在内存暂存、永不落盘。

## Requirements

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

每个被代理的 `/v1/chat/completions` 请求 SHALL 录制为独立的 trace run（一 run 一 JSONL 文件）：`run.meta`（含 `source: { kind: "proxy", base_url }`、`task: "(llm-proxy)"`，`config_hash` 按「代理 run 写入与引擎一致的配置指纹」要求条件写入，指纹缺省时同时写 `config_hash_reason`）、一个 `agent.step`（n=1）内含一个 `llm.call` span、终止 `run.event`。`llm.call.request` SHALL 记录 messages、model、tools（无则空），顶层除 model/messages/tools/stream 外字段 SHALL 平铺到 params（映射语义与 agent-loop 一致）。请求头 SHALL NOT 录制。响应 SHALL 按 agent-loop llm-client 同标准聚合 content/reasoning_content/tool_calls/usage，对流式 usage:null 中间块容错，流式结束仍无 usage 时兜底 {in:0,out:0}，诚实为占位、不臆造实测消耗。非流式 ttft_ms SHALL 记 0，语义为一次到货、无 TTFT 概念，不以总耗时冒充。

HTTP 非 2xx 与连接失败 SHALL 记录失败 llm.call，复用 trace-format 的可选顶层 error.message/status，最后 stopped/error；response SHALL 使用失败空占位，错误文本 SHALL NOT 进入 response.content、request.messages 或执行上下文。仅实际获得上游状态码时写 error.status；代理本地产生的 502 SHALL NOT 冒充上游码。已知凭据和通用凭据形式 SHALL 在诊断输出/落盘前脱敏再限长，不存 headers、完整错误体、stack、任意异常对象或 upstream 地址。客户端响应 SHALL 维持透明转发边界，历史文件 SHALL NOT 补写。客户端中途断连仍按 crashed 规则保留实际已观察内容，不伪造完整响应或终止事件。

#### Scenario: 非流式请求录制

- **WHEN** 客户端发起非 stream 请求且 upstream 返回 200
- **THEN** 落盘 meta 与配置指纹/缺因规则不变，agent.step + llm.call 保留完整请求和平铺 params，response 聚合完整、ttft_ms=0，stopped/completed，成功省略 error

#### Scenario: 流式请求录制

- **WHEN** 客户端发起 stream:true 请求并正常收到完整响应
- **THEN** 逐 chunk 转发不缓冲整响应，llm.call.response 聚合与客户端最终内容一致，成功省略 error

#### Scenario: upstream 失败

- **WHEN** upstream 返回 401 或 503
- **THEN** 错误响应按既有透明转发规则原样回传，落盘失败 llm.call 的 error 含实际 status 和非空受控摘要、完整结构化 request，response 为空占位，run 为 stopped/error，格式版本与父本不变

#### Scenario: 客户端中途断连

- **WHEN** 客户端在流式转发过程中断开连接
- **THEN** 已转发字节不作补偿，run 无终止事件（crashed），已落盘行保持完整，不猜造成功正文

#### Scenario: 连接失败不伪造上游状态码

- **WHEN** fetch 在取得上游 Response 前连接失败，代理返回本地 502
- **THEN** 失败 llm.call.error 只含受控 message 不含 status，客户端可收到明确 502，历史详情不把该码说成上游响应

#### Scenario: 错误摘要在落盘前脱敏限长

- **WHEN** 上游诊断回显本请求或当时暂存的凭据、Bearer/Authorization/URL-userinfo，且摘要超出 1024 字符
- **THEN** error.message 在包层输出、日志和落盘前先脱敏再限制至 1024 字符（含截断标记），非空，已知凭据不出现在诊断与 IPC，客户端错误 body 原字节不因脱敏改变

#### Scenario: 错误正文为空或无法解析

- **WHEN** 非 2xx 响应体为空、非 JSON 或摘要解码失败
- **THEN** 保留实际 status 与非空受控 fallback，合法文本可提供脱敏限长摘要，不把完整响应体或解析异常对象写入 trace

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

对已封存、来源可用且具有完整自有 `llm.call.request` 的代理 run，用户 SHALL 能编辑 messages 并经代理重发；这包括新录制的 `stopped/error` 失败 run。“已封存” SHALL 按已有终止记录的结构状态判断，不等同请求成功。代理 SHALL 使用当前会话最近捕获且已核对版本的凭据，以编辑后 messages 和原 params/model/tools 发送一个真实请求，产物为新 run，meta.parent 指向源 run，fork.at_span 指向其自有调用，fork.edit.field="messages"、value 为编辑后值。SHALL NOT 走 replay 路径、要求工具表/config_hash 或执行外部工具。

未修改 messages SHALL 拒绝，即使凭据已更换也不提供原样一键重试。旧失败文件无自有调用、未封存/来源不可用或请求损坏 SHALL 拒绝且不补造数据。当前监听、凭据/配置版本、来源及明确确认门禁继续适用。重发成功或再次失败 SHALL 都只记录本次真实结果和可信子 run 身份，不改父本或自动再次请求；分叉产物可在同样条件下继续编辑重发。

#### Scenario: 编辑脏消息后重发

- **WHEN** 用户把 r_proxy01 的第 1 条消息中脏内容改掉并确认重发
- **THEN** 发起一次真实调用，编辑后 messages 与原 model/tools/params 送往 upstream，产物 r_proxy02 的 parent="r_proxy01"、fork.at_span 为源调用、edit.field="messages"/value 为编辑后消息，仅含本次自有 span

#### Scenario: 未修改拒绝重发

- **WHEN** 用户未修改成功或失败代理 run 的 messages，即使当前凭据与录制时不同也尝试提交
- **THEN** 空 fork 防线拒绝，不产生 API 调用、新 run 或原样一键重试

#### Scenario: 分叉产物可再分叉

- **WHEN** 用户对可用且已封存的 r_proxy02 再次编辑 messages 并独立确认
- **THEN** 产物 r_proxy03 的 parent 指向 r_proxy02，父链可经既有 resolveBranch 展开，每次仍仅一个请求，不执行外部工具

#### Scenario: 失败父本编辑重发成功

- **WHEN** 新代理父本为 stopped/error 且有完整自有请求，用户修改 messages 并核对当前监听/凭据版本后确认，上游本次成功
- **THEN** 只发一个真实请求，沿用原 model/tools/params 及当前凭据，生成正确 parent/fork 的 stopped/completed 子 run，父本字节不变，失败父本状态不被改成成功

#### Scenario: 失败父本重发再次失败

- **WHEN** 对合法失败父本编辑并明确重发，上游本次仍返回 401/503
- **THEN** 新子 run 保留本次 request/error 和 stopped/error、正确 parent/fork，按本次可信 ID 显示失败结果，父本不变，草稿沿既有失败保留规则保持，无自动再次请求

#### Scenario: 历史无调用失败父本不可重发

- **WHEN** 旧失败代理文件仅有 meta 与 stopped/error，没有自有 llm.call
- **THEN** 编辑重发不可用且有明确原因，不补造请求/调用、不修改历史文件或调用模型

#### Scenario: 未封存或损坏失败父本不可重发

- **WHEN** 父本缺少终止记录、来源缺失/损坏或自有请求校验失败
- **THEN** 既有来源/封存/请求门禁拒绝，在副作用前返回受控原因，保留草稿且不新建子 run

### Requirement: 代理可暂停且状态可观测

代理 SHALL 提供启停开关；停止时 SHALL 拒绝新连接（明确错误），不影响已进行的转发。当前状态（running/stopped、端口、upstream、本会话是否已捕获 key）SHALL 可被 UI 查询（key 本身除外）。

#### Scenario: 暂停降噪

- **WHEN** 用户关闭代理开关后自己的应用继续发请求
- **THEN** 请求立即失败（连接被拒/明确错误），不产生录制数据；重新开启后录制恢复

### Requirement: 代理 run 写入与引擎一致的配置指纹

代理录制器 SHALL 在落盘时从请求快照派生 `meta.config_hash`：首次请求含字符串形式的 system 消息、且工具表（若有）每一项都能无损解包为 `ToolDef`（OpenAI `function` 包装或扁平形状，经 agent-loop 既有 schema 校验）时，SHALL 以与 agent-loop `configHash` **同一实现**计算并写入；任一条件不满足 SHALL 缺省不写，SHALL NOT 以部分解析、空串替代或任何伪造值放行。不写时必须同时写入 `meta.config_hash_reason` 记录缺因（`"no_system"`：无字符串 system 消息；`"invalid_tool"`：工具表存在无法解包的项），供 fork 门禁与桌面端给出可诊断的拒绝文案——两种缺因的修复路径不同（前者需源应用发送带字符串 system 的请求，后者需修正工具定义格式），SHALL NOT 以单一笼统文案掩盖差异。hash 派生与 outcome 无关（error run 的请求快照同样适用），但不含 `llm.call` span 的 run 仍会被 fork 门禁的既有条件拒绝。工具表缺省视为空表。

**保真度边界（sideEffect）**：wire 格式（OpenAI 工具定义）不携带 `sideEffect`，解包结果天然无该字段，而 `configHash` 仅在字段有值时计入——因此代理指纹是"线上事实"的指纹。若源应用恰好也是 ReBaseAgent 引擎、且其工具带 `sideEffect` 标记，代理侧 hash 与其进程内 hash **SHALL NOT 被假定相等**（标记不上线）。本要求只承诺：由同一代理录制派生的 hash 与从该录制重建的子 run（引擎 run）hash 一致；SHALL NOT 承诺跨进程指纹互通。

#### Scenario: 含 system 的无工具请求

- **WHEN** 请求 messages 含字符串 system 消息且不携带 tools

- **THEN** 落盘 meta 的 `config_hash` 与 `configHash(system, [])` 逐字节相等

#### Scenario: 含工具的请求

- **WHEN** 请求携带多工具（OpenAI function 包装、name 乱序）

- **THEN** `config_hash` 按解包后工具表计算（工具按 name 排序、键规范化），与对同一输入直接调用 `configHash` 的输出逐字节相等

#### Scenario: 无字符串 system 消息

- **WHEN** 请求 messages 不含 role=system 且 content 为字符串的消息

- **THEN** meta 不写 `config_hash`（诚实缺省）且写入 `config_hash_reason: "no_system"`，该 run 不进入配置型分叉

#### Scenario: 工具表无法解析

- **WHEN** 请求 tools 含无法解包为 `ToolDef` 的项（缺 name/description/parameters）

- **THEN** meta 不写 `config_hash` 且写入 `config_hash_reason: "invalid_tool"`，不产生部分哈希，转发与响应字节保真不受影响

#### Scenario: 可派生时不留缺因

- **WHEN** 请求含字符串 system 消息且工具表（或无工具）可派生

- **THEN** meta 写 `config_hash` 且不写 `config_hash_reason`（两者互斥，缺因仅表达"为何没有指纹"）

### Requirement: 代理变化通知不属于主动执行

代理 SHALL 对成功落盘、凭据捕获/更换、监听和恢复状态变化提供只读可校验的会话 revision 通知，并支持当前 revision 快照核对。SHALL NOT 返回 key 或凭据指纹，SHALL NOT 为被动录制创建主动操作或占执行槽，SHALL NOT 让通知失败破坏客户端转发。

#### Scenario: 通知只包含受控元信息

- **WHEN** main 空闲时外部请求落盘或捕获 Authorization
- **THEN** renderer 收到 epoch/revision/受控变化类别，状态回读只含 hasKey 与捕获版本，不含 key、headers、messages 或原始异常；没有主动 operation 或自动模型调用

#### Scenario: 写入失败不报告新记录

- **WHEN** 转发已成功但 recorder.write 失败
- **THEN** 不推进成功记录 revision 或宣告 run 可用，客户端仍按既有转发规则得到响应；主动重发返回 PROXY_RECORDING_WRITE_FAILED，保留草稿、不返回其他请求 ID、不标本次录制成功

#### Scenario: 凭据捕获与更换可观测

- **WHEN** 已有 hasKey=true 的会话再次捕获 Authorization
- **THEN** main 内存捕获版本推进并通知状态变化，即使布尔值不变仍可供执行确认失效，不持久化或回传值

### Requirement: 保存的监听意图在启动时恢复且失败可诊断

应用 SHALL 按已保存 enabled 在启动时尝试恢复一次监听，提供恢复中、已监听、停止与失败事实，不影响历史读取。失败 SHALL 提供脱敏限长诊断，保留启用意图，并允许显式应用配置重试；顶栏与录制工作区的呈现由 desktop-ui 的“代理启动恢复结果就近可见”规定。状态读取 SHALL NOT 启动服务或验证上游，key SHALL 仍只存在本次 main 内存。

#### Scenario: 保存启用后重启恢复监听

- **WHEN** saved.enabled=true 且端口可用，应用启动并完成恢复
- **THEN** 真实监听既有地址，状态反映 running=true；hasKey=false，直到本会话请求携带凭据经过

#### Scenario: 重启恢复失败可见且可重试

- **WHEN** saved.enabled=true 但端口占用或恢复失败
- **THEN** 历史仍可读取，状态保留 enabled=true、running=false 及受控失败原因，回读不再启动；端口释放后显式应用配置可重试，不自动调用模型

#### Scenario: 保存停用不启动代理

- **WHEN** saved.enabled=false 时重启
- **THEN** 不尝试监听，状态为停止，无捕获凭据和自动上游请求
