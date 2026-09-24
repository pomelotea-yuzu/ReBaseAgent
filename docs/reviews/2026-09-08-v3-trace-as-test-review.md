# V3 方案（add-trace-as-test）审阅

日期：2026-09-08　审阅范围：`openspec/changes/add-trace-as-test/`（proposal / design / spec / tasks）
对照基线：`packages/{trace-sdk,agent-loop,replay}` 现有实现 + 已归档 9 个 change 的规范

## 一句话结论

初版（14:02）**不放行**；14:23 修订版已解决初版全部阻塞，见文末「**七、复审**」——但仍有 1 个硬性矛盾 + `openspec --strict` 仍失败（两条 Requirement 缺 Scenario），**再修一轮即可放行**。

初版的两个问题：

1. **规范硬伤**：`openspec validate add-trace-as-test --strict` 失败——spec.md 缺 `## ADDED Requirements` delta 头，与全部 9 个已归档 change 的写法不一致。
2. **语义空洞**：按初版 design，测试**没有重跑任何东西**，只是在静态 JSONL 上做断言，因此**永远通过、零回归保护**。这是必须先在 spec 层面解决的问题，不是实现细节。

> 初版正文（第一~六节）保留备查；最新结论以第七节为准。

---

## 一、致命问题：这是一个重言式测试

### 问题

design.md 第 3 步写的是「在 world-free 模式下**从记录的消息和工具结果构建确定性事件流**」。这句话可以有两种读法：

| 读法 | 含义 | 是否回归测试 |
|---|---|---|
| A. 静态投影 | 读 trace → 把已录制的 spans 整理成事件流 → 断言 | ❌ **重言式** |
| B. 卡带重跑 | 把录制的 LLM 响应当卡带注入 `runLoop`，用**当前代码**重跑一遍 → 对新产出的 spans 断言 | ✅ 真回归测试 |

spec 全文没有任何一处要求「重新执行 agent-loop」，断言项（`run.status` / `span.exists` / `span.field`）全部是 trace 里已经存在的事实。**在读法 A 下这是一定的**：trace 是提交进仓库的静态文件，字节不变 → 断言结果永不变 → CI 永远绿。它连「我改坏了代码」都测不出来，因为它根本没跑代码。

这不是措辞问题，是整个 change 的价值支点。V3 的立身之本（memory: "v3 进 CI 团队接入即粘住"）就靠这一条。

### 证据：代码上 B 完全可行

- `runLoop(config, initialMessages, tracer, tools, llm, forkRun)` —— LLM 客户端可注入（`LlmClient` 接口只有一个 `complete()`）。
- `llm.call` span 录制了完整的 `request.messages` 与 `response{content, tool_calls, usage, ttft_ms}` → **卡带素材齐全**，按 step 顺序回放即可，零网络、零 API 消耗、完全确定。
- `tool.invoke` span 录了 `args` / `result` / `error` → world-free 下用「返回录制结果」的桩工具注入，外部副作用零参与，与现有 world-free 语义一致。

也就是说：**卡带重跑（读法 B）是能做的，而且成本很低**。方案只是没写。

### 必须补的 spec 要求（建议原文）

> 系统 SHALL 以 trace 中记录的 llm.call 响应为卡带、以记录的 tool.invoke 结果为工具返回值，使用**当前** agent-loop 与**当前**工具声明重新执行一遍运行，并对**新产生**的 span 流执行断言。系统 SHALL NOT 仅对 trace 中已记录的 span 做静态断言。

对应地把 tasks 2.1「实现 world-free 事件投影」拆成四个可验证任务：

- 2.1a 卡带 `LlmClient`（按 step 顺序吐录制响应；请求不匹配立即报配置错误而非静默跳过）
- 2.1b 录制工具表（从 trace 构造 `Tool[]`，handler 返回录制 `result`/`error`，**不执行任何真实工具**）
- 2.1c headless `runLoop` 执行（无 Electron、无 fs 落盘，内存 Tracer）
- 2.1d 轨迹对齐断言（见下 M3）

---

## 二、第二个致命问题：config_hash 门禁会被测试场景本身触发

`replayRun()` 里有一条硬校验（`packages/replay/src/replay-run.ts:96`）：

```
config_hash 不一致 → throw「换源码属于新实验而非时间旅行，拒绝伪装成分支」
```

而 Trace-as-Test 的典型场景恰恰是：**我改了 system prompt / 工具表，想看有没有跑歪**。此时 `configHash(currentConfig) ≠ trace.meta.config_hash` 是**常态**，不是异常。

方案必须显式回答：

- 测试路径**不复用** replay 的 hash 门禁（否则一改源码测试就变配置错误，直接死）；
- 但 hash 漂移必须**显式上报**（例如报告里带 `config_drift: {recorded, current}`，CLI 输出 warning），否则用户以为测过了，其实卡带里的旧回答已经不能代表新 prompt 下的模型行为。

建议新增一条 Requirement：**配置漂移可见**。

同时注意：**工具声明必须从用户当前代码拿**（而不是从 trace 或从测试定义 JSON 里抄一份），否则工具协议改了也不漂移、测不出来。这一点直接把「接口形态」推向测试框架集成（见 M5）。

---

## 三、重要问题（不阻塞语义，但会决定 V3 好不好用）

| # | 问题 | 说明与建议 |
|---|---|---|
| M1 | **定位错配** | 卡带重跑冻结了模型回答，它能测的是「**Agent 运行时（harness）回归**」：工具分发、参数校验、终止条件、预算、错误路径。它**测不了**「改了 prompt 模型会不会跑歪」——那是最高频需求，而 live 模式被列为 Non-goal。建议要么把 change 名和对外话术收紧为「运行时回归测试」，要么把 live 模式列入 V3b。名不副实会让 V3 让人失望。 |
| M2 | **断言选择器语义未定义** | `span.exists{tool:"read_file"}` 在一条 trace 里有 5 次 `read_file` 时匹配谁？第一个？全部？缺失时算 fail 还是 skip？必须定义 `selector: first \| nth:number \| all`（默认 `all` + `any/all` 量词），否则实现各写各的、断言静默变弱。 |
| M3 | **缺默认断言：结构性轨迹对齐** | 手写 `span.*` 断言是「我知道会坏在哪」的测试；回归测试要的是「我**不知道**哪里坏了」。应把「新产出的 span 序列 ≡ 录制序列（归一化 timing / usage / ttft / dur_ms 后）」做成**一等断言**，最好是默认项。注意这与 Non-goal「不做全文字符串 snapshot」不冲突：排除的是自由文本，比的是结构（kind / tool / args 形状 / 顺序 / 终止 reason）。 |
| M4 | **`run.status` 字段名不存在** | trace 里是 `run.event{event: stopped\|aborted\|errored, reason: completed\|max_iterations\|budget_exceeded\|aborted\|error, at?}`。示例里的 `{ "type": "run.status", "equals": "completed" }` 混了 event 与 reason。建议改名 `run.outcome`，取值对齐 `reason` 五个枚举。 |
| M5 | **分发缺口（进 CI 的前提缺失）** | 包是 workspace 私有的，没发布到 npm。CI 里 `npm i @rebaseagent/trace-test` 装不到 → 「进 CI」这条主线在 v1 内闭环不了。另建议接口优先级倒过来：**先做 vitest/jest 集成**（`runTraceTest()` 在用户已有 runner 里跑，config/工具天然来自用户代码、零漂移，还白拿 watch/报告/CI），CLI 作为 CI-only 的次要入口。 |
| M6 | **隐私/脱敏** | trace 含完整 prompt 与响应内容，进仓库有泄露风险。方案只在「报告输出」提了脱敏，不够。需要：① 文档明确警告 ② 提供 `--redact` 或测试定义级 redact 规则 ③ 断言失败摘要默认截断（已有）且不落盘敏感原文。 |
| M7 | **`mode` 字段是投机通用性** | 只有一个合法值 `world-free`，另一条路径明确不做。留着会逼 format_version 演进。建议 v1 去掉 `mode`，等真做 live 时再加。 |
| M8 | **契约细节未钉死** | ① `trace` 相对路径基准（建议相对**定义文件**而非 cwd，否则 CI 换目录就崩）；② 退出码必须给数字（建议 0=通过 / 1=断言失败 / 2=配置错误）；③ 只支持单文件定义，CI 通常需要 `test --dir tests/` 跑一整套。 |
| M9 | **代理录制的 run 怎么测未定义** | `meta.source.kind="proxy"` 的 run 无 `config_hash`，且结构是「单 agent.step + 单 llm.call」。卡带重跑在它上面退化成「回放一次已录制的响应」= 又是重言式。建议明确：代理 run 只支持静态断言，或在 v1 直接拒绝并给出清晰报错。 |

---

## 四、规范硬伤（客观证据）

```
$ npx @fission-ai/openspec@1.12.0 validate add-trace-as-test --strict
✗ [ERROR] trace-as-test/spec.md: No delta sections found.
  Add headers such as "## ADDED Requirements"
✗ [ERROR] file: Change must have at least one delta.
```

对比：9 个已归档 change 的 `specs/*/spec.md` 全部是 `## Purpose` + `## ADDED Requirements` + `### Requirement:` + `#### Scenario:`。本 change 少了 `## ADDED Requirements`，**strict 校验不过 → 无法归档**。修法：在 `## Purpose` 之后、第一个 `### Requirement:` 之前插入一行 `## ADDED Requirements`。

---

## 五、排期意见

- **v0.2.0 已完整发布**（更正既有记录）：`github/main`、`gitee/main` 均在 `3211e78`，本地 tag `v0.2.0` 已建，产物 94 MB（首次低于 Gitee 100MB 限制，可双平台挂附件）。所以「先把 v0.2.0 推出去再开工」这个前提已经满足。
- **但产品化缺口 ②（钩子 demo）仍未做**：「改第 N 步脏 tool_result → 只重跑后半段，约 1/4 成本」这个 90 秒 demo 是拉新钩子，价值密度大概率高于 CI 能力。建议 V3 之前或并行先把它做掉。
- **若坚持先做 V3**，建议拆成：
  - **V3a**：运行时回归测试（本 change 按上文修正后落地）；
  - **V3b**：分支实验 / 模型 A-B 对比（用户更显性需求，当前被列为 Non-goal）。
  先 a 后 b 是合理的——a 提供确定性执行内核，b 复用它。

## 六、放行信号

修订后可以进实现的检查点：

1. `openspec validate add-trace-as-test --strict` 全绿；
2. spec 中明确写出「使用当前 agent-loop 重新执行」的 SHALL，并区分于静态断言；
3. 新增「配置漂移可见」Requirement，并说明测试路径不复用 replay 的 config_hash 门禁；
4. tasks 2.1 拆成 2.1a–2.1d（卡带客户端 / 录制工具表 / headless runLoop / 轨迹对齐）；
5. M2、M4、M8 三条契约（选择器语义、`run.outcome` 取值、路径基准 + 退出码 + 多定义）落进 spec；
6. 明确代理录制 run 的处置口径（M9）。

---

# 七、复审（09-08 14:23 修订版）

修订版把初版意见**全部吸收**：卡带重跑进 design/spec、tasks 拆出 2.1a–d、config drift 可继续执行、
`run.outcome` 对齐 reason 五枚举、selector/quantifier、路径相对定义文件、退出码 0/1/2、
Vitest 优先、代理 run 处置、脱敏警告、去掉单值 `mode`。方向正确，可以往实现走。

但仍有 **1 个硬性自相矛盾** + **1 个校验硬伤** + 5 个实现歧义，建议再改一轮。

## R1（阻塞）改 prompt 必然撞上「请求不匹配」→ 与 drift 承诺直接冲突

代码事实：

- `runLoop` **不**注入 system 消息（`run-loop.ts` 只做 `messages: [...messages]`），
  `buildRequestBody` 也原样透传 `messages`。system prompt 是**调用方放在 messages[0]** 的
  （旁证：`apps/desktop/src/main/fork-runner.ts:162` 正是从首次 llm.call 的 system 消息**反推** `systemPrompt`）。
- 因此录制的 `llm.call.request.messages[0]` 就是旧的 system prompt 文本。

于是：

- design 第 2 步：请求与记录不匹配 → **立即配置错误**；
- spec「配置漂移可见」场景「修改 prompt 后测试」：**卡带测试仍执行**，报告带 drift 警告。

改了 prompt → 第一条请求就不匹配 → 直接 exit 2 → drift 警告永远没机会出现。
**而"改 prompt"恰恰是该 Requirement 唯一举出的场景。** 两者必须选一个并写死：

- **方案 A（推荐）**：卡带**按调用序号**取响应（第 n 次 llm.call → 第 n 条录制响应）；请求差异**不硬失败**，
  记为 `request_drift` 明细（含首个差异位置）；只有「卡带耗尽 / 卡带有剩余未消费」才是配置错误。
  「请求结构是否与录制一致」降级为可声明断言（比较角色序列、工具名与 tool-call 结构，忽略文本）。
- **方案 B**：保留硬匹配，但**只比较消息角色序列与工具调用结构**，把 system 文本与自由文本差异归入 config drift。

注意连带影响：`request.tools` 也在录制请求里（tools 非空时），所以**改工具协议同样会触发硬错误**，
会让 proposal「工具协议变化可被暴露」的承诺一起落空。方案 A/B 都顺带解决。

## R2（阻塞）`openspec --strict` 仍失败

```
✗ ADDED "代理 run 的处置明确" must include at least one scenario
✗ ADDED "CI 集成和隐私边界" must include at least one scenario
```
两条 Requirement 各补一个 `#### Scenario:` 即可（其余 5 条都合规）。

## R3 初始 messages 从哪来，没写

design 第 4 步只有 `runLoop(config, messages, ...)`。必须写明：
**initial messages = 首条 `llm.call` 的 `request.messages`（含其中的 system 首条）**，
即沿用录制的旧 prompt（VCR 语义：测的是"旧输入 + 新 harness"）；prompt 变更交给 config drift 提示重录。
不写明的话，实现者用 task 字符串或空消息起跑，整条轨迹都对不上。

## R4 桩工具的匹配键未定义

当前 run 第 2 次调 `read_file`，取哪个录制的 `result`？按 `(tool 名, 调用序号)` 还是 `args` 相等？
若当前代码 args 变了仍返回旧 result → **假绿**。建议：按 `(tool 名, 调用序号)` 取，
args 差异交给轨迹对齐（已含 args 形状）与 `span.field{field:"args"}` 断言，并在报告里给 args mismatch 明细。

## R5 缺「基线更新」出口（决定采用率）

结构对齐默认开启后，任何**合法**的结构变化（例如新增一个日志 span）都会让测试永久红，
用户只能删测试。VCR 有 `--record=all` 的前车。必须写明如何更新基线：
重录一次 run 覆盖 trace（推荐，与"trace 即资产"一致），或提供 `--update-baseline`。
另建议允许在定义里关掉/裁剪结构对齐的比较项。

## R6 `MemoryTracer` 不存在

trace-sdk 只有 `JsonlTracer`（落盘）与 `NullTracer`（丢弃），没有收集器。tasks 2.1c 说的"内存 tracer"
需要**新增**一个，并决定归属（建议放 trace-sdk 复用 `BaseTracer`，避免第二套 tracer/解析器）。任务里点名。

## R7 小的不一致

- design 示例出现 `{ "type": "trace.shape" }`，但 spec 把结构对齐写成"默认行为"而非断言类型 → 二者统一
  （建议 spec 把 `trace.shape` 列为一等断言类型，可配置比较项）。
- 「LLM 请求漂移」场景写"返回配置/轨迹错误"，退出码未定 → 按 R1 方案 A 则不算失败，按 B 则固定 2。
- `span.exists` 配 `quantifier: all` 语义绕（零匹配才失败）→ 建议 exists 默认 `any`，并在 spec 写清各断言默认量词。

## 复审放行信号

1. `openspec validate add-trace-as-test --strict` 全绿（补 2 个 Scenario）；
2. R1 二选一写死（推荐方案 A：序号取卡带 + drift 明细 + 耗尽/剩余才是配置错误）；
3. R3 初始 messages 来源写进 spec；R4 桩工具匹配键写进 design；
4. R5 基线更新方式写进 design；R6 tasks 点名 MemoryTracer 及其归属包。

---

# 八、三审（09-08 14:38）· 结论：**放行，可进实现**

`openspec validate add-trace-as-test --strict` → **`Change 'add-trace-as-test' is valid`**。
R1–R6 逐条确认已修：

| 项 | 落点 | 状态 |
|---|---|---|
| R1 请求漂移硬矛盾 | design 第 2 步 + spec「LLM 请求漂移」场景：按调用顺序消费卡带、记 `request_drift`、**仅卡带耗尽/有剩余**才是配置错误 | ✅ 采纳方案 A |
| R2 两条 Requirement 缺 Scenario | 「代理 run 的处置明确」「CI 集成和隐私边界」各补 `#### Scenario:` | ✅ strict 通过 |
| R3 初始 messages | design 第 2 步 + spec 卡带重跑 Requirement：取首个 `llm.call` 的 `request.messages`（含录制 system） | ✅ |
| R4 桩工具匹配键 | design 第 3 步 + spec 结构对齐 Requirement + task 2.1b：`(tool name, invocation sequence)` | ✅ |
| R5 基线更新 | 新增 Requirement「结构对齐基线可控」+ task 3.3：重录或 `--update-baseline`，禁止静默覆盖 | ✅ |
| R6 MemoryTracer | design 第 4 步 + task 2.1c：在 trace-sdk 的 `BaseTracer` 之上新增导出 | ✅ 可行（BaseTracer 有 `onMeta`/`onSpan`/`onEvent` 三钩子，`NullTracer` 即其例） |
| R7 小不一致 | `trace.shape` 已列为可显式配置的断言（spec 结构对齐 Requirement） | ✅ |

## 残留 3 项（措辞级，实现时钉死即可，不再卡一轮）

1. **选择器默认量词未定**：spec 写了支持 `first`/`nth`/`all`、缺失匹配即失败，但没写默认值。
   `span.exists` 配 `quantifier: all` 语义偏绕（只有零匹配才失败）。建议：`exists` 默认 `any`，
   `span.field` 默认 `all`，`span.count` 走数量阈值。
2. **drift 是否影响退出码**：config drift / request drift 应**不改变退出码**（0 仍为 passed，仅报告标记），
   否则与「改 prompt 仍执行」冲突。建议 spec 明写一句。
3. **工具名在当前工具表中不存在时**：按 `(tool name, sequence)` 取不到录制结果 → 需明确是配置错误
   还是轨迹对齐失败（建议：配置错误，提示"当前工具表与录制不兼容，请重录基线"）。

## 另建议（非阻塞）

config drift 场景的 THEN 里补一句「报告应建议重录基线」——因为改 prompt 后卡带测试大概率仍然全绿
（假阴性），exit 0 会给人虚假安全感，需要在报告里把这条出路明说出来。

## 下一步

可以开工。建议顺序：`2.1c MemoryTracer`（trace-sdk 侧，独立可测）→ `2.1a 卡带 LlmClient` →
`2.1b 桩工具` → `2.1d/2.1e 重跑 + 结构对齐`，最后 `3.1 runner API` / `3.2 CLI`。
