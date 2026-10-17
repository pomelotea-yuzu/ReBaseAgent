# 1.1 实施起点基线清单

日期：2026-10-17。实施起点提交：`379b388`（= change 文档提交，源码与评审基线 `ddcfd2a` 一致，二者间无源码改动）。物理行数实测：`store.ts` 3769、`DetailPanel.tsx` 2161、`WorkspaceFileView.tsx` 1866，与 proposal 声明逐字一致。

## 导出清单（快照行号，迁移时按名称重新定位）

### store.ts（5 个）

| 导出 | 行 | 类别 | 外部消费者 |
|---|---|---|---|
| `MAX_COMPARE` | 245 | const | 生产仅 `CompareSelectionBar.tsx`；测试无直接消费 |
| `stopOperationStatusPolling` | 1216 | function | 测试 4 个文件（create-entry-closure / navigation-intent-store / operation-polling / operation-session-epoch）；生产无外部消费 |
| `ExperimentSourceState` | 1562 | interface | **无外部消费者**（含测试），仅内部使用；保留兼容导出 |
| `idleExperimentSource` | 1569 | function | 同上，无外部消费者 |
| `useAppStore` | 1880 | zustand store | 全仓唯一 `create`；生产 24 个文件 + 2 个目标组件自身 |

### DetailPanel.tsx（8 个）

| 导出 | 行 | 外部消费者 |
|---|---|---|
| `ISOLATED_PARENT_UNSUPPORTED_KEY` | 88 | 仅文件内 |
| `IsolatedParentUnsupportedNotice` | 90 | 仅文件内 |
| `CacheHitRow` | 145 | 仅文件内 |
| `ForkCacheHintView` | 188 | 仅文件内 |
| `LlmCallDetailView` | 857 | 仅文件内 + 测试 `file-view-scroll-wiring.test.ts`（动态导入 `StepDetailView`） |
| `ToolInvokeDetailView` | 1778 | 仅文件内 |
| `StepDetailView` | 1887 | 测试动态导入 2 文件 |
| `DetailPanel` | 1974 | 生产唯一导入方 `App.tsx` |

### WorkspaceFileView.tsx（3 个）

| 导出 | 行 | 外部消费者 |
|---|---|---|
| `WorkspaceFileView` | 125 | 生产唯一导入方 `WorkspaceFilesPanel.tsx` |
| `WorkspaceFileViewBodyProps` | 465 | 仅文件内 + 测试（经 `WorkspaceFileViewBody`） |
| `WorkspaceFileViewBody` | 533 | 仅文件内 + 测试动态导入 6 文件 |

## 生产消费方（原入口）

- **store.ts**：25 个生产文件（含 DetailPanel/WorkspaceFileView 自身）：
  App.tsx、BranchTree、BudgetMap、CompareSelectionBar、CompareWorkspace、CreateRunWorkspace、DetailNotices、ExperimentWorkspace、GlobalBar、MessagesForkEditor、MessagesWorkspace、ModelAbEditor、OverviewPanel、RecordingWorkspace、ResultLiveRegion、RunActionsBar、RunList、RunWorkspace、SessionActivity、SettingsDialog、SpanTree、WorkspaceFilesPanel、lib/use-draft-close-guard.ts（+ 目标组件 2 个）。
- **DetailPanel.tsx**：`App.tsx:8`（默认详情页挂载点）。
- **WorkspaceFileView.tsx**：`WorkspaceFilesPanel.tsx:5`。

## 测试消费方分类

- **静态读源码（36 文件）**：完整清单与逐文件读取位置见 [test-migration-baseline.md](test-migration-baseline.md) T01–T36，本表不复制。
- **动态导入（50 文件）**：`await import("../src/renderer/src/store")` 42 个；`components/DetailPanel` 2 个（file-view-scroll-wiring → `StepDetailView`、workspace-focus-mode）；`components/WorkspaceFileView` 6 个（file-diff-height-chain、file-single-side-view、file-two-side-read、file-view-session-state、workspace-export-panel、workspace-file-view）。动态导入测试继续从原入口消费，作为 S01 兼容导出的活证据；其中 8 个同时也在静态 36 清单内（T02/T16/T17/T18/T19/T20/T33/T36 等），按 test-migration-baseline「一个文件两类检查分别建账」执行。
- **静态 grep 粗扫命中 35 与基线 36 的差**：基线以读取上下文核对为准（如 `aux-workspace-entries` 经封装 `read()`），以 T01–T36 为权威；任务 1.3 复核起点差集时以此差异为起点重新全量搜索。

## 工作区状态快照（提交分流依据）

`git status` untracked（**与本 change 无关，不混入任务组提交**）：
`2026-10-13.md`、`HANDOFF.md`、`apps/desktop/scripts/gen-readme-demo.cjs`、`apps/desktop/scripts/readme-shots-cdp.cjs`、`docs/readme-shots/*.png`（4 张）。

本 change 已入库（`379b388`），无未跟踪 change 文件。后续提交仅按明确路径暂存，提交前核对 staged diff。

## 职责摘要（与 design Context 一致，复述供阶段验收对照）

- `store.ts`：AppState（约 880 行）+ 初始化 + 全部 action + 提交/核对/结果收尾 + 导航恢复 + 轮询/订阅/等待者/派生缓存。
- `DetailPanel.tsx`：详情入口 + prompt/result 编辑器（PromptForkEditor L286、ForkEditor L1049）+ LLM/tool/step 展示 + 缓存与草稿提示。
- `WorkspaceFileView.tsx`：读取连接 + WorkspaceFileViewBody 布局（L533）+ FileContent 查看器（L1148）。
