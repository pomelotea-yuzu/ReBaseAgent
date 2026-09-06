# Tasks: add-branch-tree

## 1. 数据契约：run 列表载荷暴露 fork 摘要（向后兼容）

- [x] 1.1 `apps/desktop/src/shared/ipc.ts`：`RunSummarySchema` 增 `fork: z.object({ at_span: z.string().min(1), edit_field: z.string().min(1) }).nullable()`，导出类型；**不带 `edit.value`**（design D2）
- [x] 1.2 `apps/desktop/src/shared/derive.ts`：**先把 `RunLike.meta` 的窄化类型补上 `fork`**（`fork: { at_span: string; edit: { field: string; value: unknown } } | null`，参照同接口既有 `source` 的窄化写法——不补则 `run.meta.fork` 直接编译不过），再让 `deriveRunSummary` 从它派生摘要输出（`null` 透传），不新增 IO；文件头纪律补充「两种口径」说明
- [x] 1.3 测试 3 例：分支 run 载荷含 `{ at_span, edit_field }` 且**不含 value** / 根 run 与老 fixture 为 `null` / 既有聚合数字不受影响
- [x] 1.4 验收：desktop 既有 62 例全绿（新字段不拒绝老数据），`biome check` 干净

## 2. 纯派生：分支森林、全链累计、共同祖先（`src/shared/derive.ts`）

- [x] 2.1 `buildRunForest(runs)`：按 `parent` 建森林，节点含 `run` / `depth` / `children` / `orphanReason`（`null` | `"missing-parent"` | `"cycle"`）；子节点顺序确定性（`created_at` 升序，同刻 `id` 升序）——scenario「三层分支链」
- [x] 2.2 父缺失提为根并标 `missing-parent`；**迭代式**父链行走 + 路径 Set 判环，成环提为根并标 `cycle`，不死循环不抛错——scenario「父 run 不在列表中」「parent 链成环」
- [x] 2.3 `deriveChainTotals(byId, runId)`：沿 parent 链求和（步数 / 工具数 / 出错数 / tokensIn / tokensOut），任一祖先不可得 → 整条累计返回不可得；耗时同样求和且 `null` 段按不可得传递——scenario「分支 run 的双口径展示」「祖先缺失导致累计不可得」
- [x] 2.4 `findCommonAncestor(byId, ids)` → `{ id: string | null; incomplete: boolean }`：取各链最后公共 id；一条是另一条祖先时返回该祖先；**任一条链上存在父缺失（走不到根）时 `incomplete` 为 true**——三态（有共同祖先 / 无且链完整 / 判定不完整）不得合并——scenario「两条兄弟分支对照」「分属不同根」「父缺失导致判定不完整」
- [x] 2.5 `deriveComparison(runs, ids)`：输出各 run 指标 + 共同祖先（含 incomplete 标记）+ 相对共同祖先的增量差（tokens / 耗时）；`incomplete` 为真、无共同祖先、或任一侧累计不可得时，增量差 SHALL 为不可得而非 0
- [x] 2.6 测试：森林 4 例（三层链 / 父缺失 / 成环 / 空数据目录）、累计 3 例（正常链 / 父缺失 / 单根）、对照 4 例（兄弟 / 祖先关系 / 不同根且链完整 / 父缺失判定不完整）
- [x] 2.7 验收：全部为纯函数（零 Electron、零 fs），用例全绿

## 3. 纯派生：确定性布局（`src/shared/derive.ts`）

- [x] 3.1 `layoutRunTree(forest)`：横向树（根在左），叶子计数法自底向上算槽位、自顶向下分配 y，**非叶子节点的 y 取其首末子节点 y 的中点**（标准 tidy-tree 的居中逻辑，缺这句父节点会偏离子树中心、连线斜得难看）；`x = depth × (节点宽 + 层间距)`；输出 `{ nodes, edges, width, height }`，节点含坐标与包围盒尺寸，边含贝塞尔路径与标签锚点——scenario「布局可复现」「兄弟分支不重叠」
- [x] 3.2 空森林返回零尺寸结构；单节点退化（无连线）不报错——scenario「无分支时退化呈现」
- [x] 3.3 测试：同输入两次输出逐字段一致（含路径字符串）、3 子 + 孙 场景下所有节点包围盒两两不重叠、单节点与空森林各 1 例
- [x] 3.4 验收：布局纯函数零 DOM 依赖，用例全绿

## 4. renderer：分支树视图（`BranchTree.tsx`）

- [x] 4.1 容器与连线层：相对定位容器 + 绝对定位 SVG 画贝塞尔连线，节点用绝对定位 `div`（不用 `foreignObject`，中文换行与 Tailwind 直接生效）；SVG 只负责连线与边标签
- [x] 4.2 节点卡片：状态色（emerald 完成 / amber 中断 / 红色出错标记，沿用 RunList 语义）、task（截断 + `title`）、创建时间、**「本 run 增量」与「累计增量（沿链求和）」两行且各带口径名**（禁用「总耗时 / 总成本」字样，design D6.1）、父缺失 / 成环徽标；勾选框加入对照——scenario「多分支家庭呈现」「选中高亮共享前缀」「分支 run 的双口径展示」
- [x] 4.3 边标签：`fork.edit.field` → 「改 tool_result」/「改 messages」/「改 <field>」，旁标 `at_span`；选中链的边加粗高亮——scenario「代理分叉的边标注」
- [x] 4.4 缩放三档（75% / 100% / 150%）+ `overflow-auto` 滚动容器；无自由拖拽、无 minimap（Non-goal）
- [x] 4.5 空状态引导文案（指向「先跑一次或用代理录一次」）——scenario「空数据目录」
- [x] 4.6 验收：`biome check` 无 a11y 报错（交互元素一律 `<button type="button">`，不复用 `div role=button`——既有 SpanTree 踩过）

## 5. renderer：对照面板、store、视图切换

- [x] 5.1 `store.ts` 增 `view: "trace" | "tree"`、`compareIds: string[]`、`setView`、`toggleCompare`（上限 4，超出不加入并置提示文案）；视图切换 SHALL NOT 触发 `loadRuns`——scenario「切换不重载」「超出对照上限」
- [x] 5.2 `ComparePanel.tsx`：并排指标（状态与终止原因 / 步数 / 工具数与出错数 / tokens in·out·合计 / 耗时 / 分叉点摘要 / 创建时间）+ 共同祖先行（三态文案：祖先 id / 「无（分属不同根）」/「判定不完整（存在父缺失）」）+ 增量差行（不可得呈现「—」，并说明不可得原因）；不足两条时提示「再选一条即可对照」——scenario「对照不足两条」「分属不同根」「父缺失导致判定不完整」
- [x] 5.3 `App.tsx`：header 增「分支树 / 轨迹」切换按钮；主区域按 `view` 条件渲染（分支树全宽 vs 既有三栏）；两视图共享 `selectedRunId`——scenario「切到分支树」「选中状态跨视图保持」
- [x] 5.4 store 测试：视图切换不重载列表、对照上限拒绝第 5 条、切换视图后选中 run 不变
- [x] 5.5 验收：Desktop 全测绿（既有 62 例不回归）；分支树视图内无任何写通道入口（只读——scenario「视图内无写操作入口」，人工核对：组件不引用 `forkRun` / `proxyFork` / 任何写调用）

## 6. 冒烟数据、门禁与归档

- [x] 6.1 `apps/desktop/scripts/gen-branch-tree-fixture.cjs`：用 `JsonlTracer` 手写多分支家庭（1 根 + 2 兄弟分支（`fork.edit.field="result"`）+ 1 孙分支 + 1 条代理链 `source.kind="proxy"` / `fork.edit.field="messages"`），文件名前缀 `tree_`，**零 API**；脚本文件头写明「结构合法但非引擎运行产物，勿用于试『在此重跑』」（design D9）
- [x] 6.2 门禁：`biome check .` 0 errors、双端 `tsc --noEmit` 干净、`electron-vite build` 三段通过、`openspec validate --strict` 通过
- [x] 6.3 GUI 冒烟（用户本机 dev）：生成 `tree_*` 数据 → 切「分支树」→ 核对节点/边标签/选中高亮 → 勾选 2 条看对照与增量差 → 点节点切详情 → 切回「轨迹」视图确认选中保持 → 确认三栏与既有 fork 入口无回归
- [ ] 6.4 归档：`openspec archive add-branch-tree`，主 spec 新增 `openspec/specs/branch-tree/`、`openspec/specs/desktop-ui/` 合入 delta；中文 commit；按工程约定 push 由用户手动执行
