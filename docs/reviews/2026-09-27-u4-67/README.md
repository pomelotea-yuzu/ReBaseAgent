# U4 任务 6.7 — 关闭协商的真机面（§5 合并文案的正主，2026-09-27）

采集：`apps/desktop/scripts/u4-67-cdp.cjs`（5 tag：`clean-running` / `altf4-dirty` / `frozen-unknown` / `quit-return` / `quit-executing`）
驱动：`.workbuddy/u4/u4-67/run-all.cjs`（逐 tag「起全新 dev（带 quit 哨兵钩子）→ 跑 tag → 停 dev」+ 无条件还原 settings）
系统级通道：复用 U3 6.4 的 `apps/desktop/scripts/lib/u3-64-winops.ps1`（关闭投递 / `#32770` UIA 读写 / 全屏截取）
读数：`.workbuddy/u4/u4-67/<tag>-measurements.json`；截图：本目录 `67-*.png`
夹具：复用 6.1 的运行清单（`normalRun`）；"在飞"由受控服务 `delayMs` 回合撑开，全程真桥接面带执行信封。

## 一、结论

**5 tag / 82 检查 / 0 失败**，三处变异各自判红、还原后整跑复绿，**零产品代码改动**。
覆盖 tasks 6.7 的四条验收：

| 场景（spec / tasks 原文） | 落在哪个 tag | 关键判据 |
| --- | --- | --- |
| `无草稿的活跃操作也需确认` | `clean-running`（22 条） | 无草稿但 main 占槽 ⇒ **仍弹一次确认**（文案档 `有操作正在执行`）；询问期间第二主动入口被 main 拒（读 `closing` + `notAccepted`，不看界面置灰）；返回不释放槽、登记不丢；被拒那条 `notAccepted` 永不复活 |
| `草稿与操作合并且关闭竞争不漏保护` | `altf4-dirty`（20 条）+ `frozen-unknown`（16 条） | Alt+F4 与标题栏走同一条协商 ⇒ **一次**合并文案；无应答期间连发关闭仍至多一层（不重入）；unknown 档合并 `暂时无法确认草稿状态，且有操作正在执行` |
| `退出输入锁保留已接收文字且不重放按键` | `altf4-dirty` | 锁内真键盘（先显式 focus 再 `Input.dispatchKeyEvent`）不改写表单；锁内真鼠标点击不触发提交；往返后草稿逐字保留 |
| `重复关闭取消和迟到应答不会重入` | `frozen-unknown` + `quit-return` | 冻结 4s ⇒ 应答迟到 >1.5s 阈值 ⇒ unknown 降级；取消走"点击-核对-重试"排空；迟到应答零后续效果（不弹新框、不关窗）；app.quit 返回 ⇒ 退出被阻止、下次 quit 照常协商 |

`quit-executing`（11 条）补上"确认退出 × 操作仍在飞"：进程真结束、被打断那次只留自己那一份未完成文件、
既有历史逐字节不变、退出未重放请求。

## 二、本批采到的合并文案（UIA `dialog-text` 逐字，非界面自述）

| tag | message 档 | 按钮 |
| --- | --- | --- |
| `clean-running` | `有操作正在执行` | 返回 \| 退出 |
| `altf4-dirty` | `有未放弃的调试草稿，且有操作正在执行` | 返回 \| 退出并丢弃草稿 |
| `frozen-unknown` | `暂时无法确认草稿状态，且有操作正在执行` | 返回 \| 退出 |
| `quit-return` | `有未放弃的调试草稿，且有操作正在执行` | 返回 \| 退出并丢弃草稿 |
| `quit-executing` | `有操作正在执行` | 返回 \| 退出 |

三条措辞纪律都在真机核对：不诊断 renderer 存活（无"已崩溃/失联/无响应"）、活跃操作只陈述"尚未结束 +
退出不会取消上游/不撤销副作用/不标已取消"、unknown 档不宣称草稿已丢失。

## 三、三条实机口径（后续批次照此写判据）

1. **§5 把 closing 接进了 registry ⇒ 询问期间"第二个入口被拒"是 main 事实**：判据一律读
   `operations:status` 的 `closing` 与被拒记录的 `notAccepted/rejection`，不看界面置灰。
   界面侧只有**采纳了 main 快照之后**才会 `blockedBy=closing`（"应用正在退出"）。
2. **原生 `#32770` 只在 UIA 侧，CDP 看不见**（`Page.javascriptDialogOpening` 只对页内 `window.confirm` 触发）⇒
   文案判据走 `dialog-text` 读 `message`+`detail`+按钮，视觉证据走 `CopyFromScreen` 全屏截取。
3. **在飞类判据必须给 `delayMs` 回合**（6.5/6.6 各栽过一次）；且 `run` 文件在**运行开始**就落盘 ⇒
   "被拒/重放零副作用"要以"那次在飞出门之后的份数"为基准比增量，不用绝对份数。

## 四、变异（先证明判据有牙，全部用 Edit 注入、跑红即 `git checkout` 还原）

| 编号 | 注入 | 落红的判据 |
| --- | --- | --- |
| M-67A | `evaluateCloseOutcome` 的 clean 判据**忽略活跃槽**（去掉 `activeOperationId === null`） | `clean-running`：窗口直接退出、无确认 ⇒「无草稿但 main 占槽 ⇒ 仍弹一次确认」判红（dialog=null）+「措辞纪律」连锁红 |
| M-67B | 协商开始**不置 closing**（摘掉 `ports.setClosing(true)`） | `clean-running`：恰好 2 条红——「询问期间 main 的 closing 标记在场」（closing=false）+「blockedBy=closing」（退化成 `operation_running`）。⚠️ 注意「第二入口被拒」**仍绿**：槽本就忙 ⇒ 拒绝靠 busy 不靠 closing，这条判据**不是 closing 专属**，如实标注 |
| M-67C | `buildCloseConfirmText` 的 dirty/unknown 两档**丢掉"且有操作正在执行"** | `altf4-dirty` 合并文案红 1 条 + `frozen-unknown` unknown×活跃合并红 1 条（各仅 1 条，其余不动 ⇒ 精准命中合并档位判据） |

还原后整跑：**5/5 / 82 检查 / 0 失败**（见 `.workbuddy/u4/u4-67/gates.txt` 与逐 tag measurements）。

## 五、harness 侧新踩（本批特有，写脚本时照用）

- 🔴 **winops 的按钮是 `button[0]=返回 / button[1]=退出` 两个键**，不是单一 `button` ⇒ 用
  `/^button\[\d+\]$/` 前缀收集再按下标排序拼。首版按 `info["button"]` 取 ⇒ 永远空串，
  「退出并丢弃草稿」这类按钮文案判据会假红。
- 🔴 **新建运行对话框是 `showModal()`（top layer）**：`DraftCloseLockOverlay` 的 `z-[200] fixed` 盖不住它 ⇒
  锁内真鼠标点击的"输入锁生效"证据**不是** `elementFromPoint` 命中遮罩，而是**捕获阶段 preventDefault**
  （`use-draft-close-guard` 对 modal 也拦 mousedown/click）。判据要写成"点『创建』不触发提交"，
  别写成"命中的是 `draft-close-lock`"（那样在 top layer 下必假红）。
- 🔴 **桥接面外带发起的在飞操作不会被界面轮询自动推进**：轮询只在 renderer **自己经手过提交**时才武装
  （`ensureOperationStatusPolling` 挂在 submitActive 上）。本批用 `fireCreate`（真桥接面、不经 store）造在飞 ⇒
  界面要读到终态必须先 `refreshOperationStatus()`（等价用户点开面板）。据此把"返回不释放槽"读 main、
  "界面按身份显示已收口/未接受"读点开后的面板，不拿 `waitViewIdle` 空等。
- **`app.quit` 走既有验收钩子** `REBASEAGENT_SMOKE_QUIT_FILE`（U3 6.4 起，非新增）：驱动给 dev 带上哨兵路径，
  tag 内 `writeFileSync(QUIT_FLAG)` ⇒ 轮询命中调一次 `app.quit()` 并删文件（消费后 `existsSync=false` 本身是一条判据）。
- **teardown 必须套超时**：`clean 直退` 类 tag 跑完时应用已真退出 ⇒ 页内 `apiCall` 无界会挂到看门狗 ⇒
  `Promise.race([teardown, sleep(20s)])`，随后无条件 `mock.close()`（受控服务在 tag 进程内，关它不依赖应用存活）。

## 六、边界（如实标注，不冒领）

- **`unknown` 降级由真冻结诱发**（同步忙等冻结 renderer 主线程），量的是"阈值两侧行为正确"
  （迟到必降级、阈内不误伤、降级后可取消可重核对），**不**宣称 1500ms 已在真实慢机校准
  （沿用 `draft-close-flow.ts` 头注口径）。
- **输入法组合分支（`inputSettled=false`）不在此批**：本机 Monaco 走 `native-edit-context`、组合期无 composition
  事件（见项目记忆 `desktop-uia-close-harness-gotchas.md`），该分支仍按 U3 6.5 留 §7。
- **配置变更中（`configurationBusy`）的合并档**在本批未单独诱发：造一个"确定性的、够长的配置在飞窗口"
  比 `closing` 难（toggle 很快释放）；`buildCloseConfirmText` 的 `有一次配置变更尚未完成` 文案由 §5 单测
  （`buildCloseConfirmText` 5 条 + M-CL4）承载，**不冒充实机已测**。

## 七、复现命令

```bash
# 全批（逐 tag 全新 dev + quit 哨兵钩子）
node .workbuddy/u4/u4-67/run-all.cjs
node .workbuddy/u4/u4-67/run-all.cjs clean-running quit-executing   # 或指定 tag
```

变异用 Edit 注入 `apps/desktop/src/main/draft-close-flow.ts`（M-67A 在 `evaluateCloseOutcome`、
M-67B 在 `run()` 首行、M-67C 在 `buildCloseConfirmText`），改过 main ⇒ 重跑会自动起新 dev；
跑红后 `git checkout apps/desktop/src/main/draft-close-flow.ts` 还原。
