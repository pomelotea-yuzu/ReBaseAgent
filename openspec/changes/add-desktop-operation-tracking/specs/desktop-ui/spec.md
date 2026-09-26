## ADDED Requirements

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

所有现有主动入口 SHALL 在当前 main 握手成功且可执行时生成新 operationId，并绑定 U3 提交修订。renderer SHALL 以 main 状态、通信未知和本地尚未确认的提交共同派生提交/配置门禁；展示复位或页面卸载 SHALL NOT 清除操作。现有全局栏 SHALL 提供紧凑操作查询入口，展示真实状态、目标和可信 ID，并允许核对及明确打开记录，不显示虚构阶段、百分比或取消能力。既有正常执行页面布局保持可达，完整结果流程由后续 change 承接。

#### Scenario: 初始握手失败禁用主动入口

- **WHEN** 尚未取得有效 main 状态或握手返回非法结构
- **THEN** 七类主动入口及配置写入口均不可提交，只读页面仍可访问；main 继续拒绝无身份的直接请求

#### Scenario: 所有入口实际使用同一适配器

- **WHEN** 从原创建、result、prompt、messages、A/B UI 发起实际操作并切换页面
- **THEN** 请求携带身份且全局入口可查询同一登记，槽状态同步禁用其他主动/配置入口；页面卸载、reset 和列表刷新不删除登记或重复请求

#### Scenario: 核对结果只由用户明确打开

- **WHEN** 用户从恢复/核对入口读到 settled 和可信 runIds，或迟到响应属于已离开的旧提交
- **THEN** 只更新对应登记，不自动更改当前页面；用户可明确按 ID 打开，未取得 ID 时不显示伪结果链接

#### Scenario: 操作入口在窄窗口和键盘下可达

- **WHEN** 800px 窄窗口或 200% 缩放下用键盘打开操作入口、核对并选择结果
- **THEN** 类型、状态和完整 ID 可读可操作，长文本不遮挡命令，焦点与关闭恢复遵守现有模态规则，不出现无实现的停止按钮

## MODIFIED Requirements

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

### Requirement: 提交绑定草稿修订且响应不清除草稿

每次提交 SHALL 原子绑定草稿键、修订和请求快照，以及 epoch/operationId，在该请求待定时冻结对应草稿的修改/放弃。组件卸载或展示状态复位 SHALL NOT 解除冻结。所有响应 SHALL 只处理匹配关联；本阶段 SHALL NOT 因任何执行结果自动删除草稿。无法确定执行状态时 SHALL 保留输入和冻结，不自动重发；可信 settled/notAccepted 核对 SHALL 仅解冻该提交。新执行 SHALL 使用新 ID 并重新预检/确认授权，不复用失败或已封禁操作的许可。

#### Scenario: 提交快照独立于编辑器挂载

- **WHEN** 用户提交 result、prompt、messages、创建或 A/B 后，编辑组件卸载并再次挂载
- **THEN** 待定草稿仍对应原 key/revision 和提交值且不可修改或放弃，卸载不重发、不解冻；其他草稿输入不被覆盖

#### Scenario: 成功错误和部分失败均保留草稿

- **WHEN** 任一现有执行入口收到 ok、业务拒绝、明确请求失败或 A/B 部分失败
- **THEN** 提交草稿保持原文，已由可信终态或明确本地未发送证明结束的本次关联可解冻；即使 IPC 返回 ID 或记录正常 completed 也不自动清理，用户可明确放弃

#### Scenario: 迟到回调与未知状态不能错误解冻

- **WHEN** 回调不再匹配当前提交关联，或通道断开无法判断执行是否仍在进行
- **THEN** 旧回调不解冻新提交、不删除新修订；状态未知保留冻结与可复制输入，重开编辑器不能解锁或自动重发

#### Scenario: 核对终态只解冻对应修订

- **WHEN** reconcile 返回 running、settled 或 notAccepted
- **THEN** running 保持对应冻结，后两者仅解冻匹配 epoch/operationId/key/revision/token 的关联且保留原文；新提交重新取得许可，不把旧 sourceToken 或授权自动恢复

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
