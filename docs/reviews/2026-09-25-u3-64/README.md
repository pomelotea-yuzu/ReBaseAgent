# U3 任务 6.4 实机证据：标题栏关闭 / Alt+F4 / app.quit × dirty-clean × 取消-确认-重入-迟到应答

日期：2026-09-25 · dev（非沙箱，CDP 9612，验收钩子 `REBASEAGENT_SMOKE_PICK_DIR` + `REBASEAGENT_SMOKE_QUIT_FILE`）
驱动：`apps/desktop/scripts/u3-64-cdp.cjs`（**8 tag / 59 检查 / 0 失败**）
系统级通道：`apps/desktop/scripts/lib/u3-64-winops.ps1`（Win32 P/Invoke + UIAutomation）
批量驱动与门禁：`.workbuddy/u3/u3-64/run-all.cjs` · `.workbuddy/u3/u3-64/final-run.log` · `.workbuddy/u3/u3-64/gates.txt`
夹具：复用 6.1/6.3 的运行清单（普通父 `run_mughwjk4` 的 `s_03` 为草稿落点）。零模型调用：本任务只碰关闭协商，不发任何请求。

## 纪律（6.4 特有的三条硬口径）

- **关闭必须由系统发起**：`PostMessage(WM_SYSCOMMAND, SC_CLOSE)`（标题栏 X 的系统等价投递，且先断言窗口
  真有 `WS_CAPTION|WS_SYSMENU`——X 就是系统画的那个）、`keybd_event` 真 Alt+F4 按键序列、真 `app.quit()`。
  不走渲染层按钮、不直接调 guard。
- **确认框必须是真原生框**：UIA 按 `#32770` + 所属进程定位，文案与按钮从框里读（不是界面向 harness 自述），
  应答用 `CCPushButton` 的 `BM_CLICK`。
- **退出判定只看现场**：窗口句柄消失或 `IsWindow=False`、主进程 PID 不再存活、CDP 端口随之关闭；
  **不断言 guard 返回值**。每个 tag 前清掉本仓库遗留 dev（按命令行含 ReBaseAgent 认定，不按映像名）并重启，
  避免跨实例的窗口/确认框串扰。

## 逐场景覆盖

| 场景 | tag | 结果 |
| --- | --- | --- |
| 有草稿关闭 → 返回 | `titlebar-return` 12/12 | 询问框文案如实（「有未放弃的调试草稿」+ 退出将丢失）、按钮「返回」/「退出并丢弃草稿」；停留期间整屏输入锁在场且草稿未被改动；点返回后 `IsWindow=True`、草稿逐字保留、输入锁解除；**再次关闭仍重新核对并再次询问**（未被"已取消"永久短路） |
| 有草稿关闭 → 确认退出 | `titlebar-quit` 5/5 | 窗口真实结束 + 主进程 PID 消失 + 9612 端口随进程关闭 |
| clean 才允许直接关闭 | `clean-direct` 8/8 | 先 dirty 出询问并应答「返回」→ 按修订真放弃草稿（页内 `dirtyCountOf` 真口径回到 `dirtyCount=0`、`rows=[]`）→ 再关闭 **零询问**直接结束，窗口与 PID 真实消失 |
| 连续关闭不重入 | `reentry` 6/6 | 确认框停留期间连发两次 `SC_CLOSE`，6 次采样 `dialogs` 始终 ≤1（不叠加、不并发）；应答后最终清空、草稿仍在；取消后再关闭仍能询问（不卡未决态） |
| 迟到应答不关窗 | `late-answer` 10/10 | 用真 preload 通道订阅到本次查询的**真 sessionId/requestId**；用户选返回后按同 requestId 补投应答 ⇒ guard 拒绝：窗口存活、PID 仍在、草稿不删、后续关闭仍能正常协商 |
| Alt+F4 × 返回/退出 | `altf4` 7/7 | 真键盘序列投递后走同一协商；返回不关窗（窗口与 PID 均在），第二次询问后确认退出 ⇒ 窗口与 PID 真实结束 |
| app.quit × dirty | `app-quit` 7/7 | 哨兵文件触发真 `app.quit()` ⇒ 同一询问；选返回后 quit 未生效（窗口+PID 存活），再触发仍能询问，确认退出后进程真实结束 |
| app.quit × clean | `app-quit-clean` 4/4 | 无草稿时零询问，窗口与 PID 真实结束 |

## 抓到的真实缺陷（已改代码，非放宽判据）

**窗口销毁后解绑监听器抛未捕获异常，把一次干净退出污染成"确认框"**：
`apps/desktop/src/main/draft-close-attach.ts` 的 `onClosed → disposeIpc()` 里直接访问 `win.webContents.removeListener(...)`
⇒ Electron 抛 `TypeError: Object has been destroyed`，主进程未捕获异常弹出系统级 `#32770`「Error」框。
现象是 `clean-direct` 断言 `dialogs=1` 却怎么也不该出现询问框；把框内文案读出来才看清是
`A JavaScript error occurred in the main process … at disposeIpc (dist/main/index.cjs:944)`。
修法＝`win.isDestroyed()` 时跳过 webContents 解绑（其监听器与 webContents 同生命周期，销毁后已无处可解绑），
`ipcMain` 侧照常解绑。修后 `clean-direct` 8/8 且窗口/PID 真实结束。

**harness 侧的一处假判定**（同时记进记忆）：`parseLines` 把 `RESULT=altf4-keyboard hwnd=…` 折成对象，
断言却按数组 `sent[0]` 读 ⇒ 真投递成功也判红。改为读 `sent.RESULT`。

## 本轮新增的 dev-only 验收钩子

`REBASEAGENT_SMOKE_QUIT_FILE`（`apps/desktop/src/main/index.ts`）：Windows 上外部没有任何路径能调到 `app.quit()`
（也没有 quit IPC 通道，不该为验收新增一条），而"窗口在场时的 app.quit 协商"是必须真跑的分支，
故给定哨兵文件路径后：文件出现 ⇒ 调一次 `app.quit()` 并删除文件（可重复触发）。
未设置或为空 ⇒ 不注册定时器与监听，生产行为逐字节不变。⚠️ 不是授权开关：quit 之后仍走 design D6 的新鲜查询与用户确认。

## 边界（不在本任务宣称的范围）

- 系统注销/关机（`session-end`）按 design D6 不沿用普通退出承诺，其边界核对留给 **6.6**（且明确要求不触发宿主机注销/关机）。
- 1.5s 有界查询的超时降级与慢 renderer 留给 **6.7**；输入法/输入锁细节留给 **6.5**。
- 本任务在真实输入法之外**只用合成级"真系统按键"**（Alt+F4），不涉及 composition 事件，因此不宣称 6.5 的任何结论。

## 复现命令

```bash
node .workbuddy/u3/u3-64/run-all.cjs                      # 全新 dev × 8 tag（每 tag 前清遗留+重启）
node apps/desktop/scripts/u3-64-cdp.cjs --tag=clean-direct # 单 tag（需 dev 已在 9612 且带两个 SMOKE 钩子）
cd apps/desktop && ./node_modules/.bin/vitest.CMD run      # 79 文件 / 1511 用例 / 0 失败
pnpm exec biome check .                                    # 仓库根整跑：357 文件 / 0 错
```
