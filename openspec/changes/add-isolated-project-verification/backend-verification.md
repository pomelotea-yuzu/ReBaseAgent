# R3 阶段 1：Windows 后端技术验证记录

> 本文件是 tasks 1.1–1.6 的探针事实源与销账依据：任一门槛未通过即冻结第 2–6 组并先修提案（tasks.md 状态段）。
> 3.1 起的产品化后端事实也记于本文件（§3.1 起）：探针轮读数冻结候选，产品化落地后以实测覆盖。
> 探测机为真实本机（非沙箱模拟）。系统实测（2026-10-24，powershell `Get-CimInstance` / `wsl --version` / `wsl -l -v`）：
> Windows 11 专业版 build 26200（内核 26200.9445）；16 逻辑核；15.9 GB RAM；C: 可用 149.7 GB；
> WSL 3.0.1.0（内核 6.18.401.1-1，WSLg 1.0.79），发行版仅 Ubuntu（Stopped，VERSION 2）。

## 1.1 后端在机状态、endpoint、安装/许可与资源前提（2026-10-24）

### 结论：首选后端（Docker Desktop Linux containers）未安装——P01「后端缺失」成立，R3 保持未开放

六路独立探测，同日同机会话实测：

| # | 探测 | 命令/位置 | 结果 |
|---|---|---|---|
| 1 | PATH | `where docker podman`（cmd） | 均未命中（与 design D1 提案时点 `Get-Command` 未命中一致） |
| 2 | 程序目录 | `C:\Program Files\Docker` | 不存在 |
| 3 | 服务 | `Get-Service *docker*` | 无任何 Docker 服务 |
| 4 | 注册表卸载项 | HKLM Uninstall / WOW6432Node / HKCU 三处 | 均无 Docker 条目 |
| 5 | WSL 发行版 | `wsl -l -v` | 仅 Ubuntu；无 docker-desktop（引擎发行版不存在） |
| 6 | named pipe | `[IO.Directory]::GetFiles("\\.\pipe\")` 枚举 | 532 个管道中 0 个含 docker |

`DOCKER_HOST` 环境变量未设置（空）。判定：非 PATH 问题，确未安装。

### 历史安装残留（仅作历史证据，不构成可用后端）

- `%LOCALAPPDATA%\Docker\install-log*.txt`：2025-01-07 运行过 Docker Desktop **4.37.1 (178610)**
  安装器（来源 `Downloads\Docker_Desktop_Installer.exe`），日志止于「Not run as admin, relaunching
  with UAC prompt」，未见安装完成记录。
- `~\.docker\`（buildx / cli-plugins / contexts / desktop-build / scout）、`%APPDATA%\Docker\`、
  `%LOCALAPPDATA%\Docker\{run,tasks,wsl}`（2025-02 / 2025-09 最后修改）为旧安装残件；
  `~\.docker\contexts` 内仅存 `desktop-linux` context 定义（npipe `dockerDesktopLinuxEngine`），
  对应管道实测不存在（上表第 6 路）。

残留只证明「曾经装过/试装过」，不改变「当前无引擎、无 CLI」的判定；正式接入一律以安装后实测为准，
不回读本节残留作依据。

### 实际 endpoint 与远程拒绝口径

- **当前实际 endpoint：不存在（后端缺失）。**
- 安装后预期形态（待 1.2 实测覆盖，不预称）：Docker Desktop（WSL2 backend、Linux containers 模式）
  的本机 named pipe（残留 context 佐证为 `dockerDesktopLinuxEngine` 一类；以安装后
  `docker context inspect` / `docker version` 实测为准）。
- 硬规则（本节落库，实施于 3.2/4.3）：仅认已核实的本机引擎实际 endpoint；拒绝 TCP/SSH/远程
  context 与未经校验的 `DOCKER_HOST`/环境覆盖（P02）；未安装/未验收 ⇒ 明确不可用并给出具体原因，
  不隐式安装、不回退宿主 Shell（P01）；R1/R2 原便携用法不依赖本后端。

### 安装与许可前提（用户动作；proposal 明文：用户自行安装，不进 portable exe 与发行 zip）

- 官方渠道：https://www.docker.com/products/docker-desktop/ （安装器；winget 等以官方页面为准）。
- 许可口径（来源 docs.docker.com/subscription/desktop-license，页面标注 last updated 2026-07-02，
  2026-10-24 抓取）：Docker Desktop 按 Docker Subscription Service Agreement 授权，安装时需
  用户本人同意；**免费范围**＝个人使用、教育、非商业开源项目、小企业（员工 **<250 人且年收入
  <$10M**）；较大组织的专业使用、政府实体、超出免费额度的商业使用需付费订阅（Pro/Team/Business）。
  ReBaseAgent 场景（个人维护开源项目、本机个人使用）落在免费范围；该归纳不替代用户安装时的
  自行核对与同意。Docker Desktop 分发部分 GPL 开源组件（应用内 About > Acknowledgements），
  随 1.3/6.5 的第三方许可清单一并记录。
- 系统需求：本机已实测具备 WSL2 与虚拟化（Ubuntu 发行版可运行佐证）；官方最低 Windows 版本/
  内存/磁盘具体门槛本轮网络抓取未成功，**不作门槛依据**（未验证假设；可证伪：浏览器打开官方
  安装页比对），安装前由用户按官方页面确认。

### 资源前提（本机实测部分；候选限额在 1.4 实测冻结）

- 磁盘：C: 可用 149.7 GB ⇒ 充足（程序 + WSL 数据 vhdx 随镜像/容器增长；准确占用 1.4 实测）。
- 内存：15.9 GB；WSL2 VM 上限默认宿主 50%（`.wslconfig` 可限）。R3 容器候选限额
  （1 CPU / 512 MiB / 64 PID / tmpfs 160+32 MiB，design D5）在 1.4 实测冻结。
- 网络：仅「环境准备」阶段联网（拉取基础镜像与依赖，design D2）；正式测试断网。

### 状态与下一步

- **1.1 完成**（缺失态记录，后被安装事件覆盖：用户 2026-10-24 完成用户级安装并跳过登录，见 §1.2）。
- 1.2 已执行（§1.2）；1.3 已执行（§1.3）；1.4 已执行（§1.4）；1.5 已执行（§1.5）；1.6 已执行（§1.6）——**阶段 1 收口，四道开放门槛全过（见 §1.6 总结论），第 2–6 组解冻**。

## 1.2 安装落位与受限容器边界探针（2026-10-24，验收 P09 的 1.2 切片）

### 安装落位（覆盖 §1.1「未安装」结论）

- **用户级安装**：`C:\Users\28145\AppData\Local\Programs\DockerDesktop\`（非 `Program Files`、无系统
  服务、无 HKLM 卸载项 ⇒ §1.1 的 #2/#3/#4 三路探测对用户级安装不敏感；可靠信号 = bin 目录 CLI、
  docker-desktop WSL 发行版、docker named pipe——探测面据此修正）。
- 版本/身份实测：client 29.9.2 (windows/amd64)、**Docker Desktop 4.96.3 (244472)**、engine 29.9.2
  **linux/amd64**（OSType=linux，Linux containers 模式 ✓）、containerd v2.4.2、runc 1.5.2、
  kernel 6.18.40.1-microsoft-standard-WSL2、overlayfs、cgroup v2（cgroupfs driver）、VM 内存
  7.68 GB / 16 CPU、**containerd 镜像存储开启**（image Id = manifest digest）。
- endpoint：活跃 context `desktop-linux` = `npipe:////./pipe/dockerDesktopLinuxEngine`
  （SkipTLSVerify:false）；`DOCKER_HOST` 未设置。**远程拒绝必要性实证**：
  `DOCKER_HOST=tcp://127.0.0.1:2375 docker version` 把 CLI 重定向到该 tcp endpoint（连接被拒）
  ⇒ 环境变量确可改实际 endpoint，产品（3.2）必须显式钉死本机管道并拒绝 env/context 覆盖（P02）。
- 凭证面：`~/.docker/config.json`（本次安装生成）`credsStore:"desktop"` ⇒ 任何 pull 都调用 bin
  目录的 `docker-credential-desktop`（不在 PATH 时报错，已实测）⇒ 3.2 受控 CLI 调用需带可信 bin
  PATH 或用独立 config（无 credsStore），不得透传宿主 PATH。

### 镜像拉取通路（阶段 1 环境事实）

- **Docker Hub 直连超时**（宿主 curl `registry-1.docker.io` → http=000 连接超时；引擎侧同）。
  当下无代理客户端在跑、Windows 系统代理关闭。
- **采用 DaoCloud 镜像源显式前缀拉取**（`docker.m.daocloud.io/library/…`）：零 daemon/客户端
  配置改动、零环境覆盖。`alpine:3.22` 拉取成功，manifest digest
  `sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f`。
- 口径：digest 内容寻址 ⇒ 同 digest 同字节；镜像源属「已说明的下载网络」变形，记入准备计划口径
  （design D2 准备阶段允许联网）；跨 registry digest 与官方源一致性在 1.3 冻结基础镜像时核对
  （当前官方源不可达，如实标注为未核对项）。

### 受限容器边界探针（P09 的 1.2 切片；方法 = 同一组探针双跑）

探针组 `.workbuddy/r3-12/battery.sh`（不入库），原始输出 `restricted.txt` / `control.txt` 同目录。
受限侧旗标：`--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges
--network none --memory 512m --memory-swap 512m --pids-limit 64 --cpus 1`；对照侧为默认容器。

| 边界 | 受限容器读数 | 对照容器读数 | 判定 |
|---|---|---|---|
| 非 root | uid=1000 | uid=0(root) | ✅ 生效 |
| capabilities | CapInh/Prm/Eff/Bnd/Amb 全 0；Seccomp=2 | CapEff=a80425fb（非零默认集） | ✅ 生效 |
| no-new-privileges | NoNewPrivs:1 | NoNewPrivs:0 | ✅ 生效 |
| 只读 rootfs | `touch /` → Read-only file system（overlay 挂 ro） | 写成功 | ✅ 生效 |
| mknod | 拒绝（ro fs + 无 CAP_MKNOD 双重） | 成功创建设备节点 | ✅ 生效 |
| 网络 none | 仅 lo、路由表空、ping 报 Network unreachable、nc 失败 | eth0 + 默认路由、ping 223.5.5.5 通（8.77 ms）、nc 成功 | ✅ 生效 |
| /proc/sys 写 | 拒绝（ro） | 同样拒绝 | ⚠️ 非本组旗标增益，属 docker 默认基线 |
| docker socket | 缺席 | 同缺席 | ⚠️ 默认即不挂载；产品保证 = 编排永不挂载 + mounts 审计 |
| 宿主路径挂载 | /proc/mounts 无宿主路径 | 同 | ⚠️ 同上（编排责任，3.2/3.3 落牙） |
| 凭据/env | 仅 HOSTNAME/SHLVL/HOME/PATH/PWD 五项 | 同 | ⚠️ 同上（受控 env 构造） |

诚实归因（判据假门纪律）：

- `su root` 探针**不敏感**（alpine busybox su 非 suid，两侧同败）——nnp 判据以内核字段
  `NoNewPrivs:1` 为准，不用 su 行为。
- 「无宿主挂载 / 无 docker socket / env 无凭据」三项在对照侧同样阴性 ⇒ 不是本组旗标产生的差异，
  而是 docker 默认基线 + 编排「永不添加」的责任（3.2/3.3 以 mounts 审计与受控 env 断言落牙）。
- 结论：**P09 的 1.2 切片（非 root / 只读 rootfs / capabilities / 断网）全部实测通过且带对照组**；
  物化与采集侧的越界覆盖留 3.3 / 6.2。

## 1.3 node-ts-v1 模板冻结与可信环境探针（2026-10-24，验收 P04/P08/P11/P12 的 1.3 切片）

### 冻结读数（探针版；产品化归 2.x/3.x，脚本与原始输出 `.workbuddy/r3-13/` 不入库）

- 基础镜像：`node:22-alpine`（经 DaoCloud 源）manifest digest
  `sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`；**跨 registry 与
  官方源一致性未核对**（Hub 直连超时，如实标注；digest 内容寻址保证同 digest 同字节，官方源
  可达时补核对）。
- 工具链：Node **v22.23.4** / npm 10.9.9 / TypeScript **5.9.3**（**npmjs.org 直连可用**，无需
  镜像源变形；`npm install --ignore-scripts` 实测安装成功）。
- 环境镜像 `r3/node-ts-v1:probe`：ImageId
  `sha256:540409fd33af468376e596812cade3aa963468a986f44419043541bbf8346086`；受信文件 sha256：
  runner.mjs `0edf7c21…d823`、tsconfig.json `a34da16b…91f6`、package.tmpl.json `a5f4e90e…7b0e`、
  tests/smoke.test.mjs `aed08651…1030`、package-lock.json `d41f6694…90c4`（全值见
  `.workbuddy/r3-13/`）。
- 固定 argv（由 runner 冻结，枚举命令 typecheck/test）：
  - typecheck → `/opt/r3/node_modules/.bin/tsc --noEmit -p /work/tsconfig.json`
  - test → 先 `tsc -p /work/tsconfig.json`（编译到 `/work/.build`），
    再 `node --test --test-reporter=tap /opt/r3/tests/*.test.mjs`（cwd=/work，显式文件列表）
  - 模板 tsconfig/package 由 runner 从 /opt/r3 复制落位 /work（探针简化；生产归受控物化 3.3）；
    受支持源码 = `src/**/*.ts`。
- 预期测试数 `EXPECTED_TESTS=2` 与测试同镜像冻结（design D2「检查预期测试数」）。

### 探针结果（受限 profile 同 §1.2 + `--tmpfs /work:size=160m,mode=1777`）

| 探针 | 结果 | 判定 |
|---|---|---|
| 已知失败（mul=a−b） | typecheck 过、test 断言失败（expected 6 / actual −1，栈指向受信测试文件），exit 1 | ✅ P11 切片 |
| 修复（mul=a×b） | `# tests 2 / pass 2`，exit 0 | ✅ P11 切片 |
| `/opt/r3` 追加写入 | DENIED（只读 rootfs） | ✅ 受信测试不可被项目替换（P08） |
| `/work` 恶意测试文件 | 未被执行（tests 仍为 2 而非 3） | ✅ 固定文件列表，不扫描 /work |
| 恶意 package.json（scripts.test=echo PWNED） | 被模板覆盖、PWNED 未出现、npm scripts/install 全程未调用 | ✅ P08 |
| gate 自检（6 例） | 空目录 / 零测试 / 垃圾输出 / 伪测试(1) / 超计数(3) 全拒，精确匹配通过 | ✅ P12 切片 |
| 零测试危害形态实测 | **零用例文件被 node 22.23 计作「1 个通过的模块加载测试」且 exit 0** ⇒ `>0` 门无效，精确匹配门必要 | ✅ 修正后通过 |

### 发现与坑（记录在案）

- node 22.23.4 `--test <目录参数>` 把目录当模块路径加载（MODULE_NOT_FOUND）；目录发现模式
  （cwd）正常。runner 用显式文件列表规避。
- 管道后 `$?` 是 tail/grep 的退出码——量 node 退出码必须无管道或用 PIPESTATUS（本轮自踩两次）。
- Git Bash MSYS 把 `/opt/...` 形态参数改写为 Git 安装路径 ⇒ 容器内绝对路径参数须 `sh -c` 包裹
  （与既有「路径撕裂」坑同源）。
- tsc outDir/include 公共根陷阱：缺 `rootDir` 时产物少一层 `src/`；已显式 `rootDir:"."`。
- 镜像构建内 `npm install` = 「准备阶段联网」的探针体现（design D2）；lock/integrity 冻结在
  package-lock.json 哈希中。
- 诚实备注：runner/gate 为探针版（包层单测与产品化归 2.x/3.x）；生产 EXPECTED_TESTS 由
  manifest 随测试冻结。

## 1.4 资源限额实测（2026-10-24，验收 P10/P13 的 1.4 切片）

候选限额（design D5）逐项实测生效；探针脚本与原始输出 `.workbuddy/r3-14/`（不入库）。

| 限额 | 探针 | 实测读数 | 判定 |
|---|---|---|---|
| 内存 512 MiB 无 swap | node 持续分配 1 MiB Buffer（文件日志） | **NODE_EXIT=137（SIGKILL）**，最后读数 480 MB 处被 cgroup OOM 击杀 | ✅ 限额内终止、原因可识别 |
| PID 64 | 尝试派生 200 个 sleep | spawned_ok=**62** / spawn_fail=138（`can't fork: Resource temporarily unavailable`） | ✅ 精确封顶（64 含容器自身进程） |
| /work tmpfs 160 MiB、/tmp 32 MiB | dd 填充 | /work 精确写满 167,772,160 B 后 ENOSPC（DD_EXIT=1，1.5 GB/s）；/tmp 32 MiB 同样封顶；清理后 0% | ✅ |
| CPU 1 核 | 2 个 busy loop × 5 s + cpu.stat | 限额侧 usage≈5.10 s、nr_periods 50 / **nr_throttled 50**、throttled_usec≈4.93 s；对照（无限额）usage≈10.04 s、nr_throttled 0 | ✅ 配额精确限 1 核（节流不杀进程） |
| 停止时长 | `sleep 300` 容器 `docker stop -t 10` | **10,511 ms 后 SIGKILL（ExitCode 137）**——SIGTERM 被裸 PID 1 忽略 | ⚠️ 发现① |
| 输出体量 | 生成 2048 KiB stdout | `docker logs` 全量返回 **2,099,200 B**（=2048×1025 精确），engine 不设界 | 记录：有界读取是产品责任（3.4，P13） |
| 清理 | `docker ps -a` / `docker system df` | 0 残留容器/卷；镜像 3 个 284.1 MB、build cache 271 MB | ✅ |
| tmpfs×内存相互作用 | 200m 内存 + 190m tmpfs：先填 180 MB 再分配堆 | dd 180 MB 存活（180<200），node 堆分配即刻 **Killed** | ⚠️ 发现② |

### 发现与坑（记录在案）

1. **PID 1 信号陷阱（直接支撑 design D5 supervisor 结构）**：工作负载裸跑 PID 1（无信号处理器）
   时，`docker stop` 的 SIGTERM 被内核丢弃，宽限期满（10 s）才 SIGKILL。干净停止必须由受控
   supervisor 作 PID 1（注册 TERM 处理、转发并等待全部子孙退出），工作负载以子进程身份收 TERM
   正常退出——P19（停止覆盖子孙进程）依赖该结构。
2. **tmpfs 页计入容器内存 cgroup**：180 MB tmpfs + 少量堆分配即在 200 MiB 限额内被 OOM 击杀
   （若无相互作用，node 应能继续分配至 ~200 MB 并留有进度日志）。⇒ 候选口径修正为「**进程 +
   tmpfs 合并预算**」：`--memory 512m` + `/work 160m` + `/tmp 32m` 下进程有效内存 ≈ 300 MiB
   （含 node/tsc 自身）。冻结时要么接受该语义、要么调整数字；限额属 profile/指纹，按 design D5
   更新即可，无需改提案主体。
3. 管道后 `$?` 第四次踩（1.4 内存探针两版：首版 `| tail` 在脚本内、次版 NODE_EXIT 实为 tail 的
   退出码）——证据以「Killed」行 + 137 退出码为准；判退出码一律无管道读取或落文件后 cat。

## 1.5 非 root 物化、静止采集与子孙停止（2026-10-24，验收 P05/P17/P18/P19 的 1.5 切片）

### 探针 M：字节流物化 + workload + 静止采集（容器 `r3-mat`，受限 profile 同 §1.2 + `/work` tmpfs，uid 1000）

- 物化方式：`docker exec -i <ctr> sh -c 'cat > /work/src/calc.ts' < 宿主文件`——逐文件字节流，
  非解压 archive、非宿主挂载（design D5 的物化模型）。
- **字节一致**：容器内 sha256 = 宿主 sha256 = `fcb8adfb…280e`（140 B，owner `1000:1000`，
  mode 644）⇒ P05「物化字节逐项与清单一致」探针级验证 ✅。
- workload（`runner.mjs test`）：RUNNER_EXIT=0（tests 2 / pass 2）。
- **静止采集两次一致**：全树 `find + sha256sum` 双扫（间隔 2 s）diff 为空，共 5 个文件
  （src/calc.ts、tsconfig.json、package.json、.build/src/calc.js、run.log）⇒ P17 ✅。
- **输入稳定性**：workload 后 `/work/src/calc.ts` 哈希不变 ⇒ P18/W01「受测源码不变」✅。
- 产物仅在 /work（编译产物 .build/ + 模板落位 + 日志）；容器移除后 tmpfs 随之消失——
  **采集必须在移除前**（结构性事实，与 design D5「采集后移除本次容器」一致）。

### 探针 O：孤儿子孙进程停止与「不再写入」（容器 `r3-orph`，同 profile）

- 主命令（exec 会话）退出后，其后台 `while` 写者**继续存活并持续追加**（56→60 B 增长）⇒
  「命令退出 ≠ 全部停止」危害实证，design D6「命令退出后停止全部后代并确认」必要性 ✅。
- 按进程杀掉后代后 **2 s 内字节数不变（60→60）**⇒「确认没有继续写入」可判定 ✅（P19 停止
  语义基础）。
- 坑：`pkill -f "orphan.log"` 匹配到探针自身 exec 的 `sh -c` 命令行、把会话一起杀掉（确认行
  丢失；字节数稳定性仍证明写者已死）⇒ **产品不得用模式匹配停止，必须按 PID/pgid 定向停止**
  （与 design D3/D6 owner 定向停止一致，此为探针级反证）。

诚实备注：物化/采集用 docker exec + stdin 流完成（探针级）；产品化物化（清单校验、拒绝矩阵）
归 3.3，停止编排归 3.5。

## 1.6 响应丢失、daemon 断开与残留核查（2026-10-24，验收 P21/P22/P23 的 1.6 切片）

### 探针 A：create 响应丢失窗口（P22）

- `docker create --name r3-p22-demo-7f3a --label rebaseagent.owner=r3probe` 后**丢弃返回 ID**：
  按 label 过滤可精确定位（`--filter label=k=v` 为精确键值匹配）；`--filter name=` 为**子串
  匹配**、不支持锚点正则（`^…$` 形态查不到）⇒ 产品资源定位以 label 为主、名字精确比对兜底
  （3.7 设计输入）。按名 `docker start` / `docker rm` 均成功——**创建前持久化确定名称 + owner
  标签即可覆盖响应丢失窗口**（design D4 模型实证）✅。

### 探针 B：daemon 断开与引擎重启（P21/P22/P23）

- 引擎停止（`docker desktop stop`，实测 **15 s**）后 CLI 错误形态可识别：
  `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine … The
  system cannot find the file specified`（P21「daemon 断开」的可判定信号）✅。
- 引擎重启（`docker desktop start`，实测 **21 s** 就绪）后：**容器记录仍在**（两个测试容器均
  `Exited (137)`——被引擎关闭击杀，属预期），可按名/标签定位并清理 ⇒「main 崩溃 → 重启 → 按
  登记名/owner 找到并停止遗留」路径成立（P22）✅。
- **陌生资源保护**：按 label 的清理只删除带标签容器，未标记的 `someuser-unrelated-app`
  原样存活（探针后手动清走）⇒ P23「不停止陌生资源」✅。
- 重启期间容器状态不可核实（引擎不可达）⇒ 该窗口内结局 = unknown（与 design D6「daemon
  不可达 ⇒ R3 blocked / unknown」一致）。

### 阶段 1 总结论（1.1–1.6）

**四道开放门槛（design D1）全部实测通过，第 2–6 组解冻：**

1. 实际 endpoint 为已核实的本机引擎（desktop-linux npipe）；远程/env 覆盖重定向已实证，产品须
   显式钉死管道并拒绝覆盖 ✅
2. Linux 平台 + 固定 digest + 非 root + 只读 rootfs + cap-drop ALL + nnp + 无宿主挂载/socket +
   测试断网 ✅（带对照组）
3. 越界 / 网络 / CPU / 内存 / PID / 磁盘 / 输出限制实际生效 ✅（带对照组与读数）
4. 命令退出后停止全部后代并确认不再写入；超时 / 引擎重启后残留可核查清理 ✅

修订与未成立假设处置（tasks 1.6 要求）：

- 候选限额语义修正：**tmpfs 计入内存 cgroup**（合并预算：512m + 192m tmpfs ⇒ 进程有效内存
  ≈300 MiB）；冻结时按该语义定数字。
- 「裸命令可被 docker stop 干净停止」**不成立**（裸 PID 1 忽略 SIGTERM，宽限期满才 SIGKILL）
  ⇒ supervisor 结构必要（design D5 已有，实证支撑）。
- 「node --test 零测试会失败」**不成立**（零用例文件计作 1 个通过的伪测试且 exit 0）⇒ 与
  EXPECTED_TESTS 精确匹配门必要。
- 未闭合项（如实）：跨 registry digest 与官方源一致性核对（Docker Hub 直连不可达，待可达时
  补）；探针版 runner/gate 的产品化与包层单测归 2.x/3.x。

## 3.1 受信环境资产产品化构建（2026-10-25，验收 P04/P08 的 3.1 切片；实测机同阶段 1）

### 产品化配方（v2）与探针版差异

探针版（§1.3）依赖安装为镜像内 `npm install typescript@5.9.3`（锁文件**生成后**追认冻结）；
产品化配方改为**入库固定锁文件 + `npm ci --ignore-scripts --no-audit --no-fund`**——锁文件
字节为构建输入、完整性由锁内 integrity 字段校验、生命周期脚本禁用（design D2「固定锁文件
和完整性校验、禁 lifecycle scripts」的本意）。锁文件与 package.json 自探针镜像 `r3/node-ts-v1:probe`
逐字节提取（`docker cp`）：package-lock.json sha256 = `d41f6694…90c4`（= manifest 冻结值），
package.json sha256 = `16db8849…39cb`。基础镜像 FROM 仍按 digest 钉死（DaoCloud 前缀不变）。

### v2 构建实测（构建上下文与原始日志 `.workbuddy/r3-31/`，不入库）

- **构建**：`docker build --platform linux/amd64` 成功；`npm ci` 实跑联网安装
  （`added 1 package in 10s`，npmjs.org 直连，与 §1.3 结论一致）。
- **镜像**：`r3/node-ts-v1:v2` ImageId（manifest list）
  `sha256:f3a8b56dcff1f1c22ebf8eed8f2612f7706f61704c7830959e2181567a91f6bd`，
  本地大小 270,824,228 B。
- **镜像内哈希复核（六文件逐字节 `docker cp` 出比对）**：package-lock.json
  `d41f6694…90c4`、runner.mjs `0edf7c21…d823`、tsconfig.json `a34da16b…91f6`、
  package.tmpl.json `a5f4e90e…7b0e`、tests/smoke.test.mjs `aed08651…1030`、
  package.json `16db8849…39cb`——**前五项与 manifest 冻结值逐项一致**
  ⇒ `NODE_TS_V1_PROFILE` 哈希表不变、`manifestVersion` 维持 1（schema 注记已同步）。
- **受限 profile 功能冒烟**（旗标同 §1.2 全套 + /work 160m、/tmp 32m tmpfs，uid 1000，
  `--network none`，字节流物化无宿主挂载）：tsc 5.9.3；typecheck exit 0；test 2/2 pass
  exit 0；物化文件 sha256 `fcb8adfb…280e` 与 §1.5 探针 M 宿主哈希一致。
- **诚实备注**：tsc --version / 测试执行经 runner 依赖镜像内 /opt/r3——v2 镜像与探针镜像
  功能等价；supervisor/物化/停止编排在 3.3–3.7 落牙，本节不预称。

### 计划口径实测数字（buildPreparePlan 冻结常数的测量方式）

- 基础镜像压缩传输体积：`docker manifest inspect` amd64 子清单 layers size 求和 =
  **61,337,515 B**。
- typescript@5.9.3 tarball：registry.npmjs.org Range 请求 Content-Range 总长 =
  **4,377,468 B**（npmjs 直连可用）。
- 磁盘占用估计（本地解压口径）：基础镜像 239,050,910 B + v2 环境镜像 270,824,228 B =
  **509,875,138 B**（buildPreparePlan.spaceEstimateBytes）。

### 3.1 未闭合项（如实）

- 环境镜像构建尚未经**产品 Docker 适配器**（3.2）执行：本节构建为探针式直调 CLI
  （同阶段 1 口径）；受控 CLI/env/endpoint 钉死与 digest 校验归 3.2。
- 跨 registry digest 与官方源一致性核对仍未完成（§1.2 未闭合项延续；Hub 直连不可达）。
- plan 预览/prepare 的 IPC 展示与当前授权接线归 4.2/4.3；真实后端的 P04 全场景
  （含失败路径实测）在 3.2 适配器落地后于 6.2 回归。

## 3.2 Docker 受控后端适配器（2026-10-25，验收 P01/P02/P09/P10 的 3.2 切片；实测机同阶段 1）

适配器落地：`packages/project-verification/src/docker/`（cli/preflight/container-flags/
docker-backend），实现 3.1 的 `PreparationBackend` 端口。包内测试 docker-free（注入 runner，
24 用例）；本节为实机证据（探针 `.workbuddy/r3-32/probe-3.2.cjs`，dogfood 包内 dist）。

### 受控 CLI/env（P09 静态面 + P02）

- **受信 CLI 解析**：只认两处候选绝对路径（用户级 `%LOCALAPPDATA%\Programs\DockerDesktop\
  resources\bin\docker.exe` 命中 / 系统级 Program Files 兜底），不扫 PATH（P01 不隐式安装、
  不回退宿主 Shell 的静态前提）。
- **受控 env 完全替换**：实机注入敌意宿主 env（`DOCKER_HOST=tcp://127.0.0.1:2375`、
  `HTTP_PROXY`、`SECRET_API_KEY`）后，适配器传给 CLI 的 env 仅 `PATH`（=CLI bin 目录，
  credential 助手所在）、`SystemRoot`、`USERPROFILE` 三键——敌意变量不可达 CLI。
- **未受控对照（P02 必要性反证）**：裸 `docker version` 继承 `DOCKER_HOST=tcp://…`（argv
  不带 `--host`）⇒ CLI 被重定向到 tcp endpoint（`dial tcp 127.0.0.1:2375 … connectex`
  连接失败，exit 1）——环境覆盖确可改变实际 endpoint，产品必须钉死（与 §1.2 结论一致）。
- **钉死 endpoint**：`--host npipe:…` 进 argv + env 同值双保险；预检一次拿到
  client/server 29.9.2、服务端 linux/amd64、api 1.56（实测读数）。
- **不经 Shell**：全程 argv 数组 spawn（node spawn 无 MSYS 改写面）；输出逐流按字节
  截断（默认 2 MiB/流，有界纪律）。

### 预检分类（P01/P02）

`preflightLocalBackend`：endpoint 枚举外 ⇒ `BACKEND_REMOTE_REFUSED`（不发起调用）；CLI
ENOENT/超时/管道连接失败形态（§1.6 错误文本族）⇒ `BACKEND_MISSING`（reason 注明不可达）；
服务端非 linux/amd64 ⇒ `BACKEND_DRIFT`。分类判据全部带包内用例（canned runner）。

### 适配器全构建实机（P04 的产品路径切片）

- `DockerPreparationBackend.buildTrustedEnvironment`（真实 runner）两次实跑成功：
  1,911 ms（层全缓存）～7,855 ms；产物 ImageId `sha256:6f699f0b…3159` /
  `sha256:a8862503…6b12`（**两次 digest 不同 = BuildKit 层时间戳差异，属预期**——
  环境镜像身份按次登记进准备记录 `prepared.imageDigest`，运行期以其为准）。
- **镜像内五文件哈希复核**（适配器构建产物 `docker cp` 出比对）：package-lock.json/
  runner.mjs/tsconfig.json/package.tmpl.json/tests/smoke.test.mjs 全部与冻结 manifest
  一致（3.1 的 v2 配方经产品适配器可复现）。
- 工具链实测：node 22.23.4 / tsc 5.9.3（镜像内受限旗标下 `node --version` /
  `tsc --version`）；实测 ≠ manifest ⇒ `BACKEND_DRIFT` 收紧为「一致才放行」（包内用例）。
- `networkUsed=true` / `downloadedBytes=null`：准备是唯一联网阶段；构建是否命中缓存
  不可测 ⇒ 如实记 true/null（测不得 ≠ 0）。

### 实容器旗标核验（P10 静态→实映射）

`containerRunFlags(NODE_TS_V1_PROFILE)`（唯一映射，包内全等断言旗标序列、无任何挂载旗标）
经 `docker create`（不 start）+ `docker inspect` 核验实际生效：

| 字段 | 实测 | 与 manifest 一致 |
|---|---|---|
| Memory / MemorySwap | 536870912 / 536870912（无 swap） | ✅ |
| PidsLimit | 64 | ✅ |
| NanoCpus（--cpus 1） | 1000000000 | ✅ |
| User | 1000:1000 | ✅ |
| ReadonlyRootfs | true | ✅ |
| CapDrop / Privileged | ["ALL"] / false | ✅ |
| NetworkMode | none | ✅ |
| Tmpfs | /work:size=167772160,mode=1777；/tmp:size=33554432,mode=1777 | ✅ |
| LogConfig.Type | none（禁 daemon 持久保存输出） | ✅ |
| RestartPolicy.Name | no（显式禁自动重启；docker 规范化为 "no"） | ✅ |
| SecurityOpt | ["no-new-privileges"] | ✅ |

（限额的**实际 Enforcement**（OOM 137/PID 62/ENOSPC/节流）已在 §1.4 带对照实测；本节证
明产品旗标映射与其同参。容器执行期边界（宿主读写/穿越/socket）归 3.3/6.2 实测。）

### 3.2 未闭合项（如实）

- 正式测试容器的创建/执行/停止/采集（supervisor 物化等）归 3.3–3.7；本节未执行项目。
- `docker build` 缓存占用增长为已知行为（§1.4：build cache 271 MB 量级）；清理策略归 6.5 指南。
- 跨 registry digest 与官方源一致性核对仍未闭合（§1.2 未闭合项延续）。

## 3.3 受控物化（2026-10-25，验收 P05/P06/P09/W01/W02 的物化切片；实测机同阶段 1）

落地：`packages/project-verification/src/materialize/materialize.ts`（验证层 + 编排 + 端口）
与 `src/docker/docker-materialize.ts`（Docker 实现）。包内 28 新用例共 131 全绿（docker-free）；
实机探针 `.workbuddy/r3-33/probe-3.3.cjs`（dogfood dist）。

### 模型与复用边界

- **字节流物化**：`docker exec -i <ctr> tee <abs-path>`，文件字节走 stdin、路径走 argv——
  **不经 Shell**（无引号/注入面）；建目录 `docker exec mkdir -p`（argv 分批：Windows 命令行
  预算 ⇒ 字符 8000 + 200 条双重分批）；容器内核验 `docker exec sha256sum`（同分批）。
- **复用既有权威**（不另造标准，W02）：路径规则 `findLogicalPathViolation`（穿越/空段/
  绝对/反斜杠/深度长度/冒号/保留名）、碰撞 `findLogicalPathCollisionViolation`（NFC+大小写
  折叠）、配额 `findFileSetQuotaViolation`（2000 文件/8 MiB 单文件/64 MiB 合计）。
- **链接/特殊对象结构性排除**：快照清单 schema（path/sha256/bytes）无法表达符号链接，
  物化只经 tee 创建普通文件；容器内核查 symlink=0（实测，见下）。
- **验证先于一切写入**：清单校验全纯函数，任一不成立 ⇒ 零 exec（实测计数为证）。
- **字节来源逐文件重读核验**：默认 `createSnapshotByteReader(dataDir)`（replay
  `readVerified`：长度+哈希双核），写入前比对清单；中途失败即停，已写部分不发布。
- 容器生命周期（创建/停止/移除/登记）归 3.4/3.5/3.7；物化模块只持容器 ref。

### 实机探针读数（受限容器 = containerRunFlags 全套 + r3/node-ts-v1:v2）

1. **正例物化**：2 文件（`src/calc.ts` + 三层嵌套 `src/deep/nested/extra.ts`，同字节
   140 B）→ ok，589 ms，4 次 exec（mkdir×1 + tee×2 + sha256sum×1）。
2. **独立复核**（容器内原生 sha256sum，不经包内解析层）：两文件哈希均
   `fcb8adfb…280e`（与阶段 1 §1.5 探针 M 宿主冻结哈希一致——字节逐项与清单一致，P05/W01）；
   属主 `1000:1000` mode 644（非 root 物化）。
3. **无链接核查**：`find /work -type l | wc -l` = 0；`/work` 恰为预期两文件（无额外条目）。
4. **负例·穿越**：清单含 `../escape.ts` ⇒ `path_invalid`，**exec 调用 = 0**；
   容器内核查 `/work/escape.ts` 缺席、根目录无异常（穿越从未发生，P09 物化侧）。
5. **负例·碰撞**：`src/Dup.ts` 与 `src/dup.ts` ⇒ `path_collision`（NFC+大小写折叠语义，
   trace-sdk 权威文案），exec 调用 = 0。

### 坑记录

- alpine 无 `/bin/tee`（busybox applet 在 `/usr/bin`）——绝对路径 `/bin/tee` exit 127；
  改 PATH 解析的 `tee`/`mkdir`（仍是 argv 不经 Shell；容器内 PATH 为受信镜像固定值）。
- `docker exec` 输出哈希行 `<hash>  <path>` 为两空格（busybox）；个别文件缺失 exit 1
  但已输出其余行 ⇒ 解析保留部分结果、缺席路径由编排侧判 mismatch 指名。

### 3.3 未闭合项（如实）

- 物化的容器由编排层提供（3.4 组装：创建（3.2 旗标）→ 物化（本节）→ 执行 → 停止 → 采集）；
  本节容器为探针自建，未走 3.7 登记流程。
- 2000 文件/8 MiB 边界的容器内实测（大批量 tee 性能与 tmpfs ENOSPC 行为）归 6.2 回归；
  配额数字本身已在 replay 包测试与 §1.4 实测覆盖。

## 3.4 固定命令执行（2026-10-25，验收 P11/P12/P13/P20 的 3.4 切片；实测机同阶段 1）

落地：`packages/project-verification/src/execute/command-runner.ts`（解析/编排/分类/P12 门/
事件构造）与 `src/docker/docker-exec-command.ts`（Docker 实现）。包内 12 新用例共 143 全绿；
实机探针 `.workbuddy/r3-34/probe-3.4.cjs`（dogfood dist）。schema 增量：command_end 的
stdout/stderr 增 `totalBytes`（全观测口径，P13 计数是证据）并提为具名
`CommandStartEventSchema`/`CommandEndEventSchema`。

### 机制

- **命令只来自 manifest 查表**（`resolveFixedCommand`：commandId → 冻结 executable/argv/cwd），
  调用方无命令/路径/参数入口（P08 执行侧）。
- **执行形态**：`docker exec --workdir /work <ctr> /usr/local/bin/node /opt/r3/runner.mjs
  <cmd>`——argv 数组不经 Shell；CLI 硬超时 = `commandTimeoutMs(120s)` + 10s 余量，
  超时击杀 CLI 会话并以 timedOut 收尾（容器内子孙定向停止确认归 3.5）。
- **双时钟**：UTC 起止（墙钟事实）+ `performance.now()` 单调耗时（design D6）。
- **有界采集**（P13）：每流保留前 1 MiB（= limits 预算），超限**持续读取丢弃并计数**；
  CliRunResult 增字节面（stdoutBytes/stderrBytes）与全观测计数（stdoutTotalBytes/
  stderrTotalBytes）；command_end 事件双口径（byteLength/sha256=保留资产，totalBytes=全观测）；
  总观测阈值 16 MiB 只是判定函数（`exceedsTotalOutputLimit`），触发停止的接线归 3.5。
- **阶段分类**（P20）：执行级结局 = completed(0–125) / start_failed(126/127) /
  process_failed(≥128，137=SIGKILL OOM 候选、143=SIGTERM) / timed_out；exit 1 的报告
  照常产出（检查成败归编排层结合 TAP 门判定，基础设施故障不混入代码断言失败）；
  signal 字段按 128+N 约定**推导**（呈现侧注明非观测）。

### 实机探针读数

1. **已知失败输入**（mul=a−b）→ test：exit 1，2,281 ms，TAP `not ok 2 / # tests 2 /
   # pass 1 / # fail 1`，保留 1,014 B 全观测同值；command_end 事件过 schema
   （exit=1，signal=null，stdout sha256 `815b9de6…`）。
2. **修复输入**（mul=a×b，同容器重新物化覆盖）→ test：exit 0，1,850 ms，TAP
   `# tests 2 / # pass 2`；包层 `validateTestReport` 精确门 ok（与镜像内 runner 门纵深）。
3. **P11 机制切片**：两份报告独立并存（失败 stdout sha `815b9de6…` ≠ 修复 `b0e8c203…`），
   互不覆盖；完整双验证记录回查归 6.1。
4. **长输出**（容器内 node 生成 2 MiB stdout）：保留恰 1,048,576 B（=1 MiB 预算）、
   全观测 2,097,152 B、truncated=true——丢弃量如实计数（P13）。
5. **阈值判定**：totalObserved 汇总双流、对照 16 MiB 阈值布尔判定可用。

### 3.4 未闭合项（如实）

- 超时/输出限额触发的**停止接线**（owner 定向停止、全子孙确认、幂等）归 3.5；
  本节 CLI 击杀只保证本地会话终止，容器内进程可能存留（阶段 1 §1.5 探针 O 形态）。
- OOM(137)/PID 封顶等限额的实际 Enforcement 沿用 §1.4 实测；P20 的 OOM 分支在包内
  以注入 runner 用例覆盖（exit 137 → process_failed + signal 推导），真机 OOM 复现归 6.2。
- 受控 supervisor 作 PID 1 的容器结构归 3.5（P19）；本节容器以 sleep 保持存活（探针口径）。

## 3.5 停止语义与 supervisor 结构（2026-10-25，验收 P10/P19/P20/P21 的 3.5 切片；实测机同阶段 1）

落地：受信环境 v3 镜像（+ supervisor.sh / stop-workloads.sh，manifestVersion 1→2）；
`src/execute/stop.ts`（解析/编排/静止确认/幂等/unknown 分类）与
`src/docker/docker-stop.ts`（Docker 实现）；CliRunner 输出限额实时击杀接线
（`outputLimitBytes` → 超限 kill 子进程 + `outputLimitHit` 标记 → 执行分类
`output_limit_stopped`）。包内 13 新用例共 156 全绿；探针 `.workbuddy/r3-35/probe-3.5.cjs`。

### 受信环境 v3（镜像内八文件哈希复核全过）

- 新增受信脚本（哈希冻结于 manifest.trustedEnvironment）：supervisor.sh
  `09fe58f3…add8`（PID 1：TERM → `kill -TERM -1`（不含调用者）→ 5s 宽限 → KILL 兜底 →
  干净退出；主循环 wait 收割孤儿防 PID 配额被僵尸耗尽——§1.4 发现①的结构修复）；
  stop-workloads.sh `74ea5c00…b1ff`（按 PID 定向，排除 PID 1 与自身，绝不模式匹配
  ——§1.5 pkill -f 自杀反证；TERM → 2s → KILL 兜底 → 存活清点输出三行）。
- 原 runner/锁/模板/测试五项字节未变（镜像内复核一致）；v3 ImageId
  `sha256:121aa3a7…aca6e`，270,846,297 B；trustedEnvironment 形状扩展 ⇒
  manifestVersion 2（plan token/准备记录随 digest 自动漂移——P07 机制按设计生效）。
- 工作负载容器命令 = `containerRunFlags` + `workloadContainerCommand`
  （`/bin/sh /opt/r3/supervisor.sh` 经 node 镜像 entrypoint exec 落位 PID 1）。

### 实机探针读数

1. **PID 1 身份**：容器命令 `["/bin/sh","/opt/r3/supervisor.sh"]` → `/proc/1/comm = sh`。
2. **P19 孤儿写者**：detached exec 后台写者（会话退出仍在写，双扫不一致实证）→
   `stopWorkloadsAndConfirm`：stoppedPidCount=4、survivors=0、quiescent=true
   （quiescenceMs 2,576——2s 双扫窗口）。
3. **幂等**：复停 stoppedPidCount=2、survivors=0、quiescent=true——**计数语义诚实注记**：
   TERM_SENT 含对未及收割僵尸的信号成功（kill 对僵尸返回成功），计数是过程量；
   终态判据 = SURVIVORS=0 + /work 双扫一致（本探针均满足）。
4. **P13/P10 限额接线**：容器内 node 写 5 MiB vs 1 MiB 阈值 ⇒ 327 ms 内实时击杀，
   outputLimitHit=true、全观测 1,081,344 B（保留恰 1 MiB）——超限即停不是事后发现。
5. **supervisor TERM 快停对照**：`docker stop -t 10` 实测 **6,166 ms**（§1.4 裸 PID 1
   基线 10,511 ms）——6s ≈ 脚本内固定 5s 宽限 + 开销，确定性设计（保守宽限，正常流程
   不走 docker stop：停止工作负载保留容器供采集，docker stop 仅 teardown/残留清扫使用，
   残留清扫亦可 rm -f 直接 SIGKILL）。

### P21 未知阻断（包内用例 + 分类）

daemon 断开形态（§1.6 错误族）⇒ `kind: unknown`——不声明已停止，保留可信身份，只允许
核对与再次定向停止；普通失败（如 stat 权限）⇒ `failed`。survivors>0 或双扫不一致 ⇒
quiescent=false，调用方不得据此发布完成/取消结论（不乐观语义）。

### 3.5 未闭合项（如实）

- 停止请求/槽位/epoch 校验与迟到停止归操作登记层（4.2/4.4）；本单元提供的是
  资源侧停止事实（幂等、可重复、不乐观）。
- supervisor 的 5s 固定宽限未做「轮询提前退出」优化（僵尸重父化使轮询不可靠；
  确定性优先）——实测 6.2s 仍显著优于 §1.4 裸 PID 1 基线。
- P19/P21 的完整桌面操作面（用户停止请求 → cancelled 呈现）归 4.4/5.2。

## 3.6 静止采集与产物发布（2026-10-25，验收 P17/P18/W01 的 3.6 切片；实测机同阶段 1）

落地：`src/collect/collect.ts`（glob 匹配/采集编排/配额/发布）与
`src/docker/docker-collect.ts`（find 双形态/sha256sum·stat 分批/cat 字节面）。
manifestVersion 2→3：`artifacts` 采集规则入表（include `.build/**`、exclude
`node_modules/**`+`*.tmp`——纯 manifest 数据，镜像字节不变）。包内 12 新用例共 168 全绿；
探针 `.workbuddy/r3-36/probe-3.6.cjs`（dogfood dist）。

### 机制（design D5.6 顺序固定）

1. **非普通对象核查先行**：/work 下任何链接/特殊对象 ⇒ `artifact_invalid`（不静默跟随）；
2. **内容级双扫**：全树 find+stat（清单+尺寸，分批）+ sha256sum（哈希）⇒ 规范快照，
   间隔复扫（默认 2s）——两次不一致 ⇒ `artifact_invalid`（停止事实已知时的采集不稳定）；
3. **逐文件分类**：输入清单锚定的文件必须哈希不变（workload 改源码 ⇒ `input_drifted`
   ——「把测试改代码当成修复」的直接拒绝，P18/W01）；命中 include 且未被 exclude ⇒
   产物；其余 ⇒ stray（如实计数、不发布——「只收 profile 允许的普通输出」）；
4. **配额**：R1 文件集合配额复用 + 产物唯一内容 ≤ `artifactUniqueContentBudgetBytes`
   （128 MiB，limits 冻结值）；
5. **发布**：宿主逐文件重读（cat，上限=单文件配额）并复核哈希（与容器扫描不一致 ⇒
   `content_corrupt` 拒发布）后 `publishAsset` 内容寻址发布（不可变/同哈希幂等）；
   `artifactsRecordEvent` 构造记录事件（excludedPatterns=manifest 规则本身）。

### 实机探针读数（v3 容器，test 编译后停止确认 → 采集）

1. **正例**：entries=`.build/src/calc.js`（96 B，sha256 `d1a39589…b4c`）、scanStable=true、
   总观测含 2 个 stray（tsconfig.json/package.json——runner 自拷模板，探针输入清单仅含
   src/calc.ts，产品流由编排层并入输入清单后归输入面）；发布落盘
   `verification-assets/sha256/d1a39589…` 宿主哈希复核一致；artifacts 事件过 schema
   （excludedPatterns=规则本身）。
2. **反例·改源码**：tee 覆写 src/calc.ts 后再采集 ⇒ `input_drifted`
   （「采集哈希 ≠ 清单 fcb8adfb…——改代码不是修复」）。
3. **反例·链接**：`ln -s` 后再采集 ⇒ `artifact_invalid`（指名 evil-link）。

### 3.6 未闭合项（如实）

- 采集后容器移除与「产物只属于 verification」的 R2.1 导出关联归编排层/5.5；
- 大产物树（2000 文件 × 8 MiB）的容器内批量扫描耗时未压测（分批上限 200 条/批），
  6.2 回归覆盖；
- strays 的完整清单当前只计数不落记录（编排层可从 scan 快照取），如需审计面再扩展。
