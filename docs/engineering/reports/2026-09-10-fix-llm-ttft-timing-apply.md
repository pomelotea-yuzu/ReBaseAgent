# Apply 报告：`fix-llm-ttft-timing`

时间：2026-09-10 · 状态：**代码已改、验证通过、§4 收口完成、change 已归档** ✅
前置：审阅文档 `docs/reviews/2026-09-10-fix-llm-ttft-timing-review.md`（结论"放行，需先补 3 项"）

---

## 一、审阅意见的处置（B1–B3 / N1–N3）

| 编号 | 意见 | 处置 |
|---|---|---|
| B1 | 缺"重建 agent-loop 产物"步骤 | ✅ `tasks.md` 新增 **3.1**；`proposal.md` Impact 与 `design.md` D6 各加"产物重建（必须）"条目 |
| B2 | 缺"带延时流"测试 helper | ✅ `tasks.md` 新增 **2.1**（原 2.1–2.5 顺延为 2.2–2.6）；`design.md` D4 新增第 0 条前置 |
| B3 | "块数无关性"断言无法证伪 | ✅ 改为**差分对照**（同首块延时，1 块 vs 10 块，断言 `|Δ| <= 40ms`）；tasks 2.3 / design D4-2 同步 |
| N1 | llm-proxy 判据行号 | ✅ 393 → **410**（`design.md` D5） |
| N2 | "32 个 jsonl"计数漂移 | ✅ 去掉硬编码，改述"数量随跑随变、不入库" |
| N3 | 未声明"空 `tool_calls: []` 亦为内容 delta" | ✅ `proposal.md` Non-goals 新增一条显式声明（并与 llm-proxy 一致性对照） |
| — | D3 遗漏最相关替代方案 | ✅ `design.md` D3 补"把聚合搬进 `onEvent`"一行，写明否决理由（会被读流 `catch` 重写为「SSE 流中断」，破坏既有错误语义） |

---

## 二、代码改动（4 个文件）

| 文件 | 改动 |
|---|---|
| `packages/agent-loop/src/llm-client.ts` | ① 新增 `AggregateOptions { sentAt? }` 与私有谓词 `hasContentDelta(event)`（与聚合判定同源；`JSON.parse` 失败返回 `false` 不吞错）；② `startedAt = options.sentAt ?? Date.now()` 提到函数入口，`onEvent` 内首个命中记 `firstDeltaAt`；③ 删聚合循环内旧 `ttftDone/ttftMs` 计时块；④ 循环后 `ttftMs = firstDeltaAt === null ? 0 : Math.max(0, firstDeltaAt - startedAt)`；⑤ `complete()` 在 `fetchImpl` **之前**取 `sentAt` 并传入 |
| `packages/agent-loop/test/helpers.ts` | 新增 `sseStreamDelayed(...)`（`async pull` + `setTimeout`）与 `fetchReturningSseDelayed(...)` |
| `packages/agent-loop/test/llm-client.test.ts` | 新增 4 个用例（延时下界 / 块数无关性差分 / usage-only 保底 / 端到端）；在原第 47 行 `>= 0` 断言旁加警示注释 |
| `scripts/create-ab-parent.mjs` | **顺带修复**：该文件 3 处 biome 报错（模板字面量 / import 排序 / 换行）。**非本变更引入**，详见 §五 |

> `packages/agent-loop/dist/` 已按 tasks 3.1 重建（gitignored，不入库）。校验：`dist/llm-client.js` 含 `firstDeltaAt`/`hasContentDelta`、旧 `ttftDone` 已消失；`dist/llm-client.d.ts` 已导出 `AggregateOptions`。

---

## 三、验证证据

### 3.1 测试有效性（先证伪，再修）—— tasks 2.2 要求的对照

**修复前**（新用例跑在旧实现上，`agent-loop`）：`Test Files 1 failed | 6 passed`，`Tests 3 failed | 53 passed`

```
× 首块延时进入流内 ⇒ ttftMs 不小于该延时
    AssertionError: expected 0 to be greater than or equal to 100
× 块数无关性：同首块延时下，1 块与 10 块的 ttftMs 基本一致（差分对照）
    AssertionError: expected 0 to be greater than or equal to 40
× 端到端：complete() 的 ttftMs 落在 (0, 该次总耗时] 内
    AssertionError: expected 0 to be greater than 0
```

⇒ 旧实现量出的是 **`0`**（即"解析耗时"，与实测 trace 里的 `2ms` 同源）。**新用例确实能证伪旧实现**。
（第 4 个新用例「usage-only 保底 0」在旧实现下也通过——符合预期，它守的是"不回退"。）

**修复后**：`Test Files 7 passed (7)` / `Tests 56 passed (56)` ✅

### 3.2 全量测试矩阵（零 API）

| 包 | 结果 |
|---|---|
| agent-loop | **56 passed**（既有 52 + 新增 4） |
| trace-sdk | 75 passed |
| replay | 66 passed |
| llm-proxy | 16 passed |
| trace-test | 65 passed |
| desktop | 156 passed |
| **合计** | **434 passed / 0 failed** |

> 五包回归在 dist 重建**之后**执行，使 replay / desktop 经新 dist 验证。

### 3.3 静态检查与规范

- `biome check .` → **0 errors**（139 文件）
- `openspec validate fix-llm-ttft-timing --strict` → valid
- `openspec validate --all --strict` → **11 passed / 0 failed**

### 3.4 真实 provider 抽样（Ollama，零成本）

**（a）经重建后 dist 的真实调用**（`scripts/create-ab-parent.mjs` → 新 run `run_mtva4wiw`）：

```
model = qwen3.5:4b
ttft_ms = 42398    dur_ms = 43049    usage.out = 2576    content_len = 89
判据 0 < ttft < dur = true
```

对照修复前同场景 `run_mtv8nqy6_wf3c`：`ttft_ms = 2`（dur 20120ms）。

⚠️ **该数字不具说服力**：`ttft/dur = 0.985`，几乎等于总耗时——被**已知的 F3 字段映射问题**污染（Ollama `/v1` 发 `reasoning`，客户端只读 `reasoning_content` ⇒ 思考阶段的 delta 不算"内容 delta"，首个可观测正文 delta 落在思考结束后）。此现象在 proposal「边界声明」与 Non-goals 已预先声明，非本变更引入。

**（b）决定性对照探针**（关掉思考以消除 F3 干扰）——同一代码路径、同一模型，仅改 provider 参数：

| 组 | params | `ttft_ms` | `dur_ms` | `out` | `content_len` | `0<ttft<dur` |
|---|---|---|---|---|---|---|
| A · 思考开（默认） | （无） | 20448 | 20465 | 1437 | 1 | true |
| B · 思考关 | `reasoning_effort:"none"` | **161** | 180 | 2 | 1 | true |

**结论**：B 组 `ttft = 161ms` 是**真实网络首 token 时间**——既非解析耗时（旧实现必为个位数），也非总耗时（180ms）。A/B 两组仅差一个 provider 参数、`ttft` 却相差 **127 倍**，证明该字段现在**随真实流时序变化**，取时点确已落入流内。

**环境**：探针后已 `taskkill` 关停我启动的 `ollama serve`（端口 11434 已确认关闭），临时脚本与中间产物已删除；`ollama list` 仍为原有 3 个模型，未增删。新产生的 `run_mtva4wiw.jsonl` 保留供复查。

---

## 四、§4 收口（已完成）

| 任务 | 结果 |
|---|---|
| 4.1 | ✅ 已核：`packages/agent-loop/README.md:55` 仅罗列字段名、未定义 ttft 语义 ⇒ **无需改** |
| 4.2 | ✅ **已归档**：`openspec archive fix-llm-ttft-timing -y` → `archivedAs=2026-09-10-fix-llm-ttft-timing`、`specsUpdated=true`、`modified=1`。主 spec `agent-loop` 已落 delta：requirement 正文追加 ttft 语义段 + **新增 2 个 Scenario**（首 token 延迟按首块到达时刻取值 / 无内容 delta 但流正常结束），既有 2 个 Scenario 逐字保留 |
| 4.3 | ✅ `HANDOFF.md`：§二 archive 11→**12**（最新=本 change）；§三 测试矩阵 agent-loop 52→**56**、总 430→**434**；§六 🐞「ttft_ms 是假数据」→ ✅ **已修** + 三条遗留 |
| 4.4 | ✅ `docs/engineering/plans/2026-09-10-dogfood-plan.md` 升 **v0.4**（新修订块 #13–16）；D4 → 已修并归档；§七 F7 行加"根因已修 + 旧 trace 仍不可信"；附录 A-3 补修复后对照数据。验收判据**维持**以 `usage.in/out > 0` 为主（保守：臂若开思考仍受 F3 影响） |
| 4.5 | ✅ `packages/trace-sdk/README.md` 字段表：`response.ttft_ms` 说明改写为完整口径（首个含内容 delta 的 chunk 与请求发出时刻之差；无内容 delta 记 0；agent-loop 起点在 `fetch` 前 vs `llm-proxy` 起点为聚合开始；provider 以 `reasoning` 下发时不计入） |

**归档后最终校验**：`openspec validate --all --strict` = **10 passed / 0 failed**（10 主 spec、0 待归档 change）；archive 共 **12 个**。
出现 2 条 INFO（`agent-loop` 与 `llm-proxy` 的 requirement 正文 >500 字符）——非阻塞，可作将来拆分的候选。

**未提交任何 commit**（本仓由 owner 手动 commit / push）。

---

## 五、顺带发现（与本变更无关，已修）

`scripts/create-ab-parent.mjs`（V3b 提交 `c912359` 引入、已跟踪、`git status` 干净）存在 **3 处 biome 报错**（`noUnusedTemplateLiteral` / `organizeImports` / `format`）⇒ **`biome check .` 自 `c912359` 起就没绿过**，MEMORY.md 中"biome 0 errors"的记载已过期。本次顺手修复以恢复该仓不变式（纯机械改动，无运行期影响）。若不愿扩大本次 diff，可单独 revert 该文件。
