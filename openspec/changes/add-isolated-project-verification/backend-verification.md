# R3 阶段 1：Windows 后端技术验证记录

> 本文件是 tasks 1.1–1.6 的探针事实源与销账依据：任一门槛未通过即冻结第 2–6 组并先修提案（tasks.md 状态段）。
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
- 1.2 已执行（§1.2）；1.3 已执行（§1.3）；1.4–1.6 待续。

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
