# R2.2 场景证据索引

2026-10-19 提案骨架；23 条 requirement、76 条 scenario（含保留的既有场景）。2026-10-21 阶段 2 回填 1–9、27–29；阶段 3 回填 20–31；阶段 4 回填 32–36；阶段 5 增补 5/7/20/23–26/30–31/64–66；阶段 6 回填 37–75（代码/单测；实机 7.x 待做）；7.2 回填实机几何/缩放/真键盘面；**7.3 回填失败与未知路径的实机面与分层限制**。其余待实施。文档/strict 校验不代表功能通过。每行实施后填写测试文件/用例、fixture、实机批次、源码身份及限制；单元注入、mock、真实模型和原生 UI 证据分别标注。

| 序号 | capability | requirement | scenario | 对应任务 | 状态 | 证据与限制 |
|---|---|---|---|---|---|---|
| 1 | trace-format | 格式带版本号 | 未来版本文件 | 1.3、2.2、2.4 | 已交付（2.2） | `packages/trace-sdk/test/reader.test.ts`「未来版本…4」、`version-guard.test.ts`「未来版本 4」、`experiment.test.ts`；desktop `baddata-regression.test.ts`/`run-repository.test.ts`（v4 进 failed）。限制：只证新读取器拒绝；不含旧读取器模拟。 |
| 2 | trace-format | 格式带版本号 | 双版本与旧读取器 | 1.3、2.2、2.4 | 部分（2.2） | 新读取器 v1/v2 回归：`experiment.test.ts`「v1/v2 回归」、既有 reader/workspace-roundtrip 225 用例；普通 writer=v1（agent-loop）、隔离 writer=v2（replay checkpoint tracer 断言）。旧 v1 读取器拒绝 v2 沿用既有版本门禁，本批未新增旧 reader 模拟。 |
| 3 | trace-format | 格式带版本号 | 版本与隔离字段不匹配 | 1.3、2.2、2.4 | 已交付（2.2） | `experiment.test.ts`：v1 workspace/resume_after_step、v2/v3 缺 workspace、v2 私带 prompt_experiment/initial origin、v3 缺 prompt_experiment、v3 已完成 step 缺 workspace_snapshot 均明确拒绝；`version-guard.test.ts` 原 v1/v2 用例保持。 |
| 4 | trace-format | 格式带版本号 | v1 禁字段与其他扩展区分 | 1.3、2.2、2.4 | 已交付（2.2） | `version-guard.test.ts`：v1 workspace/resume_after_step/workspace_snapshot 存在性判定（含 null/false/空对象）；新增 prompt_experiment 禁字段；无关扩展字段仍放行（不递归、不 strict）。 |
| 5 | trace-format | 格式带版本号 | 三版本读取与写入职责分离 | 1.3、2.2、2.4 | 已交付（2.4/3.4/5.4） | v1 普通 writer（agent-loop 104 用例）、v2 隔离 writer（checkpoint tracer 断言）、v3 实验 writer（`isolated-prompt-run.test.ts` + `isolated-prompt-fork-ipc.test.ts` 真实落盘）；v3 卡带产出 v1。旧读取器模拟未新增（沿用既有版本门禁）。 |
| 6 | trace-format | 格式带版本号 | 新实验字段不能藏在旧版本中 | 1.3、2.2、2.4 | 已交付（2.2） | `experiment.test.ts`「v3 版本守卫」：v1/v2 顶层 prompt_experiment=null/{} 在 strip 前拒绝；消息正文同名业务字段不递归拦截（沿用 version-guard 既有判据）。 |
| 7 | trace-format | 隔离 prompt 实验记录初始来源与有效配置 | 初始来源与干预记录往返 | 2.1、2.3、3.3、5.1、6.2、6.6、7.1 | 部分（schema/main 已证；桌面 6.2/6.6；7.1 真实记录） | `experiment.test.ts` schema/parse 往返；7.1 真实子运行 `run_mvhj9i9c_c22r` 的 v3 meta 记录 origin=initial、baseline/原值/新值/假设/判据/execution，报告 `.workbuddy/r22-71/run-20261021-030856/report.json`。真实首次请求一致性由 7.1 首调用记录佐证；UI 展示仍见 6.2/6.6。 |
| 8 | trace-format | 隔离 prompt 实验记录初始来源与有效配置 | 矛盾的实验来源拒绝 | 2.1、2.3、3.3、5.1 | 已交付（2.1/2.3） | `experiment.test.ts`：缺 prompt_experiment、resume_after_step、model_params 编辑、parent/origin/baseline/span/snapshot ID 矛盾均拒绝；`findExperimentSourceViolation` 拒绝非根父、at_span≠父首次 llm.call、original_value 不符。完整来源读取依赖父可读；自有缺父仍可读。 |
| 9 | trace-format | 隔离 prompt 实验记录初始来源与有效配置 | 缺父或附件不阻止自有轨迹阅读 | 2.1、2.3、3.3、5.1、7.3 | 已交付（trace 层 + 7.3 实机） | `experiment.test.ts`「v3 自有文件可独立读取」；**7.3 parent 实机**：同卷隐藏父 trace 后子自有 8 spans 仍可读，真 IPC `getRun` 给 `completeness=ownOnly` + `lineage.status=incomplete` + `missingRunId=根`（⚠️ `selectRun` 对已选中 run 不重读 detail，必须强制重取，否则读到故障前缓存）。附件缺失/损坏的逐侧与降级见行 43/73。 |
| 10 | prompt-replay | 一次分叉只修改一个变量 | 同时修改两个字段 | 3.2、3.6 | 待实施 | — |
| 11 | prompt-replay | 一次分叉只修改一个变量 | 连续 prompt fork | 3.2、3.6 | 待实施 | — |
| 12 | prompt-replay | 一次分叉只修改一个变量 | 隔离编辑保留空串和空白的真实变化 | 3.2、3.6 | 待实施 | — |
| 13 | prompt-replay | prompt fork 的可用父本与失败原子性 | proxy run 拒绝 | 3.1、3.6、5.4 | 待实施 | — |
| 14 | prompt-replay | prompt fork 的可用父本与失败原子性 | 含 config_hash 的 proxy run 放行 | 3.1、3.6、5.4 | 待实施 | — |
| 15 | prompt-replay | prompt fork 的可用父本与失败原子性 | 父 run 未封存 | 3.1、3.6、5.4 | 待实施 | — |
| 16 | prompt-replay | prompt fork 的可用父本与失败原子性 | 隔离父本不能转普通 prompt fork | 3.1、3.6、5.4 | 待实施 | — |
| 17 | prompt-replay | 启动上下文编排可观察真实运行身份 | prompt 身份在后续失败时仍可关联 | 3.5、5.3 | 待实施 | — |
| 18 | prompt-replay | 启动上下文编排可观察真实运行身份 | prompt 前置拒绝不报告假身份 | 3.5、5.3 | 待实施 | — |
| 19 | prompt-replay | 启动上下文编排可观察真实运行身份 | prompt 观察者兼容且释放 | 3.5、5.3 | 待实施 | — |
| 20 | prompt-replay | 隔离 prompt 预检配对根启动输入与初始文件 | 合法根预检只读且提交重验 | 3.1、3.3、5.2、7.3 | 已交付（包/main 5.1–5.3 + 7.3 实机） | `isolated-prompt-preflight.test.ts`：预检前后目录指纹一致、重复预检稳定、删附件后重验失败；`isolated-prompt-run.test.ts` 提交重跑预检；`isolated-prompt-capability.test.ts` 端点只读且 strict；`isolated-prompt-fork-ipc.test.ts` 配置修订/计划漂移/附件缺失时 settled/rejected、零子记录。**7.3 attachment 实机**：附件藏起后带着健康时的 planFingerprint 提交 ⇒ `ISOLATED_PROMPT_ATTACHMENT_MISSING`、登记 settled 且 runIds=[]、零调用零子记录；还原后同一通道重新核对成功（对照）。 |
| 21 | prompt-replay | 隔离 prompt 预检配对根启动输入与初始文件 | 中途分支只能显式返回根 | 3.1、3.3、5.2、7.3 | 已交付（包层 + 6.1 + 7.3 实机） | `isolated-prompt-preflight.test.ts`：中途 result 分支返回 `parent_not_root` + 完整父链验证的 rootId，失败对象无计划/指纹；缺祖先返回 `parent_chain_invalid` 且无 rootId。**7.3 parent 实机**：完整链时「前往根运行」经只读预检落到经验证的根（零调用）；隐藏父 trace 后同一入口如实报「父链 run … 的 trace 文件不存在（不从当前目录或父最终状态补造）」并**留在原目标**，capability 对分支返回 unavailable 且不给 rootId ⇒ 不猜根；还原后导航恢复（对照）。 |
| 22 | prompt-replay | 隔离 prompt 预检配对根启动输入与初始文件 | 缺失或不可还原的启动条件拒绝 | 3.1、3.3、5.2、7.3 | 已交付（包层 3.1–3.3 + 7.3 实机） | `isolated-prompt-preflight.test.ts`：缺根/缺祖先/未封存/v1 根/缺 user/首调用非第 1 步/空编辑/组合编辑/超长假设/工具表与 config_hash 漂移/结构化 params/预算不可接受/配额超限/附件缺失/损坏均返回稳定码；`isolated-prompt-state.test.ts` 覆盖消息形状矩阵。**7.3 实机**：藏 blob ⇒ 界面原样呈现 `核对未通过（attachment_missing）：初始列表中的 fault.txt 附件不可用（附件不存在：…）——不能从当前源目录重新读取`；追加字节 ⇒ 可区分的 `attachment_corrupt（清单记录 39 字节，实际 56 字节）`；真 IPC 各案给 `EMPTY_EDIT`/`PARENT_NOT_ROOT`/`CONFIG_CHANGED`/`PLAN_CHANGED` 与 `INVALID_ARGUMENT` 分流。 |
| 23 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 单项改动与首次实际请求一致 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 已交付（mock + 7.1 真实模型） | `isolated-prompt-run.test.ts` mock 首请求断言；7.1 真实子运行首请求模型=`deepseek-flash`、system 恰为编辑后的只读指令、仅调用 read_file 读到 A；报告 `report.json` 的 `main`/`attempts.main`。真实服务端条件与人工判据见 7.1。 |
| 24 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 不支持参数或配置漂移不能静默放行 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 已交付（3.2/3.3/5.2） | `isolated-prompt-state.test.ts` params 矩阵；`isolated-prompt-preflight.test.ts` profile/config_hash/预算；`execution-config-state.test.ts` 换 key/端点/清除重配轮换；`isolated-prompt-fork-ipc.test.ts` 旧修订/计划漂移拒绝且零执行。 |
| 25 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 历史未知条件与真实计费分别表达 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 部分（capability/UI 6.2；7.1 真实 usage） | capability 返回 `historicalUnknowns`/`billing`；7.1 记录真实 usage：根 3819/326、兄弟 1028/75、主实验 1260/226，价格/缓存仍按实际记录未知，未补零。UI 文案见 6.2。 |
| 26 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 当前写入授权和失败事实不可替代 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 已交付（3.4/3.5/5.2/5.3） | `isolated-prompt-run.test.ts` 未授权/模型失败/存储故障；`isolated-prompt-fork-ipc.test.ts` allowFileWrites 必须 true、拒绝时 runIds=[]、模型失败身份=真实 id。 |
| 27 | replay | 隔离 prompt 构成独立执行边界且可继续 result 续跑 | v3 详情只呈现自有完整步骤 | 2.3、2.4、5.4 | 部分（包层已证；桌面详情 5.4） | `experiment.test.ts` + `isolated-prompt-run.test.ts`：v3 叶子解析只返回自有 spans，chain 仅根→v3 溯源；span id 跨 run 可重复，按 owner/消息内容区分。desktop 详情 `spanScope/chain` 投影归 5.4。 |
| 28 | replay | 隔离 prompt 构成独立执行边界且可继续 result 续跑 | v3 后的 result 分支保留正确前缀 | 2.3、2.4、5.4 | 已交付（包层 2.3/3.6） | `isolated-prompt-run.test.ts` 端到端：真实 v3 父 + `replayIsolatedRun` 子仍写 v2、checkpoint origin/resume_after_step 正确；`resolveBranch` 前缀只含 v3 第 1 轮整轮（step+llm+tool），第 2 轮与实验根不进入，按首轮消息内容证明来源是 v3。 |
| 29 | replay | 隔离 prompt 构成独立执行边界且可继续 result 续跑 | 新版本不扩大普通执行和卡带权限 | 2.3、2.4、5.4 | 部分（包层已证；桌面门禁 5.4） | `trace-test` v3 卡带基线可读可跑且产出 v1；`isolated-prompt-run.test.ts`：v3 父本经 `promptReplayRun` 明确拒绝、零 outDir/零调用；隔离模型实验沿用 workspace 门禁（`isolated-entry-guard.test.ts` 全绿）。**7.3 entry 实机**：隔离父本的 A-B 在界面显示本期不支持且真 IPC 在 main 侧被拒（零调用零子记录）；缺 executionMode 的隔离载荷落到普通分支同样被拒，不降级普通 handler。 |
| 30 | workspace-isolation | 初始快照实验创建独立文件映射 | 根初始状态与父最终及源目录分离 | 1.1、3.4、7.1 | 已交付（mock + 7.1 真实模型） | 7.1：根初始 A（`f06d…`）、根最终 B、源目录改成 C；真实子运行仍读 A、最终 config A，根/兄弟 trace、源目录与既有 blob 指纹不变；单侧导出 config=A。报告 `.workbuddy/r22-71/run-20261021-030856/report.json`。 |
| 31 | workspace-isolation | 初始快照实验创建独立文件映射 | 空初始世界与后续超限遵守原配额 | 1.1、3.4、7.1 | 已交付（3.4） | `isolated-prompt-run.test.ts`：空 initial_snapshot 从头执行并写入；8 MiB+1 写入成为工具错误、检查点保持空、loop 继续；未回写父/源。 |
| 32 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 两个自有检查点独立选择与路径并集 | 4.1、4.2、4.3、5.1、6.5、7.1 | 已交付（包层 4.x + 7.1 真实比较） | `workspace-compare-api.test.ts` 覆盖双 selector/并集/逐侧失败；7.1 实际比较根最终 `s_13` vs 子最终 `s_04`，`unionComplete=true`、路径并集含 config/keep/notes/summary，初始选择器两侧 snapshotId 相同。 |
| 33 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 未核验引用不冒充字节相同 | 4.1、4.2、4.3、5.1、6.5 | 已交付（包层 4.1/4.2） | 清单层只给 `reference=same/different`，不读字节；`readComparedWorkspaceFile` 才逐侧 `readVerified` 并给结论。测试：列表 same 后删除共享 blob → 读取双侧 missing、结论 unavailable；损坏→corrupt、注入 I/O→io。 |
| 34 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 文本新增删除与原换行可核对 | 4.1、4.2、4.3、5.1、6.5、7.1、7.2 | 已交付（包层 4.x + 7.1 真实比较 + 7.2 实机） | `workspace-compare-api.test.ts` CRLF/LF/空串；7.1 真实比较 config.txt different、summary.md left_only；**7.2 实机（widths + keyboard，共 6 条路径逐项）**：Monaco diff 两侧原文逐字（modified=`A: initial-config\r\nB-added-line\r\n`、original=`B: parent-final`）、notes.md 仅差末尾换行判 different、summary.md 右侧空串按「文本=空」呈现不冒充不存在、only-child.txt 左 not_found 诚实标注、keep.txt 判 same；真实行变更 + `.line-insert`/`.line-delete` 着色层在场证明新增/删除方向可辨；编辑器侧粘贴换行按 Windows CRLF 原样保留（K2）。窄档与 200% 档 diff 独立滚动与可达性见 widths/zoom200。 |
| 35 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 二进制和读取错误保留逐侧状态 | 4.1、4.2、4.3、5.1、6.5 | 已交付（包层 4.2/4.3） | `workspace-compare-api.test.ts`：二进制返回原始字节、仅 same/different、不生成文本结论；corrupt/io/too_large 逐侧状态，另一侧仍可读；缺失/损坏不当 not_found。桌面逐侧展示归 6.5。 |
| 36 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 选择快照变化不能拼出混合差异 | 4.1、4.2、4.3、5.1、6.5 | 部分（包层已证；桌面请求代次 6.5） | `workspace-compare-api.test.ts`：列表后替换同 id run 记录，旧 expectedSnapshotIds 读取→该侧 selection_changed 且无正文，另一侧仍可读、整体 unavailable。桌面 selector/path/请求代次丢弃旧反馈归 6.5。 |
| 37 | desktop-ui | 调试台提供启动 prompt 的单变量编辑入口 | 编辑前确认真实计费 | 6.1、6.2、5.4 | 已交付（6.2 代码 + 7.2 实机确认交互；真实用量见 7.1） | `isolated-prompt-card.test.ts` 双确认默认未选、缺一拒绝；**7.2 实机**：卡上分列本次端点/执行上限/预算/历史未知条件/真实计费未知，真键盘 ENTER 完成费用确认（`aria-pressed=true`）、SPACE 勾选副本授权，缺一提交按钮保持禁用；本批模型为本地受控服务（不产生真实计费），真实用量与计费用词由 7.1 package-layer 真实模型闭环承载。 |
| 38 | desktop-ui | 调试台提供启动 prompt 的单变量编辑入口 | system prompt 不可还原 | 6.1、6.2、5.4 | 已交付（6.1 代码/单测） | `isolated-prompt.test.ts`/`isolated-prompt-entry.test.ts`：无字符串 system 时两种编辑均禁用，原因明说不以 config_hash/设置/空串补造；`PromptForkEditor` 入口谓词同源。实机禁用态归 7.2。 |
| 39 | desktop-ui | 比较文件入口保持单运行合法检查点 | 分别打开文件并返回比较 | 6.4、6.6、7.2 | 已交付（6.4/6.6 代码 + 7.2 实机） | `compare-file-wiring.test.ts`/`compare-store.test.ts` 固定检查点与路径、`compareFileView` 跨单侧打开保留；**7.2 实机 K14/K16**：真键盘「打开右侧文件」→ 子运行文件页检查点固定为比较所选（`s_16`）且「返回比较」常驻 → 返回后 pair/两侧检查点/路径全部保留；再返回一次仍成立。 |
| 40 | desktop-ui | 比较文件入口保持单运行合法检查点 | 非法文件目标与普通运行不造历史 | 6.4、6.6、7.2、7.3 | 部分（6.4 代码/单测；实机只诱发附件侧故障） | `compare-file-view.test.ts`：普通运行 not-isolated、祖先/失效步骤 stale 且不自动改点、不可读侧不冒充；`openCompareSideFilesAt` stale→failed。**7.3 实机诱发了附件侧**（藏起仅左侧存在的附件 ⇒ 左 `missing`、右 `not_found` 逐侧如实、不生成伪 diff、还原后回到 `left_only`），但**跨运行 selector 失效/已失效 step 的 GUI 目标**仍未诱发（比较文件视图的检查点选项只列本 run 自有 span，制造「选中后失效」需要并发改 trace，属乱序注入族）⇒ 仍按 4.x/6.4 单元证据承载。 |
| 41 | desktop-ui | 隔离执行边界在操作前可辨认 | 多工具轮次确认 | 5.2、5.4、6.2、7.3 | 部分（6.2 核对卡；实机 7.3） | 核对卡由 `presentIsolatedPromptCard` 排版根/初始文件/工具/模型/上限；多工具轮次仍由 5.2 result 预检承载。实机 7.3。 |
| 42 | desktop-ui | 隔离执行边界在操作前可辨认 | 二次分叉轮号不沿链累加 | 5.2、5.4、6.2、7.3 | 部分（5.4 详情口径；实机 7.3） | 轮号口径沿用 `isolated-fork` 的本地 `agent.step.n`（5.4 回归）；6.2 核对卡不展示沿链轮号。实机 7.3。 |
| 43 | desktop-ui | 隔离执行边界在操作前可辨认 | 历史运行和缺附件降级 | 5.2、5.4、6.2、7.3 | 已交付（7.3 实机） | `isolated-prompt-capability.test.ts` 的 attachment_* 稳定码由 6.2 原样展示；**7.3 attachment 实机**：真实缺附件/损坏时核对卡给稳定码 + 原因，费用确认/副本授权/提交整体不在场，且**没有任何「用当前目录冒充历史快照」的兜底**（原因文本明说不可从当前源目录读取）；未封存根与非 import 根的入口降级由 `isolatedPromptEntryOf` 单测 + 入口常驻原因承载。 |
| 44 | desktop-ui | 隔离执行边界在操作前可辨认 | 隔离父本的其他真执行入口 | 5.2、5.4、6.2、7.3 | 已交付（7.3 实机） | `isolated-fork.test.ts` 只宣称 A/B 不支持；`isolated-prompt-entry` 分支只导航根。**7.3 entry 实机**：隔离根首次 llm.call 详情里 A-B 的「本期不支持」注记在场；`modelAb` 与缺 `executionMode` 的 `promptFork` 真 IPC 都在 main 侧被拒且零调用零子记录；v3 分支不给根编辑按钮、只给显式回根导航，非根载荷被 `PARENT_NOT_ROOT` 拒绝。 |
| 45 | desktop-ui | 隔离执行边界在操作前可辨认 | 每次桌面操作独立确认写入 | 5.2、5.4、6.2、7.3 | 已交付（7.2 + 7.3 实机） | 副本授权默认未选且绑定修订/设置/代次/计划指纹，不读父 trace 的 write_authorized；`isolated-prompt-card.test.ts` 缺授权拒绝。**7.2 真键盘** SPACE 才勾选、缺一提交禁用；**7.3 ipcguard 实机**：缺 `allowFileWrites` 与 `allowFileWrites:false` 两种载荷都由 strict 形状拒绝、受理前不登记（`operation` 为 null）、零模型调用零子记录。 |
| 46 | desktop-ui | 隔离执行边界在操作前可辨认 | 创建与确认在窄窗口可操作 | 5.2、5.4、6.2、7.3 | 已交付（7.2 实机窄窗与 200%） | **7.2 实机**：CSS 800（narrow）与 1024（medium）档下核对卡、副本授权行、提交按钮均可滚可达且卡自身无横向溢出；200%（DPR 4.2，实测 CSS 923×582）档同样判据全绿，窄档运行列表按显示决策收起、「打开运行列表」恢复入口在场；未修改时入口给出就近 guard 原因（K1），不出现只有禁用无说明。 |
| 47 | desktop-ui | 运行工作区按阅读任务组织 | 首次打开与无运行入口 | 1.2、5.4、6.1、7.2 | 已交付（5.4/6.1 代码 + 7.2 实机阅读面） | 6.1 只在隔离根概览加启动指令入口，不改首次选择；desktop 全量回归保持。7.2 实机侧：开局哨兵 reload 后首读、根/子运行选择与页签往返、真键盘 ENTER 打开根入口均成立；「首次打开无运行」分支本轮无空目录可验（dev 数据目录有夹具），以既有 U1/U5 回归与 6.1 单测承载。 |
| 48 | desktop-ui | 运行工作区按阅读任务组织 | 文件承载区不附带步骤目录 | 1.2、5.4、6.1、7.2 | 已交付（5.4 既有回归 + 7.2 实机读数） | 6.1 未改工作区页签/文件承载。7.2 实机：文件页/比较文件视图正文区独立裁切（高度链锚点→main 贯通、main overflow-hidden），文件承载区未见附带步骤目录；比较文件视图正文列与路径列各自裁切。 |
| 49 | desktop-ui | 运行工作区按阅读任务组织 | 旧创建设置及执行入口保持可达 | 1.2、5.4、6.1、7.2、7.3 | 已交付（7.3 实机面 + 既有 U5/U8 口径） | 普通 prompt/A-B/messages 入口由 desktop 全量 214 文件/3272 用例回归；6.1 把隔离根改为独立实验入口、非根只导航。**7.3 entry 实机**：全局栏「新建运行」仍打开同一创建工作区（`aria-label="新建运行"` 在场）、「运行配置」仍打开既有模态且可关；收起导航不影响这些入口。messages 单请求重发与 A/B 的**执行面**实机仍按 U5/U8 既有批次口径引用（本批未重复口播，见 compat-inventory §16 限制）。 |
| 50 | desktop-ui | 运行工作区按阅读任务组织 | 阅读过程不修改已有数据 | 1.2、5.4、6.1、7.2 | 已交付（只读路径回归 + 7.2 实机指纹） | `compare-readonly.test.ts` 与 full desktop 回归；**7.2 实机**：widths/zoom200 全程 dev 数据目录逐文件（sha256+字节）指纹零变化；keyboard 批除本次子 run 与其新 blob 外，根/种子子/7.1 三 run 与既有 blob 全部逐字节不变（K17）；比较与核对全走只读通道，导出只写用户显式选定的空目录。 |
| 51 | desktop-ui | 草稿恢复不恢复执行许可 | 隔离编辑恢复后重新预检授权 | 5.4、6.1、6.3、7.3 | 已交付（6.1/6.3 代码 + 7.2/7.3 实机） | `debugging-drafts.test.ts` 隔离草稿恢复文本/假设；`PromptForkEditor` 切字段/收起/卸载释放确认，授权键需重新勾选；`fork-entry-closure` 提交走同一 CAS。**7.2 实机**：页签往返恢复正文/假设但不恢复费用确认与副本授权；**7.3 实机**：在飞期间该字段被 store 冻结（改动被拒、换字段 disabled），迟到核对只留失效提示 ⇒ 必须重新核对才能再确认。 |
| 52 | desktop-ui | 草稿恢复不恢复执行许可 | sourceToken 在有效期内恢复但授权复位 | 5.4、6.1、6.3、7.3 | 已交付（既有 5.4 回归；实机 7.3） | 6.x 未改创建 sourceToken 路径；桌面全量回归保持。实机 7.3。 |
| 53 | desktop-ui | 草稿恢复不恢复执行许可 | sourceToken 失效不清空任务 | 5.4、6.1、6.3、7.3 | 已交付（既有 5.4 回归；实机 7.3） | 同上；6.x 不改 token 生命周期。实机 7.3。 |
| 54 | desktop-ui | 草稿恢复不恢复执行许可 | 取消目录选择保留原引用 | 5.4、6.1、6.3、7.3 | 已交付（既有 5.4 回归；实机 7.3） | 同上。实机 7.3。 |
| 55 | desktop-ui | 草稿恢复不恢复执行许可 | 迟到检查不覆盖草稿 | 5.4、6.1、6.3、7.3 | 已交付（7.3 实机） | `CompareFileWorkspace` manifest/file 双序号、`PromptForkEditor` 核对请求序号。**7.3 ipcguard 实机**：点核对后在同一次页内求值里推进草稿修订（实测在飞 16 ms 内达成）⇒ 响应落地只产生「输入或运行配置已变化：旧核对结论、费用确认与副本授权已失效」的失效提示，卡/确认/授权/提交都不在场；再点一次核对恢复（对照）。目录选择/A-B 预览两支的迟到响应仍由 5.4/6.x store 用例承载（本批未重复诱发）。 |
| 56 | desktop-ui | 草稿恢复不恢复执行许可 | 设置凭据与调试草稿分离 | 5.4、6.1、6.3、7.3 | 已交付（6.1 代码/单测；实机 7.3） | 草稿键/条目不含凭据或授权；`debugging-drafts` 结构断言与 full desktop 回归。实机 7.3。 |
| 57 | desktop-ui | 草稿交互保持既有执行和数据边界 | 草稿操作零执行且已有文件不变 | 5.4、6.1、6.3 | 已交付（代码/单测；实机 7.3） | 隔离草稿 ensure/写入/假设判据/放弃均不调执行通道；`debugging-drafts`/`draft-submission` 回归。实机 7.3。 |
| 58 | desktop-ui | 草稿交互保持既有执行和数据边界 | 原有执行入口和文件阅读继续可用 | 5.4、6.1、6.3 | 已交付（full desktop 回归；实机 7.3） | 214 文件/3272 用例全量跑全绿；普通 prompt/result/messages/A-B 入口保持。实机 7.3。 |
| 59 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 创建和普通重跑只声明已完成的检查 | 5.4、6.2、6.3 | 已交付（5.4 既有；隔离卡不虚构预检） | 6.2 卡只展示 capability 实际返回；普通入口未改。full desktop 回归。 |
| 60 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 普通结果与隔离结果确认边界不同 | 5.4、6.2、6.3 | 已交付（5.4/6.2 代码） | 隔离卡写明初始文件、单副本写入与真实模型计费；普通 result 路径未改。 |
| 61 | desktop-ui | 执行前检查和确认保持各入口真实语义 | prompt 与 messages 不冒充续跑完整世界 | 5.4、6.2、6.3 | 已交付（6.2 代码 + 7.2 实机文案与卡） | 隔离编辑器标题「隔离 prompt 实验 · 从初始文件与启动指令重跑」、页头常驻根运行 ID + 启动调用 ID（K1/K5 实机读到）；核对卡明说从初始文件世界重跑与只读预检语义（「不调用模型、不写文件、不占执行槽；结论不是执行凭证」）。messages 单请求重发语义未变（既有）。 |
| 62 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 实验确认使用当前预览计划 | 5.4、6.2、6.3 | 已交付（6.2/6.3 代码/单测） | 提交判据要求 capability 当前（修订/设置/代次/计划指纹）并带 `expectedPlanFingerprint`；`isolated-prompt-card.test.ts` 核对失效拒绝。 |
| 63 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 返回修改与设置往返撤销旧确认 | 5.4、6.2、6.3、7.3 | 已交付（6.2/6.3 代码 + 7.2/7.3 实机） | 设置快照变化推进检查代次并清空；切字段/收起/卸载释放确认；输入变更修订失效。**7.2 实机**：改配置＝整卡连同许可撤销 / 改输入＝stale 条 + 复位。**7.3 实机**：`ISOLATED_PROMPT_CONFIG_CHANGED`（旧修订提交）与 `ISOLATED_PROMPT_PLAN_CHANGED`（旧指纹提交）都在 main 侧被拒、受理后拒绝有登记且 runIds=[]、零调用零子记录。 |
| 64 | desktop-ui | 隔离 prompt 计划和主动提交严格分流 | 预检无副作用且非法模式拒绝 | 5.1、5.2、5.3、7.3 | 已交付（7.3 实机） | `isolated-prompt-capability.test.ts` strict/只读；`isolated-prompt-fork-ipc.test.ts` 非法模式拒绝；6.2 卡只调只读通道。**7.3 ipcguard 实机 10 案**：缺本次副本授权、授权=false、renderer 伪造 model/dataDir/sourcePath、一次改两字段、旧 epoch ⇒ 受理前拒绝且 `operation` 为 null；空编辑、非根作根、旧配置修订、旧计划指纹 ⇒ 受理后 settled + runIds=[]；全部案零模型调用零子记录，唯一放行的写入来自判重案的一次真实执行。 |
| 65 | desktop-ui | 隔离 prompt 计划和主动提交严格分流 | 去重和单槽覆盖新隔离入口 | 5.1、5.2、5.3、7.3 | 已交付（5.3） | `isolated-prompt-fork-ipc.test.ts`：同 ID 同参 duplicate 不重复执行、异参 conflict、旧 epoch 零登记、单槽 busy 拒绝、reconcile tombstone 永久拒绝；operation 回执含状态/身份。 |
| 66 | desktop-ui | 隔离 prompt 计划和主动提交严格分流 | 响应未知和模型失败只核对可信身份 | 5.1、5.2、5.3、7.3 | 已交付（7.3 实机） | `isolated-prompt-fork-ipc.test.ts` 模型失败身份=真实 meta.id；`fork-entry-closure` 成功/失败均只读登记 ID、不读信封 ID、不清非目标草稿。**7.3 modelfail 实机**：真实上游 503 ⇒ 登记 runIds = 落盘 meta.id = 信封 id 三方一致（`run_mvi67s4h_wwle`），模型调用恰一次（不重试不自动重发）。**7.3 reload 实机**：在飞（9 s 延迟）做 `Page.reload` 并以哨兵自证换文档 ⇒ 按原身份读登记只给真实 run ID 形状、state=running、不报取消；落定后与盘上 meta.id 一致；只读 reconcile 不复活不重复执行。限制：在飞期间身份已在登记而 trace 尚未出现在盘（span 整行落盘形态）⇒ 未知期只能按身份定位。 |
| 67 | desktop-ui | 隔离 prompt 工作区核对根起点与单项干预 | 根定位和核对有明确目标 | 1.2、6.1、6.2、7.2 | 已交付（6.1/6.2 代码 + 7.2 实机） | `isolated-prompt.test.ts` 三态 + `IsolatedPromptEntry` 根入口/分支导航；**7.2 实机**：根概览「修改启动指令」真键盘可达可激活，编辑器页头显示根运行 `run_mvhmwr6f_ia6xbg` 与启动调用 `s_02`，并明说返回原阅读用页签不自动跳转；7.1 根（预算不合规）被如实拒绝且给原因（见 7.2 widths 判据）。 |
| 68 | desktop-ui | 隔离 prompt 工作区核对根起点与单项干预 | 单份确认表达实际条件与未知 | 1.2、6.1、6.2、7.2 | 已交付（6.2 代码 + 7.2 实机） | `isolated-prompt-card.test.ts` 逐条分列；**7.2 实机 K5**：展开「详细边界」后卡内可读到根运行/初始文件/固定工具/基线模型/根参数/本次端点/执行上限/token 预算/计划指纹/副本写入逐行；收起态关键摘要仍在场；计费与历史未知条件明确写「未知」。 |
| 69 | desktop-ui | 隔离 prompt 工作区核对根起点与单项干预 | 修改或配置变化撤销旧许可 | 1.2、6.1、6.2、7.2 | 已交付（6.2 代码 + 7.2 实机两种形态） | `isolated-prompt-card.test.ts` 绑定修订/设置快照/检查代次；**7.2 实机 K6a/K6c**：改运行配置 ⇒ 核对卡连同费用确认与副本授权整体撤销（不留旧许可）；改输入 ⇒ 琥珀 stale 条 + 确认/授权复位，须重新核对才可确认。页签往返同样不恢复执行许可（K4）。 |
| 70 | desktop-ui | 隔离 prompt 草稿和结果沿用提交修订纪律 | 失败和旧结果不清除新草稿 | 6.1、6.3、7.3 | 已交付（6.3 代码/单测 + 7.3 实机，分支分层） | `fork-entry-closure`：隔离 prompt 失败保留草稿与关联；U5 `applyDraftClosure` 只在正常+修订匹配时清；`draft-closure-decision` 模式清理。**7.3 实机**：modelfail ⇒ 失败后正文/假设/判据与修订原样保留、提交关联仍按身份收口、失败 run 可按可信 ID 打开；staledraft ⇒ 实验记录取**提交时冻结快照**（不是迟到改动值）、迟到的正常结果不抢用户当前阅读目标。分层：「提交后产生新修订而旧成功结果迟到」这一支在 GUI **没有前提**（在飞改正文被 store 拒绝、换字段 disabled，且响应与终态同刻）⇒ 由 `fork-entry-closure` / `draft-closure-decision` 单测承载。 |
| 71 | desktop-ui | 隔离 prompt 草稿和结果沿用提交修订纪律 | 往返恢复正文不恢复执行许可 | 6.1、6.3、7.3 | 已交付（6.1/6.3 代码/单测；实机 7.3） | 草稿条目保存原文/假设/判据；确认与副本授权为组件/凭据态，切字段/收起/卸载释放；`debugging-drafts` 模式键隔离。实机 7.3。 |
| 72 | desktop-ui | 比较文件视图保留两侧事实与只读身份 | 两侧检查点独立且迟到结果不串页 | 6.4、6.5、7.2、7.3 | 已交付（7.2 + 7.3 实机） | `compare-file-view.test.ts` 选择 key/stale 独立、manifest/file 双代次守卫、`compare-store` 一侧换点不影响另一侧。**7.2 实机**：两侧默认各取最近自有完成步骤、打开单侧返回后选择保留。**7.3 latecompare 实机**：先量出 big.txt 1.35 MB 正文读取真实在飞时长 68 ms（loading 48 ms 采到），切走→切回后在 55 ms 处换选 ⇒ 旧响应必然迟到；落定后呈现 notes.md（different、逐侧 8 B/28 B 原文），新侧模型不含大文件标记，无 loading 悬挂；只改左侧检查点右侧不被带动；交换两侧后标题方向随 pair 对调（界面无交换入口，按 store 动作承载并如实登记）。 |
| 73 | desktop-ui | 比较文件视图保留两侧事实与只读身份 | 文件差异诚实呈现未验证和不可用 | 6.4、6.5、7.2、7.3 | 已交付（6.4/6.5 代码 + 7.2 实机） | `referenceLabel` 区分清单引用与待核验、`comparedFileSideLabel` 逐侧错误、`textDiffSidesOf` 仅 text/text 或 text+not_found；**7.2 实机 K13**：路径行标注「两侧清单引用不同（内容待核验）」与逐侧字节分列呈现；only-child.txt 缺失侧诚实标注；summary.md 空串不被当作不存在；含 NUL 正文按真实字节呈现。二进制/超限逐侧状态桌面路径不可诱发（`write_file` 只接受字符串 ⇒ 必为合法 UTF-8），由 4.3 单元证据承载。 |
| 74 | desktop-ui | 修复结果连接单侧导出且不自动判定成功 | 比较到导出固定选中侧 | 6.6、7.1、7.2 | 已交付（7.1 package-layer + 7.2 GUI 实机） | 7.1 从根最终/子最终比较结果固定子侧导出并逐字节复核；**7.2 GUI 实机 K15**：在比较文件视图真键盘点「导出右侧检查点」→ 子运行文件页导出入口 → 确认卡 → 真 ENTER 提交，反馈 `exported`；清单 `source.run_id=run_mvhsr8j6_ab0y`、`step_span_id=s_16`（=比较所选右侧检查点）、`initial_snapshot_id`=子初始；6 文件/76 B + `changes.patch` 逐文件 sha256/字节复核一致；目录选择由 `REBASEAGENT_PICK_DIRECTORY_FILE` 控制文件接管恰 1 次且 `dialog[open]` 数为 0（原生框未被打开，记录选择方式）。 |
| 75 | desktop-ui | 修复结果连接单侧导出且不自动判定成功 | 正常结束和输出变化不冒充修复证据 | 6.6、7.1、7.2 | 已交付（6.6 代码 + 7.1 真实模型 + 7.2 实机） | 7.1 子运行正常结束未写成「修复成功」，人工判据由用户确认；**7.2 实机 K11**：结局说明原文「本次运行正常结束。这只说明执行终止事实，不代表改动已达到目的，也不自动标为“已修复”。 请按你填写的人工判据自行核对；界面不会自动执行或评分该判据。」；干预区呈现原值/新值/假设/人工判据（用户填写，不自动评分），长输出折叠呈现且不改页面几何不变式。 |
| 76 | desktop-ui | 隔离指令实验在窄窗和键盘下连续可用 | 真键盘完成实验比较导出闭环 | 1.2、7.1、7.2 | 已交付（7.2 实机真键盘全链） | **7.2 keyboard 批 55 条判据全绿**（`r22-72-keyboard-cdp.cjs` + `gates-keyboard.txt` + `keyboard-measurements.json`）：系统级 `keybd_event` 与真 OS 剪贴板完成「根入口 → 编辑 → 假设/判据 → 往返恢复 → 只读核对 → 撤销/重核对 → 费用确认 → 副本授权 → 提交 → 结果干预区 → 与基线比较 → 比较文件视图逐项换行核对 → 打开单侧并返回（选择保留）→ 导出固定本侧并逐字节复核 → Esc 焦点回收 → 再返回比较 → 数据不变式」。窄档/200% 的可达性由同批 widths/zoom200 承载。 |

## 7.1 真实模型闭环证据（2026-10-21）

- provider：`https://api.deepseek.com` / `deepseek-flash`（key 仅 Electron 主进程内存解密，未写入报告/日志）。
- dataDir：`.workbuddy/r22-71/run-20261021-030856/data`；报告：同目录 `report.md` / `report.json`；导出：`export-child/`。
- 运行：根 `run_mvhj9cq8_1y8519`（5 LLM/4 tools，初始 A → 最终 B+summary，usage 3819/326）；兄弟 `run_mvhj9h3y_72b7`（只读 keep-A，1028/75）；主实验 `run_mvhj9i9c_c22r`（1 read_file → A，最终 config A、无 summary，1260/226）。
- 机器检查 19/19 PASS；源/根 trace/兄弟 trace/既有 blob 指纹不变；单侧导出 3 文件/33B，sha256/清单/来源复核一致。
- 人工判据：**用户已确认通过**（2026-10-21 03:29 UTC）。
- 限制：package-layer 真实模型闭环，不是 Electron GUI；7.2 真实窗口/缩放/键盘已于同日完成（见下节），7.3 失败注入与未知路径仍未做。

## 7.2 实机证据（2026-10-21，三批共 133 条机器判据全绿）

- 探针与驱动：`apps/desktop/scripts/r22-72-geometry-cdp.cjs`（widths / zoom200）、
  `apps/desktop/scripts/r22-72-keyboard-cdp.cjs`（keyboard）；批量驱动 `.workbuddy/r22-72/run-all-720.cjs`
  （每组：备份 settings → 起 dev 带 CDP 9612 与本组 env → 跑探针 → 以「9612 真空出」为停机判据 → 无条件还原
  settings / Preferences）。读数 `*-measurements.json`、日志 `gates-<tag>.txt`、截图 `shots/`。
- 夹具：`apps/desktop/scripts/r22-72-seed.cjs` + `seed.json`——与 `MAIN_EXECUTION_LIMITS` 逐字段一致的隔离根
  `run_mvhmwr6f_ia6xbg`（初始 A → 最终 B+summary，final `s_13`）与 v3 种子子 `run_mvhn8q64_c6ds`（final `s_16`），
  模型为本地受控服务（127.0.0.1:18799）。真键盘批另产出 `run_mvhsr8j6_ab0y`。
- widths **59/59**：实测 CSS 视口 1442 / 1362 / 1024 / 801（外框 2033 / 1920 / 1034 / 810，DPR 2.1），
  逐档：无横溢、高度链锚点→main 贯通且 main `overflow-hidden`、详情列独立滚动只动容器、滚动区底部不露页面灰底、
  核对卡+授权+提交可滚可达、比较文件视图默认检查点与 diff 高度链、config.txt CRLF 逐字进 Monaco；全程数据目录指纹零变化。
- zoom200 **19/19**：DPR 4.2 真 zoom；实测 CSS 923×582（zoom2 外框→CSS ≈÷2.82，故记相对几何不打 ±2px 落点）；
  窄档运行列表收起且「打开运行列表」恢复入口在场；同款几何/diff 判据全绿。
- keyboard **55/55**：系统级 `keybd_event` + 真 OS 剪贴板走完实验→比较→导出全链；逐项换行核对
  （CRLF 两行 + 新增、仅差末尾换行、右侧空串、仅本侧存在、两侧相同、含 NUL 正文）；
  两种撤销旧许可形态（改配置＝整卡撤销 / 改输入＝stale 条）；页签往返恢复正文不恢复许可；
  导出 `exported`：6 文件/76 B + `changes.patch`，清单身份 `run_mvhsr8j6_ab0y`/`s_16`/子初始；
  原生目录框由 `REBASEAGENT_PICK_DIRECTORY_FILE` 控制文件接管恰 1 次且 `dialog[open]`=0；真 Esc 焦点回收到导出入口；
  数据不变式：只新增本次子 run 与其 blob。
- 附带实证（诚实拒绝）：7.1 package-layer 根录制预算 300000 > 桌面上限 100000 ⇒ GUI 预检返回
  `config_unreconstructable` 且不给费用确认/副本授权/提交（不静默截小）——该拒绝本身是「不支持参数或配置漂移不能静默放行」
  的实机证据，也正是本批需要重造合规根的原因。
- 实机不可诱发项（注明测试层）：二进制/超限逐侧状态（`write_file` 只接受字符串 ⇒ 必为合法 UTF-8）由 4.3
  `workspace-compare-api.test.ts` 承载；非法/失效文件目标与 stale 分支由 6.4 单测承载；失败/缺附件/缺父/旧响应注入归 7.3。
- harness 限制（已下沉 `UI-VERIFY.md`）：抬前台与发键须同进程、`ShowWindow`/`SetActiveWindow` 会把窗口打成 occluded、
  Monaco 须 `editor.focus()`、`Get-Clipboard -Raw` 与真实粘贴的换行形态不对称（回读 LF、粘贴 CRLF）。
- 人工判据：**用户确认通过**（2026-10-21）。口径如实记录：认可依据是三批机器判据全绿与抽查结论，**未逐项复核截图/实机**；
  「视觉可读性 / 字号是否偏小」一类主观项仍属未细看 ⇒ 发行前实机验收（路线图 §9.1 第 5 项）需要补，本轮不以此代替。
- 人工复核入口（若要补看）：`shots/r2272-kb-k5-card.png`、`shots/r2272-kb-k13-diff-config.png`、
  `export-keyboard/files/*`，或起 dev 后打开 `run_mvhsr8j6_ab0y` 的概览「本次干预」区。

## 证据收口规则

- 任务 7.4 核对全部行名与 delta 一一对应；新增或改名场景同步本表，保留场景不能因局部改文案丢失回归。
- 所有执行拒绝分别核对 operation 登记、实际子记录、模型/工具调用与文件指纹，不能把 rejected operation 误当子 run。
- 桌面截图不能替代字节/哈希、IPC 或执行计数；mock 不能作为真实模型修复证据。实机未能诱发的存储/乱序故障注明测试层和限制。
- 记录真实模型所有尝试与人工判据结果，不隐藏失败，不把正常结束等同测试通过或修复成立。
- 每批填入命令与 exit code；最后重跑适用门禁并记录最终源码身份，归档和发行分别核对。

## 7.3 实机证据（2026-10-21，8 个 tag / 137 条机器判据全绿）

- 探针：`apps/desktop/scripts/r22-73-reject-cdp.cjs`（entry / attachment / parent / ipcguard）与
  `apps/desktop/scripts/r22-73-exec-cdp.cjs`（modelfail / reload / staledraft / latecompare）；
  机制层 `apps/desktop/scripts/lib/r22-73-harness.cjs`（逐文件指纹、故障句柄施加/还原、页内读数与在飞原语）；
  驱动 `.workbuddy/r22-73/run-all-730.cjs`（一次调用内：备份 settings → 起 dev CDP 9612 → 逐 tag 跑 →
  以「9612 真空出」停机 → 无条件还原）；读数 `<tag>-measurements.json`、逐 tag 实时日志 `<tag>-probe.log`、
  汇总 `gates-<组>.txt`、截图 `shots/`。
- 夹具：`apps/desktop/scripts/r22-73-seed.cjs` + `.workbuddy/r22-73/seed.json`。隔离根
  `run_mvi2ckn3_xfxw46`（final `s_10`、首次 llm.call `s_02`、初始快照 5 个文件含 1 352 000 B 的 big.txt
  与唯一内容 fault.txt）；v3 实验子 `run_mvi2ckpz_f5fy`（final `s_07`，与根同一初始快照）。
  故障目标 blob 由 seed 按清单 sha256 给出，探针不硬编码哈希（重造夹具也不会指错对象）。
  模型为本地受控服务（127.0.0.1:18799）。
- **真实故障与测试注入分列**：缺附件/损坏/缺父＝真实磁盘故障（同卷 rename、追加字节，收尾逐字节 sha256 还原 +
  无 `*.u73-hidden` 残留核验）；模型失败＝真实 HTTP 503（走完整 HTTP 栈，非页内 hook）；
  在飞/响应未知＝受控服务 `delayMs` 真实延迟 + 真 `Page.reload`（带换文档哨兵）；
  非法形状/旧修订/旧指纹＝测试注入（真 IPC 直调，不经 store，读未加工信封）。
- 本批**零新增主进程注入钩子**：既有 `REBASEAGENT_*` 一个都没用上（7.2 用过目录框接管，本批无导出环节）。
- 判据纪律：拒绝类一律同时核对「登记形状 + 模型调用数 + 新增子记录数」三面（受理前拒绝 `operation=null`、
  受理后拒绝 settled + runIds=[] 分列）；每个故障 tag 都配**还原后的成功对照**，防"一律拒绝"式假绿；
  每个 tag 收尾都跑数据不变式，只按本次真实执行的 run id 放行其 trace 与新 blob。
- 实机不可达并按层引用（写明原因，不当已验证）：
  ① 「提交后产生新修订而旧成功结果迟到」——在飞改正文被 store 冻结拒绝、换字段按钮 disabled、
     且响应与终态同刻 ⇒ `fork-entry-closure` / `draft-closure-decision`；
  ② 「篡改/丢弃 IPC 响应」类——`window.api` 属性 non-writable/non-configurable（U4 §6 已记）⇒ §4/6.4 store 用例；
  ③ 二进制/超限逐侧状态——`write_file` 只接受字符串、读取上限与写配额同为 8 MiB ⇒ 4.3；
  ④ 跨运行 selector 失效的 GUI 目标（行 40）⇒ 4.x/6.4。
- 关键读数（可复核）：缺附件原因原文「核对未通过（attachment_missing）：初始列表中的 fault.txt 附件不可用
  （附件不存在：dc2d2e…）——不能从当前源目录重新读取」；损坏原因「attachment_corrupt（清单记录 39 字节，
  实际 56 字节）」；缺父原因「父链 run run_mvi2ckn3_xfxw46 的 trace 文件不存在（不从当前目录或父最终状态补造）」；
  失败案 `run_mvi67s4h_wwle` 模型调用恰一次；重载案在飞登记身份 `run_mvi683he_6508` 与落盘 meta.id 一致；
  迟到核对案在飞 16 ms 内推进修订 ⇒ 只产生失效提示；交错案 big.txt 单读 68 ms、切换于 55 ms ⇒ 旧响应必然迟到。
- 本批在 dev 数据目录新增的真实子 run：最终绿跑 4 条（`run_mvi6okvc_na5a`、`run_mvi67s4h_wwle`、
  `run_mvi683he_6508`、`run_mvi6kryt_civk`）+ 迭代排障遗留 4 条（`run_mvi52ffh_xqjp`、`run_mvi5oas6_ae9o`、
  `run_mvi5ojmy_1cq2`、`run_mvi68jmn_q53w`）；未改动任何既有 trace/blob（各 tag 不变式逐文件核对）。
- 人工判据：人工判据已由用户确认通过（2026-10-21）。口径如实记录：认可依据＝**用户亲手做实机复现的「缺附件拒绝」一条**（现场翻转 blob → 界面给 attachment_missing 拒绝、费用确认/副本授权/提交整块不渲染、forking 仍 idle；留证 `.workbuddy/r22-73/live-repro-attachment.md` + `shots/r2273-live-attachment-missing.png`，还原后 sha256 逐字节一致）+ 其余各 tag 按 137 条判据全绿与核对表抽查认可；**未逐条走 12 项静态核对，也未亲手复现失败案/重载案**；视觉可读性/字号一类主观项仍未细看⇒ 发行前实机验收（路线图 §9.1 第 5 项）另补，本轮不以此代替。
- 复核入口：`.workbuddy/r22-73/人工核对表.md`（12 项静态 + 2 项亲手复现，逐条锚定 delta spec 原文行号）、
  `live-repro-attachment.md` + `shots/r2273-live-attachment-missing.png`（用户亲手复现的此刻读数与截图）、
  `shots/r2273-attachment-restored.png`、各 `<tag>-measurements.json` 的 `dump`（界面原文读数：核对未通过原因、
  父链缺失原因、失败结局、逐侧状态标签），或起 dev 后打开 `run_mvi67s4h_wwle`（失败案）与
  `run_mvi2ckpz_f5fy`（分支案）核对。
