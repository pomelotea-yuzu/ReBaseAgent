# project-verification Specification

## Purpose
R3 单环境真实项目验证（受限准备/受控 Docker 执行/静止采集/停止语义/启动核查）。
覆盖范围/边界见 `docs/guide/isolated-project-verification.md`；本 spec 只锚定可验收行为。

## Requirements

### Requirement: 项目验证只在通过验收的可选后端开放

系统 SHALL 仅在 Windows x64 上已验收的本机 Linux 隔离后端运行首个固定 Node/TypeScript profile。执行前 SHALL 核实实际本地 endpoint、平台、版本和固定镜像摘要；未安装、未验收、远程引擎或边界不成立 SHALL 明确不可用，SHALL NOT 自动改用宿主 Shell。既有 R1/R2 便携功能 SHALL 不依赖该后端安装。

#### Scenario: P01 后端缺失或未验收
- **WHEN** 本地后端缺失、不可达或没有通过本版边界验收
- **THEN** 验证不可用且返回具体原因，无项目执行、隐式安装或宿主 Shell 回退；原阅读/文件实验仍按原契约可用

#### Scenario: P02 拒绝远程或漂移环境
- **WHEN** context 指向 TCP/SSH/远程引擎，实际平台或 image digest 与固定计划不同
- **THEN** 执行前拒绝，不根据镜像标签或用户环境覆盖放行，不创建测试容器
### Requirement: 环境准备与测试分开授权和记录

系统 SHALL 提供固定版本的 node-ts-v1 manifest 和独立环境准备计划，记录准确运行时、依赖锁、完整性、可信测试、runner 和镜像摘要。准备 SHALL 经当前显式确认，在相同受限后端执行依赖构建，SHALL NOT 在宿主运行项目脚本。准备可用网络范围 SHALL 明示，正式测试 SHALL 断网且不继承凭据。预检 SHALL NOT 隐式下载或构建。

#### Scenario: P03 只读计划不准备环境
- **WHEN** 查看准备计划或验证能力，所需环境尚未准备
- **THEN** 只返回安装/下载/许可/网络/体积等前提，无下载、build、容器创建、记录写入或项目执行

#### Scenario: P04 授权准备成功或失败
- **WHEN** 用户确认当前准备计划后执行，依赖准备成功或失败
- **THEN** 用真实 preparationId 单独记录计划、实际版本/摘要、网络和结果；失败不算测试失败，不在宿主跑 npm 或把准备网络继承给测试
### Requirement: 受测输入必须是明确且完整的历史检查点

验证 SHALL 显式指定已封存、来源完整隔离 run 的自有初始或完成步骤快照，复核清单及所有附件的路径、大小和哈希、固定文件工具与模板相容性。SHALL NOT 自动选择祖先/最近步骤、用当前源目录补历史或从普通/proxy run 猜项目。前置拒绝 SHALL 零验证记录、零容器创建和零项目/模型执行。

#### Scenario: P05 精确选择初始或自有完成步骤
- **WHEN** 明确选择合法隔离 run 的初始或一个自有完成 step
- **THEN** 验证目标固定为该 run/step/snapshot，物化字节逐项与其清单一致，不使用桌面最近步骤默认替换

#### Scenario: P06 来源或附件不成立
- **WHEN** run 未封存/来源不完整、无快照、步骤属于祖先，或附件缺失/损坏
- **THEN** 在副作用前拒绝，展示实际缺项，不从宿主源目录补齐，不创建验证记录或执行项目
### Requirement: 测试计划绑定固定检查与当前执行许可

系统 SHALL 仅接受 manifest 固定命令枚举及明确 selector，SHALL NOT 接受 renderer/project 自由命令、handler、物理路径、镜像/endpoint、限额、环境变量或可信测试替换。计划 SHALL 绑定输入/环境/检查/限制修订，提交 SHALL 重核且要求当前 allowExecution:true。预检 token、历史授权和工具 sideEffect SHALL NOT 替代本次许可。

#### Scenario: P07 计划或授权失效
- **WHEN** 确认后输入/环境/profile/命令/限额变化，或本次缺少执行许可
- **THEN** 拒绝原提交并要求重新核对，不复用历史写入授权，不执行项目

#### Scenario: P08 自定义命令和配置被拒绝
- **WHEN** 请求带额外命令/物理路径/环境覆盖，或项目更改固定 package/锁文件/配置和可信测试
- **THEN** schema 或模板校验明确拒绝，不执行 package scripts、安装脚本或其他 handler
### Requirement: 项目执行具有独立文件网络和资源边界

系统 SHALL 使用新建、非 root、无特权、只读根文件系统的受限容器，不挂载宿主项目/数据/daemon socket，不继承凭据，正式测试断网。CPU、内存、PID、可写空间、时长和输出 SHALL 有固定且已实测的限额。CLI SHALL 使用受控 executable/argv/env 且不经 Shell。文件物化 SHALL 按已校验清单逐项拒绝穿越、链接、特殊对象和名称冲突。

#### Scenario: P09 越界和网络实际受限
- **WHEN** 受控测试尝试宿主读写、穿越/链接、访问外网或 Docker socket
- **THEN** 所承诺访问实际失败，源目录/父/兄弟 trace/既有 blob 指纹不变，不能仅以参数或工具声明作为证据

#### Scenario: P10 资源限额生效
- **WHEN** 项目耗尽内存、PID、可写空间或超过执行时长
- **THEN** 在限定范围终止/失败并保存可识别原因与已知命令结果，覆盖后代进程，不降级无限制执行
### Requirement: 固定检查保存可核查真实执行证据

每次验证 SHALL 保存实际 executable、argv、cwd、公开环境配置、运行时/镜像/依赖/测试身份、UTC 起止、单调耗时、stdout/stderr 和真实 exit/signal。日志 SHALL 有界持续读取、记录截断/缺项并支持范围读取。测试通过 SHALL 同时满足固定检查、预期测试报告/断言、输入未变及完整证据；退出 0、零测试、Agent 文本或缺日志 SHALL NOT 单独形成通过。

#### Scenario: P11 已知失败和通过均可回查
- **WHEN** 同一固定检查分别在已知错误与修复输入上完成
- **THEN** 保存两个独立验证的精确来源、实际命令/环境/日志/退出码/耗时，失败不被后一次成功覆盖

#### Scenario: P12 零测试或不完整报告
- **WHEN** 命令退出 0 但缺少预期测试、可信断言报告或必要日志
- **THEN** 标明检查/证据缺项而非 passed，不把无报告当作全部通过

#### Scenario: P13 长输出与分页
- **WHEN** stdout/stderr 超出保存预算或总输出停止阈值，随后读取日志
- **THEN** 持续读取计数且内存/落盘有界，超阈值停止；响应明确截断/偏移/续读位置，证据不完整不能显示完整通过
### Requirement: 验证记录独立版本化且不改写运行事实

系统 SHALL 用独立版本化 JSONL 记录每次 verificationId，引用精确 run/step/snapshot、操作身份和环境/检查。记录只追加、终止后封存，日志/产物为不可变哈希附件。SHALL NOT 改写已封存 trace、将验证伪装为 Agent run/spans、改变旧 writer 版本或把验证计入模型消耗。读取 SHALL 验证版本、身份、顺序和附件，迁移后使用相对引用。

#### Scenario: P14 验证与旧轨迹兼容
- **WHEN** 对 v2/v3 隔离检查点验证并重新读取原 run、旧列表、MCP1 和消耗
- **THEN** 原 JSONL/blob 逐字不变，验证使用独立 ID/记录，原版本、run 数和模型消耗不因测试增加

#### Scenario: P15 损坏未知版本与迁移
- **WHEN** 验证记录有坏尾、未知版本、身份错配或附件损坏，或数据根整体移动
- **THEN** 前者结构化降级为不完整/损坏/不支持而非 passed；合法迁移记录凭相对内容引用读取，不依赖旧绝对路径

#### Scenario: P16 来源删除和只读查询
- **WHEN** 来源 run 后来缺失，或执行期间 list/get/readLog
- **THEN** 来源缺失明确标注，不猜同名来源；附件按自身引用校验，查询不创建记录、清理资源或重跑
### Requirement: 全进程停止后才采集受限产物

系统 SHALL 在全部项目进程及后代停止且确认无活跃写者后采集，按固定排除/输出规则核验稳定清单、路径/对象和配额。受测源码/配置/可信测试变化、链接、超额、采集不稳定或缺失 SHALL 阻止可用产物/通过发布。产物属于验证，SHALL NOT 自动成为 Agent 检查点或回写源项目。

#### Scenario: P17 停止后采集稳定输出
- **WHEN** 检查正常结束且停止事实和两次采集一致
- **THEN** 只发布允许范围内普通产物及可核对哈希/大小，显式排除依赖/缓存/临时文件，不改输入检查点

#### Scenario: P18 写者未停或产物非法
- **WHEN** 后台继续写、采集不稳定、输入源码变化、发现链接/特殊对象或配额超限
- **THEN** 保持未知停止事实或标 artifact_invalid，不发布可用输出，不用 exit 0 冒充通过
### Requirement: 失败与停止结局依据实际事实分类

系统 SHALL 区分检查失败、准备/启动故障、进程异常、超时、输出限制、用户取消、产物无效、证据不完整、中断和未知。请求停止 SHALL 只显示 stopping，确认全部后代停止才 cancelled；超时/取消/异常不得被较晚 exit 0 覆盖。未知 SHALL 不释放当前主动槽或自动重试。

#### Scenario: P19 停止覆盖子孙进程
- **WHEN** 用户停止含后台子孙写入的 R3 操作，或操作超时
- **THEN** 停止作用于实际 owner 的全部工作负载；确认后文件不再变化才记录 cancelled/timed_out 并收尾

#### Scenario: P20 启动故障与进程异常
- **WHEN** 环境准备失败、测试无法启动、OOM、进程崩溃或可信断言非零
- **THEN** 分别记录环境/启动/进程/检查失败，保留 exit/signal 和阶段，不把基础设施故障统计成代码断言失败

#### Scenario: P21 停止结果未知
- **WHEN** daemon 断开、资源状态核实失败或停止响应丢失
- **THEN** 保留可信身份/已知日志，呈现 unknown/stopping，只允许核对/定向停止，不释放当前槽、自动重发或声明已取消
### Requirement: 残留资源可核查但不恢复旧执行

准备/验证 SHALL 在创建资源前持久化唯一名称和可信 owner 归属，再绑定实际资源 ID。main 启动 SHALL 在重新开放 R3 前核查并停止本实例残留，记录 interrupted/清理事实，SHALL NOT 继续旧项目或恢复旧操作许可/登记。归属不明、daemon 不可达或记录不可写 SHALL 阻止新 R3，不停止陌生资源。

#### Scenario: P22 创建响应丢失与 main 崩溃
- **WHEN** 资源已创建但返回 ID 前断开，或 main 在项目执行中崩溃后重启
- **THEN** 通过创建前记录的名称/owner 找到并停止遗留工作负载，保留中断证据，用新 epoch 而非继续执行或自动重试

#### Scenario: P23 无法确认清理
- **WHEN** 残留归属/停止无法确认、daemon 不可达、恢复记录损坏或写盘失败
- **THEN** R3 保持阻断并给出诊断，不删除/停止陌生资源、不伪造清理成功；普通只读与既有便携能力按原门禁可用
### Requirement: 修复证据比较明确条件与结论范围

比较 SHALL 使用用户明确选择的两个 verification，展示各自来源、已有干预、代码差异、环境/测试/命令条件与结果。条件不同/未知 SHALL 显示限制，不作为同条件失败到通过。Agent 文本、exit、可信断言和用户判断 SHALL 分开；R3 SHALL 不自动发起模型修复或将未记录人工改文件归为 Agent 修复。

#### Scenario: P24 同条件失败到通过
- **WHEN** 原检查点检查失败，已有隔离干预分支在相同已核实检查条件下通过
- **THEN** 两条验证、干预与精确检查点可回查，只声明实际检查结果，不自动宣布完整正确或因果关系

#### Scenario: P25 条件变化或未知
- **WHEN** 两侧测试、依赖、镜像、配置/限额等不同或缺失
- **THEN** 明确标注差异/未知，不合成为同条件修复通过，不以模型自然语言补证据
### Requirement: 验证工程模板与真实项目支持分开验收

首版 SHALL 用固定模板和确定性故障验证工程边界；已有项目支持和效率主张 SHALL 另有 I 接入的实际项目任务、适用范围和结果证据。mock、卡带测试、源码接线或静态校验 SHALL NOT 代替 Windows 后端、Electron 或真实项目实测。

#### Scenario: P26 模板成功的范围
- **WHEN** 固定模板和工程 fixture 全部通过而未完成真实项目接入
- **THEN** 只声明模板范围可用，真实项目项保持待验收，不宣称所有 Node 项目、语言或环境已支持
