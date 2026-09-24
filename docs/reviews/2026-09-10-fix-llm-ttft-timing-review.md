# 审阅：`fix-llm-ttft-timing` proposal

审阅时间：2026-09-10 · 审阅方式：逐条核验（源码行 / spec 行 / 磁盘数据实测）

---

## 结论

**建议放行（apply），但需先补齐 3 项（B1–B3）并修正 3 处小瑕疵（N1–N3）。**

这是一份**高质量**提案：根因定位准确、证据分级诚实（明确标注「实测 / 源码依据 / 未验证假设」三档，且"未验证假设：无"经核验属实）、改动面收得干净（只修取值时点，不碰 schema / UI / format_version）。**核心根因、全部源码行号、标题级实测数据逐条核对无误**。放行障碍不在判断，而在三处「照着做会出错」的执行细节（dist 重建 / 延时流 helper / 块数无关性断言形式）。

---

## 一、核验清单（proposal 断言 → 实况 → 判定）

### A. 根因与源码行号

| proposal 断言 | 实况 | 判定 |
|---|---|---|
| `llm-client.ts:155` 先声明缓冲数组 `events` | 155 行 `const events: EventSourceMessage[] = []`（实测 154 是函数签名） | ✅ |
| `:156` `onEvent` 只 `push` | 156–160 行 `createParser({ onEvent: (e) => events.push(e) })` | ✅ |
| `:161-171` 把整个流读到底 | 163–171 为 `try{ for(;;){ await reader.read(); parser.feed(...) } }` | ✅ |
| `:177` 才 `startedAt = Date.now()` | 177 行原话 | ✅ |
| `:179-224` 在缓冲事件遍历里取 `Date.now()-startedAt` | 179 起 `for (const event of events)`；220–223 为 `ttftDone/ttftMs` 计时块 | ✅ |
| `:131` 调用未传请求发出时刻 | `aggregateSseStream(response.body)`（单参） | ✅ |
| `OpenAiCompatClient.complete()` 缺 `sentAt` | 109 行直接 `fetchImpl(...)`，无前置取时 | ✅ |
| 对照实现 `llm-proxy/handler.ts:453` 流内实测 | 453 行 `ttft_ms: agg.firstTokenAt ?? 0`；412 行 `firstTokenAt = Date.now()-startedAt` 在 `onEvent` 内 | ✅ |
| llm-proxy 计时起点 `:369` = 聚合开始 | 369 行 `const startedAt = Date.now()` 位于 `body.getReader()` 之前 | ✅ |

### B. 测试侧根因

| 断言 | 实况 | 判定 |
|---|---|---|
| `test/llm-client.test.ts:47` 唯一 ttft 断言是 `>= 0` | 47 行 `expect(result.ttftMs).toBeGreaterThanOrEqual(0)`；全文件仅此 1 处 ttft 断言 | ✅ |

### C. 既有 spec 定义（"实现违反 spec 而非设计缺口"这一立论）

| 断言 | 实况 | 判定 |
|---|---|---|
| `archive/2026-09-03-add-agent-loop/design.md:40` 定义 ttft | 40 行逐字：「`ttft_ms`：首个含内容 delta 的 chunk 与请求发出时刻之差」 | ✅ 逐字吻合 |
| 同 archive `tasks.md:11` 要求产出 ttft_ms | 11 行确为 SSE 聚合器任务且含 `ttft_ms` | ✅ |
| 主 spec 未固化该定义 | `specs/agent-loop/spec.md` 该 Requirement 只有 2 个 Scenario，正文无 ttft 取值语义 | ✅ 立论成立 |

### D. 实测证据（标题级）

| 断言 | 实况 | 判定 |
|---|---|---|
| `run_mtv8nqy6_wf3c.jsonl` 实测 `ttft_ms=2`，同次调用 20.1s | span `s_02`：`qwen3.5:4b-8k`、`response.ttft_ms=2`；`timing` 08:01:34.268→08:01:54.388 = **20.120s** | ✅ 精确吻合 |
| 全仓 48 个 `llm.call`，分布 `0×18`、`1×2`、`2`、`7`、`10×6`、其余 250–1200 | 实测 `.rebaseagent/traces` 34 文件 / **48 span**；直方图 `0×18,1×2,2×1,7×1,10×6`，其余 338→1200 | ✅ 计数与分布**完全一致** |
| deepseek-chat 真实调用 160–1656ms 多记 `0` | 与直方图零值聚集（18/48 = 37.5%）一致 | ✅ 合理 |

### E. 影响面与下游

| 断言 | 实况 | 判定 |
|---|---|---|
| `DetailPanel.tsx:609` 「首 token 延迟 2ms」与 610「耗时」并排 | 609 行 `["首 token 延迟", \`${response.ttft_ms}ms\`]`，610 行 `["耗时", ...]` | ✅ 自相矛盾属实 |
| `trace-as-test` 结构对齐忽略 ttft | `specs/trace-as-test/spec.md:38` 明列忽略 `timing、usage、ttft` | ✅ 卡带回归不受影响 |
| 只有 `llm-client.ts:131` 一处生产调用 `aggregateSseStream` | 全仓 grep 确认：生产调用仅此 1 处，其余全在测试 | ✅ 加可选参数安全 |
| 既有 trace 均为 `.rebaseagent/`（gitignored），无需迁移 | `.gitignore:12` = `.rebaseagent/` | ✅ |

---

## 二、必须补齐（B1–B3）

### B1 · 缺「重建 agent-loop 产物」步骤 —— 不改这条，3.4 会验到旧代码

**这是本提案最实质的缺口。** 跨包消费者解析的是 **`dist/`**，不是 `src/`：

- `packages/agent-loop/package.json` → `"exports": { ".": "./dist/index.js" }`（仅 dist）
- `packages/replay`：`bin.rebaseagent-model-ab = ./dist/model-ab-cli.js`，依赖 `@rebaseagent/agent-loop: workspace:*`
- `apps/desktop/package.json` 依赖同一 workspace 包，`electron.vite.config.ts` 用 `externalizeDepsPlugin()` ⇒ 主进程运行时按 Node 解析规则取 **dist**
- 实况：`packages/agent-loop/dist/llm-client.js` 当前正是**旧的缺陷实现**（`startedAt` 位于读流循环之后），dist mtime 2026-09-06

⇒ 只改 `src/` 而不跑 `tsc -p tsconfig.json` 的话：

- `tasks.md` **3.4**（复用 `scripts/create-ab-parent.mjs` / `rebaseagent-model-ab` 对本机 Ollama 抽样）会**验到旧 dist**，`ttft_ms` 仍为 `2ms`，验证者可能误判"修复无效"；
- 更严重的是 `release/` 打包产物会**带着这个 bug 发布**（v0.2.0 已发布，下次打包即受影响）。

**补法**（二选一，推荐前者以对齐本仓"直调包内 bin"约定）：
- 新增任务（建议置于 3.1 之后、3.2/3.4 之前）：
  `3.x 重建 agent-loop 产物：cwd=packages/agent-loop 直调 ./node_modules/.bin/tsc.CMD -p tsconfig.json（或根 pnpm -r build）；验证 dist/llm-client.js 含新逻辑`
- 同时在 `proposal.md → Impact` 与 `design.md → D6` 写明「**源码修复须伴随 dist 重建**，跨包（replay/desktop/CLI/打包）才生效」。

> 附注：agent-loop **自身**测试用相对路径 `../src/index` 导入，故 2.x / 3.1 无需重建即可验证新逻辑；只有 3.2（replay 回归）与 3.4（真机抽样）跨包，必须重建。

### B2 · 缺「带延时流」测试 helper —— 不建它，正确实现也会失败

现有 `test/helpers.ts` 的 `sseStream()`（95–108 行）与 `test/llm-client.test.ts` 的 `streamOf()`（12–25 行）都基于 `ReadableStream.pull` **同步 enqueue、零延时**：

- 所有块在 ~0ms 内到齐 ⇒ 即使实现正确，`firstDeltaAt - startedAt ≈ 0`
- 于是 `2.1` 的 `ttftMs >= 100`、`2.2` 的 `>= 40`、`2.4` 的 `ttftMs > 0` **全部会失败**

`tasks.md` 的文字（"首块前 `await sleep(120ms)`"）隐含了这个意图，但没有"新建延时流 helper"这一步。**必须显式列出**（建议落在 `test/helpers.ts`：`sseStreamDelayed(events, delaysMs)` 或 `pull: async () => { await sleep(d); ... }`），否则实现者复用现成 `sseStream` 必然踩坑。

### B3 · 「块数无关性」断言形式不成立 —— 需改成差分对照

`design.md D4-2` / `tasks.md 2.2` 的单流断言 `ttftMs >= 40 && ttftMs < 总耗时/2` **无法证伪"随块数增长"**：

- 旧实现给出 ≈0–2ms，同样满足 `< 总耗时/2`；真正起证伪作用的只有 `>= 40`；
- 也就是说这条用例退化成"和 2.1 几乎同义"，`design.md` 声称的"块越多解析耗时越大 ⇒ 钉死"**没有被任何断言覆盖**。

**补法**：改成**差分对照** —— 同一首块延时 D（如 50ms），跑两条流（1 块 vs 10 块），断言两者 `ttftMs` 之差在容差内（如 `|Δ| <= 30ms`）。这才是对"不随分块数增长"的直接检验。

---

## 三、建议修正（N1–N3，小）

- **N1 · 行号精度**：`design.md D5` 与 `Non-goals` 处写 llm-proxy 判据为 `handler.ts:385/390/393` —— 385（content）、390（reasoning_content）正确，但 tool_calls 的 `sawAnything = true` 在 **410 行**，393 行是 `if (Array.isArray(tcs))`。建议改为 `385/390/410`（或统一写"三条 `sawAnything = true` 赋值点"）。
- **N2 · 计数漂移**：`Non-goals` 写"既有 **32 个** jsonl"，实测本地为 **34** 个（含 fixtures 共 38）。且该目录被 gitignore、跑完 3.4 后数字立刻变。建议**去掉硬编码计数**，改述为「`.rebaseagent/` 下的本地开发产物（gitignored，随跑随变）」，比写一个会过期的数字更稳。
- **N3 · 需显式声明一处既有 quirk**：新谓词 `hasContentDelta` 忠实复刻了旧判定 —— 而旧判定里 `if (Array.isArray(tcs)) { ... sawAnything = true }` 对**空数组 `delta.tool_calls: []` 也为真** ⇒ 若 provider 发空占位，会把"首个内容 delta"时刻提前定格。这与新 spec 措辞「首个**含内容** delta」存在字面张力。llm-proxy 有**完全相同**的 quirk（393+410），故两包一致、无新增分歧。**建议在 `Non-goals` 补一行**：「空 `tool_calls: []` 计为内容 delta 属既有行为，本变更原样保留，不在本次修正」，以免后续读者误认是本变更引入的缺陷。

---

## 四、设计层面的观察（不阻塞）

1. **D3「被否决方案」表遗漏了最相关的替代方案**：把聚合整体搬进 `onEvent`（照 llm-proxy 结构做单一解析路径）。**但核验后认为提案的"读后统一聚合"是更安全的选择** —— 因为若在 `onEvent` 内 `throw`，会被读流循环的 `catch (e)`（`llm-client.ts:169-171`）捕获并**重写为「SSE 流中断：…」**，从而破坏既有错误语义（`JSON 解析失败` 类错误会变成"流中断"）。llm-proxy 之所以能那么写，是因为它的读流 `catch` 是**吞掉**（`:436`）且解析错误 `return`（`:376`），哲学是 best-effort —— 两包本就不同。**建议在 D3 补一行**说明为何不采用"onEvent 内聚合"（错误语义会被 read-loop catch 重写），这比留白更能挡住将来的"简化"重构。
2. **双次 JSON.parse**：新方案对每个 event 解析两次（onEvent 判谓词 + 聚合循环）。对调试工具可忽略；但可考虑在 `onEvent` 内缓存 `parsed`（如 `WeakMap`/并行数组）以消除重复解析——非必需。
3. **`?sentAt` 的语义正确性**：置于 `fetchImpl` 之前确实覆盖 DNS/TCP/TLS + 请求上行 + 等待响应头，贴合 spec「与请求发出时刻之差」，**比 llm-proxy 的起点更宽**。D5 对差异的记录诚实且必要。**建议后续独立 change 统一两包口径**（提案已如此主张，认同）。
4. **`Math.max(0, …)` 护栏**：防时钟回拨，正确。
5. **delta spec 与主 spec 一致性**：`changes/fix-llm-ttft-timing/specs/agent-loop/spec.md` 的 `## MODIFIED Requirements` 块，requirement 正文与主 spec **逐字一致**（+:9 追加 ttft 语义段），两个既有 Scenario（流式响应完整聚合 / 请求失败）**逐字保留**，另增 2 个新 Scenario（首 token 延迟按首块到达时刻取值 / 无内容 delta 但流正常结束）。**形式合规**（MODIFIED 需完整重述 requirement + 全部 Scenario），预期 `validate --strict` 通过。

---

## 五、放行清单（给 apply 阶段的自检单）

- [ ] **B1** 补"重建 agent-loop dist"任务，并写入 Impact/D6
- [ ] **B2** 补"延时流测试 helper"任务（`test/helpers.ts`）
- [ ] **B3** 把 2.2 改为 1 块 vs 10 块的差分断言
- [ ] **N1** 修 llm-proxy 判据行号（385/390/**410**）
- [ ] **N2** 去掉"32 个 jsonl"硬编码计数
- [ ] **N3** Non-goals 声明"空 `tool_calls: []` 计为内容 delta 属既有行为"
- [ ] 收敛后：先跑一次 2.1/2.2 **于旧实现**，留存"用例失败"证据（证明测试有效）
- [ ] 全部改动后 `agent-loop` 重建 → 3.2 五包回归 → 3.4 真机 Ollama 抽样

---

## 六、总评

根因判断（"取时点在缓冲之后"）、修法（取时点进流 + 谓词单源 + `sentAt` 前置）、证据纪律（分档 + 指向具体行）、范围克制（不碰 schema/UI/format_version）**均属本仓提案的上乘水准**，实测证据的精确度（行号、20.120s、48 span 直方图）逐条经得起复核。

三处待补（B1–B3）都是**"照着任务清单做会出错"的落地细节**，而非方向性错误；补上即可进入 apply。
