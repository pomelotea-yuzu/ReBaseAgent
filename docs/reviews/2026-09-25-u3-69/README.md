# U3 任务 6.9 — Electron 200% 页面缩放的实机验收（2026-09-25/26）

> 验收（tasks 6.9）：**宽窄窗口均可核对完整编辑内容（200% 缩放）**，记录实际
> viewport、zoom/DPR 与编辑/操作可达性；不要求四档宽度 × 缩放的笛卡尔积
> （6.8 已覆盖 zoom 1 四档）。对应 spec delta「宽窄窗口均可核对完整编辑内容」
> 场景中的「独立 200% 缩放」分支。

## 一、机制与口径

- 缩放走主进程 `webContents.setZoomFactor`（dev-only 钩子 `REBASEAGENT_ZOOM_FACTOR=2`，
  `did-finish-load` 后设置）；**禁 `Emulation`**（U2 5.1 实证会压出 Monaco 36px 伪影）。
- 改窗一律 Win32 `MoveWindow`（`.workbuddy/ps-win.ps1`）；探针实测（本机 DPR 2.1）：
  **zoom=2 时 `devicePixelRatio = 2.1 × 2 = 4.2`，CSS = zoom1 校准值 ÷ 2**。
- 三档（外框 ⇒ 实测 CSS）：**3610×2200 ⇒ 1284（并排档 ≥1280 在 200% 下仍可达）** /
  2030×1310 ⇒ 720 / 1134×1050 ⇒ 400（极窄档）。每档读**实际** `window.innerWidth`。
- 判据口径沿用 6.8：内容完整性 = **Monaco model** 12 行首末标记（虚拟滚动下 DOM 只含视口行）；
  无右溢 = 绘制越界 ≤2px；轨道数 = xl 断点（≥1280⇒2，<1280⇒1）；操作可达 =
  `scrollIntoView` 后完整落入视口。**200% 专属加测**：整页 `scrollWidth ≤ innerWidth+2`、
  「编辑可达」= 极窄档（CSS≈400）现场键入/写入并核对 store 更新。
- 改窗纪律（本轮新坑）：**MoveWindow 回报不可信**——off-screen 158×26 幽灵窗会让
  ps-win 面积筛选选错 hwnd，回报像成功而窗口纹丝不动 ⇒ harness 一律
  `resizeTo`（改窗后**以页内实测 CSS 复核**，≤4 次重试）。
- 次序坑：200% 下 dev 默认窗口 = CSS 605 ⇒ **窄档、运行导航整列收起**
  （「复制完整运行 ID」按钮不渲染）⇒ 就绪轮询前必须先真实改窗到宽档。

## 二、结果（`apps/desktop/scripts/u3-69-cdp.cjs`，3 tag / **108 检查 / 0 失败**）

| tag | 检查 | 覆盖 |
|---|---|---|
| `tool-result` | 41/41 | 三档 ×（缩放生效 dpr=4.2 / 视口命中 / 轨道数 / 两侧 ≥200px / 零右溢 / 整页零横溢 / 放弃按钮可达 / model 12 行完整 / 改窗往返逐字保留）+ 极窄档现场键入进 store |
| `prompt` | 38/38 | 两字段独立草稿不串值 × 三档完整核对 + 极窄档键入只进当前字段 |
| `model-ab` | 29/29 | 长臂参数基线/草稿两侧对照 × 三档（1280 并排、720/400 上下）+ 极窄档写入臂参数进 store + 输入框滚动可达 |

截图 9 张（本目录）：`69-{tool-result|prompt|model-ab}-{1280|720|400}.png`。
测量明细：`.workbuddy/u3/u3-69/measurements.json`。

**正式整跑前已清 Chromium 持久 zoom**（见 §四坑 2）⇒ dpr=4.2 唯一来源是 env 钩子。

## 三、抓到并修复 1 处真实产品缺陷（A/B 对照面板长拉丁串截文）

- **现象**（6.9 首轮实机）：model-ab 核对网格**草稿侧**臂行 `{"temperature":0.777…,"tag":"AB200…`
  这类**无空格 JSON 长拉丁串**在窄盒内不强制断行 ⇒ 绘制右溢 **1280 档 26px / 400 档 36px**
  （720 档盒宽够、恒绿）——正文被裁，违反场景「长臂参数…两侧都完整可读」。
- **修复**：`DetailPanel.tsx` `ModelAbEditor` 基线侧与草稿侧臂行一律加 `break-all`
  （提交随本任务）。6.8 未抓到是因其夹具 `AB完整核对` 拉丁连段比 `AB200缩放核对` 短，
  恰好没越过临界——**判据有牙，夹具文本决定暴露与否**。
- **接线契约**：`test/model-ab-editor-draft.test.ts` +2 断言（两侧臂行 className 含 `break-all`）；
  变异「去草稿侧 break-all」⇒ 该用例 `1 failed | 11 passed` 变红，还原复绿。
- **回归**：6.8 `model-ab` tag（zoom1 两极端档）复跑 **16/16 全绿**（清持久 zoom 后）。

## 四、harness 事实与坑（后续复用必照）

1. **MoveWindow 回报不可信**（幽灵窗选错 hwnd，见 §一）⇒ 一律实测 CSS 复核 + 重试。
2. 🔴 **`REBASEAGENT_ZOOM_FACTOR` 会经 Chromium per-host zoom 持久化污染后续 dev**：
   `setZoomFactor` 的值写进 `%APPDATA%\@rebaseagent\desktop\Preferences` 的
   `partition.per_host_zoom_levels.*.localhost` ⇒ **之后任何不带 env 的 dev 也开在 200%**
   （6.8 回归首轮「运行列表未就绪」即此因，非产品缺陷）。
   复位：`node .workbuddy/u3/u3-69/u3-69-mutate.cjs --reset-zoom`
   （**dev 停止后、下一次启动前**执行；zoom2 dev 每次退出都会写回）。
3. 200% 下默认窗口落窄档 ⇒ 就绪轮询前先 `resizeTo` 宽档（harness 已内置，含「起点宽档就位」断言）。

## 五、变异（实机面 2 处全捕获，`u3-69-mutate.cjs`，注入→变红→还原）

| # | 注入 | 期望 | 实测 |
|---|---|---|---|
| M1 | `main/index.ts` 禁用 zoom 注入（`zoom > 0`→`zoom > 2`）+ 先清持久 zoom | 基准 dpr 与各档 dpr/视口判红 | **8 条判红**（dpr=2.0999…，1280/720/400 档视口全错位），exit=1 |
| M2 | 去 model-ab 草稿侧 `break-all` | 溢出判据在窄侧档判红 | **1280（26px）/400（36px）判红**、720 恒绿（盒宽够），exit=1 |

另：契约测试面变异 1 处（§三）。还原后 `git diff` 仅剩预期改动。

## 六、门禁（本轮实测）

- desktop 全量 **80 文件 / 1519 用例 / 0 失败**（无 `Errors` 行）
- `biome check .` 仓库根整跑 **364 文件 0 错**（含新 harness 格式化）
- `tsc -p tsconfig.{node,web}.json --noEmit` 双 0
- `openspec validate preserve-debugging-drafts --strict` valid（见 tasks.md 勾选记录）
