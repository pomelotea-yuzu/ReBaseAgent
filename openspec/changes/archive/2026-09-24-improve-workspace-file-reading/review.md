# U2 improve-workspace-file-reading 审阅

> 日期：2026-09-23
> 审阅对象：proposal.md / design.md / tasks.md / specs/desktop-ui/spec.md（提案完成、实现未开始状态）
> 结论：整体质量高，可进入实施。未发现阻塞性问题；1 个低优先级措辞问题（P1）建议归档前决策，其余为备注。

## 一、核对项

### 1. OpenSpec 校验

`npx openspec validate improve-workspace-file-reading --strict` 通过（输出 `Change 'improve-workspace-file-reading' is valid`；命令退出码 1 源自沙箱拦截 npm 写日志，非校验失败）。`openspec list` 显示 0/26 tasks，与"仅编写 change"的自述一致。

### 2. delta 结构与合并安全

- MODIFIED requirement「文件检查点和差异只读可查」携带完整最终文本：正文由"详情 SHALL 提供文件视图"升级为"工作区 SHALL"（呼应 U1 术语），补入"在空间足够时支持并排，在空间不足时采用 inline"与"零字节"区分；主 spec 九个既有场景（重启后查看文件差异 / 文件读取 IPC 拒绝越权 / 长文本及窄窗口 / 文件浏览过程无写入 / 初始与各轮文件快照可选择 / 文件选择器轮号不沿链累加 / 二进制和不可用附件分别显示 / 失败运行已记录文件可查看 / 数据目录迁移后文件仍可查）逐字保留，与主 spec 560-602 行比对一致。
- U1 delta 未修改该 requirement，U1/U2 两个 delta 无同 requirement 冲突；"U1 先归档、U2 再归档"的顺序约束自洽。
- 五条 ADDED requirement 均为文件专属新义务（会话恢复 / 搜索筛选 / 容器宽度适配 / 阅读工具 / 双侧读取一致性），未复制 U1 未归档 delta 的内容；与 U1 ADDED「会话内按运行恢复阅读位置」「工作区在窄窗口和键盘操作下可读」的边界（外层 shell vs 文件内部）两侧均有声明。

### 3. 事实性声明抽查（均属实）

对 [WorkspaceFileView.tsx](../../../apps/desktop/src/renderer/src/components/WorkspaceFileView.tsx) 逐条核实 proposal 的源码论断：

- 组件局部 selection/path/pane 状态，挂载默认初始、run 变化复位（63-73、85-92 行）——"检查点和路径随组件卸载重置"属实。
- `lg:w-72` 固定目录（352 行）与固定并排 diff（`renderSideBySide: true`、`height="420px"`，593-598 行）——"固定文件目录与并排 diff"属实，且 420px 固定高度正是 design D4 要消除的。
- `readSide` 将失败信封折成 null（133 行：`return outcome.ok ? outcome.data : null`），经 [workspace-files.ts](../../../apps/desktop/src/renderer/src/lib/workspace-files.ts) 的 `resolveDiffSides`（177-191 行）后，初始侧的 **IPC 失败 / binary / missing / corrupt 一律呈现为"该侧不存在"**，并附"初始快照里没有这条路径（本 run 新增的文件）"的误导性文案——"初始侧非文本又可被呈现为不存在"属实，且比 proposal 措辞更严重（不止"可被呈现"，是必然呈现）。
- 初始侧读取以当前侧成功为前提（FileContent 479-488 行：`if (current === null || current.status === "rejected") return;`）——D5"不能以当前侧成功为读取初始侧的条件"针对的缺陷属实。
- `loadContent` 无请求键/代次守卫（138-160 行）：迟到的旧请求 finally 会清除新请求的 loading，旧错误可覆盖新状态——D5 的竞态改造前提属实。
- [WorkspaceFilesPanel.tsx](../../../apps/desktop/src/renderer/src/components/WorkspaceFilesPanel.tsx) 以 `key={detail.meta.id}` 硬重挂载（52 行），design Context"保持卸载策略即可，恢复不能依赖组件常驻"与现状吻合。
- [reading-state.ts](../../../apps/desktop/src/renderer/src/lib/reading-state.ts) 的 `RunReadingState` 尚无 `files` 子结构、[reading-resolve.ts](../../../apps/desktop/src/renderer/src/lib/reading-resolve.ts) 的 `ReadingTarget` 尚无文件目标——D1/D2 的扩展点描述准确。
- `lucide-react@^1.47.0`、`monaco-editor@^0.56.0` 已在 desktop package.json；`MonacoEditor.tsx` / `MonacoEditors.tsx` 均存在——Impact 的复用声明属实，"不新增依赖"可行。
- U1 evidence-index 的 R1/U2、R7/U2 过渡条目与本 proposal 的问题定位互为印证，无越界宣称。

### 4. 任务与场景覆盖

delta 共 35 个场景（C 保留 9 + 新增 26）。逐条核对 tasks.md 1.1–6.3 的引号场景名：35 个场景全部至少被一个任务引用，其中"文件页签往返恢复阅读""不可用侧不伪装为空差异"等核心场景在纯逻辑（2.x/3.x）、组件（4.x）、实机（5.x）三层均有落点。全部任务预算 ≤2h，符合仓库门禁约定。D7 的视口矩阵（1440/1360/1210/1024/800/640 + zoomFactor=2）与任务 5.1/5.2 的分组一一对应。

## 二、问题与建议

### P1（低）：保留场景"长文本及窄窗口"的"提交"控件措辞过时

C 原场景 THEN 写"文本不覆盖**提交**和导航控件"——"提交"是 C 时代文件视图挂在调试台/详情面板语境下的控件；U1 之后文件页在主工作区，附近并无提交控件。按"原样保留"策略合并无可厚非，但该句会随 MODIFIED 进入主 spec，形成一条无法字面验收的断言。两个选项：

- a) U2 归档前顺手修订该场景措辞（MODIFIED requirement 本就有权改场景，把"提交和导航控件"改为"检查点与导航控件"，与 ADDED requirement 3 的"检查点与返回目录可达"口径统一）；
- b) 维持原样，在 6.3 evidence-index 中记录为已知措辞漂移。

**推荐 a**：一行措辞修订即可消除死断言，且不改变场景语义。

### P2（低）：ReadingTarget 扩展的字段命名易混淆

现有 `ReadingTarget` 用 `spanId`（指调用 span），D2 新增文件目标用 `stepSpanId`（指 agent.step span）。同一接口两个近似字段名，实现时易混。建议落码时用判别联合（如 `{ kind: "call", spanId } | { kind: "file", stepSpanId, path }`）或在类型注释中显式区分，避免后续 U3+ 再扩展时踩坑。

### P3（微）：两条相邻的"快速切换"场景需在 evidence-index 分别举证

U1 ADDED「会话内按运行恢复阅读位置」已有场景"快速切换及同运行重试不串响应"，U2 ADDED 又引入"快速切换不串清单正文错误和加载"与"同对象重试与往返有请求代次"。三条并存不冲突（作用域分别为详情请求 / 清单+双侧文件请求），但 6.3 建议为每条单独链接证据，避免验收时用一份竞态测试覆盖三条。

### P4（微）：D4 阈值组合在 800px 视口的可行性尚无实测背书

并排 320px×2 + 目录常驻 480px inline 在 800×600 视口下彼此紧张（目录常驻需 inline 文字区 ≥480px，并排需两侧各 ≥320px，两者在 800px 内不能同时满足，逻辑上会走"收起目录 + inline ≥480px"路径）。design 末段已自我声明"待原型和桌面实测、若无法满足先修设计"，任务 1.2 也已安排原型量测——自知且有序，仅提示 1.2 若发现 800px 无法达到 480px inline，须按 D4 约定回改四件套而非放宽验收。

> **✅ 已结案（2026-09-23，1.2 实测后）**：真 Monaco 0.56 实测确认 **800px 下 inline 文字区仅 273px**（远不足以达 480），且「≥480」的**临界视口 = 960px**（960→720 无一档达标）。用户拍板**候选 A**：修订 spec delta + design D4，把 480px 下限**限定到 ≥960 CSS px 视口**，800px 及以下定义为**窄档**（目录一律收起、diff 强制 inline、正文按可得主区自适应，不声称 480）。**实现侧 480 常数未动**（仅收窄语境），符合本 P4 "回改四件套而非放宽验收"的要求——是承认几何现实，不是降标准。

## 三、结论

四件套内部一致性、与 U1/主 spec 的合并安全、源码论断的真实性、任务-场景覆盖均通过核对。P1 建议在实施开始前决策（一行措辞修订），P2–P4 为实施期注意事项，不阻塞进入任务 1.1/1.2。

## 四、意见处理（2026-09-23）

以下为本次审阅后的文档修订；前文保留审阅时的事实和建议，不代表功能已实施。

- P1：采纳 a。窄窗口场景改为“文本不覆盖检查点与导航控件”，九个旧场景的名称与行为仍保留；proposal/tasks 同步说明这一处措辞变化，不再声称全部逐字保留。
- P2：D2 明确嵌套 `file: { stepSpanId, path? }` 分支，以 `tab: "files"` 限定并在类型上禁止混传调用定位字段；普通 `{ tab: "files" }` 仍只恢复历史。任务 2.3 增加相应验证，无需全面重构既有导航协议。
- P3：D7 与任务 6.3 要求 U1 详情竞态、U2 跨对象文件竞态、U2 同对象请求代次分别链接具体证据；可共用文件，不能替代断言。
- P4：保留原型实测要求，任务 1.2 明列 800px 两次布局决策。补充澄清：目录常驻与并排不必同时满足，800px 也可能支持目录加 inline，或收起目录后支持并排，结果取决于实际文字区。D4 和对应 spec 统一为只有目录影响 inline 最小宽度时才必须收起；阈值未降低，实际可行性仍待实施期测量。
