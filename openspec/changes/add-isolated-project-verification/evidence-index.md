# R3 逐场景证据索引

状态：阶段 1 完成（1.1–1.6）+ **第 2 组完成（2.1–2.4）** + **3.1–3.7 完成（受限准备/Docker 受控后端/受控物化/固定命令执行/停止语义+supervisor/静止采集/资源登记+启动核查）**——阶段 1 各切片、2.1–2.4 各切片、3.1（P03/P04 编排/P07/P08）、3.2（P01/P02/P09/P10）、3.3（P05/P06/P09/W01/W02）、3.4（P11/P12/P13/P20）、3.5（P10/P19/P21 + P20 接线）、3.6（P17/P18/W01）、3.7（P22/P23）各切片已实测（backend-verification.md §1.x/§3.1–§3.7 + `packages/project-verification` 212 用例）、4.1 登记面切片已实测（shared/operations+registry+renderer 3306 用例）、4.2 执行端点切片已实测（包 executeVerificationRun 227 用例 + 端点 14 用例/desktop 3320）、4.3 只读端点切片已实测（desktop 3329）、4.4 定向停止切片已实测（包 231+desktop 3337）、4.5 启动核查/分层可用性切片已实测（desktop 3341）、5.1 检查点入口/分开确认切片已实测（desktop 3385，+44 用例：lib 判据/store 接线/panel 静态断言）；其余任务切片待验证；文档/strict 校验通过不代表功能、隔离或实机验收通过。

## 新增场景

| 编号 | capability / 场景 | 对应任务 | 状态与证据 |
|---|---|---|---|
| P01 | project-verification / 后端缺失或未验收 | 1.1、3.2、6.5 | 1.1 缺失态已实测（2026-10-24，backend-verification.md §1.1：PATH/目录/服务/注册表/WSL 发行版/named pipe 六路，0 docker pipe）；3.2 切片已实测（2026-10-25，§3.2：resolveDockerCli 候选全不在场⇒null 不隐式安装、CLI ENOENT/超时/管道连接失败形态⇒BACKEND_MISSING 带具体原因、预检只读零副作用；6.5 指南待执行） |
| P02 | project-verification / 拒绝远程或漂移环境 | 1.1、2.1、3.2 | 1.1 记录 + 2.1 schema 切片已实测（LocalBackendEndpoint 仅枚举本机 npipe，tcp/ssh/unix 无类型表示且用例拒绝）；3.2 切片已实测（§3.2：受控 env 完全替换——实机敌意注入 DOCKER_HOST/代理/密钥不可达 CLI；未受控对照实证裸 CLI 可被 DOCKER_HOST 重定向到 tcp（exit 1 connectex）；--host 钉死 argv+env 双保险；预检服务端非 linux/amd64 ⇒ BACKEND_DRIFT；适配器构建产物平台校验+镜像内工具链实测≠manifest ⇒ DRIFT） |
| P03 | project-verification / 只读计划不准备环境 | 3.1、4.3、6.5 | 3.1 切片已实测（2026-10-25：buildPreparePlan 纯函数产出完整计划（2 项下载来源/压缩体积/许可、网络范围注记、占用估计）且不触碰后端/不写盘——包内用例断言零调用零记录；4.3 IPC 预览/6.5 指南待执行） |
| P04 | project-verification / 授权准备成功或失败 | 1.3、3.1、6.5 | 1.3 切片已实测（2026-10-24，backend-verification.md §1.3：镜像构建内 npm install --ignore-scripts 成功、lock/受信文件哈希冻结）；3.1 编排切片已实测（2026-10-25：allowPrepare 显式授权门、v2 产品化构建实测（§3.1：npm ci 联网安装 + 镜像内哈希逐项对回 + 受限冒烟 2/2）、fake 后端下成功/失败两路独立 preparationId 记录封存（失败≠测试失败）、downloadedBytes null=测不得语义）；真实后端全场景 3.2/6.2 待执行；6.5 待执行 |
| P07 | project-verification / 计划或授权失效 | 2.4、3.1、4.2 | 2.4 切片已实测（snapshotId+attachmentsManifestDigest 双摘要、sourceFactsMatch 重核）；3.1 切片已实测（planToken=计划×策略×配方绑定：漂移 token 按 plan_stale 拒绝且零记录零调用、token 决定性/敏感性用例）；4.2 提交面待执行 |
| P05 | project-verification / 精确选择初始或自有完成步骤 | 1.5、2.1、2.4、3.3 | 1.5 物化 + 2.1 schema + 2.4 预检切片已实测；3.3 切片已实测（2026-10-25，§3.3：受限容器内字节流物化后容器内独立 sha256sum 复核=冻结哈希 fcb8adfb、属主 1000:1000、/work 恰为预期文件集；物化目标固定于预检产出的 run/step/snapshot 清单） |
| P06 | project-verification / 来源或附件不成立 | 2.4、3.3 | 2.4 切片已实测（真实 run 定向破坏：未封存/附件缺失/附件篡改/模板不相容均副作用前拒绝并给原因）；3.3 切片已实测（清单静态校验全纯函数先于一切写入：穿越/空段/绝对/反斜杠/碰撞/配额负例 exec 调用=0；字节来源中途缺失/重读哈希不符即停不发布） |
| P08 | project-verification / 自定义命令和配置被拒绝 | 1.3、2.1、3.1 | 1.3 切片 + 2.1 schema 切片已实测（命令枚举、strict 对象拒绝多余键、路径/env/镜像无处传）；3.1 切片已实测（受信资产完整性门：篡改任一资产/缺配方文件拒绝并指名、篡改提交按 trusted_environment_drift 落 failed 记录；v2 配方固定锁文件+npm ci 实测镜像内哈希不变）；3.3 物化面待执行 |
| P09 | project-verification / 越界和网络实际受限 | 1.2、3.2、3.3、6.2 | 1.2 切片已实测（2026-10-24，backend-verification.md §1.2：受限/对照双跑，非 root/cap/nnp/ro-rootfs/断网全生效）；3.2 切片已实测（§3.2：受控 CLI 静态面——可信绝对路径不扫 PATH、argv 数组不经 Shell、受控 env 零继承、旗标序列无任何挂载旗标（全等断言）+ 实容器 Tmpfs 仅 /work 与 /tmp、credential 助手经受信 bin PATH 的机制而非透传凭据）；3.3 切片已实测（§3.3：穿越负例零 exec 且容器内核查 escape 缺席/根目录无异常、tee 只建普通文件 find -type l=0）；执行期越界（宿主读写/socket 实际尝试）6.2 待执行 |
| P10 | project-verification / 资源限额生效 | 1.4、3.2、3.5、6.2 | 1.4 切片已实测（2026-10-24，backend-verification.md §1.4：OOM 137/PID 62/ENOSPC/节流 50:50 含对照；PID1 信号陷阱与 tmpfs 计内存两发现）；3.2 切片已实测（§3.2：containerRunFlags manifest→旗标唯一映射 + 实容器 inspect 12 项全生效）；3.5 切片已实测（§3.5：输出限额实时击杀接线——容器内写 5 MiB vs 1 MiB 阈值 327ms 内触发、outputLimitHit=true、全观测 1,081,344 B；supervisor TERM 快停 6,166ms 对照 §1.4 基线 10,511ms；OOM 真机复现归 6.2） |
| P11 | project-verification / 已知失败和通过均可回查 | 1.3、2.2、3.4、6.1 | 1.3 切片 + 2.2 切片已实测（失败/通过两条独立记录并存、封存后字节不变、同 ID 重开拒绝）；3.4 切片已实测（2026-10-25，§3.4：已知失败 exit 1（TAP not ok）与修复 exit 0（精确门 ok）两份报告独立并存、stdout 哈希互异不覆盖；完整双验证记录回查归 6.1） |
| P12 | project-verification / 零测试或不完整报告 | 1.3、3.4 | 1.3 切片已实测（零测试危害形态实测+精确匹配 gate 自检 6 例；发现 node 22.23「零用例文件=1 伪测试 exit 0」形态）；3.4 切片已实测（validateTestReport 包层精确门：# tests/# pass 与 expectedTestCount 精确相等，零测试/超计数/垃圾输出/缺 pass 行全拒、多段 TAP 取末摘要——与镜像内 runner 门纵深） |
| P13 | project-verification / 长输出与分页 | 1.4、2.3、3.4、5.3、6.2 | 1.4 读数 + 2.3 切片已实测（readLog 默认 32KiB/上限 64KiB 钳制、nextOffset/remaining/truncated 续读契约、附件篡改 ASSET_CORRUPT/缺失 ASSET_MISSING）；3.4 切片已实测（§3.4：保留 1 MiB + 超限持续读取丢弃并计数——2 MiB stdout 实测保留恰 1,048,576 B/全观测 2,097,152 B/truncated；command_end 双口径 byteLength+totalBytes；16 MiB 阈值判定函数）；触发停止接线归 3.5、日志读取 5.3、回归 6.2 待执行 |
| P14 | project-verification / 验证与旧轨迹兼容 | 2.2、6.1 | 2.2 切片已实测（writer 只写验证目录，traces 哨兵逐字节不变、目录清单不变；独立 verificationId 记录）；6.1 待执行 |
| P15 | project-verification / 损坏未知版本与迁移 | 2.1、2.2、2.3 | 2.1 schema 切片 + 2.2 writer 切片 + 2.3 reader 切片已实测（坏尾行号/未知版本/身份错配/terminated 非末行结构化降级；数据根 rename 后记录与附件凭相对引用仍可读）；6.1 回归待执行 |
| P16 | project-verification / 来源删除和只读查询 | 2.3、4.3、5.3 | 2.3 切片已实测（list 只扫 verifications/、sourceStatus present/missing 精确目录名标注、来源缺失时记录仍可读、附件按自身哈希校验）；4.3/5.3 待执行 |
| P17 | project-verification / 停止后采集稳定输出 | 1.5、3.6 | 1.5 切片已实测（静止双扫一致、产物仅在 /work、采集须在移除前）；3.6 切片已实测（2026-10-25，§3.6：内容级双扫一致后 .build 编译产物发布——宿主落盘 verification-assets/sha256/<hash> 哈希复核一致、artifacts 事件过 schema、stray/exclude 如实计数不发布） |
| P18 | project-verification / 写者未停或产物非法 | 1.5、3.6、6.2 | 1.5 切片已实测（孤儿子孙持续写入实证、输入哈希不变）；3.6 切片已实测（改源码冒充修复 ⇒ input_drifted、链接 ⇒ artifact_invalid 不静默跟随、双扫不一致 ⇒ artifact_invalid、宿主重读不符 ⇒ content_corrupt 拒发布、配额超限拒绝）；6.2 回归待执行 |
| P19 | project-verification / 停止覆盖子孙进程 | 1.5、3.5、4.4、6.2 | 1.5 切片已实测（按 PID 杀后 2s 字节稳定；pkill -f 自杀反证 ⇒ PID 定向停止）；3.5 切片已实测（§3.5：supervisor 作 PID 1 结构落地（/proc/1/comm=sh）；孤儿写者（detached exec 后仍在写，双扫不一致实证）经受信 stop-workloads.sh 定向停止——stoppedPidCount=4/survivors=0/双扫一致 quiescent=true；supervisor TERM 快停 6,166ms）；桌面操作面 4.4/5.2 待执行 |
| P20 | project-verification / 启动故障与进程异常 | 3.4、3.5、6.2 | 3.4 切片已实测（2026-10-25，§3.4：classifyExecutionReport 四分类——completed 0–125/start_failed 126·127/process_failed ≥128（137→SIGKILL 推导）/timed_out；exit 1 报告照常产出、基础设施失败=environment_failed 与断言失败分开；OOM 真机复现归 6.2） |
| P21 | project-verification / 停止结果未知 | 1.6、3.5、4.4、6.2 | 1.6 切片已实测（断连错误形态可识别、重启窗口 unknown 语义）；3.5 切片已实测（stopWorkloadsAndConfirm：daemon 断开族 ⇒ kind=unknown 不声明已停止、只允许核对与再次定向停止；survivors>0 或双扫不一致 ⇒ quiescent=false 不乐观宣布；幂等复停安全）；桌面操作面 4.4/5.2 待执行 |
| P22 | project-verification / 创建响应丢失与 main 崩溃 | 1.6、3.7、4.5、6.2 | 1.6 切片已实测（丢弃 ID 后 label/名定位恢复；重启后容器 137 存留可清理；name 过滤为子串匹配的发现）；3.7 切片已实测（2026-10-25，§3.7：登记先于创建+创建后绑定、残留核查 stop→confirm→remove 真实 CLI 全链、interrupted 事实落未封存记录且不伪造终止、复跑幂等 no-op；跨数据根残留 fail-closed 意外实证）；4.5 main 接线/6.2 回归待执行 |
| P23 | project-verification / 无法确认清理 | 1.6、3.7、4.5、6.2 | 1.6 切片已实测（label 清理不触碰陌生容器）；3.7 切片已实测（2026-10-25，§3.7：先分类后执行——归属不明/登记损坏/daemon 不可达全部在触碰前 blocked 且零副作用、无标签容器不在扫描面原样存活、封存记录+存活容器自相矛盾 ⇒ blocked、追加失败登记不收尾可复跑重试）；4.5/6.2 待执行 |
| P24 | project-verification / 同条件失败到通过 | 5.4、6.1、7.2 | 待验证；未执行 |
| P25 | project-verification / 条件变化或未知 | 5.4、6.5、7.2 | 待验证；未执行 |
| P26 | project-verification / 模板成功的范围 | 1.1、6.5、7.1、7.2 | 待验证；未执行 |
| W01 | workspace-isolation / 分支输入保持历史字节 | 2.4、3.3、3.6、6.1 | 2.4 切片已实测（宿主源文件改写+删除后预检摘要不变）；3.3 切片已实测（物化字节=清单=冻结哈希，只读历史附件）；3.6 切片已实测（采集时输入清单锚定哈希必须不变——workload 篡改源码 ⇒ input_drifted 拒发布；产物只属于 verification 不回写检查点）；6.1 待执行 |
| W02 | workspace-isolation / 不扩展文件工具或状态承诺 | 2.4、3.3 | 2.4 切片已实测（受支持源码面精确判定：node_modules/点文件/额外入口/非 .ts 明确拒绝）；3.3 切片已实测（物化不另造标准：路径/碰撞/配额复用 trace-sdk/replay 同一权威函数与数字；链接/特殊对象结构性排除——清单 schema 无法表达 + tee 只建普通文件 + find -type l=0） |
| W03 | workspace-isolation / 导出字节对应所测输入 | 5.5、6.1、7.2 | 待验证；未执行 |
| W04 | workspace-isolation / 切换检查点或附件漂移 | 5.5 | 待验证；未执行 |
| D01 | desktop-ui / 计划预览和不可用原因 | 4.3、5.1、6.3 | 4.3 切片已实测（capability 聚合当前 planToken/已准备环境/来源预检/引擎健康；preparePlan 固定计划预览零副作用）；5.1 切片已实测（2026-10-25：文件页入口展开只发起 capability+preparePlan 两个只读 IPC（store 用例断言零执行通道调用）；精确输入/当前条件/profileSummary 投影/不可用原因可行动映射（引擎/来源/未准备分挡）由 lib+panel 用例钉住）；6.3 待执行 |
| D02 | desktop-ui / 当前确认与计划漂移 | 4.2、5.1、6.3 | 4.2 切片已实测（准备与测试分开确认：run 无已准备环境 ⇒ R3_PREPARE_MISSING；计划漂移旧确认失效）；5.1 切片已实测（2026-10-25：两份独立确认 prepareConfirmation/runConfirmation 互不替代；decideVerificationConfirmation 现算——目标键/计划 token/命令任一漂移 ⇒ stale；提交门 stale/missing 本地拒发零 IPC（不隐式执行）；换检查点收起面板整域复位；迟到响应/结局按代次+目标键丢弃）；6.3 待执行 |
| D03 | desktop-ui / 响应丢失与重复提交 | 4.1、4.2、5.2、6.3 | 4.1 切片已实测（登记面：R3 领域身份由实际回调关联且失败保留、复用既有 status/reconcile 判重/封禁/核对规则——同 ID 重复/封禁/占槽语义不变）；4.2/5.2/6.3 待执行 |
| D04 | desktop-ui / 请求结束与测试结局分层 | 4.1、5.2、6.3 | 待验证；未执行 |
| D05 | desktop-ui / 合法停止与迟到停止 | 4.4、5.2、6.3 | 待验证；未执行 |
| D06 | desktop-ui / 非法目标不能执行停止 | 4.4、6.3 | 待验证；未执行 |
| D07 | desktop-ui / 比较原失败与修复结果 | 5.4、6.1、6.3 | 待验证；未执行 |
| D08 | desktop-ui / 结果导出不换点 | 5.5、6.1、6.3 | 待验证；未执行 |
| D09 | desktop-ui / 长日志与迟到响应 | 4.3、5.3、6.3 | 待验证；未执行 |
| D10 | desktop-ui / daemon断开与启动残留 | 4.5、5.2、6.3 | 待验证；未执行 |
| D11 | desktop-ui / 几何和键盘流程 | 5.6、6.3 | 待验证；未执行 |
| D12 | desktop-ui / 返回保留阅读和草稿 | 5.6、6.3 | 待验证；未执行 |
| M01 | desktop-ui / R3 操作复用登记且领域身份不冒充运行 | 4.1、4.2、5.2 | 待验证；未执行 |
| M02 | desktop-ui / R3 全程占槽且停止不提前解锁 | 4.2、4.5、5.2 | 4.2 切片已实测（R3 运行中占槽互斥：另一主动请求 notAccepted busy；槽语义全复用既有 registry）|

## 既有场景与差集

两个 MODIFIED requirement 从当前主 spec 原文提取，完整保留原 6 个登记场景和 6 个占槽场景，另各加 M01/M02。实施后必须逐条运行旧回归，不能以新增场景测试代替。归档时保存合并前主 spec 基线，核对名称/正文/场景既有零丢失。

## 证据层级

- 后端：真实 Windows、本地引擎、准确版本/镜像、边界探针与残留/指纹；fake CLI 不代替。
- 包层：确定性 fixture、真实进程日志/exit、损坏/漂移/限额注入、独立输入与导出哈希。
- 桌面：真实 Electron 宽窄窗/200%/键盘，记录实际版本/尺寸/焦点及阅读返回。
- 工程：全仓 build/typecheck/tests/lint/spec、change strict 和 diff 检查；记录用例数/Errors。
- 项目：I 真实任务单列，未完成保持未知，不将受控模板提升为已有项目支持。

## 记录模板

每项填写：提交/版本、任务号、场景、输入身份/哈希、命令、期望、实际、结果、证据路径、失真与未验证范围。失败保留原始尝试；修订和复跑另记，不能覆盖失败或预填通过。
