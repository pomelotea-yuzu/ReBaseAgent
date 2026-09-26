# U4 实施任务

实施进度：**§1–§5 与 §6.1 已完成**（下列已勾项各附证据摘要），§6.2–6.8 与 §7.1–7.2 待办。基线为已归档 U1/U2/U3；旧走查和文档校验不算功能证据。每项预算 <=2h，超过先拆分。场景引用为对应 delta 的逐字标题：默认 [desktop-ui](specs/desktop-ui/spec.md)，包层另标 [replay](specs/replay/spec.md)、[prompt-replay](specs/prompt-replay/spec.md)、[model-experiments](specs/model-experiments/spec.md)。实施任务包含相应自动化断言，实机与完整门禁另列。

## 1. 操作类型与 main 登记

- [x] 1.1 定义执行 envelope、operation 判别联合、目标/臂摘要与快照 zod schema，加入受限 channel/preload/API 类型（<=2h）。验收：七类主动入口均绑定身份 / 非法操作响应不能解除门禁。
- [x] 1.2 实现 main 生命周期唯一 registry、epoch、登记版本及完整的受限元数据快照，注入 IPC/关闭流；覆盖重载与面板关闭后 settled/notAccepted 仍在快照中（<=2h）。验收：握手和快照自洽 / 同 main 重载恢复操作。
- [x] 1.3 实现 schema 后规范化业务请求、会话 HMAC 指纹及同 ID 同参关联/异参拒绝；指纹和编排参数共用同一次 parse 的不可变业务快照，规范化不原地改写，不在登记保存正文。补缺省值、字段转换/未知字段处理及嵌套修改尝试断言，验证实际入参（<=2h）。验收：同 ID 重复请求只执行一次 / 同 ID 异参和跨通道复用被拒绝 / 指纹与执行使用同一解析快照。
- [x] 1.4 实现同步接受/占槽与 busy/closing/configurationBusy 的 notAccepted，所有状态转换检查 owner（<=2h）。验收：不同入口并发只有一个被接受 / 旧操作收尾不能释放新操作。
- [x] 1.5 实现共享执行 promise、统一 settled/finally 收口和允许字段的诊断，释放执行上下文引用（<=2h）。验收：执行和收尾结束才释放本操作 / 接受后业务拒绝仍有可信终态 / 会话登记不泄漏输入和凭据。
- [x] 1.6 实现 status/reconcile handler，原子 tombstone、当前槽和版本快照；校验 sender/frame/epoch（<=2h）。验收：reconcile 先到封禁迟到提交 / 执行先到核对实际状态 / 旧 epoch 和非法身份无副作用。
- [x] 1.7 用可控调度补全 registry 竞争测试，含 settled A/reconcile A 与 running B、重复完成和顺序反转（<=2h）。验收：核对旧操作不解除另一操作的锁 / 旧操作收尾不能释放新操作 / 不同入口并发只有一个被接受。

## 2. 可信身份的编排扩展

- [x] 2.1 在 replayRun options 接入可选 onRunIdentified，订阅最终 run.meta，隔离观察异常并释放订阅（<=2h）。验收（replay）：普通 result 编排暴露已创建身份 / 可选观察不改变执行结果。
- [x] 2.2 在 createIsolatedRun 接入底层 delegate 身份观察，覆盖被替换 ID、meta 前失败和归位失败（<=2h）。验收（replay）：隔离编排报告最终世界身份 / 拒绝和写入前失败没有运行身份。
- [x] 2.3 在 replayIsolatedRun 接入相同观察口，保留预检/授权/轮末和收尾语义（<=2h）。验收（replay）：隔离编排报告最终世界身份 / 拒绝和写入前失败没有运行身份 / 可选观察不改变执行结果。
- [x] 2.4 在 promptReplayRun 添加可选身份观察，覆盖三种既有字段和前置拒绝（<=2h）。验收（prompt-replay）：prompt 身份在后续失败时仍可关联 / prompt 前置拒绝不报告假身份 / prompt 观察者兼容且释放。
- [x] 2.5 在 modelReplayRunMany 添加按臂回调与 catch 保留已知 ID，保留 dry-run 和失败继续语义（<=2h）。验收（model-experiments）：批次运行中可关联各臂 / 部分失败和异常臂保留已知 ID。
- [x] 2.6 补齐实验观察省略/抛错、未开始/meta 前失败、dry-run、订阅释放测试（<=2h）。验收（model-experiments）：未开始臂与 dry-run 不产生 ID / 实验身份观察不改变原执行。
- [x] 2.7 普通 runCreate 订阅本 tracer；CreateRunError 添加可选 runId，隔离创建消费包回调并传递结构化身份（<=2h）。验收：普通和隔离创建失败保留 ID / 分叉在已知身份后异常仍可关联。
- [x] 2.8 fork-runner 传递普通/隔离/prompt 回调，runModelAb 返回完整臂允许字段且保持旧成功 ids（<=2h）。验收：分叉在已知身份后异常仍可关联 / A-B 部分失败保留各臂事实。
- [x] 2.9 替换 ProxyManager 全局 lastWrittenRunId，以本次 fork 对象关联 recorder 结果和受控写入失败，finally 清理（<=2h）。验收：主动代理重发与被动录制交错。
- [x] 2.10 增加代理交错请求/record 吞错回归和敏感错误标记测试，证明不借用被动 ID 或二次写入（<=2h）。验收：主动代理重发与被动录制交错 / 会话登记不泄漏输入和凭据。

## 3. main 全入口和配置门禁

- [x] 3.1 将普通/隔离 create 接入 registry，确保判重在 settings 快照、sourceToken 消费和源导入之前（<=2h）。验收：同 ID 重复请求只执行一次 / 普通和隔离创建失败保留 ID / 接受后业务拒绝仍有可信终态。
- [x] 3.2 将普通/隔离 result fork 接入 registry，保留 execution 模式和包预检，不允许无身份后门（<=2h）。验收：七类主动入口均绑定身份 / 分叉在已知身份后异常仍可关联 / 接受后业务拒绝仍有可信终态。
- [x] 3.3 将 prompt 和 proxy 主动入口接入 registry，保留启动上下文/代理 key 与父本门禁（<=2h）。验收：七类主动入口均绑定身份 / 同 ID 重复请求只执行一次 / 主动代理重发与被动录制交错。
- [x] 3.4 将 A/B 实际执行整批接入 registry，dry-run 独立只读分支，按臂追加关联（<=2h）。验收：A-B 一批占槽直到全部收尾 / A-B 部分失败保留各臂事实 / 只读入口和被动录制不占主动槽。
- [x] 3.5 main settings 保存/清除原子校验槽和关闭标记；错误返回不泄漏配置或密钥（<=2h）。验收：直接 IPC 不能绕过配置锁 / 配置后重跑可用 / 未配置时提示 / settled 后读取失败不阻止配置。
- [x] 3.6 为 proxy:toggle/autoStart 增加异步配置互斥和 finally 释放，status 暴露配置变更标记（<=2h）。验收：配置变更与主动接受原子互斥 / 直接 IPC 不能绕过配置锁。
- [x] 3.7 建立七类 IPC 重复/异参/跨入口忙碌的参数化集成矩阵，断言实际编排入参与入口解析快照一致，以及真实调用、文件和 token 消费次数（<=2h）。验收：七类主动入口均绑定身份 / 同 ID 重复请求只执行一次 / 同 ID 异参和跨通道复用被拒绝 / 不同入口并发只有一个被接受 / 指纹与执行使用同一解析快照。
- [x] 3.8 覆盖直接 IPC 旧 epoch/伪造 sender、迟到提交封禁、schema 失败、只读零授权和隔离原门禁（<=2h）。验收：旧 epoch 和非法身份无副作用 / reconcile 先到封禁迟到提交 / 只读入口和被动录制不占主动槽 / 接受后业务拒绝仍有可信终态。

## 4. renderer 会话与现有界面接线

- [x] 4.1 实现 store 握手、快照校验、epoch/版本/请求代次守卫；初始未确认与 Unknown 保守锁（<=2h）。验收：初始握手失败禁用主动入口 / 乱序快照不回退新状态 / 非法操作响应不能解除门禁。
- [x] 4.2 为 U3 DraftSubmission 添加 epoch/operationId，并实现统一提交适配器与按身份解冻（<=2h）。验收：提交快照独立于编辑器挂载 / 核对终态只解冻对应修订 / 迟到回调与未知状态不能错误解冻。
- [x] 4.3 迁移 create 与 result 普通/隔离 store/UI 调用，门禁从统一槽派生，保留正文和授权重置（<=2h）。验收：所有入口实际使用同一适配器 / 成功错误和部分失败均保留草稿。
- [x] 4.4 迁移 prompt、messages 和 A/B 实际提交，保持 dry-run 独立与成功 ids 语义（<=2h）。验收：所有入口实际使用同一适配器 / A-B 部分失败保留各臂事实 / 成功错误和部分失败均保留草稿。
- [x] 4.5 接通 status/reconcile 恢复、响应完成后计时的单路轮询、无 running/失联停止和手动核对，不重放 payload。以 100/1000 条摘要记录完整快照字节数、main 构造/IPC 往返/renderer 校验耗时及高负载环境，校准 1 秒初值；不裁剪终态或封禁（<=2h）。验收：状态通道不可用保持未知 / 同 main 重载恢复操作 / 核对旧操作不解除另一操作的锁 / 握手和快照自洽。
- [x] 4.6 实现 main epoch 更换时旧关联未知处理，阻止旧响应导航/解冻或回退会话（<=2h）。验收：新 main 会话不伪造旧操作结局 / 乱序快照不回退新状态 / 核对结果只由用户明确打开。
- [x] 4.7 在现有全局栏添加最小操作入口，按 operationId 核对操作，按可信 runId 经既有详情接口读取/重试，显示可信状态及诊断；验证两种查询不混用（<=2h）。验收：结果不可读不重执行且不锁配置 / 核对结果只由用户明确打开 / 操作入口在窄窗口和键盘下可达。
- [x] 4.8 设置保存/清除/代理启停绑定统一门禁，保留读取、原密钥单向与模态焦点（<=2h）。验收：直接 IPC 不能绕过配置锁 / settled 后读取失败不阻止配置 / 操作入口在窄窗口和键盘下可达。
- [x] 4.9 更新现有 renderer fixtures/API mock 和主动执行脚本的握手/身份；补真实消费测试，禁止只测纯 reducer（<=2h）。验收：预加载接口不含文件能力 / 主进程返回非法结构 / 所有入口实际使用同一适配器 / 初始握手失败禁用主动入口。

## 5. U3 关闭协商整合

- [x] 5.1 DraftCloseFlow 注入 registry，进入协商先置 closing，clean 判定联合 main 槽/配置变更（<=2h）。验收：最新 clean 应答才允许直接关闭 / 无草稿的活跃操作也需确认 / 草稿与操作合并且关闭竞争不漏保护。
  证据：`draft-close-flow.ts` 新增 `MainCloseFacts`/`evaluateCloseOutcome` 与两条必选端口
  （`setClosing`、`readMainFacts`）——顺序固定为 closing → 查询 → 应答 → **最后**读槽；
  `draft-close-attach.ts` 把端口接到**真 registry**（`operations.setClosing` / `operations.slotState()`），
  `index.ts` 的 `operations` 提到模块作用域并穿进 `createWindow`。
  用例 `test/draft-close-flow.test.ts`「U4 5.1」9 条（真 registry 接线：询问期间新提交被拒且留
  notAccepted 封禁 / clean+占槽 ⇒ 只弹确认不关窗 / 顺序契约由 `h.events` 逐字钉住）。
  变异 5 处全捕获（读槽提前到查询前 1 红、摘掉置 closing 7 红、返回不解除 5 红、
  忽略 configurationBusy 2 红、忽略活跃槽 4 红）。
- [x] 5.2 合并原生确认文案与活跃事实，返回仅解除关闭/输入锁，保留 owner 槽；显式退出不伪造取消（<=2h）。验收：有草稿时关闭可返回或明确退出 / renderer 失联或应答无效仍有退出确认 / 无草稿的活跃操作也需确认。
  证据：`buildCloseConfirmText`（纯函数）把「草稿档 + 活跃操作 + 配置变更 + 会话丢失遗留」合进**一次**
  文案，退出按钮按档改文案；`test/draft-close-flow.test.ts`「U4 5.2」5 条 + 返回路径断言
  `registry` 槽仍 busy、登记仍 running；「明确退出不伪造取消」用例断言 quit 后 record 仍 `running`
  且 `activeId` 未变。变异 1 处捕获（摘掉活跃操作说明 ⇒ 文案用例判红）。
- [x] 5.3 补退出竞争及 U3 回归测试：新提交/settled/重载/慢应答/重复关闭/旧 sender（<=2h）。验收：慢响应降级后可取消并重新核对 / 重载不能用空仓库抹掉旧会话未知状态 / 旧会话伪造发送者和乱序消息不影响关闭 / 重复关闭取消和迟到应答不会重入。
  证据：U3 既有 4.4/4.5/4.6/4.7 全部**在新端口形状下原样复跑通过**（慢应答降级后重新核对、
  旧 requestId 被拒、伪造 sender 由 `draft-close-guard.test.ts` 承载）；新增「重载后 clean +
  main 仍占槽 ⇒ 合并确认」「连续关闭共享同一协商（closing 只置一次）」。
  desktop 全量 **103 文件 / 1822 用例 / 0 失败**。
- [x] 5.4 保持输入同步/焦点/系统退出边界，验证 closing 标记取消与异常清理（<=2h）。验收：退出输入锁保留已接收文字且不重放按键 / 系统会话结束不沿用普通退出承诺 / 草稿与操作合并且关闭竞争不漏保护。
  证据：`run()` 的 try/catch ⇒ 确认端口抛错时解除 closing + 取消挂起查询 + 发释放通知
  （否则 renderer 永久锁死），用例「确认端口抛错…」钉住；窗口销毁经
  `flow.onWindowClosed()` 解除 closing（源码契约断言 `flow?.onWindowClosed()`）。
  输入锁/焦点与系统会话结束面**未改动**（`draft-close-client.test.ts` 与 4.4 源码契约仍绿），
  真机复核归 §6.7。

## 6. 实机与受控故障验收

- [x] 6.1 用受控服务实测普通/隔离 create 成功与模型失败、重复提交及 ID 定位，核对 token 消费和文件数（<=2h）。验收：同 ID 重复请求只执行一次 / 普通和隔离创建失败保留 ID / 结果不可读不重执行且不锁配置。
  证据：`docs/reviews/2026-09-26-u4-61/README.md`（**7 tag / 58 检查 / 0 失败**，整跑一次通过）·
  采集 `apps/desktop/scripts/u4-61-cdp.cjs` · 批量驱动 `.workbuddy/u4/u4-61/run-all.cjs` ·
  逐条 `measurements.json` + 受控服务请求留痕 `mock-requests.jsonl` + 截图。
  判据三处同时核对（落盘 `meta.id` / 受控服务 `served` / traces 文件计数），全程经真桥接面带执行信封。
  ⚠️ 本轮坐实两条契约形状：重复提交的那条回 `OPERATION_DUPLICATED` **不带 `data`**（身份经 status/reconcile 取）；
  `ReconcileResult` 的终态在 `data.operation`，不存在 `data.state`（采集脚本首版据此写错断言、非产品缺陷）。
- [x] 6.2 实测普通/隔离 result 与 prompt，切页面后核对登记和草稿，回归授权/父链/轮末门禁（<=2h）。验收：所有入口实际使用同一适配器 / 提交快照独立于编辑器挂载 / 分叉在已知身份后异常仍可关联。
  证据：`docs/reviews/2026-09-26-u4-62/README.md`（**4 tag / 93 检查 / 0 失败**，整跑 4/4）·
  采集 `apps/desktop/scripts/u4-62-cdp.cjs` · 机制层抽出 `scripts/lib/u4-smoke-harness.cjs`（复用 U3 6.3 已验证的
  真会话/真 store/落盘哈希 helper，6.3–6.8 继续用）· 批量驱动 `.workbuddy/u4/u4-62/run-all.cjs` ·
  逐条 `<tag>-measurements.json` + 截图。
  在飞窗口由受控服务 `delayMs` 造出，切页与提交在同一次页内求值内完成 ⇒ 「卸载不换关联」是直接实测；
  登记只读 main `operations:status`，renderer 会话作同源对照。
  变异 2 处捕获（M-62A 界面门禁恒可提交 ⇒ 仅该条判红；M-62B 「核对状态」混入导航 ⇒ 仅该条判红），还原后复绿。
  ⚠️ 本轮两次判红都指向**判据口径**而非产品缺陷：`runLoop` 不抛 LLM 失败 ⇒ 失败 run 的登记是
  `settled / requestOutcome=returned / errorCode=null`，失败事实只在 trace 侧（`llm.call.error` + `run.event=errored`）；
  README §三 已把这条写成后续 tag 的纪律。
- [x] 6.3 实测 proxy 主动重发交错被动录制、无 key/写入失败，核对单请求身份与错误（<=2h）。验收：主动代理重发与被动录制交错 / 同 ID 重复请求只执行一次。
  证据：`docs/reviews/2026-09-26-u4-63/README.md`（**5 tag / 67 检查 / 0 失败**，整跑 5/5）·
  采集 `apps/desktop/scripts/u4-63-cdp.cjs`（`interleave` / `dup` / `nokey` / `write-fail` / `passive-no-slot`）·
  批量驱动 `.workbuddy/u4/u4-63/run-all.cjs`。
  身份只认 main `operations:status` 的 `runIds`，并与落盘 `meta.id` + 同窗被动 run 的 id **三方比对**；
  代理启停走 store 真动作、upstream 不带路径；外部请求从 harness 进程直连代理。
  写入失败注入 = 在飞窗口内把 `.rebaseagent/traces` **同卷 rename** 走（不删文件，`finally` 还原并核对份数）；
  🔴 第一版把改名放在请求发出前 ⇒ 命中的是 `PROXY_PARENT_INVALID`（读父失败），根本没走到录制写盘——
  **注入窗口的位置就是这支判据的命门**，README §三 已写成后续 tag 的纪律。
  变异：M-63A（写失败改成就借用父 id）⇒ 3 条判红；M-63B 首版（被动借用主动上下文）**无牙**
  （交错顺序里主动自己那份最后写入并覆盖 ⇒ 全绿），改注入端点层 `ctx.attachRunId(parentRunId)` 后
  `interleave` 3 条 + `dup` 2 条判红 ⇒ 又一课：**变异要注入在可观测路径上**。
  另两条实测形状：被动录制的 `meta.fork` 是 **null**（不是缺字段）；`servedBefore` 取在 seed 之后 ⇒ 交错窗期望增量是 +2 不是 +3。
  ⚠️ **口径待定（未改产品）**：端点规则是「带稳定领域码 ⇒ `requestOutcome=rejected`，未预期异常 ⇒ `failed`」，
  于是「响应已转发、录制写盘失败」也归 `rejected`——字面上更像"拒绝执行"。本轮按现状断言
  （登记仍可信：settled + 稳定码 + runIds 空 + 不借用别的 id）；若要改归 `failed` 属**改契约**，
  需回 proposal/design，已写进证据 README §三.4 与 §六待办。
- [x] 6.4 实测 A/B dry-run、实际部分失败与批次期间第二操作/配置拒绝，逐臂比对 trace（<=2h）。验收：A-B 一批占槽直到全部收尾 / A-B 部分失败保留各臂事实 / 只读入口和被动录制不占主动槽。
  证据：`docs/reviews/2026-09-26-u4-64/README.md`（**2 tag / 35 检查 / 0 失败**，整跑 2/2）·
  采集 `apps/desktop/scripts/u4-64-cdp.cjs`（`dry-run` / `partial-fail`）· 驱动 `.workbuddy/u4/u4-64/run-all.cjs`。
  ⚠️ **父本必须现造**：A/B 首期拒带副作用工具的父本（`MODEL_AB_TOOL_POLICY` 实测拒掉夹具 `normalRun`），
  且臂的调用次数 = 父本步数、受控服务回合按调用序消费 ⇒ 用「空工具表 + 单轮」纯对话父本，
  剧本才是确定的 `[父本, 臂 A 成功, 臂 B 503]`；父本当场核对 `config_hash` 与恰 1 次 `llm.call`。
  逐臂判据：登记 `arms[i].id` × 落盘 `meta.id` 一一对应，成功臂无 `llm.call.error`、
  失败臂确有 error 且 `run.event=errored`，两臂 id 互不相同；traces +2、服务 +2（无重试）。
  整批占槽由外部观察证：在飞期间 `activeOperationId` 指向本批、第二主动入口 `OPERATION_NOT_ACCEPTED`
  （登记 `notAccepted/rejection=busy`、零身份零请求零文件）、配置写被 main 拒而配置读照常。
  预览侧口径：`ModelAbResult` 的计划在 **`data.plan`**（不是 `data.arms`），`data.ids` 只数成功臂；
  登记侧臂事实是 `{index,id,outcome}` 另一套形状——两边都要断言。
  变异 2 处捕获：M-64A（`ids` 按「有 id」计 ⇒ 谎报 2 臂成功，1 条判红）、
  M-64B（摘掉 dryRun 误闯的早退 ⇒ 预览占了主动槽并登记 returned，2 条判红）。
- [ ] 6.5 注入响应丢失、status/reconcile 故障和两种到达顺序，验证 Unknown 可核对且无重发/错误解冻（<=2h）。验收：reconcile 先到封禁迟到提交 / 执行先到核对实际状态 / 状态通道不可用保持未知 / 核对终态只解冻对应修订。
- [ ] 6.6 实测同 main renderer reload 与真正 main 重启，记录 epoch/槽/真实调用次数和旧响应行为（<=2h）。验收：同 main 重载恢复操作 / 新 main 会话不伪造旧操作结局 / 乱序快照不回退新状态。
- [ ] 6.7 实测标题栏/Alt+F4/app.quit 下 dirty+running、clean+running、无应答及返回；验证输入/活跃任务保留（<=2h）。验收：无草稿的活跃操作也需确认 / 草稿与操作合并且关闭竞争不漏保护 / 退出输入锁保留已接收文字且不重放按键 / 重复关闭取消和迟到应答不会重入。
- [ ] 6.8 实测 800px、200% 缩放和键盘焦点；回归 U1 阅读/U2 文件/U3 草稿，验证状态/核对只读及源父兄弟/既有附件哈希不变（<=2h）。验收：操作入口在窄窗口和键盘下可达 / 核对结果只由用户明确打开 / 会话登记不泄漏输入和凭据 / 只读入口和被动录制不占主动槽。

## 7. 门禁与证据收口

- [ ] 7.1 运行包构建、replay/desktop 适用及全量测试、桌面 typecheck、Biome、OpenSpec strict 和 desktop build，核对测试文件实际执行（<=2h）。验收：本 change 全部场景的自动化断言；记录环境阻塞与真实失败，不以 build 替代 6.x。
- [ ] 7.2 编写 evidence-index，逐场景引用真实用例名/fixtures/实机截图与日志，核对七入口、所有 MODIFIED 保留场景及 U5 边界（<=2h）。验收：全部 delta scenarios 有可复核证据；未验证项保持待办，不声称完整执行结果闭环、自动清理、取消或发布完成，归档另行处理。
