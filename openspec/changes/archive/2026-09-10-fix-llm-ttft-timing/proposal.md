# Proposal: fix-llm-ttft-timing

## Why

`llm.call.response.ttft_ms` **当前是假数据**：它记录的不是首 token 时间，而是"解析首个已缓冲事件"的耗时。

用户可见后果已经存在：`apps/desktop/src/renderer/src/components/DetailPanel.tsx:609` 把「首 token 延迟 2ms」与相邻第 610 行的「耗时 20.1s」并排展示在同一个字段列表里——**自相矛盾且无法解释**。ReBaseAgent 的价值主张是"诚实、可复现"；一个结构性谎报的字段直接顶着这个卖点，而且它比任何新功能都更早被用户撞到（打开任一次 `llm.call` 详情即可见）。

**这是实现违反既有 spec，不是设计缺口。** `openspec/changes/archive/2026-09-03-add-agent-loop/design.md:40` 早已定义：

> `ttft_ms`：首个含内容 delta 的 chunk 与请求发出时刻之差

（同一 archive 的 `tasks.md:11` 要求 SSE 聚合器产出 `ttft_ms`。）因此本变更是 **conformance 回归修复**：判定标准现成，不需要重新设计语义，也不需要 `format_version` 或 schema 变更。

### 证据（按本项目 §五 纪律分档）

- **实测**：本机 Ollama 臂实测 `ttft_ms = 2`，同一次调用实际耗时 **20.1s**（原始记录 `run_mtv8nqy6_wf3c.jsonl`）。全仓 48 个 `llm.call` 的 `ttft_ms` 分布：`0×18`、`1×2`、`2`、`7`、`10×6`、其余 250–1200；其中 deepseek-chat 真实调用 160ms~1656ms 的记录里大多记 `0`。
- **源码依据**：`packages/agent-loop/src/llm-client.ts:155-171` 先把整个 SSE 流读到底（`events.push` 缓冲），`:177` 才 `const startedAt = Date.now()`，`:220-223` 在**缓冲事件的遍历**里取 `Date.now() - startedAt`。三处合起来 ⇒ 量的是解析耗时。
- **源码依据（对照实现）**：`packages/llm-proxy/src/handler.ts:453` 用 `agg.firstTokenAt` 在**流内**实测 —— 同一份定义，llm-proxy 是对的，agent-loop 跑偏了。
- **测试侧根因（源码依据）**：`packages/agent-loop/test/llm-client.test.ts:47` 唯一的 ttft 断言是 `expect(result.ttftMs).toBeGreaterThanOrEqual(0)` —— `0` 与 `2` 都满足，故缺陷从未被测试拦住。
- **未验证假设**：无。（本提案所有断言均已实测或指向具体源码行。）

## What Changes

- **agent-loop（核心改动，约 10 行）**：`aggregateSseStream` 把首块时间的取时点**挪进流读取循环**：
  - `startedAt` 提前到函数入口（由调用方传入请求发出时刻，缺省 `Date.now()`）
  - 在 `parser.onEvent` 里用与聚合逻辑**同一谓词**判断该 event 是否含内容 delta，首个命中时记录 `firstDeltaAt`
  - 聚合循环里删除旧的 `ttftDone/ttftMs` 计时块；循环后 `ttftMs = firstDeltaAt === null ? 0 : max(0, firstDeltaAt - startedAt)`
- **agent-loop（调用方）**：`OpenAiCompatClient.complete()` 在 `fetchImpl` **之前**取 `sentAt`，并作为 `{ sentAt }` 传给 `aggregateSseStream`（保证"与请求发出时刻之差"而不是与 fetch 返回时刻之差）
- **agent-loop（测试）**：新增断言必须能证伪旧实现——用**带真实延时的流**（首块延迟 ~120ms）断言 `ttftMs >= 100`，并断言它**不随总块数增长**（旧实现会退化成"解析耗时"，多块时反而更小）
- **不触碰的东西**：trace 格式 / schema / 桌面端 / replay / trace-test / llm-proxy（后者已正确）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-loop`：既有 Requirement「LLM 调用走 OpenAI 兼容协议流式直连」下**新增一个 Scenario**，把 `ttft_ms` 的取值语义与可证伪判据写进 spec（原先只在已归档 design.md 里，主 spec 未固化）——行为本身不变，仅把既有定义**变成可测的契约**。

## Non-goals

- **不做 `format_version` / schema 变更**：`ttft_ms` 是既有必填字段，语义不变，只修取值
- **不改 UI 文案与列位**：`DetailPanel.tsx:609` 的「首 token 延迟」保留——修复后它显示真值；不加"不可比"标注（那是给假数据打补丁，字段本身修好后不需要）
- **不做"隐藏该行"的临时方案**：会留下错字段被下游继续消费
- **不改 `delta.reasoning` → `reasoning_content` 的字段映射**：那是另一件事（Ollama 的 COT 丢失，属 provider 兼容性），不在本变更内
- **不改 `llm-proxy`**：它的 `firstTokenAt`（`handler.ts:412`）已是流内实测、且**判据与本变更完全同源**（`content` / `reasoning_content` / `tool_calls` 三者之一非空）。但它的**计时起点是"聚合开始"而非"请求发出"**（不含等待响应头），修完后两包口径会有细微差异——本变更**只记录、不统一**（详见 design.md D5；统一应作为独立 change）
- **不改「空 `tool_calls: []` 亦计为内容 delta」这一既有行为**：现有判定 `Array.isArray(delta.tool_calls)` 对空数组同样为真，故 provider 若发空占位会把"首个内容 delta"时刻提前定格（新 spec 措辞为「首个**含内容** delta」，存在字面张力）。`llm-proxy`（`handler.ts:393`+`:410`）行为**完全相同**，两包一致、无新增分歧；改它属语义变更、超出本次范围，故**原样保留**并在此声明
- **不加"可配置时钟/超时"等新配置项**：本变更不引入任何新配置面
- **不重算历史 trace**：既有 trace 均为 `.rebaseagent/`（`.gitignore:12`）下的本地开发产物（数量随跑随变、不入库），无库内数据兼容问题；不做数据迁移

## 边界声明（保真度）

- 本变更**不新增任何工具执行**、不触碰 replay/时间旅行语义，故不扩大任何保真度承诺
- 修复只改变 `ttft_ms` 一个标量字段的**取值正确性**；`content` / `reasoning_content` / `tool_calls` / `usage` 的聚合行为逐字不变
- 已知遗留（本变更不处理、需在文档中诚实声明）：若 provider 把思维链放在 `delta.reasoning`（Ollama `/v1` 实测如此）而容器只读 `reasoning_content`，则该段的"首个内容 delta"落在**正文**首 token 上——即关闭思考的 provider 得到的是首正文字时间、开启思考的得到首正文时间（不含思考）。这是字段映射问题的连带表现，与本次取时点修复无关

## Impact

- 修改包：`packages/agent-loop`（`src/llm-client.ts` + `test/llm-client.test.ts` + `test/helpers.ts`）
- 行为影响面：所有经 agent-loop 产出的 trace 的 `ttft_ms`（SDK 录制 + 所有 fork run / 模型 A/B 臂）。`llm-proxy` 录制的 run 不受影响（其 ttft 由自己计算）
- 测试：agent-loop 新增约 4 个用例（延时流下界 / 块数无关性差分对照 / usage-only 流保底 0 / 端到端）+ 1 个延时流 helper（新增用例的前置）；既有 52 个用例必须全绿
- **产物重建（必须）**：`packages/agent-loop` 的 `exports` 仅指 `dist/`，跨包消费者（`replay` 的 `rebaseagent-model-ab` bin、`desktop` 的 `externalizeDepsPlugin` 运行时解析）都取 `dist/` ⇒ 改完 `src/` 必须 `tsc -p tsconfig.json` 重建，否则真机抽样与打包产物仍跑旧代码（tasks 3.1）
- 主 spec 同步：`openspec/specs/agent-loop` 加 delta（新增 Scenario）
- 无破坏性变更：不涉及字段删除/重命名/类型变化；调用方按旧签名调用 `aggregateSseStream(body)` 依然可用（`sentAt` 可选）
- 依赖：无新增依赖
