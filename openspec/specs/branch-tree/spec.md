# branch-tree Specification

## Purpose
把一次次「改了某步再重跑」累积出来的 run 家谱画成一张图：节点是一次运行，边是一次分叉，让用户在多分支里看见自己的探索路径，并把几个分支的代价与结局并排对照。全部从既有 trace 数据（parent / fork / 自身 span）纯派生，只读。

## Requirements

### Requirement: 分支森林从 run 的 parent 关系纯派生

系统 SHALL 依据 run 列表里每条 run 的 `parent` 字段构建分支森林，且 SHALL NOT 为构建树读取任何 run 文件或发起任何额外 IO。子节点顺序 SHALL 确定性（`created_at` 升序，同一时刻按 `id` 升序）。

父 run 不在列表中的 run（祖先文件被删、或指向未知 id）SHALL 被提升为根，并标注「父缺失」，SHALL NOT 被丢弃、SHALL NOT 报错。`parent` 链成环时（如两条 run 互指）系统 SHALL 断开环：把遍历中首次重复访问的 run 提升为根并标注「父链成环」，SHALL NOT 死循环、SHALL NOT 崩溃、SHALL NOT 猜测真实父子关系。

#### Scenario: 三层分支链

- **WHEN** 数据目录含 run A（根）、run B（parent=A）、run C（parent=B）
- **THEN** 森林只有一棵树，根为 A，A 的子节点为 B，B 的子节点为 C，深度依次为 0 / 1 / 2

#### Scenario: 父 run 不在列表中

- **WHEN** run X 的 parent 指向 id `r_missing`，而列表中没有该 id 的 run
- **THEN** X 被作为根呈现并标注「父缺失」，其余 run 的树结构不受影响，列表与详情读取均不报错

#### Scenario: parent 链成环

- **WHEN** run P 的 parent 指向 Q，且 run Q 的 parent 指向 P
- **THEN** 两条 run 都出现在森林中（各自或其中之一被提为根并标注「父链成环」），构建过程终止，界面不白屏、不卡死

#### Scenario: 空数据目录

- **WHEN** traces 目录下没有任何 run
- **THEN** 森林为空，分支树视图呈现空状态引导文案（指向「先跑一次或用代理录一次」），不报错

### Requirement: 分支树以节点-边图呈现运行与分叉

分支树视图 SHALL 以图形呈现：每个节点代表一次 run 并展示任务摘要、稳定唯一短 ID、记录模型、状态、创建时间、本 run 增量（步数 · tokens）；每条边代表一次分叉，SHALL 标注分叉摘要与被分叉的 span id——摘要由 `fork.edit.field` 映射（`"result"` → 「改 tool_result」、`"messages"` → 「改 messages」、其他 → 「改 <field>」），SHALL NOT 推断编辑内容。

底层记录状态 SHALL 保持 `completed` / `crashed` 两态；节点展示 SHALL 结合该 run 已校验摘要的状态与终止原因，与运行列表及概览使用一致的状态文字和语义色。`completed` 仅表示封存，SHALL NOT 单凭该值展示正常成功：reason 为 `completed` 时显示「已结束」及正常色，`error` 显示「出错终止」及红色，`max_iterations` / `budget_exceeded` 分别显示「达到迭代上限」/「超出预算」及琥珀色，`aborted` 显示「已中止」及中性色。`crashed` 显示「运行中断」及中性色，SHALL NOT 推断为仍在执行；已封存摘要的 reason 缺失或未知时 SHALL 显示「结束原因未知」、保留可查看的原值并使用中性色。状态 SHALL 有可读文字，不能只依赖颜色；正常结束 SHALL NOT 表示测试通过或任务质量已验证。工具曾出错但最终正常结束时 SHALL 仍按终止原因展示，不将工具错误数当作整次运行失败。

选中某个 run 时，系统 SHALL 高亮已知根到该 run 的连续来源链；该链表示来源关系，SHALL NOT 一律称为共享执行前缀。prompt、代理 messages、model_params 的独立执行不能因来源高亮变成共享前缀。点击节点 SHALL 选中并加载该 run 的详情，保持树视图；打开运行 SHALL 是独立明确动作，进入运行工作区并恢复有效阅读位置。

#### Scenario: 多分支家庭呈现

- **WHEN** 存在根 run A 与两条子分支 B1、B2（均 parent=A，fork.edit.field="result"）
- **THEN** 图上出现一个根节点与两个平级子节点，两条边分别标注「改 tool_result」并各自标出自己的分叉点 span id

#### Scenario: 代理分叉的边标注

- **WHEN** 某 run 由代理重发产生（`fork.edit.field="messages"`）
- **THEN** 其入边标注「改 messages」，与 replay 分叉（「改 tool_result」）在图上可区分；树 SHALL NOT 区分两者的拼接语义（语义差异只在详情面板体现）

#### Scenario: 选中高亮共享前缀

- **WHEN** 用户点击深层分支 C（A → B → C）
- **THEN** A、B、C 三个节点与 A→B、B→C 两条边被高亮，C 的兄弟分支及其子树不高亮；高亮表达已知来源链，共享执行前缀须按各 hop 的真实分叉语义另行核实

#### Scenario: 无分支时退化呈现

- **WHEN** 数据目录只有一条 run（无 parent、无 fork）
- **THEN** 图上呈现单个节点，无分叉边，不隐藏视图、不提示「无分支可用」

#### Scenario: 节点按封存运行的终止原因区分结局

- **WHEN** 树包含 status 均为 completed、reason 分别为 completed、error、max_iterations、budget_exceeded、aborted 的运行
- **THEN** 节点分别显示已结束、出错终止、达到迭代上限、超出预算、已中止；错误为红色、限制为琥珀色、中止为中性色，与列表/概览一致；底层 status 不变，不因封存全部染成正常绿色

#### Scenario: 节点对中断和未知原因诚实降级

- **WHEN** 树包含 crashed 的运行及已封存但摘要 reason 缺失或未知的运行
- **THEN** 前者显示运行中断，后者显示结束原因未知且原值可查看，均用中性色和明确文字，不伪造活跃执行或正常成功，不为显示状态新增详情读取或放宽格式校验

#### Scenario: 节点不把已恢复的工具错误当作终止失败

- **WHEN** 某运行记录了工具错误，但最终 reason 为 completed
- **THEN** 节点仍显示已结束及正常色，已有工具错误指标仍按原记录呈现，不改成出错终止，也不声称测试通过

### Requirement: 布局确定且节点不重叠

分支树的布局 SHALL 是确定性纯计算：相同输入 SHALL 产生完全相同的坐标输出（不依赖遍历顺序之外的随机源、不依赖当前时间、不依赖渲染容器尺寸）。同层相邻节点 SHALL 保持一致的间距且互不重叠，父子层之间 SHALL 保持一致的层间距。

#### Scenario: 布局可复现

- **WHEN** 对同一组 run 连续计算两次布局
- **THEN** 两次输出的节点坐标与连线路径逐字节一致

#### Scenario: 兄弟分支不重叠

- **WHEN** 根 run 有 3 条子分支，其中第一条子分支自己又有 2 个子节点
- **THEN** 所有节点的包围盒两两不重叠，同层相邻节点间距一致

### Requirement: 数字口径区分本 run 增量与全链累计

分支树与对照面板 SHALL 显式区分两种口径：**本 run 增量**（该 run 自身新增 span 现算的步数 / tokens / 工具数 / 耗时）与**累计增量（沿链求和）**（沿 parent 链把各代增量逐段相加）。系统 SHALL NOT 把增量冒充全程、也 SHALL NOT 把全程计入增量。

累计增量 SHALL 以「累计增量（沿链求和）」这一措辞呈现，SHALL NOT 使用「总耗时 / 总成本 / 总消耗」等暗示"从头连续跑一次的真实消耗"的措辞——各代的 `durationMs` 是各自墙钟跨度之和（中间有用户思考与编辑的空档），子 run 首次 LLM 调用的输入又含父前缀，累计值会高于「一次性跑完」的真实消耗。当祖先 run 文件缺失导致某段增量不可得时，累计增量 SHALL 标注为不可得（呈现「—」），SHALL NOT 以 0 或估算值填补。

#### Scenario: 分支 run 的双口径展示

- **WHEN** 分支 B（自身 2 步 / 3k tokens）的父 run A（自身 3 步 / 5k tokens）
- **THEN** B 同时呈现「本 run 增量 2 步 · 3k tokens」与「累计增量（沿链求和）5 步 · 8k tokens」，两者各自带口径名，界面无任何「总耗时 / 总成本」字样

#### Scenario: 祖先缺失导致累计不可得

- **WHEN** run X 的父 run 不在列表中（父缺失）
- **THEN** X 的增量照常呈现，全链累计呈现为不可得（「—」），并提示原因「父 run 不在数据目录」

### Requirement: 多分支对照到 run 级指标与共同祖先

系统 SHALL 支持把若干 run（上限 4 条，超出时 SHALL 拒绝加入并给出提示）加入对照，并排展示：状态与终止原因、步数、工具数与出错数、tokens（in / out / 合计）、耗时、分叉点摘要、创建时间。对照 SHALL 给出这些 run 的**共同祖先**（最近的公共祖先 run），以及各自相对该共同祖先的增量差（tokens 差、耗时差）。当其中一条 run 是另一条的祖先时，SHALL 明确标注这种祖先关系，并把共同祖先取为那条祖先 run。

共同祖先的判定 SHALL 区分三种结果：**有共同祖先**；**无共同祖先**（两条链都能走到 `parent` 为 null 的根且确无公共 id）；**判定不完整**（任一条链上存在父缺失的 run，无法确认真实的共同祖先）。系统 SHALL NOT 把「判定不完整」呈现为「分属不同根」——那是把「中间 run 被删了、其实同源」误报成「本来就不同源」。判定不完整时 SHALL NOT 计算增量差。

指标对照 SHALL 使用宽幅表格，固定可见的名称列和带任务摘要、稳定唯一短 ID、模型与状态的运行标题；三或四条通过表内横滚保留完整名称，不挤入固定窄侧栏。两至四条的共同祖先与累计结论 SHALL 来自当前已校验比较读取，不能以旧列表缓存覆盖 ownOnly 或读取失败。普通 run 不同根仍可分别阅读自有输出和指标；含 model_params 的选择集 SHALL 先遵守 model-experiments 的专属比较门禁。提示 SHALL 按实际对象数量表述。

#### Scenario: 两条兄弟分支对照

- **WHEN** 用户把两条同为 A 的子分支 B1、B2 加入对照
- **THEN** 对照面板并排列出两者的状态 / 步数 / tokens / 耗时 / 分叉点，共同祖先显示为 A，并给出 B1 与 B2 相对 A 的 tokens 差与耗时差

#### Scenario: 对照中含祖先关系

- **WHEN** 用户把 run A 与它的子分支 B 加入对照
- **THEN** 共同祖先显示为 A，并标注「A 是 B 的祖先」，不误报为平级兄弟

#### Scenario: 超出对照上限

- **WHEN** 用户已选 4 条 run 再加入第 5 条
- **THEN** 第 5 条不被加入，界面给出可见提示（说明上限为 4），已选集合不变

#### Scenario: 对照不足两条

- **WHEN** 只勾选了一条 run
- **THEN** 对照面板呈现该条 run 的指标但不计算增量差，并提示「再选一条即可对照」

#### Scenario: 分属不同根

- **WHEN** 用户勾选的两条 run 分属两棵不同的树，且两条链都能完整走到根（无任何父缺失）
- **THEN** 共同祖先呈现为「无（分属不同根）」，不计算增量差（无可比基线），但两条 run 各自的指标与累计增量照常呈现

#### Scenario: 父缺失导致判定不完整

- **WHEN** 两条被对照的 run 中，任一条的祖先链上存在父 run 不在列表中的 run
- **THEN** 共同祖先呈现为「判定不完整（存在父缺失）」并说明原因，不呈现为「分属不同根」，也不计算增量差；两条 run 各自的指标与累计增量照常呈现（此时累计增量本身也应为不可得）

### Requirement: 分支树视图为只读视图

分支树视图 SHALL 只读取既有数据并呈现，SHALL NOT 提供删除 / 合并 / 重命名 / 移动 run、修改 `parent` 或 `fork` 的入口。加载分支树 SHALL NOT 修改任何 trace 文件。

#### Scenario: 视图内无写操作入口

- **WHEN** 用户在分支树视图中选中、勾选、缩放、切换视图
- **THEN** 全程只发生读取（列表数据已在内存）与详情读取，无任何写通道被触发，traces 目录下文件字节不变

### Requirement: 分支树区分 prompt fork 与共享前缀 fork

分支边 SHALL 将 system_prompt 映射为“改 system prompt”，将 user_message 映射为“改 user message”。prompt fork 的边 SHALL 显示“从头重跑”，不展示普通“分叉点 span id”标签；result 与 messages 的既有标签保持不变。

#### Scenario: prompt fork 边标注

- **WHEN** run B 的 parent 为 A，fork.edit.field 为 system_prompt
- **THEN** A 到 B 的边标注“改 system prompt · 从头重跑”，不显示首次 llm.call id

### Requirement: prompt fork 的指标口径保持诚实

prompt fork 的“本 run 增量”SHALL 只统计其自身完整执行；“累计增量（沿链求和）”仍按 parent 链代数求和，并 SHALL 明示这可能包含多次独立完整运行的花费，不得描述为一次连续执行的总消耗。

#### Scenario: prompt fork 的累计增量

- **WHEN** 父 run A 消耗 5k tokens，prompt fork B 从头运行消耗 6k tokens
- **THEN** B 显示“本 run 增量 6k tokens”“累计增量（沿链求和）11k tokens”，并说明累计可能包含独立完整运行，不使用“单次总消耗”措辞

### Requirement: 分支视口可定位当前运行并恢复阅读

分支视图 SHALL 默认聚焦当前运行所属已知树并使当前节点可见，无当前运行时显示全部关系；SHALL 提供当前树/全部范围、完整 ID/任务搜索、定位当前运行、适应画布、缩放与空白平移。视口变换 SHALL 独立于确定性布局且不改变应用字号；返回树 SHALL 恢复会话内视口、查询、范围和选择。

#### Scenario: 首次进入聚焦当前分支

- **WHEN** 当前 run 位于多树、多层数据的远端，用户首次进入分支视图
- **THEN** 其所属已知树及当前节点可见，选择全部关系可访问其他树；无选中项时全部展示

#### Scenario: 搜索完整字段定位范围外运行

- **WHEN** 用户搜索展示中已截断的任务片段或完整 ID，匹配项在当前树外
- **THEN** 结果使用完整原值匹配并显示唯一身份，选择结果可定位其树；无匹配时明确提示，不丢原选择

#### Scenario: 视口操作与返回保持逻辑布局

- **WHEN** 用户适应画布、缩放、平移后打开运行再返回树
- **THEN** 节点逻辑坐标不因窗口变化而重算为随机布局，字号不随应用缩放设置被改写，返回恢复视口；定位当前运行可重新居中

### Requirement: 分支节点与关系列表提供明确可访问动作

节点 SHALL 使用稳定尺寸容纳任务摘要、稳定唯一短 ID、记录模型、状态、创建时间及本 run 自有步数/tokens，状态色与选择高亮分开；完整任务、模型、ID 和边标签 SHALL 可用鼠标与键盘读取和复制。缺失模型 SHALL 标为未记录，不根据当前设置补造。SHALL 分开选中、打开、加入/移出对比，并提供消费同数据的关系列表。父缺失占位只表示真实引用 ID 和不可用原因，不能成为可执行或可比较的虚构记录；实验分组 SHALL 只依据记录 experimentId。

#### Scenario: 长节点字段完整可读

- **WHEN** 任务、模型、ID 和边标签均很长且节点具有状态及消耗
- **THEN** 任务摘要、稳定唯一短 ID、记录模型、状态、创建时间及自有步数/tokens 不被节点边界裁掉或相互遮挡，完整值可通过详情展开/复制，缺失模型标为未记录，选择不掩盖错误状态

#### Scenario: 选中打开与加入对比分离

- **WHEN** 用户单击节点、点击打开运行、再返回并加入对比
- **THEN** 单击停留树并显示所选详情；打开才进入该 run 有效阅读位置；加入只改变对比集合；双击不是唯一打开方式

#### Scenario: 键盘关系列表与图同步

- **WHEN** 键盘用户切到关系列表并选择、打开或加入同一 run
- **THEN** 与图共享身份、顺序、选中和对比状态，Tab/Enter/Space 可完成动作且有可见焦点，返回保留来源模式

#### Scenario: 父缺失与实验分组不造记录

- **WHEN** 列表含缺父 run、成环关系、同模型不同 experimentId 及同 experimentId 臂
- **THEN** 缺父占位仅显示真实引用且不可加入对比，原 run 保留；成环终止并标记；只按真实 experimentId 分组，不把来源边称为共享前缀

### Requirement: 对照身份与四列指标保持可辨

树、选择栏及对照标题 SHALL 复用全量已加载记录范围内的稳定唯一短 ID，碰撞时延长且会话内不缩短，完整 ID 可复制。最多四条集合 SHALL 有序去重；详细输出一次只读两条，三四条须明确选两条，不以列号或轮号代替身份。

#### Scenario: 碰撞短 ID 不随筛选交换改变身份

- **WHEN** 多条运行同任务同模型同时间且 ID 前后缀碰撞，随后筛选、刷新或交换
- **THEN** 展示短 ID 可区分且同会话不因碰撞项消失缩短；复制得到完整 ID，左右编号随位置更新但不改变 run 身份

#### Scenario: 四条指标名称始终可见

- **WHEN** 加入四条运行并在窄窗横向阅读指标表
- **THEN** 名称列保持可见且宽度大于零，运行标题可辨，各值能对应名称与对象；输入/输出/合计 tokens、工具/错误、状态/原因、时间与分叉摘要仍可读

#### Scenario: 三四条显式选两条阅读

- **WHEN** 集合有三或四条，用户选择其中两条打开详细比较后返回
- **THEN** 仅指定两条进入正文，其他选择保持，集合仍最多四条且不重复；第五条加入被拒绝并提示，零/单条有明确引导
