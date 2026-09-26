# U4 设计：操作身份、执行槽与原子核对

## Context

基线为 U1/U2/U3 已归档。`ipc.ts` 五个主动执行通道各自解析/调用/返回，没有 main 级互斥；`sourceTokens.consume` 在隔离创建 handler 中执行。store 的 `forkAt/createRun/promptFork/proxyFork/modelAb` 等待长请求，U3 `DraftSubmission` 只用 renderer 内 token 关联草稿。关闭流已有 sender/frame 校验、新鲜查询、1.5 秒有界等待和防重入，本 change 在其上增加 main 操作事实。

### 已核实的身份来源

| 入口 | 当前 ID 产生和失败行为 | U4 最小扩展 |
|---|---|---|
| 普通 create | runLoop 生成 ID，临时 trace 在 finally 中 readRun/rename；CreateRunError 仅有 code/message | 订阅本 tracer 的 run.meta，回调登记真实 ID；CreateRunError 带可选 runId，finally 保留已知关联 |
| 隔离 create | replay/workspace/isolated-run 生成 world/run ID，checkpoint tracer 替换 loop 的原始 ID，finally 归位 | 包 options 加 onRunIdentified，订阅底层 delegate 的最终 run.meta；绝不能登记被替换的 loop ID |
| 普通 result fork | replayRun 在预检后生成 ID 和 JsonlTracer，只在返回时暴露 ID | 包 options 加 onRunIdentified；run.meta 写出后、首次 LLM 前通知，后续抛错仍保留身份 |
| 隔离 result fork | replayIsolatedRun 生成 ID，临时文件收尾归位；拒绝结果为结构化 failure | 同隔离 create；预检/授权拒绝没有 ID，不降级执行 |
| prompt fork | promptReplayRun 内部生成 ID，成功返回 {id}，异常丢失关联 | 可选 onRunIdentified，覆盖该入口已有 model_params 单次调用但不新增桌面入口 |
| A/B | modelReplayRunMany 知道 experimentId、arm index、每臂 ID；异常 catch 的 id 为 null；桌面只透传无 error 臂的 ids | 可选 onArmRunIdentified({experimentId,index,id})；catch 保留已写 meta 的 ID；桌面新增完整臂摘要，不改变成功 ids 口径 |
| proxy 重发 | recorder.write 生成 ID，manager 用 lastWrittenRunId 取回；被动录制也覆盖此字段 | main 按本次 ProxyForkMeta 对象建立请求局部关联，recorder.write 返回时登记；移除用全局最后 ID 判断重发结果 |

`BaseTracer.startRun` 已在写 meta 后发出 `run.meta`，`subscribe` 可复用；无需改 agent-loop 或 trace-sdk 公共格式。只分配随机 ID、创建 tracer 对象不代表已有运行记录。未写 meta 或预检拒绝时不报告 ID。知道真实 ID 不保证文件已归位、封存或现在可读，界面不得据此显示成功。

## Goals / Non-goals

目标是现有所有主动入口实际使用同一 main 权威身份和执行槽，通信不确定时可核对且不重发，已知失败记录仍可定位。范围和非目标以 proposal 为准；U5 的通知、导航意图和正常完成后清草稿留到后续。U4 对迟到响应增加必要身份守卫，不整体替换正常返回时的既有导航。

## D1. main 会话和数据模型

在 main 启动时创建唯一 `OperationRegistry`，注入 IPC 和关闭协商，不能每窗口或每次注册 handler 重建。epoch 使用随机 UUID；renderer 的 U3 文档 sessionId 与 main epoch 各有职责，不能互代。

执行请求在原业务 payload 外统一增加 `operation: { epoch, operationId }`；operationId 为 renderer 明确提交时生成的 UUID。A/B `dryRun:true` 保持独立只读分支，不要求或创建执行身份，不接受混杂执行 envelope。每个请求依旧受原 zod 和领域预检约束。

公开记录至少包含：epoch、operationId、kind（create/result/prompt/proxy/modelAb）、目标 parentRunId/atSpanId/field 和普通/隔离模式、state（running/settled/notAccepted）、startedAt/settledAt、去重的 runIds、可选 experimentId/臂索引关联，以及 requestOutcome（returned/failed/rejected）、稳定错误码与受控诊断。创建目标无需任务正文；reconcile 先到的 tombstone 允许 kind/target 为 null，不伪造执行时间。A/B 臂摘要保留 index、id 或 null、请求层结局，未开始臂不得生成假 ID。

操作状态与运行终止事件分层：`settled` 仅表示本地执行及收尾均已结束；`returned` 仅表示编排正常返回，可能含 LLM error、限制终止或 A/B 部分失败。登记不是另一份 run 结果数据库。

内部仅额外保存不可逆请求指纹、当前执行 promise 和只包含允许字段的返回摘要。长请求正文/授权/凭据仅在执行所需上下文存活，settled 后释放引用，登记不得保留正文、sourceToken、密钥、原始 Error/stack、模型响应或 A/B 原始计划。终态及 notAccepted 不按 UI 关闭/列表淘汰清除，保留至 main 会话结束。

## D2. 请求同一性和接受顺序

使用通过 schema 的业务对象生成规范化表示：对象键递归排序，数组顺序和字符串字节保留，按 schema 统一缺省值，纳入通道、模式、父本/分叉点、编辑内容、臂顺序、sourceToken 和本次授权声明；排除 operation envelope、renderer 展示状态和草稿修订。区分合法的空串/空白/参数类型，不 trim 消息正文。用 main 会话随机密钥 HMAC-SHA-256 摘要，仅内部比较，不回传或持久化。所用运行 settings 不参与客户端请求同一性，重复请求不能因配置已改变而重新执行。

每次 IPC 请求在入口完成一次业务 schema parse，生成该请求的不可变业务快照；指纹与编排入参均从这份快照派生，不得一处使用 parse 结果、另一处使用原始 payload，也不得在生成指纹后修改快照的嵌套字段。规范化排序不得原地改写快照。允许从快照显式映射包层入参、注入执行上下文并保留既有领域校验，但不得重新从原始输入补缺省或产生另一套执行值。这里要求同一次解析后的数据来源一致，不要求每层函数持有同一个对象引用。测试覆盖缺省值、schema 转换/未知字段处理、对象键顺序及生成指纹后的修改尝试，并检查实际编排收到的值和调用次数；快照仍只在执行上下文存活，不放入长期 registry。

单次提交顺序：

1. 校验受信任顶层 sender、请求 schema 及 epoch；旧 epoch、缺身份或非法形状在副作用前拒绝。
2. 同步查 operationId：已有 running/settled 且指纹一致，仅关联同一 promise/终态；不再读取新配置或消费许可。异参返回 `OPERATION_CONFLICT`，原记录不变。notAccepted 返回原封禁结论，永不复活。
3. 新 ID 若关闭协商/配置变更互斥或主动槽已占用，登记 `notAccepted`（含稳定拒绝原因）并返回。再次执行必须由用户用新 ID 发起。
4. 新 ID 空槽时，在任何 await 之前原子登记 running 并占槽，再取得 settings 快照、检查业务门禁、消费 token 和开始编排。接受后发现未配置/领域拒绝，也走 settled/failed；不能把可能已使用许可的操作反标 notAccepted。
5. 执行、trace 归位、句柄/订阅/请求局部关联清理全部结束后，原子写 settled 并仅释放属于该 epoch/ID 的槽；整个过程由统一 finally 收口。清理错误记录为安全诊断，不丢先前 runIds。UI 的列表/详情读取在此之外。

同 ID 的重复 invoke 可等待同一结果；status 随时可读 running。正式执行返回带 operation 身份和登记版本的允许字段摘要，renderer 统一由此处理，不再以任意 `ok/fail` 解冻。业务拒绝采用稳定错误码，原字段级校验错误只在本次请求显示，不能把含输入的 ZodError 全量存入登记。

## D3. 执行槽与配置互斥

七类路径全覆盖：普通/隔离 create、普通/隔离 result、prompt、proxy、A/B 实际执行。所有窗口共用一个槽，A/B 从批次接受直到最后一臂与资源收尾完成均占槽，失败一臂不提前释放。既有隔离/父链/工具/费用门禁继续在 main 和包层校验。

目录选择、只读 capability、文件/列表/详情、settings:get、proxy:status 和 A/B dry-run 不占主动槽；不消耗执行授权或触发网络/文件写入。被动录制按既有代理语义继续，可以在主动操作期间产生独立记录。

`settings:save/clear` 在 main 检查主动槽和关闭协商，检查与同步写入不能被 await 分开。`proxy:toggle` 会保存代理配置并异步替换 listener/handler，也必须受同一互斥控制：先同步占短期配置变更标记，再 await 启停，finally 释放；其间拒绝新主动执行和其他配置变更，status 返回该标记供 UI 禁用。此标记不是主动 operation，不加入 runIds 或执行记录。启动 autoStart 与首次主动请求同样串行，防止新窗口在 handler 替换途中提交。已有被动流量不视为主动执行锁。

## D4. status、reconcile 与乱序

`operations:status` 无参，只读返回 main epoch、单调 registryVersion、activeOperationId、configurationBusy/closing 和本会话操作快照。一次序列化取得自洽快照，activeOperationId 必须指向同 epoch 的 running。只有此有效返回可完成初始握手；不凭列表刷新推断空槽。

本阶段返回本 epoch 全部操作的受限元数据，包括 settled 和 notAccepted；不按 renderer 当前关联或面板是否打开裁剪记录，确保重载后的首次握手也能恢复终态和封禁。registryVersion 用于乱序守卫，本阶段不兼作增量游标。长会话的全量序列化/传输/校验成本须测量后判断，不预设数百条记录已构成性能问题。若实测需要分页或增量，先修订协议并明确首次完整同步、游标失效后的恢复和 tombstone 保留，再调整实现。

`operations:reconcile({epoch,operationId})` 校验后在同步临界段执行：已有记录返回真实状态；不存在则插入 notAccepted tombstone，禁止以后接受该 ID。回应同时带当前槽和 registryVersion，不以被查询操作决定全局是否解锁。status 中“未找到”本身不是未执行证明，必须 reconcile。

reconcile 的查询键是 operationId，返回操作事实；它不读取 run 文件。用户明确打开已关联 runId 时，仍走既有运行详情接口及版本校验；详情读取失败只重试同一 runId 的读取，不把 runId 传作 operationId，也不以 reconcile 代替文件读取。

| 竞争/故障 | 确定行为 |
|---|---|
| reconcile 先到，执行后到 | notAccepted 封禁，零 token 消费/模型/工具调用 |
| 执行先到，reconcile 后到 | 返回 running 或 settled，不取消或再次执行 |
| 查询旧操作 A 时新操作 B 在跑 | A 的结果不得释放 B 的槽；以同一快照的 activeOperationId 判锁 |
| status/reconcile 或执行响应失联/非法 | renderer 标记 Unknown 并保留锁，允许只读查看、复制草稿与重试核对 |
| renderer 重载，同 main | 新 renderer 握手恢复槽和登记；U3 草稿仍不承诺跨重载恢复 |
| main 新 epoch | 清除旧会话对新槽的占用，旧已知结局保持未知，不自动重发或把未关联文件归到旧操作 |

每次登记变更递增 registryVersion。renderer 按 epoch、请求代次与版本合并，旧快照不得覆盖新槽或令 settled 回退 running；旧 epoch 的迟到响应不能切换当前 epoch。握手 epoch 变化只由当前有效 status 请求确认。首次握手失败也必须锁定执行/配置。

新 main 无旧内存登记，不承诺重新展示旧操作历史；仅当当前 renderer 仍持旧引用时，将其作为未知历史保留。全进程重启后用户仍可按实际 trace 浏览，不能根据名称/时间补关联。

## D5. 可信 ID 的最小包扩展

`replayRun`、`promptReplayRun`、`createIsolatedRun`、`replayIsolatedRun` options 增加可选 `(id: string) => void` 的 `onRunIdentified`。在调用 runLoop 前订阅现有 JsonlTracer 的 run.meta，仅将实际写出的最终 ID 传给回调；每 run 一次，finally 取消订阅。隔离路径订阅底层 delegate，得到 checkpoint tracer 注入后的 ID。普通 create 在 main 直接采用同样机制，无需扩展 loop。

回调为同步观察口，不控制执行、改 ID、改 messages 或写 trace；省略回调完全兼容。观察者异常须在编排观察适配处隔离，不能引入额外模型调用、改变终止事件或阻止原收尾；main 提供的登记回调为受控不抛实现。仅捕获观察者异常，不吞真实 tracer 写入错误。身份产生前允许 runIds=[]；已登记 ID 即使后续 loop、rename、读取或清理失败也不撤销，并提示记录可能不可读。

`CreateRunError` 增加可选 `runId`，普通/隔离模型失败均从结构化事实赋值；任意异常以已收集的 ID 为准，不解析 message。runId 表达身份，不声称最终 `.jsonl` 已成功归位。

`modelReplayRunMany` 增加 `onArmRunIdentified({experimentId,index,id})`，实际每臂 meta 写出时通知；catch 使用已经观察到的 ID，未开始/未写 meta 为 null。main 在批次结果回传前就能查询已知臂；保留既有按臂顺序执行和失败继续规则。桌面 `ModelAbResult` 新增允许字段的完整臂摘要；旧 `ids` 继续只包含成功臂，不能用扩大 ids 的方式把失败报成成功。操作摘要不缓存含 messages/params 的完整计划。

代理在 main 使用 `Map<ProxyForkMeta, RequestContext>` 持有当前主动重发上下文。现有 handler 将同一 fork 对象透传 recorder，回调在 `recorder.write` 成功后只更新匹配上下文并登记 ID；无 fork 的被动请求不更新主动上下文。finally 删除关联。recorder 同步/异步失败在请求上下文保存受控失败码，即使 llm-proxy 为保护转发而吞了 recorder 错误，主动重发也不能借另一请求 ID 报成功；不二次写同一 recording。此方案不修改 llm-proxy 包契约，测试固定对象关联和交错录制行为。

## D6. renderer 最小接线与 U3 兼容

shared 定义严格的执行 envelope、操作判别联合与快照 schema；preload 只暴露 status/reconcile 及原受限方法，main 校验 sender/frame 和输入，renderer 校验所有返回。运行详情继续沿用版本守卫，不能把操作摘要当详情数据。

store 增加会话握手、登记快照、通信状态和按 epoch/operationId 的提交关联。在明确提交时原子冻结 U3 key/revision/token 与请求快照并生成 operationId；所有七类主动路径通过同一适配器。Unknown 只发 status/reconcile，不重放业务 payload，不自动生成新 ID。可复用的业务失败/尚未发送的本地校验失败与通信未知分别处理。

原有按钮和 settings 保存/清除/代理启停从 main 槽、配置变更标记和通信状态派生 disabled；renderer 本地 submitting 状态只用于填补发出请求至收到 main 快照的间隙。main 返回 busy 仍是最后防线。展示 reset、组件卸载、刷新列表或其他操作返回均不能解锁。

在现有全局栏提供紧凑操作入口，查看类型、目标 ID、running/settled/notAccepted/Unknown、可信 runIds 与安全诊断，以及“核对状态”和按 ID 读取记录的命令。不展示进度百分比、停止按钮或成功推断。查询可在握手、提交返回、通信异常、窗口重新获得焦点和用户点击核对时触发；对已知 running 使用单路有界轮询（初值 1 秒，不重叠；失联停止自动轮询并允许手动核对）。这是状态读取，不是实时步骤事件。

自动轮询在上次 status 完成后再等待间隔，慢响应不堆积定时请求；没有已知 running 时停止该轮询，事件触发的核对仍可用。任务 4.5 以 100/1000 条受限操作摘要测量快照字节数、main 快照构造耗时、IPC 往返和 renderer 校验耗时，记录环境与高负载结果，并据此校准 1 秒初值。性能测量不裁剪终态、不改变 Unknown 的保守锁和同 main 重载恢复语义。

settled/notAccepted 仅解冻匹配提交，所有草稿保留；runIds 的详情读取失败不重新执行，也不继续占用该操作槽。迟到响应只更新自身登记，不自动导航、不清新修订。现有正常长请求导航保持当前语义，完整“用户离开后不抢焦点”交互归 U5；从恢复/核对入口取得结果时一律由用户明确打开。

## D7. 合并关闭保护

复用 `DraftCloseFlow/Guard/Attach`。发起退出协商时先在 main 置 closing 标记，拒绝新主动请求和配置变更，再按 U3 同步输入、查询 dirty；最后读取 main 活跃槽。clean 直接关闭必须同时满足 U3 全部 clean 条件、无活跃操作且无进行中配置变更。配置变更尚未完成时以状态待定合入确认，不冒充主动 run。

dirty/未知草稿/活跃操作合并成一次原生确认，默认返回；明确提示退出不会保证上游停止、费用撤销或草稿恢复。无草稿但有 running 也确认，renderer 无响应不能覆盖 main 活跃事实。操作在询问期间 settled 可更新 main 状态，但不能自行关闭已显示确认；返回只释放 closing/input 锁，不释放执行槽或删除登记。重复关闭共享当前协商；一次性 bypass 不跨窗口/请求泄漏。系统结束会话和强杀边界沿用 U3。

## D8. 验证与交付

每个任务 <=2h，对应 delta 具名 scenario。registry 单测用确定性调度证明接受/reconcile 两种顺序和 owner 校验；IPC 集成覆盖全部七类路径、直接绕 UI settings、token 单次消费和代理被动录制交错。包测试验证 observer 不改变执行/文件契约，A/B 部分失败 ID 不丢；renderer 测试覆盖 schema 失败、快照乱序、重载及草稿修订。实机使用受控服务，不要求付费 API。

实机至少验证所有入口、同 main 重载、状态通道中断/恢复、详情不可读、合并退出及窄窗口/键盘可达；核对源/父/兄弟/既有附件哈希。全进程重启单独验证新 epoch，不能用 renderer reload 替代。运行 replay/desktop 适用测试、包构建、桌面 typecheck、Biome、OpenSpec strict、桌面 build，逐场景留 evidence-index。文档阶段不运行功能验收或预勾任务。

## Risks / Trade-offs

- 主动槽串行会减少当前可绕过 UI 的并发，但使授权和配置快照有明确定义；不引入排队。
- 终态保存到 main 退出有会话内存成本，摘要严格限定字段；不以自动淘汰牺牲去重/tombstone 保证。
- `run.meta` 是身份事实，不是可读/成功证明。临时文件未归位、IO 错误和未封存运行仍可能不可读，U4 只保留 ID 和真实诊断。
- 新增包回调保持可选和纯观察，须验证异常隔离及资源释放，不把 main 状态耦合进 loop。
- 代理异步配置也需要互斥，避免只锁 settings 而遗漏 handler 替换；被动请求保持独立录制。

## Migration

main/shared/preload/renderer 同批交付，旧无身份主动请求在 main 拒绝；只读通道保持兼容。现有测试/fixtures/桌面脚本的真实执行调用同步添加握手与身份，不能给生产接口保留无身份后门。无磁盘迁移；回退代码不会改写 trace。实施发现契约需要变化时先修订本 change。
