# 评审：refactor-desktop-renderer-modules（按职责拆分桌面渲染层大文件）

> 日期：2026-10-16。对象：proposal / design / tasks / specs/desktop-ui/spec.md（delta）/ evidence-index / .openspec.yaml。范围：文档与源码核对，未实施产品代码、未运行功能或 Electron 验收。本文件为该 change 的首轮独立评审记录；原 `review.md`（起草方自检）已按仓库惯例改名为 `self-check.md`。

## 结论

**方向与结构通过，可进入实施；无阻断项。** 3 项 P3 建议随手处理（其中 F1 已在本次评审中处置）。制品互证、基线数字、delta 与主 spec 零冲突、场景→任务映射、引用测试名全部核实属实；自检声明的 `check:spec` 13/13 已由评审方复跑重现。

## 对照依据与方法

- 基线核对：HEAD = `ddcfd2a`（与 proposal 声明一致）；`ac8729e`/`00ecab6`/`18ebb6f` 均真实存在；`package.json` version = `0.5.0-rc.1`。
- 源码核对：`apps/desktop/src/renderer/src/{store.ts,components/DetailPanel.tsx,components/WorkspaceFileView.tsx}` 实际导出与内部组件结构；`apps/desktop/test/` 全部 203 个测试文件对旧文件路径的读取/静态检查点。
- 主 spec 对照：`openspec/specs/desktop-ui/spec.md` 95 条 requirement 逐条比对 delta 的 5 条 ADDED 标题，零同名。
- 复跑：`pnpm check:spec` → **13 passed / 0 failed**（含 `change/refactor-desktop-renderer-modules`），与自检一致。

## 已核实事实（全部属实）

1. **三个目标文件行数**：物理行数实测 store.ts 3769、DetailPanel.tsx 2161、WorkspaceFileView.tsx 1866，与 proposal/review 声明逐字一致（含空行与注释口径亦一致）。
2. **`AppState` 约 880 行**：实测 L246–L1128 共 883 行，design 的规模判断准确；「简单挪到一个 types 文件仍会集中职责」的拆分理由成立。
3. **store.ts 现有导出与 design 完全吻合**：`MAX_COMPARE`（L245）、`stopOperationStatusPolling`（L1216）、`ExperimentSourceState`（L1562）、`idleExperimentSource`（L1569）、`useAppStore`（L1880）共 5 个，design Context 的枚举无遗漏、无多报。全仓 `create` 仅 `store.ts:1880` 一处，单 store 约束有现状依托。
4. **D1 模块树与现状职责边界对得上**：`PromptForkEditor`（L286）/`ForkEditor`（L1049，即计划的 ResultForkEditor）/`LlmCallDetail·View`（L702/857）/`ToolInvokeDetail·View`（L1707/1778）/`StepDetailView`（L1887）/`DetailPanel`（L1974）及 `RunDraftListSection`、`CacheHitRow`、`ForkCacheHintView`、`IsolatedParentUnsupportedNotice` 等小型展示与 `DetailShared` 规划一致；`WorkspaceFileView` 侧 `WorkspaceFileViewBody`（L533）、`FileContent`（L1148）、`Selection` 类型同样对得上，不是拍脑袋命名。
5. **delta 结构**：5 条 ADDED requirements / 19 个 scenarios，标题与主 spec 95 条 requirement 零同名冲突；39 项任务全部未勾选（实测 `- [ ]` = 39、`- [x]` = 0），19 个场景名在 tasks 中均有承接且任务括号引用的场景名全部能在 delta 中逐字找到。
6. **引用测试名全部真实**：evidence-index 计划证据列与台账举例涉及的 39 个测试名（call-detail-view、operation-races、exec-entry-matrix、workspace-export-endpoint 等）在 `apps/desktop/test/` 中逐一命中。
7. **「现有本地 mock 服务」确有其物**：`apps/desktop/scripts/mock-llm-server.cjs`（含 `createMockLlmServer`、`/__log` 请求计数）与 `apps/desktop/test/helpers/mock-llm-harness.ts` 存在，refine-ui 归档证据（evidence-index 记录 CDP 9612 + 端口 18799 mock）可复用，tasks 6.2.x 不是空指。
8. **Non-goals 与既定决策一致**：不打包/不发布/不提版本、不追溯为 R2.1 前置条件、R2.2 优先级不变，与 `openspec/config.yaml` 未提交的进度校准文字口径一致，未越权宣称已发布或已验收。
9. **文档卫生**：change 目录 7 个文件无行尾空白、均有文件尾换行；`openspec validate --strict` 与场景映射的自检结论经复跑/抽查采信。

## 发现与处置建议

| 级别 | 问题 | 建议处置 |
|---|---|---|
| P3 | **`review.md` 命名与仓库惯例冲突**：本 change 原将起草方自检写入 `review.md`，而 `2026-10-12-export-run-results`、`2026-10-16-refine-ui-for-community-release`、`2026-10-10-refine-workspace-header-layout` 等先例均为「`review.md` = 独立评审、自检/响应另文（`self-check`／`review-response.md`）」 | **本次已处置**：原文件改名为 `self-check.md`，`review.md` 让位本评审。后续 change 起草时直接分开写，避免再挪 |
| P3 | **evidence-index 台账举例偏窄，实际静态检查面更大**：举例的 15 个测试确实都读取旧文件路径，声明「不是全量清单」也诚实；但实测直接 `readFileSync`/`read()` 读取 `store.ts`/`DetailPanel.tsx`/`WorkspaceFileView.tsx` 的测试共 **36 个**，其中 `entry-gate`、`focus-escape-responsive`、`modal-dialog`、`run-list-nav`、`refine-ui-return`、`draft-compare-grid`、`navigation-intent-store` 等高频读取方不在举例之列 | 任务 1.3 建档时以 36 个为实际基线，不要从 15 个举例出发增量搜；design D6 的「硬编码文件列表/计数」风险是实的（如 `run-list-nav.test.ts:238-250` 的固定文件清单含 `store.ts`，`budget-reachability.test.ts:327-329` 的清单硬编码 `DetailPanel.tsx`/`WorkspaceFileView.tsx`），迁移台账须逐条点名这类清单的改写去向 |
| P3 | **change 目录未入库**：当前 `openspec/changes/refactor-desktop-renderer-modules/` 为 untracked，工作区另有 docs 两处未提交改动（属 v0.5.0-rc.1 文档同步，与本 change 无关） | 按入库分流总则随实施任务组一并提交；提交前确认 docs 无关改动不混入 |

## 结构性评价（无问题，供实施参照）

- **等价验证是本 change 的真正难点**，delta 把它写成独立 requirement（「渲染层重构通过可追溯的等价验证」）+ 4 个场景是对的：纯重构没有新行为可演示，唯一可信的验收就是「旧保证逐条有去向」。tasks 1.3 迁移台账、5.8 逐条销账、7.1 证据回填构成闭环，evidence-index 明确「19 个场景全部待验证」不预填通过，纪律与 U 系列一致。
- **D2「唯一字段归属 + 单一协调者 + 一次 set」**是防止分片化引入中间可观察状态的正确抓手；D3 把 `createReturnFactsOf` 引用稳定、zustand v5 无限重渲染风险显式点名，与 `reading-state.ts`/`store.ts:1834` 注释里的历史教训呼应，说明设计读过源码。
- **风险表里「不声称包体积/渲染性能必然改善」**的克制值得肯定：行数下降本身不是目标，职责边界才是，与 Non-goals「不以缩短文件作为行为等价证明」自洽。

## 实施前注意事项（不改文档也可开工，但 1.1–1.3 建档时应覆盖）

1. 任务 1.1 枚举导出/导入方时，注意测试侧既有「静态读源码断言」（36 个文件）也有「动态 import 组合 store」两类，迁移策略不同：前者改查新模块路径或改由真实 DOM/action 承接，后者保持从原入口导入即为兼容导出的活证据。
2. `useAppStore` 的 25+ 个生产消费方都从 `../store` 导入，兼容导出天然被全量页面消费——S01「原入口导出指向同一实现」在测试基线里很容易验证，但也意味着 `store.ts` 收敛为组合层后不能再被 biome/格式化顺手破坏导出顺序导致初始化时序变化（D2 的「初始化阶段只创建初值」）。
3. 归档前的既有 requirement/scenario 零丢失核对（tasks 7.3）建议沿用 refine-ui 归档（`00ecab6`）的做法：delta 合入后对主 spec 做一次 95 条 requirement 与全部场景的差集校验并留档。
