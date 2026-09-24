# U2 `improve-workspace-file-reading` 验收清单（owner 逐项确认）

> 质量门禁（任务 6.1–6.3）之后的**验收阶段**回执。
> 本文件用于让 owner **逐项**确认，**不是**默认填「通过」——
> 纪律来源：skill `openspec-change-apply` §5「验收记录要逐项确认，别拿笼统回答填『通过』」。
>
> **本清单本身不是放行凭据**。逐项确认 + owner 明确同意归档后，才轮到归档动作
> （归档**只由 owner 拍板**，本 change 不自动归档）。
>
> **验收方式（owner 2026-09-24 选定）**：由 agent 起 dev、在**当前 HEAD** 复跑代表 tag 取证。
> 记录基线：`main@1b453b7`（U2 全部实施与门禁已提交，**待 push 11 个提交**；本次验收的改动另计）。

## 0. 验收对象与范围

| 项 | 内容 |
| --- | --- |
| 验收对象 | change `improve-workspace-file-reading`（U2）· 唯一 delta = `specs/desktop-ui/spec.md` 的 **6 requirements / 35 scenarios** |
| 实施状态 | `tasks.md` **26/26 全勾**（1.1–6.3） |
| 证据 | `evidence-index.md`（**35/35 覆盖 / 0 未验证**）+ 6 份任务级验收 README + **本次 HEAD 复跑（下方 §3）** |
| **不在本次范围** | ① **发行打包**：产物名/体积/身份三项门禁**未执行**（6.2 明写不安排 ⇒ 归 K1/K2/K3）；② **U3–U8**：本 change 一个都不宣称；③ **U1**：已归档（`4628b80`），非 U2 范围 |

### 两类"最容易被糊过去"的项（按纪律先标清）

- **要花真钱的 ⇒ 本 change 无。** U2 是**只读**文件阅读改造，**全程零真实模型调用**：夹具由**本地真引擎**
  （`apps/desktop/scripts/gen-u2-*.cjs`）产出，验收复跑也不含任何真实 API 调用。
  ⚠️ 但由此有一条**要说清**：「既有执行入口仍可达」（5.6 `compat`）**只验了可达性**，
  **没有真的执行一次创建/重跑**（那会花真钱）——执行业务属 U4/U5 范围。
- **界面点不到的 ⇒ 2 类。** ① **文件读取 IPC 拒绝越权**（5.5 `ipc-guard`）走 `window.api` 直调，
  界面**没有**入口；② **只读不变性**（逐文件 SHA-256 前后一致）**肉眼看不到**。
  这两类**只能追认证据**（见 §3），不接受"我点过了感觉没事"。

## 1. 前提：怎么起（约 1 分钟）

```bash
# 起 dev（带 CDP 9612）
node apps/desktop/scripts/u2-dev-host.cjs
# 停
node apps/desktop/scripts/u2-dev-host.cjs --stop
```

- ⚠️ **必须非沙箱**起（Electron 要写 `%APPDATA%\@rebaseagent\desktop\Local Storage`）。
  ⚠️ 但 `u2-dev-host.cjs` 的 detached 子进程在本宿主里**会随启动它的工具调用结束被回收**（本次实测）
  ⇒ 可靠做法是**用宿主托管的后台任务**直接跑 `cd apps/desktop && NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9612`。
- 数据目录恒为 `<仓库根>/.rebaseagent`（当前 **71 个 run**，含 5.5/5.6 生成的隔离谱系与异常标本）。
- 本机真值：CSS 视口 **1208×837 ~ 1220×723**、DPR **2.1**。
- ⚠️ **跨 run 的操作必须在 ≥960 档**：`<960` 档运行列表**无 UI 入口**（`navOpened` 缺调用方，**属 U1 范围**）。
- 改窗用 `.workbuddy/ps-win.ps1`（`MoveWindow`，会先 `SW_RESTORE`）；
  ⚠️ **不要**用 CDP `Emulation.setDeviceMetricsOverride` 伪造视口（会让 Monaco `automaticLayout` 产出 36px 伪影）。
  ⚠️ **边界档位要精确**：目标 CSS 800 对应外框 **1133**（1134 → 实测 801 ⇒ 会被判成"非窄档"而误报，本次实测踩到）。

## 2. A 类：owner 亲手走的代表路径 —— 已在 HEAD 复跑，结果如下

> 每条都挑自"本 change 实机抓出过真实缺陷 / 或最容易被表面现象骗过"的位置。
> 「不符意味着」列写明：如果看到的不是期望，**说明哪条 spec 义务不成立**。

| # | 怎么走 | 期望看到 | HEAD 复跑结果 | 场景 |
| --- | --- | --- | --- | --- |
| A1 | 冷启动（或冷重载）后，选多轮隔离 run → 切「**文件**」页签（本会话首次） | 检查点落在**最近自有完成步骤**（「本 run 第 2 轮结束」），**不是**「本 run 初始状态」；内容区立刻呈现真实差异 | ✅ `first-enter` **3/3**（新增专项 tag：先断言 `entered=false` 确实是首次，再断言落到「第 2 轮」且 `checkpoint !== null`） | 首次文件页选择最近自有完成步骤 |
| A2 | 夹具 `run_mue9rvkh_i9oil7` → **第 2 轮**（初始侧 binary / 所选侧 text）；再用 `u2side_mirror` **第 1 轮**验左右互换 | **看得到**可读侧的**完整正文**（只读单侧视图）；不可用侧标「二进制文件」+ 真实大小/完整哈希；可读侧复制/查找/换行**可用**、不可用侧**禁用并给原因** | ✅ `sides` **9/9**（含 A1/B1 两型逐条对称） | 不可用侧不伪装为空差异 |
| A3 | 同夹具 `run_mue9rvkh_i9oil7` → **第 1 轮**（两侧皆 binary） | 分别说清**两侧各自**状态；**一个编辑器都不渲染**；**不宣称**"无变化/文件为空"；元信息仍可复制 | ✅ `both-unreadable` **5/5** | 两侧都不可读时没有伪空编辑器 |
| A4 | 窗口缩到 **CSS 800**（外框 1133）；再试 **640** | 目录**一律收起**、diff 强制 inline、正文仍可读、**无整页横向滚动**、字号不缩（13px） | ✅ `800-narrow` **12/12**（CSS 精确 800）+ 5.1 `800` **12/12**（实测目录常驻=false）+ `640` **12/12**（文字区 481） | 极窄与放大后仍可阅读 |
| A5 | 宽档把目录拖宽（→280）+ 点「收起目录」→ 缩到 800 → 放回宽档 | 回宽档后**仍收起**（自动降级未写回偏好）；点「展开目录」后**宽度复原为 280**（非默认 232） | ✅ `prefs` **5/5** → `prefs-narrow` **4/4** → `prefs-restore` **3/3**（含 ★「偏好复原 + 宽度 280 还原」） | 手动布局偏好不被自动折叠覆盖 |
| A6 | 复制**路径/两侧原文/元信息**；查找；切换行；点「上一/下一差异」 | 原文复制为**完整原文**（非省略显示）；元信息是**真实大小 + 完整 64 位哈希**；查找作用**当前**文件；0 差异/inline/不可比较时导航**诚实禁用** | ✅ `tools-copy` **9/9**、`tools-find` **9/9** | 复制路径原文及元信息 / 查找换行和差异定位使用当前文件 / 不可比较或未就绪时工具诚实禁用 |
| A7 | ①文件→步骤→文件 ②步骤页「打开该轮文件」③切到别的 run 再切回（≥960 档） | ①回同一检查点/路径/滚动位置 ②跳到该轮文件 ③两 run 同名文件互不影响 | ✅ `roundtrip` **8/8**、`explicit` **5/5**、`cross-run` **9/9** | 环绕恢复三条 |
| A8 | 切检查点到一个**不含所选文件**的轮次；再搜索/筛选把当前文件隐藏 | 前者**明说失效**并回退默认（不偷偷换同名路径）；后者**保留**内容区标题与阅读状态 | ✅ `fallback` **9/9**、`search-hidden` **5/5** | 失效检查和路径安全回退 / 筛选不偷换当前文件 |
| A9 | 键盘：列表 `Home/End/↑↓`、检查点 `Enter`、分隔条 `←/→`、换行 `Enter`、查找 `Esc`；断网后重开文件页 | 键盘全生效且**焦点跟随/回编辑器**；断网仍渲染 diff（Monaco 本地懒加载） | ✅ `keyboard-offline` **10/10**（资源 host 只有 localhost） | 文件阅读键盘操作与离线加载 |

## 3. 本轮 HEAD 复跑：26 个 tag、**210/210 通过**

证据落 `docs/reviews/2026-09-24-u2-acceptance/`（**59 张新截图**，按任务分目录）+ 原始日志 `.workbuddy/u2-acc/acc-*.log`。

| 任务 | 复跑 tag（checks） | 小计 |
| --- | --- | --- |
| 5.1 | `1210` 12 · `1024` 12 · `800` 12 · `640` 12（含每档「同视口响应容器变化」） | **48** |
| 5.2 | `800-narrow` 12 · `prefs` 5 · `prefs-narrow` 4 · `prefs-restore` 3 | **24** |
| 5.3 | `roundtrip` 8 · `cross-run` 9 · `explicit` 5 · `search-hidden` 5 · `fallback` 9 | **36** |
| 5.4 | `sides` 9 · `both-unreadable` 5 · `tools-copy` 9 · `tools-find` 9 · `race-retry` 12 | **44** |
| 5.5 | `ipc-guard` 11 · `unavailable` 8 · `errored` 6 · `readonly` 12 · `selfcheck` 3 | **40** |
| 5.6 | `keyboard-offline` 10 · `compat` 5 · **`first-enter` 3（新增）** | **18** |
| **合计** | | **210/210** |

**B 类（界面点不到）已含在上述复跑中**：`ipc-guard`（`window.api` 直调 + 哨兵文件零泄漏 + 对照项确实成功）
与 `readonly`（浏览前后逐文件 SHA-256 `diff=[]`、`traces 70→70 / blobs 21→21`）；
`selfcheck` 3/3 是"判据有牙"自检（故意制造"新增/哈希变化"再还原）。

**未复跑、沿用 09-23 原始证据的部分**（如实列出，未冒充已复跑）：

| 未复跑项 | 原 checks | 原因 |
| --- | --- | --- |
| 5.1 `1440` / `1360` 两档 | 24 | 需再改两次窗口；本次已复跑 4 档（含 1210/1024/800/640），宽档侧另有 5.2 `prefs`(1208) 覆盖 |
| 5.2 `zoom2` | 13 | 需以 `REBASEAGENT_ZOOM_FACTOR=2` **重启** dev（属"真 zoom"专项） |
| 5.2 `offline` | 5 | 与 5.6 `keyboard-offline`（已复跑 10/10）重叠：后者已断言 `offline=true` 下仍渲染 diff |
| 5.2 `640-single` | 12 | 与 5.1 `640`（已复跑 12/12）同档 |
| 5.6 `restart-state` | 9 | **本环境不可复跑**（见 §4 H-2）；A1 已由新增 `first-enter` 单独覆盖 |
| 5.6 `migrate` | 10 | 需**改名整个数据目录**；风险不必要（5.6 已实测，且三处 rename 在 `finally` 还原） |

## 4. 复跑暴露的 3 项发现（2 项已修，1 项如实记录）

> 这 3 项都是**验收工具/环境**层面的，不是产品缺陷——但它们解释了"为什么 09-23 的证据不能直接当 HEAD 证据"。

| # | 发现 | 性质 | 处置 |
| --- | --- | --- | --- |
| **H-1** | **5.3/5.4 的 CDP 取证脚本 needle 只认 `/src/renderer/src/...` 形态**，而 `electron.vite.config.ts` 的 renderer `root` = `src/renderer` ⇒ 应用侧真实 URL 是 `/src/...` ⇒ 脚本**匹配不到模块、直接抛错，不可复跑**（5.5/5.6 后来已用候选数组规避） | 取证脚本缺陷（非产品） | ✅ **已修**：5.3/5.4 均改为候选数组 + 排序（`?t=` > 常规 > `/@fs/`），与 5.5/5.6 对齐；修后 5.3/5.4 全量复跑通过。⚠️ 含义：**09-23 的 5.3/5.4 证据由当时能跑通的版本产出、结论有效，但提交版脚本当时已不可复跑** |
| **H-2** | **脚本内 `spawn` 起 dev 在本环境起不来**（detached 子进程随父脚本退出被回收）⇒ `restart-state` 的"停→起→重连"必失败 | 环境限制 | ✅ **已补**：给 5.6 增加独立 **`first-enter`** tag——不做进程重启，只依赖 main() 的**冷重载**（文件阅读状态是 zustand 内存态 ⇒ 重载等价于"本会话首次进入"），3/3 通过；`restart-state` 保留不删（仍是更强证据，换环境可跑） |
| **H-3** | **窄档是 1px 敏感的**：外框 1134 → CSS **801** ⇒ `NARROW_TIER_MAX=800` 不含它 ⇒ 目录不收起（首次跑 `800-narrow` 得 11/12，报"目录一律收起"失败） | 采集口径（非产品） | ✅ 已按实测 CSS 视口重跑（外框 **1133** → CSS 恰好 800）⇒ **12/12**。⚠️ 含义：基准档位必须以**实测 CSS 视口**为准，不能只看外框标称值 |

## 5. D 类：4 条的处置与结果（owner 2026-09-24 拍板：**D-1/D-2/D-3/D-4 全部补齐**）

> owner 选择"全部补齐"（不是接受为已知限制）。以下逐条记录**做法与结果**；证据同 §3 的验收目录。

| # | 项 | 处置 | 结果与证据 |
| --- | --- | --- | --- |
| **D-1** | **列表滚动**的实机证据力弱（5.3 当轮夹具清单只可滚 2px ⇒ `scrollTop` 恒 0，断言落在"不足一屏"的宽免分支里通过） | ✅ **已补齐** | 新造**长清单夹具**（`gen-u2-acc-list-fixtures.cjs`，61 项清单）＋新 tag `u2-53-cdp.cjs --tag=list-scroll`。实测：清单 `scrollHeight 2862 / clientHeight 400 / 61 行` ⇒ **确实可滚**；真滚轮后 `store.listScrollTop=1200 / DOM 实测=1200`；**文件→步骤→文件往返后 `store=1200 / DOM=1200`（页签=文件）** ⇒ **5/5 通过**。截图 `u2-acceptance/u2-53/list-scroll-{1,2,3}.png` |
| **D-2** | **1.1 生成器的坏标本**：`u2bad_noownsteps` 的 `fork.at_span` == `resume_after_step`（step id）⇒ 经运行列表读取必被 `resolveBranch` 拒 | ✅ **已补齐** | 生成器改为取**该轮内真实 `tool.invoke`** 作 `at_span`；重生成夹具；并把 `u2-file-fixtures.test.ts` 的自检从"只 `readRun`"改为**显式调 `resolveBranch`**。**先证明有牙**：不重生成时新用例直接变红，报 `fork.at_span 不能等于 resume_after_step（s_01）…` ⇒ 证明旧标本确实是坏的；重生成后 **39/39 通过**。`evidence-index.md` §已知限制 2 可关闭 |
| **D-3** | **系统级原生 DPI 未独立实测** | ✅ **已补齐**（**应用级强制 scale factor**，见下方"方法与被测范围"） | 主进程新增 pre-ready 钩子 `REBASEAGENT_FORCE_SCALE_FACTOR`（**未设置时不注入，生产行为不变**；与既有 `NO_SANDBOX`/`REBASEAGENT_ZOOM_FACTOR` 同款、非授权开关）。三档实测（`dpi-probe.cjs`，证据 `u2-acceptance/dpi/`）：<br>· **125%** ⇒ 视口 1343×794、DPR **1.25**、有效文字区 682、无整页横向溢出<br>· **150%** ⇒ 视口 1346×801、DPR **1.5**、隐藏层 43 + 有效文字区 **685**、无溢出<br>· **300%** ⇒ 视口 847×493、DPR **3**、**模式=inline**（`original=121` 是 Monaco 隐藏层）⇒ 有效文字区 **450**，无溢出（847 属 801–959 过渡带，spec 不要求 480 ⇒ 合规）<br>⇒ 三档**均正常渲染、正文可读、无空白页、无整页横向溢出** |
| **D-4** | **发行打包三项门禁（产物名/体积/身份）未在本 change 执行** | ✅ **已补齐** | owner 定 **`0.3.0-k1`**（体验包 → `release/preview`），**只做三项门禁 + 离线冒烟，不碰 tag、不上传 Release**。产物 **`ReBaseAgent-0.3.0-k1-win-x64-portable.exe`** = **95,439,340 B**（< 100 MB ✓），SHA-256 `d34687851fbb7263877d4fbc7cd2fcf01fbb2c1413dd604b6690e9bfd4f280a8`。<br>① 构建：`check:build` EXIT=0 + `electron-vite build` EXIT=0；② 打包：electron-builder **离线 electronDist**（日志含 `using custom unpacked Electron distribution` ⇒ 零下载）EXIT=0；③ **`release:verify` EXIT=0**：产物名 ✓ / 应用版本 0.3.0-k1 ✓ / 体积 ✓ / **renderer 源码违规 无** ✓ / worker 集合 editor+json ✓；④ **打包后强制离线冒烟**：`PACKAGED_OFFLINE_PASS` + EXIT=0（**零非 localhost 请求**）。<br>旧产物未被覆盖：`…-0.3.0-k0-a3.1…` 仍为 `5ba04a00…`（与 09-21 记录一致）、`release/stable` 未动 |

### D-3 的方法与被测范围（**如实标注边界**）

- 做法：`app.commandLine.appendSwitch("force-device-scale-factor", X)`，**在 `app.whenReady()` 之前**注入
  （ready 之后再调无效）。走的是与 OS 缩放**同一条** `devicePixelRatio` 路径，**区别于** `setZoomFactor`
  的页面缩放（后者是 5.2 的 `zoom2` 档，DPR 4.2）。
- ⚠️ **未改系统设置**：真改 OS 缩放会影响整台机器、多数情况还要重新登录，本环境不做。
  若需要"真 OS 缩放"的等效证据，可另找时间改一次系统缩放，其余照本探针复测即可。
- ⚠️ 探针自写的"inline/并排"判定读的是 `.monaco-diff-editor` 的 `side-by-side` 类名，
  **未与 5.1 的同款判定方式交叉核对** ⇒ 该字段仅作参考，不作验收断言；断言只打在
  "编辑器在场 + 有效文字区 > 0 + 无整页横向溢出 + 页签含文件"上。
- ⚠️ 视口与 scale 因子**不是简单的反比**（125% → 1343、150% → 1346，几乎相同），
  说明窗口物理尺寸本身也参与了取值 ⇒ **基准档位一律以实测 CSS 视口为准**（同 §1 的 1px 提示）。

### D-4 打包记录 与 ⚠️「离线冒烟脚本已过时」的发现

**打包链（全部 EXIT=0）**：`check:build` → `electron-vite build` → `electron-builder --win`
（`-c.directories.output=../../release/preview` + `-c.electronDist=.rebaseagent/electron-dist`，
先 `unset *_proxy`）→ `release:verify` → 打包后离线冒烟。日志落 `.workbuddy/u2-acc/d4-*.log`。

⚠️ **发现：既有的「20 项断言」离线冒烟脚本已大面积过时**（`.workbuddy/smoke-monaco-slim/packaged-offline-smoke-k0.mjs`，
最后修改 **09-21**，即 **U1 三栏改造之前**）⇒ 它对 k1 包**必然失败**，而那**不代表包有问题**。实测三例过时判据：

| 旧脚本判据 | 现状 |
| --- | --- |
| `document.querySelector("section.w-96")`（6 处） | 源码里 **`w-96` 已完全移除**（U1 三栏改造后详情不再固定 384px） |
| 文案「在此重跑（时间旅行）」 | 现为「**在此重跑（隔离续跑）**」 |
| 文案「LLM 调用」 | 渲染层已无此字符串（旧详情标签） |

⇒ 已新写 **`packaged-offline-smoke-k1.mjs`（v2，当前 UI 口径）**并**跑通**：
`✓` 同级 data 落点 3 项 + 隔离 AppData/LocalAppData 各 1 项 + 名单 2 条 + `r_03` 可按 `aria-label` 定位 +
页签为「概览/步骤」且**无伪文件页** + 步骤页可选中工具调用 + 工具详情有「在此重跑*」入口 +
**Monaco 离线挂载** + **零非 localhost 请求** ⇒ **`PACKAGED_OFFLINE_PASS` / EXIT=0**。

⚠️ **未做（如实列出）**：① 旧 20 项脚本**尚未按当前 UI 重写**（我只写了 v2 替代链路；旧脚本的其余断言——
JSON/纯文本 token 类数、ECharts 预算地图、代理启停等——**未逐条迁移**）；② **未打 tag、未上传 Release**
（owner 明确"只做三项门禁 + 离线冒烟"）；③ §9.1 的"人工实机验收"6 条**未执行**（自动冒烟替代不了全部）；
④ `release/preview/win-unpacked/`（360 MB）等构建副产物未清（可随时清，`release/data/` 永不删）。
### D-1 补齐的副产品：抓到并修掉 1 处**真实产品缺陷**（整页空白）

`--tag=list-scroll` 首跑 3/5，两次失败都源于**页面已整页空白**。定位后确认是真实缺陷（非夹具问题）：

- **触发链**：`request.messages` 允许有**不带 `content` 键**的消息（仅含 `tool_calls` 的 assistant 消息、
  空 system 提示都合法，`readRun` 不拒绝）⇒ `DetailPanel` 内联 `prettyJson(message.content)` ⇒
  `prettyJson(undefined)` **返回 `undefined`**（`JSON.stringify(undefined)` 的返回值，与它 `: string`
  的签名相反）⇒ `LongText` 里 `shouldCollapse(undefined)` 读 `.length` 抛错 ⇒ **渲染层没有 error boundary**
  ⇒ **整个步骤页空白**。
- **修复两层**：① `prettyJson` 保证返回字符串；② 抽 `messageContentText()` 纯函数并加 5 条回归用例
  （含"缺 content 键 ⇒ 返回字符串而不是 undefined"）。提交 `bea1650`。
- **验证**：四人一 run 逐个试点「步骤」判影响面（只该形态触发）；修后 `--tag=list-scroll` **5/5**；
  typecheck 0；desktop 全量 **66 文件 / 1302 用例 / 0 失败 / 0 跳过**。
- ⚠️ **未修但同时登记**：渲染层**没有 error boundary** ⇒ 任一渲染期异常都会让整个窗口空白。
  本 change 只消除这一个已知触发点；"全局兜底"是跨 change 的设计决定，不在 U2 顺手塞入。

## 6. E 类：签署表（请逐行填，**不要**总体一句「都过了」）

| # | 项 | 通过 | 不通过 | 豁免 | 实测/备注 |
| --- | --- | --- | --- | --- | --- |
| A1 | 首次进入文件页落默认检查点 | ☐ | ☐ | ☐ | HEAD `first-enter` 3/3 |
| A2 | 单侧可读 ⇒ 可读侧完整正文 + 不可用侧诚实禁用 | ☐ | ☐ | ☐ | HEAD `sides` 9/9 |
| A3 | 两侧都不可读 ⇒ 无伪空编辑器 | ☐ | ☐ | ☐ | HEAD `both-unreadable` 5/5 |
| A4 | 窄档（≤800）/ 640 目录收起、正文可读 | ☐ | ☐ | ☐ | HEAD 12/12 + 12/12 + 12/12 |
| A5 | 手动布局偏好不被自动折叠覆盖 | ☐ | ☐ | ☐ | HEAD 5/5 + 4/4 + 3/3 |
| A6 | 工具：完整原文/元信息、查找换行差异、诚实禁用 | ☐ | ☐ | ☐ | HEAD 9/9 + 9/9 |
| A7 | 往返恢复 + 显式定位覆盖历史 | ☐ | ☐ | ☐ | HEAD 8/8 + 5/5 + 9/9 |
| A8 | 失效回退提示 / 筛选不偷换当前文件 | ☐ | ☐ | ☐ | HEAD 9/9 + 5/5 |
| A9 | 键盘全项 + 离线加载 | ☐ | ☐ | ☐ | HEAD `keyboard-offline` 10/10 |
| B1 | 追认 §3 的 IPC/只读类（界面点不到） | ☐ | ☐ | ☐ | HEAD `ipc-guard` 11/11 + `readonly` 12/12 + `selfcheck` 3/3 |
| D1–D4 | 4 条未验证项的处置（owner 定为**全部补齐**，见 §5） | ☐ | ☐ | ☐ | **D-1/D-2/D-3 已补齐**（D-1 长清单实机 5/5、D-2 39/39 且先证明有牙、D-3 三档 125%/150%/300% 实测）；**D-4 补齐中**（待定版本号后打便携包走三项门禁） |

**验收结论**：☐ 通过，同意归档　☐ 有条件通过（见备注）　☐ 不通过

- owner：________________　日期：____________
- 归档前须确认：**HEAD 与上表实测的提交一致**（当前 `1b453b7` + 本轮验收改动；若期间有新提交，需重新确认受影响项）。

## 7. 验收 ≠ 发布（避免误解）

- 本次验收**只覆盖 U2 的桌面阅读能力**。**发行打包未执行**、**Release 未上传**、
  §9.1「每次打包的最小完成条件」六条**未走**；`release/` 未改动。
- 主 spec 在**归档那一刻**才被本 delta 整体替换（MODIFIED 语义）⇒ **归档前主 spec 的该 requirement 仍是 C 版正文**
  （"提交和导航控件"措辞），**判现状只认 `src/` + 本 delta**。
- 归档动作由 owner 拍板后执行：无子进程直调 `bin/openspec.js archive improve-workspace-file-reading --yes`；
  归档后须再跑 `validate --all --strict` 并做**主 spec 差集复核**。
