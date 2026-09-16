## 1. trace-sdk：错误的存储形态

- [x] 1.1 `packages/trace-sdk/src/schema.ts`：新增 `LlmCallErrorSchema`（`message: string.min(1)` + `status: number.int.positive().optional()`）与 `LlmCallSpan` 顶层可选 `error`；schema 注释写明「缺省 = 未记录，不证明成功」「与 `tool.invoke.error` 同名异构」「`null` 非法」（验证：`schema.test.ts` 5 个新用例——带 status / 无 status / 缺省 / `error: null` 拒绝 / 空 message·非法 status 拒绝）
- [x] 1.2 `packages/trace-sdk/src/tracer.ts`：`EndSpanPatch` 的 llm 分支扩为 `{ response: LlmResponse; error?: LlmCallError }`（验证：run-loop 5 个用例经事件流捕获 span.end；`reader.test.ts` 3 个往返用例）
- [x] 1.3 导出与注释同步（`index.ts` 导出 `LlmCallErrorSchema` / `LlmCallError`）；确认 `readRun` 保留该字段、`error: null` 被读取器拒绝（验证：`reader.test.ts` 新增 3 用例）

## 2. agent-loop：归一化、脱敏与落盘

- [x] 2.1 新增 `packages/agent-loop/src/diagnostic.ts`（零依赖纯函数）：`GENERIC_LLM_FAILURE` / `DIAGNOSTIC_MAX_LENGTH`(1024) / `TRUNCATION_MARKER` / `normalizeFailureText` / `buildRedactionSecrets` / `redactDiagnosticText` / `limitDiagnosticText` / `sanitizeDiagnosticText`（验证：`diagnostic.test.ts` 14 用例——四类无效值兜底、`String()` 抛错不炸、三类通用规则、源去重、1024 边界与幂等、顺序铁律）
- [x] 2.2 `llm-client.ts`：构造时算 secrets；HTTP 非 2xx **删 200 字符切片**、SSE 解析失败 **删 100 字符切片**，改为「完整文本 → 脱敏 → 限长」；网络异常/流中断同法；`AggregateOptions` 增可选 `secrets`（无参数调用保持兼容）；导出 `extractHttpStatus`（验证：`llm-client.test.ts` 5 个新用例，含"凭据在旧切片之外仍被替换"的可证伪用例）
- [x] 2.3 `run-loop.ts`：失败分支归一化 → 脱敏 → 取 status → 与占位 response **同一 patch** 写入 `error`；`console.error` 复用最终 message（验证：`run-loop.test.ts` 5 用例——status 保留 / 普通异常不猜 status / 非 Error 兜底 / 注入客户端凭据脱敏 / 5000 字符限长 1024）
- [x] 2.4 `index.ts` 导出诊断函数与 `extractHttpStatus` / `AggregateOptions`（验证：trace-test 与 desktop 直接引用编译通过）

## 3. trace-test：卡带重现失败

- [x] 3.1 `cassette-llm-client.ts`：游标推进后用 `span.error` 抛 `LlmRequestError(message, status)`；不返回占位 response、不置 `exhausted`（验证：`llm-error-cassette.test.ts`——status 保留 / 缺 status 不补造 / 游标不回退·恰好消费一次）
- [x] 3.2 `rerun.ts` 的 `exhausted`/`remaining` 判定顺序不变；补「失败后仍有剩余 ⇒ 配置错误」用例（验证：同文件 3 条 rerun 路径 + 既有成功卡带不回归）
- [x] 3.3 结构对齐不把错误自由文本纳入判据（验证：`shape-align` 既有断言不变，带 error 卡带对齐通过）

## 4. desktop：标记、详情与诚实降级

- [x] 4.1 `shared/derive.ts` 新增 `deriveMissingLlmErrorDetail`（错误终止 + `leafSpanIds` 过滤后无 `llm.call.error`）（验证：`derive.test.ts` 6 用例——本 run 有/无 error、祖先有 error 本 run 无、两侧都有、成功 run、代理失败无 span）
- [x] 4.2 `SpanTree.tsx`：`hasError` 按 kind 两分支（工具 `!== null`、LLM `!== undefined`）（验证：GUI 冒烟——失败节点带 ✕、无 error 字段的 LLM 节点不标红）
- [x] 4.3 `DetailPanel.tsx`：`LlmCallDetail` 增错误 Section（message + 可选 `HTTP <status>` + 占位零值声明）；空响应四档文案；新增 `ErrorDetailNotice` 挂在 `BranchNotice` 之后（验证：GUI 冒烟 14 项断言 + 截图复核）
- [x] 4.4 `main/run-create.ts` 失败文案改为引导点开 run 看错误详情（验证：`run-create.test.ts` 增断言 error 已落盘；`store.test.ts` fixture 文案同步）

## 5. 回归与门禁

- [x] 5.1 重建改动包的 dist（trace-sdk / agent-loop / trace-test，另全量重建 5 个 packages）
- [x] 5.2 6 包测试全绿：llm-proxy 18 / trace-sdk 87 / agent-loop 104 / trace-test 74 / replay 119 / desktop 197 = **599**
- [x] 5.3 `biome check .` 154 文件 0 errors
- [x] 5.4 `openspec validate add-llm-error-detail --strict` 与 `validate --all --strict`（12/12）通过
- [x] 5.5 桌面完整构建 `electron-vite build` 通过
- [x] 5.6 受控失败数据的桌面展示检查：`apps/desktop/scripts/llm-error-cdp-smoke.cjs`（自管理 fixture、14 项断言全过、退出后无残留 fixture）

## 6. 文档与收口

- [x] 6.1 README（能力条 + 路线图 ✅ + 「当前限制」补代理失败与脱敏边界）/ HANDOFF 状态块同步
- [x] 6.2 分次提交（三件套文档 / 实现 / 测试+文档），中文 message，收尾汇报待 push
- [x] 6.3 归档（`openspec archive add-llm-error-detail -y`，2026-09-16）——owner 已验收；落 4 份主 spec（+6 requirement / ~1 modified / -0）

## 归档记录（2026-09-16）

- `openspec archive add-llm-error-detail -y`：22/23 → 23/23（归档动作本身为最后一项，执行后勾选）
- 落主 spec：`agent-loop` +2、`desktop-ui` +2（另 MODIFIED「桌面端提供原生 run 创建入口」，8 个原 scenario 全部保留）、`trace-as-test` +1、`trace-format` +1；Totals **+6 / ~1 / -0 / →0**
- `validate --all --strict`：**11/11 通过**（主 spec 11 个，无活动 change）
- 审阅文档 `docs/reviews/2026-09-16-add-llm-error-detail-review.md` 随本目录一并归档为 `review.md`（与 A2 归档同形）

