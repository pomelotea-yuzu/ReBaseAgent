# U4 任务 6.5 — 两种到达顺序、核对不解除别人的锁（含一处真实缺陷修复，2026-09-26）

> 验收（tasks 6.5）：注入响应丢失、status/reconcile 故障和两种到达顺序，
> 验证 Unknown 可核对且无重发/错误解冻。
> 对应 delta 场景（逐字标题）：`reconcile 先到封禁迟到提交`、`执行先到核对实际状态`、
> `核对旧操作不解除另一操作的锁`、`核对终态只解冻对应修订`、`状态通道不可用保持未知`。

## 一、⚠️ 本批最重要的产出：抓到并修复一处真实缺陷

**`reconcileOperation` 从来没调用过解冻口 `settleDraftByOperation`。**

- spec 把「核对到 settled / notAccepted」定为**响应丢失后唯一合法的解冻入口**
  （不自动重发、只能重新核对），实现侧也确实写了 `settleDraftByOperation`
  并钉了「只解匹配 `epoch`/`operationId` 那一条」——但它在真链路上**没有任何调用方**，
  唯一的调用者是它自己的单测（`grep settleDraftByOperation src/` 只有定义处）。
- 后果：真机上无论怎么核对，待定关联都解不开；草稿会一直冻结到换 epoch 或用户显式放弃。
  这是本仓反复出现的同一形态——**「纯逻辑写好、接线少一支」**（U2 5.3/5.4/5.6、U3 6.10 都是它）。
- 修复（`13d6058`）：`reconcileOperation` 在**核对被采纳**且该操作已进终态时，按该身份解冻那一条；
  `applied === false`（旧 epoch / 旧代次 / 低登记版本）、`running`、非法载荷一律**不**动任何关联。
- 新增 6 条接线用例（`test/operation-session-store.test.ts`）：settled 只解那一条 /
  notAccepted 同样 / running 保持冻结 / 别人的身份一条都不解 / 非法载荷按未知且不解锁 /
  解冻不等于删除草稿。
  **反证**：摘掉这支持线 ⇒ 正好判红那 3 条「该解冻」的用例，其余 12 条不动（判据只守它该守的事）。

## 二、机制与口径

- 登记事实只读 main 的 `operations:status` / `operations:reconcile`；界面会话（`s.operations`）只作同源对照。
- **在飞窗口由受控服务 `delayMs` 造出来**（6s）：第一版没给延迟回合，探针读到的是 `settled`
  ⇒ 两条「执行先到应返回 running」的判据假红——**延迟不是装饰，是在飞类判据的前提**。
- 「另一条操作」必须是**完整跑完**的真提交（settled）。反例：只登记关联不发请求 ⇒
  该关联 `epoch` 为 `null`（epoch 在发出时才绑定），核对本就不该解它——那是**构造无效**，
  不是产品缺陷（第一版这么写过，判红后按真实契约改掉了）。
- 计数双核对：`mock.served()` 与 traces 文件数；核对（reconcile）一次都不该增加任何一侧的计数。

## 三、结果（**4 tag / 28 检查 / 0 失败**，整跑 4/4）

| tag | 检查 | 覆盖 |
|---|---|---|
| `probe` | 1/1 | 量出注入通道的真实性（见下节），并把结论固化成判据 |
| `reconcile-first` | 8/8 | 核对先到的 ID ⇒ 建立 `notAccepted` 封禁（`target`/`startedAt` 均为 null，不伪造执行事实）⇒ 之后同 ID 的正式提交被拒 `OPERATION_NOT_ACCEPTED`、封禁不复活、`runIds` 为空、服务与文件计数**一动不动** ⇒ 换一个 ID 正常执行恰 1 次请求 1 份文件（封禁不扩散） |
| `execution-first` | 6/6 | 正式请求已被接受后核对 ⇒ 返回真实 `running` 且槽归属不变；结束后核对返回 `settled` + 真实 runIds；再次核对仍是既有 `settled`，**绝不**补登记 notAccepted；两次核对零新增请求/文件 |
| `lock-isolation` | 13/13 | A 完整跑成（settled）→ B 真提交在飞：期间核对 A ⇒ **B 仍 running、仍占槽、关联仍冻结、门禁仍拒绝**；A 的既有事实未被改写；界面会话与 main 同源（`unknown=false`、本地在飞身份含 B）⇒ B 只能被**自己的响应**收尾，两条 runId 互不相同 ⇒ 两次真提交恰 2 次请求（核对不引发重发） |

明细 `.workbuddy/u4/u4-65/<tag>-measurements.json`；整跑日志 `gates.txt`；截图 `docs/reviews/2026-09-26-u4-65/65-*.png`（`.png` 不入库）。

## 四、`probe` 的实测结论：**桥接面注入在真机做不到**（不冒充实测）

`window.api` 由 contextBridge 暴露，属性描述符实测
`{ writable: false, configurable: false }`；`Object.defineProperty(window.api, 'createRun', …)`
直接抛 `TypeError: Cannot redefine property: createRun`。因此：

| 6.5 题目里的注入 | 真机能否做 | 承载证据 |
|---|---|---|
| 篡改 `status` 返回非法结构 ⇒ 整份拒收、保留未知 | ❌ 不可（不能包装桥接面） | §4 的 store 用例（M-Q「status 载荷不校验就采纳」判红）+ 本批新增「非法载荷按未知且不解锁」 |
| 丢弃执行响应 ⇒ 未知保持、不自动重发 | ❌ 不可（同上；`Page.reload` 那条属 §6.6） | §4 的 M-R/M-S/M-AF + 本批 running/别人的身份两条接线用例 |
| 两种到达顺序、封禁、锁隔离 | ✅ 全真通道 | 本批三个 tag |

⇒ 「非法操作响应不能解除门禁」「状态通道不可用保持未知」这两条**不由 §6.5 实机声称覆盖**；
按 U3 6.6 的先例（`event.sender` 冒名实机不可注入 ⇒ 由 guard 单测承载）分层写明。
`§7.2 evidence-index` 要按这个分层引用，别把单测层写成实机层。

## 五、变异反证

| 编号 | 注入 | 判红 |
|---|---|---|
| M-65A | `submissionByOperation` 忽略 `operationId`（按身份查错人） | **无牙**（13/13 仍绿）——因为核对 A 时 A 的关联早已收尾、`byId` 里只剩 B，而该 tag 的响应路径不经过这个查找口。真实反证由 M-65B 承担 |
| M-65B | 摘掉 §一 那支持线（`reconcileOperation` 不再调 `settleDraftByOperation`） | 3 条判红（settled/notAccepted/草稿保留三处「该解冻」的用例），其余 12 条不动 |

⚠️ 教训延续 U2 6.3 / U3 3.3 / §6.3：**注入必须落在可观测路径上**，「代码看着在防」不等于判据抓得住；
M-65A 就是当场写下、当场被证无牙的一例，保留记录比抹掉它有用。

## 六、边界（如实）

- 本批覆盖：两种到达顺序、封禁不复活、锁隔离、核对不引发重发，以及**修复后的解冻接线（单测层）**。
- 未覆盖并仍是待办：`response-lost` 的实机形态（需桥接面注入，做不到）、
  status 通道失联后的恢复（同上）、同 main 重载与新 epoch ⇒ §6.6；
  关闭协商（`clean+running` 也确认、询问期间新提交被拒）⇒ §6.7；
  窄窗/键盘/逐文件哈希冻结面 ⇒ §6.8。
- 本批的产品改动只有 `store.reconcileOperation` 一处（+ 测试），未触碰 main 侧事实与登记形状。
