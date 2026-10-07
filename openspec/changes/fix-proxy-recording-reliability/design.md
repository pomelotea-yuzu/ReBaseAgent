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
