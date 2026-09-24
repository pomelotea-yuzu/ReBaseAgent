# K0 已完成功能体验包 · 构建记录

> 日期：2026-09-17
> 类型：**体验包**（自用 + 少量试用），不是正式发行，不上传 Release
> 依据：`docs/engineering/plans/2026-09-16-isolated-rerun-roadmap.md` §9.1
> 状态：**K0 验收通过（2026-09-17）** —— 构建与自动化通过（§10）+ §4 五项实机验收通过 + §5 六项能力核对全部通过（§5.1）

## 1. 基线与范围

| 项 | 值 |
|---|---|
| 提交 | `a89bf74`（工作区无未提交的代码改动） |
| 包版本 | `0.2.0`（**保持未变**，理由见下） |
| 基线选择 | **更新提交**（非 §9.1 建议的 `ad19fa8`） |

**基线选择说明**：§9.1 建议候选基线 `ad19fa8`，并允许选择更新提交，条件是"逐项核对未完成能力不可从 UI/IPC 进入，兼容性回归通过，并记录包实际包含的范围"。三项逐条核对：

| 条款 | 核对方法与结果 |
|---|---|
| 未完成能力不可从 UI/IPC 进入 | ✓ `git diff ad19fa8..HEAD` 中 `apps/desktop/src` **仅 `proxy-recorder.ts` 一个文件**，改动是一行 import 常量替换（`FORMAT_VERSION` → `PLAIN_FORMAT_VERSION`，值 2→1，保持代理录制写 v1）；在 `apps/desktop/src/main` 上检索新增的 `ipcMain` / `handle(` **零命中** |
| 兼容性回归通过 | ✓ `pnpm check:ci` 全绿：desktop **197** 测试 / biome **157** 文件 0 错 / openspec **14 passed** |
| 记录包实际包含范围 | ✓ 见 §3 |

**为什么不改版本号**：`openspec/specs/desktop-distribution/spec.md:9` 有一条持续有效的 SHALL ——「系统 SHALL 将根项目与 desktop 发行包版本设为 `0.2.0`，并生成名为 `ReBaseAgent-0.2.0-win-x64-portable.exe` 的新产物」。改版本号即违反该规范，须先走 OpenSpec change。因此本次采用 §9.1 原文允许的另一半路径：「预发布版本**或**独立构建标识**与输出目录**」，以**独立输出目录**实现"不覆盖同名新旧混合包"。

## 2. 产物与验收

| 项 | 值 |
|---|---|
| 路径 | `D:\ReBaseAgent\release-k0\ReBaseAgent-0.2.0-win-x64-portable.exe` |
| 字节数 | **94,358,251** |
| SHA-256 | `e91f3753e86888db0f7b5ee9ed95ce5b217e2811844e6c0e720fd3983accb8ad` |
| 构建时间 | 2026-09-17 11:19:59 |

`release:verify` 结果：**通过**

```
文件名   : ✓（ReBaseAgent-0.2.0-win-x64-portable.exe）
应用版本 : 0.2.0 ✓
体积     : 94,358,251 bytes / 阈值 100,000,000 bytes ✓（余量 5,641,749）
renderer 源码违规 : 无 ✓
worker 集合       : editor/json worker 就绪 ✓
                    renderer JS 11,219,431 / worker 1,468,821
```

**旧产物未被覆盖**（哈希与打包前基线逐字节一致）：

| 文件 | SHA-256 | 判定 |
|---|---|---|
| `release/ReBaseAgent-0.1.0-win-x64-portable.exe` | `47b9aea2…65357` | ✓ 未变 |
| `release/ReBaseAgent-0.2.0-win-x64-portable.exe` | `cd2e1c94…6815` | ✓ 未变 |
| `release/data/`（sessionData / traces / userData） | — | ✓ 未触碰 |

## 3. 包内含范围（相对 09-07 正式 0.2.0）

体积增加 **41,748 bytes**。

**边界**：v0.2.0 收口于提交 `3211e78`（09-07，annotated tag `v0.2.0` 即 40b93c8 所指）。
本包基线为 `ad19fa8`（09-16），位于其之后，故额外包含 09-07 之后归档的**全部 9 项**成果：

**面向使用（有桌面入口或可见效果）**

- **模型 A/B 与分支实验**（09-09，`add-model-ab-experiments`）—— 同上下文多臂对比（最多 4 臂）：
  先 dry-run 出计划（不联网、不写文件），确认后按臂数真实调用；各臂落盘为独立轨迹并共享
  `experimentId`，分支树按"换 model/params（A/B）"标签分组
- **Provider 原始参数透传**（09-14，`add-provider-params-passthrough`）—— 请求体顶层扩展参数被
  录制，重发时原样保留（平铺回顶层），并附参数生效性自检
- **代理录制 run 可作分叉父本**（09-14，`allow-proxy-run-forking`）—— 代理 run 可编辑 messages、
  经代理用暂存 key 重发，单请求级最小分叉
- **原生运行创建**（09-15，`add-native-run-creation`，A1）—— 桌面端新建运行入口 `runs:create`
- **缓存记账**（09-15，`add-fork-cache-accounting`，A2）—— 前缀缓存命中/未命中 tokens 与可视化
- **LLM 失败详情**（09-16，`add-llm-error-detail`，A4）—— 失败标记、错误详情区、脱敏落盘
- A3 阶段 1.1 的包层版本门禁（09-16，`version-guard.ts` 等，**无 UI/IPC 入口**）

**工程侧（不改变 exe 交互）**

- **Trace-as-Test**（09-08，`add-trace-as-test`）—— 包 API 与 `rebaseagent-trace-test` CLI，
  **无桌面入口**（已核实）
- **CI 质量门禁**（09-12，`add-ci-gates`）—— 测试 / biome / openspec validate
- **TTFT 计时修复**（09-10，`fix-llm-ttft-timing`）—— 首字延迟统计修正

**不包含**：隔离文件重跑（R1 的 A/B/C 三段均未完成）。隔离运行不得作为本包的卖点。

> **2026-09-17 复核修正**：本节初版只列了 A1 / A2 / A4（+ A3 1.1）三项，**漏列 09-08～09-14 的 6 项**
> （模型 A/B、参数透传、代理分叉、Trace-as-Test、CI 门禁、TTFT 修复）。
> 现按 `openspec/changes/archive/` 于 09-07 之后归档的目录逐项补全，清单以归档目录为准。

## 4. 实机验收（§9.1 第 5 条）—— 已执行

> **2026-09-17 owner 实机验收完成，未发现问题。** 其中第 1、3、5 项另由 §10 的自动化冒烟独立验证。

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 独立测试目录 + 全新数据目录验证首次启动 | ✅ 通过（§10 另行自动验证） |
| 2 | 历史数据**副本**的读取、重启与设置持久化、数据落点 | ✅ 通过 |
| 3 | 离线 Monaco 资源 | ✅ 通过（§10 另行自动验证） |
| 4 | 错误状态展示 | ✅ 通过 |
| 5 | 数据落在 `<exe 目录>/data`，未写 AppData 或注册表 | ✅ 通过（§10 另行自动验证） |

## 5. K0 能力可达性核对表（§9.1 专项清单）

> 记录格式：通过 / 失败 / 未验证 / 包外能力，附操作路径、运行 ID 或脱敏日志。
> 以下为 **2026-09-17 owner 实机验收结果**。

| 已归档能力 | UI / IPC 或实际入口 | 可达性状态 | 验收重点 |
|---|---|---|---|
| 原生运行创建 | 「新建运行」→ `runs:create` | ✅ 通过 | 纯对话根运行创建、落盘、重启读取；配置缺失与调用失败分别记录 |
| 缓存记账 | 运行详情缓存展示 / 运行对比 | ✅ 通过 | 已知缓存用量、未知数据、分支新增/累计口径；缺数据显示未知，不伪装为零命中 |
| LLM 失败详情 | 触发模型失败 → 运行详情 / 步骤错误 | ✅ 通过 | 错误落盘、重启可见、旧记录缺信息状态；保存脱敏错误证据 |
| 模型 A/B | 运行详情 A/B 编辑器 → `runs:modelAb` | ✅ 通过 | dry-run、费用确认、多臂执行与结果分组（详见 §5.2 证据） |
| 代理父本分叉 | 代理运行详情分叉 → `proxy:fork` | ✅ 通过 | 用实际代理录制父本生成新分支（详见 §5.3 证据） |
| provider 参数透传 | 录有扩展参数的代理父本，经已支持分叉路径触发 | ✅ 通过 | 脱敏请求是否保留参数、显式覆盖是否正确（详见 §5.3 证据） |
| Trace-as-Test | `packages/trace-test` 包 API / `rebaseagent-trace-test` CLI | **包外能力**（本次未单独执行） | 无桌面 UI/IPC 入口（已核实）；**不得把 CLI 通过写成 exe 可达**，也不为 K0 新增桌面入口 |

> 六项桌面能力**全部通过**（2026-09-17）；Trace-as-Test 为包外能力，不计入 exe 可达。
> **按 §9.1 的门槛「承诺包含的桌面能力失败或未验证时，K0 不记为验收通过」，本包已达通过条件（见 §5.1）。**

## 5.1 验收结论

**`0.3.0-k0` 通过 K0 验收（2026-09-17）。**

| 层 | 状态 |
|---|---|
| 构建与自动化 | ✅ `release:verify` 通过；`check:ci` 14 passed / 0 failed；packaged 离线冒烟 20 项断言全通过（§10） |
| §4 实机验收（§9.1 第 5 条） | ✅ 五项全部通过 |
| §5 桌面能力核对 | ✅ **6/6**：原生运行创建、缓存记账、LLM 失败详情、模型 A/B（§5.2）、代理父本分叉、provider 参数透传（§5.3） |
| Trace-as-Test | 包外能力，本次未单独执行；**不计入 exe 可达** |

**判定依据**：§9.1 的门槛是「承诺包含的桌面能力失败或未验证时，K0 不记为验收通过」。
该节把 K0 描述为"先给自己使用新建运行、A/B、缓存和错误详情"，加上代理两项共六项，
**均已在 `0.3.0-k0` 实机验证通过**（模型 A/B 与代理两项于 2026-09-17 换真实 key 后补验），故达通过条件。

**记录口径声明（避免"未验证"被静默升级为"通过"）**：

- 六项结论均以**落盘数据**为准（§5.2 / §5.3 逐项给出 run id、字段值与 usage），不只是界面观察
- 代理两项本次只走了**成功路径**；核对表所列"区分缺配置 / 父本不可分叉 / 实现失败"的失败分支
  **未单独触发**，§10 保留了用现有代理 run（`run_mto90h96_qlem.jsonl`，key 已失效）触发"缺配置"路径的方法
- **Trace-as-Test 无桌面入口**（已核实），其 CLI 结论不得计入 exe 可达；本包也未为它新增桌面入口

**不在本包范围**：隔离文件重跑（R1 的 A/B/C 均未完成）。

## 5.2 模型 A/B 补验证据（2026-09-17 12:22，`0.3.0-k0` 实机）

**父 run**：`run_mu2iw4s1`（首轮 `request` 仅含 `model/messages/tools`，无 `params` 字段）。

| 实验组 | 臂 | model / params | 结果 | usage（逐轮） |
|---|---|---|---|---|
| `exp_mu50wm4w_wbmg` | `run_mu50wm4w_y1ua` | `deepseek-chat` / `{temperature:0.3}` | ✅ `stopped/completed` | in 323→416→542, out 54→87→46, cache_hit 128→256→384 |
| `exp_mu50wm4w_wbmg` | `run_mu50wnjl_xjof` | `deepseek-reasoner` / `{temperature:0.9}` | ✅ `stopped/completed` | in 348→435→534, out 458→121→66, cache_hit 0→256→384 |

**同时验证到的点**：

- **多臂执行 + 各臂独立落盘**：两臂各 3 次 `llm.call` + 2 次 `tool.invoke`，均为独立新轨迹
- **同批分组**：两臂 `fork.edit.field = "model_params"` 且 `experimentId` 相同 —— 界面按此分组，
  故分支树"换 model/params（A/B）"标签分组的数据前提成立
- **只换 model/params**：两臂 `config_hash` **逐字节相同**（`sha256:359f20be…`），
  证明 system prompt 与工具表与父 run 一致，未被改写
- **失败批次对照**：`exp_mu50rcwf_0yy6`（12:18，错误 key）两臂均 `errored`、`usage in/out = 0`，
  列表中出现"所有臂均未成功落盘"提示 —— 属预期，换 key 后重跑即成功
- **A/B 差异真实可见**：`deepseek-reasoner` 首轮 `out=458`（推理链长），`deepseek-chat` 仅 `54`；
  两臂 `cache_hit` 曲线也不同（reasoner 首轮 `0`，chat 首轮 `128`）
- **预期噪音（非故障）**：两臂 `read_file` 均报 `a.txt does not exist at D:\k0-test\data\a.txt`
  —— `execCwd` 落数据目录，父 run 当初读的文件不在其中。工具错误属"错误即数据"，臂仍正常落盘

## 5.3 代理父本分叉 / provider 参数透传补验证据（2026-09-17 12:31–12:32，`0.3.0-k0` 实机）

**录制方式**：启用本地录制代理（`127.0.0.1:18787`，upstream `https://api.deepseek.com`）后，
经代理发一次请求，请求体顶层带 `temperature: 0.3` 与 `top_p: 0.9`（即被测的 provider 扩展参数）。

| run | 文件 | 关系 | 结果 |
|---|---|---|---|
| 代理录制（父本） | `run_mu518hse_19eo`（12:31） | `task=(llm-proxy)`、`source.kind=proxy`、`parent=(根)` | ✅ completed |
| messages 分叉 | `run_mu51a1yn_eeay`（12:32） | `parent=run_mu518hse_19eo`、`fork.at_span=s_02`、**`fork.field=messages`** | ✅ completed |

**② 代理父本分叉**：

- **父子关系数据成立**：分叉 run 的 `parent` 指向代理录制 run，`fork.field="messages"` ——
  分支树可据此呈现父子连线
- **源 run 未被修改**：分叉 run 的 messages 为 `说一句再见`，而源 run 仍是 `说一句你好`
  —— 与界面自述"单请求级分叉 · 源 run 不会被修改"一致
- **两 run 均为 `stopped/completed`**：满足界面上「编辑 messages 重发」按钮的出现条件
  （`source.kind==="proxy"` + leaf span + `status==="completed"`）

**③ provider 参数透传**：

| 阶段 | `request.params` |
|---|---|
| 录制捕获（父本） | `{"temperature":0.3,"top_p":0.9}` |
| 分叉重发 | `{"stream_options":{"include_usage":true},"temperature":0.3,"top_p":0.9}` |

- 探针请求体里的两个扩展参数**原样保留**到分叉请求 → 透传成立
- 分叉请求额外带上 `stream_options.include_usage`，与实现一致
  （`buildForkRequest` 恒 `stream:true` 并附 usage 选项；params 平铺回请求体顶层）
- 两次响应 `out` 分别为 15 / 2 tokens（分叉响应正文为"再见。"），确认是真实调用而非回放

**顺带验证到的两点**：

- **key 未落盘**：两个 trace 文件均**不含** `sk-…` / `Bearer …` 痕迹，
  印证「key 仅内存暂存，永不进录制数据 / 日志 / IPC 回传」
- **config_hash 的缺因分支是活的**：两 run 均写 `config_hash_reason="no_system"`
  （探针请求不含 system 消息 → 无法派生指纹），印证 recorder"可派生写 hash、否则写缺因"的双分支设计

**成本**：2 次调用（in 7 / out 15，in 7 / out 2）。

## 6. 已知限制

- 第一版（`0.2.0`）曾与 09-07 正式版同名，只能靠目录与 SHA-256 区分；该问题已由 §9 的 `0.3.0-k0` 重打解决
- 不含隔离文件重跑
- **未上传 Release**：本包是体验包；正式发行需另行准备（明确版本号、README 与发布材料、实包演示）

## 7. 回退方法

- 本包与正式 0.2.0 **完全隔离**：直接删除 `release-k0/` 即可，不影响 `release/`
- 打包前已备份旧产物：`D:\ReBaseAgent\.git\release-backup\`（0.1.0 与 0.2.0 完整副本，哈希与原件一致）

## 8. 构建过程中的坑（复现用）

1. **pnpm 在 Bash 里报 `Cannot find module 'D:\d\nodejs\node_modules\corepack\dist\pnpm.js'`**
   corepack shim 把 MSYS 路径 `/d/nodejs/…` 拼坏成 `D:\d\nodejs\…`（多一层 `d`），而该文件实际存在。
   绕法：`node "D:/nodejs/node_modules/corepack/dist/pnpm.js" <script>`（实测 9.15.9）。

2. **electron-builder 下载 electron 超时**（`Timeout awaiting 'request' for 600000ms`，跑满 10 分钟失败）
   本地虽有完整的 `electron-v44.1.1-win32-x64.zip` 缓存（`%LOCALAPPDATA%\electron\Cache\0ca74001…\`，9-03 下载），
   但 electron-builder 26.15.3 的缓存 key 不匹配，仍去重新下载。
   解法：带国内镜像重跑 ——
   `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
   `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
   耗时从"10 分钟超时失败"降到 **2 分钟成功**。

3. **打包必须覆盖输出目录**：`-c.directories.output=../../release-k0`
   否则产物同名，会**直接覆盖** `release/` 里的正式 0.2.0。

4. `.gitignore` 原有 `release/` 不匹配 `release-k0/`，已补 `release-*/` 规则，避免 94MB 的 exe 被误提交。

---

本次为体验包构建，**未上传 Release**。第二版变更了发行版本标识（见 §9），产品代码未改动。

## 9. 第二版：改用可辨认版本标识（`0.3.0-k0`）

第一版受当时主 spec 的硬约束（「系统 SHALL 将根项目与 desktop 发行包版本设为 `0.2.0`」），
只能用独立输出目录与正式版区分、文件名相同。该约束已由 change
`2026-09-17-allow-versioned-release-identity` 归档解除，主 spec 改为
「发行物使用可辨认且不冲突的版本身份」，并要求应用版本与产物名**同源推导**。

### 产物与验收

| 项 | 值 |
|---|---|
| 路径 | `D:\ReBaseAgent\release-k0\ReBaseAgent-0.3.0-k0-win-x64-portable.exe` |
| 字节数 | **94,351,087**（< 100,000,000，余量 5,648,913） |
| SHA-256 | `8018363be0d6a5159c3ccdebe9dd01d882e63772654aa8bb7799545286ebece5` |
| 构建时间 | 2026-09-17 11:40:46 |
| 提交 | `413bb9a`（归档后；版本提升未提交，见下） |

`release:verify`：**通过**（目标版本 `0.3.0-k0`、期望产物名与实际产物名一致、体积达标、
renderer 源码无违规、editor/json worker 就绪）。

### 切版本的实际改动面

**只改了 `apps/desktop/package.json` 的 `version` 一处**（根 `package.json` 同步仅为仓库标识一致，
发行验收不读它）。改动前先做了一次反向实测，确认期望值确实来自应用包而非硬编码：

```
对旧的 0.2.0 产物执行 release:verify（此时应用包已是 0.3.0-k0）：
  目标版本  : 0.3.0-k0
  期望产物名: ReBaseAgent-0.3.0-k0-win-x64-portable.exe
  实际产物名: ReBaseAgent-0.2.0-win-x64-portable.exe
  文件名    : ✗ 与期望产物名不符
  应用版本  : ✗ 产物名声明的版本为 0.2.0，与目标版本 0.3.0-k0 不一致
  退出码: 1
```

这一次同时验证了新 spec 的两条要求：版本与产物名不一致时失败并报告期望/实际值；
既有版本产物不被误报为本次结果。

### 隔离性与回归

- `release/` 两个正式产物哈希**未变**（0.1.0 `47b9aea2…`、0.2.0 `cd2e1c94…`）
- `release-k0/` 现有两版共存且**文件名不同**（`0.2.0` 与 `0.3.0-k0`），无需再靠目录区分
- `check:ci`：**14 passed / 0 failed**；desktop build 16.13s

### 验收状态

§4 五项人工验收与 §5 六项能力核对**均已在 `0.3.0-k0` 上完成并全部通过**（结论见 §5.1，
逐项证据见 §5.2 / §5.3）；自动化部分由 §10 覆盖。

## 10. 自动化验收：packaged 离线冒烟（2026-09-17）

对 `0.3.0-k0` 产物运行 packaged 模式离线冒烟 —— 脚本
`.workbuddy/smoke-monaco-slim/packaged-offline-smoke-k0.mjs`（由 09-07 的同名脚本适配路径而来）。

**做法**：把 exe 复制到无 marker / 无指针的临时目录 → 隔离 `APPDATA` 与 `LOCALAPPDATA` 启动 →
**拦截全部非 localhost 请求**（比"拔网线"更严格）→ 经 CDP 驱动界面断言 → 按 PID 收尾。

**结果：20 项断言全部通过（`PACKAGED_OFFLINE_PASS`）**

| 覆盖的验收项 | 证据 |
|---|---|
| 首次启动不弹目录选择 | 主界面 `aside` 就绪即通过，全程无目录选择交互 |
| 数据落点 | 同级 `data/` 自动创建，含 `traces/`、`userData/`、`sessionData/` |
| 不写 AppData / LocalAppData | 隔离目录下**零** ReBaseAgent 产品目录 |
| 离线 Monaco 资源 | 全部非 localhost 请求被拦截的前提下，JSON 编辑器语法高亮（3 种 mtk 类）与纯文本编辑器（1 种）均正常 |
| 其他界面能力 | 预算地图 canvas、分支树 SVG、轨迹详情渲染正常 |
| 本地代理 | 启动 / 端口可见 / 状态查询 / 停止 / 再次启动全部正常；代理运行中 Monaco 与预算地图不受影响 |
| 错误与外部请求 | **零 page / console 错误、零非 localhost 外部请求** |

**这一步已替代 §4 的第 1、3、5 项以及第 4 项的一部分。**

**踩坑（复现用）**：WorkBuddy 沙箱环境**固有 `ELECTRON_RUN_AS_NODE=1`**。直接 spawn 该 exe 会让
Electron 退化为纯 Node 模式 —— 不开窗口、不开 CDP 端口，冒烟脚本只报
`portable CDP 120s 未就绪`，看不出真因。**spawn 前 `delete env.ELECTRON_RUN_AS_NODE`
（连同 `NODE_OPTIONS`）并加 `--disable-gpu`** 后 18 秒跑完。

**冒烟未覆盖、后由人工验收补齐的部分**：

- §4 第 2 项：历史数据**副本**的读取、**重启持久化**、设置持久化
- §5 表中：原生运行创建、缓存记账、模型 A/B、代理父本分叉、provider 参数透传
- §5 中「LLM 失败详情」需真实触发一次模型失败（**用故意错误的 key 即可，401 不计费**）

> 以上三项均已由人工验收完成，结果见 §5.1；模型 A/B 与代理两项的落盘证据见 §5.2 / §5.3。

### 验收素材（2026-09-17 从现有 trace 中清点挑选）

`.rebaseagent/traces/` 共 **49 个** trace（清点脚本 `.workbuddy/trace-inventory.cjs`，可复用）。
按验收点挑出 6 个复制进测试目录的 `data/traces/`：

| 文件 | 为什么选它 |
|---|---|
| `run_mu2iw4s1.jsonl` | **49 个里唯一含真实缓存数据**（`"usage":{"in":323,"out":54,"cache_hit":128,"cache_miss":195}`）⇒ 验 A2 缓存记账非它不可 |
| `run_mu2iw6hw_a3ly.jsonl` | 上者的**子运行**（有 `parent`）⇒ 凑成父子对，顺带验运行对比 |
| `r_03.jsonl` | 3 步工具、**JSON 工具结果** ⇒ 验 Monaco 语法高亮与"修改后重跑" |
| `r_01.jsonl` | 2 步工具、**纯文本（markdown）结果** ⇒ 验 Monaco 纯文本路径 |
| `tree_r00.jsonl` + `tree_r01.jsonl` | 分支树 fixture 的**父与子** ⇒ 两个就能看出树与分支对比 |

可选加料：`tree_r02~r05`（把树撑到 1 父 5 子）、`run_mto90h96_qlem.jsonl`（代理录制的 run，
**验"代理父本分叉"要用这类**）、`run_mtw9u98x_jktq.jsonl` + `run_mtw9ua3v_nsv5.jsonl`
（11KB，AniPedia dogfood 真实父子对）。
**避开** `tmp-measure-*.tmp` —— 那是临时文件，不是 run。

**两项现有数据无法覆盖、必须新造**：

- **LLM 失败详情（A4）**：49 个 trace 中**一条都没有**（A4 于 9-16 归档，而数据最新到 9-15）
- **缓存记账的"有数据"分支**：仅 `run_mu2iw4s1` 有。其余 run 的 `usage` 只有 `in`/`out`，
  界面应显示"未知" —— 这正好可以顺手验 A2 的另一条要求**「缺数据显示未知，不伪装为零命中」**

### 设置持久化验收 · 具体操作（2026-09-17 核对 UI 源码后补充）

**入口**：顶部栏**最右**的「运行配置」按钮（左侧圆点：灰 = 未配置、绿 = 已配置）。
点开即「运行配置（LLM 接入）」对话框。

**设置里实际只有两组**（据 `SettingsDialog.tsx`）：

- **运行配置**：`baseURL`（须合法 URL）、`apiKey`（已配置后留空 = 保持原值）、`model`（不能为空）
- **本地录制代理**：启用勾选、端口（默认 18787）、upstream（默认 `https://api.deepseek.com`）；
  「保存并应用」，启停即保存

**没有主题 / 语言 / 字号等 UI 偏好** —— 验持久化只能用上面两组。

**步骤**：

1. 双击 exe → 点顶部「运行配置」
2. `baseURL` 填 `https://api.deepseek.com/v1`；`model` 填 `deepseek-chat`；
   **`apiKey` 首次必须填非空** —— 建议直接填 `sk-invalid`：保存不做真实性校验，
   且顺便完成 §4 第 4 项的失败详情验证（401 不计费）；想同时验真实调用就填真 key。
   实现依据：`main/settings.ts:96-102` —— 输入空串时回退到**已保存的**值，仍为空则抛
   「apiKey 不能为空（清空请用"清除配置"）」。**注意 `shared/ipc.ts` 的
   `SettingsInputSchema` 里 `apiKey` 只要求 `z.string()`，光看 schema 会误判为可空**
3. 点「保存」→ 预期出现灰字「已保存。此后"在此重跑"将使用该配置发起真实调用。」，顶部圆点转绿
4. 点「关闭」
5. 看 `D:\k0-test\data\settings.json`：应含上述 `baseURL` 与 `model`；
   `apiKeyEncrypted: true` 表示系统加密生效（若为 false 或缺失，记录该环境问题）
6. **完全关闭应用** → 重启 → 再点「运行配置」：`baseURL` 与 `model` 应回填；
   **`apiKey` 框应为空**（"apiKey 只进不出"的设计，不是缺陷）；顶部圆点应仍为绿
7. （可选加固）把 `model` 改成 `deepseek-reasoner` → 保存 → 重启 → 应显示新值，`settings.json` 同步变化

⚠️ **不要点「清除配置」** —— 它会连 apiKey 一起删除，不可恢复。

### 补验流程（操作记录 · 六项均已完成）

> ① 模型 A/B 已于 2026-09-17 补验通过，证据见 §5.2；以下 ① 保留为操作记录。

**① 模型 A/B**

1. 打开任一 run 的详情，拉到底点蓝色按钮「**模型 A/B 实验（换 model / params 对比）**」
2. 展开后是「模型 A/B 实验 · 同上下文多臂对比」：每臂填 `model` + `params`；
   `params` 留空 = 沿用父 run；可「+ 加一臂（最多 4）」；面板会显示「父 run：<model> <params>」
3. **每臂都必须与父 run 有差异**（改 model 或改 params 皆可，二者全同即被拒）。
   内核判据在 `packages/replay/src/model-replay-run.ts` 的 arm 校验段（逐臂），
   renderer 侧 `lib/model-ab.ts` 只在「所有臂都相同」时才拦 —— **两层判据不一致**（见下方"已发现的缺陷"）。
   最稳填法：**两臂都只动 params**（如 `{"temperature":0.3}` / `{"temperature":0.9}`），
   不依赖其它 model 名是否存在
4. 点「**校验并预览计划**」→ 出现「**校验通过 · 执行计划**」+ 实验组 ID + 各臂计划行。
   面板底部自述：**dry-run 不联网、不写文件**；真实执行按臂数产生费用
5. 想零成本再进一步：保持错误 key 点「**确认执行（N 次真实调用）**」→ 各臂 401 失败且**不计费**，
   可验「单臂失败不影响其它臂」（产物提示"所有臂均未成功落盘"）
6. 要验「各臂成功落盘 + 分支树按'换 model/params（A/B）'标签找到同批节点」则需**真实 key**

**换真 key 后为何能直接执行（2026-09-17 源码核实）**：

- **key 来自"运行配置"而非父 run 捕获的 key**：`main/ipc.ts:176` 传 `settings: loaded`，
  经 `buildForkConfig`（`main/fork-runner.ts:150`）拼出 `RunConfig`，内核读 `config.apiKey`
  （`model-replay-run.ts:387`）。所以**父 run 的 key 早已不在内存也不影响** —— 换 key 即生效
- **不存在配置不一致风险**：`buildForkConfig` 从父 run **首次 llm.call 的录制**重建
  `systemPrompt`（取 messages 里的 system 字符串）与工具表（取 `request.tools`，缺省视为空表），
  **只有 baseURL / apiKey / model 来自当前设置**。因此 `config_hash` 必然与父 run 一致，
  不会撞 `CONFIG_MISMATCH`
- **工具门禁会放行**：`run_mu2iw4s1` 首轮录制 tools = `[read_file]`，且**带 `sideEffect: false` 标记**
  （已逐字段核实）。`assertToolPolicy` 只对 `sideEffect !== false` 的工具报错，故不触发 `TOOL_POLICY`
- **dry-run 走不走到工具门禁**：arm 校验（`model-replay-run.ts:300-307`）在 `assertToolPolicy`（:322）
  **之前**，所以先卡臂、后卡工具；两者本样例均放行
- **成本极小**：父 run `run_mu2iw4s1` 仅 323 in / 54 out（含缓存字段），2 臂即 2 次调用
- **预期现象**：重放首轮请求含 `read_file`，模型可能再次发起读文件；`execCwd` 落在**数据目录**
  （`ipc.ts:43-44`），数据目录里没有父 run 当初读的那两个文件，因此**工具很可能返回错误**。
  这不影响验收点 —— provider 与工具错误都"错误即数据"，臂**仍会正常落盘**。
  想避免这层噪音，可改用无工具父本（如 `run_mtv8nqy6_wf3c.jsonl`，空工具表），但需两臂都换 model
- **确认框可核对 baseURL**：文案为「将按 N 个臂真实调用 <settings.baseURL> 并产生费用」
  （`DetailPanel.tsx:533`），据此可确认用的是改后的配置
- 若之前已用错误 key 执行过，列表里会留下"所有臂均未成功落盘"的记录，属正常，忽略即可

**② 代理父本分叉 / provider 参数透传**（需真实 key）

1. 「运行配置」保持可用 → 在「本地录制代理」区勾选「**启用代理**」、端口 18787、
   upstream `https://api.deepseek.com` → 点「保存并应用」（顶部出现「代理 :18787」）
2. 经代理发一次请求（**key 一字不动**，**必带 `--noproxy '*'`** 绕开本机 HTTP_PROXY）：

   ```bash
   curl -sS --noproxy '*' http://127.0.0.1:18787/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <真 key>" \
     -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"说一句你好"}],"temperature":0.3}'
   ```

3. 刷新运行列表 → 出现新代理 run（task 为 `(llm-proxy)`）→ 打开 → 选中 `llm.call` 详情
4. 应见「**单请求级分叉 · 源 run 不会被修改 · 重发使用最近捕获的 key**」→ 编辑 messages → 重发
   → 生成分叉 run（分支树可见父子连线）
5. **provider 参数透传**：第 2 步请求体里的 `temperature: 0.3` 应在详情「原始请求」中**保留可见**
6. 用完后取消勾选「启用代理」并「保存并应用」

> 若改用**历史**代理 run（如 `run_mto90h96_qlem.jsonl`）只能验**入口可达**与「缺 key」提示 ——
> 其捕获的 key 早已不在内存，重发会失败；这正好对应核对表里「区分缺配置 / 父本不可分叉 / 实现失败」
> 的记录要求。分叉点的前提（源码 `DetailPanel.tsx:728`）：run 来源为 proxy、span 属自身段、run 已封存。

**③ Trace-as-Test**（包外能力，不计入 exe 可达）：想留一条独立记录就跑其单元测试 ——

```bash
node "D:/nodejs/node_modules/corepack/dist/pnpm.js" --filter @rebaseagent/trace-test test
```

### 验收过程中的发现（2026-09-17）

**模型 A/B 的双层校验语义不一致（renderer 与 replay 内核）**

- **现象**：按「臂 1 沿用父 run、臂 2 改 model」填写时，renderer 侧**放行**（按钮可点），
  但提交后报
  `第 1 个 arm 不合法：空 fork 被拒绝：model 与采样参数都与父 run <id> 相同，模型配置无变化`，
  **整批被拒**（零文件、零调用）。
- **根因**：两层判据不同 ——
  - renderer `apps/desktop/src/renderer/src/lib/model-ab.ts:136-143`：仅当 `arms.every(sameAsParent)`
    （**所有**臂都相同）才拦截；
  - replay 内核 `packages/replay/src/model-replay-run.ts:291-311`：**逐臂**调用 `derivePromptForkState`，
    任一臂无变化即整批 `INVALID_ARM`（消息源自 `packages/replay/src/prompt-fork.ts:264`）。
- **附带**：`model-ab.ts:6` 的注释声称「main 与 replay 内核仍有**同语义**校验兜底（双保险）」，与实际不符。
- **实际规则（以内核为准）**：**每一臂都必须在 model 或 params 上与父 run 有差异**；
  臂与臂之间是否相同不受此判据约束（但相同臂做实验无意义）。
- **可用配置示例**：臂 1 = `deepseek-chat` + `{"temperature": 0.3}`；
  臂 2 = `deepseek-chat` + `{"temperature": 0.9}`（或臂 2 改 `deepseek-reasoner`）。
- **修复方向（未实施）**：把 renderer 判据改为逐臂，与内核对齐（或反之放宽内核）——
  两者取舍需单独 change 决定。这是本包验收暴露的**既有问题**（非 K0 引入），不影响 K0 验收结论本身。
- **→ 已修复（2026-09-20）**：取"renderer 判据改为逐臂"一路，并顺带发现**第二处更严重的漂移**——
  批次级副作用确认**从未作为声明下发到 arm**（内核判据是 `arms.every(allowSideEffects === true)`），
  即"勾了确认框也必被 `TOOL_POLICY` 整批拒绝"，逃生舱实际不可用。现 renderer 判据与内核同粒度，
  并由 `apps/desktop/test/model-ab-guard-parity.test.ts` 锁定（"guard 放行 ⟹ 内核 dry-run 不拒"）。
  内核口径未改，故无 spec delta；本报告上文的"未实施"仅反映 09-17 当时状态。

