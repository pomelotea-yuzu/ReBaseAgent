# U4 任务 6.2 — 普通/隔离 result 与 prompt：切页面核对登记与草稿 + 原门禁回归（2026-09-26）

> 验收（tasks 6.2）：实测普通/隔离 result 与 prompt，切页面后核对登记和草稿，回归授权/父链/轮末门禁。
> 对应 delta 场景（`openspec/changes/add-desktop-operation-tracking/specs/desktop-ui/spec.md`，逐字标题）：
> `所有入口实际使用同一适配器`、`提交快照独立于编辑器挂载`、`分叉在已知身份后异常仍可关联`、
> `核对结果只由用户明确打开`。

## 一、机制与口径

- **真 UI 提交**：真点击 / 真 Monaco 键入 / 真 store / 真原生 `window.confirm`（CDP `Page.javascriptDialogOpening` 真应答），
  执行走真 IPC（renderer 适配器 → preload → main → `OpenAiCompatClient` → 受控服务）。
  **不是**直调 `window.api`（那一条已在 6.1 用真桥接面覆盖）。
- **在飞窗口是造出来的**：受控服务回合带 `delayMs:6000`，「切页时仍在飞」是实测而非假设；
  提交与切页发生在**同一次页内求值**里（click → 轮询到关联出现 → 点 role=tab 切「概览」→ 再读一次关联），
  因此「卸载不换关联」有直接证据（前后 `operationId` 相同）。
- **登记事实只读 main**：`operations:status` 是真相源；renderer 会话（`s.operations`）只作对照，
  用来证明界面与 main 同源（同 epoch、同一 `activeOperationId`、本地在飞身份含本次）。
- **提交值核对**：落盘 `meta.fork.edit.value` 逐字 == 关联快照 == 草稿原文；
  prompt 那条再看**子 run 首次请求的 system 消息**（模型真收到，不是只落盘）。
- **只执行一次**：受控服务请求增量 1 **且** traces 文件增量 1（两处同时成立）。
- 夹具复用 U3 6.1 的真实 run（`.workbuddy/u3/u3-61/manifest.json`：`normalRun` / `isoRoot`），
  机制层从 U3 6.3 抽出为 `apps/desktop/scripts/lib/u4-smoke-harness.cjs`（6.3–6.8 继续复用）。

## 二、结果（**4 tag / 93 检查 / 0 失败**，整跑 4/4 通过）

| tag | 检查 | 覆盖 |
|---|---|---|
| `result-nav` | 33/33 | 普通 result 时间旅行：提交前门禁可提交 ⇒ 关联带 `epoch/operationId` ⇒ **在飞期间切页签+切 run** ⇒ 关联仍冻结、草稿原样、main 登记 `running` 且占槽、目标摘要只有定位事实（kind/mode/parentRunId/atSpanId/editField）、登记不含正文、界面与 main 同源、门禁拒绝新提交并给理由 ⇒ 响应后按身份解冻且成功 ⇒ 落盘 `fork.edit.value`=快照 ⇒ 登记 `settled` + `runIds` 就是那份新 run ⇒ 槽释放 ⇒ 服务恰 1 次请求 ⇒ 全局入口显示「已收口+完整 operationId+可信 runId」⇒ **「核对状态」不导航 / 「打开记录」才导航并读到详情** ⇒ 列表刷新不删登记 ⇒ 重开编辑器草稿仍是原文 |
| `prompt-nav` | 21/21 | prompt fork 同一适配器：经**原生确认**真发生 ⇒ 登记摘要 `editField=system_prompt`（不是写死的 `system_prompt`：本 tag 编辑的就是该字段，M-D 类风险由摘要逐字段断言钉住）⇒ 在飞切页同一段判据 ⇒ 子 run 首次请求的 system 即提交快照 ⇒ `settled` + runIds 指向子 run ⇒ 草稿保留 ⇒ 全局入口同一登记可查 |
| `isolated-gates` | 23/23 | 隔离 result 续跑的三条原门禁：未预检 ⇒ 提交禁用**且零登记零请求**；预检通过并显示**轮末检查点**、只读预检不占槽；未授权 ⇒ 仍禁用；授权后才提交（`mode=isolated` 摘要正确）⇒ 在飞切页判据同段 ⇒ `runIds` = 世界身份、子 run `workspace.origin.kind=checkpoint` 且 `run_id` 指向父 ⇒ **重开后草稿保留、授权复位、未授权继续禁用** |
| `error-identity` | 16/16 | 空 fork ⇒ 禁用且零登记零请求（前置拒绝不是「登记后被拒」）；模型 503 ⇒ 关联按身份收尾（解冻不悬挂）⇒ **已写 meta 后失败仍带真实新 ID**（恰 1 个、文件真存在、`llm.call.error` 与 `run.event=errored` 都在）⇒ 可按同一 ID 打开失败记录（不自动导航、不重执行）⇒ 服务恰 1 次、traces 恰 +1、草稿不被清 |

逐条明细：`.workbuddy/u4/u4-62/<tag>-measurements.json`；整跑日志 `.workbuddy/u4/u4-62/gates.txt`；
截图 `docs/reviews/2026-09-26-u4-62/62-*.png`（按仓库约定 `.png` 不入库）。

## 三、本轮坐实的关键口径：**`settled` / `requestOutcome=returned` 都不是「运行成功」**

`error-identity` 第一版把「模型失败」写成断言 `登记必须报错码 / 界面 forking==='error'`，实机判红两次：
真实行为是 **`runLoop` 不把 LLM 失败抛出** ⇒ 编排正常返回一个 errored run ⇒

- 登记：`state=settled`、`requestOutcome=returned`、`errorCode=null`；
- 界面：`forking==='success'`（它说的是「这次提交完成了」）；
- 失败事实只在 **trace 侧**：`llm.call.error{message,status:503}` + `run.event{event:"errored",reason:"error"}`。

这不是产品缺陷，而是 U4/U3 一直遵守的口径（见 `lib/draft-submission` 与 §十「关键口径」段：
`requestOutcome=returned` 只表示编排正常返回）。判据因此改成钉**两个口径不混用**：
「登记不谎称业务错误」+「那份 run 的真结局是 errored ⇒ 已收口 ≠ 跑成功」。
⚠️ 后续写失败类断言时别再按「失败必须有 errorCode」的直觉写。

## 四、变异反证（两处，全部按预期判红后还原复绿）

| 编号 | 注入 | 判红的用例 |
|---|---|---|
| M-62A | `deriveEntryGate` 恒返回 `{canSubmit:true}`（摘掉界面门禁） | 1 条 —— `A result：在飞期间界面门禁拒绝新提交并给出理由`（其余 32 条不受影响，说明这条判据只守住它该守的事） |
| M-62B | `OperationsEntry` 的「核对状态」里混入 `reopenRun`（两条通道混用） | 1 条 —— `A 核对不导航：当前页面不因核对改变`（实测导航到了新 run，正是 spec 禁止的混用） |

⚠️ 变异一律用 Edit 工具做（脚本式注入会被沙箱拦）、**逐条单独跑**、判红即反向改回；
还原后 `git diff` 为空并复跑整批 4/4 全绿。

## 五、harness 侧踩到的四个坑（后续 tag 直接照抄）

1. **静默 exit 0**：把 `main()` 的调用删掉后脚本仍然「通过」（exit 0、零输出）⇒
   现在文件末尾显式 `main().catch(...)` + **10 分钟看门狗 exit 3**；新增 tag 别忘了调用入口。
2. **Vite 模块 URL 有两种形态**：`appImport` 的 needle 必须同时给
   `/src/renderer/src/lib/xxx.ts` 与 `/src/lib/xxx.ts`（root=renderer），否则拿到
   `{error:"module-url-not-found"}`——本轮两条门禁判据一开始就是这么假红的。
3. **全局栏入口按钮是开关**：`button[aria-controls="operations-panel"]` 再点一次会**收起面板** ⇒
   「核对后再看一眼」测成「登记消失」的假故障；helper 已改成先读 `aria-expanded` 的幂等展开。
4. **失败注入也要 `delayMs`**：毫秒级返回会让「点完再查关联」扑空（U3 6.3 同坑，本轮在
   `FAIL_TURN` 上复发）⇒ 需要在飞捕获的 tag 一律给失败回合加延迟。
5. 端口紧邻起停的已知 flake：跑完实机批后整跑 desktop，`test/controlled-service.test.ts`
   一条红 ⇒ **单跑 19/19 全绿**、复跑整跑 103 文件 / 1822 用例全绿。按 HANDOFF 口径不写成回归。

## 六、边界（如实）

- 本 tag 只做 **result（普通/隔离）与 prompt** 两条入口的实机面；
  proxy 主动重发与被动录制交错归 6.3，A/B 整批与 dry-run 归 6.4，
  响应丢失/status 故障/两种到达顺序的 Unknown 核对归 6.5，同 main 重载与新 epoch 归 6.6，
  关闭协商（`clean+running 也确认`、`询问期间新提交被拒`）归 6.7，
  800px/200%/键盘与逐文件哈希冻结面归 6.8。
- 「执行期间第二入口被拒」这里钉的是**界面门禁 + main 占槽事实**；
  跨入口并发只接受一个的完整矩阵在 §3 的 `test/exec-entry-matrix.test.ts`（44 例）里。
- 未在本批制造 renderer 崩溃/失联与伪造消息（归 6.5/6.6/6.7），也不声称 §7 门禁整跑已完成。
