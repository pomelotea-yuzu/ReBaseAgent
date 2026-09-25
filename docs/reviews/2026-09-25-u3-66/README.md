# U3 任务 6.6 实机证据：renderer 崩溃 / 失联 / 重载 / 旧·伪造消息 × 系统会话结束边界

日期：2026-09-25 · dev（非沙箱，CDP 9612，验收钩子 `REBASEAGENT_SMOKE_EVENT_FILE`，独立 dev 实例、每 tag 全新重启）
驱动：`apps/desktop/scripts/u3-66-cdp.cjs`（**5 tag / 64 检查 / 0 失败**）
系统级通道：复用 6.4 的 `apps/desktop/scripts/lib/u3-64-winops.ps1`（Win32 P/Invoke + UIAutomation）+ 新增屏幕截取（原生 `#32770` 框不在网页里，CDP 截图截不到）
批量驱动：`.workbuddy/u3/u3-66/run-all.cjs` · 逐 tag 输出 `.workbuddy/u3/u3-66/measurements.json` · 门禁日志同目录
夹具：复用 6.1 的运行清单（普通父 `run_mughwjk4` 的 `s_03` 为草稿落点）。零模型调用：本任务只碰关闭协商与注入钩子，不发任何请求。

## 四条验收判据 → 五个 tag

| 判据 | tag | 结果 |
| --- | --- | --- |
| renderer 失联仍有退出确认（崩溃面） | `crash-gone` 12/12 | 哨兵 ⇒ main 真调 `forcefullyCrashRenderer()` ⇒ CDP 求值失联 + 窗口仍在（失联 ≠ 消失）；`close-titlebar` ⇒ **仍出原生确认**（unknown 文案「暂时无法确认草稿状态」，不含「已崩溃」诊断）+ 崩溃遗留标志 ⇒ 文案含「先前会话…可能已经丢失」；点返回后窗口/PID 存活；**再关闭仍保守询问**（unknown 不因返回放行），且丢失说明随「返回=已知悉」清除（第二次文案无「丢失」） |
| renderer 失联仍有退出确认（挂起面 + 恢复） | `hung-timeout` 15/15 | 真同步忙等 9s 冻结 renderer（**不合成任何事件**）⇒ 关闭走 1.5s 超时降级出确认（无丢失说明，因无会话丢失事件）⇒ 可取消、窗口进程存活；冻结结束后渲染层恢复可核对、排队中的旧查询/释放按序消化**不遗留输入锁**、草稿逐字未丢；再关闭是 fresh dirty 询问；放弃后 clean 直退（窗口+PID 真实消失） |
| 重载不能用空仓库抹掉旧会话未知状态 | `reload-empty-repo` 15/15 | 真 dirty 上报（页内 `dirtyCountOf≥1`）⇒ CDP `Page.reload` 真文档轮换（sessionId 变化）⇒ 新会话空仓库（`dirtyCount=0`）；关闭 ⇒ **clean 应答仍被降级为确认**，文案含丢失说明，且输入锁在场证明"渲染层确实应答了"（非超时假降级）；点「返回」= 用户确认知悉 ⇒ 再关闭零询问直退（标志**只能**由用户确认清除、且确实被清） |
| 旧会话伪造发送者和乱序消息不影响关闭 | `forged-stale` 13/13 | 7 类伪造经真 preload 通道直发：假会话 id、旧会话+更小序号（乱序/重放）、负序号/非整数/超界计数（schema）、无挂起查询的应答、假会话应答；重载后再重放旧会话 report+answer。断言全部"无效果"：不发确认、不误置锁、不搞死进程；**反证收口**＝全部被拒 ⇒ 旧会话按真实 clean 状态轮换 ⇒ 关闭零询问直退、窗口/PID/CDP 端口真实消失（任何一条被接受都必出询问，见变异 B） |
| 系统会话结束不沿用普通退出承诺 | `session-event` 9/9 | 哨兵 ⇒ main 在真窗口上**合成** `query-session-end` / `session-end`（**不触发宿主机注销/关机**）⇒ 零确认框、窗口/进程存活、应用可用、草稿未被改动、哨兵一次性消费；随后普通关闭仍走协商出 dirty 询问、确认退出真实结束（合成事件既没沿用、也没破坏普通退出承诺） |

视觉证据：`66-crash-gone-dialog.png`（崩溃白屏 + unknown 确认框含丢失说明）、`66-reload-empty-repo-dialog.png`（空仓库仍出询问 + 输入锁在场）、`66-forged-stale.png`（伪造后页面现场）。

## 隔离事件测试（与实机互补）

- `apps/desktop/test/u3-66-smoke-hook.test.ts` 8 用例：动作白名单（`crash-renderer` / 两种系统会话结束事件，白名单外零副作用）、哨兵消费节奏（一次性、窗口不在时消费不执行、dispose 后停轮询、无文件永不触发）、**新契约**：钩子文件自身不得注册任何事件监听（`.on(` / `.once(` / `addListener(` 一律禁止）——「产品对系统会话结束零接入」的 D6 红线（4.4 契约，`draft-close-flow.test.ts` 已锁 index/attach）跨文件成立。
- 既有单测继续承载实机做不到的两类拒绝：`event.sender.webContentsId` 冒名（非目标窗口）与子 frame 冒名——这两项**渲染层无法从内部伪造**（sender/frame 由 Electron 注入事件对象，preload 载荷原样透传碰不到它们），实机面因此聚焦 sessionId/sequence/requestId/schema 四层校验。

## 变异（先证明有牙，再宣布通过）

| 变异 | 注入点 | 被谁捕获 |
| --- | --- | --- |
| U-M1 | 钩子 default 分支放行未知动作 | 单测「白名单外零副作用」 |
| U-M2 | 哨兵不删除（可重复触发） | 单测「一次性消费」×2 条 |
| U-M3 | 窗口不在也执行 | 单测（TypeError 崩溃暴露） |
| U-M4 | 两种系统事件一律 emit `session-end`（名字混淆） | 单测事件名断言 |
| R-A | `rotateSession` 不评估旧会话（丢 pendingLoss 置位） | **实机 `reload-empty-repo` 判红**（exit=1：无确认框、丢失说明缺失） |
| R-B | `handleMetadataMessage` 跳过 sessionId 校验 | **实机 `forged-stale` 判红**（exit=1：dialogs=1，丢失询问出现，直退被打破） |

脚本：`.workbuddy/u3/u3-66/mutate.cjs`（单测面）· `.workbuddy/u3/u3-66/u3-66-guard-mutate.cjs`（实机面，注入→跑 tag→还原，产品代码零残留，`git diff` 已核）。

## 抓到的 harness 真实缺陷（假绿通道，已修）

**失联后的无界 `await` ⇒ node 事件轮排空 ⇒ 进程以退出码 0 静默结束**。首轮变异 R-A 跑出两条 ✗ 后 harness 无任何收尾输出，run-all 却记 `exit=0`（汇总 1/1 通过）——判红信息全丢、**假绿**。根因：renderer 进程消失后 CDP ws 处于"半开"（send 不抛、回应永不到），`overlayPresent`/`shot` 的无界 await 永不 settle。修法（不改判据，只加边界）：
1. 全部 CDP 求值走 `callBounded`（25s 有界，超时抛错 ⇒ 计入「场景未抛异常」判红）；
2. 崩溃 tag 的收尾截图 15s race；
3. 全局看门狗：240s 未收尾 ⇒ 落盘已有检查并以 exit 3 结束。
修后 R-A/R-B 双双如实判红（exit=1）。⚠️ 这条坑对后续所有"会把应用关掉/弄死"的 tag（6.7+）同样成立：**harness 里凡可能命中失联通道的 await 必须有界**，否则红绿不可信。

## 新增 dev-only 钩子（唯一产品侧改动）

`apps/desktop/src/main/smoke-event-hook.ts` + `index.ts` 装配（`REBASEAGENT_SMOKE_EVENT_FILE`，与 6.4 的 QUIT 哨兵同族）：哨兵文件内容 ∈ {`crash-renderer`, `query-session-end`, `session-end`} ⇒ 对当前窗口执行；白名单外不执行。**只发起/合成、不新增监听、不新增 IPC 通道**；未设置环境变量 ⇒ 不注册定时器，生产行为逐字节不变。⚠️ 不是授权开关：崩溃后关闭仍走 D6 的 unknown 保守询问。

## 边界（不在本任务宣称的范围）

- `<1.5s / >1.5s` 应答延迟注入与 CPU 降速归 **6.7**；本任务的超时证据是"renderer 完全不应答"这一极限。
- 真实慢机校准不在开发机上宣称（tasks 6.7 口径）。
- 系统会话结束的"真实 OS 注销/关机路径行为"不实测（按 design D6 不承诺），本任务核对的是**事件边界**：产品零接入 + 合成事件零效果 + 普通承诺不受污染。
- 崩溃/挂起注入依赖 dev-only 钩子；打包产物无该环境变量 ⇒ 该注入面不存在，不构成生产攻击面。

## 复现命令

```bash
# 单 tag（需 dev 已在 9612 且带钩子）：
node .workbuddy/u3/u3-66/run-all.cjs [crash-gone hung-timeout reload-empty-repo forged-stale session-event]
# 单测面：
cd apps/desktop && ./node_modules/.bin/vitest.CMD run test/u3-66-smoke-hook.test.ts
# 变异：node .workbuddy/u3/u3-66/mutate.cjs --inject=1..4 | --restore
#       node .workbuddy/u3/u3-66/u3-66-guard-mutate.cjs --inject=A|B | --restore（跑完必须 --restore）
```

## 门禁（2026-09-25 实测）

- desktop vitest 全量：**80 文件 / 1519 用例 / 0 失败 / 无 Errors 行**（基线 79/1511 + 本任务 1 文件 8 用例，文件级差集吻合）
- `biome check .` 仓库根整跑：**361 文件 0 错**（EXIT=0）
- `tsc` 双配置（node/web）：0；`electron-vite build`：EXIT=0
- `openspec validate --all --strict`：**13 passed / 0 failed**
