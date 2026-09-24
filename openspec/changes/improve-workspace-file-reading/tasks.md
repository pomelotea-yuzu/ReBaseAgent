# U2 实施任务

当前第 1、2、3 组已完成；**第 4 组已完成（4.1–4.6 全部勾选；4.1/4.5/4.6 经 2026-09-23 复核发现未真正落地后已补齐）**；**第 5 组全部完成（5.1–5.6）**；**第 6 组完成（6.1–6.3）**。⚠️ **更正（2026-09-24，任务 6.3 复核对齐）**：本条原写"依赖 U1 已完成但未归档的源码和 delta…本次不归档 U1"——**U1 实际已于 2026-09-23 归档**（`openspec/changes/archive/2026-09-23-refactor-run-workspace/`，归档提交 `4628b80`），"未归档"表述与现状不符（任务 6.3 原文的"确认 U1 完成未归档"同此，见 `evidence-index.md` §归档状态）。仍成立的是：**本 change（U2）自身不自动归档**，待 owner 拍板。实现与验收以 **U1 已落入主 spec 的现状 + 本 change 的 delta** 为准，不以旧主 spec 代替现状。每项预算不超过 2h，超出先拆分。场景名均引用 [desktop-ui delta](specs/desktop-ui/spec.md)，其中 C 原有九个场景与行为保留，仅将窄窗口场景的“提交和导航控件”校准为“检查点与导航控件”。

## 进度记录

### 2.x–4.x 复核与第 4 组补齐（2026-09-23）

用户提示「1.x 做很久、2.x 起推进很快」⇒ 对 2.x–4.x 做实质复核（源码 + 跑测试 + 变异验证），报告 `docs/reviews/2026-09-23-u2-2x-4x-audit.md`。

- **2.x / 3.x 实质可信**：局部 selection/pane/path 已删除并改读 store；`RequestGuard` 单调代次真实落地、无 `cancelled` 布尔残留；`sideResult` 不再把 failed 折成 not_found。**变异 4 组全部被捕获**（目录宽不写 store / 绕过守卫直接 set / failed 折 not_found / 缩字号），说明这部分判据是**载重**的。
- **复核发现第 4 组三处勾选与实情不符**（提交 `7aba8c8` 自称「骨架版」，但 tasks 全部勾成完成）：
  - **4.1**：「可调整目录」未落地 —— `stepFileDirWidth`/`clampRestoredDirWidth` 是**死导入**（纯逻辑 + 单测绿，零 UI 消费）。
  - **4.5**：**查找入口不存在**；「上一/下一差异」是**无 `onClick` 的死按钮**；`diffCount` 写死为 `1`。全 renderer 搜 `goToDiff`/`revealFirstDiff`/`findController` **零命中**（`git log -S` 确认从未实现），且 `MonacoEditors.tsx` **不外抛编辑器实例** ⇒ 结构上无法接线。
  - **4.6**：无任何 `onKeyDown`/`tabIndex`/`role`/方向键/焦点恢复；测试里**无键盘断言**。
  - 根因（U1 同类复发）：第 4 组「能力断言」只有字符串存在性（`expect(html).toContain("上一差异")`），**不钉接线**。
- **已按优先级补齐**（详见各任务下的 ✅ 说明）：
  1. **先决条件**：`MonacoEditor.tsx` 新增 `behaviorProps`，把 `onMount` 从懒包装层转发下去（`editorAttrs` 只透传 `data-*`/`aria-*`）。
  2. **4.5**：接 `goToDiff` / `onDidUpdateDiff` + `getLineChanges()` 真实 `diffCount` / `actions.find` 查找入口。
  3. **4.6 + 4.1**：文件列表方向键导航 + roving tabindex + `role="listbox"/"option"` + 焦点交回；目录宽度**分隔条**（拖拽 + 键盘）。
  4. **接线契约断言**：`file-two-side-read.test.ts` +10 条、`budget-reachability.test.ts` +1 条，专钉「死按钮 / 写死 diffCount / 未接线键盘 / 未转发 onMount」。
- **变异验证 6 组全部被捕获**（M1 删导航 onClick / M2 写死 diffCount / M3 删列表 onKeyDown / M4 删分隔条键盘 / M5 删查找 onClick / M6 删 onMount 转发）；脚本 `.workbuddy/u2-mutate.cjs`，基线副本 + `cp` 还原。
- **门禁**：desktop 全量 **1236 passed / 0 failed（63 文件）**（较原 1225 +11）；`tsc` web + node 净；biome 改动文件净；`openspec validate --all --strict` 通过。未提交，push 留用户手动。

### 1.1（2026-09-23 完成）

`apps/desktop/scripts/gen-u2-file-fixtures.cjs`（新）生成 `.rebaseagent/u2-file-fixtures/`：`iso-data/`（**真引擎原生**：普通根 3 轮 → 一次分叉 → 二次分叉，另含一个真实 `errored` run）、`source/`（长文本 + 零字节 + 新增文件）、`broken/{missing,corrupt,no-own-steps}/`、`MANIFEST.json`。新增 `test/u2-file-fixtures.test.ts`（38 passed）。

- **标本必须走真引擎生成，不能手搓**：早期版本手写 v2 trace，接连撞三处**只有真读才会暴露**的不变量——① 完成的 `agent.step` **必须**携带 `workspace_snapshot`（`reader.ts` 硬拒绝，删掉即 `TraceReadError`）；② 检查点归属按 `leafSpanIds`（run **自有** span）判定，**不看轮号 `n`**；③ 分叉 run 的 `workspace.origin` 必须是 `{kind:"checkpoint", run_id:父, step_span:分叉点}`，且与 `fork.at_span`/`resume_after_step` 交叉校验。改用 `createIsolatedRun`/`replayIsolatedRun` 真实产出后全部自然满足。
- **「无自有完成步骤」标本的正确构造**（1.2 前置与审阅关注点）：不是"删掉检查点"，而是**挂到一个真实父运行上、再移除本案自己的全部 `agent.step`**——这样 `deriveCheckpointOptions` 因 `leafSpanIds` 为空而返回空，界面应落"初始清单"。生成器写 `<rootId>.jsonl` + `<noCheckpointId>.jsonl` 两份（`resolveBranch` 需要能找到父），id `u2bad_noownsteps`。
- **变异验证 2 轮**（全捕获）：① 把"移除自有步骤"改成空操作 ⇒ 标本与正本**字节相同**、`自有完成步骤数为 0` 断言失败；② 更隐蔽的双重变异（改 `n` 而不改 span 归属）⇒ 因归属不看 `n` 而**仍失败**。教训：标本正确性靠**断言 3 根 vs 0 根**钉住，不靠"看起来不同"。
- 覆盖场景：初始与各轮快照可选 / 选择器轮号不沿链累加（二次分叉）/ 失败 run 已记录文件可查看 / 新增文件与零字节文件不混同 / 两侧都不可读时无伪空编辑器。
- 未覆盖：真实 Electron 下的选择器实机交互（归 5.3）；长文本滚动位置恢复的事件级行为（归 4.3/5.3）。

### 1.2（2026-09-23 完成）

`docs/reviews/2026-09-23-u2-file-prototype/`（`index.html` + `measurements.json` + `screenshots/` + `README.md`），测量脚本 `apps/desktop/scripts/u2-file-prototype-shots.cjs`（新）。原型含 **mock 排版**与**真 Monaco**两套正文来源（A/B 可切换），真 Monaco 用与产品同一份本地 0.56 实例 + 同组 options 装配，读 `getLayoutInfo().contentWidth` 作为权威数字。

- **为什么必须上真 Monaco**：mock 的文字区按自写 chrome 常数算出，用它证明"800px 够 480"是自证。`measure()` 同时给两套数字 + `crossCheck` 差值，使模型与实测的偏差不可藏。
- **Monaco API 核对（0.56 实装，全部真调用过）**：`goToDiff('next'|'previous')` / `revealFirstDiff()` / `getLineChanges()` / `onDidUpdateDiff` / `getOriginalEditor`+`getModifiedEditor` / `getContribution('editor.contrib.findController')` 均可用；**`EditorOption.fontSize` 枚举值是 61 不是 48**（用 48 会取到字符串，实测踩过）。
- **D4 阈值实测（权威）**：1440→429 / 1360→391 / 1210→443 / 1024→354（并排每侧 ≥320 ✅）；**800→inline 273（要求 480 ⇒ 差 207px ❌）**。阈值扫描 720–1280：**「正文达标」最小视口是 960**，960 以下到 720 的 inline 文字区从 392 一路掉到 193，**无一档达 480**。
- **两次 800px 决策均已单独记录**：目录常驻（即使取最小 200px、甚至收起目录，文字区 273 < 480 ⇒ 判据要求收起，但收起也救不回 480）；diff 模式（并排每侧 ≈137 < 320 ⇒ 必 inline，实测确实 inline）。二者独立成立，但合起来说明「800px 这一档看清正文的前提本身不成立」。
- **同视口响应容器变化**（真 Monaco）：视口 1440 固定、目录 203→320，Monaco 文字区 **429→400**，视口未变 ⇒ `automaticLayout` 确实 relayout，`ResolvedReading` 同类"不吃窗口断点"成立。
- **顺手校正实现常数**（按 review P4「先修设计再实施，不靠降低正文要求掩盖」）：`lib/file-layout.ts` 的 `INLINE_CHROME` 74→**64**、`DIFF_CHROME_PER_SIDE` 88→**56**（实测 inline chrome 58–64、并排每侧 55–56）；原值偏大会**误收目录**与**误判并排不足**。`file-layout.test.ts` 13 passed 零回归。
- **原型阶段抓到 4 个真实缺陷**（前两个只有真跑才暴露）：① `EditorOption.fontSize` 枚举 48 误用；② 真 Monaco 直挂进 flex 容器被压成 74px、`contentWidth` 变 **−9**（需给直挂编辑器补 `flex:1 1 0; min-width:0`）；③ `getLayoutInfo()` 需先强制 `layout()`；④ 静态服务三连坑（裸 CSS 副作用导入 / pnpm 符号链接目录 / Windows 正反斜杠 `startsWith` 失配 + 目录 URL 补 index）。
- **遗留已落定（2026-09-23 用户拍板候选 A）**：800px 档「inline 文字区 ≥480」几何不可达 ⇒ 采用「**把 480 的下限限定到 960 CSS px 及以上视口**」：spec delta 主 requirement 加分档句、`文件正文在代表视口可读` 场景的 WHEN 去掉 800px 并加 AND 说明、`极窄与放大后仍可阅读` 场景纳入「800px 及更低为窄档，目录一律收起、diff 强制 inline、不要求 480」；design D4 同步写入分档依据（960 为实测临界）。**实现侧 480 常数不动**（`INLINE_MIN_TEXT=480` 保留，仅语境收窄）。这是承认几何现实，不是降低验收。
- 未覆盖：真实 Electron 窗口 / DPI / 系统缩放（归 5.1/5.2）；语言 worker 与高亮；超长单行的换行交互逐项截图。

### 2.1（2026-09-23 完成）

`apps/desktop/src/renderer/src/lib/reading-state.ts` 增加可选 `files: FileReadingState` 子结构 + `fileReadingOf` / `patchFileReading`；`store.ts` 接上 `fileReadingOf` / `setFileReading`。新增 `test/file-reading-state.test.ts`（8 passed）。

- **缺省语义可分**：`files === undefined`（未进过文件页）与 `checkpoint === null`（进过、停在初始）是两件事——故用**可选字段**而非必填。
- **共享冻结默认值**（`DEFAULT_FILE_READING_STATE`）：默认值与 `DEFAULT_READING_STATE` 同法共享同一引用，延续 7.1 崩溃教训（逐次 new ⇒ zustand v5 getSnapshot 引用不稳 ⇒ 无限重渲）。用例断言 `defaultReadingState()` 两次调用 `.toBe` 同一引用。
- **字段集合白名单断言**：用 `new Set(Object.keys(...))` 全等比对钉住"只含阅读意图与位置"，并显式断言不含 `text`/`content`/`draft`/`authorized`/`blobPath`/`physicalPath`。
- `patchFileReading` 把显式 `undefined` 视为"不改该项"（避免 `pane: undefined` 误清值），并保证不原地改默认常量（用例断言修改后 `fileReadingOf(defaultReadingState())` 仍为默认值）。
- 未覆盖：字段的**运行时**读写归 2.4 组件接线；滚动恢复的事件级行为归 4.3/5.3。

### 2.2（2026-09-23 完成）

`lib/workspace-files.ts` 追加 `defaultCheckpointStepId` / `validateCheckpointStepId` / `validateSavedPath` 三个纯函数；新增 `test/file-checkpoint-resolve.test.ts`（13 passed）。

- **默认检查点**判据与 `deriveCheckpointOptions` **同源**（只取 `leafSpanIds` 里的 `agent.step`），"最近"按**本 run 本地轮号 `n` 最大**判——不按合并轨迹数组下标（合并轨迹把祖先前缀排在本 run 之前，用下标会选中祖先）。用例专设"祖先 n=9 排在前、自有 n=1 在后"的反例。
- 失败 run 的既有完成步骤**不隐藏**（判据不看 `status`）。
- `validateCheckpointStepId` 三态：`initial`（请求初始）/ `valid` / `stale`（祖先步骤或被删轮次 ⇒ 提示并回退默认，**不**改用另一个"看起来可读"的检查点）。
- `validateSavedPath` 三态刻意把"清单读取失败"判为 `unknown` 而非 `absent`——delta 明文「读取失败 SHALL NOT 等同引用消失」，故保留意图供重试。

### 2.4（2026-09-23 完成）

`WorkspaceFileView` 的选择/pane/路径改读 store（`fileReadingOf` / `setFileReading`），**删除旧的挂载复位 effect 与局部 `selection`/`pane`/`selectedPath` state**；`WorkspaceFilesPanel` 消费一次性 `pendingFileTarget`；store 增加 `pendingFileTarget` 与 `openFileAt`。新增 `test/file-view-session-state.test.ts`（8 passed）。

- **R7 缺陷根因被正面消除**（commit 信息与注释都写明）：C 时代检查点/路径是组件局部 `useState`，而承载组件以 `key={detail.meta.id}` 硬重挂载 ⇒「文件 → 步骤 → 文件」必然回到初始。改用 store 后卸载重建不丢，run 隔离由按 runId 分键保证。
- 接线契约用例**反向断言旧形态必须消失**（`setSelection({...})` / `setSelectedPath(null)` / `setPane("list")` / `const [selection, setSelection]` / `const [pane, setPane]` 均不得出现）——否则"局部 state 复活"会让本段白做且无人察觉。
- 失效回退**可见**：`checkpointInvalidated` / `pathInvalidated` 两条说明各有能力断言（渲染出文字）+ 反向断言（未失效时不渲染，不误报）。
- 一次性目标消费**受 run 身份约束**（`pendingTarget.runId !== detailId` 不消费），避免 A 的目标落到 B。
- 未覆盖：目标消费的**实机**往返（步骤页入口 → 文件页）归 5.3；`openFileAt` 与自有步骤入口的接线归第 4 组一并验。



`lib/reading-resolve.ts` 的 `ReadingTarget` 增加嵌套 `file: { stepSpanId, path? }` 分支（审阅 P2 采纳判别式字段），`ResolvedReading` 增加 `fileTarget`；新增 `parseReadingTarget` 拒收混传。store 增加 `fileReadingOf` / `setFileReading`。新增 `test/file-reading-target.test.ts`（12 passed）+ 既有 `reading-resolve.test.ts` 12 条**零回归**。

- **调用定位与文件定位不可混传**：`spanId`/`expandStepId` 与 `file` 同时出现 ⇒ `parseReadingTarget` 返 `null`（类型上可选、运行期拒绝），避免"定位对象不可判定"。
- **普通返回不消费显式目标**：无 `target` 时即使历史页签是 files，`fileTarget` 也为 `null`（delta 明文）；仅有 `{ tab: "files" }` 同判。
- **file 目标在无文件页的 run** ⇒ 降级概览并标 `invalidated`，不臆造文件页。
- `ResolvedReading` 新增必填 `fileTarget` 字段 ⇒ 所有返回路径都显式给出（5 处 return 全部补齐），无隐式 undefined。
- 未覆盖：**自有步骤文件入口的接线**与"迟到导航不抢页"（代次约束）归 2.3 下半 + 4.3；实机往返归 5.3。

### 3.1 + 3.2（2026-09-23 完成）

`lib/reading-request-guard.ts`（新，纯逻辑）：`RequestGuard`（`begin`/`accept`/`invalidate` 单调代次）+ `ListReadState`/`SideReadState` 三态 + `settleList`/`settleSide` 收口 + `sideResult`/`sideLoading`/`sideFailed` 查询；新增 `test/reading-request-guard.test.ts`（16 passed，含延迟 promise 时序）。`WorkspaceFileView` 连接层改用**三个独立守卫**（清单 / 初始侧 / 所选侧），两侧**独立读取**；`FileContent` 改为只排版（删掉内部自拉初始侧）；新增 `test/file-two-side-read.test.ts`（18 passed）。

- **`cancelled` 布尔是 3.1 的根因**：它只能挡卸载后的迟到响应，挡不住 delta 点名的两类——① 同对象重试 / A→B→A 往返（第二次是**新闭包**，`cancelled` 又为 `false`，旧 A 依然写回，且 key 与当前完全相同，"键相等"判据无解）；② 旧请求 `finally setLoading(false)` 抹掉新请求刚置起的 loading。改用单调代次后二者同时消除：**同 key 也有不同代次**。
- **三个守卫而非一个**：delta 要求「清单和内容分别维护加载/成功/失败」「可独立重试」；共用一个计数器会让一面请求顶掉另一面的代次。`useRef` 持有（守卫是命令式、跨渲染同实例，且自身不触发渲染）。
- **`null` 不再是"不存在"**：`sideResult` 只对 `ok` 给结果，`failed`/`loading`/`idle` 一律 `null`（语义=「没有可用结果」）。文件是否不存在只由 `result.status === "not_found"` 表达——这正是 3.2 要消除的 `null` 等同不存在。
- **通道失败与结果层状态分家**：`failed`（IPC 拒绝 / schema 不合法，连结果都没有）≠ `missing`/`corrupt`/`binary`/`not_found`（拿到了**真实事实**）。界面文案刻意分开（"该侧读取失败，不是不存在" vs "该侧不存在"）。
- **初始侧读取**由"以所选侧成功为前置"改为**独立 effect**（依赖数组只含 `readWorkspaceFile/run.meta.id/effectivePath/initialKey`，不含 `current`）——旧写法下所选侧一失败初始侧就永不读，界面把"未读"显示成"两侧都没有"。
- **`FileContent` 内部拉取删除**：旧代码 `useEffect` + `useState<WorkspaceReadFileResult>` 自拉初始侧，且 `current === null || current.status === "rejected"` 时**直接 return 不读**。现在两侧数据全由连接层喂入，`FileContent` 只渲染；`!sides.hasContent` 的粗暴合并分支（把"未读/失败"与"确实不存在"混谈）一并删除。
- **变异验证**（4 组，全部被捕获）：① `accept` 退化成只比 key → 5 条失败；② `settle` 无视守卫 → 失败；③ `sideResult` 把 failed 折成 `not_found` → 失败；④ 接线契约反向断言：清单 `then` 必须过 `settleList`、三处不得 `setXxxState({kind:"ok"})` 绕过、`!sides.hasContent` 必须消失、`FileContent` 函数体内不得有 `useEffect`/`fetchInitial(null`/`useState<WorkspaceReadFileResult`。源码变异还原后 `md5sum -c` 复核通过。
- **接线契约必须源码级**：本包无 jsdom，「响应有没有过守卫」组件测试打不到（U1 三度复发的同类问题），故用 source 级正/反向断言钉住。
- 未覆盖：**延迟切换/重试的实机点击核对**归 5.4；独立重试按钮与单侧可读的完整呈现归 3.3；目录搜索/筛选归 3.4。

### 3.3（2026-09-23 完成）
`lib/workspace-files.ts` 的 `resolveDiffSides` 增 `leftNote`/`rightNote` 四态（`text`/`not_found`/`unavailable`/`unread`）+ 新增 `canEnterTextDiff`；`WorkspaceFileView` 引入 `listRetry`/`initialRetry`/`selectedRetry` 三个独立重试 nonce，展示层三处重试按钮。`workspace-files.test.ts` +6 条、`file-two-side-read.test.ts` +5 条、`workspace-file-view.test.ts` +1 条并修 1 条。

- **「不可用侧置空进行 diff」被正面堵死**：C 时代只要"当前侧不是 rejected"就进 `MonacoDiffEditor`，缺席侧一律喂 `""` —— 若初始侧是 binary/missing/corrupt/未读，编辑器就把 `""` 当"空文件"参与比较，正是 delta 禁止的**伪空差异**。现在进编辑器前必过 `canEnterTextDiff`：只放行「两侧 `text`」或「**初始侧** `not_found` + 所选侧 `text`」（新增文件是合法空侧，且保留「该侧不存在」标识）。
- **所选侧 `not_found` 明确拒绝**（与初始侧不对称）：delta 明文只放行「初始 `not_found`」；所选检查点里没有这条路径，语义上不是"新增"，拿它当空侧比较即假报差异。实现与用例都按这个不对称钉住（变异 E 验证：放宽成对称即失败）。
- **四态缺席成因可分**：`unread`（null = 加载中/失败/未读，**绝不等同不存在**）、`unavailable`（binary/missing/corrupt/rejected，不可比较）、`not_found`（经校验确认不存在）、`text`。界面按成因分别出文案（"初始快照侧：正在读取" / "读取失败（不是不存在）" / "内容不可比较" / "清单确认不存在"）。
- **独立重试**：三个 nonce 各自进 effect 依赖 ⇒ 真的**重新调用只读 IPC**（不是复用旧结果），且重走路径/检查点校验；清单失败与内容失败互不牵连（三个按钮分别在清单错误块、所选侧错误块、"不进入 diff"块）。`biome-ignore useExhaustiveDependencies` 标注为**有意为之**（nonce 是触发器，非数据依赖）。
- **接线契约**：连接层必须把三个 `onRetry*` 回调传给展示层（变异 G 验证：删掉传递即失败）；`useAppStore` 取用的动作白名单只允许 `inspectWorkspace`/`readWorkspaceFile`/`fileReadingOf`/`setFileReading`（钉住"零写入通道"）。
- 变异验证（3 组全捕获）：E 所选侧 `not_found` 放行 / F `canEnterTextDiff` 恒放行 / G 重试回调不传。还原后 `md5sum -c` 通过。
- 未覆盖：**实机点击重试并核对内容真的重读**归 5.4；「复制路径/原文/元信息」与「查找换行差异导航」归 4.4/4.5。

### 3.4 + 3.5（2026-09-23 完成）

`lib/file-directory.ts`（新，纯逻辑）：`resolveChangeFilter` / `hasChange` / `filterFiles` / `deriveDirectoryEmptyReason` / `directoryEmptyMessage` / `directoryCounts`；`WorkspaceFileView` 接线搜索框（`按完整路径搜索`）+ 自动/全部/有变化三按钮 + `筛出 N / 共 M` 计数 + 四态空态（空清单/无变化/无匹配/无）+「查看全部」「清空搜索」入口。新增 `test/file-directory-filter.test.ts`（21 passed）。

- **筛选判据只有 added/modified**：不依赖 mtime、不依赖附件可用性——`docs/Guide.md`（unchanged 但 missing）在「有变化」下**不出现**（delta 明文"缺失或损坏不被标为删除或新增"）。
- **auto 在连接层解析**：`changeFilter={changeFilter}`（解析后 all|changed）与 `filterPreference={saved.filter}`（用户偏好原值）**分开下传**，展示层不自己算 auto。
- **计数与规模分开**：受筛时 `筛出 N / 共 M`，未受筛时 `共 N 个`——筛选结果不冒充清单规模。
- **筛选不偷换选择**：被筛掉的当前路径仍保留内容区标题与阅读状态（`selectedFile` 从**完整清单**取，不从 `visibleFiles` 取）。
- **切检查点保留仍存在路径**：`validateSavedPath` 在 2.2 已就绪，此处接线——present 原样保留、absent 清空并提示、unknown 不当作消失。

### 第 4 组（2026-09-23 完成，骨架版）

一版**完整可跑的界面骨架**（按用户指示先搭骨架、视觉后迭代）：

- `lib/file-layout.ts`（新，纯逻辑，design D4）：`clampFileDirWidth` / `stepFileDirWidth` / `decideDirResident`（容器实测宽 + 扣目录/间距/chrome 后 inline 文字区 ≥480 才常驻）/ `decideDiffMode`（两侧文字区各 ≥320 才并排，用户选并排但不足 ⇒ 降级 inline 且**说明空间不足**）/ `resolveFilePaneVisibility` / `preserveFilePrefs`。常量：目录 232（200–320）、`INLINE_MIN_TEXT=480`、`SIDE_BY_SIDE_MIN_TEXT=320`、`MIN_CODE_FONT_SIZE=13`。
- `lib/use-file-layout.ts`（新）：`useContainerWidth` 走 `ResizeObserver` 实测**文件容器**宽（不是窗口断点）；静态渲染回落 1280 供组件测试断言分支。
- `lib/file-tools.ts`（新，纯逻辑，design D6）：`sideReadiness`（text 空串=ready 合法空文件；null+failed=失败不折 not_found）/ `copyableText`（只对 text 给全文，不可读侧 null 不冒充空）/ `copyableMeta`（binary/missing/corrupt 给真实大小+完整哈希）/ `resolveToolEnablement`（按实际可读/可比较/就绪启用；无差异不假跳转；inline 下差异导航禁）/ `writeClipboard`。
- `WorkspaceFileView` 接线：容器测量 → 目录常驻/收起 + 目录宽拖拽/键盘；`FileContent` 按容器宽决定 inline/并排；**只读工具栏**（复制路径/两侧原文/元信息、换行开关、上一/下一差异、模式切换，按 `tools` 判据禁用并给 `title` 说明）；`fontSize: 13`；编辑器高度改 `min(60vh, 640px)`（消去固定 420px）；目录/内容切换；列表滚动位置接入会话状态。
- 新增 `test/file-layout.test.ts`（13 passed）+ `test/file-tools.test.ts`（11 passed）；`test/file-two-side-read.test.ts` +14 条能力断言与接线契约。
- 变异验证（4 组全捕获）：① 改用 `window.innerWidth` 判宽 / ② 目录宽不写回会话状态 / ③ `fontSize` 缩到 11 / ④ 换行开关不接入 Monaco。源码还原后 `md5sum` 复核通过。
- 未覆盖（归第 5 组实机 + 后续视觉迭代）：真实 Electron 各档窗口矩阵实测、Monaco 两侧**实际**文字区尺寸校准 chrome 常数、长文本滚动位置恢复的事件级行为、键盘完整焦点链与 tooltip 走查。

## 1. 基线、标本与原型

- [x] 1.1 核对 C/U1 fixture 并准备专用阅读测试副本（1.5h）；覆盖“初始与各轮文件快照可选择”“文件选择器轮号不沿链累加”“失败运行已记录文件可查看”“新增文件与零字节文件不混同”“两侧都不可读时没有伪空编辑器”，记录普通/隔离根/子/二次分叉关系、长文本和异常状态，不改既有附件。
- [x] 1.2 核对已安装 Monaco 的公开命令、布局和定位 API，制作窄/宽文件原型并量测 D4 阈值（1.5h）；对应“文件正文在代表视口可读”“同视口下响应容器变化”“极窄与放大后仍可阅读”，记录短句/长路径和文字区，单独记录 800px 下目录常驻与 diff 模式两次决策，示例原型不算真实桌面验收；不可达时先修订四件套，不通过降低正文要求达标。
  - ✅ **已按「先修四件套」落实**：实测量得「inline ≥480」的临界视口 = 960px，800px 几何不可达 ⇒ 已修订 spec delta + design D4，把 480 下限限定到 ≥960px 视口、800px 及以下定义为窄档（详见上文 1.2 进度记录的「遗留已落定」）。

## 2. 会话状态、选择和导航

- [x] 2.1 为 reading-state/store 增加文件状态、稳定默认值和按 run/step/path 的纯 patch（1.5h）；测试“文件页签往返恢复阅读”“跨运行和辅助视图返回恢复文件”“文件阅读状态不跨进程承诺”，只存阅读信息、不存正文/授权。
- [x] 2.2 实现默认检查点和引用重校验纯逻辑（1.5h）；验证“首次文件页选择最近自有完成步骤”“无自有完成步骤时选择初始”“失效检查点和路径安全回退”“文件选择器轮号不沿链累加”，失败运行保留已有步骤。
- [x] 2.3 扩展 ReadingTarget 的嵌套 file 分支并连接自有步骤文件入口、普通页签返回与一次性目标消费（1.5h）；验证“显式文件定位覆盖历史”“跨运行和辅助视图返回恢复文件”，含相同目标再次定位、祖先门禁、调用字段与文件字段不可混传、无 file 时普通返回及迟到导航不抢页。
- [x] 2.4 将 WorkspaceFileView 的选择/pane/偏好接入会话状态，取消挂载重置（1.5h）；验证“文件页签往返恢复阅读”“切检查点保留仍存在的路径”“失效检查点和路径安全回退”，保留运行 key 隔离和文件能力失效回退。

## 3. 双侧读取和目录

- [x] 3.1 为清单与两侧读取增加身份/代次守卫及完整错误状态（2h）；用延迟 promise 验证“快速切换不串清单正文错误和加载”“同对象重试与往返有请求代次”，分别覆盖成功/失败/异常/finally 和卸载。
- [x] 3.2 实现独立两侧读取与比较资格派生，去除 null 等同不存在（1.5h）；验证“新增文件与零字节文件不混同”“不可用侧不伪装为空差异”“两侧都不可读时没有伪空编辑器”，左右互换与初始同侧均有用例。
- [x] 3.3 展示单侧可读、双侧异常及清单/内容独立重试（1.5h）；验证“二进制和不可用附件分别显示”“不可用侧不伪装为空差异”“阅读重试只读且重新校验”，读取失败保留定位、不假报无变化。
- [x] 3.4 增加路径搜索、auto/all/changed 偏好与空态派生（1.5h）；验证“路径搜索与变化筛选组合”“初始与完成检查点的默认筛选”“空清单无变化和无匹配可区分”，可用性与变化分离。
- [x] 3.5 连接目录控件、完整路径显示和隐藏选择恢复（1h）；验证“筛选不偷换当前文件”“切检查点保留仍存在的路径”，单独标示筛选计数，保留原清单规模。

## 4. 容器布局、编辑器与阅读工具

- [x] 4.1 实现文件容器测量、可调整/折叠目录和列表/内容切换（1.5h）；验证“同视口下响应容器变化”“手动布局偏好不被自动折叠覆盖”，尺寸变化不重复写 store 或覆盖用户意图。
  - ✅ **2026-09-23 补齐“可调整目录”**：复审发现「可调整」原本未落地——`stepFileDirWidth`/`clampRestoredDirWidth` 是**死导入**（纯逻辑 + 单测绿，但无任何 UI 消费）。已补：常驻目录旁加可聚焦**分隔条**（`role="separator"` + `tabIndex`），拖拽（pointerdown/move/up + `clampRestoredDirWidth` 夹取）与键盘（ArrowLeft/Right 16px、Home/End，走 `stepFileDirWidth`）均写回会话状态。折叠/列表-内容切换/容器测量原已属实。
- [x] 4.2 实现文字区阈值、auto/inline/并排与弹性编辑器高度（1.5h）；验证“文件正文在代表视口可读”“极窄与放大后仍可阅读”“长文本及窄窗口”，消除固定 lg 目录和 420px 高度依赖。
  - 说明：`INLINE_MIN_TEXT=480` 保留，其语义按 D4 分档解读——「≥960px 视口下 480 成立」；960px 以下容器窄到几何不可达 480 时，目录收起 + 强制 inline 即为正确降级（不再视为"未达标"）。
- [x] 4.3 保存/恢复列表、内容容器及 Monaco 两侧定位，处理卸载和布局变化（1.5h）；验证“文件页签往返恢复阅读”“跨运行和辅助视图返回恢复文件”“手动布局偏好不被自动折叠覆盖”，检查延迟挂载后恢复及位置夹取。
- [x] 4.4 增加路径、两侧原文和元信息复制及剪贴板失败反馈（1h）；验证“复制路径原文及元信息”“不可比较或未就绪时工具诚实禁用”，复制全文而非显示截断。
- [x] 4.5 接入查找、换行、真实差异导航及模式控件（1.5h）；验证“查找换行和差异定位使用当前文件”“不可比较或未就绪时工具诚实禁用”，不对旧 Monaco 模型发命令，不开放替换写入。
  - ⚠️→✅ **2026-09-23 复核改回未勾，随后补齐**：原「查找入口不存在」「上一/下一差异为无 onClick 死按钮」「`diffCount` 写死 1」。补齐内容：① `MonacoEditor.tsx` 新增 `behaviorProps` 转发 `onMount`（`editorAttrs` 只透传 `data-*`/`aria-*`，故实例此前到不了父组件）；② 接 `onMount` → `diffEditorRef`，`goToDiff("previous"|"next")` 真实导航；③ `onDidUpdateDiff` + `getLineChanges()` 得**真实** `diffCount`（去掉写死）；④ 新增「查找」按钮走 `actions.find`（只读，无替换/写入）。接线契约断言 + 5 组变异（删 onClick / 写死 diffCount / 删键盘 / 删分隔条键盘 / 删查找 onClick + onMount 转发）**全部被捕获**。
- [x] 4.6 完成键盘、tooltip、焦点恢复、工具栏换行和持续错误反馈（1h）；验证“文件阅读键盘操作与离线加载”“极窄与放大后仍可阅读”，保持 U1 本地懒加载与现有其他编辑入口。
  - ⚠️→✅ **2026-09-23 复核改回未勾，随后补齐**：原「无任何键盘/焦点/role」。补齐内容：文件列表 `role="listbox"` + option 按钮 `role="option"`/`aria-selected`/roving `tabIndex`，`onKeyDown` 处理 ArrowUp/ArrowDown/Home/End，选择后焦点交回目标项（`data-file-path` + `.focus()`）；分隔条亦支持键盘（并入 4.1）。接线契约 + 变异（删 `onKeyDown` 接线）**被捕获**。
  - 说明：`tooltip`（9 处 `title=`）与工具栏换行本已属实；「持续错误反馈」由 3.3 的独立重试块承载。真实离线加载归 5.2/5.6 实机。

## 5. 实机验收与只读回归

- [x] 5.1 在真实 Electron 记录 1440/1360/1210px 宽窗口矩阵（1.5h）；验证“文件正文在代表视口可读”“长文本及窄窗口”“同视口下响应容器变化”，按 design D7 记录各层尺寸、Monaco 文字区及截图，不复用改造前走查作为结果。
  - 证据：`docs/reviews/2026-09-23-u2-51/README.md`（12 张截图 + 六档矩阵）；原始数据 `.workbuddy/u2-51/measurements.json`（75/75 checks 全绿）。D7 六档 1440/1360/1210/1024/800/640 **全部可达**（更正先前“1440/1360 物理不可达”的结论：实为最大化裁剪所致）。
  - 实机暴露并修复 **2 处真实产品缺陷**：① Monaco 内部 `renderSideBySideInlineBreakpoint:900` 静默覆盖外层 `renderSideBySide`（monoW 909→893 时左侧塌成 36px）⇒ `WorkspaceFileView.tsx` 加 `useInlineViewWhenSpaceIsLimited:false`；② `decideDiffMode` 把两侧 chrome 当同一常数 56（实测左 64/右 47），1024 档误判并排（左文字区仅 306 < 320）⇒ `file-layout.ts` 改双常量 + 外层 71，取较小侧判据，并补临界回归单测（811→inline / 839→sideBySide）。
  - 三档归 5.2：`zoomFactor=2`、极窄档、离线加载另行实测，故 5.1 只覆盖横向视口矩阵。
- [x] 5.2 实测 1024×768、800×600、640px 宽及独立 zoomFactor=2（1.5h）；验证“极窄与放大后仍可阅读”“手动布局偏好不被自动折叠覆盖”“文件阅读键盘操作与离线加载”，记录实际 CSS viewport/DPR，测短句可读性及工具栏焦点。
  - 证据：`docs/reviews/2026-09-23-u2-52/README.md`（7 张截图 + 七段结果矩阵）；原始数据 `.workbuddy/u2-52/measurements.json`（**54/54 checks 全绿**：zoom2 13、800-narrow 12、640-single 12、prefs 5、prefs-narrow 4、prefs-restore 3、offline 5）。
  - 环境真值（CDP 证实）：物理屏 2560×1600 @ 210% 缩放 ⇒ CSS 桌面 1220×762、DPR 基线 2.1（5.1 所记「1707×1067 @141%」为 DPI 虚拟化假象，已更正）；zoom2 档 DPR 4.2、CSS 视口精确减半 605。⚠️ **更正（2026-09-24 任务 6.3 复核对齐）**：本条原写「可达 CSS 视口上限 1207」「1440/1360 档本机物理不可达（与 5.1 结论一致）」——**该结论已被 5.1 §2 实测推翻**（窗口外框可超出屏幕物理边界，加 `SW_RESTORE` 复原窗口后 D7 六档全部可达；5.1 矩阵实测 1440→1441、1360→1361 CSS 视口、各 12/12 checks）。原因：1207 上限是窗口处于**最大化**被屏幕裁剪所致。**以 5.1 的更晚结论为准**；本档只测极窄/放大/偏好/离线，未重复测宽档。
  - 实机暴露并修复 **2 处真实产品缺陷**：③ 窄档 ≤800px 目录未强制收起（`decideDirResident` 缺门，1.2 候选 A 只收窄 spec 未改实现）⇒ `file-layout.ts` 加 `NARROW_TIER_MAX=800` 窄档门 + 2 临界回归单测（16 用例）；④ 宽档目录常驻时无任何收起入口（按钮只在 `!dirResident` 分支渲染）⇒ `WorkspaceFileView` 页头加「收起目录」按钮，宽档 `dirUserCollapsed` WHEN 可达。
  - harness 断言修正（非产品缺陷）：Esc 返回编辑器的表达式漏判新版 Monaco `native-edit-context`，探针证实焦点确回编辑器 ⇒ 修正并纳入断言。
  - 偏好保持三段（prefs→prefs-narrow→prefs-restore）须同页面会话按序执行（zustand 内存态，dev 重启即失）；zoom 持久化陷阱（`Preferences` 的 `per_host_zoom_levels`）与类名过滤改窗方案已记录在证据 README「陷阱记录」。
- [x] 5.3 实测文件/步骤/运行/分支/设置往返、长正文滚动及显式定位（1.5h）；验证“文件页签往返恢复阅读”“跨运行和辅助视图返回恢复文件”“显式文件定位覆盖历史”“失效检查点和路径安全回退”，含同名跨 run、无效 path 和搜索隐藏选择。
  - 证据：`docs/reviews/2026-09-23-u2-53/README.md`（15 张截图 + 六 tag 结果矩阵）；原始数据 `.workbuddy/u2-53/measurements.json`（**36/36 checks 全绿**：roundtrip 8、cross-run 9、explicit 5、search-hidden 5、fallback 9；另 probe 只 dump 真机事实）。环境真值：CSS 视口 1210×713、DPR 2.1（medium 档）。
  - 强证据：正文锚点 `contentScroll={s_11, long.txt, line 7, offset 2}` 随真滚轮从首行 1 变到 8，文件→步骤→文件往返后 DOM 仍为首可见行 8；跨运行 A(`s_01`/line 7)/B(`s_17`/line 4) 同名 `long.txt` 各自保持，经分支树+设置返回后 A 仍 line 7 且 B 不受影响；`pendingFileTarget` 全程为空（普通返回不消费显式目标）。**列表滚动一项本档证据力弱**（该夹具清单只可滚 2px），已在 README 如实标注，改由接线契约测试 + 变异 M4 立证。
  - 实机暴露并修复 **6 处真实产品缺陷**（①②③④ 属“纯逻辑写好但未接上界面”的接线缺口）：① 正文滚动位置**根本没有字段**（4.3 被误勾）⇒ 新增 `lib/file-scroll.ts`（行号 + 相对偏移锚点，按 step/path 匹配）+ `FileReadingState.contentScroll` + mount 恢复与滚动上报；② 列表滚动**只写不读** ⇒ `listScrollRef` + `decideRestore` 门控恢复；③ **全仓无调用方**的 `openFileAt` ⇒ `DetailPanel` 步骤页新增「打开该轮文件」（以 `validateCheckpointStepId(...)==="valid"` 为门，祖先步骤不给入口）；④ 带 path 的显式目标未清搜索/切 all；⑤ **无 path** 的显式目标同样未解阻（定位后看到空列表）；⑥ 失效引用**从不写回**会话状态（“清空”退化为“永久告警”）⇒ `WorkspaceFileView` 一次性写回清理 + 提示锁存，且清理只看 `absent` 判据（读取失败保留定位意图供重试）。
  - 回归与变异验证：新增 `test/file-scroll.test.ts`（10 用例）、`test/file-view-scroll-wiring.test.ts`（16 用例：能力断言 + 接线契约 + 反向断言），`file-reading-state.test.ts` 字段清单纳入 `contentScroll`；`.workbuddy/u2-53-mutate.cjs` 打 6 个变异（M1 失效不写回 / M2 提示不锁存 / M3 正文锚点不接线 / M4 列表只写不读 / M5 无 path 不解阻 / M6 入口不接回调）**6/6 全被捕获**，证明源码级接线断言非空转。
  - 陷阱记录（README §6）：store 探针的**模块身份陷阱**（`import('/src/store.ts')` 拿到另一份空 store 且不报错，必须从 `performance` 资源表解析应用用过的 URL 再 import，并加 `assertStoreLive` 自检）；`node --check` 抓不到模板字面量内嵌反引号；medium 档切 run 须先回「概览」（`navOpened`/`setNavOpened` 无 UI 调用方 ⇒ <960 档运行列表不可达，**属 U1 范围，本次仅记录不改**）；默认筛选 `auto` 在完成步骤解析为 `changed`（未改动文件不在清单）；DOM 与 store 的行号语义差 ±1（容差 2）；短文件不可用于验滚动位置（假通过）。
- [x] 5.4 实测双侧异常、延迟切换/重试及工具命令（1.5h）；验证“不可用侧不伪装为空差异”“快速切换不串清单正文错误和加载”“同对象重试与往返有请求代次”“复制路径原文及元信息”“查找换行和差异定位使用当前文件”，不以静态结构测试代替点击和内容核对。
  - 证据：`docs/reviews/2026-09-23-u2-54/README.md`（19 张截图 + 六 tag 结果矩阵）；原始数据 `.workbuddy/u2-54/measurements.json`（**44/44 checks 全绿**：sides 9、both-unreadable 5、tools-copy 9、tools-find 9、race-retry 12；probe 只 dump 真机事实不计 checks）。环境真值：CSS 视口 1210×713、DPR 2.1（medium 档）；夹具 `run_mue9rvkh_i9oil7`（A 型：初始侧 binary / 所选侧 text）、`u2side_mirror`（B 型左右互换）、`run_mudwrlbg_199xw1`（真差异与 200 行长文件）。
  - 强证据：单侧可读时 monaco **真模型** `standalone[0].text = 现在是文本内容`、`readOnly=true`，`.monaco-diff-editor=false` 且 `[data-testid="single-side-editor"]=true`，该侧复制/查找/换行可用而不可用侧诚实禁用（左右互换逐条对称）；两侧都不可读 ⇒ 一个编辑器都不渲染、无「无变化」伪装；元信息复制为**真实大小 + 完整 64 位哈希**，不可用侧复制点了也不写剪贴板（仍哨兵）；`版本`/`长文本样本` 查找 `.matchesCount="1 of 1"`、`alpha` 为 `"No results"`，切到 0 差异文件后（`lineChangeCount=0`）导航诚实禁用；真 IPC 包装层日志立证"最难场景"——③ 迟到哨兵未串入新文件、④ 往返只认最新代次（最旧 A 迟到后仍为真实文本）、卸载场景延迟 6000ms 落在切页之后且离开/迟到最后 `path=steady.txt ckpt=s_05` 一致、所选侧失败后 `path` 仍保留且重试**真的再发一次只读 IPC**（日志 23→24）并显示当前校验结果。
  - 实机暴露并修复 **2 处真实产品缺陷**（均属"可读侧全文没接上界面"，静态单测全绿照不出来）：① 两个"进不了 diff"的早返回分支**不渲染任何编辑器** ⇒ 新增**只读单侧视图**（`MonacoCodeEditor` + 真实 DOM 锚点，`readOnly: true`、无替换入口、`onMount` 接实例供查找）并修 `resolveToolEnablement` 判据（新增 `editorReady`，`find/wordWrap` 不再绑 `diffEligible`）；② `!comparability.ok` 分支**只标所选侧**（另一侧"有文本"完全不可见）⇒ 补同源同文案的两侧状态行 + 初始侧重试入口。附带：三个早返回是**独占卡**（另一侧可读时会把可读侧全文一起吞掉）⇒ 以 `initialReadableText === null` 门控落入统一呈现（失败明细/错误码不丢），并修门控后 `current` 可为 null 引发的头部取值与 `rejected`/`not_found` 判空。
  - 回归与变异验证：新增 `test/file-single-side-view.test.ts`（18 用例：能力断言 + 门控断言 + 接线契约），`file-tools.test.ts` 补 `editorReady` 并把"只有一侧 ready"拆成两条路；`.workbuddy/u2-54-mutate.cjs` 打 6 个变异（单侧视图不渲染 / 两侧状态不标 / 判据退回 `diffEligible` / 查找不接单侧实例 / 单侧编辑器非只读 / 早返回门控被拿掉）**6/6 全被捕获**（baseline 18/18 全绿），证明源码级接线断言非空转。
  - 陷阱记录（README §5，harness 侧，全部已修）：`@monaco-editor/react` 只经 `wrapperProps` 透传 `data-*` ⇒ 给 `<Editor>` 的 `data-testid` 在已加载时**不落 DOM**，探针必须改用 monaco 原生容器类 / 产品挂在真实包裹层上的锚点；Windows 剪贴板把 LF 规范化为 CRLF（8529→8732，差 203 = 行数）是平台行为，断言前归一；查找框不是 `input[aria-label="查找"]`（且被选区自动预填）⇒ 原写法**一个字符都没输进去却假通过**，改按 `.monaco-inputbox .input` 定位并断言输入值；`setRules` 未重置 `__u254n` 代次计数 ⇒ 后续子场景的失败注入静默失效；同路径两侧读共用 key ⇒ 注入需按 `side` 点名；卸载场景基准须取在切页之后且延迟须大于 `pickFile` 耗时；`node --check` 抓不到模板字面量内嵌反引号。
- [x] 5.5 回归原 IPC 安全、未录制/失败记录和只读不变性（1.5h）；验证“文件读取 IPC 拒绝越权”“二进制和不可用附件分别显示”“失败运行已记录文件可查看”“文件浏览过程无写入”“阅读重试只读且重新校验”；源/父/兄弟/既有 trace/附件逐文件前后 SHA-256 一致，模型及工具零调用。
  - 证据：`docs/reviews/2026-09-24-u2-55/README.md`（12 张截图 + 六 tag 结果矩阵）；原始数据 `.workbuddy/u2-55/measurements.json`（**40/40 checks 全绿**：ipc-guard 11、unavailable 8、errored 6、readonly 12、selfcheck 3；probe 只 dump 真机事实不计 checks）。环境真值：CSS 视口 1210×713、DPR 2.1（medium 档）；夹具生成器 `apps/desktop/scripts/gen-u2-55-fixtures.cjs`（真实引擎 root/fork/errored + 独立哈希的 missing/corrupt + 无自有完成步骤标本），采集脚本 `apps/desktop/scripts/u2-55-cdp.cjs`。
  - 强证据（**越权走真 IPC**）：`window.api` 直调（不经 store/组件）——非法 runId（穿越/NUL/`.`/`..`）返 `WORKSPACE_INVALID_REQUEST` 或 `rejected{invalid_request}`；清单外路径、物理 blob 路径、未规范化分隔符一律 `not_found`；**祖先 step** 定位本 run ⇒ `rejected{step_not_found}`（read）与 `WORKSPACE_STEP_NOT_FOUND`（inspect）；请求形状非法 ⇒ `INVALID_ARGUMENT`；**同一路径存在于别的 run 的清单、或只存在于本 run 的别的检查点** ⇒ 均 `not_found`（不以同名文件/其他快照替代）。哨兵宿主文件（5 种物理/穿越写法）**全部无泄漏**；对照项（合法请求）**确实成功**并返回真实文本 ⇒ 拒绝判据非"一律拒绝"。
  - 强证据（**不可用附件分别显示**）：二进制 ⇒「二进制文件」+ 真实大小/完整哈希、**一个编辑器都不渲染**；附件缺失 ⇒ 列表徽标「附件缺失」+「不会用空文本或源目录兜底」；附件损坏 ⇒「附件损坏」+「哈希/长度不符，拒绝展示内容」；三者 `fakeEmptyClaim` 全 false。无自有完成步骤的旧 run ⇒ 选择器**只剩「本 run 初始状态」**、初始清单照常可读。
  - 强证据（**失败运行**）：`reason:"error"` + 概览「出错终止」双证据；已落盘的 3 个检查点全列出；第 1 轮 monaco **真模型** `初始版本 → 失败前的写入`（真实写入），切第 2 轮仍可读 ⇒ 失败不撤销历史写入。
  - 强证据（**只读不变性**）：冻结源目录/夹具目录/live trace/live 附件共 **119 条哈希（113 个唯一文件）**，浏览（切检查点、开 diff、开长文本、开二进制、重试清单、重试内容）前后 **`diff = []`**、`traces 70→70 / blobs 21→21 / source 6→6` ⇒ 逐字节不变故**零 LLM/工具调用**。重试由**真 IPC 包装层日志**立证真的重发：`inspect occ1 fail → occ2 pass`、`read/selected/edit.txt occ1 fail → occ2 pass` 且随后显示**当前**校验结果。
  - **"判据有牙"自检**（`selfcheck` 3/3，非验收项）：故意新增文件 / 改写清单 ⇒ 分别检出「新增」「哈希变化」，逐字节还原后回到零差异 ⇒ 冻结面不是空转真。
  - 本轮**未发现产品缺陷**；但发现并修正 **1.1 留下的一处坏标本**：其「无自有完成步骤」标本把 `fork.at_span` 与 `resume_after_step` 设成同一个 `agent.step` id，而 `trace-sdk` 的 `resolveBranch` 硬校验前者必须是该轮内的工具调用 ⇒ 该标本**经运行列表读取必被拒**（1.1 的用例只 `readRun` 本文件，未覆盖分支解析，故未暴露）。本任务生成器改为取该轮内真实 `tool.invoke` 作 `at_span`，并把自检改为**显式调用 `resolveBranch`**。1.1 的生成器本轮未改动，如实记为遗留项（README §5）。
  - harness 侧另修 6 类坑（`find` 返回 `undefined` 致脚本崩溃 / `null?.diff === null` 恒假的假失败 / 两侧读共用计数桶致点名注入静默失效 / 同检查点同路径不重发 IPC / 模块 URL 形态不唯一 / `node --check` 抓不到模板字面量内嵌反引号）。
- [x] 5.6 在受控数据副本上重启、整体迁移、仅迁 JSONL 并断网读取（1.5h）；验证“重启后查看文件差异”“数据目录迁移后文件仍可查”“文件阅读状态不跨进程承诺”“文件阅读键盘操作与离线加载”；普通 run 无伪文件页，现有概览/步骤/编辑/执行入口仍可达。
  - 证据：`docs/reviews/2026-09-24-u2-56/README.md`（9 张截图 + 四 tag 结果矩阵）；原始数据 `.workbuddy/u2-56/measurements.json`（**34/34 checks 全绿**：restart-state 9、migrate 10、keyboard-offline 10、compat 5；probe 只 dump 真机事实不计 checks）。环境真值：CSS 视口 1210×713、DPR 2.1（medium 档）、运行名单 71 项；新增夹具生成器 `apps/desktop/scripts/gen-u2-56-fixtures.cjs`（真实引擎根 R + **隔离子 run S（自有轮写入）** ⇒ 初始 vs 完成步骤有真实差异）与采集脚本 `apps/desktop/scripts/u2-56-cdp.cjs`（五 tag）。
  - 强证据（**重启后查看文件差异 + 状态不跨进程**）：**真进程重启**（先确认 9612 端口真的空出，避免"pid 过期 ⇒ `--stop` 假成功 ⇒ 启动因端口占用直接返回"的假重启）；重启前刻意选**非默认**的初始（`entered=true, checkpoint=null`）⇒ 重启后 `entered=false`（文件状态未跨进程）且按首次进入策略落到**默认检查点「本 run 第 2 轮结束」**；选中完成步骤的修改文件后 monaco **真模型** `根第二轮改写 → 子 run 改写`、`lineChangeCount=1`、只读；未选文件时界面无任何内容副本；浏览全程逐文件 SHA-256（夹具 9 + traces 72 + 附件 25 = **106 文件**）**零变化**。
  - 强证据（**数据目录迁移**）：①整体迁移＝把 `.rebaseagent` **整个改名到另一个绝对路径**，用**新 dataDir** 直调真实读取 API 仍读出两侧真实文本，且迁移期间原 `source` 路径随数据目录一并不可达（⇒ **不依赖原 source 路径**）；迁回 + 重启后界面 diff 逐字一致。②仅迁 JSONL＝新路径下只有 `traces/` ⇒ `readRun` 成功而 `readWorkspaceFile` 报 **`missing`**；应用层（临时移走 live 附件 + 重启）徽标「附件缺失」、轨迹与步骤页照常可读、不渲染伪空文件；复位 + 重启后恢复可读。三处 rename 全程在 `finally` 还原（另有 `RESTORE-NEEDED.txt` 标记，收尾核验无残留）。
  - 强证据（**键盘 + 离线**）：资源 host **只有 localhost**（外部 host 0，monaco/css/worker 相关 172 项）⇒ Monaco 本地懒加载；`offline=true` 下仍渲染 diff 编辑器；键盘逐项实测——列表 `Home/End/ArrowUp` 选中且焦点跟随、检查点 Enter 激活、搜索键入 `edit` 筛到 1 项且退格清空恢复、目录宽度分隔条 `ArrowRight` 232→248、工具栏「换行」Enter 翻转、查找 Esc 关闭且焦点回编辑器。
  - 兼容性：普通 run `r_02` **只有概览/步骤两页签**、无文件清单/无 `listbox`（**无伪文件页**）；概览/步骤可达；在**自有**工具 span 上出现「在此重跑」编辑入口；壳层「新建运行/运行配置/代理录制」等执行类入口可达。
  - **实机暴露并修复 1 处真实产品缺陷**（违反 delta「首次进入 SHALL 选择最近自有完成步骤」，`specs/desktop-ui/spec.md` L51/L55-57）：`WorkspaceFileView` 只把 `defaultCheckpointStepId` 用在 `stale` 分支，首次进入时 `saved.checkpoint === null` 被 `validateCheckpointStepId(run, null) === "initial"` 吞掉 ⇒ 实际总停在**初始**；根因是**两种"没有 step id"被混为一谈**（`files === undefined` 从未进入 vs `checkpoint === null` 明确要看初始）。修复：新增纯函数 `resolveCheckpoint(run, {entered, checkpoint})` + store 的 `fileReadingEntered(runId)`，并在首帧把解析出的默认检查点**写回会话状态**（否则随后任一 patch 以 `checkpoint:null` 起底 ⇒ 界面突然跳回初始；写回前复查新鲜状态以免覆盖父组件写入的显式目标）。回归：`file-checkpoint-resolve.test.ts` +11（纯函数 5 + 接线契约 6，含 2 条反向断言），`file-view-session-state.test.ts` 的引用校验断言同步改钉新接线；desktop **1295 passed / 66 文件**（较 5.5 +11）；实机复测首次进入落「第 2 轮结束」并立刻呈现真实差异。
  - harness 侧另修 8 类坑（`node --check` 抓不到模板字面量内嵌反引号 / `<button>` 的 Enter 激活需 `rawKeyDown+char+keyUp` / store 字段名写错静默变空 / `bodySample` 截断致详情判据假失败 / 「清空搜索」只在空态渲染 / find widget 可见性须按 `visible` 类名 / 重启须确认端口真空出 / **一次调用跑多 tag 会让 spawn 的 Electron 撞沙箱** ⇒ 每个 tag 单独一次调用且 dev 非沙箱起）。

## 6. 质量检查与证据

- [x] 6.1 执行依赖包构建、类型检查、desktop 全量与相关 replay 读取测试（1.5h）；保存命令/退出码，确认前述纯派生、store、IPC 场景实际执行，失败或跳过不算通过。
  - 命令与退出码（原始日志/JSON 报告落 `.workbuddy/u2-61/`，gitignored）：① 构建 `pnpm check:build`（= `--filter "./packages/*" build`）⇒ **EXIT=0**，5/5 包 `tsc` 完成、5 份 `dist/index.{js,d.ts}` 时间戳全部刷新（**build 必须先于 test**，否则跨包消费者静默跳过用例）；② 类型检查 `pnpm check:typecheck`（desktop `tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit`）⇒ **EXIT=0**，日志 259 字节、零诊断；③ desktop 全量 `cd apps/desktop && vitest.CMD run --testTimeout=30000 --reporter=default --reporter=json` ⇒ **EXIT=0**，`Test Files 66 passed (66)` / `Tests 1295 passed (1295)`、**无 `Errors` 行**、逐文件汇总 `skipped=0 / todo=0 / failed=0`；④ replay 读取链 `cd packages/replay && vitest.CMD run --testTimeout=30000 --pool=forks --poolOptions.forks.singleFork=true` ⇒ **EXIT=1**，`Test Files 2 failed | 26 passed (28)` / `Tests 12 failed | 380 passed (392)`、`skipped=0`。
  - ⚠️ **desktop 首轮判为不可信并已重跑**（`03-desktop.json` 不计入结论）：命中既有 `%TEMP%\<rand>\ssr\<hash>` `EPERM` 间歇故障 ⇒ 只跑 64/66 文件、1200 用例并报 `2 errors`（恰好缺 `store.test.ts` 57 + `u2-file-fixtures.test.ts` 38 = 95 条）。按"**文件数 + 用例数 + Errors 三元组任一不符即重跑**"复跑后 66/1295/0 全符。
  - **纯派生 / store / IPC 场景逐文件确认真跑**（JSON 报告逐文件计数，全部 0 failed / 0 skipped）：纯派生 `file-reading-state` 8、`file-checkpoint-resolve` 24、`file-reading-target` 12、`file-directory-filter` 21、`file-layout` 16、`file-tools` 12、`reading-request-guard` 16、`reading-resolve` 12、`reading-state` 16、`workspace-files` 30；store `file-view-session-state` 8、`store` 57；IPC/组件 `workspace-view` 20（**直接驱动真 `workspaces:inspect`/`workspaces:readFile` 处理器**：非法 runId ⇒ `WORKSPACE_INVALID_REQUEST` 不抛错、清单外路径/物理 blob 路径 ⇒ `not_found`、祖先 step ⇒ `step_not_found`、附件删除/篡改 ⇒ `missing`/`corrupt`、完整浏览后数据目录全树指纹**逐字节不变**）、`file-two-side-read` 62、`file-single-side-view` 18、`workspace-file-view` 26、`file-scroll` 10、`file-view-scroll-wiring` 16、`reading-scroll-restore` 33；标本 `u2-file-fixtures` 38。**读取链合计 455 条，全绿零跳过。**
  - replay 侧读取链**全绿零跳过**：`workspace-file-tools` 72、`workspace-profile-guard` 28、`workspace-isolated-preflight` 19、`workspace-world` 17、`workspace-read-api` 15、`workspace-checkpoint-tracer` 14、`workspace-isolated-run` 13、`workspace-quota` 12、`workspace-blob-store`(+injection) 13、`derive` 9、`isolated-entry-guard` 8、`workspace-isolated-integration` 6、`workspace-isolated-replay` 5、`workspace-package-recovery` 4、`workspace-trace-failure` 4、`package-api-fixture` 3。
  - **12 条失败已逐条归因，全部为沙箱既有环境故障、非本 change 回归**（且整段 U2 从未改动 `packages/`：`git log --name-only 4628b80..HEAD -- packages/` 输出为空）：**9 × `model-ab-cli`**（CLI dist 冒烟须 spawn 子进程，沙箱一律 `EBUSY`/`status===null`；产物本身 `node dist/model-ab-cli.js --help` 可直验）；**3 × `workspace-import-source`** 的 symlink 形态用例——沙箱**伪造 symlink**（`symlinkSync` 不抛错、`existsSync` 为真，但条目不是真链接），该文件的能力探针只回查 `existsSync` ⇒ 被误导成"可用"，用例由 expected `skipped` 变成本轮真跑并失败（junction 那几条不需特权、恒真跑且全绿）。与 09-23 基线"replay 12 条沙箱环境失败属预期"逐条同源。
  - 未通过项：无。desktop 0 失败 0 跳过；replay 12 条已全部归因到沙箱环境并给出复验路径，**不计作"跳过"或"通过"**（属既有环境缺口，非本段引入）。
- [x] 6.2 执行仓库 lint、OpenSpec 全量严格校验及 desktop build（1h）；支持“文件阅读键盘操作与离线加载”等离线构建回归，记录结果；不安排发行打包。
  - 命令与退出码（日志/JSON 落 `.workbuddy/u2-61/`，gitignored）：① 仓库 lint `pnpm check:lint`（`biome check .`）⇒ **EXIT=0**，`Checked 326 files` / `No fixes applied`；U2 改动面另单独复跑（46 个代码文件）⇒ **EXIT=0**。注：`biome.json` 的 `files.ignore` 已含 `docs/**`（U1 7.6 起）⇒ 早前"docs 下未跟踪 JSON 的 CRLF 46 个假错误"不再出现，**全仓口径即权威口径**。② OpenSpec 全量严格校验 `openspec validate --all --strict`（直调 `bin/openspec.js`）⇒ **EXIT=0**，`Totals: 13 passed, 0 failed (13 items)` = 12 份主 spec + 1 个活动 change；19 条 INFO 全为「requirement > 500 字符」并列约束提示，**0 条 WARNING/ERROR**。③ desktop build `cd apps/desktop && ./node_modules/.bin/electron-vite.CMD build`（**直调、不绕根 `pnpm --filter`**，后者拉 `wmic.exe` 被沙箱硬拦）⇒ **EXIT=0**，`✓ built in 19.0s`；产物齐 `dist/main/index.cjs` 69,014 B / `dist/preload/index.cjs` 2,541 B / `dist/renderer/index.html` 401 B。**未做发行打包**（未跑 electron-builder、无 exe、不动 `release/`）。
  - **离线/懒加载构建回归**（对**刚构建出的产物**跑 `release-check.mjs` 的资源审计，不是合成目录）：· `auditWorkerAssets(dist/renderer/assets)` ⇒ `ok:true` / `missing:[]` / `forbidden:[]`（`editor.worker`+`json.worker` 齐备、无 `ts/css/html.worker`）；`rendererJsBytes 11,487,648` / `workerBytes 1,469,235`。· 入口 chunk 懒加载契约（U1 5.6 口径）：`index.html` 引用的入口 `index-BVAF5aNj.js`（1,066,353 B）中 `monaco-editor` / `@monaco-editor/react` / `echarts` 出现次数**均为 0** ⇒ 纯浏览路径不加载编辑器资源。
  - ⚠️ **本轮暴露并修复 1 处真实缺陷（U2 引入、会阻塞打包门禁）**（修复提交 `ecd54da`）：`auditRendererSource(src/renderer)` 报 1 条违规——`WorkspaceFileView.tsx:3` 的 `import type { editor as MonacoEditorNs } from "monaco-editor"` 从**包根**导入。`release-verify.mjs` 默认就扫**真实** `src/renderer`，且 `ok` 要求 `sourceViolations.length === 0` ⇒ **`release:verify` 必失败**（K1/K2/K3 打包会被卡）；此前无人发现是因为既有用例**只对合成 tmp 目录**跑 `auditRendererSource`。归因：`git blame` → U2 `181e11a`。修复：改用仓库既有约定的显式 ESM 子路径 `monaco-editor/editor/editor.api`（`monaco-bootstrap.ts` L18-19 已写明 0.56 的 `exports["./*"] → ./esm/vs/*.js` 映射）——**改代码而非放宽门禁**。
  - **补载重守卫 + 变异验证**：`release-check.test.ts` 新增「真实仓库 src/renderer 零违规（不只测合成目录）」。变异（把第 3 行回退成包根导入）⇒ **恰好 1 条变红**（正是该新守卫）、其余 24 条仍绿 ⇒ 判据有牙且不过宽；从**本轮基线**还原后 `md5sum -c` 通过。
  - **修复后复跑全部受影响门禁**：`check:typecheck` **EXIT=0**；重新 `electron-vite build` **EXIT=0**（入口 chunk 文件名与体积不变 `index-BVAF5aNj.js` 1,066,353 B ⇒ 类型导入改动**零产物影响**）；审计三项全绿（源码违规 0 / workers `ok:true` / 入口 0 引用）；desktop 全量 **66 文件 / 1296 用例 / 0 失败 / 0 跳过 / 无 `Errors` 行**（= 6.1 的 1295 + 1 条新守卫）；两个改动文件 biome 净。
  - 未通过项：无。
- [x] 6.3 建立逐场景 evidence-index 并核对 C 九个旧场景与所有新增场景（1h）；链接 fixture/测试/实机截图及宽度/只读证据，按 D7 分别链接 U1 详情竞态回归与 U2 两条文件竞态场景的具体断言，不能以详情测试代替文件验收；列出未验证项，确认 U1 完成未归档、U2 验收状态与 U3–U8 边界如实表述，不自动归档。
  - 产出：**`evidence-index.md`**（本 change 目录内，24,335 字符）。范围 = 本 change 唯一 delta 的 **6 requirements / 35 scenarios**（1 MODIFIED / 9 既有 + 5 ADDED / 26 新增），逐 requirement 列表标 `M`/`A`，附汇总表（**已覆盖 35 / 未验证 0**）。**不自动归档、不发版**。
  - **MODIFIED 既有场景零丢失（差集核对，不是眼看）**：脚本 `.workbuddy/u2-61/scenario-diff.cjs` 输出——「文件检查点和差异只读可查」主 spec 9 → delta 9、**丢失 0 / 新增 0**；5 个 ADDED requirement 与主 spec **无同名**（无 MODIFIED/ADDED 冲突）；delta 合计 35 场景 / 6 requirements，与 `review.md` 的"C 保留 9 + 新增 26"逐项吻合。唯一正文改动是审阅 P1-a 采纳的措辞（"提交和导航控件"→"检查点与导航控件"，**场景名未动**）。另配自检 `verify-index-coverage.cjs`：**索引逐条命中全部 35 个场景、缺失 0**。
  - **D7 三条竞态分别举证（互不替代）**单列一节：U1「快速切换及同运行重试不串响应」= `detail-request.test.ts` 6 条（对象 `getRun`）+ CDP `u1-73` `rapid-switch`；U2「快速切换不串清单正文错误和加载」= `reading-request-guard.test.ts` 延迟时序 **3 条** + `file-two-side-read.test.ts` 接线契约 + CDP 5.4 `race-retry` 12/12 之①③④；U2「同对象重试与往返有请求代次」= 同文件「同对象重试 / A→B→A 往返 / 旧代次成功与失败均被拒」+ CDP 5.4 `race-retry` 之②。并写明**为何不能互相替代**（U1 打的是 `store` 的详情请求守卫，U2 打的是 `WorkspaceFileView` 的三个独立守卫；U2 的根因恰是"`cancelled` 布尔挡不住同对象重试与往返"）。
  - **§布局证据**（D7 逐层记录）单列：8 行 × 原生外框/CSS 视口/容器宽/目录宽/Monaco 两侧文字区/模式/zoomFactor/DPR/短句可读/截图，数据源为**真实 Electron CDP**（禁用 `Emulation.setDeviceMetricsOverride`），并注明 1360/1440 容器宽 < 视口宽系 wide 断点导航常驻（U1 既定行为、非缺陷）与 1024 档并排→inline 临界的缺陷 1 暴露面。
  - **实机证据全部可定位**：CDP 脚本 `u2-51…u2-56-cdp.cjs`；截图与结果矩阵入库 `docs/reviews/2026-09-23-u2-51|52|53|54/`、`2026-09-24-u2-55|56/`；原始 `measurements.json` 落 `.workbuddy/u2-5*/`。各档 checks：5.1 **75/75**、5.2 **54/54**、5.3 **36/36**、5.4 **44/44**、5.5 **40/40**、5.6 **34/34**。
  - **本轮核对另修 2 处文档矛盾（如实表述"如实标"的落地）**：5.1 §2 已实测推翻「1440/1360 本机物理不可达」（外框可超屏、加 `SW_RESTORE` 后六档全部可达），但 `docs/reviews/2026-09-23-u2-52/README.md` 与本文档 5.2 条仍写着"物理不可达 / 上限 1207"。**两处已就地加更正说明**（未静默改写，保留原观察 + 注明以 5.1 更晚结论为准）。
  - **未验证项已逐条列出**（索引 §已知限制）：① 「文件页签往返恢复阅读」的**列表滚动**子项实机证据力弱（夹具清单仅可滚 2px）⇒ 由接线契约 + 变异 M4 立证，未另造长清单夹具实机复测；② **1.1 生成器留下的坏标本未修**（`gen-u2-file-fixtures.cjs` 的 `u2bad_noownsteps` 把 `fork.at_span` 与 `resume_after_step` 设为同一 `agent.step` ⇒ 经运行列表读取必被拒；5.5/5.6 已按正确形态另建标本并显式调用 `resolveBranch` 自检）——仅影响 gitignored 夹具可复用性，不影响产品与该场景覆盖（由 5.5 正确标本 + CDP 承载）；③ 系统级原生 DPI（非应用内 zoomFactor）未独立实测；④ **发行打包三项门禁（产物名/体积/身份）未在本 change 执行**（6.2 明写不安排），但资源门禁已先行覆盖。
  - **边界如实表述**：① **U1 已完成且已归档**（`archive/2026-09-23-refactor-run-workspace/`，`4628b80`）⇒ 任务 6.3 原文"确认 U1 完成未归档"**与现状不符**，本任务与 tasks 头部已同步更正；由此产生一个必知后果——**U2 归档前主 spec 的该 requirement 仍是 C 版正文**（"提交"措辞），归档那刻才被 MODIFIED 块整体替换，故**判现状只认 `src/` + 本 delta**。② **U2 验收状态**：1.1–6.3 全部完成，质量门禁全绿，但**本索引不构成放行**，归档由 owner 拍板。③ **U3–U8 边界**逐条列表（含 `<960px` 运行列表不可达属 U1 范围、跨运行文件 diff 属 D5 禁止项等），本 change **不宣称**任何 U3–U8 能力通过。
