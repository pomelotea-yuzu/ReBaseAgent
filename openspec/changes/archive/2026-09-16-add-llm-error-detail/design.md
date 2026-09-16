# LLM 调用失败详情落盘与展示 · 设计

> 承接 proposal「设计约束」节的 P2-1 ～ P2-5（2026-09-16 审阅）。文末附「审阅项 → 处理」对照表。
> 本设计的所有签名断言均已对回真实代码（本次 apply 前的核实结果见 §9）。

## 1. 范围与不变量

- 失败**只记录**、不改写历史文件：`format_version` 保持 `1`，旧 trace 照旧可读。
- 观测仍走唯一出口（Tracer 事件流 → JsonlTracer 落盘）；不新开第二通道、不额外写文件。
- `llm.call` 的 `response` 占位结构保持不变（空 content、`tool_calls: []`、`usage: {in:0,out:0}`、`ttft_ms: 0`）——派生层（`deriveStepStats` / `deriveRunSummary` / `deriveBudgetSeries`）的求和天然吞掉占位零值，无需改动。
- 失败语义仍由 `run.event.reason === "error"` 表达；`RunRecord.status` 取值域不变（仍只有 `completed | crashed`）。
- 不重试、不追加失败轮 assistant 消息、不把错误文本混进 messages 或 `response.content`。

## 2. 数据形态（trace-format）

`llm.call` span **顶层**新增可选 `error`（与 `request` / `response` 平级）：

```ts
export const LlmCallErrorSchema = z.object({
  message: z.string().min(1),                 // 脱敏 + 限长后的非空诊断文本
  status: z.number().int().positive().optional(), // 仅在实际取得 HTTP 错误状态码时写入
});
export type LlmCallError = z.infer<typeof LlmCallErrorSchema>;
```

- **缺省语义**：成功调用省略 `error`；老文件缺省合法。**字段缺失 ≠ 调用成功**（无法从中反推），文档与类型注释都写明。
- `error: null` **非法**（`.optional()` 只接受 `undefined`）——与 `tool.invoke.error` 的 `string | null` 明确区分（见 §7）。
- schema 不做 `.max(1024)` 硬校验：限长由写入侧保证（§4），读取侧对超长旧数据保持宽容，避免"读不了"变成新的失败模式。

`EndSpanPatch`（`tracer.ts`）的 llm 分支由

```ts
| { response: LlmResponse }
```

扩为

```ts
| { response: LlmResponse; error?: LlmCallError }
```

（工具分支的 `{ result?; dur_ms: number; error: string | null }` 不动——两个分支靠 `dur_ms` / `response` 区分，不靠 `error`。）

## 3. 归一化与兜底（P2-4）

新增模块 `packages/agent-loop/src/diagnostic.ts`，**零依赖纯函数**（不 import `llm-client.js`，避免与客户端形成循环依赖）：

| 导出 | 语义 |
|---|---|
| `GENERIC_LLM_FAILURE` | `"LLM 调用失败，未提供有效错误信息"` |
| `DIAGNOSTIC_MAX_LENGTH` | `1024`（UTF-16 代码单元，含截断标记） |
| `TRUNCATION_MARKER` | `"…[已截断]"`（6 个代码单元） |
| `normalizeFailureText(e: unknown): string` | 取候选文本（**未脱敏**），无有效文本时返回 `GENERIC_LLM_FAILURE` |
| `buildRedactionSecrets(input: { apiKey?; baseURL? }): string[]` | 本次运行的已知 secrets |
| `redactDiagnosticText(text, secrets): string` | 字面量 + 通用规则替换 |
| `sanitizeDiagnosticText(text, secrets): string` | 脱敏 → 限长（唯一对外组合入口） |

归一化判据（**有效文本**才算详情）：

1. `e instanceof Error` → 取 `e.message`；
2. `typeof e === "string"` → 取 `e`；
3. 其他值 → `String(e)`，**用 try/catch 包住**（`Symbol` 等转换会抛），失败即兜底；不序列化任意对象（不 `JSON.stringify` 未知值）。

得到文本后 `trim()`，命中以下任一即改用 `GENERIC_LLM_FAILURE`：空串、`"undefined"`、`"null"`、`"[object Object]"`。兜底文案同样经过 `sanitizeDiagnosticText`，且归一化自身**绝不允许抛错**（否则会连终止记录一起丢）。

`status` 的取得：**只从 `LlmRequestError.status`**（`typeof === "number" && Number.isInteger && > 0`），普通异常/字符串一律不猜。该判定放在 `llm-client.ts` 导出的 `extractHttpStatus(e: unknown): number | undefined`（类定义在同文件，无循环风险），loop 侧只调用它。

## 4. 脱敏顺序、应用点与长度口径（P2-1）

**顺序铁律：先脱敏、后截断。** 反之密钥被切掉后半段后无法按完整值替换，会残留可识别前缀（正是本 change 要防的泄漏口）。因此**删除**现有的提前切片：

- `llm-client.ts` HTTP 非 2xx：原 `text.slice(0, 200)` ⇒ 不再切片，先对**完整**响应文本按完整规则脱敏，再统一限长；
- SSE JSON 解析失败：原 `event.data.slice(0, 100)` ⇒ 同样先脱敏（对完整 `event.data`）再限长。

单一纯函数的全部应用点（同一语义只写一处）：

| 应用点 | 位置 | 说明 |
|---|---|---|
| HTTP 非 2xx | `llm-client.ts` `complete()` | 组装完整文案 → `sanitizeDiagnosticText` → `throw LlmRequestError(…, status)` |
| 网络/请求异常 | 同上（`fetch` catch） | 原始异常文本先脱敏再进入 message |
| SSE 流中断 | `aggregateSseStream` reader catch | 同上 |
| SSE JSON 解析失败 | `aggregateSseStream` 聚合循环 | 对完整 `event.data` 脱敏（不提前切片） |
| SSE 结束无有效内容 / 空 body | 既有抛错点 | 文案无外部数据，仍经同一函数通过 |
| 注入客户端异常 | `run-loop.ts` 失败分支 | **归一化后、落盘前**兜底脱敏（注入客户端的文本从未经过内置客户端） |
| 保留的日志 | `run-loop.ts` `console.error` | 直接复用最终 `error.message`，不另行拼接原异常 |

secrets 来源（**不读全局 settings、不依赖 Electron**）：

1. 非空的 `config.apiKey`；
2. `config.baseURL` 经 `new URL()` 解析出的 `username` / `password`（userinfo 凭据；解析失败则不做额外推断）。

替换规则（先字面量、后通用，通用规则见下）：

1. **字面量**：把每个 secret 的全部出现替换为 `[已脱敏]`（`split/join`，非正则，避免 secret 含正则元字符）。**逐字替换不做长度门槛**——宁可过度脱敏也不漏（短的假 key 最多让文案变难看，不会泄漏）。
2. `Bearer <token>` → `Bearer [已脱敏]`；
3. `Authorization: <value>` / `Authorization=<value>` → 保留键名，值替换；
4. `scheme://user:pass@host` → `scheme://[已脱敏]@host`。

限长：`text.length > 1024` 时取前 `1024 - 6` 个代码单元 + `…[已截断]`，**标记计入 1024**。函数幂等（已 ≤1024 的文本二次调用不变），因此"客户端已脱敏 + loop 再兜底"不会二次变形。

`aggregateSseStream` 的可选项 `AggregateOptions` 增加 `secrets?: readonly string[]`：**可选、缺省为空数组**，既有（无参数）调用保持兼容；`OpenAiCompatClient` 在构造时算一次 secrets 并**必须传入**。

不承诺：识别任意业务文本中的所有秘密（如 provider 把 key 哈希后回显、或用户把 key 粘进 prompt 正文）。

## 5. loop 落盘（agent-loop）

`run-loop.ts`：

1. 进入循环前算一次 `const secrets = buildRedactionSecrets(config);`。
2. 失败分支：

```ts
const message = sanitizeDiagnosticText(normalizeFailureText(e), secrets);
const status = extractHttpStatus(e);
const error: LlmCallError = { message, ...(status === undefined ? {} : { status }) };
console.error(`[runLoop] LLM 调用失败：${message}`);
tracer.endSpan(llmSpan, { response: { …既有占位… }, error } satisfies EndSpanPatch);
```

3. 其余行为逐字不变：`tracer.endSpan(step)` → `endRun({ event: "errored", reason: "error", at: iteration })` → 正常返回 `{ messages, event }`（**不抛错**，成败判据仍是终止事件）。

## 6. 卡带重放（trace-as-test，P2-2）

`CassetteLlmClient.complete()` 的顺序钉死为：

1. 耗尽检查（`cursor >= recorded.length` ⇒ 置 `exhausted` 后抛 `TraceTestConfigError`，**不变**）；
2. 取 `recorded[cursor]`，算结构漂移并 `push` 进 `requestDrift`（**不变**）；
3. `this.cursor += 1`（**先推进游标**——失败调用恰好消费一次）；
4. 若 `span.error !== undefined` ⇒ `throw new LlmRequestError(span.error.message, span.error.status)`；**不返回占位 response、不置 `exhausted`、不发任何网络请求**；
5. 否则照旧返回 `span.response` 映射结果。

要点：

- 抛 `LlmRequestError` 而非普通 `Error`：否则 `runLoop` 取不到 `status`，"录制有、重放无"。
- `runLoop` 会捕获该异常并记 `errored / error`（与既有对 `TraceTestConfigError` 的处理同构），所以录制失败**自然重现为 error outcome**。
- `rerun.ts` 的 `exhausted` / `remaining` 判定**不改**：录制失败后若仍有未消费调用，仍按既有规则报 `TraceTestConfigError`（两条失败路径互不干扰：`exhausted` 只看标志位，重放失败不动标志位）。
- 断言侧不比较错误自由文本：`alignShape` 只比 kind / parent / n / tool / args / tool_calls / count / outcome，天然排除（无需修改 `shape-align.ts`）。

## 7. 同名异构字段（P2-5）

| 字段 | 类型 | 成功判据 | 缺省含义 |
|---|---|---|---|
| `tool.invoke.error` | `string \| null` | `error === null` | 不存在该形态（字段必填） |
| `llm.call.error` | `{ message; status? } \| undefined` | `error === undefined` | **未记录错误详情**，不证明成功 |

消费端纪律：**先按 `kind` 缩窄类型再取判据**，不写统一的"非 null 即错误"。`SpanTree` 的 `hasError` 因此写成两分支；`.d.ts` 注释与 schema 注释同步标注差异；不接受用 `null` 表示 LLM 成功。

## 8. 桌面端展示（desktop-ui）

### 8.1 派生层（`shared/derive.ts`）

```ts
/** 错误终止判定：最后一个 run.event 的 reason === "error" */
export function deriveMissingLlmErrorDetail(input: {
  events: ReadonlyArray<{ reason: string }>;
  /** getRun 返回的（可能是合并后的）轨迹 */
  spans: readonly SpanLine[];
  /** 本 run 自身新增 span 的 id（RunDetail.leafSpanIds） */
  leafSpanIds: readonly string[];
}): boolean;
```

判据：错误终止 **且** `leafSpanIds` 过滤后的 spans 中**不存在** `llm.call.error !== undefined` 的调用。**不得**直接扫描整条合并轨迹——祖先的失败记录会冒充本次原因（P2-3）。自身无 `llm.call` 的代理失败 run 同样返回 `true`（"错误详情未记录"）。

### 8.2 轨迹树（`SpanTree.tsx`）

`hasError(span)` 扩为两分支：工具看 `error !== null`，LLM 看 `error !== undefined`；失败 LLM 节点沿用既有红色 + `✕` 标记（`nodeLabel` 不变）。

### 8.3 详情面板（`DetailPanel.tsx`）

- **失败节点**：`LlmCallDetail` 在「概要」后插入错误 Section（红框）：展示 `error.message`（长文本换行/滚动，沿用 `LongText`），`status` 存在时展示 `HTTP <status>`；并显式声明 **“该次调用失败：上列 tokens / 首 token 延迟为占位零值，不代表实际零消耗或零延迟”**。
- **空响应文案**（替换现有"（无正文，仅有工具调用）"这条对 reasoning-only 也不准确的统一文案）：

| 情形 | 文案 |
|---|---|
| `error !== undefined` | （调用失败，无响应正文） |
| 有 `tool_calls` | （无正文，仅有工具调用） |
| `content` 空但有 `reasoning_content` | （无正文，仅有思维链） |
| 其余空正文 | （响应为空正文） |

- **缺失提示**：新增 `ErrorDetailNotice`（`BranchNotice` 之后渲染，同级横幅）：`deriveMissingLlmErrorDetail` 为真时显示"错误详情未记录"，并指明本次 run 未记录 LLM 调用级错误（可能是代理录制失败或历史 run），**不猜造原因**；成功 run 不显示。轨迹树仍按每个 span 自身的 `error` 标记祖先失败节点——两者不互相隐藏。

### 8.4 原生创建失败提示（`main/run-create.ts`）

文案从"trace 不记录错误详情，请看应用主进程日志"改为引导查看已保留的 run：`run {id} 已落盘，可在列表中点开查看这次请求与错误详情。`

## 9. apply 前对真实代码的核实（本次）

| 假设 | 实测 | 处理 |
|---|---|---|
| `runLoop` 失败分支结构 | `run-loop.ts:111-130`：catch → `console.error` → 占位 response → `endSpan` → `endRun(errored)` | 在占位 response 同一 patch 内加 `error` |
| `EndSpanPatch` 形状 | `tracer.ts:35-38` 三分支 union，无 `kind` 字段 | 仅扩 llm 分支，加可选 `error?: LlmCallError` |
| `endSpan` 会做 schema 解析 | `tracer.ts:125` `SpanSchema.parse`（zod object 默认 strip 未知键 ⇒ 不改 schema 就静默丢字段） | 先改 schema 再加字段 |
| `LlmCallSpanSchema` 无错误字段 | `schema.ts:144-165` | 新增顶层 `error` |
| HTTP 200 / SSE 100 切片点 | `llm-client.ts:140`、`llm-client.ts:280` | 删切片，改为先脱敏后限长 |
| `LlmRequestError.status` | `llm-client.ts:22-30`，HTTP 分支传 `response.status` | 复用它；新增 `extractHttpStatus` 纯函数 |
| 卡带只返回 `span.response` | `cassette-llm-client.ts:124-142`；游标推进在 `:129`（在返回之前） | 在推进后用 `span.error` 抛 `LlmRequestError` |
| `rerun.ts` 在 loop 返回后查 `exhausted`/`remaining` | `rerun.ts:95-105`，`runLoop` 已把异常收成 errored 返回 | 顺序不变，新增用例覆盖"录制失败 + 无剩余"通过 |
| `RunDetail.leafSpanIds` 存在且语义为"本 run 自身新增" | `run-repository.ts:42` 计算、`ipc.ts:101` 传输，四种返回路径都带上 | 缺失提示以它为唯一锚点 |
| IPC 已复用 `SpanSchema` | `ipc.ts:20`（`RunRecordSchema`）、`ipc.ts:95`（`RunDetailSchema`） | 无需新增通道、不复制错误 schema |
| `SpanTree.hasError` 只认工具 | `SpanTree.tsx:27-29` | 扩为 kind 两分支 |
| `DetailPanel` 空正文统一文案 | `DetailPanel.tsx:748-749` | 按 §8.3 四档改写 |
| `run-create.ts` 旧文案位置 | `run-create.ts:115-119` | 改写该分支文案（spec 同步 MODIFIED） |

## 10. 审阅项 → 处理 对照表

| 审阅项 | 落点 | 处理 |
|---|---|---|
| P2-1 脱敏单一落点与应用点清单 | §4（表 + 顺序铁律 + 1024 口径 + 删 200/100 切片 + SSE 可选参数） | 已钉死；单一纯函数在 `diagnostic.ts`，客户端/loop/日志三处复用 |
| P2-2 卡带错误构造与 status 保留 | §6（顺序 1-5、抛 `LlmRequestError`、不置 exhausted、`rerun.ts` 不改） | 已钉死 |
| P2-3 缺失提示锚定 `leafSpanIds` | §8.1 + §9（该字段四条返回路径都带） | 已钉死为共享纯函数 |
| P2-4 有效文本判据过宽 | §3（`String()` 标准产物与转换失败均兜底） | 已钉死，并加"归一化不得抛错" |
| P2-5 同名异构 `error` | §7（对照表 + 先按 kind 缩窄纪律） | 已钉死（schema 注释 + `.d.ts` + 消费端） |
| 顺带发现：reasoning-only 文案不准 | §8.3 四档文案 | 一并修正 |
| 其他确认项（format_version 1 的降级代价） | §1 / §11 | 接受并写明 |

## 11. 兼容性代价与已知边界

- 旧读取器（zod strip 未知键）读新文件会**静默丢弃** `error`，回退显示现状文案；新读取器保证旧文件可读。不重写历史文件。
- 代理录制路径（`llm-proxy`）上游非 2xx 时不写 `llm.call`，其错误原因**本次不采集**——这类 run 在桌面端显示"错误详情未记录"（诚实缺省）。
- 失败 span 的 `usage` / `ttft_ms` 仍是占位零值（不重构失败用量存储模型）；只保证界面显式声明这不是"实际零消耗/零延迟"。
- 不保存失败前的部分流式输出。

## 12. 未做 / 后续

- 代理失败 run 的调用级错误采集（需独立 change，含 `llm-proxy` 侧设计）。
- 错误分类体系、自动重试、超时/取消策略、错误面板改版（均 Non-goals）。

## 13. 验证记录（2026-09-16）

- **单测**：6 包 **599** 全绿（llm-proxy 18 / trace-sdk 87 / agent-loop 104 / trace-test 74 / replay 119 / desktop 197），零 API 消耗。新增用例：`diagnostic.test.ts`（14）、run-loop 失败详情 5、llm-client 凭据回显与边界 5、schema 5、reader 往返 3、derive 缺失提示 6、卡带失败重现 7、run-create 错误落盘 1。
- **顺序铁律的可证伪用例**：把凭据放在旧 200 / 100 字符切片**之外**（HTTP 与 SSE 各一条），断言最终文本里既无凭据、也不残留其前缀——旧实现必然失败。
- **门禁**：`biome check .` 154 文件 0 errors；`electron-vite build` 通过；`openspec validate --all --strict` 12/12 通过（INFO 为既有「requirement > 500 字符」并列约束聚合，判定不拆）。
- **GUI 冒烟**（零成本、自管理 fixture）：`apps/desktop/scripts/llm-error-cdp-smoke.cjs` 在 dev 应用内写入两条 run（有 `error` / 无 `error` 但错误终止），14 项断言全过——节点 ✕ 标记、错误区文案与 `HTTP 401`、占位零值声明、四档空正文文案、缺失横幅（且不出现状态码），截图见 `.workbuddy/llm-error-smoke/`。
- **未做的真机验证**：未用真实 provider 401/429 做端到端点击（受控 fixture 覆盖了同一代码路径）；`runLoop` 各入口（工具结果重跑 / prompt fork / 模型 A/B）的失败详情只由共享内核保证，未逐一真实计费点开确认。

