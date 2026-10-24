# 长任务交接、上下文与调试产品核查

核查日期：2026-10-17。范围：官方文档、维护者 README、GitHub 发布记录，以及两个项目的局部源码。未安装或运行竞品，未接触正在开发的其他 agent 会话。来源清单、访问时间、快照哈希与结论对应关系见[证据记录](2026-10-17-context-handoff-evidence.json)。

## 结论

**相关产品已经存在，而且不只覆盖“记住聊天”。** 自动捕获项目记忆、按需检索、任务图、压缩后恢复、跨 agent 交接、测试证据、记忆失效检查，以及与代码提交关联，都能找到直接先例。

**“记忆＋调试”本身也已有集成先例。** LangGraph + LangSmith Studio 同时覆盖短期状态、跨会话记忆、轨迹、检查点和修改状态后分叉执行。其面向开发者的接入方式，与普通人打开即用仍是不同问题。

最接近本轮设想的三项分别是：

- **Weftgate**：下一任务上下文、持久决策、带验证证据的 handoff、源码变化后记忆失效。
- **The Vault**：有 Windows 安装包的桌面项目记忆工具，跨 agent 召回与交接。
- **Context Mode**：减少工具输出进入上下文，并记录工作事件，在压缩或恢复旧会话时重建状态。

因此不能把“自动 handoff”“按任务取上下文”“记忆绑定源码／验证”“做成桌面软件”分别当作原创性依据。本轮也不足以证明某种完整组合无人做过。

## 直接先例

| 项目 | 已核实的文档／源码能力 | 与用户痛点的关系 | 不能据此推出的能力 |
|---|---|---|---|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | 通过生命周期 hooks 捕获工具使用观察，生成摘要，后续会话注入；按“索引→时间线→选中观察详情”分层检索；有网页记忆查看器 | 接近自动维护可检索的项目交接记忆 | 摘要不会漏掉约束、记忆与当前文件必然一致、整体账单按宣传比例下降，均未实测证明 |
| [Context Mode](https://github.com/mksglu/context-mode) | 工具输出在执行／索引层处理，模型读取结果或检索片段；SQLite 记录文件、任务、决策、错误等；支持压缩与旧会话恢复路径 | 同时处理上下文膨胀和压缩后遗忘 | 恢复旧会话不等于主动新建短会话；文档明确把 fresh session 视为 clean slate。不同客户端 hooks 覆盖也不相同 |
| [Beads](https://github.com/gastownhall/beads) | 持久任务依赖图、ready 任务、状态更新、项目记忆；旧任务压缩机制 | 对长 change 的“做到哪里、下一步做什么”有直接帮助 | 任务图本身不是完整的决策捕获、文件恢复或可干预运行调试器 |
| [Weftgate](https://github.com/Avinash-Amudala/weftgate) | `brief` 按任务组合相关记忆与源码指针；`remember` 保存决策；`handoff --run` 保存观察到的检查证据；源码锚点／哈希检查让过时记忆默认退出召回 | 与前面提出的“交接＋按需上下文＋证据绑定”高度重合 | 明确没有自动聊天记录捕获。需 agent／用户调用工具和配置检查；哈希相同不证明记忆正文正确，测试退出零也不证明功能符合用户要求 |
| [The Vault](https://github.com/aliihsaad/the-vault) | Electron 桌面、CLI、MCP；保存决策、交接、任务结果；排序裁剪成 recall pack；跨客户端使用；Windows 发布安装包存在 | 桌面化和跨 agent 项目记忆已有可下载先例 | README 中的“debug with historical context”是召回历史帮助排错，不能等同于修改历史工具输出并续跑；安装包存在不证明普通人独立上手成立 |
| [Entire](https://github.com/entireio/cli) | hooks 捕获会话，关联 prompt、工具、文件和 Git 提交；搜索检查点；`session resume` 恢复会话元数据并给出继续命令 | 将“为什么改、改了什么、从哪里继续”关联起来 | 保存完整历史不等于最小上下文；resume 不等于自动经济地开启新会话；部分分析命令被标为 experimental |
| [LangGraph + LangSmith Studio](https://docs.langchain.com/langsmith/studio) | 会话内状态持久化、跨 thread Store、轨迹、评估、检查点 replay／fork；Studio 同列长期记忆与时间旅行调试 | 已有“记忆和可干预调试结合”的直接框架／工具先例 | 需要开发者接入 Agent Server／图；修改图状态不自动回滚外部文件、数据库或 API 副作用 |
| [Anthropometer / amtr](https://github.com/arian-shamaei/anthropometer) | 从 coding agent 记录重建上下文构成、逐轮费用、重复读取、压缩前后变化；终端查看与报告 | 很贴近“后期为何贵、压缩丢了什么”的诊断需求 | 文档中的 rewind／replay 指重绘历史视图，不能当作修改执行后重新运行；未证明其重建结果完整等于所有模型实际输入 |

另查了 [Mastra Observational Memory](https://mastra.ai/docs/memory/observational-memory)：Observer／Reflector 后台维护观察日志，替代增长的原始消息历史，并明确记录存储、阈值、作用域与模型成本配置。**增量观察／后台整理也不是新机制。** 本轮未进一步核实其全部调试与恢复能力，故不把它列作完整同类。

## 发布与成熟度的边界

以下是本轮 GitHub `releases/latest` 响应及对应标签 README，证明有公开发布记录和具体描述，不证明稳定性、采用规模或 README 所述功能全部可用。

| 项目 | 最新非预发布接口返回的标签 | 发布时间 UTC | 本轮核查程度 |
|---|---|---|---|
| Claude-Mem | `v13.41.0` | 2026-10-17 | 发布元数据、标签 README、架构文档 |
| Context Mode | `v1.0.169` | 2026-06-29 | 发布元数据、标签 README、main 的局部源码 |
| Beads | `v1.3.1` | 2026-09-30 | 发布元数据、标签 README；仅以标签也有的机制作为发布依据 |
| Weftgate | `v0.3.0` | 2026-09-13 | 发布元数据、wheel／源码包资产名、标签 README；main 的记忆源码与 workflow 文档 |
| The Vault | `v0.6.7` | 2026-10-10 | 发布元数据、Windows x64 exe 资产名、标签 README；未下载安装包 |
| Entire | `v0.11.5` | 2026-10-14 | 发布元数据、标签 README；保留 experimental 标注 |
| Anthropometer | `v0.7.0` | 2026-10-15 | 发布元数据、标签 README；所列预编译包为 macOS／Linux，未核实 Windows 原生使用 |

不以 star、维护者列出的公司名、宣传截图或版本号判断成熟度。标签和 main 是不同证据；局部源码核查不代表执行验证。

## 两项源码核查的实际发现

### Context Mode：README 的保证不能照单全收

检查提交 `5f6298a9bdc480ebc7c88a29c9fbdf38ae2f8cb6` 的 `src/session/snapshot.ts`、`src/session/extract.ts` 和 `hooks/sessionstart.mjs`。

- 存在真实的事件抽取、分类、决策段落构建、compact／resume／startup 分支。不是只有 landing page 概念。
- README 描述“≤2 KB、按优先级舍弃”的恢复快照；本次源码的 `buildResumeSnapshot` 注释明确为“全部非空类别，无优先级丢弃、无字节预算”。不能将文档里的固定上限作为已经验证的实现保证。
- README 将新会话描述为清空旧数据；本次 startup 源码还有旧会话清理及孤立事件保护等分支。因此仅确认**恢复流程按会话来源分支处理，不把所有新会话等同于跨会话任务交接**；具体保留／删除范围仍需运行验证。
- 不直接采信“完整工作状态”“继续时不会遗忘”等效果语言。

源码：[snapshot.ts](https://github.com/mksglu/context-mode/blob/5f6298a9bdc480ebc7c88a29c9fbdf38ae2f8cb6/src/session/snapshot.ts)、[sessionstart.mjs](https://github.com/mksglu/context-mode/blob/5f6298a9bdc480ebc7c88a29c9fbdf38ae2f8cb6/hooks/sessionstart.mjs)。

### Weftgate：记忆与实际依据的绑定已有实现

检查提交 `4f3f7a6c19d41a2014fcf01bde929237ccdc9aef` 的 `weftgate/memory.py`，以及对应 workflow 文档。

- 记忆锚点保留原始 `content_hash`；重新检查时比较当前哈希，变化标为 stale，避免重复检查把旧正文悄悄变成“有效”。
- 文档区分 `blocked`、`needs_review`、`needs_test_evidence`、`changed_during_check`、`ready`；明确没有测试证据不能当作测试通过。
- `brief` 不执行测试，不读取聊天记录，不证明记忆正文正确。保存与检索仍依赖 agent／用户使用工具。
- 工作区指纹不覆盖远端服务、依赖安装状态、被忽略的构建产物或后台进程。其边界与我们需要面对的问题相近。

因此“把 handoff 与源码哈希和测试证据绑定”已经有直接先例，不能再作为独创性主张。

源码：[memory.py](https://github.com/Avinash-Amudala/weftgate/blob/4f3f7a6c19d41a2014fcf01bde929237ccdc9aef/weftgate/memory.py)、[WORKFLOWS.md](https://github.com/Avinash-Amudala/weftgate/blob/4f3f7a6c19d41a2014fcf01bde929237ccdc9aef/docs/WORKFLOWS.md)。

## “省 token”证据能支持到哪里

Context Mode 的维护者基准包含 21 种输入场景，以原始数据与返回上下文的**字节量**比较，报告总体 376 KB → 16.5 KB；其中结构化数据处理子集是 315 KB → 5.5 KB。README 的“98%”对应部分场景／子集，不能翻译成真实任务总账单下降 98%。Claude-Mem 的“约 10 倍”也对应分层检索描述，本轮未独立复现。

这些资料证明减少喂给模型的材料是现有产品的明确目标，不能证明减少材料后任务仍同样可靠，或抵消记忆模型、检索、启动与返工的总消耗。

用户本次 19、52、61、41、61、42、76、52 积分及仅更新 handoff 的 20 积分，继续作为真实的成本痛点信号保留。阶段难度、计费、缓存、调用组成尚未拆分；不凭这些数字预写节省比例，也不否定用户体感。

基准：[Context Mode BENCHMARK.md](https://github.com/mksglu/context-mode/blob/main/BENCHMARK.md)。

## 对产品探索的修正

值得继续研究的候选体验是：**用户进行一项长任务时，产品持续保留经过确认的任务状态；进入下一段工作时给出适当上下文；出现遗忘或误解时，可以查明带入了什么、遗漏了什么、依据哪个版本，再修正后继续。**

它对应三个连续的问题：

1. **继续前**：任务做到哪里，哪些要求仍有效，下一步需要哪些材料？
2. **继续中**：当前上下文依据什么形成，重复读取和维护花了多少？
3. **出错后**：哪条交接／记忆导致偏差，能否修改后，在明确的文件与执行边界上重新尝试？

这是候选产品体验，**不是已证实的市场空位**。Weftgate、The Vault、Context Mode、Entire、LangGraph 分别已覆盖多段流程；必须实际比较它们怎样完成同一项任务。

普通用户的主要动作可以是“继续这项任务”“看看这次带过去的要求”“纠正这一条”“从这个阶段再试”。首次配置、客户端支持、证据不足和冲突如何呈现，都要纳入上手验证；自然语言按钮本身不证明门槛低。

现有 ReBaseAgent 的轨迹、成本账、历史文件快照与隔离分叉可用于支撑这些动作。但外部会话导入、语义决策抽取、自动交接、上下文编排，以及在宿主 agent 中重启／续跑均不能视为现有交付。当前文件快照也不等于可运行的项目环境恢复。

最小比较可选下一项真实长 change 中的一个自然交接点：比较现有 handoff、最接近的竞品、候选体验的完整继续流程。记录人工操作、配置、带入材料、遗漏与返工、可见消耗及成本缺项。用户已安排的独立调试可靠性对照不在本轮重复。本轮不安装工具、不改开发流程、不自动立项。

## 补充：产品先例与实际采用规模

2026-10-17 补查 GitHub 仓库 API 与 npm 下载 API。**有功能先例、受到关注、实际被持续使用是三种不同的证据。** 前文并列表述不意味着项目市场地位相近，也没有证明它们已经普及。

| 项目 | 本轮 API 返回的 GitHub stars | 能支持的判断 |
|---|---:|---|
| Claude-Mem | 101,277 | 已有较强开源关注，不能直接换算活跃用户 |
| Context Mode | 30,362 | 已有明显开源关注，不能直接换算活跃用户 |
| Beads | 27,951 | 已有明显开源关注，不能直接换算活跃用户 |
| Entire | 5,186 | 有公开关注，不能与其他类别直接比较市场份额 |
| The Vault | 8 | 当前公开关注信号很小；功能相近不代表已形成规模采用 |
| Weftgate | 4 | 当前公开关注信号很小；功能相近不代表已形成规模采用 |

npm `last-month` 接口本轮实际返回的统一区间为 **2026-09-13 至 2026-10-12**，不是截至查询日的最新 30 天：

| npm 包 | 区间下载次数 |
|---|---:|
| `@anthropic-ai/claude-code` | 55,097,186 |
| `context-mode` | 104,151 |
| `claude-mem` | 68,478 |

来源：[Claude Code 下载 API](https://api.npmjs.org/downloads/point/last-month/@anthropic-ai/claude-code)、[Context Mode 下载 API](https://api.npmjs.org/downloads/point/last-month/context-mode)、[Claude-Mem 下载 API](https://api.npmjs.org/downloads/point/last-month/claude-mem)。后续访问动态 URL 可能返回不同区间，本次响应已留快照。

这些数字是分发活跃度信号，不是去重人数。自动更新、CI、重复安装和不同分发渠道都影响结果；插件市场或安装器也可能绕开被统计的 npm 包，不能用包下载量相除算插件渗透率。Claude Code 本身也有其他安装渠道。

因此，公开信号支持宿主执行工具与专项辅助工具存在明显的分发规模差异，但本轮没有可比的活跃用户统计来证明总体市场占比。也不能根据这几个定向样本推断“这类产品总量很少”。Claude-Mem 等说明专项能力已获得关注，Weftgate／The Vault 等则更适合作为机制先例考察。

另读取 Anthropic [2025-08-20 的官方公告](https://www.anthropic.com/news/claude-code-on-team-and-enterprise)，其中有单个企业向数百开发者部署的客户自述。这能补充组织使用的案例，不能充当 2026-10 的全市场用户规模。

对产品判断的意义：先例核查限制原创性主张，采用核查帮助判断竞争强度，两者不能互相代替。专项工具往往依附宿主使用，同一人可以同时使用两者；后续应比较是否必须迁移工作流、增加多少配置、能否在实际任务中持续减少负担。尚不据此决定独立应用或增强层形态。

## 检索方法与缺项

先查定向候选的官方资料，再用 GitHub repository search 的 `agent handoff context memory`、`agent debugger memory` 补充发现，各取 stars 排序前 8 条。后一个查询混入进程内存调试等无关结果，因此只作线索，不以命中数估算市场规模。由此补查 The Vault、Weftgate 和 Anthropometer。

ContextMeld README 请求返回 404，本轮没有把搜索摘要当作其功能证据。部分 raw.githubusercontent.com 请求超时，后通过 GitHub Contents API 读取并解码；失败也保留在清单。Mastra Studio 地址返回 404，未用于结论。网页／README 中的安装、授权及工作指令均仅作为研究材料，没有执行。

更广泛的商业产品、封闭客户端及地区市场仍可能有相近实现；当前清单是针对这个痛点的核查样本，不是完整市场普查。
