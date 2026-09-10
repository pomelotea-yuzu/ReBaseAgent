# Tasks: fix-llm-ttft-timing

> 编号变更（2026-09-10 审阅后）：§2 新增 **2.1 延时流 helper**，原 2.1–2.5 顺延为 2.2–2.6；
> §3 新增 **3.1 重建 agent-loop 产物**，原 3.1–3.5 顺延为 3.2–3.6。原编号引用已同步。

## 1. SSE 聚合器：取时点进流（核心修复）

- [x] 1.1 在 `packages/agent-loop/src/llm-client.ts`：抽出 `hasContentDelta(event)` 谓词（`delta.content` 非空字符串 / `delta.reasoning_content` 非空字符串 / `delta.tool_calls` 为数组；`JSON.parse` 失败返回 `false` 且不吞错）。验证：谓词与聚合循环内既有判定逐条对应，无新增语义（**含既有 quirk：空 `tool_calls: []` 亦为真**，见 proposal Non-goals）
- [x] 1.2 `aggregateSseStream(body, options: { sentAt?: number } = {})`：`const startedAt = options.sentAt ?? Date.now()` 提到函数入口；`onEvent` 内首个 `hasContentDelta` 命中时记 `firstDeltaAt`。验证：读取循环（`reader.read()` / `parser.feed`）逻辑逐字不变
- [x] 1.3 删除聚合循环内的旧计时块（`ttftDone` / `ttftMs` 变量与该 `if` 分支），改为循环后 `ttftMs = firstDeltaAt === null ? 0 : Math.max(0, firstDeltaAt - startedAt)`。验证：`sawAnything` 与 `usage === null` 的错误分支行为不变
- [x] 1.4 `OpenAiCompatClient.complete()`：在 `fetchImpl(...)` **之前**取 `const sentAt = Date.now()`，并以 `aggregateSseStream(response.body, { sentAt })` 调用。验证：`sentAt` 声明位置在 try 之外、fetch 之前

## 2. 测试：必须能证伪旧实现

- [x] 2.1 **新增「延时流」测试 helper**（`packages/agent-loop/test/helpers.ts`）：`sseStreamDelayed(events, { firstDelayMs?, restDelayMs? })` 与 `fetchReturningSseDelayed(...)`，用 `async pull` + `setTimeout` 制造真实延时。**前置理由：现有 `sseStream` / `streamOf` 基于同步 `pull`（所有块 ~0ms 到齐），不建它则 2.2 / 2.3 / 2.5 的偏序断言连正确实现都会失败**
- [x] 2.2 新增「延时下界」用例：延时流首个 content 块前 120ms，断言 `ttftMs >= 100` 且 `<= 本次总耗时`。验证：**在旧实现上该用例必须失败**（改前先跑一次记下结果，作为"测试有效"的证据）
- [x] 2.3 新增「块数无关性」用例（**差分对照**）：同为首块延时 50ms，跑「1 块」与「首块 + 随后 9 块」两条流，断言两者 `ttftMs` 均 `>= 40` 且 `|Δ| <= 40ms`。验证：**单流断言无法证伪"随块数增长"**（旧实现的 ≈0ms 同样满足 `< 总耗时/2`），必须成对比较
- [x] 2.4 新增「usage-only 流保底」用例：仅 usage 无内容 ⇒ `ttftMs === 0`（首块仍带 30ms 延时，确保 `0` 是"无内容 delta"而非"没测到"）。验证：与既有错误分支（无内容且无 usage ⇒ 抛 `LlmRequestError`）不冲突
- [x] 2.5 新增端到端用例：`OpenAiCompatClient.complete()` 经注入的延时 fetch（80ms），断言 `ttftMs > 0` 且 `<= ` 该次总耗时。验证：**必须用延时 fetch**——零延时 mock 下 `> 0` 会误报失败
- [x] 2.6 保留 `test/llm-client.test.ts:47` 的 `>= 0` 断言，并在其旁注明"该断言不足以发现取时点错误"（防将来又只剩它）。验证：注释清楚指向本 change

## 3. 验证与回归

- [x] 3.1 **重建 agent-loop 产物**：`cwd=packages/agent-loop` 直调 `./node_modules/.bin/tsc.CMD -p tsconfig.json`（或根 `pnpm -r build`）。验证：`dist/llm-client.js` 含新逻辑（`firstDeltaAt`）、`dist/llm-client.d.ts` 的 `aggregateSseStream` 已带第 2 参。**跨包（replay 的 `rebaseagent-model-ab` bin、desktop 的 `externalizeDepsPlugin`）解析的是 `dist/`，不重建则 3.5 会验到旧代码、打包产物继续带 bug**
- [x] 3.2 `packages/agent-loop` vitest 全绿（既有 52 + 新增约 4）——cwd 必须是包目录（勿用 `--root`，会出 `instanceof` 假阳性）
- [x] 3.3 其余五包回归：trace-sdk 75 / replay 66 / llm-proxy 16 / trace-test 65 / desktop 156 保持全绿（本变更不触碰它们，用于排除连带影响）——**在 3.1 之后跑**，让 replay / desktop 经新 dist 回归
- [x] 3.4 `biome check .` 0 errors
- [x] 3.5 真实 provider 抽样核验（**零成本优先**）：对本机 Ollama 跑一次真实调用（可复用 `scripts/create-ab-parent.mjs` 或 `rebaseagent-model-ab` 臂），断言新 trace 的 `0 < ttft_ms < dur_ms`（结构性判据：不得等于总耗时、也不得仍是解析耗时；**若仍落在个位数（如 `2`）说明 3.1 未生效**）。对照修复前同场景的 `2ms`。验证：`DetailPanel` 打开该 span，首 token 延迟与耗时不再自相矛盾
- [x] 3.6 `openspec validate fix-llm-ttft-timing --strict` 通过（本仓约定：归档后跑 `--all --strict`）

## 4. 收口

- [x] 4.1 `packages/agent-loop/README.md`：若有 ttft 相关描述，与 spec 定义对齐（现 55 行仅罗列字段名，如无需改则说明）
- [x] 4.2 归档 change 并更新主 spec（`agent-loop` 新增 Scenario 落进 `openspec/specs/agent-loop/spec.md`）
- [x] 4.3 更新 `HANDOFF.md`：把 §六 的「🐞 已知缺陷：`ttft_ms` 是假数据」从**缺陷**改为**已修 + 修复判据**；同时在 §三 测试矩阵更新 agent-loop 用例数
- [x] 4.4 把修复结论回写 `docs/2026-09-10-dogfood-plan.md`（D4 状态 → 已修；§七 F7 风险行标注"根因已修，旧 trace 仍不可信"）
- [x] 4.5 记录**跨包口径差异**（design.md D5）：`packages/trace-sdk/README.md` 字段表把 `response.ttft_ms` 的口径写明为"首个含内容 delta 的 chunk 与请求发出时刻之差；`llm-proxy` 录制的 run 起点为聚合开始、不含等待响应头"。验证：字段表文字与 design.md D5 表一致；不新增代码改动
