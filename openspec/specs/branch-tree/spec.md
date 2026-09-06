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

分支树视图 SHALL 以图形呈现：每个节点代表一次 run 并展示其状态（`completed` / `crashed`）、任务名、创建时间、本 run 增量（步数 · tokens）；每条边代表一次分叉，SHALL 标注分叉摘要与被分叉的 span id——摘要由 `fork.edit.field` 映射（`"result"` → 「改 tool_result」、`"messages"` → 「改 messages」、其他 → 「改 <field>」），SHALL NOT 推断编辑内容。

选中某个 run 时，系统 SHALL 高亮从根到该 run 的整条祖先链（该链即它与兄弟分支共享的前缀）。点击节点 SHALL 选中并加载该 run 的详情，行为与在列表中点击该 run 一致。

#### Scenario: 多分支家庭呈现

- **WHEN** 存在根 run A 与两条子分支 B1、B2（均 parent=A，fork.edit.field="result"）
- **THEN** 图上出现一个根节点与两个平级子节点，两条边分别标注「改 tool_result」并各自标出自己的分叉点 span id

#### Scenario: 代理分叉的边标注

- **WHEN** 某 run 由代理重发产生（`fork.edit.field="messages"`）
- **THEN** 其入边标注「改 messages」，与 replay 分叉（「改 tool_result」）在图上可区分；树 SHALL NOT 区分两者的拼接语义（语义差异只在详情面板体现）

#### Scenario: 选中高亮共享前缀

- **WHEN** 用户点击深层分支 C（A → B → C）
- **THEN** A、B、C 三个节点与 A→B、B→C 两条边被高亮，C 的兄弟分支及其子树不高亮

#### Scenario: 无分支时退化呈现

- **WHEN** 数据目录只有一条 run（无 parent、无 fork）
- **THEN** 图上呈现单个节点，无分叉边，不隐藏视图、不提示「无分支可用」

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
