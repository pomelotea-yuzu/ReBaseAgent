## MODIFIED Requirements

### Requirement: 全程只读且只呈现原样数据

系统 SHALL NOT 提供修改或删除既有 trace 的通道；span/messages SHALL 为文件原样内容，长内容用折叠而非丢弃。既有显式执行入口保持授权要求；本次扩展的 `runs:create` / `runs:fork` 在隔离模式下 SHALL 只新增本次 trace 和不可变文件附件，不修改源目录、父/兄弟运行及已有附件。目录选择、快照检查和文件差异查看 SHALL 为只读，不触发运行或补写快照。

#### Scenario: 浏览过程无写入
- **WHEN** 用户浏览 run、文件快照或文本差异，或打开/取消源目录选择器
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
- **THEN** 文件按 meta.id 归位，列表刷新使失败运行可见，status 仍表示已封存；IPC 返回 CREATE_RUN_FAILED 并引导查看详情，已记录隔离检查点保留可读，临时文件不出现在列表

#### Scenario: 直接创建隔离文件父本
- **WHEN** 用户选择受支持源目录、勾选副本写入并提交隔离模式
- **THEN** 生成 v2 根运行，详情可查看初始与各轮文件快照，源目录字节不变，后续可编辑工具结果发起隔离分叉

## ADDED Requirements

### Requirement: 隔离执行边界在操作前可辨认

系统 SHALL 对隔离运行明确标注文件隔离，并在 result 编辑提交前显示父运行、选中工具、续跑轮末检查点、真实模型调用及副本写入授权。未满足检查点/profile/附件条件时 SHALL 禁用并显示原因。旧 trace SHALL NOT 显示为已恢复文件状态；隔离父本的 prompt fork/A-B SHALL 禁用。错误不能只靠颜色表达，执行中不得重复提交。

轮号 SHALL 使用所属 run 原始 `agent.step.n`，并与该 run 身份及 step span 定位一起呈现；SHALL NOT 使用合并轨迹索引或沿链累计轮数冒充本地轮号。确认区 SHALL 指明直接父 run，当前文件检查点选择器 SHALL 使用“本 run 第 N 轮结束”，子运行的来源说明 SHALL 明确父 run 身份。

#### Scenario: 多工具轮次确认
- **WHEN** 用户编辑直接父 run B 的本地第 N 轮首个工具结果，而该轮有其他工具
- **THEN** 确认区显示“从运行 B 的第 N 轮结束后继续”及 step span 定位，同轮工具不重做；提交后子运行前缀中这些工具各显示一次

#### Scenario: 二次分叉轮号不沿链累加
- **WHEN** 根 run A 已有 3 轮，从子 run B 的本地第 1 轮再分叉生成 C
- **THEN** 确认区和 C 的来源说明指向“运行 B 的第 1 轮”及其 span，B 文件选择器使用“本 run 第 1 轮结束”；不得将其标作第 4 轮或 C 的第 1 轮

#### Scenario: 历史运行和缺附件降级
- **WHEN** 查看无检查点旧 run 或附件不可用的隔离 run
- **THEN** 轨迹可阅读，隔离按钮显示对应不可用原因，不提供“使用当前目录冒充历史快照”的自动兜底

#### Scenario: 隔离父本的其他真执行入口
- **WHEN** 用户查看隔离父本的 prompt fork / A-B 操作
- **THEN** 显示本期不支持该执行方式；即使绕过 UI 发 IPC，也在 main/core 拒绝

### Requirement: 文件检查点和差异只读可查

详情 SHALL 提供文件视图，可选择本 run 初始状态或任一自有完成步骤。文件表 SHALL 显示路径、大小、相对初始快照的新增/修改状态及附件可用性；文本文件 SHALL 能并排比较初始与所选快照内容，二进制 SHALL 只显示可核对的大小/哈希。文件不存在、缺失和损坏 SHALL 明确区分，不渲染伪空文件。SHALL NOT 提供自动回写或应用到源目录的操作。

#### Scenario: 重启后查看文件差异
- **WHEN** 应用重启后打开完成的隔离子 run，选择一个完成步骤的修改文件
- **THEN** 从 trace 引用加载相应初始/当前文本，显示真实差异和步骤来源，全部操作零文件写入与零 LLM

#### Scenario: 文件读取 IPC 拒绝越权
- **WHEN** renderer 提交清单之外路径、祖先而非自有 step，或任意物理 blob 路径
- **THEN** 返回明确错误，不读取目标宿主文件，不以同名文件或其他快照替代

#### Scenario: 长文本及窄窗口
- **WHEN** 在代表性桌面和窄窗口中打开长路径、多文件及长文本差异
- **THEN** 路径和状态可读，列表/内容能切换或滚动，文本不覆盖提交和导航控件；二进制或缺失附件不触发文本比较
