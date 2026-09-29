# U6 实施与验收任务

> 本轮仅修订文档，全部任务待实施。每项 <=2h；超过即按入口/fixture 拆分，不压缩验收。每条“对应”均为 delta 中的完整 Scenario 标题。§6–7 的索引/门禁还须覆盖全量场景，其点名场景是最小反例锚点，不能代替逐行核对。

## 1. 结构化读取诊断

- [x] 1.1 在桌面读取适配层分类当前缺失与祖先 ENOENT，保持 GET_RUN_FAILED 信封（对应“当前文件或祖先不是可确认的缺失”、“普通 result 缺祖先只读当前记录”）。—— `run-lineage-read.ts` 单次读取上下文：原生 ENOENT 才记缺失，祖先缺失返回结构化 missingRunId；§1 内普通/隔离 result 缺祖先仍严格失败（受控原因），ownOnly 信封留 §2/§3
- [x] 1.2 区分损坏/权限/目录代替文件，拒绝通用 catch 与文本匹配降级（对应“祖先文件损坏不降级”）。—— TraceReadError ⇒ ANCESTOR_INVALID；errno code 结构化判定（目录代替文件/注入 EACCES）⇒ ANCESTOR_UNREADABLE；无 errno 的未知异常一律不可读，绝不落缺失分支
- [x] 1.3 回归转换前的未来版本与 v1 隔离字段守卫（对应“未来版本祖先不降级”、“v1 祖先携带隔离字段不降级”）。—— reader 版本守卫在 schema parse 前自然生效；§1 用例锁定 v3 祖先与 v1 私带 workspace/resume_after_step/workspace_snapshot 三处均判 ANCESTOR_INVALID 而非缺失
- [x] 1.4 校验文件 ID/路径和 meta.id 一致，非法标识在目录外读取前拒绝（对应“文件身份与路径不能伪造来源”）。—— `findIllegalRunIdViolation`（分隔符/穿越/绝对路径/NUL）+ 注入计数证明零 fs 访问；`loadRunRecord`/`getRun` 双入口接线；meta.id 不符拒绝且不暴露缺失语义
- [x] 1.5 补 parent/fork、成环、封存与可验证定位检查，锁定缺失不能掩盖已知错误（对应“祖先链成环不降级”、“fork 定位非法不降级”、“已知无效关系不能被更早缺失遮蔽”）。—— 每 hop 结构检查先于更早祖先加载：缺 fork/根带 fork/未封存/v2 边界不在可读直接父（resolveWholeRound 判据①②的必要条件）⇒ FORK_INVALID；成环 ⇒ LINEAGE_CYCLE；v1 at_span 依赖缺失祖先时记缺失不谎称非法（对照用例锁定）
- [x] 1.6 将内部六类诊断映射为受控提示，保留真实缺失 ID 而不泄漏原始异常（对应“读取诊断不泄漏路径和正文”）。—— 全部失败原因收敛为受控中文；用例统一断言无 errno 原文/物理路径/盘符/堆栈行；成功降级仅暴露 missingRunId

## 2. shared、main、preload 与读取入口

- [x] 2.1 增加 completeness/spanScope/lineage 必填结构与合法组合，拒绝错配及未知枚举（对应“详情完整性字段拒绝错配”、“根 run 以自有轨迹返回”）。—— `RunLineageSchema`（discriminatedUnion + strict，complete 不带缺失字段）+ `RunDetailSchema.superRefine`；组合判据：ownOnly 只配 own，未知枚举/缺省 completeness 整份拒
- [x] 2.2 增加 chain 连续性、唯一性、末跳身份和缺失边界关系校验（对应“详情完整性字段拒绝错配”、“普通 result 的隔代祖先缺失”）。—— `run-detail-integrity.ts`：chain 非空/ID 唯一/末跳=meta/相邻 parent 连续；ownOnly 首项 parent=missingRunId 且断点不在链内
- [x] 2.3 校验 leafSpanIds 自有范围，main 对照原始记录；允许合法空数组，拒绝重复/多余/遗漏 ID（对应“合法零 span 记录可部分读取”、“详情完整性字段拒绝错配”）。—— 载荷层判子集/精确覆盖/重复；main 侧由 §1 单次上下文的 `leafSpanIds = record.spans` 构造天然对齐原始记录
- [x] 2.4 在 main 返回与 renderer 选中详情入口接版本/schema 守卫；preload 方法面不扩张（对应“详情完整性字段拒绝错配”、“未来版本祖先不降级”）。—— `getRun` 返回前 `checkedDetail` 自检（main 不出站错配载荷）；store 选中详情与 U5 后台核实既走版本守卫 + safeParse，契约收紧自动生效；preload 未动
- [x] 2.5 迁移 U5 后台 verifyResultPayload 与全部详情 fixture/API 桩，补串号与错配载荷接线测试（对应“ownOnly 正常结果仍按原修订清理”、“详情完整性字段拒绝错配”）。—— 15 个测试文件的 detail 构造器批量迁移（批量脚本 15/15 一次命中）；main 四形态产出过 schema 的契约测试 + verifyResultPayload 拒绝缺省载荷；「末跳串号」断言改注层次（schema 先拒，身份核对层由 terminal-facts 单测直承）

## 3. repository 来源与轨迹投影

- [x] 3.1 建立单次读取上下文，根与纯 v1 result 完整链复用严格 loader/resolver（对应“根 run 以自有轨迹返回”、“普通 result 的完整父链仍合并”）。—— §1 的 readRunLineage 即该上下文；纯链（isPlainResultChain）仍走 resolveBranch，行为逐 id 不变（对照用例锁定）
- [x] 3.2 实现直接缺父 ownOnly，自有 spans/events/status 与 leaf IDs 精确匹配（对应“普通 result 缺祖先只读当前记录”、“合法零 span 记录可部分读取”）。—— result 分支缺祖先改返回 ownOnly/own 投影；零 span 变体断言空数组合法、自有事件保留
- [x] 3.3 实现隔代缺失连续 chain 与真实 missingRunId，不混入中间祖先 spans（对应“普通 result 的隔代祖先缺失”）。—— walk 已产连续 records；ownOnly 投影 spans 恒取当前 run 自有
- [x] 3.4 实现 prompt 独立范围与缺失诊断，完整与缺失均不拼父轨迹（对应“prompt、代理和 model_params 的自有范围不等于降级”、“prompt fork 缺祖先不改变从头轨迹”）。—— §2 起独立分支 ownLabels；本段补完整链不拼父轨迹用例
- [x] 3.5 实现 proxy 独立范围与缺失诊断，不借列表或其他被动记录（对应“proxy fork 缺祖先不借用代理记录”、“独立轨迹缺祖先也返回结构化 ownOnly”）。—— 同上；用例断言另一条完整 proxy run 的数据零渗入
- [x] 3.6 修正 model_params 自有轨迹与完整来源检查，补完整/缺失两组 fixture（对应“model_params 臂缺祖先不变成可比较结果”、“prompt、代理和 model_params 的自有范围不等于降级”）。—— forkField=model_params 从 resolveBranch 合并改为独立 own 轨迹（有意变更）；完整/缺失两组用例
- [x] 3.7 显式断言完整隔离 result 返回 complete/resolved 与完整 lineage，保留 v2 整轮截断及直接父边界校验，并覆盖隔离直接/隔代缺失（对应“完整隔离 result 保留整轮前缀”、“fork 定位非法不降级”、“普通 result 的隔代祖先缺失”）。—— 复用 u2 iso-data 三层隔离链 fixture；直接/隔代缺失 ownOnly + 断点正确
- [x] 3.8 实现混合链逐 hop 投影与独立边界，未知 field 拒绝；只读逻辑不改执行解析（对应“混合父链不跨独立边界拼接”）。—— 新增 run-detail-project.ts：result hop 按版本截断（v2 共用 resolveWholeRound 的最小提取导出，执行语义零改动）、独立边界重置、未知 field 受控拒绝；纯链不受影响
- [x] 3.9 恢复父文件后全链重读，非法恢复仍失败，不缓存旧 completeness（对应“父文件恢复后重试全量重验”、“祖先文件损坏不降级”）。—— 每次 getRun 全新 walk 天然无缓存；用例锁 ownOnly→损坏恢复仍失败→合法恢复切 complete

## 4. 详情 UI 与 U5 结果收尾

- [x] 4.1 概览显示固定提示、缺失 ID、自有输出/消耗；沿链指标未知，不补零（对应“部分普通分支不伪造共享前缀”、“model_params 臂缺祖先不变成可比较结果”）。—— 新纯判据 `lib/detail-completeness.ts`（`LINEAGE_INCOMPLETE_TEXT` 固定文案唯一来源 + `lineageIncompleteViewOf`）；`presentSource` 增 `incompleteNote`（ownOnly result 分支替换掉"共享前缀"原句式）、`presentConsumption` 增 ownOnly 口径行；`SourceSectionView` 渲染 `data-source-incomplete` 块；证据 `test/u6-detail-ui-completeness.test.ts`（18 条，含错配载荷防御）
- [x] 4.2 步骤与来源组件接完整性投影，截断首项不冒充根，保留被编辑字段（对应“部分来源链首项不冒充根”、“分支 run 的轨迹”、“完整普通分支保留被编辑字段”）。—— `DetailNotices` 新增 `LineageIncompleteNotice`（步骤页+文件页同源）；`BranchNotice` ownOnly 分流（`ownOnlyBranchNoticeOf`：不称共享前缀、保留分叉点/编辑字段标注）；`ParentChainList` ownOnly 也渲染并标「截断：首项不是根 run」（`truncatedChainTitleOf`）；SpanTree 自有/继承标记走 leafSpanIds，own 范围下无假「继承」行（反查确认无需改）
- [x] 4.3 独立分支仅显示自有轨迹，父级链单列；反查现有分支派生与比较消费点（对应“完整独立分支不拼接父轨迹”、“独立分支来源链完整但不共享执行前缀”）。—— main §3.4–3.6 已投影独立 own 轨迹；ParentChainList 对独立分支单列（既有）；反查结论：`deriveChainTotals`/`findCommonAncestor`/`deriveComparison` 均以列表 `walkUpChain.incomplete` 为闸——ownOnly 祖先不在列表 ⇒ 拒绝比较，无需新改（derive.ts 486–589 源码依据）
- [x] 4.4 文件入口保留初始/自有完成步骤与 C 的清单/blob 校验，来源缺失不阻断自有文件（对应“ownOnly 文件入口不显示祖先检查点”、“缺祖先与缺附件分别诊断”）。—— 判据已在 C/U2 落在 leafSpanIds（`workspace-files.ts`），main §3 投影保证 ownOnly spans 只含自有记录；本条在 ownOnly 形状下钉行为锁：祖先 step 不进选择器/判 stale/回退最近自有步骤、附件缺失与祖先缺失两套文案互不冒充；文件读取不挂 `canExecuteFromSource` 闸（grep 反查：该闸仅 DetailPanel 四处执行编辑器消费）。证据 `test/u6-file-entry-ownonly.test.ts`（6 条）
- [x] 4.5 接详情刷新 run ID/读取代次/导航守卫，保留有效阅读状态及失效回退（对应“读取重试不改变阅读位置”、“父文件恢复后重试全量重验”）。—— `detail-request.ts` 新增 `isCurrentDetailAttempt`；store.selectRun 每次实际发读递增 `detailReadAttempt`（模块计数，五处落地口全挂代次闸——同 run 连续重试是归属判据的盲区）；落地时**现取** readingByRun 历史（旧快照会覆盖在飞期间的新选择）；证据 `test/u6-detail-refresh-guard.test.ts`（6 条，含"恢复前 ownOnly 旧响应后到不盖 complete"与"旧失败收尾不清新加载态"）
- [x] 4.6 操作结果展示自有结局与来源警告，接后台核实和匹配修订清理的真实 store 路径（对应“ownOnly 正常结果仍按原修订清理”）。—— `ResultReadEntry` 增 `lineage`（verified 携带经核实的来源完整性，reading/unreadable 恒 null）；`itemViewOf` 增 `sourceWarning`（"……正常结束不等于可以重跑"，与结局分层）；OperationsEntry/AbBatchResult 渲染 `sourceWarning` 警告行；清理路径零改动——`decideDraftClosure` 只认 facts.normalEnd，ownOnly 天然参与。证据 `test/u6-partial-result-closure.test.ts`（4.6 组 2 条：store 清理路径 + 面板分层呈现）
- [x] 4.7 回归 error/限制/中断保留草稿，显式失败定位只认自有调用（对应“ownOnly 失败定位只使用自有调用”）。—— 回归确认：`deriveOwnTerminalFacts.failure` 走 leafSpanIds（ownOnly spans 全自有 ⇒ 定位必在自有调用内）；无自有失败详情 ⇒ 无 view-failure 动作只给诚实说明；error 终止 normalEnd=false ⇒ 草稿保留。证据同文件 4.7 组 2 条
- [x] 4.8 A/B 部分详情沿用预期臂/唯一 ID/experimentId 判据，缺臂与 null ID 保留整批（对应“部分实验结果保留完整批次判据”）。—— 判据零改动：`batchGapOf` 不看 completeness；ownOnly 臂各自身被独立核实为正常终止后照常计入整批。证据同文件 4.8 组 2 条（两臂 ownOnly 清理 + 缺臂/null ID/不可读三例保留）
- [x] 4.9 结果手动重试沿用 U5 身份/代次去重，保护新修订与新 token，无关联不猜草稿（对应“后台重试不导航也不重发执行”）。—— `retryResultRead` = `readRunResult(force=true)` 既有路径回归确认：不可读→ownOnly 正常后按尚存关联清理，全程只走 `runs:get`、不换选中项、不导航；重试前推进的新修订不被删除（修订 CAS）。证据同文件 4.9 组 3 条（含纯层 verifyResultPayload 携带 lineage 回归）
- [x] 4.10 renderer 得知来源不完整/不可读后，复用检查代次使旧预检/计划/确认与副本授权失效；恢复要求重新检查且保留草稿，main 不新增许可吊销登记（对应“预检后父链变化仍由 main 拒绝”）。—— `detail-completeness.ts` 增 `LINEAGE_REJECTION_CODES`/`isLineageRejectionCode`；store 增 `sourceRevocation` 撤销令牌 + `revokeSourceBoundPermissions`（检查代次每键 +1 + 确认清空 + 令牌 +1），触发口 = selectRun 落地 ownOnly 与 `submitActive` 响应以来源类稳定码拒绝；DetailPanel 隔离编辑器/A-B 编辑器订阅令牌（复用 `useRevokeOnConfigChange`，签名放宽为 string|number）撤销 capability 结果/副本授权与 A/B 计划/副作用许可，草稿正文保留；令牌只增不减 ⇒ 恢复不自动复活；main 侧吊销登记零新增（renderer 会话内凭据）。证据 `u6-partial-result-closure.test.ts` 4.10 组 3 条
- [x] 4.11 长 ID、警告、禁用原因和重试动作接现有可达性规则（对应“部分详情提示和恢复动作可达”）。—— `LineageIncompleteNotice` 拆为纯视图 `LineageIncompleteNoticeView`（props 可静态断言）+ store 薄壳：缺失 ID `break-all`（窄窗/200% 换行不断版）+ `aria-label` 复制按钮（FOCUS_RING，Tab 可达读屏可辨）；概览来源区 `incompleteNote` 块加 `break-all`；操作面板来源警告行与 runId 均已有 break-all（U5 既有规则沿用）。实机 800/1024/1440+200%+真键盘验证归 §6.8。证据 `u6-detail-ui-completeness.test.ts` 4.11 组 3 条（21 条全绿）

## 5. 执行门禁与实际端点接线

- [x] 5.1 定义共享 main 来源检查及 RUN_LINEAGE_INCOMPLETE/RUN_DETAIL_UNREADABLE 映射，在 U4 接受后 settled/rejected 收口（对应“详情加载失败在执行入口即拒绝”）。—— 新模块 `main/run-source-gate.ts`：`checkRunSource(tracesDir, runId)` 复用 `readRunLineage` 单次读取上下文（只读零写入）——完整链放行；祖先确实缺失 ⇒ `RunSourceRejection("RUN_LINEAGE_INCOMPLETE", …, missingRunId)`；其余读取失败（当前缺失/损坏/版本/成环/非法定位）⇒ `RUN_DETAIL_UNREADABLE`；`toRunResult` 增映射分支 ⇒ settled/rejected + 稳定码 + runIds 空 + finally 只释放本槽（registry 既有语义）。证据 `test/u6-exec-source-gate.test.ts` A 组 4 条 + B 组回执断言
- [x] 5.2 接普通 result 端点；有效请求直调覆盖零业务副作用与匹配回执（对应“ownOnly result 不可重跑”）。—— `forkChannel.run` 在 settings 检查之后、`runFork` 之前接 `checkRunSource`；真实 fork 链造 ownOnly 标本（fork 出子 run 后删父文件）：响应 ok:false + settled 回执 + `RUN_LINEAGE_INCOMPLETE`（消息含缺失 ID、无路径），record rejected/runIds []，零模型调用零新 trace。正对照：父链完整时同形请求成功。证据 B 组 3 条
- [x] 5.3 接隔离 result 端点与合法 allowFileWrites 请求，断言无副本世界/trace 创建，不新增 sourceToken（对应“ownOnly 隔离 result 不消费副本授权”）。—— 同一 `checkRunSource` 覆盖隔离分支（`runForkIsolated` 之前）；真实隔离根 run（execCreateRun+token）→ 隔离续跑出 C（正对照 ok）→ 删根文件 → C 上合法 allowFileWrites 请求 ⇒ `RUN_LINEAGE_INCOMPLETE`，零模型调用零新 trace，令牌消费计数不变（result 请求 schema 本无 sourceToken 字段）。证据 C 组 1 条
- [x] 5.4 接 prompt 端点，来源拒绝后仍保留完整父本的原领域门禁（对应“ownOnly prompt、代理和实验臂不执行”）。—— `promptChannel.run` settings 检查后接 `checkRunSource`；ownOnly prompt 父本（真实 prompt fork 出子 run 后删父）⇒ RUN_LINEAGE_INCOMPLETE + settled/rejected 回执 + 零模型调用；正对照反证：完整父本 + 无 system 消息 ⇒ `PROMPT_FORK_NO_SYSTEM` 照常拒绝（领域门禁不被绕过）。证据 `u6-exec-source-gate.test.ts` 5.4 组 2 条
- [x] 5.5 接 proxy 端点，计数模型请求/录制写入/真实 ID，零借用其他记录（对应“ownOnly prompt、代理和实验臂不执行”）。—— `proxyChannel.run` 在 `deps.proxy.fork` 之前接 `checkRunSource`（发请求/录制之前）；ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE + runIds 空 + 代理 fork 零调用；正对照：完整父本 + 代理桩 ⇒ 成功。真实代理链路（发请求/录制写入计数）归 §6 受控回归。证据同文件 5.5 组 1 条
- [x] 5.6 接 A/B 整批执行来源门禁，第一臂前拒绝且无运行身份（对应“ownOnly prompt、代理和实验臂不执行”、“ownOnly model_params dry-run 保持只读”）。—— `modelAbChannel.run` settings 检查后、`runModelAb` 之前接 `checkRunSource`；ownOnly 父本（真实批次造臂后删父）⇒ RUN_LINEAGE_INCOMPLETE，record arms []/runIds []/experimentId null（零臂身份），零模型调用；正对照：完整父本整批成功。证据同文件 5.6 组 1 条
- [x] 5.7 接 A/B dry-run 同源拒绝；对照完整合法父本预览仍可用且不占槽（对应“ownOnly model_params dry-run 保持只读”）。—— `execModelAbPlan` settings 检查后接 `checkRunSource`（捕获 `RunSourceRejection` 转普通错误信封——本通道不登记不占槽的既有语义不变）；ownOnly 父本 ⇒ RUN_LINEAGE_INCOMPLETE + 零网络 + registry 无新登记；正对照：完整父本 dry-run 计划照常给出。证据 `u6-exec-source-gate.test.ts` 5.7 组 2 条
- [x] 5.8 接隔离 capability 来源拒绝；自有文件接口保持独立可读（对应“隔离 capability 对不完整来源明确拒绝”）。—— `runForkCapability` 入口接 `checkRunSource`；ipc.ts catch 增 `RunSourceRejection` 分支（不落 FORK_CAPABILITY_FAILED 兜底）；真实隔离链（根→B 续跑）删根后 capability ⇒ RUN_LINEAGE_INCOMPLETE + missingRunId=根；正对照根在场照常给出；同場景断言 `inspectWorkspace(B)` 初始快照照常取得（自有文件阅读不被封禁）。证据 `isolated-desktop-flows.test.ts` U6 5.8 组 2 条
- [x] 5.9 验证父链变化与有效 direct IPC 绕过 UI；服务端重读，不信任客户端详情（对应“预检后父链变化仍由 main 拒绝”）。—— 端点级测试本身即 direct-IPC 等价（不经任何 renderer/按钮）；专测：dry-run 预检通过后父文件消失，正式提交仍被来源门禁拒绝（当前 run 缺失 ⇒ RUN_DETAIL_UNREADABLE，design D2「缺当前文件直接失败」）；请求 schema 里本就没有 completeness 字段 ⇒ 客户端声明无从伪造。证据同文件 5.9 组 1 条
- [x] 5.10 验证同 ID 恢复不复活、异参/旧 epoch/tombstone 及槽归属；新 ID 重检才可能执行（对应“父链恢复不复活已拒绝操作”）。—— 同 ID 再提交先命中 U4 判重（OPERATION_ERROR.duplicated，零重读零执行——异参 conflict/旧 epoch/tombstone 归 U4 既有测试，未动）；恢复父文件后**新 ID** 重新提交 ⇒ 重检通过正常执行。证据同文件 5.10 组 1 条
- [x] 5.11 回归普通/隔离 create 与被动录制，无父本路径不受所选 ownOnly 阻断（对应“无父本创建和被动录制保持原契约”）。—— create 通道无 parentRunId ⇒ 不经过来源门禁（代码路径事实）；专测：磁盘存在 ownOnly run 时普通 create 照常成功；被动录制不经 exec 端点（proxy-manager 录制路径零改动）。证据同文件 5.11 组 1 条
- [x] 5.12 反查 renderer 所有执行按钮与只读重试，disabled 有就近原因，重试不调用执行通道（对应“读取重试与执行严格分离”、“ownOnly result 不可重跑”）。—— 反查结论：五类执行编辑器经 `canExecuteFromSource` 单咽喉取执行资格（grep：DetailPanel 四处消费）；`resolveExecutionGate` 增 `lineageIncomplete` 入参、store 注入 `detail.completeness === "ownOnly"` ⇒ ownOnly 时全部执行入口禁用并沿用既有就近原因行（“源记录不可用：重新读取并校验通过前不能发起新执行”）；重试不调执行通道已由 4.9 store 测试钉住（calls 仅 runs:get）；main 来源门禁仍是权威防线（renderer disabled 非保护依据）。证据 `u6-partial-result-closure.test.ts` 5.12 组 2 条

## 6. 受控验证与 Electron 证据

- [ ] 6.1 建立自建临时数据的备份/注入/finally 还原/指纹核验工具，失败保留恢复指引（对应“父文件恢复后重试全量重验”、“读取诊断不泄漏路径和正文”）。
- [ ] 6.2 建立场景→fixture/测试/实机 tag 索引及回查工具，加入漏行/错文件反例；初始全部标待验证（对应“详情完整性字段拒绝错配”）。
- [ ] 6.3 逐入口运行契约负例并配可达正对照；移除来源门禁必须使对应负例变红（对应“ownOnly result 不可重跑”、“ownOnly 隔离 result 不消费副本授权”、“ownOnly prompt、代理和实验臂不执行”、“详情加载失败在执行入口即拒绝”）。
- [ ] 6.4 Electron 第一批：普通/隔离 result 直接与隔代缺失、文件自有检查点，保存实际读数与截图（对应“普通 result 缺祖先只读当前记录”、“普通 result 的隔代祖先缺失”、“ownOnly 文件入口不显示祖先检查点”、“缺祖先与缺附件分别诊断”）。
- [ ] 6.5 Electron 第二批：prompt/proxy/model_params 完整与缺失；验证实际 UI 禁用与有效 IPC 拒绝（对应“prompt fork 缺祖先不改变从头轨迹”、“proxy fork 缺祖先不借用代理记录”、“model_params 臂缺祖先不变成可比较结果”、“ownOnly prompt、代理和实验臂不执行”）。
- [ ] 6.6 Electron 第三批：恢复、损坏/未来版本、已知错误叠加缺失；权限不可实机诱发时单列注入层证据（对应“父文件恢复后重试全量重验”、“祖先文件损坏不降级”、“未来版本祖先不降级”、“已知无效关系不能被更早缺失遮蔽”）。
- [ ] 6.7 Electron 第四批：U5 操作结果提示、失败定位与手动重试；修订/缺臂等不可达注入由 store 集成承载并注明（对应“ownOnly 正常结果仍按原修订清理”、“ownOnly 失败定位只使用自有调用”、“后台重试不导航也不重发执行”、“部分实验结果保留完整批次判据”）。
- [ ] 6.8 Electron 第五批：800/1024/1440 CSS px、独立 200% 与真键盘，保留长 ID/重试/禁用原因证据（对应“部分详情提示和恢复动作可达”）。
- [ ] 6.9 回归完整链 v1/v2、独立轨迹、U1/U2 阅读恢复及 U3/U5 草稿/结果流程，核对源/父/兄弟/blob 指纹（对应“完整隔离 result 保留整轮前缀”、“完整独立分支不拼接父轨迹”、“读取重试不改变阅读位置”、“后台重试不导航也不重发执行”）。

## 7. 工程门禁与逐场景收口

- [ ] 7.1 运行 trace-sdk/replay/desktop 受影响用例、desktop typecheck/build，分开记录产品失败与环境受阻（对应“混合父链不跨独立边界拼接”、“详情加载失败在执行入口即拒绝”、“ownOnly 正常结果仍按原修订清理”）。
- [ ] 7.2 运行 Biome、git diff --check 与 OpenSpec 全量 strict；核对所有 tasks 场景名、MODIFIED 基线差集和明确有意变更（对应“分支 run 的轨迹”、“详情完整性字段拒绝错配”）。
- [ ] 7.3 逐行回查全量 evidence-index 的实际文件/测试标题/tag/结果，反查 repository/IPC/store/UI 消费点；未验证项与 U4/U5 历史限制单列，不自动归档发布（对应“读取重试与执行严格分离”、“后台重试不导航也不重发执行”、“无父本创建和被动录制保持原契约”）。

