# 1.3 静态测试迁移台账（起点版）

日期：2026-10-17。基线：`379b388`。对 [test-migration-baseline.md](test-migration-baseline.md) 的 36 文件清单做起点差集复核，登记动态导入清单与基线运行记录；逐断言映射以本台账为骨架，新承载/实际消费者/新断言位置列在对应迁移阶段（2.x/3.x/5.x）回填并销账。

## 起点差集复核（结论：36 文件成立，差集为零）

- 直接以绝对相对组合路径搜索命中 **35** 文件；差 1 个为 T07 `create-workspace-store.test.ts`——它经本地 `read(rel)` 封装以 `"store.ts"` 相对名读取（L445–474），直写全路径搜不到。
- **方法结论**：起点复核不能只搜全路径；必须同时覆盖「相对名 + 封装读取」。两法并集 = T01–T36，**无新增、无减少**。
- 后续阶段再复核时沿用两法并集；不能把 36 当扫描停止条件（新测试/间接 helper 另记差集）。

## 动态导入清单（50 文件，S01 兼容导出的活证据）

- `await import("../src/renderer/src/store")`：**42** 文件（原入口消费组合 store 的实例身份验证，迁移后**继续从原入口导入**，不改写这些导入）。
- `components/DetailPanel`：2（`file-view-scroll-wiring` → `StepDetailView`；`workspace-focus-mode`）。
- `components/WorkspaceFileView`：6（file-diff-height-chain、file-single-side-view、file-two-side-read、file-view-session-state、workspace-export-panel、workspace-file-view）。
- 与静态 36 清单重叠的文件（T16/T17/T18/T19/T20/T33/T36 及 workspace-export-panel——后者不在 T 表内，属「动态导入 + 行为测试」类，登记于此）按纪律**两类检查分别建账**。
- 迁移纪律：动态导入测试一律不动导入路径；原入口兼容导出若被删改，这 50 个文件就是第一道报警。

## 基线运行记录（2026-10-17，先库构建后 desktop）

| 步骤 | 结果 |
|---|---|
| `pnpm check:build`（5 包） | ✅ 全绿（后台任务 Gx3qP3 正常退出） |
| desktop 全量（并行，`--testTimeout=30000`） | 201 文件 / 3098 用例；2 failed + 2 Unhandled Errors |
| 失败复核 | 2 条失败全在 `controlled-isolated.test.ts`（6.5 受控服务回归）；**单文件复跑 4/4 全过** ⇒ 沙箱并行假红，非回归 |
| Unhandled Errors | 2 条 `EPERM … %TEMP%\ssr\…`，为 ENGINEERING 登记的既有沙箱噪声（vitest SSR 缓存写随机失败 ⇒ 全量文件计数波动 ±2） |

**结论**：本机全量并行存在已知波动，权威三元组（203 文件/3180 用例/Errors=0）以 CI 或分批复跑为准；本基线以「已收集用例全过（单包复跑后）+ 已知 Errors 归因」记录，阶段回归按同一口径比较。

## 固定清单/跨文件计数点名（design D6 要求逐条写改写去向）

| 位置 | 内容 | 迁移去向（计划） |
|---|---|---|
| `run-list-nav.test.ts:238–250` | 固定 6 文件清单（RunList/GlobalBar/**store.ts**/3 个测试文件）扫描旧标签「本地直录/仅代理」 | 清单中 `store.ts` 项改为**实际承载该文案的模块**（预计 configuration/navigation 分片）；清单逐项写理由，不得扩大成整目录拼接搜索 |
| `budget-reachability.test.ts:325–338` | ①325–334：DetailPanel/WorkspaceFileView/MonacoEditor 不得静态 import @monaco-editor/react；②336–338：DetailPanel 含 `MonacoCodeEditor`、WorkspaceFileView 含 `MonacoDiffEditor` | ① 前两项改为拆分后的实际编辑器承载模块（detail/ 与 workspace-file/），MonacoEditor.tsx 项不动；② 同步指向新模块；懒加载边界语义不变 |
| `draft-compare-grid.test.tsx:107/108/120/129` | DetailPanel.tsx 内 `compareKey="prompt"`/`compareKey="tool-result"` 及出现次数 | 改查 detail/ 实际挂载对照区的模块；「出现次数」换算成新模块等价保证，逐项注明 |
| `execution-confirmation-store.test.ts:167–274` | 固定组件列表、绑定/披露与确认块计数（6 处读取 DetailPanel.tsx） | 随确认区实际承载模块（预计 PromptForkEditor/ResultForkEditor/DetailShared）逐项迁移；计数口径对齐新结构 |

## 36 文件台账（骨架；测试数来自机器抽取，见附录）

| T | 文件 | 用例数 | 读取目标 | 目标模块（计划） | 销账阶段 |
|---|---|---|---|---|---|
| T01 | aux-workspace-entries.test.tsx | 15 | S | navigation（辅助工作区） | 5.3 |
| T02 | budget-reachability.test.ts | 27 | D+W | detail/ + workspace-file/ | 2.4、3.4 |
| T03 | cache-display.test.ts | 25 | D | detail/LlmCallDetail + DetailShared | 2.1 |
| T04 | call-detail-view.test.ts | 68 | D | detail/LlmCallDetail·ToolInvokeDetail·StepDetail | 2.1 |
| T05 | confirm-dialog.test.ts | 5 | D | detail/（放弃确认调用点） | 2.4 |
| T06 | create-entry-closure.test.ts | 11 | S | navigation（创建） | 5.3 |
| T07 | create-workspace-store.test.ts | 21 | S（相对名封装） | navigation（创建） | 5.3 |
| T08 | draft-closure-store.test.ts | 17 | S | results（收尾判据） | 5.5 |
| T09 | draft-compare-grid.test.tsx | 8 | D | detail/ 对照区挂载 | 2.4 |
| T10 | draft-list.test.ts | 11 | D | DetailShared（草稿列表） | 2.1 |
| T11 | draft-submission.test.ts | 20 | D+S | drafts + detail/编辑器 | 5.2、2.2–2.3 |
| T12 | entry-gate.test.ts | 12 | D | detail/入口门禁 | 2.4 |
| T13 | execution-confirmation-store.test.ts | 15 | D | drafts（确认）+ detail/编辑器 | 5.2、2.2–2.3 |
| T14 | experiment-results.test.ts | 15 | D | detail/（批次挂载否定断言） | 2.4 |
| T15 | file-checkpoint-resolve.test.ts | 24 | W+S | workspace-file/ + reading | 3.1、5.1 |
| T16 | file-diff-height-chain.test.ts | 3 | W（+动态导入） | workspace-file/FileContent | 3.2 |
| T17 | file-single-side-view.test.ts | 18 | W（+动态导入） | workspace-file/ | 3.2 |
| T18 | file-two-side-read.test.ts | 62 | W（+动态导入） | workspace-file/ + reading | 3.2–3.3 |
| T19 | file-view-scroll-wiring.test.ts | 15 | D+W（+动态导入 DetailPanel） | detail/StepDetail + workspace-file/ | 2.1、3.2 |
| T20 | file-view-session-state.test.ts | 8 | W（+动态导入） | workspace-file/ | 3.1 |
| T21 | focus-escape-responsive.test.ts | 5 | D | DetailShared/收尾文案 | 2.1 |
| T22 | fork-editor-draft.test.ts | 15 | D（切片读取） | detail/ResultForkEditor | 2.3 |
| T23 | fork-entry-closure.test.ts | 6 | S | operations（执行入口） | 5.4 |
| T24 | modal-dialog.test.ts | 16 | D | detail/编辑器 Esc 规则 | 2.2–2.3 |
| T25 | monaco-view-state.test.ts | 18 | W | workspace-file/FileContent | 3.2 |
| T26 | navigation-intent-store.test.ts | 14 | S+D | results（navIntents）+ detail/ | 5.5、2.4 |
| T27 | notice-disclosure.test.tsx | 10 | D | DetailNotices 侧 + detail/ | 2.4 |
| T28 | operation-result-actions.test.ts | 12 | S | results（结果定位跳转） | 5.5 |
| T29 | panel-collapse-headers.test.tsx | 7 | W | workspace-file/Body | 3.1 |
| T30 | prompt-messages-editor-draft.test.ts | 18 | D | detail/PromptForkEditor | 2.2 |
| T31 | proxy-ab-entry-closure.test.ts | 9 | S+D | operations + detail/ | 5.4、2.3 |
| T32 | refine-ui-return.test.ts | 14 | S | navigation（返回事实唯一派生） | 5.3 |
| T33 | run-list-nav.test.ts | 24 | S（+动态导入 store） | runs + navigation（固定清单见上） | 5.1、5.3 |
| T34 | settings-roundtrip-invalidate.test.ts | 16 | D | configuration + detail/编辑器 | 5.6、2.3 |
| T35 | workspace-file-view.test.ts | 26 | D（+动态导入 W） | navigation（页签）+ workspace-file/ | 5.3、3.1 |
| T36 | workspace-focus-mode.test.ts | 21 | D（+动态导入 DetailPanel） | RunWorkspace 侧 + detail/ | 2.4 |

合计：36 文件 / **631 用例**（机器抽取口径；与 vitest 计数的差异来自参数化展开，以运行计数为准）。

## 逐断言方法（各阶段回填时执行）

1. 每文件迁移前用 `vitest --reporter=json` 取该文件真实用例数，与本表对照（差异 = 参数化/收集问题，先解释再动手）。
2. 每条受影响用例在对应阶段任务里记录：旧断言 → 原保证 → 新承载模块与真实生产消费者 → 新断言位置（测试文件/断言形式）。
3. 静态否定断言必须跟随实际实现迁移（**不能只查已搬空的原入口**）；跨文件计数注明原计数↔新计数的等价换算。
4. 禁止：删除断言、改 `.skip`、整目录拼接字符串搜索、以注释命中证明接线；确需静态检查的用导入图/语法结构检查。
5. 阶段完成后在本表「销账阶段」列回填实际提交；未迁移的保证在 7.1 复核时逐条点名，不得静默丢失。
