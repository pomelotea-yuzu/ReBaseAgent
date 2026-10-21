# R2.2 任务 1.3 —— FORMAT_VERSION / 版本消费方兼容盘点

状态：2026-10-20 盘点完成（源码基线 = 拆分归档后 `a833269`；关键高危断言已逐处抽查源码核实）。
本表是 2.x（v3 格式）与 5.x（main/shared）实施的**修改归属账本**：改一处勾一处，不允许清单外静默修改。
2026-10-21 阶段 2 销账见文末「阶段 2 完成记录」。

## 0. 两个关键结论

1. **隔离判据没有 `isIsolatedWorkspace` 这类函数**：写入/读取端判 `meta.workspace !== undefined`
   （replay `read-api.ts`、desktop `lib/isolated-fork.ts` `isIsolatedRun` 等），结构校验判 origin 自洽
   （`findWorkspaceOriginViolation`）。⇒ v3 文件（带 workspace + prompt_experiment）会被这些存在性判据
   **自动识别为隔离**，普通路径天然拒绝，无需改判据。
2. **全仓 4 处 `format_version === FORMAT_VERSION` 等值二分是最高危波及面**（reader / branch /
   desktop shared ×2 / main ×2——实数 6 处，见下）。FORMAT_VERSION 2→3 后它们会把存量 v2 文件
   误判为 v1 ⇒ **必须同步改成 `>= 2` 或显式版本集合**，否则 v2 静默走 v1 语义（截断/丢边界）。

## 1. trace-sdk src/

| 位置 | 现状 | v3 修改归属 |
|---|---|---|
| `schema.ts:11` `FORMAT_VERSION = 2` | 最高读取版本 | **改 3**，注释补 v3（隔离 prompt 实验） |
| `schema.ts:20` `PLAIN_FORMAT_VERSION = 1` | 普通写入版本（与最高版本刻意分离） | 不变 |
| `schema.ts:23-26` `FormatVersionSchema` union | v1/v2 双读 | **加 `z.literal(3)`** |
| `schema.ts:123-131` `WorkspaceOriginSchema` | import/checkpoint 二选一 | **加 `{kind:"initial"}` 臂**（仅 v3 实验根） |
| `schema.ts:164-175` `ForkSchema.resume_after_step` | v2 隔离分支必带（`schema.ts:244-257` superRefine 等值判定 `=== FORMAT_VERSION`） | superRefine 改 `>= 2`；**新增 v3 规则**：v3 必带 `prompt_experiment`、禁 `resume_after_step`、origin=initial 自洽 |
| `schema.ts:193-231` `RunMetaObjectSchema` | 无 prompt_experiment 字段（zod 剥未知键 ⇒ 必须显式声明） | **新增 `prompt_experiment` 可选字段** |
| `version-guard.ts:50-65` v1 分支 | v1 禁 workspace / resume_after_step | **加禁 `prompt_experiment`** |
| `version-guard.ts:67-73` v2 分支 | v2 必带 workspace | 保持；**新增 v3 分支**（必带 workspace+prompt_experiment）；v2 禁带 prompt_experiment |
| `reader.ts:84-87` 版本门禁 `> FORMAT_VERSION` 抛 | 未来版本拒绝 | FORMAT_VERSION→3 自动放行 v3；未来版本 fixture 用 4+ |
| `reader.ts:117` 跨行校验 `fileVersion === FORMAT_VERSION` | v2 step 必带快照 | **改 `>= 2`（防 v2 逃逸，高危）** |
| `branch.ts:83` `=== FORMAT_VERSION` → `resolveWholeRound` | v2 整轮截断 | **改 `>= 2`（防 v2 掉进 v1 截断，最高危）**；`resolveWholeRound` 文案扩 v2/v3 |
| `tracer.ts:116-119/170-173` | startRun/endSpan 原始行检查 | 随 version-guard 扩展自动生效 |
| `workspace-snapshot.ts:123-149` `findWorkspaceOriginViolation` | 根 run 无条件要求 `origin.kind === "import"` | **放行 `initial`**（需补版本上下文或放宽为 import/initial） |
| `memory-tracer.ts` / `jsonl-tracer.ts` / `workspace-hash.ts` | 无版本逻辑 | 零修改 |
| `guards.ts:19-24` `assertDeletable` | 纯 parent 指向判定 | 零修改（v3 分支天然参与子分支保护） |
| `index.ts` | 导出面 | schema 新字段/新臂自动跟随 |

## 2. replay src/

| 位置 | 现状 | v3 修改归属 |
|---|---|---|
| `workspace/checkpoint-tracer.ts:95` `format_version: FORMAT_VERSION`（写死） | 隔离 run 恒写当前最高版本 | **最高优先：参数化写入版本**（隔离根/result 分支写 2，隔离 prompt 实验写 3），并注入 `prompt_experiment` |
| `workspace/isolated-run.ts:223-228` origin 写死 `{kind:"import"}` | 隔离根 origin | 参数化或为 v3 实验根新增入口（`initial`） |
| `fork-parent.ts:54-58` `assertNotIsolatedParent` | 隔离父本禁普通 fork | **v3 专属隔离 prompt 入口在此开洞之外另走新编排**（`promptReplayIsolatedRun`）；本门禁保持拒绝普通入口（含 v3） |
| `isolated-guard.ts:29-35` | workspace 存在性判定 | 判据零修改（v3 自动命中），文案补 v3 |
| `replay-run.ts` / `model-replay-run.ts` | 隔离父本拒 + config_hash 门禁 | 零修改（v3 隔离模型实验仍拒） |
| `prompt-replay-run.ts` / `prompt-fork.ts` | 普通 prompt fork 派生与编排 | 普通行为零修改（D1 明确不复用隔离校验收紧普通入口）；新隔离编排并列新增 |
| `workspace/preflight.ts:210-222` | 隔离父本判据 + profile 校验 | 存在性判定零修改；v3 预检（D1/D2）并列新增，不复用本函数放行 |
| `workspace/read-api.ts` / `export-*` / `world.ts` / `blob-store.ts` / `quota.ts` / `file-tools.ts` | origin 透传 / 无版本逻辑 | 零修改（`export-manifest.ts:88` 的 `format_version:1` 是**清单文件自身版本**，勿动） |
| `src/index.ts` | 导出面 | 新增 v3 编排/预检/比较 API 时补导出 |

## 3. trace-test / agent-loop

| 位置 | 现状 | v3 修改归属 |
|---|---|---|
| `trace-test/src/definition.ts:9` `DEFINITION_FORMAT_VERSION=1` | 测试定义自身版本 | 零修改（与 trace 格式无关） |
| `trace-test/src/loader.ts:68-74` `loadTrace → readRun` | v3 经 trace-sdk 门禁 | FORMAT_VERSION→3 后 v3 自动可读；**补「v3 可读 + 断言可跑」回归用例**；v3 仍是卡带/桩工具语义（D4） |
| `agent-loop/src/run-loop.ts:79-98` | 恒写字面量 `format_version: 1`（刻意不复用 FORMAT_VERSION） | 零行为修改；:82 注释「现为 2」改 3 |

## 4. apps/desktop（shared / main / preload / renderer）

| 位置 | 现状 | v3 修改归属 |
|---|---|---|
| `src/shared/ipc.ts:729-737` `WorkspaceInspectResultSchema.origin` | import/checkpoint 二值 union | **加 `initial` 臂** |
| `src/shared/ipc.ts:26-31/124-146` RunRecord/RunDetail | 复用 trace-sdk schema | 自动跟随 |
| `src/shared/compare-edit-evidence.ts:377-379`（+592-594）`variantOf` `=== FORMAT_VERSION` | isolated-v2 / plain-v1 二分 | **改 `>= 2`**，并决定 v3 实验编辑的 variant 投影规则 |
| `src/shared/compare-source-map.ts:71-81` `boundaryOfHop` 同款二分 | v2 整轮边界 | **改 `>= 2`**；v3 hop 归入整轮分支 |
| `src/shared/detail-version-guard.ts` | 复用 `findVersionFieldViolation` | 自动跟随，零结构修改 |
| `src/main/run-lineage-read.ts:222-223` `findV2BoundaryViolation` `!== FORMAT_VERSION` | v2 边界预校验 | **改 `>= 2` 语义**（防 v2 校验失效） |
| `src/main/run-detail-project.ts:57-66` 同款二分 | 混合链投影 | **改 `>= 2`** |
| `src/main/workspace-view.ts:58-63` `projectOrigin` | 只认 import/checkpoint | **加 `initial` 投影臂** |
| `src/main/run-repository.ts` / `run-read-context.ts` / `fork-runner.ts` / `proxy-recorder.ts` / `preload/index.ts` | 无版本判据/纯透传 | 零修改（新 IPC 端点在 5.x 另加） |
| `src/renderer/src/lib/isolated-fork.ts:49-53/81-88/96-100` origin 文案三处 | import/checkpoint 二值 | **各加 `initial` 文案臂**（否则 v3 根显示「运行 undefined 的检查点」） |
| `src/renderer/src/lib/overview-view.ts:440/508-511`、`lib/workspace-files.ts:189-196`、`components/RunWorkspace.tsx:271-272` | origin 二值判定 | **各加 `initial` 臂** |
| `src/renderer/src/lib/compare-files.ts` / `store/slices/compare.ts` | `isIsolatedRun` 存在性 | 零修改（跨运行比较 API 在 4.x/5.x 新增） |
| `src/renderer/src/store/slices/{runs,navigation}.ts`、`lib/result-verification.ts` | 版本守卫拒绝语义 | 零修改（自动跟随 trace-sdk） |
| `src/main/run-create.ts:218` | 隔离根创建入口 | v3 实验根若新入口则并列新增（3.x），本入口不动 |

## 5. 「format_version=3 当作未来版本」的既有测试/脚本（升级时必须翻转构造值）

- `apps/desktop/test/baddata-regression.test.ts:69-73`：replace `1→3` 造未来版本 ⇒ **改 4+**
- `apps/desktop/scripts/gen-u1-lineage-fixtures.cjs:517`、`gen-u7-compare-fixtures.cjs:823`：同款 ⇒ **改 4+**
- `apps/desktop/scripts/lib/u5-read-faults.cjs:34-35`：用 99 ⇒ 不受影响

## 6. 删除保护与 blob 共享

- 唯一可删判定 `trace-sdk guards.ts assertDeletable`（parent 指向计数）⇒ v3 父本/分支天然参与，零修改。
- desktop 无 runs:delete 通道；blob 共享（world.fork 复制映射不复制字节）与版本无关 ⇒ 零修改。

## 7. 测试侧 fixture 基座（v1/v2/v3 矩阵的构造来源）

| helper | 现状 | v3 矩阵用法 |
|---|---|---|
| `replay/test/workspace-helpers.ts:97-169` `writeIsolatedRun` | 现成 v2 隔离根/分支构造器（真发布附件） | **加 v3 变体参数**（format_version/origin=initial/prompt_experiment）⇒ v3 fixture 基座 |
| `replay/test/isolated-helpers.ts` `ScriptedLlm`/`makeConfig` | 逐轮剧本桩 + 固定工具表 | 复用，零修改 |
| `replay/test/package-fixture.ts` | 只走包导出面真跑三轮 | v3 若新增入口则并列构造器 |
| `trace-sdk/test/helpers.ts` `sampleMeta`/`buildRecord` | v1 缺省可 override | v3 schema 单测基于它扩展（format_version:3 + workspace + prompt_experiment） |
| `replay/test/isolated-prompt-baseline-fixture.ts`（本 change 1.1 新增） | config.json 受控案例（v2 隔离根 + 兄弟分支 + 源目录） | 3.x/7.1 直接消费；v3 落地后补 v3 写出变体 |

## 8. v1/v2/v3 fixture 矩阵（2.2/2.4 实施时按此建）

| 矩阵格 | 构造 | 期望 |
|---|---|---|
| v1 普通 | `sampleMeta`/既有 helper | 原行为不变 |
| v2 隔离根（origin import） | `writeIsolatedRun` 无 parent | 原行为不变 |
| v2 隔离分支（checkpoint） | `writeIsolatedRun` 带 parent | 原行为不变（`>=2` 修复后仍整轮） |
| v3 实验根（initial + prompt_experiment） | v3 变体 | 新 schema/reader 全链通过 |
| v3 矛盾（缺 prompt_experiment / resume_after_step 在场 / id 不一致 / edit 越界字段） | 手工变体 | 写入端与读取端都明确拒绝 |
| v1/v2 私带 prompt_experiment（含 null） | 手工变体 | strip 前守卫拒绝 |
| 未来版本（4+） | replace 构造 | reader 明确拒绝 |
| v3 父 + v2 result 子 | v3 变体 + `writeIsolatedRun` 带 v3 父 | 子仍写 v2；前缀解析只继承 v3 整轮 |

## 9. 阶段 2 完成记录（2026-10-21）

源码基线 = `1281077` + 本批工作区改动。以下逐项销账，未列出的行维持「零修改」或留给 3.x/5.x。

### trace-sdk

- ✅ `FORMAT_VERSION` 2→3（= `PROMPT_EXPERIMENT_FORMAT_VERSION`）；新增
  `ISOLATED_FORMAT_VERSION=2`（既有隔离 writer）与 `PROMPT_EXPERIMENT_FORMAT_VERSION=3`；
  `FormatVersionSchema` 三版本 union。
- ✅ `WorkspaceOriginSchema` 增 `initial{run_id,snapshot_id}`；`WorkspaceMetaSchema` 文档口径扩 v3。
- ✅ `PromptExperimentSchema` / `PromptExperimentExecutionSchema` /
  `PROMPT_EXPERIMENT_TEXT_MAX_LENGTH=4000`；`RunMetaObjectSchema.prompt_experiment`。
- ✅ `RunMetaSchema.superRefine`：v2 resume_after_step 必填判据改用 `ISOLATED_FORMAT_VERSION`；
  v3 自洽（parent/fork、禁 resume、edit 字段与类型、baseline/origin/snapshot/span ID）；
  v1/v2 直带 prompt_experiment、v2 initial origin 在 schema 层也拒绝（守卫之外的纵深）。
- ✅ `version-guard.ts`：v1 禁 prompt_experiment；v2 禁 prompt_experiment + initial origin；
  v3 必带 workspace+prompt_experiment+initial origin、禁 resume_after_step。
- ✅ `reader.ts:117` 跨行快照判据改 `fileVersion >= ISOLATED_FORMAT_VERSION`（`FORMAT_VERSION` 等值二分已消除）。
- ✅ `branch.ts:83`：v2 走整轮；v3 走独立边界（只取自有 spans）并新增
  `findExperimentSourceViolation`（父根身份/首次调用/第 1 步/原值/初始快照）。
- ✅ `workspace-snapshot.ts`：`findWorkspaceOriginViolation` 放行分支 `initial`（run_id 必须指直接父）。
- ✅ `index.ts`：导出新常量、PromptExperiment schema/类型、`findExperimentSourceViolation`。
- ✅ 零修改已复核：`tracer.ts`（随共用守卫自动生效）、`memory-tracer.ts`、`jsonl-tracer.ts`、
  `workspace-hash.ts`、`guards.ts`。

### replay / trace-test / agent-loop

- ✅ `workspace/checkpoint-tracer.ts:95`：写 `ISOLATED_FORMAT_VERSION`（不再随最高读取版本升到 3）。
- ✅ `isolated-run.ts`/`preflight.ts`/`read-api.ts`/`export-*`/`isolated-guard.ts`/`fork-parent.ts`：
  阶段 2 零行为修改（workspace 存在性判据自动命中 v3）；v3 专属预检/编排/比较留 3.x/4.x。
- ✅ `trace-test`：`loadTrace` 经 trace-sdk 自动读 v3；新增 v3 卡带基线用例
  （父文件不存在仍可读可跑、产出 v1、真实 handler 不执行）。
- ✅ `agent-loop/src/run-loop.ts:82` 注释「现为 2」→ 3；writer 行为零修改。

### apps/desktop

- ✅ `shared/ipc.ts`：`WorkspaceInspectResultSchema.origin` 增 `initial{runId,snapshotId}`。
- ✅ `shared/compare-edit-evidence.ts:377/592`：等值二分改版本集合（v3→`isolated-v3`，
  v2→`isolated-v2`，v1→`plain-v1`）。
- ✅ `shared/compare-source-map.ts:71`：`>= ISOLATED_FORMAT_VERSION` 才按整轮边界。
- ✅ `main/run-lineage-read.ts:222`：v2 边界校验改 `=== ISOLATED_FORMAT_VERSION`；
  新增 v3 完整来源校验（复用 `findExperimentSourceViolation`）。
- ✅ `main/run-detail-project.ts:57`：result hop 改 `>= ISOLATED_FORMAT_VERSION`。
- ✅ `main/workspace-view.ts:58`：`projectOrigin` 增 initial 投影。
- ✅ renderer origin 文案：`lib/isolated-fork.ts` 三处、`lib/overview-view.ts`、
  `lib/workspace-files.ts`、`components/RunWorkspace.tsx` 各增 initial 臂。
- ✅ 未来版本 fixture 3→4：`test/baddata-regression.test.ts`、`test/run-repository.test.ts`、
  `scripts/gen-u1-lineage-fixtures.cjs`、`scripts/gen-u7-compare-fixtures.cjs`、
  `test/fixtures/u1-lineage/broken/u1b_future.jsonl`、`test/fixtures/u7-compare/broken/u7c_b_future.jsonl`。
- ✅ 零修改已复核：`run-repository.ts`/`run-read-context.ts`/`fork-runner.ts`/`proxy-recorder.ts`/
  `preload/index.ts`（新 IPC 在 5.x）、`lib/compare-files.ts`、`store/slices/{runs,navigation}.ts`、
  `lib/result-verification.ts`、`main/run-create.ts`（v3 根新入口在 3.x）。

### fixture 矩阵落地情况

- ✅ 已覆盖：v1 普通、v2 隔离根、v2 隔离分支、v3 实验根、v3 矛盾、v1/v2 私带 prompt_experiment、
  未来版本 4、v3 父 + v2 result 子。
- ⏳ 未覆盖：`replay/test/workspace-helpers.ts` 的 v3 变体参数与 `isolated-prompt-baseline-fixture`
  的 v3 写出变体（随 3.4 真实 v3 writer 落地）；旧读取器模拟（沿用既有 A 段版本门禁，不在本批新增）。

## 10. 阶段 3 完成记录（2026-10-21）

- ✅ `workspace/checkpoint-tracer.ts`：`formatVersion` 参数化（缺省 2，v3=3）并接受
  `promptExperiment`；构造期拒绝"v3 缺实验记录 / v2 带实验记录 / v3 非 initial origin"。
- ✅ 新增 `workspace/isolated-prompt-state.ts`（纯派生：启动消息、单项编辑、params 恢复、
  config_hash、端点规范化、计划指纹）。
- ✅ 新增 `workspace/isolated-prompt-preflight.ts`（只读预检：根资格、来源、配额、全附件、
  稳定的 15 类失败码；非根只给 rootId 导航建议）。
- ✅ 新增 `workspace/isolated-prompt-run.ts`（v3 编排：授权→重验→初始快照建世界→固定工具→
  v3 tracer→从第 1 步执行→归位）。
- ✅ `src/index.ts`：导出上述 API/类型。
- ✅ 测试：`isolated-prompt-state.test.ts` 34 项、`isolated-prompt-preflight.test.ts` 26 项、
  `isolated-prompt-run.test.ts` 10 项、`isolated-prompt-trace-failure.test.ts` 3 项；
  replay 全量 45 文件 / 581 通过（+5 skip）。
- ⏳ 未做：desktop IPC/preload/操作适配器（5.x）；跨运行文件比较（4.x）；真实模型/Electron 实机（7.x）。
- ⏳ fixture 矩阵补充：`workspace-helpers.writeIsolatedRun` 的 v3 变体未加——v3 根现在由真实
  writer（`promptReplayIsolatedRun`）在测试中产出，手写 helper 变体留到需要纯构造的 5.x 用例。

## 11. 阶段 4 完成记录（2026-10-21）

- ✅ 新增 `workspace/compare-api.ts`：`compareWorkspaceSnapshots`（双 selector 清单/引用/并集）
  与 `readComparedWorkspaceFile`（按 path 延迟核验/expectedSnapshotIds 守卫/逐侧状态）。
- ✅ `workspace/read-api.ts`：`readWorkspaceRun` 增可选 `readRecord`，供比较层保证同 run 单读。
- ✅ `src/index.ts`：导出比较 API 与类型。
- ✅ 测试 `workspace-compare-api.test.ts` 15 项；replay 全量 46 文件 / 596 通过（+5 skip）。
- ⏳ 未做：desktop IPC/preload（5.1）、比较工作区接线（6.4/6.5）、实机 diff 换行/缩放（7.2）。
- 版本/隔离 writer 消费方：本阶段零修改（比较只读，不写 trace/blob，不登记 operation）。

## 12. 阶段 5 完成记录（2026-10-21）

- ✅ shared：`channels.ts` 增 `workspaces:isolatedPromptCapability` / `compareSnapshots` /
  `compareFile`；`ipc.ts` 增 strict capability / 比较 schema、`PromptForkRequestSchema`
  普通/隔离 union、`WindowApi` 三方法。
- ✅ main：`execution-config-state.ts`（单一配置修订 owner，main 常量为唯一限制来源）、
  `isolated-prompt-endpoints.ts`（只读 capability）、`workspace-compare-endpoint.ts`
  （比较清单/正文）、`config-endpoints.ts` 写后刷新、`exec-endpoints.ts` promptFork
  隔离分流、`ipc.ts` 三条只读 handler。
- ✅ preload 暴露三方法；封闭清单测试同步。
- ✅ `run-create.ts` / `fork-runner.ts` 改用 `MAIN_EXECUTION_LIMITS`；受控剧本额度常量测试
  改读同一 owner。
- ✅ replay：`promptReplayIsolatedRun` 增可选 `expectedPlanFingerprint`，提交时重验计划。
- ✅ 测试新增：配置修订 5、capability 6、隔离提交/U4 10、比较 IPC 4、v3 IPC 往返 3、
  配置写刷新 1；desktop 全量 208 文件/3211 通过，replay 46 文件/596(+5 skip)。
- ⏳ 未做：renderer 工作区/比较/草稿接线（6.x）、真实模型与 Electron 实机（7.x）。
- 版本消费方：无新增改动（v3 字段沿用阶段 2 的 trace-sdk schema）。

## 13. 阶段 6 完成记录（2026-10-21）

- ✅ 6.1/6.2/6.3：`lib/isolated-prompt.ts`、`lib/isolated-prompt-card.ts`、
  `detail/IsolatedPromptEntry.tsx`；`PromptForkEditor` 增 `mode="isolated"`；
  草稿键加 `mode` 与假设/判据；capability 只读核对卡、费用确认与副本授权；
  `operations.promptExperiment` 复用 `submitActive`/U4/U5 收尾。
- ✅ 6.4/6.5：`lib/compare-file-view.ts`、`CompareFileWorkspace.tsx`；
  `compareFileView` 会话状态、双 selector、显式默认检查点、路径并集、
  `expectedSnapshotIds` 与 manifest/file 双代次守卫、只读 Monaco diff。
- ✅ 6.6：`lib/prompt-experiment-view.ts` 与概览「本次干预」区；
  与基线比较/本运行文件导出入口；比较文件视图「导出该侧检查点」。
- ✅ 门禁：desktop 全量 **214 文件 / 3272 用例通过**（最终轮无失败）；
  tsc web/node 0；biome 变更文件 0；`check-spec` 13 项 ✓。
- ⏳ 未做：7.1 真实模型闭环、7.2 真实窗口/缩放/键盘、7.3 失败与未知路径实机；
  本阶段只交付代码/单测/源码接线，不把单测当实机证据。
- 版本/包层：本阶段零修改 trace-sdk/replay/main 契约；仅消费 5.x 端点与既有 U4/U5。

## 14. 阶段 7.1 完成记录（2026-10-21）

- ✅ 独立 dataDir `.workbuddy/r22-71/run-20261021-030856/data` 完成真实模型闭环：
  provider `https://api.deepseek.com` / `deepseek-flash`；根 `run_mvhj9cq8_1y8519`
  （初始 A → 最终 B+summary）、兄弟 `run_mvhj9h3y_72b7`（只读 keep-A）、
  主实验 `run_mvhj9i9c_c22r`（单次 read_file → A，最终 config A、无 summary）。
- ✅ 机器检查 19/19 PASS：初始快照同 A；根 B vs 子 A different；summary 仅根；
  源/父 trace/兄弟 trace/既有 blob 指纹不变；单侧导出子 `s_04` 3 文件/33B，
  sha256/manifest/来源逐项复核；导出 config=A。
- ✅ 人工判据：用户已确认通过（2026-10-21 03:29 UTC）。
- ✅ 报告：`.workbuddy/r22-71/run-20261021-030856/{report.md,report.json,export-child/}`。
- ⏳ 未做：desktop GUI 实机（7.2）、失败/缺附件/缺父/未知响应（7.3）、全仓门禁与归档（7.4/7.5）。
- 诚实边界：本批是 package-layer 真实模型闭环，不能写成 Electron GUI 已验收；
  “正常结束”只证明终止事实，不自动等于修复成功。

## 15. 阶段 7.2 完成记录（2026-10-21）

- ✅ 三批 Electron 实机共 **133 条机器判据全绿**：widths 59（1442/1362/1024/801 CSS，DPR 2.1）、
  zoom200 19（DPR 4.2，实测 CSS 923×582）、keyboard 55（真键盘全链，子 run `run_mvhsr8j6_ab0y`）。
  证据 `.workbuddy/r22-72/`（measurements / gates / shots / export-keyboard）。
- ✅ 桌面新增视图遵守既有 UI 约束：无横溢、`overflow-hidden`+`min-h-0` 高度链贯通、详情列独立滚动只动容器、
  滚动区底部不露页面灰底、比较文件视图正文列与路径列各自裁切、窄档与 200% 下核对卡/授权/提交可达。
- ✅ 换行与差异逐字核对：编辑器侧粘贴按 Windows CRLF 原样保留；比较视图 Monaco 两侧原文逐字，
  CRLF+新增行 / 仅差末尾换行 / 右侧空串 / 仅本侧存在 / 两侧相同 / 含 NUL 正文六条形态各自结论正确，
  真实行变更与插入-删除着色层在场；单侧导出 6 文件/76 B 逐文件 sha256 复核。
- ✅ 许可撤销与恢复语义实机化：改配置＝核对卡连同费用确认与副本授权整体撤销；改输入＝stale 条 + 许可复位；
  页签往返恢复正文与假设/判据但不恢复任何执行许可。
- ✅ 只读不变式：widths/zoom200 全程 dev 数据目录逐文件指纹零变化；keyboard 批仅新增本次子 run 与其 blob。
- ✅ 原生目录选择方式已记录：dev-only 控制文件 `REBASEAGENT_PICK_DIRECTORY_FILE` 接管恰 1 次，
  `dialog[open]` 计数 0 自证原生框未被打开；打包版不读该变量。
- ⚠️ 新发现的**跨层事实**（不改契约、只记限制）：7.1 的 package-layer 根录制预算 300000 高于桌面唯一限制来源
  `MAIN_EXECUTION_LIMITS`（10 万），GUI 预检按 3.3 口径如实拒绝（`config_unreconstructable`）。
  ⇒ 桌面实验链夹具必须与 `MAIN_EXECUTION_LIMITS` 逐字段一致（本批 `r22-72-seed.cjs` 即为此写）。
- ⏳ 未做：7.3 失败/缺附件/缺父/旧响应/未知操作实机注入；7.4 全仓门禁与证据审计；7.5 文档同步与归档。
- 诚实边界：本批模型是本地受控服务（真实模型闭环与真实计费见 7.1）；二进制/超限逐侧状态桌面路径不可诱发，
  由 4.3 单元证据承载；机器 PASS 不等于人工判据通过，人工复核仍待用户确认。
