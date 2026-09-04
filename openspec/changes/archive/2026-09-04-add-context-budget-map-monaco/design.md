# Design: add-context-budget-map-monaco

## Context

MVP 三块「查看 / 上下文预算地图 / 时间旅行切片」唯独预算地图与 Monaco 在 Spec #3 中确定"后置"，仅预留挂载位。现状（见 proposal.md Why）：

- 渲染层按 span 渲染详情（`DetailPanel`），外层 `flex-1 overflow-y-auto` 容器可容纳 run 级地图区块；`ForkEditor` 内嵌 `<textarea>`（`apps/desktop/src/renderer/src/components/DetailPanel.tsx` L189）编辑 `tool.invoke.result`，走唯一写通道 `runs:fork`。
- 派生层 `apps/desktop/src/shared/derive.ts` 已聚合 `tokensIn/out`（现算、无缓存），与"计数从数据派生"不变量同源。
- 数据契约 `apps/desktop/src/shared/ipc.ts` 的 `RunDetailSchema.meta` 直接复用 `trace-sdk` 的 `RunMetaSchema`——**trace 一旦新增字段，detail 自动透传**，无需改 IPC schema。
- 录制端 `packages/agent-loop/src/run-loop.ts` L66-75 `tracer.startRun({...})` 组装 meta，现无 budget。loop 侧预算口径为 `deriveTotalTokens(usages)` = 所有 `llm.call` 的 `usage.in+out` 累计，超 `config.budget.maxTotalTokens` → `budget_exceeded`。

## Goals / Non-Goals

**Goals:**

- 让 run 文件自包含预算事实：`run.meta` 记录源配置的 `maxTotalTokens`（可选、向后兼容）。
- 提供上下文预算地图：沿 `llm.call` 累计 in+out 的趋势曲线 + 预算参考线 + 超限标记 + 数据点联动详情。
- 提供代码级编辑控件替换 `<textarea>`，且不改变任何 `runs:fork` 语义。

**Non-Goals:**

- 不做"手术预览"漏斗（裁剪→实时算 token 变化）。
- 不做预算图的分支对比 / diff、模型上下文窗口自动映射。
- 不改 `format_version`、不做破坏性格式变更。
- Monaco 不扩展到完整 prompt 编辑器（v2）。

## Decisions

### D1 trace 新增可选 `budget` 字段（口径与 loop 一致）

`RunMetaSchema` 增 `budget: z.object({ max_total_tokens: z.number().int().positive() }).optional()`；`RunMetaInput` 同步为可选。`run-loop.ts` 的 `startRun` 依 `config.budget.maxTotalTokens` 有值则写入，否则省略该字段（保持可选语义）。

- 口径：预算值 = `config.budget.maxTotalTokens`；曲线的"累计消耗" = 每个 `llm.call` 的 `usage.in + usage.out` 之和（与 loop 的 `deriveTotalTokens` 逐字节一致），保证地图上的"超限点"就是 loop 判定 `budget_exceeded` 的同一数值。
- 备选 A（UI 临时参数、不进 trace）：被否。理由见提案，run 文件是唯一事实源，参考线不该靠 UI 记忆；缺底座会阻碍未来手术预览。

### D2 预算曲线是派生纯函数

`derive.ts` 新增纯函数 `deriveBudgetSeries(spans)` → `{ points }`，每点 `{ index, spanId, tokensIn, tokensOut, cumulative }`。只收集 `kind === "llm.call"` 的 span，按 `flattenTree` 的 DFS 顺序遍历（与 SpanTree 同序），`cumulative` 为迄今 in+out 累计。

- 不缓存、从 spans 现算——延续该文件既有纪律（Spec #4 编辑后不失效任何缓存）。
- 预算上限不进函数：由调用方从 `detail.meta.budget?.max_total_tokens` 取（缺省为 null，参考线不显示）。

### D3 ECharts 懒加载 + 按需引入

新增 `BudgetMap.tsx`，挂载于 `DetailPanel` 的 `BranchNotice` 之后、滚动容器顶部（run 级区块，折叠默认收起）。`useEffect` 内 `await import("echarts/core")` 并按需注册折线所需模块（`LineChart` / `GridComponent` / `TooltipComponent` / `DataZoomComponent`），`useRef<HTMLDivElement>` + `echarts.init`，数据变化 `setOption`。

- 懒加载：echarts 仅进入 run 详情时才 dynamic import，不进入首屏 bundle。
- 联动：`chart.on("click", params => store.selectSpan(params.data.spanId))`，联动既有 `selectedSpanId`，选中 llm.call 详情。
- 参考线：`markLine` 于预算值；`budget_exceeded` 时末点 `itemStyle` 做超限高亮。

### D4 Monaco 用 wrapper 且离线自托管

ForkEditor 的 `<textarea>` 替换为 Monaco（`@monaco-editor/react` 的 `<Editor>`），仅当 `open === true` 时才渲染（懒加载：关闭态不加载资源）。受控 `value` + `onChange`，沿用 `unchanged` 空 fork 防线与 `disabled`（`inProgress`）语义。语言嗅探：`try JSON.parse` 成功 → `language: "json"`，否则 `language: "plaintext"`。

- 依赖：`echarts`、`monaco-editor` + `@monaco-editor/react`。wrapper 为布局/loader 编排层，不是技术栈本体；`@monaco-editor/react` 标准化处理 Monaco 的 worker/Loader 集成（在 electron-vite 下手写 worker path 极易踩坑，见风险表）。
- 离线自托管：默认 `@monaco-editor/react` 从 CDN 拉 monaco，违反"本地优先、数据不出机器"；需 `loader.config({ monaco })` 指向本地 `monaco-editor`，保证无网可编辑（MVP 面向自研 loop 开发者，离线可 debug 是关键）。

### D5 IPC 零改动

`RunDetailSchema.meta` 复用 `RunMetaSchema`，budget 随 D1 自动透传，无需改 `ipc.ts` 或其它 schema。列表 `RunSummary` 不需要 budget，保持不动。

### D6 冒烟数据解耦预算

`apps/desktop/scripts/gen-smoke-run.cjs` 生成器增可选 budget 写入，用于演示参考线；旧 fixtures（r_01~r_04，手工数据、无 budget）照常读取，地图只画趋势、不画参考线——诚实呈现"事实源里没有预算就不编造线"。

## Risks / Trade-offs

- **Monaco/echarts 增大 renderer bundle** → 双双 dynamic import 懒加载；echarts 只按需注册折线所需模块；@monaco-editor/react 只在编辑态挂载。
- **Monaco Worker/路径在 electron-vite 下易出错**（loader 与 wasm/worker 的 vite 处理）→ 用 @monaco-editor/react 的 loader 统一接管，并本地 `loader.config({ monaco })` 自托管脱离 CDN；作为首个集成风险在 apply 时先冒烟验证。
- **budget 口径被误解为"上下文窗口/单次调用"** → D1 明确口径与 loop 的 `deriveTotalTokens` 一致（累计 in+out vs maxTotalTokens），并在 trace-sdk README 字段表显式注明。
- **地图只展示 llm.call 点，不含工具调用耗点** → 属既定 Non-goal（预算地图语义是"token 预算"，工具无 token）。
- **旧文件无 budget 参考线缺失** → 有意为之：不静默回退 UI 猜测值（诚实原则），场景已写入 delta spec。

## Migration Plan

无迁移/回滚复杂度：budget 为可选字段，旧文件与新文件兼容读写，向前向后均安全。如需回滚仅回退对 `RunMetaSchema`、`run-loop.ts`、renderer 组件的改动（互不耦合，可单独剥离）。无数据迁移步骤。

## Open Questions

无影响 spec / 方案 / 任务拆分的遗留未知项。（此前"参考线数据源"歧义已在提案确认取 trace 记 budget 方案。）