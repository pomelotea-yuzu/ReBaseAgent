# Linux / macOS 三端打包可行性评估 —— 结论与依据

日期：2026-11-07
对象：ReBaseAgent 桌面应用（Electron）发行物从 Windows x64 portable 扩展到 Linux / macOS
结论性质：**决策记录**——本轮评估后放弃为既有项目补打 Linux/mac 版，仅维持 Windows x64 口径；后续新项目从第一天即按三端准备。

## 结论（先看这条）

**不为本项目补打 Linux / macOS 版本。** 继续以 `ReBaseAgent-<version>-win-x64-portable.exe`（zip 发行）为唯一发行形态；0.8.0-rc.1 及后续候选均按既有 Windows 口径打包。若未来重启三端，应作为独立立项（OpenSpec change）而非打包轮附带动作。

用户侧决策背景：用户有 Linux 虚拟机与 MacBook 可用于实机测试，但在了解难度与执行成本后选择放弃；并明确「以后的项目在一开始就准备好三端」。

## 难度定性：中等偏高，且执行成本落在用户侧

代码层准备程度好于预期，真正的成本在流程层。分述如下。

### 已就绪的部分（代码层）

- **便携数据目录逻辑平台无关**：`apps/desktop/src/main/data-dir.ts` 全部使用 `node:path.join` 与 marker 文件探测，无 win32 硬编码；`PORTABLE_EXECUTABLE_DIR` / `portable.marker` 两条 portable 判据在 Linux（AppImage 场景需另行评估锚点）与 macOS 同样成立。
- **平台门控已有先例**：R3 的 Docker CLI 候选路径自 v0.7.0-rc.2 起按平台返回（非 Windows 明确返回空表），`path.win32` 构造仅用于 Windows 候选；主进程仅一处 `process.platform !== "darwin"`（macOS 关窗行为，标准写法）。
- **依赖无 native 模块**：react / monaco / echarts / zod / zustand 等全为纯 JS，`npmRebuild: false` 在三端均可维持。

### 三座山（流程层）

1. **无法从 Windows 交叉构建。** electron-builder 的 macOS 目标（dmg）只能在 macOS 上构建；Linux AppImage 依赖 Linux 侧工具链（mksquashfs），在 Windows 上同样不可靠。意味着 Linux/mac 构建必须在 VM / MacBook 内由用户手动执行（装 Node ≥ 20 + pnpm、clone、install、build、排错），Windows 这端无法代跑、无法直接取证——每轮排错的往返成本都由用户承担。
2. **发行管线绑死 Windows portable exe。** `apps/desktop/scripts/release-verify.mjs`（产物名 / 体积 / renderer 资源核验）、`scripts/assemble-release-zip.mjs`（exe + `mcp/` 闭包 + `SHA256SUMS.txt` + 使用说明组装与三段自验）、离线冒烟 12 判据，整套验收体系按 portable exe + Windows 环境编写。每个新平台都需要重造一套等价验证故事，否则产物「能跑不能验」，与发行规范（`docs/development/release-and-handoff.md`）的取证要求冲突。
3. **desktop 全量测试的跨平台行为未知。** 0.7.0-rc.2 基线为 225 文件 / 3474 用例，其中多少用例隐含 Windows 假设（路径分隔符、junction、换行符、时序）只有真机跑过才知道；trace-sdk / fs-boundary 的 Windows 加固经验（junction 探测、临时目录重试）反向说明测试对平台特性敏感。每暴露一批就要修一批，迭代轮数不可预估。

### 次要成本（如实列出，不构成否决项但加重负担）

- **R3 范围声明**：隔离项目验证仅声明 Windows x64 + Docker Desktop + `node-ts-v1`；Linux/mac 包需在发行文案中继续如实标注该能力不可用（门控已返回空表，属声明问题而非功能缺陷）。
- **图标**：`build/icon.png` 转 icns 仅能在 macOS 上完成，Linux 需确认 png 尺寸族满足 builder 要求。
- **未签名告知**：mac 无代码签名时 Gatekeeper 拦截强度高于 Windows SmartScreen 首弹（需右键或 `xattr` 放行），使用说明需按平台分写。
- **`mcp/` 闭包**：`pnpm --prod deploy` 在 Linux/mac 上可行，但 zip 布局自验、`使用说明.en.txt` 的平台差异（路径写法、启动命令）需同步改写。

## 新项目的三端-first 约定（承接用户决策）

- 数据目录、路径拼接、便携/安装双形态从第一版即按 `node:path` 跨平台写法落地，禁止 win32 硬编码；
- 测试套件对路径分隔符 / 换行 / 平台特性保持中性，CI 至少覆盖一个非 Windows 平台；
- 发行管线（产物核验、组装、冒烟）按平台参数化设计，而非绑定单一产物形态；
- electron-builder 配置一开始就含三端 target，避免事后补配置时才发现工具链宿主约束。

## 依据与回溯

- 构建口径与发行管线现状：`docs/development/release-and-handoff.md`、`docs/engineering/reports/2026-10-26-v0.7.0-rc.2-build-record.md`
- 平台门控先例：`docs/engineering/reports/2026-10-26-v0.7.0-rc.2-release-notes.md`（Docker CLI 按平台返回）
- 数据目录实现：`apps/desktop/src/main/data-dir.ts`（2026-11-07 勘察确认无平台硬编码）
- 本轮评估对话记录：用户提出用 Linux 虚拟机 + MacBook 实测的设想 → 难度评估 → 用户决策放弃（2026-11-07）
