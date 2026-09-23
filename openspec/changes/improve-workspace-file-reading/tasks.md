# U2 实施任务

当前第 1、2、3 组已完成；**第 4 组已完成（4.1–4.6 全部勾选；4.1/4.5/4.6 经 2026-09-23 复核发现未真正落地后已补齐）**；第 5、6 组待办。依赖 U1 已完成但未归档的源码和 delta，不以旧主 spec 代替现状；本次不归档 U1。每项预算不超过 2h，超出先拆分。场景名均引用 [desktop-ui delta](specs/desktop-ui/spec.md)，其中 C 原有九个场景与行为保留，仅将窄窗口场景的“提交和导航控件”校准为“检查点与导航控件”。

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
  - 环境真值（CDP 证实）：物理屏 2560×1600 @ 210% 缩放 ⇒ CSS 桌面 1220×762、DPR 基线 2.1（5.1 所记「1707×1067 @141%」为 DPI 虚拟化假象，已更正）；可达 CSS 视口上限 1207；zoom2 档 DPR 4.2、CSS 视口精确减半 605。1440/1360 档本机物理不可达（与 5.1 结论一致）。
  - 实机暴露并修复 **2 处真实产品缺陷**：③ 窄档 ≤800px 目录未强制收起（`decideDirResident` 缺门，1.2 候选 A 只收窄 spec 未改实现）⇒ `file-layout.ts` 加 `NARROW_TIER_MAX=800` 窄档门 + 2 临界回归单测（16 用例）；④ 宽档目录常驻时无任何收起入口（按钮只在 `!dirResident` 分支渲染）⇒ `WorkspaceFileView` 页头加「收起目录」按钮，宽档 `dirUserCollapsed` WHEN 可达。
  - harness 断言修正（非产品缺陷）：Esc 返回编辑器的表达式漏判新版 Monaco `native-edit-context`，探针证实焦点确回编辑器 ⇒ 修正并纳入断言。
  - 偏好保持三段（prefs→prefs-narrow→prefs-restore）须同页面会话按序执行（zustand 内存态，dev 重启即失）；zoom 持久化陷阱（`Preferences` 的 `per_host_zoom_levels`）与类名过滤改窗方案已记录在证据 README「陷阱记录」。
- [ ] 5.3 实测文件/步骤/运行/分支/设置往返、长正文滚动及显式定位（1.5h）；验证“文件页签往返恢复阅读”“跨运行和辅助视图返回恢复文件”“显式文件定位覆盖历史”“失效检查点和路径安全回退”，含同名跨 run、无效 path 和搜索隐藏选择。
- [ ] 5.4 实测双侧异常、延迟切换/重试及工具命令（1.5h）；验证“不可用侧不伪装为空差异”“快速切换不串清单正文错误和加载”“同对象重试与往返有请求代次”“复制路径原文及元信息”“查找换行和差异定位使用当前文件”，不以静态结构测试代替点击和内容核对。
- [ ] 5.5 回归原 IPC 安全、未录制/失败记录和只读不变性（1.5h）；验证“文件读取 IPC 拒绝越权”“二进制和不可用附件分别显示”“失败运行已记录文件可查看”“文件浏览过程无写入”“阅读重试只读且重新校验”；源/父/兄弟/既有 trace/附件逐文件前后 SHA-256 一致，模型及工具零调用。
- [ ] 5.6 在受控数据副本上重启、整体迁移、仅迁 JSONL 并断网读取（1.5h）；验证“重启后查看文件差异”“数据目录迁移后文件仍可查”“文件阅读状态不跨进程承诺”“文件阅读键盘操作与离线加载”；普通 run 无伪文件页，现有概览/步骤/编辑/执行入口仍可达。

## 6. 质量检查与证据

- [ ] 6.1 执行依赖包构建、类型检查、desktop 全量与相关 replay 读取测试（1.5h）；保存命令/退出码，确认前述纯派生、store、IPC 场景实际执行，失败或跳过不算通过。
- [ ] 6.2 执行仓库 lint、OpenSpec 全量严格校验及 desktop build（1h）；支持“文件阅读键盘操作与离线加载”等离线构建回归，记录结果；不安排发行打包。
- [ ] 6.3 建立逐场景 evidence-index 并核对 C 九个旧场景与所有新增场景（1h）；链接 fixture/测试/实机截图及宽度/只读证据，按 D7 分别链接 U1 详情竞态回归与 U2 两条文件竞态场景的具体断言，不能以详情测试代替文件验收；列出未验证项，确认 U1 完成未归档、U2 验收状态与 U3–U8 边界如实表述，不自动归档。
