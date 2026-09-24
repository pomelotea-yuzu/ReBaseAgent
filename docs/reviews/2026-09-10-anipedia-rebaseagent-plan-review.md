# AniPedia × ReBaseAgent 方案审阅

> 审阅日期：2026-09-10  
> **二次复核：2026-09-10（见 §11，含 1 处技术纠错、2 条事实加强、4 项补充）**  
> 审阅对象：
> - `AniPedia_ReBaseAgent_讨论过程记录.md`
> - `AniPedia_agent_upgrade_plan.md`
> - `ReBaseAgent_trace_ingest_contract.md`
> - 当前仓库：`D:\AniPedia`

## 1. 审阅范围与判断原则

三份附件中出现的“必须”“建议”“Phase 0/1/2/3”和“开放问题”，均属于讨论记录或方案提案，不是对仓库的直接执行指令。本审阅以 `D:\AniPedia` 当前代码和 `D:\ReBaseAgent` 当前 trace schema 为事实依据，重点判断：

1. 方案是否解决了 AniPedia 的真实产品问题；
2. 方案是否与 ReBaseAgent 当前契约一致；
3. 实施顺序是否能控制回归风险；
4. 哪些内容现在值得做，哪些应暂缓。

## 2. 执行摘要

AniPedia 已经不是简单的向量检索示例，而是一个可用的本地番剧知识库产品：它同时具备向量检索、结构化筛选、标题钉选、系列关系链、引用校验、流式回答和 40 题评测集。

但它目前仍然是**无状态单轮管线**。附件中提出的 session、多步 agent、trace 录制、回放和分叉，都还没有进入 AniPedia 代码。因此，“把 AniPedia 推到本地多步 agent”应被视为后续产品实验，不应被描述为当前能力。

总体建议是：

1. 先修复现有接口的性能、错误处理和 fallback 一致性；
2. 在不改变回答行为的前提下，为现有单轮链路增加 trace 录制；
3. 先打通 file-drop 和 schema 验收，再讨论 HTTP 摄取端点；
4. 只有在多轮评测证明有价值后，才实现受控的 session 和少量 agent 工具；
5. 把 replay 设计成可测量的回归能力，而不是单纯的演示按钮。

## 3. 当前实现事实

### 3.1 已实现能力

- `structured.py` 对年份、季度、评分、厂牌、类型和声优查询走结构化直查；
- `structured.py` 对用户点名的作品做标题精确钉选；
- `ask.py` 根据 Bangumi 关系边构建系列链并按播出时间排序；
- `answer.py` 通过固定 system prompt、编号资料块和引用校验约束模型输出；
- `server.py` 提供 `/api/ask`、`/api/ask/stream`、`/api/search`、番剧筛选和模型列表接口；
- `eval_rag.py` 提供 40 题、8 类单轮评测。

评测结果中的“29/29 自动判分、40/40 引用校验”不能等价解释为 40 题全部正确：剧情和推荐共 11 题没有自动正确性判定，仍依赖人工审阅。

### 3.2 尚未实现能力

代码中没有发现：

- `ANIPEDIA_TRACE` 开关或 trace writer；
- `run.meta`、`agent.step`、`tool.invoke`、`llm.call` 的生成逻辑；
- `session_id`、后端会话存储或历史摘要；
- 意图路由和 agent 循环；
- `config_hash` 计算和 replay 父本校验；
- ReBaseAgent 摄取 API 对接。

前端虽然保存了 `messages`，但只是 React 进程内状态，并不会发送给后端；刷新窗口后历史即丢失，也不能形成真正的多轮上下文。

## 4. 主要审阅发现

以下问题按优先级排序。

### P0：方案依赖的 trace 基础尚未落地

多步 agent 方案的价值依赖 trace 可查看、可回放、可分叉，但当前 AniPedia 没有任何 trace 输出。若直接实现 agent 循环，后续无法判断是检索、路由、工具还是生成导致质量下降。

**结论：** Phase 1 单轮埋点应当先于 Phase 2 agent 化，并作为硬门槛，而不是并行的“可选工作”。

### P0：番剧数据接口重复解析 186 MB JSON

`/api/animes`、`/api/tags`、`/api/studios` 和 `/api/filter` 每次请求都会重新读取并解析 `data/anime_data.json`。当前文件约 186 MB，而侧栏会在初始化和筛选条件变化时反复调用 `/api/filter`。

这会带来：

- 首次请求和筛选响应延迟高；
- 多个请求同时到达时产生重复内存峰值；
- 筛选体验受 CPU 和磁盘吞吐限制。

`structured.py` 已经有进程内 `_load()` 缓存，应统一复用，进一步可将筛选索引预构建为 SQLite 或轻量 JSON 索引。

### P1：流式错误在前端被吞掉

`app/src/renderer/src/api.ts` 在解析 SSE 时遇到 `type: "error"` 会抛出异常，但该异常立即被同一层 `catch` 捕获并忽略。因此 Ollama 不可用、模型不存在或生成超时时，前端可能只显示空答案或半截答案。

这是用户可见的错误处理缺陷，应在 agent 化之前修复，否则后续工具错误也很难诊断。

### P1：fallback 约定与实现不一致

`common.py` 定义了 `DATA_FALLBACK`，README 也说明缺少主数据时可使用 seed 数据；但 `structured.py` 只读取 `DATA_PATH`，`server.py` 的多个接口也直接访问主数据文件。

结果是：向量路径可能能回退，结构化路径和番剧库接口却会失败。应在一个公共数据加载函数中统一处理主数据、fallback 和错误提示。

### P1：当前 Ollama 请求格式与 trace 回放格式不一致

AniPedia 现在调用 Ollama `/api/generate`，使用独立的 `system` 和 `prompt` 字段；trace schema 要求 `llm.call.request.messages` 是可直接回放的完整消息数组。

接入时必须明确规范化规则，例如：

```text
messages = [
  {role: "system", content: SYSTEM_PROMPT},
  {role: "user", content: prompt}
]
```

同时保留模型、采样参数和实际 prompt。仅记录最终答案或只记录 prompt 摘要，都不足以支持可靠 replay。

### P1：trace 契约内部存在“开放 kind”与现有 schema 的冲突

摄取契约提出未知 `span.kind` 应被读取器忽略，但当前 `schema.ts` 的 `SpanSchema` 是只接受 `agent.step`、`llm.call`、`tool.invoke` 的 discriminated union。`retrieve`、`embed` 等新 kind 会被 schema 判为非法。

这是必须先解决的契约问题：

- 要么 v1 明确只允许三种 kind，AniPedia 将检索信息放入 `tool.invoke.tool`；
- 要么修改 schema 和读取器，真正支持未知 kind 的兼容策略，并定义 UI 如何展示。

在这个问题解决前，不建议 AniPedia 自行输出扩展 kind。

### P1：`config_hash` 的建议口径不足以证明可回放等价

方案建议使用 `sha256(SYSTEM_PROMPT + 工具表)`。这只能证明部分配置相同，不能覆盖：

- 模型名和模型版本；
- 温度、上下文窗口和最大输出长度；
- 检索阈值、top-k、去重和排序规则；
- 数据集版本、Chroma 索引版本和嵌入模型版本。

建议把配置分层：`config_hash` 记录运行配置，另记录 `model_fingerprint`、`retriever_fingerprint` 和 `dataset_fingerprint`。若暂时只保留一个 hash，至少要把上述内容规范化序列化后纳入计算。

### P2：健康检查返回值语义不准确

Ollama 不可用时 `/api/health` 仍返回 `ok: true`。这会让调用方无法区分“后端在线但模型离线”和“完整问答能力可用”。建议拆分为 `api`、`ollama`、`data` 三个状态字段。

### P2：引用校验只能发现编号和标题问题

`verify_citations` 能发现超范围编号、无标题资料块和部分标题串台，但不能证明回答中的事实确实由资料支持。标题前六字匹配还可能产生误报或漏报。

这适合作为警告和调试信号，不应在产品文案中称为“事实正确性验证”。后续可增加字段级断言或评测器，但不应在第一阶段阻塞回答。

## 5. 对 Trace 摄取契约的审阅

### 5.1 保留 file-drop 是合理的

ReBaseAgent 仍处于开发期，file-drop 作为最低依赖、可人工检查、容易恢复的兜底接口是合理选择。HTTP 摄取端点可以作为便利层，但不应成为 AniPedia 接入的前置条件。

### 5.2 HTTP 端点暂不应成为 Phase 0 的阻塞项

HTTP 端点涉及版本协商、幂等 append、部分 run、权限和 UI 事件通知。对当前单用户本地工具而言，先完成稳定的 JSONL 文件落盘和目录发现，收益更高、风险更低。

### 5.3 `app` 命名空间需要先改 schema

契约建议在 `run.meta` 增加 `app` 和 `app_version`，但当前 `RunMetaSchema` 是 `z.object` 且未声明这两个字段。若不改为 passthrough 或显式增加字段，生产者写入的这些字段**不会生效**（详见 §11.2 的技术纠错：Zod 默认行为是静默丢弃，不是报错）。该变更应通过 OpenSpec 和版本策略落地，不应由 AniPedia 私自假设。

### 5.4 目录发现必须有可测试的优先级

建议固定为：

1. `REBASEAGENT_TRACES_DIR`；
2. `.rebaseagent/data-dir.json`；
3. 明确的 dev fallback，并输出告警；
4. 若最终目录不可确定，写入本地 staging 目录并报告错误，不要静默丢弃 trace。

## 6. 对多步 Agent 方案的审阅

“右上角甜区”可以作为产品定位语言，但不能单独作为工程决策依据。多轮 agent 是否值得做，需要至少回答三个问题：

1. 用户是否真的会进行迭代推荐、系列补番和多跳查询；
2. 多轮是否比单轮结构化查询明显提高任务完成率；
3. 新增的路由、状态和模型调用成本是否可接受。

当前方案最大的逻辑风险是：为了让 ReBaseAgent 有更丰富的 trace，反过来让 AniPedia 承担多步 agent 复杂度。更稳妥的做法是保持单轮路径不变，先用真实 trace 验证 ReBaseAgent 的价值，再针对有证据的场景增加多轮能力。

## 7. 建议的实施顺序

### Phase A：稳定现有单轮产品

- 统一数据加载和 fallback；
- 修复 `/api/filter` 等接口的重复解析；
- 修复 SSE 错误传播；
- 改进 health 状态字段；
- 保留当前单轮评测结果作为基线。

验收：现有 40 题结果不下降；结构化筛选和流式错误均有可重复测试。

### Phase B：单轮 trace 录制

在现有链路外包一层 recorder，不修改检索和生成逻辑：

```text
run.meta
  agent.step
    tool.invoke: retrieve_smart
    llm.call
    tool.invoke: verify_citations
run.event
```

使用 `ANIPEDIA_TRACE=1` 控制开关，默认关闭；写盘采用临时文件加原子 rename，避免 ReBaseAgent 读到半行 JSON。

**二次复核补充：** 本阶段开工前应额外产出两份前置交付物，否则录出来的 trace 在 ReBaseAgent 里可读性无保障：
- **字段字典**：AniPedia 内部字段 → span 字段的映射表（`tool.invoke.args` / `result` 各记什么、prompt 是否进 `llm.call.request.messages`、引用校验结果落在哪个 span）；必须包含 §13.2–13.4 的三条硬约束（`request.tools: []`、`messages[0]` 为 system 字符串、span id 用 `s_NN`、`config_hash` 逐字节复刻 TS 实现）；
- **裁剪与留存策略**：默认只录元信息 + prompt 哈希 + 引用标题，完整 prompt 与资料块按需开启（理由见 §11.3 第 2 条）。

验收：一轮请求生成合法 JSONL；失败请求仍有终止事件或可识别的崩溃状态；关闭开关时回答结果逐字一致。

### Phase C：ReBaseAgent 摄取验收

- 先用 file-drop；
- **不必等待 HTTP 端点**：开发模式下 ReBaseAgent 的数据目录固定为 `<仓库根>/.rebaseagent`、trace 目录为 `<仓库根>/.rebaseagent/traces`（见 `apps/desktop/src/main/data-dir.ts:102`），AniPedia 直接写入即可跑通 dogfood 闭环（§11.3 第 3 条）。注意：`REBASEAGENT_TRACES_DIR` 目前仅为契约提案，ReBaseAgent 代码尚未读取该变量；
- 验证目录发现、schema 校验、未知字段策略和 run 列表刷新；
- 明确 `config_hash`、模型指纹和检索指纹的口径；
- 暂缓 HTTP，直到 file-drop 在实际开发流程中证明不够用。

### Phase D：最小 session 能力

**二次复核补充：** 本阶段应作为**可证伪实验**执行：先建 10–15 题多轮评测集（迭代推荐 / 多跳人物查询 / 系列顺序 / 对比），baseline 取「单轮 + 人工拼接上下文」，只有多轮任务完成率明显高于 baseline 才进入 Phase E。前置改造项：前端必须把历史 messages 回传后端（当前 `/api/ask` 请求体只有 `question` / `model`），否则 session 做了也接不到数据。

增加可选 `session_id`，保持旧 API 兼容：

- 没有 `session_id` 时继续单轮旧路径；
- 有 `session_id` 时保存最近几轮的实体、筛选条件和引用；
- 不把完整历史无限塞进 `num_ctx`；
- 先使用内存存储，持久化另行评估。

### Phase E：受控多步工具调用

只开放已有且可验证的工具：`retrieve_smart`、`query`、`build_series_chain`、`verify_citations`。路由优先使用规则和显式状态，设置最大迭代次数、token 预算和超时；工具失败记录为数据，不让整个 trace 消失。

验收：新增多轮评测集，至少覆盖迭代推荐、多跳人物查询、系列顺序和对比问题；单轮 40 题不能回归。

### Phase F：Replay / Trace-as-Test

把评测样本录为 cassette，支持只重跑指定 `llm.call` 或指定下游步骤。比较结果时同时展示：答案、引用、工具参数、配置指纹和耗时；不能只比较最终文本。

## 8. 明确的非目标

当前阶段不建议：

- 把 AniPedia 改造成通用聊天机器人；
- 为了 agent 叙事引入大量自主工具；
- 在 trace 契约未锁定前硬编码内部路径；
- 把引用警告包装成事实正确性证明；
- 以“多轮”作为产品升级完成的唯一标准。

## 9. 最终审阅结论

方案方向有价值，但实施顺序需要调整：**先稳定单轮产品，再做单轮 trace，再验证摄取和 replay，最后才做受控多轮 agent。**

AniPedia 最有说服力的 ReBaseAgent 参考价值，不是“它拥有一个 agent 循环”，而是：它有真实数据、真实检索分支、真实引用错误和可复现的模型输出，能够让开发者在本地 trace 上定位问题、分叉修改并回归验证。

在上述 P0/P1 问题修复、trace 契约冲突解决、以及多轮评测集建立之前，不建议把 AniPedia 对外描述为“ReBaseAgent 的多步 agent 参考应用”；更准确的称呼是“具备结构化 RAG 能力、计划接入 ReBaseAgent trace 的本地番剧知识库”。

## 10. 已执行的静态验证

- `D:\AniPedia\app`：`npm.cmd run typecheck` 通过；
- `D:\AniPedia\src`：使用项目自带 Python 3.13 执行 `compileall` 通过；
- 未启动 Ollama 做端到端模型和 SSE 实测，因此模型超时、断线和真实延迟仍需在运行环境中验证。

---

## 11. 二次复核意见（2026-09-10）

> 本节是对本文档前 10 节的**再审阅**。复核方式是不采信本文与契约文档的既有结论，回到代码逐条验证：
> AniPedia `src/server.py`、`src/common.py`、`src/answer.py`、`app/src/renderer/src/api.ts`、`data/` 目录；
> ReBaseAgent `packages/trace-sdk/src/schema.ts`。

### 11.1 复核结论：判断成立的部分

| 本文论断 | 复核结果 | 代码证据 |
|---|---|---|
| P0 番剧接口重复解析大 JSON | 成立，且比原文描述更广 | `server.py` 共 **4 处** `DATA_PATH.read_text()`（`/api/animes`、`/api/tags`、`/api/studios`、`/api/filter`），每次全量解析 3 万条；`structured.py` 已有 `_load()` 进程内缓存但未复用 |
| P1 流式错误在前端被吞掉 | 成立 | `api.ts:99` 遇 `type === "error"` 时 `throw new Error(...)`，**紧邻的** `catch { }` 立即吞掉，注释为「跳过无法解析的事件」 |
| P1 Ollama 请求格式与回放格式不一致 | 成立 | `answer.py` 调用 `/api/generate`，使用独立 `system` / `prompt` 字段；schema 要求 `llm.call.request.messages` 为完整消息数组 |
| P1 span.kind 为封闭枚举 | 成立 | `schema.ts:165` `SpanSchema = z.discriminatedUnion("kind", [agent.step, llm.call, tool.invoke])` |
| P2 health 返回值语义不准确 | 成立 | `server.py:88` Ollama 不可用时仍返回 `{"ok": true, "ollama": null}` |
| 前端消息历史不回传后端 | 成立 | 前端 `messages` 仅为 React 进程内状态；`/api/ask` 请求体只有 `question` / `model` |

### 11.2 技术纠错：Zod 默认行为是 strip，不是 strict

§5.3 原文（承袭契约文档 3.4 节）称「当前 Zod 对象默认是严格模式，生产者写入这些字段会被拒绝」。**该表述不准确。**

- Zod 的 `z.object()` 默认行为是 **strip**：解析时**静默丢弃**未声明字段，不抛错。只有显式 `.strict()` 才会拒绝。
- 经检索，`schema.ts` 全文无 `.strict()`。

因此真实后果不是「写入被拒、立刻暴露」，而是 **`app` / `app_version` 被静默丢弃、UI 永远过滤不出来**——比报错更隐蔽。修正措施不变（显式增加字段，或改为 `.passthrough()`），但论证与风险描述需按此更正，§5.3 已同步修改。

### 11.3 四项补充（本文未覆盖）

**1. 应补上「单轮就够用」的正向论证。**
本文正确否掉了「为了 ReBaseAgent 才做多轮」的因果，但没有给出替代论证，导致多轮之争容易反复。事实上单轮管线 `retrieve → build_prompt → llm.call → verify` 已经提供 **3 个天然 fork 点**：

- 换检索参数（top-k / 阈值 / 直查规则）重跑 → 比较召回差异；
- 改 `SYSTEM_PROMPT` 只重跑 `llm.call` → 比较答案与引用；
- 只重跑 `verify_citations` → 比较引用校验结论。

time-travel 的价值来自「可重放的下游子图」，**不来自轮数**。这条补上后，Phase D/E 才能从立场之争变成可证伪实验。

**2. Phase B 缺前置交付物：字段字典 + 裁剪留存。**
直接开录，产出的 span 在 ReBaseAgent 里大概率读不懂。应在埋点前先定死「AniPedia 内部字段 → span 字段」映射表。同时必须定裁剪策略：单轮 prompt 实测约 4000 token，40 题评测全量录制即数十 MB JSONL，且含 Bangumi 资料块全文。建议默认只录元信息 + prompt 哈希 + 引用标题，全文按需开启。此条已写入 §7 Phase B。

**3. Phase C 有比 HTTP 端点低一个数量级的捷径（并附一条实现现状更正）。**
本文建议「暂缓 HTTP、先 file-drop」方向正确，但未给落地路径。实现现状（`apps/desktop/src/main/data-dir.ts`）：开发模式下数据目录恒为 `<仓库根>/.rebaseagent`，trace 目录为 `<仓库根>/.rebaseagent/traces`——`resolveDataDir` 在未打包分支直接返回该路径，且不写任何指针文件。因此 AniPedia 只需把 JSONL 写进 `D:\ReBaseAgent\.rebaseagent\traces`，配合 dev 端手动刷新即可跑通完整 dogfood 闭环，无需等待 ReBaseAgent 任何改动。

**更正（同时是对契约文档 3.1 的纠错）：** 契约提出的 `REBASEAGENT_TRACES_DIR` 环境变量与 `.rebaseagent/data-dir.json` 指针，**当前 ReBaseAgent 代码均未实现**。现有的 `data-dir.json` 是**打包态**写在 exe 旁、键名为 `dataDir` 的指针文件（`data-dir.ts:117-124`、`saveDataDirPointer`），与契约描述的位置（`.rebaseagent/` 下）和语义都不同；开发态根本不生成该文件。因此 Phase C 落地时不能假设这两条发现机制已存在——这也意味着契约 3.1 的「目录发现」章节需要按真实实现重写，或作为 ReBaseAgent 的新增需求单独提出。此条已写入 §7 Phase C。

**4.（补充）Phase D 的前置改造项被漏列为实施步骤。**
§3.2 已指出前端不回传历史，但未将其列为 Phase D 的前置项。实施时极易遗漏：session 与意图路由都做了，却仍拿不到历史数据。此条已写入 §7 Phase D。

### 11.4 两条事实需要加强（比本文描述更严重）

- **`DATA_FALLBACK` 不是「约定不一致」，而是死代码。** `data/` 目录下当前**只有 `anime_data.json` 一个文件**，`anime_seed.json` 不存在，而 README 第 56 行仍在描述它。即：回退路径从未生效过，属文档与实现的双重漂移。Phase A 需先决策「是否保留 seed 回退」，而非仅统一加载函数。
- **生成参数已与方案文档不同步。** 方案文档写 `num_predict=512`，代码实际为 **768**（`answer.py:32`，系列题截断后调整）。这恰好是「config_hash 口径不足」（§4 P1）最直接的证据：连文档与代码都不同步的参数若不进指纹，replay 出的答案会截断，却被误判为模型退步。

### 11.5 修订后的实施顺序

在本文 §7 的 A–F 基础上，仅 B / C / D 三处补充，其余不变：

| 阶段 | 相对本文的变化 |
|---|---|
| A 稳定单轮产品 | 不变；增加「决策 seed 回退去留」 |
| B 单轮 trace 录制 | **+** 字段字典、裁剪留存策略 |
| C 摄取验收 | **+** 环境变量直写 dev 目录，不等待 HTTP |
| D 最小 session | **+** 前端回传历史作为前置；改为可证伪实验（多轮评测集 vs 单轮拼接 baseline） |
| E 受控多步工具 | 不变；仅当 D 证明多轮更优才执行 |
| F Replay / Trace-as-Test | 不变 |

### 11.6 复核后的最终结论

本文的主体判断——**先稳定单轮、再单轮埋点、再验证摄取与 replay、最后才做受控多轮 agent**——经代码复核成立，可作为实施基线。

需一并采纳的修正是：§5.3 的技术性错误（strip 而非 strict）、§11.4 的两条事实加强、§11.3 的四项补充。其中第 1 项（单轮已有 3 个 fork 点）建议补入正文，否则「要不要做多轮」将持续停留在立场层面。

对外文案约束维持本文 §9 不变：在契约冲突解决与多轮评测建立之前，AniPedia 应描述为「具备结构化 RAG 能力、计划接入 ReBaseAgent trace 的本地番剧知识库」，不得称为「ReBaseAgent 的多步 agent 参考应用」。

---

## 12. 三次复核意见（2026-09-10）

> 本节是对二次复核结论的独立核验。核验重点是：二审是否把“契约提案”“当前实现”和“未来能力”混在了一起，以及新增建议是否真的能被现有 ReBaseAgent 执行。

### 12.1 P0：契约对“非法行不中断 run”的描述与实际 reader 相反

二审已经正确指出 `SpanSchema` 是封闭枚举，但还需要把影响范围说得更清楚：当前 `packages/trace-sdk/src/reader.ts` 在 `TraceLineSchema.safeParse` 失败时会直接抛出 `TraceReadError`，不会继续读取同一文件后面的 span。`RunRepository.listRuns()` 只是在更外层捕获异常，把**整个文件**放入 `failed` 列表。

因此，当前实际语义是：

- 单个坏文件不拖垮其它 run；
- 一个 run 内出现坏行时，该 run 不返回部分结果；
- 与摄取契约所写的“非法行记录错误但不中断整个 run 的加载”不一致。

两种语义都可以成立，但必须在契约中选定一种。对于 AniPedia 的 trace，建议保持“文件级拒绝 + 上层隔离”，因为部分加载会破坏 span 父子关系、引用编号和 replay 前缀；同时把契约文字改为“单个坏文件不得拖垮其它 run，坏文件需报告行号并标记不可用”。

### 12.2 P1：未知 `span.kind` 不能只写成“读取器忽略”

当前 `TraceLineSchema` 和 `reader.ts` 都会把未知 kind 视为非法行。若未来要开放 `retrieve`、`embed` 等 kind，至少需要同时改动：

1. schema 的解析联合；
2. reader 的类型返回和排序逻辑；
3. UI 的未知 span 展示策略；
4. replay 对未知 span 的可编辑性规则。

在这些未定义前，AniPedia 应只输出契约已有的三种 kind，并把检索和引用校验记录为 `tool.invoke`，例如 `tool: "rag.retrieve"`、`tool: "verify.citations"`。这不是临时绕过，而是当前 v1 最可验证的兼容方案。

### 12.3 P1：二审提出的“三个天然 fork 点”需要降级表述

二审补充的正向论证有助于说明“单轮也值得做”，但其中三项并非当前 ReBaseAgent 都已提供为同一种 fork 能力：

| 二审说法 | 当前可核对的能力 | 三审修正 |
|---|---|---|
| 改检索参数后重跑 | 可由外部应用重新发起一次 run；当前 replay API 没有 AniPedia 检索参数编辑入口 | “可形成新的对照 run”，不是现成 time-travel fork |
| 修改 `SYSTEM_PROMPT` 后只重跑 `llm.call` | prompt fork 会从启动上下文重新执行，且是独立新轨迹，并非只复用单个 llm span | “支持 prompt fork/对照实验”，不要承诺只重跑一个下游节点 |
| 只重跑 `verify.citations` | 当前 AniPedia 没有 `verify.citations` trace；ReBaseAgent replay 主要针对 tool result 或 prompt/model 参数 | 先把校验变成可记录的 `tool.invoke`，再另行设计纯函数重算入口 |

因此，推荐的正向论证应改成：**单轮已经拥有可观测的检索、生成、校验边界；其中部分边界可以作为未来 fork/replay 的候选点，但是否支持局部重跑要以实际编排 API 为准。**

### 12.4 P1：原子落盘与崩溃可见性存在真实取舍

二审建议“临时文件 + 原子 rename”以避免扫描器读到半行，这是正确的完整性保护，但会改变契约中的崩溃语义：若进程在 rename 前崩溃，临时文件通常不会出现在 `traces/*.jsonl`，ReBaseAgent 就无法把它识别为缺失终止事件的 crashed run。

实施时必须先选定策略：

- **最终文件早出现**：直接写 `<run_id>.jsonl`，每次整行写入；优点是崩溃 run 可见，缺点是扫描器可能在运行中把它显示为 crashed，需要支持后续刷新；
- **临时文件后改名**：运行期间写 `<run_id>.jsonl.partial`，完成后原子改名；优点是列表永远只看到完整 run，缺点是需要额外的 partial 恢复/展示机制，才能保留崩溃诊断。

不能同时宣称“原子 rename”与“任意崩溃都能按 JSONL 文件被发现”，除非契约明确规定 partial 文件的生命周期。Phase B 验收应覆盖：写入中扫描、正常完成、进程崩溃、重启后恢复四种情况。

### 12.5 P1：开发目录直写是 dogfood 快捷路径，不是稳定外部接口

二审确认开发模式目录为 `D:\ReBaseAgent\.rebaseagent\traces`，这足以让 AniPedia 在本机快速演示。但该路径来自当前桌面应用实现，而不是已锁定的公共契约；未来仓库布局、工作目录或打包方式变化都可能使硬编码失效。

因此建议把“直写开发目录”限定为开发配置项，并在启动时打印实际 trace 目录；生产配置仍应通过显式环境变量、配置文件或 ReBaseAgent 提供的 discovery API 获取。AniPedia 不应把 `D:\ReBaseAgent` 写死到发布代码中。

### 12.6 P2：`config_hash` 与“可重放”仍应区分两个概念

三次复核确认当前 ReBaseAgent 的 `configHash` 实际只覆盖 `systemPrompt + tools`，并且 replay 层明确把换模型/采样参数视为合法同源实验。这是一个可接受的产品决策，但不能在 AniPedia 文档中把 hash 解释为“结果可重现指纹”。

建议在 trace 元数据中分别表达：

- `config_hash`：源代码/工具表同源性；
- `model` 与参数：本次调用配置；
- 数据集、索引、嵌入模型版本：检索环境；
- 是否具备确定性 replay：由模型和 provider 能力另行标记。

这样既不破坏 ReBaseAgent 当前 fork 门禁，也避免用户误以为相同 hash 必然产生逐字相同答案。

### 12.7 三审后的决策门槛

在进入多步 agent 之前，至少满足以下条件：

1. 单轮 40 题基线可重复运行，且有记录生成参数和数据版本；
2. 一条合法 AniPedia trace 能被当前 reader 完整读取，坏文件不会拖垮其它 run；
3. file-drop 的运行中、完成、崩溃三种状态已经通过测试；
4. 已明确 prompt fork、tool result replay 和重新发起新 run 的边界；
5. 多轮 10–15 题评测相对单轮拼接 baseline 有可量化收益。

若第 5 条未满足，继续完善单轮 trace、评测和数据查询的收益高于引入 agent 循环。

### 12.8 三审最终结论

二审的主线判断仍然成立：先稳定单轮，再 trace，再摄取/replay，最后才考虑多轮 agent。但三审需要收紧三处表述：

- 把“reader 隔离坏行”改成当前真实的“reader 拒绝坏文件、repository 隔离坏文件”；
- 把“单轮有三个现成 fork 点”改成“单轮有三个可观测边界，其中只有部分已有 replay 编排”；
- 把开发目录直写和原子落盘写成明确的开发策略与状态机，而不是稳定契约的既成事实。

在这些修正后，本文可以作为下一阶段实施评审的基线；目前仍不建议修改 AniPedia 的核心回答路径或直接启动多步 agent 重构。

---

## 13. 对三审结论的核验与补充（2026-09-10）

> 核验方式：读 `packages/trace-sdk/src/reader.ts`、`packages/replay/src/replay-run.ts`、`packages/agent-loop/src/config-hash.ts`、`apps/desktop/src/main/run-repository.ts`、`apps/desktop/src/main/fork-runner.ts`。
> 结论：**§12 的四条技术论断全部成立**；但三审仍未回答一个决定性问题——**AniPedia 写出的 trace 究竟能不能被当前桌面端 fork**。本节给出答案与 Phase B 必须新增的硬约束。

### 13.1 三审论断复核（四条全部成立）

| 三审论断 | 复核证据 | 结论 |
|---|---|---|
| 12.1 reader 遇坏行抛错、不返回部分结果；坏文件由 repository 隔离 | `reader.ts:85-89` `safeParse` 失败即 `throw new TraceReadError`；`run-repository.ts:23-35` 把整个文件推入 `failed` | 成立 |
| 12.2 未知 `span.kind` 视为非法行 | `TraceLineSchema` 为封闭 discriminatedUnion，reader 逐行校验，无跳过分支 | 成立 |
| 12.3 「三个 fork 点」需降级 | `replay-run.ts:22-31` 分叉点必须是 `tool.invoke` span 且 MVP 仅支持编辑 `result`，下游真实重跑；`fork-runner.ts:204-205` prompt fork 「从头重跑，不共享前缀」 | 成立，二审表述确实过强 |
| 12.6 `config_hash` 只覆盖 systemPrompt + tools | `config-hash.ts:5-23`，注释明示 model/params 不参与，换模型属合法对比实验 | 成立 |

### 13.2 P0（新增）：桌面端 fork 有三道硬门槛，AniPedia 目前一道都过不了

`fork-runner.ts:142-183`（`buildForkConfig`，被 replay fork / prompt fork / 模型 A/B **共用**）之前，还有一道更前置的门禁：

0. **父 run 必须已封存**（末行有 `run.event`）→ `guards.ts:8-11` `assertForkable` 对 `status === "crashed"` 的 run 直接报错，crashed run 永远不能作分叉父本。这与 §12.4 的落盘取舍直接耦合：走「临时文件 + rename」则崩溃 run 不可见；直接写目标文件则崩溃 run 可见但**必然是 crashed、只能看不能 fork**。

1. 父 run 必须含 `llm.call`，且其 `request.messages` 中必须有 **`role === "system"` 且 `content` 为字符串**的消息 → 否则 `NO_SYSTEM`，prompt fork 不可用；
2. `request.tools` **必须存在**（不能省略）→ 否则 `FORK_NO_CONTEXT`「父 run 录制缺少工具表」。AniPedia 调 Ollama 无工具表，**必须显式写 `tools: []`**；
3. 工具定义必须能在桌面 `HANDLERS` 中找到，当前注册表**只有 `read_file` / `write_file`**（`fork-runner.ts:293-318`）→ 否则 `UNKNOWN_TOOL`「桌面端暂不支持重跑工具：rag.retrieve…」。

**推论（决定 Phase F 的形态）：**

- 「在 `tool.invoke` 处分叉重跑」**对 AniPedia 不可用**（其工具未注册，也无法在 Electron 主进程里执行 Python 检索）；
- **prompt fork 与模型 A/B 可用**，前提是 `tools: []` + 存在 system 消息。而 AniPedia 单轮 `llm.call` 本就不调工具，**恰好匹配**：重跑 = 改 `SYSTEM_PROMPT` / 换模型后重新生成一次答案 —— 这正是 Phase F 想要的「改 prompt → 重跑 → 并排对比」闭环；
- 因此 Phase B 的字段字典必须新增两条硬约束：`llm.call.request.tools` 写 `[]`（不可省略）、`messages[0]` 为字符串 system 消息。
- **一致性说明**：AniPedia 仍会把检索与引用校验记为 `tool.invoke` span（用于可观测），但 `request.tools` 必须写 `[]`。二者并不矛盾——`request.tools` 表示「交给模型选择」的工具，而 AniPedia 的检索由代码执行、模型无从调用。若把 `rag.retrieve` 等写进 `request.tools`，连 prompt fork 也会被 `UNKNOWN_TOOL` 一起拒掉。

### 13.3 P0（新增）：`config_hash` 必须在 Python 侧逐字节复刻 TS 实现

`configHash(systemPrompt, tools)` = `"sha256:" + hex(sha256(canonical))`，其中 canonical 为 `{systemPrompt, tools:[{description, name, parameters, sideEffect?}]}`，工具按 `name` 排序、对象键按字典序排序、JSON 无空白。Python 侧复刻有三个坑：

1. **`ensure_ascii=False`** —— Python 默认 `True`，会把中文 `SYSTEM_PROMPT` 转义成 `\uXXXX`，哈希必然与 TS 端不一致；
2. **`separators=(",", ":")`** —— 默认带空格，与 `JSON.stringify` 不一致；
3. 输出必须带 **`sha256:` 前缀**，且 `sideEffect` 仅在为布尔值时写入。

哈希不一致的直接后果是 fork 被拒（`fork-runner.ts:113`、`assertForkable`）。这是三份文档都未提及、但会在实施第一天就卡住的细节。

### 13.4 P1（新增）：span id 应采用引擎格式 `s_NN`

`replay-run.ts:56-67` 的 `maxSpanSeq` 用 `/^s_(\d+)$/` 推断 fork run 的编号起点。契约 §4 示例中的 `s1` / `t1` / `l1` **不匹配该正则**，会导致 fork run 从 `s_01` 重计，而注释明确指出这会产生「展开轨迹重复 id、再分叉命中祖先同名 span」。AniPedia 手写 trace 应直接采用 `s_01 / s_02 …` 递增格式（根 span 与子 span 统一编号即可）。

### 13.5 对 Phase 计划的影响

- **Phase B**：字段字典加入 13.2 / 13.3 / 13.4 三条硬约束；验收标准增加一条——「该 trace 能在桌面端成功执行一次 prompt fork」。
- **Phase F**：修订预期。桌面端可对 AniPedia 做的是**改 prompt / 换模型后整轮重跑**，既不是「只重跑某个 `llm.call`」，也不是「在检索步骤分叉」。若需要后者，ReBaseAgent 需新增「外部工具 handler 注册 / 外部执行器」能力，这应作为**对 ReBaseAgent 的独立需求**提出，而不是由 AniPedia 单方面适配。

### 13.6 补充后的结论

三审 §12.8 的结论成立并应采纳。新增 §13.2–13.4 之后，Phase B 的字段字典才真正具备可执行性；其中 13.2 决定了「作者用 ReBaseAgent 调试 AniPedia」这条闭环目前**只有 prompt fork / 模型 A/B 一条通路**可用——这既是坏消息（tool 级 time-travel 用不了），也是好消息（它恰好覆盖作者最需要的 prompt 迭代场景，且不需要 ReBaseAgent 做任何改动）。

---

## 14. 四次复核意见（2026-09-10）

> 本节对 §13 的新增结论再次回到实现核对，重点区分不同 replay 入口的前置条件，避免把“理论上可录制”写成“导入后必然可重跑”。

### 14.1 §13 的三条新增技术结论基本成立

- `llm.call.request.tools` 在当前桌面端的 fork 重建中必须存在；AniPedia 若没有模型工具，仍应显式写 `tools: []`；
- 当前 `configHash` 的规范化规则确实要求 Python 侧复刻排序、无空白 JSON、UTF-8 非 ASCII 转义和 `sha256:` 前缀；
- 当前 replay 的 span 序号约定是 `s_NN`，示例中的 `s1/t1/l1` 不能直接作为可安全分叉的生产格式。

这些结论可以保留，但应把它们标记为“对当前桌面端 replay 的兼容要求”，而不是 v1 trace schema 本身已经声明的全部要求。

### 14.2 P0：tool-result replay 与 prompt fork/model A/B 不是同一组门槛

§13.2 将三种情况放在同一组“桌面端 fork 三道硬门槛”下，容易造成实施误判。当前实现实际分成两条路径：

| 路径 | 必须具备 | AniPedia 单轮是否可能满足 |
|---|---|---|
| `runs:fork` / tool-result replay | 已封存；`tool.invoke` 分叉点；父 step 中有 `llm.call`；工具表可重建；工具名在桌面 handler 中注册；当前 MVP 只编辑 `result` | **不能直接满足**，因为 AniPedia 的 `rag.retrieve` / `verify.citations` 不在桌面 handler 中 |
| prompt fork / model A/B | 已封存；非 proxy；有 `config_hash`；首次 `llm.call` 有字符串 system 消息；`request.tools` 存在（无工具时为 `[]`） | **可以满足 trace 形状**，但仍依赖当前桌面设置可访问对应 provider/model |

因此，“AniPedia 只有 prompt fork / 模型 A/B 一条通路可用”应改成：**在满足 provider、凭据和模型可用性后，当前桌面端理论上可使用 prompt fork / 模型 A/B；tool-result replay 仍不可用。**

### 14.3 P1：prompt fork 不会自动复用 AniPedia 的 Ollama 运行环境

`buildForkConfig` 从桌面端当前 `settings.baseURL`、`settings.apiKey` 和 `settings.model` 组装重跑配置；它不会从 AniPedia 的 `run.meta` 恢复 Ollama `/api/generate` 地址，也不会自动知道 AniPedia 的本地模型安装情况。

这意味着导入 trace 后：

- 若桌面端未配置 OpenAI-compatible provider，prompt fork 仍会失败；
- 若当前设置的模型与父 trace 不同，模型 A/B 是新实验，不是原环境复现；
- 若使用代理或远端 provider，AniPedia 原本“数据不出本机”的约束可能不再成立。

Phase C/F 验收必须明确 provider、凭据、网络和隐私边界；不能只以“trace 被 reader 读取”作为 replay 成功标准。

### 14.4 P1：§13 的硬约束列表遗漏了 `llm.call` 的必填响应字段

当前 `LlmCallSpanSchema` 规范化的字段包括：

- `response.content`；
- `reasoning_content`；
- `tool_calls`（缺省时由 schema 默认成空数组，fixture 仍建议显式写出）；
- `usage.in/out`；
- `ttft_ms`。

AniPedia 当前 `/api/generate` 封装只返回文本，`eval_rag.py` 另行读取 `eval_count` 和 `eval_duration`；它没有现成的 `usage.in`、`usage.out` 和可靠 TTFT 对象。实现 trace 时必须定义映射：

- `in` 使用 Ollama 的 prompt token 统计，缺失时不能伪造为未知字段，因为 schema 不允许省略；
- `out` 使用生成 token 统计；
- 流式调用可用首块到达时间测量 `ttft_ms`，非流式调用应明确记录 `0` 或“不可得”的策略；
- `tool_calls` 在 AniPedia 单轮中写 `[]`，而不是省略。

这应加入 Phase B 字段字典和 fixture 测试，否则 trace 可能在最后一步因响应字段不完整而无法摄取。

### 14.5 P1：`messages[0]` 为 system 的说法应改为“存在可定位的 system 消息”

当前 `fork-runner.ts` 和 `prompt-fork.ts` 都是用 `find` 查找字符串形式的 `role: "system"` 消息，并没有要求它必须位于数组索引 0。将其写成 `messages[0]` 是一个可行的 AniPedia 生产约定，但不是当前实现的硬门槛。

建议字段字典同时规定“将 system 消息放在首位以提高可读性”，但验收条件应写成“至少有一条可定位的字符串 system 消息”，避免把实现细节误写成 schema 要求。

### 14.6 P1：`config_hash` 复刻还要处理缺省工具表的语义

AniPedia trace 的 `request.tools` 必须写 `[]`，但 `config_hash` 的输入是工具定义数组，不是 `request.tools` 原始字段的存在性本身。字段字典需要明确：

- 无模型工具时，`tools = []`，hash 输入中的 tools 也是空数组；
- 不能把 `undefined`、`null`、省略字段和 `[]` 混用；
- 若以后加入 `rag.retrieve` 等模型可调用工具，必须提供与桌面端一致的 handler 或明确禁止 tool-result replay。

### 14.7 P2：Phase F 的“只重跑指定下游步骤”仍然过于宽泛

当前 ReBaseAgent 已有的是：

- prompt fork：从启动上下文重新执行；
- tool-result replay：从工具结果编辑点继续执行，但要求桌面端能处理该工具；
- model A/B：基于启动上下文做多模型/参数实验。

AniPedia 的 `verify_citations` 是 Python 纯函数，尚未成为 ReBaseAgent 可独立调度的 step。Phase F 应把“只重跑指定下游步骤”改成具体支持矩阵，不要承诺任意 span 可局部执行。

### 14.8 四审后的实施硬约束

Phase B 的 AniPedia trace fixture 至少要同时满足：

1. `run.meta` 首行包含 `parent: null`、`fork: null`、`config_hash` 和有效时间戳；
2. 至少一个 `agent.step`，其下有 `llm.call`；
3. `llm.call.request.messages` 中存在字符串 system 消息；
4. `llm.call.request.tools` 显式为 `[]`；
5. `response.tool_calls` 显式为 `[]`，并提供合法 `usage`、`reasoning_content`、`ttft_ms`；
6. span id 采用 `s_01`、`s_02` 形式且父子关系闭合；
7. 末尾有 `run.event`，并能被当前 reader 完整加载；
8. 在配置好兼容 provider 后，至少成功完成一次 prompt fork；未配置 provider 时，错误必须明确而不是伪装成 trace 读取失败。

### 14.9 四审最终结论

§13 把审阅从“能否写 trace”推进到了“能否被当前桌面端使用”，方向正确；但最终结论需要再加一层条件：**trace 形状兼容不等于 replay 环境兼容。**

对 AniPedia 来说，当前最现实的第一条闭环是：本地单轮 → 录制合法 trace → ReBaseAgent 查看 → 在配置好兼容 provider 后做 prompt fork/model A/B。tool-result replay、检索步骤分叉和引用校验局部重算仍属于后续扩展，不应写成当前已具备能力。

---

## 15. 收敛结论（2026-09-10：对 §14 的核验与终止建议）

> 核验方式：读 `packages/replay/src/fork-parent.ts`、`packages/replay/src/derive.ts`、`packages/trace-sdk/src/schema.ts:128-150`、`apps/desktop/src/main/fork-runner.ts:184-196`。

### 15.1 §14 复核（五条全部成立）

| 四审论断 | 复核证据 | 结论 |
|---|---|---|
| 14.2 两类 replay 门槛不同 | `fork-parent.ts:34-57` 门禁顺序：父链 → 已封存 → 非 proxy → `config_hash` **存在** → 首次 `llm.call` → 字符串 system 消息 | 成立。补充：`config_hash` 对 prompt fork 是**存在性**门槛（不是一致性门槛，一致性只用于 tool-result replay） |
| 14.3 prompt fork 不复用 AniPedia 的 Ollama 环境 | `fork-runner.ts:185-190` 用桌面 `settings.baseURL/apiKey/model` 组装重跑配置 | 成立 |
| 14.4 遗漏 `llm.call` 响应必填字段 | `schema.ts:138-146`：`usage`（`in`/`out` 必填）与 `ttft_ms`（非负数字，必填）**均非可选**；`content`/`reasoning_content` 可为 `null` 但键必须存在；`tool_calls` 有 default，fixture 仍应显式写 `[]` | 成立，且比四审描述更硬：这是三份文档都没写、会在**摄取最后一步**炸掉的字段 |
| 14.5 system 消息不必在索引 0 | `fork-runner.ts:160`、`fork-parent.ts:61` 均为 `find`，非下标 | 成立 |
| 14.6 `config_hash` 需处理缺省工具表语义 | `config-hash.ts:10-23` 输入为工具**定义数组** | 成立 |

### 15.2 加强：tool-result replay 对 AniPedia 是「架构不可能」，不只是「handler 未注册」

`derive.ts:76-104` 揭示了两道比 handler 注册更根本的前提：

1. `stepLlm.response.tool_calls[toolIndex]` 必须存在，且 `id` 为非空字符串（`:84-90`）；
2. 分叉点之后首次 `llm.call` 的 `request.messages` 中，必须存在 `role: "tool"` 且 `tool_call_id` 等于该 id 的消息（`:98-104`）。

即：**tool-result replay 的语义前提是「工具由模型通过 `tool_calls` 发起」**。AniPedia 是「代码检索 → 拼 prompt → 模型生成」，模型从未发出 `tool_calls`，因此**即使注册了 handler 也必然失败**。

据此更正 §13.5 与 §14.2 第一行：从「若以后提供 handler / 外部执行器即可支持」改为「还需要把 AniPedia 改造成模型 tool-calling 循环，且工具能在重跑侧执行」。

### 15.3 收敛判据：把「要不要做多步 agent」压缩成一个工程问题

| 目标能力 | 需要什么 | 代价 |
|---|---|---|
| 改 `SYSTEM_PROMPT` / 换模型 → 整轮重跑 → 并排对比 | 单轮 + prompt fork / 模型 A/B | AniPedia 零架构改动，ReBaseAgent 零改动 |
| 在检索结果上做反事实编辑 → 只重跑下游 | ① 模型以 `tool_calls` 发起工具（即真正的 agent 循环）② 该工具能在重跑侧执行（AniPedia 检索在 Python，需跨语言桥） | 大工程，且必然动到已调好的单轮质量 |

因此决策问题收敛为一句：**是否需要「在检索结果上编辑并重跑下游」这一能力？**

- 需要 → 才值得做 agent 化 + 跨语言 handler 桥；
- 不需要 → 单轮 + prompt fork 已经覆盖作者最常做的 prompt/模型迭代，「多步 agent 化」不应以 ReBaseAgent 为由启动（回到 §6 的判断：不能为工具叙事改造产品）。

### 15.4 终止建议

技术事实已核到代码级（schema、reader、fork 门禁、replay 派生、桌面 handler 注册表、数据目录解析），四轮审阅的边际收益已低于继续讨论的成本；剩下的 15.3 是**产品决策**而非技术分歧。

建议：**停止审阅，进入 Phase A**（统一数据加载与 seed 决策、4 接口缓存、SSE 错误传播、health 拆字段；纯工程、零争议，以现有 40 题评测做回归）。Phase B 按 §13.2–13.4 + §14.4 + §14.8 的硬约束实施，验收加入「完成一次 prompt fork」。
