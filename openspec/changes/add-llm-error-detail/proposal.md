# LLM 调用失败详情落盘与展示

## Why

桌面端原生运行创建已上线，但模型调用失败后，用户只能看到“出错终止”：`runLoop` 把错误文本打印到控制台，trace 只保留空响应和 `errored` 终止事件，重新打开运行仍无法查到失败原因。此缺口也影响复用 `runLoop` 的工具结果重跑、prompt fork 和模型 A/B；本 change 将失败原因作为 trace 数据保存，并在失败调用处直接展示，让用户无需查主进程日志即可排查。

## What Changes

- **增加可选的 LLM 错误详情**：在 `llm.call` span 顶层增加 `error?: { message: string; status?: number }`。`message` 为脱敏、限长后的非空诊断文本；`status` 仅在实际取得 HTTP 错误状态码时写入，不从消息文本猜测。成功调用省略 `error`；旧 trace 缺省合法，缺失本身不能证明调用成功。保持 `format_version: 1`，不改写历史文件。
- **在失败发生处完成记录**：`runLoop` 捕获 `llm.complete()` 失败后，将详情随失败 span 的 `span.end` 事件流出，并由现有 Tracer 落盘；随后关闭步骤，以 `errored / error` 收尾。覆盖 HTTP 非成功状态、网络失败、SSE 读取或解析失败，以及注入客户端抛出的普通异常或非 Error 值；取不到有效文本时使用明确的通用失败文案。保持不重试、不追加失败轮 assistant 消息的行为，不把错误文本混入模型响应正文或上下文。
- **错误在输出前脱敏**：对本次配置的 API key、Authorization/Bearer 凭据以及 URL 中的认证信息做脱敏，再截断诊断文本；HTTP 响应片段和 SSE 异常片段在客户端截断前处理，避免先截断导致密钥只剩前缀、无法按完整值替换。错误详情不保存 headers、完整响应体、stack 或任意异常对象；若保留控制台日志，使用同一份脱敏结果。全部入口复用单一纯函数，统一长度上限及应用点见下节。不承诺识别任意业务文本中的所有秘密。
- **桌面端显式呈现失败**：轨迹树中的失败 LLM 调用使用错误标记，详情优先展示错误原因及已知 HTTP 状态码，仍可查看原始请求。失败调用不再显示“无正文，仅有工具调用”；空响应按是否确有工具调用区分文案。沿用现有失败响应占位结构，但错误详情中明确 usage/TTFT 的占位零值不是实际零消耗或零延迟。
- **历史记录诚实降级**：运行以 `reason: error` 结束且自身 spans 未记录 LLM 错误详情时，在运行上下文显示“错误详情未记录”。不根据空正文、零 token 或最后一个 LLM span 猜造失败原因、标错历史调用；代理失败没有 LLM span 时也可显示该缺省提示。
- **打通现有消费路径**：确认读取器和既有详情 IPC 保留新字段；原生创建失败提示改为引导查看已保留运行的错误详情。Trace-as-Test 卡带消费到带 `error` 的调用时重现调用失败，让 `runLoop` 生成对应 error outcome，避免把失败占位响应当作成功空回答；无错误字段的历史卡带沿用既有行为，不反推错误。

## 设计约束

以下约束对应 2026-09-16 审阅的 P2-1 至 P2-5，后续 design、spec 和实现任务须逐项承接。

1. **统一脱敏入口与长度口径（P2-1）**：在 `agent-loop` 内提供并导出一个纯函数负责诊断文本脱敏，客户端和 loop 复用同一实现。已知 secrets 来自非空 `config.apiKey` 及 `config.baseURL` 中的认证信息，结合 Authorization/Bearer 和 URL 凭据规则处理；不读取全局 settings，不依赖 Electron。应用点包括 HTTP 失败、网络异常、SSE 读取/解析异常，以及 `runLoop` 对注入客户端异常的归一化落盘入口。SSE 聚合器通过可选参数接收脱敏上下文，既有无参数调用保持兼容；内置客户端必须传入。移除现有 HTTP 200 字符和 SSE 100 字符的提前切片，改为对完整候选诊断文本先脱敏、再统一限长至 **1024 个 UTF-16 代码单元（含截断标记）**。最终落盘前再次使用同一规则兜底；保留的 `console.error` 直接复用最终 `error.message`，不另行拼接原异常。
2. **卡带消费与错误类型（P2-2）**：`runLoop` 仅从 `LlmRequestError` 提取已知且合法的 HTTP 状态码；普通异常不靠 message 猜测 status。卡带客户端先记录 request drift、推进 cursor 消费当前调用，再对存在 `error` 的 span 抛出 `LlmRequestError(recorded.message, recorded.status)`，不返回占位 response、不标记 `exhausted`。录制失败因此重现为运行的 error outcome，并保留已录制 status；卡带耗尽仍设置 `exhausted` 并走 `TraceTestConfigError` 路径。`rerun.ts` 在 loop 返回后的 exhausted/remaining 检查保持有效，录制失败后若仍有未消费调用，仍按既有规则报配置错误。
3. **缺失提示使用本 run 的事实（P2-3）**：“错误详情未记录”的判定落在 `shared/derive.ts` 纯函数中，依据当前 run 的终止原因，并用 `RunDetail.leafSpanIds` 过滤合并后的 `spans`，只检查其中 `llm.call.error` 是否存在。不得直接扫描整条祖先合并轨迹来判断本次错误原因是否已记录。轨迹树仍可按每个 span 自身的 error 标记祖先失败节点，但不能因此隐藏当前 run 的缺失提示；自身无 LLM span 的代理错误运行同样适用。
4. **有效诊断文本与兜底（P2-4）**：归一化优先读取 Error 的 message 或直接抛出的字符串；其他值的字符串转换须有异常保护，不序列化任意对象。去除首尾空白后，空串、`[object Object]`、`undefined`、`null`，以及转换失败，均使用固定文案“LLM 调用失败，未提供有效错误信息”。兜底文本也经过同一脱敏与限长流程；不得让归一化本身失败而丢失终止记录。
5. **同名 error 字段按 kind 区分（P2-5）**：schema 注释、导出类型说明和消费端明确区分 `tool.invoke.error: string | null` 与 `llm.call.error?: { message; status? }`。节点错误判据分别为工具的 `error !== null`、LLM 的 `error !== undefined`，先按 `kind` 缩窄类型，不能套用统一的非 null 判据。LLM 字段缺失只表示未记录错误详情，不能证明成功；不接受以 `null` 表示 LLM 成功。

兼容性代价：保持 `format_version: 1` 后，旧版本读取器会通过 zod 的未知字段剔除机制静默丢弃新增 `error`，继续按原有界面展示。新版本保证旧 trace 可读，但不承诺旧应用能展示新增错误详情；不重写旧文件。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `trace-format`：扩展 `llm.call` 的可选错误结构、合法值与缺省语义；保证 Tracer 事件和 JSONL 读取保留该字段，旧文件继续可读。
- `agent-loop`：补齐“请求失败时错误信息经事件流出”的既有契约，明确错误归一化、脱敏、状态码保留和失败收尾行为。
- `desktop-ui`：扩展轨迹树及 LLM 详情的失败展示，明确错误详情缺失时的提示、空响应文案和原生创建失败后的查看引导。
- `trace-as-test`：扩展卡带重跑契约，消费已录制的 LLM 失败并重现 error outcome；不将错误自由文本纳入结构对齐判据。

## Impact

| 范围 | 预期改动 |
|---|---|
| `packages/trace-sdk/src/schema.ts`、`tracer.ts` 及导出、字段文档 | 可选错误 schema、类型和 `EndSpanPatch`；验证写入与读取往返 |
| `packages/agent-loop/src/llm-client.ts`、`run-loop.ts` 及诊断辅助模块、导出 | 单一脱敏纯函数与统一限长；客户端各异常入口及 loop 落盘前复用，传递 SSE 脱敏上下文；复用已有 `LlmRequestError.status` |
| `apps/desktop/src/renderer/src/components/SpanTree.tsx`、`DetailPanel.tsx` | 失败节点、错误详情、缺失提示与空响应文案；沿用现有界面布局 |
| `apps/desktop/src/main/run-create.ts` | 修订“trace 不记录错误详情，请看主进程日志”的现有失败提示 |
| `apps/desktop/src/shared/derive.ts`、`ipc.ts` | 基于 `leafSpanIds` 的缺失提示纯派生与传输验证；IPC 已复用 `SpanSchema`，无需新增通道或复制错误 schema |
| `packages/trace-test/src/cassette-llm-client.ts`、`rerun.ts` 的相关测试 | 先消费调用再以 `LlmRequestError` 重现失败并保留 status；验证 exhausted/remaining 配置错误判定不受干扰 |
| 相关测试及 fixtures | 错误落盘、脱敏、旧 trace 兼容、桌面展示和卡带失败重现 |

不增加第三方依赖，不新增数据库列或持久化派生缓存。经过 `runLoop` 的各运行入口共享该记录能力；它们各自的完成通知、自动跳转及 IPC 成败契约不在本次统一改造。

## 源码依据

以下为当前源码事实，不是针对真实 provider 的实测结论：

- `packages/agent-loop/src/run-loop.ts` 的失败分支只 `console.error`，写入空 `response` 后结束 run；`packages/agent-loop/test/run-loop.test.ts` 现有失败用例仅断言终止结果和 messages，未验证详情落盘。
- `packages/agent-loop/src/llm-client.ts` 已有 `LlmRequestError.status`；HTTP 非成功响应取前 200 字符、SSE JSON 解析失败取前 100 字符，新增脱敏必须覆盖这些截断入口。
- `packages/trace-sdk/src/schema.ts` 的 `LlmCallSpanSchema` 没有错误字段；`tracer.ts` 在 `endSpan` 时经 schema 解析，因此不能只在调用处额外传字段而不改 schema。
- `apps/desktop/src/renderer/src/components/SpanTree.tsx` 只标注工具错误；`DetailPanel.tsx` 对空正文统一显示“无正文，仅有工具调用”。
- `packages/llm-proxy/src/handler.ts` 对上游非成功响应只记录 meta 和终止事件、不写 `llm.call`；该路径需要独立的采集设计，本次不承诺覆盖其错误原因。
- `packages/trace-test/src/cassette-llm-client.ts` 当前只返回 `span.response`，必须显式适配新错误字段，才能重现失败而非成功空响应。

本次不依赖特定 provider 的错误响应格式；验收使用可注入客户端与受控本地 HTTP/SSE 服务，不要求真实密钥或付费调用。

## 验收标准

1. **错误可持久诊断**：受控 HTTP 401/429/500、网络拒绝、SSE 中断或非法 JSON、普通 Error 与非 Error 抛出均能生成可读的失败 trace；重新加载后可看到非空错误详情。HTTP 状态码只在已知时存在；终止事件、已完成消息和不重试行为保持一致。`throw {}`、`throw undefined`、`throw null`、空白 message 及字符串转换抛错的对象均落固定兜底文案；有诊断价值的字符串保留脱敏后的内容。
2. **凭据不随错误输出**：分别通过内置 HTTP/SSE 客户端和注入客户端构造凭据回显，覆盖 API key、baseURL 认证信息、Authorization/Bearer 文本及旧 200/100 字符、新 1024 字符截断边界。确认 trace、事件、桌面提示及保留的日志无测试凭据或因提前切片残留的凭据前缀，最终 message 长度不超过 1024，保留日志复用最终 message。此项针对新增诊断链路，不等同于对全部历史请求内容做隐私清洗。
3. **界面可辨认**：打开失败 run，能够定位有记录的失败 LLM 节点并阅读原因；成功空响应、仅工具调用、仅思维链的成功响应和失败空响应有正确文案。错误详情长文本可换行或滚动，窄窗口不遮挡请求与操作区。覆盖 LLM error 存在/缺失、工具 error 为字符串/null 的四种节点状态，确认判据按 kind 区分。
4. **兼容与缺省**：旧成功、旧失败、代理失败及缺失错误字段的 fixtures 均可读取；有错误终止却无详情时显示“错误详情未记录”，成功 run 不显示该提示。共享派生测试显式构造“祖先有 error、本 run 无 error 且错误终止”的合并轨迹，验证 `leafSpanIds` 过滤后仍显示缺失提示；本 run 有 error 时才隐藏该提示。验证新读取器保留字段、旧 schema 剔除字段的降级行为，以及新 schema 拒绝 LLM `error: null`。
5. **共享路径不丢字段**：验证 Tracer 事件、JSONL 往返、分支解析与详情 IPC；原生创建失败文件保持可加载，通过 `runLoop` 执行的工具结果重跑、prompt fork 和模型 A/B 的失败调用均保留详情，父文件不变。
6. **卡带重现失败**：消费带错误的录制调用后，Trace-as-Test 得到对应 error outcome，已录制的 status 在新 span 中保留，缺失 status 不补造；失败调用恰好消费一次，request drift 照常记录，不设置 exhausted，无真实网络请求。分别覆盖正常消费至录制失败、卡带耗尽和失败后仍有剩余三条路径，后两者仍由编排层判为配置错误；既有成功卡带不回归。

实施阶段运行相关包测试、项目质量门禁及桌面完整构建，并通过受控失败数据完成桌面展示检查。本次 proposal 编写不代表这些实现验收已经通过。

## Non-goals

- 不增加自动重试、超时策略、取消按钮，也不调整请求过程中取消被捕获后的既有终止分类。
- 不扩展 HTTP 200 内嵌错误、异常 SSE 结束等新的错误检测规则；本次保存客户端已经识别并抛出的失败。
- 不改造代理录制或 `proxy:fork` 的错误采集，不承诺所有代理失败都有调用级详情。
- 不新增错误分类体系、自动根因推断、修复建议、独立错误面板或全局执行反馈改版。
- 不改变 `run.event` 枚举、`RunResult` 返回契约、封存状态定义或 fork 门禁；不将错误详情重复存入运行摘要。
- 不保存失败前的部分流式输出，不重构失败 usage/TTFT 的存储模型或全局统计口径。
- 不修改封存 trace、不补造历史错误，不做全部 prompt/工具结果的隐私清洗。
- 不做版本号、changelog、打包发版，不引入既定技术栈之外的新依赖。

## 保真度边界

本 change 为真实执行增加诊断数据，不改变时间旅行的执行范围：工具结果重跑仍复用分叉点前的录制前缀、前缀零 LLM 调用，分叉点后的工具按既有逻辑真实执行；prompt fork 与模型 A/B 仍从启动上下文重跑。只有自身契约保证纯函数的工具可视为 pure；依赖文件、网络、记忆或数据库的工具与外部状态仍属 best-effort，不承诺回退或撤销副作用。

Trace-as-Test 仅按卡带记录重现“该次 LLM 调用失败”，不复现实际网络、provider 状态、耗时或取消过程；缺失历史错误详情时不推测原因。
