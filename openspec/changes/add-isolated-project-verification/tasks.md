# R3 实施与验收

状态：**阶段 1 完成（1.1–1.6 全过）；第 2 组完成（2.1–2.4，包层契约与只读记录收口，65 用例）；3.1 完成（受限准备，79 用例）；3.2 完成（Docker 受控后端，103 用例）；3.3 完成（受控物化，131 用例）；3.4 完成（固定命令执行，143 用例）；3.5 完成（停止语义+supervisor 结构，156 用例）；3.6 完成（静止采集与产物发布，168 用例）；3.7 完成（资源登记+启动核查，212 用例）；4.1 完成（操作登记扩 R3，desktop 3306 用例）**；下一步 4.2（准备/测试 endpoint 绑定与占槽编排）；实机和真实项目任务未执行。单项不超过 2 小时；超时须先拆分，不将探针/fixture 通过记成真实项目支持。阶段 1 是后续执行开放的硬门槛：1.1–1.6 的探针产物（backend-verification.md 与结论）作为独立提交节点尽早落库，任一门槛未过即冻结第 2–6 组并先修提案，不以零散本地记录代替。3.3/4.5/6.2 已预置拆分点（见各条），拆分不改编号与 evidence-index 映射。发现设计不成立先修 proposal/design/spec。

## 1. Windows 后端技术验证与 profile 冻结

- [x] 1.1（1h）记录本机后端/版本/实际 endpoint、安装/许可和资源前提，建立 backend-verification.md；拒绝远程和宿主回退。验收 P01/P02/P26。（2026-10-24 完成缺失态记录：六路实测确认 Docker Desktop 未安装、许可/资源前提与远程拒绝口径落库，见 backend-verification.md §1.1；1.2–1.6 待用户安装后执行）
- [x] 1.2（2h）独立探针验证非 root/rootfs/capabilities、无宿主挂载/凭据、网络和越界实际限制。验收 P09；未通过不开放。（2026-10-24 完成：battery.sh 受限/对照双跑，非 root/cap-drop/nnp/ro-rootfs/network-none 全部生效带对照；无挂载/凭据/socket 三项诚实归因为默认基线+编排责任，3.2/3.3 落牙；镜像经 DaoCloud 源（Hub 直连超时）；详见 backend-verification.md §1.2）
- [x] 1.3（2h）冻结 node-ts-v1 模板、准确 Node/TS/镜像 digest、lock/测试/runner 哈希和固定 argv，验证可信测试不可被项目替换、零测试不通过。验收 P04/P08/P11/P12。（2026-10-24 完成：Node 22.23.4/TS 5.9.3/镜像 digest 冻结；受信环境镜像 r3/node-ts-v1:probe + 固定 argv；已知失败/修复双跑、/opt/r3 不可改、恶意测试与 npm scripts 不生效、零测试精确匹配门——发现「零用例文件=1 伪测试 exit 0」危害形态并修正；详见 backend-verification.md §1.3）
- [x] 1.4（2h）验证 CPU/内存/PID/空间/时间/输出限制，记录实际读数及清理结果。验收 P10/P13。（2026-10-24 完成：内存 512MiB OOM 击杀（137/480MB）、PID 封顶 62/64、tmpfs 160+32MiB 精确 ENOSPC、CPU 1 核 50/50 周期节流（对照 0）、stop 全宽限后 SIGKILL、logs 全量 2,099,200B、0 残留；关键发现：裸 PID 1 忽略 SIGTERM（supervisor 必要）、tmpfs 计入内存 cgroup（合并预算语义）；详见 backend-verification.md §1.4）
- [x] 1.5（2h）验证非 root 字节物化、工作负载停止后仍可采集、全部子孙停止及输入/产物稳定性。验收 P05/P17/P18/P19。（2026-10-24 完成：uid1000 字节流物化哈希=宿主、静止双扫一致、输入不变、孤儿子孙持续写入实证+按 PID 杀后字节数稳定；发现 pkill -f 模式匹配自杀会话 ⇒ 产品必须 PID 定向停止；详见 backend-verification.md §1.5）
- [x] 1.6（2h）验证 create 响应丢失、daemon 断开和 main 崩溃后的定位/停止/核查阻断；形成通过/失败结论并修订未成立假设。验收 P21/P22/P23。（2026-10-24 完成：响应丢失后 label/名定位可恢复、断连错误形态可识别、引擎重启后容器 137 存留可按登记清理、label 清理不动陌生资源；发现 name 过滤为子串匹配；未成立假设修订三条 + 未闭合项如实登记，见 backend-verification.md §1.6 总结论）

## 2. 包层契约与只读记录

- [x] 2.1（1.5h）新包及纯 schema/只读子路径、项目 manifest/selector/plan/result/error 联合、测试类型检查入口。验收 P02/P05/P08/P15。（2026-10-25 完成：`@rebaseagent/project-verification` 入库，exports `.`/`./schema` 分离；schema 纯 zod 全 strict——endpoint 仅本机管道、selector 显式判别联合、命令枚举、allowExecution/allowPrepare literal true、NODE_TS_V1_PROFILE 冻结实例（tmpfs 合并预算与 supervisorPid1 钉 literal）、结局/错误码闭集、记录事件 v1、恢复日志登记；25 用例绿 + 测试 tsconfig 0 错 + biome 0 + lockfile 仅新 importer；只读记录子路径随 2.2/2.3 落地）
- [x] 2.2（2h）版本化 JSONL writer、事件顺序/身份校验、唯一终止/封存、日志产物不可变发布。验收 P11/P14/P15。（2026-10-25 完成：schema 联合拆分 meta/正文/唯一终止；layout 布局+ID 防穿越；writer wx 排他+meta 首行钉版本+body 联合校验+terminate fsync 封存+abortClose 留未封存现场+整行落盘；assets 临时文件+link 原子排他+同哈希字节比对幂等/拒绝覆盖；40 用例全绿+测试 tsconfig 0 错+biome 0）
- [x] 2.3（1.5h）只读 list/get/readLog 范围/预算/相对引用，处理运行中、坏尾、未知版本、附件损坏、来源缺失和迁移。验收 P13/P15/P16。（2026-10-25 完成：reader 模块——getVerification 逐行校验（坏尾行号/未知版本/身份错配/terminated 非末行/重复终止均结构化降级，非 sealed 不呈现结局）、listVerifications 只扫 verifications/、readLog 先整体验哈希再 32KiB 默认/64KiB 钳制切片返回 nextOffset/remaining/truncated、sourceStatus 来源标注、数据根 rename 后记录与附件仍可读；53 用例全绿+测试 tsconfig 0 错+biome 0）
- [x] 2.4（1.5h）显式自有检查点/来源完整性/模板与附件全量预检，快照/计划摘要和漂移重核。验收 P05/P06/P07/W01/W02。（2026-10-25 完成：source/precheck——readWorkspaceRun+locateSnapshotInRun 同一时点、status≠completed 拒、selector 显式二选一、受支持源码面精确判定（拒 node_modules/点文件段）、R1 配额复核复用 replay findFileSetQuotaViolation、附件逐字节 readVerified、snapshotId+attachmentsManifestDigest 供 PlanBinding、sourceFactsMatch 漂移重核；集成测试用真实 createIsolatedRun 夹具（12 用例：initial/step/未知步骤/run 不存在/未封存/模板不相容/附件缺失/篡改/宿主源目录漂移不影响）；配额边界用例归 replay 包既有测试，如实注明；65 用例全绿）

## 3. 受限准备、执行和产物

- [x] 3.1（2h）固定准备 plan/执行、许可与当前授权、后端内依赖构建、独立准备记录；不在预检下载。验收 P03/P04/P07/P08。（2026-10-25 完成：受信环境资产产品化入库——内嵌构建资产（探针 env 字节原样 + 探针镜像内提取的固定锁文件/清单，`npm ci` 配方）+ 完整性门 verifyNodeTsV1Assets 逐项对回冻结 manifest；buildPreparePlan 纯只读计划（实测压缩/占用数字 + 网络范围/许可明示，P03）+ preparePlanToken（计划×策略×配方绑定，P07）；executePreparation 编排——allowPrepare 门→schema strict→token 漂移零副作用拒绝（P07）→独立准备记录先于构建→完整性门→后端端口内构建（依赖构建不在宿主，P04）→prepared/failed 封存（失败不算测试失败）；PreparationBackend 端口 + fake 仅覆盖编排（design D3）；v2 镜像 `r3/node-ts-v1:v2`（sha256:f3a8b56d…）构建实测镜像内六哈希与冻结 manifest 逐项一致（manifestVersion 维持 1）+ 受限 profile 功能冒烟 2/2；包内 79 用例全绿（+14）；详见 backend-verification.md §3.1。P04 真实后端全场景归 3.2/6.2）
- [x] 3.2（2h）Docker adapter 受控 CLI/env、实际本地 endpoint/digest 校验与限额参数；不经 Shell、无宿主挂载/凭据。验收 P01/P02/P09/P10。（2026-10-25 完成：`src/docker/`——resolveDockerCli 只认两处候选绝对路径不扫 PATH；controlledCliEnv 完全替换 env（实机敌意注入证明 DOCKER_HOST/代理/密钥不可达 CLI）；`--host` 钉死 endpoint 进 argv + env 双保险；preflightLocalBackend 分类（枚举外 REMOTE_REFUSED 不发起调用/ENOENT·超时·管道失败形态 MISSING/非 linux-amd64 DRIFT，P01/P02）；containerRunFlags manifest→旗标唯一映射（memory==memory-swap 无 swap、tmpfs 精确字节、--restart no、--log-driver none、不用 --init；P10 静态面）+ 实容器 inspect 核验 11 字段全生效；DockerPreparationBackend——端口内再完整性门→预检→临时上下文（仅受信资产字节，无宿主挂载）→构建→inspect digest/平台校验→镜像内工具链实测（≠manifest ⇒ DRIFT）；实机构建两次成功（1.9s/7.9s，digest 按次登记）+ 镜像内五哈希复核全一致；未受控对照实证 DOCKER_HOST 可重定向（P02 必要性）。包内 24 新用例共 103 全绿、测试 tsconfig 0、biome 24 文件 0。事实源 backend-verification.md §3.2）
- [x] 3.3（2h）已校验清单流物化和路径/链接/配额拒绝，不读源目录或任意 archive。预计偏紧：可按穿越与名称碰撞、链接与特殊对象、配额三段拆分证据。验收 P05/P06/P09/W01/W02。（2026-10-25 完成（一次收口未拆分）：`src/materialize/`——清单静态校验全纯函数先于一切写入（穿越/空段/绝对/反斜杠/碰撞 NFC+大小写折叠/配额 2000·8MiB·64MiB，全部复用 trace-sdk/replay 权威函数，W02 不另造标准），负例零 exec 实测计数为证；编排=建目录→逐文件重读核验（readVerified 长度+哈希）→tee 字节流写入→容器内 sha256sum 逐路径复核（P05「物化字节逐项与清单一致」）；链接/特殊对象结构性排除（清单 schema 无法表达 + tee 只建普通文件 + 实机 find -type l=0）；Docker 实现经 `exec -i tee`（字节 stdin/路径 argv，不经 Shell；alpine /bin/tee 坑改 PATH 解析）+ 字符预算分批；CliRunner 增 stdin 支持与写入失败上报。实机探针六步全过：正例 2 文件哈希=fcb8adfb（与阶段 1 冻结值一致、属主 1000:1000）、独立容器内复核、无链接、穿越/碰撞负例零 exec 且 escape 未发生。包内 28 新用例共 131 全绿；事实源 backend-verification.md §3.3）
- [x] 3.4（2h）固定命令执行、单调耗时、报告/退出码/阶段分类与有界 stdout/stderr 持续采集。验收 P11/P12/P13/P20。（2026-10-25 完成：`src/execute/command-runner.ts`——resolveFixedCommand 查表（命令仅来自 manifest，P08 执行侧）；executeFixedCommand 双时钟（UTC 起止+performance.now 单调耗时）+ 报告（exit/signal 推导/双流采集）；classifyExecutionReport 四分类（completed 0–125/start_failed 126·127/process_failed ≥128 含 OOM 137/timed_out；exit 1 报告照常产出——检查成败归编排层 TAP 门，基础设施故障不混入断言失败，P20）；validateTestReport TAP 精确门（# tests/# pass 与 expectedTestCount 精确相等，零测试/超计数/垃圾全拒，与镜像内 runner 门纵深，P12）；exceedsTotalOutputLimit 总观测阈值判定（P13 停止接线归 3.5）；commandStartEvent/commandEndEvent schema 事件构造（command_end 增 totalBytes 全观测口径 + 具名导出）；Docker 实现 exec --workdir + CLI 硬超时=120s+10s 余量击杀；CliRunner 捕获增字节面+超限持续读取丢弃计数（不停读防满管道阻塞）。实机探针：已知失败 exit 1（TAP not ok/2,281ms）→ 修复 exit 0（精确门 ok/1,850ms）两份报告独立并存（P11 机制切片）；2 MiB stdout → 保留恰 1 MiB+全观测 2 MiB+truncated（P13）。包内 12 新用例共 143 全绿；事实源 backend-verification.md §3.4）
- [x] 3.5（2h）owner 定向停止/超时/输出限额、全子孙停止确认、幂等与未知阻断。验收 P10/P19/P20/P21。（2026-10-25 完成：受信环境 v3（supervisor.sh/stop-workloads.sh 哈希冻结，manifestVersion→2，五原文件字节不变镜像内复核一致）；stop.ts——runStopWorkloads 解析三行清点、stopWorkloadsAndConfirm（双扫静止确认、survivors>0 或双扫不一致 ⇒ quiescent=false 不乐观宣布、幂等复停、daemon 断开族 ⇒ unknown 不声明已停止 P21）；输出限额实时击杀接线（CliRunner outputLimitBytes → 超限 kill + outputLimitHit → 分类 output_limit_stopped，超限即停不是事后发现）；workloadContainerCommand（PID 1 = supervisor）。实机探针：孤儿写者定向停止 stoppedPidCount=4/survivors=0/双扫一致（P19）、幂等复停安全、限额 1 MiB 阈值 327ms 内击杀、supervisor TERM 快停 6,166ms（§1.4 裸 PID 1 基线 10,511ms，6s≈固定 5s 宽限+开销）。包内 13 新用例共 156 全绿；计数含僵尸信号成功的语义注记与未闭合项见 backend-verification.md §3.5）
- [x] 3.6（2h）静止采集、输入未变/两次稳定校验、允许输出/排除/对象/配额和产物附件。验收 P17/P18/W01。（2026-10-25 完成：artifacts 规则入表（include .build/**/exclude node_modules+*.tmp，manifestVersion→3，纯数据不重建镜像）；collect.ts 五步——非普通对象核查先行（链接 ⇒ artifact_invalid 不静默跟随）→ 内容级双扫（find+stat+sha256sum 分批，两次不一致 ⇒ artifact_invalid）→ 逐文件分类（输入清单锚定哈希不变 W01：改源码 ⇒ input_drifted「改代码不是修复」；include∧¬exclude ⇒ 产物；其余 stray 计数不发布）→ 配额（R1 复用 + 128 MiB 唯一内容）→ 宿主重读复核后 publishAsset 内容寻址发布 + artifactsRecordEvent；Docker 实现 argv 直传（find 双形态/stat/sha256sum/cat 分批）。实机探针：test 编译产物 96 B 发布宿主哈希一致、改源码 ⇒ input_drifted、链接 ⇒ artifact_invalid。包内 12 新用例共 168 全绿；事实源 backend-verification.md §3.6）
- [x] 3.7（2h）创建前资源登记、确定名称/owner、启动核查与 interrupted 追加、陌生资源保护/恢复日志故障。验收 P22/P23。（2026-10-25 完成：`src/runtime/` 三模块 + `records/append.ts` + `docker/docker-runtime.ts`——登记先于创建（确定性名 r3-<kind>-<id> + owner 标签落盘 phase=registered → create → 绑定 ID phase=created，原子替换）；create 四分类成功/stale-name/failed/unknown（响应丢失按名探查消解，不可判如实 unknown）；启动核查先分类后执行——归属三重门（派生名∧登记在案∧标签复核）、归属不明/登记损坏/daemon 不可达/记录缺失损坏/封存+存活容器全部在触碰前 blocked 且零副作用；执行段 stop→confirm→remove 失败即 blocked+部分事实如实；interrupted 事实事件（schema 修订：验证/准备记录共用 + 登记补 containerName/epoch/dataRoot）只追加不写终止、已有 interrupted 不二次追加、坏尾/身份错配拒写盘；登记收尾 removed ⇒ 复跑 no-op。实机探针 11/11：登记+绑定、残留清理+interrupted 落记录、移除确认、幂等、无标签容器不触碰、归属不明 blocked、登记损坏 blocked、daemon 不可达 blocked；意外实证跨数据根残留 fail-closed；实测修复 Docker 29 两事实（ps --format 的 Labels 是逗号串⇒改 ps -aq+逐容器 inspect；inspect 主键是 Id 不是 ID）。包内 44 新用例共 212 全绿。事实源 backend-verification.md §3.7）

## 4. main、IPC 与操作纪律

- [x] 4.1（1.5h）扩展 verificationPrepare/verification target、真实领域 ID 摘要/回调和单次 parse 深冻结；保留旧 runIds 语义。验收 D03/D04/M01 及既有登记场景。（2026-10-25 完成：shared/operations——OperationKind 增两类 R3；target 联合增定位摘要（runId+checkpointKind+stepSpanId 可空，verification 另带 commandId 枚举），无计划正文/许可/网络策略字段；记录增 preparationIds/verificationIds 有界去重摘要；登记精炼四条——领域身份与 kind 严格对应、notAccepted 零领域身份、R3 runIds 恒空（M01 红线伪造当场抛）、step 必带 stepSpanId/initial 必不带。registry——MutableOperation/toRecord 扩展 + OperationContext.attachPreparationId/attachVerificationId（requireRunning+去重+bump identity；身份登记后不因失败撤销=D03 保留已知验证身份；kind 一致性由快照出口自证自洽核查，与 attachExperimentId 同形态）。renderer 最小展示面（KIND_LABELS/targetTextOf）。单次 parse 深冻结=parseBusinessRequest 通用路径，4.2/4.3 业务 schema 直接复用。desktop 3306 用例全绿（+5）、双 tsc 0、biome 0；既有登记场景全量回归通过。D03/D04 的桌面呈现/核对交互归 5.2/5.4）
- [ ] 4.2（2h）准备/测试 endpoint 绑定当前计划/许可，复用查重/占槽/status/reconcile，涵盖并发、响应丢失、接受后失败、旧 epoch。验收 P07/D02/D03/M01/M02 及既有占槽场景。
- [ ] 4.3（1.5h）新增 capability/preparePlan/list/get/readLog 与严格 preload/schema 白名单；capability 引擎健康仅允许枚举的只读 docker 子命令（version/info 类）并落断言；只读不执行/清理。验收 P03/P16/D01/D09。
- [ ] 4.4（1.5h）R3 stop owner/sender/frame 校验和幂等，显式更新无取消白名单断言，旧模型操作仍拒绝停止。验收 D05/D06/P19/P21。
- [ ] 4.5（2h）启动互斥核查、R3 blocked 与旧便携能力分层，正常关闭等待真实停止/收尾。预计偏紧：可按启动核查、分层可用性两段拆分。验收 P22/P23/D10/M02。

## 5. 桌面验证与修复阅读闭环

- [ ] 5.1（2h）检查点入口/显式 selector、环境准备与执行分开核对，计划变化失效且不隐式执行。验收 D01/D02。
- [ ] 5.2（2h）store slices 执行/操作/结果状态、可信领域 ID 核实和停止反馈，重载/未知只核对。验收 D03/D04/D05/D10/M01/M02。
- [ ] 5.3（2h）日志范围/截断/损坏、旧响应隔离和当前验证身份。验收 D09/P13/P16。
- [ ] 5.4（2h）双验证条件/结局/干预展示，连接现有文件差异，Agent 文本与测试事实分开。验收 P24/P25/D07。
- [ ] 5.5（1.5h）结果到 R2.1 精确输入导出、切侧/换点/附件漂移阻断与导出哈希回查。验收 W03/W04/D08。
- [ ] 5.6（1.5h）返回/草稿/阅读、焦点和响应式布局接线验证；真实视觉取证留给 6.3。验收 D11/D12。

## 6. 真实执行、实机和收口

- [ ] 6.1（2h）真实后端跑受控模板已知失败→已记录的 result/R2.2 修复分支→同条件通过→导出；回查命令/日志/代码/环境和全根指纹。真实模型仅在独立授权后执行，不挑选成功样本冒充首轮。验收 P11/P14/P24/W01/W03/D07/D08。
- [ ] 6.2（2h）真实后端故障/越界/网络/子孙/超时/停止/重启与采集失败回归；反证须能检出弱化边界，受控资源执行，不运行弱化用户项目。预计偏紧：可按 P 编号组（边界类 P09/P10/P13、停止类 P18–P23）拆分证据。验收 P09/P10/P13/P18/P19/P20/P21/P22/P23。
- [ ] 6.3（1.5h）真实 Electron 宽窗/约800 CSS px/200%/键盘验证核对、停止、日志、比较、导出和返回；记录版本/尺寸/焦点。验收 D01—D12，静态/组件测试不替代。
- [ ] 6.4（2h）全仓 build/typecheck/逐包 tests/全仓 lint/spec、change strict、git diff --check；核对实际文件数/用例数/Errors，旧登记/槽/白名单/reader/MCP1 回归。验收全部，失败先修，不以 scoped lint 代替全仓。
- [ ] 6.5（1.5h）写安装/许可/环境准备/验证/停止/日志缺项/代码导出/已知限制指南；明确 Linux/Windows 差别和模板范围，核对后端第三方清单。验收 P01/P03/P04/P25/P26/D01/D10。
- [ ] 6.6（1.5h）逐场景回填 evidence-index、主 spec 合并前后差集核对既有零丢失，同步项目状态/路线/入口后归档；后端未通过或功能缺口未闭合不得标完成。归档不等于打包/发布。验收全部。

## 7. I 真实项目任务（I＝路线 §3.2 真实项目接入；单列验收，不用模板代替）

- [ ] 7.1（1.5h）选择一个实际维护项目的失败任务，记录来源/许可/现有排查过程，检查能否满足 node-ts-v1；不适配时先提出独立 profile/change，不能静默放开任意项目。验收 P26。
- [ ] 7.2（2h）在已明确支持范围内，跑一次真实失败/已记录修复/固定检查/导出，回填成功、失败或不支持及失真清单。验收 P24/P25/P26/W03。

第 7 组不要求为了工程首版扩展第二套技术栈；若需独立适配，写清后续 change 去向，R3 只可声明已验收模板范围。尚未完成真实任务，不主张已有项目支持或效率改善。
