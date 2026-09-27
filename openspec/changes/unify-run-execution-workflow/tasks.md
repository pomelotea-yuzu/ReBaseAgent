# U5 实施与验收任务

> 实施进度（2026-09-27）：**§1 全部完成（1.1–1.4）+ §2 全部完成（2.1–2.5）+ §3 全部完成（3.1–3.6）
> + §4 全部完成（4.1–4.7）+ §5.1 完成**
> （`shared/terminal-facts.ts` 19 条 + `lib/result-verification.ts` 纯判据 15 条 + store 核实 9 条 +
> 终态消费 13 条 + `draft-submission` 收尾关联 13 条 + `draft-closure` 清理判据 20 条 +
> store 收尾/批次/反证 17 条 + `create-entry-closure` 创建入口 10 条 + `fork-entry-closure` result/prompt 入口 6 条 +
> `proxy-ab-entry-closure` messages/A-B 入口 9 条 + `navigation-intent` 纯判据 14 条 + 导航接线 14 条 +
> `operation-result-view` 呈现与通知判据（含喂 props 的视图）19 条 + `operation-result-actions` 明确动作 12 条 +
> `create-workspace` 来源判据 14 条 + 创建工作区接线 21 条 + `create-form-view` 创建页能力 19 条 +
> `execution-confirmation` 确认判据 27 条 + 确认接线 14 条 + A/B 确认接线 11 条 +
> `operation-request-facts` 请求事实/诊断/A-B 逐臂 16 条；
> desktop 全量 124 文件 / 2147 用例绿，`tsc` node/web 双 0 错，根 `biome check .` 449 文件 0 错；
> 变异：1.1 三组、1.2 三组、1.3 四组、1.4 五组、2.1 三组、2.2 四组、2.3 三组、2.4 三组、
> 2.5 两组、3.1 三组、3.2 三组、3.3 三组、3.4 四组、3.5 四组、3.6 三组、4.1 九组、4.2 四组、
> 4.3 三组、4.4 三组、4.5 两组、4.6 两组、4.7 四组、5.1 五组各有牙
> （另有 3.1 的一组"响应路径次序补支"判**无牙** ⇒ 已回退，见注记）。
> 其余 §5.2–§7 全部待办；没有实施、GUI 验收或发布通过声明。
> ⚠️ 已知环境噪声（非回归）：`test/controlled-service.test.ts` 在并行整跑下出现过 4 条超时失败，
> 单跑 19 条全绿；复跑整跑亦全绿 ⇒ 按"单包/单文件复跑"口径判定，登记为端口时序 flake。
> 每项实施/验收控制在 2h 内；若实际超出先拆分。场景名称对应 `specs/desktop-ui/spec.md`，既有场景用于回归，不能用旧报告替代新接线验证。

## 1. 结果核实与读取边界

- [x] 1.1 固定自有终止事件与结局判据，复用 shared 派生并补 `stopped/completed`、错误、上限、中止和非法/未知记录反例（≤2h）。验收：「成功信封但运行错误」「封存限制中止和未知不等于正常结束」「祖先结束与失败调用不能冒充本次事实」。
- [x] 1.2 增加按可信 runId 独立读取/校验结果的 store 动作，与导航动作分离；校验请求 ID、meta.id 和自有事件来源（≤2h）。验收：「失败信封仍可打开可信记录」「列表失败不阻断已知结果」；直接调用核实动作，断言成功/失败/重试均不改变当前运行/页签/调用、滚动或焦点。
- [x] 1.3 实现结果读取代次、不可读/未定位状态和显式只读重试（≤2h）。验收：「结果不可读只重试同一记录」「settled 无身份与 notAccepted 不猜测结果」「旧读取响应不能污染其他结果」。
- [x] 1.4 把 status/执行回执后的刷新/reconcile 接到同一终态消费，按身份去重读取和单次列表刷新（≤2h）。验收：「全部七类入口使用相同核实路径」「未知通信与新会话分开呈现」；须用真实 store 动作验证消费点，不只测纯函数。
  - 说明：本项只统一了**终态消费落点**（解冻 + 整批一次列表刷新 + 按身份串行核实），
    七类入口"响应即成功 / 无条件选中新运行"的局部分支仍留到 3.1–3.3 逐条移除；
    因此「全部七类入口使用相同核实路径」在本项只覆盖到三条消费入口。
    U4 既有用例 `4.9` 的读取次数由 2 改 3 —— 这是本项引入的**有意契约变更**：
    采纳含终态的快照即自动按可信 ID 核实一次（原先只有用户明确打开才读）。
    （2026-09-27 补：随 3.1–3.3 收口，「全部七类入口使用相同核实路径」现已覆盖五条通道，
    详见 3.3 注记；本项当时的口径只到三条消费入口。）

## 2. 提交修订与草稿收尾

- [x] 2.1 分离待定冻结与结果收尾关联，解冻前保留目标、修订、token、epoch/operationId 和批次预期信息，不额外复制正文（≤2h）。验收：「提交快照独立于编辑器挂载」「成功错误和部分失败均保留草稿」「核对终态只解冻对应修订」。
  - 落点：`SubmissionStore.closures`（键 `(epoch, operationId)`，值只含目标 / 目标标识 / 通道 /
    提交修订 / 令牌 / A-B 预期臂数）；`settleSubmission` 与 `settleSubmissionByOperation` 解冻时转存，
    `epoch === null`（本地未发送）不留关联；同目标新提交作废旧关联。
- [x] 2.2 实现单运行正常终止后的原子修订清理，包括创建对应目录引用；保留其他草稿（≤2h）。验收：「单运行正常结束清理匹配修订」「解冻后修改不被旧结果删除」。
  - 落点：`lib/draft-closure.ts`（`verdictOfOperation` 结局聚合、`decideDraftClosure` 四道闸、
    `applyDraftClosure` 走 U3 修订 CAS）+ `store` 在每次读取结论落地后尝试收尾（自动核实、
    显式只读重试、面板收起后的轮询同一去处）。A/B 的整批清理判据已在本模块内实现，
    store 侧的批次证据按任务 2.4 单独收口。
  - 落点：`lib/draft-closure.ts`（`verdictOfOperation` / `decideDraftClosure` 四道闸 / `applyDraftClosure`
    走 U3 修订 CAS）+ `store.closeDraftClosureFor`（挂在每次读取结论落地之后，覆盖自动核实与只读重试）。
    A/B 整批判据（`batchGapOf`）与 `expectedArmCount` 基准一并落在此处，2.4 只补 store 侧批次用例。
- [x] 2.3 加固 token/修订竞争与放弃重建幂等，未知或旧会话不清理（≤2h）。验收：「同修订再次提交也不被旧操作清理」「重复收尾与显式放弃不会误删重建草稿」「迟到回调与未知状态不能错误解冻」。
  - 落点：同目标新提交作废旧关联（2.1）+ `decideDraftClosure` 的更晚令牌闸（2.2）+
    显式放弃时 `releaseClosuresForTarget` 释放该目标关联（三类草稿的放弃口都接）+
    `closeDraftClosureFor` 只结"当前 epoch 且通信已确认"的账；每轮消费末尾对在场的关联
    补一次收尾（结果早于通信恢复读到时也有出路）。
- [x] 2.4 实现 A/B 预期臂完整性核对及整批清理，保留 null ID、缺臂、失败和不可读的整份配置（≤2h）。验收：「全部预期实验臂正常才清理整批」「实验缺臂部分失败与未核实保留整批」「实验预览和结果不隐式清理批次」。
  - 落点：`draft-closure.batchGapOf`（基准是提交时 `expectedArmCount`，逐 index 要求唯一非空 id +
    `returned` + 臂 id 必须落在登记 `runIds` 内 + 已核实条数相等）+ store 侧批次用例
    （两臂齐正常一次清干净、缺臂/null ID/失败臂/一条不可读保留整批、信封带 ids 但未核实保留、
    dry-run 预览不登记也不清理）。
- [x] 2.5 补读取重试成功后清理与非正常结果保留的 store 接线反证（≤2h）。验收：「失败与读取恢复分别收尾」；断言读取重试执行调用增量为零，且组件卸载后仍能完成收尾。
  - 落点：`test/draft-closure-store.test.ts` 末两支——"运行失败 ⇒ 保留 → 只读重试读到正常终止 ⇒
    才清理"同一条链上断言执行通道零增量、列表不额外刷新、不产生导航；收尾发生在 `resetFork()`
    之后（组件侧展示态复位不影响）；另加源码级接线契约：清理判据的调用点只在 `store.ts`
    （读取落地 + 终态消费两处），任何 `.tsx` 组件都不得复写一份。
  - 两组变异（摘掉读取落地后的收尾调用 / 让只读重试顺带 selectRun）分别判红。

## 3. 七入口与导航意图

- [x] 3.1 接入普通/隔离 create 的结果收尾，移除响应即成功/无条件选中新运行的分支（≤2h）。验收：「新建 run 成功」「执行失败不产生半成品」「失败信封仍可打开可信记录」。
  - 落点：`store.createRun` 删掉 ok 分支的 `loadRuns()` + `selectRun(信封里的 id)` 与失败分支的
    `loadRuns()`，`creatingRun` 状态机去掉 `"success"`（只剩 `idle/in_progress/error`）；
    列表刷新与按可信 ID 核实全部由 `consumeSettledOperations` 承担（main 在 `onRunIdentified`
    就把 runId 挂到操作上 ⇒ 失败信封那条 error run 同样可见、可按登记 ID 读）。
    证据：`test/create-entry-closure.test.ts` 9 条（成功一侧零导航 + 只读登记 ID、正常终止才按修订
    清草稿并连带清 `createSourceRef`、结果不可读保留草稿与关联、只读重试当场收尾、
    失败信封仍刷一次列表、settled 无 ID ⇒ 不解析文案不扫列表、隔离创建同一条路、
    回执 running ⇒ 响应不消费而轮询到终态才收尾、store 源码级"旧局部分支不得复活"契约）。
  - ⚠️ **有意契约变更**（既有判据被改，归档时别当回归）：`test/store.test.ts` 的创建成功/失败两支
    不再断言"入口刷列表 / `creatingRun === success` / 选中新 run"，改判为"入口零次列表刷新、
    回到 idle、`selectedRunId` 保持 null"；`test/run-list-nav.test.ts` 的「本地记录」正向锚点
    从 store 注释改指 `RunList.tsx`（被钉的那句注释随成功分支一起删除）。
    **（4.1 之后本文件的"零导航"又改判了一次：创建页不再是覆盖模态 ⇒ 留在流程内时跳的是
    **登记的那条**，`readCalls` 改按出现顺序去重。见 4.1 注记的"反向改判"条——
    入口不消费响应这件事本身没有被削弱。）**
  - ⚠️ **反向欠账（本轮查明，别补错方向）**：曾怀疑"响应路径在终态消费之后才转存关联 ⇒ 快执行的
    清理永远不发生"，并在 `settleDraftSubmission` 里补了一次立即收尾。变异验证**判无牙**
    （摘掉后 9 条全绿）⇒ 该补支是死代码，已回退；实际次序是消费点内部先 `settleDraftByOperation`
    转存关联、再读结果、读到即收尾。留此注记免得下一轮又去加同一支。
  - 「全部七类入口使用相同核实路径」的覆盖从 1.4 的三条消费入口扩到创建通道（普通 + 隔离同属
    `runs:create`）；result / prompt / messages / A/B 的入口侧局部分支仍留在 3.2、3.3。
- [x] 3.2 接入普通/隔离 result 与 prompt，清理局部 success/busy 消费对真实结果的替代（≤2h）。验收：「成功信封但运行错误」「所有入口实际使用同一适配器」。
  - 落点：`store.forkAt`（普通与隔离 result 同一通道，只差 `execution`）与 `store.promptFork`
    的 ok 分支删掉 `loadRuns()` + `selectRun(信封里的 id)`，并停止写 `forking: "success"`
    （改回 `idle`）。`forking` 的 `"success"` 取值暂时仍被 `proxyFork` 写入（任务 3.3 去掉后
    从联合类型里删除）；组件侧本来就只读 `in_progress` / `error`，因此没有别的消费点要迁。
  - 证据：`test/fork-entry-closure.test.ts` 6 条——「成功信封但运行错误」（信封 ok ⇒ 入口返回 true，
    但结局按**登记 ID** 读出的自有 `errored/error` 说话：不清理、保留草稿与关联、不导航）、
    正常终止才按提交修订清该调用草稿（同父本另一 span 的草稿不受牵连）、隔离 result 带
    `execution` 透传且**调用序列与创建入口同形**
    （`通道 → operations:status → runs:list → runs:get:<登记 id>`，即「所有入口实际使用同一适配器」）、
    prompt 两侧（正常清理 / 失败保留）与两条入口的源码级"局部分支不得复活"契约。
  - 三组反证：恢复 `forkAt` 的刷新 + 选中 ⇒ 4 支红；恢复 `promptFork` 的刷新 + 选中 ⇒ 4 支红；
    让 `forkAt` 在 ok 时顺手清草稿 ⇒ 3 支红（含"其他草稿不受牵连"）。
  - ⚠️ 有意契约变更（既有判据被改）：`test/store.test.ts` 的 `runs:fork` / `runs:promptFork`
    成功两支不再断言 `forking === "success"`、列表出现新 run 与 `selectedRunId`/`detail` 被填，
    改判为"回到 idle、入口这条路零次列表刷新、零详情读取、不选中"。
    **（3.4 之后本文件的 `selectedRunId` 判据又改了一次：留在流程内时由协调器跳向登记 id；
    见 3.4 注记的"反向改判"条。）**
- [x] 3.3 接入代理 messages 与 A/B 真实执行，保留 dry-run 独立路径、失败臂身份和原门禁（≤2h）。验收：「全部七类入口使用相同核实路径」「实验缺臂部分失败与未核实保留整批」「编辑并重发成功」「未修改禁用」「未捕获 key」「SDK run 无此入口」。
  - 落点：`store.proxyFork` 的 ok 分支删掉 `loadRuns()` + `selectRun(信封里的 id)` 与
    `forking: "success"`；`store.modelAb` 真实执行分支删掉入口自己的 `loadRuns()`
    （原本就无 `selectRun`，多臂不自动聚焦）。至此 `forking` 联合类型里的 `"success"` 已删除
    （只剩 `idle/in_progress/error`），五条通道（普通/隔离 create、普通/隔离 result、prompt、
    messages、A/B）的响应侧都不再宣称成功。dry-run 仍走只读的 `modelAbPlan` 通道：
    不占槽、不登记、不消费、不清批次（用例直接断言调用序列只有一条 `runs:modelAbPlan`）。
    A/B 的臂身份继续取登记的 `runIds`/`arms`，**不取信封 `ids`**（用例：信封回两条 id 而登记缺
    第 1 臂 ⇒ 只读登记那条，且整批草稿与关联保留）。
  - 证据：`test/proxy-ab-entry-closure.test.ts` 9 条（messages 正常终止清该字段草稿 + 与其余入口
    **同形的调用序列**、messages 自有 error 保留；A/B 两臂齐正常⇒整批一次刷新+逐臂各读一次、
    一臂 error⇒两臂都核实且整批保留、缺臂⇒按登记读一条且整批保留；dry-run 独立路径；
    store 与 DetailPanel 的源码级接线契约）。三条 messages 门禁（「未修改禁用」「未捕获 key」
    「SDK run 无此入口」）本轮**未改其实现**，改由源码级判据钉住（`unchanged ||` /
    `proxy?.running !== true` + `PROXY_NO_KEY` 就近指引 / `canResend = isProxy && leafOwned &&
    status === "completed"`）；端到端侧的既有证据是 `controlled-proxy.test.ts`
    「外部非流式请求 JSON 直通 + 编辑 messages 分叉按 stream:true 重发」「未捕获 key 时分叉 →
    PROXY_NO_KEY，且受控服务零请求」与 `exec-prompt-proxy.test.ts`「PROXY_* 拒绝：settled +
    原稳定码 + 零身份」。「实验预览和结果不隐式清理批次」的批次判据证据仍在 2.4。
  - 三组反证：恢复 `proxyFork` 的刷新 + 选中 ⇒ 2 支红；恢复 `modelAb` 的入口刷新 ⇒ 2 支红
    （列表被刷两次）；让 `modelAb` 在 ok 时顺手清整批 ⇒ 4 支红（含 2.4 的既有
    「执行信封把 ids 全带回来，但登记与核实未跟上 ⇒ 整批保留」）。
  - ➕ 回补 1.4 注记：「全部七类入口使用相同核实路径」至此**覆盖全部五条通道 / 七类入口**
    （1.4 当时只到三条消费入口）。仍属部分覆盖的是实机侧——§6.2–6.5 未做，桌面自然诱发的
    缺臂/null ID 按计划由集成 fixture 单列。
  - ⚠️ 已知边界（不静默）：A/B 面板的批次结果区仍显示信封 `ModelAbResult`（`ids.length` 计臂数），
    那是**请求事实**而非结局；把它换成"逐臂读取状态 + 可信 ID 动作"属任务 5.1
    （「操作详情可读诊断但不泄漏输入」），本轮不动，归档时别当已交付。
    **（3.4 之后本文件 messages 那支的 `selectedRunId` 判据改判为"跳向登记 id"，见 3.4 注记。）**
    **➕ 5.1 已兑现本边界**：批次结果区改吃登记快照 + `resultReads` 逐臂呈现（`deriveAbBatchResult`），
    信封 `ModelAbResult` 不再进面板；两边留痕见下方 5.1 注记与 `proxy-ab-entry-closure.test.ts` 头注。
- [x] 3.4 增加提交来源/导航代次与自动导航撤销规则，以独立导航动作在核实后、实际切换前重验当前资格（≤2h）。验收：「留在当前流程可进入成功或失败概览」「离开再返回不恢复旧自动导航」「读取途中离页仍不抢焦点」；分别断言资格有效才导航、核实期间撤销资格则零导航，不复用读取开始时的资格快照。
  - 落点：新纯判据模块 `renderer/src/lib/navigation-intent.ts`（`NavigationIntent {operationId, generation}`
    + `armNavigationIntent` / `releaseNavigationIntent` 幂等 + `decideResultNavigation` 四态
    `navigate / wait / drop / none`）。**资格按阅读代次判，不按"位置是否等于提交时位置"判** ⇒
    返回同一位置也不恢复；`coveringModal`（创建对话框 / 设置）只是 `wait`（这一刻不跳），
    与"永久作废"分开；A/B 批次、多运行、未定位、notAccepted、不可读、终态来自 reconcile ⇒ `drop`。
  - store 接线：`navGeneration` + `navIntents` 两个会话内字段（不落盘、不进 IPC）；
    登记唯一咽喉是 `beginDraftSubmission`（七入口都经它，组件侧不得各自登记）；
    撤销面挂在既有阅读动作 `selectRun`（同 ID 短路 ⇒ 自动导航不推进代次）/ `setReadingTab` /
    `selectSpan` / `setView` / `setSettingsSection(打开)`；刻意**不**挂 `resetFork` / `resetCreateRun`
    这类展示态复位（D5 同一纪律）。协调器 `attemptResultNavigation(record, trigger)` **只在**
    `consumeSettledOperations` 里、全部核实落地之后被调用，入参一律现取（spec：不复用读取开始时的资格快照）；
    `refreshOperationStatus → "status"`（可导航）、`reconcileOperation → "reconcile"`（只通知）。
  - 证据：`test/navigation-intent.test.ts` 纯判据 14 条 + `test/navigation-intent-store.test.ts`
    接线 13 条。三条验收场景逐条对上：成功与失败结局都进概览（且不以"打开"冒充成功、失败不清草稿）、
    切走再切回原 run ⇒ 不跳且意图作废（但结果照样核实到）、详情读取挂在半路时用户切走 ⇒
    落地后选择与详情仍是用户那一条；另有"重复快照只跳一次""覆盖模态不跳""reconcile 不跳"
    "手动只读重试不跳""A/B 只识别出一条臂也不跳（批次规则优先于单运行）""非批次多运行不跳"
    "组件侧不得出现判据"共 9 项。
  - 四组反证：撤销面失效（代次不推进）⇒ 3 支红；reconcile 改用 status ⇒ 2 支红；
    摘掉批次判据 ⇒ 1 支红（该用例刻意把登记做成"只有一条臂拿到 id"，否则多运行规则会替它挡住 ⇒ 无牙）；
    摘掉覆盖模态判据 ⇒ 1 支红。
  - ⚠️ **3.4 反过来改了 §3.1–3.3 证据的导航断言**（有意契约变更，同一 change 内部）：
    result / prompt / messages 三支"留在流程内"的用例现在**应当**跳转，故
    `fork-entry-closure.test.ts`（3 支）与 `proxy-ab-entry-closure.test.ts`（1 支）把
    `selectedRunId 为 null` 改为"跳的是**登记的那条**"，`readCalls` 判据改为去重后只含登记 id
    （协调器自己会再读一次详情）；`create-entry-closure.test.ts` 的复位表补
    `createDialogOpen: true`（与真机一致：提交发生在打开着的创建对话框里 ⇒ `wait` ⇒ 不跳），
    该文件的"零导航"因此继续成立。`draft-closure-store.test.ts` 2.5 的"重试不导航"
    改判为"重试前后选择不变"（第一轮 status 消费会按意图跳一次，那是 3.4 的行为）。
    **入口不消费响应**这件事本身仍由"信封 id 一次都不读 + 函数体内无 `loadRuns`/`selectRun`"两层钉住。
  - ⚠️ 已知边界（不静默）：① 内联编辑器"收起"是组件本地状态 + `resetFork`，本轮刻意不把它当撤销 ⇒
    收起后结果到达仍会跳概览；实机若判定这是抢焦点，改在 §5.6/§6 收口（届时撤销面挂到组件的收起动作）。
    ② 原生 `confirm()` 与设置对话框之外的确认框不在 store 里，`coveringModal` 只覆盖
    `createDialogOpen` / `settingsSection`；③ 创建页在 §4 改成工作区页面之前，覆盖模态恒在场 ⇒
    **创建入口实际不会自动导航**（这是 spec 要求的"不跳到模态背后"，不是漏接）。
    **（4.1 已兑现这一条：创建改为工作区页面后 `coveringModal` 只看 `settingsSection`，
    创建入口从此走本项判据 ⇒ 留在流程内就跳；上面 ② 点名的 `createDialogOpen` 随 4.1 删除，
    本项 3.4 的"创建页内不跳"证据由 `create-entry-closure.test.ts` 的改判支接替，见 4.1 注记。）**
- [x] 3.5 接通明确打开结果、真实自有失败调用、返回草稿及失效回退（≤2h）。验收：「失败定位和返回草稿明确可达」「祖先结束与失败调用不能冒充本次事实」「核对结果只由用户明确打开」。
  - 落点：新纯判据 `renderer/src/lib/operation-result-view.ts`（`deriveOperationResultView` /
    `buildOperationResultViews`，键编码与 `lib/operation-list` 的 `row.key` 同源）——动作只给得出事实的那些：
    可信 runId ⇒ 「打开结果」；`facts.failure.llmCallSpanId` 在场 ⇒ 「查看失败调用」；
    草稿仍在（`isOperationDraftPresent`）⇒ 「返回草稿」；不可读 ⇒ 只给"按同一 runId 重读"。
    不给的每一种都配诚实说明（`failureNote` / `draftNote`），其中"以 error 终止但自有无失败详情"
    与"本次不是 error 终止"两种措辞分开，杜绝"跳祖先的最后一个错误调用凑数"。
  - store 明确动作：`openOperationResult`（走既有 `selectRun`，**不**过 3.4 的导航意图判据）、
    `openOperationFailure`（拿不到自有失败 span ⇒ `false` 且一点也不动页面）、
    `returnOperationDraft`（按身份查目标：待定关联优先、其次收尾关联；草稿不在 ⇒ `false`，
    不登记定位目标、不写回任何正文）。`lib/draft-submission.ts` 新增 `submissionTargetOf`
    作为"按身份找回草稿目标"的唯一入口（只回目标键，正文仍只在草稿仓库）。
  - 组件接线：`OperationsEntry` 的行视图改为消费 `row.result`（`deriveOperationRows(session, {reads,
    draftPresentOf})`），四个动作全部走 store 动作；核对与"刷新"按钮既不收起面板也不切页面，
    失败定位只在 store 返回 true 时才收起。`reopenRun` 不再是面板的通路（明确动作用身份三元组）。
  - 证据：`test/operation-result-view.test.ts` 19 条（纯呈现 + 喂 props 的 `renderToStaticMarkup`）
    + `test/operation-result-actions.test.ts` 12 条（store 接线）。关键条：
    「自有失败调用在场 ⇒ 给入口并带真实错误正文」与「祖先含失败调用、自有无 ⇒ 无入口 + 说明」成对；
    「打开结果」即便覆盖模态在场也切（证明明确动作不受意图判据约束）、reconcile 与只读重试都不切、
    「返回草稿」失败保留时可达 / 被清理后 false、`isOperationDraftPresent` 三态分开。
  - 四组反证：给「打开结果」加上覆盖模态判据 ⇒ 3 支红；让失败定位在无自有失败时"跳一个 span"⇒ 1 支红；
    去掉"草稿不在就不返回"的守卫 ⇒ 1 支红；面板行视图里出现结局判据（`viewOperationResult` 等）
    的源码级契约另立一条（组件不重写第二份判据）。
  - ⚠️ 有意契约变更（U4 的 4.7 用例）：`test/operation-entry.test.ts` 的两支改判——
    "打开只走 `reopenRun(runId)`"改为"打开只走 `openOperationResult(identity)`，组件里不出现
    `selectRun`/`reopenRun`/`loadRuns`"；"只有打开记录会收起面板"改为
    "核对与刷新都不收起；失败定位只在定位成功时收起"。
  - ⚠️ 已知边界：「许可复位」（返回草稿后旧预检/确认失效）仍属 §4.5/§4.6 的确认流程，本轮只做
    "定位到那份草稿 + 执行状态不被这次返回改动"；来源位置（页签/滚动/文件）不进 `NavigationIntent`，
    等 §4.1 的创建工作区再存。
- [x] 3.6 接通恢复/核对/重试/批次的只通知路径及去重，后台读取不碰当前阅读状态（≤2h）。验收：「恢复核对重试与批次结果只通知」「旧读取响应不能污染其他结果」。
  - 落点：新纯判据 `renderer/src/lib/result-notices.ts` —— `deriveResultNotices({records, reads, seenKeys})`
    现算未读通知（**没有通知队列**，符合"数据派生不累积"），只有落到结论的才报：
    可查看 / 不可读 / 未定位 / 本次未接受；`running` 与"正在读取"都不报。
    **两层去重**：① 用户已看过的身份键；② 同一次派生里同一键只报一次（快照拼接/旧 epoch 同 id 都可能重复出现）。
    通知文本刻意不含等待计时（进了就等于每秒重复通知），计时显示属 §5.2。
  - store 侧：会话内 `seenNoticeKeys` + `markNoticesSeen(keys)`（幂等，无变化不改引用）；
    「打开结果」顺带标记该条已看，面板展开标记全部已看。组件用订阅状态现算，不缓存条数。
  - 证据：`test/operation-result-view.test.ts` 的 3.6 段（未读/在读不算通知、四种结论各算一条、
    标已看后归零、**同一结论两条记录也只算一条**、文本不含计时、批次逐臂各算一条不合并）
    + `test/operation-result-actions.test.ts` 的 3.6 段（轮询再来两轮不把同一结论数成两条、
    标记幂等、后台自动核实不改页签/滚动/选中调用/选中运行、以及"跳转与定位的唯一入口是 store 动作"）。
  - 三组反证：去掉已看过滤 ⇒ 2 支红；去掉同键一次派生去重 ⇒ 1 支红；
    「打开结果」不标记已看 ⇒ 1 支红。
  - ➕ 本轮补的实质缺陷（写用例时发现，非变异）：`deriveResultNotices` 初版只做"已看过滤"，
    **同一次派生里同一身份会重复计数**（两条同 id 登记 ⇒ 两条通知）⇒ 补第二层去重后才有牙。
    「恢复核对重试与批次结果只通知」的 live 区域与未读标记 UI 属 §5.2；本项交付的是判据与去重本身。

## 4. 创建工作区与检查确认

- [x] 4.1 将新建迁入 App 主工作区，接全局入口/草稿定位/返回位置，保留导航和 U1/U2 阅读恢复；来源引用独立存于 renderer 会话导航状态（≤2h）。验收：「创建工作区任务优先且可返回来源」「创建关闭配置再新建仍有任务」「首次打开与无运行入口」「旧创建设置及执行入口保持可达」；断言重进创建取新来源、创建内重复点击/设置往返沿用、草稿不含来源、重载后失效并安全回退。
  - 落点：新纯判据 `renderer/src/lib/create-workspace.ts`（`WorkspaceView = trace|tree|create`、
    `decideCreateEntry` 只在"视图不是创建页"时以当时阅读位置重记来源、`decideCreateReturn`
    三态 `restore / fallback(no-location) / fallback(run-missing)`、
    `readingPatchOfLocation` + `filePatchOfLocation` + `liveSpanOfLocation` 决定回写哪一份位置）。
    来源引用只含**视图 / 运行 / 页签 / 调用 / 文件定位**（`files === undefined` 即"从未进入文件页"，
    与 store 的 `fileReadingEntered` 是同一定义而非第二份判据；`checkpoint === null` 是"进过、停在初始"
    ⇒ 照记，不伪造）——不含草稿正文、目录引用、授权、凭据与任何登记字段。
  - store 接线：`view` 增加 `"create"`，**删除** `createDialogOpen` / `setCreateDialogOpen`；
    新增 `createReturnLocation`（会话内，不落盘 / 不进 URL/日志/IPC）+ `openCreateWorkspace`
    （全局栏、列表标题区、`openDraftAt(create)` 三处共用的唯一入口动作；从别的工作区进来
    重记来源并**推进阅读代次**，页内重复点击与设置往返走 keep 支 ⇒ 什么都不动）+
    `returnToCreateSource`（可用即恢复：该 run 仍选中则用既有阅读动作当场对齐，否则先把位置写成
    该 run 的会话阅读状态再走 `selectRun` 的校验/失效回退；用过即清，一次性凭据）。
    `selectRun` 在创建页在场时**先退出创建页**（放在同 ID 短路之前 ⇒「打开结果」不会点了没反应）
    并作废来源引用；`setView` 离开创建页同样作废引用（草稿不动）。
  - 守卫：`resolveInitialSelection` 新增 `userWorkspace` 入参与 `user-workspace` 结论
    ——**首次读取迟到也不覆盖已进入的创建页**，且这一支不消耗 `attempted`
    （回到轨迹后原规则照常，属"不误伤"）；后台 `loadRuns` 本就不改选，用例另钉。
  - 组件与承载：`CreateRunDialog.tsx` → `CreateRunWorkspace.tsx`（App 的
    `view === "create"` 分支挂载，与 `RunList` 同一支 ⇒ 运行导航保留；不再是 App 层模态单例）；
    去 `ModalDialog` 与全窗 `closeDisabled`（表单锁定判据 `formLocked = busy || pickingSource ||
    draftFrozen` 一字未动，只是不再锁住离页）；正文单列 `max-w-200`（800px）；
    页头「返回来源」；**两模式共用**当前接入摘要（旧形态只在隔离块里出现）；
    高级 System Prompt 改为可展开区（`aria-expanded`），初始按草稿是否有内容决定。
  - 证据：`test/create-workspace.test.ts` 纯判据 14 条 + `test/create-workspace-store.test.ts`
    接线 21 条（进入取新来源 / 页内重复点击与设置往返沿用 / 换工作区后重记 /
    两条恢复路径 / 文件定位两种"进过没进过" / 重载失效与运行缺失各回退且不伪造 /
    首次读取迟到不覆盖 + 对照不误伤 / 后台刷新不动现场 / 来源与草稿互不决定 + 草稿键集合不含来源 /
    点运行与同 ID 短路都退出创建页 / 三条源码级"判据只有一份"契约）。
  - ⚠️ **有意契约变更**（反向改判 §3.1 的导航证据，两边留痕）：3.4 注记 ③ 的前提
    （"创建页在 §4 改成工作区页面之前覆盖模态恒在场 ⇒ 创建入口实际不会自动导航"）随本项消失，
    `coveringModal` 从此只看 `settingsSection` ⇒ `create-entry-closure.test.ts` 的四支
    "零导航"（成功、失败信封、running→轮询、隔离创建）改判为**跳的是登记的那条**，
    `readCalls` 判据改为按出现顺序去重（协调器自己会再读一次详情）；
    另加一支「提交发生在创建页里 ⇒ 终态落定照样按意图跳概览」钉这条。
    **入口不消费响应**仍由"信封 id 一次都不读 + `createRun` 体内无 `loadRuns`/`selectRun`"钉住。
    同步在 `navigation-intent-store.test.ts` 补「提交后走进创建工作区 ⇒ 不跳也不顶掉创建页」
    （进入创建页推进代次 ⇒ 资格永久作废，不是"这一刻不跳"）。
  - ⚠️ **载体迁移**（U3/3.x 证据跟着组件改名，判据强度不变；§7.3 逐条核对时别读成"证据被换弱"）：
    `modal-dialog.test.ts` 的"创建经 ModalDialog + `closeDisabled={modalLocked}`"拆成两条
    ——设置仍是模态、**创建页不得做成模态**（`<ModalDialog`/`showModal`/`fixed inset-0` 走剥注释审计器）；
    `create-form-draft.test.ts` 的锁定判据改名 `formLocked` 并新增"返回来源走 store 动作 +
    页面不读写 `createReturnLocation`"；`entry-gate` / `confirm-dialog` / `draft-submission`
    的文件路径与常量名随改名更新；`operation-result-actions.test.ts` 的"覆盖模态在场"夹具由
    `createDialogOpen: true` 换成 `settingsSection: "proxy"`（同一判据、不同载体）；
    `store.test.ts` 原「新建运行对话框开关」两支合并为一支「创建工作区只有一个会话状态」；
    `draft-list` / `result-verification-store` / `draft-closure-store` 复位表补 `view` 与
    `createReturnLocation`（U5 §九 第 2 条的复位纪律）。
  - 九组反证各有牙：摘掉 keep 支 ⇒ 3 红；去掉"进入过文件页"判据 ⇒ 2 红；去掉 run-missing 回退 ⇒ 2 红；
    去掉 `userWorkspace` 守卫 ⇒ 1 红（对照支仍绿，不误伤）；把创建视图重新算进 `coveringModal` ⇒ 2 红；
    摘掉 `selectRun` 的退出创建页 ⇒ 3 红；返回来源不清引用 ⇒ 2 红；进入创建页不推进代次 ⇒ 2 红
    （机制支 + 行为支各一）；`setView` 不清来源 ⇒ 1 红。
  - ⚠️ 已知边界（不静默）：① 真机上"点另一条运行"必然先离开创建页 ⇒「仍在创建页但选中项已变」
    的恢复支只能由 store 单测摆放现场来钉（构造有效但 UI 不自然，写清楚免得被读成缺陷）；
    ② 进入创建页的初始焦点、Tab/Esc 与响应式属 §5.6，实机证据归 §6.2/§6.8；
    ③ 字段错误呈现与"就近配置入口"（点一下直达设置）留到 §4.2，目录选择/token/每次副本授权的
    迁移与复验留到 §4.3；④ 设置盖在创建页之上仍走 App 本地 `settingsOpen`，
    "返回并刷新摘要 / 使预检与许可失效"属 §5.3；⑤ 本轮只改 desktop，packages 逐包单跑与
    `electron-vite build` 未重跑（§7.2 统一补）。
- [x] 4.2 布置任务、模式、两模式模型摘要、高级系统指令和字段错误，沿用已有请求形状（≤2h）。验收：「userMessage 为空时禁用提交」「空 systemPrompt 允许」「settings 未配置时拒绝」「两模式配置后返回任务」。
  - 落点：`lib/create-run.ts` 的拒绝分支新增**归属键** `field`
    （`userMessage / source / writesAuthorized / null`）与新纯函数 `fieldErrorsOf`
    ——就近呈现的位置由同一份提交判据给出，组件不另算"哪条错该显示在哪儿"；
    理由文案与请求形状**一字未改**（用例逐字钉住）。
    组件拆成**容器 + 纯视图**两个导出：`CreateRunWorkspaceView` 只吃 props（可见结构全部在此），
    `CreateRunWorkspace` 订阅 store、把判据结果与锁位交出去。正文按 design D1 顺序
    （模式 → 任务 → 隔离目录 → 当前模型/接入摘要 → 高级系统指令 → 执行范围 → 操作区，
    单列 `max-w-200`）：两模式共用接入摘要 + 就近「运行配置…」入口
    （经 App 传入的 `onOpenSettings`，组件**不自建**第二份设置状态）；执行范围与
    "一次提交 = 一次真实模型调用"就地可读；高级 System Prompt 折叠（展开态是展示态，不进草稿）；
    请求事实（`createRunError`）单独一行，不与运行结局说明合并。
  - 四条验收的对位：空 userMessage ⇒ 拒绝落在**它自己的**槽上，textarea 带
    `aria-describedby` + `aria-invalid`；空 systemPrompt ⇒ 放行且给"留空也可以（按空 system 算
    config_hash）"说明；settings 未配置 ⇒ 摘要转告警态 + 可点的配置入口 + 拒绝理由走表单级说明位
    （`SETTINGS_NOT_CONFIGURED` 仍由 main 判定，页面不冒充预检通过）；两模式配置后返回任务 ⇒
    摘要与入口**在两种模式下都在**（"配好之后回到任务"的返回与失效属 §5.3）。
  - 证据：新 `test/create-form-view.test.ts` 16 条能力断言（喂 props 的
    `renderToStaticMarkup`）——错误给得出就必须文本+锚点都在、没给就一条都不渲染；
    隔离块只在隔离模式存在；未选目录时复选框真 disabled（对照：选了就可点）；
    **逐控件**判 `disabled=""`（只看"整页有几处 disabled"会被别的按钮凑数，
    类名里的 `disabled:` 变体还会被裸子串误伤）；两模式摘要与配置入口；执行范围随模式换内容；
    表单级说明与"进行中"条分工；源码级"视图段里不得出现 store / 提交判据 / 门禁派生"。
    判据本身仍在 `test/create-run-dialog.test.ts`（新增两条：四类拒绝各自点名归属、
    放行分支键集合不含 field）。
  - ⚠️ **载体迁移**（容器/视图拆分的连带，判据强度不变；§7.3 别读成"证据被换弱"）：
    `create-form-draft.test.ts` 三条源码断言改写（`e.target.value` → 回调参数 `text`、
    `!draftDirty` → `canDiscard: draftDirty && !formLocked`、`disabled={formLocked}` →
    `lock={{...}}` 片段 + 能力断言移到视图用例）；`draft-submission.test.ts` 的
    `disabled={draftFrozen}`×2 → `disabled={lock.draftFrozen}`×2；
    `entry-gate.test.ts` 的 `blockedReason = submission.ok ? gate.notice : submission.reason`
    → `: null`，另钉 `{ ...submissionErrors, form: blockedReason }` 与视图消费
    （**理由**：4.2 起门禁文案属表单级、字段拒绝属字段级，一条横幅不再同时承载两者）。
  - 四组反证各有牙：摘掉 userMessage 的 `aria-describedby` ⇒ 1 红；把两段文本的 `disabled`
    改成恒 `false` ⇒ 逐控件支红（顺带暴露我第一版"数整页 disabled"是**假牙**，改判后才咬）；
    `fieldErrorsOf` 把所有拒绝都塞进 `form` ⇒ 映射支红；表单说明位判据反向 ⇒ 该支红。
  - ⚠️ 已知边界（不静默）：① 未配置时页面只给摘要与入口，真正的拒绝仍发生在 main
    （不给"看起来已经预检过"的假象，D2）；② 设置模态的开合仍是 App 本地 state ⇒
    `coveringModal` 只认 `settingsSection`，从创建页"常规打开设置"那一刻不算覆盖模态
    （与 3.4 同源，留给 §5.3 连同"返回并刷新摘要"一起收）；③ 目录选择、token 与每次副本授权
    的迁移与复验属 §4.3；④ 键盘可达与窄窗实测属 §5.6 / §6.8；⑤ 本轮只改 desktop，
    packages 逐包单跑与 `electron-vite build` 未重跑（§7.2 统一补）。
- [x] 4.3 迁移目录选择、token 和每次副本授权，保留取消选择、过期、消费与异步代次守卫（≤2h）。验收：「直接创建隔离文件父本」「切创建模式保留文本而放弃重置表单」「创建忙碌期间不能通过焦点修复绕过关闭锁」；回归主 spec「sourceToken 在有效期内恢复但授权复位」「sourceToken 失效不清空任务」「取消目录选择保留原引用」。
  - 落点：`lib/create-run.ts` 新增 `restoreCreateForm` —— 把原先散在组件 `useState` 初始化里的三条规则
    收敛成一处纯判据（**模式跟会话草稿 / 源目录引用跟 store 的 `createSourceRef` /
    副本授权恒为未选**）。token 是否过期与是否已被消费**只由 main 在使用时判定**：渲染层不校时间戳，
    更不按路径重建引用（"有效期内可恢复"这一半是 main 的承诺，桌面侧只保证"引用可恢复、授权不继承"）。
    容器改为调用该函数，不再自己决定授权跟不跟引用回来。
  - ⚠️ **「创建忙碌期间不能通过焦点修复绕过关闭锁」两条都收**（用户 2026-09-27 定的口径；4.1 起创建
    不是模态，原判据的载体一半消失）：
    ① **创建侧改判** —— 新 store 用例（`create-entry-closure.test.ts` 的「执行中不放行第二次执行」）
    钉"在飞期间离页（进/出创建工作区）+ 组件卸载式的展示态复位 + 组件同形的第二次登记 ⇒
    一次 `runs:create` 都不多发；草稿与目录引用都不动；解冻只认明确回执或终态核对"。
    挡重复执行的是**待定登记与 U4 执行槽**，不是模态锁。
    ② **模态侧原判据保留**在仍存在的模态上：设置对话框与放弃确认经 `ModalDialog` 的
    `closeDisabled` + keydown 捕获吞 Escape（`modal-dialog.test.ts` 那组一字未动），
    创建页里的放弃确认走同一宿主（`create-form-draft` 的 `void requestConfirm({` +
    `confirm-dialog.test.ts` 的计数契约）。两边留痕＝本注记 + 4.1 的载体迁移条。
  - 三条回归主 spec 的对位：「sourceToken 在有效期内恢复但授权复位」⇒ `restoreCreateForm`
    的三条行为用例（含"引用在场也不能把表单变成可提交"的对照：同目录同模式，本次勾选后才放行）；
    「sourceToken 失效不清空任务」⇒ 既有 `INVALID_SOURCE_TOKEN` 清引用不清草稿（源码契约 +
    lib 判据）本轮补上"重进时的底稿"这一半；「取消目录选择保留原引用」⇒ `applyChosenSource`
    取消支返回原状态 + 容器不写镜像引用（既有 B 段用例与源码契约仍在）。
    「切创建模式保留文本而放弃重置表单」与「直接创建隔离文件父本」的**判据面**早已就位
    （`switchCreateRunMode` / `resolveCreateRunSubmission` + `create-run-dialog.test.ts`），
    本项只改它落到创建页形态里的那一层。
  - 证据：`create-run-dialog.test.ts` 新增 3 条 `restoreCreateForm` 行为用例（现共 19 条）+
    `create-entry-closure.test.ts` 新增 1 条在飞不放行用例（现共 11 条）；
    容器侧源码契约随拆分改写（`const ref = useAppStore.getState().createSourceRef;` →
    `restoreCreateForm({ sourceRef: …, draftMode: … })`，并新增"组件不写 `writesAuthorized: true`"
    的禁用型判据）。
  - 三组反证各有牙：授权随引用继承 ⇒ 2 红；模式不跟草稿 ⇒ 2 红；选择不镜像到会话引用 ⇒ 1 红。
  - ⚠️ 已知边界（不静默）：① 目录选择的**异步代次守卫**仍是组件本地 `useRef` + 源码契约
    （无 jsdom ⇒ "卸载后迟到响应不落地"的行为面归 §6 实机）；② 「直接创建隔离文件父本」的端到端真跑
    （v2 根 run、检查点、源目录字节不变）属 §6.2，本项交付的是表单与判据面；
    ③ 隔离模式的**只读预检与轮末确认**属 §4.5，检查确认边界属 §4.4；④ 本轮只改 desktop，
    packages 逐包单跑与 `electron-vite build` 未重跑（§7.2 统一补）。
- [x] 4.4 接创建/普通 result 的检查确认及真实边界，不添加无接口支持的预检信息（≤2h）。验收：「创建和普通重跑只声明已完成的检查」「普通结果与隔离结果确认边界不同」的普通部分；后者须与 4.5 的隔离证据合并，单独通过仅记部分覆盖。
  - 落点：新纯判据 `renderer/src/lib/execution-confirmation.ts` —— 确认是一份**绑现场的凭据**
    （`ConfirmationBinding = 通道 + 目标 + 草稿修订 + 设置快照 + 检查代次`），
    `armConfirmation` / `releaseConfirmation` / `decideConfirmation`（**现算比对**，任一不同即
    `missing`/`stale`，不靠"记得去清"）；`settingsStampOf` 只取模型 / baseURL / 是否已配置 /
    代理在跑与是否已捕获 key，**不含 apiKey 值**（用例钉住"凭据不进指纹"）。
    披露由同一模块给出：`createDisclosure` / `resultPlainDisclosure` / `disclosureLines`，
    普通 result 的模型行**复用** `lib/fork-cache-hint.ts`（未知 ≠ 不一致，不在这里另算一套）。
  - store 接线：`confirmations` + `checkGenerations` 两个会话内字段（不落盘 / 不进 IPC）+
    `currentConfirmationBinding`（**修订与设置快照一律现取**，组件传不进旧值）、
    `armExecutionConfirmation` / `releaseExecutionConfirmation` / `executionConfirmationReady` /
    `restartExecutionCheck`（推进代次并作废）。**执法点只有一个**：`beginDraftSubmission` 带上
    `confirmation` 时先现算一次，不成立 ⇒ 返回 null（组件因此一次 IPC 都不发）；登记成功即
    **消费**该确认（重新执行要重新确认）。既有"未带 confirmation 的入口"行为不变（opt-in，
    隔离 result / prompt / messages / A-B 在 4.5–4.7 逐条接入，本轮不静默宣称它们已受约束）。
    撤销面：`noteReadingChanged`（切运行 / 换页签 / 换调用 / 换视图 / 进创建页）与
    `setSettingsSection`（进与不进设置都算一次往返）撤销待用确认；三类草稿显式放弃时一并释放。
  - 入口形态：创建页在正文末尾**就地**给「核对本次提交」区（逐行事实 + 已做的检查 + 本次边界 +
    确认按钮），未确认时提交按钮不可用、还不能确认时就近给原因；result 编辑器同形（普通路径），
    隔离路径不动（仍走既有 `forkCapability` 预检 + 本次授权，判据归 4.5）。两处都不新增
    阻断阅读的大模态（design D2）。
  - 证据：`test/execution-confirmation.test.ts` 纯判据 14 条（现场比对六条 + 指纹不含密钥 +
    披露只说做过的事：普通创建明说"没有独立的模型连通性预检"、隔离明说"没有目录采集预览接口"
    且不给数字、普通 result 说明"世界不隔离 / 后续工具会真的执行"且不得出现隔离专属话术）+
    `test/execution-confirmation-store.test.ts` 接线 10 条（现取绑定、改输入即失效、离开现场与
    设置往返撤销、重启检查推进代次、不成立的确认被登记口拒绝、当场消费、显式放弃释放、
    组件不得自判与披露唯一来源的源码契约）+ `create-form-view.test.ts` 追加 3 条视图能力断言。
  - ⚠️ **载体迁移**（判据强度不变）：`entry-gate.test.ts` 的 `canCreate` / `canFork` 两条正则改为
    折叠空白后子串比对，并各多要求一道确认（`&& confirmed` / `(isolated || plainConfirmed)`）；
    `draft-submission.test.ts` 的两处源码契约同样改折叠空白（登记调用换行传 `confirmation` 了），
    并新增"创建提交登记时必须交出 confirmation"一条。
  - 三组反证各有牙：摘掉登记口的现场确认校验 ⇒ "改输入后用当下现场登记即被拒"红；
    登记后不消费确认 ⇒ "当场消费、重新执行要重新确认"红；
    `noteReadingChanged` 不清确认 ⇒ "换视图 / 进设置撤销"红（`setSettingsSection(null)` 那支仍绿，
    说明两条路各自有判据，不是一条兜住全部）。
  - ⚠️ 已知边界（不静默）：① 场景「普通结果与隔离结果确认边界不同」**本轮只交付普通侧**，
    与 4.5 的隔离证据合并才算覆盖（§7.3 按部分覆盖记）；② 确认是 renderer 会话内的展示与许可凭据，
    main 侧的门禁与重复校验一字未改，确认**不授予**执行资格；③ 创建页的确认区在窄容器下的
    几何与键盘可达属 §5.6 / §6.8；④ 「无独立预检接口」的措辞依据是仓库现有 IPC 面
    （`runs:forkCapability` 只对隔离续跑有效），没有采集预览端点 ⇒ 不显示文件数量或"目录检查通过"。
- [x] 4.5 接隔离 result 的只读预检、轮末确认和失效规则，保持主进程重验（≤2h）。验收：「普通结果与隔离结果确认边界不同」的隔离部分、「返回修改与设置往返撤销旧确认」；前者须与 4.4 的普通证据合并，单独通过仅记部分覆盖。
  - 落点：新披露 `resultIsolatedDisclosure`（`lib/execution-confirmation.ts`）——
    事实取自**真实预检结论**（直接父 / 本地轮号 / 编辑点 / 整轮结束检查点 / 续跑方式 /
    config_hash / 本次模型），检查一项写"只读预检 `runs:forkCapability`：不创建运行、不写文件、
    不请求模型"，边界三项直说"整轮续跑不重做本轮其余工具 / 不撤销已经发生的写入 /
    副本写入需本次勾选、不从父 trace 的历史标注补授权"。
    **预检缺席时**该句"已做的检查"不出现（改为"尚未取得只读预检结论"）—— 界面无一处把
    没做过的事写成检查过。检查点与续跑标签复用 `isolatedContinueLabel` /
    `isolatedCheckpointLabel`，不另算一份。
  - 隔离编辑器接线：确认按钮（`data-confirm-execution`）要求**预检结论 + 本次副本授权 +
    提交判据 + 源可用 + 门禁**全在场才可点；点一下记一份绑现场的确认；`canFork` 从此与普通
    路径同判据（不再有 `isolated ||` 豁免），登记时一律交出 `confirmation` ⇒ 主进程重复校验照旧
    在 `runs:fork` 里跑，确认**不代替**任何 main 侧判定。
  - 失效规则（"返回修改与设置往返撤销旧确认"）分三层，缺一层都会留下可用的旧许可：
    ① 草稿修订 —— `decideConfirmation` 现算比对（U3 的 `verified.revision` 只守预检结论，
    不守确认）；② 设置快照 —— 模型 / baseURL / 代理状态任一变化即 `stale`；
    ③ 检查代次 —— `doCheck` 先 `restartExecutionCheck(draftKey)`（推进代次 + 作废确认），
    且排在 `checkAllowed` 判据之后（被挡住的点击不产生抖动）。
    另有既有通道：U3 的 `verified` 值 + 修订双绑守"旧预检结论装到新草稿上"，
    换运行 / 换视图 / 进设置经 `noteReadingChanged` 与 `setSettingsSection` 撤销待用确认，
    显式放弃草稿时一并释放。
  - 证据：纯判据 3 条（`execution-confirmation.test.ts` 的 4.5 组：预检在场才把 `forkCapability`
    列进"已做的检查"、隔离措辞不借用"世界不隔离"、授权是本次事实）+ 接线 3 条
    （`execution-confirmation-store.test.ts`：确认按钮的 disabled 清单含 `capability === null`
    与 `!writesAuthorized`、预检缺席就近给原因、`doCheck` 里代次推进的位置、两条 result 路径
    都交确认且无豁免分支）。**与 4.4 合并后才算覆盖**场景
    「普通结果与隔离结果确认边界不同」：普通侧见 4.4（"世界不隔离 / 后续工具真副作用 /
    没有独立预检接口"），隔离侧见本项，两份用例互斥断言（普通侧不得出现"轮末检查点"、
    隔离侧不得出现"世界不隔离"），故 §7.3 按"两侧各有名用例"计覆盖。
  - ⚠️ 载体迁移（判据强度不变）：`entry-gate.test.ts` 的 `canFork` 期望去掉
    `(isolated || …)` 豁免；`execution-confirmation-store.test.ts` 新增"panel 里不得再出现
    `isolated ? {} :`"的禁用型断言。
  - 两组反证各有牙：摘掉 `doCheck` 里的代次推进 ⇒ 接线支红；恢复隔离侧的确认豁免 ⇒
    `entry-gate` 的 `canFork` 支红。
  - ⚠️ 已知边界（不静默）：① 预检结论与确认是**两份**凭据（前者守"这份结论属于这条草稿"，
    后者守"用户核对过边界"），主进程仍独立重验，桌面任何一条都不授予执行资格；
    ② 确认按钮的可点/禁用清单是源码级契约（本包无 jsdom），真实点击与焦点行为归 §6.3；
    ③ "整轮不重做所选工具"的措辞来自 main 的预检语义，界面不解释成"撤销原写入"。
- [x] 4.6 接 prompt / messages 确认与就近资格原因，保留单变量/单请求语义（≤2h）。验收：「prompt 与 messages 不冒充续跑完整世界」「返回修改与设置往返撤销旧确认」。
  - 落点：`lib/execution-confirmation.ts` 新增 `promptDisclosure` 与 `messagesDisclosure` ——
    prompt 侧写死"从头执行一条新轨迹：不复用父执行前缀、不回放工具结果、父 run 只作对照、
    一次只改一个启动字段"；messages 侧写死"只重发这一个请求：不执行外部 Agent 的工具、
    不恢复其工作区、凭据是代理会话**最近捕获**的 key（可能与录制当时不同）"，
    并把 messages 条数与 upstream 作为事实列出（代理未运行时 upstream 显示"无"，不编一个）。
    两个编辑器各有一处就地确认（`data-confirm-execution`）：prompt 的 `canSubmit` 加
    `promptConfirmed`，messages 的提交按钮加 `!messagesConfirmed`；沿用 4.4 的执法点
    （`beginDraftSubmission` 带 `confirmation`），**原生 `window.confirm` 在这两处撤下**。
  - 就近资格原因（本章第一条正向要求）：messages 按「源记录 → 恢复重验 → 代理是否在跑 →
    是否捕获到 key → 统一槽门禁」的顺序算出 `ineligible` 并显示在确认区里；
    prompt 复用既有 `submitBlocked`。两处都钉**判据形状**（`!messagesConfirmed && ineligible !== null`
    / `!promptConfirmed && submitBlocked !== null`），只断言"出现过这个变量"是假门。
  - ⚠️ 与 HANDOFF 预判不同的实施结论（更正，免得后人照旧计划绕路）：messages 原本"先登记 →
    解析快照 → 原生确认 → 取消则回滚关联"**不需要重排** —— 确认改在登记口执法后，
    不成立就返回 null（连关联都不登记），而"解析只针对快照原文"这条性质必须保留。
    因此 `settleDraftSubmission(assoc)` 的调用点由 3 处降到 2 处（两处本地校验），
    "取消确认"这一支整体消失。
  - ⚠️ 载体迁移（双侧留痕）：`confirm-dialog.test.ts` 的"`window.confirm` 三处执行确认"计数
    3 → 1（只剩 A/B，由 §4.7 收口）；`draft-submission.test.ts` 的 messages 契约同步改判
    （settle 次数 3 → 2 + 不得再出现原生确认 + 登记必须交出 `confirmation: messagesBinding`）。
    DetailPanel 里两条解释性注释改用"原生确认对话框"措辞 —— 计数判据会被注释里的
    `window.confirm` 字面量误伤（本轮实测：注释让计数停在 3，看起来像"没迁走"）。
  - 三条 messages 既有门禁（「未修改禁用」「未捕获 key」「SDK run 无此入口」）**实现未动**，
    3.3 的源码级 + 受控端到端证据继续有效；本项只在其后叠加确认凭据，不替换任何门禁。
  - 证据：纯判据 4 条（`execution-confirmation.test.ts` 4.6 组）+ 接线 3 条
    （四处确认按钮计数、隔离侧禁用清单、prompt/messages 原因显示的条件形状）。
  - 两组反证各有牙：messages 登记不再交出确认 ⇒ 契约红；原因显示条件反向 ⇒ 判据形状支红
    （我第一版把它写成"出现过 submitBlocked"，同一条变异**不红** ⇒ 假门，改判据形状后才有牙）。
  - ⚠️ 已知边界：① 就地确认的按钮态是源码级契约（无 jsdom），真实点击与焦点归 §6.4；
    ② 当时 A/B 仍走原生确认 ⇒ **已由 §4.7 收口**（五类入口的执行确认至此全部就地化）；
    ③ messages 的"未捕获 key"文案与 `PROXY_NO_KEY` 的 IPC 侧提示各自存在，本项不合并措辞。
- [x] 4.7 接 A/B 当前计划确认及修订失效，不迁独立实验工作区（≤2h）。验收：「实验确认使用当前预览计划」「实验臂增删和非法参数可恢复」。
  - 落点：`lib/execution-confirmation.ts` 新增 `abDisclosure` —— 事实一律取自**当前生效的 dry-run
    计划**（逐臂 `plan.params` 实际生效值、被丢弃的父录值、静默忽略告警、实验组 ID、副作用放行与否）；
    计划缺失时只列目标与规模并明说"尚未取得当前批次的计划"，**不把未校验的草稿文本摊开冒充计划**
    （草稿里的 params 还要经解析、与父 params 合并、丢弃无效项）。"已做的检查"按事实分级：
    只有真跑过预览才追加 `runs:modelAbPlan`（dry-run）那一条。
  - `ModelAbEditor` 就地"核对本次实验"（全会话第 5 处 `data-confirm-execution`）：确认按钮要求
    `activePlan !== null ∧ canSubmit ∧ gate.canSubmit`，执行按钮追加 `!abConfirmed`，
    **原生确认对话框在此撤下**（五类入口的执行确认至此全部就地化），登记口交出
    `confirmation: abBinding`（执法点仍是 `beginDraftSubmission`，不新增第二处）。
  - "检查"的重启：`doPreview` 在资格判据**之后**调 `restartExecutionCheck(draftKey)` ⇒ 重新预览
    推进检查代次，旧确认当场作废（旧响应也装不回新确认）；预览本身仍是只读通道，既不受主动槽
    也不受确认约束（否则就是把门禁当业务判据）。
  - 修订失效沿用 U3 3.3 的 `activePlan = plan !== null && planRevision === draftRevision`：
    披露喂的是 `plan: activePlan` 而非组件局部 `plan`，所以"改了臂还拿旧计划的结论执行"在源头
    断掉。新增的 `planStale` 只用于就近说明"这份计划属于旧批次修订"，**不是第二份判据**。
  - ⚠️ 载体迁移（双侧留痕）：`confirm-dialog.test.ts` 的执行确认原生计数 **1 → 0**（A/B 是最后一处；
    其"A/B 原生确认仍在"的旧契约随之删除，等价证据改为本项的接线用例）；
    `entry-gate.test.ts` 的 A/B 执行按钮契约加 `!abConfirmed` 并改为**归一空白**比对（biome 会折行，
    跨行断言不该依赖排版）；`model-ab-editor-draft.test.ts` 的 3.3 守卫/禁用契约同步加确认项
    （只加不减，`activePlan` 判据仍在原位）；`draft-submission.test.ts` 的 A/B 登记契约改为带
    `confirmation: abBinding`；`execution-confirmation-store.test.ts` 的就地确认计数 4 → 5。
  - 证据：纯判据 6 条（无计划不给臂级事实 / 逐臂实际生效值 / 副作用放行两条 / 边界两条 / 不虚构
    连通性）+ `execution-confirmation-ab.test.ts` 11 条（store 6：整批修订、跨 span 不共享、
    增删臂与非法文本、代次推进、一次性消费、放弃整批撤销；接线 5）。
  - 四组反证各有牙：① 执行按钮去掉 `!abConfirmed` ⇒ 两支红（4.7 与 4.4 契约各一）；
    ② 披露改喂 `plan` ⇒ "activePlan"支红；③ `doPreview` 去掉 `restartExecutionCheck` ⇒ 代次支红；
    ④ 登记不交出 `confirmation: abBinding` ⇒ 两支红（A/B 接线 + 3.4/3.5 快照契约）。
  - ⚠️ 已知边界：① 「实验臂增删和非法参数可恢复」的**可恢复**一面仍由 U3 任务 2.4/2.6 的证据承担
    （`debugging-drafts` / `model-ab-editor-draft`），本项只补"行写入同样作废确认、非法文本逐字留在
    草稿"这一条 store 判据，没有新造恢复路径；② 就地确认的按钮态是源码级契约（无 jsdom），真实点击、
    费用与"重新校验"文案的可发现性归 §6.5；③ 未迁独立实验工作区（按本项口径保持就地）。

## 5. 全局反馈与设置返回

- [x] 5.1 扩展操作列表/详情的请求事实、结果状态、受控诊断及结果动作（≤2h）。验收：「操作详情可读诊断但不泄漏输入」「失败信封仍可打开可信记录」「settled 无身份与 notAccepted 不猜测结果」。
  - 落点：`lib/operation-result-view.ts` 新增 `requestFactsLineOf`（信封侧收口**单独一行**：
    returned/failed/rejected + 稳定码；rejected 措辞钉"是编排分类，不一律等于零模型调用"，
    running/notAccepted ⇒ null——"没有开始执行"只属于 notAccepted 文案）与
    `deriveAbBatchResult`（A/B 逐臂：集合基准 = 登记 `target.armCount`，**不是**信封 `ids` 也不是
    `arms.length`；有 id 的臂复用与操作面板同一个 `itemViewOf`，缺臂/null ID 只给诚实说明、
    零动作零链接；快照未到场 ⇒ 只报等待不预告结局）。`lib/operation-list.ts` 的
    `OperationRow.diagnosticCount` 替换为 `diagnostics`（main 已脱敏限长，原样透传，条数从列表现数）
    + `requestLine`；`OperationsEntry` 渲染请求事实行与 `<details>` 诊断列表，
    `ACTION_LABELS`/`TONE_STYLES` 导出共用（两处各写一份必然分叉）。
    新组件 `components/AbBatchResult.tsx`（只吃 props）+ `DetailPanel` 的 `ModelAbEditor`：
    信封 `executed` 状态**删除**，改留 `executedOperationId` 提交身份指针；批次结果区现算吃
    登记快照 + `resultReads`；"实验完成/成功 N 臂"通报框消失，底部写死"不产出臂间差值/胜出臂"。
  - 证据：`test/operation-request-facts.test.ts` 16 条——分层措辞（returned 不宣告结局、
    failed 不削减结果动作、rejected 不一律零调用）、失败信封仍给 open-result、
    unlocated/notAccepted 不造链接、诊断逐条渲染 + 夹带未知字段的记录被
    `OperationRecordSchema.strict` 拒（"不泄漏"的机器判据）+ 呈现层 import 面扫描
    （无草稿/提交快照/目录凭据通道）、`deriveAbBatchResult` 逐臂与缺臂诚实、
    DetailPanel 源码级接线（信封不再进面板）。门禁复跑：desktop **124 文件 / 2147 用例 / 0 失败 /
    无 Errors 行**；根 biome 449 文件 0 错；tsc node/web 双 0；desktop-test 配置**我改的文件 0 错**
    （顺手修掉该文件一处 HEAD 既有隐式 any，总错误 212→211）；`validate --all --strict` 13/13。
  - 五组变异（Edit 施加、当场复原）：① rejected 措辞注入"未执行任何模型调用"⇒ 1 红；
    ② 臂基准改 `arms.length` ⇒ 1 红（running 两臂支）；③ `diagnostics` 摘空 ⇒ 2 文件红；
    ④ `requestLine` 摘 null ⇒ 1 红；⑤ 逐臂读取键的 epoch 挪空 ⇒ 1 红（verified 臂掉回"待读取"）。
  - ⚠️ 改判留痕（两边）：`model-ab-editor-draft.test.ts` 的 U3 源码断言
    `setExecuted(null);` → `setExecutedOperationId(null);`（临时态清理判据不变，载体改名）；
    `entry-gate.test.ts`「三个编辑器同一来源」的 A/B 支改判为"先订阅后派生"两步字面在场
    （`operationsSession` 被批次结果区共用，判据仍是同一份 `s.operations`，无第二套状态源）；
    3.3 注记的"批次结果区仍显示信封"边界兑现，见上方 3.3 的 ➕ 回补与
    `proxy-ab-entry-closure.test.ts` 头注迁移。
  - ⚠️ 已知边界（不静默）：① 等待计时/未读标记/`aria-live` 属 5.2——本项的行内时间字段
    （startedAt/settledAt）仍未显示；② 批次面板以**本地提交身份指针**为输入，renderer 重载后
    呈现退场（登记快照仍可在操作面板核对）——重载恢复语义归 5.2/6.6；③ 真实点击、费用文案
    与窄窗呈现归 6.5/6.8；④ "本次执行待处理"通报框里"待 U5 接入可信操作身份后才自动清理"
    是滞后的过渡文案，按 4.7 注记归 5.6 文案更新，本项不动。
- [x] 5.2 添加真实等待计时、跨页入口、结果未读提示和全局 `aria-live="polite"` 通知，关闭详情只关闭查看；通知区域独立于操作面板，重复状态和计时不重复通知（≤2h）。验收：「执行中离页仍可查询等待」「终态和重载后的计时不伪造」「关闭详情与退出不冒充停止」「恢复核对重试与批次结果只通知」。
  - 落点（两个提交）：**5.2a 计时** —— `PendingSubmission` 新增 `submittedAt`（本地提交时刻，
    会话内存；IPC 信封仍只带 `epoch/operationId` 两键，main strict schema 不外带）；
    新 `lib/wait-timing.ts`（running：本地时刻优先、重载后退回 main `startedAt` 并明标
    「自接受起」；settled 定格在 `settledAt`；notAccepted/无时间事实/NaN ⇒ null 不造数）；
    新 `lib/use-wait-clock.ts` **唯一**可见性受控时钟（面板开 ∧ 有可盯操作才走秒、页面隐藏不空转、
    零 store/IPC 依赖）；`OperationRow.wait` 由派生注入，`OperationsEntry` 只渲染不复算。
    **5.2b 通知区** —— 新 `components/ResultLiveRegion.tsx`（`<output>` 语义 live region，
    隐式 role=status + 显式 `aria-live="polite"`，biome useSemanticElements 的正解；**恒渲染**，
    空文本不卸载），挂在 App 外壳（独立于面板开合与当前视图）；文本与徽标**同一份**
    `deriveResultNotices`（重复快照派生逐字相同 ⇒ DOM 不变不重复播报；计时不进文本由 3.6 判据保证）。
  - 证据：`test/wait-timing.test.ts` 15 条（口径分层/停增/不造数/store 信封形状/源码级时钟约束）+
    `test/result-live-region.test.ts` 5 条（区域恒在/文本稳定同源/不摸执行导航通道/App 无条件挂载/
    ✕ 只 `setOpen(false)`）。跨页入口本身复用 U4 全局栏（`GlobalBar` 无条件渲染的断言并入本文件）。
  - 五组变异各有牙并复原：终态时长改吃 `nowMs`（不停增）、running 忽略本地时刻、去掉
    非有限时间戳守卫、区域空文本卸载、通知区挂进条件分支。
  - ⚠️ 已知边界（不静默）：① 设置是原生 top-layer 模态（背景 inert），**模态打开期间**
    live region 的播报可达性属浏览器行为，真机证据归 §6.8（6.8 判据原文也只要求
    "面板关闭时区域可访问且为 polite"）；② 重载后本地时刻随 renderer 会话一起消失是**预期**
    降级（判据自动换口径），跨重载保留"自提交起"计时不在 spec 要求内；③ 退出的合并确认与
    窄窗焦点归 §5.4/§5.6/§6.7；④ 「关闭详情与退出不冒充停止」的**桥接面**证据（通道表无
    stop/cancel/abort/terminate）由 U4 `preload-surface` 钉，本项只补面板✕与文案判据。
- [x] 5.3 接设置来源返回和摘要刷新，使原检查/许可失效，保持代理入口可达（≤2h）。验收：「两模式配置后返回任务」「重跑编辑配置往返保持阅读」「录制入口保持现有代理区可达」。
  - 落点：`lib/execution-confirmation.ts` 新增 `modelConfigStampOf`（**settingsStampOf 的去代理
    投影**——代理启停/凭据波动不该连带打掉 A/B 计划，delta「代理凭据仍按自身会话规则判断」）
    与 `decidePlanFreshness`（fresh / revision-stale / **config-stale 优先报**）；
    新 `lib/use-revoke-on-config-change.ts`（纯钩子：只在指纹**变化**时回调一次，首挂不算变化）。
    `ModelAbEditor` 预览成功同时记录 `planConfigStamp`（**发起时**捕获 ⇒ 在飞期间改设置也不装新计划），
    `activePlan` 只认 fresh，失效措辞分"配置往返/旧批次修订"两种就近说明；
    隔离 result 编辑器与创建页容器各接一条 revoke：**配置变了 ⇒ 本次副本授权作废**，
    模式与目录引用照旧保留（token 仍由 main 使用时判定）。确认/检查代次的撤销走
    `setSettingsSection` 进出（4.4 已交付），本项补"保存成功改了配置"这一路，两路互补不重复。
    摘要的"已核实保存"= `saveSettings` 成功后立即 `loadSettings` 回读（既有实现），不造第二份核实。
  - 证据：`test/settings-roundtrip-invalidate.test.ts` 11 条（指纹三要素/加密方式与代理不进指纹/
    freshness 三种优先序/两个容器的接线与"revoke 不顺手清 source"禁词块判据/录制入口
    `openRecording` 定位既有代理分区）。
  - 三组变异抽查各有牙并复原（摘掉 config-stale 支 ⇒ 纯判据红；删 result 编辑器 revoke 行 ⇒ 接线红；
    另 U3 断言形状迁移见下）。
  - ⚠️ 改判留痕（两边）：U3 `model-ab-editor-draft.test.ts` 3.3 的字面断言
    `planRevision === draftRevision` 迁移为"组件把两份修订交给 `decidePlanFreshness` +
    activePlan 只认 fresh"（**行为判据不变且增强**，修订比对在纯函数里另有三条单测）。
  - ⚠️ 已知边界（不静默）：① "返回任务"路径的**阅读位置恢复**由 U1/U3 既有证据承载
    （设置是覆盖模态，编辑器不卸载），本项未重测；② 真实点设置保存再返回的实机链路归 §6.2/6.7；
    ③ 未保存关闭确认与保存/回读失败分型属 5.4，清除确认（现仍 `window.confirm`）属 5.5。
- [x] 5.4 补设置未保存修改关闭确认、单向 key、保存防重入和失败/回读失败反馈（≤2h）。验收：「未保存设置关闭可继续或放弃」「单向密钥与保存反馈不冒充连通」「保存失败和保存后回读失败区分」。
  - 落点：新 `lib/settings-form.ts`（`settingsDraftDirty`：模型字段/密钥输入/未应用代理字段
    逐项与**已保存已应用事实**比，trim 同值不算改；代理状态未读到不把代理字段算脏——
    没有可比基线就不钉人；`apiKey` 打过字即未保存输入。`SettingsSaveOutcome` 三态）。
    `store.saveSettings` 从 boolean 改判为 **`saved / save-failed / reread-failed`**
    （`loadSettings` 返回 boolean；回读失败 ⇒ settings 清空 + 不否定"已保存"，两个结论分开)，
    唯一消费方 `SettingsDialog` 按态分支措辞；只读重试按钮只调 `loadSettings`（`settings:get`，
    不受写门禁影响、不重新保存）。关闭确认：✕ / 底部「关闭」/ Esc（ModalDialog onClose）**三路
    同源**走 `requestClose` ⇒ dirty 时 `requestConfirm`「继续编辑（默认焦点，U3 纪律）/
    放弃修改并关闭」，继续逐字保留、放弃只丢会话输入（密钥从未离开渲染层暂存；已保存配置、
    阅读与调试草稿一概不动——对话框 import 面结构上没有草稿通道）。`ConfirmDialog` 增设
    `cancelLabel`（"继续编辑"这类非破坏语义要能说清，缺省仍「取消」）。
    「不冒充连通」：成功反馈只称"已保存并回读到配置状态（未发起任何连接测试）"；
    单向 key 的机器判据 = `SettingsStateSchema` 键集**没有** apiKey。
  - 证据：`test/settings-save-feedback.test.ts` 11 条（dirty 五支 + store 三态四支 +
    键集结构判据 + 对话框源码级五支）。
  - 两组变异各有牙并复原（reread 失败折回 saved ⇒ 分支支红；摘掉 apiKey 脏判据 ⇒ key 支红）。
  - ⚠️ 已知边界（不静默）：① 真机 Esc/焦点回位归 §6.7/6.8；② 「缺 key 按真实校验拒绝」的
    拒绝执法在 main（settings 保存校验），桌面侧本轮只保证措辞与输入保留，未重测 main 分支；
    ③ 清除确认仍用 `window.confirm` —— 属 5.5 的迁移项，别混在本提交里判"归零完成"。
- [ ] 5.5 补清除凭据确认与 U4 门禁接线回归，查看/返回不被锁（≤2h）。验收：「清除确认包含凭据且受槽约束」「初始握手失败禁用主动入口」「结果不可读只重试同一记录」。
- [ ] 5.6 调整本次工作区/设置/确认/操作详情响应式与焦点，更新触及代码的 U3/U4 过渡注释（≤2h）。验收：「长任务路径模型与结果不遮挡操作」「创建页面键盘可离开而模态约束焦点」「创建设置和放弃确认不泄漏焦点」「Esc 只关闭最上层并恢复焦点」。

## 6. 真实接线与受控 Electron 验收

- [ ] 6.1 准备受控 SSE 成功/503/延迟/限制 fixture 与调用计数、只读失败注入，建立本次 evidence-index 场景清单（≤2h）。验收：每条 delta 场景有计划用例或实机入口，fixture 不访问付费 provider；记录所用 main/renderer/脚本版本和数据目录。
- [ ] 6.2 实机验证普通/隔离创建成功、503、执行中离开和配置返回；核对真实 trace、草稿及源目录指纹（≤2h）。验收：「新建 run 成功」「直接创建隔离文件父本」「执行失败不产生半成品」「执行中离页仍可查询等待」「两模式配置后返回任务」。
- [ ] 6.3 实机验证普通/隔离 result 成功/失败、离开再返回及读取途中导航（≤2h）。验收：「成功信封但运行错误」「普通结果与隔离结果确认边界不同」「离开再返回不恢复旧自动导航」「读取途中离页仍不抢焦点」。
- [ ] 6.4 实机验证 prompt 与代理 messages 的确认、失败定位、正常清理和凭据缺失门禁（≤2h）。验收：「prompt 与 messages 不冒充续跑完整世界」「单运行正常结束清理匹配修订」「失败定位和返回草稿明确可达」。
- [ ] 6.5 实机验证 A/B 全正常/部分失败与计划失效，逐臂记录可信 ID 和真实终止事件（≤2h）。验收：「实验确认使用当前预览计划」「全部预期实验臂正常才清理整批」「实验缺臂部分失败与未核实保留整批」；不可从桌面自然诱发的缺臂/null ID 由集成 fixture 单列，不能冒充实机已测。
- [ ] 6.6 实机验证列表/结果读取失败与重试、终态解冻后新修订、通信核对和同 main 重载（≤2h）。验收：「列表失败不阻断已知结果」「结果不可读只重试同一记录」「解冻后修改不被旧结果删除」「未知通信与新会话分开呈现」「恢复核对重试与批次结果只通知」。
- [ ] 6.7 实机验证设置保存/清除/未保存退出和合并窗口退出，记录密钥不回读证据（≤2h）。验收：「未保存设置关闭可继续或放弃」「保存失败和保存后回读失败区分」「清除确认包含凭据且受槽约束」「关闭详情与退出不冒充停止」。
- [ ] 6.8 按代表宽度和独立 200% 缩放采集长文本/路径/多臂、真实 Tab/Shift+Tab/Esc、U2 文件页往返及数据指纹（≤2h）。验收：「长任务路径模型与结果不遮挡操作」「创建页面键盘可离开而模态约束焦点」「操作入口在窄窗口和键盘下可达」「只读反馈和读取重试保持数据边界」「恢复核对重试与批次结果只通知」；面板关闭时断言 live 区域可访问且为 polite，真实结果变为可查看/不可读时文本更新、重复状态/计时不重复通知、焦点不变。未实测屏幕阅读器时仅记 DOM/可访问属性证据，不宣称已验证实际播报。

## 7. 回归与收口

- [ ] 7.1 回归新创建父本的 prompt/A-B/Trace-as-Test、现有执行权限/配置锁与 U1/U2/U3 阅读/草稿保护（≤2h）。验收：「新建 run 作为父本进行 prompt fork」「新建 run 作为父本进行模型 A/B」「新建 run 作为父本进行 trace-test」「所有入口实际使用同一适配器」「文件承载区不附带步骤目录」「阅读过程不修改已有数据」及原有包层不变量。
- [ ] 7.2 执行仓库要求的 Biome、desktop 类型检查/测试/构建和相关包门禁，记录实际通过/失败/跳过与环境限制；长门禁按现有串行规则运行（≤2h 记录窗口，超出拆任务，不与 Electron 证据脚本争用实例）。验收：新增接线无回归、无隐藏 Errors；OpenSpec 全量 strict 通过。
- [ ] 7.3 逐条核对 delta→用例/fixture/实机证据和七入口→消费点，复核七条 MODIFIED 的场景差集并记录有意契约变更及未验证限制（≤2h）。验收：无虚构引用、无漏场景，U4 旧证据与 U5 新证据分开；「普通结果与隔离结果确认边界不同」须同时引用 4.4/4.5 两侧证据，缺一侧只记部分覆盖；tasks 仅在真实完成后勾选，归档/打包/发布另行处理。
