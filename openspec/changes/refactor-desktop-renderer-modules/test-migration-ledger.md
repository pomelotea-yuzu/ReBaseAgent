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

## 2.1 销账记录（2026-10-17）

迁移：DetailPanel.tsx 2161→1595 行；新增 `detail/DetailShared.tsx`(203)/`detail/LlmCallDetail.tsx`(185)/`detail/ToolInvokeDetail.tsx`(113)/`detail/StepDetailView.tsx`(107)。原 8 个导出全部经 DetailPanel 兼容再导出指向同一实现；`Section`/`KeyValue`/`RunDraftListSection`（原非导出）入 DetailShared。壳（LlmCallDetail/ToolInvokeDetail/ForkEditor/PromptForkEditor）暂留容器，2.2–2.4 迁。

| T | 迁移的断言 | 新承载 | 说明 |
|---|---|---|---|
| T03 cache-display | `<CacheHitRow usage={response.usage} />` 挂载断言 | 改读 `detail/LlmCallDetail.tsx`（真实挂载点） | presentCacheHit 判据断言改读 `detail/DetailShared.tsx`；ForkEditor 缓存提示接线部分仍在 DetailPanel（2.3 处理）。动态导入 LlmCallDetailView/ToolInvokeDetailView 继续从原入口（兼容导出活证据） |
| T04 call-detail-view | `text={messageContentText(message)}` 接线 | 改读 `detail/LlmCallDetail.tsx` | 新增容器否定检查（DetailPanel 不再有消息渲染）；动态导入 LlmCallDetailView/ToolInvokeDetailView/StepDetailView 继续从原入口 |
| T05 confirm-dialog | 放弃确认计数「DetailPanel 5」 | **DetailPanel 4 + DetailShared 1**（RunDraftListSection 的列表放弃点随迁） | 总保证不变（5 处），计数按实际载体重分；`void requestConfirm` 存在性与 window.confirm 否定断言保持 |
| T27 notice-disclosure | `"isolated-parent-unsupported"` + `toggleNoticeExpanded` 展开键断言 | 改读 `detail/DetailShared.tsx` | 挂载点 `<IsolatedParentUnsupportedNotice run={run} />` 断言仍在 DetailPanel（壳在 2.4 前保留） |
| T02 budget-reachability | 失败 LLM 错误区三断言（HTTP 状态/失败占位零值/解释文案） | 改读 `detail/LlmCallDetail.tsx` | Monaco 清单断言（325–338）本阶段未触及，DetailPanel 仍含编辑器（2.2/2.3 处理） |
| T09 draft-compare-grid | `xl:grid-cols-2` 恰一处断言 | **DetailPanel 0 + detail/ToolInvokeDetail.tsx 1**（tool.invoke 只读 args/result 例外随迁） | 200/140px 禁用扫描扩至新模块；compareKey 挂载断言（prompt/tool-result）未变——ForkEditor/PromptForkEditor 仍在容器 |
| T10 draft-list | `deriveDraftList(drafts, { runId })` + `<DraftListPanel` 断言 | 改读 `detail/DetailShared.tsx` | 挂载点 `<RunDraftListSection runId={selectedRunId} />` 断言仍在 DetailPanel；新增「容器经 detail/DetailShared 导入」接线断言 |

验证：tsc web/node 0 错；biome 5 文件 0 错；受影响 8 个测试文件单包复跑全过（并行收集受沙箱 EPERM 噪声影响，单跑为准）；**全量 200 文件/2988 用例全过 0 失败**（3 条 Unhandled Errors 为已知沙箱 EPERM 噪声）。

## 2.2 销账记录（2026-10-17）

迁移：PromptForkEditor（含 startupContents）DetailPanel→`detail/PromptForkEditor.tsx`（~440 行，DetailPanel 1595→1155 行）。DetailPanel 经 import 指向同一实现（组件原非导出，无兼容再导出需求）。

| T | 迁移的断言 | 新承载 | 说明 |
|---|---|---|---|
| T30 prompt-messages-editor-draft | 6 条 PFE 源码切片断言（sliceBetween 两字段独立键/失效 CAS/对照网格/4.3 去重） | 改读 `detail/PromptForkEditor.tsx` 整文件作用域 | 原容器内切片改为模块边界天然隔离；容器侧 messages 入口断言不变 |
| T05 confirm-dialog | requestConfirm 计数 4→**DetailPanel 2 + PFE 2**；CAS 锚点 `discardCallDraft(draftKeyOf(field), snapshot.revision)` 改读 PFE | 计数按载体重分，总保证（prompt/result 字段+横幅 + 列表）不变 |
| T09 draft-compare-grid | `compareKey="prompt"` case 改读 `detail/PromptForkEditor.tsx`；200/140px 禁用扫描扩至 PFE | compareKey=tool-result 仍在容器（ForkEditor 未迁） |
| T10 draft-list | 重验闸门计数改 **DetailPanel + PromptForkEditor + ModelAbEditor ≥ 4** | prompt 闸门随迁 |
| T11 draft-submission | `beginDraftSubmission({channel:"prompt"` 与 `assoc.submittedText`/`inProgress`/`isDraftFrozen`/`本次提交待处理` 计数拆到 PFE（各 1），容器留 result（各 1） | 快照绑定与冻结语义保证不变；新增 PFE 侧「不直接提交渲染值」否定断言 |
| T12 entry-gate | PROMPT 切片改读 `detail/PromptForkEditor.tsx`（editorBody 切片函数随之删除） | 门禁/确认/按钮禁用三组断言逐字保持 |
| T13 execution-confirmation-store | 订阅现算文件清单 +PFE；`promptBinding` 锚点改读 PFE；`<ConfirmationBlock` 计数 3→**容器 2 + PFE 1**；prompt 资格原因就近显示改读 PFE | messages/A-B 断言不变 |
| T24 modal-dialog | useEscapeClose 计数 2→**容器 1 + PFE 1**；收起动作 escBlocks 同步拆分 | 收起=保留草稿语义逐字保持 |

验证：tsc web 0 错；biome 14 文件 0 错；8 个受影响测试文件单跑全过；**全量 200 文件/3030 用例全过 0 失败**（3 条 Unhandled Errors 为已知沙箱 EPERM 噪声）。

## 2.3 销账记录（2026-10-17）

迁移：ForkEditor（result 编辑器，含 toolMessageText/detectResultLanguage，684 行）DetailPanel→`detail/ResultForkEditor.tsx`（组件名保持 `ForkEditor`，文件名按 design D1）。DetailPanel 1155→**435 行**（只剩 LlmCallDetail/ToolInvokeDetail 两个壳 + DetailPanel 组合层）；死导入清空（模型库/隔离库/草稿源库等 12 处 import 只剩壳所需）。容器经 import 指向同一实现。

| T | 迁移的断言 | 新承载 | 说明 |
|---|---|---|---|
| T22 fork-editor-draft | 10 条切片断言（草稿读写/预检修订绑定/授权生命周期/按修订放弃/对照网格） | `forkEditorSource()` 改读 `detail/ResultForkEditor.tsx` 整文件 | 原「DetailPanel 切 ForkEditor 函数体」→ 模块边界天然隔离 |
| T02 budget-reachability | 「编辑器走懒包装」断言 | 改读 detail/PromptForkEditor + detail/ResultForkEditor（MonacoCodeEditor）+ WorkspaceFileView（MonacoDiffEditor） | 容器不再持有编辑器 |
| T03 cache-display | forkCacheHint 判据 + ForkCacheHintView 渲染断言 | 改读 `detail/ResultForkEditor.tsx` | |
| T05 confirm-dialog | requestConfirm 计数→**DetailShared 1 + PFE 2 + RFE 2**（容器归零）；CAS 锚点 `discardCallDraft(draftKey, snapshot.revision)` 改读 RFE | 放弃确认调用点全部在编辑器/列表模块 |
| T09 draft-compare-grid | `compareKey="tool-result"` case 与禁用扫描扩 RFE | 四处对照区调用点全部落在各自模块 |
| T10 draft-list | 闸门计数改 **PFE+RFE+ModelAb ≥ 4**（容器归零）；`DraftSourceBanner` 挂载断言改读 RFE | |
| T11 draft-submission | result 通道锚点/`assoc.submittedText`/`inProgress`/`isDraftFrozen`/`本次提交待处理` 全部随迁 RFE（容器归零），新增 RFE 侧否定断言 | 快照绑定/冻结语义逐字保持 |
| T12 entry-gate | 两个 describe 的 result 接线（deriveEntryGate/canFork 门禁/checkAllowed 不受槽/禁用理由/EntryGateNotice import 路径）改读 RFE | `deriveEntryGate(useAppStore((s) => s.operations))` 判据逐字保持 |
| T13 execution-confirmation-store | `executionBinding` 订阅/确认块计数（容器 0 + RFE 2 + PFE 1）/result 披露来源/登记口绑定/隔离预检结论断言改读 RFE | 订阅现算文件清单更新 |
| T21 focus-escape-responsive | 冻结通报判据文案断言改读 RFE（prompt 冻结通报无此句，原单断言即 result 侧） | |
| T24 modal-dialog | useEscapeClose 计数改 PFE 1 + RFE 1（容器归零）；hook import 路径断言随迁 | 收起=保留草稿语义逐字保持 |
| T34 settings-roundtrip-invalidate | `useRevokeOnConfigChange(modelConfigStampOf(settings), ...)` 授权失效接线改读 RFE | 配置指纹撤销语义逐字保持 |

验证：tsc web 0 错；biome 208 文件 0 错；**全量 200 文件/3010 用例全过 0 失败**（3 条 Unhandled Errors 为已知沙箱 EPERM 噪声）。DetailPanel 至此只剩壳与组合层——2.4 收敛挂载选择逻辑。

## 2.4 销账记录（2026-10-17）

迁移：LlmCallDetail/ToolInvokeDetail 两壳（142+57 行）随各自视图迁入 `detail/LlmCallDetail.tsx`/`detail/ToolInvokeDetail.tsx` 并导出；**DetailPanel 收敛为 219 行纯选择/组合层**（span kind → 详情模块分发 + StepDetailView 挂载 + 预算地图 + 草稿列表 + 滚动恢复），壳体逐字搬迁、DOM/key 零变化（call-detail-view 68 用例、fork-editor-draft 15 用例等组件级/静态契约全过佐证）。

| 断言 | 新承载 | 说明 |
|---|---|---|
| call-detail-view「resolveIoView 结果与 io 回调」壳接线 | 改读 `detail/LlmCallDetail.tsx` | io 阅读位置接线随壳 |
| notice-disclosure「不适用分支挂载」 | 改读 `detail/LlmCallDetail.tsx`（组件本体仍在 DetailShared） | 挂载点+展开键两半各归其位 |
| prompt-messages-editor-draft「messages 入口/canResend/崩溃说明」 | 改读 `detail/LlmCallDetail.tsx`；容器侧否定断言（不再挂 MessagesForkEditor）保留 | 入口判据逐字随壳 |
| proxy-ab-entry-closure「isProxy/canResend/入口条件」 | PANEL 改读 `detail/LlmCallDetail.tsx` | 「SDK run 无此入口」门槛逐字保持 |

验证：tsc web 0 错；biome 全绿；**全量 202 文件/3118 用例全过 0 失败**（1 条 Unhandled Error 为沙箱 EPERM 噪声，本机收集最全一次）。**阶段 2 完成**：DetailPanel 2161→219 行，detail/ 七模块（DetailShared 203 / LlmCallDetail 338 / PromptForkEditor 458 / ResultForkEditor 718 / StepDetailView 107 / ToolInvokeDetail 176）。
