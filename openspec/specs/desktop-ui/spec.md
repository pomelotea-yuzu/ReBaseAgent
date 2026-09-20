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

系统 SHALL NOT 提供修改或删除既有 trace 的通道；span/messages SHALL 为文件原样内容，长内容用折叠而非丢弃。既有显式执行入口保持授权要求；本次扩展的 `runs:create` / `runs:fork` 在隔离模式下 SHALL 只新增本次 trace 和不可变文件附件，不修改源目录、父/兄弟运行及已有附件。目录选择、轨迹浏览和隔离能力预检 SHALL 为只读，不触发运行或补写快照；本阶段不要求文件视图。

#### Scenario: 浏览过程无写入
- **WHEN** 用户浏览 run 轨迹、执行隔离能力预检，或打开/取消源目录选择器
- **THEN** 不创建 trace/blob，不修改或删除既有文件，不请求 LLM

#### Scenario: 超长消息
- **WHEN** 某条消息内容超过一屏
- **THEN** 内容默认折叠并可展开，展开后为完整原文，无截断省略

#### Scenario: 分叉不触碰既有文件
- **WHEN** 用户显式提交并完成普通或隔离分叉
- **THEN** 新增 fork run；隔离模式只另增必要内容附件，父 run、源目录、兄弟文件及已有附件逐字节不变

#### Scenario: 新建运行不触碰既有文件
- **WHEN** 用户提交新建运行并正常完成或以 LLM error 封存
- **THEN** 新 trace 文件名等于 meta.id；隔离模式可另增内容附件，其他 run 和源目录不变；本次临时 trace/blob 清理，半成品不被列为可恢复快照

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

本 requirement 约束既有 `runs:fork` 和 `runs:create` 两条通道的扩展；其余已定义执行入口仍按各自 spec 授权，不因本 change 获得隔离执行能力。`runs:fork` SHALL 接收明确 parentRunId、atSpanId 和 `{field:"result",value}`；隔离父本 SHALL 另要求 `execution:{mode:"isolated_files",allowFileWrites:true}`，漏传或类型不匹配 SHALL 拒绝。`runs:create` SHALL 接收 systemPrompt 和非空 userMessage，可选 `workspace:{mode:"isolated_files",sourceToken,allowFileWrites:true}`。未提供 workspace 时保留空工具表纯对话行为。SHALL NOT 接收 renderer 提供的 handler、物理存储路径或配额覆盖值。

#### Scenario: 编辑 tool_result 并重跑
- **WHEN** 用户编辑一个合法 tool.invoke 的 result 并确认
- **THEN** 显示进行中状态，结束后列表刷新并选中新 run；隔离模式的确认与展开同时反映编辑位置和整轮续跑边界

#### Scenario: 非法请求被拒绝
- **WHEN** atSpanId 不存在、父未封存、字段非 result、userMessage 为空，或隔离模式缺授权/sourceToken 无效
- **THEN** 返回可操作的信封错误，不创建运行、不请求 LLM；隔离父本不降级普通执行

#### Scenario: 空 fork 被拒绝
- **WHEN** 用户未修改编辑值即提交
- **THEN** 拒绝空 fork，不创建运行或请求 LLM

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

系统 SHALL 在运行列表标题区提供新建对话框，包含可空 System Prompt 与必填 User Message，并以分段控件选择默认“纯对话”或“隔离文件运行”。纯对话 SHALL 继续使用空工具表；隔离模式 SHALL 提供原生目录选择和显式副本写入复选框，显示采集范围及工具读取内容进入已配置模型请求的事实。未选目录或未授权 SHALL 禁用隔离提交；main SHALL 重复校验。

提交后 SHALL 经 runs:create 读取 settings，从 system+user 消息创建根 run，parent/fork 为 null，不写 source，task 等于 userMessage。纯对话 config_hash SHALL 等于 `configHash(systemPrompt,[])` 且产出 v1；隔离模式 SHALL 按固定 profile 工具表计算指纹并产出带检查点的 v2。执行中的临时 trace SHALL 不出现在列表；结束后文件名等于 meta.id，成功刷新并选中新 run。

#### Scenario: 新建 run 成功
- **WHEN** 用户填写 systemPrompt 和 userMessage，按默认纯对话模式点击创建
- **THEN** 新 run 可选中，parent/fork 为 null，task 等于 userMessage，config_hash 按空工具表计算，文件名等于 meta.id

#### Scenario: 新建 run 作为父本进行 prompt fork
- **WHEN** 用户对新建的纯对话 run 发起 prompt fork
- **THEN** fork 正常执行，子 parent 指向该根运行，既有 prompt fork 行为不变

#### Scenario: 新建 run 作为父本进行模型 A/B
- **WHEN** 用户对新建的纯对话 run 发起两个模型实验 arm
- **THEN** 各臂独立运行，parent 指向新建 run，config_hash 与父一致

#### Scenario: 新建 run 作为父本进行 trace-test
- **WHEN** 使用匹配工具声明对新建 run 做 Trace-as-Test
- **THEN** 卡带正常重跑；隔离 run 的卡带仍是录制结果与桩工具，不访问真实文件世界

#### Scenario: settings 未配置时拒绝
- **WHEN** 未配置 baseURL/apiKey/model 即提交
- **THEN** 在导入写入和模型请求前返回 SETTINGS_NOT_CONFIGURED，提示先配置运行参数

#### Scenario: userMessage 为空时禁用提交
- **WHEN** User Message 为空
- **THEN** 创建按钮禁用，无网络请求

#### Scenario: 空 systemPrompt 允许
- **WHEN** System Prompt 留空且其余条件有效
- **THEN** 允许创建，纯对话指纹按空字符串和空工具表计算；隔离模式按空字符串和固定工具组计算

#### Scenario: 执行失败不产生半成品
- **WHEN** LLM 失败并由 runLoop 以 errored 封存
- **THEN** 文件按 meta.id 归位，列表刷新使失败运行可见，status 仍表示已封存；IPC 返回 CREATE_RUN_FAILED 并引导查看详情，已记录隔离检查点数据完整保留且轨迹可读，临时文件不出现在列表

#### Scenario: 直接创建隔离文件父本
- **WHEN** 用户选择受支持源目录、勾选副本写入并提交隔离模式
- **THEN** 生成 v2 根运行，详情可阅读轨迹和来源；从原始 trace 验证初始与各轮检查点已记录，源目录字节不变，后续可编辑工具结果发起隔离分叉；不要求文件页

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

### Requirement: 隔离执行边界在操作前可辨认

系统 SHALL 对隔离运行明确标注文件隔离，并在 result 编辑提交前显示父运行、选中工具、续跑轮末检查点、真实模型调用及副本写入授权。未满足检查点/profile/附件条件时 SHALL 禁用并显示原因。旧 trace SHALL NOT 显示为已恢复文件状态；隔离父本的 prompt fork/A-B SHALL 禁用。错误不能只靠颜色表达，执行中不得重复提交。

轮号 SHALL 使用所属 run 原始 `agent.step.n`，并与该 run 身份及 step span 定位一起呈现；SHALL NOT 使用合并轨迹索引或沿链累计轮数冒充本地轮号。确认区 SHALL 指明直接父 run，子运行的来源说明 SHALL 明确父 run 身份。

#### Scenario: 多工具轮次确认
- **WHEN** 用户编辑直接父 run B 的本地第 N 轮首个工具结果，而该轮有其他工具
- **THEN** 确认区显示“从运行 B 的第 N 轮结束后继续”及 step span 定位，同轮工具不重做；提交后子运行前缀中这些工具各显示一次

#### Scenario: 二次分叉轮号不沿链累加
- **WHEN** 根 run A 已有 3 轮，从子 run B 的本地第 1 轮再分叉生成 C
- **THEN** 确认区和 C 的来源说明指向“运行 B 的第 1 轮”及其 span；不得将其标作第 4 轮或 C 的第 1 轮

#### Scenario: 历史运行和缺附件降级
- **WHEN** 查看无检查点旧 run 或附件不可用的隔离 run
- **THEN** 轨迹可阅读，隔离按钮显示对应不可用原因，不提供“使用当前目录冒充历史快照”的自动兜底

#### Scenario: 隔离父本的其他真执行入口
- **WHEN** 用户查看隔离父本的 prompt fork / A-B 操作
- **THEN** 显示本期不支持该执行方式；即使绕过 UI 发 IPC，也在 main/core 拒绝

#### Scenario: 每次桌面操作独立确认写入
- **WHEN** 父 trace 带 write_authorized:true，用户重新打开创建或隔离分叉确认，或直接提交缺 allowFileWrites 的 IPC
- **THEN** 本次副本写入复选框默认未选，必须本次显式确认；main 拒绝缺授权请求，不从历史记录补授权，零新运行和模型调用

#### Scenario: 创建与确认在窄窗口可操作
- **WHEN** 使用窄窗口和长源路径打开隔离创建或分叉确认
- **THEN** 路径、来源、轮末边界、授权和提交状态可读且不遮挡，可滚动或换行，错误不只靠颜色表达

### Requirement: 隔离详情 IPC 保留数据并校验版本

系统 SHALL 在 RunRecord/RunDetail 的原始输入进入 schema 转换前复用 trace-sdk 的版本禁字段 helper。v1 自有 workspace、fork.resume_after_step、span.workspace_snapshot 即使值为 null/false/空对象或内存 undefined 也 SHALL 拒绝；SHALL NOT 泛化 strict 或递归搜索业务内容同名字段。合法 v2 的 workspace、快照、fork 边界及祖先来源 SHALL 完整往返；校验 SHALL 根据记录所属 run 版本进行，不把祖先元数据遗漏。纯轨迹解析 SHALL 不读取 blob，附件不可用不影响合法 JSONL 的轨迹展示。

#### Scenario: 详情 IPC 快照往返
- **WHEN** 合法 v2 根及分支的初始、空清单和完成步骤快照经 main/preload/renderer 加载
- **THEN** 路径、哈希、来源、边界和所属 run 完整保留；消息、步骤语义顺序不变，缺附件仍可浏览轨迹

#### Scenario: 详情 IPC 拒绝 v1 隔离字段
- **WHEN** v1 RunRecord/RunDetail 原始输入或祖先 meta 带隔离字段，另有不相关扩展和业务正文同名字段的对照
- **THEN** 前者在转换前按属性存在性拒绝，后者保持既有兼容行为；不以字段 truthiness 判定，不丢字段后继续显示或执行

#### Scenario: 真实列表扫描完整且只读
- **WHEN** 对 1/10/50 run 的合法短路径、长 ASCII/中文路径 fixture 和 v1 对照执行实际 listRuns
- **THEN** 每份 trace 完整校验，列表的步骤、用量、状态与完整读取派生一致，不读 blob、不写缓存或修改 trace；记录环境、字节量、首次进程/重复扫描耗时及峰值内存，不将其描述为已清空 OS 缓存或大规模即时刷新

### Requirement: 文件检查点和差异只读可查

在已交付隔离桌面详情 IPC 的基础上，详情 SHALL 提供文件视图，可选择本 run 初始状态或任一自有完成步骤。文件表 SHALL 显示路径、大小、相对初始快照的新增/修改状态及附件可用性；文本文件 SHALL 能并排比较初始与所选快照内容，二进制 SHALL 只显示可核对的大小/哈希。文件不存在、缺失和损坏 SHALL 明确区分，不渲染伪空文件。SHALL NOT 提供自动回写或应用到源目录的操作。

文件检查点选择器 SHALL 使用所属 run 原始 agent.step.n，并保留 ownerRunId/stepSpanId/localIteration；当前选择器显示“本 run 第 N 轮结束”，来源说明另标父 run，不按合并轨迹或沿链累加轮数。

只读通道 SHALL 走统一 IPC 信封和 zod：workspaces:inspect 接收 {runId,stepSpanId?}，省略 step 时取本 run 初始清单，指定 step 仅取本 run 自有完成步骤，返回路径/大小/相对初始新增或修改状态及附件可用性；workspaces:readFile 接收 {runId,stepSpanId?,path}，只读取该清单引用的内容，返回完整 UTF-8 文本或二进制/不存在/缺失/损坏状态。renderer SHALL NOT 指定物理附件路径或存储根。main SHALL 注入 dataDir 并调用 A 的包读取接口，沿用 B 的详情数据校验。所有检查和读取 SHALL 零 trace/blob 写入、零工具及 LLM 调用。

#### Scenario: 重启后查看文件差异
- **WHEN** 应用重启后打开完成的隔离子 run，选择一个完成步骤的修改文件
- **THEN** 从 trace 引用加载相应初始/当前文本，显示真实差异和步骤来源，全部操作零文件写入与零 LLM

#### Scenario: 文件读取 IPC 拒绝越权
- **WHEN** renderer 提交可穿越 tracesDir 的非法 runId、清单之外路径、祖先而非自有 step，或任意物理 blob 路径
- **THEN** 返回明确错误，不读取目标宿主文件，不以同名文件或其他快照替代

#### Scenario: 长文本及窄窗口
- **WHEN** 在代表性桌面和窄窗口中打开长路径、多文件及长文本差异
- **THEN** 路径和状态可读，列表/内容能切换或滚动，文本不覆盖提交和导航控件；二进制或缺失附件不触发文本比较

#### Scenario: 文件浏览过程无写入
- **WHEN** 用户浏览初始/完成步骤快照、切换文件或展开文本 diff
- **THEN** 不创建运行或附件、不补写清单、不修改源目录及已有数据、不请求 LLM；轨迹与文件视图切换保留当前 run 和步骤

#### Scenario: 初始与各轮文件快照可选择
- **WHEN** 打开隔离根运行或子运行的文件页
- **THEN** 可选择本 run 初始状态及各自有完成步骤，列表展示路径、大小、相对初始的新增/修改状态和附件可用性，不把祖先步骤当本 run 检查点

#### Scenario: 文件选择器轮号不沿链累加
- **WHEN** A 有 3 轮，子 B 的本地第 1 轮再生成 C，用户查看 B 或 C 的文件检查点
- **THEN** B 选择器使用“本 run 第 1 轮结束”并保留 B/step 定位，C 起点来源指向 B 第 1 轮；不标作全链第 4 轮或把父轮号标成 C 自有轮号

#### Scenario: 二进制和不可用附件分别显示
- **WHEN** 读取非 UTF-8 文件、清单外路径、缺失或损坏附件，或打开没有检查点的旧 run
- **THEN** 二进制只显示原大小/哈希；不存在、缺失、损坏、未录制检查点分别提示；不尝试有损文本比较，不回读源目录、不渲染伪空文件，合法轨迹仍可读

#### Scenario: 失败运行已记录文件可查看
- **WHEN** run 因后续 LLM 失败封存，但此前已记录初始或完成步骤快照
- **THEN** 可选择已记录检查点并读取完整文件事实；没有落盘的步骤不能伪造，失败不撤销历史写入或回写源目录

#### Scenario: 数据目录迁移后文件仍可查
- **WHEN** 包含 JSONL 和引用附件的数据目录整体移动后重新启动应用
- **THEN** 通过新的 dataDir 和 trace 相对引用读取真实初始/步骤文件差异，无需原 source 路径；只迁移 JSONL 时明确显示附件缺失且轨迹可读
