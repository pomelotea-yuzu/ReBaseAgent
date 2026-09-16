# desktop-ui Specification

## Purpose
让用户在本地桌面上看见一次 Agent 运行的完整轨迹：从 run 列表进入，以 span 树浏览每轮迭代的 LLM 调用与工具执行，并查看任意一步的原始请求与响应。全部本地读取、只读呈现，是编辑与重跑（时间旅行）的前置。

## Requirements

### Requirement: 数据目录遵循便携策略

系统 SHALL 将所有数据置于单一数据目录内：若可执行文件旁存在 `portable.marker`，数据目录为可执行文件所在目录下的 `data/`；否则使用用户显式指定的目录。开发模式下数据目录 SHALL 指向仓库内的指定目录。系统 SHALL NOT 写入 AppData、用户主目录或注册表。trace 文件位于 `<数据目录>/traces/*.jsonl`，一文件一 run。

#### Scenario: 便携模式

- **WHEN** 可执行文件旁存在 `portable.marker`
- **THEN** 数据目录解析为 `<exe 目录>/data`，全部读写发生在该目录内，无任何其他位置被写入

#### Scenario: 未指定且非便携

- **WHEN** 无 `portable.marker` 且用户未指定目录
- **THEN** 应用提示用户选择数据目录，在选定前不创建任何文件

#### Scenario: 目录为空

- **WHEN** 数据目录存在但 `traces/` 为空
- **THEN** 列表显示空状态引导文案，不报错

### Requirement: run 列表从 traces 目录扫描派生

系统 SHALL 扫描 `<数据目录>/traces/*.jsonl`，对每个文件执行 `readRun`，并按 run 展示：任务名、模型、创建时间、状态（`completed` / `crashed`，`crashed` 需标注"运行中断"）、迭代步数、工具调用数、出错工具数、token 合计、总耗时。列表 SHALL 按创建时间倒序排列。

#### Scenario: 多份 trace 文件

- **WHEN** 目录含 normal / tool-error / infinite-loop / branch 四份 run
- **THEN** 列表呈现四行，各自显示正确的步数、token 合计与状态徽章，按创建时间倒序

#### Scenario: 崩溃的 run

- **WHEN** 某文件无终止事件（进程中断）
- **THEN** 该行状态显示为"运行中断"，其余派生字段照常展示，不视为错误

### Requirement: 单个文件读取失败不阻塞列表

系统 SHALL 隔离单个文件的读取失败：读取报错的文件 SHALL 在列表中呈现为失败条目，展示文件名与错误原因（含行号/版本信息），其余文件照常展示。

#### Scenario: 目录混入损坏文件

- **WHEN** 目录中某文件第 12 行缺少 `type` 字段
- **THEN** 列表其余行正常展示，该文件显示为失败条目并提示"第 12 行：type 为必填"

#### Scenario: 版本过高的文件

- **WHEN** 目录中某文件 `format_version` 为 2
- **THEN** 该文件显示为失败条目并提示"不支持的格式版本"，列表其余行不受影响

### Requirement: 渲染进程无文件权限且跨进程数据经校验

渲染进程 SHALL NOT 持有任何文件系统访问能力（`nodeIntegration` 关闭、`contextIsolation` 开启），只经预加载脚本暴露的受限接口获取数据；主进程返回的跨进程数据 SHALL 经 zod 校验后方可进入渲染层。

#### Scenario: 预加载接口不含文件能力

- **WHEN** 渲染层尝试访问文件系统 API
- **THEN** 该 API 不可用（未暴露），只能通过受限接口取数

#### Scenario: 主进程返回非法结构

- **WHEN** 主进程返回的数据未通过结构校验
- **THEN** 界面显示错误提示，不渲染部分数据

### Requirement: 全程只读且只呈现原样数据

系统 SHALL NOT 提供任何写入、修改或删除既有 trace 文件的通道；界面呈现的 span 与 messages SHALL 为文件原样内容，不做采样或截断（长内容用折叠而非丢弃）。`runs:fork` 与 `runs:create` 是本系统仅有的两个例外写通道：两者 SHALL 只**新建** run 文件，SHALL NOT 修改或删除任何既有文件；`runs:fork` SHALL 仅在用户显式编辑并确认后触发，`runs:create` SHALL 仅在用户显式提交表单后触发。

#### Scenario: 浏览过程无写入

- **WHEN** 用户浏览任意 run 的全部 span 与详情
- **THEN** 除用户显式提交分叉重跑或新建运行外，接口集合不含任何写类方法，trace 文件不被创建、修改或删除

#### Scenario: 超长消息

- **WHEN** 某条消息内容超过一屏
- **THEN** 内容默认折叠并可展开，展开后为完整原文，无截断省略

#### Scenario: 分叉不触碰既有文件

- **WHEN** 用户对某 run 发起分叉重跑并完成
- **THEN** 仅新增一个 fork run 文件；父 run 与其余文件内容逐字节不变

#### Scenario: 新建运行不触碰既有文件

- **WHEN** 用户提交"新建运行"并执行完成（成功或失败）
- **THEN** 仅新增一个 run 文件（文件名等于其 `meta.id`）；其余 run 文件内容逐字节不变，且数据目录不留任何临时文件

### Requirement: 轨迹以 span 树呈现

系统 SHALL 依据 span 的 `parent` 构建树：`agent.step` 为层级节点（标注迭代序号 `n`），其下的 `llm.call` 与 `tool.invoke` 为子节点；`tool.invoke` 的 `error` 非空时 SHALL 被显著标注为出错；用户可选中任意 span 查看详情。

#### Scenario: 三步运行的树结构

- **WHEN** 打开一个含 3 轮迭代、每轮 1 次 LLM 调用与若干工具调用的 run
- **THEN** 树呈现 3 个 `agent.step` 节点，各自展开后为其下的 llm.call 与 tool.invoke 子节点，顺序与文件一致

#### Scenario: 工具报错

- **WHEN** 某 `tool.invoke` 的 `error` 非空而 run 最终 `completed`
- **THEN** 该节点以错误样式标注，run 状态仍为已完成（错误是数据不是异常）

### Requirement: 详情面板完整展示一步的原始请求与响应

选中 `llm.call` 时系统 SHALL 展示：完整 `request.messages`、`request.tools`（若有）、`request.params`（若有），以及 `response` 的正文 `content`、思维链 `reasoning_content`（与正文区别展示）、`tool_calls`、`usage`（in/out）、`ttft_ms` 与耗时。选中 `tool.invoke` 时 SHALL 展示 `tool`、`args`、`result`、`error`、`dur_ms` 与耗时。

#### Scenario: 推理模型的思维链

- **WHEN** 选中一次带 `reasoning_content` 的 llm.call
- **THEN** 思维链以区别于正文的样式单独分区展示，两者内容均完整

#### Scenario: 工具调用详情

- **WHEN** 选中一次 tool.invoke
- **THEN** 面板展示工具名、入参、结果与耗时；`error` 非空时错误信息显式呈现

### Requirement: 分支 run 展示解析后的完整轨迹

`parent` 非空的 run SHALL 经 `resolveBranch` 解析后展示：父 run 的共享前缀（截至 fork 点，含 fork 点）与本 run 新增 span 拼接为一条连续轨迹；界面 SHALL 标注分叉点 span 与被编辑字段，并明示前缀来自哪个父 run。

#### Scenario: 分支 run 的轨迹

- **WHEN** 打开一个从父 run `s_03` 分叉的分支 run
- **THEN** 树呈现父 run 截至 `s_03` 的前缀加上本 run 新增 span，分叉点被标注，界面提示前缀所属父 run

### Requirement: 聚合数字从 spans 现算且缺失时间则降级

所有聚合数字（步数、工具调用数、出错数、token 合计、耗时）SHALL 在读取时从 spans 派生，SHALL NOT 持久化任何派生缓存。span 缺失时间区间时，耗时 SHALL 显示为"—"，不得用其他字段臆造。

#### Scenario: token 合计

- **WHEN** 打开含 3 次 llm.call 的 run
- **THEN** 列表与详情的 token 合计等于三次 usage 的 in/out 之和，且随数据变化即时反映，无缓存参与

#### Scenario: 老文件缺失时间区间

- **WHEN** 打开的 run 中 span 未记录时间区间
- **THEN** 耗时显示为"—"，其余聚合数字照常展示，不报错

### Requirement: 分叉重跑是唯一的显式写路径

renderer 侧 SHALL 仅有两条可触发文件写入的通道：`runs:fork`（分叉重跑）与 `runs:create`（新建运行）。除此之外的浏览、列表、详情等既有路径 SHALL 保持零写能力。

- `runs:fork`：请求体 = `{ parentRunId, atSpanId, edit: { field, value } }`，main 侧加载父 run、校验可重放性、执行重跑，返回新 run id；每个请求 SHALL 携带用户明确选择的 `atSpanId` 与编辑值（不允许无编辑的"空 fork"）。
- `runs:create`：请求体 = `{ systemPrompt, userMessage }`，main 侧取运行配置组装空工具表的 `RunConfig` 并执行一次从头开始的 agent loop，返回新 run id；每个请求 SHALL 携带非空 `userMessage`（不允许空消息）。

#### Scenario: 编辑 tool_result 并重跑

- **WHEN** 用户在详情面板选中一个 `tool.invoke` span，编辑其 result 并确认重跑
- **THEN** 界面出现进行中状态；完成后列表刷新并自动选中新 run（分支 run 经 resolveBranch 展示合并轨迹，分叉点被标注）

#### Scenario: 非法请求被拒绝

- **WHEN** `runs:fork` 的 atSpanId 不存在、父 run 未封存、或编辑字段非 result；或 `runs:create` 的请求体缺少非空 userMessage
- **THEN** 界面显示错误原因（来自信封 error），不产生新 run

#### Scenario: 空 fork 被拒绝

- **WHEN** 用户未修改编辑值即提交
- **THEN** 请求被拒绝（编辑前后值相同视为无操作），不产生新 run

### Requirement: 运行配置（LLM 接入）经 safeStorage 持久化

系统 SHALL 提供运行配置入口：baseURL / apiKey / model。apiKey SHALL 优先经 Electron safeStorage 加密后写入数据目录（不落 AppData/注册表）；safeStorage 不可用（如 Linux 无 keyring）时 SHALL 降级明文存储并向用户明示风险。未配置时点击"重跑"SHALL 提示先配置，不发起调用。

#### Scenario: 配置后重跑可用

- **WHEN** 用户填写 baseURL/apiKey/model 并保存
- **THEN** apiKey 以加密形式存在于数据目录，重跑使用该配置发起真实调用

#### Scenario: 未配置时提示

- **WHEN** 尚未配置运行参数即点击重跑
- **THEN** 界面提示先完成运行配置，不发任何网络请求

### Requirement: fork 的 config 与父 run 同源

发起分叉时，系统 SHALL 使用与父 run 相同的 system prompt 与工具表（config_hash 一致）执行重跑；若用户修改了运行配置中的系统提示或工具而 config_hash 不再匹配，SHALL 拒绝并提示"源码变化不属于时间旅行"。

#### Scenario: 同源重放

- **WHEN** 运行配置与父 run 同源（未改 system prompt/工具）
- **THEN** 重跑正常执行，fork run 的 config_hash 与父一致

#### Scenario: 异源拒绝

- **WHEN** 运行配置的 system prompt 与父 run 不同
- **THEN** runs:fork 返回 config_hash 不一致错误，不产生新 run

### Requirement: 上下文预算地图从 spans 现算并联动选择

选中任一 run 后，系统 SHALL 呈现其上下文预算地图：沿 `llm.call` 的调用次序累计 token（in+out）形成趋势曲线；当该 run 的 meta 含 `budget.max_total_tokens` 时 SHALL 以参考线标出预算上限；当 run 以 `budget_exceeded` 终止时 SHALL 在超限点标注。曲线数据 SHALL 全部从 spans 现算派生，SHALL NOT 持久化任何缓存，SHALL NOT 发起任何 LLM 调用。曲线上的数据点 SHALL 可被选中，并联动详情面板的 `selectedSpanId`（选中对应 llm.call 详情）。

#### Scenario: 预算地图与聚合一致

- **WHEN** 打开一个含 3 次 llm.call、每次 usage 合计 1000 token 的 run，其 meta 含 `budget.max_total_tokens = 3000`
- **THEN** 地图呈现 3 个数据点，累计值依次为 1000 / 2000 / 3000，参考线标于 3000，全程无任何网络请求

#### Scenario: 选中数据点联动详情

- **WHEN** 用户点击地图上第 2 个数据点
- **THEN** 详情面板选中并展示对应第 2 次 llm.call 的完整请求与响应

#### Scenario: 超限终止被标注

- **WHEN** run 以 `budget_exceeded` 结束且累计已超过参考线
- **THEN** 地图在超限点呈现显著标记（如底色/图标），与 `budget_exceeded` 终止原因一致

#### Scenario: 无预算信息的老文件

- **WHEN** run 的 meta 无 `budget` 字段
- **THEN** 地图照常绘制累计趋势，仅不显示参考线，不报错、不臆造预算值

### Requirement: tool_result 编辑提供代码级编辑器

编辑 `tool.invoke.result` 的输入控件 SHALL 支持多行编辑、等宽字体、语法高亮（按内容自动识别 JSON / 普通文本），并随内容长度可滚动；其应替换原有单行/纯文本输入体验。该编辑器 SHALL 为懒加载资源，仅在用户进入编辑态时加载，纯浏览路径不加载编辑器资源。编辑的提交 SHALL 完全复用既有 `runs:fork` 通道与请求体（`edit.field = "result"`），不改变分叉语义、校验或错误处理。

#### Scenario: 编辑态才加载编辑器

- **WHEN** 用户选中一个 `tool.invoke` span 但未进入编辑
- **THEN** 不加载编辑器资源；点击"在此重跑"进入编辑态时才加载

#### Scenario: 编辑提交走既有 fork 通道

- **WHEN** 用户在编辑器内修改 result 并确认重跑
- **THEN** 产生与 textarea 版本完全一致的 `runs:fork` 请求（`{ parentRunId, atSpanId, edit: { field: "result", value } }`），空编辑（前后相同）依旧被拒绝

#### Scenario: 长文本可滚动编辑

- **WHEN** result 内容超过面板可视高度
- **THEN** 编辑器内可滚动查看与编辑完整内容，无截断、无折叠导致的丢失

### Requirement: 代理设置与运行状态可观测可控

设置对话框 SHALL 增加代理区：启用开关、监听端口（默认 18787）、upstream base\_url（默认 `https://api.deepseek.com`）。应用界面 SHALL 有代理运行状态指示（运行中含端口）。启用/停用 SHALL 即时生效并反馈结果（端口占用等错误可见）。状态指示 SHALL 包含「本会话是否已捕获 key」（不含 key 值本身）。

#### Scenario: 启用代理

- **WHEN** 用户在设置中打开代理开关并保存

- **THEN** 状态指示变为运行中（显示端口 18787），用户可立即把应用的 base\_url 指过来

#### Scenario: 端口占用可见

- **WHEN** 保存启用但端口被占用

- **THEN** 设置界面呈现明确错误，开关回到停用态

#### Scenario: key 捕获状态

- **WHEN** 代理运行中但本会话尚无任何请求经过

- **THEN** 状态指示标明「未捕获 key」，重发功能预期不可用的状态与之一致

### Requirement: run 列表标注录制来源并可过滤

run 列表 SHALL 为代理录制的 run（meta 含 `source.kind="proxy"`）显示来源徽标，SHALL 提供来源过滤（全部 / 仅代理 / 仅本地直录）。无 `source` 字段的老文件 SHALL 归入「本地直录」，不报错。

#### Scenario: 徽标与过滤

- **WHEN** 列表同时含 3 个代理 run 与 2 个 SDK 直录 run，用户选择「仅代理」

- **THEN** 列表仅显示 3 个带代理徽标的 run；选择「全部」恢复 5 个

#### Scenario: 老文件无来源

- **WHEN** 列表含无 `source` 字段的老 run

- **THEN** 归入「本地直录」且无徽标，不报错

### Requirement: proxy fork 的分支视图降级为父链列表

`resolveBranch` SHALL 保持原样（纯拼接、不应用编辑、不加 proxy 形态分支）。对经 `proxy:fork` 产生的 run（`fork.edit.field="messages"`），分支/时间线视图 SHALL 降级呈现为「父链列表」：按 parent 链从根到当前列出各代 run（每项含 task 来源、fork.edit 摘要——被编辑的第几条消息），点击可切换查看对应 run 详情。SHALL NOT 把编辑前后的两个 llm.call 拼进同一条时间线假装成一次连续运行（编辑生效点不可见即诚实缺省）。既有 replay 分叉（`fork.edit.field="result"`）的分支呈现 SHALL 完全不变。

#### Scenario: proxy fork 用父链列表查看

- **WHEN** 用户选中 r\_proxy02（parent 指向 r\_proxy01，fork.edit.field="messages"）

- **THEN** 分支区显示 r\_proxy01 → r\_proxy02 的父链列表（r\_proxy02 项标注「已编辑 messages」），点击 r\_proxy01 可查看其详情；不存在把两个 llm.call 混排的合并时间线

#### Scenario: replay 分叉呈现不变

- **WHEN** 用户选中既有 `fork.edit.field="result"` 的 run

- **THEN** 分支呈现与 Spec #4 行为完全一致（共享前缀 + 新增 span 的时间线）

### Requirement: 代理 run 的 llm.call 可编辑 messages 重发

代理 run 的 `llm.call` 详情 SHALL 提供「编辑重发」入口：编辑器（Monaco，懒加载，复用既有编辑器加载机制）呈现 `request.messages` 全文（JSON），提交时走新通道 `proxy:fork`（含源 run id、源 llm.call span id、编辑后 messages）。未修改 SHALL 禁用提交（空 fork 防线）；本会话未捕获 key SHALL 呈现明确指引（先把应用经代理跑一次）而非灰按钮无解释。重发确认处 SHALL 明示「将真实调用 upstream 并产生 API 费用」。成功后 SHALL 重载 run 列表并自动选中新 fork run；失败（upstream 报错等）SHALL 呈现错误详情且源 run 不受影响。

#### Scenario: 编辑并重发成功

- **WHEN** 用户在编辑器中修改 messages 的一条内容并确认重发

- **THEN** 经 `proxy:fork` 产生新 run（parent/ fork.edit 如 llm-proxy spec），列表出现新 run 且被自动选中，详情可见新响应

#### Scenario: 未修改禁用

- **WHEN** 编辑器内容与原始 messages 逐字节一致

- **THEN** 提交按钮禁用，无任何网络请求

#### Scenario: 未捕获 key

- **WHEN** 本会话代理未捕获任何 key 时用户点击重发

- **THEN** 呈现明确提示「本会话未捕获到 key，请先把你的应用经代理跑一次」，不发起请求

#### Scenario: SDK run 无此入口

- **WHEN** 选中一个非代理 run 的 `tool.invoke` 或 `llm.call`

- **THEN** 既有 ForkEditor（tool.result 编辑重跑）行为不变；messages 编辑重发入口不出现（分叉语义属 replay 路径，本变更不越界）

### Requirement: run 列表载荷暴露 fork 摘要

run 列表的每条记录 SHALL 携带该 run 的分叉摘要：`fork: { at_span, edit_field } | null`（根 run 与老文件为 `null`）。摘要 SHALL 只含分叉点 span id 与被编辑字段名，SHALL NOT 携带被编辑的值（value 可能是整段工具结果或完整 messages，列表载荷不需要，也不得因此放大跨进程数据量）。该字段为向后兼容新增——不含该字段的旧载荷 SHALL 被按「无分叉摘要」处理，不报错。

#### Scenario: 分支 run 带摘要

- **WHEN** run B 的 `meta.fork` 为 `{ at_span: "s_03", edit: { field: "result", value: "…" } }`
- **THEN** 列表载荷中 B 的 fork 摘要为 `{ at_span: "s_03", edit_field: "result" }`，不含 value

#### Scenario: 根 run 与老文件

- **WHEN** run 为根 run（`parent` 为 null、`fork` 为 null）
- **THEN** 其 fork 摘要为 `null`，不臆造分叉信息

### Requirement: 界面提供分支树与轨迹两种视图

header SHALL 提供「分支树 / 轨迹」视图切换入口。切到分支树时，主区域 SHALL 呈现分支树视图（全宽），切回轨迹视图时 SHALL 恢复既有三栏（列表 / span 树 / 详情）。两种视图 SHALL 共享同一份 run 列表数据与同一个选中 run 状态——在分支树里点选的 run，切回轨迹视图后仍是被选中的那个，反之亦然。视图切换 SHALL NOT 触发列表重新加载。

#### Scenario: 切到分支树

- **WHEN** 用户在 header 点击「分支树」
- **THEN** 主区域切换为分支树视图，已有 run 列表数据直接复用，不重新读取磁盘

#### Scenario: 选中状态跨视图保持

- **WHEN** 用户在分支树视图点选 run B，然后切回轨迹视图
- **THEN** 轨迹视图呈现 B 的 span 树与详情，无需用户再次选择

#### Scenario: 切换不重载

- **WHEN** 用户在两视图间来回切换
- **THEN** 列表数据不发生第二次加载（无重复 IO），失败文件条目同样保持

### Requirement: 调试台提供启动 prompt 的单变量编辑入口

SDK / agent-loop run 的详情 SHALL 从首次 llm.call 请求中展示可编辑的 system prompt 与首条 user message。一次操作 SHALL 只允许编辑其中一项；无字符串 system 消息时整个 prompt fork SHALL 禁用，因为无法重建 RunConfig.systemPrompt。proxy run SHALL 继续显示既有 messages 重发入口，不显示 prompt replay 入口。

#### Scenario: 编辑前确认真实计费

- **WHEN** 用户修改一项启动 prompt 并准备提交
- **THEN** 界面明确提示“从头重跑，将真实调用模型并计费”“父 run 不会修改”，并在用户确认后才发起写通道

#### Scenario: system prompt 不可还原

- **WHEN** 首次 llm.call 没有字符串 system 消息
- **THEN** system prompt 与 user message 编辑入口均不可用并说明原因，界面不以 config_hash、桌面设置或空字符串填充伪值

### Requirement: prompt fork 详情呈现独立新轨迹与父级溯源

prompt fork 的详情 SHALL 呈现当前 run 自身的完整 spans，并单独列出父级 chain 与编辑字段。界面 SHALL 使用“从头重跑”描述该关系，SHALL NOT 显示“共享前缀”或把 fork.at_span 当作普通中间分叉点展示。

#### Scenario: 不混排父子轨迹

- **WHEN** prompt fork 的父 run 与子 run 都从 agent.step 1 开始
- **THEN** 子详情只出现子 run 自身的 step 1 及后续 spans，父 run 的旧路径不进入时间线

### Requirement: 桌面端提供原生 run 创建入口

系统 SHALL 提供"新建运行"入口，允许用户直接在桌面端创建并执行一个 run，无需依赖代理录制或外部脚本。入口 SHALL 位于 run 列表标题区，点击后弹出对话框。对话框 SHALL 包含：

- **System Prompt**（多行文本框，可选，缺省为空字符串）
- **User Message**（多行文本框，必填）

提交后系统 SHALL 通过 `runs:create` 通道执行：main 侧读取运行配置（baseURL / apiKey / model），组装空工具表的 `RunConfig`，以"system（内容可为空串）+ user"两条初始消息调用 `runLoop`。产出的 run SHALL 为根 run（`meta.parent` 为 `null`、`meta.fork` 为 `null`）、SHALL 不含 `source` 字段（与 SDK 直录 run 同形，归入列表的「本地直录」类别）、`meta.task` SHALL 等于 userMessage、`meta.config_hash` SHALL 与 `configHash(systemPrompt, [])` 逐字节相等。run 文件的文件名 SHALL 等于 `meta.id`。系统 SHALL 仅在运行结束后把该文件按 `meta.id` 归位，SHALL NOT 让执行中的半成品以任何形式出现在 run 列表中。成功后 SHALL 刷新 run 列表并自动选中新 run。

#### Scenario: 新建 run 成功

- **WHEN** 用户填写 systemPrompt 和 userMessage 并点击"创建"
- **THEN** 系统创建新 run，run 出现在列表中并被自动选中；run 的 `meta.parent` 为 `null`、`meta.fork` 为 `null`、`meta.task` 等于 userMessage、`meta.config_hash` 与 `configHash(systemPrompt, [])` 逐字节相等，且其文件名等于 `meta.id`

#### Scenario: 新建 run 作为父本进行 prompt fork

- **WHEN** 用户对新建的 run 发起 prompt fork（编辑 system prompt 或 user message）
- **THEN** fork 正常执行，子 run 的 `meta.parent` 指向该新建 run，fork 元数据与既有引擎父本产物的形状一致

#### Scenario: 新建 run 作为父本进行模型 A/B

- **WHEN** 用户对新建的 run 发起模型 A/B 实验（两个不同 model/params 的 arm）
- **THEN** 每个 arm 独立执行，各臂 run 的 `meta.parent` 指向该新建 run，各臂 `config_hash` 与父 run 一致

#### Scenario: 新建 run 作为父本进行 trace-test

- **WHEN** 用户对新建的 run 发起 trace-test
- **THEN** trace-test 正常执行，测试该 run 的可重放性

#### Scenario: settings 未配置时拒绝

- **WHEN** 用户未配置 baseURL / apiKey / model 即点击"创建"
- **THEN** 系统在发起任何网络请求前拒绝，返回 `SETTINGS_NOT_CONFIGURED` 错误，界面提示"请先在设置中配置运行参数"

#### Scenario: userMessage 为空时禁用提交

- **WHEN** 对话框中 userMessage 为空
- **THEN** "创建"按钮禁用，无网络请求

#### Scenario: 空 systemPrompt 允许

- **WHEN** 用户未填写 systemPrompt（留空）
- **THEN** 系统允许创建，run 的 `config_hash` 按 `configHash("", [])` 计算

#### Scenario: 执行失败不产生半成品

- **WHEN** 模型调用失败（`runLoop` 以 `errored` 终止事件收尾）
- **THEN** 该 run 的文件仍按 `meta.id` 归位，且 run 列表 SHALL 被重新拉取使该 run 可见/可选中（列表徽标显示终止原因为"出错终止"；`status` 仍为 `completed`——该字段只表示"是否含终止事件"）；IPC SHALL 返回 `CREATE_RUN_FAILED` 与中文提示，提示 SHALL 引导用户点开该 run 查看错误详情（trace 已记录调用级错误原因），SHALL NOT 再把"看应用主进程日志"作为唯一出路；SHALL NOT 留下任何非 `.jsonl` 的临时文件被列表读到

### Requirement: 缓存命中可视化

llm.call 详情的 usage 区 SHALL 在 `usage.cache_hit` **存在**（`!== undefined`，**`0` 属存在**）时展示缓存命中：命中 tokens、占输入（`usage.in`）的比例，并以视觉强调区分「命中为主」与「全量计费」（着色或同等的直观区分），让用户一眼看出该次调用的前缀是否省钱。判据 SHALL NOT 使用 truthiness——`cache_hit: 0` 恰是"本次全量计费"，SHALL 照常展示（这是最该被看见的一态）。`usage.in` 为 0 时 SHALL 只展示绝对 tokens、不做除法。字段缺失时 SHALL 降级省略展示，SHALL NOT 以 0 或推断值冒充。

run 级的累计缓存命中 SHALL 由共享派生层从**当前 run 文件自有的**各 llm.call 的 usage 现算（不含祖先共享前缀的调用；沿既有「聚合数字从 spans 现算」纪律，不持久化缓存），并 SHALL 在 run 列表条目与既有 token 合计同行展示；无任何命中数据时 SHALL NOT 展示（未知 ≠ 0）。

**仅 tool_result 分叉**（即共享前缀、缓存提示才有意义的唯一形态）的确认编辑器 SHALL 在当前运行配置的 `model` 与父 run 录制的 `model` 不一致时给出信息性提示（缓存可能不命中、计费口径可能变化）；该提示 SHALL NOT 拦截或改变 fork 的既有门禁，prompt fork 与代理 messages 分叉 SHALL NOT 加此提示。

#### Scenario: llm.call 详情展示缓存命中

- **WHEN** 选中一次 `usage` 含 `cache_hit: 800`、`in: 1000` 的 llm.call
- **THEN** usage 区展示缓存命中 800 tokens（占比 80%）并以直观视觉强调命中为主

#### Scenario: 零命中仍展示为全量计费

- **WHEN** 选中一次 `usage` 含 `cache_hit: 0`、`in: 1000` 的 llm.call（DeepSeek 未命中时的常规返回）
- **THEN** usage 区展示缓存命中 0 tokens，并以视觉强调「全量计费」（SHALL NOT 因 `0` 为假值而省略该行）

#### Scenario: 少量命中不得被称为全量计费

- **WHEN** 选中一次 `usage` 含 `cache_hit: 128`、`in: 323` 的 llm.call（实测真机数据）
- **THEN** 展示 128 / 323（40%）与 miss 195，措辞表明"部分命中、多数输入仍按全价计费"，SHALL NOT 写成"全量计费"（命中即已省钱，措辞不得夸大成本）

#### Scenario: 无缓存字段的调用降级

- **WHEN** 选中一次 usage 无 `cache_hit` 的 llm.call（老 trace 或不支持缓存的 provider）
- **THEN** usage 区不展示缓存命中行，不报错、不显示 0

#### Scenario: run 级累计现算

- **WHEN** 打开一个含 3 次 llm.call（其中 2 次带 `cache_hit`）的 run
- **THEN** run 列表条目中的累计缓存命中等于 2 次 `cache_hit` 之和（只算当前 run 文件自有 spans），随数据变化即时反映，无持久化缓存参与

#### Scenario: fork run 的累计不含祖先前缀

- **WHEN** 打开一个 fork run，其展开轨迹含祖先共享前缀中带 `cache_hit` 的 llm.call
- **THEN** run 级累计缓存命中只统计本 run 新增的 llm.call，祖先前缀调用的命中不计入（展开视图中它们各自的单 span 详情照常展示自己的缓存命中）

#### Scenario: tool_result 分叉的模型不一致提示

- **WHEN** 用户在 tool_result 分叉编辑器（「在此重跑」）中，运行配置的 model（如 deepseek-chat）与父 run 在该 step 录制的 model（如 glm-flash）不一致
- **THEN** 编辑器显示缓存可能不命中的信息性提示，用户仍可确认执行 fork，既有校验与执行路径不变；模型一致时 SHALL NOT 显示该提示

#### Scenario: 其它分叉形态不加缓存提示

- **WHEN** 用户打开 prompt fork 编辑器或代理 messages 分叉入口
- **THEN** 界面 SHALL NOT 出现模型缓存提示（这些形态不共享前缀，提示无意义）

### Requirement: 失败 LLM 调用的标记与错误详情

轨迹树中 SHALL 对记录到失败的 `llm.call` 节点给出错误标记（与工具错误同等醒目），判据 SHALL 为 `error !== undefined`（`null` 非法）；工具节点的判据仍是 `error !== null`——两者 SHALL 先按 `kind` 缩窄类型再判定，SHALL NOT 套用统一的"非 null 即错误"。字段缺省的 LLM 节点 SHALL NOT 被标注为失败（未记录详情不等于成功，但界面 SHALL NOT 因此猜造失败）。

选中失败调用时，详情面板 SHALL 在概要区之后展示错误原因（`error.message`，长文本可换行或滚动，窄窗口下 SHALL NOT 遮挡请求与操作区），并在 `error.status` 存在时展示该 HTTP 状态码。错误详情区 SHALL 显式声明该次调用的 tokens / 首 token 延迟为**占位零值**，不代表实际零消耗或零延迟。失败调用 SHALL 仍可查看完整原始请求。

响应正文为空时的文案 SHALL 按情形区分，SHALL NOT 一律显示"仅有工具调用"：调用失败时 SHALL 说明调用失败、无响应正文；确有 `tool_calls` 时说明仅有工具调用；仅思维链成功响应 SHALL 说明仅有思维链；其余空正文 SHALL 说明响应为空正文。

#### Scenario: 失败节点被标记且可读原因

- **WHEN** 打开一个含失败 `llm.call`（`error.message` 非空、`status` 为 401）的 run 并选中该节点
- **THEN** 轨迹树该节点带错误标记；详情展示错误原因与 `HTTP 401`，并提示 tokens / 首 token 延迟为占位零值

#### Scenario: 工具错误与 LLM 错误判据不混用

- **WHEN** 同一轨迹内存在四种节点：LLM 带 `error`、LLM 无 `error`、工具 `error` 为字符串、工具 `error` 为 `null`
- **THEN** 仅 LLM 带 `error` 与工具 `error` 为字符串的两个节点被标为错误，另外两个不标

#### Scenario: 无状态码的失败不展示状态码

- **WHEN** 选中一个 `error` 只含 `message`（无 `status`）的失败调用
- **THEN** 只展示错误原因，SHALL NOT 展示任何状态码、SHALL NOT 以 0 冒充

#### Scenario: 空响应文案按情形区分

- **WHEN** 依次打开四类空正文调用：失败调用、成功且含 `tool_calls`、成功且仅有 `reasoning_content`、成功且三者皆空
- **THEN** 依次显示"调用失败，无响应正文"、"无正文，仅有工具调用"、"无正文，仅有思维链"、"响应为空正文"

#### Scenario: 失败调用仍可查看原始请求

- **WHEN** 选中一个失败调用
- **THEN** 请求消息、工具表与采样参数照旧完整可读，错误详情不与请求区重叠遮挡

### Requirement: 错误详情缺失的诚实提示

当运行的终止原因为 `error` 但**本 run 自身**的 spans 中不存在任何带 `error` 的 `llm.call` 时，界面 SHALL 在运行上下文处显示"错误详情未记录"的提示，并说明这是未记录（而非无错误）。

该判定 SHALL 由共享派生层的纯函数完成，只检查以 `RunDetail.leafSpanIds` 过滤后的 spans；SHALL NOT 直接扫描祖先合并后的整条轨迹——祖先的失败记录 SHALL NOT 冒充本次失败原因，也 SHALL NOT 因此隐藏本 run 的缺失提示。自身没有任何 `llm.call` 的代理失败 run（`meta.source.kind === "proxy"`）同样 SHALL 显示该提示。非错误终止的运行 SHALL NOT 显示该提示，且界面 SHALL NOT 根据空正文、零 token 或末尾 `llm.call` 猜造失败原因或标错历史调用。

#### Scenario: 错误终止且本 run 无详情

- **WHEN** 打开一个 `reason` 为 `error`、其自身 spans 内所有 `llm.call` 都无 `error` 字段的 run
- **THEN** 运行上下文显示"错误详情未记录"，成功 run 上不出现该提示

#### Scenario: 本 run 有详情时不显示缺失提示

- **WHEN** 打开一个错误终止且自身某次 `llm.call` 带 `error` 的 run
- **THEN** 不显示"错误详情未记录"（详情由失败节点自身展示）

#### Scenario: 祖先有错误不冒充本次原因

- **WHEN** 打开一个分支 run：其合并轨迹中祖先段落存在带 `error` 的 `llm.call`，而该 run 自身 `leafSpanIds` 覆盖的 spans 无 `error`，且终止原因为 `error`
- **THEN** 仍显示"错误详情未记录"（祖先的失败不计入本次判定）；同时轨迹树中祖先的失败节点照旧按自身 `error` 标记，不被隐藏

#### Scenario: 代理失败 run 同样提示缺失

- **WHEN** 打开一个代理录制的失败 run（无任何 `llm.call` span，终止原因为 `error`）
- **THEN** 显示"错误详情未记录"，SHALL NOT 报错、SHALL NOT 编造原因
