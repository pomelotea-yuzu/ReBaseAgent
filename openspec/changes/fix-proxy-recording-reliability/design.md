# 设计：代理事实更新与失败录制

## D1. 被动变化通知独立于主动登记

operations 只在有主动操作时轮询，不能作为被动外部请求唯一更新来源。新增封闭的只读 `proxy:changed` 订阅及预加载取消订阅接口，所有载荷经 shared schema 校验，只携带 main 会话 epoch、单调 revision 与受控变化类别（records/status）。通知不包含 key、headers、messages 或错误体，不创建 operation、不占执行槽。

成功 recorder.write 返回后推进记录 revision；失败不宣告新 run 可用。请求捕获有效 Authorization 后推进状态 revision，监听启停/恢复完成和失败同样推进。事件处理不得抛错影响转发。renderer 订阅先于首次快照读取，刷新复用已有 loadRuns 的在途合并与尾随补发，保留筛选、选择、滚动、详情和草稿，不自动导航到外部新记录。

在 proxy:status 的严格载荷中回传当前 epoch/revision 和 recordsRevision，首次加载及窗口重新激活时只读核对 revisions，补齐订阅前或失焦期间的变化；新 renderer 不用旧会话 revision 拒绝新 main。renderer 按会话及请求代次守卫迟到响应。禁止高频扫描全部 traces 或依赖页面切换强制刷新。

## D2. 代理状态与确认绑定

ProxyState 继续分别表达保存 enabled 与真实 running；增加恢复阶段、受控 failure，以及仅内存的 keyCaptureRevision。后者是捕获次数版本，不是 key 指纹；同样 hasKey=true 的 key 更换也会作废旧确认，不回传凭据值。状态回读合并在途请求；messages 初次打开、目标切换、从录制返回、窗口激活均可核对，依赖捕获通知更新当前打开页面。回读期间门禁显示“状态核对中”，不把未知判为未捕获。

确认绑定监听/上游配置、凭据捕获版本、当前源身份和草稿修订等语义值；同一状态的重复读取不能清掉用户已核对的确认，仅代次推进也不应造成重绘风暴。失败/未知、凭据轮换、监听失效或配置变化撤销旧确认，保留原始输入。proxy:fork 提交携带经严格 schema 校验的预期捕获版本与代理配置版本，纳入既有不可变业务快照/指纹；main 在副作用前核对当前版本，不匹配则受控拒绝并要求重新核对，renderer 的 fresh 状态不替代 main 检查。

## D3. 启动恢复诊断

保留 index.ts 的 autoStart 与配置变更互斥。autoStart 按 saved.enabled 尝试一次；失败只保留脱敏、限长的可读诊断和稳定错误类别，不影响应用历史阅读。状态明确 recovering/running/stopped/failed，失败不伪造 enabled 回滚。恢复成功事件保证 renderer 不停留在启动前 stopped；顶栏给简短状态，录制页给原因和显式保存并应用重试，状态重读本身不启动监听。

不添加后台无穷重试，不恢复 key，不调用上游验证连接。多实例抢端口属于可见失败场景。

能力分层：llm-proxy delta 定义保存意图与真实监听的生命周期、只读状态及失败事实；desktop-ui delta 的“代理启动恢复结果就近可见”单独定义顶栏/录制工作区的呈现与重读/显式应用入口。两层场景分别验收，归档后 UI 要求不会只留在代理 spec。

## D4. 失败 llm.call 的数据流

给 ProxyRecording 增加可选的结构化 error（message/status），HTTP 非 2xx 时记录实际 upstream.status；fetch 连接异常不写 status，客户端本地生成的 502 不冒充上游状态码。成功无 error。错误落盘由 recorder 写现有 v1 agent.step(n=1) 与失败 llm.call：request 保留实际结构化请求，response 为既有失败占位（空正文、空工具调用、零 usage/ttft），顶层 error 表达诊断，最后写 stopped/error。

该 agent.step 只是单代理请求分组，不代表执行了外部 Agent 的一轮。错误消息不进入 request.messages 或 response.content，不拼入可续跑上下文。原始错误响应只用于原样转发；摘要优先抽取 provider 的 error.message/受控字段，对非 JSON 给有限文本摘要或“非结构化上游错误”。读取诊断不额外制造录制或重发。

在包层返回 error 前脱敏并限长：使用本请求 Authorization、其 token 以及当时最近捕获凭据的字面量，覆盖通用 Authorization/Bearer/URL-userinfo；先脱敏再截断，采用现有 DIAGNOSTIC_MAX_LENGTH 的 1024 字符上限。采用内部纯 helper 保持 llm-proxy 零 Electron/零 agent-loop 依赖；desktop 的集成测试同时导入 agent-loop 既有常量与 llm-proxy 导出的诊断上限，断言数值相等，并对同组脱敏边界输入比较输出行为，避免单边改动漂移，不为测试增加包层运行时依赖。不要求服务商自脱敏。main 写入及启动异常再次应用现有诊断兜底。error 只允许 message/status，不存 headers、完整响应体、stack、异常对象或 upstream 地址。异常解码/摘要失败也给非空受控 fallback，转发字节保持不变。

详情概览复用自有 span/leafSpanIds 判据，显示短错误摘要、真实状态码和“查看失败调用”；该 span 的 usage/ttft 标为占位未知，不能宣称零成本或成功输出。旧 meta+event 文件继续缺失提示。

失败父本编辑重发采用 review 的方案 A。reader 的 status="completed" 是已有终止记录、已封存的结构状态，不代表模型请求成功；stopped/error 的新代理 run 同样已封存。它若保留完整自有 llm.call.request，允许修改 messages、按当前监听/凭据版本核对并显式提交，沿用原 model/tools/params，子 run 的 parent 指向该失败父本、fork.at_span 指向其自有调用、edit.field="messages"。不要求 config_hash，也不扩大配置型 replay 能力。

未修改 messages 即使凭据已更新仍被空 fork 防线拒绝；本次不提供原样一键重试。旧 meta+event 失败文件没有自有调用，仍不可重发；crashed/未封存、缺失/损坏来源或请求、当前监听/凭据不可用、版本失配继续被拒绝。配置指纹 requirement 中“不含 llm.call span 的 run 被拒”仍适用于旧/不完整记录，不再作为所有失败 run 的否定条件。

新请求成功或再次失败都写自己的新子 run，不改父本，不自动重试。再次失败的子 run 记录自己的 error 和 stopped/error，并保留本次可信 ID 供结果核实；“提交已产出记录”不冒充“模型请求成功”。原失败父本的草稿不会因为失败结果被清除，其收尾沿用既有草稿修订规则。

recorder.write 失败时，被动转发仍保护客户端响应，但不发送成功记录 revision；主动重发由请求局部上下文返回 PROXY_RECORDING_WRITE_FAILED，结果区显示“响应已转发，本次记录写入失败”并保留草稿，不返回其他请求 ID，也不标本次录制成功。

## D5. 可见编辑器塌缩调查及恢复

先复现反馈路径并登记“可见宿主 + 祖先尺寸/样式 + 活动 editor + 目标草稿键 + 加载状态”。Monaco 隐藏 helper 0×0 不计失败。真实 MoveWindow/最大化/还原与 CDP Emulation 分开记录，后者不代替人工视口验收。

按证据修复祖先布局、初始化或观察生命周期。可见容器获得非零空间时重新 layout；必须重挂时复用原草稿/model/view state，清理 observer，不循环重建。加载/恢复失败显示明确占位和本地恢复动作，不以重启应用为唯一出口，不自动提交或清空。一般编辑区自适应布局由另一个 change 负责；先合入本项时约定公共 Monaco 包装的回调/尺寸接口，后续布局变更必须重跑恢复场景。

## D6. 风险与实施顺序

通知突发会导致 IO 风暴，靠 revision、在途合并和尾随刷新控制；IPC 迟到会覆盖最新凭据事实，靠会话与请求代次控制。新失败 span 改变调用数投影，需验证指标不会把占位解读为实测零。先实现同步与状态，随后失败录制与展示，再定位恢复问题并留回归。另一 change 只新增界面要求，不替换本 change 的 requirement；两者可以独立验收，但修改同一组件时须复核合并。

⚠️ 上面「IO 风暴靠 revision、在途合并和尾随刷新控制」的实现归属已经核实并钉住：
**三道防线全在 renderer 侧**，main 侧不做同tick 合并。N 条通知的代价是至多
「一次在飞 + 一次尾随」列表读取（`loadRuns` 的既有语义），而不是 N 次全量 traces 扫描；
main 侧再加一层微任务合并并不会让列表读取更少，却会让"落盘即通知"多一个事件循环的
延迟，并把 `changes` 的语义从"这次变了什么"变成"这一 tick 变了什么"。

## D7.实施期核实结论（tasks 1.1–1.4，2026-10-07）

提案是假设，代码是事实。以下每条都用真实代码核实过，实现按此落地；**与提案不一致处已标注**。

### 已核实的签名事实

- `ProxyState` 原先只有 5 个字段（`enabled`/`running`/`port`/`upstreamBaseUrl`/`hasKey`）。
- `ProxyStateSchema` 只有 store 两处消费，**无** `.extend()` / `.partial()` 消费者 ⇒
  加三个必填版本字段是安全的，不会连带打断其他构造点。
- `ProxyManager.status()` 是**同步**方法（读settings + 内存字段），可安全当作补读快照。
- `ProxyManager.autoStart()` 原先是 `catch {}` 静默吞掉启动失败。
- `preload-surface.test.ts` 的桥接面是**封闭白名单** ⇒ 新增 `onProxyChanged`
  必须显式登记，否则该测试必然红（这是预期的强制点，不是回归）。
- `loadRuns` 已有在途合并 + 尾随补发，**无需重写**；刷新一律走它，不得旁路 `refreshRunsOnce`
  （旁路那次请求无人递减在途计数，计数器永久残留）。
- `App.tsx` 挂载时 `loadRuns` 与 `loadProxyStatus` 并行且**原本无订阅**。

### 与提案不一致 / 提案未覆盖之处（已按代码事实定案）

1. **🔴 提案未覆盖的实现缺口**：key 的写入发生在 `llm-proxy` 包内
   （`keyStore.lastKey = auth`），main侧拿不到"何时发生了捕获"这一事实。
   D1 要求的"捕获后推进状态 revision"因此**无法只靠桌面侧实现**。
   定案：在 `ProxyHandlerOptions` 新增可选回调 `onAuthorizationCaptured`，
   捕获点调用；回调抛错被包内try/catch 隔离（不改"凭据已捕获"这一事实、不回滚已写入的 key）。
2. **合并窗口的归属**：D6 的IO 风暴防线按 renderer 侧实现（见 D6 末尾补记），
   `onChange` 的文档注释已按此改写（原注释承诺了不存在的"同 tick 合并"）。
3. **🔴 读失败时"保守补刷"的实现坑**：`loadProxyStatus` 失败时游标**不前进**，
   于是 epoch 仍与失焦前相同 ⇒ 若直接把游标交给 `shouldReconcileOnActivate`，
   它会走"无落后"分支返回 `false`，把"这次什么都没读到"误判成"没有变化"，
   **失焦期间漏掉的落盘永远补不上**。定案：`reconcileProxyFacts` 在读取失败时
   把交给判据的 epoch 置 `null`，显式表达"本次未取得任何版本事实"。
   该行为由 `proxy-change-store.test.ts` 的「状态读取失败 ⇒ 保守补刷」钉住。
4. **首次列表读取失败不标"未更新"**：`resolveRefreshFailure` 的口径是"有过成功加载才标
   stale"。测试断言"刷新失败沿用旧列表"必须先造一次成功加载，否则测的是首次失败分支。

### 测试基础设施的两条硬约束（本轮实际踩到）

- **测试目录不在 tsconfig `include` 内** ⇒ `pnpm typecheck` 绿**不覆盖** `apps/desktop/test/`。
  `ProxyStateSchema` 加必填字段后，27 处手写 `{...}` 夹具**静默**过不了 schema，
  症状是 `proxy` 被置 `null`、`recordingStatusReadFailed` 变 true——离病因很远。
  定案：新增 `test/helpers/proxy-state-fixture.ts` 共享工厂，新增 `ProxyState` 字段时只改那里。
- **`RunSummarySchema` 有 14 个必填字段**，少一个就被 `ListRunsDataSchema.safeParse` 静默拒掉
  （症状同样是 `runs` 变空+ 校验失败文案）。本轮新增的列表夹具集中在测试文件内的
  `runSummary()` 一处，同理不得散落字面量。

### 审阅项 → 处理对照

| 审阅项 | 处理 | 落点 |
| --- | --- | --- |
| 通知只含受控元信息 | 载荷 schema 键集合封闭；测试断言通知文本不含 key/messages/系统提示 | `proxy-change-notify.test.ts`、`proxy-change-decisions.test.ts` |
| 写入失败不报告新记录 | `recorder.write` 抛错分支不推进 `recordsRevision`、不发 records 通知，原样抛出由包层保护转发 | `proxy-manager.ts:248`；变异验证（故意加 `notifyRecord()` ⇒ 2 条用例红） |
| 零主动登记 / 零自动请求 | 通知路径不碰 `operations:status`/`proxy:fork`/`runs:create`/`model:ab`；不改动 operation 会话对象 | `proxy-change-store.test.ts`「零主动登记 / 零自动请求」 |
| 订阅先于首读 | `App.tsx` 挂载 effect 首行 `ensureProxyChangeSubscription()`；广播装配先于 `autoStart` | `App.tsx:97`、`main/index.ts` |
| 突发 IO | renderer 侧三道防线（游标去重 + `loadRuns` 在途合并 + 尾随补发），实测 N 条通知 ⇒ 2 次列表读取 | `proxy-change-store.test.ts`「在飞期间的 N 条通知」 |
| 失焦补读 | 窗口 `focus` ⇒ `reconcileProxyFacts`；读取失败按 D7.3 保守补刷 | `App.tsx:122`、`store.ts` |
| 订阅泄漏 | `releaseProxyChangeSubscription` 幂等复位；测试 `beforeEach` 强制复位防跨用例污染 | `store.ts`、`proxy-change-store.test.ts` |

## D8. 实施期核实结论（task 2.1，2026-10-07）

D2 写了「状态回读合并在途请求」和「按会话及请求代次守卫迟到响应」。前半句可直接实现；
**后半句拆开后只有一半成立**，以下按代码事实定案。

### 1. 🔴 「请求代次守卫」是死代码，已移除

先按字面实现了 `isLatestStatusRead(state, token)`（token 不匹配 ⇒ 拒绝采纳）。**变异验证把它
替换成 `if (false)` 后，`proxy-status-store.test.ts` 14 条用例全部仍然通过** —— 证明在合并
调度已经存在的前提下，任一时刻至多一个读取在飞，这个守卫从未拒绝过任何响应。

定案：**删除** `isLatestStatusRead` 及其测试块；`ProxyStatusReadState.generation` 保留，但它的
作用降级为「可诊断的读取代次锚点」，不是并发防线。两道真实防线是：

| 防线 | 拦什么 | 落点 |
| --- | --- | --- |
| 在途合并（`beginStatusRead`/`settleStatusRead`） | 同一时刻多个并发 `proxy:status` 读取 | `lib/proxy-status-read.ts` |
| 快照新旧守卫（`acceptProxySnapshot`） | 响应乱序：旧 revision/recordsRevision 晚到 | 同上 |

`acceptProxySnapshot` 的守卫条件是 `revision` **与** `recordsRevision` 两个维度都比。当前 main
总是同时推进两者，只比 `revision` 时「recordsRevision 单独落后」这一路会漏过（首轮测试真的红了）。
额外一个维度当前成本为零，挡住的是「将来某一侧被单独重置」这类静默回退，故保留。

### 2. 合并带来语义破裂，必须配一道「静默门」

合并的直接后果是：`await loadProxyStatus()` 返回时**可能什么都没读**（被合并的调用立即返回）。
对「读到最新事实才判门禁」的调用方，这等于假成功。定案：模块级 `settledProxyStatusRead()`
等待者集合 + `notifyProxyStatusSettled()`，仅在**没有尾随补发**时唤醒（有待发则等下一次结算）。
`reconcileProxyFacts`（判是否补刷列表）与新增的 `reconcileProxyGate`（只刷门禁事实）都过这道门。
`ProxyStatusReadState.inFlight > 0` 供 UI 派生「核对中」。

两个动作刻意分开：`reconcileProxyFacts` 会连带触发列表刷新，`reconcileProxyGate` 只读状态。
打开 messages 用后者 —— 打开编辑器不该顺带重扫列表。

### 3. 🔴 fire-and-forget 遇通道抛错 ⇒ 8 处未处理拒绝

接线到 `openMessagesWorkspace` / `returnToAuxSource` 后，全量测试冒出 8 处
`TypeError: api.proxyStatus is not a function`。这不是测试脚手架问题：`loadProxyStatus` 只处理
「通道返回失败信封」，没处理**通道自身抛错**，而调用点是 `void get().reconcileProxyGate()` ——
抛出去即未处理拒绝。定案：内层 `try/catch` 把异常转成
`{ ok: false, error: { code: "PROXY_STATUS_UNAVAILABLE", message } }`，与「读到失败信封」走**完全相同**
的失败路径（`proxy=null`、`recordingStatusReadFailed=true`、游标不前进），并补回归用例钉住。
先修生产代码而不是给夹具打桩。

### 4. 「核对中」与「状态未知」必须分措辞

spec 要求「回读期间显示核对中……不把未知判为未捕获」。实现上这是**两个不同分支**：
`proxyRunning === undefined` 且 `inFlight > 0` ⇒ 「正在核对代理当前状态…」；`inFlight === 0`
⇒ 「代理状态未知（尚未读取或读取失败）」。两者都返回 `recordingEntry: true` 阻止重发，但都不能说成
「未捕获」——那会把「还没读」和「读过且确实没有」混为一谈。`MessagesForkEditor` 另有可见提示
（`data-messages-proxy-checking`）。

### 5. 测试脚手架的两处顺序约束（本轮实际踩到）

- **`stallStatus()` 必须最后调用**：它包装当前 `proxyStatusImpl`；先调用再改实现会把包装器连同
  捕获的旧实现一起覆盖掉，制造出并不存在的响应乱序。
- **store 在导入时即捕获 `api` 引用**：事后替换 `window.api` 无效。要断言「状态读取被合并时
  列表读取不受影响」，必须引入可变 `listRunsImpl` 间接层，不能直接改 `window.api.runs.list`。

### 6. 本轮质量基线

typecheck 双0 绿；`biome check apps packages scripts` 584 文件 0 错；`git diff --check` 绿；
desktop 全量 **178 文件 / 2866 用例全绿、0 未处理错误**（基线 176/2835，+2 文件 +31 用例）。

## D9. 实施期核实结论（tasks 2.2a–2.2b，2026-10-07）

D2 写了「确认绑定监听/上游配置、凭据捕获版本…」。落地时有三处与提案字面不同。

### 1. 🔴 「捕获版本」不能复用 `revision`，必须是独立的 `keyCaptureRevision`

`revision` 在**监听启停、恢复完成/失败**时也推进。若拿它当凭据判据，「开关一次代理」会
作废所有执行确认——而凭据压根没变。定案：新增 `ProxyState.keyCaptureRevision`（仅内存的
捕获次数，捕获/更换时推进），`revision` 保持原义。它**不是 key 指纹、不含 key material、
不持久化**（重启后 main 不恢复 key，`hasKey` 同时为 false，版本回 0 是事实而非静默回退）。

`settingsStampOf` 相应新增两个维度：代理目标（`upstreamBaseUrl#port`）与捕获版本。

### 2. 🔴 版本核对必须比 `status()` 而不是 `settings.loadProxy()`

`status().port` 在运行中返回**实际监听端口**，而保存值可能是 `0`（由系统分配）或旧端口
——两者在**正常运行时就不相等**。第一版拿保存值比，结果每一次正常重发都被误判成
`PROXY_CONFIG_CHANGED`（测试直接红）。定案：与 renderer 同源，比 `this.status()`。

失配检查的位置也定死了：放在**读父本之前**。它是纯内存比较，不碰磁盘也不碰上游，
顺带不泄露父本 id 是否存在。代价是它排在 `PROXY_NO_KEY` / `PROXY_PARENT_INVALID`
**之前**，所以测试这些门禁的用例必须带上与当刻一致的预期值，否则测到的会是版本失配
而不是想测的那一层（这条已写进 `proxy.test.ts` 与 `controlled-proxy.test.ts` 的注释）。

### 3. 🔴 fork 自身会推进捕获版本 ⇒ 同一个预期不能用于两笔并发提交

`proxy:fork` 走的是与被动录制**同一条**转发+录制路径，会再次捕获 Authorization ⇒
推进捕获版本。于是「两笔真并发 fork 都拿 `withParent` 时取的同一份预期」里，第二笔会被
正确地拒掉。`proxy-fork-identity.test.ts` 的并发用例因此改为**每笔在发起那一刻重取事实**——
那两条要测的是身份隔离，不是版本竞争。这不是绕过门禁，是把两件事分开测。

### 4. 测试夹具的一条硬约束（2.2a踩到）

伪造 main 事实时，`revision` 与 `keyCaptureRevision` 必须**自洽**。第一版只推进捕获版本、
把 `revision` 留在 0，于是通知声明 `revision=9` 而状态响应 `revision=0` —— 2.1 的快照
新旧守卫**正确地**把它判成"迟到的旧快照"整份丢弃，症状是"确认怎么没被撤销"。
拦住你的不是 bug，是你自己造的矛盾。

### 5. 本轮质量基线

typecheck 双 0 绿；`biome check apps packages scripts` 587 文件 0 错；`git diff --check` 绿；
desktop 全量 **181 文件 / 2881 用例**（2.2a 基线 180/2884，2.2b 新增 `proxy-fork-version-race`
6 条并把 `proxy.test.ts` 等 7 处调用点补齐预期字段）。变异验证：拿掉捕获版本 ⇒ 精确 1 条红；
拿掉两道 main 侧版本核对 ⇒ 5 条红、只剩「正常路径」那条。

## D10. 实施期核实结论（task 2.3a，2026-10-07）

### 1. 🔴 端口占用的错误文案是中文 ⇒ 只按`EADDRINUSE` 归类会把最常见的失败错判

`packages/llm-proxy/src/server.ts:75` 收到 `EADDRINUSE` 后**把错误码翻成中文**再抛：

```
端口 11609 已被占用，无法启动录制代理（可在设置中换端口）
```

错误码到这里已经丢失。`classifyRecoveryFailure` 第一版只认英文
（`EADDRINUSE` / `address already in use`），于是端口占用被判成 `LISTEN_FAILED`，
界面会给出一句"启动失败"却不说"换端口"——恰好丢掉用户唯一能做的事。
定案：正则同时保留英文错误码措辞与中文译法（`已被占用` / `端口占用` / `端口已被使用`）。

这条不是"顺手兼容一下"：**文案翻译层会吃掉错误码**，凡是跨层做失败归类的判据，
都必须按**实际抛出的字符串**写，不能按上游的 `code` 想当然地写。这是通用教训。

### 2. `autoStart` 与 `toggle` 必须共用一份 `attemptListen`

第一版给两者各写了一份"起监听 + 记阶段"，结果"恢复失败有诊断、显式重试没诊断"。
语义上这两件事**是同一件**：按当前保存的配置试一次监听。合并成 `attemptListen` 后，
界面才能对「启动恢复」与「应用配置重试」用同一套阶段呈现，不会出现两套措辞。

顺带定死两条：`toggle` 里**必须 `await`**（返回契约是"返回时监听已就绪"，漏 await 会让
调用方拿着 `status().port` 去连而实际还没 listen ⇒ ECONNREFUSED，且失败重抛变成无人
处理的 rejection）；`autoStart` **刻意吞掉**异常（恢复失败不阻断应用启动），
但阶段与诊断由 `attemptListen` 落好，界面不需要靠 catch 分支拼文案。

### 3. 🔴 `saveProxy({port: 0})` 会被 `loadProxy()` 归一成默认 18787

`settings.ts:152` 要求端口落在 1..65535，非法值回退 `PROXY_DEFAULTS.port = 18787`。
所以测试里**不能**用 `port: 0` 表达"随便给个端口"——`autoStart` 走的是
`loadProxy()` 读回来的值，每条用例会去抢同一个固定端口 18787。这解释了本轮第一批
失败里"保存停用"那条为何诡异地拿到了 200：它其实连的是 18787 上别的东西。
定案：需要"应有端口可用"的用例统一走 `freePort()`（借一个系统分配的端口再放掉）。

配套的第二条本机事实：本机 `HTTP_PROXY=http://127.0.0.1:9088` **穿透 localhost**，
`fetch` 到无人监听的端口也可能被代理接管并返回响应体（实测拿到过 400 JSON）。
因此判"端口到底有没有人监听"必须用 `node:net` 直连看 ECONNREFUSED，**不能用 `fetch`**。
（既有的 `proxy-change-notify.test.ts` 用 `fetch` 打真实监听端口是可以的——那里要验的是
"代理转发是否成功"，不是"端口是否被占用"。）

### 4. 恢复阶段刻意不持久化

`recovery` / `recoveryFailure` 只描述"本次 main 生命周期内那次启动尝试"。持久化它会在
下次启动显示一个属于上一次进程的失败原因——那正是"过期诊断"，比不显示更糟。
阶段每次启动从 `stopped` 重走一遍。同理**失败不改`enabled`**：`enabled` 是用户保存的
意图，把它改成 false 等于把"我想开着"悄悄换成"用户关了"。变异验证已钉住这条。

### 5. 本轮质量基线

typecheck 双 0绿；`biome check apps packages scripts` 588 文件 0 错；
desktop 全量 **182 文件 / 2900 用例**全绿、0 未处理错误（2.2b 基线 181/2890，
新增 `proxy-recovery-lifecycle.test.ts` 10 条）。变异验证三处：失败分类恒 false ⇒ 1 条红；
失败时不写诊断 ⇒ 4 条红；失败回滚 `enabled` ⇒ 1 条红。

## D11. 实施期核实结论（task 2.3b，2026-10-07）

### 1. 🔴 源码级接线断言钉「符号出现」必然假绿，必须钉「数据流」

U1 已经吃过三次"组件测得绿但没挂上"的亏，所以 2.3b 的顶栏接线走了源码级契约
（`global-bar-recovery-wiring.test.ts`）。第一版断言写成"源码里出现了
`proxyRecoveryView` / `needsRecordingEntry` 这些字面量"——**变异验证时把整个调用
换成内联字面量`{ phase: …, needsRecordingEntry: false }`，6 条全绿**。
函数名还留在 import 与类型位置上，实现却已经与判据脱钩。

定案：源码级断言要钉**结果被谁消费**，不钉符号是否出现。实际用的三条：
- `const view = proxyRecoveryView(...)` 的返回值被渲染消费；
- `{view.needsRecordingEntry ? (` —— 入口的存在条件读这个变量；
- `proxyPhaseDotClass(view.phase)` 与 `view.phase === "failed" → border-red-300`
  —— 颜色与边框跟随同一个变量。换成内联字面量这三条同时红。

推论：**凡是"某处必须用某个共享判据"的断言，"文件里提到过它"不构成证据**。

### 2. 顶栏与录制页必须共用一份措辞源

原先录制页自己写 `proxy.running ? … : "未监听（启用不等于监听成功）"`、顶栏自己写
`代理 已停`。两处各写一套，恢复失败时必然出现"顶栏说失败、录制页说未监听但不说原因"，
而用户正是靠这两处判断要不要改端口。定案：新增 `lib/proxy-recovery-view.ts`
作为唯一派生点（`proxyRecoveryView` + `proxyPhaseDotClass`），两边都从它取值。

四条措辞判据（写进该文件头注释，因为它们是"为什么不是另一句话"的根据）：
1. 保存启用 ≠ 真实监听：失败时两行分别说"已启用"与"未监听"，不混成一句；
2. 失败不说成已停用：2.3a 刻意不回滚 `enabled`，文案若说"已停用"就是撒谎；
3. 恢复中不是停止：否则启动那几秒界面会闪一个"已停"，正好停在用户最该知道真相的时刻；
4. 诊断只在有诊断时出现，没有就明说"未留下受控诊断"，不编一个。

### 3. 失败处置区：两个按钮并排，且各带作用说明

delta 要求「状态重读与显式应用重试区分」。做法不是靠按钮位置或颜色，而是让两个
按钮的 `title` 各自写明作用：「重读状态」= 不启动监听；「保存并应用」= 再次尝试监听。
用户点完"重读"发现代理没起来时，才不会以为按钮坏了。
恢复中**不给**应用按钮（正在起，等它自己出结果），只给只读重读。

### 4. 既有测试的字面量工厂要跟着补字段

`recording-workspace-view.test.tsx` 的 `proxyState` 是手写字面量 + `as ProxyState`
断言。`recovery` / `recoveryFailure` 漏掉时它们是 `undefined`，于是
`recovery === "recovering"` 静默为 false——**判据被绕过而测试仍绿**。
已在该文件头写明这条纪律。凡是手写字面量 + 类型断言的测试工厂，新增 `ProxyState`
字段时都要显式补上。

### 5. 本轮质量基线

typecheck 双 0 绿；`biome check apps packages scripts` 591 文件 0 错；`git diff --check` 绿；
desktop 全量 **184 文件 / 2922 用例**全绿、0 未处理错误（2.3a 基线 182/2900，
新增 `proxy-recovery-view.test.tsx` 14 条 + `global-bar-recovery-wiring.test.ts` 8 条）。
变异验证：顶栏脱离共用判据 ⇒ 接线契约红（第一版断言假绿已修正并复验）。
