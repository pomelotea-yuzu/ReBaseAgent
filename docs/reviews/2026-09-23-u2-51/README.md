# U2 任务 5.1 · 宽窗口文件阅读矩阵（真实 Electron 实机验收）

> change: `improve-workspace-file-reading`（U2） · 日期: 2026-09-23 · 承载需求: design D7 / D4
> 采集脚本: `apps/desktop/scripts/u2-51-cdp.cjs`（+ `scripts/lib/u2-cdp-util.cjs`）
> 原始数据: `.workbuddy/u2-51/measurements.json`（75 checks）/ `window-calibration.json`
> **本轮结论：D7 六档全部可达并全绿（75/75 checks）；过程中发现并修复 2 处真实产品缺陷。**

---

## 1. 任务原文与交付边界

> **5.1** 在真实 Electron 记录 1440/1360/1210px 宽窗口矩阵（1.5h）；验证"文件正文在代表视口可读""长文本及窄窗口""同视口下响应容器变化"，按 design D7 记录各层尺寸、Monaco 文字区及截图，**不复用改造前走查作为结果**。

design D7（第 100 行）六档矩阵：**1440×900 / 1360×860 / 1210 / 1024×768 / 800×600 / 640**。

本文档只覆盖 5.1 的横向视口矩阵。极窄/放大（`zoomFactor=2`）、键盘与离线加载归 5.2；往返导航归 5.3；异常与工具命令归 5.4；只读不变性归 5.5；迁移归 5.6。

---

## 2. 方法与两条硬纪律

采集链路为**两阶段**（2026-09-23 实测确立）：

1. **PowerShell 工具**改窗口外框（`MoveWindow`；最大化窗口须先 `SW_RESTORE` 再移动，否则无效）。
2. **node 脚本**只连 CDP 读取与断言，**不 spawn、不改窗、不重启 dev**。

两条纪律（违反会得到假数据）：

| 纪律 | 原因（实测） |
| --- | --- |
| **禁用 `Emulation.setDeviceMetricsOverride` 伪造宽档** | 它会把 Monaco `automaticLayout`（基于真实元素尺寸）破坏成 36px / 5px 伪影，几何**不可信**；宽档必须用真实窗口尺寸 |
| **脚本内不得 `spawnSync("powershell", ...)`** | 沙箱内 EBUSY 静默失败（`status=null`、无 stdout），改窗看似执行实则无效 |

**窗口外框(Win32 px) ↔ CSS 视口映射**（本机 DPI 141%，ratio≈1.39、offset≈22）：

| 目标 CSS | 外框 (Win32) | 实测 CSS | 断点档 |
| --- | --- | --- | --- |
| 1440 | 2030×1310 | 1441×887 | wide |
| 1360 | 1918×1300 | 1361×879 | wide |
| 1210 | 1704×1240 | 1212×837 | medium |
| 1024 | 1446×1180 | 1023×794 | medium |
| 800 | 1134×1050 | 800×701 | narrow |
| 640 | 912×950 | 641×629 | single |

> **更正一处既有错误结论**：先前记录「design D7 的 1440×900 / 1360×860 在本机物理不可达，需外接显示器」是**错的**。窗口外框**可以超出屏幕物理边界**，Electron 仍按请求的 CSS 尺寸渲染。先前的 1221px 上限是窗口处于**最大化**状态被屏幕裁剪所致。复原窗口后六档**全部可达**。脚本头注释已同步改正。

---

## 3. 六档实测矩阵（按 D7 记录各层尺寸 + Monaco 文字区）

单位 CSS px。`dirRes` = 文件目录是否常驻；`mono` = `.monaco-diff-editor` 宽；`box/text` = 该侧编辑器**包裹层**宽 / 其内 `.view-lines` **实际文字区**宽。

| 档 | CSS 视口 | 容器宽 | 目录宽(dirRes) | mono | 左 box/text | 右 box/text | 有效文字区 | 模式 | 容器变化支 | checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **640** | 641×629 | 641 | 0 (N) | 593 | 36 / 228 | 527 / **480** | **480** | inline | paneToggle | 12/12 |
| **800** | 800×701 | 800 | 200 (Y) | 547 | 36 / 228 | 481 / **435** | **435** | inline | dirWidth | 13/13 |
| **1024** | 1023×794 | 1023 | 200 (Y) | 771 | 36 / 228 | 705 / **658** | **658** | inline | dirWidth | 12/12 |
| **1210** | 1212×837 | 1212 | 200 (Y) | 960 | 464 / **400** | 466 / **419** | 419 | **sideBySide** | dirWidth | 14/14 |
| **1360** | 1361×879 | 1097 | 200 (Y) | 845 | 407 / **343** | 408 / **361** | 361 | **sideBySide** | dirWidth | 12/12 |
| **1440** | 1441×887 | 1177 | 200 (Y) | 925 | 447 / **383** | 448 / **401** | 401 | **sideBySide** | dirWidth | 12/12 |

**合计 75 checks，0 失败。**

> 注：1360/1440 档「容器宽」小于视口宽，是因这两档落在 **wide 断点**，左侧运行导航常驻（medium 档在文件页会临时收起导航，故 1024/1210 的容器宽≈视口宽）。这是 U1 既定布局行为，非缺陷。

### 模式演进核验（D4 判据生效点）

- **inline**：640 / 800 / 1024 —— 有效文字区 480 / 435 / 658
- **sideBySide**（两侧文字区各 ≥320）：1210 / 1360 / 1440 —— 左 400/343/383，右 419/361/401

并排→inline 的临界落在 **1210 与 1024 之间**：按修好的 D4 判据，1024 档 `(1023−71)/2−64 = 412 ≥ 320` 本应并排，但实机 Monaco 在 monoW=771 时**已回退 inline**。这正是**缺陷 1**（Monaco 内部 900px 断点覆盖外层 `renderSideBySide`）的暴露面——修复后由外层判据唯一裁决，二者不再打架（详见 §5）。

### 三项验证逐条对应

| 5.1 要求 | 证据 |
| --- | --- |
| 文件正文在代表视口可读 | 六档 `.view-lines` 实际文字区均 > 0；≥960 档 inline 均 ≥480（D4 硬判据）；并排档两侧均 ≥320 |
| 长文本及窄窗口 | 640 档目录非常驻（0px）⇒ 列表/内容**二选一占主区**，正文文字区仍 480 可读 |
| 同视口下响应容器变化 | 六档 `containerChange` 全绿（见 §4），证明吃**容器实测宽**而非 window 断点 |

---

## 4. 同视口下响应容器变化（视口不动，只改容器内布局）

分两支（由该档目录是否常驻决定）：

**A. 目录常驻档（800/1024/1210/1360/1440）** —— 键盘 `ArrowRight` ×5 调分隔条加宽目录：

| 档 | 目录 200→ | 文字区 before→after | 模式 before→after | 视口 | 现象 |
| --- | --- | --- | --- | --- | --- |
| 800 | 200 → **0** | 435 → 639 | inline → inline | 800 → 800 | 目录加宽后容器不足常驻 ⇒ **目录整体收起**，正文回宽 |
| 1024 | 200 → 280 | 658 → 578 | inline → inline | 1023 → 1023 | 目录变宽 ⇒ inline 文字区收窄 |
| 1210 | 200 → 280 | 419 → 379 | sideBySide → sideBySide | 1212 → 1212 | 保持并排，文字区随容器收窄 |
| 1360 | 200 → 280 | 361 → 652 | sideBySide → **inline** | 1361 → 1361 | 左侧文字区跌破 320 ⇒ **判据降级 inline**，文字区变宽 |
| 1440 | 200 → 280 | 401 → 361 | sideBySide → sideBySide | 1441 → 1441 | 保持并排，文字区随容器收窄 |

出现在上述两处「目录→0」与「模式降级」都是**设计预期**：容器不足以同时容下目录 + 正文时，**正文优先**，目录收起 / 布局降级，而不是压缩正文。故 5.1 断言只要求「文字区 ≠ 变化前」（视口不变），以容纳这些合规走向；1360 档同时证明**并排↔inline 的降级判据在运行时真的被触发**（不只是静态阈值）。

**B. 目录非常驻档（640）** —— 无分隔条可调，改验证 **pane 二选一**：
`显示文件列表` → 列表在场、编辑器不在场；`显示文件内容` → 列表不在场、编辑器在场；视口恒 641。证明窄档下「列表与内容分别占用主区」（spec 明写）。

---

## 5. 本轮发现并修复的 **2 处真实产品缺陷**

两处均为 5.1 实机验收按 evidence-first 暴露，**不是**验收脚本的问题。

### 缺陷 1：Monaco 内部 900px 断点静默覆盖 `renderSideBySide`

- **现象**：容器 248 → monoW 909 正常并排（447/448）；容器 264 → monoW 893 突变为 **36/827**，左侧被压成细条、sash 消失。
- **根因**：Monaco 默认 `useInlineViewWhenSpaceIsLimited: true` + `renderSideBySideInlineBreakpoint: 900`（`esm/vs/editor/common/config/diffEditor.js`）。**只要编辑器元素宽 ≤900px，Monaco 就无视外层传入的 `renderSideBySide: true` 强行改渲染 inline**；而本层 `decideDiffMode` 按 `(contentArea−chrome)/2 ≥ 320` 仍判并排 ⇒ 外层判据与 Monaco 实际布局**不一致**。
- **修复**：`WorkspaceFileView.tsx` 的 `<MonacoDiffEditor options>` 显式加
  ```tsx
  useInlineViewWhenSpaceIsLimited: false,
  ```
  让 `renderSideBySide` 成为唯一权威。
- **验证**：修复后全档正常——1210 档 464/466（box/text 400/419）、1360 档 407/408（343/361）、1440 档 447/448（383/401），不再出现 36px 细条。

### 缺陷 2：`decideDiffMode` 用对称 chrome 常数 ⇒ 1024 档误判并排

- **现象**：1024 档外层判据判并排，但**左侧文字区仅 306 < 320**（D4 要求每侧 ≥320）。
- **根因**：原实现把两侧 chrome 当**同一常数 56**。实测真机 1024/1212/1360/1441 四档恒为 **左 64 / 右 47**——原常数把左侧**低估 8px**，在临界档正好越线。
- **修复**：`lib/file-layout.ts` 改为两常量 + 外层固定开销：
  ```ts
  DIFF_CHROME_PER_SIDE = 64        // 左
  DIFF_CHROME_PER_SIDE_RIGHT = 47  // 右
  DIFF_OUTER_CHROME = 71           // 两侧之外固定开销
  // perSideBox = (contentAreaWidth - 71) / 2
  // 取 min(leftText, rightText) >= 320 才并排
  ```
- **回归单测**：`test/file-layout.test.ts` 新增「临界档：以较小侧（左侧 chrome 64）为准」——`811 ⇒ inline`（复现 1024 缺陷）、`839 ⇒ sideBySide`、`838 ⇒ inline`；并修正既有 auto 用例（`contentAreaWidth:800` 由 sideBySide 改判 inline）。

> 两处修复后：全量 **1237 passed / 0 failed（63 文件）**；`typecheck` 干净；`pnpm lint` 全绿。

---

## 6. 截图索引

`docs/reviews/2026-09-23-u2-51/`，命名 `<支>-<档>-<语义>.png`：

| 文件 | 内容 |
| --- | --- |
| `a-{640,800,1024,1210,1360,1440}-files-monaco.png` | 各档文件页 Monaco（默认目录宽，容器变化**之前**） |
| `c-{800,1024,1210,1360,1440}-dir-wider.png` | 各档目录加宽后（目录常驻支） |
| `c-640-pane-content.png` | 640 档 pane 切到「内容」（目录非常驻支） |

---

## 7. 复现步骤

```bash
# 0) 起 dev（后台常驻）
cd apps/desktop && NO_SANDBOX=1 node scripts/start-dev.cjs --remoteDebuggingPort=9612

# 1) 逐档：先用 PowerShell 工具改窗口外框，再单独跑一次采集
& .workbuddy\ps-win.ps1 -OuterWidth 2030 -OuterHeight 1310 -X 0 -Y 0   # 1440 档
CDP_PORT=9612 node apps/desktop/scripts/u2-51-cdp.cjs --tag=1440 --expect=1440

# 其余档外框见 §2 映射表 / .workbuddy/u2-51/window-calibration.json
# ⚠️ 每档必须单独调用：containerChange 只保留最后一次调用的结果
```

脚本前置会自动：确保停在隔离 v2 run（`run_muappa2a_gk7964`，medium 档需先切「概览」页签才能看到运行列表）→ 进文件页 → 装载 `a.txt` → 目录宽复位（`Home`）。

---

## 8. 遗留与后续

- 本机无 800×600 以下更窄的真实窗口档证据（D7 未要求；更窄档与 `zoomFactor=2` 归 **5.2**）。
- `screen` 物理 1707×1067 时，1440 档窗口会超出屏幕边界（不可整屏目视）——截图由 CDP `Page.captureScreenshot` 完整产出，不受屏幕裁剪影响。
