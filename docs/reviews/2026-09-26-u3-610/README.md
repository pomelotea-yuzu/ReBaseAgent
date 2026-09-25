# U3 任务 6.10 — 模态焦点禁闭 / Esc 层级 / busy 关闭锁的实机验收（2026-09-26）

> 验收（tasks 6.10）：创建设置和放弃确认不泄漏焦点 / Esc 只关闭最上层并恢复焦点 /
> 创建忙碌期间不能通过焦点修复绕过关闭锁。对应 spec delta「保留模态框约束焦点并正确恢复」
> 三场景与 design D7（Esc 先由最上层模态/Monaco 弹层消费，再处理编辑区收起；
> 一次按键不能同时关闭放弃确认和底层编辑器）。

## 一、机制与口径

- 键盘/鼠标一律 CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`（trusted 输入；
  探针实证：Esc 触发原生 `dialog cancel`、Tab 走浏览器焦点遍历、`dialog:modal` 可用）。
- 焦点判据 = 页内 `document.activeElement` 归属（`closest('dialog')` + aria-label +
  按钮文案 + `data-modal-focus-fallback` 在场性），逐步采集焦点链落盘 `measurements.json`。
- 多层模态的「最上层」判定：`querySelector('dialog:modal')` 按 DOM 序返回**首个（=底层）**，
  顶层必须取 `querySelectorAll('dialog:modal')` 末位（6.10 首轮判据自纠）。
- 意外原生 `window.confirm` 全程记红（放弃确认必须是页面模态）。

## 二、结果（`apps/desktop/scripts/u3-610-cdp.cjs`，7 tag / **63 检查 / 0 失败**）

| tag | 检查 | 覆盖 |
|---|---|---|
| `focus-create` | 9/9 | 创建对话框 top layer、初始焦点=首个可见可用控件、Tab×16+Shift+Tab×8 全程禁闭且回绕、背景「录制接入」真鼠标无效、Esc 关+焦点恢复触发入口 |
| `focus-settings` | 8/8 | 设置对话框同套判据（背景「新建运行」真鼠标无效） |
| `nested-confirm` | 10/10 | 创建+放弃确认两层在场（确认在顶）、初始焦点=「取消」、**一次 Esc 只关确认**（创建对话框仍在）、取消不丢草稿、焦点逐级恢复（放弃按钮→新建运行触发）、关闭≠放弃 |
| `editor-confirm-esc` | 10/10 | 编辑器+放弃确认：Esc 只关确认（网格仍在、草稿逐字保留、焦点回「放弃修改」）；再一次 Esc 收起编辑区（store 草稿仍在） |
| `monaco-esc` | 7/7 | 真 Ctrl+F 打开 find 弹层 → **第一次 Esc 只被弹层消费**（编辑区仍在）→ 第二次收起编辑区；两态草稿均保留 |
| `busy-lock` | 11/11 | 受控服务 delayMs=6s：执行中 ✕/取消/放弃/提交全禁用+「执行中」横幅、**连按 Esc 被吞**、无可用控件态 Tab×8 焦点不逃逸背景、输入不丢、受控服务恰 1 次请求（零第二次提交）、应答后正常关闭+焦点回触发点、重开锁不外泄 |
| `fallback-focus` | 8/8 | 会话草稿下拉「定位」打开创建（表单值=草稿）→ 面板关闭触发点卸载 → Esc 后焦点=回退锚点 `[data-modal-focus-fallback]`（运行配置，真实可见），不落 body/隐藏元素 |

截图 7 张（本目录）。测量明细 `.workbuddy/u3/u3-610/measurements.json`。

## 三、抓到并修复 2 处真实产品缺陷（+1 处编辑区接线缺口）

1. **CreateRunDialog Esc 双通道**（`CreateRunDialog.tsx`）：5.1 迁移 ModalDialog 时
   **残留旧 `window keydown Escape` 监听**，与原生 cancel 并存 ⇒ 嵌套放弃确认在场时
   一次 Esc **同时**关掉确认与创建对话框（直接违反 D7「不能一次按键同时关闭放弃确认
   和底层编辑器」；SettingsDialog 的同款监听 5.1 已删、契约只钉了设置侧 ⇒ 创建侧漏网）。
   修＝删除该监听，Esc 单通道走 ModalDialog。回归钉 = `nested-confirm` tag。
2. 🔴 **Chromium 对模态框 Esc 是「两步关闭」——cancel 上吞一次不够**（`ModalDialog.tsx`）：
   busy（`closeDisabled`）期第一次 Esc 的 `cancel` 可被 `preventDefault`（实机证实处理器
   确实执行且 `disabled:true`），**第二次 Esc 的 `cancel` 以 `cancelable:false` 派发**——
   处理器里 `preventDefault()` 完全无效（打点实测 `prevented:false`）⇒ 原生默认直接关窗，
   busy 关闭锁被绕过。另坐实 **React 委托的 `onCancel` 监听第二次不再执行**
   （`DOMDebugger.getEventListeners` 显示监听器在场但行为缺席，不再依赖）。
   修＝① cancel 处理改手动 `el.addEventListener("cancel")`（与 open 生命周期同挂同卸）；
   ② 关闭锁主拦截点移到 **document 捕获阶段 keydown**：锁定且本模态为最顶层 modal 时
   直接吃掉 Escape（cancel 根本不生成；嵌套确认在其上层时放行）。
3. **编辑区 Esc 收起缺接线**（spec L58/L62「收起按钮或 Esc 关闭…保留输入」+ D7
   「再处理编辑区收起」）：四个编辑器只有按钮通道，Esc 无消费方。
   修＝新增 `lib/use-escape-close.ts`（纯判据 `shouldEscapeClose`：Escape ∧ 未被
   defaultPrevented 消费 ∧ 无真模态在场 ∧ 栈顶=最近打开的编辑区）+ 四编辑器接
   `useEscapeClose(open && !inProgress, 与收起按钮同动作)`。

契约测试：`modal-dialog.test.ts` 新增 shouldEscapeClose 5 用例 + 接线契约（4 处 hook、
单通道、手动 cancel、keydown 守卫+最顶层判定）；`create-form-draft.test.ts` 的
「原忙碌关闭限制」断言改钉新通道（回插旧监听即判红——变异 A 实测）。

## 四、变异（实机面 4 处全捕获，`u3-610-mutate.cjs`，注入→判红→还原零残留）

| # | 注入 | 期望 | 实测 |
|---|---|---|---|
| A | CreateRunDialog 回插 window keydown Esc 双通道 | nested-confirm 判红 | **3 条判红**（一次 Esc 双关、两级焦点恢复错位），exit=1 |
| B | ModalDialog 不注册 keydown 关闭锁守卫 | busy-lock 判红 | **3 条判红**（第二次 Esc 两步关闭、焦点逃逸背景），exit=1 |
| C | shouldEscapeClose 去掉 modalPresent 让位判据 | editor-confirm-esc 判红 | **2 条判红**（确认在场时编辑区被连带收起），exit=1 |
| D | 焦点恢复删回退锚点 | fallback-focus 判红 | **2 条判红**（焦点落 BODY），exit=1 |

⚠️ 如实记录：C 的**第一版注入**（去掉 `defaultPrevented` 判据）实机**未被捕获**——
Monaco find 弹层消费 Esc 走的是 stopPropagation（window 监听根本不触发），
`defaultPrevented` 分支是纵深防御、当前实现下实机不可观测 ⇒ 改注入 `modalPresent`
（可观测核心判据）后捕获。该分支由单测「Monaco 内部弹层已消费 ⇒ 编辑区让位」钉住。

## 五、harness 事实与坑（后续复用必照）

1. **`Page.reload` 后 CDP 真鼠标点击不再触发 React onClick**（探针 6 实测：程序化
   `.click()` 正常、dispatchMouseEvent 全落空）⇒ 需要干净页面时用**重启 dev**，别 reload。
2. 多层模态 `querySelector('dialog:modal')` 返回**底层**（DOM 序）⇒ 顶层判据取
   `querySelectorAll` 末位。
3. 探针里 `document` 级监听跨 tag 叠加会污染打点 ⇒ 每轮诊断用全新 dev 实例。
4. busy 类 tag 的判据窗口以「应答前」为界：受控服务 `delayMs=6000` + 各步 sleep 预算
   合计需 < delay（本 tag 约 4.5s）。

## 六、门禁（本轮实测）

- desktop 全量 **80 文件 / 1525 用例 / 0 失败**（基线 1519 +6：shouldEscapeClose×5 + 接线契约×1）
- `biome check .` 仓库根整跑 **366 文件 0 错**；`tsc` 双配置 0；desktop `electron-vite build` EXIT=0
- `openspec validate preserve-debugging-drafts --strict` valid
- 日志：`.workbuddy/u3/u3-610/{desktop-full.log,biome.log,build.log,openspec-strict.log}`
