# U4 任务 6.8 — 窄窗口 / 200% 缩放 / 键盘焦点 + U1–U3 回归 + 只读面（2026-09-27）

采集：`apps/desktop/scripts/u4-68-cdp.cjs`（3 tag：`narrow-keyboard` / `zoom200-keyboard` / `readonly-noslot`）
驱动：`.workbuddy/u4/u4-68/run-all.cjs`（逐 tag「起全新 dev → 跑 tag → 停 dev → **reset-zoom**」+ settings 备份还原）
读数：`.workbuddy/u4/u4-68/<tag>-measurements.json`；截图：本目录 `68-*.png`
夹具：复用 6.1 的运行清单（`normalRun` 普通根 / `isoRoot` 隔离根）。

## 一、结论

**3 tag / 40 检查 / 0 失败**（`narrow-keyboard` 18 / `zoom200-keyboard` 8 / `readonly-noslot` 14），
还原后整跑 3/3、零产品代码改动。覆盖 tasks 6.8 四条验收：

| 场景（spec / tasks 原文） | 落在哪个 tag | 关键判据 |
| --- | --- | --- |
| `操作入口在窄窗口和键盘下可达` | `narrow-keyboard` + `zoom200-keyboard` | 800px（实测视口 805）与 200%（dpr 4.2）下：入口按钮可 `focus()` 获焦、真键盘激活（恰一次原生 click）打开面板；类型/状态/完整 36 位 operationId/runId 逐字可读；面板按钮矩形完整落在视口内（长 ID 不遮挡命令）；`scrollWidth ≤ clientWidth`（不破版）；**按钮里无停止/取消/中止一类无实现命令** |
| `核对结果只由用户明确打开` | `readonly-noslot` | 点「核对状态」后 `selectedRunId/selectedSpanId/页签` 三项不变（不导航）、模型请求计数不增（不重放）；只有点「打开记录」才导航到该 runId |
| `只读入口和被动录制不占主动槽` | `readonly-noslot` | A/B 预览（`modelAbPlan`）+ 隔离预检（`forkCapability`）+ 经代理的被动录制：全程 `activeOperationId=null`、登记条数不变、被动那条独立落盘（+1 文件）但不进登记 |
| `会话登记不泄漏输入和凭据` | `readonly-noslot` | 带正文 canary + apiKey canary 跑一条真执行后，扫 `operations:status` × 面板可见文本 × `operations:reconcile` × `settings:get` 四处 ⇒ canary 三处零命中；快照里无 `"stack":` 字段 |

回归面（折进 `narrow-keyboard`）：U1 阅读（窄窗选 run、读 span 树）、U2 文件（隔离根文件页签可达、读得到清单）、
U3 草稿（改 result 的草稿落 store 并保留、可放弃）；`源/父/兄弟 run 文件逐字节哈希不变` + `workspace-blobs 附件逐字节不变`。

## 二、本批量到的三条实机口径（写键盘/窗口类判据必照）

1. 🔴 **真键盘激活按钮只发 `char` 序列，别发 `keyDown(带 text)` + `char`**：实测 `keyDown` 带 text 时
   Blink 自己会补一次 keypress，再显式发 `char` 就是**两个原生 click**——对"操作入口是开关"的按钮 = 开→关，
   面板看着根本没开（本批首跑就是这么假红的）。`activateFocused()` 现逐个候选序列试到 `click 计数==1 且 aria-expanded==true`，
   实测命中序列 = **`char-only`**（单发 `Input.dispatchKeyEvent{type:"char", text:"\r"}`）。
2. 🔴 **MoveWindow 的 virtual→CSS 比值 ≈1.42（不是 DPR 2.1）且回报不可信**：DPI-unaware 的 PowerShell 坐标
   被虚拟化压掉了比例，幽灵窗还会抢 hwnd（U3 6.9 旧坑）。`resizeOuter()` 现"先量一次算比值、再反解重试 ≤4 次"，
   **判据一律以页内 `window.innerWidth` 复核**（实测 800→[561, 805]，第 2 次命中）。
3. **200% 缩放把默认窗口压进窄档 ⇒ 运行列表收起**，就绪探测读到 0 ⇒ 采集入口前先 `resizeOuter` 到宽档 +
   `ensureNavOpen()`（点 `button[aria-controls="run-navigation"]`）兜底；收尾驱动**必须 `reset-zoom`**
   （`REBASEAGENT_ZOOM_FACTOR` 经 Chromium per-host 持久化会污染后续 dev，见项目记忆）。
4. 🔴 **就绪判据要读 `store.runs.length`，不读 DOM 复制按钮**：200%/窄档下导航收起时列表行**不在 DOM 里**，
   `H.runs()`（数 `aria-label="复制完整运行 ID …"` 按钮）会读到 0 ⇒ 把"数据已加载"误判成"没就绪"（recheck 首跑 zoom200 就是这么假红，
   且 `resizeOuter` 在 200% 下撞 Win32 32767 上限跑飞）。改成读 store 真源 + `loadRuns` 兜底后 3/3 稳定复绿。

## 三、按层交付（真机测到了什么，什么仍归别处）

- **真机覆盖**：操作入口在 800px / 200% / 真键盘下的可达性与"无取消按钮"契约；核对 vs 打开两条通道在真机上不混用
  （`M-AL` 的实机复核）；登记/快照/核对/配置读四处不泄漏正文与凭据；只读入口与被动录制不占主动槽、不改写既有文件。
- **preload 白名单的注入反证（`M-AO`）**：这是 §4 沙箱拦下的欠账，本轮在**单测层**补上真反证——
  往 `src/preload/index.ts` 的 api 对象多挂一个 `fsReveal:` 方法 ⇒ `test/preload-surface.test.ts` 的 25 项白名单
  当场判红（`1 failed | 4 passed`），`git checkout` 还原后复绿（`5 passed`）。**不是实机注入**（`window.api`
  属性 `configurable:false`，真机包装不到，6.5 已实测），按层引用为"单测有牙"。
- **A/B 预览这一条的如实标注**：夹具 `normalRun` 带副作用工具 ⇒ `modelAbPlan` 被 `MODEL_AB_TOOL_POLICY` 业务拒；
  但本 tag 的判据是"只读通道不占槽、不登记"，拒绝发生在占槽之前 ⇒ 判据仍成立（`activeOperationId=null`、计数不变）。
  真·通过的 A/B 预览由 §6.4 `dry-run` tag 承担，不在此重复。

## 四、变异

本 tag 无产品代码改动；判据有牙的两处直接证据：
- **M-AO（preload 白名单）**：见第三节，注入 `fsReveal` ⇒ 白名单必然不等 ⇒ 单测判红（已跑，已还原）。
- **可达性判据反证**：`char-only` 序列单独就够（spy==1）——若入口被改成"只认鼠标"（`onClick` 换成 pointerdown），
  `char-only` 的 click spy 会是 0 ⇒ 该判据落红；本批正向实测坐实了"键盘能触发原生 click"。

## 五、边界

- 宽度档的**精确几何**（并排/上下/diff inline 的像素阈值）归 U1/U2 已归档批次，本批只验"操作入口在窄窗与缩放下可达且不破版"，
  不重开宽度契约。
- 键盘焦点**遍历顺序 / Esc 关闭 / 焦点恢复**的完整模态规则由 U3 §6.10 承载（Chromium 模态 Esc 两步关闭等坑已在那批记录）；
  本批的 Escape 只作收尾关面板，不宣称验完焦点环。
- 窄窗口 N1（`<Dialog>` 系缺 `max-width`）仍是**用户未定口径**的独立欠账（见 HANDOFF §十"已知留白"），与本 change 无关。

## 六、复现命令

```bash
# 全批（逐 tag 全新 dev；zoom200 tag 自动带 REBASEAGENT_ZOOM_FACTOR=2，收尾 reset-zoom）
node .workbuddy/u4/u4-68/run-all.cjs
node .workbuddy/u4/u4-68/run-all.cjs zoom200-keyboard   # 或指定 tag
# M-AO 注入反证：给 src/preload/index.ts 的 api 对象加一行 `fsReveal: ...`，
#   cd apps/desktop && npx vitest run test/preload-surface.test.ts  ⇒ 白名单判红；git checkout 还原
```
