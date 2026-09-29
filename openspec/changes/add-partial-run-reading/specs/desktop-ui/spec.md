## ADDED Requirements

### Requirement: 详情完整性在缺祖先文件时结构化降级

`runs:get` SHALL 在统一 IPC 信封中返回受校验的 `completeness`（`complete` 或 `ownOnly`）、`spanScope`（`resolved` 或 `own`）、`lineage`、`chain` 和 `leafSpanIds`。main SHALL 先完整校验当前 run，再按分支语义读取祖先；只有结构化确认缺失的是祖先 trace 文件本身时，才返回 `ownOnly`。`ownOnly` SHALL 只包含当前 run 自有且通过 reader、版本、schema 和跨行约束校验的 meta/spans/events/status，chain 按最早可读 hop 到当前 run 排列并在缺失点截断，`leafSpanIds` SHALL 精确对应当前 run 自有 spans。已可证明的无效身份、结构或定位 SHALL 优先拒绝，不能以更早祖先缺失遮蔽错误。

#### Scenario: 普通 result 的完整父链仍合并

- **WHEN** 普通 result 分支及其所有祖先文件均存在且通过版本、schema 和 fork 定位校验
- **THEN** 详情返回 `completeness=complete`、`spanScope=resolved`，轨迹按既有 `resolveBranch` 语义合并，chain 包含根到当前 run 的完整连续来源，`leafSpanIds` 只标当前 run spans

#### Scenario: 根 run 以自有轨迹返回

- **WHEN** 打开一个 `meta.parent=null` 且当前文件通过全部 reader、版本、schema 和跨行校验的根 run
- **THEN** 详情返回 `completeness=complete`、`spanScope=own`、`lineage.status=complete`，spans 只包含根 run 自有记录，chain 只有该根 run，`leafSpanIds` 覆盖其全部 spans

#### Scenario: 普通 result 缺祖先只读当前记录

- **WHEN** 当前普通 result 文件合法，但其某一级祖先文件明确不存在（包括直接父缺失与隔代祖先缺失）
- **THEN** 详情返回 `completeness=ownOnly`、`spanScope=own`、`lineage.status=incomplete`、`lineage.reason=ANCESTOR_NOT_FOUND` 及来自最近可读记录 `meta.parent` 的真实 `missingRunId`；spans/events/meta/status 只来自当前 run，chain 只保留当前向上连续可读的 hops，不拼接断点另一侧的未知历史

#### Scenario: 普通 result 的隔代祖先缺失

- **WHEN** 当前 run 和直接父 run 合法，但直接父的 `meta.parent` 指向不存在的祖先文件
- **THEN** 详情保留当前 run 与直接父的连续 chain，`missingRunId` 等于直接父声明的祖先 ID；不把当前 run 的直接父误报为缺失，也不拼接更早的未知轨迹

#### Scenario: prompt、代理和 model_params 的自有范围不等于降级

- **WHEN** 打开完整父链的 prompt fork、代理 messages fork 或 model_params 实验臂
- **THEN** 详情返回 `completeness=complete`、`spanScope=own`，只展示当前 run 自有 spans 并单独展示父级 chain；不得把 `own` 判为 ownOnly 或拼接独立执行的父轨迹

#### Scenario: 独立轨迹缺祖先也返回结构化 ownOnly

- **WHEN** prompt、代理 messages 或 model_params run 当前文件合法但某个祖先文件不存在
- **THEN** 详情返回 `ownOnly/own` 与 `ANCESTOR_NOT_FOUND`，当前自有输出、步骤、自有消耗和自有终止事实仍可读，继承前缀和祖先增量标为未知

#### Scenario: prompt fork 缺祖先不改变从头轨迹

- **WHEN** prompt fork 当前文件合法但其父文件不存在
- **THEN** 只显示该 prompt fork 自有 spans 和缺失来源，不能经 `resolveBranch` 补入父 spans，也不能把缺失父本当成普通 result replay

#### Scenario: proxy fork 缺祖先不借用代理记录

- **WHEN** proxy messages fork 当前文件合法但来源链中某个祖先不存在
- **THEN** 保留本次代理重发的自有 messages/llm 事实，缺失原因可见，不从其他 proxy run 或列表时间猜测父记录

#### Scenario: model_params 臂缺祖先不变成可比较结果

- **WHEN** model_params 实验臂当前文件合法但父链缺失
- **THEN** 只显示该臂自有 spans 和 ownOnly 状态，不计算共同祖先、沿链增量或臂间结论

#### Scenario: 当前文件或祖先不是可确认的缺失

- **WHEN** 当前 run 缺失，或祖先读取遇到无权限、JSON/schema 损坏、未知格式版本、v1 非法隔离字段、成环或非法 fork 定位
- **THEN** `runs:get` 返回明确失败信封，不返回 ownOnly，不通过通用 catch 或错误文本匹配放行部分详情

#### Scenario: 祖先文件损坏不降级

- **WHEN** 当前 run 合法，但祖先 JSONL 截断、跨行约束失败或 schema 非法
- **THEN** `runs:get` 返回祖先无效/不可读错误，不返回 ownOnly，不展示当前 run 的部分轨迹

#### Scenario: 未来版本祖先不降级

- **WHEN** 当前 run 合法，但祖先使用桌面尚不支持的 `format_version`
- **THEN** 版本守卫在 schema 转换前拒绝详情，不丢字段后继续显示或执行

#### Scenario: v1 祖先携带隔离字段不降级

- **WHEN** v1 祖先 meta、fork 或自有 span 携带非法隔离字段，即使值为 null、false 或空对象
- **THEN** 详情按版本守卫失败，不把该祖先当作文件缺失

#### Scenario: 祖先链成环不降级

- **WHEN** 父链重复访问同一 run ID
- **THEN** `runs:get` 返回成环错误并终止读取，不截断成 ownOnly，不死循环

#### Scenario: fork 定位非法不降级

- **WHEN** 祖先可读但 fork 缺少必需字段、`at_span` 不属于指定父轨迹或隔离边界不自洽
- **THEN** `runs:get` 返回 fork 定位错误，不用当前自有 spans 冒充可读的部分分支

#### Scenario: 父文件恢复后重试全量重验

- **WHEN** ownOnly 详情对应的缺失祖先文件恢复，用户重试读取
- **THEN** main 重新读取并校验当前 run 及完整父链，只有所有版本、schema、跨行和 fork 定位校验通过才返回 `complete`；不局部拼接、不仅隐藏警告、不写回任何 trace/blob/source

#### Scenario: 读取重试不改变阅读位置

- **WHEN** 用户在 ownOnly 详情中重试读取，期间切换步骤、页签或当前 run
- **THEN** 旧读取响应不能覆盖新的阅读位置；恢复后的详情只应用到发起请求的 run ID，不抢焦点或自动导航

#### Scenario: 详情完整性字段拒绝错配

- **WHEN** IPC 载荷声明 `complete/ownOnly`、`resolved/own` 或 lineage 状态与 chain 不相容
- **THEN** main 与 renderer 两处拒绝整份载荷；chain 非空且 ID 唯一，末跳与 meta 一致、相邻 parent 连续，complete 首项为根，ownOnly 首项 parent 等于链外 missingRunId；own 的 leaf ID 精确覆盖 spans，resolved 的 leaf ID 为不重复子集，不能借未知字段剥离接受错配

#### Scenario: 文件身份与路径不能伪造来源

- **WHEN** 当前或祖先 ID 含目录穿越/绝对路径/分隔符，或文件内 meta.id 与请求 ID 不符
- **THEN** 在目录外读取前拒绝非法路径，身份不符则拒绝详情；不返回 ownOnly，不从错误正文猜测缺失 ID

#### Scenario: 已知无效关系不能被更早缺失遮蔽

- **WHEN** 可读 hop 缺 fork、祖先未封存、v2 边界不属于可读直接父，或存在其他已可证明的非法关系，且更早祖先文件缺失
- **THEN** 返回严格错误；仅当定位依赖不可得祖先而暂不能核实时才可标 ownOnly，不能把未核实谎称校验通过，也不能把它误报为已证实非法

#### Scenario: 合法零 span 记录可部分读取

- **WHEN** 当前 run 合法且尚无自有 spans，祖先文件不存在
- **THEN** 返回 ownOnly、空 spans/leafSpanIds 与当前自有事件；空数组不被当作损坏，也不借祖先终止事件推断当前结局

#### Scenario: 读取诊断不泄漏路径和正文

- **WHEN** 读取遇到缺文件、权限或含输入内容的解析错误
- **THEN** 失败保持 GET_RUN_FAILED 信封与受控中文原因，成功降级仅暴露合法缺失 ID；不透传物理路径、堆栈、正文或凭据

### Requirement: 运行详情的来源完整性控制主动执行

五类引用父本的主动入口（普通/隔离 result、prompt、代理 messages、model_params/A-B）SHALL 在 U4 判重、接受占槽之后，由 main 重新检查被引用详情的可读性、完整性及原有领域门禁。详情加载失败 SHALL 返回 RUN_DETAIL_UNREADABLE；ownOnly SHALL 返回 RUN_LINEAGE_INCOMPLETE；均在授权消费、业务文件写入、工具或模型请求前拒绝，按 settled/rejected 回执收口并释放本操作槽。renderer 的 disabled 或提交的完整性声明 SHALL NOT 是保护依据。只读重试不重发执行；无父本的普通/隔离 create 保持原契约。

#### Scenario: ownOnly result 不可重跑

- **WHEN** 用户从 `ownOnly` 普通或隔离 result 详情提交 result 编辑，或绕过 UI 直接提交对应 IPC
- **THEN** main/core 返回稳定的来源不完整拒绝，零授权消费、零文件/blob 写入、零工具调用和零模型请求，且不产生新的运行记录

#### Scenario: ownOnly prompt、代理和实验臂不执行

- **WHEN** 用户对 `ownOnly` prompt、代理 messages 或 model_params/A-B 记录发起主动执行
- **THEN** 各入口统一拒绝并保留具体缺失原因；不得降级成普通 handler、从当前源目录补父链或仅依赖 renderer 按钮禁用，操作登记按 U4 既有拒绝语义处理

#### Scenario: ownOnly 隔离 result 不消费副本授权

- **WHEN** 对 ownOnly 隔离 result 提交符合现有 schema、带 allowFileWrites 的执行请求
- **THEN** main 在使用副本授权、创建文件世界或写入 trace 前拒绝；不为 result 新增创建路径的 sourceToken 字段，测试必须确实进入来源门禁

#### Scenario: ownOnly model_params dry-run 保持只读

- **WHEN** 对 ownOnly model_params 记录请求计划预览或真实 A/B 执行
- **THEN** 计划预览返回来源不完整原因，不生成可执行计划、不调用网络、不写文件、不创建 operation 或占槽；真实执行整批在第一臂前拒绝，零臂身份，登记按 settled/rejected 收口

#### Scenario: 读取重试与执行严格分离

- **WHEN** ownOnly 详情的父文件尚未恢复或用户点击“重试读取”
- **THEN** 只发起一次只读 `runs:get`（按读取代次防旧响应覆盖），不创建 operation、不消费授权、不调用模型/工具；恢复为 complete 后仍须重新通过原有执行预检

#### Scenario: 详情加载失败在执行入口即拒绝

- **WHEN** 当前 run 缺失、祖先损坏、版本不支持、成环或 fork 定位非法时尝试任一主动入口
- **THEN** 已通过身份/schema 且被接受的请求保留 settled/rejected 登记、匹配回执与空 runIds，返回 RUN_DETAIL_UNREADABLE 并仅释放自身槽；零授权消费、零业务文件、零工具和零模型调用

#### Scenario: 父链恢复不复活已拒绝操作

- **WHEN** 来源不完整导致操作 settled/rejected 后恢复父文件，再次提交同 operationId；或旧 epoch、异参、reconcile 封禁请求到达
- **THEN** 先执行 U4 判重/身份/封禁规则，不重读父本或再次执行；只有用户重新检查并使用新 ID 才可能执行，不更改原拒绝终态或另一操作的槽

#### Scenario: 预检后父链变化仍由 main 拒绝

- **WHEN** UI 已取得完整详情及确认，但正式提交前父文件消失，或 renderer 绕过禁用直接调用有效 IPC
- **THEN** main 重读后以 RUN_LINEAGE_INCOMPLETE 拒绝并保留草稿；renderer 从读取/预检或拒绝响应得知来源变化后，使旧 capability、A/B 计划、确认和副本授权失效，恢复父链必须重新检查与确认；main 不新增许可吊销登记或文件监听，未被读取发现的变化也不能绕过提交时重验

#### Scenario: 隔离 capability 对不完整来源明确拒绝

- **WHEN** ownOnly 隔离父本请求只读 forkCapability
- **THEN** 返回不可执行及来源缺失原因，不授予许可、不登记或占槽、不写文件；合法自有文件阅读仍可进行

#### Scenario: 无父本创建和被动录制保持原契约

- **WHEN** 当前页面选中 ownOnly run 时用户另行创建普通/隔离 run，或发生被动代理录制
- **THEN** 不把所选详情隐式当成父本；创建仍受原 U4 槽和授权控制，被动录制仍不占主动槽且不借用主动身份

### Requirement: 部分详情沿用自有结果核实与草稿收尾

U5 结果核实 SHALL 对 ownOnly 保持请求 runId、meta.id、chain 末跳、版本与 schema 核对，自有终止事实与来源完整性分别展示。自有 stopped/completed SHALL 继续参与原提交修订/token 匹配清理；来源不完整不得伪造运行失败或授予执行资格。后台读取及手动重试 SHALL 保持导航、通知和读取代次规则。

#### Scenario: ownOnly 正常结果仍按原修订清理

- **WHEN** 已 settled 操作的可信 runId 返回合法 ownOnly，且自有 stopped/completed，存在匹配的原提交关联
- **THEN** 后台核实进入原 U5 原子修订清理；较新 revision/token 不被删除，操作面板同时显示自有结局与来源缺失，不以 status=completed 代替严格事件判据

#### Scenario: ownOnly 失败定位只使用自有调用

- **WHEN** ownOnly 结果自有终止为 error/限制/中断，或当前详情仍不可读
- **THEN** 保留草稿；有自有失败调用才提供定位，否则诚实说明无可定位调用，不从祖先补错，不修改 main 请求结局

#### Scenario: 部分实验结果保留完整批次判据

- **WHEN** A/B 的一个或多个结果详情为 ownOnly
- **THEN** 仍按全部预期臂、唯一可信身份、同批 experimentId 与各自正常终止判断整批清理；缺臂/null ID/错误/不可读任一存在均保留整批，不推断胜出臂

#### Scenario: 后台重试不导航也不重发执行

- **WHEN** 手动重试结果从不可读变 ownOnly 或从 ownOnly 变 complete，且用户已切换阅读位置或重载 renderer
- **THEN** 仅更新匹配身份与代次的读取项；可核实正常终止时只按尚存在的原关联清理，不猜草稿、不抢焦点、不重复通知、不自动导航或执行，旧 epoch/旧响应不能覆盖新状态

#### Scenario: 部分详情提示和恢复动作可达

- **WHEN** 在 800/1024/1440 CSS px、独立 200% 缩放与真键盘下阅读含长缺失 ID 的详情或操作结果
- **THEN** 来源警告、就近禁用原因、只读重试和复制信息可读可达；Tab/Shift+Tab 可到达动作，重试保持有效步骤/页签/文件/滚动位置，失效引用沿用 U1/U2 回退

## MODIFIED Requirements

### Requirement: 分支 run 展示解析后的完整轨迹

`parent` 非空的 run SHALL 依据详情的完整性与轨迹范围展示。普通/隔离 result 只有在 `completeness=complete` 且 `spanScope=resolved` 时才展示共享前缀与自有新增 span：v1 截至 fork 点（含该点），v2 按 resume_after_step 保留整轮及后代，遵守既有 resolver 定位规则。界面 SHALL 标注分叉点 span、被编辑字段，并明示前缀来自哪个父 run。prompt、代理 messages 和 `model_params` 即使完整也 SHALL 只展示当前 run 自有 spans，并单独展示父级 chain，不声称共享执行前缀。混合链 SHALL 逐 hop 尊重独立执行边界。ownOnly SHALL 只展示当前 run 自有 spans，持续显示父链不完整及结构化缺失原因。

#### Scenario: 分支 run 的轨迹

- **WHEN** 打开一个 `completeness=complete`、`spanScope=resolved` 的普通 result 分支
- **THEN** 树呈现父 run 截至 fork 点的前缀加上本 run 新增 spans，分叉点和被编辑字段均被标注，界面提示前缀所属父 run

#### Scenario: 完整独立分支不拼接父轨迹

- **WHEN** 打开一个 `completeness=complete`、`spanScope=own` 的 prompt、代理或 model_params 分支
- **THEN** 时间线只呈现本 run 自有 spans，父级 chain 作为独立来源信息展示，不声称存在共享执行前缀

#### Scenario: 部分普通分支不伪造共享前缀

- **WHEN** 打开一个 `completeness=ownOnly` 的普通 result 分支
- **THEN** 时间线只呈现当前 run 自有 spans，显示“仅显示本运行记录，父链不完整”和缺失 run ID；不补零、不显示祖先增量、不将 chain 断点两侧拼成完整轨迹

#### Scenario: 部分来源链首项不冒充根

- **WHEN** ownOnly chain 从当前 run 向上保留了一个或多个可读中间 hop，但根 run 缺失
- **THEN** 来源区域明确标为截断链，不能把 `chain[0]` 显示为根或绘制一条虚假的根到叶连接

#### Scenario: 完整普通分支保留被编辑字段

- **WHEN** 打开一个完整普通 result 分支，其 fork 编辑字段为 `result`
- **THEN** 分叉点同时标注 span、被编辑字段和直接父 run，合并轨迹与既有完整语义一致

#### Scenario: 独立分支来源链完整但不共享执行前缀

- **WHEN** 打开完整 prompt、proxy 或 model_params 分支并展开父级来源
- **THEN** 父级只作为 lineage 展示，本 run 时间线不插入父 spans，用户能区分“父级溯源”和“共享执行前缀”

#### Scenario: ownOnly 文件入口不显示祖先检查点

- **WHEN** ownOnly 隔离 run 有当前自有完成步骤，但缺失祖先也有文件检查点
- **THEN** 文件选择器只列当前 run 初始状态和自有完成步骤，不显示或读取祖先检查点，不回读源目录

#### Scenario: 完整隔离 result 保留整轮前缀

- **WHEN** v2 隔离 result 及其父链通过版本、schema 与定位校验，编辑点后同轮还有兄弟工具调用
- **THEN** 返回 completeness=complete、spanScope=resolved、lineage.status=complete，chain 为完整根到叶来源且 leafSpanIds 仅含当前自有 spans；前缀保留 resume_after_step 整轮及全部后代，不按 at_span 截掉后续兄弟；边界不属于直接父自有步骤时拒绝

#### Scenario: 混合父链不跨独立边界拼接

- **WHEN** result 子分支引用从头执行的 prompt/model_params 父本，且完整来源链中还存在更早祖先
- **THEN** chain 保留全部来源，子分支只取直接父有效轨迹的对应前缀和自身新增记录，不再混入独立边界之前的祖先 spans；未知 edit.field 明确拒绝而非默认 result

#### Scenario: 缺祖先与缺附件分别诊断

- **WHEN** ownOnly 隔离 run 打开合法自有检查点，其 blob 存在或缺失
- **THEN** 存在时正常按 C 校验读取，缺失时显示原附件错误；不把 blob 缺失当祖先缺失，不因来源缺失封禁全部自有文件阅读
