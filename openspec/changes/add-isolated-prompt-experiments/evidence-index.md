# R2.2 场景证据索引

2026-10-19 提案骨架；23 条 requirement、76 条 scenario（含保留的既有场景）。2026-10-21 阶段 2 回填 1–9、27–29；阶段 3 回填 20–31；阶段 4 回填 32–36；阶段 5 增补 5/7/20/23–26/30–31/64–66（部分交付项已写明剩余任务与证据层）。其余待实施。文档/strict 校验不代表功能通过。每行实施后填写测试文件/用例、fixture、实机批次、源码身份及限制；单元注入、mock、真实模型和原生 UI 证据分别标注。

| 序号 | capability | requirement | scenario | 对应任务 | 状态 | 证据与限制 |
|---|---|---|---|---|---|---|
| 1 | trace-format | 格式带版本号 | 未来版本文件 | 1.3、2.2、2.4 | 已交付（2.2） | `packages/trace-sdk/test/reader.test.ts`「未来版本…4」、`version-guard.test.ts`「未来版本 4」、`experiment.test.ts`；desktop `baddata-regression.test.ts`/`run-repository.test.ts`（v4 进 failed）。限制：只证新读取器拒绝；不含旧读取器模拟。 |
| 2 | trace-format | 格式带版本号 | 双版本与旧读取器 | 1.3、2.2、2.4 | 部分（2.2） | 新读取器 v1/v2 回归：`experiment.test.ts`「v1/v2 回归」、既有 reader/workspace-roundtrip 225 用例；普通 writer=v1（agent-loop）、隔离 writer=v2（replay checkpoint tracer 断言）。旧 v1 读取器拒绝 v2 沿用既有版本门禁，本批未新增旧 reader 模拟。 |
| 3 | trace-format | 格式带版本号 | 版本与隔离字段不匹配 | 1.3、2.2、2.4 | 已交付（2.2） | `experiment.test.ts`：v1 workspace/resume_after_step、v2/v3 缺 workspace、v2 私带 prompt_experiment/initial origin、v3 缺 prompt_experiment、v3 已完成 step 缺 workspace_snapshot 均明确拒绝；`version-guard.test.ts` 原 v1/v2 用例保持。 |
| 4 | trace-format | 格式带版本号 | v1 禁字段与其他扩展区分 | 1.3、2.2、2.4 | 已交付（2.2） | `version-guard.test.ts`：v1 workspace/resume_after_step/workspace_snapshot 存在性判定（含 null/false/空对象）；新增 prompt_experiment 禁字段；无关扩展字段仍放行（不递归、不 strict）。 |
| 5 | trace-format | 格式带版本号 | 三版本读取与写入职责分离 | 1.3、2.2、2.4 | 已交付（2.4/3.4/5.4） | v1 普通 writer（agent-loop 104 用例）、v2 隔离 writer（checkpoint tracer 断言）、v3 实验 writer（`isolated-prompt-run.test.ts` + `isolated-prompt-fork-ipc.test.ts` 真实落盘）；v3 卡带产出 v1。旧读取器模拟未新增（沿用既有版本门禁）。 |
| 7 | trace-format | 隔离 prompt 实验记录初始来源与有效配置 | 初始来源与干预记录往返 | 2.1、2.3、3.3、5.1 | 部分（包/main 已证；桌面展示 6.x） | schema/parse 往返（`experiment.test.ts`）；真实 v3 writer 的 meta/experiment 往返与详情 IPC schema（`ipc-v3-roundtrip.test.ts`、`isolated-prompt-run.test.ts`）；桌面核对卡展示归 6.2。真实首次请求一致性在 3.4 mock 断言，真实模型归 7.1。 |
| 6 | trace-format | 格式带版本号 | 新实验字段不能藏在旧版本中 | 1.3、2.2、2.4 | 已交付（2.2） | `experiment.test.ts`「v3 版本守卫」：v1/v2 顶层 prompt_experiment=null/{} 在 strip 前拒绝；消息正文同名业务字段不递归拦截（沿用 version-guard 既有判据）。 |
| 7 | trace-format | 隔离 prompt 实验记录初始来源与有效配置 | 初始来源与干预记录往返 | 2.1、2.3、3.3、5.1 | 部分（2.1/2.2） | `experiment.test.ts`：origin=initial、baseline/original_value/execution（含 params 缺省 vs {}）/假设/判据经 schema 与 parseRunText 完整往返；v3 子 world_id=自身 ID。真实首次请求与有效配置相符归 3.4 + 7.1。 |
| 8 | trace-format | 隔离 prompt 实验记录初始来源与有效配置 | 矛盾的实验来源拒绝 | 2.1、2.3、3.3、5.1 | 已交付（2.1/2.3） | `experiment.test.ts`：缺 prompt_experiment、resume_after_step、model_params 编辑、parent/origin/baseline/span/snapshot ID 矛盾均拒绝；`findExperimentSourceViolation` 拒绝非根父、at_span≠父首次 llm.call、original_value 不符。完整来源读取依赖父可读；自有缺父仍可读。 |
| 9 | trace-format | 隔离 prompt 实验记录初始来源与有效配置 | 缺父或附件不阻止自有轨迹阅读 | 2.1、2.3、3.3、5.1 | 部分（trace 层已证） | `experiment.test.ts`「v3 自有文件可独立读取」：父文件缺失时 parseRunText 仍通过；trace-sdk reader 不读附件。附件可用性门槛与桌面导出归 3.x/5.x/7.x 实测。 |
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
| 20 | prompt-replay | 隔离 prompt 预检配对根启动输入与初始文件 | 合法根预检只读且提交重验 | 3.1、3.3、5.2、7.3 | 已交付（包/main 5.1–5.3；桌面 UI 6.x） | `isolated-prompt-preflight.test.ts`：预检前后目录指纹一致、重复预检稳定、删附件后重验失败；`isolated-prompt-run.test.ts` 提交重跑预检；`isolated-prompt-capability.test.ts` 端点只读且 strict；`isolated-prompt-fork-ipc.test.ts` 配置修订/计划漂移/附件缺失时 settled/rejected、零子记录。桌面确认卡 UI 归 6.2。 |
| 21 | prompt-replay | 隔离 prompt 预检配对根启动输入与初始文件 | 中途分支只能显式返回根 | 3.1、3.3、5.2、7.3 | 部分（包层已证；桌面导航 6.1） | `isolated-prompt-preflight.test.ts`：中途 result 分支返回 `parent_not_root` + 完整父链验证的 rootId，失败对象无计划/指纹；缺祖先返回 `parent_chain_invalid` 且无 rootId。桌面"前往根运行"显式导航与重新预检归 6.1。 |
| 22 | prompt-replay | 隔离 prompt 预检配对根启动输入与初始文件 | 缺失或不可还原的启动条件拒绝 | 3.1、3.3、5.2、7.3 | 已交付（包层 3.1–3.3） | `isolated-prompt-preflight.test.ts`：缺根/缺祖先/未封存/v1 根/缺 user/首调用非第 1 步/空编辑/组合编辑/超长假设/工具表与 config_hash 漂移/结构化 params/预算不可接受/配额超限/附件缺失/损坏均返回稳定码；`isolated-prompt-state.test.ts` 覆盖消息形状矩阵。 |
| 23 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 单项改动与首次实际请求一致 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 部分（包/main mock 已证；真实模型 7.1） | `isolated-prompt-run.test.ts`：首次请求只改目标 content、模型/params 取根录制值、第 1 步读 A；`isolated-prompt-fork-ipc.test.ts` main 端点实际走同一包层。真实模型/服务端条件与人类判据归 7.1。 |
| 24 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 不支持参数或配置漂移不能静默放行 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 已交付（3.2/3.3/5.2） | `isolated-prompt-state.test.ts` params 矩阵；`isolated-prompt-preflight.test.ts` profile/config_hash/预算；`execution-config-state.test.ts` 换 key/端点/清除重配轮换；`isolated-prompt-fork-ipc.test.ts` 旧修订/计划漂移拒绝且零执行。 |
| 25 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 历史未知条件与真实计费分别表达 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 部分（包/main capability 已证；UI 6.2） | capability IPC 返回 `historicalUnknowns` 与 `billing`（`isolated-prompt-capability.test.ts`）；桌面核对卡文案与真实 usage 呈现归 6.2/7.1。 |
| 26 | prompt-replay | 隔离 prompt 固定可恢复配置并从头真实执行 | 当前写入授权和失败事实不可替代 | 1.1、3.2、3.3、3.4、3.5、5.2、7.1 | 已交付（3.4/3.5/5.2/5.3） | `isolated-prompt-run.test.ts` 未授权/模型失败/存储故障；`isolated-prompt-fork-ipc.test.ts` allowFileWrites 必须 true、拒绝时 runIds=[]、模型失败身份=真实 id。 |
| 27 | replay | 隔离 prompt 构成独立执行边界且可继续 result 续跑 | v3 详情只呈现自有完整步骤 | 2.3、2.4、5.4 | 部分（包层已证；桌面详情 5.4） | `experiment.test.ts` + `isolated-prompt-run.test.ts`：v3 叶子解析只返回自有 spans，chain 仅根→v3 溯源；span id 跨 run 可重复，按 owner/消息内容区分。desktop 详情 `spanScope/chain` 投影归 5.4。 |
| 28 | replay | 隔离 prompt 构成独立执行边界且可继续 result 续跑 | v3 后的 result 分支保留正确前缀 | 2.3、2.4、5.4 | 已交付（包层 2.3/3.6） | `isolated-prompt-run.test.ts` 端到端：真实 v3 父 + `replayIsolatedRun` 子仍写 v2、checkpoint origin/resume_after_step 正确；`resolveBranch` 前缀只含 v3 第 1 轮整轮（step+llm+tool），第 2 轮与实验根不进入，按首轮消息内容证明来源是 v3。 |
| 29 | replay | 隔离 prompt 构成独立执行边界且可继续 result 续跑 | 新版本不扩大普通执行和卡带权限 | 2.3、2.4、5.4 | 部分（包层已证；桌面门禁 5.4） | `trace-test` v3 卡带基线可读可跑且产出 v1；`isolated-prompt-run.test.ts`：v3 父本经 `promptReplayRun` 明确拒绝、零 outDir/零调用；隔离模型实验沿用 workspace 门禁（`isolated-entry-guard.test.ts` 全绿）。桌面普通/模型入口的 v3 拒绝实机归 5.4/7.3。 |
| 30 | workspace-isolation | 初始快照实验创建独立文件映射 | 根初始状态与父最终及源目录分离 | 1.1、3.4、7.1 | 部分（包/main mock 已证；真实模型 7.1） | `isolated-prompt-run.test.ts`：v3 首轮读 A（≠B≠C），父/兄弟/源/blob 指纹不变；`isolated-prompt-fork-ipc.test.ts`：v3 文件页 origin=initial、读到 A，导出来源固定初始快照。真实模型闭环/导出字节复核归 7.1。 |
| 31 | workspace-isolation | 初始快照实验创建独立文件映射 | 空初始世界与后续超限遵守原配额 | 1.1、3.4、7.1 | 已交付（3.4） | `isolated-prompt-run.test.ts`：空 initial_snapshot 从头执行并写入；8 MiB+1 写入成为工具错误、检查点保持空、loop 继续；未回写父/源。 |
| 32 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 两个自有检查点独立选择与路径并集 | 4.1、4.2、4.3、5.1、6.5 | 部分（包层 4.1；桌面 6.5） | `workspace-compare-api.test.ts`：不同根/同 run 初始 vs 完成步骤各自冻结；路径 UTF-16 并集（仅左/仅右/双方）；同 run 两 selector 注入读取器计数=1；共同祖先下两侧 initialSnapshotId 可不同；身份不符/祖先步骤/v1 无 workspace 逐侧失败且 unionComplete=false。IPC/桌面双列表/路径并集呈现归 5.1/6.5。 |
| 33 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 未核验引用不冒充字节相同 | 4.1、4.2、4.3、5.1、6.5 | 已交付（包层 4.1/4.2） | 清单层只给 `reference=same/different`，不读字节；`readComparedWorkspaceFile` 才逐侧 `readVerified` 并给结论。测试：列表 same 后删除共享 blob → 读取双侧 missing、结论 unavailable；损坏→corrupt、注入 I/O→io。 |
| 34 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 文本新增删除与原换行可核对 | 4.1、4.2、4.3、5.1、6.5、7.2 | 部分（包层已证；UI diff 6.5/7.2） | `workspace-compare-api.test.ts`：CRLF vs LF 原文逐字节保留；空串仅左→left_only；仅右→right_only；相同→same；两侧不存在→not_found；`textDiffEligible` 仅 text/text 或 text+not_found。Monaco diff、滚动/焦点与 200% 缩放归 6.5/7.2。 |
| 35 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 二进制和读取错误保留逐侧状态 | 4.1、4.2、4.3、5.1、6.5 | 已交付（包层 4.2/4.3） | `workspace-compare-api.test.ts`：二进制返回原始字节、仅 same/different、不生成文本结论；corrupt/io/too_large 逐侧状态，另一侧仍可读；缺失/损坏不当 not_found。桌面逐侧展示归 6.5。 |
| 36 | workspace-isolation | 跨运行检查点比较只读取明确的自有快照 | 选择快照变化不能拼出混合差异 | 4.1、4.2、4.3、5.1、6.5 | 部分（包层已证；桌面请求代次 6.5） | `workspace-compare-api.test.ts`：列表后替换同 id run 记录，旧 expectedSnapshotIds 读取→该侧 selection_changed 且无正文，另一侧仍可读、整体 unavailable。桌面 selector/path/请求代次丢弃旧反馈归 6.5。 |
| 37 | desktop-ui | 调试台提供启动 prompt 的单变量编辑入口 | 编辑前确认真实计费 | 6.1、6.2、5.4 | 待实施 | — |
| 38 | desktop-ui | 调试台提供启动 prompt 的单变量编辑入口 | system prompt 不可还原 | 6.1、6.2、5.4 | 待实施 | — |
| 39 | desktop-ui | 比较文件入口保持单运行合法检查点 | 分别打开文件并返回比较 | 6.4、6.6、7.2 | 待实施 | — |
| 40 | desktop-ui | 比较文件入口保持单运行合法检查点 | 非法文件目标与普通运行不造历史 | 6.4、6.6、7.2 | 待实施 | — |
| 41 | desktop-ui | 隔离执行边界在操作前可辨认 | 多工具轮次确认 | 5.2、5.4、6.2、7.3 | 待实施 | — |
| 42 | desktop-ui | 隔离执行边界在操作前可辨认 | 二次分叉轮号不沿链累加 | 5.2、5.4、6.2、7.3 | 待实施 | — |
| 43 | desktop-ui | 隔离执行边界在操作前可辨认 | 历史运行和缺附件降级 | 5.2、5.4、6.2、7.3 | 待实施 | — |
| 44 | desktop-ui | 隔离执行边界在操作前可辨认 | 隔离父本的其他真执行入口 | 5.2、5.4、6.2、7.3 | 待实施 | — |
| 45 | desktop-ui | 隔离执行边界在操作前可辨认 | 每次桌面操作独立确认写入 | 5.2、5.4、6.2、7.3 | 待实施 | — |
| 46 | desktop-ui | 隔离执行边界在操作前可辨认 | 创建与确认在窄窗口可操作 | 5.2、5.4、6.2、7.3 | 待实施 | — |
| 47 | desktop-ui | 运行工作区按阅读任务组织 | 首次打开与无运行入口 | 1.2、5.4、6.1、7.2 | 待实施 | — |
| 48 | desktop-ui | 运行工作区按阅读任务组织 | 文件承载区不附带步骤目录 | 1.2、5.4、6.1、7.2 | 待实施 | — |
| 49 | desktop-ui | 运行工作区按阅读任务组织 | 旧创建设置及执行入口保持可达 | 1.2、5.4、6.1、7.2 | 待实施 | — |
| 50 | desktop-ui | 运行工作区按阅读任务组织 | 阅读过程不修改已有数据 | 1.2、5.4、6.1、7.2 | 待实施 | — |
| 51 | desktop-ui | 草稿恢复不恢复执行许可 | 隔离编辑恢复后重新预检授权 | 5.4、6.1、6.3、7.3 | 待实施 | — |
| 52 | desktop-ui | 草稿恢复不恢复执行许可 | sourceToken 在有效期内恢复但授权复位 | 5.4、6.1、6.3、7.3 | 待实施 | — |
| 53 | desktop-ui | 草稿恢复不恢复执行许可 | sourceToken 失效不清空任务 | 5.4、6.1、6.3、7.3 | 待实施 | — |
| 54 | desktop-ui | 草稿恢复不恢复执行许可 | 取消目录选择保留原引用 | 5.4、6.1、6.3、7.3 | 待实施 | — |
| 55 | desktop-ui | 草稿恢复不恢复执行许可 | 迟到检查不覆盖草稿 | 5.4、6.1、6.3、7.3 | 待实施 | — |
| 56 | desktop-ui | 草稿恢复不恢复执行许可 | 设置凭据与调试草稿分离 | 5.4、6.1、6.3、7.3 | 待实施 | — |
| 57 | desktop-ui | 草稿交互保持既有执行和数据边界 | 草稿操作零执行且已有文件不变 | 5.4、6.1、6.3 | 待实施 | — |
| 58 | desktop-ui | 草稿交互保持既有执行和数据边界 | 原有执行入口和文件阅读继续可用 | 5.4、6.1、6.3 | 待实施 | — |
| 59 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 创建和普通重跑只声明已完成的检查 | 5.4、6.2、6.3 | 待实施 | — |
| 60 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 普通结果与隔离结果确认边界不同 | 5.4、6.2、6.3 | 待实施 | — |
| 61 | desktop-ui | 执行前检查和确认保持各入口真实语义 | prompt 与 messages 不冒充续跑完整世界 | 5.4、6.2、6.3 | 待实施 | — |
| 62 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 实验确认使用当前预览计划 | 5.4、6.2、6.3 | 待实施 | — |
| 63 | desktop-ui | 执行前检查和确认保持各入口真实语义 | 返回修改与设置往返撤销旧确认 | 5.4、6.2、6.3 | 待实施 | — |
| 64 | desktop-ui | 隔离 prompt 计划和主动提交严格分流 | 预检无副作用且非法模式拒绝 | 5.1、5.2、5.3、7.3 | 部分（main/包 5.1–5.3；UI 6.2） | `isolated-prompt-capability.test.ts`：capability 只读、strict 拒绝额外 config/授权/物理字段；`isolated-prompt-fork-ipc.test.ts`：缺 mode/allowFileWrites=false/额外 config shape 拒绝、旧修订/计划漂移/非根零执行。桌面确认卡与错误展示归 6.2。 |
| 65 | desktop-ui | 隔离 prompt 计划和主动提交严格分流 | 去重和单槽覆盖新隔离入口 | 5.1、5.2、5.3、7.3 | 已交付（5.3） | `isolated-prompt-fork-ipc.test.ts`：同 ID 同参 duplicate 不重复执行、异参 conflict、旧 epoch 零登记、单槽 busy 拒绝、reconcile tombstone 永久拒绝；operation 回执含状态/身份。 |
| 66 | desktop-ui | 隔离 prompt 计划和主动提交严格分流 | 响应未知和模型失败只核对可信身份 | 5.1、5.2、5.3、7.3 | 部分（main/包 5.3；UI 6.3） | `isolated-prompt-fork-ipc.test.ts`：模型失败 v3 errored 落盘、操作身份=真实 meta.id、runIds 保留；reconcile 后提交被拒。renderer 重载/迟到响应核对归 6.3。 |
| 67 | desktop-ui | 隔离 prompt 工作区核对根起点与单项干预 | 根定位和核对有明确目标 | 1.2、6.1、6.2、7.2 | 待实施 | — |
| 68 | desktop-ui | 隔离 prompt 工作区核对根起点与单项干预 | 单份确认表达实际条件与未知 | 1.2、6.1、6.2、7.2 | 待实施 | — |
| 69 | desktop-ui | 隔离 prompt 工作区核对根起点与单项干预 | 修改或配置变化撤销旧许可 | 1.2、6.1、6.2、7.2 | 待实施 | — |
| 70 | desktop-ui | 隔离 prompt 草稿和结果沿用提交修订纪律 | 失败和旧结果不清除新草稿 | 6.1、6.3、7.3 | 待实施 | — |
| 71 | desktop-ui | 隔离 prompt 草稿和结果沿用提交修订纪律 | 往返恢复正文不恢复执行许可 | 6.1、6.3、7.3 | 待实施 | — |
| 72 | desktop-ui | 比较文件视图保留两侧事实与只读身份 | 两侧检查点独立且迟到结果不串页 | 6.4、6.5、7.2、7.3 | 待实施 | — |
| 73 | desktop-ui | 比较文件视图保留两侧事实与只读身份 | 文件差异诚实呈现未验证和不可用 | 6.4、6.5、7.2、7.3 | 待实施 | — |
| 74 | desktop-ui | 修复结果连接单侧导出且不自动判定成功 | 比较到导出固定选中侧 | 6.6、7.1、7.2 | 待实施 | — |
| 75 | desktop-ui | 修复结果连接单侧导出且不自动判定成功 | 正常结束和输出变化不冒充修复证据 | 6.6、7.1、7.2 | 待实施 | — |
| 76 | desktop-ui | 隔离指令实验在窄窗和键盘下连续可用 | 真键盘完成实验比较导出闭环 | 1.2、7.1、7.2 | 待实施 | — |

## 证据收口规则

- 任务 7.4 核对全部行名与 delta 一一对应；新增或改名场景同步本表，保留场景不能因局部改文案丢失回归。
- 所有执行拒绝分别核对 operation 登记、实际子记录、模型/工具调用与文件指纹，不能把 rejected operation 误当子 run。
- 桌面截图不能替代字节/哈希、IPC 或执行计数；mock 不能作为真实模型修复证据。实机未能诱发的存储/乱序故障注明测试层和限制。
- 记录真实模型所有尝试与人工判据结果，不隐藏失败，不把正常结束等同测试通过或修复成立。
- 每批填入命令与 exit code；最后重跑适用门禁并记录最终源码身份，归档和发行分别核对。
