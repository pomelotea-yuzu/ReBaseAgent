# U8 任务：录制与已有实验工作区

所有任务当前未实施。每条实现任务预计不超过 2h，超出即继续拆分；先按 design 固定事实来源，再接 UI。括号中的场景名与 delta 精确对应，证据在实施时逐项填写，不以 strict 或本文件存在标为完成。

## 1. 基线和导航

- [x] 1.1 建立 evidence-index：枚举两份 delta 全部场景，记录单元/IPC、fixture、实机批次、证据消费点及待验证状态；记录 U7 基线与历史未验证限制（对应全部 delta 场景）。
- [x] 1.2 定义 recording/experiment/messages 工作区目标及会话来源引用，禁止目标跟随侧栏选择；扩展必要导航类型与复位表，以对应场景的定向状态/组件测试验证（对应“运行入口打开明确实验目标”“切运行不更换实验父本”）。
- [x] 1.3 实现辅助工作区进入/返回与重复进入守卫，设置往返不覆盖原来源，目标失效保留草稿并明确回退；定向状态/组件测试核对 messages/A-B 新工作区与设置往返后的目标、原文、阅读位置及旧确认撤销（对应“离开实验恢复不带计划许可”“缺凭据转录制再返回精确编辑”“重跑编辑配置往返保持阅读”）。
- [x] 1.4 接全局、空态、运行菜单和自有代理调用入口，移除被迁移的重复编辑表单，以对应场景的定向状态/组件测试验证（对应“启用代理”“运行入口打开明确实验目标”“SDK run 无此入口”）。（注记 2026-10-01：三个入口 + 三个工作区壳 + RunActionsBar 已接；DetailPanel 内 ModelAbEditor/MessagesForkEditor 的**移除**按 design Migration Plan「每次迁移同时改唯一入口」随 §3.1/§5.1 提取时执行，本任务先接「在工作区打开」的第二扇门（同一草稿键，非第二份表单状态）。「录制入口保持现有代理区可达」用例已随本任务有意改判（定位设置分区 → 打开独立工作区），两边留痕见该用例注释与 evidence-index 行 20。）
- [x] 1.5 更新草稿列表与全局操作的返回草稿目标，使其进入新工作区并保留精确身份，以对应场景的定向状态/组件测试验证（对应“切运行不更换实验父本”“messages 工作区恢复完整非法文本”）。（注记 2026-10-01：openDraftAt 对 model_ab/messages 分流到实验/messages 工作区并按草稿键显式绑定目标、不切全局选中；旧详情内编辑器的 pending 自动打开随 §3.1/§5.1 提取后移除，result/system_prompt 路径不动。）
- [x] 1.6 扩展 U7 返回位置以支持实验结果来源，进入比较不改结果/批次事实，返回恢复对应位置，以对应场景的定向状态/组件测试验证（对应“比较拒绝和返回实验不改批次事实”）。（注记 2026-10-01：WorkspaceView 扩展后 `SourceView`/`CompareSourceView` 天然收录三个辅助视图，enterCompareView/returnFromCompare 零改动即支持 experiment 来源（runId null 不触发 selectRun）；结果面板位置的精确定位随 §4.5 结果区落地补。）

## 2. 录制草稿和状态

- [x] 2.1 实现独立 recordingDraft 原始字段、基线、单调修订及 dirty 派生，禁止凭据/计划持久化，以对应场景的定向状态/组件测试验证（对应“录制配置跨页恢复原始输入”）。（注记 2026-10-01：纯层 lib/recording-draft.ts + store ensure/写入 + baseline 随回读同步；实机归 6.6）
- [x] 2.2 接入带修订 CAS 的明确放弃，支持取消且不调用配置写通道，以对应场景的定向状态/组件测试验证（对应“录制放弃取消及修订竞争”）。（注记 2026-10-01：store CAS + 真模态确认（可取消、零配置写调用））
- [x] 2.3 接入 dirty 汇总、草稿定位、关闭协商与手写复位表，默认未改表单不误报，以对应场景的定向状态/组件测试验证（对应“录制未应用修改参与退出保护”）。（注记 2026-10-01：sessionDirtyCountOf 计入关闭协商；复位表在 recording-draft-store beforeEach；录制草稿未入全局草稿列表（其定位入口 = 录制工作区本身与全局栏/空态录制按钮））
- [x] 2.4 实现录制应用字段校验与提交冻结，完整整数解析及 URL schema 反馈，不接受部分有效数字；定向状态/组件测试对非法端口同时断言原始输入保留、字段错误可见及零配置写调用，不仅检查提示文本（对应“录制端口校验不接受部分整数”“代理应用沿用配置互斥”）。（注记 2026-10-01：完整整数端口 + URL 同 main 判据；非法 ⇒ invalid 零 toggle（store 纵深 + 视图 disabled）；实机归 6.6）
- [x] 2.5 实现应用成功/失败收尾与真实状态回读：保留失败输入、承认部分应用，不伪回滚；回读失败允许只读重试，以对应场景的定向状态/组件测试验证（对应“端口占用可见”“应用失败回读也失败保留输入”）。（注记 2026-10-01：toggle 后一律回读；失败两层诊断 + 只读重试不重新 toggle）
- [x] 2.6 为代理读取/应用结果加匹配提交修订与代次守卫，旧响应不能覆盖新状态、输入或导航，以对应场景的定向状态/组件测试验证（对应“录制应用收尾不覆盖后来输入”）。（注记 2026-10-01：修订守卫：在飞期间新输入不被旧响应覆写基线（store 定向测试））
- [x] 2.7 实现录制页意图/监听/凭据状态区及全局摘要，状态未知显式呈现，停止语义保持本地服务范围，以对应场景的定向状态/组件测试验证（对应“key 捕获状态”“停止或未知状态撤销地址”“停止服务不称取消运行”）。（注记 2026-10-01：意图/监听/凭据三层状态区 + 全局摘要（GlobalBar 既有 proxy 行）；实机归 6.6）
- [x] 2.8 实现真实地址复制及成功/失败反馈，仅用有效 running 和实际端口，无付费测试，以对应场景的定向状态/组件测试验证（对应“接入地址只来自已核实监听”“录制状态不冒充接入验证”）。（注记 2026-10-01：地址仅 running 可复制（在飞/未知撤销）；复制成功/失败反馈、零测试请求）
- [x] 2.9 接查看代理记录、搜索共同作用及显式列表/状态刷新，保留选择并呈现独立读取错误，以对应场景的定向状态/组件测试验证（对应“查看代理记录保留选择和搜索”“录制刷新只读且错误可重试”）。（注记 2026-10-01：查看代理记录（sourceFilter=proxy + 回轨迹视图，选择与搜索不动）+ 只读刷新状态/列表）
- [x] 2.10 移除设置代理表单，保留跳转；处理未保存模型字段/密钥的继续或放弃，取消零应用，以对应场景的定向状态/组件测试验证（对应“录制入口保持现有代理区可达”“设置跳转录制先处理未保存模型字段”“未保存设置关闭可继续或放弃”）。（注记 2026-10-01：设置代理表单已移除，分区只剩真实监听摘要 + 「打开录制工作区」跳转；dirty 时先真模态确认（取消零调用），确认后清密钥输入再进录制、调试草稿保留；settingsDraftDirty 去掉 ProxyDraft 参数（有意改判，settings-save-feedback 两用例删代理分支并留痕）；settings-clear-confirm/entry-gate 的旧锚点断言随表单移除改判并留痕）

## 3. 实验编辑与计划

- [x] 3.1 提取现有实验编辑展示到主工作区，复用 U3 目标/稳定臂 ID/原始文本与增删顺序，以对应场景的定向状态/组件测试验证（对应“运行入口打开明确实验目标”“切运行不更换实验父本”）。（注记 2026-10-01：3.1a ModelAbEditor 逐字提取为独立文件 + EntryGateNotice/DraftSourceBanner 随迁，三处源码切片测试改判留痕；3.1b 实验工作区目标作用域源读取 readExperimentSource（只读 runs:get 不动全局选择）+ 编辑器常开挂载（sourceExecutable 目标作用域覆盖/alwaysOpen 形态），DetailPanel 步骤页挂载点移除；draft-list 四编辑器闸门判据分文件计数留痕）
- [x] 3.2 接来源重验与明确拒绝，维持非隔离、已封存、完整父链、首次 system、config/tool/provider 原门禁，以对应场景的定向状态/组件测试验证（对应“实验来源失效仍能返回草稿”）。（注记 2026-10-01：重验判据（revalidateModelAbDraftSource + DraftSourceBanner + canSubmit 闸门）由编辑器原样继承；工作区经 3.1b 传入目标作用域源；既有定向测试在新文件全绿；实机归 6.7）
- [x] 3.3 保持参数解析与逐臂空 fork 判据，空文本和显式 {} 区分，非法原文不清洗，以对应场景的定向状态/组件测试验证（对应“实验空参数与显式空对象区分”）。（注记 2026-10-01：空文本/显式 {} /保留键/逐臂空 fork 判据原样继承（model-ab + guard-parity 全套既有测试在新载体复跑绿））
- [x] 3.4 提取逐臂计划展示，直接读 params/overridden/added/discarded/warnings，长字段可展开复制，以对应场景的定向状态/组件测试验证（对应“计划直接展示生效覆盖新增丢弃告警”“长模型上游和告警可完整核对”“dry-run 暴露整体替换的代价”“dry-run 每臂三段固定展示”）。（注记 2026-10-01：ArmPlanRow 超长值（model/参数/丢弃值/告警）经 LongText 呈现：折叠带字符数、展开完整原文、复制原文（阈值复用 shouldCollapse；短值内联形态不变）；能力断言 model-ab-plan-row 4 条）
- [x] 3.5 接只读预览通道及独立请求状态，桌面沿用配置前置；未冻结批次在别的操作占槽时仍可预览，以对应场景的定向状态/组件测试验证（对应“桌面预览沿用配置前置且零执行”“dry-run 无密钥”）。（注记 2026-10-01：预览独立请求状态：previewing 局部态 + 就地防重入 + finally 解除 + 独立呈现（只读 dry-run 文案与执行 busy 分开）；不登记操作、不占主动槽（gate 只绑执行））
- [x] 3.6 用修订/工具声明绑定计划新鲜度，修改再改回仍失效，重排和副作用声明变化也需重验，以对应场景的定向状态/组件测试验证（对应“修改臂再改回不恢复计划”）。（注记 2026-10-01：decidePlanFreshness 修订绑定 + 声明变化 setPlan(null) 原样继承；3.7 代次扩展后复跑绿）
- [x] 3.7 接已核实配置变化/回读失败和来源撤销，覆盖仅轮换 key 而 model/baseURL 相同，不传播 key 值；定向状态/组件测试断言已核实保存/清除推进配置变化代次并撤销计划，普通 proxy:status 刷新不推进该代次或误使有效计划失效，已保存但回读失败仍撤销旧计划（对应“配置轮换与来源撤销作废计划”）。（注记 2026-10-01：工作已随提交 `d8c81ee` 交付——settingsChangeGeneration（已核实保存含仅轮换 key/清除推进、save-failed 不推进、reread-failed 也推进、proxy:status 刷新不推进）+ decidePlanFreshness 代次扩展 + settings-save-feedback +5 / settings-roundtrip +3 / execution-confirmation-ab +1；本勾选为漏勾补记。）
- [x] 3.8 实现目标、修订、检查代次、配置和声明的在飞守卫，覆盖乱序/离开/放弃重建，复用 U5 代次，以对应场景的定向状态/组件测试验证（对应“迟到和乱序预览不能安装旧计划”）。（注记 2026-10-01：迟到预览守卫（requestedRevision/requestedStamp/requestedSettingsGeneration 三重）原样继承；定向测试（预览发起时记录/修订推进即失效）复跑绿）
- [x] 3.9 接当前计划的费用/工具确认及取消，说明臂数并非准确请求数、费用未知、顺序副作用边界，以对应场景的定向状态/组件测试验证（对应“费用确认区分臂数和请求数”“副作用声明不承诺公平隔离”“未确认时阻断真实调用”）。（注记 2026-10-01：⚠️ 措辞修正：执行按钮「N 次真实调用」→「N 臂」（臂数≠准确请求数，delta 明令）；abDisclosure 既有臂数/费用 unknown/副作用边界措辞继承）
- [x] 3.10 接计划无效拒绝、离开恢复撤销、最终提交重验及 submittedRevision/operation 关联，沿用单槽和批次冻结，以对应场景的定向状态/组件测试验证（对应“无有效计划和确认不提交实验”“离开实验恢复不带计划许可”）。（注记 2026-10-01：beginDraftSubmission 提交重验 + 整批冻结 + main 最终裁决原样继承（draft-closure-store/exec-model-ab 既有测试承载））

## 4. 批次结果与比较

- [x] 4.1 将逐臂结果展示移到独立工作区，按登记 target.armCount/arms 展示全部预期位置，不用成功臂 ids 补清单，以对应场景的定向状态/组件测试验证（对应“成功臂集合不隐去失败臂”）。（注记 2026-10-01：结果区从编辑器组件局部指针迁到工作区级——新纯派生 lib/experiment-results.ts deriveExperimentBatches（按 target.parentRunId 圈定本目标 modelAb 登记，复用 deriveAbBatchResult 的 armCount 基准）+ 纯视图 ExperimentResults.tsx + ExperimentWorkspace 容器挂载（事实源 = operations 登记 + resultReads）；ModelAbEditor 移除 executedOperationId 指针与结果区渲染、DetailPanel 死导入删除。有意改判两处两边留痕：operation-request-facts 源码级接线判据换载体（DetailPanel→ExperimentWorkspace/ExperimentResults）、model-ab-editor-draft 的 setExecutedOperationId 断言移除（指针随迁移删除）。测试 experiment-results.test.ts 11 条 + 邻居 aux-workspace-store 20 / execution-confirmation-ab 13 复跑绿；tsc 双 0；biome 0。）
- [x] 4.2 显示真实 experimentId/父本分组，区分预览和执行身份，不按模型/时间猜批次，以对应场景的定向状态/组件测试验证（对应“预览标签不充当真实批次身份”“同父同模型仍按真实批次分组”“同批 arm 自动配对”“多批实验共存”）。（注记 2026-10-01：分组键 = main 登记的 operationId，experimentId 只作随组展示标签（null 如实呈现"未登记"）；dry-run 预览的 experimentId 是编辑器局部态，deriveExperimentBatches 输入里没有计划 ⇒ 预览标签结构上进不了结果区（呈现层纯度源码级断言钉住：结果区组件/派生不摸 execution-confirmation/debugging-drafts/model-ab）。多批共存与同 experimentId 不合并、确定排序（startedAt+operationId）均有定向测试。）
- [x] 4.3 接单臂打开、失败定位、可信 ID 只读重试，未关联/不可读不补造文件或触发执行，以对应场景的定向状态/组件测试验证（对应“实验结果不可读仅重试读取”）。（注记 2026-10-01：接线随 4.1 落地（源码级断言钉住动作走既有 store 口）；本轮补行为反证 test/experiment-results-actions.test.ts 3 条——打开结果=经 selectRun 明确导航且执行通道零调用、不可读臂只按同一条可信 ID 重试（两次重试全路径仅 runs:get）、失败定位无已核实事实时零读取零执行；视图层"全部臂缺可信 ID ⇒ 零动作按钮"渲染判据入 experiment-results.test.ts。逐臂动作可用性判据（不可读只给 retry-read 等）由 operation-request-facts 既有用例承载。）
- [x] 4.4 将结果读取与清理继续交给 U5，核对全部预期臂、提交修订匹配和新草稿保护，以对应场景的定向状态/组件测试验证（对应“全臂核实才按提交修订清理”）。（注记 2026-10-01：零产品代码改动——清理唯一汇合点仍是 store 的 consumeSettledOperations（U5 §3），4.1 迁移未新增路径；源码级反证入 experiment-results.test.ts（结果区容器/视图无 consumeSettled/settleDraft/discard/beginDraftSubmission 任何调用）；"全臂核实才清/缺臂失败不可读整批保留/修订不匹配不清/新草稿保护"由 draft-closure-store 既有用例承载（evidence-index 39 行已引用两支）。）
- [x] 4.5 接结果选择两至四条进入 U7，复用上限、顺序、指标表/详细页分流与已有实验资格，以对应场景的定向状态/组件测试验证（对应“实验结果选两到四条进入共用比较”“比较拒绝和返回实验不改批次事实”）。（注记 2026-10-01：AbBatchResultSection 增可选 selection 注入面（旧消费方缺省不受影响）——可信臂加入/移出全局对照集合（toggleCompare，上限 4 归 store）、未关联臂禁用且原因在 title 但不隐藏（ownOnly/不可读仍可选中，拒绝由 U7 呈现）；ExperimentResults 增「进入比较」按钮 + 分流话术（experimentCompareHintOf）+ compareNotice 呈现；store 测试：两条按选择顺序进详细比较（comparePair=加入序）、来源引用记实验工作区、返回恢复视图且对照集合保留、比较入口/拒绝全程登记与读取项引用原样（只读反证）。上限拒绝与指标表分流由 store.test / compare-metrics 既有用例承载。）
- [x] 4.6 接工作区结果导航意图、全局操作入口及同 main 重载，保持后台零抢焦点和未知只核对，以对应场景的定向状态/组件测试验证（对应“跨页结束与重载恢复实验结果”）。（注记 2026-10-01：导航意图零新代码——批次提交登记时经 armNavigationIntent 注册（U5 既有），A/B ⇒ drop / 重载后 none 由 navigation-intent 既有用例承载（evidence-index 42 行）；全局操作入口由 OperationsEntry 既有结果面板承载（同批 store 口）。本轮补 4.6 定向测试两支（experiment-results-actions）：重载后由登记快照恢复批次呈现 + 读取项显式核实可重建 + 草稿仓库 model_ab 区与待定/收尾关联零补造；采纳已收口快照时人在别的页面零抢跳（view/selectedRunId 不动）。工作区结果区本身按登记派生（4.1），天然跨页存活与同 main 重载恢复。）

## 5. messages 工作区

- [x] 5.1 提取完整 JSON 编辑器和原值阅读到主工作区，保持精确草稿键/原始文本/Monaco 加载，以对应场景的定向状态/组件测试验证（对应“messages 工作区恢复完整非法文本”“未修改禁用”“SDK run 无此入口”）。（注记 2026-10-01：5.1a MessagesForkEditor 逐字提取独立文件（脚本切取+自证）；5.1b messagesSource 四态 + readMessagesSource（与 experimentSource 同判据）+ MessagesWorkspace 挂载（目标 span 缺席如实呈现/只读重试）；DetailPanel 挂载点移除改入口按钮（canResend=proxy 来源+自有调用+已封存 ⇒ SDK run 无此入口）；编辑器增 sourceExecutable 覆盖与 alwaysOpen 形态；顺手修复 3.1a 遗留破洞：prompt-messages-editor-draft 的 PROMPT 切片终点锚 ArmPlanRow 迁出后失效，改用 LlmCallDetail 锚并留痕）
- [x] 5.2 接运行、来源和凭据重验及就近录制入口，覆盖停止但 hasKey=true 与 main 重启，不回读或借用模型 key，以对应场景的定向状态/组件测试验证（对应“缺凭据转录制再返回精确编辑”“停用代理仍有凭据不能重发”“未捕获 key”“重启后凭据失效历史仍可读”）。（注记 2026-10-01：资格链提取为纯判据 lib/messages-eligibility.ts（源 → 重验 → 监听 → key → 槽，顺序即语义；running=null 状态未知不放行）；凭据/监听类原因就近给「打开录制工作区」入口（data-messages-recording-entry；进录制再返回，草稿与目标原样保留——store 路径由 aux-workspace-store 既有用例承载）；「不借用模型 key」是结构性的：判据输入无 settings；改判留痕：execution-confirmation-store 的确认面载体拆四文件计数（3.1a/5.1a 迁出后定向回归没跑到、本轮修复）+ 资格文案迁 messages-eligibility）
- [x] 5.3 接已有检查/费用确认/提交身份，明确单请求而非外部工具续跑，实际请求仍由 main 裁决，以对应场景的定向状态/组件测试验证（对应“messages 确认仍是单请求”“编辑并重发成功”）。（注记 2026-10-01：源码级判据——提交只走登记（channel messages + 确认凭据 + 提交快照解析）+ proxy:fork；forkAt/replayRun/modelReplayRun 零出现；单请求边界措辞出自 lib/messagesDisclosure（execution-confirmation.test.ts 既有判据承载「只重发这一个请求/不执行任何外部 Agent 的工具」）；登记口执法（assoc null ⇒ 零 IPC）；编辑并重发成功的 store 行为由 proxy-ab-entry-closure（messages 通道序列同形）/draft-closure-store（messages 收尾）既有用例承载）
- [x] 5.4 接结果打开/失败定位/只读重试和返回编辑，失败或 unknown 保留输入，源 trace 不变，以对应场景的定向状态/组件测试验证（对应“messages 失败定位与返回不丢草稿”）。（注记 2026-10-01：新 lib/messages-results.ts（deriveMessagesResults 按 target.kind=proxy + run/span 逐字匹配圈定提交，复用 deriveOperationResultView/requestFactsLineOf）+ 纯视图 MessagesResults.tsx（逐条结果动作 + 草稿在场给「返回编辑」+ 诚实空态）+ MessagesWorkspace 挂载（动作走既有 store 口，容器零执行/写调用）；store 反证：失败提交 ⇒ 不可读只给重试、返回编辑保留）
- [x] 5.5 回归主动重发与被动录制交错及录制写入失败，不借外部请求 ID；确认迁移未增加执行通道，以对应场景的定向状态/组件测试验证（对应“主动重发结果不借被动记录”）。（注记 2026-10-01：deriveMessagesResults 只按登记 target 圈定 ⇒ 被动记录结构上进不了结果区；store 反证：被动录制与重发新 run 并存 ⇒ 只呈现登记可信 ID；迁移未增加执行通道——容器源码级断言 proxyFork/forkRun/createRun/modelAb/proxyToggle 零出现；main 侧「录制写入失败不借被动 run」由 exec-prompt-proxy 既有两支承载）

## 6. 证据与实机

- [x] 6.1 准备受控录制 fixtures/mock：端口占用、状态读取失败与配置应用中断，维护注入清单/指纹还原，禁止覆盖生产凭据（对应“端口占用可见”“应用失败回读也失败保留输入”）。（注记 2026-10-01：`apps/desktop/scripts/lib/u8-recording-fixtures.cjs`——两种注入：occupyPort（真实 socket 占位，127.0.0.1 同 host ⇒ startProxyServer 必撞 EADDRINUSE，server.ts:74-76 → PROXY_START_FAILED 信封 = 端口占用可见 + 配置应用中断的唯一真实诱发面）+ writeProxySection（只替换 settings.json 的 proxy 字段、运行配置含 apiKey 密文逐字节不动 = 禁止覆盖生产凭据的机械保证；批尾 restoreFile 逐字节核验，失败落 U8-RESTORE-NEEDED.txt）。🔴 探明事实：「状态读取失败」（proxy:status 错误信封）真机没有注入面——main handler 恒 ok（ipc.ts:387）+ loadProxy 全容错（settings.ts:140，settings.test.ts 坐实）+ invoke reject 收不到 envelope ⇒ 「应用失败回读也失败」半边由 recording-draft-store 单元承载，6.6 批验证「端口占用→应用失败→回读成功」分层路径并如实登记。自检 test/controlled-recording-fixtures.test.ts 5 条（含还原失败反证——顺带修掉核验阶段不容错的库破洞；稳定码/文案源码级锚防漂移）。测试 5/5 + 邻居 recording-draft-store 10 + settings 10 单跑各绿；tsc 双 0；biome 0；desktop-test tsc 本文件 0 错。）
- [x] 6.2 准备自洽 JSONL 实验完整/部分失败/缺臂/ownOnly/非法标本与 messages 凭据/写入失败 mock，逐份读取确认不被前置校验意外拒绝（对应“成功臂集合不隐去失败臂”“主动重发结果不借被动记录”）。（注记 2026-10-01：`apps/desktop/scripts/gen-u8-recording-fixtures.cjs` + 入库标本 `apps/desktop/test/fixtures/u8-recording/`（10 份：组 A 自洽成功批 p1+a1/a2、组 B 部分失败批 p2+b1/b2（失败臂 = 顶层 llm.call.error + errored/error + 占位零用量）、组 C ownOnly o1（注入时 p3 缺席）、组 D 异父同标签 x1、组 E broken 读取被拒）+ MANIFEST（注入清单 + messages mock 手法：凭据序列走 keyStore 真实状态、写入失败 = fork 在飞 rename traces ⇒ PROXY_RECORDING_WRITE_FAILED）。🔴 修复 U7 6.2 的标本现实性缺口：全部臂首请求 model/params 与 fork.edit.value 逐字一致（整体覆盖语义，experiment-records 4 号判据）——U7 手工臂 ea/eb 不自洽的教训按 U8 6.7/6.9 实测复证。回查 `verify-u8-recording-fixtures.cjs` V1–V8 全绿（逐份经真 trace-sdk readRun；broken 必拒；selftest 三类注入 3/3 被抓）；手工组逐字节可重复（REPEATABLE）；biome 0。诚实边界：手工标本无 main 操作登记 ⇒ 结果区不显示，结果区主路径归 6.8 受控真实执行。）
- [ ] 6.3 录制行为反证：去掉迟到守卫、用草稿端口复制，记录定向测试判红与还原复绿，不在注入脚本内 spawn 测试（对应“录制应用收尾不覆盖后来输入”“接入地址只来自已核实监听”）。
- [ ] 6.4 实验计划反证：复用旧计划、仅按 model/baseURL 判配置不变，记录判红与还原复绿（对应“迟到和乱序预览不能安装旧计划”“配置轮换与来源撤销作废计划”）。
- [ ] 6.5 结果与凭据反证：按成功臂 ids 漏失败臂、只看 hasKey 放行停用服务，记录判红与还原复绿（对应“成功臂集合不隐去失败臂”“停用代理仍有凭据不能重发”）。
- [ ] 6.6 Electron 第一批：录制打开/启停/真实地址复制、占用/回读失败、跨页原文恢复、配置门禁与只读刷新；真实点击/结果/哈希证据（对应“启用代理”“端口占用可见”“应用失败回读也失败保留输入”“录制配置跨页恢复原始输入”“代理应用沿用配置互斥”“录制刷新只读且错误可重试”）。
- [ ] 6.7 Electron 第二批：实验臂增删/非法值/{}/继承参数、三段计划、修改后失效、设置往返/仅换 key、取消费用确认及副作用说明；零调用/落盘由 mock 计数和目录指纹核对（对应“实验空参数与显式空对象区分”“计划直接展示生效覆盖新增丢弃告警”“修改臂再改回不恢复计划”“配置轮换与来源撤销作废计划”“无有效计划和确认不提交实验”“副作用声明不承诺公平隔离”）。
- [ ] 6.8 Electron 第三批：受控真实执行完整及部分失败、不可读重试、缺臂/未知、后台离开/重载、逐臂打开/返回；核对冻结/清理/可信身份（对应“成功臂集合不隐去失败臂”“实验结果不可读仅重试读取”“全臂核实才按提交修订清理”“跨页结束与重载恢复实验结果”）。
- [ ] 6.9 Electron 第四批：合法/不可比结果进入 U7、2/3/4/第5条、返回实验；messages→录制→返回→受控重发/失败与被动交错；无新增执行权限（对应“实验结果选两到四条进入共用比较”“比较拒绝和返回实验不改批次事实”“缺凭据转录制再返回精确编辑”“messages 确认仍是单请求”“messages 失败定位与返回不丢草稿”“主动重发结果不借被动记录”）。
- [ ] 6.10 Electron 第五批：1440/1360/1024/800px、200% 缩放、长模型/upstream/告警/JSON、多臂计划；记录正文几何、内部滚动及可复制原文（对应“辅助页面窄窗和缩放完整可用”“长模型上游和告警可完整核对”）。
- [ ] 6.11 Electron 第六批：系统真键盘完成录制→重发及实验→比较；设置/放弃焦点、仅录制 dirty 退出及其他 dirty/操作合并；无法实测的竞争由确定性单元承载并单列（对应“键盘完成录制到重发闭环”“键盘完成实验到比较闭环”“录制未应用修改参与退出保护”“录制放弃取消及修订竞争”）。
- [ ] 6.12 跨入口回归普通/隔离创建、result/prompt、messages/A-B 与设置往返、文件、比较及全局操作；逐项验证任务文本、阅读恢复、单向密钥、保存/回读分层和配置锁，落实所有保留旧场景和新增场景剩余分支到 evidence-index，不以历史批次冒充新工作区验收（对应“辅助页面不改变已有主流程”“两模式配置后返回任务”“重跑编辑配置往返保持阅读”“单向密钥与保存反馈不冒充连通”“保存失败和保存后回读失败区分”“清除确认包含凭据且受槽约束”及两份 delta 全部场景）。

## 7. 门禁与收口

- [ ] 7.1 核对所有手写 store/API 桩复位表、导航类型消费者与关闭 dirty 契约；运行 desktop 定向/全量（singleFork）、node/web typecheck 和构建；包层若有修改先构建后跑受影响测试，环境受阻逐项登记（对应“辅助页面不改变已有主流程”“录制未应用修改参与退出保护”）。
- [ ] 7.2 Biome、git diff --check、OpenSpec 全量 strict；核对 MODIFIED 原场景全部保留，全部 delta 场景（含保留旧场景）都有精确任务引用且无悬空引用；只有 design 明列的布局/状态/候选语义改变，不改主 spec 或包能力以凑通过（对应两份 delta 全部场景）。
- [ ] 7.3 逐行回查 evidence-index 的测试/fixture、实机 tag、结果、消费点和指纹还原；列待验证/环境限制，无空入口、自动排名、隔离实验或取消扩权；不自动归档发布（对应两份 delta 全部场景）。
