# U3 任务 6.7 实机证据：应答延迟注入（<1.5s / >1.5s）× CPU 降速 × 超时降级-取消-迟到-重核对

日期：2026-09-25 · dev（非沙箱，CDP 9612，**无新增钩子、无产品代码改动**——6.7 全部用既有通道注入）
驱动：`apps/desktop/scripts/u3-67-cdp.cjs`（**3 tag / 38 检查 / 0 失败**）
系统级通道：复用 6.4 的 `apps/desktop/scripts/lib/u3-64-winops.ps1`（关闭投递/确认框 UIA 读写）+ 6.6 的全屏截取
批量驱动：`.workbuddy/u3/u3-67/run-all.cjs`（每 tag 全新 dev）· 逐 tag 数据 `.workbuddy/u3/u3-67/measurements.json`
夹具：复用 6.1 运行清单（`run_mughwjk4` 的 `s_03`）。零模型调用。

## 注入面（都是真冻结/真降速，不合成任何协议事件）

- **应答延迟**：CDP 投递一段同步忙等（wall-clock 冻结 renderer 主线程）⇒ 关闭查询在 renderer 排队、
  应答时刻可控（1.5s / 4s 两档）；应答发出时刻用真 preload 订阅 `onDraftCloseQuery` 在页内记 `Date.now()`
  （与客户端 handler 同一次消息派发 ⇒ 即应答时刻，与 harness 时钟同机可比）。
- **CPU 降速**：CDP `Emulation.setCPUThrottlingRate` 20×（辅助面，制造"整体慢机"而非精确延迟）。
- 关闭由系统发起（`WM_SYSCOMMAND SC_CLOSE`），确认框真 `#32770` 走 UIA 读写，退出判定只看窗口句柄/PID/端口。

## 逐场景（记录四件套：超时提示 / 取消解锁 / 迟到应答 / 下次正常查询）

| tag | 结果 | 记录 |
| --- | --- | --- |
| `slow-fast` 11/11 | 冻结 1.5s：应答距关闭发起 **实测 1501ms**（忙等覆盖应答路径）但仍在 1.5s 阈值窗口内（查询投递晚于关闭若干百毫秒）⇒ **dirty 确认**（慢应答被有效接受，未误降级）；取消 ⇒ 解锁、草稿逐字保留；再关闭仍正常核对；放弃后 clean 直退（慢应答史不污染后续） | 应答延迟实测入 measurements；截图 `67-slow-fast-dialog.png` |
| `slow-slow` 16/16 | 冻结 4s：**应答迟到（实测 tQ−tFire=4001ms > 1.5s 阈值）**⇒ 超时降级出 **unknown 确认**（超时提示在场；文案只说"暂时无法确认草稿状态"，**不宣称已崩溃/失联、无丢失说明**）；确认在场连发 2 次关闭 ⇒ 6 次采样**至多一层**（不重入）；取消走"点击-核对-重试"排空（见下节：首击未生效、hwnd 轨迹证明是同一层框，**不是**产品重弹新框）；**取消解除输入锁**（排队查询/释放按序消化不遗留）；**迟到应答零后续效果**（解冻后 3s 不自主弹框、不关窗、草稿原样）；**下次正常查询**：恢复后关闭走 fresh 应答 ⇒ dirty；放弃后 clean 直退、窗口/PID 真实结束 | 截图 `67-slow-slow-dialog.png`（unknown 超时提示在场）；排空轮次 `{kind,hwnd,click,after}` 逐轮落盘 |
| `cpu-throttle` 11/11 | 20× 降速：关闭**绝不静默放行**（实测 1227ms 内出 dirty 确认——如实记录，**不以此宣称"慢 renderer 不能超时"**）；连发关闭仍至多一层；可取消；解除降速后恢复 fresh 核对 ⇒ dirty ⇒ 放弃 ⇒ clean 直退 | 截图 `67-cpu-throttle.png` |

## 判据纪律（tasks 6.7 明说的两条）

- **不以"慢 renderer 不能超时"为判据**：`cpu-throttle` 只断言"必出询问 + 不重入 + 可取消 + 可恢复"，
  询问类型（dirty/unknown）如实记录不设向；阈值的两侧行为由 `slow-fast`/`slow-slow` 用真延迟坐实。
- **开发机注入 ≠ 真实慢机校准**：本任务证明的是"阈值两侧的行为正确"（迟到的必降级、阈内的不误伤、
  降级后可取消可重核对），**不**宣称 1500ms 已在真实慢机校准——`draft-close-flow.ts` 头注的原口径保持不变。

## 变异（先证明有牙）

| 变异 | 注入点 | 结果 |
| --- | --- | --- |
| F-A | `DRAFT_CLOSE_QUERY_TIMEOUT_MS` 1500→100 | `slow-fast` 判红 exit=1：阈内慢应答被误降级成 unknown（dirty 判据变红，框内文案为反证） |
| F-B | 1500→60000 | `slow-slow` 判红 exit=1：4s 迟到应答被"提前接受"出 dirty（unknown/超时提示两条判据变红） |

脚本 `.workbuddy/u3/u3-67/u3-67-flow-mutate.cjs`（注入→跑 tag→还原；跑完 `git diff` 零残留已核）。

## harness 侧发现（沿用 6.6 教训 + 一条新坑）

- 全部 CDP 求值有界（30s cap）+ 240s 看门狗：冻结/退出路径零静默 exit 0。
- **原生确认框的"返回"首击可能不生效 ⇒ 取消类断言必须"点击-核对框数-重试"**：slow-slow 首跑用
  单次 `dialog-click + waitDialogGone` 判红"无法取消"；给 winops `dialog-text` 增补 `dialog-hwnd` 后复跑取证——
  排空两轮读到**同一句柄**（after=1→0），证明是**同一层框首击未生效**、第二击正常关闭；
  **排除**了"产品取消后又弹新框"（新框会是不同 hwnd，且 flow 取消后无任何再触发路径）。
  最终证据集里该现象**独立复现 3/3**（slow-slow 两轮 `hwnd` 恒定 ×2 次运行、cpu-throttle ×1），
  而 6.4/6.6 同通道单发点击生效 ⇒ 时序性 flaky（三次复现时 renderer 都处于冻结恢复期或 20× 降速中），
  归 harness 稳健性问题而非产品缺陷；`drainDialogs` 逐轮记录 `{kind,hwnd,click,after}` 留证。
  ⚠️ 后续 tag（6.10 焦点/Esc）凡"点原生框按钮"一律走点击-核对-重试，别回到单发断言。

## 边界

- 冻结注入的是"renderer 完全不应答"到"应答迟到"的连续面；`inputSettled=false` 的输入法组合分支仍按
  6.5 事实留 §7 处理（本机 `native-edit-context` 下无触发路径）。
- 系统会话结束、崩溃/重载面归 6.6（已完成），本任务不重复宣称。
- 200% 缩放/宽度档归 6.8/6.9。

## 复现命令

```bash
node .workbuddy/u3/u3-67/run-all.cjs [slow-fast slow-slow cpu-throttle]
# 变异：node .workbuddy/u3/u3-67/u3-67-flow-mutate.cjs --inject=A|B | --restore（跑完必须 --restore）
```

## 门禁（2026-09-25 实测）

- desktop vitest 全量：**80 文件 / 1519 用例 / 0 失败 / 无 Errors 行**（6.7 零产品代码改动，基线不动）
- `biome check .`：**362 文件 0 错**（新增 u3-67-cdp.cjs）
- `tsc` 双配置 0；`openspec validate --all --strict`：**13 passed / 0 failed**
