## MODIFIED Requirements

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

## ADDED Requirements

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
