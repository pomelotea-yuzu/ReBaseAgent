# U3 任务 6.5 实机证据：真键盘最后一次键入 / 真粘贴 / 真中文输入法组合 × 输入锁

日期：2026-09-25 · dev（非沙箱，CDP 9612，钩子 `REBASEAGENT_SMOKE_PICK_DIR`）
驱动：`apps/desktop/scripts/u3-65-cdp.cjs`（**6 tag / 47 检查 / 0 失败**）
系统输入通道：`apps/desktop/scripts/lib/u3-65-input.ps1`（`keybd_event` 真按键、`Set-Clipboard` 真系统剪贴板、
`GetGUIThreadInfo`/`ImmGetContext` 输入法状态）+ 复用 6.4 的 `u3-64-winops.ps1`（关窗与原生确认框）
批量驱动与门禁：`.workbuddy/u3/u3-65/{run-all.cjs,run-final.log,gates.txt}` · 原始测量 `.workbuddy/u3/u3-65/measurements.json`
夹具：复用 6.1 的运行清单（普通父 `run_mughwjk4` 的 `s_03` result 编辑器）。**零模型调用**：本任务不触发任何请求。

## 纪律（6.5 特有的硬口径）

- **输入必须由系统产生**：字符、Ctrl+A、Ctrl+V、Shift、空格选词全部是 `keybd_event` 真按键序列；
  剪贴板内容来自 `Set-Clipboard`（真系统剪贴板，载荷经 UTF-8 文件传递，PS 脚本本体保持纯 ASCII）。
  CDP 只负责**聚焦哪个控件**和**读回结果**（Monaco model + zustand store 双口径同源核对）。
- **绝不合成 composition 事件**：tasks.md 明文禁止以合成 CompositionEvent 冒充系统输入法。
  真实输入法的判据是**结果侧**的：`hkl=0x08040804`（微软拼音）+ 只发 ASCII 拼音字母与空格却产出汉字
  （实测 `m,a,o` + 空格 → 「猫」进入编辑器模型与 store）。
- **模态框在场时不把主窗口抬到前台**（`-Raise 0`）：真实用户面对应用模态框做不到那件事；
  抬窗口会造出一条不可能的路径（组合文本短暂进模型再回退）。锁内也只发字母，**不发 space/enter/esc**
  ——那会激活确认框的默认按钮，把"询问仍在场"测成"已应答"。
- **输入法模式不确定时先预检**：预热串 `m,a,o`+空格若产不出汉字，就按一次真 Shift 再试；
  预检结果写进断言（`系统中文输入法确在生效`），不让"英文模式"偷偷变成假通过。

## 逐场景覆盖（tasks 6.5 的三条验收）

| 场景 | tag | 结果 |
| --- | --- | --- |
| 最后一次真键入 | `real-keys` 7/7 | 真按键后编辑器模型与 store **同值且变长**（实测 store 变成「猫内容(README.md)」）；紧接着关闭 ⇒ 刚这次键入已被算进 `dirtyCount`（确认框出现）；选返回后逐字保留 |
| 真粘贴 | `paste` 5/5 | 真系统剪贴板 + 真 Ctrl+A（选区长度=全文长度）+ 真 Ctrl+V ⇒ 编辑器与 store 同时等于剪贴板内容；真 `paste` 事件确实抵达页面 |
| 锁内阻止新输入（A 段=纯锁定期） | `lock-blocks` 11/11 | 关闭已投递、确认框**尚未**弹起时真键入 + 真粘贴：值逐字不变；抵达页面的插入类事件（`beforeinput`/`paste`）全部被标记 `defaultPrevented` |
| 锁内阻止新输入（B 段=确认框在场） | 同上 | 不抬窗口时字母与 Ctrl+V 都进不了草稿；确认框未被误触发（`dialogs` 恒为 1）；整屏输入锁遮罩在场 |
| 取消恢复与焦点 | `cancel-restore` 6/6 | 返回后确认框消失、**焦点归还给锁前那个编辑面**（`native-edit-context` 宿主元素被打标记，解锁后 `=== document.activeElement`）；解锁后真键盘仍可正常输入并同步进 store |
| 不重放 | `lock-blocks` 尾检查 | 解锁后等 2.5s，值仍逐字等于锁前基线（被拦的按键不缓冲、不回填） |
| 真中文输入法组合 + 尾随事件 | `ime-composing` 10/10 | 组合在飞时关闭**仍出询问**（绝不零询问直接关闭）；询问文案如实记录；锁内收尾后模型与 store 同源；收尾结局二选一且不重复（不留裸拼音）；**锁前已提交的文字未被换回旧基线** |
| clean 才允许直接关闭（锁面复核） | `clean-unlock` 8/8 | dirty 时询问 → 返回 → 放弃入口可用 → 按修订真放弃 → 再关闭 **零询问**且窗口真实结束 |

## 两条必须留档的实现面事实（不是判据放宽，是后续任务的输入）

1. **本机 Monaco/Chromium 走 `native-edit-context`，中文组合期的 `compositionstart/update/end`
   在 document 级一条都观测不到**（实测 `compEventsSeen=0`，`document.activeElement` 即
   `DIV.native-edit-context`）。⇒ 任务 4.3 用来算 `inputSettled` 的 `composingRef` 在这条通道上不会置位，
   `inputSettled` 实际恒为 `true`。本轮实测**没有**因此变成静默放行：组合文本已进 Monaco 模型 ⇒ `dirtyCount>0`
   ⇒ 出的是「有未放弃的调试草稿」确认框。但"D6 第 4 步：inputSettled=false ⇒ 暂时无法确认"这条保护
   在真输入法下**不再有触发路径**，需要 §7 evidence-index 记录，并决定是否补 design（改以
   `beforeinput` 的 `insertCompositionText`/`editContext` 信号为准，或明确该保护仅覆盖 textarea 通道）。
   注意：候选未提交时"是否已进模型"取决于编辑器实现，不能反过来用合成事件去制造 false。
2. **未提交候选在确认框抢焦点时被输入法丢弃**：实测锁前模型含裸拼音 `mao`，返回后模型与 store
   回到**已提交基线**（`discarded=true`，不留裸拼音、不重复插入）。按 D6「候选窗中尚未进入控件/model 的候选
   不视为应用已接收文本、不代用户选词」这是可接受结局；本轮把它作为**二选一断言**（提交出恰好一个汉字 /
   干净丢弃）并同时断言"已提交文字不得被换回旧基线"，两种结局都必须满足后者。

## 未覆盖（不在 6.5 宣称范围）

- renderer 失联 / 超时降级下的 `inputSettled=false → unknown 确认`路径留给 **6.6 / 6.7**（那两条不依赖真输入法信号）。
- 系统注销/关机、宽窄档与 200% 缩放、Tab/Shift+Tab/Esc 焦点链分别属 6.6、6.8/6.9、6.10。

## 复现命令

```bash
node .workbuddy/u3/u3-65/run-all.cjs                        # 全新 dev × 6 tag
node apps/desktop/scripts/u3-65-cdp.cjs --tag=ime-composing # 单 tag（需 dev 已在 9612 且带钩子）
node apps/desktop/scripts/u3-65-cdp.cjs --tag=lock-probe    # 诊断探针：纯锁定期 vs 确认框在场两段分开看
cd apps/desktop && ./node_modules/.bin/vitest.CMD run        # 79 文件 / 1511 用例 / 0 失败
pnpm exec biome check .                                      # 仓库根整跑：358 文件 / 0 错
```
