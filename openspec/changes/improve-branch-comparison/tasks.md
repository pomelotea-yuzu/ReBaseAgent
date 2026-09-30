# U7 实施与验收任务

本清单全部为待实施。每条按不超过 2h 的实现与针对性验证切分；若超出，先细分再实施。括号内为 delta 的精确场景名。继承的 MODIFIED 场景还须纳入 §6.1 索引和回归，不能只验新增场景。

## 1. 只读比较契约与完整性

- [x] 1.1 新增只读比较请求/响应 schema，验证数量、唯一身份、完整性及受控错误（对应“比较拒绝非法身份和错配载荷”）。（`6349ce7`：channels/ipc 三 schema + findCompareResponseMismatch + preload 透传；契约测试 15 条。1.7 起同轮改判：ready 项新增必填 chainSummaries）
- [x] 1.2 提取按 run ID 缓存的单次读取上下文，保持 U6 读取拒绝与 ownOnly 行为并补 repository 回归（对应“列表完整但比较读取缺祖先”）。（`619ae94`：main/run-read-context.ts RunReadContext——成功与失败都按物理文件缓存一次；getRun 委托行为零变化；回归 u6 五文件 75 用例绿）
- [x] 1.3 实现逐对象失败结果和合法侧保留，补相应单元/IPC/store/组件验证（对应“一侧不可读保留另一侧”）。（`345509b`：main/compare-endpoints.ts——请求级拒绝在读取前，逐项 ready/unavailable 稳定码映射（U6 六分类 + FORK_INVALID/RUN_INVALID/RUN_UNREADABLE），受控原因码点截断 512；RunDetailReadError 结构化诊断。store/组件消费归 §2 接线时同轮验证）
- [x] 1.4 实现选择集读取代次、迟到响应和销毁守卫，补相应单元/IPC/store/组件验证（对应“快速更换交换移出不串内容”）。（`045252e`+`5deff0c`：renderer/lib/compare-state.ts CompareReadSession——代次单调/在飞守卫/结论撤销先行；store 接线 enterCompareSelection/leaveCompare。纯判据 7 + store 9 条；组件消费归 §2 视图任务同轮验证）
- [x] 1.5 接线只读重试、结论失效及恢复，补相应单元/IPC/store/组件验证（对应“比较重试恢复必须全量重验”）。（同 1.4 提交：retryCompareSelectionRead 同选择集全量重读、旧结论先行撤销、无选择集不可重试；重试调用序列只有 runs:compare）
- [x] 1.6 接入 main/preload 的 compareRuns 只读通道与 renderer 验证；有效和非法请求各有实际往返测试（对应“比较拒绝非法身份和错配载荷”）。（`48fc2b8`：ipc.ts 注册 handler；compare-ipc.test.ts 以 vi.mock("electron") 捕获真实注册 handler（HANDOFF §六登记补法首次落地），往返 5 条）
- [x] 1.7 以本次已校验祖先自有摘要接共同祖先/累计派生；覆盖列表过期、ownOnly 与完整另一侧（对应“列表完整但比较读取缺祖先”）。（`dc0d648`：ready 项新增必填 chainSummaries；shared/compare-derive.ts deriveVerifiedComparison 三态 relation，唯一事实源 = 本次已校验链摘要并集，复用 deriveChainTotals/findCommonAncestor 不回退列表缓存；测试 7 条 + 列表版同源对照）
- [x] 1.8 核对概览沿用 U6 缺祖先的只读自有事实；用 ownOnly 正对照与损坏/版本/权限等严格错误反对照锁定修订后的概览判据（对应“缺祖先概览沿用已校验自有事实”“非法详情不被概览绕过”）。（`d83bb4a`：10 条判据锁定；原位错误+只读重试由 U1 detail-request / U6 detail-refresh-guard 承载、不恢复执行资格由 U6 run-source-gate 承载，注记边界）

本组依赖顺序：1.1 → 1.2/1.3 → 1.6/1.7 → 1.4/1.5；编号用于追踪，不表示可以跳过依赖。

## 2. 比较导航与阅读状态

- [x] 2.1 接入概览和可信操作结果的父子入口，补相应单元/IPC/store/组件验证（对应“父子入口默认父左子右”）。（`2e12b8e`：decideCompareWithParent 三态 + SourceSection.compareWithParent + 概览「与父运行对比」按钮（available 才渲染，源码级接线契约）+ store.openCompareWithParent（详情归属不符不猜父本）。⚠️ 可信操作结果侧的入口待 ResultReadEntry 携带 parentRunId 后接（detail.meta.parent 未存读取项），归 §5/§4 消费面任务同轮补）
- [x] 2.2 实现独立 pair 状态、更换、交换与同 ID 拒绝，补相应单元/IPC/store/组件验证（对应“更换交换不改变侧栏选择”）。（`2e12b8e`：comparePair 独立于侧栏选择与 compareIds；decidePairSideEdit 三态；setCompareSide/swapCompareSides 不调 selectRun；交换按新序重读使旧序请求失效）
- [x] 2.3 实现类型明确的返回位置与单侧往返，补相应单元/IPC/store/组件验证（对应“返回恢复来源与单侧阅读”）。（`2e12b8e`：CompareReturnLocation 复用创建页类型；compareReturnLocation 一次性凭据，但 selectRun 打开单侧保留——返回比较→再返回来源成立；restoreReadingLocation 共用提取；setView 才清；树视口恢复字段随 §3.3 扩展）
- [x] 2.4 将比较动作接入 U5 导航代次并回归草稿与设置，补相应单元/IPC/store/组件验证（对应“后台结束不抢比较页且草稿保留”）。（`2e12b8e`：进入/更换/交换/返回全部 noteReadingChanged 推进 navGeneration（store 测试断言）；代次单调 ⇒ 在途自动导航资格被撤销；全链实机验证归 §6.9。草稿/设置不因比较动作变更——比较动作不触碰 draft/execution-confirmation 状态面）
- [x] 2.5 验证手动集合按加入顺序确定左右，包含先子后父；与显式父子入口的父左子右分别验收（对应“手动两条比较按加入顺序确定左右”“父子入口默认父左子右”）。（`2e12b8e`：decideManualPair（两条按序/三条 explicit-select/单条 needs-two）+ store 用例先子后父 ⇒ 子左父右并按该序读取；与 decideCompareWithParent 的父左子右分别锁定）

## 3. 分支定位与可访问关系

- [x] 3.1 实现当前树/全部范围与首次定位，并覆盖远端节点和无选择，补相应单元/IPC/store/组件验证（对应“首次进入聚焦当前分支”）。（`ed8de23`：decideTreeInitialFocus + treeRootOf/visibleRunIdsForScope + store armTreeSession（幂等：已初始化沿用不重复居中）；滚动/居中几何归 §6.4 实机）
- [x] 3.2 接入完整字段搜索、范围外定位及空结果，补相应单元/IPC/store/组件验证（对应“搜索完整字段定位范围外运行”）。（`ed8de23`：searchTreeNodes 复用 matchesSearch 匹配完整原值；命中带所属树根、范围外标记与定位；空结果明确提示不丢节点）
- [x] 3.3 实现视口变换、定位与会话返回恢复，补相应单元/IPC/store/组件验证（对应“视口操作与返回保持逻辑布局”）。（`ed8de23`：treeViewport 会话观察状态（缩放档+滚动），范围/搜索只改可见性不改坐标；定位当前运行/适应画布（fitZoomLevel）；真机几何与返回恢复归 §6.4 实机）
- [x] 3.4 调整统一节点尺寸容纳任务摘要、稳定唯一短 ID、记录模型、状态、创建时间及自有步数/tokens；覆盖长字段完整阅读和缺失模型标记（对应“长节点字段完整可读”）。（`ed8de23`+`476ce32`：节点短 ID/模型（缺失标未记录）/状态/时间/自有步数 tokens；SelectedRunDetail 选中详情区承载完整阅读——完整任务 LongText 展开/查找/复制、完整 ID 复制按钮、沿链累计挪出节点（D2））
- [x] 3.5 接线节点三种动作及选择栏，补相应单元/IPC/store/组件验证（对应“选中打开与加入对比分离”）。（`476ce32`：节点单击仍只选中；详情区「打开运行」= selectRun+setView trace（独立明确动作）、「加入/移出对照」aria-pressed；节点双击 = 打开快捷方式；2.2 的 compareIds toggle 既有）
- [x] 3.6 实现可键盘操作的同数据关系列表，补相应单元/IPC/store/组件验证（对应“键盘关系列表与图同步”）。（`476ce32`：branch-relations.deriveRelationEntries 与图同序同身份同过滤；树呈现模式 图/列表（store treeMode 会话，返回保留模式）；列表行三动作均为原生 button（Tab 聚焦、Enter/Space 激活）+ aria-pressed 同步）
- [x] 3.7 接入缺父占位、成环与实验分组呈现，补相应单元/IPC/store/组件验证（对应“父缺失与实验分组不造记录”）。（`476ce32`：缺父占位只显示真实引用 + 固定不可用原因、无任何动作按钮，原 run 保留；成环沿用 OrphanBadge 提根标记；实验组头只按记录 experimentId（N 臂、首臂前一次），无标签不进组）

## 4. 修改、输出与步骤阅读

- [x] 4.1 实现普通 result 的父调用原值与子 fork 新值证据投影并测试（对应“直接父子展示真实编辑前后值”）。（`08da068`：shared/compare-edit-evidence.ts deriveDirectEditEvidence 三态；方向按 meta.parent 身份不按左右位置；v1 原值 = 父轨迹 at_span → tool.invoke.result，新值 = fork.edit.value 原样；真实空串/null 与未记录分开；未知字段原样保留 + UNKNOWN_EDIT_FIELD；prompt/messages/model_params 暂 FIELD_NOT_PROJECTED——4.11 与 §5 改判时须两边留痕）
- [x] 4.2 实现逐跳编辑证据与来源链呈现，补相应单元/IPC/store/组件验证（对应“多跳兄弟展示逐跳修改链”）。（`2009a88`：deriveHopChains(items, ancestorId)——从已确认共同祖先（不含）到各 ready 侧逐跳，每跳核对直接父（CHAIN_BREAK 兜底）；值级证据尽力投影：result 跳在该侧 resolved 视图定位、context 跳在来源详情于对内时走实际请求、否则 SPAN_NOT_IN_VIEW；ancestorId=null ⇒ 空链不推断根。纯派生层交付；「呈现」归 4.12 视图消费）
- [x] 4.3 实现不同根事实对照及不适用状态，补相应单元/IPC/store/组件验证（对应“不同根只核对实际输入配置”）。（`7613e4b`：deriveDifferentRootFacts——relation=unrelated 且两侧 ready 时逐侧列出模型/system/user/params 实际记录值；relation 非 unrelated 或有不可读侧 ⇒ notApplicable（共同祖先未确认不得按不同根呈现）；不触 config_hash；视图呈现归 4.12）
- [x] 4.4 实现编辑证据三态、未知字段与空值边界，补相应单元/IPC/store/组件验证（对应“原值缺失未知字段不补空”）。（`5131d0c`：三态/未知字段/空值/未记录/祖先不可得判据已随 4.1（`08da068`）、4.10、4.11（`87fccd3`）模块与用例交付，本轮补齐最后三支边界——edit.value 字面 undefined ⇒ EDIT_VALUE_UNRECORDED、null+空串双真实值 verified、不可用结论恒带身份四元组与无路径受控原因；IPC 层无新通道；store/组件级验证归 4.12 接线同轮补）
- [x] 4.5 复用输出/结局派生并实现单侧错误跳转，补相应单元/IPC/store/组件验证（对应“最终输出不借中间正文或祖先”）。（`e1ecf98`：shared/compare-output.ts deriveSideOutputFacts 薄组合 deriveOwnTerminalFacts + deriveOwnOutput，只补 failure.runId 侧身份；store 动作 openCompareSideError——落地判据 = 详情已读出且归属相符（selectRun 失败也落 selectedRunId，不能只看选中项），打开单侧保留 pair/来源引用；组件级呈现归 4.12）
- [ ] 4.6 实现输出工具栏、只读 diff 与独立滚动，补相应单元/IPC/store/组件验证（对应“长输出独立阅读与合法文本差异”）。
- [x] 4.7 提取普通 v1 resolver 的只读来源映射，对照原完整轨迹验证 span 边界与被覆写值（对应“result 共享前缀保留真实边界”）。（`4e2bd12`：shared/compare-source-map.ts deriveV1ResultSourceMapping——不做截断，从已校验投影视图 + chain 推导分段；边界须恰好出现一次且按链序递进，缺失/错序/重复 ⇒ unreliable 不折叠；段末 boundaryEdit 标注下一跳编辑、共同区被覆写值保留原值；spanScope=own ⇒ 单段归属叶子；独立边界/v2 ⇒ notPlainV1 归 4.8/4.13）
- [x] 4.8 实现独立步骤目录和复合定位，覆盖混合链，补相应单元/IPC/store/组件验证（对应“重复 span ID 与独立分支不强行对齐”）。（`606b299`：renderer/lib/compare-steps.ts deriveSideStepCatalog——每侧独立目录，复用 buildSpanTree+flattenSpanRows，行补来源归属（来源映射可靠时标注物理来源 run）；store compareStepSelection {left,right} + selectCompareStep 只动本侧；重复 s_01/同轮号不对齐不合并（目录纯派生 + 选中分列）；更换清被换侧、交换随 pair 对调、换 pair 全清/同 pair 保留；视图渲染归 4.12）
- [x] 4.9 接入 ownOnly 步骤限制与完整另一侧，补相应单元/IPC/store/组件验证（对应“缺父链仅显示自有步骤”）。（`606b299`：compare-steps 的 prefixUnknown 位——ownOnly 侧只显示已校验自有步骤并提示前缀未知，attribution=own 单段归属，不按可见链首项推断根、不折叠未知祖先；完整另一侧照常成目录互不影响；组件级提示呈现归 4.12）
- [x] 4.10 实现隔离 result 编辑证据，保留原始来源与本地整轮续跑边界并测试（对应“直接父子展示真实编辑前后值”）。（`08da068`：随 4.1 同轮交付——v2 分型 variant=isolated-v2，resume_after_step 在来源轨迹定位 agent.step（boundaryStep，未定位如实 null）；前后值提取与 v1 同源；整轮边界的视图呈现归 4.12）
- [x] 4.11 实现 system/user prompt 与 messages 的实际父请求取值和从头/单请求语义并测试（对应“直接父子展示真实编辑前后值”）。（`87fccd3`：原值 = 来源 run 自有首次 llm.call（leafSpanIds 过滤，反例钉住合并视图祖先调用不冒充）；role+字符串 content 判据与 draft-source/fork-runner 同款，缺证 START_CONTEXT_UNRECORDED；messages 取整份请求；verified 新增 semantics 分型 shared-prefix/from-scratch/single-request；4.1 注记的 FIELD_NOT_PROJECTED 改判在此兑现——prompt/messages 四分支的 4.1 期用例同步改判）
- [ ] 4.12 实现编辑证据完整展开、复制与左右方向展示，消费 4.1/4.10/4.11 的结果（对应“直接父子展示真实编辑前后值”）。
- [x] 4.13 接入隔离 v2 来源映射并验证 resume_after_step 整轮边界，不重写截断算法（对应“result 共享前缀保留真实边界”）。（`de617d5`+`a6455b8`：4.7 的 deriveV1ResultSourceMapping/notPlainV1 改判推广为 deriveResultSourceMapping/notResultChain——v2 result 跳接入段映射，v2 段边界 = resume_after_step 所指 step 的整段子树末尾（同轮兄弟工具保留在前缀段），只识别边界不重写截断（resolveWholeRound 仍是读取层唯一权威）；核验 step 恰好一次且是 agent.step、编辑点属该轮子树且≠step、子树视图内连续，违背 ⇒ unreliable；notResultChain 收窄为 fork 缺失防御分支——4.7 的「独立边界 ⇒ notPlainV1」用例同步改判为「重置视图单段映射」，两边留痕）
- [ ] 4.14 消费两种来源映射实现前缀折叠/展开，保留编辑差异和完整调用访问（对应“result 共享前缀保留真实边界”）。

## 5. 指标、实验门禁、文件与响应式

- [ ] 5.1 复用会话短 ID 到树、选择栏和比较标题，补相应单元/IPC/store/组件验证（对应“碰撞短 ID 不随筛选交换改变身份”）。
- [ ] 5.2 替换窄侧栏为宽幅指标表并固定名称列，补相应单元/IPC/store/组件验证（对应“四条指标名称始终可见”）。
- [ ] 5.3 实现指标表选两条与集合上限、空态，补相应单元/IPC/store/组件验证（对应“三四条显式选两条阅读”）。
- [ ] 5.4 复用自有与链路指标派生并标出口径，补相应单元/IPC/store/组件验证（对应“自有指标不重复计算继承前缀”）。
- [ ] 5.5 接入缓存覆盖范围和失败占位解释，补相应单元/IPC/store/组件验证（对应“缓存未知零部分和失败占位分开”）。
- [ ] 5.6 接线左右文件入口、U2 恢复与比较返回，补相应单元/IPC/store/组件验证（对应“分别打开文件并返回比较”）。
- [ ] 5.7 实现文件能力与检查点身份门禁，补相应单元/IPC/store/组件验证（对应“非法文件目标与普通运行不造历史”）。
- [ ] 5.8 实现内容宽度适配与导航状态恢复，补相应单元/IPC/store/组件验证（对应“窄窗和缩放仍能完整阅读”）。
- [ ] 5.9 补齐比较键盘交互和异步焦点，补相应单元/IPC/store/组件验证（对应“键盘完成比较闭环”）。
- [ ] 5.10 验证比较路径只接只读能力并覆盖写入反证，补相应单元/IPC/store/组件验证（对应“比较全程只读且不恢复许可”）。
- [ ] 5.11 实现历史实验资格与合法失败臂的共用展示，补相应单元/IPC/store/组件验证（对应“合法同父实验臂展示事实”）。
- [ ] 5.12 实现选择集级实验门禁与批次身份，补相应单元/IPC/store/组件验证（对应“异父混选与相同实验标签不能绕过”）。
- [ ] 5.13 实现实验拒绝矩阵与受控原因，补相应单元/IPC/store/组件验证（对应“不完整未封存与前置缺证明确拒绝”）。
- [ ] 5.14 提取并复用参数、首请求和 config_hash 记录一致性纯校验，验证不反推完整 RunConfig（对应“历史比较不依赖当前密钥和预览”）。
- [ ] 5.15 覆盖所有视图的实验结论限制和副作用说明，补相应单元/IPC/store/组件验证（对应“交换和四列均不产出实验臂间结论”）。
- [ ] 5.16 提取工具表/副作用声明纯校验并做既有执行门禁等价回归；历史比较不调用 handler 或当前配置的 dry-run（对应“历史比较不依赖当前密钥和预览”）。

本组实验任务先完成 5.14/5.16，再接 5.11–5.13/5.15；无法证明的前置条件保持不可验证，不能为通过验收放宽。

## 6. 证据与受控 Electron 验收

- [ ] 6.1 从三份 delta 建立逐场景 evidence-index，覆盖全部 ADDED 与 MODIFIED 场景；记录实际测试文件/标题/实机 tag、结果和限制，未知不得填已完成（对应“比较全程只读且不恢复许可”及全部继承场景）。
- [ ] 6.2 准备隔离测试目录与普通/隔离父子、多跳、兄弟、不同根、prompt、messages、model_params、ownOnly、错误和长文本标本；索引引用真实来源，生产数据不变（对应“直接父子展示真实编辑前后值”“重复 span ID 与独立分支不强行对齐”）。
- [ ] 6.3 为迟到响应、祖先缺失、模型门禁、只读不变性设计反证；故意破坏身份匹配/完整性/只读调用约束时测试须有效失败，恢复后通过并保存证据（对应“快速更换交换移出不串内容”“不完整未封存与前置缺证明确拒绝”“比较全程只读且不恢复许可”）。
- [ ] 6.4 Electron 第一批：复现 R9，验证远端分支定位、长节点、搜索、图/关系列表、三种动作、缺父占位和返回视口，保存真实点击与几何证据（对应“首次进入聚焦当前分支”“长节点字段完整可读”“选中打开与加入对比分离”“视口操作与返回保持逻辑布局”）。
- [ ] 6.5 Electron 第二批：普通/隔离父子编辑值、最终/缺失输出、长文本复制查找、不同根、兄弟多跳及两侧独立调用；覆盖 Monaco 就绪与全文读取（对应“直接父子展示真实编辑前后值”“多跳兄弟展示逐跳修改链”“长输出独立阅读与合法文本差异”“result 共享前缀保留真实边界”）。
- [ ] 6.6 Electron 第三批：列表读后藏祖先、恢复重试、当前或祖先非法、快速换边与离开；同时核对概览 ownOnly 可读及非法详情报错，验证错误分栏、旧响应不覆盖及全程只读计数/哈希（对应“列表完整但比较读取缺祖先”“一侧不可读保留另一侧”“比较重试恢复必须全量重验”“快速更换交换移出不串内容”“缺祖先概览沿用已校验自有事实”“非法详情不被概览绕过”）。
- [ ] 6.7 Electron 第四批：合法/失败实验臂、异父/混选/缺证拒绝、清除配置后的历史读取；核对全部比较视图无臂间差值或胜出结论（对应“合法同父实验臂展示事实”“异父混选与相同实验标签不能绕过”“历史比较不依赖当前密钥和预览”“交换和四列均不产出实验臂间结论”）。
- [ ] 6.8 Electron 第五批：复现 R8，四条同任务同模型同时间/短 ID 碰撞标本；1440/1360/1024/800px 与 200% 缩放，检查名称列、标题、正文宽度和内部滚动（对应“四条指标名称始终可见”“碰撞短 ID 不随筛选交换改变身份”“窄窗和缩放仍能完整阅读”）。
- [ ] 6.9 Electron 第六批：纯键盘闭环、手动先子后父与显式父子入口的左右顺序、文件自有检查点往返、草稿/设置往返、后台结束不抢焦点；未具备实机注入面的情况明确登记，不能用静态标记冒充（对应“键盘完成比较闭环”“手动两条比较按加入顺序确定左右”“父子入口默认父左子右”“分别打开文件并返回比较”“后台结束不抢比较页且草稿保留”）。

## 7. 回归与收口

- [ ] 7.1 检查新增 store 状态/API 桩在所有手写复位表中完整复位；运行 desktop 定向与全量测试、node/web typecheck、构建；包层有提取时先构建包再跑受影响 replay/trace-sdk 回归，失败/环境限制逐项记账（对应“result 共享前缀保留真实边界”“历史比较不依赖当前密钥和预览”及既有执行回归）。
- [ ] 7.2 运行 Biome、git diff --check 与 OpenSpec 全量 strict；核对三个 capability 的 MODIFIED 原场景均保留，内容变更只属于 design 列出的有意修改，任务场景名与索引逐项对上（对应全部 delta 场景）。
- [ ] 7.3 逐行回查 evidence-index 的实际测试、实机 tag、文件、结果与消费点，未验证项单列；检查无空入口、无 U8/跨运行文件 diff/执行扩权，不把文档通过或历史 U4/U5 欠账写成已交付，不自动归档发布（对应“比较全程只读且不恢复许可”及全部 delta 场景）。
