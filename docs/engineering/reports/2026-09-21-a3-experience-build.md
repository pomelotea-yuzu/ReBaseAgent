# A3 隔离重跑体验包（`0.3.0-k0-a3.1`）· 构建记录

> 日期：2026-09-21
> 类型：**体验包**（自用 + 定向试用），不是正式发行，**未上传 Release**
> 依据：`docs/engineering/plans/2026-09-16-isolated-rerun-roadmap.md` §9.1
> 状态：**构建与自动化验收通过**；§9.1 第 5 项的**人工实机验收尚未执行**

## 1. 基线与范围

| 项 | 值 |
|---|---|
| 提交 | `5630361`（C 段归档；工作区仅两处 `package.json` 版本号改动 + 未跟踪的 `HANDOFF.md` / `docs/`） |
| 包版本 | `0.3.0-k0-a3.1`（根与 desktop 同步） |
| 上一包基线 | `fba9167` = `0.3.0-k0`（09-17 已发布，**不含 A/B/C**） |
| 输出位置 | `release/preview/`（**体验包**子目录；正式发行在 `release/stable/`，见 §2） |

**为什么用这个版本标识**：主 spec `desktop-distribution` 已由 `2026-09-17-allow-versioned-release-identity`
改为「发行物使用可辨认且不冲突的版本身份」，版本与产物名**同源推导**。沿用 `0.3.0-k0` 前缀表明
这是 K0 能力线之上的体验包，`-a3.1` 表明本次增量是 **R1 的 A3 隔离重跑三段**（第 1 个此类包）。
只改了 `apps/desktop/package.json` 与根 `package.json` 的 `version` 各一处，**未改任何发行校验脚本**。

## 2. 产物与验收

| 项 | 值 |
|---|---|
| 路径 | `D:\ReBaseAgent\release\preview\ReBaseAgent-0.3.0-k0-a3.1-win-x64-portable.exe` |
| 字节数 | **94,517,322**（< 100,000,000，余量 **5,482,678**） |
| SHA-256 | `5ba04a009eb0061629352b9db6e8cd9ed376763bd160847984fc42ba80e2f210` |
| 构建时间 | 2026-09-21 13:00 |

`release:verify`：**通过**

```
目标版本  : 0.3.0-k0-a3.1
期望产物名: ReBaseAgent-0.3.0-k0-a3.1-win-x64-portable.exe
实际产物名: ReBaseAgent-0.3.0-k0-a3.1-win-x64-portable.exe  ✓
应用版本  : 0.3.0-k0-a3.1 ✓
体积      : 94,517,322 / 100,000,000 bytes ✓
renderer 源码违规 : 无 ✓
worker 集合       : editor/json worker 就绪 ✓
                    renderer JS 11,285,723 / worker 1,468,821
```

**既有产物未被触碰**（打包前后哈希与字节数逐字节一致）：

| 文件 | SHA-256（前 16） | 字节数 | 判定 |
|---|---|---|---|
| `release/stable/ReBaseAgent-0.1.0-win-x64-portable.exe` | `47b9aea248d3ae74` | 113,095,437 | ✓ 未变 |
| `release/stable/ReBaseAgent-0.2.0-win-x64-portable.exe` | `cd2e1c9482398604` | 94,316,503 | ✓ 未变 |
| `release/preview/ReBaseAgent-0.3.0-k0-win-x64-portable.exe` | `8018363be0d6a515` | 94,351,087 | ✓ 未变 |

### 产物目录约定：`release/stable`（正式发行）与 `release/preview`（体验包）（2026-09-21 owner 定）

```
release/
├── stable/    正式发行：ReBaseAgent-0.1.0-… / ReBaseAgent-0.2.0-…
└── preview/   体验包：  ReBaseAgent-0.3.0-k0-… / ReBaseAgent-0.3.0-k0-a3.1-…
```

两类包**身份与输出位置都可分辨**（体验包版本号带 `-k0*` 前缀、且落在独立子目录），
与 `desktop-distribution` spec 的「体验包与正式发行 SHALL 使用可分辨的身份与输出位置」一致；
同时上层只有 `release/` 一个目录，不再为每包新建平级目录。

**今后打包的输出目录**：
- 正式发行 —— `apps/desktop/electron-builder.yml` 的 `directories.output: ../../release/stable`（默认，无需传参）
- 体验包 —— 显式 `-c.directories.output=../../release/preview`（**不可省略**，省略会落进 stable）

**副产物清理（2026-09-21 已执行）**：`release/` 根目录下遗留的 `win-unpacked/`（335 MB）、
`builder-debug.yml`、`.icon-ico/` 已删除，回收约 **335 MB**；删除后 4 个产物哈希复核仍逐字节未变。
`release/data/`（应用便携数据）**保留未动**。⇒ 整理后 `release/` 只含 `stable/`、`preview/`、`data/`。
注意此后每次打包会在**输出子目录内**重新生成 `win-unpacked/` 等副产物，做完可随手清掉。

⚠️ **本次目录整理的过程与一处不可逆损失**：构建期连同旧布局一共搬动过三次
（`release/` + `release-k0/` + `release-k0-a3/` → 合并为 `release/` → 恢复 `release/` + `release-k0/`
→ 最终 `release/stable` + `release/preview`）。期间 `release-k0/` 原有的
`ReBaseAgent-0.2.0-win-x64-portable.exe`（`e91f3753…`，94,358,251 B —— 09-17 K0 第一版误用 `0.2.0`
命名、与正式 0.2.0 同名只能靠目录区分的**已被取代构建**）在"合并为单目录"那一步被确认为冗余并删除，
**已无法找回**（Git Bash 的 `rm` 不进回收站，回收站与 `.git/release-backup/` 均无副本）。
该产物自 09-17 起即被 `0.3.0-k0` 取代，**不影响任何已发布版本**。其余 4 个产物在每个阶段哈希均逐字节未变。

## 3. 自动化验收（沙箱替换口径）

本沙箱跑不了 `pnpm check:ci`（`pnpm -r test` 会拉起 `wmic.exe`、`check:spec` 的 `npx` 同被程序黑名单拦），
按 MEMORY 记录的替换法逐段执行：

| 段 | 命令 | 结果 |
|---|---|---|
| ① 共享包构建 | `pnpm check:build` | ✅ 5 包全绿（llm-proxy / trace-sdk / agent-loop / replay / trace-test） |
| ② 桌面构建 | `electron-vite build` | ✅ 三段全绿（22.55s） |
| ③ 桌面类型检查 | `tsc -p tsconfig.node.json && tsc -p tsconfig.web.json` | ✅ 无错误 |
| ④ 桌面测试 | `vitest run --pool=forks --poolOptions.forks.singleFork=true --testTimeout=30000` | ✅ **24 文件 / 363 passed / 0 failed**（与 C 段验收基线一致） |
| ⑤ 静态检查 | `biome check apps packages scripts package.json biome.json` | ✅ **223 文件 0 errors** |
| ⑥ spec 校验 | 直调 `openspec validate --all --strict`（1.12.0） | ✅ **12 passed / 0 failed**（主 spec 12 个，活动 change 0 个） |

> ⚠️ **口径说明**：对仓库根跑 `biome check .` 会额外报 **36 个格式错误，全部位于未入库的
> `docs/reviews/2026-09-21-ui-walkthrough-assets/*.json`**（09-21 UI 走查的截图/状态采集产物）。
> 这些文件不入库、`docs/` 在任何检出中都不存在，故不构成代码回归，也不影响 CI。**未**为此放宽 `biome.json`。

### 打包后强制离线冒烟（§9.1 第 5 项的可自动化部分）

对本次产物运行 `.workbuddy/smoke-monaco-slim/packaged-offline-smoke-k0.mjs`（已参数化为接受任意 exe 路径）。
做法：把 exe 复制到无 marker / 无指针的临时目录 → 隔离 `APPDATA` 与 `LOCALAPPDATA` 启动 →
**拦截全部非 localhost 请求** → 经 CDP 驱动界面断言 → 收尾。

**结果：20 项断言全部通过（`PACKAGED_OFFLINE_PASS`，退出码 0）**

| 覆盖的验收项 | 证据 |
|---|---|
| 首次启动不弹目录选择 | 主界面就绪即通过，全程无目录选择交互 |
| 数据落点 | 同级 `data/` 自动创建，含 `traces/`、`userData/`、`sessionData/`（后两者为 pre-ready 锚定） |
| 不写 AppData / LocalAppData | 隔离目录下**零** ReBaseAgent 产品目录 |
| 离线 Monaco 资源 | 全部非 localhost 请求被拦截的前提下，JSON 高亮（3 种 mtk 类）与纯文本编辑器（1 种）均正常 |
| 其他界面能力 | 预算地图 canvas、分支树 SVG、轨迹详情渲染正常 |
| 本地代理 | 启动 / 端口可见 / 状态查询 / 停止 / 再次启动全部正常；代理运行中 Monaco 与预算地图不受影响 |
| 错误与外部请求 | **零 page / console 错误、零非 localhost 外部请求** |

> ⚠️ **沙箱限制，不是产品问题**：脚本用于登记清理 PID 的 `execSync(cmd.exe → powershell)` 在本沙箱
> 一律 `EBUSY`。已改为**尽力而为 + `Browser.close` 优雅退出**，断言结论不受影响，退出码已回到 0。

## 4. 包内含范围（相对 `0.3.0-k0`）

边界：`v0.3.0-k0` 收口于 `fba9167`（09-17），本包基线 `5630361`，二者之间共 45 个提交，新增归档 change **3 个**：

| 归档 change | 段 | 用户可见增量 |
|---|---|---|
| `2026-09-19-add-sandboxed-rerun` | A（包层） | **新建 `workspace-isolation` 主 spec**（6 requirement / 19 场景）：隔离文件世界、内容寻址附件、快照清单与哈希校验、版本与隔离字段匹配约束 |
| `2026-09-20-add-sandboxed-rerun-desktop` | B（桌面入口） | **新建对话框的隔离模式 + 原生目录选择（15 分钟 sourceToken）**；改 `tool_result` 的**两段式隔离续跑**（只读预检 → 确认区 → 真实调用）；隔离父本禁用 prompt fork 与模型 A/B |
| `2026-09-20-add-sandboxed-rerun-file-view` | C（文件视图） | 详情面板新增**轨迹 / 文件 tab（仅隔离 run 出现）**：本轮结束检查点选择器、只读文件内容视图、来源说明 |

顺带纳入的非 A3 改动：`f795b6a`（模型 A/B 的 renderer 判据与内核对齐：空 fork 改逐臂、副作用确认下发到每臂）、
`5a3b5c1`（仓库卫生：移除误入库的 `.trae/`）。

体积从 94,351,087 → 94,517,322，**增加 166,235 bytes**（约 0.18%）。

**仍在 K0 基础上保留**：V3a 卡带回归（包外能力）、V3b 模型 A/B、A1 原生建运行、A2 缓存记账、A4 LLM 失败详情。

**不包含**：R2.1 结果导出、R3 单环境测试、U1–U8 可用性改造（仅规划稿，尚未建活动 change）。

## 5. 已知限制

- 隔离文件能力**只有桌面入口与只读文件视图**，尚无「按 fixture 哈希逐份核对真实文件 diff」的端到端冒烟
  （B 段明确迁给 C 之后的验收范围）。
- `docs/engineering/plans/2026-09-21-ui-change-split-plan.md` 记录的 UI 可用性缺陷（正文被固定列挤掉、草稿丢失、
  失败收尾状态色等 11 组走查问题）**本包一个都没修** —— 这些是 U1–U8 的范围。
- 与 09-17 的 K0 相同：本包**未上传 Release**。
- §9.1 第 5 项的**人工实机验收**（独立测试目录首次启动、历史数据副本读取、重启与设置持久化、
  错误状态、包目标主流程）**本次未执行**；自动化只替代了其中的首次启动、数据落点、离线资源与零外部请求。

## 6. 回退方法

删除 `release/preview/ReBaseAgent-0.3.0-k0-a3.1-win-x64-portable.exe` 即可，不影响 `release/preview/` 内其它产物，
也不影响 `release/stable/` 下的正式发行与 `release/data/`（既有便携数据目录）。本次未改动任何非本包产物。

## 7. 发行准备与交付

| 项 | 值 |
|---|---|
| 版本提升提交 | `17dc2ea` —— `chore(release): 版本提升到 0.3.0-k0-a3.1`（只含根与 desktop 的 `package.json` 各一处 `version`） |
| tag | `v0.3.0-k0-a3.1`（附注 tag，与 `v0.1.0` / `v0.2.0` / `v0.3.0-k0` 同格式），已建在 `17dc2ea` 上 |
| 推送 | **由 owner 手动执行**（沙箱凭证限制，见 MEMORY「commit 归 agent、push 归用户」） |

```bash
git push github main && git push gitee main
git push github v0.3.0-k0-a3.1 && git push gitee v0.3.0-k0-a3.1
```

交付物：

| 类型 | 路径 | 是否入库 |
|---|---|---|
| 便携包 | `release/preview/ReBaseAgent-0.3.0-k0-a3.1-win-x64-portable.exe` | 否（`release/` 已 ignore） |
| 构建记录 | `docs/engineering/reports/2026-09-21-a3-experience-build.md`（本文件） | 否 |
| 发行文案 | `docs/engineering/reports/2026-09-21-v0.3.0-k0-a3.1-release-notes.md` | 否 |

**发布前必须先处理两件事**（否则文案与实际自相矛盾）：
① 新 tag 已推双远程、exe 已上传 Releases；② README 中「桌面入口尚未进入任何发行包」与
「0.3.0-k0 不含它」两处表述需改为指向本版。

## 8. 构建过程中的坑（复现用）

1. **electron 走镜像下载会挂死**（本次第一次打包卡了 8 分钟无进展，最终被手动终止）。
   现象：`%TEMP%\electron-download-*/SHASUMS256.txt` 是 **0 字节且长时间不变化** —— 请求建立了连接但无数据。
   实测 `curl -sSL https://npmmirror.com/mirrors/electron/44.1.1/SHASUMS256.txt` 30 秒超时：
   镜像返回 302，**跟随重定向到 CDN 的请求被本机代理挡住**（`http_proxy=http://127.0.0.1:6417`）。
   即 09-17 记录里「必须带镜像」的结论在本机代理生效时**会反向变成挂死**。
   **可靠解法（本次采用，完全离线）**：本地已有 `%LOCALAPPDATA%\electron\Cache\0ca74001…\electron-v44.1.1-win32-x64.zip`，
   用 7za 解压到 `.rebaseagent/electron-dist/`（`version` 文件为 `44.1.1`），然后
   `-c.electronDist=D:/ReBaseAgent/.rebaseagent/electron-dist` 交给 electron-builder。
   日志会出现 `using custom unpacked Electron distribution` ⇒ 不再有任何下载，全流程约 2 分钟。
   （顺带否证一条旧认知：缓存的目录名**不是**下载 URL 的普通 sha256 —— 三种候选 URL 都算不出 `0ca74001…`，
   所以「不带镜像就能命中缓存」这条推断不成立，`electronDist` 才是可复现的路子。）
2. **打包命令别把输出管到 `tail`**：`... | tail -40` 会缓冲到进程结束才吐字，看起来像"卡住了"。
   改为 `> 日志文件 2>&1`，再单独读文件看进度。
3. **沙箱内 node 起 `cmd.exe` 一律 `EBUSY`**（本次冒烟脚本的 PID 枚举就栽在这里，报错栈指向
   `spawnSync C:\WINDOWS\system32\cmd.exe`）。已改为尽力而为 + CDP `Browser.close` 收尾。
   ⚠️ 且 `Browser.close` **不能 await** —— 应用退出后 ws 不会回包，顶层 await 永不 settle，
   Node 会以**退出码 13** 结束（断言全过但结果不干净）。
4. **输出目录**：体验包必须显式覆盖 —— `-c.directories.output=../../release/preview`
   （相对路径按 **apps/desktop** 解析）。不要省略：省略会落到 `electron-builder.yml` 里
   `directories.output: ../../release/stable`，把体验包混进正式发行目录。

---
本次为体验包构建，**未上传 Release**。产品代码未改动，只动了版本号。
