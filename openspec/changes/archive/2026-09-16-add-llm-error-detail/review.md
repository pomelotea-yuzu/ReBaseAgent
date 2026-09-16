# 审阅：`add-llm-error-detail` proposal

- 日期：2026-09-16
- 审阅对象：`openspec/changes/add-llm-error-detail/proposal.md`（该 change 目前仅产出 proposal，design / specs / tasks 尚未生成，以下 P2 项均为 design/spec 阶段必须钉死的落点）
- 审阅方式：逐条比对仓库实际源码（run-loop.ts、llm-client.ts、schema.ts、tracer.ts、SpanTree.tsx、DetailPanel.tsx、run-create.ts、run-repository.ts、derive.ts、ipc.ts、cassette-llm-client.ts、llm-proxy/handler.ts）
- 结论：**方向正确，范围收敛得当，源码依据全部核实，无 P1；5 个 P2 需在 design/spec 阶段钉死。**

---

## 总评

这个 proposal 补的是一个真实的可诊断性断点：`runLoop` 失败分支目前只 `console.error`（[run-loop.ts:115-117](file:///d:/ReBaseAgent/packages/agent-loop/src/run-loop.ts#L115-L117)），trace 里只留空响应占位，用户重开 run 无从排查。设计思路成熟：

- **在失败发生处记录、经既有 Tracer 事件流落盘、不建第二通道**——与项目"观测全部经 Tracer 流出"的既有纪律一致；
- **诚实降级语义贯穿始终**：「缺失 error ≠ 调用成功」「不猜造历史失败原因」「不借用祖先错误充当本次原因」，与 cache_hit 存在性判定的先例（`0` 是有值 / `undefined` 是未知）同一语义家族；
- **脱敏的顺序陷阱被前置识别**：「先截断再脱敏会让密钥只剩前缀、无法按完整值替换」——这是最容易踩的实现坑，proposal 明确要求客户端截断前处理；
- **保真度边界一节**延续了项目惯例（pure/best-effort 工具区分、卡带不复现网络状态），措辞与既有 change 一致。

Non-goals 清单完整（不重试、不改终止分类、不覆盖代理采集、不做根因推断），避免了把一个诊断补全 change 漂移成错误处理体系改版。

## 源码依据核查

proposal「源码依据」节的全部断言经逐一核实，**全部准确**：

| 引用 | 实测 | 结论 |
|---|---|---|
| 失败分支只 `console.error` + 空响应占位 | [run-loop.ts:113-130](file:///d:/ReBaseAgent/packages/agent-loop/src/run-loop.ts#L113-L130) | ✅ |
| 已有 `LlmRequestError.status` | [llm-client.ts:22-30](file:///d:/ReBaseAgent/packages/agent-loop/src/llm-client.ts#L22-L30) | ✅ |
| HTTP 非 2xx 取前 200 字符 / SSE 解析失败取前 100 字符 | [llm-client.ts:140](file:///d:/ReBaseAgent/packages/agent-loop/src/llm-client.ts#L140)、[llm-client.ts:280](file:///d:/ReBaseAgent/packages/agent-loop/src/llm-client.ts#L280) | ✅ |
| `LlmCallSpanSchema` 无错误字段 | [schema.ts:144-162](file:///d:/ReBaseAgent/packages/trace-sdk/src/schema.ts#L144-L162) | ✅ |
| `endSpan` 经 schema 解析，只传字段不改 schema 不生效 | [tracer.ts:125](file:///d:/ReBaseAgent/packages/trace-sdk/src/tracer.ts#L125)（且 zod object 默认 strip 未知键，非报错——静默丢弃） | ✅ |
| SpanTree 只标注工具错误 | [SpanTree.tsx:28](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/components/SpanTree.tsx#L28) `span.kind === "tool.invoke" && span.error !== null` | ✅ |
| DetailPanel 对空正文统一显示「无正文，仅有工具调用」 | [DetailPanel.tsx:748-749](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx#L748-L749) | ✅ |
| run-create 失败提示「trace 不记录错误详情，请看应用主进程日志」 | [run-create.ts:115-118](file:///d:/ReBaseAgent/apps/desktop/src/main/run-create.ts#L115-L118) | ✅ |
| 代理上游非 2xx 只落 meta + 终止事件、不写 `llm.call` | [handler.ts:178-183](file:///d:/ReBaseAgent/packages/llm-proxy/src/handler.ts#L178-L183) | ✅ |
| 卡带客户端只返回 `span.response` | [cassette-llm-client.ts:131-141](file:///d:/ReBaseAgent/packages/trace-test/src/cassette-llm-client.ts#L131-L141) | ✅ |
| IPC 已复用 `SpanSchema` | [ipc.ts:20](file:///d:/ReBaseAgent/apps/desktop/src/shared/ipc.ts#L20)、[ipc.ts:95](file:///d:/ReBaseAgent/apps/desktop/src/shared/ipc.ts#L95) | ✅ |
| run-loop 现有失败用例仅断言终止结果和 messages | [run-loop.test.ts:153-160](file:///d:/ReBaseAgent/packages/agent-loop/test/run-loop.test.ts#L153-L160) | ✅ |

一个顺带的发现：`（无正文，仅有工具调用）` 这条现有文案对 **reasoning-only 的成功响应**（content 为 null、tool_calls 为空、仅有思维链）本就不准确——proposal「空响应按是否确有工具调用区分文案」会顺手修正这一点，属于额外收益。

## P2（design/spec 阶段必须钉死）

### P2-1 脱敏函数的单一落点与应用点清单

proposal 正确提出了「先脱敏再截断」的顺序约束，但脱敏需要**两处应用**：`llm-client` 的诊断片段截断前（密钥在那里可见），以及 `runLoop` 归一化注入客户端错误时（注入客户端的消息从未经过 `llm-client`，`String(e)` 产物可能含任意内容）。若实现只在其中一处脱敏，另一处即为泄漏口；若两处各写一份，又踩项目「同一语义只写一处」的既有纪律（history 里因此翻过车）。

**要求**：design 明确单一纯函数（建议 agent-loop 内定义并导出，secrets 列表 = `config.apiKey` + baseURL 派生的认证信息），列明全部应用点（`llm-client` 截断前、`runLoop` 落盘前、保留的 `console.error` 复用同一结果），并定义统一长度上限与既有 200/100 切片的关系（是放宽既有切片还是另设最终上限）。

### P2-2 卡带重放的错误构造与 status 保留

`runLoop` 现有 catch 不区分错误类型（[run-loop.ts:115](file:///d:/ReBaseAgent/packages/agent-loop/src/run-loop.ts#L115) 只取 `e.message`）。新逻辑需 `instanceof LlmRequestError` 才能取得 `status`。相应地，卡带客户端重放带 `error` 的调用时应抛 **`LlmRequestError(recorded.message, recorded.status)`** 而非普通 Error——否则新 run 的失败 span 丢 status，录制有而重放无。另需钉死 cursor 计数顺序（先消费计数、后抛错，保证验收 6 的「卡带消费计数正确」），以及 `TraceTestConfigError`（卡带耗尽）与重放 `LlmRequestError`（录制失败）两条失败路径在编排层 `rerun.ts:95` 处的判定不互相干扰。

### P2-3 「错误详情未记录」判定锚定既有 `leafSpanIds`

验收 4 要求「只检查本 run 自有 spans，不能借用祖先错误充当本次原因」。数据通路已存在：`getRun` 对分支 run 返回 `resolveBranch` 合并轨迹，但同时随附 **`leafSpanIds`**（[run-repository.ts:41-50](file:///d:/ReBaseAgent/apps/desktop/src/main/run-repository.ts#L41-L50)，注释原话「当前 run 自身新增的 span」）。若实现者在 renderer 用合并后的 spans 数组直接查「有无带 error 的 llm.call」，祖先的失败记录会冒充本次原因——恰好是验收条款想防的坑。

**要求**：design 显式写明判定基于 `RunDetail.leafSpanIds` 过滤后的 spans（或 main 侧用 `loadRunRecord` 自有记录完成判定后带出），并建议判定本身落 `shared/derive.ts` 纯函数（先例：`findStepLlm` 上移共享）。

### P2-4 归一化「有效文本」判据过宽

proposal 说 `message` 为「非空诊断文本」，且「取不到有效文本时使用明确的通用失败文案」。但非 Error 抛出的归一化走 `String(e)`：`throw {}` → `"[object Object]"`，`throw undefined` → `"undefined"`——非空，但无诊断价值。按字面实现会把这些垃圾文本当详情落盘。

**要求**：design 钉死有效文本判据（如：空串、`"[object Object]"`、`"undefined"`/`"null"` 这类 `String()` 标准产物触发通用失败文案），或在 spec 场景里加对应用例。

### P2-5 `error` 字段与 `tool.invoke.error` 同名异构

`tool.invoke.error` 是 `string | null`（数据性错误，null = 成功）；新增 `llm.call.error` 是 `object | undefined`（存在即调用失败）。同名不同型、语义相反方向（一个是"null 才正常"，一个是"undefined 才正常"），消费端极易混淆。

**要求**：schema 注释与 design 注明两者语义差异；SpanTree 的 `hasError` 扩展为 llm.call 分支时，判定必须是 `error !== undefined`（对象恒 truthy，倒不会翻车，但与 tool 分支的 `!== null` 形成对照，值得写明防止后续消费者用错判据）。

## 其他确认项（无异议）

- **format_version 保持 1 的降级代价**：旧版本读取器（zod strip 未知键）读新文件会静默丢弃 `error`，失败调用回退显示现状文案——与 `timing` / `budget` / `cache_hit` 可选字段的先例一致，属可接受的向后兼容代价，design 注明即可。
- **范围收敛正确**：不动终止分类、不重试、不覆盖代理采集（代理失败 run 诚实显示「错误详情未记录」）、卡带不把错误文本纳入结构对齐（shape-align 本就只比 kind/parent/n/tool/args/tool_calls/count/outcome，自由文本不参与）。
- **失败 span 保留占位 response + 顶层 error 的结构选择合理**：`deriveStepStats`/`deriveRunSummary` 的 usage 求和天然吞掉占位零值，无需改派生层；卡带与 UI 都已列为显式适配点。
- **与「更可视化」方向的相容性**：错误标记 + 详情展示属于可诊断性的最小增量，不在 v2 前引入新面板或错误体系，符合既定的路线图约束。
- 验收标准可操作（受控 HTTP/SSE、注入客户端、脱敏回显构造），不依赖真实 provider。

## 可应用性

**无 P1。** P2-1 ～ P2-5 均为 design/spec 阶段的钉死项——proposal 的事实基础与约束条件完备，生成 design 时把上述五点的落点写实即可 apply；实现过程中 P2 项随对应任务一并验收。
