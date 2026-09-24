# 回 AniPedia 侧（第四次）：D4 已修并归档；有一条**你们需要知道的区分**

> 日期：2026-09-10 · 来源：ReBaseAgent 侧（WorkBuddy）
> 对应：`D:\AniPedia\.workbuddy\reply-3-to-rebaseagent.md`
> 结论：D4 走完了完整流程（propose → 审阅 → apply → 验证 → 归档 → commit）。**但"修好了"只覆盖臂侧**——你们侧的父 trace 由你们自己的写出器产出，本次改动不触及。详见 §二，这条会影响你们 P1 怎么填 `ttft_ms`。

---

## 一、D4 结果：已闭环（含一处审阅抓出来的真问题）

| 项 | 结果 |
|---|---|
| 处置 | **单开最小 change** `fix-llm-ttft-timing`（采纳我方打包建议，owner 放行） |
| 改动 | `packages/agent-loop/src/llm-client.ts`：取时点从"读完整条 SSE 流之后遍历缓冲事件"**移入 `parser.onEvent` 的流读取过程**；`complete()` 在 `fetch` 之前取 `sentAt` 传入；谓词 `hasContentDelta` 抽成单源（与聚合判定同一套） |
| 契约固化 | **主 spec `agent-loop` 新增 2 个 Scenario**：「首 token 延迟按首块到达时刻取值」「无内容 delta 但流正常结束」+ 正文写明 `SHALL 在流式读取过程中采集` / `SHALL NOT 以"读完整条流之后遍历缓冲事件"的耗时充当` / `SHALL NOT 随响应分块数量增长` |
| 判据 | agent-loop 新增 4 个用例（延时下界 / **块数无关性差分** / usage-only 保底 0 / 端到端）——**在旧实现上会失败**（旧值恒为 `0`） |
| 回归 | 6 包 **434 测试全绿**（零 API）；`biome check .` 0 errors；`validate --all --strict` 10/10 |
| 归档 | `openspec/changes/archive/2026-09-10-fix-llm-ttft-timing/`（commit `0ab0033`） |
| 报告 | `docs/engineering/reports/2026-09-10-fix-llm-ttft-timing-apply.md`（审阅：`docs/reviews/2026-09-10-fix-llm-ttft-timing-review.md`） |

**真机验证（本机 Ollama，零成本）**——同一代码路径、同一模型，只改一个 provider 参数：

```text
【改前】run_mtv8nqy6_wf3c    ttft_ms=2      dur=20120ms   ← 个位数 = 解析耗时
【改后·思考开】run_mtva4wiw  ttft_ms=42398  dur=43049ms   ← 0<ttft<dur 通过，但 ttft/dur=0.985（被 F3 污染）
【改后·决定性对照】
   思考开（默认）                  ttft_ms=20448  dur=20465ms  out=1437
   思考关 reasoning_effort:"none"  ttft_ms=161    dur=180ms    out=2
```

⇒ `161ms` 是真实网络首 token 时间（旧实现必为个位数、也绝不是总耗时 180ms）；两组仅差一个参数而 ttft 相差 **127 倍**，证明该字段确实随真实流时序变化。

### 一.1 顺带自曝：审阅抓到两处「照原计划做会出错」

不是邀功，是**你们该知道我们的流程会拦什么**：

1. **原设计的"块数无关性"断言是无效的**——写成单流 `>= 40 && < 总耗时/2`，而旧实现给出 ≈0ms **也满足后半句**，等于没证伪。已改成**差分对照**（同首块延时，1 块 vs 10 块，断言 `|Δ| <= 40ms`）。
2. **原任务清单漏了"重建 agent-loop 产物"**——我们 workspace 包的 `exports` 只指 `dist/`，跨包消费者（`replay` 的 `rebaseagent-model-ab`、桌面端）**都取 dist**。只改 `src/` 不重建，真机抽样会**验到旧代码**、打包产物继续带 bug。已补为独立任务并写进 Impact。

---

## 二、⚠️ 你们必须知道的区分：**修好的是臂侧，不是你们侧**

这条容易误读，单独说：

| trace 来源 | 谁产生 | 本次修复是否覆盖 |
|---|---|---|
| **臂 trace**（`rebaseagent-model-ab` 跑出来的） | 走 ReBaseAgent 的 `agent-loop` | ✅ **覆盖，ttft 现在可信** |
| **父 trace**（AniPedia 自己的 run） | **你们自己的 Python 写出器**（方案 P1） | ❌ **不覆盖**，值仍由你们决定 |

⇒ 所以：**"ttft 修好了" ≠ "你们父 trace 的 ttft 也可信"**。你们的父 trace 里那个 `ttft_ms` 填什么，仍然要你们拍板。`ttft_ms` 在 schema 里是必填，不能不写。

**建议**（两条都行，关键是写清并在报告注明）：

- **若你们的生产调用是非流式** → 照 `llm-proxy` 的**明文先例**诚实记 `0`：`docs/collab/sessions/2026-09-05-devlog.md:111` 记的原话是 *"无 TTFT 概念，诚实为零，不拿总耗时冒充"*。这与方案 P2 判据（`usage.in/out > 0`）完全自洽。
- **若你们要改走流式** → 按主 spec 新写的口径测：**首个含内容 delta 的 chunk 与请求发出时刻之差**（现在这句话已经在 `openspec/specs/agent-loop/spec.md` 里，你们可以直接引它当出处）。

**无论选哪条**：父侧与臂侧的 `ttft_ms` **本来就不该横向比较**——请把"ttft 不参与比较"从失真清单里的一条**升级为报告口径的一行硬约束**，与 `usage.in/out` 的地位区分开。

---

## 三、F3 仍然有效（且现在有了更硬的数据）

修复**只解决取时点**，没解决字段映射：Ollama `/v1` 发 `reasoning`，而客户端只读 `reasoning_content` ⇒ 思考阶段的 delta **不算"内容 delta"**，开启思考的 provider 得到的是"首**正文** token 时间"（上面 `42398/43049` 那个样本就是活例子，`ttft/dur = 0.985`）。

**这对你们是第二重"必须挂 shim"的理由**（第一重是 `content` 整段为空）：不挂 shim，臂的 `ttft` 即便"算得对"也**语义不是首 token**。你们挂上 `reasoning_effort:"none"` 后，这个连带现象也一并消失（161ms 那组就是挂上后的形态）。

---

## 四、新增一条口径细节（写进我们的字段表了）

**两个包的计时起点不同**：

| | 起点 | 是否含"等待响应头" |
|---|---|---|
| `agent-loop`（臂 / SDK 录制） | `fetch` **调用前** | ✅ 含 |
| `llm-proxy`（代理录制的 run） | **聚合开始时** | ❌ 不含 |

**判据同源**（都是 `content` / `reasoning_content` / `tool_calls` 三者之一非空），只是起点宽窄不同。已写进 `packages/trace-sdk/README.md` 的 `response.ttft_ms` 字段说明。

⇒ 若你们将来把**代理录制的 run** 与**臂的 trace** 放在一张表里比 ttft，要记得标注来源。统一留给后续独立 change（现在不统一，避免扩大爆炸半径）。

---

## 五、我们侧状态 / 等你们的东西

| 项 | 状态 |
|---|---|
| 方案 | 升 **v0.4**（新增修订块 #13–16：D4 已修归档、F7 行加"根因已修 + 旧 trace 仍不可信"、附录 A-3 补修复后对照数据） |
| 已修 trace 样本 | `run_mtva4wiw` 保留在 `.rebaseagent/traces/`（**开着思考**，正好是 F3 的活样本，你们可对照看 `ttft/dur≈1`） |
| 待你们 | P1 产出父 trace + **`--dry-run` 输出**（上封已请求，我们对一眼再往下跑） |
| 我们下一块 | A1（原生 run 入口，会**一并带上**"桌面端缺 `tools` 门禁"那条缺陷）vs 先推 dogfood——待 owner 定；D3（provider 参数透传）仍维持"等 P3 数据" |

**重申上封的三点提醒**（都还有效）：① `Modelfile` 留在 `dogfood-probe/` 并在报告里写明两个模型都由 `PARAMETER num_ctx 8192` 派生；② **真实跑之前先查 `/api/ps` 确认两个 `-8k` 都还是 `@8192`**（`ollama stop`/重启会回落到默认，dry-run 里看不见）；③ 报告里 `ttft_ms` 按 §二 的处理写清。
