# 设计：正文优先的工作区布局

## D1. 折叠控制统一

使用现有 Lucide 图标和文字按钮/标题行，不另建依赖。控制统一可访问名称、aria-expanded、aria-controls、方向与 visible focus。一般标题整行可点击，最小命中高度 28 CSS px，图标自身可小，但浅色 16px 箭头不再是唯一入口。全局/列表的重复入口需含义一致；文件目录控制靠近目录标题，收起后显示明确“展开目录”；长文本标题显示字段、字数与动作。

折叠属于会话阅读状态，按 run/span/分区或比较 pair 归属，沿用 readingByRun/草稿和布局偏好。自动折叠不得写回手动偏好，数据变更需校验定位。折叠不等于放弃、取消执行或解除授权门禁。Monaco gutter 代码折叠与页面面板折叠用各自明确名称，不混用。

## D2. 信息分层和去重

运行页头常驻任务短摘要、状态、短 ID/模型、能力标签和紧凑来源摘要；保持完整内容可展开/复制。同一隔离说明只在一处详细展开，文件区不再重复 DetailNotices 与 RunHeader 的相同段落。当前位置、父本与快照所属轮次须可辨，但 world_id/profile/hash 的扩展解释归“来源与技术详情”。

“来源与技术详情”与 D5 的 fork/main 登记/config_hash 工程说明共用一个可访问的 disclosure 组件/机制：受控 expanded 状态、唯一 aria-controls、统一键盘与焦点语义，不分别造两套详情控件。展开状态按现有 run/span/分区或比较 pair 的会话阅读键保存；组件只消费状态和动作，不自建第二份阅读 store。内容与标题可不同，同屏相同技术说明仍只保留一份，完整原值可读/复制，异常摘要不随详情收起。

错误、来源缺失、读取失败、未知/未核实状态和阻断门禁在相关内容处保留可见摘要及处理动作，完整原文可以展开；不得把必要错误藏进一般说明。模型实验在隔离父本不适用的原因可在动作菜单或能力详情，取消常驻长说明行，保留查询原因入口。

比较页修改证据折为“修改证据 · 字段/修改数 · 展开”，缺证据/关系未知摘要仍常驻。输出 diff 两侧用紧凑身份栏标明 run 与方向，不只依赖工具提示。长正文、错误体、编辑值始终可完整展开/复制，不做数据截断。

## D3. 可用空间与专注模式

用实际工作区宽度/可用高度作输入，优先复用 ResizeObserver 与 layout helper。file/diff 编辑器从固定 vh 改为有限容器剩余高度，形成明确 flex 高度链和 min-h-0，滚动主要在内容内部。messages/prompt/result/A/B 中主要编辑器使用剩余空间，默认高度不再固定为 200px；按实际每侧文字区域宽度决定并排/上下，目标每侧至少约 320px 可读空间，窄窗上下并各自滚动，不能只追随 xl 窗口断点。比例调整支持拖拽及键盘，遇到空间不足保留可达切换与内部滚动。

增加“专注编辑/退出专注”“专注差异/退出专注”操作，进入时折叠一般说明及辅助目录，保留工作区目标、原值/草稿或左右身份、重要门禁、返回与必要提交摘要。原值可单独收起但恢复入口始终在编辑栏；不把只读 diff 变成可写界面。

状态归属固定在现有 useLayoutState：增加仅会话有效的 focus={mode,targetKey} 临时状态，mode 区分编辑/差异，targetKey 由已有 run/span/编辑字段或有方向的比较 pair 身份生成。专注后的有效布局从现有 LayoutPrefs、阅读状态与该临时模式派生；进入、缩放和退出均不写回手动宽度/折叠偏好，不保存一份用于退出时覆盖原值的偏好快照。文件目录与一般说明的专注收起也只是该目标的显示覆盖层，不写回原阅读状态。草稿、model/view state 与阅读定位继续由现有目标机制持有，不复制到 focus 或新 store。

退出直接移除覆盖层，按当前容器约束恢复原有有效偏好。用户在专注中显式调整列表/目录宽度或手动展开/收起辅助区时，先退出专注，再通过原 setter 更新该项偏好；这类主动调整成为新偏好，之后退出不回滚。targetKey 变化、离开该工作区或宿主卸载时清空 focus，返回同目标也不会自动重入；仅窗口尺寸变化保持 focus。目标变更以身份比对立即停止使用旧覆盖层，不能等迟到 effect 才解除。进入/退出不保存或恢复执行许可，门禁仍由原确认机制判断。

Monaco 布局变化调用 layout，避免因 React key 变化反复销毁模型；视图状态按草稿键/比较身份保存。复用可靠性 change 的可见宿主恢复机制，不另造恢复通道。若先实现本 change，公共包装仍保留 onMount、尺寸接线和失败占位接口。

1210×713 的普通文件页和专注编辑/差异至少保留 50% 视口高度给主要正文（约 357px）；基线截图 y≈509 的布局须改善。此数是验收目标，不假装所有异常页面都已满足；阻断异常仍可见，低高度设备通过内部滚动保持操作可达，不横向溢出或缩小字体。

## D4. 相邻核对与提交

编辑区底部或固定可见操作栏放置当前目标、费用/副作用短摘要、“核对本次提交”与“确认提交”；详细请求/保真度边界使用可展开区域，正文处不反复陈述相同纪律。核对和提交视觉相邻，可用宽度不足则上下相邻，不放在长说明的两端。采用 sticky 需为正文保留空间，键盘焦点不被栏遮挡。

保留原先每种执行模式的确认流程。普通/隔离预检、实验计划、messages 源/代理状态检查还是原动作；折叠不免除前置核对，确认不能只看 checkbox 就绕过绑定。编辑/目标/模型参数/配置/凭据语义变化继续撤销许可；纯阅读折叠不新增授权，离开再返回不恢复旧许可。与可靠性 change 的 keyCaptureRevision 兼容。

## D5. 放弃模态和用户语言

保留 ModalDialog.showModal 与现有焦点/Esc/关闭禁止行为，将居中对话框和较明显遮罩作为统一样式，避免看起来像普通正文卡片。打开时聚焦安全操作，取消后回到触发点；长草稿确认内容内部滚动，不以整段正文将按钮推出可用区域。保留修订 CAS，模态打开期间底层无法交互是预期，不能为自动化便利移除。

将“空 fork”主提示改为“与原值相同，请修改后再提交”，main 登记和 config_hash 的解释进入“技术详情”，状态主文案使用“尚未提交/提交失败/结果待读取”；直接渲染的 ** 标记修为实际强调或普通文字。时间旅行入口使用“在此重跑”并提供“时间旅行 · 隔离续跑”语义说明，不承诺历史磁盘/外部工具状态恢复；工程 API、trace 字段、文档中的 fork 保留。

## D6. 与其他 change 的交界

本 delta 只 ADDED 新要求，不替换代理相关 requirement，也不修改 branch-tree 数字契约。可靠性 change 拥有通知/状态/失败录制/恢复根因；本 change 拥有布局与视觉，涉及同一编辑器时合入后重跑彼此场景。export-run-results 的功能入口保持独立规划；工具栏可给未来动作位置但不提前显示未交付能力。

## D7. 证据与风险

风险是正文放大后必要提示不可见、sticky 遮挡、observer 循环、专注状态串目标和切换丢 Monaco view state。必须同时记录实际正文可见高度、操作可达、目标/原始草稿指纹、手动偏好前后值和模型调用计数。沿用真实窗口截图，不用 Emulation 假几何满足比例；宿主不能达到的宽档单独标限制并以其他可用环境补齐，不宣称全矩阵通过。

## D8. §1 实施核对记录（2026-10-09，apply 时对回真实代码的结论）

| 提案假设 | 核实结果 | 处理 |
| --- | --- | --- |
| RunHeader 与 DetailNotices 同屏重复同一段隔离说明 | 属实：两者都渲染 `isolatedRunNotice(detail)` 全文（RunWorkspace.tsx 页头 + DetailNotices.IsolatedRunNotice） | 拆 `isolatedRunNoticeView`（compact/detail/tech 三层）；页头只留 compact，完整边界进共享 Disclosure |
| 「来源与技术详情」与 D5 工程说明共用一个机制 | 先建 `components/Disclosure.tsx`（DisclosureButton + Disclosure，全部受控）；D5 落地（3.4）时复用同一组件，不再造第二套 | 已共用；DetailPanel 的隔离父本「不适用」原因同机制接线 |
| 展开状态按 run 阅读键保存 | `RunReadingState` 已有 `overviewExpanded`/`calls[].expanded` 两个 string[] 先例；新增可选 `noticesExpanded?`（键为静态 UI 键，reconcile 不清理），通用 toggle 收敛到 `lib/reading-state.ts`（LongText 委托） | `toggleNoticeExpanded(runId, key)` 单点写路径 |
| 比较证据收起态的存储 | 与 `comparePrefixFolded` 同口径：store 会话级字段、换 pair 复位、交换不复位 | `compareEvidenceExpanded`（默认 false=收起）+ `setCompareEvidenceExpanded` |
| 文件目录开关「靠近目录标题」 | 目录列此前无标题行、常驻收起按钮在页头检查点行（离目录远） | 目录列新增 sticky 标题行（「目录」+ 收起按钮）；非驻留 pane 条按钮补 aria-expanded |
| 证据区收起不得藏异常 | `DirectEditEvidence` notApplicable 变体只有 reason（无前后值/方向字段），incomplete/unavailable 分型整体即异常 | `evidenceCollapsible` 只放行 verified/direct-hops/different-roots；不可收起分型保持原 heading 措辞（既有用例钉住「不同根」框架不丢） |

## D9. §2 实施核对记录（2026-10-09，apply 时对回真实代码的结论）

| 设计假设 | 核实结果 | 处理 |
| --- | --- | --- |
| 2.1 高度链的挤压退路 | toolbar 换行可把 `flex-1` 正文吃穿到 0（flex 内部溢出） | 根容器自身 `overflow-y-auto` + diff 容器 `min-h-[200px]`：正文保 200px 下限、根滚动兜底；异常分支保留普通流（`min(60vh,640px)` 计数=1 由回归钉住） |
| 2.2/2.3 并排判据的归属 | 既有 `xl:grid-cols-2` 吃**窗口**断点，spec 要求按**容器**实测宽决策 | 新共享层 `DraftCompareGrid`：`useContainerWidth(720)` 实测 + `(w-8)/2≥320` 判据（`lib/editor-space.ts`）；xl 断点在四处接线中全部退场（DetailPanel 只读 args/result 展示的 `xl:grid-cols-2` 不在范围，回归计数钉住） |
| 2.2 原值收起的恢复入口 | 收起后若无常驻入口，「恢复核对」场景断裂 | 收起/恢复按钮同位常驻（`aria-expanded` 可判）；收起态高度让给草稿 |
| 2.4 focus 生效判定 | effect 异步解除会有「返回同目标自动重入」窗口 | **身份比对即时判定**（`focusActiveFor` 同步 false）+ effect 清状态（防重入）；`workspaceKey` 单值承载 view/tab/run/span 两级身份（span 入 key，专注编辑入口不绑字段） |
| 2.4b 主动调整的归属 | 专注中调宽/折叠若回滚，调整丢失；若不退出直接写，退出后又像覆盖 | 全部 8 个写偏好入口**先 `setFocus(null)` 再写**——调整成为新偏好、退出不回滚（use-layout 源码契约逐入口钉住） |
| 2.4 专注收起范围 | DetailPanel 内 RunDraftListSection/BudgetMap 与 nav/steps 不同层 | nav/steps 在 App 层（显示层派生）；DetailPanel 收草稿列表 + 消耗图；DetailNotices（异常摘要）按 spec 保留——2.4 改造中 WorkspaceFilesPanel 的 DetailNotices 被误删一次，由 workspace-file-view 既有契约当场钉回 |
| 2.5 view state 的键与范围 | file diff 已有 U2 4.3 滚动恢复通道，两套恢复会打架 | 键 = `data-monaco-host|data-monaco-target` **同时**存在才启用 ⇒ file diff（无 target）天然不参与，调用方零排除动作；草稿编辑器/compare-diff 按既有寻址身份自动启用，零新 prop |
| 2.5 恢复时机的竞态 | monaco 实例由 loader 异步创建，挂载 effect 跑时 ref 常为 null | 恢复放 onMount 合成内（实例创建那一刻，调用方 onMount **之后**最后落笔）；保存放 effect cleanup（卸载时实例必然在 ref），键经 ref 取离开前最新值 |
| 2.5 observer 纪律 | design D7 风险点名「observer 循环」 | diff 编辑器**复用**单编辑器的 `useSizeRecovery`（`layoutRecoveryAction` 未真正恢复返回 null ⇒ 不自激；`new ResizeObserver` 全文件唯一，回归钉住） |
