# U4 任务 6.3 — proxy 主动重发 × 被动录制交错、无 key、录制写入失败（2026-09-26）

> 验收（tasks 6.3）：实测 proxy 主动重发交错被动录制、无 key/写入失败，核对单请求身份与错误。
> 对应 delta 场景（逐字标题）：`主动代理重发与被动录制交错`、`同 ID 重复请求只执行一次`、
> `只读入口和被动录制不占主动槽`、`接受后业务拒绝仍有可信终态`。

## 一、机制与口径

- **代理启停走 store 真动作** `toggleProxy`（界面状态与 main 同源），upstream 用**不带路径**的
  `http://127.0.0.1:18799`（handler 自己拼 `/v1/chat/completions`；写成 `…/v1` 会发出 `/v1/v1/…` 的失真请求）。
- **外部请求从 harness 进程直连代理**（`fetch` → 127.0.0.1:18787）——渲染层 fetch 受系统代理干扰，
  U3 6.3 已实测；「外部 agent 经代理跑一次」本就是这条通道的设计用法。
- **身份只认 main**：`operations:status` 的登记 `runIds`，并与落盘 `meta.id`、同窗被动 run 的 id **三方比对**
  ——相等就是串号（判红），不是"看起来对上了"。
- **在飞窗口由受控服务 `delayMs` 造出来**（回合 6s）。`submitResend` 在页内捕获关联身份后即返回，
  此时执行仍在飞 ⇒ node 侧有真窗口插入被动录制。
- **写入失败注入 = 在飞窗口内把 `.rebaseagent/traces` 同卷 `rename` 走**（不删一个文件），
  `finally` 无条件还原并核对份数。这是真机上唯一能造出「响应已转发、录制写盘失败」而不破坏数据的方式。
- 「只执行一次」= 受控服务请求增量 **与** traces 文件增量同时成立。

## 二、结果（**5 tag / 67 检查 / 0 失败**，整跑 5/5 通过）

| tag | 检查 | 覆盖 |
|---|---|---|
| `interleave` | 19/19 | 主动 messages 重发在飞期间做一条**被动录制**：两条通道互不阻塞（被动 200 返回）⇒ 主动登记 `running` 且占槽、`target.kind=proxy` ⇒ **被动录制不增加任何登记条目** ⇒ 解冻后 `runIds` 恰 1 且就是本次 fork（≠ 父、≠ 被动）⇒ fork 记录带 `fork.edit.field=messages`、被动那一份 `meta.fork` 仍是 `null`（未被改写）⇒ 本窗新增 2 份 run、服务恰多 2 次请求 ⇒ 草稿保留 |
| `dup` | 14/14 | 同 ID 并发两条真 IPC（同 epoch/operationId/同参）：一条被接受并返回真实 fork 身份，另一条 `OPERATION_DUPLICATED` **不带 data**；两条回执同一身份同一终态；服务 +1、文件 +1；settled 后再提交仍不产生新请求；同 ID 异参 ⇒ `OPERATION_CONFLICT` 且原登记 `runIds`/终态一字未改 |
| `nokey` | 11/11 | 关代理后**越过 UI 直调真 IPC**：`PROXY_NO_KEY` 由 main 独立复核拒绝（渲染层禁用只是 UX）⇒ 回执带同一身份且 `state=settled`、`errorCode=PROXY_NO_KEY`、`requestOutcome=rejected` 类终态、**runIds 为空**（未产生运行时身份）⇒ 零服务请求、零新文件、草稿逐字保留、槽已释放 |
| `write-fail` | 13/13 | 改名前先证明请求**确实在飞**（登记 running 且占槽）⇒ 窗口内目录消失：响应已转发但录制写盘失败 ⇒ `PROXY_RECORDING_WRITE_FAILED`、登记 `settled` + 同一身份回执、**`runIds` 为空（绝不借用别的 run id）**、无半成品文件；还原后被动录制照常落盘且 +1 份、份数与改前一致、草稿保留 |
| `passive-no-slot` | 10/10 | 外部请求在飞时：main 执行槽仍空闲 ⇒ 主动重发被接受、登记与被动互不串号 ⇒ 外部请求正常返回 ⇒ 被动录制**不产生任何登记条目**（登记数只多我们那一次主动提交）⇒ 只读 `status` 在外部流量期间始终可用 |

逐条明细 `.workbuddy/u4/u4-63/<tag>-measurements.json`；整跑日志 `.workbuddy/u4/u4-63/gates.txt`；
截图 `docs/reviews/2026-09-26-u4-63/63-*.png`（`.png` 按仓库约定不入库）。

## 三、本轮坐实的三条事实（写判据前必须知道）

1. 🔴 **注入窗口的位置就是这支判据的命门**。代理 fork 的真实顺序是
   「读父 run → 转发 upstream → 录制写盘」。第一版把目录改名放在**请求发出之前**，
   于是命中 `PROXY_PARENT_INVALID`（读父失败）——那是一条合法但完全不同的拒绝路径，
   `PROXY_RECORDING_WRITE_FAILED` 根本没被触发，三条判据全红却"看起来像在测写入失败"。
   正确做法：先起请求（不 await）→ 读一次 status 证明登记已 `running` → 再改名 → 等响应。
2. **被动录制的 `meta.fork` 是 `null`，不是缺字段**。断言写成 `=== undefined` 会假判"被改写了"；
   判据应是「被动那份 fork 仍为 null，主动那份带 `fork.edit`」。
3. **`servedBefore` 的取点决定算术**。它在 `prepareMessagesDraft`（已含 seed 那次请求）之后取，
   所以交错窗口的期望增量是 **+2**（主动重发 + 交错被动），不是 +3。
4. ⚠️ **一条口径观察（未改产品，留待定夺）**：端点对请求结局的分类规则是
   「**带稳定领域码 ⇒ `rejected`，未预期异常 ⇒ `failed`**」（`exec-endpoints.ts:66` + `toRunResult`）。
   于是 `PROXY_RECORDING_WRITE_FAILED` 登记成 `settled / rejected`——但这一次**请求确实已经执行、
   响应也已转发**，只是录制没落盘。按字面读，`rejected` 更像"我们拒绝执行它"。
   本轮按现状断言（判据仍可信：`settled` + 稳定码 + `runIds` 空 + 不借用别的 id），
   是否要把"执行后写盘失败"改归 `failed` 属**改契约** ⇒ 按纪律应回 proposal/design 再动，
   不在实机批里静默偏离；已在下面「五、边界」列出。

## 四、变异反证（两处判红 + 一处**无牙**记录）

| 编号 | 注入 | 结果 |
|---|---|---|
| M-63A | 摘掉 `ProxyManager.fork()` 的写失败抛出，改成 `return { id: request.parentRunId }`（借用别的 run id 冒充成功） | `write-fail` **3 条判红**（稳定码 / 登记可信终态 / `runIds` 为空），其余 10 条不受影响 |
| M-63B（首版，**无牙**） | recorder 回调里让**被动录制**借用"在场主动上下文"（旧 `lastWrittenRunId` 形状） | `interleave` 19/19 **仍全绿** ⇒ 注入不可观测：交错顺序里被动先完成、主动自己那一份最后写入并覆盖，借用值被盖掉。教训同 U2 6.3 / U3 3.3：**变异要注入在可观测路径上**，"看代码像是在防"不等于判据抓得住 |
| M-63B（改法） | 端点层 `ctx.attachRunId(business.parentRunId)`（登记直接借用父 run 身份） | `interleave` 3 条 + `dup` 2 条判红（含「主动登记只带本次 fork 的一个身份」「runIds 恰 1 就是那条 fork」） |

⚠️ 变异一律用 Edit 工具做（脚本式注入会被沙箱拦）、逐条单独跑、判红即反向改回；
还原后 `git status` 只剩未跟踪的新脚本与 `HANDOFF.md`，再整跑 5/5 复绿。

## 五、边界（如实）

- 本批只覆盖 **proxy 通道**（messages 重发）的身份、交错、重复、无 key 与写失败；
  A/B 整批与 dry-run 归 6.4，响应丢失/status 故障与两种到达顺序归 6.5，同 main 重载与新 epoch 归 6.6，
  关闭协商归 6.7，窄窗/键盘/逐文件哈希冻结面归 6.8。
- 「不二次录制」在这里钉的是**主动重发那一次**的写失败形状（`writeFailure` 记在请求局部上下文、
  原样抛给 handler 自行吞掉以保护转发）；handler 侧的重试语义未在本批制造。
- `PROXY_RECORDING_WRITE_FAILED` 的包层等价判据仍只有端点层反证（§3 的 M-B），
  ProxyManager 层那条「被动录制同窗落盘 ⇒ 主动身份不变」没有独立的注入反证，本批的 M-63B 首版
  恰好说明**为什么**它在该交错顺序下不可观测——别把这条写成"已全部有牙"。
- 未声称 §7 门禁整跑与 `evidence-index.md` 已完成。

## 六、留给后续/用户的待办

1. **口径待定**（§三 第 4 条）：`PROXY_RECORDING_WRITE_FAILED` 这类「已执行、录制写盘失败」是否应从
   `rejected` 改归 `failed`。改就是**改契约** ⇒ 需回 proposal/design，再动 `toRunResult` 的分类规则。
2. `ProxyManager` 层的「被动录制同窗落盘 ⇒ 主动身份不变」仍缺一条**有牙**的注入反证
   （M-63B 首版在该交错顺序下不可观测）；若要补，注入点要选在"最后写入者决定返回值"的形状上。
