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

- **1.1 完成**（缺失态记录）。1.2–1.6 全部依赖真实引擎 ⇒ **阻塞于用户安装 Docker Desktop**
  （安装时选 WSL2 backend、首次启动接受协议、确认 Linux containers 模式）。
- 安装完成后本节「未安装」结论作废，由 1.2 实测（实际版本/endpoint/image digest/边界探针）
  覆盖，并记录实际版本与本节候选口径的差异。
