# 设计：A2 共享前缀重跑·事实校准（fork 缓存命中记账与成本兑现）

## 0. 范围校准（先于一切）

**本 change 不实现"共享前缀重跑"的执行机制——它已经存在**：

- 编辑 `tool_result` 从该步重跑 = `replayRun`（`packages/replay/src/replay-run.ts`，主 spec `replay` 即其契约）
- 「分叉点之前零 LLM 调用（截断拼接而非重放）」= `replay-run.ts:103-104`
- 前缀逐字节稳定（provider prompt cache 命中前提）= `buildRequestBody` 纯函数不变量（agent-loop 主 spec「请求前缀稳定性」）

README 路线图 A2 条目声称的缺口（"当前所有重跑都是从头执行"）是**错误描述**（HANDOFF §三 已勘误）。真正剩余的是**计费侧**：fork 重跑的首个 LLM 调用重发整个前缀，「成本约 1/4」依赖 provider prompt cache 命中，而命中既不被记录（usage 只记 `{in, out}`，`llm-client.ts:283-290`）也不被展示、从未实测。

**本 change = 记账（§1–§3）→ 可视化（§4）→ 实测校准（§5）**。执行语义零改动。

## 1. 字段设计：`usage.cache_hit` / `usage.cache_miss`

- **命名**：trace 顶层字段一律 snake_case（`config_hash`、`ttft_ms`、`dur_ms`），故取 `cache_hit` / `cache_miss`。**例外说明**：同一 usage 对象内的兄弟字段是 `in` / `out`（项目既有短名，非 snake_case）——本 change 取顶层惯例而非 usage 内部惯例，理由是这两个字段会出现在 trace 行里与其它 snake_case 字段并列（P2-1 审阅项：原论证只提顶层、未处理 usage 内部的反例，此处补正）。
- **只记 tokens，不记货币**：价格随 provider 变动，换算留给用户（Non-goal）。
- **语义**：`in` 仍为 provider 返回的 `prompt_tokens` 原值（含命中部分，依赖断言口径的**未验证假设 4**），`cache_hit` 是其组成维度的附加信息——`deriveTotalTokens` 等既有派生（`in + out` 求和）不受影响，不重复计费。
- **存在性判定语义（P1-2 审阅项，必须钉死）**：字段"有值"的判据是 **`cache_hit !== undefined`（`'cache_hit' in usage`）**，**不是 truthiness**。原因：DeepSeek 在常规未命中时返回 `prompt_cache_hit_tokens: 0`——若实现写成 `if (usage.cache_hit)`，**"命中为 0"的最高频路径会被 `0` 的 falsy 静默吞掉**，amber「全量计费」提示永不出现，主卖点在生产主路径上失效。`0` 是**有值**（实测零命中）；只有**字段缺失**才是"未知"。
- **异常防御**：占比与 miss 推算对 `cache_hit > in` 的异常口径数据 clamp（占比至 100%、miss 至 0）并标注异常，不显示负值；`in === 0` 时占比分母不参与计算（只展示绝对 tokens，不做除法，防 `0/0`）。
- **可选性**：provider 未返回缓存字段 ⇒ 两个字段**整体省略**，不写 0 冒充（0 是"实测零命中"，与"未知"语义不同）。

类型变化点（两处，同步改）：

```typescript
// packages/agent-loop/src/llm-client.ts:9（LlmResponse.usage）
usage: { in: number; out: number; cache_hit?: number; cache_miss?: number };

// packages/trace-sdk/src/schema.ts:25-28（LlmUsageSchema）
export const LlmUsageSchema = z.object({
  in: z.number().int().nonnegative(),
  out: z.number().int().nonnegative(),
  cache_hit: z.number().int().nonnegative().optional(),
  cache_miss: z.number().int().nonnegative().optional(),
});
```

## 2. 解析实现（agent-loop）

落点：`aggregateSseStream` 的 usage 块解析（`llm-client.ts:279-290`）。`Aggregation.usage` 类型同步扩展（`llm-client.ts:158`）。

解析规则（与 `pickReasoningDelta` 的"块内二选一"先例同风格——同一语义只写一处）：

```
cache_hit  = prompt_cache_hit_tokens           （DeepSeek 扁平，优先）
          ?? prompt_tokens_details.cached_tokens （OpenAI 嵌套，兜底）
cache_miss = prompt_cache_miss_tokens          （仅扁平形态携带）
```

- 两形态并存取扁平（spec scenario 已定）；`cache_miss` 无嵌套等价物，嵌套形态时省略。
- 值非正整数的**类型**校验：`typeof !== "number"` 一律视为缺失，沿用既有"中间块 usage 容错跳过"的语义（`llm-client.ts:280-282` 的 deepseek v4-flash 实测教训）。注意 `0` 是合法数字 ⇒ **保留为 0**（见 §1 存在性判定）。
- **赋值时机（P2-5 审阅项）**：现有解析对每个完整 usage 块**覆盖式**赋值 `agg.usage = { in, out }`。缓存字段 SHALL 与 `in` / `out` **同一次赋值**写入（同一个对象字面量），SHALL NOT 跨块累加或分别赋值——否则若缓存字段与 `prompt_tokens` 落在不同块，覆盖式赋值会把先前写入的缓存字段丢掉。
- `OpenAiCompatClient` 只走 SSE 流式一条路径（`stream_options.include_usage`），无非流式分支需要改；llm-proxy 有自己的聚合（Non-goal，不动）。

**未验证假设**：DeepSeek 流式 usage 携带 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`、OpenAI 风格端点携带 `prompt_tokens_details.cached_tokens`——由 §5 实测证伪/证实；解析按容错设计，任一假设不成立时字段自然缺省、行为不劣化。

## 3. trace-sdk 读取端

`LlmUsageSchema` 加 optional 字段后，读取端（`readRun` / zod 校验）天然接受老文件（无字段合法），与 `timing` / `budget` 的缺省字段先例同法（缺省 = 时间未知，这里缺省 = 缓存命中未知，调用方按未知处理，不推断）。`format_version` 不变。

## 4. 桌面端可视化

### 4.1 llm.call 详情：缓存命中行

落点：`DetailPanel.tsx` 的 `LlmCallDetail`「概要」区（现有 `KeyValue` 行「输入 tokens / 输出 tokens / 首 token 延迟」，`DetailPanel.tsx:672-683`）。

**实现形态（实测修正）**：`KeyValue` 只接受 `Array<[string, string]>` 并统一渲染，**不支持逐项着色**（`DetailPanel.tsx:50-60`）⇒ 着色需求不能塞进 `items`，须在 `KeyValue` 之后追加一个专用行元素。判据与显示：

```
cache_hit 有值（!== undefined）：
  缓存命中  800 / 1000（80%）  ·  miss 200      ← 命中为主：emerald「前缀缓存生效，本次调用省钱」
  缓存命中  128 / 323（40%）  ·  miss 195      ← 部分命中：amber「部分命中，多数输入仍按全价计费」
  缓存命中  0 / 1000（0%）                     ← 零命中：amber「全量计费（无命中）」
cache_hit 缺失（老 trace / 不支持缓存的 provider）：整行省略（不显示 0，不报错）
```

- 分母 = `usage.in`（当次输入总量）；`cache_miss` 有值时行内并列展示（`miss 200`）。占比对 `cache_hit > in` 的异常数据 clamp 至 100% 并标注异常（假设 4 防御，见 §1）；`in === 0` 时只展示绝对 tokens、不显示占比（防 `0/0`）。
- **措辞按命中量分档**（真机截图暴露的问题）：`hit === 0` 才能叫「全量计费」；部分命中必须说"多数输入仍按全价计费"——命中即已省钱，措辞不得夸大成本。
- **`0` 也要走展示分支**（P1-2）：命中为 0 正是"这次全量计费"的信号，是最该被看见的一态；只有**字段缺失**才省略整行。
- **可视化直观性**（产品方向约束）：着色区分一眼可辨「这次调用省钱了」vs「这次全量计费」，不是只堆一个数字。

### 4.2 run 级累计：现算派生

**派生层**（`apps/desktop/src/shared/derive.ts`，main/renderer 复用、现算不缓存，沿「聚合数字从 spans 现算」纪律）：新增纯函数，并由 `deriveRunSummary` 吸收为字段（与 `tokensIn` / `tokensOut` 同源同口径）：

```typescript
/** run 级累计缓存命中（tokens）；从 run 文件自有 spans 现算（不含祖先前缀），无任何命中数据返回 null（未知≠0） */
export function deriveCacheHitTotal(spans: readonly SpanLine[]): number | null
```

**IPC 载荷**：`RunSummarySchema`（`shared/ipc.ts`）新增 `cacheHit: z.number().int().nonnegative().nullable()`——纯加法字段，老数据/无命中恒为 `null`，schema 校验不回归。

**展示位置（实测修正）**：既有 run 级 token 合计**只出现在 run 列表条目**（`RunList.tsx:123` 的 `formatTokens(run.tokensIn + run.tokensOut)`）；详情面板里的 tokens 全是 span 级/step 级，**没有** run 级合计——原设计写的"详情头部既有 token 合计旁"**该落点不存在**。故改为落在 **run 列表条目**：tokens 合计后追加「命中 X」（`cacheHit === null` 时不渲染）。这也更贴"省钱"叙事——列表里逐条对比各 run 的 tokens 与命中。

**口径（P2-1 修复）**：只算**当前 run 文件自有 spans**——与 `deriveRunSummary` 的 `tokensIn` / `tokensOut` 口径一致（`derive.ts:144-206`，只遍历本文件 spans；`listRuns()` 逐文件 `readRun` 后派生，天然是叶子口径）。展开视图中祖先共享前缀的 llm.call 在 span 级各自显示自己的缓存命中行（无歧义、信息正确），但 **run 级合计不含祖先**：祖先的命中属于祖先 run 的记账，fork run 的合计语义 =「本次重跑实际新发生的计费维度」。

### 4.3 tool_result 分叉编辑器：模型不一致提示

**只挂 tool_result 分叉**（P2-4 审阅项）：只有它共享前缀、缓存提示才有意义。prompt fork 是全新实验（前缀不复用，谈不上命中）、代理 Messages fork 走 `proxy:fork` 重发（同样不共享前缀）——**均不加此提示**。落点因此唯一：`ForkEditor`（`DetailPanel.tsx:944-1059`，「在此重跑」编辑器），与既有的「空 fork」amber 提示同级。

**查表必须双端同源（P1-1 审阅项）**：判据要"给定一个 tool.invoke span → 同 step 的 llm.call → 取 `request.model`"，而**该查表目前只存在于 main 进程的私有函数** `findStepLlm`（`fork-runner.ts:276-285`），且 renderer 侧**没有等价实现**（实测：`DetailPanel.tsx` 里没有任何 step→llm 的查表）。按「同一语义只写一处」，本 change SHALL 把它**上移为共享纯函数**并双端复用：

```typescript
// apps/desktop/src/shared/derive.ts
/** 定位某 span 所在 step 的 llm.call（root→leaf 的查表逻辑，与 fork 编排同源） */
export function findStepLlm(
  spans: readonly SpanLine[],
  atSpanId: string,
): Extract<SpanLine, { kind: "llm.call" }> | null
```

- `fork-runner.ts` 的私有副本 SHALL 改为调用它（行为逐字等价：`atSpan.parent === null` 或父不是 `agent.step` 或同 step 无 llm.call ⇒ `null`），避免第二份实现漂移。
- renderer 传入**当前展示的 `detail.spans`**（分支 run 是 `resolveBranch` 合并视图）：用户点到祖先 span 时给的是祖先的 model——此时 main 侧会用 `FORK_SPAN_NOT_IN_LEAF` 拒绝该 fork，提示与拒绝并不冲突（提示只陈述"模型不一致可能不命中"，不改变门禁）。
- 判据：父 run 分叉点所在 step 的 llm.call 录制 `request.model` ≠ 当前 settings 的 `model`。
- 提示形态：amber 文案行，大意「父 run 模型为 X、当前配置为 Y——前缀缓存可能不命中，计费口径变化」。**信息性提示，不拦截**（换模型重跑是既有合法用法，spec 的 fork 门禁不变）。模型一致时不显示。

## 5. 真机实测协议（「事实校准」的核心）

**目标**：把 README 的「成本约 1/4」从承诺变成带条件的实测结论，或如实证伪。

### 步骤

1. **造父 run**：脚本直录一个 ≥3 步、带 `read_file` 工具的原生 run（真实 provider，DeepSeek，`runLoop` 直录——fork 的桌面 registry 覆盖 read_file/write_file）。产物入 `.rebaseagent/traces/`（gitignore，不入库）。
2. **记录父 run 计费基线**：各 llm.call 的 `usage` 求和（这就是「从头跑一次」的计费样本）。
3. **立即 fork**（缓存有效期内，分钟级间隔）：桌面端编辑第 2 步 tool_result → 重跑。
4. **核对 fork run**：
   - 首个 llm.call 的 `usage.cache_hit` 被记录且 > 0（§2 假设 1 的证实/证伪点）
   - 核对 `cache_hit + cache_miss === usage.in`（假设 4 的证实/证伪点）
   - 记录各调用**原始三元组**（`cache_hit` / `cache_miss` / `out`），成本以**区间**表述：全价下界 Σ(`miss` + `out`)、全价上界 Σ(`in` + `out`)，真实成本介于两者之间（命中部分按 provider 折扣价计费，折扣率是断言口径的未验证假设 5，不入代码）
5. **冷缓存对照**（可选，隔夜或换 key 再 fork 一次）：验证无命中时的真实成本（上限口径）。

### 失真清单（必附，§五纪律）

- 缓存 TTL 与命中由 provider 决定，实测只代表当次条件（执行间隔、账号、模型、负载）
- 温度非 0 时 suffix 输出 tokens 不确定——成本对比以**输入侧**为主，输出侧仅参考
- 父 run 计费基线含生成前缀的输出，fork 只调 suffix 调用——「1/4」的算术本质是**调用次数比 × 命中折扣**，README 措辞必须写明这个口径

### README 改写

- 路线图 A2 条目：勘误缺口描述（分叉点前零 LLM 调用早已实现），改为「缓存命中记账 + 实测」的实际内容，完成后打 ✅
- 正文「时间旅行」段：`成本约 1/4` 改为按实测的限定表述（例：「前缀命中 provider 缓存时，重跑只调 suffix 调用——全价口径省 X%，考虑缓存折扣后实际成本介于父 run 的 Y%–Z%」）；命中不成立则如实写「取决于 provider 缓存策略，当次实测 X」并回 proposal 修订

## 6. 测试策略

- **agent-loop**（`packages/agent-loop/test/`，SSE fixture 直喂 `aggregateSseStream`）：4 个解析用例对应 spec 的 4 个 scenario（扁平 / 嵌套 / 并存扁平优先 / 缺省省略）+ 1 个既有用例回归（`{in, out}` 派生不变）+ **`hit: 0` 被如实记录为 0（而非省略）**（P1-2 关键用例）。
- **trace-sdk**（`test/schema.test.ts`）：老文件（无缓存字段）校验通过、有字段校验通过、`0` 通过、非法值（负数 / 非整数）拒绝。
- **desktop**（node 环境，测纯函数与编排）：
  - `deriveCacheHitTotal` / `RunSummary.cacheHit` 现算（含 `null` 语义、含"0 命中 ⇒ 返回 0 而非 null"）
  - `findStepLlm` 共享纯函数（命中 / 父非 step / 无 llm.call / 空数组四态）+ **`fork-runner` 行为等价回归**（改复用后既有 fork 用例全绿即是该回归）
  - `ForkEditor` 模型提示判据（一致 / 不一致两态，走共享 `findStepLlm`）
- **真机实测不进 CI**（花真钱、依赖外部条件），作为 tasks 中的一次性验证项，结果记入本 design 附录（§8，apply 时回填）。

## 6.1 明确不并入预算地图（P3-3）

预算地图（`BudgetMap` / `deriveBudgetSeries`）的语义是「**上下文占用**」（每个数据点 = 该次 llm.call 的累计 token 占用），与「**计费**」正交：缓存命中不改变上下文长度，只改变计费口径。往预算地图加缓存着色会把两个语义混在一张图里，故**不并入**——缓存命中只出现在 llm.call 概要区与 run 列表条目。

## 7. 影响文件清单

| 文件 | 改动 |
|---|---|
| `packages/agent-loop/src/llm-client.ts` | usage 聚合解析扩展（缓存字段与 in/out 同次赋值）+ 类型 |
| `packages/trace-sdk/src/schema.ts` | `LlmUsageSchema` 两个 optional 字段 |
| `apps/desktop/src/shared/derive.ts` | `deriveCacheHitTotal`；`deriveRunSummary` 增 `cacheHit`；**`findStepLlm` 从 fork-runner 上移为共享纯函数** |
| `apps/desktop/src/shared/ipc.ts` | `RunSummarySchema` 增 `cacheHit: number \| null`（加法式） |
| `apps/desktop/src/main/fork-runner.ts` | 私有 `findStepLlm` 改为复用共享实现（**查表行为不变**；门禁与执行路径不动） |
| `apps/desktop/src/renderer/src/components/DetailPanel.tsx` | llm.call 概要区缓存命中行；`ForkEditor` 模型不一致提示（仅 tool_result 分叉） |
| `apps/desktop/src/renderer/src/components/RunList.tsx` | 条目 tokens 合计旁展示 run 级缓存命中 |
| `README.md` | 路线图勘误 + 承诺按实测校准 |
| 三个包的 `test/` | §6 用例 |

不改动：`run-loop.ts`（派生不动）、replay 包全部、fork-runner 的**门禁与执行路径**（只换查表实现）、llm-proxy、IPC 通道（无新通道，仅 `RunSummary` 加一个可选字段）、预算地图。

## 8. 实测记录（2026-09-15 18:22，真机 DeepSeek）

**执行方式**：`apps/desktop/scripts/measure-fork-cache.cjs`（Electron 进程内跑，用 safeStorage 解出 apiKey 后直调 `runLoop` / `replayRun`——与桌面端 `runs:fork` 同一实现；key 不打印、不落盘）。产物 `run_mu2iw4s1`（父）/ `run_mu2iw6hw_a3ly`（fork），均在 `.rebaseagent/traces/`（不入库）。

**配置**：`https://api.deepseek.com/v1` · `deepseek-chat` · 空 temperature（provider 默认）· 工具 `read_file`（`sideEffect: false`）· 任务为"依次读 a.txt / b.txt 再总结"· 分叉点 = **最后一次** `tool.invoke`（后缀最短 = README「1/4」所指的乐观情形）。

### 原始三元组（逐调用）

| 调用 | in | out | cache_hit | cache_miss | ttft |
|---|---|---|---|---|---|
| 父 #1 | 323 | 54 | 128 | 195 | 709ms |
| 父 #2 | 400 | 46 | 256 | 144 | 560ms |
| 父 #3 | 470 | 39 | 256 | 214 | 400ms |
| **fork #1** | **484** | **53** | **256** | **228** | 533ms |

### 结论

1. **断言 1 证实**：DeepSeek `/v1` 流式 usage **确实携带** `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，且被本 change 的解析如实记录（`cache_hit` / `cache_miss` 落在 trace 里）。
2. **断言 4 证实**：`cache_hit + cache_miss === in` 成立（fork：256 + 228 = 484 = in）⇒ `in` 含命中部分、占比分母口径成立。
3. **"只重跑后缀" 证实**：fork run 只发生 **1 次** llm.call（父 run 3 次）⇒ 调用次数比 1/3。
4. **前缀缓存确实命中**：fork 首个调用重发 484 输入 tokens，其中 **256（53%）命中**缓存 ⇒ README 的「前缀本地命中」在 provider 侧为真（不只是本地拼接）。
5. **「成本约 1/4」的实测口径**：以父 run 全价基线 Σ(in+out)=1332 为分母，fork 的区间为
   - **下界 281（21%）**：Σ(cache_miss + out)，即命中部分零计费的极限；
   - **上界 537（40%）**：Σ(in + out)，即命中部分也按全价。
   ⇒ 真实成本介于 **21%~40%**（DeepSeek 命中输入按折扣价计费，折扣率属 provider 定价，不入代码）。**「1/4」只在乐观下界附近成立**，README 必须改写为区间 + 条件表述。

### 失真清单（必附）

- **缓存是跨请求共享的**：父 run **首次**调用就有 128 命中，说明 provider 缓存里已存在与我方前缀相似的内容（同一账号此前的调用），故"父 run 基线"本身也享受了缓存——**21%~40% 不是"冷 vs 热"的对照**，只是同一时间窗内的实测比例。
- 温度取 provider 默认（非 0），后缀输出 tokens 会波动；成本对比以**输入侧**为主。
- 只跑了一次、一个 provider、一个模型、一个任务；缓存 TTL 与命中率由 provider 决定，**不代表命中率承诺**。
- 未做冷缓存对照（task 3.4，条件不允许：需要隔夜或换账号），故"无命中时的上限"未实测。
- 分叉点取最后一次 tool 调用（后缀最短）。若改更早的步，后缀变长、占比升高——公式：后缀调用数 = 父调用数 − 分叉步序。

### 对 README 的措辞要求

「成本约 1/4」→ 按实测改写为：**重跑只调后缀（本例 3 次调用 → 1 次），且重发的整个前缀会被 provider 前缀缓存命中（本例 484 输入 tokens 命中 256）；全价口径下重跑消耗为父 run 的 21%~40%（区间两端 = 命中零计费 / 命中全价），真实值取决于 provider 折扣。**
