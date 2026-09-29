# U6 设计：部分详情读取与完整性门禁

## Context

基线为 U5 归档后的 `desktop-ui` 59 requirements / 278 scenarios。依据 U4 的接受顺序与证据纪律、U5 的结果核实/草稿收尾及其遗留限制修订。本轮仅修改 change，任务均未实施。

源码依据：`apps/desktop/src/main/run-repository.ts` 的普通分支调用 `resolveBranch`；prompt/proxy 的 `buildLineageChain` 吞掉全部读取异常并静默截链；`model_params` 没有独立分支。`packages/trace-sdk/src/reader.ts` 的文件读取保留原生 fs 错误，reader 已做版本、schema 和隔离跨行校验，但不证明所有父子定位或文件 ID 一致性。不得把这些额外校验说成已有能力。

`exec-endpoints.ts` 的 `submitActive` 先接受登记，再进入业务门禁；`result-verification.ts` 与 `shared/terminal-facts.ts` 按请求 ID、chain 末跳和自有事件核实结果。U6 必须同时接入这些消费点。

## Goals / Non-goals

仅在祖先文件确实不存在时显示已校验的当前记录，所有引用不完整父本的桌面执行仍拒绝。其余 Non-goals 见 proposal；不修改 JSONL 或 replay 公共执行契约，不实现 U7 比较、U8 工作区、取消、并发或跨 main 恢复。

## Decisions

### D1. 统一详情完整性元数据

`RunDetail` 增加受校验字段：

```ts
completeness: "complete" | "ownOnly"
spanScope: "resolved" | "own"
lineage:
  | { status: "complete" }
  | { status: "incomplete"; reason: "ANCESTOR_NOT_FOUND"; missingRunId: string }
leafSpanIds: string[]
```

| 情形 | completeness | spanScope | spans | lineage |
| --- | --- | --- | --- | --- |
| 根 run | complete | own | 自有轨迹 | complete |
| 完整普通/隔离 result | complete | resolved | 按对应 v1/v2 语义合并 | complete |
| 完整 prompt / proxy / model_params | complete | own | 自有轨迹 | complete |
| 祖先文件确实缺失 | ownOnly | own | 仅当前 run 自有轨迹 | incomplete/ANCESTOR_NOT_FOUND |

`own` 不代表降级。main 依据已校验 fork 类型生成字段，renderer 不从 chain 长度猜完整性。chain 总是从最早可读 hop 排到当前 run；ownOnly 的首项不保证是根。

main 负责验证文件事实，shared schema 负责载荷内可证明的一致性：chain 非空、ID 唯一、末跳 meta/fork 与当前 meta 一致、相邻 parent 连续；complete 的首项 parent=null；ownOnly 的首项 parent=missingRunId 且该 ID 不在 chain 内。完整 lineage 不允许携带缺失字段。span/leaf ID 不重复；own 范围 leaf ID 与 spans 的 ID 集合精确相等，resolved 为当前自有 span 集合且是 spans 子集。合法零 span 记录允许空数组，不把“空”当作损坏。renderer 无法仅凭合并载荷证明自有归属，main 必须与当前原始记录逐项核对。

### D2. 严格读取、可证明错误优先与缺失边界

桌面 repository 内建立单次读取上下文，按请求 ID 缓存本次已验证的 RunRecord；不写磁盘缓存，不跨调用复用缺失/完整性结论。流程：

1. 校验当前 ID 与每个 parent ID 为数据目录内合法文件标识，拒绝绝对路径、分隔符、目录穿越；读取后核对 `meta.id` 等于请求 ID。缺当前文件直接失败。
2. 在 schema 转换前跑已有版本守卫，再执行 reader 的 schema/跨行检查。额外检查当前和每个可读 hop 的 parent/fork 结构、span 唯一性、身份和已能证明的定位约束；根带 fork、分支缺 fork、循环或祖先未封存不能因后续文件缺失而被遮蔽。
3. 向上读取，只有对合法祖先 trace 路径的读取返回原生 `ENOENT`（或有明确类型的等价结果）才记缺失。EACCES/EPERM、EIO、目录代替文件、JSON/schema/版本错误均失败；不比较异常文本，也不将附件缺失转成祖先缺失。
4. 缺失时停止遍历，missingRunId 来自最接近断点的已校验 parent；只返回当前自有 spans/events/status 和可读连续 chain。对依赖缺失祖先才能核实的 v1 at_span，标为来源未核实而非断言非法；但可读直接父已足以证伪的 v2 整轮定位必须拒绝。不得在缺失之前跳过已发现的错误。
5. 完整时按 D3 验证全部分支语义并投影。恢复后重新执行 1–5，重验失败仍是详情错误，不能只隐藏提示。一次调用复用同批已读记录，不先探测 exists 再把另一轮读取的结果混入。

内部分类保持 `CURRENT_RUN_NOT_FOUND`、`ANCESTOR_NOT_FOUND`、`ANCESTOR_INVALID`、`ANCESTOR_UNREADABLE`、`LINEAGE_CYCLE`、`FORK_INVALID`；当前损坏等仍为普通严格读取失败。`runs:get` 失败保持 `GET_RUN_FAILED` 信封兼容，返回受控中文原因，不透传 fs 路径、堆栈或含正文的 ZodError。成功的缺失诊断仅暴露受校验的 missingRunId。无需改 trace-sdk 公共错误类型。

### D3. 来源链和轨迹投影分开

来源完整性总是检查整条 parent 链，独立执行不切断溯源。展示轨迹逐 hop 分类：

- 根为自有 spans。
- 普通 v1 result 沿父轨迹截到 at_span（含该 span），追加本次自有 spans。
- 隔离 v2 result 按 `resume_after_step` 保留整轮和全部后代，再追加本次自有 spans；边界和编辑点须属于直接父自有记录，保留 `resolveWholeRound` 的既有判据。
- prompt/system_prompt/user_message、proxy/messages、model_params 是独立执行边界，轨迹重置为该 hop 自有 spans，chain 仍包含更早来源。其 fork 定位按已有对应领域语义校验，不能套 result 的截断算法。

独立定位的源码锚点是 `packages/replay/src/prompt-fork.ts`（prompt/model_params 的 at_span 为父本首次 llm.call）和 `apps/desktop/src/main/proxy-manager.ts`（messages 定位代理父本所选 llm.call）。只读验证其结构与来源位置，不调用这些会执行请求的编排函数，也不要求当前配置/代理凭据才能读历史。

纯 result 链复用 `resolveBranch` 与本次已读记录；混合链在桌面只读投影中逐 hop 处理独立边界并复用/提取等价的 result 截断逻辑，禁止直接把整条混合链交给只会拼接的 resolver，也禁止伪造 parent=null 或修改原 RunRecord。若实现需要共享纯函数，只作不改变原调用行为的最小提取，不扩张包的公开执行契约。完整 result 子分支引用 prompt/model_params 父本的 fixture 必须锁定这一点。

未知 edit.field 不得因为字段是自由字符串就默认成 result；无法识别的分支返回明确不支持错误。独立分支完整可读仍不代表有执行资格，隔离父本、配置、工具等领域限制保持原样。

### D4. IPC 与全部 renderer 消费点

main 构造并校验完整 `RunDetail` 后返回现有信封；preload 保持受限方法面。renderer 的选中详情读取和 U5 按 ID 后台结果核实两条入口都先身份/版本守卫、再 schema 校验；不能只更新 `selectRun`。同步迁移 tests/fixtures/API 桩，非法组合整份拒绝。

概览、步骤、来源链、分支区域与操作结果均显示“仅显示本运行记录，父链不完整”和缺失 ID；自有输出/消耗/事件可读，继承前缀、共同祖先、祖先增量、无法核实的编辑原值显示未知或不适用。不可把当前 `chain[0]` 当根，不得用列表缓存生成完整来源。现有对比与沿链派生必须受完整性限制；U7 的新比较能力不在此实施。

`WorkspaceFileView` / `workspace-view.ts` 保持 C 的当前 run 初始和自有完成步骤清单、哈希与 blob 校验。缺祖先不应阻断合法自有文件，缺 blob 仍按 C 显示附件错误，不回读源目录，不增加祖先检查点。

详情刷新复用 run ID、读取代次与导航代次守卫，保留有效页签/步骤/滚动/文件位置，失效定位按 U1/U2 回退。后台结果重试与当前详情刷新各更新各自读取状态，不借 `selectRun` 抢导航，也不另起轮询或自动执行。

renderer 在读取/预检或执行拒绝响应中得知该父本来源已不完整或不可读时，使旧 capability 结果、A/B 计划、确认和副本授权失效：复用 U5 检查代次与确认状态，清除对应可提交状态并要求重新检查，保留草稿正文。父文件恢复不能自动复活这些状态。main 则在每次新提交中重新读取并校验来源，不信任旧预检；不新增已签发许可登记、主动吊销协议或文件监听。尚未被读取发现的外部文件变化不承诺即时更新 UI，但正式提交仍由 main 重验拒绝。

### D5. U4 接受顺序与来源门禁

五类引用父本的入口由 main 服务端重读来源，不能接收客户端自称的 completeness。顺序固定：sender/请求/epoch 校验 → 判重/封禁/忙碌 → 原子 running 与占槽 → 原有只读配置检查及来源检查 → 领域预检 → 业务副作用。来源检查必须位于所有执行、token 消费、创建文件世界或新 run 之前。

| 路径 | U6 接入与拒绝 |
| --- | --- |
| 普通 result / 隔离 result | `execForkRun` 被接受的分支调用共享来源判据，随后原 runFork/runForkIsolated 门禁 |
| prompt | `execPromptFork` 同判据，随后原 prompt 门禁 |
| proxy messages | `execProxyFork` 同判据，在 `ProxyManager.fork` 发请求/录制前 |
| A/B 真实执行 | `execModelAb` 整批在第一臂前检查，零创建臂/运行身份 |
| A/B dry-run、隔离 capability | 只读端点同判据，不完整返回不可执行原因，无有效计划/许可，不登记、不占槽 |
| 普通/隔离 create、被动录制 | 无引用父本，不加 U6 门禁；回归 U4 的原槽/身份语义 |

被接受后的 `ownOnly` 领域拒绝使用稳定码 `RUN_LINEAGE_INCOMPLETE`；严格详情读取失败用 `RUN_DETAIL_UNREADABLE`，两者映射 `settled/rejected` 并返回匹配回执，runIds=[]，finally 只释放本操作的槽。这里的零副作用指零模型/工具/业务文件/授权消费，不包括必要的操作登记。已知的原配置等先行拒绝保留原码；后续原领域门禁不因 complete 绕过。

同 ID 重复必须先命中 U4 去重，父文件恢复也不能复活已拒绝的 ID；异参/旧 epoch/reconcile tombstone 保持原行为。新执行必须由用户重新检查并使用新 ID。若来源在 UI 预检后消失，main 的本次检查仍拒绝；检查之后外部磁盘变化仍由原严格 loader/领域门禁处理，不承诺跨进程文件系统事务或补历史重试。

隔离 result 的现有请求使用 `allowFileWrites` 等副本声明，不包含创建路径的 sourceToken；不得为了测试 U6 给它新增 token 字段。以真实 schema 构造有效请求，避免测试先被非法 payload 拒绝而假称命中了来源门禁。

### D6. U5 自有终止事实、草稿与导航

来源完整性、自有运行结局、main 请求结局三者独立。按可信 runId 核实身份、版本、schema 后，ownOnly 的自有 `stopped/completed` 仍可进入 U5 原修订匹配清理；不增加“必须父链完整才清草稿”的新门槛，也不因 status=completed 就清理。error/限制/中断/不可读保留草稿；错误定位只认 leafSpanIds。A/B 仍需全部预期臂唯一、齐全、同批且自有正常终止，缺臂/null ID 不清理。

操作结果保留来源警告和读取重试动作，避免“正常结束”被理解为可重跑。手动重试最终核实正常结束可按原关联清理匹配修订，但不导航、不重复通知、不执行；新修订或新 token 仍受保护。renderer 重载无原关联时不得猜测草稿，迟到响应不得跨 run/epoch 覆盖状态。真实 store 接线测试须同时覆盖后台核实、草稿收尾、操作展示和显式打开失败调用。

## Delta 策略与兼容性

仅改 `desktop-ui` delta，不直接改主 spec。新增详情完整性、来源执行门禁及 U5 部分结果衔接要求；MODIFIED 完整替换“分支 run 展示解析后的完整轨迹”，保留“分支 run 的轨迹”名称及分叉点/被编辑字段/父来源义务，明确 v2 整轮与独立分支例外。归档前机器比较 requirement/scenario 标题及有意变更清单，不能只看 strict 通过。

有意变更：普通/隔离 result 缺祖先由失败改 ownOnly；prompt/proxy 不再吞损坏/循环错误；model_params 不再误合并；混合链按独立边界展示；桌面独立执行入口与只读预检新增完整来源要求。包层执行继续严格，旧 JSONL 不迁移。shared/main/renderer 同批迁移，不允许静默缺省 completeness。

## Validation Strategy

任务按 <=2h 切片，每项对齐具名 scenario；先 fixture/纯判据，再真实 repository/IPC/store 消费点，最后 Electron。证据索引逐场景标“计划/已验证/环境受阻/实机不可达”，单元、契约、实机分开，不虚构测试标题或将截图存在等同通过。回查脚本验证引用真实存在且属于对应文件，加入漏行/挂错文件的反例。

受控临时数据目录内备份→注入→finally 还原→逐字节核验，含失败时保留恢复指引；验证源/父/兄弟/既有 blob 不变。恢复父文件是 fixture 的动作，产品本身零写入。覆盖真实 ENOENT、损坏、版本、循环、非法定位与可读错误叠加更早缺失；权限故障若 Windows 环境不可稳定诱发，使用受控 fs 故障注入并标注层级，不伪称实机。

端点零副作用计数必须有合法完整父本的可达正对照；移除来源门禁时对应负例须变红。UI 禁用、直调预加载 IPC、后台结果收尾分别验收，不能以源码扫描代替行为。800/1024/1440 CSS px、独立 200% 与真键盘验证长 ID/警告/重试/禁用原因可达，U1–U5 完整链流程回归。

## Risks / Trade-offs

- 当前 chain 载荷不足以独立证明所有文件事实，main 严格读取不可被 renderer schema 替代。
- mixed chain、v2 整轮与缺失下未能核实的定位须分别建 fixture，不能用统一 at_span 算法覆盖全部分支。
- U4/U5 的真实满载 IPC、configurationBusy 关闭文案、跨 epoch 在飞实机前提、ProxyManager 被动交错反证以及空 diagnostics 仍属历史限制，未补证据不得称已解决。
- 没有真实取消通道、不可变 preload 桥也未必可注入所有故障；如实按契约/集成层覆盖，不为造实机证据添加产品后门。

## Open Questions

无阻塞问题。实施如发现领域定位契约与这里不符，先修 proposal/design/delta，再继续；文档审阅通过不等于实施验收或归档。
