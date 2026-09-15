# Review：A2 共享前缀重跑·事实校准（fork 缓存命中记账与成本兑现）

> 审阅日期：2026-09-15
> 审阅对象：`openspec/changes/add-fork-cache-accounting/{proposal,design,specs,tasks}`
>
> **收口状态（2026-09-15，apply 前已完成）**：本文件的 2×P1 + 5×P2 **全部收口**；另一份外部审阅
> （`docs/reviews/2026-09-15-add-fork-cache-accounting-proposal-review.md`，2×P1 + 3×P2）亦全部收口。
> 逐条对照表见 `tasks.md`「审阅收口（apply 前）」节，另有 2 处 apply 前自行发现的落点错误一并修正。

## 结论

**方向正确，范围收敛得当，设计质量高，可应用（apply 前需清理 2 个 P1 + 5 个 P2）。**

本 change 的最大优点是**诚实地重新划定了范围**：它没有去"实现"一个早已存在的机制（编辑 `tool_result` 前缀截断重跑已在 `replay-run.ts:103-104` 实现），而是把目标校准到真正缺失的**计费侧**——缓存命中不被记录、不被展示、从未实测。这既符合 README 承诺校准为事实的目标，也避免了重复造轮子。三个 capability delta（agent-loop 解析、trace-format 记账、desktop-ui 展示）职责清晰，Non-goals 与保真度边界界定完整，且显式对齐了项目「更可视化」的产品方向约束。

## 源码依据核查（§五纪律）

以下 proposal 引用的代码锚点经逐一核实，**全部准确**：

| 引用 | 实测 | 结论 |
|---|---|---|
| `llm-client.ts:283-290` usage 只记 `{in,out}` | [llm-client.ts](file:///d:/ReBaseAgent/packages/agent-loop/src/llm-client.ts#L282-L290) 每块覆盖式 `agg.usage = { in, out }` | ✅ |
| `llm-client.ts:158` `Aggregation.usage` 形态 | [llm-client.ts](file:///d:/ReBaseAgent/packages/agent-loop/src/llm-client.ts#L158) `usage: { in; out } | null` | ✅ |
| `replay-run.ts:103-104` 分叉点前零 LLM 调用 | [replay-run.ts](file:///d:/ReBaseAgent/packages/replay/src/replay-run.ts#L103-L104)「纯数据变换，分叉点之前零 LLM 调用」 | ✅ |
| `DetailPanel.tsx:676-678` usage 行 | [DetailPanel.tsx](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx#L675-L678) 输入/输出/首 token 延迟 | ✅ |
| `DetailPanel.tsx:944-1059` `ForkEditor` | [DetailPanel.tsx](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx#L944-L1059)「在此重跑」编辑器 | ✅ |
| schema.ts:25-28 `LlmUsageSchema` | [schema.ts](file:///d:/ReBaseAgent/packages/trace-sdk/src/schema.ts#L25-L29) `in`/`out` int nonnegative | ✅ |
| `config_hash` 不纳入 model（fork 换模型合法） | [fork-runner.ts](file:///d:/ReBaseAgent/apps/desktop/src/main/fork-runner.ts#L96) `configHash(systemPrompt, tools)` | ✅（此点支撑 P1-1 的意义） |
| 分叉点前首调用重发整个前缀（hit 前提） | `state.messages` = 截断拼接前缀 | ✅ |

任务审批成本算术 `Σ(in − cache_hit + out)` 对 DeepSeek（`prompt_tokens = hit + miss`）成立。

## P1（应用前必须解决）

### P1-1 前端无法复用 `findStepLlm`——「同一语义只写一处」纪律被触碰

design §4.3 的 fork 模型不一致提示，判据取「分叉点所在 step 的 llm.call 录制 `request.model`」，注释写「`findStepLlm` 同源查法」。但 [fork-runner.ts:276](file:///d:/ReBaseAgent/apps/desktop/src/main/fork-runner.ts#L276-L285) 的 `findStepLlm` 是 **main 进程私有函数**，而 `ForkEditor` 是 **renderer 组件**（[DetailPanel.tsx](file:///d:/ReBaseAgent/apps/desktop/src/renderer/src/components/DetailPanel.tsx#L945)），拿不到它。若按现状实现，renderer 必须重写一段「给定 tool.invoke span → 同 step 的 llm.call → 取 request.model」的查表逻辑——这恰好是项目 history 里因为「同一语义写两遍、一处跑偏」踩过的坑。

**要求**：proposal/design 必须明确前端落点——要么把该查表抽为 `shared` 纯函数双端复用（推荐，符合「同源」纪律），要么证明 renderer 侧已有等价的既有查表（`RunDetail.spans` 步行可做，但须指出具体复用点而非「同源查法」四个字）。task 2.4 的「判据纯函数」应落在这个共享函数上，而非 fork-runner 的私有实现。

### P1-2 「字段缺失(未知)」vs「命中 0(全量计费)」的判定未钉死为判别语义

design §1/§4.1 在**语义层**正确区分了「provider 未返回 → 整组省略（未知，显示 0）」与「DeepSeek 常规缓存未命中返回 `prompt_cache_hit_tokens: 0` → 记录 0（实零命中）」。但 agent-loop 场景「未返回字段时省略」与 desktop 场景「有值时展示」的措辞过宽——若实现按 JS 惯用 truthiness（`if (usage.cache_hit)`）处理，**DeepSeek 每次未命中调用返回的 `0` 会被当 falsy 整行省略**，从而「这次全量计费」的 amber 提示分支在**生产最高频路径上静默失效**，主卖点降级。

**要求**：在 trace-format 或 desktop-ui delta 加一条显式约束（字段存在性判定 = `'cache_hit' in usage` / `!== undefined`，而非 truthy；`0` 属「有值」）；对应 task 补一个「hit=0 时仍展示为全量计费」的用例。

## P2（收尾前处理）

### P2-1 命名论证与 `in`/`out` 自相矛盾
design §1 以「trace 既有字段是 snake_case（`config_hash`/`ttft_ms`）」论证取 `cache_hit`/`cache_miss`，但**同一 usage 对象的兄弟字段恰是 `in`/`out`（非 snake_case）**。要么改用 `cacheHit`/`cacheMiss` 与对象内兄弟一致，要么修正论证措辞（说明是按 trace 顶层字段惯例而非 usage 内部）。二者任一即可，当前论证不成立。

### P2-2 占比分母 `in` 的 provider 语义未契约
点缀占比分母取 `usage.in`，隐含「`in` 已含命中部」这一 provider 约定（OpenAI/DeepSeek 实践满足，但非契约）。建议在 desktop 场景注明分母口径依赖 provider 语义，并保证 `in=0` 时不除零（一行防御）。

### P2-3 trace-format 场景缺「非法值拒绝」
trace-format 只有「写入 / 老文件合法」两场景，非法值（负数/非整数）拒绝只在 task 1.2 出现。建议补一个场景钉住 zod 行为，与「老文件合法」对称。

### P2-4 「fork 确认弹窗」措辞过泛
desktop 场景写「fork 确认弹窗」，但只有 **tool_result 分叉（`ForkEditor`）** 才共享前缀、缓存提示才有意义；prompt fork 是全新实验、Messages fork 走代理重发，均不适用。应明确提示仅挂 tool_result 分叉，避免实现者全量接入。

### P2-5 穿透的低风险点：usage 覆盖时机
现有解析对每个完整 usage 块**覆盖** `agg.usage`。若缓存字段落在与 `prompt_tokens` 不同的块，覆盖式赋值可能丢字段（DeepSeek 实践中末块同带三字段，风险低）。建议 task 1.1 明示「缓存字段随最终 usage 块与 in/out 同次赋值」，避免后续实现误当「累加」。

## 其他确认项（无异议）

- 方向正确：**范围收敛在计费侧**，不触碰执行语义、config_hash 门禁、world-free 边界；能力增量与任务一一对应。
- 未验证假设（DeepSeek 扁平字段 / OpenAI 嵌套字段 / 缓存 TTL）的证伪命令具体、5 分钟可验，§3.2 证伪则回 proposal 修订的纪律正确。
- trace-format 向后兼容（可选字段、`format_version` 不变、读老文件合法）设计成熟，沿用 `timing`/`budget` 缺省先例。
- 不造第二通道、不做人为干预、不做货币核算等 Non-goals 恰当，避免过度设计。

## 可应用性

解决 P1-1（前端落点）、P1-2（字段存在判定）后即可 apply；P2 项建议在实现过程中顺手清理，不阻塞主流程。