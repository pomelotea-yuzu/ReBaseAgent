# Proposal: add-branch-tree

## Why

时间旅行已经能用了（改某步 tool_result → 从该步重跑，产生新 run），但**用户看不见自己跑出来的那棵树**。目前 `parent` / `fork` 关系只以「运行记录列表里一个紫色『分支』小标签」存在——分叉一多，列表按时间倒序平铺，父子关系、谁从哪一步分出来、几个分支各自的代价如何，全部要用户自己在脑子里重建。这直接卡住了 v2 的两条主线价值：

1. **JTBD ③（换 prompt / 模型做 A/B）**：A/B 的前提是「并排看两个分支的代价与结局」，现在只能来回切换两个 run 各自看一遍，靠记忆对比。
2. **JTBD ①（跑歪了找是哪一步）**：分支树天然是「探索过程的地图」——哪一步之后试过几种走法、哪种走法活下来了，树一眼可见，比逐条翻时间线快一个量级。

同时项目长期约束明确要求**「更可视化」**（HANDOFF.md 协作提醒）：纯文本展示难懂。分支树是把既有数据（run 的 parent / fork 元数据，trace 里早就记着，只是没被画出来）变成一张图的纯派生工作——**不改 trace 格式、不加写通道、零新依赖**，是 v2 里投入产出比最高的一块。

## What Changes

- **分支树视图（新增全宽视图）**：header 增「分支树 / 轨迹」视图切换。分支树视图以 SVG 画出 run 家谱——**节点 = 一次 run**（状态色 + task + 时间 + tokens + 步数），**边 = 一次分叉**（标注分叉摘要，如「改 tool_result」「改 messages」，并标出分叉点 span id）。选中某 run 时高亮根到它的整条祖先链（这条链就是它与其他分支共享的前缀事实）
- **构建与布局是纯派生函数**（`shared/derive.ts`，与既有 `buildSpanTree` 同纪律）：`buildRunForest(runs)` 依据 `parent` 建森林——父 run 不在列表中的 run 提为根并标注「父缺失」，parent 链成环时断开并标注，绝不死循环；`layoutRunTree(forest)` 输出确定性坐标（同输入必同输出，便于快照测试），渲染层只负责把坐标画出来
- **多分支对照（run 级）**：节点可勾选加入对照（上限 4 个），右侧对照面板并排展示各分支的状态 / 终止原因 / 步数 / 工具数与出错数 / tokens(in·out·合计) / 耗时 / 分叉点 / 创建时间，并给出**共同祖先**与**相对共同祖先的增量**（token 差、耗时差）
- **口径诚实标注（重要）**：既有 `RunSummary` 的聚合数字是**本 run 自身新增 span** 的统计（不含祖先前缀），树与对照面板 SHALL 显式区分「本 run 增量」与「全链累计（沿祖先链求和）」两行，不把增量冒充全程、也不把全程算进增量
- **run 列表载荷暴露 fork 摘要**（向后兼容增字段）：`RunSummary` 增 `fork: { at_span, edit_field } | null`——只带分叉点 span id 与被编辑字段名，**不带 value**（value 可能是整段 tool_result / messages，列表载荷不需要，避免无谓放大 IPC 体积）
- **冒烟数据**：新增 dev 辅助脚本造一棵多分支家庭（根 + 兄弟分支 + 孙分支 + 代理链），零 API 消耗，让树视图不必先跑真模型就能看

## Capabilities

### New Capabilities

- `branch-tree`：分支树的可视化呈现与多分支对照——森林构建（孤儿 / 成环处理）、确定性布局、节点与分叉边的信息口径、对照面板的指标与增量计算

### Modified Capabilities

- `desktop-ui`：run 列表载荷新增 fork 摘要字段（供分支边标注）；header 新增分支树视图切换入口

## Non-goals

- **不做 span 级并排 diff**：不把两条分支的 span 逐条对齐做内容对比（需双向解析 resolveBranch 结果并定义对齐语义，工作量与风险都独立成 change）。对照只到 run 级指标 + 分叉点 + 共同祖先
- **不做任何写操作**：不删除 / 合并 / 重命名 / 移动 run，不改 `parent` / `fork`。本变更纯只读派生（删除有子分支的 run 需保护，属既有不变量，本变更不触碰）
- **不改 trace 格式**：`parent` / `fork` / `source` 早已在格式里，本变更只是把它们画出来。不改 `format_version`，不动 trace-sdk 的 schema
- **不改既有 fork 语义与通道**：`runs:fork` / `proxy:fork` 行为零改动；DetailPanel 的 ForkEditor、代理父链列表呈现均不变
- **不做复杂画布交互**：无自由拖拽平移、无无限缩放、无 minimap、无自动重排动画。只给三档缩放（75% / 100% / 150%）+ 滚动容器
- **不做导出**：不导出分支树为图片 / PDF / Mermaid
- **不做时间轴视图**：分支树只表达「run 之间的派生关系」，不按真实时间比例画时间轴（span 级时间轴属另一个可视化方向）
- **不新增依赖**：手写 SVG + 既有 React / Tailwind / zustand。ECharts 已在依赖里但树布局自己写（确定性、可单测、不为一张图引入图表运行时布局的黑盒）
- **不做跨 run 的「最优分支」评判**：不排序推荐、不打分

## 边界声明（保真度）

- 分支树**只呈现 trace 里已记录的事实**：`meta.parent`、`meta.fork.at_span`、`meta.fork.edit.field`、以及从自身 span 现算的聚合数字。不推测「如果当时改了 X 会怎样」——那要跑一次才知道
- **分叉边标注是元数据级的**：只标「改了哪个字段 + 分叉点是哪个 span id」，不呈现编辑前后的内容差异（value 不进列表载荷，差异对比属 Non-goal）
- **代理 fork 与 replay fork 在树上一视同仁**：两者都是有 `parent` + `fork` 的 run，树不区分其拼接语义差异（语义差异只在 DetailPanel 里体现：proxy fork 走父链列表）。`fork.edit.field` 的中文标签按字段值映射（`"result"` → 「改 tool_result」、`"messages"` → 「改 messages」、其他 → 「改 <field>」），不做语义推断
- **父 run 文件缺失 / parent 链成环**属于数据异常（手工编辑过 traces 目录、或删了中间某个 run）：树 SHALL 降级呈现（提为根 + 显式标注），不静默丢弃、不崩溃、不猜测真实关系
- **「全链累计」是沿 parent 链对各自增量的求和**，不重跑、不解析祖先的 span（祖先文件即使缺失也只影响该段累计不可得，标注为「—」而非补零）

## Impact

- 修改范围**仅限 `apps/desktop`**：
  - `src/shared/derive.ts`：`buildRunForest` / `layoutRunTree` / `deriveChainTotals` 等纯函数（与既有 `buildSpanTree` 同文件同纪律）
  - `src/shared/ipc.ts`：`RunSummarySchema` 增 `fork` 摘要字段（zod，向后兼容）
  - `src/main/run-repository.ts`：`deriveRunSummary` 输出透传 fork 摘要（meta 已在手，无额外 IO）
  - `src/renderer/src/`：新增 `BranchTree.tsx`（SVG 渲染）、`ComparePanel.tsx`（对照面板）；`store.ts` 增 `view` 视图模式与 `compareIds` 选中集；`App.tsx` 增视图切换与分支树区域
  - `scripts/gen-branch-tree-fixture.cjs`（dev 辅助，不入产品代码路径）：用 `JsonlTracer` 造多分支家庭，零 API
- 新增依赖：无
- 测试：`apps/desktop` vitest 增三组——森林构建（孤儿 / 成环 / 深链 / 空）、布局确定性（同输入同输出、节点不重叠）、对照派生（共同祖先、增量符号与口径）；既有 62 个 desktop 测试不受影响（schema 增字段为可选兼容方向，老 fixture 无需改）
- 门禁：biome 0 errors、双端 typecheck、electron-vite build、GUI 冒烟（分支树视图看多分支家庭 → 点节点切详情 → 勾选对照 → 看增量）
- 主 spec 同步：新增 `openspec/specs/branch-tree/`，`openspec/specs/desktop-ui/` 加 delta
- 无破坏性变更：既有 run 文件、既有 IPC 消费者、既有 fork 路径全部不受影响
