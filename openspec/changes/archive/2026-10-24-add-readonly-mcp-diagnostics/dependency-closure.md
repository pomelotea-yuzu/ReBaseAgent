# 1.3 run-query 最小依赖闭包清单

状态：审计完成（2026-10-22），**尚未迁移**。基线源码 `2d39b1e`（R2.2 归档后 HEAD）。
本文件是 design D2 的落地清单；2.x 实施按此表迁移，超出本表即按 D2 四条硬触发先修订提案。

机器审计：`.workbuddy/mcp0-13/audit-closure.cjs` → `closure-audit.json`（16 个目标文件、零禁止导入、零缺失导出记号）。

## 结论

**未触发 D2 任何硬触发，可以按最小闭包进入 2.x。** 需要迁入 `packages/run-query` 的源文件共 **16 个**
（main 6 + shared 10），其中 3 个 shared 模块（`outcome` / `overview` / `terminal-facts`）不在 D2 表中逐字点名，
是 `compare-*` 与 `run-detail-integrity` 的**必要传递依赖**，不是范围扩大；替代方案只会在 run-query 复制第二份判据。

旧 IPC 名、schema、行为零变更：包层提供同一实现，desktop 旧路径保留薄 re-export；renderer 继续从
`@shared/*` 消费，不需要改 store/组件。

## 审计基线与方法

- 源码：`git rev-parse HEAD` = `2d39b1e`；change 文档为工作区未提交状态。
- 方法：逐文件读取导入/导出 → 反向 grep 全部消费方（`src/` + `test/`）→ 提取纯函数与 schema 的传递闭包 →
  按 design D2 四条硬触发逐条判定。
- 机器检查：禁止导入（`electron` / `react` / `zustand` / `src/renderer` / `@modelcontextprotocol/sdk`）在 16 个
  目标文件中均为零；每个预期导出记号均存在。脚本只审计**源闭包**，不代替 2.x 的包级构建/测试。

## 目标包结构

```text
packages/run-query/
  package.json          # type:module; deps: trace-sdk, replay, zod
  src/schema.ts         # 纯领域 schema（zod + trace-sdk/schema），无 Node
  src/facts/            # 纯派生，无 Node/replay/Electron；renderer 与 MCP 共用
    summary.ts          # deriveRunSummary / deriveTerminalReason / deriveCacheHitTotal
    chain.ts            # indexRunsById / deriveChainTotals / findCommonAncestor / deriveComparison
    outcome.ts          # classifyOutcome / isKnownReason（Tailwind 类名留 desktop）
    overview.ts         # 自有输出/错误/消耗事实
    terminal-facts.ts   # 自有终止事实 + 结果身份
    compare-derive.ts   # 祖先/累计比较
    compare-output.ts   # 比较侧输出/错误
    compare-edit-evidence.ts
    compare-source-map.ts
    run-detail-integrity.ts
  src/read/             # Node 侧只读实现
    repository.ts       # RunRepository.listRuns/getRun/loadRunRecord
    lineage.ts          # readRunLineage / findIllegalRunIdViolation
    read-context.ts     # RunReadContext 单请求缓存
    detail-project.ts   # 混合链投影
    compare.ts          # compareRunsEndpoint 的事实部分
    workspace-view.ts   # inspectWorkspace / readWorkspaceFileForView
  src/index.ts          # Node 侧出口（read/* + schema/facts 再导出）
```

`package.json` 的 `exports` 至少三条：`.`（Node 侧）、`./schema`（纯 schema）、`./facts`（纯派生）。
`facts` / `schema` **不得**导入 `node:*`、`@rebaseagent/replay` 或 `read/*`；renderer 只能从这两条子路径消费。

## 迁移清单（main）

| 源文件 | 行数 | 目标 | 导出 | 关键依赖 |
|---|---:|---|---|---|
| `apps/desktop/src/main/run-repository.ts` | 73 | `read/repository.ts` | `RunRepository` | `node:fs`、`readRun`、`deriveRunSummary`、`findIllegalRunIdViolation`、`RunReadContext` |
| `run-read-context.ts` | 286 | `read/read-context.ts` | `RunDetailReadError`、`RunReadContext` | `readRun`/`resolveBranch`、`RunDetailSchema`、`projectMixedChainSpans`、`readRunLineage` |
| `run-lineage-read.ts` | 265 | `read/lineage.ts` | `RunLineageDiagnostic`、`RunLineageFailure`、`RunLineageOutcome`、`findIllegalRunIdViolation`、`readRunLineage` | `node:path`、`TraceReadError`、`findExperimentSourceViolation`、`ISOLATED_FORMAT_VERSION`、`PROMPT_EXPERIMENT_FORMAT_VERSION` |
| `run-detail-project.ts` | 96 | `read/detail-project.ts` | `ChainProjection`、`projectMixedChainSpans`、`isPlainResultChain` | `resolveWholeRound`、`ISOLATED_FORMAT_VERSION` |
| `compare-endpoints.ts` | 90 | `read/compare.ts` | `CompareEndpointDeps`、`COMPARE_RUN_INVALID_CODE`、`COMPARE_RUN_UNREADABLE_CODE`、`CompareEndpointOutcome`、`compareRunsEndpoint` | `CompareRunsRequestSchema`、`COMPARE_REASON_MAX`、lineage/read-context |
| `workspace-view.ts` | 233 | `read/workspace-view.ts` | `WorkspaceViewDeps`、`WorkspaceInspectOutcome`、`inspectWorkspace`、`readWorkspaceFileForView` | `@rebaseagent/replay` 的 `locateWorkspaceSnapshot`/`readWorkspaceFile`/`createWorkspaceBlobStore`；workspace IPC schema |

## 迁移清单（shared → facts / schema）

| 源文件 | 行数 | 目标 | 迁移范围 | 留在 desktop |
|---|---:|---|---|---|
| `shared/derive.ts` | 786 | `facts/summary.ts` + `facts/chain.ts` | `RunLike`、`deriveTerminalReason`、`deriveCacheHitTotal`、`deriveRunSummary`、`ChainTotals`、`CommonAncestor`、`ComparisonEntry`、`Comparison`、`indexRunsById`、`deriveChainTotals`、`findCommonAncestor`、`deriveAncestorIds`、`deriveComparison`、私有 `walkUpChain`/`experimentIdOf` | `spanDurationMs`、span 树/步骤/预算函数、`buildRunForest`、`layoutRunTree`、`forkEditLabel`、`isPromptForkField`、`RunTreeNode` 等视图与布局 |
| `shared/compare-derive.ts` | 104 | `facts/compare-derive.ts` | 整文件 | — |
| `shared/compare-output.ts` | 132 | `facts/compare-output.ts` | 整文件 | — |
| `shared/compare-edit-evidence.ts` | 693 | `facts/compare-edit-evidence.ts` | 整文件 | — |
| `shared/compare-source-map.ts` | 240 | `facts/compare-source-map.ts` | 整文件 | — |
| `shared/overview.ts` | 342 | `facts/overview.ts` | 整文件（compare-output 与 MCP `get_run` 消耗/输出事实的必要依赖） | — |
| `shared/terminal-facts.ts` | 118 | `facts/terminal-facts.ts` | 整文件（compare-output 的必要依赖） | — |
| `shared/outcome.ts` | 154 | `facts/outcome.ts` | `OutcomeKind`、`OutcomeTone`、`Outcome`、`classifyOutcome`、`isKnownReason`、`KNOWN_REASONS` | `outcomeBadgeClass`、`outcomeTextClass`（Tailwind 类名） |
| `shared/run-detail-integrity.ts` | 117 | `facts/run-detail-integrity.ts` | 整文件（`RunDetailSchema` 的 superRefine 依赖） | — |
| `shared/ipc.ts` 领域 schema 子集 | — | `schema.ts` | 见下表 | 其余 IPC/执行/操作/代理/导出 schema |

### schema 子集（只迁这些，不整体搬 `shared/ipc.ts`）

- 运行摘要：`RunSummarySchema`/`RunSummary`、`FailedFileSchema`/`FailedFile`、`ListRunsDataSchema`/`ListRunsData`。
- 详情与来源：`ChainHopSchema`、`RunLineageSchema`/`RunLineage`、`RunDetailSchema`/`RunDetail`。
- 运行比较：`COMPARE_RUN_MIN`/`COMPARE_RUN_MAX`/`COMPARE_CODE_MAX`/`COMPARE_REASON_MAX`、
  `CompareRunsRequestSchema`/`CompareRunsRequest`、`CompareRunItemSchema`/`CompareRunItem`、
  `CompareRunsResultSchema`/`CompareRunsResult`。
- 检查点读取：`WorkspaceInspectRequestSchema`/`WorkspaceInspectRequest`、`WorkspaceInspectFileSchema`/`WorkspaceInspectFile`、
  `WorkspaceInspectResultSchema`/`WorkspaceInspectResult`、`WorkspaceReadFileRequestSchema`/`WorkspaceReadFileRequest`、
  `WorkspaceReadFileResultSchema`/`WorkspaceReadFileResult`。

留在 desktop 的 schema：`RunRecordSchema`（当前无消费方）、`EnvelopeSchema`/`Envelope`、执行/操作/代理/设置/
导出/工作区比较 IPC schema、`findCompareResponseMismatch`（renderer 响应错配守卫）。

## 旧出口兼容（desktop 侧）

| 旧路径 | 2.x 后形态 |
|---|---|
| `main/run-repository.ts` | `export { RunRepository } from "@rebaseagent/run-query"` |
| `main/run-read-context.ts` | 薄 re-export `RunDetailReadError` / `RunReadContext` |
| `main/run-lineage-read.ts` | 薄 re-export 五个导出（`run-source-gate.ts`、`workspace-export-endpoint.ts` 继续消费） |
| `main/run-detail-project.ts` | 薄 re-export 三个导出 |
| `main/compare-endpoints.ts` | 薄 re-export；IPC 信封仍由 `main/ipc.ts` 构造 |
| `main/workspace-view.ts` | 薄 re-export；`main/ipc.ts` 继续消费 |
| `shared/derive.ts` | 保留视图/布局函数，并从 `@rebaseagent/run-query/facts` re-export 已迁事实 |
| `shared/compare-*.ts`、`overview.ts`、`terminal-facts.ts`、`run-detail-integrity.ts` | 薄 re-export |
| `shared/outcome.ts` | re-export 分类函数/类型 + 保留两个 Tailwind 类名函数 |
| `shared/ipc.ts` | 删除领域 schema 定义，改为从 `@rebaseagent/run-query/schema` re-export；其余定义与 `CHANNELS`/信封不动 |

现有 `apps/desktop/test/` 中 40+ 个文件从旧路径导入目标模块；薄 re-export 保证它们无需改写即可继续回归。
2.x 新增包级测试（无 Electron）与 3.2 的桌面/包层同 fixture 对照，才是 Q01/D02 的证据。

## 依赖方向与禁止项

- `run-query` 依赖：`@rebaseagent/trace-sdk`、`@rebaseagent/replay`、`zod`；不得依赖 `apps/desktop`、Electron、renderer、MCP SDK。
- `mcp-server` 依赖：`@rebaseagent/run-query`、`@modelcontextprotocol/sdk`、`zod`。
- desktop 新增 `@rebaseagent/run-query` 依赖（main + renderer 的 facts 子路径）；依赖图无环：
  `desktop → run-query → replay → agent-loop → trace-sdk`、`mcp-server → run-query`。
- `facts` 子路径只允许 `trace-sdk/schema` 的类型/版本常量 + `zod`；`schema` 子路径只允许 `zod` + `trace-sdk/schema`。
- 不迁 `main/workspace-compare-endpoint.ts`：它只做 IPC 形状映射，底层已直接调用 replay `compare-api`；
  MCP 也调用同一 `compare-api`，事实同源，无需二次搬家。

## 与 replay 的分工（2.8/2.9）

- `read/workspace-view.ts` 继续调用 replay：`locateWorkspaceSnapshot`、`readWorkspaceFile`、`createWorkspaceBlobStore`；
  不复制解析、哈希、附件定位。
- 跨运行检查点比较继续用 replay `compareWorkspaceSnapshots` / `readComparedWorkspaceFile`；
  run-query 只做参数/结果类型与 MCP 外部投影，不复制清单引用/字节核验。
- `desktop` 的 `workspace-compare-endpoint.ts` 保持现状（R2.2 已验收行为），3.x 只做回归。

## D2 四条硬触发逐条判断

| 硬触发 | 判断 | 依据 |
|---|---|---|
| ① 需变更旧 IPC 名/schema/行为才能迁出 | **未触发** | schema 逐字迁移并在旧 `ipc.ts` re-export；`RunDetailSchema`/`CompareRuns*`/`WorkspaceInspect*` 形状与校验消息不变；主进程详情自检仍用同一 schema |
| ② 需搬 CHANNELS/信封/执行类型/store/renderer 状态 | **未触发** | `CHANNELS`、`Envelope`、执行/操作/代理/导出 schema、store、组件全部留在 desktop；renderer 仅间接从纯 `facts` 子路径取数 |
| ③ run-query 反向 import apps/desktop 或 Electron | **未触发** | 16 个目标文件禁止导入扫描为零；目标结构把 Node 读取与纯事实拆成 `.`/`./facts`/`./schema` 三条出口 |
| ④ D2 表外 shared 模块成批迁入 | **未触发** | 表外仅 `outcome`/`overview`/`terminal-facts` 三个传递依赖；不迁则只能复制 compare-output/terminal 判据，违反「不复制第二事实源」 |

## 构建与发布边界

- 新包构建沿用 `tsc -p tsconfig.json`（NodeNext、ESM、`dist/`），构建顺序由 pnpm workspace 拓扑保证：
  `trace-sdk → replay → run-query → {desktop, mcp-server}`。
- desktop 的 main/preload 走 `externalizeDepsPlugin`：`@rebaseagent/run-query` 不进 bundle，必须在运行时可解析
  （与现有 trace-sdk/replay 相同）；renderer 会 bundle `run-query/facts`，所以 facts 必须保持纯、无 `node:*`。
- MCP 首版源码构建后以 `node packages/mcp-server/dist/cli.js --data-dir <已有绝对路径>` 启动；
  不进入 desktop 安装包，不做 npm 发布（proposal Non-goals）。

## 风险与实施提醒

1. **ESM/CJS 边界**：desktop main 输出 CJS，现有 ESM workspace 包已可运行；2.x 要补一次真实 Electron 启动
   验证 `require(ESM)` 路径，不能只靠 tsc。
2. **renderer 体积**：`facts` 被 renderer bundle；不要从 `.` 入口 re-export，否则会把 `node:fs` 带进浏览器构建。
3. **schema 单源**：领域 schema 只能定义一次（run-query/schema）；`ipc.ts` 不得保留副本，否则两处校验会漂移。
4. **测试迁移**：旧路径 re-export 是兼容层，不是第二实现；2.x 完成后用 `rg` 确认旧文件只剩 re-export 与视图函数。
5. **R2.2 行为**：详情投影、ownOnly、v1/v2/v3 边界、逐侧失败、默认检查点语义全部按原实现搬迁；
   3.1 的桌面默认（最近自有完成步骤）必须在 desktop 解析成显式 selector，不能依赖包层缺省（design D8）。

## 验收映射

- Q01（三个 trace 版本同一事实实现）：2.1–2.3 包级 v1/v2/v3 对照 + 3.2 desktop/包层同 fixture 对照。
- D02（桌面默认检查点与旧 IPC 保持）：3.1 显式 selector 接线 + 3.2 IPC/schema 回归；本清单只证明**闭包可行**，
  不构成通过证据。
