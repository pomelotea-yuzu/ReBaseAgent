# R3 设计：单环境真实项目验证

## D1. 基线、后端和开放门槛

核对基线：2026-10-24，`52c8a6a`（较 `3d207eb` 仅并入 add-mcp-to-release-zip 归档的一条 desktop-distribution requirement，与本 change 三个 capability 无交集）。已读 replay 的工作区读取/配额/导入/导出、desktop operation registry、shared operations/channels 及主规格。现有文件世界不是进程沙箱。`locateWorkspaceSnapshot` 省略步骤取初始，与桌面“最近完成步骤”默认不同；新接口必须显式选择。

本轮 `Get-Command docker,podman` 未命中，只能说明当前 PATH 未发现命令，不能推断未安装或不支持。首选 Windows x64 的本机 Docker Desktop Linux containers，未验证。阶段 1 新建 `backend-verification.md`，记录安装/许可、Windows/虚拟化/引擎/CLI 版本、本地 endpoint、image digest、资源占用和边界探针。Podman、远程引擎、Windows Sandbox 不进入首版自动切换。

全部门槛通过才开放：

1. 实际 endpoint 为已核实的本机引擎，拒绝远程 TCP/SSH context 和未经校验的环境覆盖；CLI 用可信绝对路径、`shell:false`，不能由项目/renderer 提供。
2. Linux 平台、固定 image digest、非 root、只读 rootfs、cap-drop ALL、no-new-privileges；没有特权、宿主 namespace/设备、daemon socket 或宿主 bind mount；测试网络 none。
3. 越界访问、网络、CPU/内存/PID/磁盘/日志/时间限制实际生效；参数存在不代表验证通过。
4. 命令退出后能停止全部后代并确认没有继续写入，取消/超时/main 崩溃后的残留可核查清理。

失败先修订设计，保持未开放，不用宿主 Shell 替代。普通 R1/R2 不要求安装后端。

## D2. 固定 profile、准备和同条件比较

`node-ts-v1` 是入库的版本化 manifest：受支持源码 `src/**/*.ts`、固定 package/锁文件/tsconfig、只读环境内的可信测试/runner/编译器。Node 22、TypeScript 5 系列为候选，准确版本、基础镜像 digest、lock integrity、测试与 runner 哈希在 1.3 实测冻结；不使用 latest。

只有 manifest 明列源码/说明路径允许变化；额外入口、自定义配置、依赖目录、链接或生命周期脚本拒绝。测试来自固定环境 `/opt/r3`，不读取 Agent 可改的测试和 npm scripts。命令仅为 `typecheck`、`test` 枚举；main 将其映射为固定 executable/argv/cwd。test 先编译，再执行可信 Node 测试；检查预期测试数和报告，退出 0 但零测试不能通过。不改 `file-tools-v1`，不增加模型 Shell 工具。

环境准备是独立主动操作 `verificationPrepare`，单独预览下载来源/体积、网络、许可和脚本策略并确认。依赖构建在同一受限后端内，用固定锁文件和完整性校验、禁 lifecycle scripts，不在宿主跑 npm。仅准备阶段允许已说明的下载网络，不传用户凭据。准备记录 image digest、环境清单及成败；预检不得隐式 pull/build，正式测试无网络。

比较条件指纹包含 profile/version、可信测试/runner 哈希、依赖锁、实际 image digest、OS/arch、实际 Node/TS 版本、命令/参数/cwd、公开环境配置和限额；代码 snapshotId 独立比较。宿主/引擎版本也记录，变化明确提示。缺字段为未知，不仅靠标签或命令名字认同条件。

## D3. 包边界、接口和授权

新增 `@rebaseagent/project-verification`，纯 schema 子路径供 shared，Node/main 使用记录 I/O 和执行器；只读记录模块不导入执行器，便于以后 MCP2 复用。mock 后端仅覆盖编排，不能代替真实门槛。

| IPC | 输入与职责 | 副作用 |
|---|---|---|
| `verification:capability` | 显式 runId、checkpoint 初始/自有 step、profileId、commandId；检查快照/附件、已准备环境和引擎健康 | 只读，可有限 inspect/version；不下载、建容器、写记录/附件、占槽 |
| `verification:preparePlan` | 读取固定准备计划和前提 | 只读，不安装 |
| `verification:prepare` | execution envelope、当前准备计划指纹、allowPrepare:true | 登记占槽，准备并写准备记录 |
| `verification:run` | execution envelope、精确 selector/profile/command、planToken、allowExecution:true | 登记占槽，复核后执行一次 |
| `verification:list/get/readLog` | 有效 runId/verificationId、日志流、范围 | 有界只读，不补写/重跑 |
| `verification:stop` | 当前 epoch/operationId 与可信 verificationId；准备阶段按可信 preparationId | 只停止本 R3 owner，不占第二槽，不接任意 PID/container ID |

selector 为 `{runId,checkpoint:{kind:"initial"}|{kind:"step",stepSpanId}}`，UI 不得无声换点。main 内 planToken 短期绑定 trace/快照/附件摘要、profile、command、环境、限额和策略版本；它防漂移，不替代当前授权。提交重核，变更要求重新核对。未接受/预检拒绝零记录、零容器、零项目/模型执行；已接受后失败保留真实身份和诊断。

renderer 不能输入命令、物理路径、环境变量、镜像/endpoint、挂载、限额或测试正文。main 受控构造 CLI argv/env，不继承 API key、代理、Docker endpoint 覆盖或项目 env 文件；capability 的引擎健康仅使用枚举的只读 docker 子命令（version/info 类），由 schema 白名单断言，不透传任意参数。执行/status/stop 经 schema、sender/frame、epoch 校验。日志为不可信文本，不执行其中指令或 HTML。

## D4. 验证事实源、身份和兼容

验证不是 Agent run/fork，没有新消息、spans 或 LLM 消耗，不升级 trace。独立 schema version=1，未知版本拒绝：

```text
verifications/<verificationId>.jsonl
verification-assets/sha256/<hash>
verification-environments/<preparationId>.jsonl
verification-runtime/<resourceOwnerId>.json
```

每次验证 JSONL 只追加，终止后封存。事件含 meta、阶段、command start/end、日志引用/截断、停止确认、产物清单与唯一终止。meta 记录 verificationId、原 epoch/operationId、精确 run/step/snapshot、profile/环境/command 和计划摘要；旧 run 不追加索引，不改 JSONL/blob。日志/产物内容寻址，保存长度/哈希/流偏移，排他发布且不得覆盖。准备记录与验证记录分开。

恢复日志是允许原子替换的有界资源登记，不是结果事实源，不是持久操作 registry：仅存资源名、安装实例/数据根归属、owner 标签、已知 container ID 和阶段，不存授权/正文/凭据。**创建资源之前**先持久化确定性唯一名称及 owner 标签，create 后再绑定返回 ID，覆盖响应丢失窗口。准备资源同样登记。无法核实归属不得停止陌生容器。

读取逐行验证版本/事件顺序/身份/引用；坏尾、未终止、缺失/损坏附件有明确状态，不能 passed。每次读固定时点，不以活跃 registry 猜历史结局。日志默认 32 KiB、上限 64 KiB/请求，返回 nextOffset/remaining/truncated；原始字节附件与安全文本视图分开。数据路径相对，可迁移后只读；旧运行列表/MCP1 只扫 traces，不计入验证。删除来源后显示 source_missing，不把记录指向同名其他运行；产物/日志读取仍可按其自身引用校验。

## D5. 物化、资源限额和产物

1. 只接受已封存、来源完整、合法 v2/v3 隔离 run 的自有初始/完成 step，并验证 file-tools-v1 与模板相容。普通/proxy 无快照拒绝。
2. 复核全部路径、快照哈希及附件字节，沿用 R1 配额：2000 文件、单文件 8 MiB、快照 64 MiB、路径 512/深度 32。历史缺项不从源目录补齐。
3. 无宿主目录挂载；按清单将已校验字节流写入新容器 `/work`。拒绝 archive 额外条目、链接/特殊对象、穿越/名称碰撞；不直接解压项目提供的 tar。可信依赖/测试在 `/opt/r3` 只读；禁容器自动重启，禁 daemon 日志驱动持久保存项目输出，输出只经有界执行通道采集。准确非 root 物化和静止采集方法须通过阶段 1，未通过保持关闭。
4. 候选固定限额：1 CPU、512 MiB 内存且不额外 swap、64 PIDs、/work tmpfs 160 MiB、/tmp 32 MiB；单命令 120 秒、整次 180 秒。stdout/stderr 各保存前 1 MiB，之后持续读取丢弃并计数；总观测 16 MiB 触发 output_limit。阶段 1 实测冻结；限额变化更新 profile/指纹。
5. 受控 supervisor 管理项目工作负载，命令退出后停止所有项目进程和后代、确认不再写入，再采集副本。正常采集期间仅可信 supervisor 存活以保留 tmpfs；不能先 stop/remove 容器后假称 tmpfs 仍可采集。强制停止整个容器可能丢失临时输出，须记录产物缺失，不能伪造。采集后移除本次容器；daemon/项目停止状态不明时不发布可用产物。
6. 静止采集两次清单/哈希一致；只收 profile 允许的普通输出如 out/**，显式排除 node_modules/缓存/临时目录。扫描范围外新增对象并拒绝链接/特殊对象，不静默跟随。源集合/字节、固定配置/测试不得变化；否则 artifact_invalid，不能把测试改代码当成修复。产物配额沿用 R1，并限制新增唯一内容 128 MiB。
7. 产物只属于 verification，不成为 Agent checkpoint。R2.1 导出该验证的输入 run/step/snapshot，导出前重核身份和附件，核对所测源码哈希；不把测试副本作为所测代码。

## D6. 操作登记、停止和重启

新类型 verificationPrepare/verification 进入现有唯一 OperationRegistry。扩展受限摘要 preparationIds/verificationIds，由实际记录创建回调关联，不能放入 runIds；后者仍只指本操作创建的 Agent run，此处为空，目标 run 放 target。保留一次 parse 不可变快照、先查重后授权/副作用、旧 epoch 拒绝、reconcile 封禁、未知先核对与 owner 释放规则。

| 执行事实 | 验证结局 | 槽/呈现 |
|---|---|---|
| 未接受/预检拒绝 | 无测试结论 | 零项目执行 |
| 准备/物化/执行/停止中 | 实际阶段 | running 占唯一槽 |
| tsc 非零或可信测试断言失败 | check_failed（区分阶段/退出码） | 停止并收尾后 settled |
| 检查通过且源码/报告/日志/产物完整 | passed | 停止并收尾后 settled |
| 准备/启动失败、OOM或进程异常 | environment_failed/start_failed/process_failed | 不算项目断言失败 |
| 超时、输出限额、用户停止 | timed_out/output_limit/cancelled | 必须先确认全部停止 |
| 采集拒绝/输入被修改 | artifact_invalid | 无可用输出清单 |
| 截断/缺少必要日志或报告 | evidence_incomplete（保留真实 exit） | 不能绿色通过 |
| daemon断开/停止未确认 | unknown 或未终止 | 当前槽不释放，只允许核对/再次停止 |

stop 仅控制当前 owner，重复幂等，不新建执行；迟到请求不能停止下一任务。stop 请求只表示 stopping，确认全部停止才 cancelled；exit 0 不能覆盖更早取消/超时/OOM。正常关闭先走关闭协商并停止 R3，不因 renderer 离开而释放。记录 UTC 起止与单调实际耗时。

启动配置互斥区执行残留核查，不与新主动接受并发；新 main 使用新 epoch，不恢复旧 registry，不继续执行。按确定名称/可信标签停止旧准备/测试资源，向未封存领域记录追加 interrupted 与清理事实；保留已有日志，不伪造已完成/已取消。daemon 不可达、归属不明或记录不可写则 R3 保持 blocked，普通只读和原 R1/R2 按原门禁可用。读记录本身不能触发核查写盘。

## D7. 修复闭环和范围

用户明确选原验证和修复验证，显示输入身份、已有干预证据、测试/环境/命令条件、真实结局、日志及代码差异；条件不同醒目标注，不形成同条件失败→通过。Agent 文本、退出码、可信断言、用户判断分别呈现。

修复继续使用已交付 result 编辑或 R2.2 单项 prompt 实验，独立授权/计费，记录真实分支；不由 R3 自动发起。不把 result 编辑说成撤销同轮写入或参数重做，不将未记录人工改文件描述为 Agent 修复。R3-E2 材料包、E3 回归管理后续独立，不阻塞首条路径或 MCP2。

实施顺序和证据见 tasks/evidence-index。阶段 1 尚待确定准确版本/digest、可信模板、非 root 物化/静止采集、停止/重启及限额效果；mock 或文档校验不能销账。任何契约变化先修提案。主 spec 在提案阶段不改，MODIFIED 条目完整保留旧场景。
