## ADDED Requirements

### Requirement: 验证工作区核对明确输入与执行环境

桌面 SHALL 从检查点提供验证入口并显示 run/步骤/快照、固定检查、环境、网络/写入范围、限制及当前授权。后端/模板/来源不满足时 SHALL 展示原因；准备和测试分开确认，SHALL NOT 因打开页面自动准备/执行，或把历史文件写入授权当作命令许可。

#### Scenario: D01 计划预览和不可用原因
- **WHEN** 在初始/自有步骤进入验证，或后端未安装/模板不支持
- **THEN** 显示精确输入和当前条件，失败原因连接可行动说明，预览不下载、建容器或调用模型

#### Scenario: D02 当前确认与计划漂移
- **WHEN** 确认准备/测试前后发生输入/环境/命令计划变化
- **THEN** 旧确认失效并重新核对，准备与执行许可不互相替代，不自动提交新计划

### Requirement: 验证操作保留独立可信领域身份

准备/验证的 operation 摘要 SHALL 分别关联编排真实创建的 preparationIds/verificationIds，目标 run 只放 target，runIds 仍仅表示该操作创建的 Agent run。已接受后失败 SHALL 保留已知验证身份；无身份 SHALL 不从时间/日志/最新列表猜测。settled 与测试 passed SHALL 独立呈现，核实/读取重试 SHALL NOT 再执行。

#### Scenario: D03 响应丢失与重复提交
- **WHEN** 同 ID 重复、响应丢失、renderer 重载或接受后失败
- **THEN** 复用 status/reconcile 核对真实操作与验证 ID，保留已知失败记录，不创建第二容器或猜新 run

#### Scenario: D04 请求结束与测试结局分层
- **WHEN** 操作 settled 但测试断言失败、证据不全或结果读取失败
- **THEN** 分别显示请求收尾、测试结局和读取状态，只重读可信验证，不标成测试通过或重跑

### Requirement: 停止接口仅控制已登记的 R3 操作

preload/IPC SHALL 仅新增按 epoch/operationId 与可信领域 ID 绑定的 R3 定向停止，不暴露任意 PID、容器或通用 Shell/kill/abort。main SHALL 校验 sender/frame、epoch、owner 和操作类型，重复停止幂等，不占第二槽。旧模型/代理执行 SHALL 保持原无取消契约。

#### Scenario: D05 合法停止与迟到停止
- **WHEN** 对当前 R3 请求停止，重复发送或旧操作停止在新任务期间到达
- **THEN** 当前 owner 显示 stopping 并核实全进程停止；重复不启动新执行，迟到请求不停止/解锁新 owner

#### Scenario: D06 非法目标不能执行停止
- **WHEN** 请求带任意容器/PID、错误领域 ID、旧 epoch、非法 sender 或普通模型操作 ID
- **THEN** 副作用前拒绝，不停止任意资源，不新增通用取消桥接

### Requirement: 修复结果以可核查测试事实连接代码和导出

结果 SHALL 在同一阅读流程展示精确检查点、已有干预、代码差异、环境/检查条件、真实结局、命令/日志与缺项；通过仅对应实际固定检查。导出 SHALL 连接验证输入的 R2.1 选择，不随比较切侧/默认检查点改变。Agent 文本与退出码/可信断言/用户判断 SHALL 分开。

#### Scenario: D07 比较原失败与修复结果
- **WHEN** 用户选择两条验证比较
- **THEN** 显示各自来源/干预/代码/条件/结局；条件变化或未知可见，不强行形成同条件失败到通过

#### Scenario: D08 结果导出不换点
- **WHEN** 从已选验证导出或导航到另一个步骤
- **THEN** 导出绑定原验证精确输入，新步骤不继承通过标签；日志/材料包不被暗含在代码导出承诺中

### Requirement: 验证日志与未知状态保持可读和只读

日志 SHALL 按流有界读取并展示截断/续读/损坏事实，以不可信文本呈现。未知和停止未确认 SHALL 保留锁及可信身份，不用刷新页面假装结束。结果读取不产生准备/执行/清理，旧异步响应 SHALL 不覆盖新输入或新验证。

#### Scenario: D09 长日志与迟到响应
- **WHEN** 查看超限日志、切换验证后旧响应迟到或日志附件损坏
- **THEN** 展示当前验证的范围/截断或损坏，不混入上一条正文，不自动补写/执行，不以截断视图表示完整日志

#### Scenario: D10 daemon断开与启动残留
- **WHEN** 停止未确认或新 main 尚未完成 R3 残留核查
- **THEN** 明确显示 unknown/核查阻断，只提供可信核对/定向停止；旧记录不显示仍可继续执行，不伪造取消

### Requirement: 验证流程在窄窗缩放和键盘下连续可用

核对、授权、停止、日志、比较与导出 SHALL 在宽窗、约 800 CSS px 窄窗、200% 缩放及键盘下可读可达，长身份/路径/输出不撑破页面。返回 SHALL 保留已有文件/比较阅读选择，焦点回到合理入口，不清除相关修复草稿。

#### Scenario: D11 几何和键盘流程
- **WHEN** 在宽/窄/200% 及键盘操作下完成核对、执行/停止、日志、比较和导出
- **THEN** 关键身份/结局/按钮可达，长内容局部滚动，焦点受控且无被遮挡必要操作

#### Scenario: D12 返回保留阅读和草稿
- **WHEN** 从文件/比较进入验证，再返回或去已有编辑入口
- **THEN** 保留原检查点、两侧身份、阅读位置和合法草稿，不自动导航到另一运行或恢复旧执行许可

## MODIFIED Requirements

### Requirement: 主动执行由 main 会话身份登记和去重

main SHALL 在启动时生成全窗口共用的 epoch，并为普通/隔离 create、普通/隔离 result fork、prompt fork、proxy messages 重发、A/B 真实执行及 R3 环境准备/项目验证登记 epoch/operationId。登记 SHALL 包含类型、目标、running/settled/notAccepted、可信 runIds、请求结局及安全诊断；仅存 main 内存且终态与封禁保留至该会话结束。相同 ID 和相同规范化业务请求 SHALL 仅关联原操作，异参 SHALL 拒绝；判重 SHALL 先于任何授权消费、文件副作用或模型/工具调用。请求正文、sourceToken、凭据和原始错误 SHALL NOT 存入登记或查询返回。

每次请求的指纹与实际编排业务参数 SHALL 来自入口同一次 schema parse 产生的不可变业务快照。实现 SHALL NOT 回用原始 payload、重新补出不同缺省值或在指纹生成后修改快照；包层入参映射与既有领域校验 SHALL 保持该快照的业务值。

R3 操作 SHALL 另保存实际编排创建的 preparationIds/verificationIds，runIds 仍只表示本操作新建的 Agent run，目标来源放 target；领域记录持久化 SHALL NOT 改变 registry 仅存当前 main 内存的契约，SHALL NOT 持久化请求正文或恢复旧许可。

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

#### Scenario: M01 R3 操作复用登记且领域身份不冒充运行

- **WHEN** 环境准备/项目验证提交、重复、失败或响应丢失
- **THEN** 使用相同 epoch/operationId 判重、不可变快照和核对规则；只关联实际 preparationId/verificationId，runIds 不伪造 Agent run，重复不创建新资源或消费许可


### Requirement: main 原子执行槽覆盖所有主动编排

main SHALL 在接受主动请求时同步占用唯一执行槽，直到该操作执行及资源/文件收尾结束后原子置 settled 并释放自己的槽。A/B SHALL 整批占槽。拒绝尚未接受的新请求 SHALL 登记 notAccepted 且封禁该 ID；接受后的业务失败 SHALL 以 settled 记录。只读操作与代理被动录制 SHALL NOT 占主动槽。配置变更和关闭协商 SHALL 与接受新主动执行互斥，renderer 展示或读取成功 SHALL NOT 作为释放条件。

R3 准备、项目执行、全部后代停止确认和文件/日志收尾 SHALL 全程占同一槽。R3 定向停止仅控制当前 owner，不另占槽；停止未知 SHALL 保留占用。启动残留核查 SHALL 与新主动接受互斥，不恢复旧 epoch 操作。

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

#### Scenario: M02 R3 全程占槽且停止不提前解锁

- **WHEN** R3 正在准备、执行、停止、采集或收尾，另一个主动请求到达，或停止结果未知
- **THEN** 原 owner 持有唯一槽直到全部停止和收尾确认，另请求按原 notAccepted 规则拒绝；定向停止不争第二槽，未知不自动解锁，旧回调不释放新 owner
