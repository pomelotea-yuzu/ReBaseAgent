# Design: fix-llm-ttft-timing

## D1 · 根因：取时点在"缓冲之后"，而不在"流内"

`packages/agent-loop/src/llm-client.ts` 现状（三处叠加造成缺陷）：

```text
:155  const events: EventSourceMessage[] = [];        ← 先声明缓冲数组
:156  createParser({ onEvent: (e) => events.push(e) })  ← 边读边塞进缓冲
:161~168  for(;;) { await reader.read(); parser.feed(...) }  ← 把整个流读到底
:177  const startedAt = Date.now();                    ← ✗ 计时起点在"读完"之后
:179~224  for (const event of events) { ... ttftMs = Date.now() - startedAt }
```

于是 `ttftMs` = 遍历缓冲事件到遇到首个内容 delta 的**解析耗时**（通常 0–10ms），与网络首 token 时间无关。

**为什么"把 `startedAt` 提前"不够**：若只把起点挪到请求发出时刻，而取时点仍在缓冲遍历里，则 `Date.now()` 已是"全流到齐"之后的时刻 ⇒ 得到的是**总时长**，仍然不是 ttft。**必须把取时点也挪进读取循环。**

## D2 · 修法：取时点进流，谓词单源

```text
complete()：
  const sentAt = Date.now();                 ← fetch 之前
  response = await this.fetchImpl(...)
  aggregateSseStream(response.body, { sentAt })

aggregateSseStream(body, options = {})：
  const startedAt = options.sentAt ?? Date.now()
  let firstDeltaAt: number | null = null
  createParser({ onEvent: (e) => {
    events.push(e)
    if (firstDeltaAt === null && hasContentDelta(e)) firstDeltaAt = Date.now()   ← 流内实测
  }})
  ... 读取循环不变 ...
  ... 聚合循环：删除原 ttftDone/ttftMs 计时块，其余逻辑逐字不变 ...
  ttftMs = firstDeltaAt === null ? 0 : Math.max(0, firstDeltaAt - startedAt)
```

- `hasContentDelta(event)`：与聚合循环**同一套判定**（`delta.content` 非空字符串 / `delta.reasoning_content` 非空字符串 / `delta.tool_calls` 是数组）。抽成小函数，避免两处判定将来漂移——这正是本缺陷的成因模式（同一语义写两遍，一处跑偏）。
- 解析失败容错：`hasContentDelta` 内 `JSON.parse` 失败返回 `false`，**不吞错**——真正的解析错误仍由聚合循环抛出 `LlmRequestError`（保持既有错误语义）。
- 保底语义不变：无任何内容 delta 时 `ttftMs = 0`（与 `!sawAnything && usage === null` 的错误分支共存，行为不变）。

## D3 · 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 只把 `startedAt` 提前，取时点不动 | 得到的是**总时长**而非 ttft（见 D1 末段），是"用错的数字替换错的数字" |
| 把聚合整体搬进 `onEvent`（照 `llm-proxy` 结构，单一解析路径） | 看似更优雅，但会让解析错误在**读流循环内**抛出，被 `llm-client.ts:169-171` 的 `catch (e)` 捕获并**重写为「SSE 流中断：…」**，破坏既有 `JSON 解析失败` 错误语义。`llm-proxy` 之所以能那么写，是因其读流 `catch` 是**吞掉**（`handler.ts:436`）、解析错误直接 `return`（`:376`），哲学为 best-effort——两包口径本就不同。故本变更保持"读后统一聚合"，解析错误仍由聚合循环抛 |
| UI 层把该字段标注为"不可比" / 隐藏该行 | 字段模型仍是错的，下游（A/B 报告、fork run、臂输出）会继续消费；将来任何消费方都要再补一次例外。**修根因是唯一收敛解** |
| 让 UI 显示 `dur_ms` 冒充首 token 延迟 | 直接撒谎，且 `dur_ms` 已在相邻行展示 |
| 改为非流式请求后自行计时 | 破坏流式直连与 `stream_options.include_usage` 的既有契约，且会改变 usage 语义 |
| 与 A1（原生 run 入口）合批 | 违反本项目 §五「一次只推进一个可独立验证的单元」：两者验收目标无关，混批会带来两个验收目标 |

## D4 · 判据与测试策略（**本设计的关键：必须能证伪旧实现**）

判据来自既有 spec（`archive/2026-09-03-add-agent-loop/design.md:40`）：**首个含内容 delta 的 chunk 与请求发出时刻之差**。

测试必须满足"旧实现会失败"：

0. **前置：延时流 helper**。现有 `sseStream` / `streamOf` 基于 `ReadableStream.pull` **同步 enqueue**（所有块 ~0ms 到齐）⇒ 必须先新增 `sseStreamDelayed`（`async pull` + `setTimeout`），否则下面 1 / 2 / 4 的偏序断言**连正确实现都会失败**。
1. **延时下界**：延时流首块 content 前 120ms ⇒ 断言 `ttftMs >= 100`（且 `<= 本次总耗时`）。
   旧实现下该值为解析耗时（≈0–2ms）⇒ **必然失败**（证明测试有效）。
2. **块数无关性（差分对照）**：同为首块延迟 50ms，跑两条流——「1 块」与「首块 + 随后立刻 9 块」⇒ 断言两者 `ttftMs >= 40` 且 `|Δ| <= 40ms`。
   **单流断言（如 `< 总耗时/2`）无法证伪"随块数增长"**：旧实现的 ≈0ms 同样满足它；只有成对比较才真正钉死"不随分块数变化"（旧实现下两者皆 ≈0 ⇒ 失败）。
3. **usage-only 流保底**：仅 `usage` 无内容 ⇒ `ttftMs === 0`（既有语义不回退）。
4. **端到端**：`OpenAiCompatClient.complete()` 经**延时** fetch 走一遍 ⇒ `ttftMs > 0` 且不大于该次总耗时（零延时 mock 下 `> 0` 会误报，故必须延时）。

现有断言 `expect(result.ttftMs).toBeGreaterThanOrEqual(0)`（`test/llm-client.test.ts:47`）**保留但不再作为唯一保障**——它是本缺陷逃逸的直接原因，任务里要求补上偏序断言。

## D5 · 与 `llm-proxy` 的口径差异（**本变更不统一，但必须记录**）

修完后两个包都会产出"正确量级的 ttft"，但**起点定义不同**：

| | agent-loop（本变更后） | llm-proxy（不动） |
|---|---|---|
| 计时起点 | `sentAt` = `fetchImpl` **调用前**（含等待响应头） | `handler.ts:369` `startedAt` = **聚合开始时**（此时 headers 已到） |
| 判据 | `hasContentDelta`：`content` / `reasoning_content` / `tool_calls` 三者之一非空 | `sawAnything`：**同一套三条**（赋值点 `handler.ts:385/390/410`） |
| 与 spec 文字的关系 | 贴合「与请求发出时刻之差」 | **不含**等待响应头的时间，严格说比 spec 少一段 |

- 结论：**判据同源**（这点已被核实，两处逐条对应），**起点不同**。
- 本变更**不改 llm-proxy**：它是既有正确实现（虽起点略窄），改动它会扩大爆炸半径、且需要独立的 spec delta 与回归面。
- 处理方式：在 `tasks.md` 4.5 记录该差异（口径已写入 `trace-sdk`/两份 README 的字段表更佳），并留作**后续候选**（若将来要统一，应作为独立 change 处理）。

## D6 · 兼容性与影响面

- **签名**：`aggregateSseStream(body, options?)` —— 第 2 参可选，旧调用点零改动可用
- **数据结构**：不改任何字段名/类型/必填性；`ttft_ms` 仍是 `number`（非负）
- **产物重建（必须）**：`packages/agent-loop` 的 `exports` 仅指 `dist/`，跨包消费者（`replay` 的 `rebaseagent-model-ab` bin、`desktop` 的 `externalizeDepsPlugin` 运行时解析）**都取 dist** ⇒ 改完 `src/` 必须 `tsc -p tsconfig.json` 重建，否则真机抽样与打包产物仍跑旧代码（tasks 3.1）
- **历史数据**：`.gitignore:12` = `.rebaseagent/`，既有 jsonl 全为本地开发产物，无库内数据需要迁移或重算
- **影响面**：所有经 agent-loop 产出的 trace（SDK 录制、prompt fork、模型 A/B 臂）的 `ttft_ms` 由"假"变"真"；`llm-proxy` 录制的 run 不受影响（其值由 `handler.ts:453` 独立计算）
- **下游消费方**：`DetailPanel.tsx:609`（修复后显示真值）；`trace-as-test` 的结构对齐**忽略** `ttft`（`openspec/specs/trace-as-test/spec.md:38`）⇒ 卡带回归不受影响；`deriveComparison` 不消费 ttft
