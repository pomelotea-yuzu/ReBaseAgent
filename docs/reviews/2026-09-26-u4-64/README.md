# U4 任务 6.4 — A/B：dry-run 只读、实际部分失败保留各臂事实、整批占一个槽（2026-09-26）

> 验收（tasks 6.4）：实测 A/B dry-run、实际部分失败与批次期间第二操作/配置拒绝，逐臂比对 trace。
> 对应 delta 场景（逐字标题）：`A-B 一批占槽直到全部收尾`、`A-B 部分失败保留各臂事实`、
> `只读入口和被动录制不占主动槽`、`接受后业务拒绝仍有可信终态`。

## 一、机制与口径

- **父本是现造的**：A/B 首期只接受**无副作用工具表**的父本（`MODEL_AB_TOOL_POLICY` 实测拒掉带
  `write_file` 的历史夹具父本），且臂的模型调用次数 = 父本步数、受控服务**回合按调用序消费** ⇒
  必须用「空工具表 + 单轮」的纯对话父本，剧本才是确定的：`[父本回合, 臂 A 成功回合, 臂 B 503 回合]`。
  父本经真 IPC `runs:create` 产出，并当场核对 `meta.config_hash` 存在、`llm.call` 恰 1 次（A/B 门禁）。
- **逐臂对落盘**：登记 `arms[i].id` 与那份 `.jsonl` 的 `meta.id` 比对，
  成功臂必须「无 `llm.call.error` 且结局不是 `errored`」、失败臂必须「有 `llm.call.error` 且 `run.event=errored`」，
  两臂 id 互不相同（不是把同一份记两次）。
- **整批占槽的证法**：批次在飞期间（臂 A 回合 `delayMs:6000` 造窗口）做三件事——
  ① `activeOperationId` 就是这批的 operationId；② 第二个主动入口（result fork）被拒
  `OPERATION_NOT_ACCEPTED` 且登记 `notAccepted/rejection=busy`、零身份、零请求、零文件；
  ③ 配置写 `settings:save` 被 main 拒绝，而 `settings:get` / `runs:list` 照常可用。
- **只读预览走独立通道**：`runs:modelAbPlan`（不带执行信封）⇒ 零登记、零请求、零文件、槽仍空闲。

## 二、结果（**2 tag / 35 检查 / 0 失败**，整跑 2/2）

| tag | 检查 | 覆盖 |
|---|---|---|
| `dry-run` | 12/12 | 父本满足 A/B 门禁（`config_hash` + 恰 1 次调用）⇒ 预览成功返回计划（两臂、有 `experimentId`、`changed`/`added` 如实算出）⇒ **`data.ids` 为空**（没有臂落盘）⇒ 零模型请求、零新文件、**不产生任何登记条目**、不占槽 ⇒ `dryRun` 误闯主动通道被拒 `MODEL_AB_DRY_RUN_CHANNEL`，且仍留可信终态（`settled/rejected`、`runIds` 空、零执行）⇒ 只读入口前后都可用 |
| `partial-fail` | 23/23 | 批次在飞：登记 `running` 且整批占住唯一的槽 ⇒ 期间第二主动入口被拒（`OPERATION_NOT_ACCEPTED`，登记 `notAccepted/rejection=busy`，零身份零请求零文件）⇒ 期间配置写被 main 拒、配置读仍可用 ⇒ 收尾：整批一条操作 `settled`、目标摘要 `kind=modelAb` + `armCount=2`、携带 `experimentId` ⇒ **两臂都有真实身份（失败臂不丢 id）**、`runIds` 覆盖两臂、traces 恰 +2、服务恰 +2（无重试）⇒ 逐臂与落盘 trace 对得上（臂 0 干净、臂 1 确有 `llm.call.error` + `errored`）⇒ **`data.ids` 只数成功臂**（部分失败不谎报成功数）⇒ 槽释放后配置写恢复可用 |

明细 `.workbuddy/u4/u4-64/<tag>-measurements.json`；整跑日志 `.workbuddy/u4/u4-64/gates.txt`；
截图 `docs/reviews/2026-09-26-u4-64/64-*.png`（`.png` 按仓库约定不入库）。

## 三、本轮坐实的结果形状（写断言前必看）

1. **`ModelAbResult` 的计划条目在 `data.plan`，不是 `data.arms`**；`data.ids` 是**成功臂**的 id
   （dry-run 恒为空数组）。第一版按 `data.arms` 读 ⇒ `plan.data.arms.map` 直接 TypeError，
   连累后面几条判据一起假红。
2. **登记侧的臂事实是另一套形状**：`OperationRecord.arms[i] = {index, id, outcome}`（`outcome` 是请求结局），
   与 `data.ids`（成功臂 id）不是同一个口径——两边都要断言，不能只断言一边。
3. **A/B 父本门禁会在预览阶段就拒**（`MODEL_AB_TOOL_POLICY`）：夹具父本带 `write_file` ⇒
   别指望"先过预览再说"，父本必须现造。

## 四、变异反证（两处，各只打红该红的那几条）

| 编号 | 注入 | 判红 |
|---|---|---|
| M-64A | `fork-runner` 的 `ids` 过滤改成「有 id 就算成功臂」（U3 6.3 修前的旧形状） | `partial-fail` **1 条**：`data.ids 只计成功臂（部分失败不谎报成功数）`——实测 ids 从 1 变 2（把 503 臂也报成成功） |
| M-64B | 摘掉 `exec-endpoints` 里「`dryRun` 不许闯主动执行通道」的早退 | `dry-run` **2 条**：`dryRun 误闯主动通道被拒`（变成 `ok:true` 返回计划并登记）、`误闯仍留下可信终态且零执行`（登记 `settled/returned`、占了槽） |

⚠️ 两处都用 Edit 注入、逐条单独跑、判红即反向改回；还原后 `git diff` 只剩未跟踪文件，整跑 2/2 复绿。

## 五、边界（如实）

- 本批只做 A/B 的**实机面**（dry-run 只读、部分失败各臂事实、整批占槽、期间第二操作与配置拒绝）；
  臂顺序/参数类型/副作用门禁的**完整矩阵**仍在 §3 的 `test/exec-model-ab.test.ts`（8 例）与包层用例里。
- 「批次期间首臂结束不放槽」这一条是从**外部观察**证的（在飞期间第二操作被拒 + 槽仍指向本批），
  不是从内部时序证的；内部逐臂时序由包层用例固定。
- 未测：批次执行中 renderer 崩溃/失联（归 6.5/6.6）、批次期间关闭协商（归 6.7）、
  窄窗/键盘下的 A/B 核对可达（归 6.8）。
- §6.3 遗留的口径观察（「已执行、录制没落盘」登记成 `rejected` 是否合适）同样适用于 A/B 通道，
  仍待用户/§7 定夺，本批未改产品。
