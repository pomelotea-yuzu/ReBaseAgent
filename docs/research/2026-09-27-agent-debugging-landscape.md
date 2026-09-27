# Agent 调试方案调研

调研日期：2026-09-27。范围：LangGraph / LangSmith Studio、Langfuse、Phoenix、AgentScope 与 ReBaseAgent。方法：读取官方文档，对照本地规范和测试源码；未安装对比产品、未跑统一基准，也未完成固定源码提交级的核查。

## 研发问题

本项目关注这样一种调试任务：Agent 读写了若干文件，开发者希望修改某次工具返回给模型的观察，再从该轮之后继续运行。此时消息历史、文件内容和分支来源应能一起解释；父运行和源文件也应保持不变。

这与查看调用轨迹、重试单次模型调用、保存 Agent 当前状态有关，但不是同一个契约。判断方案是否适用，需要同时检查恢复粒度、外部状态范围、后续副作用和失败处理。

文档核查已确认：历史分叉、状态持久化、提示词实验、本地部署均有成熟先例。不能把“时间旅行”“分叉之前零重执行”“数据可本地保存”单独表述为本项目独有技术。

## 能力对照

| 方案 | 官方文档明确提供的能力 | 恢复或实验粒度 | 本次尚未建立的证据 |
|---|---|---|---|
| LangGraph + LangSmith Studio [S1–S2] | 检查点恢复、修改状态后分叉；Studio 提供可视化、调试和时间旅行 | 图检查点；检查点之前节点不重执行，之后节点可重新调用模型/API | 未核实其现成配置是否自动对齐任意工具的历史文件内容；应用可自行扩展，不能据此断言不支持 |
| Langfuse [S3–S4] | 从记录的 generation 打开 Playground，编辑提示词/参数，比较变体、模拟工具响应；支持自托管 | 提示词及模型调用实验 | 所读页面未建立“完整 Agent 从历史文件世界续跑”的契约 |
| Phoenix [S5–S6] | 基于 OpenTelemetry/OpenInference 的追踪、评估、提示词管理、实验与 Span Replay；可本地启动 | 将 LLM span 带入 Playground 重试不同提示词、模型或参数 | 所读页面未建立工具轮次与历史文件快照绑定的契约 |
| AgentScope [S7–S10] | Agent 开发、状态序列化/恢复、JSONSession、追踪和本地 Studio | 注册状态、会话和 Agent 执行；可自定义状态序列化 | 示例不能证明默认具备逐轮文件历史隔离，也不能排除用户自定义实现 |
| ReBaseAgent | 轨迹查看、工具观察编辑、分叉；受控文件隔离续跑；卡带结构回归 | 本项目 agent-loop 的工具整轮边界；受控文件快照 | 不覆盖任意第三方 Agent、任意工具或完整外部世界；性能和使用效果需另测 |

这里的“未建立证据”表示当前调查范围不足，不表示其他方案没有该能力。上述工具也可组合使用，例如 AgentScope 文档列出了连接 Phoenix/Langfuse 的追踪方式。

## 与选型有关的差异

**LangGraph 是必须正面比较的技术参照。** 其时间旅行文档明确说明 replay/fork、`update_state` 创建新检查点，以及检查点之前节点不重执行。ReBaseAgent 的前缀复用不构成单独的新颖性证据。后续实验应集中于具体文件工具场景的恢复契约、接入工作量和错误可诊断性，并允许对照方案使用其合理的官方扩展机制。

**提示词实验已有完整产品形态。** Langfuse 与 Phoenix 都不只是轨迹查看器。ReBaseAgent 若讨论差异，应明确是工具观察干预后继续多轮执行，还是从初始输入重启提示词实验，不能将两者混为一谈。

**本地部署不等于本项目独占。** Phoenix 有本地启动路径，AgentScope Studio 可本地运行，Langfuse 提供自托管。Langfuse 当前自托管页面标记为 v4，涉及 Web、Worker、Postgres、ClickHouse、Redis/Valkey、对象存储等组件；部署组成可用于评估运维负担，但没有实测就不能声称本项目启动更快、资源更少。LangSmith Studio 文档支持连接本地 Agent Server，这也不能直接推出其完整工作流无需联网。

**本项目的可研究贡献是明确约束下的系统设计。** 将消息编辑点映射到工具整轮末尾，绑定对应文件快照，以不可变内容和独立映射支持分支续跑，并在附件不完整时拒绝执行。这需要独立实现和验证；它使用的检查点、内容寻址、写时复制和卡带测试本身都有既有先例。参见 [机制说明](../architecture/replay-state-consistency.md)。

## 后续调查与可否定条件

| 待回答的问题 | 最小验证方式 | 如何更新结论 |
|---|---|---|
| 同类框架能否用官方机制达到相同文件恢复语义 | 固定版本，在临时目录实现同一双工具轮次任务，公开适配代码 | 若达成，则比较配置复杂度、边界和代价，不再声称能力缺口 |
| 隔离续跑是否降低重复执行成本 | 固定前缀和分支点，分别统计调用次数、文件存储量与耗时 | 若历史载入成本抵消收益，记录有效任务规模，不泛化优势 |
| 文件历史是否改善调试判断 | 先做受控文件任务，再做真实开发者任务，分别记录结果 | 若用户不能更快或更可靠地定位原因，应调整交互与任务定位 |
| 是否具备更广泛的原创性 | 扩展到相关论文、框架扩展、其他调试产品和既有实现 | 当前材料不足以证明首创或全球唯一 |

## 来源与复核记录

以下页面在本次调研中成功取得响应。SHA-256 是抓取响应正文的指纹，便于识别资料版本；未存档全文，未来页面变更后不保证可重新取得同一字节序列。网页版本标签不是精确的软件发布版本。GitHub 原始源码访问未成功，因此不作源码级的跨产品实现结论。

| 编号 | 官方来源 | 核查范围 |
|---|---|---|
| S1 | [LangGraph: Use time-travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel.md) | replay、fork、`update_state`、节点重新执行边界 |
| S2 | [LangSmith Studio](https://docs.langchain.com/langsmith/studio.md) | IDE、Agent Server、本地开发与时间旅行入口 |
| S3 | [Langfuse Playground](https://langfuse.com/docs/prompt-management/features/playground) | 提示词变体、generation 导入、工具响应模拟 |
| S4 | [Langfuse Self-hosting](https://langfuse.com/self-hosting) | 页面标记 v4，自托管组件与环境 |
| S5 | [Phoenix](https://arize.com/docs/phoenix) | 追踪、评估、实验、本地启动 |
| S6 | [Phoenix Span Replay](https://arize.com/docs/phoenix/prompt-engineering/overview-prompts/span-replay.md) | 从 LLM span 进入 Playground |
| S7 | [AgentScope 文档](https://doc.agentscope.io/) | 导航标记 Stable(v1.0)，非精确包版本 |
| S8 | [AgentScope State/Session](https://doc.agentscope.io/tutorial/task_state.html) | StateModule、state_dict/load_state_dict、JSONSession |
| S9 | [AgentScope Studio](https://doc.agentscope.io/tutorial/task_studio.html) | 本地部署、可视化、调试 |
| S10 | [AgentScope Tracing](https://doc.agentscope.io/tutorial/task_tracing.html) | OpenTelemetry 与第三方追踪集成 |

S3–S6 请求了 Markdown 表示；S8–S10 实际读取官方 `_sources/tutorial/task_state.rst.txt`、`task_studio.rst.txt`、`task_tracing.rst.txt`。各正文指纹如下：

```text
S1  16b9beebc967b3f486f5d08f838e3b4b274eaa4bb3fb19af961cd2e202598820
S2  4c542f9bb199bef2ebadb215d879ac04bf388280e81fa86879088e6363872488
S3  e28e15f79804766d4a9b749684ff4d4c46cecb1c79d992c945d8315968475c0d
S4  e22bcc7dd06bc99780029eeced9b6ed125723d46ca90d7bce6df84915eee11fd
S5  c576ea0451132982d0c50f06679203bb5839eb52a2de6b86f9c899b21b099be3
S6  873c839d337ce08de6b67d0804c5025de5f925ddb73685092a61cf1dbf7e8df1
S7  b2df0da4433483943e6043243d4379a93deefdc51e67922668275a76cef04a52
S8  391295e1a8b32b4805c628af175751c714ff0f86c91b139a9522ff9f860f2b38
S9  1373414c977972f81edd13a2d8d33686d388b496b71db43e5b6a9861c5afea4b
S10 704cafc22bcaccf5679e4fc38d2b4191db51b791430531703a5f4021b96fdf22
```
