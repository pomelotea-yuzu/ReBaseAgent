# V3b `add-model-ab-experiments` 审阅记录

> 审阅对象：`openspec/changes/add-model-ab-experiments`　｜　本文件为审阅记录，`docs/` 不提交。
> - **第一审（13:20）**：结论「修改后放行」，7 类阻塞 + 5 项架构取舍（见下）。
> - **第二审（13:45，修订版）**：`openspec validate --strict` 通过，路线改为扩展 prompt fork；第一审问题**全部消化**。结论：**条件放行——补完 M1/M2/M3/M4/M11 五条即可开工**，均为文档级补充，无需再审一轮。

## 总体判断

提案本身的工程素养高于平均：诚实性边界（不伪装可比、成本 unknown 不估算、不自动重试）、失败隔离、原子写入、dry-run 门禁都写到了，Non-goals 也守得住。

问题集中在两类：

1. **引用了不存在的基础设施**（脱敏策略、V3a 执行内核、RunConfig 可选字段），照此实现会在第一天卡住；
2. **与已有能力撞车**——`packages/replay` 的 prompt fork 已经实现了"从头真实重跑 + 落盘 + 血缘 + 校验前置"，本 change 另起一套实验体系，会造出两套餐品和两套可比性判据。

---

## A. 阻塞项（必须改，否则实现卡死或破坏既有不变量）

| # | 问题 | 证据 | 建议修法 |
|---|---|---|---|
| A1 | **openspec 校验不通过**：`specs/model-experiments/spec.md` 缺 `## ADDED Requirements` 头，Scenario 写成 `###`（应为 `####`）。本 change 自己的 acceptance gate 就要求 `validate --all --strict` 通过 | `openspec validate add-model-ab-experiments --strict` 报 2 个 ERROR | 补 `## Purpose` + `## ADDED Requirements`，全部 Scenario 升为 `####`。格式参照 `archive/2026-09-08-add-trace-as-test/specs/trace-as-test/spec.md` |
| A2 | **"复用既有脱敏和长度限制"是假前提**：全仓不存在任何脱敏/截断基础设施 | grep `redact`/`脱敏` 零命中；命中 `truncate` 全是 Tailwind CSS 类；`DetailPanel.tsx:16` 明确写"不做任何截断丢弃" | 改为：本 change 定义报告摘要的字段上限（如 200 字符 + `…`），或明确"报告不截断、由 UI 折叠"。另补：apiKey 天然不进 trace（`run-loop.ts:102-107` 只写 model/messages/tools/params），但**配置校验失败时不得回显 `RunConfig` 原文**（含 apiKey） |
| A3 | **"复用 V3a 的 headless 执行内核"说错了**：V3a 的 `rerun.ts` 是**卡带重跑**——`CassetteLlmClient` 消费录制响应、`StubToolTable` 替换 handler（注释："绝不执行真实工具"），与真实 A/B 正交 | `packages/trace-test/src/rerun.ts:11-13`；`cassette-llm-client.ts` | 改为"复用 `agent-loop` 的 `runLoop` + `JsonlTracer`"。V3a 可复用的只有：`MemoryTracer`、CLI exit 0/1/2 约定（`cli.ts`）、相对路径解析约定 |
| A4 | **`ExperimentSpec` 凑不出合法 `RunConfig`**：`RunConfig` 的 `maxIterations`、`exec.cwd` 必填，`budget` 也**必填**（`BudgetSchema` 非 optional 且 refine 要求至少其一）；而 spec 里 `budget?` 是可选，且完全没有 `maxIterations` / `cwd` | `agent-loop/src/config.ts:74-109` | 二选一：① 实验必填 `maxIterations` + `budget.maxTotalTokens`，`cwd` 取进程 cwd；② 复用 desktop 现有构造（`fork-runner.ts:101-108`：`maxIterations: 10`、`budget: {maxTotalTokens: 100_000}`、`sanitizeParams`）。推荐 ② 并把默认值写进 spec |
| A5 | **类型冲突**：`ExperimentArm.params: Record<string, unknown>` vs `SampleParamsSchema = z.record(z.string(), z.number())` | `config.ts:95` | `params` 改为 `Record<string, number> \| undefined`，并说明非数值采样参数（如 `stop`、`response_format`）本期不支持，属 Non-goal |
| A6 | **桌面端没有多凭据**：settings 全局只有**一个** baseURL + 一个 apiKey（加密存储、永不回传 renderer）。`ExperimentArm.baseURL` 暗示跨 provider A/B，桌面端根本做不到 | `main/settings.ts:38-52`；`main/ipc.ts:32` "apiKey 永不回传渲染层" | 首个实现限定为**同 provider 内多 model / params A/B**（baseURL+key 复用 settings）；跨 provider 明确写入 Non-goal，并注明"需多凭据管理能力，另开 change" |
| A7 | **apiKey 注入路径未定义**：`RunConfig.apiKey` 必填，但实验文件不含 key | `config.ts:101` | 写明来源与优先级：桌面端 = settings；CLI = 环境变量（给出变量名，如 `REBASEAGENT_API_KEY`）+ 多 arm 跨 provider 时的映射规则；校验失败错误文本不得包含 key |
| A8 | **工具 handler 从哪来？**（补充项）`ExperimentSpec.tools` 是纯 JSON 声明（无 handler），而 `runLoop` 要求 `tools: Tool[]` 含 handler 且数量与 config.tools 一致 | `run-loop.ts:62-64`；desktop 只有 `read_file`/`write_file` 两个 handler，其他一律 `FORK_UNKNOWN_TOOL` 拒绝（`fork-runner.ts:240-252`） | 必须明确三选一：① 实验期工具一律桩化（复用 V3a `StubToolTable`，工具轨迹只反映"模型会不会调"，不反映真实结果）；② 仅支持无工具任务；③ 扩展桌面内置 handler 白名单。推荐 ①，并在报告里标注"工具结果为桩，不参与质量结论" |
| A9 | **`systemPrompt` 与 `messages` 双真相源**：spec 同时定义 `messages: Message[]` 与 `systemPrompt: string`，若二者不一致，`config_hash` 与实际首次请求会分叉——这正是 prompt fork 早期踩过的坑 | `prompt-fork.ts:5-12` 注释："config_hash 的输入与首次真实请求里的 system 消息必须是同一个编辑值（双真相源）" | 加校验：若 `messages` 首条为 system 消息，其 content 必须 === `systemPrompt`，否则字段级报错；或只保留 `messages` |
| A10 | **顺序执行 + 真实工具副作用 = A/B 系统性偏差**：arm A 的写操作改变外部状态后，arm B 起步环境已不同，先跑的臂天然占优。spec 只覆盖"tool policy 不兼容"，没覆盖"副作用已发生"这一更常见情形 | design §8 只把它列为风险，未上升为规则 | 规则化：任一 arm 执行过 `sideEffect !== false` 的工具 → 比较结果降级为 `not_comparable`（或新增 `degraded`），并给出原因。默认 toolPolicy 建议 = `pure`（桩化） |

## B. 待拍板（架构取舍，影响 tasks 量级）

### B1（最关键）与已有 prompt fork 撞车

`packages/replay` 已实现 `promptReplayRun`：读父 run 首次 `llm.call.request.messages` → 深拷贝并改启动上下文 → **从头真实重跑** → 落一个新 fork run → `fork.edit` 记录编辑项 → 校验全部前置（失败零文件零调用）。它和 V3b 的差别**只有一点**：可编辑维度是 `system_prompt` / `user_message`，而 V3b 需要 `model` / `params`。

而且 `ForkSchema.edit.field` 就是自由 `string`（`trace-sdk/src/schema.ts:34-42`），desktop 侧才是窄化枚举 `["system_prompt","user_message"]`（`shared/ipc.ts:151`）。**把 `model`/`params` 加进去，trace schema 零改动。**

| 路线 | 内容 | 代价 | 收益 |
|---|---|---|---|
| **甲：扩展 prompt fork** | `PromptForkField` 增 `model` / `params`（+ 组合编辑），复用 `promptReplayRun`、分支树、ComparePanel、封存门禁、fork-runner 的 config 构造与工具白名单 | 需要扩展"一次只改一项"为"可组合改多项"；实验视图仍需一个轻量索引 | 一套实验体系、一套可比性判据；A4/A7/A8 大部分被既有代码消化；分支树天然展示 A/B |
| **乙：新建 `ExperimentRecord`（当前提案）** | 独立包 + 独立清单 + 新 IPC + 新 UI | 落盘/原子写/outDir/load 注入/mock 注入/校验前置全部重写；两套实验 UI 并存 | 表达力强：N 臂、跨 provider、预算、批量 |

我的倾向：**甲**。理由不是省事，而是"用户做 A/B 时必然想和既有 fork run 放在一起看"——分裂成两套 UI 会直接损害 JTBD ③。若坚持乙，请在 design 增加一节专门论证"为何不扩展 prompt fork"（现在只论证了"不伪装成 tool-result 时间旅行"，没论证与 prompt fork 的分工）。

### B2 可比性判据与既有的冲突

既有 `deriveComparison` 以**共同祖先**判可比（`derive.ts:441-479`），ComparePanel 已有三态展示。而 V3b 的 arm 是无 parent 的独立根 run → 同一批 run：ComparePanel 判"无共同祖先 / 不可比"，实验视图判 `ready`。**两套结论同时呈现给用户。**

解法：走甲路线后 arm 天然有共同父（实验基线 run），判据统一；或把可比性从"血缘祖先"泛化为"共同输入基线"，在 `derive.ts` 增加 sibling 关系，一套 UI 两种基线来源。

### B3 指标派生在包层不可见

`deriveRunSummary` / `deriveComparison` 在 `apps/desktop/src/shared/derive.ts`，**包层引用不到**（不能反向依赖 apps）。新包做指标派生只能复制一份 → steps/tokens/duration 口径双份，违反"派生不累积、单一真相"纪律，未来必漂移。

决定其一：① 把 `derive.ts` 上提到共享包（建议另开一个"共享派生层"change，本 change 依赖它）；② 实验包只输出 run id 与可比性，具体指标一律由 desktop 派生。

### B4 toolPolicy 三态无实现基础

`ToolDef.sideEffect`（布尔，默认 true，replay 分级用）与本 change 的 `pure|sandbox|explicit` 概念重叠且未定义映射。`sandbox` 在当前代码里**零实现**（隔离世界/COW 快照仍是未来项）。建议本期只保留 `pure | explicit` 两态，`sandbox` 移入 Non-goals。

### B5 成本与价格表

全仓无 cost 字段、无价格表；`BudgetSchema.maxCost` 注释写"暂以 token 计"，`runLoop` 只查 `maxTotalTokens`（`run-loop.ts:91`）。design 的"本地价格表 / price estimator"没有来源。建议明确：**不内置任何价格表**，只接受调用方注入 estimator，缺失一律 `unknown`；`maxCost` 门禁本期不实现（或明确只在外层按 token 估算并标注）。

## C. 小问题

- **C1 status 一词两义**：既有 run status = `completed|crashed`（按"有无终止事件"判定，`reader.ts:106`），终止 reason = `completed|max_iterations|budget_exceeded|aborted|error`。`ExperimentRecord.runs[].status` 用 `completed|failed|cancelled`，而"已封存"又用 completed 表达。建议拆成 `outcome` + `sealed` 两字段，并给出 reason→outcome 映射表（`error`→failed、`aborted`→cancelled、`budget_exceeded`→?）。
- **C2 "共同前缀校验"在正常流程下永不失败**：各 arm 用同一 messages / config_hash 构造，天然一致。真实漂移只来自事后编辑 trace、或改 spec 后部分重跑。design 应写明漂移来源，否则 tasks 4.3 的"输入漂移"测试无从构造（容易写成假测试）。
- **C3 落盘位置未遵守便携数据策略**（项目不变量）：实验清单是新持久化数据，必须走既有 data-dir 解析（dev `.rebaseagent/` / portable 锚点 `PORTABLE_EXECUTABLE_DIR` / `data-dir.json`）。design 只说"与 runs 分目录"，CLI 侧完全没提。好消息：`run-repository` 只扫 `*.jsonl`（`run-repository.ts:19`），清单用 `.json` 后缀不会被误扫——请把它写成硬约束。
- **C4 措辞纪律**：沿链数字禁用"总耗时/总成本"（`derive.ts:11-17`）。独立根 run 的 duration 安全，但一旦复用 ComparePanel 的"累计增量"就要守住措辞。
- **C5 dry-run 与 `--confirm-cost` 的关系**：建议规定 dry-run 时**不需要**确认、也不需要 key（零摩擦看计划），否则"先看看要花多少钱"这个最自然的动作要被迫配 key。
- **C6 清单版本演进**：`format_version: 1` 有了，缺"读到更高版本怎么办"（拒绝并提示升级，还是尽力读）。
- **C7 并发**：两个 CLI 进程同时跑同 id 实验的行为未定义（建议：清单已存在即报错，除非 `--rerun`）。

## D. 放行信号

改完以下几条即可进入实现：

1. `openspec validate add-model-ab-experiments --strict` 零 ERROR（A1）。
2. A2/A3 的错误引用修正；A4–A10 在 design/spec 中有明确答案（不接受"实现时再定"）。
3. B1 路线拍板（甲 / 乙），B2–B5 给出选择并在文档落字。
4. tasks.md 按最终路线重写（若走甲，1.2/2.1/2.3/4.1/4.2 的绝大部分工作量会被既有代码吸收，应体现出来）。

---

# 第二审（13:45 · 修订版）

## 0. 第一审问题的消化情况

| 一审项 | 状态 | 落点 |
|---|---|---|
| A1 格式 | ✅ | `validate --strict` 输出 `Change 'add-model-ab-experiments' is valid`；`## Purpose` / `## ADDED Requirements` / 四级 Scenario 齐全 |
| A2 脱敏假前提 | ✅ | 改为"报告不截断原始 trace，UI 使用折叠"（acceptance gate + spec Requirement 7） |
| A3 V3a 内核误用 | ✅ | 保真度边界点名 `CassetteLlmClient`/`StubToolTable` 不用于本 change |
| A4 RunConfig 必填 | ✅ | spec Scenario「补齐默认运行配置」：maxIterations=10 / maxTotalTokens=100000 / 当前 cwd，再过 schema |
| A5 params 类型 | ✅ | Non-goal + design：`Record<string, number>`，非数值参数不支持 |
| A6 多凭据 | ✅ | Non-goal：单一 baseURL/apiKey，跨 provider 需独立 change |
| A7 apiKey 路径 | ✅ | 桌面 settings / CLI `REBASEAGENT_API_KEY`，不得进 edit value、日志、错误文本 |
| A8 handler 来源 | ✅ | spec Requirement 4：必须与 config.tools 一一对应且含 handler |
| A9 双真相源 | ✅ | spec Scenario「拒绝双真相源或非法参数」 |
| A10 顺序执行偏差 | ✅ | 升级为硬门禁：有副作用工具在创建第一个 run 前拒绝整个实验 |
| B1 路线 | ✅ 甲 | design §1 论证复用 prompt fork；不建 `ExperimentRecord` |
| B2 可比性冲突 | ✅ | 各 arm 直接 parent 相同 → `deriveComparison` 共同祖先判据直接可用 |
| B3 派生复制 | ✅ | design §7 + spec Requirement 7：包层不复制指标派生 |
| B4 toolPolicy | ✅ | 收敛为 `sideEffect === false` 单一门禁 |
| B5 成本 | ✅ | 不内置价格表，缺 estimator 即 unknown |

tasks 也从 16 项收敛到 18 项但全部落在 replay 包与桌面扩展上，工作量与既有代码的复用关系写清楚了。

## 1. 必修（M1/M2/M3/M4/M11，补完即可开工）

### M1（重要）sideEffect 门禁会把真实数据几乎全部拒掉

实测 `.rebaseagent/traces/run_mtljcbrr.jsonl` 的工具表：

```json
[{"name":"read_file", ..., "sideEffect": false},
 {"name":"write_file", ...}]            // ← 未声明，按语义即 true
```

按新规则"缺失标记按有副作用处理并拒绝"，**任何用过 `write_file` 的 run 都不能做 A/B**。而桌面内置工具只有 `read_file`/`write_file`（`fork-runner.ts:236-265`），`write_file` 恒为 true → 首期可用面只剩"全程只用过 read_file 的 run"。

补标记这条路也是堵死的：`configHash` 把 `sideEffect` 计入指纹（`config-hash.ts:18`），给 `write_file` 补任何值都会改 hash，直接违反 spec「新 run 的 config_hash 必须与父一致」；而 `attachHandlers` 本身也不注入该字段（`fork-runner.ts:350-356`，未声明则省略）。

**补丁**：① spec 明确写出这条可用性边界（现在只有 Non-goal 一句话，没说后果）；② 给一个显式逃生舱——`--allow-side-effects`（桌面为二次确认），走这条时比较结果必须标注"顺序执行、外部状态可能已被前一臂改变"，或至少在拒绝错误里给出可操作指引。

### M2（重要）多次实验无法配对

甲路线没有实验分组元数据。同一父 run 连续做 3 次实验 = 6 个同父兄弟 run，UI 与 ComparePanel 无法判断哪两个是一对。

**补丁**：`model_params` 的 value 增加可选 `experimentId`（`ForkSchema.edit.value` 是 `unknown`，schema 零迁移），UI 用它分组并默认配对，缺省时退化为手选。这是甲路线唯一需要补的元数据，成本极低。

### M3（中）CLI 归属与工具来源悬空

- `packages/replay` 没有 `bin`（package.json 无 `bin` 字段），tasks 4.3 要加 CLI 却没说放哪个包。建议明确新增 bin 名（如 `rebaseagent-model-ab`）并说明与 V3a `rebaseagent-trace-test` 的分工（卡带回归 vs 真实调用，不共用 bin）。
- 更关键：**CLI 侧没有工具 handler 来源**。桌面端有内置 `read_file`/`write_file`，replay 包自己不提供 handler，`StubToolTable` 又被明令禁止冒充。spec Requirement 4 要求含 handler 的 `Tool[]`，CLI 无从满足。

**补丁**：明确"CLI 首期仅支持空工具表（纯对话任务）"，或要求调用方显式提供工具模块（后者要写清不做动态加载、不引新依赖）。

### M4（中）漏了"首次请求必须含字符串 system 消息"

既有 `promptReplayRun` 依赖 `derivePromptForkState` 校验编辑目标（要求首次 `llm.call` 含字符串 system 消息）。新 spec 只写了"已封存、非 proxy、含 config_hash"三条，漏了这条。而 model_params 的双真相源校验（`config.systemPrompt` vs 首次 messages 的 system 内容）在**没有 system 消息时根本无法执行**。

**补丁**：Requirement 1 的 Scenario 补一条——父 run 首次 `llm.call` 无字符串 system 消息时前置拒绝（或规定 systemPrompt 必须为空串且一致）。

### M11（中）"强制覆写"与"不一致即拒绝"冲突，会导致该 Scenario 无法验证

既有实现是**强制覆写**（`prompt-replay-run.ts:80`：`effectiveConfig = { ...config, systemPrompt: state.systemPrompt }`）。若模型实验沿用覆写，那么 `config.systemPrompt` 无论传什么都会被改写成父值 → config_hash 永远一致 → spec 的「拒绝双真相源」Scenario **永远触发不了**。若改成拒绝，又会动到既有 prompt fork 行为，违反 spec 的兼容要求。

**补丁**：写清顺序——**先校验后覆写**：`config.systemPrompt !== state.systemPrompt` 直接拒绝；相等时覆写等价于无操作，既有行为零影响。

## 2. 措辞与精确性（顺手改掉）

- **M5「其他字段必须与父配置同源」不成立**：trace 只录 `budget.max_total_tokens`（`run-loop.ts:75-78`），不录 `maxIterations` / `cwd` / `baseURL`。建议改写为：systemPrompt + tools 必须与父 `config_hash` 一致（硬校验）；`maxIterations`/`budget`/`cwd`/`baseURL` 由调用方提供并取默认值，并说明"各臂取同值即保证臂间公平"。
- **M6「增量差值」措辞**：现有 `deriveComparison` 只有"各臂相对共同祖先的累计增量"，**没有 A−B 臂间差值列**。要么明确"臂间比较由用户完成"，要么引入基线臂。同时提醒实现者守住措辞纪律（沿链数字禁用"总耗时 / 总成本"）。
- **M7 取消**：建议写明"每臂独立 AbortController，共享一个父 signal 做级联"，否则已完成的臂可能被后续 signal 误伤。
- **M10 params 缺省**：父 run 首次请求无 `params`（`run-loop.ts:106` 未写该字段）时，建议明确"父 params 缺省视为空对象"，否则"至少一项实际改变"的判定有歧义。

## 3. 第二审放行信号

1. M1 的可用性边界 + 逃生舱（或明确不做）落字；
2. M2 的 `experimentId` 进 design §2 与 tasks 1.1；
3. M3 的 CLI 归属包 + 空工具表限制写进 spec；
4. M4 的 system 消息前置条件补进 Requirement 1；
5. M11 的"先校验后覆写"写进 design §3。

五条都是文档级补充，**不需要再审一轮**，补完即可进入实现。
