# U4 任务 6.1 — 受控服务实测普通/隔离 create（2026-09-26）

> 验收（tasks 6.1）：普通/隔离 create 的成功与模型失败、重复提交及 ID 定位，核对 token 消费和文件数。
> 对应 delta 场景（`openspec/changes/add-desktop-operation-tracking/specs/desktop-ui/spec.md`，逐字标题）：
> `同 ID 重复请求只执行一次`、`普通和隔离创建失败保留 ID`、`结果不可读不重执行且不锁配置`。

## 一、机制与口径

- **一律经真桥接面**：`window.api` → preload → ipcMain，主动执行都带执行信封
  `{operation:{epoch,operationId}, request}`；epoch 由 `operations:status` 现场握手，
  operationId 每次 `crypto.randomUUID()` 同形状新生成。不经 store、不 stub。
- **判据不看界面自述**：提交值与身份以落盘 `.rebaseagent/traces/<id>.jsonl` 的 `meta.id`、
  受控服务收到的请求条数（`GET /__log` 的 `served`）、traces 文件计数**三处同时**核对；
  「只执行一次」= `served` 增量 1 **且** 文件增量 1（任何一处多 1 就是二次执行）。
- **受控服务**：`apps/desktop/scripts/mock-llm-server.cjs`（127.0.0.1:18799，`--script` 剧本 +
  `--log` 请求 jsonl）。成功剧本 `[{content:"好。"}]`；失败剧本 `[{mode:"fail",status:500}]` ⇒
  走真 HTTP 500 分支，不是桩里假抛。
- **隔离创建**：dev 以 `REBASEAGENT_SMOKE_PICK_DIR=<源目录>` 启动（原生目录框不可被 CDP 驱动），
  `chooseSource` 真签发会话 token。令牌消费判据是**反向**的：失败/重复之后再用同一令牌换新
  operationId 必须被 `INVALID_SOURCE_TOKEN` 拒 ⇒ 证明"恰消费一次"，而不是"看起来没报错"。
- **结果不可读**：把刚产出的 `<id>.jsonl` 同卷 rename 走（`finally` 还原），再按同 ID 读 ⇒
  断言读取失败可辨认 + 该操作仍 settled 不占槽 + `saveSettings` 仍成功 + `served` 计数不变。
- 夹具与批量驱动：`.workbuddy/u4/u4-61/run-all.cjs`（单次非沙箱调用内「备夹具 → 写受控 settings →
  起受控服务 → 起 dev → 顺序跑 7 个 tag → 停 dev → 无条件还原 settings」）。
  采集脚本：`apps/desktop/scripts/u4-61-cdp.cjs`。

## 二、结果（**7 tag / 58 检查 / 0 失败**，整跑一次通过）

| tag | 检查 | 覆盖 |
|---|---|---|
| `probe` | 3/3 | 桥接面可用（`getSettings` ⇒ configured=true）、受控服务在监听、traces 目录可读（128 份基线） |
| `plain-success` | 10/10 | 一次请求 ⇒ 一份文件（128→129）⇒ 回执 `settled` 且身份=提交身份 ⇒ status 快照 `runIds=["run_muif…"]` 与落盘 `meta.id` 相符 ⇒ `activeOperationId` 已释放 ⇒ 核对返回既有 settled 且 `served` 不变 ⇒ 按可信 ID `getRun` 成功 |
| `plain-fail` | 9/9 | 模型 500 ⇒ 响应 `ok:false` **但带 settled 回执**、稳定码 `CREATE_RUN_FAILED`；登记 `runIds` **恰 1 个**（结构化身份，非解析 message 里的 run 名）；该身份文件真存在、trace 内确有 `llm.call.error`、`getRun` 可读；`served`=1（不重试）、traces 恰 +1 |
| `isolated` | 8/8 | 真 token 签发 ⇒ 隔离创建成功 ⇒ 落盘 `meta.id` = **世界身份**（`run_muift8ed_7kdn2v`，非 loop 临时 id）⇒ 同 ID 重复提交 ⇒ `served`/文件零增量且**不报令牌失效**（判重在 sourceToken 消费之前）⇒ 换新 ID 复用同一令牌被 `INVALID_SOURCE_TOKEN` 拒（恰消费一次） |
| `isolated-fail` | 9/9 | 隔离创建撞模型 500 ⇒ 回执 settled + `CREATE_RUN_FAILED`，登记仍携带世界身份（恰 1 个、`meta.workspace.origin.kind=import`）、trace 有 `llm.call.error`、可按 ID 读到、traces +1、`served`=1；失败也已消费令牌（换新 ID 被拒） |
| `duplicate` | 12/12 | 并发两条同 ID 同参 ⇒ 只 1 次请求、只多 1 个文件；被接受的一条回 `data.id`，另一条回 `OPERATION_DUPLICATED` **且两条回执身份/终态完全相同**；settled 后再提交仍不产生新请求；同 ID 异参 ⇒ `OPERATION_CONFLICT` 且原登记一字未改（`state=settled`、`runIds` 未增）、`served` 不变 |
| `unreadable` | 7/7 | 文件移走 ⇒ `GET_RUN_FAILED`（ENOENT 可辨认）⇒ 该操作仍 settled 不占槽 ⇒ `saveSettings` 仍成功（不被当成执行中）⇒ 全程 `served` 不变（零重执行）⇒ 还原后按同 ID 重试读取成功、仍零请求 |

截图（本地，`.png` 按仓库约定不入库）：`.workbuddy/u4/u4-61/<tag>/00-app.png` + 每 tag 一张结果态；
逐条检查明细在各 tag 的 `measurements.json`，整跑日志 `.workbuddy/u4/u4-61/gates.txt`，
受控服务请求留痕 `.workbuddy/u4/u4-61/mock-requests.jsonl`。

## 三、本轮坐实的两条**契约形状**（写断言时容易走偏，别再按直觉写）

1. **重复提交的那一条不回 `data`**：被接受方回 `{ok:true, data:{id}}`，
   重复方回 `{ok:false, error.code:"OPERATION_DUPLICATED", operation:{…state:"settled"}}`——
   「返回原关联/终态」落在**回执身份 + 登记版本 + state** 上，运行身份要由 `reconcile`/status 取。
   （采集脚本第一版按"两条都回同一个 id"写断言 ⇒ 判红，是判据错、不是产品错。）
2. **`ReconcileResult` 是「槽状态 + 被查 operation」**：终态在 `data.operation.state` /
   `data.operation.runIds`，**没有** `data.state`。同 ID 异参的拒绝码是 `OPERATION_CONFLICT`
   （判重在指纹比较之后、任何副作用之前）。

## 四、边界（如实）

- 本 tag 只覆盖 **create 两类**（普通/隔离）的成功、失败、重复与不可读；
  result fork / prompt / proxy / A/B 的实机面归 6.2–6.4，Unknown 注入与两种到达顺序归 6.5，
  同 main 重载与新 epoch 归 6.6，关闭协商（含「无草稿但占槽也确认」）归 6.7，
  全局栏操作入口的窄窗/键盘可达归 6.8。
- 「UI 上从执行入口提交」这一面本轮走的是**真 IPC**（桥接面 + main 全链路），
  不是页面点击；页面接线由 §4 的契约用例 + 6.2/6.8 的实机面共同守住。
- `mainEpoch` 更换、renderer 崩溃/失联未在本 tag 制造（归 6.6/6.7）。
- settings 指向受控服务是**临时改写**，run-all 结束无条件还原（本轮运行前不存在 settings ⇒
  删除本轮写入，不留受控配置）。

## 五、环境坑（后续 tag 照抄）

- 改过 `src/main` ⇒ run-all **必须**拒绝复用已监听的 9612（否则跑的是旧 main，判据全假）。
- dev 与全部 tag 必须在**同一次非沙箱 Shell 调用**内完成（dev 跨调用不存活）；spawnSync 全线 EBUSY ⇒ 异步 spawn。
- `playwright-core` 不在仓库里，走 `NODE_PATH=C:/Users/28145/.workbuddy/binaries/node/workspace/node_modules`。
- 本机 netsh 排除段含 9222 ⇒ CDP 端口用 **9612**。
- 清理只按 task 前缀（`U4 6.1 冒烟`）认自己产出的 run，历史数据与夹具不动。
