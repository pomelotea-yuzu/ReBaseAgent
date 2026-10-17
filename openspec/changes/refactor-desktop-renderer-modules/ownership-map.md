# 1.2 AppState 字段/action/资源归属表

日期：2026-10-17。依据：`store.ts` @ `379b388` 全量通读（AppState 接口 L246–1128 + 模块级资源与协调函数实测）。分片命名沿用 design D1 的 8 个 slices；design 未预分配归属的通道（只读预检/文件读写/导出/目录选择）在本表显式指定并说明理由——**它们不是职责变更，是首次分配**。

## 分片归属总表

### runs（列表、详情、来源筛选和选择）

- 字段：`runs`、`failed`、`detail`、`selectedRunId`、`loadingList`、`loadingDetail`、`listLoaded`、`listStale`、`error`、`sourceFilter`、`searchQuery`、`initialSelectionAttempted`、`sourceUnavailable`、`sourceUnavailableReason`、`listRefreshInFlight`、`listRefreshPending`、`shortIdState`（短 ID 长度记忆锚定列表导航，归列表域）
- action：`loadRuns`、`refreshRunsOnce`、`selectRun`、`reopenRun`、`autoSelectInitialRun`、`setSearchQuery`、`sourceAvailability`、`filterVisibility`、`canExecuteFromSource`、`setSourceFilter`

### reading（调用/文件阅读状态与定位）

- 字段：`readingByRun`、`selectedSpanId`（派生视图，真源 `readingByRun`）、`expandedSteps`（派生视图）、`readingInvalidated`、`pendingFileTarget`
- action：`readingOf`、`setReadingTab`、`setReadingScroll`、`setCallReading`、`toggleNoticeExpanded`、`toggleStep`、`selectSpan`、`fileReadingOf`、`fileReadingEntered`、`setFileReading`、`openFileAt`
- 模块级：`detailReadAttempt`（L1676，详情读取代次；只增不减、不进渲染状态）

### drafts（草稿仓库、提交关联、执行确认）

- 字段：`drafts`、`draftSubmissions`、`confirmations`、`checkGenerations`、`sourceRevocation`、`createSourceRef`、`pendingDraftTarget`
- action：`callDraftOf`、`ensureCallDraft`、`writeCallDraftText`、`discardCallDraft`、`createRunDraftOf`、`ensureCreateRunDraft`、`writeCreateRunDraft`、`discardCreateRunDraft`、`modelAbDraftOf`、`ensureModelAbDraft`、`setModelAbRows`、`discardModelAbDraft`、`setCreateSourceRef`、`beginDraftSubmission`、`settleDraftSubmission`、`finishDraftSubmission`、`settleDraftByOperation`、`isDraftFrozen`、`currentConfirmationBinding`、`armExecutionConfirmation`、`releaseExecutionConfirmation`、`executionConfirmationReady`、`restartExecutionCheck`、`openDraftAt`、`consumeDraftTarget`

### operations（握手、统一提交、核对、执行/通道入口适配）

- 字段：`operations`、`forking`、`forkError`、`forkErrorCode`、`creatingRun`、`createRunError`、`createRunErrorCode`、`modelAbInFlight`、`modelAbError`、`modelAbErrorCode`
- action：`refreshOperationStatus`、`ensureOperationStatusPolling`、`stopOperationStatusPolling`（action 形态；模块级同名导出另有，见 runtime）、`reconcileOperation`、`forkAt`、`promptFork`、`proxyFork`、`modelAb`、`createRun`、`resetFork`、`resetModelAb`、`resetCreateRun`、`loadForkCapability`、`inspectWorkspace`、`readWorkspaceFile`、`chooseSource`、`exportCheckpoint`
- **首次分配说明**：`loadForkCapability`/`inspectWorkspace`/`readWorkspaceFile`（只读预检/文件通道）、`chooseSource`（目录选择辅助）、`exportCheckpoint`（导出写通道，**不走 submitActive**、自持 key+代次守卫）都是 IPC 通道适配，与操作槽/握手同域，归 operations；不新增第九分片。`exportCheckpoint` 的代次语义独立于操作会话，迁移时整体搬迁不得并入 submitActive。

### results（结果核实、草稿收尾、通知、导航意图）

- 字段：`resultReads`、`navGeneration`、`navIntents`、`seenNoticeKeys`
- action：`verifyRunResult`、`retryResultRead`、`openOperationResult`、`openOperationFailure`、`returnOperationDraft`、`isOperationDraftPresent`、`markNoticesSeen`
- 模块级：`readRunResult`、`closeDraftClosureFor`、`closeRemainingClosures`、`consumeSettledOperations`（终态消费唯一落点）、`attemptResultNavigation`、`noteReadingChanged`、`inspectAck`

### compare（比较读取、pair、侧目标与返回）

- 字段：`compareRead`、`comparePair`、`compareStepSelection`、`comparePrefixFolded`、`compareEvidenceExpanded`、`compareReturnLocation`
- action：`enterCompareSelection`、`retryCompareSelectionRead`、`leaveCompare`、`selectCompareStep`、`toggleComparePrefix`、`setCompareEvidenceExpanded`、`openCompareWithParent`、`openComparePair`、`openCompareWorkspace`、`setCompareSide`、`swapCompareSides`、`returnFromCompare`、`returnToCompare`、`openCompareSideError`、`openCompareSideFiles`
- 模块级：`requestCompareRead`、`enterCompareView`

### navigation（视图、创建/辅助工作区、树、返回来源）

- 字段：`view`、`createReturnLocation`、`recordingReturnLocation`、`experimentReturnLocation`、`messagesReturnLocation`、`experimentTarget`、`messagesTarget`、`treeScope`、`treeQuery`、`treeViewport`、`treeMode`
- action：`setView`、`openCreateWorkspace`、`returnToCreateSource`、`createReturnFactsOf`、`openRecordingWorkspace`、`openExperimentWorkspace`、`openMessagesWorkspace`、`returnToAuxSource`、`armTreeSession`、`setTreeScope`、`setTreeQuery`、`setTreeViewport`、`setTreeMode`
- 模块级：`createReturnFactsCache`（按引用缓存，见 runtime）、`auxEntrySnapshot`、`auxLocationKey`、`auxTargetKey`、`enterAuxWorkspace`、`restoreReadingLocation`（创建/比较/辅助返回共用的位置恢复落点，**跨 navigation+reading 协调**，归 navigation 持有、只调 reading 的公开 action）
- `MAX_COMPARE` 常量留在 store.ts 兼容导出（CompareSelectionBar 消费）。

### configuration（设置、代理状态/变化、录制草稿应用）

- 字段：`settings`、`proxy`、`proxyStatusRead`、`proxyReadGeneration`、`proxyFactCursor`、`settingsChangeGeneration`、`settingsSection`、`recordingDraft`、`recordingApply`、`recordingApplyError`、`recordingStatusReadFailed`
- action：`loadSettings`、`saveSettings`、`clearSettings`、`setSettingsSection`、`loadProxyStatus`、`toggleProxy`、`ensureProxyChangeSubscription`、`releaseProxyChangeSubscription`、`reconcileProxyFacts`、`reconcileProxyGate`、`writeRecordingDraftFields`、`discardRecordingDraftConfirmed`、`applyRecordingDraft`

## 模块级资源（runtime 所有者；全部已有唯一所有者，迁移 = 原样搬进 runtime/*，不改语义）

| 资源 | 位置 | 启动时点 | 停止/解绑时点 | 备注 |
|---|---|---|---|---|
| 轮询 `pollState` + `pollTimer` | L1187–1188 | `ensureOperationStatusPolling`（挂载/重载，空闲/失联不排）；每次可信响应/握手后 `rescheduleStatusPoll`（计时起点=响应完成） | `stopOperationStatusPolling`（导出）+ 通道抛错/staleEpoch 时 disarm；`applyPollStep` 每步先清旧 timer | 单路有界；只读 status，绝不重放 payload；在飞守卫在 `lib/operation-polling` |
| 代理变化订阅 `proxyChangeUnsubscribe` | L1831 | `ensureProxyChangeSubscription`（幂等；**必须先于首次 loadProxyStatus**） | `releaseProxyChangeSubscription`（renderer 卸载）；测试用它复位 | 句柄放模块作用域：资源句柄不是 UI 状态 |
| 静默等待者 `proxyStatusReadWaiters` | L1857 | `settledProxyStatusRead()`（reconcileProxyFacts / messages 门禁核对前） | 每次状态读取结算后 `notifyProxyStatusSettled`（**先结算后唤醒**，在 `loadProxyStatus` finally 接线） | 在飞 0 且尾随 0 才放行 |
| 派生缓存 `createReturnFactsCache` | L1841 | 惰性：首次 `createReturnFactsOf` | 按 `createReturnLocation`/`runs` 引用失效重算 | zustand v5 getSnapshot 引用稳定纪律（2026-10-15 实机教训：不缓存⇒无限重渲染⇒创建页白屏） |
| 详情读取代次 `detailReadAttempt` | L1676 | 每次 `selectRun`/`reopenRun` 实际发起 `getRun` 前 +1 | 不清零（只增不减） | 与 `resultReads.attempt` 分面：本者管"当前选中详情"，彼者管"按可信 runId 的后台核实" |

## 跨领域协调者（唯一入口，迁移时整体搬迁，禁止新旧两套）

| 协调函数 | 触达域 | set/await 边界（**现状，逐条保持**） |
|---|---|---|
| `noteReadingChanged()` | reading→results(navGeneration)→drafts(confirmations) | set#1 `{navGeneration+1}`；set#2 `clearExecutionConfirmations()`（两段 set，现状即如此；无确认时 set 返回 `{}` 不改引用） |
| `revokeSourceBoundPermissions()` | results/operations→drafts | **单次原子 set**：`{sourceRevocation+1, checkGenerations 每键+1?, confirmations 清空?}`（后两项条件包含） |
| `closeDraftClosureFor(identity)` | results→drafts+drafts(关联)+drafts(createSourceRef) | 判据只读（closure/record/四道闸），命中后**单次原子 set** `{drafts, draftSubmissions, createSourceRef?}`；CAS 输出不动 |
| `submitActive()` | operations+drafts(关联 epoch 绑定) | set(bindSubmissionEpoch)〔仅 epoch 不匹配时〕→ set(beginLocalSubmission) → await call → 失败路径 set(markUnknown)；回执终态 set(endLocalSubmission) → await refreshOperationStatus → rescheduleStatusPoll |
| `consumeSettledOperations(previous, trigger)` | operations→drafts→runs→results→navigation | 串行：逐条 `settleDraftByOperation` → `loadRuns`（有新 run 才一次）→ 逐条 `readRunResult` → 逐条 `attemptResultNavigation` → `closeRemainingClosures`；顺序即保证 |
| `enterCompareView(pair)` | compare→navigation(view/来源)→reading(代次) | set#1 `{view, compareReturnLocation?, comparePair}`；pair 变化时 set#2 `{compareStepSelection, comparePrefixFolded, compareEvidenceExpanded}`；再 await `enterCompareSelection` |
| `enterAuxWorkspace(view, target)` | navigation→reading(代次) | keep 分支：仅 set(targetPatch)；capture 分支：`noteReadingChanged()` 后 set `{view, 来源引用, 目标}` |
| `restoreReadingLocation(location)` | navigation→reading | 同 run：只调既有阅读 action（setReadingTab/selectSpan/setFileReading）；换 run：set(patch readingByRun) → set(patch fileReading) → await selectRun |
| `attemptResultNavigation(record, trigger)` | results→navigation | set(releaseNavigationIntent) → decision.kind==="navigate" 时 await selectRun（同 ID 短路 = 不推进代次） |

**初始化边界**：`create` 的对象字面量只含初值与 action 闭包；模块加载不启动任何资源（轮询/订阅/等待者全部惰性）。分片迁移后每字段/每个 action 只有一个初始化写入点；组合键集合用类型层检查验证无缺失、无重复覆盖。

## 4.1 接口拆分映射（供阶段 4 使用）

按上表 8 域将 `AppState`（883 行）拆成各 slice 的接口片段（`slices/*.types.ts` 或 slice 文件内），`store/types.ts` 聚合为完整 `AppState` 并加组合键集合检查。原字段/action 签名与 JSDoc 注释原样随迁（注释里承载了大量纪律语义，是判据的一部分）。
