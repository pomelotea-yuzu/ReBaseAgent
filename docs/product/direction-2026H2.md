# AniPedia × ReBaseAgent 方向规划（一审稿 · v2.1）

> 撰写日期：2026-09-10 · 状态：**一审已回（2026-09-10）→ 结论：通过，建议按 §6 执行**
> 一审记录：`docs/reviews/2026-09-10-direction-2026h2-review.md`（外部模型审阅；原平台输出未落盘，由 WorkBuddy 手工保存并附采纳判断）
> 二审记录：`docs/reviews/2026-09-10-direction-2026h2-review-2.md`（WorkBuddy 自查：独立复跑 430 测试 + 本机 Ollama 实测参数保真度 + 跨语言复刻 config_hash。**核心结论：方向成立，但「AniPedia 是理想适配场景」需降级**——V3b 的 OpenAI 兼容路径静默忽略 `num_ctx`、`think:false` 无效）
> 作者：WorkBuddy（v2 稿写在 AniPedia 工作区；v2.1 在 **ReBaseAgent 工作区** 实地复核后修订）
> 范围：两个项目 2026 下半年的发展方向；V3b 已完成后的下一步
> 约定：本文档为探讨类文档，按仓库约定不入库（同 `HANDOFF.md`、`docs/` 下其他文档）
>
> **v2 修订说明**：v1 稿基于过期的 `HANDOFF.md`（2026-09-08）判断「V3b 未开始」，并据此提议立项 V3b。经核查该判断**错误**——V3b 已于 2026-09-09 归档且实现完成。本文档已据此重写，§2.3 保留了我两次判断失误的记录，供一审评估我的信息可靠性。
>
> **v2.1 修订说明（2026-09-10，ReBaseAgent 工作区复核）**：只动**事实层**，判断层（§2 及之后的核心主张）一律保留，仍待一审挑战。本轮修订：
> 1. §1.2 测试矩阵改为**本地实测值**（六包跑完，全绿 430 个测试），并新增一条 `HANDOFF.md` 仍滞后的证据（它写「archive 10 个 / 主 spec 9 个 / validate 9/9」，实际 11 / 10 / 10）；
> 2. §1.2 V3b 表格补三条**只有读源码才知道**的约束：CLI 真实执行需 `--base-url` + `REBASEAGENT_API_KEY`（`model-ab-cli.ts:170-201`）、arm params 只接受**数值**（`model-replay-run.ts:63`，父 params 非数值项被静默过滤）、CLI 与桌面端**两条门禁不同**；
> 3. §1.1 补 AniPedia 的 GEN_OPTIONS 硬约束（`temperature=0` / `presence_penalty=0` / `num_predict=768` / `think:false` / `num_ctx=8192`）——它直接决定 §4.1 的 dogfood 手臂能不能设计出来；
> 4. §4.1 补 dogfood 的**可落地姿势**：Ollama 的 OpenAI 兼容端点 + 空占位 key = 零成本真实 A/B；落盘目录是 `.rebaseagent/traces/`（`REBASEAGENT_TRACES_DIR` 未实现）；
> 5. §1.3 / §3.3 / §8 补硬门槛与风险：`tools` 字段在 CLI 与桌面端要求不同、span id 必须 `s_NN`、父 run 必须已封存；
> 6. §7 问题 6 改写为**三个具体卡点**（不再问空泛的"有没有 blocker"），并新增问题 7。
>
> **注意**：v2.1 未改动两个仓库任何代码，也未改 `HANDOFF.md`（§2.3 的那条建议仍挂着待办）。

---

## 0. 请一审回答什么

本文档的核心是一组**判断**，不是一组事实。事实部分（§1）已实地核查并附出处；判断部分（§2 之后）才是我希望被挑战的。§7 列了最想被回答的问题。

**本文档不含代码改动**，两个仓库目前均未因此修改任何一行代码。

---

## 1. 事实基础（已核查，附出处）

### 1.1 AniPedia 现状

来源：`D:\AniPedia\README.md`、源码、`.workbuddy/memory/MEMORY.md`

| 项 | 状态 |
|---|---|
| 数据 | `data/anime_data.json`，30745 条动画（Bangumi 官方全量 dump） |
| 检索 | Chroma + bge-small-zh，约 6.3 万块（重建日志 62792；MEMORY「问答链路」小节写 63276，同一数量级，不影响任何判断） |
| 问答模型 | Ollama `qwen3.5:4b`（`src/answer.py:22` DEFAULT_MODEL） |
| 完成度 | P1 ✅ / P2 ✅ / P4 Electron UI ✅ / **P3 LoRA 微调 ⏳ 未做** |
| 增强 | 结构化直查 `src/structured.py`、推荐检索 `reco_target()`、系列链 `build_series_chain()` |
| 评测 | 40 题评测集 `eval_baseline_40.json`，八分层，自动判分 22/29 → 26/29；另有 `eval_after_pin.json` / `eval_zh_all.json`，以及 `src/eval_rag.py`（10 题 × 多模型对比） |

架构特征：**单轮、纯对话、无工具调用**——代码检索 → 拼 prompt → 生成。模型从不发起 `tool_calls`。

**v2.1 新增 · 生成参数硬约束（决定 §4.1 的手臂设计能否成立）**：`answer.py` 的 `GEN_OPTIONS` 是
`temperature=0`、`presence_penalty=0`、`num_predict=768`、`think:false`，系列题另需 `num_ctx=8192`。
AniPedia 的项目记忆明确写了：**`presence_penalty` 必须为 0**（默认 1.5 会让模型回避复用 `[1]` 而编造新编号）、
**`temperature` 必须为 0**（默认 1.0 会同题多次输出不一致）、**`num_ctx` 不足会让输出被截断**。
即：AniPedia 的答案质量对这些参数**高度敏感**，任何"换参数重跑"的实验都必须把它们纳入变量或固定住。

**v2.1 新增 · 两处文档滞后**：
- AniPedia `README.md` 写的问答模型仍是 `qwen3:1.7b`，代码已是 `qwen3.5:4b` —— **本项目 README 同样落后于代码**，与 §8 的信息源排序同源问题。
- 生成走 Ollama `/api/generate`（独立 `system` / `prompt` 字段），而 trace schema 要的是 `messages[]` —— 落 trace 时必须规范化成 `[{role:"system"},{role:"user"}]`。

### 1.2 ReBaseAgent 现状（v2 修正）

来源：归档目录与源码实地核查（非仅 HANDOFF）

```text
✅ MVP 5/5
✅ 零摩擦录制代理 llm-proxy（默认端口 18787）
✅ 分支树 + prompt fork
✅ v0.2.0 发行收口（94.3MB）
✅ V3a Trace-as-Test（2026-09-08 归档，包 packages/trace-test，bin rebaseagent-trace-test）
✅ V3b 模型 A/B 实验（2026-09-09 归档，spec model-experiments，bin rebaseagent-model-ab）
```

V3b 实现已确认落地：`packages/replay/src/model-replay-run.ts`、`model-ab-cli.ts`、测试 `model-replay-run.test.ts` / `model-ab-cli.test.ts` 均存在，tasks 全绿。（注：proposal.md 末尾仍留有「当前未实现」的模板段落未清理，是文档残留，非实际状态。）

**V3b 已通过真实 A/B 冒烟**（`exp_mttvdcko_6h5c` 两臂成功）——但父 run 由 `scripts/create-ab-parent.mjs` 现造，**不是真实应用产生的 trace**。
冒烟产物本地仍可查（出处 `docs/product/2026-09-09-roadmap-gaps.md` §附 + `.rebaseagent/traces/` 实测）：父 `run_mttvbmww` → 两臂 `run_mttvdcko_0p8q` / `run_mttvddwj_mg81`，均 deepseek-chat、temperature 0.2 / 1.5。

测试矩阵（**v2.1 本地实测**，2026-09-10 逐包 `vitest run`，工作区干净、无未提交改动）：

| 包 | 测试数 | 结果 |
|---|---|---|
| trace-sdk | 75 | ✅ |
| agent-loop | 52 | ✅ |
| replay | 66 | ✅ |
| llm-proxy | 16 | ✅ |
| trace-test | 65 | ✅ |
| desktop | 156 | ✅ |
| **合计** | **430** | **全绿，零 API** |

> 复核插曲（方法论，供一审评估我的严谨度）：我第一次用「根目录 vitest + `--root <包路径>`」跑，trace-test 报 2 个
> `instanceof TraceTestConfigError` 失败；改回项目约定（cwd = 包目录、`vitest run`）后 65 全绿。
> **那 2 个失败是我的跑法造成的假阳性，不是代码问题**（`--root` 使同一模块被解析成两份，类身份不同）。
> `openspec validate --all --strict` 本轮未实跑（需联网拉 CLI），沿用既有记录 10/10（主 spec 10 个已列目录核实）。

**v2.1 新增 · `HANDOFF.md` 仍在滞后（§2.3 的第三条证据）**：它写「archive 10 个 change / 主 spec 9 个 / validate 9/9」，实际 **11 / 10 / 10**（`openspec/changes/archive/`、`openspec/specs/` 已列目录核实；最新 change = `2026-09-09-add-model-ab-experiments`，最新 spec = `model-experiments`）。

**README 路线图待办（📋，四项）**：① **原生 run 创建入口**（桌面端不能直接新建 run，父 run 只能来自 SDK/脚本/代理）② 共享前缀重跑（即「成本约 1/4」的出处，**尚未实现**）③ 隔离世界真重跑 ④ 工程与分发（GitHub Actions CI、quickstart、macOS/Linux 打包、协作分享）。

**V3b 的能力与边界**（`openspec/specs/model-experiments/spec.md` + proposal Non-goals）：

| 维度 | 说明 |
|---|---|
| 做什么 | 在**一个**已封存父 run 上创建 N 个 arm，各自用不同 model / 数值 params **真实重跑** |
| 启动上下文 | 父 run 首次 `llm.call.request.messages` 深拷贝；system prompt 与工具表必须与父逐字段一致（含 `sideEffect` 字段的**有无**） |
| 分组 | `experimentId` 标记同批 arm，供 UI 分组与 ComparePanel 默认配对 |
| 失败隔离 | 各 arm 独立 tracer / client / AbortController，单臂失败不影响其他 |
| CLI | `rebaseagent-model-ab`，需 `REBASEAGENT_API_KEY` + `--confirm-cost`，`--dry-run` 离线 |
| **首期限制** | **CLI 只支持空工具表（纯对话任务）**；带工具的父 run 提示改用桌面端 |
| **明确不做** | **不做自动评分、显著性检验、价格表或「最佳模型」推荐**；只展示各臂相对父 run 的累计增量 |

**v2.1 新增 · 三条只有读源码才知道的约束（都会影响 §4.1 的 dogfood 设计）**：

1. **CLI 真实执行还要 `--base-url`**：`model-ab-cli.ts:170-201` 的解析顺序是 `--base-url` > `--config` 模块的 `baseURL`，两者都没有时真实执行直接报配置错误；`apiKey` 只从 `REBASEAGENT_API_KEY` 取，非空即通过。也就是说 CLI 可以指向**任意 OpenAI 兼容端点**（含本机 Ollama 的 `http://127.0.0.1:11434/v1`），key 填任意非空占位串即可。
2. **arm 的 params 只接受数值**：`model-replay-run.ts:63` 类型为 `Record<string, number>`；父 run 录制的 params 也只取数值项（`numericParentParams()`，非数值被**静默丢弃**），"父未录 params 而 arm 给了数值"按全变判定。→ `temperature` / `presence_penalty` / `num_predict` / `num_ctx` 可传，**`think: false`、`stop: [...]` 这类非数值参数传不进去**，且它们不会参与"相对父 run 是否真的变了"的判定。
3. **CLI 与桌面端是两套门禁，对 `tools` 字段要求不同**：
   - CLI（`fork-parent.ts:36-68` + `model-replay-run.ts:311`）：`request.tools` 缺失按空表处理，**能过**；
   - 桌面端（`apps/desktop/src/main/fork-runner.ts:171-174`）：`request.tools` 必须**存在**，缺失直接 `FORK_NO_CONTEXT`。
   - 而 `agent-loop` 自己在空工具表时**不写** `tools` 字段（`run-loop.ts:105` 仅 `tools.length > 0` 才写）→ **手写 JSONL 必须显式写 `tools: []`**，才能两条路都通。

### 1.3 四轮审阅已收敛的技术事实

前序文档 `D:\ReBaseAgent\AniPedia_ReBaseAgent_方案审阅.md`（§11 二审复核 / §12 三审 / §13 / §14 四审 / §15 收敛）已就「AniPedia 如何接入 ReBaseAgent」完成四轮评审：

| 结论 | 出处 |
|---|---|
| AniPedia trace 只能 prompt fork / 模型 A/B（整轮重跑），不能 tool 级分叉 | `apps/desktop/src/main/fork-runner.ts:142-183` |
| **tool-result replay 是架构不可能**（非待办）：要求模型发起 `tool_calls`，AniPedia 模型从未发起 | `packages/replay/src/derive.ts:76-104` |
| `usage.in/out`、`ttft_ms` 必填，缺失在摄取最后一步被拒 | `packages/trace-sdk/src/schema.ts:138-146` |
| `config_hash` 只覆盖 systemPrompt + 工具表（键排序 + 工具按 name 排序 + 无空白） | `packages/agent-loop/src/config-hash.ts:5-23` |
| Zod `z.object()` 默认 **strip（静默丢弃）** 非 strict | `schema.ts` 全文无 `.strict()` |
| 开发态数据目录恒为 `<仓库根>/.rebaseagent` | `apps/desktop/src/main/data-dir.ts:102` |

**v2.1 复核**：上表六条我逐条打开源码对过，**全部成立**，并补两条同级别硬门槛（前四轮已提到，但没进这张收敛表）：

| 补充结论 | 出处 |
|---|---|
| 父 run 必须**已封存**（有终止事件）；`crashed` 永不可分叉 | `fork-parent.ts:44-45` → `trace-sdk/src/guards.ts` |
| span id 必须是 `s_NN`（正则 `/^s_(\d+)$/` 取序号），否则 fork run 从 `s_01` 重计导致 id 冲突 | `packages/replay/src/replay-run.ts:56-67` |
| 桌面端工具 handler 白名单当前**只有 `read_file` / `write_file`** | `fork-runner.ts` HANDLERS |

---

## 2. 核心判断

### 2.1 两个项目不是两个项目

| | AniPedia | ReBaseAgent |
|---|---|---|
| 有 | 3 万条真实数据、40 题评测集、几十个 bad case | fork / 模型 A/B / 卡带重跑、portable 分发 |
| 缺 | 用户 | 真实用例与真实 trace |

### 2.2 交汇点不是 trace 格式，是「可复现对比」

前四轮审阅主要争论「怎么接入 trace 格式」。我的判断是这个争论抓错了重点：trace 只是管道。若接进去之后没有「改前 vs 改后」的闭环，录下来的 trace 就是死数据。

**v2 修正**：V3b 落地后，这个判断的下半段已经被工具侧满足了——「换模型/参数后重跑并并排看」现在是现成能力。剩下的缺口转移到了§3.4 与§4.2。

### 2.3 我两次基于过期信息的判断（已作废，供一审评估）

| 版本 | 判断 | 错误原因 |
|---|---|---|
| 初版 | 「把 v3 提前到 v2」 | 依据 `docs/product/product.md`（09-05），实际 V3a 已于 09-08 完成 |
| v1 稿 | 「V3b 未开始，建议立项」 | 依据 `HANDOFF.md`（09-08），实际 V3b 已于 09-09 完成 |

**教训**：`HANDOFF.md` 与 `docs/product/product.md` 均落后于归档目录与源码。**后续状态判断必须以 `openspec/changes/archive/` 与 `packages/*/src/` 为准。** 此条建议写入 HANDOFF 的工程约定。

**v2.1 补充**：复核当天 `HANDOFF.md` 仍写「archive 10 个 / 主 spec 9 个 / 9/9」（实际 11 / 10 / 10，见 §1.2），说明**它没有随 V3b 归档更新，滞后是持续的而非一次性的**。另外 AniPedia 的 `README.md` 同样滞后于 `src/answer.py`（§1.1）——这不是某个文件的卫生问题，是**两份项目都缺"文档随代码更新"的收口动作**。

**✅ 已落地（2026-09-10，本条已按建议执行）**：该约定已写入 `HANDOFF.md` §五 第 1 条（标为最优先），并顺手校准了该文档自身过期的状态：§一 最新提交 → `79d2fbf`、§二 主 spec 8 → **10** 个 / archive 10 → **11** 个、§三 状态节点补齐 V3a/V3b 与实测 430 测试、§四 新增 model-experiments 决策速查、§六 路线图 V3b 改为 ✅ 并接上 A1–A3/B1 候选。同时在 §五 补了两条环境坑（vitest 必须 cwd=包目录、Bash 缺 coreutils）。

---

## 3. 四个缺口（v2 重排）

### 3.1 代理 run 能力受限 —— 项目已知并公开承认（v1 判断需降级）

README「当前限制」原文：

> 代理录制的 run 没有 `config_hash`，不能作为 prompt fork / tool_result 重跑 / 模型 A/B 的父本，只能走"编辑 messages 重发"

| 接入方式 | V3a 卡带重跑 | V3b 模型 A/B |
|---|---|---|
| 代理（改一行 `base_url`） | 降级静态断言 | 拒绝（父 run 必须非 proxy） |
| SDK 埋点 | 完整 | 完整 |

**v1 判断修正**：我原称之为「结构性裂缝，比任何功能缺失都危险」。读完 README 后降级——项目**已知并主动公开声明**该限制，且 README「快速开始」的主线本就是 SDK 埋点，代理只是补充。**这不是被忽视的裂缝，是一次有意识的取舍。**

**问题因此改变**：不再是「要不要修补」，而是「**这个取舍对不对**」——零摩擦吸引来的用户长期只能享受"录制 + 单请求重发"，是否足以支撑口碑传播？见 §7 问题 1。

**一审补充（2026-09-10，已采纳）**：审阅方把这个取舍重新定义为**漏斗问题**而非功能问题——代理用户是目标用户里的「**轻度用户**」，代理是**体验入口**（先让他看到 trace），SDK 才是**完整能力**。因此**修补方向不是修补代理本身，而是修补叙事 + 引导**：README「当前限制」已说清限制，缺的是在「快速开始」里加一段正向引导（"想体验完整的时间旅行，就在代码里接 SDK"）。此条已列入待办。

### 3.2 V3a 对 prompt 变更是假阴性 —— 已被 V3b 部分补偿

`packages/trace-test/README.md` 原文：卡带冻结模型回答，**「改 prompt 后卡带测试大概率仍然全绿，那是假阴性，不是安全」**。

V3b 补上了「换模型/采样参数后真实重跑」的执行能力，但**只覆盖 model / 数值 params 维度**。`SYSTEM_PROMPT` 的变更仍走既有 prompt fork（属 v2 能力，不是 V3b 新增）。

### 3.3 没有真实应用产生的 trace（最紧迫的缺口）

测试全为 mock 注入、零 API；钩子 demo 未做。

**精度修正**：V3b 已通过真实 A/B 冒烟，但父 run 由 `scripts/create-ab-parent.mjs` **现造**。真正缺的是「**真实应用产出的 trace**」——这正是 AniPedia 能补的。

**v2 关键判断不变**：V3b 已就绪，缺的只是父 run。且 CLI 首期只支持空工具表（纯对话），AniPedia 恰好是纯对话——**这是 V3b 的理想适配场景**。

> **⚠️ 二审降级（2026-09-10，实测）**：「理想适配场景」只对**结构**成立（纯对话、空工具表、单请求），**参数保真度上不成立**：
> V3b 走 OpenAI 兼容 `/v1/chat/completions`，实测 `num_ctx` 被**静默忽略**（发 8192 仍加载 4096）、`think:false` **无效**（思考模式照开，同一问题 completion tokens 432–2160 vs 生产 `eval_count=2`）。
> 后果：dogfood 只能证明「V3b 链路能在真实 trace 上跑通」，**不能用来判断"哪个模型更好"**——否则会把「思考模式 + 上下文窗口差异」误读成「模型差异」。详见 §4.1 二审实测与 `docs/reviews/2026-09-10-direction-2026h2-review-2.md`。

**但接入方式受限**：README 路线图中「原生 run 创建入口」仍是 📋 未做，桌面端不能直接新建 run。AniPedia 是 Python，无法用 TS SDK，只能走**自行写出合法 JSONL**（file-drop）。这也解释了为何四轮审阅花了大力气核对 schema 硬约束。

**v2.1 补充 · file-drop 的落点是确定的**：开发态数据目录恒为 `<仓库根>/.rebaseagent`，traces 在其下 `traces/`（`data-dir.ts:102`，已复核；实测该目录当前有 33 个 jsonl，含 V3b 冒烟产物）。**`REBASEAGENT_TRACES_DIR` 环境变量并未实现**（AniPedia 侧曾误以为有），也没有"dev 目录指针文件"这回事——AniPedia 必须把 JSONL **直接写进** `D:\ReBaseAgent\.rebaseagent\traces\`。

### 3.4 评测集维度缺失（v1 未识别，v2 新增）

V3b 的「一批」= **同一父 run 的多个 arm**，不是多个不同输入。即 `1 题 × N 配置`。

AniPedia 的 40 题 × N 配置 = **40 次独立编排调用**，ExperimentId 分组语义跨调用不生效，ComparePanel 也无法跨父 run 比较。

**这个维度是否值得补，是 §7 的问题 3。**

**一审补充（2026-09-10，部分采纳）**：审阅方同意「先 dogfood 再评估」，但**倾向于认为多题批量编排是 ReBaseAgent 的自然延伸**（批量回归测试），主张 **dogfood 成功后立项**；并给出首期的低成本探针——**先手动跑 40 次**，看需求是否真实存在，再决定建不建编排层。我采纳这个「40 次手工调用当需求探针」的验收方式，但**不提前立项**（与 §5 Non-goals 一致）。

---

## 4. 方案（v2 重写）

### 4.1 第一步：dogfood，而不是立项新功能

建议的第一件事**不是开发**，而是：AniPedia 落合法 trace → 用 `rebaseagent-model-ab` 跑一次真实模型 A/B → 检验 V3b 在真实场景是否成立。

理由：
1. V3b 的真实冒烟用的是**脚本现造**父 run，尚未在**真实应用产出**的 trace 上验证过。先用真实数据验证，比基于假设立项稳妥。
2. 产出可复用：真实 trace + 真实 A/B 结果 = 钩子 demo 的素材，顺带解决 §3.3。
3. ~~拿「1/4 成本」真数字~~ —— **撤回（v1 误判）**：该能力对应路线图中的「共享前缀重跑」，目前仍是 📋 **未实现**，数字无从测起。v1 把它当成「已实现但未实测」是错的。

**二审限定的结论口径**：本次 dogfood 只用来验证「**V3b 链路能否在真实应用产出的 trace 上端到端跑通，并暴露首期参数保真度缺口**」；**「哪个模型更好」的结论不在本次范围内**（原因见下表 F1/F2，参数失真会把模型差异与其他差异混在一起）。

**接入条件**（四轮审阅 + V3b spec 合并）：父 run 已封存、含 `config_hash`、首次 `llm.call` 有字符串 system 消息、`tools: []` 不可省略、`usage` 与 `ttft_ms` 必填、span id 用 `s_NN`、`config_hash` 用 `ensure_ascii=False` 的 canonical JSON 复刻。

**v2.1 补充 · 落点**：手写 JSONL 直接写进 `D:\ReBaseAgent\.rebaseagent\traces\`（§3.3；无环境变量可指，也无指针文件）。

**v2.1 补充 · provider 配置（这条让 dogfood 从"要花钱"变成"零成本"）**：

- **桌面端**：settings 的单一 baseURL/apiKey 指向本地 Ollama 的 OpenAI 兼容端点（`http://127.0.0.1:11434/v1`）即可，与「本地不出机器」卖点一致。
- **CLI**：需显式给 `--base-url http://127.0.0.1:11434/v1`，并设 `REBASEAGENT_API_KEY=<任意非空占位串>`（Ollama 侧不校验 key，只要非空就过门禁）——见 §1.2 新增约束 1。
- **含义**：AniPedia 的 dogfood 全程跑本地模型，**零 token 费用、零数据出境**，且 `--confirm-cost` 的心理门槛不再是成本问题。相对地，V3b 冒烟时用的 deepseek-chat 是**付费 provider**——第一次 dogfood 不必、也不应该走付费路径。

**v2.1 补充 · 手臂设计的硬约束（可能决定 dogfood 成败）**：

| 项 | 能否当 arm 变量 | 说明 |
|---|---|---|
| `model`（如 `qwen3.5:4b` vs `qwen3:1.7b`） | ✅ | 换模型是 V3b 的一等公民 |
| `temperature` / `num_predict` | ✅ | 数值即可，且实测生效 |
| `presence_penalty` | ⚠️ 未定论 | 实测有差异（temp=0 下 pp=0/1.5 → completion 762/432 tokens），但 reasoning 长度本身有波动，未做重复性统计 |
| `num_ctx` | ❌ **实测失效** | 数值可传，但 **OpenAI 兼容路径静默忽略**（发 8192 仍加载 4096）；只有 `/api/generate` 的 `options.num_ctx` 生效 |
| `think: false` | ❌ | 非数值传不了；**且实测在 `/v1` 路径即使传了也无效**（思考照开） |
| SYSTEM_PROMPT | ❌ | 属 prompt fork（v2 能力），不是 V3b 的 arm |

**二审实测（2026-09-10，本机 Ollama，零费用）**：

```text
卸载后概览                      → 实例数=0
/v1/chat/completions 顶层 num_ctx=8192  → ["qwen3.5:4b@4096"]   ← 未采纳（HTTP 200，无警告）
/api/generate options.num_ctx=2048      → ["qwen3.5:4b@2048"]   ← 采纳
判据：/api/ps 的 context_length（实例实际加载的窗口）

同一问题「1+1」：
  /api/generate + think:false → eval_count=2，response="2"（零思考）
  /v1（默认）                 → completion_tokens=207，message.reasoning 1849 字符
  /v1 + max_tokens=32         → content=""（正文为空，token 全被思考吃掉；三轮复现三次）
```

**两个附带事实**：① Ollama `/v1` 的思维链字段名是 `reasoning`，而 `agent-loop`（`llm-client.ts:195`）只读 `reasoning_content` → **COT 被丢弃**（trace 仍合法，但它的 token 照样计入 `usage.out`）；② **`usage` 其实由 provider 直接返回**（流式也带），不需要自造——"换算/近似"只发生在 AniPedia 手写的父 trace 上（`prompt_eval_count` / `eval_count`）。

**⚠️ 冒烟为何没发现这两条**：V3b 冒烟的父 run 由 `create-ab-parent.mjs` 现造，prompt 只有 **21 token**，根本碰不到上下文窗口边界，思考开销也不影响"能跑通"这个结论——**冒烟全绿掩盖了参数保真度问题**。

→ 因此 **AniPedia 的 `think:false` 无法经 V3b 表达**：如果实验臂依赖它来关掉思维链，跑出来的回答可能与线上形态不一致（编造引用 / 思维链混进正文），而这恰好是 AniPedia 最敏感的失败模式。可选规避：① 用不带思考的模型名；② 只在父 run 与所有 arm 上都不依赖该开关；③ 承认这是 V3b 首期的表达力缺口，先只跑**换模型**这一维。这条已进 §7 问题 7。

### 4.2 Auto-Judge 归属：应用层，不是 ReBaseAgent（v1 判断已撤回）

v1 我主张 Auto-Judge 是「ReBaseAgent 唯一的 AI 原生能力」。**V3b 的 Non-goals 明确写了「不做自动评分、显著性检验、价格表或『最佳模型』推荐」，spec 用 SHALL NOT 表述。这是有意的设计决策，我撤回原主张。**

修正后的判断：

- **ReBaseAgent 应保持价值中立**。它是工具层：负责执行、展示、陈述事实（累计增量、tokens、duration、工具轨迹）。让工具替用户宣布「哪个模型更好」，既不严谨也越界。
- **判分属于应用层**，判分标准高度依赖领域（番剧问答的「好」与代码生成的「好」完全不同，无法通用）。
- 因此 **Auto-Judge 应落在 AniPedia 侧**（它本就有 LLM-as-judge 经验），ReBaseAgent 不需要为它改一行。

### 4.3 AI 原生自检 —— 两处自我修正

「离开 AI 还成立吗？」答案：ReBaseAgent 现有能力离开 AI **全部成立**——trace 可视化 ≈ Fiddler/Wireshark；分支树 ≈ git；卡带重跑 ≈ VCR；模型 A/B ≈ 参数化 benchmark runner。

**修正一：「Postman 类比」不是我的发现。** `MEMORY.md`「普及性判断」早已写明「天花板 = Agent 开发者 niche 内的品类标准（类比 Postman）」。v1 把它当新洞察提出，实为重复既有判断。

**修正二：「别宣称 AI 原生」是打空靶。** README 叙事本就是「Agent 的时间旅行调试器 / 给上下文这门语言的调试器」，从未宣称 AI 原生，该建议无的放矢。

**真正存在且悬而未决的张力**（项目内部已有记载）：`MEMORY.md` 记录 2026-09-04 探讨过平台化跃迁，用户当时说「**调试器太狭隘**」，最终未采纳、维持 v2/v3 路线。

**我的判断**：维持调试器路线是对的（护城河具体、可交付），但「调试器太狭隘」这个疑虑不会自行消失——它会在 V3a/V3b 完成、功能无处可加时重新浮出。**建议在 V3b dogfood 之后、立项下一个大功能之前，正面重开一次定位讨论**，而非继续沿路线图下推。这条已并入 §7 问题 4。

### 4.4 AniPedia 侧配合

- **Phase A 工程债**（零争议，建议先做）：`server.py` 4 处 `DATA_PATH.read_text()` 无缓存；`api.ts:99` SSE error 被紧邻 `catch {}` 吞掉；`server.py:88` health 恒 ok；`data/anime_seed.json` 不存在但 README:56 仍描述（死代码，需决策去留）
- **v2.1 新增 · 落 trace 的规范化**：Ollama 走 `/api/generate`（独立 `system` / `prompt`）→ 必须转成 `messages[]`；`usage` 与 `ttft_ms` 从 Ollama 响应取（`prompt_eval_count` / `eval_count` / 首 token 时间），**缺失会在摄取最后一步被拒**；`num_predict` 已是 768（方案文档写的 512 已过时）
- **40 题套件标准化**：从一次性验收升级为回归套件（分层判分 + 版本快照 + 每次出分）
- **Auto-Judge 落在此侧**（§4.2）
- **不做**：多步 agent（已被代码证伪）；P3 LoRA 提前（顺序仍是「评测 → 工程 → 换模型 → 最后微调」，且效果必须用回归套件证明）

---

## 5. ReBaseAgent 侧 Non-goals

- 为 V3b 增加自动评分（违反既有 SHALL NOT，且属应用层职责）
- 继续堆 v2 功能深度
- 一键导入（LangSmith 导出 / 框架转换）——无真实用例前导入也是死数据
- 平台化 / agent 构建器（`product.md` §11 已否）

---

## 6. 里程碑（v2，v2.1 微调第 2–3 步）

```text
1. AniPedia Phase A 工程债 + 40 题套件标准化
2. AniPedia 落合法 trace：写进 D:\ReBaseAgent\.rebaseagent\traces\（满足 §4.1 接入条件）
   验收口径：先用 --dry-run 跑通（免密钥、不联网、不写文件），能出计划才算落 trace 成功
3. dogfood：rebaseagent-model-ab 指向 Ollama 本地端点跑真实 A/B（零费用）
   → 产出①链路跑通证据 ②真数字（**口径限定：只证明链路成立，不证明模型优劣**，见 §4.1 二审实测）
     ③钩子 demo 素材 ④参数保真度缺口清单（`num_ctx`/`think` 已由二审实测证实失效）
4. 评估：是否需要多题批量编排层（§3.4）
5. AniPedia 侧 Auto-Judge
6. 桌面并排视图收尾 + GitHub Actions 挂 CI
```

第 1–3 步零新功能开发，且**不依赖 ReBaseAgent 任何改动**。

**v2.1 微调说明**：第 2 步加了「`--dry-run` 先跑通」作为验收口径（否则会把"trace 不合法"和"provider 不通"两类失败混在一起）；第 3 步明确走**本地 Ollama 而非付费 provider**（§4.1），并把「验证三个卡点」写进产出——dogfood 的价值一半在拿数字，一半在暴露首期表达力缺口。

**一审结论（2026-09-10）**：排序**合理，可以立即开始**（第 1–3 步零新功能开发、不依赖 ReBaseAgent 任何改动）。另有一条**并列的待办**不在本里程碑内：README 快速开始加「代理→SDK」引导段（§3.1 一审补充）。

**📄 已细化成可执行方案（v0.2）**：`docs/engineering/plans/2026-09-10-dogfood-plan.md`（P0–P4 阶段、契约清单、验收判据、止损条件）；AniPedia 侧前置实测 `docs/collab/anipedia/2026-09-10-anipedia-dogfood-precheck.md`；回信 `docs/collab/anipedia/2026-09-10-reply-to-anipedia.md`。
核心结论：**首期零 ReBaseAgent 改动**，但需**先挂参数补丁 shim**（`reasoning_effort:"none"`，否则臂的正文为空）+ `num_ctx` 用**派生模型**绕开。**原「接受思考模式失真」的判断已被 AniPedia 侧真实 prompt 实测推翻**（不是"形态不同"，是"零信息"）。

---

## 7. 请一审重点回答的问题

> **一审已于 2026-09-10 逐条答复完毕**（全文见 `docs/reviews/2026-09-10-direction-2026h2-review.md`）。摘要：
> ①**是问题，但属漏斗问题**——代理是体验入口，修补叙事+引导而非修补代理；②Auto-Judge 归应用层**成立，无更好切法**；
> ③多题批量**值得补但非现在**，先手动跑 40 次当需求探针；④定位张力在 **dogfood 之后、下一个大功能立项之前**重开；
> ⑤里程碑排序**合理，可立即开始**；⑥三处卡点**均非 blocker**（`think:false` 先绕开／`ttft_ms`·`usage` 属合理近似／`tools: []` 不污染结论）；⑦**未发现其他 blocker**。
> 下方原问题保留，作为审阅记录的上下文。

1. **§3.1 的倒挂是否真的是问题？** 代理用户是否本就不是目标用户（只是"顺便被录到"）？若是，产品叙事该怎么改？若否，修补方向是什么？
2. **§4.2 的 Auto-Judge 归属判断是否成立？** 判分放应用层、工具层保持中立，这个切分对吗？有没有更好的切法？
3. **§3.4 的评测集维度是否值得补？** 40 次独立 CLI 调用 vs 新增批量编排层，哪个更合适？还是说多题批量本就不该由 ReBaseAgent 承担？
4. **定位张力何时重开？** `MEMORY.md` 记载用户曾认为「调试器太狭隘」（2026-09-04 平台化探讨，未采纳）。V3a/V3b 已完成后，是否该在下一个大功能立项前正面重开定位讨论？还是继续按路线图推进？
5. **§6 的里程碑排序是否合理？** 特别是「先 dogfood 再评估」——有没有应该并行或前置的？
6. **（v2.1 改写）dogfood 的三个具体卡点，哪个需要提前决策？** 原问题太泛，换成读源码后锁定的三处：
   ① `think: false` 这类**非数值参数**无法作为 arm 变量（§4.1 表），AniPedia 又高度依赖它——是先绕开（只跑换模型），还是认为这是 V3b 该补的表达力缺口？
   ② `ttft_ms` 与 `usage` 必填，但 AniPedia 走 Ollama `/api/generate`，这两项要**自己造**（首 token 时间、prompt/eval token 数）。造出来的数字进 trace 算不算"伪造事实"？还是接受它是本地 provider 的合理近似？
   ③ CLI 的 `tools` 字段缺失能过、桌面端不能（§1.2 约束 3），而 agent-loop 自己也不写——手写 `tools: []` 会不会让这条 trace 与"SDK 正常产出"的 trace 形状不一致，从而污染后续所有结论？
   ④ **（二审新增，实测背书）dogfood 前必须拍板**：`num_ctx` 与 `think:false` 在 V3b 的 OpenAI 兼容路径下**静默失效**（§4.1 二审实测）。是接受失真、把 dogfood 结论限定为「链路跑通」，还是先给 V3b 加一个「provider 原生参数逃生舱」（如允许 arm 声明一段透传给 provider 的原始 options）再跑？
7. **（v2.1 新增）有没有我完全没看到的 blocker？** 特别是会阻止 §6 第 2–3 步落地的既有设计决策。上面三个是我能看到的，看不到的才是风险。

---

## 8. 已识别风险

| 风险 | 说明 |
|---|---|
| 我的信息可靠性 | 已多次基于不完整信息误判（§2.3 两次 + §4.3 两处自我修正）。**权威信息源排序**：`MEMORY.md` > `README.md` > 归档目录 / 源码 > `HANDOFF.md` > `docs/product/product.md`。一审应抽查 |
| **文档滞后是持续的，不是一次性的**（v2.1 加强） | `HANDOFF.md` 在 V3b 归档后仍未更新（10/9/9 vs 实际 11/10/10）；AniPedia `README.md` 也落后于 `answer.py`。两份项目都缺"文档随代码收口"的动作 → 未来仍会有基于过期文档的误判 |
| V3b 未在真实应用 trace 上验证 | 现造父 run 与真实数据可能有结构性差异，dogfood 才见分晓 |
| AniPedia 只能 file-drop 接入 | 「原生 run 创建入口」未做，且 AniPedia 是 Python 无法用 TS SDK → 必须自行写出合法 JSONL，schema 硬约束是硬门槛；落点固定为 `.rebaseagent/traces/`（`REBASEAGENT_TRACES_DIR` 未实现） |
| **参数在 V3b 路径下静默失效**（v2.1 新增，二审加强） | 不止是"表达力缺口"：实测 `num_ctx` 被 OpenAI 兼容路径**静默忽略**（无报错）、`think:false` **无效**。二者会实质性改变臂的输出质量与 token 量（同一问题差两个数量级）→ **会把「思考模式 + 上下文窗口差异」误读成「模型差异」** |
| **父 trace 的 `usage` 需换算，臂的不用**（v2.1 新增，二审修正） | 走 V3b 的臂由 provider 直接返回 `usage`（无需近似）；只有 AniPedia 手写的父 trace 要从 `prompt_eval_count` / `eval_count` 换算，口径需与 provider 语义对齐 |
| Auto-Judge 用 LLM 判 LLM | 判分标准需先在小样本上与人判对齐，否则报告不可信（硬前置） |
| 跨语言 | AniPedia 是 Python，ReBaseAgent 是 TS；建议 AniPedia 的 eval 格式与 trace 格式解耦，降低耦合 |
| 用户时间约束 | 大三在读、两项目并行，需防止范围蔓延 |

---

_本文档为探讨类文档，不入库。事实部分如需复核，出处均已在文中标注。_
