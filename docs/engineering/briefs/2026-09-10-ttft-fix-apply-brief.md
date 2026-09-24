# Apply 交接单：`fix-llm-ttft-timing`（照此执行即可）

> 提案：`D:\ReBaseAgent\openspec\changes\fix-llm-ttft-timing\`（proposal / design / tasks / spec delta，已过 `validate --strict`）
> 审核交接单：`D:\ReBaseAgent\docs\2026-09-10-ttft-fix-review-brief.md`
> 目标：修 `llm.call.response.ttft_ms` 的取时点。**约 10 行代码 + 4 个用例**。

## 0. 前置

先跑一次测试确认基线绿，**并记下旧值**（tasks 2.1 要求）：

```bash
# cwd 必须是包目录（勿用根 vitest + --root，会出 instanceof 假阳性）
cd "D:/ReBaseAgent/packages/agent-loop" && ./node_modules/.bin/vitest.CMD run
```

## 1. 改代码（`packages/agent-loop/src/llm-client.ts`）

**① 抽出同源谓词**（放在 `aggregateSseStream` 上方）：

```ts
/** 该 SSE event 是否含内容 delta（与聚合循环同一判定，勿各写一份） */
function hasContentDelta(event: EventSourceMessage): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(event.data); } catch { return false; }   // 解析错误仍由聚合循环抛
  const delta = (parsed as { choices?: Array<{ delta?: Record<string, unknown> }> })
    .choices?.[0]?.delta;
  if (delta === undefined) return false;
  const c = delta.content;
  const r = delta.reasoning_content;
  return (
    (typeof c === "string" && c.length > 0) ||
    (typeof r === "string" && r.length > 0) ||
    Array.isArray(delta.tool_calls)
  );
}
```

**② 函数签名 + 计时起点提到入口**：

```ts
export async function aggregateSseStream(
  body: ReadableStream<Uint8Array>,
  options: { sentAt?: number } = {},
): Promise<LlmResponse> {
  const startedAt = options.sentAt ?? Date.now();   // ← 原 :177 那行挪到入口
  let firstDeltaAt: number | null = null;           // ← 新增
```

**③ `onEvent` 里流内记时**：

```ts
    onEvent: (event: EventSourceMessage) => {
      events.push(event);
      if (firstDeltaAt === null && hasContentDelta(event)) firstDeltaAt = Date.now();
    },
```

**④ 删掉聚合循环里的旧计时块**（原 `:174-176` 的 `let ttftDone/ttftMs` 与 `:220-223` 的 `if (!ttftDone && sawAnything) {...}`），改为循环结束后：

```ts
  const ttftMs = firstDeltaAt === null ? 0 : Math.max(0, firstDeltaAt - startedAt);
```

（`sawAnything` 与 `:239` 的 `!sawAnything && usage === null` 错误分支**保持原样**。）

**⑤ `complete()` 里传起点**（`~:106` 附近）：

```ts
    const sentAt = Date.now();                       // ← 在 fetchImpl 之前
    try { response = await this.fetchImpl(...) } ...
    const aggregated = await aggregateSseStream(response.body, { sentAt });   // ← 原来无第二参
```

## 2. 测试（`packages/agent-loop/test/llm-client.test.ts`）

新增 4 例（`streamOf` 需支持 `await sleep()`，把 `pull` 改成 async）：

1. 首块 content 前 `await sleep(120)` ⇒ `expect(result.ttftMs).toBeGreaterThanOrEqual(100)`
2. 首块延迟 50ms + 随后立刻 10 块 ⇒ `>= 40` 且 `< 总耗时 / 2`
3. 仅 usage 块 ⇒ `toBe(0)`
4. `OpenAiCompatClient.complete()` 经注入 fetch ⇒ `> 0` 且 `<= ` 该次总耗时

**必须做**：改代码前先只加用例、跑一次，确认 1/2 **在旧实现上失败**（记录输出作为"测试有效"的证据）。第 47 行既有 `>= 0` 断言保留，旁边加一行注释说明它不足以发现取时点错误。

## 3. 验收（缺一不可）

```bash
cd "D:/ReBaseAgent/packages/agent-loop"    && ./node_modules/.bin/vitest.CMD run   # 52 + 4
cd "D:/ReBaseAgent/packages/trace-sdk"     && ./node_modules/.bin/vitest.CMD run   # 75
cd "D:/ReBaseAgent/packages/replay"        && ./node_modules/.bin/vitest.CMD run   # 66
cd "D:/ReBaseAgent/packages/llm-proxy"     && ./node_modules/.bin/vitest.CMD run   # 16
cd "D:/ReBaseAgent/packages/trace-test"    && ./node_modules/.bin/vitest.CMD run   # 65
cd "D:/ReBaseAgent/apps/desktop"           && ./node_modules/.bin/vitest.CMD run   # 156
cd "D:/ReBaseAgent" && ./node_modules/.bin/biome.CMD check .                       # 0 errors
```

**真实 provider 抽样（零成本）**：起本机 Ollama 后记一条真 trace，断言该 span 的 `ttft_ms > 100` 且 `< dur_ms`；对照修复前的 `2ms`。
（Ollama 绿色版：`OLLAMA_MODELS=D:/Ollama/models "D:/Ollama/ollama/ollama.exe" serve`，用完 `keep_alive:0` 卸载并终止进程。）

## 4. 归档与收口

```bash
cd "D:/ReBaseAgent" && "C:/Users/28145/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
  "D:/nodejs/node_modules/corepack/dist/npx.js" -y @fission-ai/openspec@1.12.0 \
  archive fix-llm-ttft-timing && ... validate --all --strict   # 期望 11 passed
```

- 归档后主 spec 应含新增 Scenario；`tasks.md` 全部勾选
- `packages/trace-sdk/README.md` 字段表按 tasks 4.5 注明口径（含 llm-proxy 起点差异）
- `HANDOFF.md` §六 的「🐞 已知缺陷：`ttft_ms` 是假数据」改为**已修 + 判据**；§三 测试矩阵更新 agent-loop 用例数
- `docs/engineering/plans/2026-09-10-dogfood-plan.md` D4 状态改「已修」、§七 F7 标注"根因已修，旧 trace 仍不可信"

## 5. 已知坑（会浪费时间的）

- 跑 vitest **必须 cwd = 包目录**；用 `--root` 会出 `instanceof` 假阳性
- Git Bash 里**没有** `ls`/`tail`/`head`/`dirname`，管道会静默失败——查目录/读结果直接调托管 node 写 `-e`
- `pnpm` 在 Git Bash 不可用，直调 `corepack/dist/pnpm.js`
- 别动 `packages/llm-proxy`（它是对的，但起点口径不同 → 见 design.md D5）
- 别动 `delta.reasoning` → `reasoning_content` 的映射（Non-goals，属另一件事）
