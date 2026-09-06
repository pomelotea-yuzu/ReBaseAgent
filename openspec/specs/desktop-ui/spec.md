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

系统 SHALL NOT 提供任何写入、修改或删除 trace 文件的通道；界面呈现的 span 与 messages SHALL 为文件原样内容，不做采样或截断（长内容用折叠而非丢弃）。`runs:fork` 是本系统唯一的例外写通道：它 SHALL 只**新建** fork run 文件，SHALL NOT 修改或删除任何既有文件，且 SHALL 仅在用户显式编辑并确认后触发。

#### Scenario: 浏览过程无写入

- **WHEN** 用户浏览任意 run 的全部 span 与详情
- **THEN** 除用户显式提交分叉重跑外，接口集合不含任何写类方法，trace 文件不被创建、修改或删除

#### Scenario: 超长消息

- **WHEN** 某条消息内容超过一屏
- **THEN** 内容默认折叠并可展开，展开后为完整原文，无截断省略

#### Scenario: 分叉不触碰既有文件

- **WHEN** 用户对某 run 发起分叉重跑并完成
- **THEN** 仅新增一个 fork run 文件；父 run 与其余文件内容逐字节不变

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

系统 SHALL 提供 `runs:fork` 写通道：请求体 = `{ parentRunId, atSpanId, edit: { field, value } }`，main 侧加载父 run、校验可重放性、执行重跑，返回新 run id。该通道 SHALL 是 renderer 侧唯一能触发文件写入的方法，且每个请求 SHALL 携带用户明确选择的 `atSpanId` 与编辑值（不允许无编辑的"空 fork"）。浏览、列表、详情等既有路径保持零写能力。

#### Scenario: 编辑 tool_result 并重跑

- **WHEN** 用户在详情面板选中一个 `tool.invoke` span，编辑其 result 并确认重跑
- **THEN** 界面出现进行中状态；完成后列表刷新并自动选中新 run（分支 run 经 resolveBranch 展示合并轨迹，分叉点被标注）

#### Scenario: 非法请求被拒绝

- **WHEN** atSpanId 不存在、父 run 未封存、或编辑字段非 result
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
