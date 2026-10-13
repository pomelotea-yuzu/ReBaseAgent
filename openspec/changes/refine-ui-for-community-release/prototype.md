# 原型与契约核对：身份、入口、布局状态表（任务 1.1–1.3）

日期：2026-10-13。全部条目按 2026-10-13 实读源码核对（基线 `5a37b50`，产品源码最新归档 R2.1 `ac8729e`）。
路径均相对 `apps/desktop/src/renderer/src/`。行号为核对时快照，实现后以内容为准。

## 1.1 页面 × 实际对象 × 入口 × 返回目的地对照表

覆盖 proposal 要求的侧栏 A／编辑 B／比较 C-D 状态。

### 身份来源（真实绑定）

| 页面（view） | 实际对象绑定（store 字段） | 独立于侧栏？ | 现状呈现 | 缺口 |
|---|---|---|---|---|
| 侧栏 A（RunList） | `selectedRunId`（store.ts:246） | —（本身即侧栏） | 条目高亮 + 状态徽章 | 无 |
| 单运行（trace） | `detail` + `selectedRunId` + `readingByRun[selectedRunId]`（store.ts:246-260） | 与侧栏同一对象（正当） | WorkspaceShell→RunWorkspace；DetailPanel 对象头 | 无 |
| 比较（compare） | `comparePair.leftRunId/rightRunId`（store.ts:739；lib/compare-navigation.ts:24-27） | ✅ 独立（store.ts:2105 注释：与侧栏选中、`compareIds` 互不决定） | CompareWorkspaceView 对象头：左侧/右侧 `ShortIdLabel` | 顶栏全局 ID 冒充（见下）；两侧完整 ID 复制已有 `ShortIdLabel`（复制完整原始 ID + copied/unavailable 反馈） |
| 编辑 messages | `messagesTarget` + `messagesSource`（store.ts:378、1098；写入纪律 371-376：目标只由显式进入动作写入，`selectRun` 永不改写） | ✅ 独立 | AuxWorkspaceFrame `targetLine` | 顶栏全局 ID 冒充 |
| 实验（experiment） | `experimentTarget` + `experimentSource`（store.ts:377、1091；readExperimentSource 3595-3619 只读 `runs:get`，注释明言"不借用全局 detail"） | ✅ 独立 | AuxWorkspaceFrame `targetLine` | 顶栏全局 ID 冒充 |
| 新建（create） | 无运行身份（草稿 runId 为空串，lib/draft-list.ts:21）；`createReturnLocation`（store.ts:355） | — | CreateRunWorkspace 表单 | 顶栏显示 detail.meta.id 冒充"当前对象" |
| 录制（recording） | 无运行目标（AuxWorkspaceFrame.tsx:30 注释 "null = 该页无运行目标（录制）"） | — | RecordingWorkspace | 顶栏显示 detail.meta.id 冒充 |

### 🔴 核心缺陷：全局栏的身份冒充（2.2 的落点）

`components/GlobalBar.tsx:272` 订阅全局 `detail`，`:303-307` **无条件**渲染 `detail.meta.id`
（侧栏最近选中的 run 的完整 ID）——不区分当前 view。后果：

- 比较页：顶栏显示侧栏选中的 A 的 ID，冒充比较对象（违反 N01「比较对象不被侧栏身份覆盖」的呈现要求）；
- 编辑/实验页：顶栏 ID 与 AuxWorkspaceFrame 的真实来源 B 不一致（违反 N02）；
- 新建/录制页：顶栏显示一个与当前任务无关的 run ID。

这正是 proposal「全局栏直接使用当前加载 detail，容易在比较页表达错误对象」的实锚。
**修法（2.2）**：移除全局栏的这行 detail.meta.id 展示——每个工作区对象头已各自呈现真实身份
（DetailPanel / CompareWorkspaceView / AuxWorkspaceFrame / 表单），全局栏不再承担对象身份职责。

### 返回目的地现状

| 入口 | 来源字段 | 返回动作 | 失效判据 |
|---|---|---|---|
| 创建 | `createReturnLocation`（store.ts:355；注释 339-354：只含阅读位置、不含草稿/授权、重载必然失效） | `returnToCreateSource()`（:3471-3484，一次性凭据） | `decideCreateReturn`（lib/create-workspace.ts:134-145：null→no-location；runId 不在 knownRunIds→run-missing） |
| 比较 | `compareReturnLocation`（store.ts:771，注释：一次性凭据，经 selectRun 打开单侧时保留） | `returnFromCompare()`/`returnToCompare()`（:808/:813）；App.tsx:425-450 `ReturnToCompareBar` 常驻显示"比较对象已保留：左 X → 右 Y" | 同 decideCreateReturn 族 |
| 录制/实验/messages | `recordingReturnLocation` / `experimentReturnLocation` / `messagesReturnLocation`（store.ts:367-369） | `returnToAuxSource(view)`（:3514-3542） | `decideAuxReturn`（lib/aux-workspace.ts:147-159） |

失效呈现现状：`AuxWorkspaceFrame.tsx:55-93` 在 `returnAvailable=false` 时"返回来源"按钮 disabled，
title="本次会话没有记录来源位置（重载后来源失效），不能返回"。

**N03 缺口**：失效时只有按钮 disabled + title，没有**就近可见的真实原因文案**（须读 title 才知道），
且没有"可达退路"的表达（草稿可找回/复制入口在别处）。2.3 落点：失效来源在对象头就近显示原因与退路。
**返回文案（N02/D2）**：现状按钮统一叫"返回来源"，无实际目的地说明；2.3 落点：改为
"返回运行概览/第 N 轮调用/比较"等可读目的地（取自 return location 的真实字段）。

### N04 完整 ID 复制现状

`ShortIdLabel`（components/ShortIdLabel.tsx:19-）已实现：复制完整原始 id（`id` 是唯一复制目标）、
copied/unavailable 双态反馈、可访问名称含对象名。已消费于：RunList 条目（兄弟节点复制，:338-346）、
CompareWorkspaceView 两侧。**缺口**：单运行 DetailPanel 对象头与 AuxWorkspaceFrame 的 targetLine
是否都消费 ShortIdLabel 需在 2.2 逐个核对补齐（键盘可达性随组件既有实现）。

## 1.2 任务适配 × 手动偏好 × 专注 × 设置往返状态表

### 布局事实（lib/layout.ts + lib/use-layout.ts）

| 事实 | 位置 |
|---|---|
| `LayoutPrefs { navWidth; stepsWidth; navUserCollapsed; stepsUserCollapsed }`，**会话内有效、不持久化** | layout.ts:82-98（注释） |
| 常量：NAV_MIN=220 / NAV_MAX=360 / NAV_DEFAULT=264；DETAIL_MIN_WIDTH=480 | layout.ts:29-39 |
| `decideNavVisible`：自动折叠**只在显示层生效，不写回 LayoutPrefs** | layout.ts:102-105、112-136 |
| `decideStepsVisible`：480px 硬约束 | layout.ts:39、148-166 |
| `WorkspaceFocus { mode: "edit"|"diff"; workspaceKey }`；`workspaceKeyOf()`（trace 视图 = `trace:tab:runId:spanId`）；`focusActiveFor()` 身份比对 | layout.ts:219-240 |
| App 接线：workspaceKey 变化即 `layout.exitFocus()`（"返回不自动重入"） | App.tsx:58-73 |
| 专注进入/退出按钮 | App.tsx:370-388（data-enter-focus / data-exit-focus） |
| 比较页窄窗默认收起导航（navShowing 已按视图分流） | U7 5.8，App.tsx:177-184 |
| 步骤目录只在步骤页挂载；收起后正文有"重新打开步骤目录"入口 | App.tsx:271-289 |

### 状态表（ADDED2 / N05 / N06 / N07 的逐项规则）

| 状态迁移 | 现行行为 | 本 change 规则（delta） | 缺口/落点 |
|---|---|---|---|
| 进入编辑/实验/比较任务 | 仅比较页窄窗自动收起（U7 5.8）；编辑/实验无任务适配 | 按任务及内容空间**临时**调整导航，保留恢复入口与当前对象 | 3.1：把"任务默认适配"扩展到编辑/实验（临时覆盖层，不写 LayoutPrefs） |
| 用户主动开/合导航 | `openNav/closeNav` 写 `navUserCollapsed`（手动偏好，会话内） | 保持；自动适配、专注、手动偏好覆盖顺序一致 | 3.1 复用 |
| 离开任务（返回运行阅读） | 无任务适配故无恢复 | 解除临时覆盖，按实际空间恢复有效手动布局 | 3.1：离开时清除任务覆盖层，`decideNavVisible` 自然回到手动偏好 |
| 进入专注 | `enterFocus(mode, workspaceKey)`；退出后不自动重入 | 保持现行专注规则：先退出再更新主动偏好，退出不回滚新偏好 | 3.2 既有行为核对（N06 回归） |
| 打开设置 | `SettingsDialog` 真模态（App.tsx:302），不改 view/布局/输入 | 设置往返保留有效任务布局及输入 | 既有 ✓（模态不卸载工作区）；N02 回归核对 |
| 窄窗回退 | `decideNavVisible`/`decideStepsVisible` 按可用空间自动折叠（不写偏好） | 保持；窄窗仍保持关键内容和恢复入口可达 | 既有 ✓；5.5 实测 |
| 布局往返 | 纯显示层状态变化 | SHALL NOT 新增模型/工具/导出请求、不清理草稿/操作登记、不借布局恢复失效预检 | N07：新增回归测试钉住（布局动作不触 IPC 执行通道） |

**关键既有保真点（不改）**：自动折叠从不写回 `LayoutPrefs`（layout.ts:102-105 注释是契约）；专注退出不自动重入
（App.tsx:58-73 注释）；`LayoutPrefs` 不持久化（刷新后回默认，delta N05 的"会话内有效手动偏好"以此为准）。

## 1.3 原型决策记录

### 活动入口位置：底部活动条 vs 顶栏分组

**现状**：顶栏已有两个入口——`OperationsEntry`（OperationsEntry.tsx:279；操作 + 结果未读合计徽标，
operationBadge(rows, notices.unreadCount)）与 `SessionDraftsEntry`（GlobalBar.tsx:183-259；草稿徽标 =
dirty 计数）。polite live 由 `ResultLiveRegion`（sr-only，独立于面板开合）承担。

**比较**：

| 方案 | 优点 | 风险 |
|---|---|---|
| 底部活动条（D1 初始方案） | 三组（修改/操作/结果）有可读分组标签的空间；顶栏 flex-wrap 在窄窗已拥挤（新建/录制/状态指示 + 两入口，800px 下换行） | 新增 ~32px 常驻高度，800px 矮窗挤压正文（设计风险条已预判） |
| 顶栏分组（合并两入口） | 零新增占高；改动面小 | 顶栏更挤，窄窗换行加剧；三组标签空间不足 |

**推荐：底部会话活动条**（按 D1 初始方案推进），理由：ADDED3 要求组内"分别表达未提交修改、主动操作及
结果待查看"且各自有可达动作，可读分组需要横向空间；顶栏已承载品牌/视图切换/新建/录制/状态指示，
再塞三组标签必然换行，窄窗反而多占一行。底部条固定单行，高度成本可预算。
**回退判据**：5.5 实测 800×~640 下正文高度低于现行约束（DETAIL_MIN_WIDTH 相应的正文底线）或活动条换行
⇒ 回退顶栏分组（design 风险条既有路径）。

### 三个用户路径的原型走查（用现有公开 fixture，无模型请求）

| 路径 | 现有可达路径 | 整理后路径 | 受影响条款 |
|---|---|---|---|
| 找错误 | RunList 条目第三行"N 出错"红标（RunList.tsx:306-333）→ 点进 run → SpanTree 调用行红标（:127-132）→ DetailPanel | 保持主线；列表条目结局徽章已有一等呈现，2.4 只做信息分层（次级计数按需展开） | ADDED5（N15） |
| 找文件 | 合法隔离 run → 文件页签 → WorkspaceFileView（检查点选择） | 不变；文件页占满主工作区已成立（R06 既有） | MODIFIED2 回归 |
| 恢复修改 | 顶栏 SessionDraftsEntry → 徽标 dirty 计数 → 定位草稿（pendingDraftTarget，store.ts:904） | 统一活动入口的"修改"组；本运行草稿列表与调用旁标记保留，同一 deriveDraftList 事实 | ADDED3（N08-N11） |
| 比较返回 | ReturnToCompareBar 常驻（App.tsx:425-450）→ returnToCompare | 保持；对象头按 D2 显示左右对象与方向 | ADDED1（N01）回归 |

### 找回 clean 会话（N09 现状核对）

`deriveDraftList`（lib/draft-list.ts:71-74）返回全部会话条目（含 clean），dirty 判据 =
isCallDraftDirty/isModelAbDraftDirty/isCreateRunDraftDirty（:92/117/139）。GlobalBar 徽标只数 dirty
（GlobalBar.tsx:190）。**缺口**：入口面板是否呈现 clean 条目、"标为未修改"的分组/标记——3.4 落点：
面板列表分"未提交修改"/"未修改的编辑会话"两组，先列 dirty；clean 条目不加警告（delta 明文）。
录制未应用修改：`isRecordingDraftDirty`（lib/recording-draft.ts:103-110）已独立成立，
`sessionDirtyCountOf`（draft-list.ts:162-169）已并入计数——3.4 核对统一计数消费它。

## 与 delta 场景的映射

- 1.1 表 → N01（比较不被覆盖：现状独立字段 ✓，冒充在顶栏）、N02（往返：目标不跟随侧栏 ✓，顶栏冒充待修）、N03（失效可辨：disabled+title → 就近文案待补）、N04（ShortIdLabel 已有，覆盖面待补齐）。
- 1.2 表 → N05（任务适配待建，手动偏好机制既有）、N06（专注规则既有，回归钉住）、N07（新增回归测试）。
- 1.3 决策 → N08-N11（底部活动条方案 + 三组事实消费既有派生）、N09（clean 分组落点）、N15（列表分层）、N16（入口不新建第二流程：openCreateWorkspace/openRecording 均单入口 ✓ 既有）。
