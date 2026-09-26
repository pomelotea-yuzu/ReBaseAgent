# U4 `add-desktop-operation-tracking` 场景 → 证据索引

> 任务 7.2 的产出。范围 = 本 change 的四份 spec delta：
> **12 requirements / 63 scenarios** = `desktop-ui`（5 ADDED + 4 MODIFIED / 52 场景）+
> `replay`（1 ADDED / 4）+ `prompt-replay`（1 ADDED / 3）+ `model-experiments`（1 ADDED / 4）。
> 其中 **40 条 ADDED**、**23 条 MODIFIED**（16 条为**既有场景逐字保留**、7 条为本 change 新增）。
>
> **本索引不自动归档、不发版、不是验收放行凭据**——放行由 owner 拍板（tasks 7.2 明写"归档另行处理"）。
> 证据只到契约级、或实机不可注入的项**显式标注分层**，不以"已通过"冒充。

## 怎么读这份表

- **用例名逐字取自 `it(...)` 标题**（不写行号、不把 describe 名拼进用例名）；引用格式 `测试文件 › 用例名`。
  全部引用经机器回查（见「引用回查」节），不靠"我核对过了"。
- **单测** = vitest 用例；**契约** = 源码级接线断言（vitest 内读源码字符串）；**实机** = CDP / Win32 / UIA tag。
- **实机 tag 引用格式** `u4-6x-cdp.cjs --tag=NAME n/m`，`n/m` = 通过/总检查数。
  采集脚本：`apps/desktop/scripts/u4-6{1..8}-cdp.cjs`；机制层公共库 `apps/desktop/scripts/lib/u4-smoke-harness.cjs`（6.2 起，判据不在库里）；
  系统级通道 `apps/desktop/scripts/lib/u3-64-winops.ps1`（`SC_CLOSE` / 真 Alt+F4 / 真 `#32770` UIA 读写 / `CopyFromScreen` 全屏截取）；
  `app.quit` 走 dev-only 哨兵 `REBASEAGENT_SMOKE_QUIT_FILE`（U3 6.4 起，本 change 未新增通道）。
- **受控执行** = `apps/desktop/scripts/mock-llm-server.cjs`（剧本制 OpenAI 兼容服务：`served()` 逐条计数、
  `delayMs` 造真在飞、`mode:fail` 造失败）⇒ "真的执行过 / 确实零执行"两面都由它立证，零付费。
- **实机证据目录**：`docs/reviews/2026-09-26-u4-6{1,2,3,4,5}/README.md`、`docs/reviews/2026-09-27-u4-6{6,7,8}/README.md`；
  入库截图共 **30 张**（6.2=4、6.3=5、6.4=2、6.5=6、6.6=4、6.7=6、6.8=3）。
  ⚠️ **6.1 的截图与逐条 `measurements.json` 只在 gitignored `.workbuddy/u4/u4-61/`（未入库）**，README 已如实标注"`.png` 按仓库约定不入库"。
  其余各批原始 JSON 同样落 `.workbuddy/u4/u4-6x/`（gitignored），**终态以 README 表格 + 本索引引用数字为准**。
- **夹具**：`.workbuddy/u3/u3-61/manifest.json`（`normalRun=run_mughwjk4` / `isoRoot=run_mughyp60_txvlev` /
  `proxyRun=run_mughwwom_jlgs` 都是真引擎产出的真 run，文件仍在 `.rebaseagent/traces/`）。
- **变异** = 「注入一处破坏 ⇒ 确认判红 ⇒ 还原复绿」，是"判据有牙"的证据、不是测试用例。
  §3 十处 + §4 二十六处 + §5 七处 = 单元层 **43 处**（台账见 `HANDOFF.md` §十），实机层 6.2–6.8 共 **18 处**
  （M-62A/B、M-63A/B、M-64A/B、M-65A/B、M-66A…E、M-67A/B/C + M-AO 单测反证）。

## 汇总

| requirement | 层 | 场景 | 已覆盖 | 未验证 | 主要证据层 |
| --- | --- | --- | --- | --- | --- |
| A1 主动执行由 main 会话身份登记和去重 | ADDED | 6 | 6 | 0 | 单测（§1 四件 + 矩阵）+ 实机 6.1–6.4/6.6/6.8 |
| A2 main 原子执行槽覆盖所有主动编排 | ADDED | 6 | 6 | 0 | 单测 + 实机 6.4/6.8 |
| A3 操作状态可查询且未知请求可原子核对 | ADDED | 8 | 8 | 0 | 单测 + 实机 6.5/6.6；⚠️ 2 条实机不可注入 ⇒ 归 §4 |
| A4 操作关联使用编排产出的真实运行身份 | ADDED | 5 | 5 | 0 | 包层单测 + 端点单测 + 实机 6.1–6.4 |
| A5 现有界面消费统一操作事实 | ADDED | 4 | 4 | 0 | 单测 + 契约 + 实机 6.2/6.8 |
| M1 渲染进程无文件权限且跨进程数据经校验 | MODIFIED | 3 | 3 | 0 | 2 保留 + 1 新增；M-AO 已补真反证（单测层） |
| M2 运行配置经 safeStorage 持久化 | MODIFIED | 5 | 5 | 0 | 2 保留 + 3 新增（main 判锁 + 实机 6.1/6.4/6.7） |
| M3 提交绑定草稿修订且响应不清除草稿 | MODIFIED | 4 | 4 | 0 | 3 保留 + 1 新增（含 §6.5 真实缺陷修复） |
| M4 主进程核对草稿后决定常规退出 | MODIFIED | 11 | 11 | 0 | 9 保留（U3 证据）+ 2 新增（实机 6.7） |
| R1 重跑编排可观察真实运行身份（replay） | ADDED | 4 | 4 | 0 | 包层单测 + 实机 6.1/6.2 |
| P1 启动上下文编排可观察真实运行身份 | ADDED | 3 | 3 | 0 | 包层单测 + 实机 6.2 |
| E1 实验编排暴露各臂真实身份且保留失败关联 | ADDED | 4 | 4 | 0 | 包层单测 + 实机 6.4 |
| **合计** | — | **63** | **63** | **0** | — |

> 四条**诚实边界**（不改上表计数，逐条落在下方「已知限制」）：
> ① `状态通道不可用保持未知`、`非法操作响应不能解除门禁` 的**注入面实机不可达**（`window.api` 属性 `writable/configurable:false`）⇒ 只由 §4 单测承载；
> ② 跨 epoch 的**在飞**关联真机凑不出前提（renderer 随 main 一起死）⇒ 只由 §4 承载；
> ③ 代理交错的"被动同窗落盘 ⇒ 主动身份不变"在 **ProxyManager 层仍无有牙反证**（6.3 M-63B 教训），端点层有；
> ④ `configurationBusy` 合并档的关闭确认文案未实机诱发（造不出确定性的长配置在飞窗口）⇒ 由 §5 单测 + M-CL4 承载。

## 差集核对

**MODIFIED 是"整段替换"语义** ⇒ 丢场景的真实风险在这里。逐条比对 delta 与主 spec 现状：

| MODIFIED requirement | 主 spec 现有 | delta 新内容 | 保留 | 新增 | 逐字丢失 |
| --- | --- | --- | --- | --- | --- |
| 渲染进程无文件权限且跨进程数据经校验 | 2 | 3 | 2 | 1（非法操作响应不能解除门禁） | **0** |
| 运行配置（LLM 接入）经 safeStorage 持久化 | 2 | 5 | 2 | 3（直接 IPC 不能绕过配置锁 / 配置变更与主动接受原子互斥 / settled 后读取失败不阻止配置） | **0** |
| 提交绑定草稿修订且响应不清除草稿 | 3 | 4 | 3 | 1（核对终态只解冻对应修订） | **0** |
| 主进程核对草稿后决定常规退出 | 9 | 11 | 9 | 2（无草稿的活跃操作也需确认 / 草稿与操作合并且关闭竞争不漏保护） | **0** |
| **合计** | **16** | **23** | **16** | **7** | **0** |

- **同名冲突核对**：5 个 ADDED requirement（desktop-ui）+ 3 个（其余 spec）与各自主 spec 现有 requirement **无同名**
  ⇒ 归档时是纯新增，不会与既有条目撞名。主 spec `desktop-ui` 归档后 requirements 47 → **52**、scenarios 200 → **229**（净新增 5/29）。
- **七入口点名核对**（tasks 7.2 明列）：`runs:create`（普通 + 隔离）/ `runs:fork`（普通 + 隔离）/ `runs:promptFork` /
  `proxy:fork` / `runs:modelAb` = **七类主动入口**，全部①在 schema 可表达（`operation-schemas › 五种 kind（create/result 各含普通与隔离 = 七类主动入口）均可表达`）、
  ②进 §3.8 矩阵（`exec-entry-matrix` 的 `describe.each` 七行 × 六判据）、③出现在 preload 白名单的七个主动方法
  （`preload-surface › 七个主动方法都按执行信封透传，preload 不替调用方补身份`）、④有实机 tag 覆盖（6.1 创建两型 / 6.2 result 两型 + prompt / 6.3 proxy / 6.4 A-B）。

### 引用回查（防"编造证据"）

脚本 `.workbuddy/u4/u4-72/case-inventory.cjs`（抽用例标题池）+ `verify-index-refs.cjs`（六项回查）：

| 自检 | 结果 | 反证（判据有牙） |
| --- | --- | --- |
| **delta 场景逐条覆盖** | **63** 场景 ⇒ 索引点名 **63** 行，缺失 **0** | `--selftest`：内存里抹掉「七类主动入口均绑定身份」那一行 ⇒ coverage 立刻报缺失 ✅ |
| **索引未虚构场景行** | 点名行 **63**，其中不属于 delta 的 **0** | 同上（点名集与 delta 双向对账） |
| 用例名逐字存在 | 索引含中文的 code span 130 条 ⇒ 命中 **117**（其余 4 条豁免为 delta **场景标题**、其它为文件名/tag/UI 文案），未命中 **0** | `--selftest` 用不存在的用例名反查 ⇒ 查不到 ✅ |
| tag 名真实 | 点名 **33** 个 tag 全部在采集脚本源码内命中（扫描面 = U3+U4 共 31 个 `*-cdp.cjs`） | `--selftest` 用假 tag ⇒ 不命中 ✅ |
| 检查数 = **该批 run 自己落盘的 measurements JSON** | n/m 引用 42 处、可比对 **40** 处，全部相等（失败数必须为 0 才算"全绿"） | `--selftest` 拿 `error-identity` 冒充 999/999 ⇒ 判红 ✅ |
| 入库截图计数 | 逐批 `{61:0, 62:4, 63:5, 64:2, 65:6, 66:4, 67:6, 68:3}`，合计 **30**，与索引声明的 `（6.2=4、6.3=5…）` 逐项相等 | 索引声明与 `readdirSync` 实际计数对账，任一项不符即红 |

> 🔴 **本次回查抓到并修正 4 处"非逐字"引用**（都属"我以为是这么写的"那一类，人读没问题、机器按标题匹配就判红）：
> ① 源码里那条标题**本就没有空格**（"…main 不会发出renderer 无法校验的形状"），我按可读性"补"了空格 ⇒ 已改回原样；
> ② `operation-session` 那条用省略号截断过（"有效握手后…"）⇒ 换成完整标题；
> ③ `新 main 会话不伪造旧在飞身份的结局` 那条同样被我省略号截断 ⇒ 已换完整标题；
> ④ `draft-close-flow` 的「配置变更尚未完成」那条也截断了 ⇒ 已换完整标题。
> 另修正一处**批次歧义**：`probe` 在 6.1/6.5/6.6 三批各自存在且读数不同（3/3、1/1、14/14）⇒ 回查改为按上下文批次定位，不全局取首个。

---

## desktop-ui（ADDED）

### A1. 主动执行由 main 会话身份登记和去重（6）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 七类主动入口均绑定身份 | **契约** `operation-schemas › 缺身份、非 UUID、身份内多余字段一律拒绝（不留无身份后门的形状）` / `五种 kind（create/result 各含普通与隔离 = 七类主动入口）均可表达`；**单测** `exec-entry-matrix › 旧 epoch / 伪造 sender / 缺身份信封：副作用之前被拒，不产生登记`（该文件按七入口 `describe.each` × 六判据展开）；**实机** 6.1 `plain-success` 10/10 + `isolated` 8/8（创建两型）、6.2 `result-nav` 33/33 + `prompt-nav` 21/21、6.3 `interleave` 19/19（proxy）、6.4 `partial-fail` 23/23（A/B）⇒ 七入口全部带真信封跑通；**契约** `preload-surface › 七个主动方法都按执行信封透传，preload 不替调用方补身份` |
| 2 | 同 ID 重复请求只执行一次 | **单测** `operation-registry › 同 ID 同参的重复提交：只执行一次，后续只关联原操作与原终态`、`operation-races › 同 ID 同参的并发重复提交：第二个只等待同一收口，执行计数仍为 1`、`operation-execution › 同 ID 同参的并发 invoke：第二个等待第一个收口，且拿到同一终态`、`exec-create-fork › 同 ID 重复提交只执行一次：文件集合、模型调用次数与令牌消费都不再增长`；**实机** 6.1 `duplicate` 12/12（两条同 ID 并发 ⇒ 恰 1 请求 1 文件、两条回执终态相同）+ 6.3 `dup` 14/14（代理面）+ 6.6 `reload-running` 28/28（**跨重载**重放 ⇒ `OPERATION_DUPLICATED`）；**变异** M-F6（registry 侧）+ M-66C（摘判重，红以"场景中止"形式出现，归因如实标注） |
| 3 | 同 ID 异参和跨通道复用被拒绝 | **单测** `operation-request-fingerprint › 同 ID 异指纹 ⇒ conflict：原登记一字不改，也不占第二槽`、`exec-create-fork › 同 ID 改编辑值 ⇒ conflict：原登记与副作用一字不动` / `跨通道复用同一 operationId ⇒ conflict：fork 不借用 create 的登记`、`exec-model-ab › 跨通道复用同一 operationId ⇒ conflict：A/B 不借用 create 的登记`、`exec-entry-matrix › 同 ID 等价改写判 duplicated、异参判 conflict，四笔副作用计数都不增长`；**实机** 6.1 `duplicate`（异参 ⇒ `OPERATION_CONFLICT` 且原登记未改）+ 6.6 `reload-running`（跨重载同 ID 异参） |
| 4 | 指纹与执行使用同一解析快照 | **单测** `operation-request-fingerprint › 成功路径：返回值即 schema 解析产物（含类型收窄），且整棵子树深冻结` / `原始 payload 事后被改写 ⇒ 快照与指纹都不受影响（指纹不读原始输入）` / `缺省值等价性：dryRun 未给 / 显式 undefined / 解析产物三种写法同一指纹` / `未知字段：非 strict 业务 schema 会剥离它 ⇒ 与不携带时同一指纹；strict schema 直接拒绝`；**实机** 6.2 `result-nav`（提交值以落盘 `fork.edit.value` 核对，不看界面自述）；**变异 M-I**（指纹按原始 payload 算 ⇒ `legacyNote` 那条判红） |
| 5 | 旧 epoch 和非法身份无副作用 | **单测** `operation-endpoints › 旧 epoch 与非法身份一律在副作用前拒绝：不建封禁、不释放当前槽`、`operation-registry › 非 UUID 的 operationId 在登记入口即拒（坏身份不会漂到后来的快照读取才爆）`、`exec-entry-matrix › 旧 epoch / 伪造 sender / 缺身份信封：副作用之前被拒，不产生登记`；**实机** 6.6 `main-restart` 25/25（真重启后旧 epoch 的核对与提交都 `OPERATION_STALE_EPOCH`、新登记 count 仍 0、零请求零文件）；**变异 M-K**（摘掉 `submitActive` 的 epoch 检查 ⇒ 矩阵七行全红） |
| 6 | 会话登记不泄漏输入和凭据 | **契约** `operation-schemas › 摘要里放正文/授权值/凭据（edit value、messages、sourceToken、apiKey）⇒ strict 拒绝` / `登记不泄漏输入与凭据：多一个正文字段即非法；诊断有码/阶段/限长`；**单测** `operation-execution › 快照只含允许字段：正文、sourceToken、密钥、模型响应都不在其中`、`exec-entry-matrix › 实际编排入参 == 解析快照，且登记里既无正文也无凭据`；**实机** 6.8 `readonly-noslot` 14/14（正文 canary + apiKey canary ⇒ 扫 `operations:status` × 面板可见文本 × `operations:reconcile` × `settings:get` **四处零命中**、快照无 `"stack":`）；**变异 M-H**（把 `business.userMessage` 塞进 `ctx.diagnose` ⇒ 矩阵两行判红） |

### A2. main 原子执行槽覆盖所有主动编排（6）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 不同入口并发只有一个被接受 | **单测** `operation-races › 七类入口轮流抢位：赢家占槽执行，其余 notAccepted 且此后永不自动执行`、`operation-registry › 不同 ID 同时到达：一个被接受占槽，另一个 notAccepted 且零执行` / `接受判定的原子性：同一同步段内两入口交错，仍只有一个 accepted`、`exec-entry-matrix › 并发只有一个被接受：另一笔 running 时本入口判 busy，且本入口副作用恰为 0`；**实机** 6.4 `partial-fail`（在飞期间第二主动入口 `OPERATION_NOT_ACCEPTED` + 登记 `notAccepted/rejection=busy` + 零身份零请求零文件） |
| 2 | 执行和收尾结束才释放本操作 | **单测** `operation-execution › 编排返回后收尾仍被延迟 ⇒ 继续占槽、第二操作被拒；收尾完成才释放` / `收尾抛错：终态仍是可信 settled，已登记的 runIds 不丢，错误只落受控诊断`、`operation-registry › settled 后释放自己的槽，但记录仍在快照中（终态不随面板关闭消失）`；**实机** 6.2 `result-nav`（在飞切页仍占槽 ⇒ 收口才释放） |
| 3 | A-B 一批占槽直到全部收尾 | **单测** `exec-model-ab › A-B 一批占槽直到全部收尾：首臂已结算仍 running，第二入口被 busy 拒，末臂收尾才释放`、`operation-execution › A/B 整批：批内按臂登记身份，批次收尾前不释放槽`；**实机** 6.4 `partial-fail` 23/23（整批占一个槽由**外部观察**证：`activeOperationId` 指向本批 + 第二入口被拒 + 配置写被 main 拒而配置读照常）；**变异 M-64B**（摘掉 dryRun 早退 ⇒ 预览占主动槽并登记 `returned`，2 条判红） |
| 4 | 只读入口和被动录制不占主动槽 | **单测** `exec-entry-matrix › A/B 批次 running 时 status 与只读预览都可用，且不追加调用/不写文件/不动槽` / `令牌只被**已被接受**的那一笔消费：busy 拒绝不消耗一次许可`、`exec-model-ab › 批次占槽期间预览照常可用：零模型调用、零文件、不产生登记`；**实机** 6.3 `passive-no-slot` 10/10（被动录制独立落盘、不产生登记条目、不占槽）+ 6.8 `readonly-noslot`（A/B 预览 + 隔离预检 + 被动录制全程 `activeOperationId=null`）；**⚠️ 见「已知限制」③** |
| 5 | 接受后业务拒绝仍有可信终态 | **单测** `operation-registry › 业务拒绝的终态：settled/rejected 必须带稳定错误码（未配置等门禁不被绕过）`、`operation-execution › 接受后领域拒绝：沿用既有拒绝码写 settled/rejected，runIds 为空并可立即接新操作`、`exec-create-fork › 未配置运行参数：接受之后才失败 ⇒ 可信终态 + 原稳定码 + 零模型调用`、`exec-model-ab › dryRun 误闯主动执行通道：接受后拒绝 ⇒ settled/rejected + 零身份零调用零文件`；**实机** 6.3 `nokey` 11/11（关代理后 main 以 `PROXY_NO_KEY` 独立复核）+ 6.1 `plain-fail` / `isolated-fail`；**口径更正**：`dryRun:true` 误闯是"接受后拒绝"而**不是**零登记（HANDOFF 旧措辞已更正） |
| 6 | 旧操作收尾不能释放新操作 | **单测** `operation-registry › 旧操作收尾不能释放新操作：owner 校验贯穿 settle 与身份追加` / `重复完成只保留既有终态：不二次释放槽，旧操作的迟到收尾不影响新操作`、`operation-races › settled A + running B：核对 A、重复完成 A、duplicate 提交 A 都不动 B 的槽`；**实机** 6.5 `lock-isolation` 13/13 |

### A3. 操作状态可查询且未知请求可原子核对（8）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 握手和快照自洽 | **单测** `operation-registry › 空会话的握手快照自洽：版本 1、无活跃槽、无操作`、`operation-endpoints › 两条通道的成功返回都过 shared 契约：main 不会发出renderer 无法校验的形状`、`operation-schemas › 反例：槽指向不存在/非 running 的操作、两个 running、跨 epoch、operationId 重复`（`findSlotStateViolation` 与 schema 同判据）；**实机** 6.6 `probe` 14/14（真重启原语 + 桥接面形状量测）+ 6.1 `probe` 3/3 |
| 2 | reconcile 先到封禁迟到提交 | **单测** `operation-races › reconcile 先到 ⇒ 封禁；迟到的正式执行被拒且零副作用`、`operation-endpoints › reconcile 先到：原子建立 notAccepted 封禁，迟到的正式执行零副作用`、`operation-request-fingerprint › notAccepted（含 reconcile 封禁）⇒ banned：连指纹都不比，永不复活`；**实机** 6.5 `reconcile-first` 8/8 + 6.1 `duplicate`（封禁跨重载仍有效）+ 6.6 `reload-running`（重载后封禁不复活） |
| 3 | 执行先到核对实际状态 | **单测** `operation-races › 执行先到 ⇒ 核对只读：running/settled 如实返回，绝不建封禁、不再次执行`、`operation-endpoints › 执行先到：核对返回真实 running，不建封禁、不取消、不再次执行`；**实机** 6.5 `execution-first` 6/6（在飞由 `delayMs` 真造） |
| 4 | 核对旧操作不解除另一操作的锁 | **单测** `operation-endpoints › 核对旧操作不解除另一操作的锁：响应里的槽始终指向当前 running`、`operation-session › B 在跑时核对到 A settled：A 不再占槽，但全局仍是 operation_running`、`draft-submission-identity › 只解匹配身份那一条；别的待定关联与查不到的身份都不改仓库引用`；**实机** 6.5 `lock-isolation` 13/13 |
| 5 | 状态通道不可用保持未知 | **单测** `operation-session › 从未有会话时通道失败仍是「未握手」；已有会话后失败才转 Unknown` / `Unknown 只由下一次有效 status 清除；reconcile 只补事实、不解未知`、`operation-session-store › 通道抛错 ⇒ 未知锁且保留在飞身份；不自动重发，只有有效 status 才解锁`；**⚠️ 实机不可注入**（6.5 `probe` 测得 `window.api` 属性 `writable:false/configurable:false`，`defineProperty` 抛 `Cannot redefine property`）⇒ 该场景只由 §4 承载，见「已知限制」① |
| 6 | 同 main 重载恢复操作 | **单测** `operation-polling › 同 main 重载：握手恢复在跑的操作与既有终态/封禁，不重发也不丢事实`、`operation-registry › 重载后的新消费者握手：同一 epoch、同一槽、同一登记（含 running）`；**实机** 6.6 `reload-running` 28/28（epoch 不变、新 renderer 首次握手即采纳在飞槽、门禁仍拒、**零重放请求且零重放文件**、收口后按身份恢复终态）；🔴 采集面硬教训：`Page.reload` 偶发不换文档 ⇒ 现挂活体标记，没换就抛错（M-66D 首轮 15/15 假绿即此） |
| 7 | 新 main 会话不伪造旧操作结局 | **单测** `operation-session › 新 main 会话不伪造旧在飞身份的结局：保留为未知历史，但不锁住新会话`、`operation-session-epoch › 旧 epoch 的成功响应迟到 ⇒ 不导航、不解冻、不回退会话`；**实机** 6.6 `main-restart` 25/25（真杀进程树 ⇒ 新 epoch 全新、登记 0 条、旧 settled/running 查无此操作、旧 ID 只以「未接受」呈现、历史文件逐字节不变）；⚠️ 跨 epoch 在飞关联见「已知限制」② |
| 8 | 乱序快照不回退新状态 | **单测** `operation-session › 低登记版本的迟到快照整份丢弃：settled 不回退 running、新槽不被旧槽覆盖` / `等版本快照可采纳（同 registryVersion 不属于旧响应判据）`；**实机** 6.6 `out-of-order` 15/15（并发 8 路刷新期间采纳版本单调不减、槽不被旧快照抹成空闲）；**变异 M-66E** 推翻"旧快照真机不可诱发"的初判：摘掉 status 的代次/版本两条守卫 ⇒ 真机判红 2 条（界面被压回 `v10/running` 而 main 已到 `v11/settled`）⇒ 这两条守卫**在真机有牙** |

### A4. 操作关联使用编排产出的真实运行身份（5）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 普通和隔离创建失败保留 ID | **单测** `exec-create-fork › 普通创建失败保留 ID；失效令牌被拒时不产生任何运行身份`、`run-create.ts` 侧 `CreateRunError.runId` 由结构化事实赋值；**实机** 6.1 `plain-fail` 9/9（模型 500 ⇒ 回执 `ok:false` 带 settled + 稳定码 `CREATE_RUN_FAILED`，登记 `runIds` **恰 1 个**结构化身份、文件真存在、trace 内确有 `llm.call.error`）+ `isolated-fail` 9/9（隔离失败登记的 ID 就是最终世界身份，非 loop 临时 id） |
| 2 | 分叉在已知身份后异常仍可关联 | **单测** `exec-prompt-proxy › 写出 meta 后执行抛错：登记保留真实 id，但该记录确实没封存（身份 ≠ 可读）`、`prompt-replay-identity › meta 写出后模型失败：调用方仍持有该 id，可按它读到 errored 记录（不解析异常文案）`；**实机** 6.2 `error-identity` 16/16（空 fork 前置拒绝 ⇒ 零登记零请求；503 ⇒ 已写 meta 后失败仍带真实新 ID + 可按同一 ID 打开失败记录、不自动导航不重执行） |
| 3 | A-B 部分失败保留各臂事实 | **单测** `exec-model-ab › A-B 部分失败：失败臂带真实 id 与 failed 结局，ids 只含成功臂，批次不冒充全臂成功`、`model-ab-identity › 部分失败与异常臂：LLM 失败臂与写 meta 后抛错的臂都保留真实 id 与各自结局`；**实机** 6.4 `partial-fail`（登记 `arms[i].id` × 落盘 `meta.id` 一一对上、成功臂无 `llm.call.error`、失败臂确有 + `run.event=errored`、两臂 id 互不相同、traces +2 服务 +2 无重试）；**变异 M-64A**（`ids` 按"有 id"计 ⇒ 把 503 臂报成成功，1 条判红） |
| 4 | 主动代理重发与被动录制交错 | **单测** `exec-prompt-proxy › 重发等待期间被动录制落盘 ⇒ 登记只认本次 fork 的 id，不借用被动 run` / `本次录制写入失败 ⇒ 明确失败且不借用在场被动 run 的 id`；**实机** 6.3 `interleave` 19/19（main 登记 × 落盘 `meta.id` × 同窗被动 id **三方比对**）+ `write-fail` 13/13（在飞窗口内同卷 rename 走 traces 目录 ⇒ 命中录制写盘，`finally` 无条件还原）；🔴 两条口径：**注入窗口的位置就是命门**（改名放请求发出前只会命中 `PROXY_PARENT_INVALID`）；**M-63B 首版无牙**（被动借用被主动自己那份覆盖 ⇒ 全绿），改注端点层才判红 ⇒ 见「已知限制」③ |
| 5 | 结果不可读不重执行且不锁配置 | **单测** `operation-session-store › 按可信 runId 读详情失败 ⇒ 无操作占槽、下一次提交与握手照常`、`config-gate › 已 settled 的操作（含失败与结果不可读）不阻止配置写入`；**实机** 6.1 `unreadable` 7/7（文件移走 ⇒ `GET_RUN_FAILED` ⇒ 该操作仍 settled 不占槽 ⇒ `saveSettings` 仍成功 ⇒ 全程 `served` 不变 ⇒ 还原后重试读取成功仍零请求） |

### A5. 现有界面消费统一操作事实（4）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 初始握手失败禁用主动入口 | **单测** `operation-session › 没握过手 ⇒ 主动入口与配置写入口都禁用，原因是不知握手而非未知`、`operation-session-store › 握手通道失败 ⇒ 本地未发送，业务通道一次都没被调用` / `握手返回非法快照 ⇒ 同样未发送，且不部分采纳所谓成功字段`、`entry-gate › 空闲会话 ⇒ 可提交且无提示；未握手 ⇒ 禁用并给提示` |
| 2 | 所有入口实际使用同一适配器 | **契约** `entry-gate › 两个入口都读 s.operations 并经 deriveEntryGate 判定` / `三个编辑器都声明同一来源的门禁，并渲染禁用理由` / `门禁 AND 进提交判据，但没有并进输入锁/关闭锁/只读预检`、`draft-submission › store：六处写入/放弃路径拦冻结；五个执行函数负责收尾`；**实机** 6.2 四 tag（result/prompt/isolated/error 走**同一个** `submitActive` 适配器，逐 tag 核对关联带 `epoch/operationId`、在飞切页判据同一段） |
| 3 | 核对结果只由用户明确打开 | **契约** `operation-entry › 核对只发 reconcile(operationId)，打开只走 reopenRun(runId)` / `不显示进度/百分比/停止按钮；不自动导航（核对与刷新都留面板在原处）`；**单测** `operation-session-epoch › 核对不改变当前选中（结果只由用户明确打开）`；**实机** 6.2 `result-nav`（「核对状态」不导航 / 「打开记录」才导航并读到详情）+ 6.8 `readonly-noslot`（点核对 ⇒ `selectedRunId/selectedSpanId/页签` 三项不变且模型计数不增；点打开 ⇒ 导航到该 runId）＝**M-AL 的实机复核** |
| 4 | 操作入口在窄窗口和键盘下可达 | **契约** `operation-entry › 窄窗口与键盘可达：受视口宽度约束、长 ID 断行、按钮可聚焦且带 aria 关系`；**实机** 6.8 `narrow-keyboard` 18/18 + `zoom200-keyboard` 8/8（800px 实测视口 805 / 200% dpr 4.2；`focus()` + 真键盘单发 `char` ⇒ 恰一次原生 click 打开面板；36 位 operationId 与 runId 逐字在场；面板按钮矩形完整落在视口内；`scrollWidth ≤ clientWidth` 不破版；按钮里无停止/取消/中止）；🔴 两条 harness 口径见 6.8 README 第二节（`char-only` 单序列；就绪判据读 `store.runs`） |

---

## desktop-ui（MODIFIED，逐条标"保留 / 新增"）

### M1. 渲染进程无文件权限且跨进程数据经校验（3：2 保留 + 1 新增）

| # | scenario | 保留/新增 | 证据 |
| --- | --- | --- | --- |
| 1 | 预加载接口不含文件能力 | 保留 | **契约** `preload-surface › preload 不引入任何 node 运行时能力，也不把 ipcRenderer 交给渲染层`（25 方法封闭白名单，多一个即红）/ `窗口安全基线在 main 侧钉死：nodeIntegration 关、contextIsolation 开、sandbox 开`；🔴 **M-AO 真反证已补（§6.8，单测层）**：Edit 给 api 对象加一行 `fsReveal:` ⇒ 该用例当场判红（1 failed/4 passed），`git checkout` 还原后 5 passed |
| 2 | 主进程返回非法结构 | 保留 | **单测** `detail-request › 载荷自称的 run 与请求不一致（main 回错） ⇒ 报错且不落地` / `版本非法（v1 载荷私带隔离字段） ⇒ 拒绝加载，不落进 detail` / `结构非法（schema 不符） ⇒ 拒绝加载，不落进 detail`；**实机** 6.2 `isolated-gates`（隔离详情 IPC 的 v1 守卫与 v2 全量往返照常） |
| 3 | 非法操作响应不能解除门禁 | **新增** | **单测** `operation-session-store › 回执身份不匹配（main 回了别人的操作）⇒ 按未知处理，不销账也不解冻`、`operation-session › 低登记版本的迟到快照整份丢弃：settled 不回退 running、新槽不被旧槽覆盖`、`operation-schemas › 执行响应两个分支都带登记回执；回执非法或结果走样都不能通过`；⚠️ 注入面**实机不可达**（同「已知限制」①）⇒ 按层引用，不冒充实测；**变异 M-O**（执行响应不比对回执身份 ⇒ 冒充的回执被采纳，1 条判红） |

### M2. 运行配置（LLM 接入）经 safeStorage 持久化（5：2 保留 + 3 新增）

| # | scenario | 保留/新增 | 证据 |
| --- | --- | --- | --- |
| 1 | 配置后重跑可用 | 保留 | **实机** 6.1 `probe` 3/3（`getSettings ⇒ configured=true`）+ `plain-success`（连到受控 baseURL 真跑通）；**单测** `controlled-entrances › 连到配置的 baseURL：恰一次 SSE 提交（空工具表），结果落盘进概览、预算门禁保留` |
| 2 | 未配置时提示 | 保留 | **单测** `exec-create-fork › 未配置运行参数：接受之后才失败 ⇒ 可信终态 + 原稳定码 + 零模型调用`、`entry-gate › 五种禁用原因各给一句可读理由，且只有通信未知引导核对`；**实机** 6.2 `isolated-gates`（未预检/未授权 ⇒ 提交禁用且零登记零请求） |
| 3 | 直接 IPC 不能绕过配置锁 | **新增** | **单测** `config-gate › 主动操作占槽时：save/clear 被拒、配置文件字节不变、registry 不被写入` / `形状不合先拒（不写盘）；子 frame / 陌生 webContents 一律拒绝`、`exec-entry-matrix › A/B 批次 running 时 status 与只读预览都可用，且不追加调用/不写文件/不动槽`；**实机** 6.7 `clean-running`（询问期间配置写被 main 拒 ⇒ `settings.json` 逐字节未变，且**配置读照常可用**）+ 6.4 `partial-fail`；**契约** `entry-gate › 读取、关闭与回读不被门禁锁掉（spec：settings:get / proxy:status 仍可用）` |
| 4 | 配置变更与主动接受原子互斥 | **新增** | **单测** `config-gate › 启停进行中新主动执行被拒；结束后标记释放、主动执行才可被接受` / `启停抛错也在 finally 释放标记（不留下永久锁死的配置通道）` / `主动占槽时启停被拒且代理处理器不动；只读 status 照常可用`、`operation-races › 配置变更与主动接受互斥：标记期间的新提交被拒，释放后按当前槽判定`；**变异 M-AI/M-AK**（摘配置门禁 / 不渲染理由 ⇒ 各 1 条判红） |
| 5 | settled 后读取失败不阻止配置 | **新增** | **单测** `config-gate › 已 settled 的操作（含失败与结果不可读）不阻止配置写入`；**实机** 6.1 `unreadable`（文件移走 ⇒ 该操作仍 settled 不占槽 ⇒ `saveSettings` 仍成功） |

### M3. 提交绑定草稿修订且响应不清除草稿（4：3 保留 + 1 新增）

| # | scenario | 保留/新增 | 证据 |
| --- | --- | --- | --- |
| 1 | 提交快照独立于编辑器挂载 | 保留 | **单测** `draft-submission › 提交快照独立于编辑器挂载：resetFork 与展示状态复位后仍冻结`；**实机** 6.2 `result-nav` / `prompt-nav`（**在飞期间切页签 + 切 run** ⇒ 关联仍冻结、草稿原样、main 登记仍 `running` 占槽）⇒ "卸载不换关联"是直接实测 |
| 2 | 成功错误和部分失败均保留草稿 | 保留 | **单测** `draft-submission › 成功响应收尾（解冻）但草稿保留原文` / `业务拒绝同样收尾（可重新提交）且草稿保留；三个通道一致` / `A/B：部分臂失败（仍是明确返回）收尾且批次保留`；**实机** 6.2 `error-identity`、6.4 `partial-fail`（草稿不被清） |
| 3 | 迟到回调与未知状态不能错误解冻 | 保留 | **单测** `draft-submission › 迟到回调不解冻新提交；通道抛错（状态未知）保留冻结`、`draft-submission-identity › 旧提交的回执不能解冻新提交（身份 + 令牌双守卫）`；**实机** 6.6 `reload-running`（跨重载的旧身份重放不改写原登记）；⚠️ 真机"丢弃执行响应"不可注入 ⇒ 分层见「已知限制」① |
| 4 | 核对终态只解冻对应修订 | **新增** | **单测** `draft-submission-identity › 同身份 + settled ⇒ 解冻，草稿原文保留` / `同身份 + notAccepted（main 拒了这次提交）⇒ 同样解冻：这是可信终态，不是未知` / `running 回执 ⇒ 保留冻结（执行还在进行，不能假装结束）` / `只解匹配身份那一条；别的待定关联与查不到的身份都不改仓库引用`、`operation-session-store › 核对到 settled ⇒ 只解冻该身份那一条，另一条仍冻结`（共 6 条 U4 5.x 接线用例）；**实机** 6.5 四 tag 28 检查；🔴 **本批抓到并修一处真实缺陷**（提交 `13d6058`）：`reconcileOperation` 从没调用解冻口 ⇒ 真机上核对永远解不开待定关联（本仓反复出现的"纯逻辑写好、接线少一支"），反证 M-65B 摘掉那支持线正好红那 3 条 |

### M4. 主进程核对草稿后决定常规退出（11：9 保留 + 2 新增）

> 关闭一律**由系统发起**（`PostMessage(SC_CLOSE)` / `keybd_event` 真 Alt+F4 / 哨兵真 `app.quit()`），
> 确认框是真 `#32770`（UIA 读文案、`BM_CLICK`/LegacyIAccessible 应答），
> 退出判定只看**窗口句柄消失 / 主进程 PID 不再存活 / 端口关闭**，不断言 guard 返回值。
> §5 起 `showConfirm(kind)` 端口换成 `showConfirm(facts)` ⇒ 关闭文案是**合并档**，U3 的两档旧措辞已作废。

| # | scenario | 保留/新增 | 证据 |
| --- | --- | --- | --- |
| 1 | 有草稿时关闭可返回或明确退出 | 保留 | **实机** 6.7 `altf4-dirty` 20/20（真 Alt+F4 ⇒ 合并文案 ⇒「返回」⇒ 解锁 + 草稿逐字保留；`67-altf4-dirty-dialog.png`）、`quit-return` 13/13（真 `app.quit()` 哨兵 ⇒ 返回阻止退出、哨兵被消费、窗口/进程仍活）；U3 6.4 的 titlebar 面仍有效（`draft-close-flow` 单测未改判据） |
| 2 | 最新 clean 应答才允许直接关闭 | 保留 | **单测** `draft-close-flow › clean + 槽空闲 + 无配置变更 ⇒ 才允许直接关闭`；**实机** 6.7 `clean-running` 尾段与 `quit-return`（放弃草稿 + 无活跃操作 ⇒ 零询问直退 + 窗口/PID 真结束） |
| 3 | 退出输入锁保留已接收文字且不重放按键 | 保留 | **实机** 6.7 `altf4-dirty`（询问在场 ⇒ 遮罩渲染；先显式 `focus()` 再真 `Input.dispatchKeyEvent` 键入 ⇒ 表单**不含锁内字符**、草稿修订不变；真鼠标点「创建」不触发提交、不新增登记）；🔴 口径：新建运行框在 **top layer**，拦截来自 `use-draft-close-guard` 的**捕获阶段 preventDefault**，不是遮罩命中 ⇒ 判据不能写成"命中的是 draft-close-lock"；U3 6.5 的输入法面仍按 `native-edit-context` 事实留档（见「已知限制」） |
| 4 | renderer 失联或应答无效仍有退出确认 | 保留 | **单测** `draft-close-flow › 无应答/未握手/inputSettled=false/会话丢失 ⇒ unknown`；**实机** U3 6.6（真 `forcefullyCrashRenderer` + 真忙等冻结）；本批 6.7 `frozen-unknown` 复用了同一冻结注入通道 |
| 5 | 慢响应降级后可取消并重新核对 | 保留 | **实机** 6.7 `frozen-unknown` 16/16（真同步忙等 4s ⇒ 实测应答距关闭 >1.5s ⇒ 降级 unknown；恢复后取消走「点击-核对-重试」排空；迟到应答零后续效果；下次关闭 fresh 核对）；U3 6.7 的 `slow-fast`/`slow-slow`/`cpu-throttle` 三 tag 38 检查为原始证据（阈值两侧行为 + 不设向纪律不变） |
| 6 | 重载不能用空仓库抹掉旧会话未知状态 | 保留 | **单测** `draft-close-flow › 重载后新会话报 clean，main 仍有活跃操作 ⇒ 不因重载消失（合并确认）`；**实机** U3 6.6 `reload-empty-repo` 15/15；本批 6.6 `reload-running` 佐证同一条协议会话轮换 |
| 7 | 旧会话伪造发送者和乱序消息不影响关闭 | 保留 | **单测** `draft-close-guard › 报告：未握手 / 非法载荷 / 旧会话 / 乱序全部被拒，合法报告才更新 lastReported` 等；⚠️ `event.sender` 冒名实机不可注入（U3 已记）⇒ 只由单测承载 |
| 8 | 重复关闭取消和迟到应答不会重入 | 保留 | **单测** `draft-close-flow › 连续关闭共享同一协商：closing 只置一次、查询只发一次、确认只弹一次（不重入）`；**实机** 6.7 `frozen-unknown`（无应答期间连发关闭，6 次采样 `dialogs` 恒 ≤1）+ `altf4-dirty`（本次协商只发起过一次查询 ⇒ 迟到/排队应答不二次弹框） |
| 9 | 系统会话结束不沿用普通退出承诺 | 保留 | **契约** `draft-close-flow › 源码契约：装配层与入口不注册 query-session-end/session-end 拦截`；U3 6.6 `session-event` 9/9（合成事件零确认零阻止）＋ `u3-66-smoke-hook.test.ts` 的白名单/零监听器断言（本 change 未触碰该钩子） |
| 10 | 无草稿的活跃操作也需确认 | **新增** | **单测** `draft-close-flow › clean 但有活跃操作 ⇒ 合并确认（draft=null 表示草稿侧已知 clean，不冒充有草稿）` / `renderer 报 clean 但 main 仍占槽 ⇒ 不直接关闭，弹一次活跃操作确认` / `只有活跃操作（草稿已知 clean）⇒ 不出现草稿丢失措辞，退出按钮不写「丢弃草稿」`；**实机** 6.7 `clean-running` 22/22（无草稿 + 真在飞 ⇒ 弹一次「有操作正在执行」，UIA 逐字 + 全屏截图 `67-clean-running-dialog.png`；询问期间 `closing` 在场 ⇒ 第二入口被 main 拒且留 `notAccepted`；配置写被拒而配置读照常；返回不释放槽、登记不丢、不记成已取消）+ `quit-executing` 11/11（clean + 活跃 ⇒ 退出按钮只说「退出」；确认退出 ⇒ 窗口/PID 真结束、被打断那次只留自己那一份未完成文件、历史逐字节不变、未重放）；**变异 M-CL5**（clean 判据忽略活跃槽 ⇒ 4 条判红）+ **M-67A**（同义实机版 ⇒ 直接关窗、dialog=null） |
| 11 | 草稿与操作合并且关闭竞争不漏保护 | **新增** | **单测** `draft-close-flow › dirty/unknown 与活跃操作并存 ⇒ 一次确认同时带两类事实` / `协商一开始就置 closing：询问期间新主动请求在副作用前被拒（不漏保护）` / `顺序契约：置 closing 早于查询，读活跃槽晚于应答（先读槽会漏掉询问期间刚提交的那一次）` / `配置变更中：clean + configurationBusy ⇒ 合入确认，不冒充主动 run`；**实机** 6.7 `altf4-dirty`（dirty×活跃 合并成一次）+ `frozen-unknown`（unknown×活跃 合并成一次，**不是两层框**）+ `quit-return`（同一条协商经 `app.quit` 路径）；**变异** M-CL1（读槽提前 1 红）/ M-CL2（不置 closing 7 红）/ M-CL3（返回不解除 5 红）/ M-CL4（忽略 configurationBusy 2 红）/ M-CL6（异常清理摘掉 1 红）/ M-CL7（文案丢活跃说明 1 红）+ 实机 **M-67B**（不置 closing ⇒ 恰 2 条红）/ **M-67C**（丢合并支 ⇒ altf4 与 frozen 各 1 条红）；⚠️ `configurationBusy` 合并档文案未实机诱发，见「已知限制」④ |

---

## 包层三条（replay / prompt-replay / model-experiments）

### R1. 重跑编排可观察真实运行身份（replay，4）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 普通 result 编排暴露已创建身份 | **单测** `run-identity › 身份恰一次、等于落盘 meta.id，且先于首次 LLM 调用` / `meta 写出之后的失败不撤销已知身份（errored run 仍可按该 ID 读到）`；**实机** 6.2 `result-nav`（登记 `runIds` 就是那份新 run） |
| 2 | 隔离编排报告最终世界身份 | **单测** `workspace-isolated-identity › 报告最终世界身份：恰一次、等于落盘 meta.id 与 world_id、先于首次 LLM 调用` / `隔离续跑报告子 run 的最终世界身份，恰一次且先于子首次 LLM 调用`；**实机** 6.1 `isolated` 8/8（世界身份 `run_*_*` 非 loop 临时 id）+ 6.2 `isolated-gates` |
| 3 | 拒绝和写入前失败没有运行身份 | **单测** `run-identity › meta 写出前失败 ⇒ 不报告身份（没有记录就不给 ID）` / `预检拒绝（未封存父本 / config_hash 不同源）⇒ 零回调、零模型调用、零新文件`、`workspace-isolated-identity › 预检拒绝（授权缺失 / profile 不符）⇒ 零回调、零落盘` / `拒绝路径与写入前失败零回调：缺授权 / 非法分叉点都不给身份，也不落子文件`；**实机** 6.2 `error-identity`（空 fork ⇒ 禁用且零登记零请求 ⇒ 前置拒绝**不是**"登记后被拒"） |
| 4 | 可选观察不改变执行结果 | **单测** `run-identity › 省略回调 ⇒ 连订阅都不建立（省略时的行为与接入前逐字节相同）` / `观察者抛错被就地吞掉：不外泄异常、不影响后续事件、也不重复通知` / `省略观察者 / 正常观察者 / 观察者抛错：调用次数、终止事件与文件数完全一致`、`workspace-isolated-identity › 省略观察者与抛错观察者的执行结果完全相同（观察者不成为新失败原因）` |

### P1. 启动上下文编排可观察真实运行身份（prompt-replay，3）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | prompt 身份在后续失败时仍可关联 | **单测** `prompt-replay-identity › 三种既有编辑字段各报告一次真实新身份，且都先于首次 LLM 调用` / `meta 写出后模型失败：调用方仍持有该 id，可按它读到 errored 记录（不解析异常文案）`；**实机** 6.2 `prompt-nav` 21/21 |
| 2 | prompt 前置拒绝不报告假身份 | **单测** `prompt-replay-identity › 前置拒绝一律不报告假身份：未封存父本 / 空编辑 / 双真相源漂移`；**实机** 6.2 `error-identity`；§3.3 另有 `makeNoSystemParent()` 造的真父本 ⇒ `exec-prompt-proxy › 启动上下文门禁（前置拒绝）：父本首次 llm.call 无 system 消息 ⇒ 原稳定码 + 零身份零文件` |
| 3 | prompt 观察者兼容且释放 | **单测** `prompt-replay-identity › 省略观察者与抛错观察者：终止事件、模型调用数与落盘文件数一致`；`run-identity › 释放函数幂等；释放后到达的事件不再通知`（共用同一 `observeRunIdentity` 内核） |

### E1. 实验编排暴露各臂真实身份且保留失败关联（model-experiments，4）

| # | scenario | 证据 |
| --- | --- | --- |
| 1 | 批次运行中可关联各臂 | **单测** `model-ab-identity › 每臂在该臂首次模型调用前恰通知一次，id 与各臂实际落盘记录一致且互不覆盖`；**实机** 6.4 `partial-fail`（登记 `arms[i].id` × 落盘 `meta.id` 一一对上） |
| 2 | 部分失败和异常臂保留已知 ID | **单测** `model-ab-identity › 部分失败与异常臂：LLM 失败臂与写 meta 后抛错的臂都保留真实 id 与各自结局`；**实机** 6.4 `partial-fail`；**变异 M-F**（批次收尾不补齐各臂结局 ⇒ 3 条判红）+ **M-64A** |
| 3 | 未开始臂与 dry-run 不产生 ID | **单测** `model-ab-identity › meta 未写出的臂不产生身份：该臂客户端工厂抛错 ⇒ id 为 null 且无通知` / `dry-run 与未开始的臂都不产生身份，也不消耗调用与文件`、`exec-model-ab › dryRun 误闯主动执行通道：接受后拒绝 ⇒ settled/rejected + 零身份零调用零文件`；⚠️ 桌面端点侧 `id=null` 分支**不可达**（桌面注入单个共享 `LlmClient`，每臂必先写 meta）⇒ 该分支由包层固定，端点用例不自称覆盖 |
| 4 | 实验身份观察不改变原执行 | **单测** `model-ab-identity › 省略观察者与抛错观察者的执行结果一致（订阅不改变臂顺序与结局）`；**实机** 6.4 `dry-run` 12/12 |

---

## 接线核对（入口 ↔ 真相源，逐条点名）

- **唯一真相源**：`src/main/index.ts` bootstrap 创建**唯一** `OperationRegistry`（提到模块作用域，同时供 `registerIpc` / 关闭协商 / autoStart 占标）；
  窗口侧 `attachDraftCloseGuard(win, operations)` 的两条端口接**真 registry**（`operations.setClosing` / `operations.slotState()`）
  —— 契约 `draft-close-flow › 装配层把两条端口接到真 registry（源码契约：不另造一个 closing 标志）`。
- **五条主动执行端点**（`src/main/exec-endpoints.ts`）固定顺序：sender → 信封 → epoch → 业务**只 parse 一次** → `submitExecution` → 带回执响应；
  三条配置端点（`src/main/config-endpoints.ts`）同步判锁、`toggle` 持 `beginConfigurationChange` 且 `finally` 释放。
- **renderer 唯一提交适配器**：`store.ts` 的 `submitActive(call, business, submission?)` 七条通道共用；
  消费方 `lib/entry-gate.ts`（`deriveEntryGate` / `deriveConfigGate`）、`lib/operation-session.ts`（纯转移会话模型）、
  `lib/operation-polling.ts`（单路轮询状态机）、`lib/operation-list.ts` + `components/OperationsEntry.tsx`（全局栏最小入口）。
- **包层身份观察**：`packages/replay/src/run-identity.ts` 的 `observeRunIdentity` 已从包出口公开，
  被 `replayRun` / `promptReplayRun` / `createIsolatedRun` / `replayIsolatedRun`（订阅底层 `delegate`）/
  `modelReplayRunMany`（`onArmRunIdentified`）与桌面 `main/run-create.ts`、`main/fork-runner.ts` 复用。
- **代理身份**：`main/proxy-manager.ts` 删掉全局 `lastWrittenRunId` ⇒ 改 `activeForks: Map<ProxyForkMeta, {runId, writeFailure}>`
  （按 handler 原样透传的同一 fork 对象匹配，`finally` 删除）；被动录制无 forkMeta ⇒ 不入表。
- **U4 期间改到的既有产品代码**（均有测试或实机判据回写）：`main/ipc.ts`（七 handler 改委派 + 两条只读通道）、
  `main/index.ts`（registry 提模块作用域、closing 接线）、`main/fork-runner.ts` / `main/run-create.ts` /
  `main/proxy-manager.ts`（身份透传）、`shared/{channels,ipc,operations}.ts` + `preload/index.ts`（信封契约与白名单）、
  `renderer/src/store.ts`（`mainEpoch` → `operations: OperationSession`）、`components/{CreateRunDialog,DetailPanel,SettingsDialog}.tsx`（门禁接线）。
  🔴 其中唯一一处**真实缺陷修复**是 §6.5 的 `reconcileOperation` 漏接解冻口（提交 `13d6058`，配套 6 条接线用例 + M-65B 反证）。

## 已知限制与诚实边界（逐条，带影响面）

| # | 限制 | 影响 | 现在由什么守住 |
| --- | --- | --- | --- |
| ① | **桥接面不可包装**：`window.api` 属性 `writable:false / configurable:false`，真机 `defineProperty` 抛 `Cannot redefine property`（6.5 `probe` 实测） | 「篡改 status 载荷」「丢弃执行响应」两类注入**真机做不到** ⇒ `状态通道不可用保持未知`、`非法操作响应不能解除门禁` 无实机面 | §4 store 用例（M-N / M-Q / M-R / M-S / M-AF + 6.5 新增 6 条）；引用时**按层点名**，不得写成实机已测 |
| ② | 跨 epoch 的**在飞**关联真机凑不出前提（renderer 随 main 一起死，`restartMain` 也救不回同一个 renderer 会话） | 「换会话后旧在飞身份的结局」只有单测面 | `operation-session › 新 main 会话不伪造旧在飞身份的结局：保留为未知历史，但不锁住新会话`；6.6 已把可测的那一半（旧 epoch 核对/提交/封禁）做成实机 |
| ③ | `ProxyManager` 层的"被动录制同窗落盘 ⇒ 主动身份不变"**至今无有牙反证**（6.3 M-63B 首版注入被自己的交错顺序盖掉，改注端点层才判红） | 该不变量在包/管理层没有回退旧实现跑红的记录 | 端点层等价注入 M-B（2 条判红）+ 实机 6.3 `interleave`；**别写成"已全部有牙"** |
| ④ | `configurationBusy` 合并档的关闭确认文案未实机诱发（代理启停太快 ⇒ 造不出确定性的长配置在飞窗口） | M4-11 的合并文案实机面缺"配置变更中"这一档 | §5 单测 `draft-close-flow › 配置变更中 ⇒ 按「配置变更尚未完成」呈现，不写成主动操作在跑` + 变异 M-CL4；`buildCloseConfirmText` 的该分支有独立用例 |
| ⑤ | `inputSettled=false`（输入法组合中）在本机 Monaco `native-edit-context` 通道**无触发路径**（document 级 composition 事件 0 条） | M4-3 的组合期分支不在实机面 | U3 6.5 结论沿用：保护由 `dirtyCount` 侧承担；`draft-close-client/flow` 单测直接钉该分支 |
| ⑥ | 真机 IPC 往返与**满载诊断体积**未测（4.5 只测了构造 + 校验） | 1 秒轮询初值只在构造层成立 | `operation-snapshot-cost › 1000 条（settled + 封禁）的构造 + 校验远小于 1 秒轮询间隔 ⇒ 1 秒初值成立` + `docs/engineering/notes/2026-09-26-u4-snapshot-cost.md`（明列未测项） |
| ⑦ | 6.1 的截图与逐 tag `measurements.json` **只在 gitignored `.workbuddy/u4/u4-61/`**（当时按"过程截图不入库"约定） | 从仓库里看不到 6.1 的原始截图 | 其 README 表格 + `HANDOFF.md` §十 6.1 条目；本索引引用数字与 README 一致 |
| ⑧ | 隔离父本守卫路径（漏传 `execution`）**没有稳定业务码**（包层抛裸 `Error` ⇒ 落兜底码 `OPERATION_EXECUTION_FAILED`） | 不是回归（与 U4 之前 `ipc.ts` catch-all 同码），终态与"零身份零写入"仍可信 | `exec-create-fork › 隔离父本漏传执行模式：普通分支被包层隔离门禁拒绝，不降级执行也不带回身份`；要收紧须改包层错误形状 ⇒ **属改契约，待与用户定口径** |
| ⑨ | 沙箱仍跑不了整条 `pnpm check:ci`（`pnpm -r test` 拉 `wmic.exe` 被黑名单拦、`check:spec` 的 `npx` 同理） | 门禁需逐段替换执行 | 见下「质量门禁」的逐段口径；`.workbuddy/memory/MEMORY.md` 有替换表 |

## 质量门禁（任务 7.1，2026-09-27 §6 收口整跑，HEAD `b1f1e4e`）

`pnpm --filter "./packages/*" build` **EXIT=0（5/5，排除 desktop）** ⇒ 随后**逐包单跑** vitest：
llm-proxy **18** / trace-sdk **191** / agent-loop **104** / trace-test **77** / replay **412 passed + 5 skipped（417）**
——先 build 再 test ⇒ replay 那 60+ 条以 `existsSync(dist)` 守卫的 CLI 用例**实际执行**（P0 不变量）；
5 条 skipped 是既知的"伪造 symlink"环境用例，非本轮引入。
`desktop vitest run` **103 文件 / 1828 用例 / 0 失败 / 无 `Errors` 行**（EXIT=0）。
根 `biome check .` **Checked 419 files，0 错**（新增两支采集脚本后计数由 417 → 419）。
`desktop typecheck`：**node / web 两配置各 EXIT=0**。
`openspec validate add-desktop-operation-tracking --strict` **valid**（入口 = 缓存内 `bin/openspec.js`，无子进程直调）。
`electron-vite build` **EXIT=0（✓ built）**。
**实机检查总数**：6.1 58 + 6.2 93 + 6.3 67 + 6.4 35 + 6.5 28 + 6.6 82 + 6.7 82 + 6.8 40 = **485 检查全绿**，
共 **34 个正式 tag 键**（6.1 7、6.2 4、6.3 5、6.4 2、6.5 4、6.6 4、6.7 5、6.8 3）。
**环境阻塞（如实记录，不写成回归）**：`test/controlled-proxy.test.ts`（mock 端口紧邻起停）、
`test/proxy.test.ts` + `test/proxy-fork-identity.test.ts`（真回环端口 + stub upstream 在并行负载下 `fetch failed`）、
`test/controlled-service.test.ts` 一条——**判法＝单跑复现**（单跑全绿即 flake，不写进回归）。
**产品真实失败：0**；本 change 期间的 1 处真实缺陷（§6.5 核对漏接解冻）已在 `13d6058` 修掉并有反证。
⚠️ desktop 测试**不在 tsc 双配置覆盖内** ⇒ 新用例类型检查走一次性 `tsconfig.testcheck.json`（跑完即删）；
本批未新增 desktop `*.test.ts`，故该口径只对 §1–§5 的历史用例有效。

## 本索引不宣称的事（放行前请 owner 自决）

- **不宣称 U5 的任何能力**：无进度/百分比/阶段、无真实取消或中止（`preload-surface › 本阶段不交付取消能力：桥接面没有 stop/cancel/abort 通道`）、
  无跨 main 重启的任务恢复（6.6 明写"新 main 会话不伪造旧结局"是特性）、无运行队列/并发（同时只允许一个主动操作）、
  **不因任何执行结果自动删除草稿**（自动清理属 U5）。
- `runs:forkCapability` 是只读预检、**没进 registry**（`OperationTargetSchema` 里没有对应 kind；认定它也该登记属改契约）。
- 窄窗口 N1（`<Dialog>` 系缺 `max-width` 收口）是**用户未定口径**的独立欠账，与本 change 无关，未处理也未宣称处理。
- 未打 tag、未上传 Release、**未归档**（tasks 7.2 明写"归档另行处理"）；归档时需同步 README 关于"桌面入口尚未进入任何发行包"的表述。
- 本地 `main` 领先双远程 **5 个提交**（`01f74d0` `246c836` `08500bc` `4f41350` `b1f1e4e`；push 按约定留给用户）。
