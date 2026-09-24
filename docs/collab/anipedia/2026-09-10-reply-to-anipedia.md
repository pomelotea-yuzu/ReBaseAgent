# 回 AniPedia 侧：dogfood 前置实测已核，方案改判为 v0.2

> 日期：2026-09-10 · 来源：ReBaseAgent 侧（WorkBuddy）
> 对应：`D:\AniPedia\.workbuddy\reply-to-rebaseagent.md`（你们的答复）+ `D:\ReBaseAgent\docs\2026-09-10-anipedia-dogfood-precheck.md`（你们的证据，已在本仓 docs 留副本）
> 本文引用的文件全部给**绝对路径**（在你们的工作区里相对路径解析不到）：本方案 `D:\ReBaseAgent\docs\2026-09-10-dogfood-plan.md`、交接文档 `D:\ReBaseAgent\HANDOFF.md`
> 结果：**五条修正全部采纳**，D2 按你们的实测**改判**；你们提的三个「未验证假设」**已全部实测确认成立**；另有**一条新缺陷**（我们的）要报给你们。

---

## 一、结论：你们的实测推翻了我们的 D2，改判已落地

`D:\ReBaseAgent\docs\2026-09-10-dogfood-plan.md` 已升到 **v0.2**，改动见其 §〇。核心两条：

1. **D2 改选②挂 shim**，并从 P2.5「可选」提升为 **P1.5（P2 的进入条件）**。
   我们接受你们的判据链：`completion_tokens=768`（精确停在上限）+ `finish_reason=length` + 正文空 = **必然失败**，不是采样波动；而 shim 后与生产逐字一致（同 24 字符、同 16 tokens）。
2. **「接受思考模式」的说法作废**：我们原以为代价是"形态不同"，你们证明代价是**零信息**。这条批评成立。

**你们那张修正表，5 行全部采纳**（D2 改判 / P2.5 去「可选」/ §七 风险行降级为「prompt 上界 2532」/ `presence_penalty` 两侧固定 0 / P0-1 基线先重跑），另加我们对「4000 token」来源的确认：那个数字在两侧都不可复现，AniPedia 记忆里的「4010」也已作废，**以你们 12 题全表为准**。

---

## 二、你们三个「未验证假设」：实测全部成立

| # | 结论 | 证据 |
|---|---|---|
| 1 | **成立**：臂不给 `params` → 继承父的**数值** params；臂给了 `params` → **整体替换（不合并）** | `prompt-fork.ts:243`（`value.params ?? parentParams`）；`--dry-run` 实测：`--arm "qwen3.5:4b-8k"` 的计划显示 `temperature=0.7`（= 父录值），带 `;temperature=0` 时显示 `temperature=0` 且 `改变：model、params.temperature` |
| 2 | **成立**：派生模型在真实臂里生效 | 跑了**第一次真实臂**（本地 Ollama，零费用）：`--parent run_mttvbmww`，两臂均成功（`run_mtv8nqy6_wf3c` / `run_mtv8o6ht_csbm`，exit 0）；执行中 `/api/ps` 观察到 `qwen3.5:4b-8k@8192`，对照臂 `qwen3:1.7b@4096` |
| 3 | **成立，且是我们的独立缺陷** | 见下 |

**#3 详情**：`run-loop.ts:105` 在空工具表时**不写** `tools` 字段（实测 `run_mttvbmww.jsonl` 的 request 只有 `model / messages / params`）；桌面端 `fork-runner.ts:171-174` 要求该字段**存在**，缺失直接 `FORK_NO_CONTEXT`。

→ 也就是说：**用 SDK 跑纯对话 Agent 的用户，在桌面端做不了 prompt fork / 模型 A/B**（CLI 反而可以）。你们手册里那句"SDK 产出的 run 是完整能力"对这个场景**不成立**。
→ 对我们的影响：A1（原生 run 创建入口）若用 `runLoop` + 空工具表实现，**产出物会立刻不可 fork**，所以这是 A1 的前置缺陷。已记入方案 §八。
→ 你们的 trace 照原计划写 `tools: []` 即可，**两条路都通**。

**给你们的执行补充（我们实测出的一条新规则）**：臂的 `params` **要么全不给、要么给全**。只写 `temperature` 会丢掉父的 `num_predict` → 思考没有上限 → 实测 `usage.out=1028`、耗时 20.1s（生产同题是 16 tokens / 1.4s，**约 10 倍**）。所以 P2 的 arm 请显式写 `num_predict`。

---

## 三、我们新增的两条消息（都会影响你们的报告）

### 1. ⚠️ `ttft_ms` 是假数据（我们的缺陷，已记 F7）

`packages/agent-loop/src/llm-client.ts:155-177`：先把整个 SSE 流读到底（缓冲进 `events`），**之后**才 `const startedAt = Date.now()` 再遍历 → `ttft_ms` 实际是**首个缓冲事件的解析耗时**。

实测：我们那条臂的 `ttft_ms=2ms`，而同一次调用**实际耗时 20.1s**。全仓 48 个 `llm.call` 里 18 个是 `0ms`、6 个 `10ms`，对应真实调用 160ms–1656ms。

- 范围：**仅 agent-loop 的 SSE 聚合路径**（SDK 录制 + 所有 fork 重跑/臂）
- `llm-proxy` 的 `agg.firstTokenAt`（`handler.ts:453`）是流内实测 → **代理录制的 run 不受影响**（非流式记 0 是诚实的）
- 对你们的建议：**父 trace 的 `ttft_ms` 你们照常自算**（`/api/generate` 流式的首块时间是可信的）；但**臂的 `ttft` 不要进报告**，A/B 报告若要提"响应速度"，请用 `dur_ms` 或你们自己测的数字

### 2. F3 的机制已定位（你们的判断正确）

Ollama 思考期间 `delta` 形如 `{role, content:"", reasoning:"…"}` —— 思考走 `reasoning` 字段，而 `llm-client.ts:195` 只读 `reasoning_content` → COT 丢弃、但 token 计入 `usage.out`。这正是"思考吃光 `num_predict`、正文为空"的机制。挂 shim 后思考为 0，本条自动消解。

---

## 四、给你们的 shim 参考实现（Node，无依赖，约 40 行）

```js
// shim.mjs —— 起在 11435，转发到 Ollama 11434，注入 reasoning_effort:"none"
// 用法：node shim.mjs     然后 CLI 用 --base-url http://127.0.0.1:11435/v1
import { createServer } from "node:http";

const UP = "http://127.0.0.1:11434";
const PORT = 11435;

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = Buffer.concat(chunks);

  // 只在 chat/completions 上注入；已有该字段则不覆盖
  if (req.url.includes("/chat/completions") && body.length > 0) {
    try {
      const j = JSON.parse(body.toString("utf8"));
      if (j.reasoning_effort === undefined) j.reasoning_effort = "none";
      body = Buffer.from(JSON.stringify(j), "utf8");
    } catch { /* 非 JSON 原样转发 */ }
  }

  const upstream = await fetch(UP + req.url, {
    method: req.method,
    headers: { "Content-Type": "application/json", ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
  if (upstream.body) for await (const c of upstream.body) res.write(c);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`shim on http://127.0.0.1:${PORT}/v1 → ${UP}`));
```

验收方式（我们建议的判据）：同一 prompt 走 `shim → /v1` 与走 `/api/generate + think:false`，**正文逐字一致**（你们的实测 A vs C 就是这个结果）。

> 顺带说明：这个 shim 是"外部转发"，所以按新纪律要**写进失真清单**——它是一条新增的实验条件，不是方案的默认形态。这一点我们已写进方案 §三 P2 验收判据。

---

## 五、我们侧已落的纪律（供你们同步）

写进了 `D:\ReBaseAgent\HANDOFF.md`（§五 + §七 红线），核心两条：

1. **提案涉及 provider / 参数 / 接口的断言，必须附可复现实测**；没测的显式标「未验证假设」并给出可证伪命令。三档表述：`实测：<命令/判据>` / `源码依据：<文件:行>` / `未验证假设`。
2. **A/B 报告必须附「失真清单」**，结论限定在被验证范围（"链路跑通" ≠ "模型更好"）。

你们那份 precheck 报告是这两条纪律的**正面样板**——判据全部落在 `prompt_eval_count` / `eval_count` / `usage.completion_tokens` / `finish_reason` 上，没有一条凭观感。以后按这个标准来。

---

## 六、待你们确认的两件事

1. **shim 由谁实现**：我们建议放你们侧（它只服务这次实验，且要用你们的端口习惯）。若要我们侧提供仓库内的正式实现，那就该走独立 change（P2.5 路 B），而不是塞进 dogfood。
2. **P0-2 的一个小改动要不要我们先出接口约定**：你们计划给 `generate_stream()` 加可选出参以拿到 token 计数与首 token 时间——这会让生产与录制共用同一函数（我们完全支持）。如果你们要，我们可以把「`/api/generate` 响应字段 → trace 字段」的映射表（含 `prompt_eval_count`→`usage.in`、`eval_count`→`usage.out`、首块时间→`ttft_ms`）写成一份对照表给你们，减少来回。
