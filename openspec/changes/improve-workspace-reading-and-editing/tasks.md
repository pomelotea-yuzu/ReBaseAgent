# 实施任务

> 起草状态：全部待实施，每项控制在 2 小时内，超时拆分。括号引用 delta 场景。几何基线见 `docs/reviews/2026-10-06-ui-density-geometry-baseline.json`（原 output/ 截图未入库），不作为优化已通过证据。

## 1. 折叠控制与信息分层

- [x] 1.1 设计并实现统一可访问标题行/开关样式，接线列表与步骤目录，保持自动/手动偏好区别。（列表和步骤控制可发现且可恢复；键盘折叠显示当前状态）
  - 2026-10-09：新增共享 `Disclosure`/`DisclosureButton`（aria-expanded/aria-controls、min-h-[28px]、方向箭头、FOCUS_RING，单点产生）；RunList/SpanTree 页头改标题整行开关（写偏好仍走外壳 closeNav/toggleStepsCollapsed 唯一路径）；裸 `‹` 箭头退场（审计函数钉住）。
- [x] 1.2 文件目录开关就近呈现，长文本和说明使用同一交互语义并保存会话阅读状态。（目录与长文本折叠不丢位置；键盘折叠显示当前状态）
  - 2026-10-09：目录收起入口移入目录列标题行（sticky，与搜索同容器）；pane 切换条按钮补 aria-expanded/min-h；LongText summary 补方向箭头与 28px 命中区（`<details>` 原生展开语义保留）；会话阅读状态沿用 readingByRun 既有机制（未新增存储）。
- [x] 1.3 运行/文件页去重隔离说明，来源元信息与工程说明共用同一受控可访问 disclosure 组件；按原阅读目标键接线展开状态，不适用动作原因可查询。（隔离文件页不重复同一说明；技术元信息按需完整阅读）
  - 2026-10-09：`isolatedRunNotice` 拆为 compact/detail/tech 分层视图（isolatedRunNoticeView）；RunHeaderView 只留紧凑一行，完整边界+技术值进 DetailNotices 的「来源与技术详情」Disclosure；展开态存 `readingByRun[runId].noticesExpanded`（静态 UI 键）；DetailPanel 隔离父本「不适用」原因同机制可展开（IsolatedParentUnsupportedNotice）。
- [x] 1.4 比较修改证据可折叠，diff 身份紧凑常驻；缺证据/不完整原因仍可见。（修改证据收起释放输出空间；异常摘要始终可见）
  - 2026-10-09：EditEvidenceSection 收起态 = 「修改证据 · 字段/修改数 · 展开」摘要行；incomplete/unavailable/notApplicable 分型与逐跳异常原因行常驻不可收起；store 增加 compareEvidenceExpanded（默认收起、换 pair 复位，与 comparePrefixFolded 同口径）；diff 两侧身份栏沿用既有 ShortIdLabel（未动）。
- [x] 1.5 说明分层与共享详情状态保存做针对性回归，验证键盘/aria、完整阅读/复制、目标隔离、未丢原文及没有新写通道或授权旁路。（技术元信息按需完整阅读；异常摘要始终可见；目录与长文本折叠不丢位置）
  - 2026-10-09：新增 4 个测试文件 34 条（disclosure / notice-disclosure / compare-evidence-collapse / panel-collapse-headers）；aria 与结构静态断言 + 源码接线契约（auditForbiddenTokens 剥注释）；desktop 全量 194 文件/3037 用例绿；真实键盘焦点流转与命中区实测归 4.3。

## 2. 编辑/diff 空间

- [x] 2.1 文件页建立可用高度链，diff 占剩余空间并在内部滚动，去除与外层滚动冲突的固定 vh。（普通文件页正文获得可见高度；只读差异保持只读）
  - 2026-10-09：主 diff 分支自建高度链（`data-file-diff-chain` 锚点）：`h-full min-h-0 flex-col` + header/toolbar/身份行 shrink-0，diff 容器 `min-h-[200px] flex-1 overflow-hidden` 吃全部剩余高度，编辑器 `height="100%"` 内部滚动；根容器 `overflow-y-auto` 兜底（toolbar 换行挤压时 diff 保 200px 下限，不压缩到 0）；异常分支（状态卡/单侧视图）保留普通流。回归 `file-diff-height-chain.test.ts` 3 条；1210×713 实测 ≥357px 归 4.1。
- [x] 2.2 messages/prompt 编辑器按容器宽高适配原值/草稿，可收起原值并调整比例。（原值与草稿按容器适配；原值收起后仍可恢复核对）
  - 2026-10-09：新增共享布局层 `DraftCompareGrid`（`useContainerWidth` 实测容器宽；`(w-8)/2 ≥ 320` 才并排——判据 `lib/editor-space.ts`，不吃 xl 窗口断点；原值收起/「显示原值」恢复按钮常驻、aria-expanded 状态可判；pointer capture 拖拽 resizer 调比例、ArrowUp/Down/Home/End 键盘步进 ±24px）；编辑器高度 `clamp` 视口相对（原值 32vh / 草稿 44vh / 展开 64vh），固定 200px/140px 退场。回归 `draft-compare-grid.test.tsx` 8 条 + 既有 4 处接线断言更新。
- [x] 2.3 result/A/B 主要编辑器沿用相同空间策略，保持既有预检/实验计划语义。（原值与草稿按容器适配；长草稿切换不丢输入和目标）
  - 2026-10-09：prompt（emerald）/tool-result（violet）经 DetailPanel、messages（sky）经 MessagesForkEditor、model_ab 经 ModelAbEditor 全部换用 DraftCompareGrid；A/B 侧 `fixedHeight={false}` + `resizable={false}`（保持实验计划行的既有空间语义）、原值标签改「原值（父本基线臂 · 只读）」显式只读身份。预检/计划逻辑零改动（编辑器仅换布局容器）。
- [x] 2.4a 在现有 useLayoutState 加入目标绑定的临时 focus 模式，由原 prefs/阅读状态派生有效布局；不复制偏好/草稿，不写回专注折叠，保留来源/两侧身份和阻断提示。（专注模式保留身份并恢复布局；异常摘要始终可见）
  - 2026-10-09：`lib/layout.ts` 增 `WorkspaceFocus{mode,workspaceKey}` + `workspaceKeyOf`（trace 细化到 `tab:run:span`）/`focusActiveFor`（身份即时比对，不等 effect）/`decideFocusLayout`（生效时 nav/steps 按**显示层**收起，LayoutPrefs 原封不动）；App 装配 focusActive 并经 WorkspaceShell 下传两条承载；文件页「专注差异」/步骤页「专注编辑」入口 + 顶部专注栏（目标说明 + 退出按钮常驻）；DetailNotices（异常摘要）不随专注隐藏；不新增草稿/阅读存储。
- [x] 2.4b 接线目标变化/离开/卸载重置与主动调整先退出再写偏好；验证退出不回滚主动调整，缩放只改有效布局，返回不重入且不恢复许可。（专注切换目标与主动调整有明确归属；专注模式保留身份并恢复布局）
  - 2026-10-09：use-layout focus 为会话级 state；**8 个写偏好入口**（setNavWidth/setStepsWidth/toggleNavCollapsed/openNav/closeNav/toggleStepsCollapsed/handleNavKey/handleStepsKey）先 `setFocus(null)` 再写——调整成为新偏好、退出不回滚；App effect 目标变化即清空 focus（不止判定失效——返回同目标不自动重入）；仅窗口尺寸变化不动 workspaceKey ⇒ focus 保持。回归 `workspace-focus-mode.test.ts` 21 条。修复 2.4 改造误删的 WorkspaceFilesPanel DetailNotices 渲染（既有契约钉回）；overview-result 三分支断言放宽为分支起点匹配（挂载自此带 focus props）。
- [x] 2.5 接线 Monaco layout/view state 与可见恢复机制，补尺寸变化、非法 JSON、光标/滚动及无重复 observer 回归。（长草稿切换不丢输入和目标；只读差异保持只读）
  - 2026-10-09：MonacoDiffEditor 就绪态补锚点宿主 div + `useSizeRecovery`（**复用**可靠性 change 的尺寸恢复机制，`new ResizeObserver` 全文件唯一——无重复 observer）；新增 `lib/editor-view-state.ts` 会话级视图状态仓库（键 = `data-monaco-host|data-monaco-target` 既有寻址身份，值为 saveViewState 的 JSON 快照；非法 JSON/循环引用双向容错不抛）；卸载保存（effect cleanup）+ mount 恢复（调用方 onMount 先行、restore 最后落笔）；file diff 无 target 天然不参与——其滚动恢复仍由 U2 4.3 专属通道唯一权威承载。回归 `monaco-view-state.test.ts` 18 条；真实光标/滚动语义归 4.3 实机。

## 3. 操作与文案

- [x] 3.1 messages 与 prompt/result 核对/提交移到相邻操作区，保留费用/模式边界摘要与详情。（确认和提交在同一操作区；核对后的编辑撤销旧许可）
  - 2026-10-09：新建共享 `ConfirmationBlock`（标题行 = 标题 + `data-confirm-summary` 关键摘要 + 确认按钮 `data-confirm-execution`/`aria-pressed`；facts/checks/limits 全表收进 1.1 的 `Disclosure` 默认收起；`blocked` 原因就近行；children 槽）；六个执行入口（messages / prompt / result 普通 / result 隔离 / 模型 A-B / 创建）全部换用，`data-confirm-execution` 渲染点唯一、判据逐字保留由调用方传入；lib 六个 disclosure 各加 `summary`（收起态费用/工具/文件副作用与门禁摘要仍可见）；prompt 核对块原先嵌在按钮 flex 行里横排挤压，现独立成块、提交按钮行紧随其下。
- [x] 3.2 创建与实验确认/提交沿用相邻规则，窄窗/键盘可达，计划与副作用授权不简化。（确认和提交在同一操作区；详细边界可读但不能跳过核对）
  - 2026-10-09：创建入口确认块换 ConfirmationBlock（确认行为提醒保留在块内 children）；A-B 确认块换 ConfirmationBlock（confirmDisabled 判据逐字保留 `activePlan === null` 门——没有生效计划不给确认；blocked = submitBlocked ?? planStaleText）；实验计划块（逐臂 dry-run 事实 + 副作用警示）与副本授权复选框原样保留未简化；创建页操作区固定在正文下方的既有语义不变，确认与提交之间不隔长说明。
- [x] 3.3 ModalDialog 增强遮罩/居中/可用高度，保留 focus trap、Esc、关闭禁止与放弃 CAS。（放弃模态可辨且取消不丢草稿；长确认可滚动且操作可达；旧确认不能放弃新修订）
  - 2026-10-09：基类加 `max-h-[85vh] overflow-y-auto`（长确认在框内滚动、操作可达，不撑破视口）；遮罩 `backdrop:bg-black/20`→`/40`（放弃确认与对比确认弹窗的遮罩可辨）；showModal / cancel / Esc 两步关闭合成 / keydown 捕获 / closeDisabled / 焦点恢复全部不变。
- [x] 3.4 主流程替换空 fork/main 登记等实现术语，工程解释复用 1.3 的详情机制，修复字面 **，补时间旅行与隔离续跑对应说明。（没有改动提示用中文且技术细节可查；时间旅行名称不扩大恢复承诺）
  - 2026-10-09：lib 理由改用户语言——prompt/isolated 的 unchanged（"与原值相同，请修改后再…；未做修改的会被原样拒绝"）、A-B 逐臂（"与父 run 完全相同——与父完全相同的臂会让整批被拒"）；四处字面 `**` 已随 3.1 在 lib 移除；MessagesResults / ExperimentResults 去"main 登记"（标题与组头），空态改"尚未提交重发 / 尚未执行实验"，技术说明（登记身份、被动录制边界、预览不产生批次、同父同模型不合并）收进「结果说明」Disclosure；创建页 config_hash / v1/v2 改中文主文案 + 新增「技术说明」Disclosure 承载版本细节；DetailPanel「在此重跑」入口给普通路径补时间旅行说明（不撤回外部调用、不回滚同轮写入），unchanged 提示同步改写；DetailPanel 1382 的"空 fork"括注改用户语言。

## 4. 实机与完整验收

- [x] 4.1 真实 1210×713 复拍文件 diff、messages、比较/证据和放弃模态，记录正文高度与前后基线。（普通文件页正文获得可见高度；修改证据收起释放输出空间；确认和提交在同一操作区）
  - 2026-10-09：真实窗口 1211×714（外框 1708×1068 + CDP 回读校准，非 Emulation）。文件 diff：y 509→472.3、视口外截断 223px→0、可见正文 225px（普通/筛选档）；**未达 ≥约 357px 目标**（隔离 run 说明栈约 380px；专注差异档 198px 反低于普通档——收目录收益被 tab 行 +28px 抵消），是否继续压缩归用户决策。messages/prompt 编辑：编辑器 314px 全可见（基线确认按钮视口外 240px → 核对块 y=563 + 操作行 y=675 同屏相邻）。放弃模态：居中 400×281.8、maxH=85vh、焦点落「取消」。比较证据：单行折叠收起/展开（aria-expanded 受控）；textdiff y=91.8 h=460.1（基线 443）。读数汇总 `.workbuddy/u4x/summary-41.json`、截图 `shots/`（均本地）；evidence-index 6 行已回填。
- [x] 4.2 真实宽窄窗口与 200% 缩放检查输入/滚动/恢复、菜单和操作栏遮挡、手动偏好；宿主不可达项写明限制。（窄窗口和缩放不压缩字号；专注模式保留身份并恢复布局）
  - 2026-10-09：三档真实窗口 1023×714 / 800×714 / zoom2 605×356（应用内 setZoomFactor(2)，dpr 4.2；Windows 显示设置级 200% 不可达，已作限制记录）。**字号**：renderer 0 处响应式字号类（grep 静态证据）+ 三档同渲染树 CSS 字号不变。**内部滚动/恢复**：messages 编辑态滚动祖先 scrollIntoView 后草稿编辑器全可见（1024/800 档 visH 0→314.3）+ 放弃修改/取消 onScreen；zoom2 档极端挤压但滚动可达（fd 54.5px、msg 草稿 138.2px 可见）；zoom2 长草稿 1078 字符 setValue 写入 + 模态取消后逐字保留。**工具栏/焦点遮挡**：1024 起触发「文件列表/内容」tab 回退（3.x 形态），工具栏无换行溢出；草稿 popover 为用户触发可关闭浮层。**手动偏好**：800 收起 → 1211 保持收起（跨断点记忆）→ 展开恢复 ✓。**专注档**：tab 回退下专注收益≈0（目录已收进 tab），退出后布局恢复。**修复（用户拍板本轮补）**：compare textdiff 面板 `min-h-0 flex-1`→`min-h-[200px] flex-1`（对齐文件页 2.1 高度链），zoom2 实机复测编辑器 49.7→184px 过视口一半判据，测试补断言 26 用例绿 + typecheck 双 0 + biome 618 文件 0 错。**另一决策点（用户拍板保持现状）**：文件页正文 225px<357px 不再压缩——顶部说明栈属 spec 38 行要求保留的必要诊断，按异常豁免口径以实测现状登记。evidence-index 18/19/20/24/27/28 六行已回填；截图 `shots/w1024-*、w800-*、zoom2-*`（本地）。
- [x] 4.3 纯键盘完成折叠/专注/编辑/核对/返回/取消放弃，核对目标切换/卸载及主动调整行为；固定完整草稿、原偏好、阅读状态与当前许可指纹，不自动执行。（键盘折叠显示当前状态；专注切换目标与主动调整有明确归属；长草稿切换不丢输入和目标；放弃模态可辨且取消不丢草稿）
  - 2026-10-10：五段探针（fold/focus/draft/resizer-stacked/longtext）真实窗口 1210×713（stacked 档 447×714），键盘全程 `Input.dispatchKeyEvent`（Enter 带 `\r`、逐字符真实键序）。**折叠**：运行列表/技术详情 Disclosure Enter+Space 双键切换、aria-expanded/controls 一致、命中区 28px、焦点环可见，收起→恢复往返不丢阅读状态（noticesExpanded 展开中态保存）。**专注**：键盘进/出；负对照（轮次切换 workspaceKey 不变→专注保持，正确）；页签「概览」切换→立即解除、「文件」切回不重入；主动收起偏好进出专注不回滚。**编辑**：Tab 至 native-edit-context（键盘入口）+ 逐字符真实键序输入；草稿 fp 在折叠往返/放弃模态取消/目标切换往返三处逐字相等。**核对**：确认 aria-pressed 翻转（已确认从头重跑）→ 提交按钮 Enter → 新 run 生成（557→558）。**放弃模态**：打开即聚焦「取消」、Tab 焦点圈不逃 dialog、Esc 关闭、焦点回触发点、草稿逐字保留。**返回**：compare「返回来源」Enter → view trace。resizer stacked 档键盘 ±24 精确 + Home 钳 120。指纹固定：confirmations/readingByRun/LayoutPrefs 形态全程记录，无自动执行（提交为键盘动作显式触发）。限制与观察（Tab 缩进穿越/运行列表 1100+ Tab 序/切概览后 nav 展开观察项）⇒ evidence-index「4.3 实机限制与观察」。
- [ ] 4.4 合入可靠性 change 后重跑可见编辑器恢复、当前凭据门禁与确认撤销；与导出规划检查文件工具栏边界。（核对后的编辑撤销旧许可；长草稿切换不丢输入和目标）
- [ ] 4.5 跑受影响 desktop 测试/typecheck/build/Biome/OpenSpec strict，补齐 evidence-index 全场景映射与当前文档，不声称起草即交付。（本 change 全部场景）
