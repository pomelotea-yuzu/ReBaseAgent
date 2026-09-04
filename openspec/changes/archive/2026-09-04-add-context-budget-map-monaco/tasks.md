# Tasks: add-context-budget-map-monaco

## 1. trace 预算元数据（trace-sdk + agent-loop）

- [x] 1.1 在 `packages/trace-sdk/src/schema.ts`：`RunMetaSchema` 增可选 `budget: z.object({ max_total_tokens: z.number().int().positive() }).optional()`，同步 `RunMetaInput` 类型。新增 schema 测试覆盖三态（有 budget / 无 budget / `format_version` 保持不变）。验证：`packages/trace-sdk` 的 vitest 全绿
- [x] 1.2 在 `packages/trace-sdk/README.md` 字段表同步 `budget` 字段及其语义（口径：累计 in+out 相对 maxTotalTokens，与 loop 一致）。验证：字段表描述与 schema 一致
- [x] 1.3 在 `packages/agent-loop/src/run-loop.ts`：`startRun` 调用中依 `config.budget.maxTotalTokens` 有值则写入 `budget`、为 undefined 则省略。新增测试覆盖"有配置→meta 带 budget"与"未配置→meta 无 budget"，并确认既有 config 测试不回归。验证：`packages/agent-loop` vitest 全绿

## 2. 预算曲线派生（纯函数）

- [x] 2.1 在 `packages/desktop/src/shared/derive.ts`：新增纯函数 `deriveBudgetSeries(spans)` → `{ points }`，只收集 `llm.call`，按 `flattenTree` DFS 顺序，逐点累计 `in+out` 得 `cumulative`；预算上限不进函数（由调用方传 `meta.budget`）。验证：函数签名与返回结构清晰，无缓存
- [x] 2.2 新增 `derive.test.ts` 用例：① 3 次 llm.call 的 cumulative 依次累加、与聚合一致；② 只收集 llm.call（跳过 tool.invoke）；③ DFS 顺序与 SpanTree 同序。验证：`apps/desktop` vitest 全绿

## 3. ECharts 上下文预算地图（desktop）

- [x] 3.1 `apps/desktop/package.json` dependencies 增 `echarts`；新增 `BudgetMap.tsx`，挂载于 DetailPanel 的 BranchNotice 之后、滚动容器顶部（run 级区块，默认折叠）。验证：`tsc` 渲染层 typecheck 通过
- [x] 3.2 实现地图：`dynamic import("echarts/core")` 懒加载，仅注册折线所需模块（LineChart/Grid/Tooltip/DataZoom）；累计曲线 + `markLine` 预算参考线（取 `detail.meta.budget?.max_total_tokens`，缺省 null 则无参考线）+ `budget_exceeded` 时末点超限高亮 + `click` 联动 `store.selectSpan`。验证：加载含预算 run 时曲线/参考线/超限标记正确，无网络请求；老 run（无 budget）仅趋势无参考线
- [x] 3.3 预算地图的运行数据组装（把 detail.spans 转 points + budget）抽出为纯函数并纳入测试（复用 2.1 派生，本项验证装配层正确）。验证：`apps/desktop` vitest 相应用例全绿

## 4. Monaco tool_result 编辑器（desktop）

- [x] 4.1 `apps/desktop/package.json` dependencies 增 `monaco-editor` + `@monaco-editor/react`；ForkEditor 的 `<textarea>` 替换为 `<Editor>`，仅 `open === true` 时渲染（懒加载，关闭态不加载资源）。验证：进入编辑态才加载编辑器资源
- [x] 4.2 接入离线自托管：`loader.config({ monaco })` 指向本地 `monaco-editor`（不用 CDN）；语言嗅探（`try JSON.parse` 成功 → `json`，否则 `plaintext`）；保持受控 `value` + `onChange`，`unchanged` 空 fork 防线、`inProgress` 禁用语义与 `runs:fork` 请求体不变。验证：既有 fork 相关测试不回归，`tsc` 双端 typecheck 干净

## 5. 冒烟数据与整体收尾

- [x] 5.1 `apps/desktop/scripts/gen-smoke-run.cjs`：支持生成含 `budget` 的元数据，产出可演示参考线的冒烟 run；旧 fixtures 不迁移（无 budget → 无参考线）。验证：运行脚本生成的新 run 打开后预算地图显示参考线
- [x] 5.2 整体验收：`apps/desktop` 全量 vitest + `biome check .` 0 errors + 双端 typecheck 通过；GUI 冒烟（`NO_SANDBOX` dev）验证预算地图显示/联动选择与 Monaco 编辑提交走 `runs:fork`（空 fork 仍被拒）。验证：所有验收场景对应 spec 中 scenario 逐条通过