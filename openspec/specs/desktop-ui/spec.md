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

渲染进程 SHALL NOT 持有任何文件系统访问能力（`nodeIntegration` 关闭、`contextIsolation` 开启），只经预加载脚本暴露的受限接口获取数据；主进程返回的跨进程数据 SHALL 经 zod 校验后方可进入渲染层。操作请求、执行响应、status 和 reconcile SHALL 使用受限 schema，并由 main 校验 sender/frame、身份及业务参数；操作摘要 SHALL NOT 绕过现有详情版本守卫。

#### Scenario: 预加载接口不含文件能力

- **WHEN** 渲染层尝试访问文件系统 API
- **THEN** 该 API 不可用（未暴露），只能通过受限接口取数

#### Scenario: 主进程返回非法结构

- **WHEN** 主进程返回的数据未通过结构校验
- **THEN** 界面显示错误提示，不渲染部分数据

#### Scenario: 非法操作响应不能解除门禁

- **WHEN** 执行/status/reconcile 返回错误状态联合、非法 runIds、错配 epoch/operationId 或不自洽槽引用
- **THEN** renderer 拒绝应用并保留未知状态与锁，不部分采纳所谓成功字段；详情 v1/v2 校验继续生效

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

`parent` 非空的 run SHALL 依据详情的完整性与轨迹范围展示。普通/隔离 result 只有在 `completeness=complete` 且 `spanScope=resolved` 时才展示共享前缀与自有新增 span：v1 截至 fork 点（含该点），v2 按 resume_after_step 保留整轮及后代，遵守既有 resolver 定位规则。界面 SHALL 标注分叉点 span、被编辑字段，并明示前缀来自哪个父 run。prompt、代理 messages 和 `model_params` 即使完整也 SHALL 只展示当前 run 自有 spans，并单独展示父级 chain，不声称共享执行前缀。混合链 SHALL 逐 hop 尊重独立执行边界。ownOnly SHALL 只展示当前 run 自有 spans，持续显示父链不完整及结构化缺失原因。

#### Scenario: 分支 run 的轨迹

- **WHEN** 打开一个 `completeness=complete`、`spanScope=resolved` 的普通 result 分支
- **THEN** 树呈现父 run 截至 fork 点的前缀加上本 run 新增 spans，分叉点和被编辑字段均被标注，界面提示前缀所属父 run

#### Scenario: 完整独立分支不拼接父轨迹

- **WHEN** 打开一个 `completeness=complete`、`spanScope=own` 的 prompt、代理或 model_params 分支
- **THEN** 时间线只呈现本 run 自有 spans，父级 chain 作为独立来源信息展示，不声称存在共享执行前缀

#### Scenario: 部分普通分支不伪造共享前缀

- **WHEN** 打开一个 `completeness=ownOnly` 的普通 result 分支
- **THEN** 时间线只呈现当前 run 自有 spans，显示“仅显示本运行记录，父链不完整”和缺失 run ID；不补零、不显示祖先增量、不将 chain 断点两侧拼成完整轨迹

#### Scenario: 部分来源链首项不冒充根

- **WHEN** ownOnly chain 从当前 run 向上保留了一个或多个可读中间 hop，但根 run 缺失
- **THEN** 来源区域明确标为截断链，不能把 `chain[0]` 显示为根或绘制一条虚假的根到叶连接

#### Scenario: 完整普通分支保留被编辑字段

- **WHEN** 打开一个完整普通 result 分支，其 fork 编辑字段为 `result`
- **THEN** 分叉点同时标注 span、被编辑字段和直接父 run，合并轨迹与既有完整语义一致

#### Scenario: 独立分支来源链完整但不共享执行前缀

- **WHEN** 打开完整 prompt、proxy 或 model_params 分支并展开父级来源
- **THEN** 父级只作为 lineage 展示，本 run 时间线不插入父 spans，用户能区分“父级溯源”和“共享执行前缀”

#### Scenario: ownOnly 文件入口不显示祖先检查点

- **WHEN** ownOnly 隔离 run 有当前自有完成步骤，但缺失祖先也有文件检查点
- **THEN** 文件选择器只列当前 run 初始状态和自有完成步骤，不显示或读取祖先检查点，不回读源目录

#### Scenario: 完整隔离 result 保留整轮前缀

- **WHEN** v2 隔离 result 及其父链通过版本、schema 与定位校验，编辑点后同轮还有兄弟工具调用
- **THEN** 返回 completeness=complete、spanScope=resolved、lineage.status=complete，chain 为完整根到叶来源且 leafSpanIds 仅含当前自有 spans；前缀保留 resume_after_step 整轮及全部后代，不按 at_span 截掉后续兄弟；边界不属于直接父自有步骤时拒绝

#### Scenario: 混合父链不跨独立边界拼接

- **WHEN** result 子分支引用从头执行的 prompt/model_params 父本，且完整来源链中还存在更早祖先
- **THEN** chain 保留全部来源，子分支只取直接父有效轨迹的对应前缀和自身新增记录，不再混入独立边界之前的祖先 spans；未知 edit.field 明确拒绝而非默认 result

#### Scenario: 缺祖先与缺附件分别诊断

- **WHEN** ownOnly 隔离 run 打开合法自有检查点，其 blob 存在或缺失
- **THEN** 存在时正常按 C 校验读取，缺失时显示原附件错误；不把 blob 缺失当祖先缺失，不因来源缺失封禁全部自有文件阅读

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

系统 SHALL 提供运行配置入口：baseURL / apiKey / model。apiKey SHALL 优先经 Electron safeStorage 加密后写入数据目录（不落 AppData/注册表）；safeStorage 不可用（如 Linux 无 keyring）时 SHALL 降级明文存储并向用户明示风险。未配置时点击"重跑"SHALL 提示先配置，不发起调用。main SHALL 在保存/清除配置及代理启停保存前校验执行槽和关闭/配置变更互斥，禁止只依赖 renderer disabled。配置读取 SHALL 保持可用且不回传密钥；历史 run 不因设置改变而被改写。

#### Scenario: 配置后重跑可用

- **WHEN** 用户填写 baseURL/apiKey/model 并保存
- **THEN** apiKey 以加密形式存在于数据目录，重跑使用该配置发起真实调用

#### Scenario: 未配置时提示

- **WHEN** 尚未配置运行参数即点击重跑
- **THEN** 界面提示先完成运行配置，不发任何网络请求

#### Scenario: 直接 IPC 不能绕过配置锁

- **WHEN** 任一主动操作占槽时绕过 UI 调用 settings:save、settings:clear 或 proxy:toggle
- **THEN** main 拒绝且配置文件、已使用的配置快照和代理处理器不变，settings:get/proxy:status 仍可用

#### Scenario: 配置变更与主动接受原子互斥

- **WHEN** settings 保存/清除或代理异步启停与新主动提交竞争
- **THEN** 先取得互斥的一方完成前另一方被拒绝；代理启停及启动恢复期间保持配置变更标记，finally 释放，不把标记伪装为主动 run

#### Scenario: settled 后读取失败不阻止配置

- **WHEN** 旧操作已 settled、当前 main 槽和互斥标记均空，但该操作结果详情读取失败
- **THEN** 可保存/清除配置，结果读取失败不能作为执行中证据；新设置仅影响后续新 operationId 的操作

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

录制接入 SHALL 使用独立全局工作区，设置对话框仅提供跳转。工作区 SHALL 提供启用意图、监听端口（默认 18787）、upstream base_url（默认 `https://api.deepseek.com`）及显式“保存并应用”。系统 SHALL 分别呈现已保存 enabled 与真实 running，不把未应用输入或启用意图当作监听事实；全局栏 SHALL 显示真实监听状态及端口。配置应用 SHALL 反馈成功或明确错误，本会话凭据状态仅显示 hasKey，不回传凭据值。

#### Scenario: 启用代理

- **WHEN** 用户从设置跳转录制工作区，打开代理开关并保存且监听成功

- **THEN** 状态指示变为运行中（显示端口 18787），用户可立即把应用的 base\_url 指过来

#### Scenario: 端口占用可见

- **WHEN** 保存启用但端口被占用

- **THEN** 录制工作区呈现明确错误并保留输入，重新读取后分别显示实际保存的启用意图与监听状态；若保存成功但监听失败则明确已启用但未监听，不伪造配置回滚

#### Scenario: key 捕获状态

- **WHEN** 代理运行中但本会话尚无任何请求经过

- **THEN** 状态指示标明「未捕获 key」，重发功能预期不可用的状态与之一致

#### Scenario: 接入地址只来自已核实监听

- **WHEN** 用户编辑端口但尚未应用，或应用成功后复制地址
- **THEN** 仅当最新有效状态 running=true 时可复制真实监听端口对应的本地 /v1 地址，不复制草稿端口或 upstream；复制失败可见，零测试请求

#### Scenario: 停止或未知状态撤销地址

- **WHEN** 配置应用在飞、代理已停止、应用失败后监听未恢复或状态读取失败
- **THEN** 显示停止、未监听或状态待读取，接入地址不可复制；hasKey=true 不被解释为正在监听或上游连接成功

#### Scenario: 应用失败回读也失败保留输入

- **WHEN** 代理配置应用失败且随后的状态回读失败
- **THEN** 保留原始配置输入与两层诊断，实际保存/监听状态显示未知；仅重读状态的动作不重新应用、不启动服务

#### Scenario: 代理应用沿用配置互斥

- **WHEN** 主动执行槽被占、操作通信未知或另一配置变更在飞时尝试保存并应用
- **THEN** 依既有 main 门禁拒绝，不新建主动操作、不清配置输入；状态读取、历史记录阅读和返回保持可用

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

代理 run 的 `llm.call` 详情 SHALL 提供「编辑重发」入口并进入带来源与返回动作的主工作区：编辑器（Monaco，懒加载，复用既有编辑器加载机制）呈现 `request.messages` 全文（JSON），提交时走 `proxy:fork`（含源 run id、源 llm.call span id、编辑后 messages）。未修改 SHALL 禁用提交（空 fork 防线）；本会话未捕获 key SHALL 呈现明确指引（先把应用经代理跑一次）而非灰按钮无解释。重发确认处 SHALL 明示「将真实调用 upstream 并产生 API 费用」。执行结束 SHALL 刷新列表并按可信身份核实结果，自动导航仅在本次流程意图仍有效时进行；失败（upstream 报错等）SHALL 呈现错误详情且源 run 不受影响。

#### Scenario: 编辑并重发成功

- **WHEN** 用户在编辑器中修改 messages 的一条内容并确认重发
- **THEN** 经 `proxy:fork` 产生新 run（parent/fork.edit 如 llm-proxy spec），列表出现新 run，按可信 ID 可查看新响应；持续留在本次流程才可自动进入其概览，已离开只通知

#### Scenario: 未修改禁用

- **WHEN** 编辑器内容与原始 messages 逐字节一致
- **THEN** 提交按钮禁用，无任何网络请求

#### Scenario: 未捕获 key

- **WHEN** 本会话代理未捕获任何 key 时用户点击重发
- **THEN** 呈现明确提示「本会话未捕获到 key，请先把你的应用经代理跑一次」，不发起请求

#### Scenario: SDK run 无此入口

- **WHEN** 选中一个非代理 run 的 `tool.invoke` 或 `llm.call`
- **THEN** 既有 ForkEditor（tool.result 编辑重跑）行为不变；messages 编辑重发入口不出现（分叉语义属 replay 路径，本变更不越界）

#### Scenario: 停用代理仍有凭据不能重发

- **WHEN** hasKey=true 但代理当前未监听时用户尝试重发
- **THEN** 保留 messages 草稿，明确需恢复代理服务并重新核对当前会话状态；不只按 hasKey 放行，不使用桌面模型 key 替代

#### Scenario: 主动重发结果不借被动记录

- **WHEN** 主动重发期间外部请求被动录制，或本次重发录制写入失败
- **THEN** 只读取 main 为本次 operation 关联的可信 ID，写入失败保留诊断和草稿，不把其他录制记录当作本次结果

### Requirement: run 列表载荷暴露 fork 摘要

run 列表的每条记录 SHALL 携带该 run 的分叉摘要：`fork: { at_span, edit_field } | null`（根 run 与老文件为 `null`）。摘要 SHALL 只含分叉点 span id 与被编辑字段名，SHALL NOT 携带被编辑的值（value 可能是整段工具结果或完整 messages，列表载荷不需要，也不得因此放大跨进程数据量）。该字段为向后兼容新增——不含该字段的旧载荷 SHALL 被按「无分叉摘要」处理，不报错。

#### Scenario: 分支 run 带摘要

- **WHEN** run B 的 `meta.fork` 为 `{ at_span: "s_03", edit: { field: "result", value: "…" } }`
- **THEN** 列表载荷中 B 的 fork 摘要为 `{ at_span: "s_03", edit_field: "result" }`，不含 value

#### Scenario: 根 run 与老文件

- **WHEN** run 为根 run（`parent` 为 null、`fork` 为 null）
- **THEN** 其 fork 摘要为 `null`，不臆造分叉信息

### Requirement: 界面提供分支树与轨迹两种视图

header SHALL 提供分支树与运行工作区的视图切换入口。切到分支树时，主区域 SHALL 呈现宽幅分支关系与比较选择入口，指标对照及双运行正文在完整工作区内打开；切回运行工作区时 SHALL 呈现所选 run 的概览/步骤/文件页签，恢复其有效阅读位置，首次访问默认概览，SHALL NOT 强制恢复固定三栏。两种视图 SHALL 共享同一份 run 列表与同一个选中 run 状态。视图切换 SHALL NOT 触发列表重新加载。既有最多四条指标对照及其比较限制 SHALL 保持。

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
- **THEN** 既有指标及本 run/沿链口径保持，超出上限或不可比条件仍按原规则提示，不新增臂间差值或胜出结论；可进入已实现的双运行修改与输出比较，三四条须先明确选两条

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

系统 SHALL 从全局新建入口打开主工作区创建页面并保留运行导航与来源位置，包含必填任务（User Message）、高级区可空系统指令（System Prompt），以分段控件选择默认“纯对话”或“隔离文件运行”。两模式 SHALL 显示当前已保存的模型/接入摘要及就近配置入口。纯对话 SHALL 继续使用空工具表；隔离模式 SHALL 提供原生目录选择和显式副本写入复选框，显示采集范围及工具读取内容进入已配置模型请求的事实。未选目录或未授权 SHALL 禁用隔离提交；main SHALL 重复校验。

提交后 SHALL 经 runs:create 读取 settings，从 system+user 消息创建根 run，parent/fork 为 null，不写 source，task 等于 userMessage。纯对话 config_hash SHALL 等于 `configHash(systemPrompt,[])` 且产出 v1；隔离模式 SHALL 按固定 profile 工具表计算指纹并产出带检查点的 v2。临时 trace SHALL 不出现在列表；结束后文件名等于 meta.id，结果刷新/读取与导航 SHALL 遵守可信身份及用户阅读意图，不依赖创建页面保持挂载。

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
- **THEN** 在导入写入和模型请求前返回 SETTINGS_NOT_CONFIGURED，提示并提供就近配置入口，任务保留

#### Scenario: userMessage 为空时禁用提交

- **WHEN** User Message 为空
- **THEN** 创建按钮禁用，无网络请求

#### Scenario: 空 systemPrompt 允许

- **WHEN** System Prompt 留空且其余条件有效
- **THEN** 允许创建，纯对话指纹按空字符串和空工具表计算；隔离模式按空字符串和固定工具组计算

#### Scenario: 执行失败不产生半成品

- **WHEN** LLM 失败并由 runLoop 以 errored 封存
- **THEN** 文件按 meta.id 归位，列表刷新使失败运行可见，status 仍表示已封存；IPC 返回 CREATE_RUN_FAILED 并可按可信身份打开失败详情，已记录隔离检查点数据完整保留且轨迹可读，临时文件不出现在列表

#### Scenario: 直接创建隔离文件父本

- **WHEN** 用户选择受支持源目录、勾选副本写入并提交隔离模式
- **THEN** 生成 v2 根运行，详情可阅读轨迹和来源；从原始 trace 验证初始与各轮检查点已记录，源目录字节不变，后续可编辑工具结果发起隔离分叉；不要求文件页

#### Scenario: 创建工作区任务优先且可返回来源

- **WHEN** 用户从任一阅读位置打开新建，填写长任务并展开高级系统指令，再返回来源
- **THEN** 主工作区显示单列表单且运行导航保留，两模式均有模型摘要；返回恢复有效来源位置并保留草稿。来源仅存 renderer 会话导航状态，不进入草稿或持久存储；从其他工作区再次进入创建时取新来源，创建内重复点击及设置往返保持本次来源，重载后失效并回退有效工作区；不创建临时运行项或增加请求级模型/配额字段

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

系统 SHALL 提供紧凑全局栏、可收起/调整宽度的运行导航及主工作区。全局栏 SHALL 提供真实可用的新建运行、录制接入和设置入口；新建与列表标题区既有入口打开同一创建工作区，录制接入定位现有代理设置。单运行工作区 SHALL 使用概览、步骤、按能力提供的文件平级页签，保持当前任务、状态和来源可辨。

首次成功加载列表且尚未选择运行、用户也尚未主动进入其他工作区时 SHALL 尝试最近可读摘要对应的运行并进入概览；详情失败时 SHALL 留在该运行错误态，不循环跳到其他记录。无运行时 SHALL 提供新建和录制两个实际入口。首次读取迟到或后台刷新 SHALL NOT 覆盖用户已进入的创建/编辑流程。文件页 SHALL 占主工作区，不常驻无关步骤目录；合法隔离运行附件异常时 SHALL 保留文件入口，继续使用既有文件读取/版本/能力校验。

所有现有普通/隔离创建、result 重跑、prompt/messages 编辑、模型实验、设置及旧分支/指标入口 SHALL 保持可达并遵守现有门禁，SHALL NOT 因导航收起而消失。阅读动作 SHALL NOT 触发模型调用、写入 trace/附件或恢复写入授权。

#### Scenario: 首次打开与无运行入口

- **WHEN** 首次列表加载成功且无选中项，或数据目录没有运行
- **THEN** 用户未主动进入其他工作区时只尝试最近可读摘要对应的运行并进入概览，已打开创建则保持其页面和输入；空目录显示可操作的新建和录制入口，不显示营销欢迎页；选择失败时可原位重试而不自动遍历其他运行

#### Scenario: 文件承载区不附带步骤目录

- **WHEN** 用户在合法隔离运行切到文件页
- **THEN** 文件视图使用整个主工作区正文，没有无关步骤目录；附件缺失/损坏仍保留文件入口和既有异常说明，普通无文件世界运行不出现虚假文件页

#### Scenario: 旧创建设置及执行入口保持可达

- **WHEN** 用户收起导航，再新建、打开设置/录制，或从受支持运行进入 result、prompt、messages 与模型实验入口
- **THEN** 所有已有入口仍可达，创建进入主工作区；普通与隔离参数/预检/每次授权、费用确认及隔离 prompt/A-B 拒绝保持，操作核对使用已有全局入口，不显示未实现的取消能力

#### Scenario: 阅读过程不修改已有数据

- **WHEN** 用户搜索、刷新、切换概览/步骤/文件、展开原文、查看预算、打开分支并返回
- **THEN** 既有 trace、附件与源目录逐字节不变，不额外调用模型或工具，不从历史阅读状态继承执行授权

### Requirement: 运行概览呈现自有结果与消耗

系统 SHALL 在首次访问运行时呈现概览，以当前运行自有终止事件区分正常、失败、限制、中止和中断，SHALL NOT 使用请求返回成功或祖先结局代替。正常结束 SHALL NOT 表示质量验证或测试通过。结构或版本不合法时 SHALL 继续拒绝详情，不能为展示概览放宽校验。

概览 SHALL 从当前运行自有调用选择输出：正常终止且最后自有模型调用记录非空正文、无错误及无待执行工具调用时展示已记录最终输出；不满足时明确未记录最终输出。失败/限制/中断前的正文及更早正文 SHALL 作为单独的中间输出保留，不能冒充最终结果；仅有思维链/工具调用时 SHALL 如实说明并可打开原调用，不从祖先或模型生成总结补全。

概览 SHALL 显示真实记录的自有 LLM 错误及其定位入口，工具错误可单独定位，不断言其为终止根因。错误终止但自有 LLM 错误详情未记录时 SHALL 保留缺失说明，不用祖先错误、零 token 或最后调用猜原因。定位 SHALL 打开对应调用及其所属 step。

本次消耗 SHALL 仅由自有 spans 现算，含 token、已记录时间、工具调用/错误及已记录缓存，未知不补零；失败占位零用量 SHALL 保留解释。来源 SHALL 展示真实父本、修改字段与既有隔离边界，可返回父记录；来源关系不一律表示共享执行前缀。概览 SHALL NOT 将工具返回修改称为文件修改，也不新增沿链总成本。普通运行有真实直接父引用时 SHALL 提供“与父运行对比”，默认父左子右；无父引用不显示该入口。父不可读时进入明确的不可用状态，不猜测替代父本；model_params 遵守实验比较门禁，不提供绕过门禁的父子比较入口。

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

- **WHEN** 读取详情遇到当前记录缺失、不支持格式、v1 非法隔离字段、JSON/schema 或跨行错误、权限错误、成环或非法 fork 定位
- **THEN** 显示原位详情错误与只读重试，不渲染未经校验的部分概览，不将这些错误通用降级为 ownOnly，不放宽执行权限

#### Scenario: 缺祖先概览沿用已校验自有事实

- **WHEN** 当前记录通过完整校验，且仅因结构化确认祖先文件不存在而返回 ownOnly
- **THEN** 概览显示“仅显示本运行记录，父链不完整”和真实缺失 ID，自有结局、输出、步骤与消耗可读；继承前缀、完整共同祖先和沿链增量仍未知，不从列表缓存补全，也不恢复执行资格

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

创建 SHALL 在会话内保留模式、任务和系统指令，离开后再次打开创建工作区恢复，明确放弃或核实正常结束且匹配修订才清理。A/B SHALL 保留有稳定身份和顺序的整批臂配置，包括未通过校验的 model/paramsText；增删或修改均计入批次修订。两者 SHALL 保持独立数据结构，不保存凭据、授权或 dry-run 计划到草稿。

#### Scenario: 创建关闭配置再新建仍有任务

- **WHEN** 用户在任一创建模式输入任务和系统指令，离开创建、打开并关闭设置、再次点击新建
- **THEN** 模式及两个文本字段逐字恢复到创建工作区，本次副本授权未勾选；未编辑的默认空表单不冒充草稿

#### Scenario: 切创建模式保留文本而放弃重置表单

- **WHEN** 用户切换纯对话与隔离模式，或对有修改的创建草稿执行放弃
- **THEN** 切模式保留任务和系统指令但清除目录引用与授权；放弃取消时保持输入，确认后恢复纯对话空表单并清除该创建的目录引用

#### Scenario: 实验臂增删和非法参数可恢复

- **WHEN** 用户新增和删除 A/B 臂、修改模型并输入未完成参数 JSON，再切调用或运行后返回
- **THEN** 臂身份、顺序和原始参数文本完整恢复，整批修订正确，原初始臂不算 dirty，未校验参数不能用于真实执行

#### Scenario: 实验预览和结果不隐式清理批次

- **WHEN** A/B dry-run 返回、真实执行信封全部返回或部分臂失败后用户重新打开实验
- **THEN** 不以计划、IPC ok 或部分结果清除配置；只有全部预期臂自有正常终止已核实且批次修订仍匹配才清理，其他情况保持完整，恢复后需重新预览与确认副作用

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

每次提交 SHALL 原子绑定草稿键、修订和请求快照，以及 epoch/operationId，在该请求待定时冻结对应草稿的修改/放弃。组件卸载或展示状态复位 SHALL NOT 解除冻结。所有响应 SHALL 只处理匹配关联，响应本身 SHALL NOT 自动删除草稿；清理仅发生在独立核实正常终止并通过目标/修订/后续提交检查之后。无法确定执行状态时 SHALL 保留输入和冻结，不自动重发；可信 settled/notAccepted 核对 SHALL 仅解冻该提交并保留后续核实所需关联。新执行 SHALL 使用新 ID 并重新预检/确认授权，不复用失败或已封禁操作的许可。

#### Scenario: 提交快照独立于编辑器挂载

- **WHEN** 用户提交 result、prompt、messages、创建或 A/B 后，编辑组件卸载并再次挂载
- **THEN** 待定草稿仍对应原 key/revision 和提交值且不可修改或放弃，卸载不重发、不解冻；其他草稿输入不被覆盖

#### Scenario: 成功错误和部分失败均保留草稿

- **WHEN** 任一现有执行入口收到 ok、业务拒绝、明确请求失败或 A/B 部分失败，但尚未独立核实全部预期结果正常终止
- **THEN** 提交草稿保持原文，已由可信终态或明确本地未发送证明结束的本次关联可解冻；IPC 返回 ID 不能触发清理，部分失败保留整批

#### Scenario: 迟到回调与未知状态不能错误解冻

- **WHEN** 回调不再匹配当前提交关联，或通道断开无法判断执行是否仍在进行
- **THEN** 旧回调不解冻新提交、不删除新修订；状态未知保留冻结与可复制输入，重开编辑器不能解锁或自动重发

#### Scenario: 核对终态只解冻对应修订

- **WHEN** reconcile 返回 running、settled 或 notAccepted
- **THEN** running 保持对应冻结，后两者仅解冻匹配 epoch/operationId/key/revision/token 的关联并先保留原文；settled 后续核实正常结果才按修订清理，新提交重新取得许可，不恢复旧 sourceToken 或授权

### Requirement: 主进程核对草稿后决定常规退出

main SHALL 拦截标题栏关闭、Alt+F4 和 app.quit，向目标 renderer 请求新鲜 dirty 元数据，并核对 main 活跃执行槽；存在草稿、活跃操作或状态无法确认时 SHALL 显示一次合并的原生退出确认，默认返回。renderer SHALL 在锁前同步控件已接收输入，锁定新编辑直至关闭决定，并报告 inputSettled；超时或输入未完成同步 SHALL NOT 当作 clean。main SHALL 在退出协商期间阻止新主动执行和配置变更。确认只放行本次退出，取消保留已接收文字并恢复编辑，SHALL NOT 取消活跃操作或释放其槽。协议 SHALL 校验 sender/frame、文档会话、序号和查询身份，只传元数据。

Windows 注销、关机、系统重启及强制结束进程不在此退出确认保证内；系统 SHALL NOT 为草稿或操作保护阻止系统结束会话或承诺恢复内存草稿/任务。明确退出 SHALL NOT 被解释为上游请求、费用或副作用已撤销。

#### Scenario: 有草稿时关闭可返回或明确退出

- **WHEN** 任一类型草稿为 dirty，用户点击标题栏关闭、按 Alt+F4 或走 app.quit
- **THEN** 出现一次原生确认并明确会话草稿会丢失；默认/取消返回且输入不变，明确退出才关闭，不承诺重启恢复或副作用撤销

#### Scenario: 最新 clean 应答才允许直接关闭

- **WHEN** 最后一次上报为 clean 后用户输入最后一个字符并立即关闭，或全部草稿已回到基线/明确放弃后关闭
- **THEN** main 均重新查询；前者得到最新 dirty 并确认，后者仅在当前有效 clean、inputSettled=true、无遗留未知状态、无活跃操作且无进行中配置变更时直接关闭，查询应答到关闭之间不能新增未核对输入或主动操作

#### Scenario: 退出输入锁保留已接收文字且不重放按键

- **WHEN** 用户键入、粘贴或通过中文输入法组合输入后立即关闭，在退出核对或确认期间尝试新编辑，再选择返回
- **THEN** 锁前控件/model 已接收的文字完整保留；锁期间禁止新编辑、粘贴、放弃和提交，不缓冲重放按键；未收尾组合不能报告可直接退出的 clean，锁前组合的尾随事件仅同步收尾且不自动关闭确认；返回后解锁并恢复焦点，不承诺恢复尚未进入控件的输入法候选

#### Scenario: renderer 失联或应答无效仍有退出确认

- **WHEN** renderer 无响应、崩溃、未握手、应答无效、inputSettled=false 或关闭查询超过 1.5 秒
- **THEN** main 提供“暂时无法确认草稿状态”的原生确认，不静默放行、不无限等待；不因超时断言 renderer 已崩溃或失联，用户仍可返回或明确退出，已知活跃操作事实同时呈现

#### Scenario: 慢响应降级后可取消并重新核对

- **WHEN** 受控延迟或 CPU 降速使仍存活的 renderer 在 1.5 秒阈值内或阈值后应答
- **THEN** 阈值内按有效应答和 main 操作状态处理，超时进入状态未确认的提示是允许的降级；用户取消后输入保持且输入锁可解除，活跃槽不被释放，迟到应答不关窗，恢复后新查询能正常完成，不将 1.5 秒声称为已实测存活阈值

#### Scenario: 重载不能用空仓库抹掉旧会话未知状态

- **WHEN** 旧 renderer 存在 dirty 或无法确认其状态，新 renderer 重载后报告空草稿
- **THEN** main 不自动消除旧会话丢失状态，下次关闭明确说明先前草稿可能已丢失；用户知悉或确认退出后才处理该标志，不承诺恢复正文；main 活跃操作也不因重载消失

#### Scenario: 旧会话伪造发送者和乱序消息不影响关闭

- **WHEN** main 收到其他窗口/子 frame、旧 session、旧 sequence、非当前 requestId 或非法 dirtyCount 的消息
- **THEN** 拒绝用其更新有效关闭结论，不传输草稿正文、sourceToken、授权或凭据，不因伪造 clean 绕过确认

#### Scenario: 重复关闭取消和迟到应答不会重入

- **WHEN** 用户连续关闭、取消一次确认，随后旧应答到达或再次关闭
- **THEN** 同时最多一个核对/合并确认，取消解除输入/关闭协商锁但保留活跃执行槽，迟到应答不关窗；新关闭重新核对，一次性放行标记不泄漏到后续关闭或重建窗口

#### Scenario: 系统会话结束不沿用普通退出承诺

- **WHEN** Windows 通过 query-session-end/session-end 结束会话，而非用户关闭窗口或调用 app.quit
- **THEN** 不依赖 before-quit 必然触发，不为草稿或操作保护阻止系统会话结束，不承诺显示异步退出确认或恢复草稿/任务；通过隔离事件测试核对边界，不为验收而注销或关闭宿主机

#### Scenario: 无草稿的活跃操作也需确认

- **WHEN** renderer 报 clean 而 main 仍有 running，或 renderer 重载后关闭窗口
- **THEN** 仍显示一次活跃操作退出确认，明确上游可能继续；返回后原操作继续且登记不丢，确认退出不记录为已取消

#### Scenario: 草稿与操作合并且关闭竞争不漏保护

- **WHEN** dirty 和 running 同时存在，或退出协商期间收到新主动请求/操作终态
- **THEN** 仅出现一次包含两类事实的确认；新主动请求在副作用前拒绝，已显示确认不因操作 settled 自动关闭，取消后重新开放提交仍以当前 main 槽为准

### Requirement: 保留模态框约束焦点并正确恢复

设置和放弃/必要执行确认 SHALL 使用真正模态容器，隔离背景交互、设置初始焦点并约束 Tab/Shift+Tab。创建 SHALL 作为可导航的工作区页面，不再使用执行期间锁住全窗口的模态。Esc SHALL 只处理最上层可关闭界面，Monaco 内部弹层优先消费；关闭后 SHALL 返回触发入口或有效工作区回退点。原生目录选择 SHALL 防重入，迟到选择不得覆盖新流程。

#### Scenario: 创建设置和放弃确认不泄漏焦点

- **WHEN** 用户在创建页打开设置或放弃/执行确认等真正模态，并反复使用 Tab/Shift+Tab，含无可用操作按钮的状态
- **THEN** 初始焦点合理、焦点留在当前模态，背景创建/步骤/运行控件不可被键盘或鼠标操作；未打开模态的创建页面允许导航

#### Scenario: Esc 只关闭最上层并恢复焦点

- **WHEN** 用户在嵌套放弃确认或 Monaco 内部弹层按 Esc，再关闭底层编辑/模态
- **THEN** 一次按键只处理最上层，取消放弃保留草稿，关闭恢复触发焦点；触发节点卸载时使用有效回退点，不落到隐藏元素

#### Scenario: 创建忙碌期间不能通过焦点修复绕过关闭锁

- **WHEN** 创建正在执行或原生目录选择尚未结束，用户通过键盘尝试离开、关闭界面或重复提交
- **THEN** 执行期间允许离开创建阅读，草稿冻结与执行槽仍不可绕过；原生选择期间防重入且迟到结果受代次校验，系统窗口退出仍由 main 合并保护决定，离页不等于取消

### Requirement: 草稿交互保持既有执行和数据边界

创建、查看、恢复、复制、收起、放弃草稿及退出核对 SHALL 不调用模型/工具、不写既有 trace/附件/源目录。最终明确提交 SHALL 继续使用既有通道、字段校验、能力预检与每次授权，不扩展隔离执行类型。文件阅读和运行阅读状态 SHALL 保持 U1/U2 的恢复行为。

#### Scenario: 草稿操作零执行且已有文件不变

- **WHEN** 用户对全部编辑类型完成输入、导航、恢复、复制、收起和放弃，并取消退出
- **THEN** 模型及工具请求数为零，源目录、父/兄弟 trace 与既有附件逐文件哈希不变，无草稿持久化文件

#### Scenario: 原有执行入口和文件阅读继续可用

- **WHEN** 经草稿恢复后分别确认普通/隔离创建、result、prompt、messages 与 A/B 的合法请求，并在步骤/文件间往返
- **THEN** 请求沿用原有执行语义和门禁，隔离 prompt/A-B 不获新权限；U1/U2 的页签、调用、检查点、路径及阅读位置恢复不被草稿覆盖

### Requirement: 主动执行由 main 会话身份登记和去重

main SHALL 在启动时生成全窗口共用的 epoch，并为普通/隔离 create、普通/隔离 result fork、prompt fork、proxy messages 重发及 A/B 真实执行登记 epoch/operationId。登记 SHALL 包含类型、目标、running/settled/notAccepted、可信 runIds、请求结局及安全诊断；仅存 main 内存且终态与封禁保留至该会话结束。相同 ID 和相同规范化业务请求 SHALL 仅关联原操作，异参 SHALL 拒绝；判重 SHALL 先于任何授权消费、文件副作用或模型/工具调用。请求正文、sourceToken、凭据和原始错误 SHALL NOT 存入登记或查询返回。

每次请求的指纹与实际编排业务参数 SHALL 来自入口同一次 schema parse 产生的不可变业务快照。实现 SHALL NOT 回用原始 payload、重新补出不同缺省值或在指纹生成后修改快照；包层入参映射与既有领域校验 SHALL 保持该快照的业务值。

#### Scenario: 七类主动入口均绑定身份

- **WHEN** 普通/隔离创建、普通/隔离 result、prompt、proxy 或 A/B 实际提交到 main
- **THEN** 均校验 epoch/operationId 并登记唯一操作，缺少身份的直接 IPC 在副作用前拒绝；dry-run 不进入该执行分支

#### Scenario: 同 ID 重复请求只执行一次

- **WHEN** 七类入口各自收到相同 ID 和相同请求的并发重复提交，或 settled 后再次收到同一请求
- **THEN** 只执行原操作，返回原关联/终态；模型及工具调用、trace 创建、源导入和 sourceToken 消费均不因重复增加，即使 settings 后来改变也不重新执行

#### Scenario: 同 ID 异参和跨通道复用被拒绝

- **WHEN** 复用 operationId 却改变通道、模式、目标、编辑内容、臂顺序、参数类型、sourceToken 或授权声明
- **THEN** 返回明确冲突且不改变原登记，不消费许可、不执行；对象属性顺序变化视为相同，正文空白和数组顺序变化不得视为相同

#### Scenario: 指纹与执行使用同一解析快照

- **WHEN** 合法请求经 schema 注入缺省值、转换字段或处理未知字段，随后生成指纹并进入编排，或尝试修改其嵌套业务字段
- **THEN** 指纹和实际编排参数均从同一次解析结果派生，修改尝试不能改变已绑定业务值；等价解析结果的同 ID 重复请求只关联原操作，业务值不同仍拒绝，不能仅以对象引用相等代替参数和调用次数验证

#### Scenario: 旧 epoch 和非法身份无副作用

- **WHEN** 旧 main epoch、非法 operationId 或不受信任 sender/frame 发起主动请求或 reconcile
- **THEN** main 在副作用前拒绝，不创建当前会话操作、不释放当前槽、不消耗 token

#### Scenario: 会话登记不泄漏输入和凭据

- **WHEN** 提交含敏感标记的任务、messages、臂参数、token 或上游错误，再查询 running/settled 和关闭操作入口
- **THEN** 查询/登记/诊断仅含允许元数据与内部不可逆指纹，不含敏感正文、授权值、凭据或 stack；关闭入口不删除登记，不产生新的持久操作文件

### Requirement: main 原子执行槽覆盖所有主动编排

main SHALL 在接受主动请求时同步占用唯一执行槽，直到该操作执行及资源/文件收尾结束后原子置 settled 并释放自己的槽。A/B SHALL 整批占槽。拒绝尚未接受的新请求 SHALL 登记 notAccepted 且封禁该 ID；接受后的业务失败 SHALL 以 settled 记录。只读操作与代理被动录制 SHALL NOT 占主动槽。配置变更和关闭协商 SHALL 与接受新主动执行互斥，renderer 展示或读取成功 SHALL NOT 作为释放条件。

#### Scenario: 不同入口并发只有一个被接受

- **WHEN** 两个不同 operationId 从相同或不同窗口的任意主动入口同时到达
- **THEN** 原子接受一个并占槽，另一个 notAccepted 且零执行/许可消费；忙碌请求在槽释放后迟到也不能自动执行，用户再次提交须用新 ID

#### Scenario: 执行和收尾结束才释放本操作

- **WHEN** 编排已返回但 trace 归位或资源清理仍被受控延迟，或执行/收尾随后抛错
- **THEN** 延迟期间仍占槽，最终以 settled 和真实请求结局结束并只释放自己占用的槽；错误不丢已知 runIds，不依赖 renderer 存活

#### Scenario: A-B 一批占槽直到全部收尾

- **WHEN** 多臂实际执行中首臂结束或失败而后续臂尚未完成
- **THEN** 批次保持 running 且不允许第二主动操作，最后一臂和批次收尾后才 settled；失败臂不提前释放槽

#### Scenario: 只读入口和被动录制不占主动槽

- **WHEN** 有主动操作时读取目录/文件/详情/设置/状态、执行能力预检或 A/B dry-run，或外部请求经代理被动录制
- **THEN** 这些入口按原契约可用且不占/释放主动槽；只读入口不消费写入许可、不写 trace/blob 或调用模型，被动录制按原契约独立落盘

#### Scenario: 接受后业务拒绝仍有可信终态

- **WHEN** 请求占槽后发现未配置、过期 token、缺父链、空 fork、版本/工具/隔离授权不满足
- **THEN** 沿用既有拒绝码且不绕过门禁，记录 settled/failed 后释放槽，未产生运行时 runIds 为空；同 ID 重复不重试消费或执行

#### Scenario: 旧操作收尾不能释放新操作

- **WHEN** 操作 A 已结束后 B 占槽，A 的重复完成回调或旧查询结果到达
- **THEN** main 仅允许槽 owner 释放，B 仍 running；renderer 不能据 A 的终态解锁 B

### Requirement: 操作状态可查询且未知请求可原子核对

`operations:status` SHALL 返回当前 epoch、自洽的执行槽/配置变更/关闭状态、单调登记版本及本会话全部操作的受限元数据快照，包含 settled/notAccepted，SHALL NOT 按 renderer 关联或界面开合裁剪。`operations:reconcile` SHALL 按 epoch/operationId 原子返回既有状态，或为从未接受的 ID 建立永久至会话结束的 notAccepted 封禁。核对 SHALL NOT 执行业务、取消操作、消费授权或修改运行文件。status 中不存在记录 SHALL NOT 单独作为未执行证明。操作核对 SHALL NOT 代替按 runId 通过既有详情接口读取运行记录。

#### Scenario: 握手和快照自洽

- **WHEN** renderer 首次启动或在执行中查询 status
- **THEN** 返回 main 当前 epoch 和一致的登记版本；非空 activeOperationId 指向同 epoch 的 running，包含本会话全部操作的受限元数据且不产生模型调用；renderer 重载或关闭操作入口不使终态或封禁从快照消失

#### Scenario: reconcile 先到封禁迟到提交

- **WHEN** 同 epoch/operationId 的 reconcile 先于正式请求到达
- **THEN** 原子建立 notAccepted，之后同 ID 正式请求始终拒绝，sourceToken 未消费且零模型/工具调用、零运行文件

#### Scenario: 执行先到核对实际状态

- **WHEN** 正式请求已被接受后 reconcile 到达，或操作已 settled 后再次核对
- **THEN** 分别返回实际 running 或 settled，不登记 notAccepted、不再次执行；响应同时反映 main 当前槽

#### Scenario: 核对旧操作不解除另一操作的锁

- **WHEN** B 占槽时对 A 核对得到 settled 或 notAccepted
- **THEN** 快照仍指向 B，A 不再占槽但全局执行/配置保持锁定

#### Scenario: 状态通道不可用保持未知

- **WHEN** 执行请求响应丢失且 status/reconcile 超时、断开或返回非法结构
- **THEN** renderer 保留 Unknown 和执行/配置锁，保留对应草稿冻结与复制/只读入口，只允许重新核对，不自动重发，不用刷新列表或重开面板解锁

#### Scenario: 同 main 重载恢复操作

- **WHEN** renderer 重载而 main 中仍有 running 或已有 settled/notAccepted
- **THEN** 握手恢复同 epoch 的槽和登记，不再次执行，不承诺恢复 U3 草稿正文，也不以空草稿仓库解除活跃锁

#### Scenario: 新 main 会话不伪造旧操作结局

- **WHEN** main 重启并由当前有效握手确认新 epoch
- **THEN** 只按新 main 的槽决定可执行性，旧 epoch 请求拒绝；仍持有的旧未知关联不标成功/失败/已取消，不自动重发或按列表猜关联，全进程重启不承诺恢复操作历史

#### Scenario: 乱序快照不回退新状态

- **WHEN** 新槽或 settled 快照已应用后，较低版本、旧请求代次或旧 epoch 的响应迟到
- **THEN** 不覆盖新 epoch/槽、不使 settled 回退 running、不解冻另一提交；只有当前有效 status 握手可确认 epoch 改变

### Requirement: 操作关联使用编排产出的真实运行身份

runIds SHALL 来自实际编排回调、结构化结果或错误，包含已创建的失败运行和 A/B 各臂。尚无可信身份时 SHALL 允许空数组，SHALL NOT 从报错文案、列表时间、任务名或其他请求猜 ID。获得 ID SHALL NOT 等同于文件已归位、可读、封存或运行成功。已知身份 SHALL 在后续异常时保留，proxy 被动录制 SHALL NOT 覆盖主动重发关联。

#### Scenario: 普通和隔离创建失败保留 ID

- **WHEN** 普通或隔离 create 的模型调用失败但已写出运行 meta/失败记录
- **THEN** 操作登记包含与该记录一致的 ID，CreateRunError 可结构化携带它，不解析文案；用户可按此 ID 读取失败记录，不能称为正常完成

#### Scenario: 分叉在已知身份后异常仍可关联

- **WHEN** 普通/隔离 result 或 prompt 已写 meta 后执行、归位或收尾出错
- **THEN** 操作保留实际新 ID 和安全诊断，隔离 ID 与最终 workspace.world_id 一致；未产生 meta 的前置拒绝不产生假 ID

#### Scenario: A-B 部分失败保留各臂事实

- **WHEN** 同批 A/B 中有成功臂、模型失败臂或写 meta 后异常的臂
- **THEN** 按 experimentId/arm index 关联所有已知真实 ID，未开始/未写 meta 的臂为 null；原成功 ids 不混入失败臂，操作 settled 不冒充全部臂正常结束

#### Scenario: 主动代理重发与被动录制交错

- **WHEN** 主动重发等待返回期间被动录制先后写入其他 run，或主动 recorder 写入失败
- **THEN** 主动操作只关联本次 fork 上下文的 ID，不能返回被动 run ID；写入失败明确记录失败且不二次录制，不修改被动录制结果

#### Scenario: 结果不可读不重执行且不锁配置

- **WHEN** main 已 settled 且返回可信 ID，但文件尚不可读、归位失败、缺失或校验失败
- **THEN** 界面显示读取失败并允许按同 ID 重试读取，保留草稿，不自动执行；该操作已不占槽，配置可用性由当前 main 槽决定

### Requirement: 现有界面消费统一操作事实

所有现有主动入口 SHALL 在当前 main 握手成功且可执行时生成新 operationId，并绑定提交修订。renderer SHALL 以 main 状态、通信未知和本地尚未确认的提交共同派生提交/配置门禁；展示复位或页面卸载 SHALL NOT 清除操作。全局栏 SHALL 提供紧凑操作入口，展示真实状态、等待、目标、可信 ID 及核实后的运行结局，并允许核对及明确打开记录，不显示虚构阶段、百分比或取消能力。七类主动入口 SHALL 统一消费结果收尾，独立录制/实验页面迁移不作为其前提。

#### Scenario: 初始握手失败禁用主动入口

- **WHEN** 尚未取得有效 main 状态或握手返回非法结构
- **THEN** 七类主动入口及配置写入口均不可提交，只读页面仍可访问；main 继续拒绝无身份的直接请求

#### Scenario: 所有入口实际使用同一适配器

- **WHEN** 从创建、result、prompt、messages、A/B UI 发起实际操作并切换页面
- **THEN** 请求携带身份且全局入口可查询同一登记，槽状态同步禁用其他主动/配置入口；页面卸载、reset 和列表刷新不删除登记或重复请求，终态统一核实结果

#### Scenario: 核对结果只由用户明确打开

- **WHEN** 用户从恢复/核对入口读到 settled 和可信 runIds，或迟到响应属于已离开的旧提交
- **THEN** 更新对应登记及结果读取状态，不自动更改当前页面；用户可明确按 ID 打开，未取得 ID 时不显示伪结果链接

#### Scenario: 操作入口在窄窗口和键盘下可达

- **WHEN** 800px 窄窗口或 200% 缩放下用键盘打开操作入口、核对并选择结果
- **THEN** 类型、状态和完整 ID 可读可操作，长文本不遮挡命令，焦点与关闭恢复遵守现有模态规则，不出现无实现的停止按钮

### Requirement: 执行前检查和确认保持各入口真实语义

创建、result、prompt、messages 和 A/B SHALL 提供编辑、检查、确认、明确提交的连续流程。确认 SHALL 展示本次目标、输入和实际执行边界；只读检查 SHALL 不调用模型、不占主动执行槽、不产生 trace/blob 或消费授权。缺少独立预检接口的路径 SHALL 只声明已完成的本地检查，正式提交仍由 main 校验。目标、修订、设置或流程代次变化 SHALL 使旧检查与许可失效。

#### Scenario: 创建和普通重跑只声明已完成的检查

- **WHEN** 用户检查普通/隔离创建或普通 result/prompt/messages 的输入
- **THEN** 仅执行该入口已有的本地或只读检查，不显示虚构的目录采集预览或上游连接成功；无检查接口的条件明确留待提交校验，非法输入就近提示并保留

#### Scenario: 普通结果与隔离结果确认边界不同

- **WHEN** 用户分别确认普通和隔离 result 重跑
- **THEN** 普通路径说明修改模型观察及后续工具副作用，不称为隔离；隔离路径用真实预检展示直接父、本地轮号和整轮结束检查点，说明不重做所选工具、不撤销原写入，并重新取得本次副本授权

#### Scenario: prompt 与 messages 不冒充续跑完整世界

- **WHEN** 用户确认 prompt 或代理 messages 修改
- **THEN** prompt 一次修改一个启动字段并说明从头执行；messages 展示完整请求编辑、当前凭据门禁并说明只重发单请求，不恢复外部 Agent 的工具/工作区；缺资格时就近显示原因

#### Scenario: 实验确认使用当前预览计划

- **WHEN** 用户预览 A/B 后修改臂、参数或配置再尝试执行
- **THEN** 旧计划失效，须重新预览生效参数并确认独立调用与费用、副作用；dry-run 不产生主动操作、运行文件或草稿清理

#### Scenario: 返回修改与设置往返撤销旧确认

- **WHEN** 已确认后返回编辑、切换对象、修改内容、进入设置或重新执行
- **THEN** 相关许可复位，旧检查响应不能恢复确认；隔离 prompt/A-B 仍拒绝，不以普通路径降级绕过

### Requirement: 跨页操作反馈展示真实等待与分层状态

全局操作入口 SHALL 在创建、运行阅读和设置往返期间可达，展示类型、目标、等待时间、main 请求事实和独立的结果读取/终止状态。等待 SHALL 从真实提交时间或明确标注的接受时间派生，结束后停止增长，不冒充模型耗时或进度。页面关闭 SHALL 不删除登记或停止执行；通信未知及配置门禁 SHALL 继续服从现有操作契约。

#### Scenario: 执行中离页仍可查询等待

- **WHEN** 提交创建或任一重跑后用户切到其他运行或文件页
- **THEN** 原操作和等待时间仍可查看，提交草稿冻结，只读浏览可用；不新增模型请求，不显示预设阶段/百分比

#### Scenario: 终态和重载后的计时不伪造

- **WHEN** main 返回 settled，或同 main 下 renderer 重载后仅恢复 startedAt，或操作为无时间戳的 notAccepted
- **THEN** 已结束等待不再增长；恢复时明确以接受时间计时；无时间事实时不造数，重载不恢复丢失草稿或自动跳转

#### Scenario: 关闭详情与退出不冒充停止

- **WHEN** 用户关闭操作详情或尝试退出有草稿/活跃操作的应用
- **THEN** 关闭详情仅恢复焦点，执行继续；退出走既有一次合并确认，可返回且不丢输入，不显示未实现的停止按钮或承诺上游撤销

#### Scenario: 未知通信与新会话分开呈现

- **WHEN** 查询失败、reconcile 返回单条终态，或有效握手确认 main epoch 已变
- **THEN** 同会话通信未知仅由有效 status 清除，核对不自动重发；新会话按新槽决定门禁，旧操作仍未知且不自动清理草稿，不用新会话空槽伪造旧结局

#### Scenario: 操作详情可读诊断但不泄漏输入

- **WHEN** 查看返回异常或业务拒绝的操作
- **THEN** 请求诊断与运行结局分开呈现，受控诊断可读；rejected 不一律称为零调用，未定位结果不造链接，操作摘要不包含正文、密钥、授权或 sourceToken

### Requirement: 结果按可信运行身份核实且读取重试不执行

主动操作 settled 后 SHALL 按 main 登记的可信 runIds 独立读取和校验结果，读取不得依赖运行列表成功或改变当前选择、滚动和焦点；自动导航 SHALL 在核实后单独检查当前资格。正常结束 SHALL 由当前运行自有 `stopped/completed` 终止事件证明，文件封存、IPC ok、requestOutcome 或成功 ID 子集 SHALL NOT 替代该证明。读取失败 SHALL 保留诊断与草稿，只提供只读重试；门禁始终取当前 main 槽。

#### Scenario: 成功信封但运行错误

- **WHEN** result 或 prompt 返回 ok 和可信 ID，而该运行自有事件是 errored/error
- **THEN** 结果显示失败及真实原因，保留提交草稿，不显示正常完成或测试通过；提供失败记录入口

#### Scenario: 失败信封仍可打开可信记录

- **WHEN** 创建或其他入口返回失败信封，但 main 已登记真实 runId
- **THEN** 按该 ID 读取，分别呈现请求异常与自有终止事实，不解析错误文案猜 ID，不扫描列表最新项替代关联

#### Scenario: 封存限制中止和未知不等于正常结束

- **WHEN** 已封存记录终止原因为 max_iterations、budget_exceeded、aborted，或记录缺失/未识别必要终止信息
- **THEN** 显示相应限制、中止、中断或未知并保留草稿；非法详情明确读取失败，不为显示未知而放宽 schema，未知原始值存在时可查看

#### Scenario: 祖先结束与失败调用不能冒充本次事实

- **WHEN** 子运行含继承前缀，祖先正常结束或含错误调用而子运行缺相应自有事实
- **THEN** 不从祖先补正常结局或失败定位；仅真实自有失败调用可直达，没有详情就如实说明

#### Scenario: 列表失败不阻断已知结果

- **WHEN** 操作 settled 后列表刷新失败，但按可信 runId 的详情可读
- **THEN** 仍核实并允许打开结果，核实本身不改变当前运行/页签/调用、滚动或焦点；导航另行核对资格，列表错误独立可重试，不因刷新失败重发操作或阻断清理判定

#### Scenario: 结果不可读只重试同一记录

- **WHEN** 已结束操作的结果文件缺失、损坏、版本不支持、父链按现有契约不可读，或详情 ID 不匹配
- **THEN** 显示执行已结束但结果不可读，保留草稿，按可信 ID 重试读取；零新增模型/工具调用、零 trace/blob/source 写入，不阻止已空闲槽的配置保存，不解除其他操作的槽

#### Scenario: settled 无身份与 notAccepted 不猜测结果

- **WHEN** settled 的 runIds 为空，或操作核对为 notAccepted
- **THEN** 前者保留结果未定位并允许核对登记，后者明确本次未接受；均保留草稿，不生成临时运行或从邻近记录推断结果

#### Scenario: 旧读取响应不能污染其他结果

- **WHEN** 同记录重试、不同操作读取或新 epoch 切换期间旧详情响应迟到
- **THEN** 只采纳匹配操作/运行身份和当前读取代次的响应，不覆盖新读取、不改变其他操作状态、不清理不匹配草稿

#### Scenario: 全部七类入口使用相同核实路径

- **WHEN** 普通/隔离创建、普通/隔离 result、prompt、messages 和 A/B 分别通过执行响应、轮询或显式核对到达终态
- **THEN** 编辑器是否挂载均不影响结果读取和收尾；重复快照不重复自动刷新列表、读取已核实记录或发送通知，A/B dry-run 不进入此流程

### Requirement: 正常结束仅清理提交对应草稿修订

系统 SHALL 仅在操作可信 settled、预期结果已核实自有正常终止、当前目标/修订仍等于提交关联且无更新的待定提交时自动清理草稿。解冻 SHALL 与清理分开，结果待读取时保留核对原修订所需的会话关联。错误、限制、中止、中断、未知、未定位或不可读 SHALL 保留输入；不持久化恢复关联。

#### Scenario: 单运行正常结束清理匹配修订

- **WHEN** 创建、result、prompt 或 messages 的可信结果已核实 stopped/completed，目标草稿仍为提交修订且无后来待定提交
- **THEN** 仅清理该目标，其他运行/字段草稿不受影响；创建只清理该提交的整份草稿和对应目录引用，正常结束不表示质量通过

#### Scenario: 解冻后修改不被旧结果删除

- **WHEN** main 已结束并解冻草稿，结果读取尚未完成，用户修改后旧结果才正常返回
- **THEN** 旧结果可显示但新修订逐字保留，即使文本后来改回相同值也不以内容相等清理

#### Scenario: 同修订再次提交也不被旧操作清理

- **WHEN** 结果待读取期间用户明确用同一草稿新建操作，旧操作随后核实正常结束
- **THEN** 旧操作不能删除或解冻更新 token 的待定提交；新执行有新身份和重新确认的许可

#### Scenario: 失败与读取恢复分别收尾

- **WHEN** 运行失败、限制、中止、未知或不可读，随后用户仅重试读取
- **THEN** 非正常结局一直保留草稿；仅当重试读到原操作正常终止且修订仍匹配才可清理，读取重试不自动导航或发起执行

#### Scenario: 全部预期实验臂正常才清理整批

- **WHEN** A/B settled，所有提交预期臂均有唯一可信 ID、匹配的实验/臂身份及正常自有终止事件
- **THEN** 仅在整批修订和提交关联仍匹配时清理批次，不按成功 ids 子集或空集合判断，不逐臂删除配置

#### Scenario: 实验缺臂部分失败与未核实保留整批

- **WHEN** A/B 存在缺臂、null/重复 ID、身份不一致、失败、上限或不可读臂，即使批次 requestOutcome 为 returned
- **THEN** 展示全部预期臂和各自已知事实，保留整份配置与未核实状态，允许分别打开可信记录，不宣称全成功或最佳模型

#### Scenario: 重复收尾与显式放弃不会误删重建草稿

- **WHEN** 正常结果重复到达，或用户已显式放弃并重建同目标草稿，或 renderer 重载已无原提交关联
- **THEN** 收尾幂等，不删除新修订、不重建旧草稿、不推测匹配并清理；重载仅恢复 main 登记和可读取结果

### Requirement: 结果导航尊重用户当前阅读意图

单运行操作 SHALL 仅在用户持续停留于本次提交流程且首次结果可读时允许自动进入其概览；所有异步导航 SHALL 在执行前重验该意图。主动离页、改变阅读对象、进入设置或关闭编辑 SHALL 撤销该资格，返回同一位置不恢复。核对、手动读取重试、重载恢复和 A/B SHALL 只通知并由用户明确选择结果。

#### Scenario: 留在当前流程可进入成功或失败概览

- **WHEN** 单运行结果首次核实可读，用户未离开本次创建/编辑流程且没有覆盖模态
- **THEN** 可进入该运行概览，包括失败概览，显示真实终止原因并提供返回原草稿入口，不以“打开”冒充成功

#### Scenario: 离开再返回不恢复旧自动导航

- **WHEN** 提交后切换运行、页签、步骤、文件或设置，即使随后返回原位置才收到结果
- **THEN** 当前选择、滚动和焦点保持，仅全局提示有结果可查看，不因对象 ID 恰好相同恢复旧导航资格

#### Scenario: 读取途中离页仍不抢焦点

- **WHEN** 结果读取已开始但尚未返回，用户此时导航或打开设置/确认框
- **THEN** 读取动作只更新结果状态，单独的导航动作在实际切换前再次核对当前意图，不覆盖当前页面或关闭模态，不将焦点转入隐藏元素

#### Scenario: 恢复核对重试与批次结果只通知

- **WHEN** 显式核对、手动结果读取重试、同 main 重载恢复或 A/B 产生可查看或不可读的结果状态
- **THEN** 不自动选择任一 run，面板关闭时仍可通过全局未读标记和可访问的 polite live 区域感知结果；结果变为可查看或不可读时更新通知文本，重复状态及等待计时不重复通知，焦点保持；通知可从全局入口重开，关闭提示不删除登记，A/B 由用户选择具体臂

#### Scenario: 失败定位和返回草稿明确可达

- **WHEN** 用户从操作结果选择打开记录、查看失败调用或返回编辑
- **THEN** 打开记录到概览，失败定位只到真实自有调用；返回恢复原编辑目标与仍存在的草稿且许可复位，来源失效允许复制草稿并显示原因，不复活已清理内容

### Requirement: 设置往返保留编辑并真实反馈配置结果

全局与就近配置入口 SHALL 打开受可用宽高约束的设置界面并保留来源位置与草稿。设置 SHALL 独立管理未保存输入，关闭有修改时允许继续编辑或确认放弃；保存/清除防重复，失败保留输入。密钥 SHALL 只进不出且不进入调试草稿、日志或返回定位。所有配置写入 SHALL 保持既有 main 门禁。

#### Scenario: 两模式配置后返回任务

- **WHEN** 从普通或隔离创建的模型摘要/缺配置提示进入设置，保存并返回
- **THEN** 任务、系统指令、模式和有效目录引用保留，摘要显示已核实保存状态；旧预检/写入许可失效，可继续重新检查和授权

#### Scenario: 重跑编辑配置往返保持阅读

- **WHEN** 从 result、prompt、messages 或 A/B 编辑进入设置再返回
- **THEN** 原运行/调用、输入和已有阅读位置恢复，配置变更使执行检查或计划失效；代理凭据仍按自身会话规则判断，不由桌面模型密钥替代

#### Scenario: 未保存设置关闭可继续或放弃

- **WHEN** 设置内模型字段或密钥有修改，用户点击关闭或 Esc
- **THEN** 先确认放弃/继续编辑，继续时逐字保留；确认放弃才关闭并清除未保存密钥，返回来源有效焦点，不清调试草稿

#### Scenario: 单向密钥与保存反馈不冒充连通

- **WHEN** 已有配置留空 key 保存，或新配置缺 key，或系统加密不可用
- **THEN** 分别保持原密钥、按真实校验拒绝、明确已有明文存储事实；回读只含配置状态，保存成功只称已保存/已配置，不调用付费连接测试或称连接成功

#### Scenario: 保存失败和保存后回读失败区分

- **WHEN** 保存请求失败，或保存已确认成功但配置状态回读失败
- **THEN** 前者保留输入及错误，后者明确已保存但状态待读取并允许只读重试；均不把旧摘要当作新配置事实，保存中不能重复提交

#### Scenario: 清除确认包含凭据且受槽约束

- **WHEN** 用户取消或确认清除配置，或在活跃操作/通信未知时尝试保存、清除和代理应用
- **THEN** 清除确认说明保存凭据一并删除，取消零清除调用；配置写入按既有门禁拒绝而查看/返回可用，不绕过 main 或清理其他草稿

#### Scenario: 录制入口保持现有代理区可达

- **WHEN** 从全局录制接入入口或设置进入代理配置
- **THEN** 打开独立录制工作区，设置不保留第二份代理配置表单；显示真实监听和会话凭据状态，不显示假连接验证，不混同代理停止与主动执行取消

#### Scenario: 设置跳转录制先处理未保存模型字段

- **WHEN** 设置内有未保存模型字段或密钥时点击录制跳转
- **THEN** 先允许继续编辑或确认放弃；取消跳转零代理应用调用，确认后密钥输入清除并进入录制，原调试草稿保留

### Requirement: 执行流程在窄窗口与键盘下连续可用

创建、检查确认、操作结果及本次修改的设置界面 SHALL 用可辨认的状态文本/图标和就近错误呈现事实，按容器宽度重排长内容，不仅靠颜色。正文和操作 SHALL 在常见桌面宽度及放大后可达，页面无非必要横向溢出或文字重叠；工具图标 SHALL 有可访问名称。创建页面与真正模态的焦点规则 SHALL 区分。

#### Scenario: 长任务路径模型与结果不遮挡操作

- **WHEN** 在 1440、1210、1024、800 CSS px、独立 200% 缩放及导航展开后的窄内容区查看长任务、路径、ID、模型、原新值和多臂结果
- **THEN** 正文可完整阅读，窄窗上下排，关键按钮和原因可达，设置不超可用宽高，不通过缩小字体掩盖溢出

#### Scenario: 创建页面键盘可离开而模态约束焦点

- **WHEN** 用键盘进入创建、确认、执行后切运行、打开操作结果及设置再返回
- **THEN** 页面焦点可进入运行导航；真正模态限制 Tab/Shift+Tab 与背景交互，Esc 只处理最上层且不停止执行，关闭后恢复有效入口

#### Scenario: 只读反馈和读取重试保持数据边界

- **WHEN** 跨页查看操作、核对、读取重试、返回草稿并浏览已有文件
- **THEN** 不调用执行通道，不改变源目录、父/兄弟/既有 trace 与附件字节；仅提供已实现且满足对象条件的对比入口，没有未实现取消的空按钮，也没有把执行结束称为测试通过

### Requirement: 详情完整性在缺祖先文件时结构化降级

`runs:get` SHALL 在统一 IPC 信封中返回受校验的 `completeness`（`complete` 或 `ownOnly`）、`spanScope`（`resolved` 或 `own`）、`lineage`、`chain` 和 `leafSpanIds`。main SHALL 先完整校验当前 run，再按分支语义读取祖先；只有结构化确认缺失的是祖先 trace 文件本身时，才返回 `ownOnly`。`ownOnly` SHALL 只包含当前 run 自有且通过 reader、版本、schema 和跨行约束校验的 meta/spans/events/status，chain 按最早可读 hop 到当前 run 排列并在缺失点截断，`leafSpanIds` SHALL 精确对应当前 run 自有 spans。已可证明的无效身份、结构或定位 SHALL 优先拒绝，不能以更早祖先缺失遮蔽错误。

#### Scenario: 普通 result 的完整父链仍合并

- **WHEN** 普通 result 分支及其所有祖先文件均存在且通过版本、schema 和 fork 定位校验
- **THEN** 详情返回 `completeness=complete`、`spanScope=resolved`，轨迹按既有 `resolveBranch` 语义合并，chain 包含根到当前 run 的完整连续来源，`leafSpanIds` 只标当前 run spans

#### Scenario: 根 run 以自有轨迹返回

- **WHEN** 打开一个 `meta.parent=null` 且当前文件通过全部 reader、版本、schema 和跨行校验的根 run
- **THEN** 详情返回 `completeness=complete`、`spanScope=own`、`lineage.status=complete`，spans 只包含根 run 自有记录，chain 只有该根 run，`leafSpanIds` 覆盖其全部 spans

#### Scenario: 普通 result 缺祖先只读当前记录

- **WHEN** 当前普通 result 文件合法，但其某一级祖先文件明确不存在（包括直接父缺失与隔代祖先缺失）
- **THEN** 详情返回 `completeness=ownOnly`、`spanScope=own`、`lineage.status=incomplete`、`lineage.reason=ANCESTOR_NOT_FOUND` 及来自最近可读记录 `meta.parent` 的真实 `missingRunId`；spans/events/meta/status 只来自当前 run，chain 只保留当前向上连续可读的 hops，不拼接断点另一侧的未知历史

#### Scenario: 普通 result 的隔代祖先缺失

- **WHEN** 当前 run 和直接父 run 合法，但直接父的 `meta.parent` 指向不存在的祖先文件
- **THEN** 详情保留当前 run 与直接父的连续 chain，`missingRunId` 等于直接父声明的祖先 ID；不把当前 run 的直接父误报为缺失，也不拼接更早的未知轨迹

#### Scenario: prompt、代理和 model_params 的自有范围不等于降级

- **WHEN** 打开完整父链的 prompt fork、代理 messages fork 或 model_params 实验臂
- **THEN** 详情返回 `completeness=complete`、`spanScope=own`，只展示当前 run 自有 spans 并单独展示父级 chain；不得把 `own` 判为 ownOnly 或拼接独立执行的父轨迹

#### Scenario: 独立轨迹缺祖先也返回结构化 ownOnly

- **WHEN** prompt、代理 messages 或 model_params run 当前文件合法但某个祖先文件不存在
- **THEN** 详情返回 `ownOnly/own` 与 `ANCESTOR_NOT_FOUND`，当前自有输出、步骤、自有消耗和自有终止事实仍可读，继承前缀和祖先增量标为未知

#### Scenario: prompt fork 缺祖先不改变从头轨迹

- **WHEN** prompt fork 当前文件合法但其父文件不存在
- **THEN** 只显示该 prompt fork 自有 spans 和缺失来源，不能经 `resolveBranch` 补入父 spans，也不能把缺失父本当成普通 result replay

#### Scenario: proxy fork 缺祖先不借用代理记录

- **WHEN** proxy messages fork 当前文件合法但来源链中某个祖先不存在
- **THEN** 保留本次代理重发的自有 messages/llm 事实，缺失原因可见，不从其他 proxy run 或列表时间猜测父记录

#### Scenario: model_params 臂缺祖先不变成可比较结果

- **WHEN** model_params 实验臂当前文件合法但父链缺失
- **THEN** 只显示该臂自有 spans 和 ownOnly 状态，不计算共同祖先、沿链增量或臂间结论

#### Scenario: 当前文件或祖先不是可确认的缺失

- **WHEN** 当前 run 缺失，或祖先读取遇到无权限、JSON/schema 损坏、未知格式版本、v1 非法隔离字段、成环或非法 fork 定位
- **THEN** `runs:get` 返回明确失败信封，不返回 ownOnly，不通过通用 catch 或错误文本匹配放行部分详情

#### Scenario: 祖先文件损坏不降级

- **WHEN** 当前 run 合法，但祖先 JSONL 截断、跨行约束失败或 schema 非法
- **THEN** `runs:get` 返回祖先无效/不可读错误，不返回 ownOnly，不展示当前 run 的部分轨迹

#### Scenario: 未来版本祖先不降级

- **WHEN** 当前 run 合法，但祖先使用桌面尚不支持的 `format_version`
- **THEN** 版本守卫在 schema 转换前拒绝详情，不丢字段后继续显示或执行

#### Scenario: v1 祖先携带隔离字段不降级

- **WHEN** v1 祖先 meta、fork 或自有 span 携带非法隔离字段，即使值为 null、false 或空对象
- **THEN** 详情按版本守卫失败，不把该祖先当作文件缺失

#### Scenario: 祖先链成环不降级

- **WHEN** 父链重复访问同一 run ID
- **THEN** `runs:get` 返回成环错误并终止读取，不截断成 ownOnly，不死循环

#### Scenario: fork 定位非法不降级

- **WHEN** 祖先可读但 fork 缺少必需字段、`at_span` 不属于指定父轨迹或隔离边界不自洽
- **THEN** `runs:get` 返回 fork 定位错误，不用当前自有 spans 冒充可读的部分分支

#### Scenario: 父文件恢复后重试全量重验

- **WHEN** ownOnly 详情对应的缺失祖先文件恢复，用户重试读取
- **THEN** main 重新读取并校验当前 run 及完整父链，只有所有版本、schema、跨行和 fork 定位校验通过才返回 `complete`；不局部拼接、不仅隐藏警告、不写回任何 trace/blob/source

#### Scenario: 读取重试不改变阅读位置

- **WHEN** 用户在 ownOnly 详情中重试读取，期间切换步骤、页签或当前 run
- **THEN** 旧读取响应不能覆盖新的阅读位置；恢复后的详情只应用到发起请求的 run ID，不抢焦点或自动导航

#### Scenario: 详情完整性字段拒绝错配

- **WHEN** IPC 载荷声明 `complete/ownOnly`、`resolved/own` 或 lineage 状态与 chain 不相容
- **THEN** main 与 renderer 两处拒绝整份载荷；chain 非空且 ID 唯一，末跳与 meta 一致、相邻 parent 连续，complete 首项为根，ownOnly 首项 parent 等于链外 missingRunId；own 的 leaf ID 精确覆盖 spans，resolved 的 leaf ID 为不重复子集，不能借未知字段剥离接受错配

#### Scenario: 文件身份与路径不能伪造来源

- **WHEN** 当前或祖先 ID 含目录穿越/绝对路径/分隔符，或文件内 meta.id 与请求 ID 不符
- **THEN** 在目录外读取前拒绝非法路径，身份不符则拒绝详情；不返回 ownOnly，不从错误正文猜测缺失 ID

#### Scenario: 已知无效关系不能被更早缺失遮蔽

- **WHEN** 可读 hop 缺 fork、祖先未封存、v2 边界不属于可读直接父，或存在其他已可证明的非法关系，且更早祖先文件缺失
- **THEN** 返回严格错误；仅当定位依赖不可得祖先而暂不能核实时才可标 ownOnly，不能把未核实谎称校验通过，也不能把它误报为已证实非法

#### Scenario: 合法零 span 记录可部分读取

- **WHEN** 当前 run 合法且尚无自有 spans，祖先文件不存在
- **THEN** 返回 ownOnly、空 spans/leafSpanIds 与当前自有事件；空数组不被当作损坏，也不借祖先终止事件推断当前结局

#### Scenario: 读取诊断不泄漏路径和正文

- **WHEN** 读取遇到缺文件、权限或含输入内容的解析错误
- **THEN** 失败保持 GET_RUN_FAILED 信封与受控中文原因，成功降级仅暴露合法缺失 ID；不透传物理路径、堆栈、正文或凭据

### Requirement: 运行详情的来源完整性控制主动执行

五类引用父本的主动入口（普通/隔离 result、prompt、代理 messages、model_params/A-B）SHALL 在 U4 判重、接受占槽之后，由 main 重新检查被引用详情的可读性、完整性及原有领域门禁。详情加载失败 SHALL 返回 RUN_DETAIL_UNREADABLE；ownOnly SHALL 返回 RUN_LINEAGE_INCOMPLETE；均在授权消费、业务文件写入、工具或模型请求前拒绝，按 settled/rejected 回执收口并释放本操作槽。renderer 的 disabled 或提交的完整性声明 SHALL NOT 是保护依据。只读重试不重发执行；无父本的普通/隔离 create 保持原契约。

#### Scenario: ownOnly result 不可重跑

- **WHEN** 用户从 `ownOnly` 普通或隔离 result 详情提交 result 编辑，或绕过 UI 直接提交对应 IPC
- **THEN** main/core 返回稳定的来源不完整拒绝，零授权消费、零文件/blob 写入、零工具调用和零模型请求，且不产生新的运行记录

#### Scenario: ownOnly prompt、代理和实验臂不执行

- **WHEN** 用户对 `ownOnly` prompt、代理 messages 或 model_params/A-B 记录发起主动执行
- **THEN** 各入口统一拒绝并保留具体缺失原因；不得降级成普通 handler、从当前源目录补父链或仅依赖 renderer 按钮禁用，操作登记按 U4 既有拒绝语义处理

#### Scenario: ownOnly 隔离 result 不消费副本授权

- **WHEN** 对 ownOnly 隔离 result 提交符合现有 schema、带 allowFileWrites 的执行请求
- **THEN** main 在使用副本授权、创建文件世界或写入 trace 前拒绝；不为 result 新增创建路径的 sourceToken 字段，测试必须确实进入来源门禁

#### Scenario: ownOnly model_params dry-run 保持只读

- **WHEN** 对 ownOnly model_params 记录请求计划预览或真实 A/B 执行
- **THEN** 计划预览返回来源不完整原因，不生成可执行计划、不调用网络、不写文件、不创建 operation 或占槽；真实执行整批在第一臂前拒绝，零臂身份，登记按 settled/rejected 收口

#### Scenario: 读取重试与执行严格分离

- **WHEN** ownOnly 详情的父文件尚未恢复或用户点击“重试读取”
- **THEN** 只发起一次只读 `runs:get`（按读取代次防旧响应覆盖），不创建 operation、不消费授权、不调用模型/工具；恢复为 complete 后仍须重新通过原有执行预检

#### Scenario: 详情加载失败在执行入口即拒绝

- **WHEN** 当前 run 缺失、祖先损坏、版本不支持、成环或 fork 定位非法时尝试任一主动入口
- **THEN** 已通过身份/schema 且被接受的请求保留 settled/rejected 登记、匹配回执与空 runIds，返回 RUN_DETAIL_UNREADABLE 并仅释放自身槽；零授权消费、零业务文件、零工具和零模型调用

#### Scenario: 父链恢复不复活已拒绝操作

- **WHEN** 来源不完整导致操作 settled/rejected 后恢复父文件，再次提交同 operationId；或旧 epoch、异参、reconcile 封禁请求到达
- **THEN** 先执行 U4 判重/身份/封禁规则，不重读父本或再次执行；只有用户重新检查并使用新 ID 才可能执行，不更改原拒绝终态或另一操作的槽

#### Scenario: 预检后父链变化仍由 main 拒绝

- **WHEN** UI 已取得完整详情及确认，但正式提交前父文件消失，或 renderer 绕过禁用直接调用有效 IPC
- **THEN** main 重读后以 RUN_LINEAGE_INCOMPLETE 拒绝并保留草稿；renderer 从读取/预检或拒绝响应得知来源变化后，使旧 capability、A/B 计划、确认和副本授权失效，恢复父链必须重新检查与确认；main 不新增许可吊销登记或文件监听，未被读取发现的变化也不能绕过提交时重验

#### Scenario: 隔离 capability 对不完整来源明确拒绝

- **WHEN** ownOnly 隔离父本请求只读 forkCapability
- **THEN** 返回不可执行及来源缺失原因，不授予许可、不登记或占槽、不写文件；合法自有文件阅读仍可进行

#### Scenario: 无父本创建和被动录制保持原契约

- **WHEN** 当前页面选中 ownOnly run 时用户另行创建普通/隔离 run，或发生被动代理录制
- **THEN** 不把所选详情隐式当成父本；创建仍受原 U4 槽和授权控制，被动录制仍不占主动槽且不借用主动身份

### Requirement: 部分详情沿用自有结果核实与草稿收尾

U5 结果核实 SHALL 对 ownOnly 保持请求 runId、meta.id、chain 末跳、版本与 schema 核对，自有终止事实与来源完整性分别展示。自有 stopped/completed SHALL 继续参与原提交修订/token 匹配清理；来源不完整不得伪造运行失败或授予执行资格。后台读取及手动重试 SHALL 保持导航、通知和读取代次规则。

#### Scenario: ownOnly 正常结果仍按原修订清理

- **WHEN** 已 settled 操作的可信 runId 返回合法 ownOnly，且自有 stopped/completed，存在匹配的原提交关联
- **THEN** 后台核实进入原 U5 原子修订清理；较新 revision/token 不被删除，操作面板同时显示自有结局与来源缺失，不以 status=completed 代替严格事件判据

#### Scenario: ownOnly 失败定位只使用自有调用

- **WHEN** ownOnly 结果自有终止为 error/限制/中断，或当前详情仍不可读
- **THEN** 保留草稿；有自有失败调用才提供定位，否则诚实说明无可定位调用，不从祖先补错，不修改 main 请求结局

#### Scenario: 部分实验结果保留完整批次判据

- **WHEN** A/B 的一个或多个结果详情为 ownOnly
- **THEN** 仍按全部预期臂、唯一可信身份、同批 experimentId 与各自正常终止判断整批清理；缺臂/null ID/错误/不可读任一存在均保留整批，不推断胜出臂

#### Scenario: 后台重试不导航也不重发执行

- **WHEN** 手动重试结果从不可读变 ownOnly 或从 ownOnly 变 complete，且用户已切换阅读位置或重载 renderer
- **THEN** 仅更新匹配身份与代次的读取项；可核实正常终止时只按尚存在的原关联清理，不猜草稿、不抢焦点、不重复通知、不自动导航或执行，旧 epoch/旧响应不能覆盖新状态

#### Scenario: 部分详情提示和恢复动作可达

- **WHEN** 在 800/1024/1440 CSS px、独立 200% 缩放与真键盘下阅读含长缺失 ID 的详情或操作结果
- **THEN** 来源警告、就近禁用原因、只读重试和复制信息可读可达；Tab/Shift+Tab 可到达动作，重试保持有效步骤/页签/文件/滚动位置，失效引用沿用 U1/U2 回退

### Requirement: 双运行工作区保留比较对象和返回位置

系统 SHALL 提供修改与输出、步骤、消耗三种双运行视图，默认修改与输出，顶部保留左右对象、更换、交换及返回。比较对象 SHALL 独立于侧栏选中 run；进入、换对象和返回是显式阅读意图，不得被后台执行结果抢走。打开单侧运行/调用/文件后 SHALL 可返回原比较；会话内恢复各侧阅读位置，不清除草稿。

#### Scenario: 父子入口默认父左子右

- **WHEN** 普通运行具有真实 parent，用户从概览或 U5 已核实结果进入与父运行对比
- **THEN** 左为真实父、右为当前结果，默认修改与输出；无 parent 不显示入口，缺父保留该 ID 并显示不可用，未核实结果不猜比较对象

#### Scenario: 更换交换不改变侧栏选择

- **WHEN** 用户更换右侧对象或交换左右
- **THEN** 侧栏原运行保持，比较标题、修改方向及每侧内容同步更新，保留未更换对象的位置；相同 ID 不被接受为两条

#### Scenario: 手动两条比较按加入顺序确定左右

- **WHEN** 用户手动依次将两条符合比较规则的运行加入集合并进入详细比较，包括先加入子运行、后加入其父运行
- **THEN** 第一条在左、第二条在右，不因父子关系自动重新排序；先子后父时子左父右，只有显式“与父运行对比”入口默认父左子右；进入不改变侧栏选择或集合顺序

#### Scenario: 返回恢复来源与单侧阅读

- **WHEN** 用户从树/步骤打开比较，再打开某侧调用后返回比较及原来源
- **THEN** 恢复原比较对象、页签、每侧调用与滚动，再返回时恢复来源页和有效选择/焦点；目标失效有说明，不跳到同名对象

#### Scenario: 后台结束不抢比较页且草稿保留

- **WHEN** 进入比较后原主动操作结束，或比较期间进入设置再返回
- **THEN** 后台按原操作事实收尾但不强制导航；比较对象与未提交草稿保留，不因只读比较清理草稿或恢复授权

### Requirement: 比较读取验证身份完整性并隔离迟到响应

比较 SHALL 从本次受校验的记录读取自有详情、祖先摘要及关系证据，拒绝非法 ID、重复对象和超过四条。每项 SHALL 保留请求身份和可读/不可用状态，不能用列表缓存冒充本次校验。普通 ownOnly 只参与自有事实阅读，链结论保持不完整；当前或祖先损坏、版本或权限错误不能伪装 ownOnly。重试 SHALL 只读重验，不触发模型、工具、执行登记、授权或修复写入。

#### Scenario: 比较拒绝非法身份和错配载荷

- **WHEN** 比较请求含越界路径/重复 ID/第五条，或响应身份、顺序、完整性与请求不符
- **THEN** 非法请求在目录外读取前拒绝，错配响应整体拒绝；不把另一对象内容放到当前标题下，错误不暴露路径、正文或凭据

#### Scenario: 列表完整但比较读取缺祖先

- **WHEN** 列表缓存显示完整，进入比较时某普通运行的祖先文件已缺失
- **THEN** 该侧自有内容可读并标 ownOnly，共同祖先判定不完整，受影响累计未知且所有祖先差不计算；完整另一侧自有/累计仍可读

#### Scenario: 一侧不可读保留另一侧

- **WHEN** 某侧当前记录缺失，或祖先损坏/未来版本/权限错误/成环
- **THEN** 该侧保留真实 ID 和受控原因，不伪空文本、不降级为 ownOnly；合法侧仍可单独阅读，跨侧关系结论不可用

#### Scenario: 快速更换交换移出不串内容

- **WHEN** 前次比较读取未返回时用户更换对象、交换、移出或离开
- **THEN** 旧响应不能覆盖新对象、新顺序或当前页面，各侧步骤与滚动不被旧 run 重置

#### Scenario: 比较重试恢复必须全量重验

- **WHEN** 祖先文件恢复后用户重试，或已有成功内容后文件被外部改坏再重试
- **THEN** 对当前选择集重新校验完整来源，通过才恢复关系；新失败撤销旧结论，不局部拼旧链；仍为只读且不改变未换对象阅读位置

### Requirement: 修改比较只展示可核实编辑证据

修改视图 SHALL 区分直接父子、多跳/兄弟、不同根和无法完整判断。原值/新值必须来自已校验的对应父调用和子 fork，带字段及来源身份；未知、不适用和真实空值必须区分。SHALL NOT 从 config_hash 反推配置或把工具结果改动描述成文件修改。

#### Scenario: 直接父子展示真实编辑前后值

- **WHEN** 比较普通或隔离 result、system/user prompt、messages 的直接父子
- **THEN** 按真实字段定位原值和 fork 新值，显示完整可展开复制的内容及方向；隔离显示真实整轮边界，prompt 从头重跑、代理单请求语义可辨

#### Scenario: 多跳兄弟展示逐跳修改链

- **WHEN** 两侧为多代父子或具有共同祖先的兄弟分支
- **THEN** 从已确认共同祖先逐跳标识每个源/目标与字段，不将兄弟说成直接编辑对方，也不将多跳合成一次修改

#### Scenario: 不同根只核对实际输入配置

- **WHEN** 两侧普通运行父链完整且没有共同祖先
- **THEN** 可读两侧已记录输入/模型/参数差异但标为不同根，不声称一次分叉修改、共同前缀或祖先增量

#### Scenario: 原值缺失未知字段不补空

- **WHEN** 祖先不可得、原字段未记录或 fork 字段未知，另有真实空字符串编辑值
- **THEN** 缺证处明确不可核对，合法当前记录的原始字段/新值仍可读；真实空值与未记录分开，不生成伪空 diff

### Requirement: 双运行输出沿用自有结局且完整可读

输出 SHALL 复用概览的自有终止事实与最终输出判据，完整展开、查找和复制；正常结束不等于质量验证。只有两侧均为已记录最终文本时才能进入文本 diff；其他情况 SHALL 显示各侧真实状态并独立阅读。

#### Scenario: 最终输出不借中间正文或祖先

- **WHEN** 一侧正常完成有最终正文，另一侧失败/受限/中断、仅 reasoning/tool_calls 或无自有正文
- **THEN** 前者显示完整最终输出，后者明确未记录最终输出并保留中间内容和已知状态，不借祖先或更早正文补齐；真实自有错误可定位

#### Scenario: 长输出独立阅读与合法文本差异

- **WHEN** 两侧文本长度悬殊，用户滚动、查找、复制并切换文本 diff
- **THEN** 默认各侧独立滚动，复制完整原文；只有双方最终文本就绪才启用 diff 与同步滚动，缺失/错误不参与伪空比较

### Requirement: 比较步骤按真实来源识别共享前缀

步骤 SHALL 提供独立选择和完整调用阅读；仅对已校验 result 分叉的真实共同执行部分提供可展开折叠，保留被编辑值的差异。来源关系、重复 span ID、轮号或文本相同 SHALL NOT 作为共享执行的证明；独立轨迹明确分别排列。

#### Scenario: result 共享前缀保留真实边界

- **WHEN** 普通 v1 result 或隔离 v2 result 具有可验证共同执行前缀
- **THEN** 分别按 span 截断或整轮边界标记前缀，可展开全部记录，编辑处仍可核对；两侧后续调用独立选择，不丢工具结果差异

#### Scenario: 重复 span ID 与独立分支不强行对齐

- **WHEN** 两侧都含 s_01 或相同轮号，且为不同根、prompt、messages、model_params 或混合来源链
- **THEN** 身份按 run 和 span 区分；跨独立执行 hop 不展示共享执行前缀，步骤独立排列，选左不改变右

#### Scenario: 缺父链仅显示自有步骤

- **WHEN** 普通一侧为 ownOnly 且另一侧完整
- **THEN** 部分侧只显示已校验自有步骤并提示前缀未知，不按可见链首项推断根或折叠未知祖先

### Requirement: 比较消耗区分自有累计和未知

比较 SHALL 同口径展示自有输入/输出/合计 tokens、步骤、工具与错误、已记录耗时及缓存。沿链累计和相对祖先增量单列口径与可得性，不称连续单次总耗时/成本，不估计未知值、不自动评分或排名。

#### Scenario: 自有指标不重复计算继承前缀

- **WHEN** 两侧详情含继承前缀，链含 prompt 独立执行，部分耗时缺失
- **THEN** 自有仅统计 leaf spans，沿链按各代自有值求和并说明独立执行；任何未知耗时保持未知，祖先增量按同口径计算

#### Scenario: 缓存未知零部分和失败占位分开

- **WHEN** 各运行缓存分别未记录、明确零命中、仅部分记录，另有失败占位零 token
- **THEN** 四种解释可辨，未记录不显示成实际零，失败占位不称零消费，不输出金额、质量评分或模型胜负

### Requirement: 比较文件入口保持单运行合法检查点

比较 SHALL 仅提供分别打开左右运行文件页的入口，使用各自 U2 文件阅读状态及合法自有检查点；不得创建跨运行文件 diff 页签、借祖先/兄弟步骤或源目录补历史。无文件能力的运行说明不适用，ownOnly 不封禁合法自有文件。

#### Scenario: 分别打开文件并返回比较

- **WHEN** 两侧隔离运行各保存不同合法检查点/path，用户分别打开文件后返回
- **THEN** 每次只进入目标 run 自有文件页并恢复其位置；返回比较对象与阅读位置保持，没有跨运行文件差异页签

#### Scenario: 非法文件目标与普通运行不造历史

- **WHEN** 目标步骤属于祖先/兄弟或已失效，或目标是普通运行，或 ownOnly 仍有合法自有附件
- **THEN** 非法定位明确说明并走目标 run 的合法恢复/默认规则；普通运行不造文件史；ownOnly 合法自有附件可读，缺失/损坏按 U2 原规则

### Requirement: 比较工作区在窄窗口与只读操作下连续可用

双运行正文 SHALL 随内容容器宽度并排或上下排列，窄窗重复对象标题并默认收起导航，返回恢复原导航状态。操作 SHALL 有可访问名称、键盘路径和稳定焦点。比较、定位、复制、重试及返回 SHALL 不触发执行、不改 trace/blob/source 或操作许可。

#### Scenario: 窄窗和缩放仍能完整阅读

- **WHEN** 在 1440/1360/1024/800px 窗口及 200% 应用缩放下阅读长标题、长输出和四条指标
- **THEN** 正文有可读宽度，窄窗上下排列且标题重复；名称列不消失、控件不被遮挡，必要横滚限于表格/画布/代码容器，返回恢复原导航状态

#### Scenario: 键盘完成比较闭环

- **WHEN** 用户仅用键盘从关系列表选两条、进入比较、交换、换视图、打开调用再返回
- **THEN** 所有动作可达且名称明确，焦点可见并在返回时恢复，编辑器加载和读失败有反馈，不依赖双击或仅悬停提示

#### Scenario: 比较全程只读且不恢复许可

- **WHEN** 完成选中、比较、文本 diff、指标阅读、重试、单侧文件打开和返回
- **THEN** 模型/工具及执行通道调用均为零，trace/blob/source 字节不变；不占主动槽、不生成操作身份、不清草稿或恢复授权

### Requirement: 录制配置草稿在会话内保留并参与关闭保护

系统 SHALL 在会话内保留独立的录制配置草稿，含启用意图、原始端口/上游文本和修订；导航、读取或服务失败 SHALL NOT 静默清空输入。草稿 SHALL NOT 含凭据值、执行许可或持久化计划；未应用修改 SHALL 可定位、可明确放弃并参与既有窗口关闭协商。

#### Scenario: 录制配置跨页恢复原始输入

- **WHEN** 用户输入无效端口、未完成 URL 并切运行、设置或比较后返回
- **THEN** 启用意图与原始字段逐字恢复，未应用提示保留，实际状态不被草稿覆盖

#### Scenario: 录制端口校验不接受部分整数

- **WHEN** 用户输入 18787abc、小数、空值、0 或 65536 后应用
- **THEN** 在字段处拒绝，保留文本且零配置写调用；完整合法整数按现有 schema 提交

#### Scenario: 录制放弃取消及修订竞争

- **WHEN** 用户对有修改录制草稿取消放弃，或确认打开后输入修订改变
- **THEN** 取消保持输入，旧修订确认不能删除新输入；匹配修订确认才恢复已核实配置，不重新 toggle

#### Scenario: 录制未应用修改参与退出保护

- **WHEN** 只有录制草稿未应用或它与其他草稿/活跃操作并存时关闭窗口
- **THEN** 沿用一次合并退出确认，返回继续保留输入；失联不能当作无草稿，未修改默认表单不误报 dirty

#### Scenario: 录制应用收尾不覆盖后来输入

- **WHEN** 应用在飞期间离开，响应到达时目标修订或读取代次已改变
- **THEN** 仅按匹配的提交和有效状态更新，旧响应不覆写后来字段或新状态、不跳回录制；成功更新相应基线，失败输入与未完成应用提示保留

### Requirement: 录制工作区提供真实接入提示和只读记录入口

录制工作区 SHALL 提供本地地址、会话凭据说明、查看代理记录和显式刷新。hasKey SHALL 仅表示当前 main 会话捕获凭据，不证明上游连通、请求成功或任意 Agent 已接入。停止 SHALL 只表述为停止本地服务，不承诺取消外部任务。

#### Scenario: 查看代理记录保留选择和搜索

- **WHEN** 用户从录制点击查看代理记录且已有任务/ID 搜索
- **THEN** 打开运行导航并设代理来源筛选，搜索共同生效，保留当前打开运行；结果被隐藏时提供可见清除条件入口

#### Scenario: 录制刷新只读且错误可重试

- **WHEN** 用户刷新监听/凭据状态或运行列表且读取失败
- **THEN** 明确对应读取失败并允许只读重试，不 toggle、不调用模型、不新建运行或覆盖配置草稿

#### Scenario: 重启后凭据失效历史仍可读

- **WHEN** main 重启后已保存启用配置恢复但没有本会话凭据
- **THEN** 历史记录可读，监听事实按当前状态显示；重发明确需要重新经代理接入，零 key 回读或持久恢复

#### Scenario: 录制状态不冒充接入验证

- **WHEN** 代理监听成功或刷新后 hasKey=true
- **THEN** 只展示监听/凭据事实，不主动测试 upstream，不展示连接成功、Agent 已接入、无契约的请求速率或最近请求时间

#### Scenario: 停止服务不称取消运行

- **WHEN** 用户保存停用代理且有外部 Agent 或在途请求
- **THEN** 只反馈真实服务状态并说明停止本地接入，不承诺外部 Agent 或在途请求已取消，不改主动操作结局

### Requirement: 模型实验工作区绑定父本和完整批次草稿

已有模型实验 SHALL 从运行级入口进入主工作区，以父 run 和首次自有 llm.call 绑定整批草稿；默认两臂，保留稳定臂身份、顺序与原始 model/paramsText。工作区 SHALL 复用既有普通实验能力门禁与 U3 草稿规则，不由当前侧栏选择隐式替换父本。

#### Scenario: 运行入口打开明确实验目标

- **WHEN** 用户从合格普通运行的更多操作进入模型实验
- **THEN** 显示父本身份、首次自有调用与默认两臂，正文占主工作区；来源不完整、隔离或其他不合格父本明确拒绝执行且不出现降级绕过

#### Scenario: 切运行不更换实验父本

- **WHEN** 用户编辑实验后选中另一运行，再通过草稿入口返回
- **THEN** 返回精确父 run/调用，臂身份、顺序及非法参数原文恢复，不把新选中运行当旧草稿父本

#### Scenario: 实验空参数与显式空对象区分

- **WHEN** 某臂参数文本为空或显式为 {}，或输入非法类型/保留键
- **THEN** 前两者分别沿用父参数和整体替换为空，最终计划来自后端；非法输入保留且不可执行，逐臂空 fork 仍按既有条件拒绝

#### Scenario: 实验来源失效仍能返回草稿

- **WHEN** 实验编辑恢复时父本缺失、ownOnly、损坏或首次调用事实改变
- **THEN** 保留批次输入并明确来源原因，撤销计划/确认，不以旧完整详情放行；来源恢复后重新校验预览

#### Scenario: 离开实验恢复不带计划许可

- **WHEN** 用户从实验去设置、录制、结果或比较，再返回编辑
- **THEN** 批次原文和稳定臂身份保留，旧计划、费用确认及副作用许可不恢复，能够返回原来源有效位置

### Requirement: 实验结果工作区消费可信完整批次并连接比较

实验结果 SHALL 按 main 登记的批次身份、预期臂数及逐臂真实 ID 展示，结合自有结果核实，不从成功臂响应集合或目录扫描补造失败/未开始臂。工作区 SHALL 提供打开、失败定位、只读重试、返回草稿以及连接既有比较的动作，后台结果 SHALL 尊重阅读意图。

#### Scenario: 成功臂集合不隐去失败臂

- **WHEN** 实验响应 ids 仅含成功臂而登记还有失败臂或 null ID
- **THEN** 按预期臂列出全部位置，失败臂可按可信 ID 打开，未关联臂明确无记录；不以响应 ok/ids 判整批正常完成

#### Scenario: 实验结果不可读仅重试读取

- **WHEN** main 已 settled 但某臂结果损坏、缺失或读取失败
- **THEN** 保留批次草稿与该臂诊断，只按可信 ID 只读重试；执行槽仍以 main 当前事实为准，不自动重跑或定位邻近记录

#### Scenario: 全臂核实才按提交修订清理

- **WHEN** 全部预期臂核实自有正常 completed，或存在失败、缺臂、未知、不可读及较新草稿修订
- **THEN** 仅全臂正常且提交修订匹配时清理整批；其他情况保留，不删除后来输入或其他批次

#### Scenario: 实验结果选两到四条进入共用比较

- **WHEN** 用户选择两条、三四条或尝试第五条真实关联结果
- **THEN** 两条按选择顺序进入详细比较，三四条进指标表再选两条，第五条明确拒绝；由共用读取校验与实验门禁判资格，不恢复执行许可

#### Scenario: 比较拒绝和返回实验不改批次事实

- **WHEN** 所选臂链不完整、未封存、异父或缺配置证据，或用户从比较返回
- **THEN** 共用工作区明确拒绝实验比较且可单独阅读；返回原实验目标及结果位置，无臂间差值/胜出结论，不合并不同批次

#### Scenario: 跨页结束与重载恢复实验结果

- **WHEN** 执行中用户切到文件/录制/其他运行，或同 main 下 renderer 重载
- **THEN** 后台结束不抢页与焦点，全局入口可定位真实批次；重载恢复登记/结果读取但不补造内存草稿、计划或旧确认，unknown 只核对不重发

### Requirement: messages 编辑工作区保留单请求来源与返回路径

代理 messages 编辑 SHALL 使用主工作区，显示父 run、自有调用、原值与完整编辑 JSON，并明确单请求重发的费用和能力边界。输入 SHALL 使用既有精确草稿键，不因页面、设置或录制往返丢失；来源或凭据失效 SHALL 撤销许可而保留草稿。

#### Scenario: messages 工作区恢复完整非法文本

- **WHEN** 用户输入未完成 JSON、空串或尾随空白后切页并从草稿返回
- **THEN** 精确 run/span/messages 原始文本逐字恢复，合法性错误就近呈现，原值可完整阅读，零自动重发

#### Scenario: 缺凭据转录制再返回精确编辑

- **WHEN** 用户从缺凭据提示进入录制并返回 messages
- **THEN** 父本、调用与正文保留，重新读取代理真实状态；凭据值不进入草稿，旧确认不恢复

#### Scenario: messages 确认仍是单请求

- **WHEN** 已编辑合法 messages 并通过当前来源/凭据检查后确认
- **THEN** 说明真实 upstream 请求费用及不执行外部 Agent 工具；仅经既有登记重发路径提交，不执行普通 replay 或重建外部文件世界

#### Scenario: messages 失败定位与返回不丢草稿

- **WHEN** 重发失败、unknown 或记录不可读时用户打开结果再返回
- **THEN** 按本次可信 ID 阅读/定位或仅重试读取，保留精确编辑草稿并撤销旧许可，源运行不变，不因结果失败重发

### Requirement: 辅助工作区在窄窗与键盘下保持连续流程

录制、实验和 messages 工作区 SHALL 使用文字与可辨状态组织配置、计划及结果，保留完整长字段和主正文阅读宽度。窄窗/缩放 SHALL 通过内部滚动和上下排列保持操作可达，不以缩小字体隐藏问题；设置/放弃模态及全局操作规则维持。

#### Scenario: 辅助页面窄窗和缩放完整可用

- **WHEN** 在 1440/1360/1024/800px 或 200% 缩放使用三个辅助工作区
- **THEN** 字段、长 JSON、臂计划、结果与主要按钮完整可读/可滚动，不被步骤目录挤占，页面无非预期横向溢出，自动收导航不改宽度偏好

#### Scenario: 长模型上游和告警可完整核对

- **WHEN** 模型、upstream、ID 或 provider 告警超长且臂参数很多
- **THEN** 可展开/滚动/复制完整值，臂和运行身份始终可辨，状态有文字，告警不截成无法核对的摘要

#### Scenario: 键盘完成录制到重发闭环

- **WHEN** 仅用键盘进入录制、应用、复制地址、查看记录、编辑重发并返回
- **THEN** 所有步骤有可见焦点和可访问名称，复制/读取失败有可感知反馈，返回有效来源焦点，工作区不困焦点

#### Scenario: 键盘完成实验到比较闭环

- **WHEN** 仅用键盘增删臂、预览、确认、打开失败或选两条比较后返回
- **THEN** 动作真实生效且保持明确臂身份，设置/放弃确认仍约束焦点和支持取消，比较返回到原实验目标

#### Scenario: 辅助页面不改变已有主流程

- **WHEN** 在新页面往返普通/隔离创建、result/prompt、U2 文件、U7 比较和全局操作
- **THEN** 原入口、草稿、合法文件检查点、比较选择/返回及单槽门禁继续有效，不新增执行权限或丢失已有阅读位置

### Requirement: 工作区折叠控制一致且可发现

页面列表、步骤、目录、长文本及说明的折叠控制 SHALL 使用可辨文字/方向、与实际状态一致的可访问名称及展开状态，并提供至少 28 CSS px 高命中区和可见焦点。收起 SHALL 保留明确恢复入口、原文、当前目标与有效阅读位置，不等于放弃或取消执行；自动适配 SHALL NOT 覆盖手动偏好。代码 gutter 折叠 SHALL 与页面面板控制区分。

#### Scenario: 列表和步骤控制可发现且可恢复

- **WHEN** 用户查看或收起运行列表/步骤目录
- **THEN** 可直接看到“收起/展开”含义，无需仅靠浅色箭头或 tooltip；收起后恢复入口仍可见且保持选择与手动宽度

#### Scenario: 目录与长文本折叠不丢位置

- **WHEN** 用户收起目录或某 run/span 的长正文并重新展开/往返
- **THEN** 控制就近可辨，完整原文、有效选择与阅读状态保持，其他目标不串状态，不发模型请求

#### Scenario: 键盘折叠显示当前状态

- **WHEN** 用户用 Tab、Enter/Space 操作折叠控制
- **THEN** 焦点可见，名称和 aria-expanded 对应当前真实状态，折叠后焦点与恢复入口可达，没有静态文字假按钮

### Requirement: 工作区说明分层去重且异常不隐藏

同屏同一隔离/一般说明 SHALL 只呈现一份完整内容，一般元信息与实现细节按需展开。当前来源身份、文件检查点与差异两侧、错误/未知/阻断状态摘要和处理动作 SHALL 保持可见。详细原文仍可全文阅读/复制，不能用折叠丢数据或宣称未交付能力。

#### Scenario: 隔离文件页不重复同一说明

- **WHEN** 打开隔离根或续跑分支的文件页
- **THEN** 运行页头与文件区不重复同一长隔离段落，当前轮次/来源及只读身份可辨，详细保真边界有明确展开入口

#### Scenario: 技术元信息按需完整阅读

- **WHEN** 用户查看 profile/world/snapshot/hash、不适用能力或执行机制详情
- **THEN** 来源元信息与工程说明采用同一受控、可访问的详情展开机制，展开状态按当前阅读目标隔离；紧凑摘要之外可完整阅读/复制原值和原因，主内容不常驻多层技术解释，不改写 trace

#### Scenario: 异常摘要始终可见

- **WHEN** 来源不完整、附件读取失败、状态未知或提交受门禁阻断，用户收起一般说明/进入专注
- **THEN** 相关异常摘要与处理动作仍可见，完整诊断可展开，折叠不能绕过门禁或伪装可执行

### Requirement: 编辑与差异获得实际可用空间

主要编辑器与 diff SHALL 随实际容器宽高适配，使用剩余内容区并支持内部滚动；原值/草稿按每侧可读宽度决定并排/上下，提供区域调整与原值恢复入口，不仅使用窗口 xl 断点或固定 200px。1210×713 CSS px 下正常文件页及专注编辑/差异 SHALL 至少提供视口高度一半的主要正文可见区域；异常造成不足时 SHALL 保留必要诊断和可达阅读退路。SHALL NOT 缩小正文字号、造成非预期整页横向溢出或将只读 diff 变为可写。

#### Scenario: 普通文件页正文获得可见高度

- **WHEN** 在真实 1210×713 视口打开正常隔离 config.json 修改 diff，包括从比较返回路径
- **THEN** 在正常紧凑布局或明确专注模式下主要正文可见高度至少约 357px，checkpoint/左右身份与返回可辨，不需先滚过重复说明才能阅读主要差异

#### Scenario: 原值与草稿按容器适配

- **WHEN** 改变可用宽高、收起列表或拖动/键盘调整编辑区域比例
- **THEN** 原值/草稿在每侧约 320px 可读宽度足够时可并排，否则上下且可完整滚动；主要编辑区使用剩余空间，不因固定小高度留下无用大空白

#### Scenario: 原值收起后仍可恢复核对

- **WHEN** 用户收起只读原值以集中编辑草稿
- **THEN** 草稿加大且可输入，原值恢复入口始终可见，恢复后全文与只读身份保持，不把收起等同放弃

#### Scenario: 窄窗口和缩放不压缩字号

- **WHEN** 在真实 1024/800px 窗口或独立 200% 缩放阅读/编辑长内容
- **THEN** 通过上下排列、内部滚动和相邻工具栏保持正文及操作可达，不缩字号掩盖不足，无非预期整页横向溢出和遮挡

#### Scenario: 只读差异保持只读

- **WHEN** 切换差异布局、专注或区域尺寸并查找/复制原文
- **THEN** 文件与输出 diff 仍只读，无替换/回写操作，不改变源目录、trace、附件或模型调用数

### Requirement: 专注模式保留目标草稿与阅读偏好

编辑和差异 SHALL 提供明确专注/退出操作，临时收起辅助列表与一般说明，保留来源/两侧身份、必要异常、返回和本次操作摘要。临时模式 SHALL 绑定当前目标，沿用现有布局状态归属，不能复制草稿/阅读状态或另建并行存储。专注/自动适配 SHALL NOT 写回手动偏好，退出 SHALL 移除临时覆盖并按当前空间恢复有效偏好；专注中主动调整辅助区偏好 SHALL 先退出再更新，之后不回滚该主动调整。目标变化、离开或卸载 SHALL 清除专注，返回不自动重入。模式切换 SHALL 保留精确草稿（含非法文本）、模型/view state、光标与滚动，不自动提交或恢复已失效许可。

#### Scenario: 专注模式保留身份并恢复布局

- **WHEN** 用户从手动设置的列表/目录宽度进入专注再退出
- **THEN** 专注中目标和恢复操作可见，手动偏好前后相等；退出仅移除临时覆盖并按当前空间恢复有效宽度/阅读位置，不用旧快照覆盖偏好

#### Scenario: 专注切换目标与主动调整有明确归属

- **WHEN** 专注时切换 run/span/编辑字段或比较 pair、离开/卸载再返回，或显式调整辅助区宽度/折叠偏好
- **THEN** 目标变化与离开立即解除旧专注，返回不自动重入；主动调整先退出专注再写原偏好，后续退出不回滚调整；草稿与阅读状态仍由原目标机制持有，无跨目标覆盖或旧许可恢复

#### Scenario: 长草稿切换不丢输入和目标

- **WHEN** messages/prompt/result/A/B 输入含非法 JSON、多行、空串或尾随空白，随后折叠/专注/页面往返
- **THEN** 精确目标和完整原文逐字保留，编辑器恢复后可输入，光标/有效滚动保持，不新建错目标草稿或自动执行

### Requirement: 比较修改证据可收起且身份始终可辨

比较页 SHALL 为修改证据提供可见摘要和展开/收起控制，收起释放输出阅读空间，不丢前后值/方向或关系不完整提示。diff 两侧 SHALL 有紧凑可见运行身份，不只靠 tooltip。

#### Scenario: 修改证据收起释放输出空间

- **WHEN** 用户阅读长输出 diff 并收起修改证据
- **THEN** diff 获得释放的高度，字段/方向/修改概况及恢复入口可辨，展开后完整证据与阅读位置保持，关系未知不被说成没有修改

### Requirement: 核对与提交相邻且绑定纪律不变

编辑/创建/实验的核对与提交 SHALL 位于同一紧凑操作区，窄窗可上下相邻，费用、目标、工具/文件副作用和当前门禁摘要可见，详细边界可展开。SHALL 维持既有预检、计划、源身份、配置/凭据、草稿修订及明确授权规则；阅读折叠不能新增授权或跳过核对。

#### Scenario: 确认和提交在同一操作区

- **WHEN** 用户完成当前模式所需预检/计划并准备核对提交
- **THEN** 核对与提交不隔着长说明，可在同一操作区通过键盘依次完成；sticky 栏不遮挡正文焦点或必要摘要

#### Scenario: 核对后的编辑撤销旧许可

- **WHEN** 核对后修改草稿、目标、配置/参数、凭据语义或离开后返回
- **THEN** 旧许可按既有绑定失效，完整输入保留，必须重新核对，收起或专注不能绕过校验

#### Scenario: 详细边界可读但不能跳过核对

- **WHEN** 用户折叠执行细节并尝试提交普通/隔离创建、result、prompt、messages 或 A/B
- **THEN** 当前模式关键费用/副作用摘要可见，必须满足既有两段确认与对应预检/计划，messages 仍单请求且不执行外部工具

### Requirement: 放弃修改模态视觉明确且保留安全语义

放弃修改 SHALL 使用可辨遮罩和居中对话框，受实际可用宽高约束，长内容内部滚动。SHALL 保留原生 showModal、底层交互隔离、焦点限制/恢复、Esc/取消以及修订 CAS，不通过弱化模态迁就自动化。

#### Scenario: 放弃模态可辨且取消不丢草稿

- **WHEN** 用户从编辑区请求放弃并取消或按 Esc
- **THEN** 对话框及背景遮罩清晰可见，背景不能交互，焦点回到有效触发点，草稿逐字保留

#### Scenario: 长确认可滚动且操作可达

- **WHEN** 长草稿在窄窗/200% 缩放下打开放弃确认
- **THEN** 草稿摘要/原文可滚动，继续编辑与确认放弃可达，焦点不逃到背景，没有屏外按钮

#### Scenario: 旧确认不能放弃新修订

- **WHEN** 待确认目标修订已被后续更新替换
- **THEN** 旧确认不删除新草稿，保持既有 CAS 并要求核对当前内容

### Requirement: 主流程文案表达用户结果而非实现机制

主流程提示 SHALL 用可理解的中文说明没有改动、尚未提交、失败/未知和单请求边界；fork/main 登记/config_hash 的工程解释可在技术详情保留，原始数据/API 不改名。时间旅行与隔离续跑 SHALL 有明确对应说明，不承诺未交付环境恢复。

#### Scenario: 没有改动提示用中文且技术细节可查

- **WHEN** 未修改重发/重跑，或结果区尚无提交，或打开机制说明
- **THEN** 主提示清楚表达“与原值相同，请修改后再提交”“尚未提交”等结果，技术规则可展开，不显示字面 Markdown 强调符号或改写真实状态

#### Scenario: 时间旅行名称不扩大恢复承诺

- **WHEN** 用户从时间旅行/在此重跑入口进入隔离续跑
- **THEN** 可辨两种称呼对应关系，当前模式说明整轮快照/消息复用边界，不承诺恢复外部服务或撤销同轮写入

### Requirement: 被动代理录制自动更新列表并保留阅读

renderer SHALL 订阅受校验代理变化并按 recordsRevision 自动更新成功落盘记录，main 空闲也有效；SHALL 合并在途与尾随刷新，保留筛选、选中、滚动、详情和草稿，不自动跳到被动记录。SHALL 在订阅初始化和窗口激活时只读核对当前版本以补漏，不高频扫描全部 traces。刷新失败沿用旧列表未更新提示与只读重试。

#### Scenario: 空闲 main 的被动录制自动可见

- **WHEN** 无主动操作时外部请求成功落盘
- **THEN** 下一次合并刷新完成后“全部”及匹配代理筛选含该 run，不需要录制页刷新，当前阅读不跳转

#### Scenario: 并发录制保留筛选和当前阅读

- **WHEN** 多个请求在列表读取在飞期间落盘，用户正编辑或阅读其他 run
- **THEN** 至多一个列表读取在飞并保留尾随刷新，最终可见全部新 ID，不清输入、改变筛选或覆盖当前详情

#### Scenario: 订阅前与失焦期间的变化可补读

- **WHEN** 记录落盘发生在 renderer 首次订阅/快照竞争或窗口失焦期间
- **THEN** 会话 revision 快照或激活核对补齐更新，迟到的旧会话响应不能覆盖当前列表事实，无自动重发

### Requirement: 重发门禁使用当前代理事实且隔离迟到读取

messages 打开、目标变化、录制返回及窗口激活 SHALL 只读核对代理状态；已打开页面 SHALL 随捕获/监听通知更新。核对中或失败 SHALL 表达状态未知并禁用依赖当前事实的提交，不谎报未捕获。确认 SHALL 绑定语义状态及捕获版本，监听/配置/凭据变化撤销旧确认，重复同事实读取不撤销已核对确认。凭据值不得进入 renderer。

#### Scenario: 打开重发即核对当前状态

- **WHEN** main 已捕获凭据但 store 仍有旧 hasKey=false，用户打开 messages
- **THEN** 读取期间显示核对中，完成后门禁使用实际 running/hasKey，无需去录制页手动重读，不自动授权

#### Scenario: 捕获通知更新已打开编辑器

- **WHEN** 编辑器已打开，外部合法请求首次捕获凭据
- **THEN** 通知后回读更新凭据门禁，草稿不变，仍要求本次独立确认，不自动重发

#### Scenario: 凭据轮换撤销旧确认

- **WHEN** 已核对的重发收到新的捕获版本或监听/上游配置变化
- **THEN** 原确认失效，正文和目标保留，必须重新核对当前单请求费用/边界

#### Scenario: 提交前版本变化由 main 拒绝

- **WHEN** renderer 已确认但 main 在收到 proxy:fork 前捕获新凭据或应用新代理配置
- **THEN** main 按提交的预期代理/捕获版本在副作用前拒绝，不调用上游、不产生新 run，保留草稿并要求重新核对，不仅依赖 renderer 禁用

#### Scenario: 重复只读核对不撤销未变化的确认

- **WHEN** 同一 main 会话回读相同语义状态与捕获版本
- **THEN** 不因读取次数撤销仍绑定当前修订的确认，不重复执行或产生请求风暴

#### Scenario: 迟到读取不能覆盖新事实

- **WHEN** 旧状态响应晚于较新状态或新 main 会话到达，或最新核对失败
- **THEN** 旧响应不覆盖新事实；失败保留输入、显示未知及只读重试，不能使用旧确认放行

### Requirement: 代理启动恢复结果就近可见

顶栏与录制工作区 SHALL 根据只读代理状态区分恢复中、已监听、停止及恢复失败，保存 enabled 不等同真实 running。恢复失败 SHALL 在顶栏保留简短异常与录制页入口，录制页展示受控原因、状态重读和显式“保存并应用”重试；状态重读 SHALL NOT 启动监听或调用上游。恢复期间及失败时历史阅读仍可用，凭据门禁 SHALL 仅使用本次 main 会话事实。

#### Scenario: 恢复中到监听成功同步呈现

- **WHEN** saved.enabled=true，启动恢复尚在进行，随后状态通知报告真实 running=true
- **THEN** 顶栏与录制页从恢复中更新为已监听，不停留在旧停止状态；本会话尚未捕获凭据时如实显示未捕获，历史阅读不中断

#### Scenario: 恢复失败显示意图与实际状态

- **WHEN** 保存启用的代理在启动时因端口占用或其他原因恢复失败
- **THEN** 顶栏显示恢复失败并提供录制页入口，录制页可辨已启用但未监听及受控原因，不把失败说成已停用、凭据可用或监听成功

#### Scenario: 状态重读与显式应用重试区分

- **WHEN** 恢复失败后用户先重读状态，再在端口释放后显式保存并应用
- **THEN** 重读只核对状态且不启动代理；显式应用才尝试监听并呈现本次成功或失败，不自动调用模型或恢复旧重发许可

### Requirement: 代理失败概览只使用自有已记录诊断

新代理失败 run 的概览 SHALL 展示自有失败 llm.call 的简短 error.message、真实 status（若有）与定位动作；详情保持完整请求可读，usage/ttft 占位不能说成实际零消耗、零延迟或成功最终输出。历史无诊断文件仍显示详情未记录，不借祖先原因。

#### Scenario: 新代理失败在概览可诊断

- **WHEN** 新代理 run 自有 llm.call.error 含 status=401 和受控诊断
- **THEN** 概览可读 HTTP 401 及诊断并定位失败调用，详情展示请求与占位解释，没有成功最终输出

#### Scenario: 网络失败不展示伪造状态码

- **WHEN** 新失败 error 只有 message，没有上游 status
- **THEN** 概览说明连接失败且不展示上游 HTTP 502/0，缺省成本不被解释为免费

#### Scenario: 旧代理失败仍提示详情未记录

- **WHEN** 读取旧 meta+stopped/error 文件，或叶子无诊断而祖先有失败
- **THEN** 仍显示本 run 错误详情未记录，不改写文件或借祖先解释本次原因

### Requirement: 可见消息编辑器可恢复且不丢草稿

messages 可见宿主在获得可用空间后 SHALL 正确布局并可输入。尺寸/加载异常 SHALL 有明确占位与本地恢复动作，不以重启为唯一出口；恢复 SHALL 保留目标草稿、完整非法文本、model/view state，不自动提交。隐藏 Monaco helper 的零尺寸 SHALL NOT 单独作为可见塌缩的判据。

#### Scenario: 可见宿主恢复非零尺寸

- **WHEN** 真实窗口调整、最小化还原或面板往返使可见编辑区重新获得空间
- **THEN** 对应活动编辑器恢复非零尺寸可输入，草稿与目标逐字保持，不重启、不自动提交

#### Scenario: 恢复失败可见且能就地重试

- **WHEN** 编辑器加载/布局恢复失败
- **THEN** 显示可辨失败占位与恢复入口，用户重试只恢复该目标编辑器，不清空草稿、恢复旧许可或调用模型

#### Scenario: 隐藏 Monaco 节点不误报

- **WHEN** 页面有零尺寸隐藏 helper 且可见活动编辑器尺寸正常
- **THEN** 不显示虚假塌缩错误，复现证据以可见宿主及其祖先、活动实例归属判定
