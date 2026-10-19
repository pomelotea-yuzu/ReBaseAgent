# R2.2 设计：隔离 prompt 修复实验

## Context

核对基线 `a833269`。`promptReplayRun` 经 `loadForkParent` 拒绝 workspace；`runPromptFork` 目前经 `buildForkConfig` 附加普通宿主文件 handler，不能用于新隔离路径。`preflightIsolatedReplay`/`replayIsolatedRun` 只支持 result 整轮续跑。`WorkspaceOriginSchema` 只有 import/checkpoint，v2 分支强制 resume_after_step，无法表达从初始快照启动。`FORMAT_VERSION=2` 目前兼作最高读取版本和多处隔离判据，升版必须审计所有消费方。`compare-files.ts` 和主 spec 目前明确禁止跨运行文件 diff；本提案显式修改该契约。

复用 `createWorkspaceWorld`、blob 校验、固定 profile、checkpoint tracer、run identity observer、U4/U5/U6 和 R2.1。保留拆分后的单 store、依赖方向及连接层职责，不把新增流程重新堆回 store.ts/DetailPanel/WorkspaceFileView。

## Goals / Non-goals

交付一个根基线、一项启动指令、一条新隔离运行的完整桌面流程，并能核对输出、文件、消耗与导出来源。范围以 proposal 的 Non-goals 为准。普通 prompt 连续 fork、普通模型实验、代理单请求与 result 续跑继续使用各自原契约。

## Decisions

### D1. 基线资格与只读预检

新增 `preflightIsolatedPromptReplay({dataDir,parentId,edit,config})`，不写文件、不分配运行身份、不登记 operation、不占槽、不调用网络。返回可执行条件或稳定失败码；桌面外层错误沿用统一信封。

按如下顺序校验：严格请求形状/安全 run ID → 完整来源与已封存 → 隔离根（parent/fork null，origin import）→ 自有首次 LLM 请求 → 完整可执行 messages → 固定工具定义与 profile → 原 system+工具的 config_hash → 编辑 → 模型/参数可重建 → 初始清单 ID/路径/配额 → 全部附件长度/SHA-256。不接受外部传入的快照对象或 handler。profile 使用逐字段校验，不能仅比较工具名。第一轮请求须位于自有第 1 步；首版消息仅允许 role=system/user、字符串 content 及可选字符串 name，至少各一条，不接受历史 assistant/tool、tool_calls/tool_call_id、多模态或其他未知字段，不静默 strip。多条合法 system/user 的非目标消息原样保留。

所有按 run ID 读取都必须核对请求/文件名 ID 与 meta.id 一致，不因文件可解析就认可身份。失败码至少区分 `invalid_request`、`parent_not_root`、`parent_chain_invalid`、`parent_not_forkable`、`parent_not_isolated`、`startup_unavailable`、`profile_mismatch`、`source_changed`、`invalid_edit`、`empty_edit`、`config_unreconstructable`、`attachment_missing`、`attachment_corrupt`、`storage_io`。不把 I/O 错误伪装成不存在。缺历史输入/快照提示重新创建隔离根采集，不从当前目录补齐。

对中途 result 分支或新 v3 分支，预检最多返回经完整父链验证的 rootId 作为导航建议，仍 `parent_not_root`；不得顺便把 rootId 当作已授权目标。用户显式打开根、检查初始输入和文件后再编辑/核对。缺父链或成环时不猜根。源分支与根各自草稿隔离，不自动搬运编辑值。

上述“至少各一条 system/user”只约束新增隔离路径。普通 `derivePromptForkState` 保持既有行为：有字符串 system、缺 user 时仍可改 system，只拒绝 user_message 编辑；不得复用隔离校验顺便收紧普通入口。

### D2. 一项编辑与执行条件

edit 为严格联合 `{field:"system_prompt"|"user_message",value:string}`。只改首条对应字符串消息的 content，按原始字符串相等拒绝空编辑；不 trim、不序列化结构化内容，允许实际改变后的空串。system 编辑同时改变有效 config.systemPrompt 与启动消息，user 编辑保持 system；新 config_hash 按有效 system+固定工具表计算。其余消息的顺序、role 和允许字段逐项一致。

模型固定为根首次 request.model，params 必须无损恢复为当前客户端支持的标量表：保留缺省与显式空对象的区别，保留字符串/数值/布尔值；嵌套对象、保留键、非法数值等拒绝，不能经 `scalarParams`/sanitizeParams 静默删项。本入口不允许模型或参数编辑，桌面 settings.model 不能覆盖基线模型。使用当前已配置端点与 key，提交前显示端点与基线模型；若历史未记录 provider/服务端版本，显示“历史服务端条件未知”，不声称严格因果实验。

根 meta 已录制 token budget 时复用该值；缺省时显示历史预算未知并使用 main 的既有预算。maxIterations 当前未录制，显示历史上限未知并使用 main 既有限制。历史预算若不能被当前策略接受则明确拒绝，不静默截小后声称条件相同。有效 messages、tool profile/定义、model、params、端点和本次实际限制共同生成只读计划。计划指纹采用递归对象键 UTF-16 序、数组原序的规范 JSON（缺省键省略，显式空对象保留），SHA-256 覆盖基线身份/首次请求/初始 snapshot ID、编辑和上述非密钥有效配置。端点记录仅保留去除 userinfo/query/fragment 的 origin+pathname；URL 中额外凭据不得进入记录。

capability 同时返回非密钥 `configRevision`，正式提交必须携带 `expectedConfigRevision` 并由 main 比对当前值。该值是 main 会话内、不从 secret 派生的配置修订标识，真实端点（包括被隐藏部分）、凭据或执行限制变化均轮换；不写 trace/operation、不作为可重用授权。main 重启由 U4 epoch 处理。公开指纹不能替代此修订核对；相同安全端点/不同 key 也必须拒绝旧确认。包 API 不管理桌面修订，使用调用方显式提供且已冻结的有效 config。

修订的唯一拥有者为 main 装配一次、注入配置端点/预检/执行端点的 `ExecutionConfigState`（拟新增），不在各 handler 或 SettingsStore 中另设计数器。其统一刷新入口读取 SettingsStore 当前解密配置和本次执行限制，以 main 内存中的实际值比较，变化才轮换不透明修订；原值和密钥不离开 main，也不以 secret 哈希构造修订。`config-endpoints.ts` 的运行设置保存/清除在成功写入后、响应前同步调用此刷新入口；预检和正式提交取配置时也调用同一入口，捕获两次读取之间可见的磁盘/解密结果变化。相同有效值重复保存或只读核对不轮换；失败写入若实际改变了后续可读状态，由下一次刷新识别，不凭失败响应认定仍是旧配置。代理设置只有实际改变运行配置时才影响此修订。当前执行限制为 main 代码常量，启动时纳入快照；本阶段不新增限制设置项，未来若出现可变写入入口也必须接同一拥有者。

修改正文、基线、设置、凭据修订或可见来源事实使旧计划/费用确认/副本授权失效；只读重复预检内容未变不撤销输入。正式提交重新读取并核对计划，漂移返回 `source_changed` 或 `config_changed`，需要用户重新确认，不能自动升级旧许可。预检结果不是执行凭证。

### D3. trace v3 与兼容策略

新增 v3 **只用于本次隔离 prompt 实验**，不用 v2 塞入新 origin，也不修改既有文件。最高读取版本为 3；显式区分普通写入版本 1、既有隔离写入版本 2 和实验写入版本 3，不让 `FORMAT_VERSION` 增加导致普通/隔离根/result writer 自动升版。能力判据使用已校验 workspace 与明确版本集合，审计 `=== FORMAT_VERSION` 等全部消费方。

v3 meta 的固定形状：

```text
format_version: 3
parent: <选定根 run ID>
fork: {at_span:<根自有首次 llm.call>,edit:{field,value}}  // 无 resume_after_step
workspace: {
  profile:"file-tools-v1",world_id:<新 run ID>,write_authorized:true,
  initial_snapshot:<经核验的根 initial_snapshot 完整清单>,
  origin:{kind:"initial",run_id:<直接父/根 ID>,snapshot_id:<初始清单 ID>}
}
prompt_experiment: {
  baseline_run_id,baseline_llm_span_id,initial_snapshot_id,
  original_value,
  execution:{model,params?,provider_endpoint,max_iterations,budget,config_fingerprint},
  hypothesis?,acceptance_criterion?
}
```

`fork.edit` 保存字段/新值，`original_value` 保存原始字符串；hypothesis/acceptance_criterion 是用户可选的假设/人工判据，各不超过 4000 字符，随本次提交落盘，不自动执行判据。execution 不含 key、sourceToken、授权票据或源绝对路径。首次实际请求与记录的 model/params/messages/tools 逐项核对，指纹可从记录和本次有效限制复算；config_hash 仍只表达 system+工具，不能冒充完整执行指纹。尚未有首次调用的失败记录以已落盘 meta 为事实，不补造调用。

v3 的 origin.run_id、parent、baseline_run_id 一致，snapshot_id/initial_snapshot.id/initial_snapshot_id 一致，fork.at_span 与 baseline_llm_span_id 一致，edit 仅两个 prompt 字段，禁止 resume_after_step；读取阶段可做本行自洽校验，完整来源读取再核对父确为根、首次调用/原值/原始快照对应。JSONL 自有读取不为解析而强求父文件存在，保留 U6 ownOnly；缺附件也不阻止轨迹阅读。完整 agent.step 继续带轮末 snapshot。

新字段必须在 schema strip 前守卫：v1/v2 顶层 prompt_experiment 或 initial origin 均拒绝，即使值为 null；v3 缺必需字段、矛盾关系或更高版本明确失败。消息/工具业务正文中的同名键不递归拦截。旧 reader 由版本号拒绝 v3。BaseTracer/MemoryTracer/JSONL/reader/RunRecord/RunDetail/preload 的版本校验及字段透传一起更新。

### D4. 独立编排与后续 result 语义

新增 `promptReplayIsolatedRun`，只收 dataDir/根 ID/edit/config/当前 allowFileWrites 及测试 LLM/身份观察者，不接受普通 handlers、物理源路径或 caller 快照。提交时重验 D1/D2 与当前授权，再从已核验初始清单创建全新 world、固定文件工具、v3 checkpoint tracer，从第 1 步调用 runLoop。父记录仅作溯源，不拼接父 spans，不把父最终快照或当前源目录作为起点。agent-loop 无需新增文件模式。

子运行 meta 写出后、首次模型调用前恰一次 onRunIdentified；零子记录拒绝不通知身份。观察者异常不改变执行；模型错误按 llm.call.error 与 errored 收尾；trace/存储故障保留已落盘事实，不伪造成功终止，只清理本次未发布临时资源。已经发布的共享 blob 和未封存 trace 不删除。

v3 是完整独立执行边界，resolveBranch/详情读取在此不继承父 spans。已有 result 续跑可接受已封存的 v3 父本，仍取该父本自有轮末快照、逐项核验有效 system/profile/config_hash，子 run **继续写 v2 result 格式**；解析此后代时仅继承 v3 自身对应整轮前缀，不跨 v3 拼入实验根。普通 replay/prompt 入口仍拒绝 workspace，隔离模型实验仍拒绝 v2/v3。trace-test 若读取 v3 仍是卡带/桩工具，不能恢复文件执行。删除有子分支保护、自己的文件检查点与 R2.1 导出均须识别新版本。

### D5. IPC / main / 操作纪律

扩展 `runs:promptFork` 的请求为可区分的普通/隔离分支：普通载荷保持兼容；隔离需 `executionMode:"isolated"`、`parentRunId`、严格 edit、`expectedPlanFingerprint`、`expectedConfigRevision`、当前 `allowFileWrites:true` 和可选假设/判据。包层 config 由 main 重建，renderer 不传模型、handler、dataDir、blob/source/目标物理路径。新增只读 `runs:isolatedPromptCapability` 接收根 ID/edit/可选说明，读取当前配置后返回 D1/D2 的诊断/计划与 configRevision；不返回 key 或物理附件地址。

mode 必须与已核实父本 workspace 一致；缺 mode 的隔离请求、对普通 run 伪造隔离 mode、额外配置键均拒绝，不能降级进 `buildForkConfig`。模型与参数取根请求，端点/密钥/执行限制由 main 当前设置管理。预检与正式提交不复用不受约束的普通 handler 构建函数。

主动提交沿用 kind=promptFork 的 ExecutedRequest/回执。先 U4 epoch/ID/参数绑定/判重/单槽，再来源和计划重验、当前授权、包层执行；被接受但业务拒绝的操作 settled/rejected、runIds=[]，不与“零子记录”混淆。重复同 ID 不再执行，异参拒绝；旧 epoch/未知响应进入 reconcile，仅只读核对。真身份由回调登记；失败后仍按可信 ID 读取自有终止事实。ownOnly 不能执行，但自有轨迹/文件仍按既有只读规则读取。

### D6. 跨运行检查点比较

新增包层 `compareWorkspaceSnapshots({dataDir,left:{runId,stepSpanId?},right:{runId,stepSpanId?}})` 与 `readComparedWorkspaceFile({...selectors,path,expectedSnapshotIds})`。两侧分别用自有记录定位初始或已落盘完成步骤，冻结本次清单；同 run 只读取一次记录。不要求同根或步骤号相等，也不把共同祖先等同于相同初始状态。桌面核对每侧来源完整性并单列 ownOnly；包接口仅保证各侧快照事实。祖先步骤/非法请求返回对应侧失败，另一侧仍可阅读，不能替换成默认检查点。

默认值按层区分：包 API 缺省 stepSpanId 永远指初始快照；桌面首次打开“最近自有完成步骤，无则初始”必须先在已校验详情中解析为显式检查点选择，完成步骤传其实际 stepSpanId，仅选择初始时省略该字段。IPC/包 API 注释分别写明本层语义，桌面不能通过省略 stepSpanId 请求“最近一步”，也不能在所选步骤失效后自动回落到包层初始缺省。

比较清单返回两侧 run/step/snapshot ID、initial_snapshot ID 及各自成功/拒绝状态；每侧请求 ID 须与实际 meta.id 一致，不符返回该侧身份错误，不能标为选中的 run。两侧均有合法清单时按路径 UTF-16 序并集列出“仅左/仅右/双方存在”。哈希/大小相同只能先显示“清单引用相同，内容待核验”；不同只能显示“清单引用不同”，不能据此伪造可读内容。读取所选 path 后逐侧验证字节：text/binary/not_found/missing/corrupt/io 独立，not_found 仅由合法清单证明。两侧已校验字节才可给出相同/修改/新增/删除结论；二进制只显示哈希/大小与是否相同，不生成文本 diff。单侧清单不可用时路径并集不完整，不能把不可用侧当不存在。

仅 text/text、或 text 与经合法清单证明 not_found 的组合生成只读 Monaco diff；保留 CRLF/LF、空串、末尾换行差异。文本查看沿用现有文件大小/编辑器限制，超限给出原因与单侧阅读入口，不输出假无差异。列表不预读全部文件正文；点击路径再读验证。snapshot ID 若与提交 selector 冻结值不同，返回 `selection_changed`，等待显式刷新，不串用旧清单新正文。相同内容对象可内部复用核验，但两侧状态/身份不合并。

比较不写 trace/blob，不登记 operation/占槽/消费授权，不调用模型/工具。文件 diff 无补丁导出接口；“导出左/右”先定位该侧单运行文件页，显示并固定自有检查点，再走 R2.1 原确认/原生目录选择/写入前重验。导出补丁仍相对**该 run 初始快照**，不相对比较另一侧。

### D7. 桌面交互与结果解释

沿用已整理的对象身份、返回目的地和会话活动入口。隔离根概览/启动输入详情进入现有 prompt 工作区，标“修改启动指令，从初始文件重跑”；分支入口显示“前往根运行查看启动指令”，显式导航后重新选目标。核对面板列根 ID/启动请求、初始文件、固定工具、基线模型/参数、当前端点与未知历史条件、编辑 diff、执行上限、真实计费及副本写入范围。费用未定价或 usage 未知不显示实际零费用。

草稿身份增加执行模式与根 ID，沿用 revision/token CAS；正文、空白、假设/判据与阅读位置仅在 renderer 会话保留。费用确认和副本授权不进入草稿恢复。失败/预算终止保留草稿及实际子记录入口；只有 U5 对匹配提交修订核实正常 stopped/completed 才按既有规则清理，较新编辑不受旧结果影响。离开/迟到结果不抢导航，重载只核对已有 operation，不自动再跑。

结果入口连接基线↔子运行现有输出/指标比较，并在同一比较工作区切换“文件”。首次明确显示默认各侧最近自有完成检查点，无已完成步骤则取初始；用户可独立改成任一合法自有检查点，不按轮号自动对齐。返回编辑、单侧文件、导出及比较保留原选择/滚动/焦点。只展示本次实际结局和人工判据，不使用“已修复”“测试通过”等自动断言。

新增视图沿用主工作区 `overflow-hidden`、各列容器 `min-h-0` 的高度链和详情列独立滚动，底部与正文同色；不让长 diff 把外层工作区撑开。实机逐项检查 CRLF/LF、空串、末尾换行及新增/删除方向的可辨性，对照字节 fixture，不以规范化后的文本替代原文；空间不足采用已有并排/上下适配和代码区滚动。

## Risks / Trade-offs

- 选择 v3 带来 reader/IPC/消费方兼容工作，但可保证旧客户端明确拒绝新执行语义；不能以少改文件为由复用 v2 轮末标记。
- 历史 provider/预算与模型后端未完整记录，无法证明严格控制所有条件；只确认消息与初始文件配对和本次实际执行配置。
- 附件预检可能较慢；先检查轻量条件，再核验全部初始字节。首版不引入后台持久任务或进度伪值。
- 跨运行比较是新增功能，需在完成包层及 IPC 身份守卫后接 UI；不从两份独立文件页拼出未经核实的差异。
- prompt 与假设可能敏感，沿用本地 trace 存储边界；列表/operation/诊断不带正文，R2.1 导出清单不加入这些文本。

## Migration Plan

先冻结 fixture、UI 状态与兼容矩阵，再做 v3 reader/schema/独立边界；随后包层预检/编排/比较、main/preload、现有工作区接入及实机。历史文件不迁移，普通 writer=v1，隔离根/result writer=v2，仅新入口 writer=v3。回退旧程序时 v3 明确不可读，v1/v2 原文件继续可用；不转换 v3 或覆盖原轨迹以“兼容”。

每个任务按对应 scenario 回填证据。最后执行 check:build/typecheck/test/lint/spec、定向 OpenSpec strict 和场景覆盖审计，再单独评估归档；本提案没有发布任务。

## Open Questions

无阻塞首版范围问题。实施期若需要扩大消息类型、trace v3 可写场景或执行能力，先修订 proposal/delta，再改代码；不静默降级或过滤历史事实。
