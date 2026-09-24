# U2 任务 5.2 实机验收证据（2026-09-23）

change：`improve-workspace-file-reading` · 任务 5.2（实机矩阵：800/640/zoom2 + 偏好保持 + 键盘/离线）
原始数据：`.workbuddy/u2/u2-52/measurements.json`（**54/54 checks 全绿**）· 截图 7 张（本目录）

## 环境真值（CDP `screen.*` + `devicePixelRatio` 证实）

| 项 | 值 |
| --- | --- |
| 物理屏 | 2560×1600 @ Windows 缩放 **210%** |
| CSS 桌面 | 1220×762（`screen.width/height`），DPR 基线 **2.1** |
| 本档实际用到的最大 CSS 视口 | **1207**（=「1210 档」实测值；窗口 outer 1218 − 边框 11）。⚠️ 这是**本档用到的值，不是本机上限**——见下方更正 |
| zoom2 档 DPR | **4.2**（2.1 × 2，真 zoom 生效的直接证据） |

⚠️ 5.1 期间记录的「物理 1707×1067 @141%」是 DPI-unaware PowerShell 的**虚拟化假象**（虚拟化系数 1.5）。已在 `scripts/lib/u2-cdp-util.cjs` 头注更正。

> ⚠️ **更正（2026-09-24 任务 6.3 复核对齐）**：本行原先还写着「design D7 的 1440/1360 档本机物理不可达（须外接更大屏），与 5.1 结论一致」——**这句是错的，且与 5.1 的最终结论相反**。
> 5.1 §2 已实测推翻该说法：窗口外框**可以超出屏幕物理边界**，Electron 仍按请求的 CSS 尺寸渲染；先前的 1221px 假上限是窗口处于**最大化**被屏幕裁剪所致，加 `SW_RESTORE` 复原窗口后 **D7 六档全部可达**（5.1 矩阵：1440→实测 CSS 1441、1360→1361，各 12/12 checks）。
> 本档（5.2）只测极窄/放大/偏好/离线四类，未重复测宽档，故此处按 5.1 的更晚结论为准。


## 真实性保障（与 5.1 同纪律）

- **真窗口**：PowerShell `MoveWindow` 改外框（禁用 `Emulation.setDeviceMetricsOverride`——它伪造布局视口，Monaco automaticLayout 产出 36px 伪影）。
- **真 zoom**：主进程 `webContents.setZoomFactor`（`REBASEAGENT_ZOOM_FACTOR=2`，挂在 `did-finish-load` 之后——加载前调用会被 Electron 静默重置为 1）。`Emulation.setPageScaleFactor` 只是视觉缩放不改布局视口，不采用。
- **真键盘**：`Input.dispatchKeyEvent`（keyDown/keyUp），非合成 DOM 事件（合成事件到不了 Monaco 的按键层）。

## 结果矩阵（54/54）

| 档位/tag | checks | CSS 视口 | DPR | 目录 | diff 模式 | Monaco 文字区 | 字号 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `zoom2`（真 zoom=2） | 13/13 | 605×356 | 4.2 | 收起 | inline（强制） | 451 | 13 |
| `800-narrow`（窄档） | 12/12 | 800×701 | 2.1 | **收起** | inline | 639 | 13 |
| `640-single`（单栏档） | 12/12 | 641×629 | 2.1 | 收起 | inline | 480 | 13 |
| `prefs`（设定偏好） | 5/5 | 1207 | 2.1 | 常驻 | sideBySide | 416 | — |
| `prefs-narrow`（缩窄降级） | 4/4 | 800 | 2.1 | 收起（降级） | inline | 639 | — |
| `prefs-restore`（恢复宽档） | 3/3 | 1207 | 2.1 | **仍收起★** | inline | 1046 | — |
| `offline`（离线加载） | 5/5 | 1207 | 2.1 | 常驻 | inline | 762 | 13 |

三场景验证结论（对应 spec）：

1. **极窄与放大后仍可阅读**：800/640/zoom2 三档目录一律收起、diff 强制 inline、正文占满可用主区（451–639px）、字号不缩（13px）、无整页横向滚动；zoom2 的 CSS 视口精确减半（1210→605）且 DPR 翻倍（2.1→4.2），证实是真 zoom。
2. **手动布局偏好不被自动折叠覆盖**：用户调宽 280（Home 复位后 +5×ArrowRight）+ 显式收起 → 缩到 800 档安全降级 → 回到 1207 宽档后 **显式收起保持收起（dirResident=false，未被自动改回）**；手动「展开目录」后常驻恢复且 **宽度精确复原 280**（≠默认 232）。偏好可逆。
3. **文件阅读键盘操作与离线加载**：目录宽度分隔条可聚焦、ArrowRight 步进生效；工具栏控件可获得键盘焦点；`navigator.onLine=false` 下 Monaco 仍从本地懒加载照常渲染；打开查找后 **Esc 关闭且焦点返回编辑器**（探针证实落点为 Monaco `native-edit-context`）。

## 实机暴露并修复的 2 处真实产品缺陷

### 缺陷 3：窄档（≤800px）目录未强制收起

- **症状**：800 档实测 `dirResident=true`（红项）。spec「极窄与放大后仍可阅读」明写 ≤800px「目录一律收起」，但 `decideDirResident` 只按几何判（800−232−12−64=492 ≥ 480 ⇒ 常驻）。
- **根因**：1.2「候选 A」结案时只收窄了 spec/design 语境、实现未跟进的债。
- **修复**：`file-layout.ts` 增加 `NARROW_TIER_MAX = 800`，容器 ≤800 时无条件的窄档门（先于几何判据；`dirUserCollapsed` 判据仍在最前）。801–959 为过渡带，按几何决策不变。
- **回归**：`test/file-layout.test.ts` +2 用例（16 个）：800/640/610 ⇒ 收起；801 过渡带按几何正常决策。

### 缺陷 4：宽档（目录常驻）没有任何收起入口

- **症状**：「收起目录」按钮只渲染在 pane 切换条（`dirResident===false` 分支）⇒ 目录常驻时 `dirUserCollapsed` 无法置真，spec「手动布局偏好」的 WHEN 在宽档不可达。
- **修复**：`WorkspaceFileView.tsx` 页头检查点行尾增加「收起目录」按钮（`dirResident && onDirCollapsed !== undefined` 时渲染），悬停说明「可随时重新展开」。

## harness 断言修正（非产品缺陷）

- `offline` 场景的 `backToEditor` 表达式只认 `className 含 monaco`/`TEXTAREA`/`INPUT`——新版 Monaco 用 `native-edit-context` div 替代 textarea，导致「焦点返回编辑器」误报 false。探针（`scripts/u2-52-probe-focus.cjs`，真实 Esc 按键）证实焦点落点 `isMonaco: true`。已修正表达式（加 `closest('.monaco-editor')` + `native-edit-context`）并把 `backToEditor === true` **纳入断言**（此前只记录不判）。

## 陷阱记录（给 5.3+ 复用）

1. **Electron zoom 持久化**：`setZoomFactor` 写入 `%APPDATA%\@rebaseagent\desktop\Preferences` 的 `partition.per_host_zoom_levels`（值 = log2(zoom)），**重启 dev 后 zoom 仍在**——复位须清该键。zoom2 实测曾污染后续轮次（dpr 停在 4.2）。
2. **zoom 生效时机**：必须在 `did-finish-load` 之后 `setZoomFactor`，否则被加载流程静默重置。
3. **prefs 三段编排**：`FileLayoutPrefs` 是 zustand 内存态（无 persist），**dev 重启即失**。`prefs`（设定）→ `prefs-narrow`（缩窄，PowerShell 改窗 1134×1050 ⇒ CSS 800）→ `prefs-restore`（回宽档 1704×1240 ⇒ CSS 1207）必须**同页面会话**按序执行，harness 三场景均不做导航。
4. **改窗必须类名过滤**：`title="ReBaseAgent"` 会命中 tooltip 残留窗（`tooltips_class32`，158×26 离屏）；主窗口也可能被宿主隐藏。最终方案 `ps-dbg.ps1`：按 `Chrome_WidgetWin_1` 类名枚举 → `ShowWindow(9)` 还原 → `MoveWindow`，每步落盘可审计。**每次设窗后必须读回输出 + CDP 验证视口再跑采集**（本轮 prefs-narrow 曾在错误视口跑出无效数据）。
5. **文件清单筛选**：默认「有变化」，检查点无变化时 `[role="option"]` 为 0，须点「全部」；单栏档默认显示内容 pane，先点「显示文件列表」。
6. **PowerShell 工具静默失败**：脚本内异常可能只留 exit 0（stderr 被宿主吞）。诊断路径：外层 try/catch 把 `$_.ToString()` 落盘读回。

## 证据文件

| 文件 | 内容 |
| --- | --- |
| `.workbuddy/u2/u2-52/measurements.json` | 全部 54 checks + 各档几何测量 |
| `a-zoom2-narrow.png` / `a-800-narrow-narrow.png` / `a-640-single-narrow.png` | 三档降级形态 |
| `b-prefs-prefs-set.png` / `b-prefs-narrow-degraded.png` / `b-prefs-restore-restored.png` | 偏好设定→降级→复原 |
| `c-offline-offline.png` | 离线加载 |
| `scripts/u2-52-cdp.cjs` · `scripts/u2-52-probe-focus.cjs` | 采集 harness / 焦点探针 |
| `.workbuddy/ps-dbg.ps1` | 类名过滤改窗入口（v2） |
