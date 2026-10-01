# U8 设计：录制、模型实验与 messages 工作区

## Context

基线 HEAD `d53b7d0`，U7 已归档，起草前活动 change 为零。范围与保真度以 proposal 为准。录制与实验是辅助入口整合，未实测的新界面问题不能写成已发现缺陷。

| 现有代码 / 契约 | 已核实事实 | 本次衔接 |
|---|---|---|
| App / GlobalBar / SettingsDialog | 录制入口打开设置代理区；端口、upstream、开关局部保存 | 改为独立工作区，设置仅跳转 |
| shared/ipc ProxyState | enabled、running、port、upstreamBaseUrl、hasKey | 分层呈现，零凭据回读 |
| main/proxy-manager | toggle 先保存再停旧服务/启新服务；启动失败可 enabled=true、running=false；停止不必清空内存 key | 应用失败后回读，不伪造回滚；hasKey 不等于服务可用 |
| main/config-endpoints | proxy:toggle 有执行槽门禁和配置变更互斥；不登记主动 operation | 原样消费，防重复提交 |
| DetailPanel 内 ModelAbEditor / MessagesForkEditor | 已接 U3 草稿、U4/U5 确认与结果；展示与计划仍依赖局部组件 | 提取到工作区，复用原事实与动作 |
| modelAbPlan / fork-runner | 桌面预览要求已配置 settings；dry-run 零调用零落盘；CLI 无 apiKey 预览维持原能力 | 保留桌面前置，不宣称新增无配置桌面预览 |
| ModelAbResult.ids / operations.arms | ids 仅含成功臂；登记有失败臂、真实 index/id/outcome 与 target.armCount | 完整批次只从登记及按 ID 读取派生 |
| U7 比较 | 1–4 条校验读取、实验优先门禁、来源返回、禁止臂间结论 | 复用选择栏与工作区，不新增比较判据 |

## Goals / Non-Goals

让录制配置、实验臂编辑和 messages 编辑占据主工作区，离开仍有草稿和全局操作反馈，结果可按可信身份定位。录制用清晰的“意图 / 监听 / 凭据”状态区；实验用按臂排列的配置与计划、逐臂结果状态，减少必须阅读长文本才知道下一步的情况。Non-goals 见 proposal。

## Decisions

### D1. 页面与来源引用

在现有 WorkspaceView 增加 recording、experiment、messages，保持外壳、全局操作入口和运行导航。运行级“更多操作”提供已有实验入口；代理自有 llm.call 的入口打开 messages 工作区，原详情不另养一份编辑器。普通 prompt/result 仍就地编辑。

录制是全局页面，可从空态、全局栏、设置或缺代理凭据提示进入。experiment 目标 = 父 runId + 首次自有 llm.call spanId；messages 目标 = 当前代理 runId + 自有 llm.call spanId。目标引用与对应 U3 草稿键一致，但不把入口的当前选中运行当作长期目标。切运行后不能悄悄替换正在编辑的目标。

导航来源只保存会话内可核对的位置和焦点引用；重复点击同页或设置往返不覆盖原来源。录制→返回、实验→单臂结果→返回实验、实验→U7→返回实验以及 messages→结果→返回编辑有显式入口。扩展现有比较返回类型，使其可以返回新工作区的目标/结果面板位置；引用不含草稿正文、key、确认或授权，不持久化。避免建立通用历史栈：每个流程只保留必要的直接来源及工作区目标；重入刷新来源，返回一次消费对应引用。

来源失效时保留输入，说明目标不可用并回退现有可读工作区/空态；不得重建不存在的父本。后台核实不切页、不改选择、不抢焦点。全局“返回草稿”和现有草稿列表要定位到新工作区，不能继续把实验/messages 草稿路由到已移除的局部编辑器。

### D2. 录制配置草稿与状态

独立 recordingDraft 存 renderer 内存：baseline（最近可核实配置）、enabled、portText、upstreamText、单调 revision。保留无效端口和未完成 URL 原文；明确应用时才解析。复用 U3 修订/CAS 放弃规则，但保持独立数据结构。无 key、sourceToken、执行许可；字段只由用户输入或经过 schema 校验的状态初始化。默认 18787 / https://api.deepseek.com，读取未知时明确“状态待读取”，默认值不充当已保存事实。

dirty 是未应用字段偏离已核实 baseline，不以服务是否 running 判定。导航/设置往返保留字段；该 dirty 接入既有草稿入口与 main 关闭协商，放弃可取消。应用冻结本次字段并防重复，开始时撤销旧地址的可复制状态，直到当前应用结束并核实监听。成功且返回有效状态后按提交修订更新 baseline；不改监听之外的草稿或结果。失败保留提交输入，另行 proxy:status 回读，显示实际已保存意图和监听；由于 toggle 已可能保存或停止旧服务，不自动回滚开关、不恢复旧地址。失败输入仍标为未完成应用，即使回读配置相同也不能以“已保存”隐藏启动失败；重新应用须显式点击。回读失败清楚撤销可复制地址和可信状态，允许仅重读状态；重读不重新 toggle。

端口接受完整整数文本 1–65535，不用 parseInt 接受“18787abc”或小数；URL 仍遵守现有 schema。proxy:toggle、settings 保存/清除继续遵守 main 配置锁，监听启停不进入主动操作清单。应用期间离开页面，响应只更新匹配的状态/修订，不导航或覆盖后来输入。

### D3. 录制接入与凭据

页头展示已核实 enabled 与 running，分别标意图和服务状态；hasKey 单独说明“本会话凭据可用/尚未收到”。全局栏复用真实监听摘要。接入地址仅从最新有效 running=true 的 ProxyState.port 构造 `http://127.0.0.1:<port>/v1`，不使用未应用端口或 upstream；停止、失败、读取未知时地址不可复制。长 upstream 完整可读；复制有成功/失败反馈，不发送请求。

入口/页面进入和显式刷新读取 proxy:status，必要时复用已有受控读取动作；无新的实时订阅/常驻高频轮询。hasKey 可能在下一次读取才更新，不承诺即时仪表。查看代理记录设 sourceFilter=proxy，打开列表并保留当前选择；任务/ID 搜索仍共同生效，被旧搜索遮住时提示并允许清除。显式列表刷新沿用 loadRuns，不用“最新文件”推断本次重发结果。

停止后 hasKey 可能仍为 true，messages 重发还要求现有 handler 可用（running），不能仅按 hasKey 放行。主进程重启 key 自然失效，历史记录可读但重发需重新接入；桌面 settings 密钥不替代代理 key。未新增最近请求时间、速率、连接成功或“已接入 Agent”信息。

### D4. 实验编辑与计划

提取现有 ModelAbEditor、ArmPlanRow 展示逻辑，复用 model-ab guard、debugging-drafts、draft-source 和执行确认绑定。默认两臂；稳定行 ID 与原始 model/paramsText、顺序保留。参数空文本 = 不传 params / 沿用父值，显式 `{}` = 整体替换为空；非法标量/保留键/逐臂空 fork 沿用既有校验，不静默清洗输入。复用完整父链、已封存、非隔离、config_hash、字符串 system、工具实现和单 provider 条件。

计划只调用 `modelAb(..., dryRun=true)` → modelAbPlan；执行仍走原主动通道。桌面沿用 settingsConfigured 前置，CLI 无密钥 dry-run 不变。预览需要只读父本以验证来源和配置，原“dry-run 无密钥”场景的“不读写 trace”修正为“不改写 trace、不创建运行”，不增加写能力。共享结果 schema 校验后的 plan.fields 直接渲染：model、params、overridden、added、discarded、warnings 与工具策略，空告警说明知识库未命中，不称 provider 已生效。不重算后端计划或价格。

计划 binding 至少包含目标、批次 revision、运行配置变化代次、来源重验/撤销代次、预览 requestGeneration、当前副作用声明。运行配置变化代次由已核实保存/清除推进，包括相同 model/baseURL 下只轮换 key 的成功保存；不记录 key 值。普通代理状态刷新不冒充模型配置变化。每次预览先撤销旧确认；返回设置或离开再恢复清计划和许可，保留臂正文。修改后改回原值也不恢复旧计划。

在飞响应只有 binding 全部相符且工作区仍有效才安装；更换父本、改行、重排、放弃后重建、源失效、设置保存或第二次预览均作废旧响应。实施优先复用 U5 checkGeneration/配置失效流程，补足迁移必需的纯状态守卫；不把 dry-run plan 写草稿、操作登记或磁盘。

### D5. 执行与完整结果

有效计划后进入既有确认流程，列出单 provider、父本、每臂 model/生效 params、计划臂数、费用 unknown 与工具策略。臂数不等于 API 请求数（每臂 loop 可多次调用），不能用“2 次请求”承诺两臂总费用。副作用工具需现有显式声明，说明顺序执行及外部污染；声明变更作废计划并重验。最终提交仍由 main 重验，不把预览当成后端许可。

整批提交使用 U3 submittedRevision + U4 epoch/operationId，冻结目标草稿；全局执行槽与 unknown 核对维持原规则，允许跨页只读。新工作区不自建轮询、busy 真相或取消。源不完整先拒绝，旧许可不能因重新阅读变 complete 自动恢复。

结果面板绑定明确 operation pointer，使用 deriveAbBatchResult / resultReads / 登记记录。按 target.armCount 列全部预期 index，逐臂呈现未关联、执行中、结果待读取、不可读或自有结局。`ModelAbResult.ids` 是成功臂集合，不是完整清单；dry-run experimentId 不是执行批次身份，真实分组只用登记/已校验记录。没有 ID 不造文件、不扫目录猜；失败 ID 可打开并定位失败调用；待读取/不可读只 retryOperationResultRead，不执行。

全部预期臂自有 stopped/completed 核实且原修订匹配才整批清理；部分失败、缺臂、未知、不可读保持批次。renderer 重载同 main 恢复操作/结果但不恢复丢失的内存草稿或旧计划。结果区不依赖当前密钥；历史 batch 同样只读。

### D6. 结果到 U7 的入口

结果区为真实 ID 提供打开运行、失败定位、返回配置及选择两至四条比较；两条按选择顺序进入详细比较，三至四条进入指标表后再选两条，超四条可移出再选，不新增无界列。未关联 ID 禁用选择并显示原因；已关联但 ownOnly/不可读/未封存的记录仍可通过 U7 呈现拒绝，不能由结果页把它们过滤成“比较成功”。

复用 U7 同次读取、实验优先门禁、父本/配置/工具校验和副作用说明。experimentId 仅分组，不取代资格；不同批同父也不按模型名合并。共用比较不计算臂间差值/胜者。进入比较只读，不重新跑计划、消耗 sourceToken 或恢复确认。返回实验还原目标、结果列表与滚动；编辑草稿返回后必须重新预览。

### D7. messages 工作区

提取 MessagesForkEditor 为独立页面，显示代理来源、父 run/调用、单请求语义、原始 messages 与完整编辑 JSON（Monaco 沿用懒加载）。键和原文仍由 U3 管理，非法 JSON、空白与空串不丢失；收起/切页/设置/录制往返保留，许可清零。执行前重新校验已封存完整代理来源、自有 llm.call、非空合法数组、有变化及当前运行代理凭据。

凭据提示可进入 recording，再返回精确编辑目标；停止但 hasKey=true 仍禁重发并解释。确认显示真实 upstream 调用/费用及不执行外部工具，操作和结果直接复用 proxyFork 提交、登记、按 ID 核实。被动请求与主动重发交错不抢占 ID。失败/未知/录制写入失败保留草稿，不借被动录制补结果；源 trace 不改写。

### D8. 可视化、响应式与回归

录制按配置→状态→地址→凭据→记录入口组织单列；实验按臂卡片/行与计划逐项就近展示，结果状态对齐同一臂身份；messages 原值/新值宽窗可并排，窄窗上下排列且标题重复。无步骤目录占位，正文/JSON 使用可用宽度及内部滚动，主要文字沿 U1 基线。窄窗自动折叠导航只影响显示，不覆盖用户宽度偏好。

所有状态同时有文字，不依赖颜色；长模型/ID/upstream/告警可展开和复制，失败提示就近、aria-live 有界。完整工作区不使用模态焦点陷阱；设置/放弃确认继续用已有 ModalDialog。纯键盘能够打开录制、复制、回编辑、预览/确认、打开失败和返回比较；离开后恢复有效来源焦点，目标失效采用明确回退。

## Risks / Trade-offs

本次选择主工作区提取而非继续扩展详情内长表单，以保持正文宽度和来源返回；选择复用已有草稿/登记/结果适配而非新建通用表单或第二套编排，减少迁移时事实分叉；选择会话内状态而非持久化草稿，维持 U3 凭据和许可边界。

- proxy:toggle 非事务：保存先于监听，失败要承认部分应用，不能通过伪回滚改善外观；若未来需要事务改动另提契约。
- 配置变化只看 model/baseURL 抓不到 key 轮换：用已核实变更代次，零密钥传播。已保存而回读失败要撤销旧计划并显示待读取。
- DetailPanel 提取容易漏掉全局草稿定位、手写 store 复位表和操作导航意图，tasks 单独核对，不能只检查新组件渲染。
- 跨工作区返回可能覆盖来源或引用旧目标，用目标身份与代次测试，避免递归导航栈。
- 新工作区需实机才可证明几何/键盘；U7 已登记的缩放/注入限制保留，不将历史分层证据自动改成 U8 已通过。

## Migration Plan

先建立逐场景证据与导航/录制草稿，再迁移录制页面；随后迁移实验编辑/计划、批次结果/U7 接线、messages。每次迁移同时改唯一入口，避免留两份配置真相。既有 trace、settings、端口默认值、凭据生命周期、CLI 和包执行无迁移；新 UI 状态只存会话，renderer 重载不恢复草稿。最后执行跨入口回归、门禁和逐条证据回查，另按用户指令决定实施后归档/发布。

## Open Questions

无阻塞范围问题。组件名与局部布局可在实施中调整；若需要新 IPC、持久格式或执行能力，先修订 proposal。当前文档自检不声称独立评审或实机验收。
