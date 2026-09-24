# 审核交接单：`fix-llm-ttft-timing`（ttft 假数据修复提案）

> 给新会话的审核用。**只审不改**：本轮不改任何代码、不归档、不动 spec 主文件。
> 提案状态：已写全、`openspec validate fix-llm-ttft-timing --strict` 通过、全量 `--all --strict` = 11 passed / 0 failed。
> 我的定位：我是提案作者，**请按"作者可能自证清白"的前提审**。

---

## 一、背景（30 秒）

`llm.call.response.ttft_ms` **当前不是首 token 时间**，而是"读完整条 SSE 流之后、遍历缓冲事件"的解析耗时。桌面端 `DetailPanel.tsx:609` 把它当「首 token 延迟」展示，与相邻第 610 行的「耗时」并排——实测出现过 `2ms` 与 `20100ms` 同框。

**性质**：实现违反既有 spec，不是设计缺口。`openspec/changes/archive/2026-09-03-add-agent-loop/design.md:40` 早已定义「`ttft_ms`：首个含内容 delta 的 chunk 与请求发出时刻之差」。

---

## 二、请先读这些（绝对路径）

| 文件 | 看什么 |
|---|---|
| `D:\ReBaseAgent\openspec\changes\fix-llm-ttft-timing\proposal.md` | Why / 证据三档 / What Changes / Non-goals |
| `…\fix-llm-ttft-timing\design.md` | D1 根因、D2 修法、D3 否决方案、D4 测试策略、D5 跨包口径差异 |
| `…\fix-llm-ttft-timing\tasks.md` | 4 组任务（含"改前先在旧实现上跑一次"的要求） |
| `…\fix-llm-ttft-timing\specs\agent-loop\spec.md` | spec delta（MODIFIED requirement） |
| `D:\ReBaseAgent\packages\agent-loop\src\llm-client.ts` | 待改文件：**155-171**（缓冲）、**177**（错位计时）、**179-224**（聚合与计时）、**102-133**（`complete()`） |
| `D:\ReBaseAgent\packages\agent-loop\test\llm-client.test.ts` | **第 47 行**：唯一的 ttft 断言 `>= 0` —— 缺陷逃逸的直接原因 |
| `D:\ReBaseAgent\packages\llm-proxy\src\handler.ts` | **369 / 382-393 / 412-413 / 453**：可对照的"正确实现" |
| `D:\ReBaseAgent\apps\desktop\src\renderer\src\components\DetailPanel.tsx` | **609 / 610**：用户可见的荒谬并排 |

---

## 三、已核实的证据（你不用重复查，但要抽查）

**① 缺陷是机器产出的，不是 fixture 手写的**——全仓 48 个 `llm.call` 按来源归类后：

| 来源 | n | `ttft_ms` 取值 | 判定 |
|---|---|---|---|
| `agent-loop` 产出（SDK 录制 / fork / 模型 A/B 臂） | 35 | `0×20`、`1×3`、`2`、`7`、`10×6` | **假数据**（对应真实调用 160ms~20.1s） |
| `llm-proxy` 录制 | 13 | `0`（非流式，诚实记 0）、`1×2`、**`338`**（09-05 真实代理 fork，与 `dur=1021ms` 自洽） | 正常 |
| 手写 fixture（`r_01`–`r_04`、`tree_r*`） | — | `850/620/410/1200/980/900/250…` | **常量，非测量**（归档 proposal 示例里就写着 `"ttft_ms": 850`） |

⚠️ 提醒审核者：**「看起来合理的大数字」全是手写常量或代理产出**，机器经 agent-loop 产出的无一例外是 0–10ms。别被总体分布误导。

**② 根因三处叠加**：`llm-client.ts:155-171` 先读完整流 → `:177` 才 `startedAt = Date.now()` → `:220-223` 在缓冲遍历里取差 ⇒ 量的必然是解析耗时。

**③ 判据同源已核**：`llm-proxy` 的 `sawAnything`（`handler.ts:385/390/393`）= `content` / `reasoning_content` / `tool_calls` 三者之一非空 —— 与提案里的 `hasContentDelta` **逐条对应**。

**④ spec delta 未改原意**：MODIFIED 段落里既有 requirement 文字经程序比对，与 `openspec/specs/agent-loop/spec.md:51` **逐字一致**（其后才追加 ttft 段落）。

---

## 四、请重点挑战的检查点

**A. 语义判定（我认为最该被质疑的一条）**
1. 谓词只认 `delta.content` / `delta.reasoning_content` / `delta.tool_calls`，**不认 `delta.reasoning`**（Ollama `/v1` 的思维链字段叫 `reasoning`，实测有内容）。
   → 后果：**开启思考的 provider**，其 ttft 会等于"首个**正文** token 时间"（思考期间不计）。我判定这符合 spec 的"首个含内容 delta"（思维链不是回答内容），且与 llm-proxy 同源。**请复核这个判定**，或给出反例。
2. 无内容 delta 时记 `0`。schema 要求 `number`，所以不能写 `null`。→ 但 `0` 与"未测到"混同，是否违背"诚实"原则？有没有更好的表达（例如也在 UI 上区分）？

**B. 修法正确性**
3. "只提前 `startedAt` 不够、必须把取时点挪进流"——这个判断是否成立？（这是本提案的核心论断，design.md D1 末段）
4. `sentAt` 取在 `fetchImpl` 之前（`buildRequestBody` 之后）。这是否就是 spec 说的"请求发出时刻"？还是应该取在 `buildRequestBody` 之前？
5. 在 `parser.onEvent` 里取时：若**同一 chunk 含多个事件**，时间戳是"该 chunk 到达时刻"而非"该 event 到达时刻"，误差量级 ms 级——可接受吗？

**C. 测试是否真能证伪**
6. `sleep(120ms)` + 断言 `>= 100`：**20ms 余量在 CI 负载下够吗**？是否该改为 `sleep(200)/assert >= 150`，或改用 `vi.useFakeTimers()`（但 fake timers 与真实 `ReadableStream` 的配合需要验证）。
7. `tasks.md` 要求"**改前先在旧实现上跑一次，记录失败**"——你认为这条是否足以防止"新测试恰好也通过旧实现"的假保障？

**D. 打包与影响面**
8. Impact 断言「`trace-as-test` 忽略 `ttft`（`openspec/specs/trace-as-test/spec.md:38`）⇒ 卡带回归不受影响」——请复核该行。
9. Non-goals 里把「`delta.reasoning` → `reasoning_content` 的映射（F3）」排除在外，理由是"另一件事"。**你是否同意**，还是认为两件事该合并（因为它们都改同一段代码）？
10. **D5 跨包口径差异**：修完后 agent-loop 的 ttft 含"等待响应头"，而 llm-proxy 不含。我选择**只记录、不统一**。这个取舍对吗？

**E. 我可能没看到的**
11. 有其它消费 `ttft_ms` 的地方吗？（我做过全仓 grep：渲染层只有 `DetailPanel.tsx:609`；`trace-test/shape-align.ts:46` 明确忽略；`deriveComparison` 不消费；`trace-sdk` 只做 schema 校验。）请复核这个清单是否漏了。
12. 有没有**让这个修复引入新回归**的路径？（例如：某个测试/fixture 断言了具体 ttft 值、或某个派生依赖"ttft 很短"这个隐含假设。）
13. 归档时主 spec 的落法：把新增 Scenario 合并进 `openspec/specs/agent-loop/spec.md` 的对应 requirement，**是否有既范例**？请核对 `openspec/changes/archive/` 里同样"MODIFIED requirement + 新增 scenario"的归档产物写法是否与我一致。

---

## 五、边界与放行

- **本轮只审**：不改代码、不改 spec 主文件、不归档、不重算历史 trace
- 审阅产出建议格式：**逐条**（1–13）给「通过 / 需改（附理由）」，外加一节「作者没看到的 blocker」
- 放行信号：用户明确说"可以/开始/apply"后才进入实现阶段；实现阶段的验收按 `tasks.md` 3.1–3.5（六包回归 + biome + 真实 provider 抽样 + strict 校验）
- 相关背景文档（按需）：`D:\ReBaseAgent\docs\2026-09-10-dogfood-plan.md`（§六 D4 / §七 F7 / 附录 A-3）、`D:\ReBaseAgent\docs\2026-09-10-reply-3-to-anipedia.md`（AniPedia 侧拍板"修根因"的四条理由）
