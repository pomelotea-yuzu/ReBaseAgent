# U3 设计：会话草稿与退出核对

## Context

U1/U2 的阅读状态已经提升到 store，但其白名单明确排除草稿和授权。`DetailPanel.tsx` 的 `PromptForkEditor`、`ModelAbEditor`、`MessagesForkEditor`、`ForkEditor` 仍持有局部输入；prompt 的 `switchField`、messages/result 的重新打开路径会填回原值。A/B 虽有稳定行 key，整个 rows 仍随卸载丢失。创建表单在成功信封后关闭，并在卸载时复位请求展示状态。main `index.ts` 当前没有草稿关闭协商；preload 只有请求接口，需增加有解绑能力的定向订阅。

问题证据与范围见 [proposal](proposal.md)。本设计不把既有 `forking: success` 当作运行结局，也不在 U3 改造全部执行状态。

## Goals / Non-goals

目标：任何已输入的调试内容在当前 renderer 会话的普通导航中可找回；明确放弃可取消；编辑与授权分离；常规退出不会静默丢弃草稿。实现与 U4/U5 可衔接的键和修订关联，但不预先实现操作系统。

非目标：磁盘保存、崩溃恢复、全局执行槽、自动清理、设置表单重构、统一创建/实验工作区和取消运行。U3 只保护草稿退出；无草稿但有活跃操作的退出保护由 U4 补充，U5 统一文案。

## Decisions

### D1. 类型化草稿与会话边界

新增 `lib/debugging-drafts.ts` 纯逻辑，由现有 zustand store 持有独立 draft slice。字段更新事件同步写入 store，不能仅靠 debounce、失焦或卸载 cleanup 保存最后一次输入。未发生编辑不创建 dirty 项，不为所有 trace 预先复制 messages。选择器返回稳定引用，延续 U1/U2 对 zustand 快照稳定性的约束。

| 类别 | 身份 | 保存内容 |
|---|---|---|
| result | 当前打开的 runId + spanId + `result` | 只读基线文本、原始输入文本、修订 |
| prompt | runId + 首次 llm spanId + `system_prompt` / `user_message` | 两个独立字段的基线、原始输入、修订 |
| proxy | runId + llm spanId + `messages` | 基线 JSON 展示文本、原始 JSON 输入、修订 |
| 创建 | 单个会话创建 key | `mode`、`systemPrompt`、`userMessage`、修订 |
| A/B | runId + 首次 llm spanId + `model_ab` | 有稳定行 ID 的有序 `{model, paramsText}`、基线行内容、批次修订 |

键用结构化嵌套索引或无歧义元组编码，不用可能碰撞的字符串拼接。继承 span 使用当前作为父本的 runId，不把共同祖先的编辑偷偷共享到子/兄弟运行。创建及 A/B 各保留自己的结构，不抽象成任意字段的通用表单引擎。

保留用户原始字符串，包括末尾空格、换行、空串和非法 JSON；解析只在校验/提交边界进行，不将 parse/stringify 的结果回写编辑器。A/B 的 dirty 比较语义字段与行顺序，不比较随机行 ID；初始两臂不算修改。创建相对默认纯对话空表单比较，模式修改也算 dirty。目录显示引用可与创建会话关联，其变化纳入退出 dirty 汇总，但 token 和授权不进入 draft payload。

每次实际内容变化分配 renderer 会话内单调递增 revision；恢复/收起/查看不递增。删除后重建同 key 也不能复用旧 revision，防止 ABA。输入回到基线时 dirty=false、标记消失，可保留非 dirty entry；其后再次修改继续递增。dirty 只表示未放弃的编辑，不表示可提交或执行成功。

草稿只在 renderer 内存，无 localStorage/sessionStorage/URL/日志/设置文件/trace 持久化；新 renderer 会话从空仓库开始。模型连接和代理配置凭据由原设置流程管理，不读取并复制进草稿。用户自行输入到 prompt/messages 的任意文本不作破坏性删改，也不得出现在关闭 IPC 或诊断日志中。

### D2. 恢复、定位与原记录校验

编辑器打开时优先读匹配 key 的 draft，没有时从已校验详情创建基线；组件 mount、field 切换和读取刷新不能覆盖已有输入。打开状态属于临时 UI：返回步骤后可先显示草稿标记，点击恢复；不要求强制展开所有编辑器。步骤调用旁标记修改，步骤页标题可打开本 run 草稿列表；全局草稿入口也能列出创建和其他运行的草稿，保证源 run 消失后仍能找到内容。两个入口复用同一列表视图和选择逻辑，不再造第二份存储。

点击条目定位明确 run/span/field 或恢复创建/A-B 表单。定位失效时显示原身份、草稿文本、复制和放弃入口，不选择另一同名调用冒充恢复。普通阅读缓存淘汰、详情读取失败和 run 列表缺项不能删除草稿。

基线保存编辑目标所依赖的已校验源身份和内容签名（run meta、目标 span 及重建请求所依赖字段）；恢复后复用详情读取校验，比较必要源数据。缺失、读取失败、版本/能力不合法或源内容改变时保留草稿但禁止提交，不静默用新原文重置基线。恢复原来源并重新验证通过后才解禁；如要采用改变后的来源，先复制旧草稿并明确放弃，再重新编辑。本次不实现 U6 的缺父链详情降级。

prompt/A-B 恢复时按既有规则重新求首次 `llm.call`，核对其 ID 与草稿键相同，并重新验证自有记录、封存状态、配置指纹、所需消息及隔离限制等入口条件。不跳过不合法的首次调用而改用后续调用；span ID 相同也不等于执行资格仍有效。草稿不跨 renderer 重载保存，因此不新增能力算法版本签名或升级迁移，只比较事实源和当前门禁。

### D3. 编辑、核对与明确放弃

原值只读、新值可编辑，就近呈现；按可用内容宽度并排或上下排布，不为两个编辑器固定挤占窄窗。result/messages 使用现有 Monaco 包装，prompt 与 A/B 沿用现有控件。编辑态才加载资源，代码字号、正文可滚动及 U2 文件编辑器接线不回退。

“收起”、Esc、导航与设置往返仅隐藏编辑区并清除临时预检/授权；不删除 draft。对有变更的条目执行“放弃修改”时，确认明确目标；取消逐字保留，确认只删除该目标，prompt 的另一个字段及其他运行不受影响。创建放弃整个创建表单，A/B 放弃整个批次，不提供默认勾选全部草稿的批量清除。确认等待期间如目标修订已变，旧确认不能删除新修订，重新核对后才可放弃。

清空字段得到空串仍然是变更，不能绕开放弃确认。无变化时禁用重跑；空串能否提交沿用各字段既有契约（例如创建 system 可空、user 必填，messages 必须有效非空数组），非法输入照常保存。一次提交只使用当前目标，不合并其他 prompt/result 草稿。创建仍采用现有对话框，关闭后可经全局设置再打开恢复；就近配置入口及新的设置返回流程属于 U5。

### D4. 授权、sourceToken 和预检与草稿分离

以下内容不随草稿恢复：`writesAuthorized`、A/B 的 `allowSideEffects`、预检结果、dry-run 计划、执行确认和可提交结论。打开/恢复、改变目标或内容、切模式、离开编辑流程和每次提交尝试均使对应授权/计划失效；授权只用于当次构造的请求。返回后重新走原门禁，隔离 prompt/A-B 仍拒绝。

创建源目录放入独立的会话引用，仅含 main 已签发 token 及用于核对的 name/path，不写阅读偏好或持久状态。同一次未提交创建可在关闭/设置往返后保留引用，重新授权；main 仍是 token 是否有效的唯一判定者，恢复不延长 15 分钟，不重新签发，不通过 path 自动补 token。切模式或明确放弃创建清除引用；目录选择取消保留原引用，首次取消仍未选。

失效/已消费 token 的提交错误要求重新选目录，保留任务、系统指令和模式；不能泛化为所有失败均消费 token，消费点沿用现有 main。选择目录、预检和 A/B dry-run 的迟到响应按会话/目标/revision/请求代次校验，不能给修改后的草稿安装旧来源或旧授权。卸载时也使临时请求代次失效。

### D5. 提交修订与 U4/U5 交接

提交时从 store 原子取得当前 key、revision 及请求快照，记为 renderer 本地提交关联，并冻结该草稿的修改/放弃。现有 store 执行函数负责完成收尾，不把组件卸载或 `resetFork/resetCreateRun/resetModelAb` 当作解冻依据。A/B 冻结整批，创建冻结整份；其他草稿仍可编辑，但执行禁用继续沿用既有规则，本 change 不承诺跨入口统一槽。

临时授权随本次快照消费，不作为提交关联正文长期保存。执行响应只处理匹配的关联；任何 ok、业务错误、抛错、失败运行或部分 A/B 结果均不删除 draft。已明确返回/拒绝的本地请求可解除本次冻结，迟到回调不能解除新的关联。通道断开而无法确定执行是否仍在进行时保留草稿和冻结，不通过重开面板恢复执行；U4 才补可信核对。该边界不新增超时重发或把未核实操作标记为取消。

为 U5 保留 `{draftKey, submittedRevision}` 关联位置；不先引入假的 operationId/main epoch，也不实现按 completed 自动清理。U5 再与 U4 可信操作身份绑定，以真实自有终止事件和相同修订为清理条件。U3 的成功提交草稿仍显示为待处理，用户可在请求结束后明确放弃。

### D6. main 持有关闭决策，renderer 只报告元数据

新增独立 `main/draft-close-guard.ts`，由窗口创建时装配，在窗口销毁时解除监听。共享消息类型和通道放入 `shared/ipc.ts` / `shared/channels.ts`，preload 暴露受限报告与订阅/解绑接口，不暴露原始 ipcRenderer，不引入 zod 到 sandbox preload。

建议协议：main 为每个窗口文档会话生成 sessionId；renderer 报告 `{sessionId, sequence, dirtyCount}`，关闭查询携带 `{sessionId, requestId}`，应答增加当前 sequence/dirtyCount 及布尔值 `inputSettled`（锁前已接收输入完成同步，且无待收尾的输入法组合）。字段严格校验、计数为有界非负整数；main 验证 sender 是目标窗口当前主 frame，拒绝其他 webContents、子 frame、旧 session 和旧 sequence。关闭应答只认当前 requestId；正文、run 内容、token、授权和 apiKey 均不在消息中。

处理顺序：

1. 拦截 `BrowserWindow.close` 和常规 `app.quit` 路径，立即阻止默认关闭。同一窗口只允许一个关闭核对/原生确认，连续点击关闭复用当前流程。
2. 无论上次报告是否为 clean，都发起新鲜查询；renderer 先将控件/Monaco model 已接收的文本同步至 store，再设置退出核对输入锁并读取应答，防止“已回 clean 又继续输入”竞态。锁持续到本次关闭决定，不受查询超时长度限制；取消关闭后解除锁并恢复编辑焦点。
3. 查询发出后 1.5 秒内得到匹配的有效应答且 dirtyCount=0、inputSettled=true、无未解决的会话丢失状态时放行。dirtyCount>0 时使用绑定窗口的 `dialog.showMessageBox`，默认/取消选项为“返回”，另一选项为“退出并丢弃草稿”；明确仅当前会话存在且退出后不能恢复。
4. 超时、renderer unresponsive、render-process-gone、未完成握手、非法应答或 inputSettled=false 走“暂时无法确认草稿状态”的原生确认。超时只说明本次未及时取得可信状态，不能据此显示“已崩溃/已失联”。不能以最后一次 clean 或查询失败推断没有草稿，也不能无限等待。取消仍能继续留在应用，renderer 之后恢复可重新核对。
5. 确认退出只给当前关闭尝试一次性的 bypass，然后重新触发正常关闭；取消、窗口重建或后续会话不复用 bypass。迟到应答不能关闭已取消的窗口。

输入锁期间阻止新的编辑、粘贴、放弃与提交，不缓冲并在解锁后重放按键。锁前输入法组合已写入控件/model 的文字同样必须保留，不替换为旧基线；若组合尚未结束，则 inputSettled=false，不允许报告可直接退出的 clean。锁前组合产生的尾随 input/compositionend 可以同步收尾，更新修订/sequence，但不能借此接收新的编辑动作。原生确认期间收到该收尾也不自动关闭确认；用户选择返回后保留已接收文字并恢复编辑。输入法候选窗中尚未进入控件/model 的候选不视为应用已接收文本，不代用户选词或承诺恢复候选窗。

1.5 秒是当前的有界等待设计初值，不是实测的 renderer 存活阈值。验收对小于阈值和超过阈值的受控应答延迟分别验证，辅以 CDP CPU 降速；慢但仍存活的 renderer 超时后进入确认是允许的降级。必须验证取消后的输入/锁恢复、迟到应答不关窗和下次查询可正常完成。若实测需要调整阈值，先同步修改 design/spec 与测试，不宣称此值已在慢机校准。

renderer 重载/崩溃使旧协议 session 失效。旧会话 dirty 或状态不明时 main 保留“会话状态丢失”标志，新 renderer 空仓库不能静默消除此标志；下次关闭明确说明先前草稿可能已丢失，用户选择返回并知悉后可清除该遗留标志，新会话再走正常核对。该标志只存 main 内存，不保存正文，不声称能够防止崩溃丢失。

main 的退出原因汇总留一个小的组合入口供 U4 加入 active operations；本次只有 dirty/unknown 原因，不伪造执行状态。原生确认是唯一退出确认，不再叠加 renderer beforeunload 对话框。标题栏关闭、Alt+F4 与 app.quit 使用相同 guard，处理递归 before-quit 时不可绕过其他尚未核对的窗口。

Windows 注销、关机、系统重启不属于本 change 保证的常规退出：Electron 在这些路径不发 `before-quit`；`query-session-end` 可请求延迟系统结束，而 `session-end` 已不可阻止。U3 不接入阻止系统结束的异步查询/原生确认，不保证这些路径出现确认或恢复草稿；系统强杀、断电同样不保证。依据当前 Electron 类型附带文档核对了 [before-quit](https://www.electronjs.org/docs/latest/api/app#event-before-quit)、[query-session-end](https://www.electronjs.org/docs/latest/api/browser-window#event-query-session-end-windows) 与 [session-end](https://www.electronjs.org/docs/latest/api/browser-window#event-session-end-windows) 的事件语义，这些路径不能按普通 app.quit 验收。

### D7. 模态与焦点

复用一个小的 `ModalDialog` 基础组件，使用 Electron Chromium 支持的 `dialog.showModal()` 获得 top layer 和背景 inert，禁止继续只使用 `<dialog open>`。创建、设置、新增放弃确认接入；既有原生执行确认保留原生行为。组件负责初始焦点、可见可用控件间 Tab/Shift+Tab、关闭时焦点恢复；触发节点已卸载时回退当前工作区的有效标题或入口。

Esc 先由最上层模态/Monaco 内部弹层消费，再处理编辑区收起；不能一次按键同时关闭放弃确认和底层编辑器。创建执行中或目录选择中的既有 modalLocked 继续生效，不通过 Esc 绕开。设置中未保存值仍由 SettingsDialog 原流程管理，本 change 只修模态容器，不把设置输入纳入调试草稿或宣称已完成 U5 设置保护。

## Risks / Trade-offs

- 内存保留增加占用：按实际编辑惰性建条目，不自动淘汰 dirty 项；大文本验证不得截断输入。暂不提供无限历史和每次按键副本列表。
- 协商不是崩溃恢复：主进程只能保守提示状态未知，不能承诺已消失的 renderer 内存仍可复制。正常关闭时即时同步保存和输入锁避免最后一键与 clean 应答竞态。
- 既有执行状态仍有 R3/R4/R5 的局限：草稿保留验收不能冒充结果核实、跨页执行或在途操作退出保护已经交付。
- 单测不足以证明接线：U2 曾出现状态函数存在但控件未消费的问题；本 change 必须用真实事件驱动所有编辑入口并核对 store/DOM/实际 IPC，而非只查源码字符串或静态 HTML。

## Validation Strategy

以 [spec delta](specs/desktop-ui/spec.md) 的场景为准，tasks 逐项关联。纯逻辑测试覆盖身份、修订、dirty、输入原文与 CAS 放弃；renderer 集成覆盖卸载/重挂载、字段切换、来源异常和授权重置；main/preload 测试覆盖 sender/schema/session/sequence/requestId、超时和退出重入。

Electron 实测覆盖所有编辑类型，R2 原路径、创建→关闭→设置→新建、失败提交后返回、A/B 参数无效时的恢复、Tab/Shift+Tab/Esc、标题栏关闭/Alt+F4/app.quit、取消与确认退出以及 renderer 失联。单列最后一键/粘贴/中文输入法组合、锁内新输入阻止、受控延迟和 CPU 降速验收；Windows 系统会话结束只以隔离测试核对事件边界，不触发宿主机注销/关机。宽度验收为 1440、1210、1024、800 CSS px 四档，另做独立 200% 页面缩放，不要求全档宽度与缩放的笛卡尔积。记录实际视口与编辑文字区，禁止只用模拟盒子宽度冒充 Monaco 可读性。

调用仅使用受控本地服务，草稿操作的模型/工具调用数为零；执行回归按原通道单次提交。使用隔离测试数据目录，逐文件核对已有 trace/blob/源目录哈希；重启时草稿不恢复，磁盘无新增草稿内容。实现完成后跑适用 build/typecheck/desktop tests/Biome/OpenSpec 门禁，产出场景到断言和截图的 evidence-index，未运行项如实保留。

## Migration / Open Questions

无磁盘迁移，无主 spec 之外的新 capability；先实现存储和受限关闭协议，再逐编辑器接线，最后接入模态和实机验证。未完成前不归档。本 change 无需阻塞提案的产品选择；若实施发现现有字段契约与此处假设不符，先修本文和对应 spec，再继续实现。

评审后已确定系统会话结束不在退出确认保证内、锁内新输入不缓冲重放、恢复重验首次调用身份而不新增算法版本签名。1.5 秒阈值的慢响应体验仍待实施阶段验证，不把文档修订记为实测完成。
