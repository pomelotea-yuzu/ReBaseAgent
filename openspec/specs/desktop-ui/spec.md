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

系统 SHALL 扫描 `<数据目录>/traces/*.jsonl`，对每个文件执行 `readRun`，按创建时间倒序展示运行。每条记录 SHALL 可查看任务名、模型、创建时间、真实终止状态、迭代步数、工具调用数、出错工具数、token 合计与已记录耗时；次级指标可展开，SHALL NOT 因紧凑布局丢失。列表 SHALL 使用已校验摘要，不为搜索和列表渲染逐条加载详情、不写持久汇总缓存。

状态 SHALL 同时考虑封存状态与终止原因：正常 `completed` 显示已结束，`error` 显示出错终止，`max_iterations`/`budget_exceeded` 显示具体限制，`aborted` 显示已中止，无终止事件的 `crashed` 显示运行中断。未知原因 SHALL 保留原值并标为未知，SHALL NOT 将已封存或无结束记录分别等同于成功或执行中。列表、概览及既有分支树节点 SHALL 使用一致的状态文字与语义色，失败使用红色、限制使用琥珀色，且不只靠颜色表达状态。

导航 SHALL 提供完整 task/ID 搜索和显式刷新。任务摘要仅在展示时折叠空白及限制两行；缺失或空白任务 SHALL 用来源、时间和短 ID 回退。模型 SHALL 使用记录原值，缺失时标为未记录，长名称可换行并访问全文。短 ID SHALL 在全部已加载记录中唯一，不随排序或筛选重新编号；发现新碰撞时延长，完整 ID 可复制和搜索。

刷新 SHALL 保留当前阅读位置和旧列表，合并重复在途请求；执行收尾期间需要更新时 SHALL 保证随后可获取新记录。刷新失败 SHALL 保留旧列表并提示未更新，首次失败 SHALL 提供重试。SHALL NOT 因视图切换或搜索触发磁盘扫描，SHALL NOT 高频轮询所有 trace。

#### Scenario: 多份 trace 文件

- **WHEN** 目录含 normal / tool-error / infinite-loop / branch 四份 run
- **THEN** 列表呈现四行，各自显示正确的步数、token 合计与状态徽章，按创建时间倒序

#### Scenario: 崩溃的 run

- **WHEN** 某文件无终止事件（进程中断）
- **THEN** 该行状态显示为“运行中断”，其余派生字段照常展示，不将其当作执行中或文件读取错误

#### Scenario: 封存状态不冒充正常结束

- **WHEN** 列表及树节点包含正常结束、error、max_iterations、budget_exceeded、aborted 和未知原因的摘要
- **THEN** 各自显示对应文字，error 不使用正常绿色，限制可辨认，未知保留原值，且工具曾出错后正常结束的 run 仍按正常终止显示并另列工具错误数

#### Scenario: 完整任务和 ID 搜索

- **WHEN** 用户搜索未显示在两行摘要内的任务片段或完整运行 ID，并切换来源条件
- **THEN** 搜索匹配完整原值且与来源条件求交集，不请求每条详情，不改变原 task；无结果时可清除条件

#### Scenario: 同名运行的短 ID 稳定可辨

- **WHEN** 多条记录任务、模型和时间相同，ID 尾部片段相同，随后用户筛选、排序或刷新加入新碰撞项
- **THEN** 在全部已加载记录范围内延长短 ID 以区分，筛选与排序不改变已有标识，刷新只在必要时延长，复制得到完整 ID

#### Scenario: 长模型和空任务的导航摘要

- **WHEN** 导航收窄且记录包含超长模型名、空白任务或缺失模型
- **THEN** 模型可换行并查看完整值，状态与短 ID 不被覆盖；空任务使用来源/时间/短 ID，缺失模型显示未记录，既有计数和耗时仍可展开查看

#### Scenario: 刷新合并且保留阅读

- **WHEN** 用户重复刷新，或在列表请求期间既有执行收尾触发更新
- **THEN** 重复请求合并，必要时在当前请求后刷新一次以包含新记录，旧列表与选中阅读位置保持；单纯刷新不自动选择新记录

#### Scenario: 列表刷新失败可重试

- **WHEN** 已有列表的刷新失败，或首次列表读取失败
- **THEN** 前者保留旧记录并显示未更新，后者显示可重试错误，不生成假记录，不清空已成功加载的阅读位置

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

系统 SHALL 在步骤页依据 span 的 `parent` 构建可收起的目录：`agent.step` 为层级节点（标注所属运行本地迭代序号 `n`），其下的 `llm.call` 与 `tool.invoke` 为子节点，顺序与记录一致，不将展示顺序声称为并行调用的串行因果关系。`tool.invoke.error` 非 null、`llm.call.error` 存在时 SHALL 按各自记录显著标错；用户可选中任意 span 查看详情，展开控制 SHALL 与选中控制分开。

有共享前缀的轨迹 SHALL 区分本次自有与继承记录，不累加本地轮号；prompt、代理及模型参数分支 SHALL 保留各自既有独立轨迹语义。首次进入步骤页且没有显式目标或有效历史选择时 SHALL 选择首个自有模型/工具调用，没有时回退首个可读 span；空轨迹 SHALL 显示空态。窄窗口收起目录后 SHALL 保留当前调用身份及重新打开目录的入口。

#### Scenario: 三步运行的树结构

- **WHEN** 打开一个含 3 轮迭代、每轮 1 次 LLM 调用与若干工具调用的 run 并进入步骤页
- **THEN** 树呈现 3 个 `agent.step` 节点，各自展开后为其下的 llm.call 与 tool.invoke 子节点，顺序与文件一致

#### Scenario: 工具报错

- **WHEN** 某 `tool.invoke` 的 `error` 非空而 run 最终正常 `completed`
- **THEN** 该节点以错误样式标注，run 状态仍为已结束并另列工具错误数（错误是数据不是异常）

#### Scenario: 展开与调用选择互不干扰

- **WHEN** 用户展开或折叠 step，再选中其中某个调用
- **THEN** 展开动作不替换当前详情，选择调用不意外折叠目录；LLM 与工具各按自身错误字段标记

#### Scenario: 首次步骤选择与空轨迹

- **WHEN** 首次进入含祖先前缀的步骤页且无指定目标，或打开没有任何 span 的记录
- **THEN** 前者选择首个自有模型/工具调用，无自有调用才选择首个可读 span；后者显示空态，不伪造步骤

#### Scenario: 继承轨迹与独立执行来源

- **WHEN** 浏览普通/隔离 result 分支以及 prompt、代理、model_params 分支
- **THEN** result 的已解析继承段与自有段可辨，本地轮号不沿链累加；其他分支保留既有自有轨迹及来源说明，不伪造共享执行前缀

### Requirement: 详情面板完整展示一步的原始请求与响应

选中 `llm.call` 时系统 SHALL 在步骤工作区展示完整 `request.messages`、`request.tools`（若有）、`request.params`（若有），以及 `response` 的正文 `content`、思维链 `reasoning_content`（与正文区别展示）、`tool_calls`、`usage`（in/out）、`ttft_ms` 与耗时。选中 `tool.invoke` 时 SHALL 展示 `tool`、`args`、`result`、`error`、`dur_ms` 与耗时。选中 step 时 SHALL 展示其已记录调用、错误及派生消耗。

系统 SHALL 保留消息角色与顺序、代码格式及完整原文访问，可折叠长内容或切换输入/输出，SHALL NOT 截断丢弃记录。长文本 SHALL 可查找、展开和复制，复制 SHALL 对应原始文本而非省略后的展示。错误详情、占位零值解释、空响应分型、缓存及上下文预算能力 SHALL 保持可达；预算仍以既有轨迹口径计算并联动真实调用选择。工具 args/result SHALL 在同一详情中便于核对。

输出 SHALL 安全呈现，不执行原始 HTML、脚本或 iframe，不自动加载模型输出中的远程图片，不将逻辑路径当作任意宿主文件读取能力。

#### Scenario: 推理模型的思维链

- **WHEN** 选中一次带 `reasoning_content` 的 llm.call
- **THEN** 思维链以区别于正文的样式单独分区展示，两者内容均完整

#### Scenario: 工具调用详情

- **WHEN** 选中一次 tool.invoke
- **THEN** 面板展示工具名、入参、结果与耗时；`error` 非空时错误信息显式呈现

#### Scenario: 长请求和原始字段完整可读

- **WHEN** 调用包含多角色长 messages、tools、params、tool_calls 或多行工具结果
- **THEN** 用户可展开、查找和复制完整内容，原角色/顺序/代码格式保持，输入输出切换不丢字段，step 摘要仍可进入每个原始调用

#### Scenario: 预算和错误能力迁移后可达

- **WHEN** 用户从步骤页打开预算地图、点击调用点或查看失败 LLM
- **THEN** 地图按既有完整轨迹口径计算并定位真实调用；错误正文、HTTP 状态（若有）、占位零值及空响应解释保持可读，编辑仍使用原有懒加载编辑器和执行门禁

#### Scenario: 模型输出不产生外部副作用

- **WHEN** 概览或详情的内容包含脚本、HTML、远程图片地址或宿主文件路径
- **THEN** 内容安全显示且可复制，不执行脚本、不自动访问图片或宿主路径，不因阅读发起模型请求

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

run 列表 SHALL 为代理录制的 run（meta 含 `source.kind="proxy"`）显示来源徽标，SHALL 提供来源过滤（全部 / 代理录制 / 本地记录）。无 `source` 字段的老文件 SHALL 归入“本地记录”，不报错；系统 SHALL NOT 将本地记录推断为桌面创建或 SDK 的某一种来源。来源过滤与任务/ID 搜索 SHALL 共同作用，不修改当前打开的运行。

#### Scenario: 徽标与过滤

- **WHEN** 列表同时含 3 个代理 run 与 2 个 SDK 直录 run，用户选择“代理录制”
- **THEN** 列表仅显示 3 个带代理徽标的 run；选择“全部”恢复 5 个

#### Scenario: 老文件无来源

- **WHEN** 列表含无 `source` 字段的老 run
- **THEN** 归入“本地记录”且无代理徽标，不报错，不猜测具体接入方式

#### Scenario: 筛选隐藏当前运行

- **WHEN** 搜索或来源条件隐藏当前选中运行
- **THEN** 主工作区继续显示该运行，导航提示当前运行不在筛选结果中并提供清除条件入口，不自动改选其他运行

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

header SHALL 提供分支树与运行工作区的视图切换入口。切到分支树时，主区域 SHALL 呈现已有宽幅分支树及其指标对照；切回运行工作区时 SHALL 呈现所选 run 的概览/步骤/文件页签，恢复其有效阅读位置，首次访问默认概览，SHALL NOT 强制恢复固定三栏。两种视图 SHALL 共享同一份 run 列表与同一个选中 run 状态。视图切换 SHALL NOT 触发列表重新加载。既有最多四条指标对照及其比较限制 SHALL 保持。

#### Scenario: 切到分支树

- **WHEN** 用户在 header 点击“分支树”
- **THEN** 主区域切换为分支树视图，已有 run 列表数据直接复用，不重新读取磁盘

#### Scenario: 选中状态跨视图保持

- **WHEN** 用户在分支树视图点选 run B，然后点击返回运行工作区
- **THEN** 呈现 B 已保存的有效阅读页签与位置，首次访问则进入 B 的概览，无需再次选择；B 的步骤及详情可直接进入

#### Scenario: 切换不重载

- **WHEN** 用户在两视图间来回切换
- **THEN** 列表数据不发生第二次加载（无重复 IO），失败文件条目同样保持

#### Scenario: 既有四条指标对照仍可使用

- **WHEN** 用户进入分支树并选择两条至四条符合现有比较规则的运行
- **THEN** 既有指标及本 run/沿链口径保持，超出上限或不可比条件仍按原规则提示，不新增臂间差值、胜出结论或未实现的输出比较入口

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

llm.call 详情的 usage 区 SHALL 在 `usage.cache_hit` **存在**（`!== undefined`，**`0` 属存在**）时展示缓存命中：命中 tokens、占输入（`usage.in`）的比例，并以视觉强调区分“命中为主”与“全量计费”（着色或同等的直观区分）。判据 SHALL NOT 使用 truthiness，`cache_hit: 0` SHALL 照常展示。`usage.in` 为 0 时 SHALL 只展示绝对 tokens、不做除法。字段缺失时 SHALL 降级省略展示，SHALL NOT 以 0 或推断值冒充。

run 级累计缓存命中 SHALL 从当前 run 文件自有的各 llm.call 的 usage 现算，不含祖先共享前缀，不持久化缓存；SHALL 在列表条目的 token 摘要同行与概览本次消耗区展示。无任何命中数据时 SHALL NOT 展示伪造的命中数字。列表 SHALL 使用“已记录命中量”等限定措辞；概览 SHALL 从自有调用明确展示记录覆盖数，部分调用有字段时 SHALL NOT 将局部合计称为全运行确定命中率。

仅 tool_result 分叉的确认编辑器 SHALL 在当前运行配置的 `model` 与父 run 该 step 录制的 `model` 不一致时给出缓存可能不命中、计费口径可能变化的信息性提示；SHALL NOT 拦截或改变 fork 门禁，prompt fork 与代理 messages 分叉 SHALL NOT 加此提示。

#### Scenario: llm.call 详情展示缓存命中

- **WHEN** 选中一次 `usage` 含 `cache_hit: 800`、`in: 1000` 的 llm.call
- **THEN** usage 区展示缓存命中 800 tokens（占比 80%）并以直观视觉强调命中为主

#### Scenario: 零命中仍展示为全量计费

- **WHEN** 选中一次 `usage` 含 `cache_hit: 0`、`in: 1000` 的 llm.call
- **THEN** usage 区展示缓存命中 0 tokens，并以视觉强调“全量计费”，不因 0 为假值而省略

#### Scenario: 少量命中不得被称为全量计费

- **WHEN** 选中一次 `usage` 含 `cache_hit: 128`、`in: 323` 的 llm.call
- **THEN** 展示 128 / 323（40%）与 miss 195，措辞表明“部分命中、多数输入仍按全价计费”，不写成“全量计费”

#### Scenario: 无缓存字段的调用降级

- **WHEN** 选中一次 usage 无 `cache_hit` 的 llm.call
- **THEN** usage 区不展示缓存命中行，不报错、不显示 0

#### Scenario: run 级累计现算

- **WHEN** 打开一个含 3 次 llm.call（其中 2 次带 `cache_hit`）的 run
- **THEN** 列表 token 摘要同行的已记录命中量等于 2 次 `cache_hit` 之和，概览展示覆盖 2/3 次调用，只算自有 spans，不使用持久化缓存，不称全运行确定命中率

#### Scenario: fork run 的累计不含祖先前缀

- **WHEN** 打开一个 fork run，其展开轨迹含祖先共享前缀中带 `cache_hit` 的 llm.call
- **THEN** run 级累计只统计本 run 新增调用，祖先命中不计入；展开视图各 span 详情照常展示自身缓存命中

#### Scenario: tool_result 分叉的模型不一致提示

- **WHEN** 用户在 tool_result 分叉编辑器中，当前配置 model 与父 run 在该 step 录制的 model 不一致
- **THEN** 编辑器显示缓存可能不命中的信息性提示，仍可按既有校验确认 fork；模型一致时不显示提示

#### Scenario: 其它分叉形态不加缓存提示

- **WHEN** 用户打开 prompt fork 编辑器或代理 messages 分叉入口
- **THEN** 界面不出现模型缓存提示

#### Scenario: 输入为零与全未知缓存

- **WHEN** 某调用 in=0 且记录 cache_hit=0，或运行所有自有调用均无缓存字段
- **THEN** 前者只显示绝对命中 tokens，不显示无效比例；后者概览可说明未记录，但不显示虚构零命中，列表不显示命中数字

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

在已交付隔离桌面详情 IPC 的基础上，工作区 SHALL 提供文件视图，可选择本 run 初始状态或任一自有完成步骤。文件表 SHALL 显示路径、大小、相对初始快照的新增/修改状态及附件可用性；文本文件 SHALL 能比较初始与所选快照内容，在空间足够时支持并排，在空间不足时采用 inline。二进制 SHALL 只显示可核对的大小/哈希。文件不存在、零字节、缺失和损坏 SHALL 明确区分，不渲染伪空文件。SHALL NOT 提供自动回写或应用到源目录的操作。

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
- **THEN** 路径和状态可读，列表/内容能切换或滚动，文本不覆盖检查点与导航控件；二进制或缺失附件不触发文本比较

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

### Requirement: 运行工作区按阅读任务组织

系统 SHALL 提供紧凑全局栏、可收起/调整宽度的运行导航及主工作区。全局栏 SHALL 提供真实可用的新建运行、录制接入和设置入口；新建与列表标题区既有入口打开同一现有创建流程，录制接入定位现有代理设置。单运行工作区 SHALL 使用概览、步骤、按能力提供的文件平级页签，保持当前任务、状态和来源可辨。

首次成功加载列表且尚未选择运行时 SHALL 尝试最近可读摘要对应的运行并进入概览；详情失败时 SHALL 留在该运行错误态，不循环跳到其他记录。无运行时 SHALL 提供新建和录制两个实际入口。文件页 SHALL 占主工作区，不常驻无关步骤目录；合法隔离运行附件异常时 SHALL 保留文件入口，继续使用既有文件读取/版本/能力校验。

所有现有普通/隔离创建、result 重跑、prompt/messages 编辑、模型实验、设置及旧分支/指标入口 SHALL 保持可达并遵守现有门禁，SHALL NOT 因导航收起而消失。阅读动作 SHALL NOT 触发模型调用、写入 trace/附件或恢复写入授权。

#### Scenario: 首次打开与无运行入口

- **WHEN** 首次列表加载成功且无选中项，或数据目录没有运行
- **THEN** 前者只尝试最近可读摘要对应的运行并进入概览；后者显示可操作的新建和录制入口，不显示营销欢迎页；选择失败时可原位重试而不自动遍历其他运行

#### Scenario: 文件承载区不附带步骤目录

- **WHEN** 用户在合法隔离运行切到文件页
- **THEN** 文件视图使用整个主工作区正文，没有无关步骤目录；附件缺失/损坏仍保留文件入口和既有异常说明，普通无文件世界运行不出现虚假文件页

#### Scenario: 旧创建设置及执行入口保持可达

- **WHEN** 用户收起导航，再新建、打开设置/录制，或从受支持运行进入 result、prompt、messages 与模型实验入口
- **THEN** 所有已有入口仍能到达原流程；普通与隔离参数/预检/每次授权、费用确认及隔离 prompt/A-B 拒绝保持，不显示新取消或操作核对能力

#### Scenario: 阅读过程不修改已有数据

- **WHEN** 用户搜索、刷新、切换概览/步骤/文件、展开原文、查看预算、打开分支并返回
- **THEN** 既有 trace、附件与源目录逐字节不变，不额外调用模型或工具，不从历史阅读状态继承执行授权

### Requirement: 运行概览呈现自有结果与消耗

系统 SHALL 在首次访问运行时呈现概览，以当前运行自有终止事件区分正常、失败、限制、中止和中断，SHALL NOT 使用请求返回成功或祖先结局代替。正常结束 SHALL NOT 表示质量验证或测试通过。结构或版本不合法时 SHALL 继续拒绝详情，不能为展示概览放宽校验。

概览 SHALL 从当前运行自有调用选择输出：正常终止且最后自有模型调用记录非空正文、无错误及无待执行工具调用时展示已记录最终输出；不满足时明确未记录最终输出。失败/限制/中断前的正文及更早正文 SHALL 作为单独的中间输出保留，不能冒充最终结果；仅有思维链/工具调用时 SHALL 如实说明并可打开原调用，不从祖先或模型生成总结补全。

概览 SHALL 显示真实记录的自有 LLM 错误及其定位入口，工具错误可单独定位，不断言其为终止根因。错误终止但自有 LLM 错误详情未记录时 SHALL 保留缺失说明，不用祖先错误、零 token 或最后调用猜原因。定位 SHALL 打开对应调用及其所属 step。

本次消耗 SHALL 仅由自有 spans 现算，含 token、已记录时间、工具调用/错误及已记录缓存，未知不补零；失败占位零用量 SHALL 保留解释。来源 SHALL 展示真实父本、修改字段与既有隔离边界，可返回父记录；来源关系不一律表示共享执行前缀。概览 SHALL NOT 将工具返回修改称为文件修改，也不新增跨运行对比或沿链总成本。

#### Scenario: 正常结束直接看到最终输出

- **WHEN** 首次打开普通或隔离运行，自有事件正常 completed，最后自有 LLM 正文非空且无错误或待执行工具调用
- **THEN** 概览直接显示完整可展开复制的最终输出、结束原因和本次消耗，可进入步骤；不要求先选 span，不声称修复或测试通过

#### Scenario: 失败概览定位真实自有调用

- **WHEN** 本 run 以 error 结束且有带 error 的自有 llm.call
- **THEN** 概览显示已记录错误并可直接打开该调用、展开所属 step；失败前已有正文单独保留，祖先错误不替代本次原因

#### Scenario: 旧失败记录没有错误详情

- **WHEN** 本 run 以 error 结束但自有 LLM 没有错误详情，包括没有自有 LLM 或仅祖先含错误
- **THEN** 概览显示错误详情未记录，不虚构失败调用入口或原因；已有自有工具错误可独立查看但不被断言为终止根因

#### Scenario: 限制中止与中断如实展示

- **WHEN** 运行因 max_iterations、budget_exceeded、aborted 结束，或没有结束事件
- **THEN** 概览显示对应限制、中止或中断，保留最近自有输出为中间内容，不标为正常成功或仍在执行

#### Scenario: 无最终正文不借用祖先补全

- **WHEN** 最后自有调用没有正文、仅有 reasoning/tool_calls，或子运行没有自有调用但祖先有输出
- **THEN** 概览显示未记录最终输出并区分已记录内容类型，较早自有正文只能作为中间输出，祖先正文不被当作本次结果

#### Scenario: 本次指标不累计共享前缀

- **WHEN** 分支详情包含祖先调用与自有调用，部分自有调用缺 timing 或缓存，失败调用存在占位零用量
- **THEN** 概览只派生自有消耗，说明已记录时间/缓存范围，缺失不补零，失败占位零不被解释为实际零消费；沿链指标仍在既有分支视图以原口径提供

#### Scenario: 来源和隔离边界保持真实

- **WHEN** 概览展示 result、prompt、messages、model_params 或二次隔离分叉
- **THEN** 来源使用真实直接父 ID 和字段，父入口可打开相应记录，独立执行不冒充共享前缀；隔离保留原始来源和本地轮末边界，tool_result 修改不声称改了文件

#### Scenario: 非法详情不被概览绕过

- **WHEN** 读取详情遇到不支持格式、v1 非法隔离字段、schema 错误或现行解析拒绝的缺祖先
- **THEN** 显示原位详情错误与重试，不渲染未经校验的部分概览，不放宽执行权限，不宣称已支持缺父链降级

### Requirement: 会话内按运行恢复阅读位置

系统 SHALL 在当前会话内按运行身份保存概览/步骤/文件页签、选中 span、展开轮次、详情阅读分区/长文本展开和概览/步骤滚动位置。切运行再返回、进入分支或设置再返回 SHALL 恢复有效阅读位置；搜索条件和列表滚动 SHALL 保持。文件仅恢复页签，内部检查点/路径/滚动仍遵循现有文件视图，不承诺本次改进。

明确调用定位 SHALL 优先于历史位置；恢复前 SHALL 校验对象仍属于当前详情，失效引用 SHALL 提示并回退到有效默认位置。不同 run 中相同 span ID SHALL 不串状态。阅读位置 SHALL 仅存会话，不写 trace，不保存草稿、授权或凭据，不承诺重启恢复。

详情加载 SHALL 区分每次请求及运行身份，迟到成功或失败 SHALL NOT 覆盖新选择、清除新请求加载态或错误。切换时 SHALL 显示与当前身份匹配的加载/错误状态，不将旧正文无提示地置于新标题下。同一运行显式重试 SHALL 真正重新读取。刷新确认当前源文件消失或损坏时 SHALL 标明源不可用并禁用依赖其的新执行，重新读取校验通过前不以旧内容获得执行资格。

#### Scenario: 跨运行返回恢复阅读

- **WHEN** 用户在 A 展开长消息、选择调用、滚动，再切 B 后返回 A，或从 A 进入设置/分支再返回且未改选
- **THEN** A 的页签、调用、目录和原文展开、各阅读滚动位置恢复，搜索和列表滚动保持；A/B 相同 span ID 的状态互不污染

#### Scenario: 显式错误定位优先于恢复

- **WHEN** A 原先停在文件或另一调用，用户从概览选择真实错误调用
- **THEN** 进入步骤页、展开相应 step、选中并滚动到目标调用，键盘焦点进入目标；不被旧页签或旧滚动覆盖

#### Scenario: 失效阅读对象安全回退

- **WHEN** 重读后保存的 span/展开对象不存在，或保存的文件页签不再适用
- **THEN** 提示原位置不可用并清理失效引用，步骤回到首个自有可读调用/首个 span 或空态，不适用文件页回到概览，不选择另一个运行的同 ID span

#### Scenario: 快速切换及同运行重试不串响应

- **WHEN** 用户 A→B→A 快速切换或同一运行发起重试，早先请求的成功、错误或校验失败迟到
- **THEN** 只有最新匹配请求更新当前详情/加载/错误，旧响应不覆盖；标题和正文身份一致，显式重试实际重新读取

#### Scenario: 已选源记录不可用

- **WHEN** 刷新确认选中源文件消失或变为读取失败，且工作区仍有之前加载的内容
- **THEN** 内容明确标为源记录不可用，相关执行入口禁用；用户可选择其他运行，原运行只有重新读取并校验成功才恢复正常

#### Scenario: 阅读恢复不保存授权或草稿

- **WHEN** 用户返回一个曾打开编辑/授权区域的运行，或重启应用
- **THEN** 会话内只按上述规则恢复阅读，不自动恢复写入授权或把编辑输入视为阅读状态；重启后没有跨进程阅读恢复承诺

### Requirement: 工作区在窄窗口和键盘操作下可读

运行导航与步骤目录 SHALL 可收起、调整宽度，并在正文空间不足时自动收起；自动行为 SHALL NOT 覆盖用户宽窗口偏好。窄窗口 SHALL 使用可返回的辅助列表/单工作区，保留当前运行与调用身份。全局操作和页签 SHALL 可达，工具栏可换行，主要字体 SHALL NOT 随窗口缩小，页面 SHALL NOT 横向溢出；代码和图表可在局部滚动。

复制、刷新、折叠、设置等工具控件 SHALL 提供图标、可访问名称、悬停说明及焦点态；页签、目录选择、展开、关闭和宽度调整 SHALL 可键盘完成。关闭临时辅助区域 SHALL 返回触发点或当前阅读对象，SHALL NOT 被解释为取消执行。主要文字 SHALL 使用可读字号、语义颜色及明确状态文字，长 ID/模型 SHALL 换行或按需展开而不遮挡相邻内容。

#### Scenario: 多尺寸与放大下关键阅读可达

- **WHEN** 在 100% 缩放下使用 1440×900、1360×860、1024×768、800×600、640px 应用内容视口 CSS 宽度，并另以 200% 缩放检查概览、步骤和文件承载页
- **THEN** 输出/错误、页签及主要入口可达，导航/步骤目录按空间收起，文件页不带无关步骤目录，标题/模型/ID 不重叠，页面无横向溢出；文件内部 diff 改进不被冒充已通过

#### Scenario: 自动折叠后恢复用户布局

- **WHEN** 用户调整导航/目录宽度，再进入窄窗口或文件/编辑态，随后返回足够宽的普通阅读区
- **THEN** 正文优先可读，退出自动收起条件后恢复用户偏好，宽度始终在有效范围内，加载内容不撑大固定控件

#### Scenario: 键盘导航及工具名称

- **WHEN** 用户仅用键盘切页签、选调用、展开目录、调整宽度、关闭临时列表并访问复制/刷新/设置
- **THEN** 操作有可见焦点和可访问名称，关闭返回合理焦点，不触发取消执行；图标悬停可辨用途，长内容和状态无需仅靠颜色理解

### Requirement: 文件阅读在会话内按运行恢复并校验定位

系统 SHALL 按 run ID 保存文件检查点、完整逻辑路径、列表/内容意图、搜索/筛选、目录及 diff 偏好、列表与正文阅读位置，状态独立于文件组件挂载。首次进入 SHALL 选择最近自有完成步骤，无此步骤时选择初始；一次性明确文件目标 SHALL 优先于有效会话选择，再优先于默认值。普通文件页签返回 SHALL NOT 被当作覆盖历史的定位请求。

恢复 SHALL 重新读取并校验 run/step/path，保留清单中仍存在的完整路径；过期 step SHALL 提示并回退默认，过期 path SHALL 提示并清空选择，不选择另一同名文件。读取失败 SHALL NOT 等同引用消失。阅读状态 SHALL 只存会话，不保存文件事实、草稿、授权、凭据或物理路径，不承诺重载/重启恢复偏好。

#### Scenario: 首次文件页选择最近自有完成步骤
- **WHEN** 首次进入含祖先前缀和多个自有完成步骤的隔离 run 文件页
- **THEN** 按自有 agent.step.n 选择最近步骤，初始与其他自有完成步骤仍可选；失败 run 的既有完成步骤同样可用，不选择祖先或未完成轮次

#### Scenario: 无自有完成步骤时选择初始
- **WHEN** 首次进入没有自有完成步骤的隔离 run 文件页
- **THEN** 选择本 run 初始状态；初始未录制时显示明确不可用，不伪造空清单

#### Scenario: 文件页签往返恢复阅读
- **WHEN** 在第 1 轮的 a.txt 选择内容模式、滚动到长文本中部，再执行文件→步骤→文件
- **THEN** 恢复检查点、路径、模式、搜索筛选、布局偏好与列表/正文位置，重新读取校验后显示，组件卸载不使其回到初始状态

#### Scenario: 跨运行和辅助视图返回恢复文件
- **WHEN** 从 A 文件页切到 B，再经分支或设置返回 A，且 A/B 有同名 step/path
- **THEN** 每个 run 保持各自检查点和阅读位置，不串文件或覆盖另一运行状态，普通返回不消费显式目标

#### Scenario: 显式文件定位覆盖历史
- **WHEN** 用户从当前运行的自有步骤打开该轮文件，或提交带合法检查点和 path 的明确文件目标
- **THEN** 定位该自有轮末而不是历史检查点；无 path 时显示未选文件的列表，有 path 时显示目标内容并解除阻挡它的搜索筛选；目标仅作用于本次导航，重复定位仍生效

#### Scenario: 失效检查点和路径安全回退
- **WHEN** 重新读取发现保存或明确指定的 step 不再属于当前运行，或目标 path 不在所选完整清单
- **THEN** 前者提示并清理相关位置、回到最近自有完成步骤或初始；后者提示并清空文件选择、显示列表；不借用祖先、另一运行或同名路径

#### Scenario: 切检查点保留仍存在的路径
- **WHEN** 用户切换检查点，原完整 path 在新清单存在但可能不符合筛选或附件不可用
- **THEN** 保留该 path 并呈现新检查点对应状态；仅清单确认 path 不存在时清空，读取失败保留定位意图供重试

#### Scenario: 文件阅读状态不跨进程承诺
- **WHEN** 文件页已记录阅读位置后重载 renderer 或重新启动应用
- **THEN** 允许按首次进入策略选择检查点，持久记录仍可重新读取；阅读过程未持久化内容副本、草稿、授权或凭据

### Requirement: 文件目录支持真实变化筛选和路径查找

文件目录 SHALL 提供完整逻辑路径搜索与全部/有变化筛选，默认完成步骤看有变化、初始看全部，显式筛选偏好在会话内保留。“有变化” SHALL 仅使用 inspect 的 added/modified，不依赖 mtime 或附件可用性。空清单、无变化、搜索无匹配、未录制/读取失败 SHALL 分开表达，筛选结果 SHALL NOT 冒充原始清单规模。

#### Scenario: 路径搜索与变化筛选组合
- **WHEN** 文件清单包含新增、修改、未变与不可用附件，用户搜索目录或文件名并切换筛选
- **THEN** 对完整路径做不区分大小写的子串匹配并与筛选组合，变化只认清单/哈希派生，缺失或损坏不被标为删除或新增

#### Scenario: 初始与完成检查点的默认筛选
- **WHEN** 尚无显式筛选偏好，分别进入初始与自有完成步骤
- **THEN** 初始显示全部、完成步骤显示有变化；明确选择全部或有变化后往返保留偏好

#### Scenario: 空清单无变化和无匹配可区分
- **WHEN** 分别读取合法零文件清单、有文件但相对初始无变化的清单，或搜索没有匹配项
- **THEN** 分别显示空清单、相对本运行初始无变化、无匹配，后两者提供查看全部或清空搜索；未录制/读取失败不显示成上述空态

#### Scenario: 筛选不偷换当前文件
- **WHEN** 搜索或筛选隐藏当前选择的完整 path
- **THEN** 保留其内容标题和阅读状态，说明该文件被筛选隐藏并可显示所选文件，不自动改选另一文件；清单规模与筛选计数分开

### Requirement: 文件目录和差异按内容容器宽度适配

布局 SHALL 依据文件容器与编辑器文字区实际宽度决策，先保障正文、再决定目录常驻及 diff 模式，不依赖单一窗口断点。目录 SHALL 可收起、调整宽度和键盘切换；不足时列表与内容分别占用主区。并排 SHALL 仅在两侧文字区各至少 320 CSS px 时生效，否则 inline；自动调整 SHALL NOT 覆盖用户布局偏好。正文宽度下限 SHALL 按容器宽分档：容器宽足够（对应 960 CSS px 及以上视口）时 inline 文字区至少 480 CSS px；低于该档时正文按可得主区自适应，不声称 480 CSS px。

#### Scenario: 文件正文在代表视口可读
- **WHEN** 在 100% 缩放的 1440/1360/1210/1024px 宽 CSS 视口查看短句、长路径和长文件
- **THEN** 没有无关步骤目录；并排每侧文字区至少 320px，否则使用至少 480px 的 inline 文字区，目录常驻不足以保障该宽度时收起目录；正文至少 13px，工具栏可达、文字不重叠、无整页横向滚动
- **AND** 上述 480px 下限适用于 960 CSS px 及以上视口；800px 及更低视口归入窄档（见「极窄与放大后仍可阅读」），正文使用可得主区，不要求达到 480px

#### Scenario: 同视口下响应容器变化
- **WHEN** 保持窗口宽度不变但调整运行导航或文件目录宽度，使文字区低于可读阈值
- **THEN** 依据新容器尺寸收起目录或切 inline，宽度恢复后还原用户目录宽度和 diff 偏好，不用窗口断点判断足够宽

#### Scenario: 极窄与放大后仍可阅读
- **WHEN** 使用 800px 及更低的 CSS 视口（含 640px），或单独设置 Electron zoomFactor 为 2 后访问文件页
- **THEN** 目录与内容可切换，目录一律收起，diff 强制 inline；正文使用可用主区，不要求 inline 文字区达到 480px；允许 inline 局部滚动，工具栏换行、检查点与返回目录可达，不缩小字号或产生整页横向滚动

#### Scenario: 手动布局偏好不被自动折叠覆盖
- **WHEN** 用户调整目录宽度、收起目录或选择 inline/并排，再缩窄、切页并恢复宽度
- **THEN** 不足空间时安全降级，宽度恢复后恢复用户偏好；不强行显示过窄并排，正文阅读行位置保持，目录切换不抢走无关焦点

### Requirement: 文件阅读工具操作完整原文且保持只读

文件页 SHALL 提供路径及可读侧完整原文复制、查找、换行、上一/下一差异和 diff 模式控件，复用本地懒加载 Monaco。控件 SHALL 有可访问名称、状态、悬停说明和键盘焦点，按实际可读/可比较/编辑器就绪状态启用。SHALL NOT 增加编辑、替换、回写、应用补丁或导出入口。

#### Scenario: 复制路径原文及元信息
- **WHEN** 用户在长路径、折叠或搜索后的文件上复制路径、某可读侧原文，或复制二进制/不可用附件元信息
- **THEN** 获得完整逻辑路径、该侧完整原文或真实大小/哈希，不复制截断显示内容，不把无文本侧复制为空文件；剪贴板失败就近提示

#### Scenario: 查找换行和差异定位使用当前文件
- **WHEN** 用户在可比较文本上查找、切换换行并导航上一/下一差异，再切换文件
- **THEN** 操作作用于当前文件和活动可读侧，差异导航使用已完成的真实 diff；切换后不沿用旧模型命令，换行不改原文，禁用替换和修改

#### Scenario: 不可比较或未就绪时工具诚实禁用
- **WHEN** 编辑器仍加载、内容未取得、两侧不可比较、没有差异或仅一侧可读
- **THEN** 按条件禁用对应复制/查找/差异工具并给出说明；单侧可读时该侧仍可复制查找，无差异时不假跳转

#### Scenario: 文件阅读键盘操作与离线加载
- **WHEN** 离线进入文件页并用键盘操作检查点、搜索筛选、目录切换、宽度调整及工具栏
- **THEN** Monaco 从本地懒加载，控件可操作且有焦点态；返回列表聚焦原文件或有效列表项，关闭查找返回编辑器，无覆盖正文的工具控件

### Requirement: 文件两侧读取状态真实且旧响应不覆盖新选择

清单和两侧文件 SHALL 分别维护加载、成功和失败，所有响应及 loading 收尾 SHALL 绑定 run/step/path/侧与请求代次。旧成功、业务失败、异常和 finally SHALL NOT 覆盖新选择或同对象新请求。两侧 SHALL 独立读取，任一侧不可用不阻止另一可读侧展示；加载及失败 SHALL NOT 被当作不存在。

只有两侧均为 text，或经校验的初始 not_found 与所选 text，SHALL 进入文本 diff；新增文件使用空侧时 SHALL 保留“不存在”标识。text 空串与 0 B SHALL 作为真实空文件。missing/corrupt/binary/rejected 或失败侧 SHALL NOT 用空文本参与比较。重试 SHALL 重新调用只读接口，SHALL NOT 导入、补写、调用模型或工具。

#### Scenario: 新增文件与零字节文件不混同
- **WHEN** 初始侧明确返回 not_found、所选侧 text，或任一合法 text 的 bytes 为零
- **THEN** 前者可比较并标明初始状态不存在；后者标明 0 B 空文件且可参与合法比较，二者不使用同一个不存在提示

#### Scenario: 不可用侧不伪装为空差异
- **WHEN** 任一侧处于加载、失败、拒绝、二进制、附件缺失或损坏，另一侧为可读文本
- **THEN** 两侧分别标出真实状态，可读侧完整展示并可复制查找，禁止把不可用侧置空进行 diff；左右互换同样成立

#### Scenario: 两侧都不可读时没有伪空编辑器
- **WHEN** 两侧都没有可读文本，或都经校验为不存在
- **THEN** 显示各侧具体状态及适用的重试/元信息操作，不展示假空文件或宣称无变化

#### Scenario: 快速切换不串清单正文错误和加载
- **WHEN** 快速切换运行、检查点或 path，使先前清单/任一侧请求的成功、失败或异常迟到
- **THEN** 标题、清单、内容、错误及 loading 只对应当前请求，旧请求 finally 不清除新 loading，卸载后请求不改写当前阅读状态

#### Scenario: 同对象重试与往返有请求代次
- **WHEN** A→B→A 或同一对象连续重试，较旧的 A 请求后返回
- **THEN** 仅最新代次结果生效，不能因 run/step/path 相同接受旧结果；失败保留当前定位意图，清单和内容可独立重试

#### Scenario: 阅读重试只读且重新校验
- **WHEN** 返回保存的文件选择或重试此前失败的清单/附件读取
- **THEN** 实际重新调用对应只读 IPC 并显示当前校验结果，不以旧内容或源目录兜底；源/父/兄弟/既有 trace 与附件逐文件哈希不变，模型及工具调用为零

### Requirement: 调试草稿按编辑身份保存在会话内

系统 SHALL 在独立于组件挂载和阅读状态的 renderer 会话内存中保存草稿。result、system_prompt、user_message、messages SHALL 按当前父本 runId、调用 spanId 和字段隔离；创建 SHALL 有独立单份表单，A/B SHALL 按父本与起始调用保存整个批次。输入事件 SHALL 同步保存原始输入及单调递增修订号，不以 blur 或卸载作为唯一保存时机；SHALL NOT 将草稿写入持久存储、URL、日志、settings 或 trace。

#### Scenario: result 草稿经步骤页签和运行往返逐字恢复

- **WHEN** 用户修改普通或隔离运行的工具结果，随即切步骤、切文件或概览页、切另一运行，再返回原调用打开编辑
- **THEN** 包括最后一次输入、换行及空白在内的草稿逐字恢复，原 trace 不变，导航不触发模型或工具调用

#### Scenario: 相同 span ID 和不同字段不串草稿

- **WHEN** 两个运行含相同 span ID，或父子运行共享继承 span，且用户分别编辑 result 或 system/user prompt
- **THEN** 各 run/span/field 的输入独立保存，切换 prompt 字段不会重置另一字段，提交一个目标不自动合并其他字段

#### Scenario: 非法 JSON 和空输入仍可暂存

- **WHEN** 用户将 messages 改成未完成 JSON，或将可编辑字符串清空、输入仅空白后离开
- **THEN** 原始输入仍可恢复，不被格式化、trim 或替换为原值；能否提交另按字段既有校验判定

#### Scenario: 修订不因删除重建而复用

- **WHEN** 用户连续修改、恢复查看、改回基线、放弃后重新编辑同一个目标
- **THEN** 只有实际内容变化推进修订，改回基线不再标 dirty，同 key 重建仍使用新的修订；打开未编辑的表单不产生虚假 dirty

#### Scenario: 草稿不会跨 renderer 会话持久恢复

- **WHEN** 用户输入带唯一标记的草稿，检查持久存储后重载 renderer 或重启应用
- **THEN** 存储、日志和 trace 中没有新增草稿副本，新 renderer 不恢复旧草稿；正常退出前仍须执行本 change 的关闭核对

### Requirement: 草稿可定位且来源失效不丢输入

系统 SHALL 在调用旁显示草稿标记，步骤页提供本运行草稿列表，并提供可访问创建及其他运行草稿的会话入口。打开条目 SHALL 定位原 run/span/field；恢复时 SHALL 重新核对源记录有效性及编辑基线，来源不可用或改变时保留输入供复制/放弃并阻止执行。阅读状态回退、列表刷新和缓存清理 SHALL NOT 删除草稿。

#### Scenario: 草稿列表返回精确编辑目标

- **WHEN** 当前会话含多个运行、两个 prompt 字段、创建与 A/B 草稿，用户从列表打开其中一项
- **THEN** 展示可辨认的运行和字段身份并打开对应编辑目标，其他草稿不变；本运行列表只呈现该运行条目

#### Scenario: 源记录缺失损坏或发生改变

- **WHEN** 返回草稿时原 run/span 消失、读取失败、格式或能力校验失败，或编辑所依赖的源内容已改变
- **THEN** 保留原身份和草稿供复制/放弃，禁止执行，不替换为另一调用或静默采用新基线；详情失败时仍能从会话草稿入口访问输入

#### Scenario: 阅读回退不删除草稿且重新校验才能执行

- **WHEN** 阅读缓存被清理或引用回退后重新打开草稿，或曾失效的原来源恢复
- **THEN** 输入不变；只有原来源和既有能力重新校验通过后才恢复执行资格，恢复草稿本身不等于授权

#### Scenario: prompt 和实验恢复重验首次调用资格

- **WHEN** 恢复 prompt 或 A/B 草稿时，当前详情的首次 llm.call 身份或其执行资格与编辑时不再一致
- **THEN** 保留原草稿但禁止提交，不跳过首次调用改用后续调用，不仅凭 span ID 相同放行；重新核对首次调用、来源事实及既有门禁，不新增算法版本签名或跨重载迁移

### Requirement: 编辑核对与明确放弃区分于收起

编辑区域 SHALL 就近展示只读原值和草稿，在窄窗口上下排列并保持正文及操作可达。收起、Esc、导航和设置往返 SHALL 保留输入；实际变更的放弃 SHALL 经确认，取消不丢内容，确认只删除指定目标的已核对修订。无变化 SHALL 禁用提交，空串合法性 SHALL 沿用字段契约。清空为零长度仍属于需保护的变更。

#### Scenario: 关闭编辑与设置往返保留内容

- **WHEN** 用户通过收起按钮或 Esc 关闭 result、prompt、messages 或 A/B 编辑区，或进入设置后返回
- **THEN** 再打开时原输入仍在，关闭动作不等于放弃或取消执行，不恢复之前的授权和预检

#### Scenario: 放弃可取消且只影响指定目标

- **WHEN** 用户放弃非空变更或清空后的变更，先取消确认，再重新确认放弃
- **THEN** 取消后逐字保留，确认后仅清除目标草稿并恢复其基线；其他字段、其他运行、创建和其他批次不受影响

#### Scenario: 旧放弃确认不能删除新修订

- **WHEN** 放弃确认所针对的草稿修订已被后续内容更新替换
- **THEN** 旧确认不删除新内容，重新展示当前目标并要求核对

#### Scenario: 无变化与空字符串按各字段契约处理

- **WHEN** 草稿与原值相同，或创建 systemPrompt 为空、userMessage 为空，或 messages 不是有效非空数组
- **THEN** 无变化重跑被禁用；空 systemPrompt 可按原契约创建，空 userMessage 和非法 messages 禁止提交并说明原因，所有输入仍可保留

#### Scenario: 宽窄窗口均可核对完整编辑内容

- **WHEN** 在 1440、1210、1024、800 CSS px 和独立 200% 缩放下核对长结果、多行 prompt、messages 与长臂参数
- **THEN** 原值与草稿身份明确，正文可完整滚动阅读，窄窗上下排列，收起/放弃/提交及禁用原因可达，无整页横向溢出或重叠，不通过缩小正文掩盖空间不足

### Requirement: 创建草稿和实验臂遵守同一保留规则

创建 SHALL 在会话内保留模式、任务和系统指令，关闭后再次打开恢复，明确放弃才重置默认。A/B SHALL 保留有稳定身份和顺序的整批臂配置，包括未通过校验的 model/paramsText；增删或修改均计入批次修订。两者 SHALL 保持独立数据结构，不保存凭据、授权或 dry-run 计划到草稿。

#### Scenario: 创建关闭配置再新建仍有任务

- **WHEN** 用户在任一创建模式输入任务和系统指令，关闭创建、打开并关闭设置、再次点击新建
- **THEN** 模式及两个文本字段逐字恢复，创建仍使用现有对话框，本次副本授权未勾选；未编辑的默认空表单不冒充草稿

#### Scenario: 切创建模式保留文本而放弃重置表单

- **WHEN** 用户切换纯对话与隔离模式，或对有修改的创建草稿执行放弃
- **THEN** 切模式保留任务和系统指令但清除目录引用与授权；放弃取消时保持输入，确认后恢复纯对话空表单并清除该创建的目录引用

#### Scenario: 实验臂增删和非法参数可恢复

- **WHEN** 用户新增和删除 A/B 臂、修改模型并输入未完成参数 JSON，再切调用或运行后返回
- **THEN** 臂身份、顺序和原始参数文本完整恢复，整批修订正确，原初始臂不算 dirty，未校验参数不能用于真实执行

#### Scenario: 实验预览和结果不隐式清理批次

- **WHEN** A/B dry-run 返回、真实执行全部返回或部分臂失败后用户重新打开实验
- **THEN** 配置草稿保持完整，不以计划、IPC ok 或部分结果清除批次；恢复后需重新预览与确认副作用

### Requirement: 草稿恢复不恢复执行许可

草稿 SHALL NOT 包含副本写入授权、副作用许可或可执行预检结论；恢复、改变目标/内容、离开编辑流程和每次提交尝试 SHALL 使相关临时许可失效。创建 sourceToken SHALL 仅作为独立的受限会话引用保存，仍由 main 校验 15 分钟有效期与一次性消费，不因恢复延长有效期或从路径重建。设置凭据 SHALL NOT 被复制到草稿或关闭消息。

#### Scenario: 隔离编辑恢复后重新预检授权

- **WHEN** 用户已预检并勾选副本写入后收起、离开或修改 result，再回到提交确认
- **THEN** 授权默认未选，先重新预检并明确授权才能提交；父 trace 的 write_authorized 不作为授权，隔离 prompt/A-B 仍被拒绝

#### Scenario: sourceToken 在有效期内恢复但授权复位

- **WHEN** 用户选择目录后未提交，关闭创建并在 token 有效期内重新打开
- **THEN** 可恢复原目录展示和同一会话 token，任务保留，授权未勾选；不签发新 token，不延长有效期，不按路径自动选择

#### Scenario: sourceToken 失效不清空任务

- **WHEN** 恢复的 token 过期或已消费，main 拒绝隔离创建
- **THEN** 提示重新选择目录且不复用失效 token，保留任务、系统指令和模式，不绕过 main 或自动重发

#### Scenario: 取消目录选择保留原引用

- **WHEN** 用户取消创建流程的目录选择
- **THEN** 保持原选择，首次取消保持未选，不清空草稿或赋予写入授权

#### Scenario: 迟到检查不覆盖草稿

- **WHEN** 目录选择、隔离预检或 A/B 预览响应在目标、内容修订或请求代次改变后才返回
- **THEN** 迟到响应不能给当前草稿覆盖目录、安装旧计划或恢复许可；各入口分别校验自身请求，不要求 A/B 提供目录选择

#### Scenario: 设置凭据与调试草稿分离

- **WHEN** 用户从含草稿的工作区进入设置并填写模型或代理凭据，再返回编辑
- **THEN** 草稿仓库和关闭 IPC 不新增这些凭据，调试草稿原文保留，设置未保存输入仍由原设置流程自行管理

### Requirement: 提交绑定草稿修订且响应不清除草稿

每次提交 SHALL 原子绑定草稿键、修订和请求快照，在该请求待定时冻结对应草稿的修改/放弃。组件卸载或展示状态复位 SHALL NOT 解除冻结。所有响应 SHALL 只处理匹配关联；本阶段 SHALL NOT 因任何执行结果自动删除草稿。无法确定执行状态时 SHALL 保留输入和冻结，不自动重发；可信核对由后续操作登记提供。

#### Scenario: 提交快照独立于编辑器挂载

- **WHEN** 用户提交 result、prompt、messages、创建或 A/B 后，编辑组件卸载并再次挂载
- **THEN** 待定草稿仍对应原 key/revision 和提交值且不可修改或放弃，卸载不重发、不解冻；其他草稿输入不被覆盖

#### Scenario: 成功错误和部分失败均保留草稿

- **WHEN** 任一现有执行入口收到 ok、业务拒绝、明确请求失败或 A/B 部分失败
- **THEN** 提交草稿保持原文，已明确返回的本次关联可解冻；即使 IPC 返回 ID 或记录正常 completed 也不自动清理，用户可明确放弃

#### Scenario: 迟到回调与未知状态不能错误解冻

- **WHEN** 回调不再匹配当前提交关联，或通道断开无法判断执行是否仍在进行
- **THEN** 旧回调不解冻新提交、不删除新修订；状态未知保留冻结与可复制输入，重开编辑器不能解锁或自动重发

### Requirement: 主进程核对草稿后决定常规退出

main SHALL 拦截标题栏关闭、Alt+F4 和 app.quit，向目标 renderer 请求新鲜 dirty 元数据；存在草稿或状态无法确认时 SHALL 显示一次原生退出确认，默认返回。renderer SHALL 在锁前同步控件已接收输入，锁定新编辑直至关闭决定，并报告 inputSettled；超时或输入未完成同步 SHALL NOT 当作 clean。确认只放行本次退出，取消保留已接收文字并恢复编辑。协议 SHALL 校验 sender/frame、文档会话、序号和查询身份，只传元数据。

Windows 注销、关机、系统重启及强制结束进程不在此退出确认保证内；系统 SHALL NOT 为 U3 草稿保护阻止系统结束会话或承诺恢复内存草稿。

#### Scenario: 有草稿时关闭可返回或明确退出

- **WHEN** 任一类型草稿为 dirty，用户点击标题栏关闭、按 Alt+F4 或走 app.quit
- **THEN** 出现一次原生确认并明确会话草稿会丢失；默认/取消返回且输入不变，明确退出才关闭，不承诺重启恢复或副作用撤销

#### Scenario: 最新 clean 应答才允许直接关闭

- **WHEN** 最后一次上报为 clean 后用户输入最后一个字符并立即关闭，或全部草稿已回到基线/明确放弃后关闭
- **THEN** main 均重新查询；前者得到最新 dirty 并确认，后者在收到当前有效 clean、inputSettled=true 且无遗留未知状态后直接关闭，查询应答到关闭之间不能新增未核对输入

#### Scenario: 退出输入锁保留已接收文字且不重放按键

- **WHEN** 用户键入、粘贴或通过中文输入法组合输入后立即关闭，在退出核对或确认期间尝试新编辑，再选择返回
- **THEN** 锁前控件/model 已接收的文字完整保留；锁期间禁止新编辑、粘贴、放弃和提交，不缓冲重放按键；未收尾组合不能报告可直接退出的 clean，锁前组合的尾随事件仅同步收尾且不自动关闭确认；返回后解锁并恢复焦点，不承诺恢复尚未进入控件的输入法候选

#### Scenario: renderer 失联或应答无效仍有退出确认

- **WHEN** renderer 无响应、崩溃、未握手、应答无效、inputSettled=false 或关闭查询超过 1.5 秒
- **THEN** main 提供“暂时无法确认草稿状态”的原生确认，不静默放行、不无限等待；不因超时断言 renderer 已崩溃或失联，用户仍可返回或明确退出

#### Scenario: 慢响应降级后可取消并重新核对

- **WHEN** 受控延迟或 CPU 降速使仍存活的 renderer 在 1.5 秒阈值内或阈值后应答
- **THEN** 阈值内按有效应答处理，超时进入状态未确认的提示是允许的降级；用户取消后输入保持且锁可解除，迟到应答不关窗，恢复后新查询能正常完成，不将 1.5 秒声称为已实测存活阈值

#### Scenario: 重载不能用空仓库抹掉旧会话未知状态

- **WHEN** 旧 renderer 存在 dirty 或无法确认其状态，新 renderer 重载后报告空草稿
- **THEN** main 不自动消除旧会话丢失状态，下次关闭明确说明先前草稿可能已丢失；用户知悉或确认退出后才处理该标志，不承诺恢复正文

#### Scenario: 旧会话伪造发送者和乱序消息不影响关闭

- **WHEN** main 收到其他窗口/子 frame、旧 session、旧 sequence、非当前 requestId 或非法 dirtyCount 的消息
- **THEN** 拒绝用其更新有效关闭结论，不传输草稿正文、sourceToken、授权或凭据，不因伪造 clean 绕过确认

#### Scenario: 重复关闭取消和迟到应答不会重入

- **WHEN** 用户连续关闭、取消一次确认，随后旧应答到达或再次关闭
- **THEN** 同时最多一个核对/确认，取消解除输入锁且迟到应答不关窗；新关闭重新核对，一次性放行标记不泄漏到后续关闭或重建窗口

#### Scenario: 系统会话结束不沿用普通退出承诺

- **WHEN** Windows 通过 query-session-end/session-end 结束会话，而非用户关闭窗口或调用 app.quit
- **THEN** 不依赖 before-quit 必然触发，不为草稿保护阻止系统会话结束，不承诺显示异步退出确认或恢复草稿；通过隔离事件测试核对边界，不为验收而注销或关闭宿主机

### Requirement: 保留模态框约束焦点并正确恢复

创建、设置和新增放弃确认 SHALL 使用真正模态容器，隔离背景交互、设置初始焦点并约束 Tab/Shift+Tab。Esc SHALL 只处理最上层可关闭界面，Monaco 内部弹层优先消费；关闭后 SHALL 返回触发入口或有效工作区回退点。已有创建执行/目录选择期间的关闭限制 SHALL 保留。

#### Scenario: 创建设置和放弃确认不泄漏焦点

- **WHEN** 用户打开各保留模态框并反复使用 Tab/Shift+Tab，含无可用操作按钮的状态
- **THEN** 初始焦点合理、焦点留在当前模态，背景步骤/运行/设置控件不可被键盘或鼠标操作

#### Scenario: Esc 只关闭最上层并恢复焦点

- **WHEN** 用户在嵌套放弃确认或 Monaco 内部弹层按 Esc，再关闭底层编辑/模态
- **THEN** 一次按键只处理最上层，取消放弃保留草稿，关闭恢复触发焦点；触发节点卸载时使用有效回退点，不落到隐藏元素

#### Scenario: 创建忙碌期间不能通过焦点修复绕过关闭锁

- **WHEN** 创建正在执行或原生目录选择尚未结束，用户按 Esc 或点击关闭
- **THEN** 继续遵守已有 modalLocked，输入不丢失、不触发第二次提交；系统窗口退出仍由 main 草稿 guard 决定

### Requirement: 草稿交互保持既有执行和数据边界

创建、查看、恢复、复制、收起、放弃草稿及退出核对 SHALL 不调用模型/工具、不写既有 trace/附件/源目录。最终明确提交 SHALL 继续使用既有通道、字段校验、能力预检与每次授权，不扩展隔离执行类型。文件阅读和运行阅读状态 SHALL 保持 U1/U2 的恢复行为。

#### Scenario: 草稿操作零执行且已有文件不变

- **WHEN** 用户对全部编辑类型完成输入、导航、恢复、复制、收起和放弃，并取消退出
- **THEN** 模型及工具请求数为零，源目录、父/兄弟 trace 与既有附件逐文件哈希不变，无草稿持久化文件

#### Scenario: 原有执行入口和文件阅读继续可用

- **WHEN** 经草稿恢复后分别确认普通/隔离创建、result、prompt、messages 与 A/B 的合法请求，并在步骤/文件间往返
- **THEN** 请求沿用原有执行语义和门禁，隔离 prompt/A-B 不获新权限；U1/U2 的页签、调用、检查点、路径及阅读位置恢复不被草稿覆盖
