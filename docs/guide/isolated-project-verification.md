# 项目验证使用指南（R3 当前实现）

> 在**受限容器**里，对某个隔离检查点的历史源码跑固定类型检查/可信测试，保存可回查的记录与日志；
> 两条验证可并排比较条件与结局，并把「所测输入」按 R2.1 导出。
>
> 本文对应 `add-isolated-project-verification` 的当前实现（**自 `v0.7.0-rc.2` 起进入发行 zip；Release 上传由维护者执行**）。
> 证据边界：真实 Docker 双验证与导出已实测（2026-10-25）；**Electron 实机视觉/键盘/窄窗走查尚未完成**，
> 相关结论不能引用本文代替实机验收。

## 1. 边界：先说不能做什么

- **只支持 Windows x64 + Docker Desktop（Linux containers）**。远程 Docker（TCP/SSH）、WSL 里的引擎、
  Podman 或宿主 Shell 都不被接受；后端缺失/不可达时验证不可用，**不会自动改用宿主命令**。
- **只支持 `node-ts-v1` 模板**：受测源码只允许 `src/**/*.ts`；`package.json`/`tsconfig.json` 由受信环境提供，
  不读项目自己的 `npm scripts`/依赖目录/生命周期脚本。命令只有 `typecheck` 与 `test` 两个枚举，
  不接受自定义命令、参数、路径、环境变量、镜像或限额。
- 测试来自镜像内 `/opt/r3/tests`（当前冻结为 `add(2,3)=5`、`mul(2,3)=6` 两个断言），
  不是项目自带测试；换模板属于新 profile/新 change，不在这里静默放开。
- **验证不会自动发起模型修复**。修复必须来自已记录的运行分支（R2.1 result 编辑 / R2.2 实验），
  人工改文件若没有记录，不会被描述成 Agent 修复。
- 数据只在本机：验证只读历史 trace/blob 与容器输出，不上传源码/日志/凭据；正式测试断网。

## 2. 前置条件

1. Windows 10/11 x64。
2. Docker Desktop（Linux containers）已安装并可运行。应用**不安装**引擎，只使用用户级安装里的
   `docker.exe` 与 `desktop-linux` named pipe；不使用 `DOCKER_HOST` 或当前 Shell 的 PATH 猜测。
3. 首次使用需要能访问以下来源（仅准备阶段联网）：
   - 基础镜像 `docker.m.daocloud.io/library/node:22-alpine@sha256:fe4f6d74…`；
   - npm 官方源拉取 `typescript@5.9.3`（固定锁文件 integrity 校验）。
   正式测试阶段网络为 `none`。
4. 磁盘/内存：准备镜像本地占用约 0.5 GiB；单次验证容器限额为 1 CPU、512 MiB 内存、
   64 PIDs、`/work` 160 MiB tmpfs、`/tmp` 32 MiB、单命令 120 s、整次 180 s。

当前实机读数（2026-10-25）：Docker Desktop **29.9.2**、API 1.56；引擎版本仅用于诊断，
不进入验证条件；条件以 `profileId + manifestVersion + 计划绑定摘要 + 实际环境身份` 为准。

## 3. 准备环境（与执行分开授权）

入口：文件页 →「项目验证」→ 展开（自动做 capability + 准备计划两个**只读**核对）。

1. 预览会显示：来源 run/检查点/快照/文件数与字节、profile 与工具链、下载来源与体积、网络范围、
   限额与隔离基线。预览**不下载、不建容器、不执行、不写记录**。
2. 用户在「核对环境准备」确认块里显式点确认，再点「开始准备环境」。准备阶段允许按固定来源联网
   下载/构建，禁止生命周期脚本，不在宿主跑 npm；准备记录单独封存（失败不算测试失败）。
3. 准备成功后 capability 会显示已准备环境；再进入「核对固定检查执行」确认块。两份确认互不替代：
   已经有环境 ≠ 允许执行本次测试；计划/命令/目标变化后旧确认失效，需要重新核对。

## 4. 执行一次验证

- 检查点由入口显式绑定：初始检查点，或该 run 的**自有完成步骤**；切换检查点会收起面板并整组复位，
  不会静默换成「最近步骤」。
- 命令二选一：`typecheck`（只编译）或 `test`（先编译，再运行可信测试；要求 TAP 的
  `# tests` 与预期数**精确相等**，零测试/超计数/垃圾输出都不通过）。
- 一次确认只执行一次，不自动重试；重复提交同一 operationId 只关联原操作。
- 结局分层：
  - **请求收尾**：登记里的 running/settled/requestOutcome；
  - **测试结局**：`passed` / `check_failed` / `environment_failed` / `start_failed` /
    `process_failed` / `timed_out` / `output_limit` / `cancelled` / `artifact_invalid` /
    `evidence_incomplete` / `unknown`；
  - **证据完整性**：`evidenceComplete=false` 不能显示成完整通过（例如输出被截断、采集缺项）。
  - 退出码 0 不等于通过：还要有可信测试报告且计数精确匹配；Agent 文本不参与判定。

## 5. 停止与未知

- 执行在飞时面板提供「请求停止」；请求只表示 **stopping**，确认容器内全部工作负载/后代停止且
  `/work` 不再变化后才落 `cancelled`。停止成功不显示成「已结束」。
- 准备阶段（镜像构建）**没有定向停止通道**，面板如实说明不可中断。
- daemon 断开、停止响应丢失或残留清理无法确认 ⇒ `unknown` 并保持阻断；只允许核对与再次定向停止，
  不删除陌生资源、不伪造清理成功。
- 重复停止是幂等的；迟到停止不会作用于下一个任务。

## 6. 记录、日志与损坏

- 每条验证有独立 JSONL 记录（`verifications/<verificationId>.jsonl`），只追加、终止即封存；
  run 的 trace 与旧记录不会被改写。
- 记录头包含：来源 run/检查点/快照、profile/manifest 版本、命令、计划绑定摘要、
  **实际环境身份**（preparationId、实际镜像 digest、平台、工具链、限额、隔离基线）。
- 日志按流有界读取：默认 32 KiB/页、上限 64 KiB/页，显示 `totalBytes`、`nextOffset`、`remaining`、
  `truncated`；**有界切片不是完整日志**。超出保留预算的部分只计全观测字节，不写盘。
- 记录/日志状态如实呈现：未封存不显示结局；坏尾显示行号/原因；未知版本拒绝；附件缺失/损坏给稳定码，
  不自动补写，也不用测试副本/源目录补齐。
- 来源 run 后来被删除时标注「来源已缺失」，记录与自身附件仍可按哈希校验读取；不猜同名来源。

## 7. 比较两条验证

- A/B 必须由用户**显式选择**本会话登记附件里的验证身份（可跨 run）；不从时间、日志或记录列表猜身份。
- 并排显示：来源 run/检查点/快照、记录的分叉干预、命令/argv/cwd、profile/manifest/计划绑定摘要、
  实际镜像/运行时/限额/隔离基线、结局/证据完整性/退出码/耗时、日志保留与全观测字节。
- 只有**全部已记录条件一致、两侧证据完整、左侧 `check_failed`、右侧 `passed`** 才显示
  「同条件失败→通过」；措辞只声明该固定检查的实际结果，不宣布完整正确或因果。
- 条件不同 ⇒ 列出不同项；字段缺失 ⇒ 标记未知；两者都**不**合成同条件失败→通过。
- Agent 文本不进入条件与结论；「在运行比较中查看代码差异」进入既有运行比较（显式两条，不改全局对照集合）。

## 8. 导出所测输入（R2.1）

- 在验证记录阅读区点「选择空目录并导出精确输入」：请求只带可信 `verificationId`，main 从记录解析
  run/检查点/快照，在原生对话框前后各重核一次；包层在**写入前**再次比对快照 ID，不一致即阻断。
- 目标必须由系统目录对话框选择且为空目录；导出布局为 `files/<逻辑路径>` + 根部
  `rebaseagent-export.json`（必要时 `changes.patch`）。
- 回查：成功反馈显示「验证快照 = 导出快照（写入前已绑定）」；打开目标根的
  `rebaseagent-export.json`，核对 `source.run_id`、`source.snapshot_id` 与 `files[].sha256`
  是否等于验证记录与所测源码。
- **导出的是所测输入代码快照**：不含日志、材料包或测试产物，不应用补丁，也不代表测试通过。
- 记录来源缺失、记录被移除、来源 trace 缺失、快照漂移会分别以稳定码阻断（见 §10）；
  切检查点/比较侧或离开页面不会改变已发起的绑定，反馈按验证身份保留（重载后丢失＝结果未知，
  以目标清单为准，不自动重发）。

## 9. 已知限制

- **模板范围**：只有 `node-ts-v1` 固定模板（Node 22.23.4 / npm 10.9.9 / TypeScript 5.9.3；
  两个信任断言）。真实项目、自定义依赖/测试/命令/配置都不支持，需另立 profile/change。
- **镜像来源**：基础镜像经 DaoCloud 源按 digest 拉取；与 Docker Hub 官方源的一致性核对未完成
  （backend-verification.md §1.2 未闭合项）。环境镜像由准备阶段构建，身份以实际 digest 与镜像内
  哈希复核为准。
- **平台**：仅 Windows x64；不支持 Linux/macOS 宿主、远程引擎或 WSL 内引擎。容器平台固定
  `linux/amd64`。
- **比较候选**只来自当前 main 会话的操作登记；重载后旧登记不恢复，因此不能从历史列表猜一个身份来比较。
- **视觉/键盘**：当前结论来自组件静态测试与真实后端；宽窗/约 800 CSS px/200%/真实键盘与原生目录
  对话框的实机取证尚未完成（6.3），不要把本文当视觉验收。
- **真实模型**：6.1 的双验证使用确定性隔离 run（手写 trace）作为已知失败与已记录修复分支，
  不是真实 LLM 产物；真实模型任务需单独授权后另跑，且不得挑选成功样本冒充首轮。

## 10. 故障排查（稳定码）

| 现象/码 | 含义与处理 |
|---|---|
| `R3_NOT_CONFIGURED` / `BACKEND_MISSING` | 未发现可信 Docker CLI 或管道不可达；启动 Docker Desktop，确认 Linux containers |
| `R3_PREPARE_MISSING` | 尚未准备环境或准备记录不可用；先完成准备 |
| `R3_PREPARE_PLAN_STALE` / `R3_RUN_PLAN_STALE` | 计划/策略/配方已变化；重新核对并确认当前计划 |
| `R3_RUN_SOURCE_*` / `R3_RUN_*` | 来源预检/门内拒绝；按原因修来源或重新选择检查点 |
| `output_limit` / `evidence_incomplete` | 输出超限或证据缺项；不是通过，检查日志缺项与限额 |
| `R3_LOG_ASSET_MISSING` / `R3_LOG_ASSET_CORRUPT` | 日志附件缺失/损坏；不补写，重读或按缺项处理 |
| `VERIFICATION_EXPORT_SOURCE_INVALID` | 验证记录缺失/损坏/未封存；先在阅读区确认记录状态 |
| `VERIFICATION_EXPORT_SOURCE_MISSING` | 来源 run 的 trace 已缺失；导出被阻断，不猜同名来源 |
| `VERIFICATION_EXPORT_SNAPSHOT_DRIFT` | 定位快照与验证记录绑定值不一致；不导出其他检查点 |
| `attachment_unavailable` / `target_invalid` | 导出附件缺失/损坏或目标非空/非法；换空目录、修来源后重试 |
| `R3_STOP_*` | 停止目标非法/旧 epoch/未登记；先核对登记，不对任意资源发停止 |

Docker Desktop 本身的许可、更新与资源设置由其自己的条款管理，与应用许可无关。

## 11. 第三方组件与许可（当前受信镜像）

准备阶段构建的环境镜像基于 `node:22-alpine`（digest 见上），镜像内**顶层**组件：

| 组件 | 版本 | 许可 | 说明 |
|---|---|---|---|
| Node.js | 22.23.4 | MIT | Alpine 官方镜像自带 |
| npm | 10.9.9 | Artistic-2.0 | 同上 |
| TypeScript | 5.9.3 | Apache-2.0 | 由入库固定锁文件安装（`integrity` 校验） |
| Alpine 基础包（19 个） | — | 见上游 | `alpine-baselayout`、`apk-tools`、`busybox`、`ca-certificates-bundle`、`libcrypto3`、`libssl3`、`musl`、`zlib` 等；逐包许可随 Alpine 上游，未逐项汇总 |
| 受信 runner/测试/supervisor | 本仓冻结 | MIT | `runner.mjs`、`tests/smoke.test.mjs`、`supervisor.sh`、`stop-workloads.sh` 哈希冻结并随准备复核 |

未做：Alpine 基础包的**逐包**许可清单汇总、基础镜像与 Docker Hub 官方源的逐字节一致性核对。
这两项属于发布前法务/供应链核对，不应被本指南的工程范围掩盖。

## 12. 已实测证据（摘要）

- 2026-10-25：Docker Desktop 29.9.2；**v4 受信环境**（manifestVersion 4）真实准备构建镜像
  `sha256:fd809329…`；受控模板 `src/calc.ts` 已知失败（`mul` 误写 `a-b`）⇒
  `check_failed` exit 1，记录分叉修复（`fork.edit.field=result`）⇒ `passed` exit 0；
  两条独立封存记录、TAP `not ok 2` 可回查；比较条件逐项一致、快照不同；
  （v3 首轮另测）`traces/` 与 `workspace-blobs/` 全根指纹不变；两条验证输入经 main 导出，
  清单快照与源码哈希一致。
- 2026-10-25 安全子集（v4）：容器内写宿主/相对穿越 ⇒ EROFS，docker.sock/网络/宿主凭据不可达，
  uid 1000；Buffer 越过 512 MiB ⇒ `process_failed` exit 137/SIGKILL；2 MiB 测试输出 ⇒
  保留 1,048,576 B / 全观测 2,097,581 B / `evidence_incomplete`；孤儿写者被定向停止
  （stoppedPidCount=2、quiescence 2,584 ms、零残留容器）。v4 同时修复了 v3 的两个真实缺陷：
  runner 的 1 MiB 缓冲会把长输出误判为断言失败；supervisor 的 sleep 子进程会让停止确认随机 unknown。
  未重跑：P18 持续写者在采集期不停、P21 断连 unknown、P22/P23 崩溃重启/无法确认清理。
- 失真清单：双验证使用确定性 fixture（非真实模型/R2.1 UI 产生）；导出目录选择为测试桩；
  UI 视觉/键盘/原生对话框未做实机取证（6.3）。
- 原始报告与日志：`.workbuddy/r3-61b/report.json`、`.workbuddy/r3-62/report.json` 及对应 `-probe.log`
  （本地临时证据，不入库）；门禁读数：`.workbuddy/r3-64/`。
