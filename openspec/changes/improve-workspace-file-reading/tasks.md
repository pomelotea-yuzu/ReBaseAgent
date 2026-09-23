# U2 实施任务

当前仅完成 change 编写，以下实现与验收全部待办。依赖 U1 已完成但未归档的源码和 delta，不以旧主 spec 代替现状；本次不归档 U1。每项预算不超过 2h，超出先拆分。场景名均引用 [desktop-ui delta](specs/desktop-ui/spec.md)，其中 C 原有九个场景与行为保留，仅将窄窗口场景的“提交和导航控件”校准为“检查点与导航控件”。

## 进度记录

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

## 1. 基线、标本与原型

- [ ] 1.1 核对 C/U1 fixture 并准备专用阅读测试副本（1.5h）；覆盖“初始与各轮文件快照可选择”“文件选择器轮号不沿链累加”“失败运行已记录文件可查看”“新增文件与零字节文件不混同”“两侧都不可读时没有伪空编辑器”，记录普通/隔离根/子/二次分叉关系、长文本和异常状态，不改既有附件。
- [ ] 1.2 核对已安装 Monaco 的公开命令、布局和定位 API，制作窄/宽文件原型并量测 D4 阈值（1.5h）；对应“文件正文在代表视口可读”“同视口下响应容器变化”“极窄与放大后仍可阅读”，记录短句/长路径和文字区，单独记录 800px 下目录常驻与 diff 模式两次决策，示例原型不算真实桌面验收；不可达时先修订四件套，不通过降低正文要求达标。

## 2. 会话状态、选择和导航

- [ ] 2.1 为 reading-state/store 增加文件状态、稳定默认值和按 run/step/path 的纯 patch（1.5h）；测试“文件页签往返恢复阅读”“跨运行和辅助视图返回恢复文件”“文件阅读状态不跨进程承诺”，只存阅读信息、不存正文/授权。
- [ ] 2.2 实现默认检查点和引用重校验纯逻辑（1.5h）；验证“首次文件页选择最近自有完成步骤”“无自有完成步骤时选择初始”“失效检查点和路径安全回退”“文件选择器轮号不沿链累加”，失败运行保留已有步骤。
- [ ] 2.3 扩展 ReadingTarget 的嵌套 file 分支并连接自有步骤文件入口、普通页签返回与一次性目标消费（1.5h）；验证“显式文件定位覆盖历史”“跨运行和辅助视图返回恢复文件”，含相同目标再次定位、祖先门禁、调用字段与文件字段不可混传、无 file 时普通返回及迟到导航不抢页。
- [ ] 2.4 将 WorkspaceFileView 的选择/pane/偏好接入会话状态，取消挂载重置（1.5h）；验证“文件页签往返恢复阅读”“切检查点保留仍存在的路径”“失效检查点和路径安全回退”，保留运行 key 隔离和文件能力失效回退。

## 3. 双侧读取和目录

- [x] 3.1 为清单与两侧读取增加身份/代次守卫及完整错误状态（2h）；用延迟 promise 验证“快速切换不串清单正文错误和加载”“同对象重试与往返有请求代次”，分别覆盖成功/失败/异常/finally 和卸载。
- [x] 3.2 实现独立两侧读取与比较资格派生，去除 null 等同不存在（1.5h）；验证“新增文件与零字节文件不混同”“不可用侧不伪装为空差异”“两侧都不可读时没有伪空编辑器”，左右互换与初始同侧均有用例。
- [x] 3.3 展示单侧可读、双侧异常及清单/内容独立重试（1.5h）；验证“二进制和不可用附件分别显示”“不可用侧不伪装为空差异”“阅读重试只读且重新校验”，读取失败保留定位、不假报无变化。
- [ ] 3.4 增加路径搜索、auto/all/changed 偏好与空态派生（1.5h）；验证“路径搜索与变化筛选组合”“初始与完成检查点的默认筛选”“空清单无变化和无匹配可区分”，可用性与变化分离。
- [ ] 3.5 连接目录控件、完整路径显示和隐藏选择恢复（1h）；验证“筛选不偷换当前文件”“切检查点保留仍存在的路径”，单独标示筛选计数，保留原清单规模。

## 4. 容器布局、编辑器与阅读工具

- [ ] 4.1 实现文件容器测量、可调整/折叠目录和列表/内容切换（1.5h）；验证“同视口下响应容器变化”“手动布局偏好不被自动折叠覆盖”，尺寸变化不重复写 store 或覆盖用户意图。
- [ ] 4.2 实现文字区阈值、auto/inline/并排与弹性编辑器高度（1.5h）；验证“文件正文在代表视口可读”“极窄与放大后仍可阅读”“长文本及窄窗口”，消除固定 lg 目录和 420px 高度依赖。
- [ ] 4.3 保存/恢复列表、内容容器及 Monaco 两侧定位，处理卸载和布局变化（1.5h）；验证“文件页签往返恢复阅读”“跨运行和辅助视图返回恢复文件”“手动布局偏好不被自动折叠覆盖”，检查延迟挂载后恢复及位置夹取。
- [ ] 4.4 增加路径、两侧原文和元信息复制及剪贴板失败反馈（1h）；验证“复制路径原文及元信息”“不可比较或未就绪时工具诚实禁用”，复制全文而非显示截断。
- [ ] 4.5 接入查找、换行、真实差异导航及模式控件（1.5h）；验证“查找换行和差异定位使用当前文件”“不可比较或未就绪时工具诚实禁用”，不对旧 Monaco 模型发命令，不开放替换写入。
- [ ] 4.6 完成键盘、tooltip、焦点恢复、工具栏换行和持续错误反馈（1h）；验证“文件阅读键盘操作与离线加载”“极窄与放大后仍可阅读”，保持 U1 本地懒加载与现有其他编辑入口。

## 5. 实机验收与只读回归

- [ ] 5.1 在真实 Electron 记录 1440/1360/1210px 宽窗口矩阵（1.5h）；验证“文件正文在代表视口可读”“长文本及窄窗口”“同视口下响应容器变化”，按 design D7 记录各层尺寸、Monaco 文字区及截图，不复用改造前走查作为结果。
- [ ] 5.2 实测 1024×768、800×600、640px 宽及独立 zoomFactor=2（1.5h）；验证“极窄与放大后仍可阅读”“手动布局偏好不被自动折叠覆盖”“文件阅读键盘操作与离线加载”，记录实际 CSS viewport/DPR，测短句可读性及工具栏焦点。
- [ ] 5.3 实测文件/步骤/运行/分支/设置往返、长正文滚动及显式定位（1.5h）；验证“文件页签往返恢复阅读”“跨运行和辅助视图返回恢复文件”“显式文件定位覆盖历史”“失效检查点和路径安全回退”，含同名跨 run、无效 path 和搜索隐藏选择。
- [ ] 5.4 实测双侧异常、延迟切换/重试及工具命令（1.5h）；验证“不可用侧不伪装为空差异”“快速切换不串清单正文错误和加载”“同对象重试与往返有请求代次”“复制路径原文及元信息”“查找换行和差异定位使用当前文件”，不以静态结构测试代替点击和内容核对。
- [ ] 5.5 回归原 IPC 安全、未录制/失败记录和只读不变性（1.5h）；验证“文件读取 IPC 拒绝越权”“二进制和不可用附件分别显示”“失败运行已记录文件可查看”“文件浏览过程无写入”“阅读重试只读且重新校验”；源/父/兄弟/既有 trace/附件逐文件前后 SHA-256 一致，模型及工具零调用。
- [ ] 5.6 在受控数据副本上重启、整体迁移、仅迁 JSONL 并断网读取（1.5h）；验证“重启后查看文件差异”“数据目录迁移后文件仍可查”“文件阅读状态不跨进程承诺”“文件阅读键盘操作与离线加载”；普通 run 无伪文件页，现有概览/步骤/编辑/执行入口仍可达。

## 6. 质量检查与证据

- [ ] 6.1 执行依赖包构建、类型检查、desktop 全量与相关 replay 读取测试（1.5h）；保存命令/退出码，确认前述纯派生、store、IPC 场景实际执行，失败或跳过不算通过。
- [ ] 6.2 执行仓库 lint、OpenSpec 全量严格校验及 desktop build（1h）；支持“文件阅读键盘操作与离线加载”等离线构建回归，记录结果；不安排发行打包。
- [ ] 6.3 建立逐场景 evidence-index 并核对 C 九个旧场景与所有新增场景（1h）；链接 fixture/测试/实机截图及宽度/只读证据，按 D7 分别链接 U1 详情竞态回归与 U2 两条文件竞态场景的具体断言，不能以详情测试代替文件验收；列出未验证项，确认 U1 完成未归档、U2 验收状态与 U3–U8 边界如实表述，不自动归档。
