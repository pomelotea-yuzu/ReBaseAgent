import {
  isCurrentDetailAttempt,
  isCurrentDetailResponse,
  isDetailPayloadForRun,
  shouldApplyDetailFailure,
} from "@shared/detail-request";
import { findRunDetailVersionViolation } from "@shared/detail-version-guard";
import type {
  ChooseSourceResult,
  CreateRunRequest,
  Envelope,
  FailedFile,
  ForkCapabilityRequest,
  ForkCapabilityResult,
  IsolatedExecutionMode,
  ModelAbResult,
  ProxyState,
  ProxyToggleInput,
  RunDetail,
  RunSummary,
  SettingsInput,
  SettingsState,
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceReadFileRequest,
  WorkspaceReadFileResult,
} from "@shared/ipc";
import type { ModelAbArm, PromptForkRequest } from "@shared/ipc";
import {
  ChooseSourceResultSchema,
  ForkCapabilityResultSchema,
  ListRunsDataSchema,
  ProxyChangeEventSchema,
  ProxyStateSchema,
  RunDetailSchema,
  SettingsStateSchema,
  WorkspaceInspectResultSchema,
  WorkspaceReadFileResultSchema,
} from "@shared/ipc";
import { decideRefresh, resolveRefreshFailure, settleRefresh } from "@shared/list-refresh";
import { ShortIdState } from "@shared/nav";
import type {
  ExecutedRequest,
  ExecutedResponse,
  OperationAck,
  OperationRecord,
  OperationStatusResult,
} from "@shared/operations";
import {
  OPERATION_ERROR,
  OperationAckSchema,
  OperationStatusResultSchema,
  ReconcileResultSchema,
} from "@shared/operations";
import { create } from "zustand";
import { api } from "./lib/api";
import type {
  AuxReturnLocation,
  AuxWorkspaceView,
  ExperimentTarget,
  MessagesTarget,
} from "./lib/aux-workspace";
import { decideAuxEntry, decideAuxReturn } from "./lib/aux-workspace";
import { deriveCompareFileEntry, isOwnStepTarget } from "./lib/compare-files";
import {
  type ComparePair,
  type CompareReturnLocation,
  decideCompareWithParent,
  decideManualPair,
  decidePairSideEdit,
  swapComparePair,
} from "./lib/compare-navigation";
import {
  type CompareReadSession,
  applyCompareResponse,
  beginCompareRead,
  destroyCompareRead,
  emptyCompareReadSession,
  findCompareSelectionViolation,
  retryCompareRead as retryCompareReadState,
  sameCompareSelection,
} from "./lib/compare-state";
import type {
  CreateReturnLocation,
  ReadingLocationSnapshot,
  SourceView,
  WorkspaceView,
} from "./lib/create-workspace";
import {
  decideCreateEntry,
  decideCreateReturn,
  filePatchOfLocation,
  liveSpanOfLocation,
  readingPatchOfLocation,
} from "./lib/create-workspace";
import type {
  CallDraftEntry,
  CallDraftKey,
  CallDraftSource,
  CreateRunDraftEntry,
  CreateRunDraftPatch,
  CreateSourceRef,
  DraftRepo,
  ModelAbArmRow,
  ModelAbDraftEntry,
  ModelAbDraftKey,
} from "./lib/debugging-drafts";
import * as draftLib from "./lib/debugging-drafts";
import { isLineageRejectionCode } from "./lib/detail-completeness";
import {
  applyDraftClosure,
  decideDraftClosure,
  draftStateOf,
  pendingTokenForTarget,
  verdictOfOperation,
} from "./lib/draft-closure";
import type { DraftKind } from "./lib/draft-list";
import type {
  DraftSubmission,
  DraftSubmitChannel,
  DraftSubmitTarget,
  SubmissionStore,
} from "./lib/draft-submission";
import { CREATE_SUBMIT_TARGET } from "./lib/draft-submission";
import * as submissionLib from "./lib/draft-submission";
import type { ConfirmationBinding, ConfirmationStore } from "./lib/execution-confirmation";
import {
  armConfirmation,
  confirmationTargetKey,
  decideConfirmation,
  emptyConfirmationStore,
  releaseConfirmation,
  settingsStampOf,
} from "./lib/execution-confirmation";
import { isIsolatedRun } from "./lib/isolated-fork";
import {
  type NavigationIntentStore,
  type NavigationTrigger,
  armNavigationIntent,
  decideResultNavigation,
  emptyNavigationIntents,
  navigationIntentOf,
  releaseNavigationIntent,
} from "./lib/navigation-intent";
import {
  type PollContext,
  type PollState,
  type PollStep,
  disarmPoll,
  initialPollState,
  onPollSettled,
  onResponseSettled,
  onTimerFired,
} from "./lib/operation-polling";
import {
  type OperationBlockedBy,
  type OperationSession,
  type PendingSubmission,
  applyReconcile,
  applyStatus,
  beginHandshake,
  beginLocalSubmission,
  captureGeneration,
  deriveGate,
  endLocalSubmission,
  hasSameEpochPending,
  initialSession,
  markUnknown,
  newlySettledOperations,
} from "./lib/operation-session";
import type { ProxyFactCursor } from "./lib/proxy-changes";
import {
  initialProxyFactCursor,
  shouldApplyChange,
  shouldReconcileOnActivate,
} from "./lib/proxy-changes";
import type { ProxyStatusReadState } from "./lib/proxy-status-read";
import {
  acceptProxySnapshot,
  beginStatusRead,
  initialProxyStatusReadState,
  settleStatusRead,
} from "./lib/proxy-status-read";
import { resolveReading } from "./lib/reading-resolve";
import {
  defaultReadingState,
  fileReadingOf,
  patchCallReading,
  patchFileReading,
  patchReadingState,
  readingStateOf,
} from "./lib/reading-state";
import type {
  CallReadingState,
  FileReadingState,
  ReadingStateByRun,
  RunReadingState,
} from "./lib/reading-state";
import type { RecordingDraft, RecordingDraftPatch } from "./lib/recording-draft";
import {
  applyRecordingBaseline,
  discardRecordingDraft as discardRecordingDraftState,
  ensureRecordingDraft,
  recordingApplyRequest,
  recordingBaselineOf,
  writeRecordingDraft,
} from "./lib/recording-draft";
import {
  type ResultReadEntry,
  type ResultReadIdentity,
  type ResultReadStore,
  beginResultRead,
  emptyResultReadStore,
  finishResultRead,
  resultReadAlreadySettledOrInFlight,
  resultReadKeyOf,
  resultReadOf,
  verifyResultPayload,
} from "./lib/result-verification";
import type { SettingsSaveOutcome } from "./lib/settings-form";
import { type TreeScope, type TreeViewport, decideTreeInitialFocus } from "./lib/tree-view";
import {
  resolveExecutionGate,
  resolveFilterVisibility,
  resolveInitialSelection,
  resolveSourceAvailability,
} from "./lib/workspace-selection";
import type { FilterVisibility, SourceAvailability } from "./lib/workspace-selection";
/**
 * UI 状态：只存选择状态与原始数据。
 * 聚合数字一律在组件里用 shared/derive 的纯函数现算，不进 store、不落缓存。
 */

/** 分支对照的条数上限：再多是界面放不下，也失去了"并排看"的意义 */
export const MAX_COMPARE = 4;
interface AppState {
  runs: RunSummary[];
  /** 读取失败的文件（隔离展示，不拖垮列表） */
  failed: FailedFile[];
  detail: RunDetail | null;
  selectedRunId: string | null;
  /**
   * 当前 run 的选中 span（**派生视图**）。
   * 真源是 `readingByRun[selectedRunId].spanId`；本字段供既有组件直接读，
   * 每次写通过 `selectSpan` 同步两处，避免组件一次性大改（渐进迁移）。
   */
  selectedSpanId: string | null;
  /** 当前 run 的展开 step 集合（**派生视图**，真源同 `readingByRun`） */
  expandedSteps: Record<string, boolean>;
  /**
   * 会话内按运行保存的阅读状态（页签/调用/展开/滚动）。
   * 只存会话、不落盘、不保存授权或草稿；切运行再返回据此恢复。
   */
  readingByRun: ReadingStateByRun;
  /**
   * 恢复阅读位置时发生了失效回退（保存的 span / 展开对象已不在详情里，或文件页签不再适用）。
   * 只作一次性提示：用户下一次明确选择 span 即清除。**不**用来选另一个 run 的同 ID span。
   */
  readingInvalidated: boolean;
  loadingList: boolean;
  loadingDetail: boolean;
  /** 列表曾成功加载过（用于区分「刷新失败」与「首次读取失败」的提示口径） */
  listLoaded: boolean;
  /** 列表刷新失败但旧记录仍在：界面据此提示「未更新」，不清空列表 */
  listStale: boolean;
  error: string | null;

  /**
   * U4 任务 4.1：**main 操作会话**（`operations:status` 握手所得 + 乱序/代次守卫）。
   * 它取代了原先单个 `mainEpoch` 缓存——epoch 只是其中一项，锁还要看
   * 当前槽、配置变更标记、关闭标记、通信未知与**本地尚未确认的提交**
   * （spec「现有界面消费统一操作事实」；判据在 `lib/operation-session.ts`）。
   * 与 U3 的文档会话 id 各有职责、不能互代：同一 main 内重载 renderer 不换 epoch，
   * main 重启才会换。
   */
  operations: OperationSession;

  /**
   * 分叉类入口的**请求**状态（`runs:fork` / `runs:promptFork` / `proxy:fork` 共用一条写通道）。
   *
   * U5 任务 3.1–3.3：取值里没有"成功"——三条入口在 ok 后都回到 `idle`，
   * 因为响应只证明"这次请求明确返回了"；运行结局另由可信身份核实（`resultReads`）给出。
   */
  forking: "idle" | "in_progress" | "error";
  /** 分叉失败的展示信息（来自信封 error） */
  forkError: string | null;
  /** 分叉失败的错误码（渲染层据此给针对性提示，如未配置） */
  forkErrorCode: string | null;

  /**
   * 新建运行的**请求**状态（runs:create 写通道）。
   *
   * U5 任务 3.1：取值里刻意没有"成功"——响应回来只证明"这次请求明确返回了"，
   * 运行结局另由可信身份核实（`resultReads`）给出。ok 之后回到 idle = 输入面已交出。
   */
  creatingRun: "idle" | "in_progress" | "error";
  /** 新建运行失败的展示信息（来自信封 error） */
  createRunError: string | null;
  /** 新建运行失败的错误码（渲染层据此给针对性提示，如未配置） */
  createRunErrorCode: string | null;

  /** 运行配置状态（不含 apiKey；null = 尚未加载成功） */
  settings: SettingsState | null;

  /** 本地录制代理状态（不含 key 值；null = 尚未加载） */
  proxy: ProxyState | null;
  /** run 列表来源过滤 */
  sourceFilter: "all" | "proxy" | "local";
  /** 列表搜索词（匹配完整 task/ID）；与来源条件求交集（任务 3.5） */
  searchQuery: string;

  /**
   * 首次自动选择是否已尝试过（任务 3.5）。
   * 一次性动作的守卫：失败后留在该 run 的错误态由用户原位重试，
   * **不**因为"这条读不了"就去试下一条（那等于静默遍历整个列表）。
   */
  initialSelectionAttempted: boolean;
  /** 当前选中运行的源记录可用性（列表刷新后派生；见 lib/workspace-selection） */
  sourceUnavailable: boolean;
  sourceUnavailableReason: "available" | "missing" | "unreadable" | "unknown";

  /**
   * 主区域视图：trace = 既有三栏（列表 / span 树 / 详情），tree = 分支树，
   * create = 创建工作区（U5 任务 4.1：新建不再是覆盖模态，而是主工作区的一个页面）。
   * 纯 UI 状态，不进 IPC、不持久化（design D7）。
   */
  view: WorkspaceView;
  /** 加入对照的 run id（上限 4，分支树的选择栏与比较工作区的指标表消费） */
  compareIds: string[];
  /** 对照集合的操作提示（超上限等），空则无提示 */
  compareNotice: string | null;

  /**
   * 创建工作区（U5 任务 4.1）：**这次是从哪儿点进来创建的**。
   *
   * 「新建」不再是覆盖模态而是主工作区的一个页面（`view === "create"`），于是需要一个
   * 与创建草稿**分开**的凭据来兑现"返回来源"（design D1 + delta 场景「创建工作区任务
   * 优先且可返回来源」）。三条纪律：
   * - 只含阅读位置（运行 / 页签 / 调用 / 文件定位），**不含**草稿正文、目录引用、授权、
   *   凭据，也不含 main 操作登记的任何字段（判据与形状都在 `lib/create-workspace.ts`）；
   * - 只存 renderer 会话：不落盘、不进 URL/日志/IPC ⇒ **重载后必然失效**，
   *   返回时只能回退到已有可用工作区，不从草稿或登记反推旧位置；
   * - 与草稿生命周期互不决定：草稿的恢复/放弃/正常结束清理都不动它；
   *   从别的工作区进入创建重记，创建页内重复点击与设置往返沿用。
   *
   * ⚠️ 与 `createSourceRef`（隔离运行的**源目录**引用：main 签发的 token + name/path）
   * 是两回事，别混用。
   */
  createReturnLocation: CreateReturnLocation | null;
  /** 「录制接入」跳转后要高亮的设置分区（null = 常规打开设置） */
  settingsSection: "proxy" | null;

  /**
   * U8（unify-recording-and-experiment-workspaces）任务 1.2/1.3：三个辅助工作区的
   * **来源位置引用**（判据在 `lib/aux-workspace.ts`，语义同 `createReturnLocation`）：
   * - 只含会话内可核对的阅读位置，不含草稿正文 / 目标 / 凭据 / 授权；
   * - 页内重复进入与设置往返（视图未变）沿用；跨视图进入重记；经 setView 离开 = 用掉；
   * - `selectRun` 离开辅助页时**保留**（与比较页同一纪律：返回动作才消费引用）。
   * recording 是全局页面，也留来源（可从 messages 缺凭据提示进入，返回要回得去）。
   */
  recordingReturnLocation: AuxReturnLocation | null;
  experimentReturnLocation: AuxReturnLocation | null;
  messagesReturnLocation: AuxReturnLocation | null;

  /**
   * U8 任务 1.2/1.3：辅助工作区的**显式目标**（与 U3 草稿键同形：runId + spanId）。
   * 目标只由明确的进入动作写入（运行级菜单 / 自有代理调用入口 / 草稿列表返回）；
   * `selectRun`（侧栏选择）**永不改写**目标——「切运行不更换实验父本」。
   * 切换目标只有一个途径：用户对另一目标做显式进入动作。目标失效的来源重验归 3.2/5.2。
   */
  experimentTarget: ExperimentTarget | null;
  messagesTarget: MessagesTarget | null;

  /**
   * U8 任务 2.1：录制配置草稿（结构/判据在 `lib/recording-draft.ts`，独立于草稿仓库）。
   * 会话内保留；baseline = 最近可核实的代理配置（null = 状态待读取）；不含凭据/许可/计划。
   */
  recordingDraft: RecordingDraft | null;
  /**
   * U8 任务 2.5/2.6：在飞应用的**提交修订**（null = 无在飞）。应用+回读全程防重复提交；
   * 响应只有与当前草稿修订匹配才更新基线（「录制应用收尾不覆盖后来输入」）。
   */
  recordingApply: number | null;
  /** 最近一次应用的启动失败诊断（成功即清；「已保存意图 vs 监听事实」的分层呈现归视图） */
  recordingApplyError: string | null;
  /** 最近一次状态回读失败（2.5：失败也允许只读重试；重试即 loadProxyStatus，不重新 toggle） */
  recordingStatusReadFailed: boolean;
  /** U8 任务 2.6：状态读取代次（每次 loadProxyStatus 推进；守卫的锚点之一） */
  proxyReadGeneration: number;
  /**
   * 任务 2.1：代理状态读取的**在途合并与代次守卫**（`lib/proxy-status-read.ts` 判据）。
   * 与列表读取的 `listRefreshInFlight/Pending` 是**两套独立计数**——守卫锚点不同
   * （列表锚阅读位置，状态锚门禁事实），合并不许互相影响。
   *
   * ⚠️ 不参与渲染；UI 要「核对中」请派生 `proxyStatusChecking`（避免订阅整对象）。
   */
  proxyStatusRead: ProxyStatusReadState;
  /**
   * U8 任务 3.7：**已核实的运行配置变化代次**——已核实保存（含仅轮换 key：model/baseURL
   * 相同、指纹不变的那次）与已核实清除推进；保存失败不推进；已保存但回读失败**也推进**
   * （状态未知 ⇒ 撤销旧计划，不拿猜测保住结论）；普通 proxy:status 刷新**不**推进。
   * 只记次数，零密钥值传播。
   */
  settingsChangeGeneration: number;

  /**
   * 会话内的短 ID 长度记忆（任务 4.4）。
   *
   * ⚠️ 为什么不放在 RunList 组件里：delta 要求「**会话中**已扩展的长度不因刷新删除
   * 碰撞项而缩短」。组件随导航收起/展开会卸载重建，本地 state 一卸载就丢长度记忆 ⇒
   * 刷新后短 ID 缩回 8 位，正是规则禁止的。放 store 才跨渲染存活。
   */
  shortIdState: ShortIdState;

  loadRuns: () => Promise<void>;

  /**
   * 在途刷新计数与尾随登记（任务 3.4）。
   * 不是 UI 状态，故不参与渲染；放 store 内便于测试直接断言"读列表次数"。
   */
  listRefreshInFlight: number;
  listRefreshPending: number;
  /** 单次列表读取（合并调度内部使用；失败保留旧记录） */
  refreshRunsOnce: () => Promise<void>;
  /**
   * 订阅 main 的代理变化通知（design D1，tasks 1.3）。**幂等**：重复调用只保留
   * 一个订阅（挂载 effect 在 StrictMode 下会跑两次）。
   *
   * ⚠️ 必须在首次 `loadProxyStatus` **之前**调用：订阅与首读之间落盘的记录，
   * 两边都看不到（通知没发生、首读已结束）。顺序反过来则由
   * `shouldReconcileOnActivate` 在激活时补齐。
   */
  ensureProxyChangeSubscription: () => void;
  /** 解除订阅（renderer 卸载时必须调用，否则监听器泄漏） */
  releaseProxyChangeSubscription: () => void;
  /**
   * 已采纳的代理事实版本游标（`proxy-changes.ts` 的判据输入）。
   * 只存 epoch 与两个计数器——**没有任何凭据、指纹或载荷**。
   */
  proxyFactCursor: ProxyFactCursor;
  /**
   * 只读核对当前代理事实版本（design D1 的补读路径）。
   * 供窗口重新激活时调用：读到更新的 `recordsRevision` 才补刷列表。
   * 它**只读**：不启动监听、不调上游、不产生模型请求（design D3）。
   */
  reconcileProxyFacts: () => Promise<void>;
  /**
   * tasks 2.1：**门禁用**的只读核对（messages 打开 / 从录制返回时）。
   *
   * 与 `reconcileProxyFacts` 的分工：后者判"要不要补刷列表"（比对 recordsRevision），
   * 本者只保证"读到的事实是最新的"——**不刷列表**（打开编辑器不该白读一遍全量 traces）。
   * 同样只读：不启动监听、不调上游、不产生模型请求。
   *
   * ⚠️ 内部**等静默**：合并调度下被合并的那次调用会立即返回，不等就等于没读。
   */
  reconcileProxyGate: () => Promise<void>;

  selectRun: (id: string) => Promise<void>;
  /** 按同一 runId 重新读取详情（spec「结果不可读不重执行」的重试口）；不产生任何主动执行 */
  reopenRun: (id: string) => Promise<void>;
  selectSpan: (id: string) => void;
  toggleStep: (id: string) => void;

  /**
   * 首次自动选择（任务 3.5）：列表首次成功加载且无选中项时，
   * 尝试「最近可读摘要」对应的运行并进入概览。只尝试**一条**，失败即停。
   */
  autoSelectInitialRun: () => Promise<void>;
  /** 设置列表搜索词（与来源条件求交集；不改选当前运行） */
  setSearchQuery: (query: string) => void;
  /** 当前选中运行的源记录可用性（列表事实的纯派生，不缓存在字段里） */
  sourceAvailability: () => SourceAvailability;
  /** 当前选中运行是否被搜索/来源条件隐藏（导航据此提示，不改选） */
  filterVisibility: () => FilterVisibility;
  /** 依赖源记录的执行入口是否可用（源不可用 ⇒ 旧内容仍可见但不得执行） */
  canExecuteFromSource: () => boolean;

  /**
   * 阅读状态的读写（会话内按运行恢复；只存阅读位置，不存授权/草稿）。
   * 全部以 runId 为键——不同 run 中相同 span ID 不串状态。
   */
  readingOf: (runId: string) => RunReadingState;
  /** 切换某 run 的页签（首次默认概览） */
  setReadingTab: (runId: string, tab: RunReadingState["tab"]) => void;
  /** 记录某 run 某处的滚动位置（概览/步骤目录） */
  setReadingScroll: (runId: string, where: "overview" | "steps", top: number) => void;
  /** 记录某 run 某次调用的分区阅读状态（io 切换/展开块/内部滚动） */
  setCallReading: (runId: string, spanId: string, patch: Partial<CallReadingState>) => void;

  /**
   * U2 文件阅读状态（任务 2.1/2.4）：读取与不可变更新。
   * 与 `readingOf` 同法——按 run 隔离，组件卸载不丢。
   */
  fileReadingOf: (runId: string) => FileReadingState;
  /**
   * 该 run 是否**进入过**文件页（会话里 `files !== undefined`）。
   *
   * ⚠️ 必须与 `fileReadingOf(...).checkpoint === null` 分开用：`null` 明确代表"要看初始"，
   * 而"从未进入"要套**默认检查点**（最近自有完成步骤）——U2 5.6 实机缺陷正是把两者混为一谈。
   */
  fileReadingEntered: (runId: string) => boolean;
  /** 更新某 run 的文件阅读状态片段（undefined 值视为不改该项） */
  setFileReading: (runId: string, patch: Partial<FileReadingState>) => void;
  /**
   * U2 任务 2.3：一次性显式文件目标（如从步骤页「打开该轮文件」）。
   *
   * 与阅读历史分开存：历史是"上次读到哪"，目标是"这次要看哪"——混在一起会让普通
   * 页签返回被误当成定位请求（delta 明文禁止）。由文件页承载组件消费一次后清空，
   * 且与目标 run 的身份绑定（旧目标不抢回当前页）。
   */
  pendingFileTarget: { runId: string; file: { stepSpanId: string | null; path?: string } } | null;
  /** 登记一次性文件目标（切到该 run 的文件页） */
  openFileAt: (runId: string, file: { stepSpanId: string | null; path?: string }) => void;

  /**
   * U3 会话调试草稿仓库（任务 1.1/1.2/1.3）：调用类（result / system_prompt /
   * user_message / messages）+ 创建表单 + A/B 批次，三区共享会话内单调修订计数器。
   * 只存 renderer 会话内存——不落 localStorage / URL / 日志 / settings / trace，
   * 也不保存授权、凭据或 dry-run 计划（design D1/D4）。
   */
  drafts: DraftRepo;
  /** 读取某编辑目标的草稿条目（无则 undefined；返回仓库内对象，引用稳定） */
  callDraftOf: (key: CallDraftKey) => CallDraftEntry | undefined;
  /**
   * 编辑器打开时登记基线（来自已校验详情的原文）。已存在同 key 条目则原样保留：
   * 不覆盖基线、不推进修订——重开编辑不得覆盖已有输入（design D2）。
   * `source` 为任务 1.4 的源基线（captureCallDraftSource 的产物），只在条目创建时落库。
   */
  ensureCallDraft: (
    key: CallDraftKey,
    baseline: string,
    source?: CallDraftSource,
  ) => CallDraftEntry;
  /**
   * 输入事件**同步**写入原始文本（不得仅靠 debounce/失焦/卸载保存最后一次输入）；
   * 实际内容变化才推进修订。须先 ensureCallDraft——未登记基线的目标不接收写入。
   */
  writeCallDraftText: (key: CallDraftKey, text: string) => void;
  /**
   * U3 任务 1.2：按 key + revision 的放弃校验（CAS）。仅当目标修订与确认时一致才删除；
   * 确认等待期间内容已推进或条目不存在时不动仓库。返回是否真的放弃。
   */
  discardCallDraft: (key: CallDraftKey, expectedRevision: number) => boolean;
  /** 创建表单草稿（会话内单份；null = 默认空表单）；打开创建流程时 ensure */
  createRunDraftOf: () => CreateRunDraftEntry | null;
  ensureCreateRunDraft: () => CreateRunDraftEntry;
  /** 合并写入创建草稿（切模式只传 mode ⇒ 文本保留）；实际内容变化才推进修订 */
  writeCreateRunDraft: (patch: CreateRunDraftPatch) => void;
  /** 放弃创建草稿（CAS）：确认后恢复默认空表单；旧确认不动新修订 */
  discardCreateRunDraft: (expectedRevision: number) => boolean;
  /** A/B 批次草稿读写（稳定行 ID；授权/计划不进草稿） */
  modelAbDraftOf: (key: ModelAbDraftKey) => ModelAbDraftEntry | undefined;
  ensureModelAbDraft: (
    key: ModelAbDraftKey,
    baselineArms: ReadonlyArray<{ model: string; paramsText: string }>,
    source?: CallDraftSource,
  ) => ModelAbDraftEntry;
  /** 整批替换行列表（增删/改内容/重排都经此）；语义不变仅行 ID 变化不推进修订 */
  setModelAbRows: (key: ModelAbDraftKey, rows: ReadonlyArray<ModelAbArmRow>) => void;
  /** 放弃整个 A/B 批次（CAS） */
  discardModelAbDraft: (key: ModelAbDraftKey, expectedRevision: number) => boolean;
  /**
   * 创建源目录的独立受限会话引用（design D4）：仅 main 已签发 token + 核对用
   * name/path。**不属于**草稿仓库：有效期由 main 判定，授权/计划不在此。
   */
  createSourceRef: CreateSourceRef | null;
  setCreateSourceRef: (ref: CreateSourceRef | null) => void;

  /**
   * U3 任务 3.4/3.5：提交关联（renderer 本地，与草稿仓库和授权都分开）。提交时**原子**
   * 取到目标、当前修订与请求快照，据此冻结该草稿的修改/放弃；收尾由既有执行函数负责——
   * 组件卸载、`resetFork`/`resetCreateRun`/`resetModelAb`、展示状态复位都不是解冻依据
   * （design D5）。调用类冻结单个字段，A/B 冻结整批，创建冻结整份。
   */
  draftSubmissions: SubmissionStore;
  /**
   * 开始一次提交：返回关联（快照 `submittedText` + 匹配令牌），目标已有待定提交时返回
   * null（拒绝重复提交，不覆盖旧关联）。调用类提交值必须取自返回的快照，不用组件可能
   * 过期的局部值；A/B 与创建的快照由本动作按同类草稿拼出。
   *
   * U5 任务 4.4：入口可以带上**本次执行确认**（只给目标即可——修订与设置快照由 store
   * 当场取，组件传不进旧值）。带确认的提交在登记前先验一次现场：不是 `confirmed`
   * ⇒ 返回 null，一次 IPC 都不发；通过后这份确认即被消费（重新执行要重新确认）。
   */
  beginDraftSubmission: (input: {
    channel: DraftSubmitChannel;
    target: DraftSubmitTarget;
    /** 已给出的本次确认（缺省 = 该入口尚未接入确认门禁，见 tasks 4.4 边界条） */
    confirmation?: ConfirmationBinding;
  }) => DraftSubmission | null;
  /**
   * 收尾一次提交（解除冻结）：只认令牌相同的关联，旧回调不解冻新提交。仅"已明确有结论"
   * 的路径可调用（响应到达 / 本地校验拒绝）；通道断开等不确定状态保留冻结。
   */
  settleDraftSubmission: (submission: DraftSubmission) => void;
  /**
   * U4 任务 4.2：执行响应到达后**按身份**收尾（spec「核对终态只解冻对应修订」
   * 「迟到回调与未知状态不能错误解冻」）。
   * 判据在 `decideSettle`：回执身份必须等于本次提交绑定的 `epoch`/`operationId` 且已进终态；
   * running、身份不匹配、回执不可信 ⇒ 保留冻结。一律不删草稿。
   */
  finishDraftSubmission: (submission: DraftSubmission, response: ExecutedResponse<unknown>) => void;
  /**
   * U4 任务 4.2/4.5：核对到某身份已进终态时按身份解冻（reconcile 与迟到响应的唯一合法解冻口）。
   * 身份查不到（已结束 / 从未登记）⇒ 状态不变。
   */
  settleDraftByOperation: (identity: { epoch: string; operationId: string }) => void;
  /** 该目标是否被待定提交冻结（冻结期间仓库拒绝写入与放弃） */
  isDraftFrozen: (target: DraftSubmitTarget) => boolean;

  /**
   * U5 任务 4.4：**执行前确认**（会话内凭据，design D2）。
   *
   * 绑"目标 + 草稿修订 + 设置快照 + 检查代次"，任一变化即失效；判据在
   * `lib/execution-confirmation.ts`。它**不授予执行资格**（门禁仍是 U4 的统一槽 +
   * main 的重复校验），也不落盘 / 不进 URL/日志/操作 IPC。
   */
  confirmations: ConfirmationStore;
  /** 只读检查代次（按目标键）：重启检查即推进，旧响应不可安装新确认 */
  checkGenerations: Record<string, number>;
  /**
   * U6 任务 4.10：**来源撤销令牌**（会话内单调递增）。
   * 详情落地为 ownOnly、或预检/执行响应以来源类稳定码拒绝时 +1；
   * 编辑器据此撤销绑定旧父本的 A/B 计划 / capability 结果 / 本次副本授权。
   * 只增不减 ⇒ 父文件恢复不能自动复活（恢复后必须重新检查）。
   */
  sourceRevocation: number;
  /** 当前现场确认绑定：修订与设置快照都由 store 现取，组件传不进旧值 */
  currentConfirmationBinding: (
    channel: DraftSubmitChannel,
    target: DraftSubmitTarget,
  ) => ConfirmationBinding;
  /** 记下一次确认（"已核对目标与边界"） */
  armExecutionConfirmation: (binding: ConfirmationBinding) => void;
  /** 撤销确认：返回编辑、切换对象、进入设置、重新执行、显式放弃都走这个出口 */
  releaseExecutionConfirmation: (target: DraftSubmitTarget) => void;
  /** 该现场现在还算不算已确认（现算，不缓存结论） */
  executionConfirmationReady: (binding: ConfirmationBinding) => boolean;
  /** 重新开始一次只读检查：推进代次并作废既有确认 */
  restartExecutionCheck: (target: DraftSubmitTarget) => void;

  /**
   * U4 任务 4.1：读一次 `operations:status` 并**校验后整份采纳**。
   * 三种结论都保留保守锁：通道失败、载荷不合契约（含不自洽的槽引用）⇒ `unknown`；
   * 旧代次/低登记版本的迟到快照 ⇒ 整份丢弃（不部分采纳所谓成功字段）。
   * 返回采纳后的会话，界面按 `deriveGate` 禁用入口。
   */
  refreshOperationStatus: () => Promise<OperationSession>;
  /**
   * U4 任务 4.5：挂载/重载时的"接着核对"入口——必要时先握手一次，然后**只在确实有在跑的
   * 操作时**排一次单路轮询（空闲不排、失联不排）。
   */
  ensureOperationStatusPolling: () => Promise<OperationSession>;
  /** 任务 4.5：停止自动轮询（手动核对不受它限制；也不重放任何业务 payload） */
  stopOperationStatusPolling: () => void;
  /**
   * U4 任务 4.1/4.5：按 `operationId` 核对一次。**只补该操作的事实与当前槽，
   * 不清 `unknown`**（通信是否恢复只能由完整快照握手确认），
   * 也绝不因"查到旧操作已 settled"而解除别的操作的锁。
   */
  reconcileOperation: (operationId: string) => Promise<OperationSession>;

  /**
   * U5 任务 1.2：按可信身份读取到的**结果读取项**（design D3）。
   * 键为 `(epoch, operationId, runId)`；只存 renderer 会话内存，
   * 不落盘、不进 URL/日志/操作 IPC，也**不是**第二套执行真相源——
   * 它只说明"renderer 看到了哪条已校验的结局"。
   */
  resultReads: ResultReadStore;

  /**
   * U5 任务 3.4：**阅读代次**（design D6）。每次"用户主动换阅读对象或进出覆盖模态"都推进它，
   * 提交时登记的导航意图与它一比就知道用户有没有离开本次流程。
   * ⚠️ 单调递增、永不倒退 ⇒「离开再返回同一位置」不恢复旧资格（位置相等恒成立，代次不等）。
   */
  navGeneration: number;
  /** 本次会话各提交的导航意图（键 = operationId；renderer 内存，不落盘 / 不进 IPC / 不进日志） */
  navIntents: NavigationIntentStore;
  /**
   * U5 任务 1.2：**与导航分离**的结果核实。按 main 登记的 runId 独立读取并校验
   * （归属 → 版本 → schema → 自有终止事件归属），只写本条读取项。
   *
   * ⚠️ 刻意不调 `selectRun`/`reopenRun`，也不刷新列表、不写全局 `error`：
   * 核实一次结局不得改掉用户正在读的运行、页签、调用、滚动或焦点（spec
   * 「列表失败不阻断已知结果」「读取途中离页仍不抢焦点」）。零执行通道调用。
   */
  verifyRunResult: (identity: ResultReadIdentity) => Promise<ResultReadEntry>;
  /**
   * U5 任务 1.3：**显式只读重试**。只对同一条可信 runId 重读详情（`attempt` 递增），
   * 零执行通道调用——"重试读取"绝不复用执行通道、不重发模型请求（spec
   * 「结果不可读只重试同一记录」；重新执行必须换新 operationId 并重新授权）。
   * 与 `verifyRunResult` 的分工：后者对已在读/已核实的身份去重，本动作绕过那道去重。
   */
  retryResultRead: (identity: ResultReadIdentity) => Promise<ResultReadEntry>;

  /**
   * U7 任务 1.4/1.5：比较选择集的**会话读取状态**（design D3 渲染层半边）。
   * 只存 renderer 内存，不落盘、不进 URL/日志；不是执行真相源——比较全程只读。
   * 选择集代次、在飞请求守卫与结论撤销见 `lib/compare-state.ts`。
   */
  compareRead: CompareReadSession;
  /**
   * U7 任务 1.4：进入/更换比较对象并读取。合法性与幂等判据：
   * 非法（数量/重复/空 id）⇒ 不变；与当前选择集同序同 id ⇒ 幂等不重读（保留结论）；
   * 换集 ⇒ 旧结论撤销 + 发起单次 `runs:compare`（旧在飞响应被代次淘汰）。
   * 返回值供调用方与测试区分三分支。
   */
  enterCompareSelection: (
    runIds: readonly string[],
  ) => Promise<"started" | "unchanged" | "invalid">;
  /**
   * U7 任务 1.5：**显式只读重试**——同选择集全量重读（design D3：整组重验保持
   * 共同基线一致）。旧结论先行撤销；无活动选择集时不可重试（返回 false）。
   * 零执行通道调用。
   */
  retryCompareSelectionRead: () => Promise<boolean>;
  /**
   * U7 任务 1.4：离开比较（销毁守卫）。在飞请求作废、结论清空、代次递增——
   * 迟到响应永不复活；不碰选择运行/草稿/操作事实。
   */
  leaveCompare: () => void;

  /**
   * U7 任务 2.2：详细比较的**独立 pair**（父左子右 / 手动加入顺序）。与侧栏
   * 选中项、`compareIds` 全局集合互不决定（D1）；null = 比较工作区无详细比较
   * （单条自有指标 / 引导态）。只存 renderer 会话。
   */
  comparePair: ComparePair | null;
  /**
   * U7 任务 4.8：比较步骤的**复合定位**——左右两列各自的选中调用，身份 =
   * 侧 + run + span。选左不改变右（scenario「重复 span ID 与独立分支不强行
   * 对齐」：两侧重复的 s_01 各归各列）；更换对象清空被换侧，交换随 pair 对调，
   * 换了 pair（新比较集）则两侧全清。
   */
  compareStepSelection: { readonly left: string | null; readonly right: string | null };
  /** U7 任务 4.8：设置某一列的选中调用（null = 取消选中）；只动本侧。 */
  selectCompareStep: (side: "left" | "right", spanId: string | null) => void;
  /**
   * U7 任务 4.14：每侧前缀的折叠态（默认折叠——共同执行部分收进摘要行，
   * 可展开完整前缀）。复位口径与复合定位一致：换 pair 双侧回默认、
   * 更换对象被换侧回默认、交换随 pair 对调。
   */
  comparePrefixFolded: { readonly left: boolean; readonly right: boolean };
  /** U7 任务 4.14：切换某一侧的前缀折叠/展开（只动本侧）。 */
  toggleComparePrefix: (side: "left" | "right") => void;
  /**
   * U7 任务 2.3：比较页的来源位置引用（类型与创建页同形，捕获/恢复复用同一批
   * 判据）。一次性凭据：返回来源即用掉；经 `selectRun` 打开单侧时**保留**——
   * 「打开单侧 → 返回比较 → 再返回来源」的往返要靠它（setView 才清）。
   */
  compareReturnLocation: CompareReturnLocation | null;
  /**
   * U7 任务 2.1/2.5：概览/可信结果的「与父运行对比」入口。父左子右恒定；
   * 无 parent ⇒ hidden（入口不显示），model_params 臂 ⇒ blocked（实验门禁，
   * 不提供普通旁路）。返回值供调用方与测试区分分支。
   */
  openCompareWithParent: (runId: string) => Promise<"opened" | "hidden" | "blocked">;
  /**
   * U7 任务 5.3：从宽幅指标表**显式选择两条**进入详细比较（design D1）。
   * - 两枚 runId 必须互异（相同 ID 不构成两条比较）且都属于当前对照集合
   *   （表列只能来自集合，双保险）；
   * - 显式选择**不改全局集合**（进入/交换不改集合，D1）；
   * - 页内换 pair = 显式换阅读对象 ⇒ 推进阅读代次（2.4 同款）；
   *   步骤选中/折叠随 pair 变更的清理在 `enterCompareView` 内完成。
   */
  openComparePair: (leftRunId: string, rightRunId: string) => Promise<"opened" | "rejected">;
  /**
   * U7 任务 2.2/2.5：从全局对照集合进入比较工作区。恰好两条 ⇒ 按加入顺序
   * （先子在左也是子左父右）；三/四条 ⇒ 不自动选两条（§5.3 显式选择，这里如实
   * 提示后仍进工作区）；零/一条 ⇒ 无详细比较（引导态）。
   */
  openCompareWorkspace: () => Promise<void>;
  /**
   * U7 任务 2.2：更换 pair 的一侧。同 ID 拒绝（两枚 runId 必须互异）、同值幂等；
   * 换成功 ⇒ 推进阅读代次并按新序重读。**不**调 `selectRun`、不动侧栏选择
   * 与全局集合（scenario「更换交换不改变侧栏选择」）。
   */
  setCompareSide: (
    side: "left" | "right",
    runId: string,
  ) => Promise<"replaced" | "unchanged" | "rejected">;
  /** U7 任务 2.2：交换左右。方向、标题、每侧内容随序号同步；推进阅读代次并重读。 */
  swapCompareSides: () => Promise<"swapped" | "none">;
  /**
   * U7 任务 2.3：返回比较的来源页（一次性凭据，恢复/回退都算用掉）。
   * 来源不可用（no-location / run-missing）⇒ 回退到仍有效的来源视图，不选同名运行。
   */
  returnFromCompare: () => Promise<void>;
  /**
   * U7 任务 2.3：从单侧运行/调用回到比较页（打开单侧**不清**来源引用与 pair）。
   * 同 pair 幂等：`enterCompareSelection` 不重读，会话结论与阅读位置保留。
   */
  returnToCompare: () => void;
  /**
   * U7 任务 4.5：比较侧的**单侧错误跳转**——打开目标侧运行并定位其自有失败
   * 调用。spanId 来自该侧已校验详情的错误定位派生（`deriveSideOutputFacts`），
   * 本动作不做二次归属判断；运行不可达（详情读取失败）⇒ false，由视图给
   * 回退说明。打开单侧按 2.3 保留 pair 与来源引用 ⇒ 「返回比较」仍成立。
   */
  openCompareSideError: (runId: string, llmCallSpanId: string) => Promise<boolean>;
  /**
   * U7 任务 5.6/5.7：**分别打开左右侧文件页**（design D6）。
   * - 能力判据用比较响应里该侧的**已校验详情**（isIsolatedRun），普通运行
   *   ⇒ unsupported（不造文件历史、不借当前选中 run 冒充）；
   * - 该侧若有选中的比较步骤，仅**合法自有完成步骤**（leafSpanIds 内 agent.step）
   *   写成文件检查点定位目标，否则不写、走 U2 已保存位置/默认规则；
   * - 落地判据与 `openCompareSideError` 同款（selectRun 后详情读出且归属相符）；
   *   打开单侧保留 pair 与来源引用 ⇒ 「返回比较」仍成立（2.3）。
   */
  openCompareSideFiles: (side: "left" | "right") => Promise<"opened" | "unsupported" | "failed">;

  /**
   * U7 任务 3.1/3.2/3.3：分支树的**会话观察状态**（design D2——视口是观察参数，
   * 逻辑布局永不在 store 里重排）。null = 本会话尚未进入过树（首次进入由
   * `decideTreeInitialFocus` 决定初始范围与焦点）。
   */
  treeScope: TreeScope | null;
  /** U7 3.2：树内搜索词（完整 ID/任务匹配在渲染层复用 matchesSearch；空串 = 未搜索） */
  treeQuery: string;
  /** U7 3.3：会话视口（缩放档 + 滚动位置）；返回树恢复，显式定位才改写 */
  treeViewport: TreeViewport | null;
  /** U7 3.1：首次进入时对初始范围的处置（幂等：已初始化则沿用，不重复居中） */
  armTreeSession: () => { scope: TreeScope; focusRunId: string | null };
  /** U7 3.1/3.2：显式切换范围（当前树/全部）——观察参数变化，不推进阅读代次 */
  setTreeScope: (scope: TreeScope) => void;
  /** U7 3.2：更新搜索词（不丢原选择；空结果在渲染层明确提示） */
  setTreeQuery: (query: string) => void;
  /** U7 3.3：记录视口（滚动/缩放/适应画布/定位都落这里，返回树据此恢复） */
  setTreeViewport: (viewport: TreeViewport) => void;
  /**
   * U7 3.6：树的呈现模式（图 / 关系列表）。会话内状态——从列表打开某运行再返回，
   * 仍停留在列表模式（scenario「返回保留来源模式」）；与范围/搜索/视口一样不落盘。
   */
  treeMode: "graph" | "list";
  setTreeMode: (mode: "graph" | "list") => void;

  /**
   * U5 任务 3.5：**用户明确打开某条可信结果**。
   *
   * 与 3.4 的自动导航分开：那条要过导航意图（离开过流程就不跳），这条**不过**——
   * 用户点了就是要去看。仍走既有 `selectRun`（恢复该 run 自己的阅读状态），不另写落地逻辑。
   * 顺带把该条通知标成已看（3.6 的去重）。
   */
  openOperationResult: (identity: ResultReadIdentity) => Promise<void>;
  /**
   * U5 任务 3.5：**失败定位只到真实自有调用**。
   *
   * 判据取 `deriveOwnTerminalFacts` 的 `failure`（`deriveErrorTarget` 已在 `leafSpanIds` 内找）；
   * 拿不到自有失败 span ⇒ 返回 false 且**一点也不动页面**——绝不跳祖先的错误调用、
   * 绝不跳"最后一个调用"凑数。诚实说明由视图给（`lib/operation-result-view` 的 `failureNote`）。
   */
  openOperationFailure: (identity: ResultReadIdentity) => Promise<boolean>;
  /**
   * U5 任务 3.5：**返回该提交对应的草稿**（复用既有草稿定位通道）。
   *
   * 目标键按身份查：先看待定关联（还在跑/未接受时正文与关联都在），再看收尾关联（解冻后）。
   * 草稿已被清理或从未登记 ⇒ 返回 false，由视图给回退说明；**不复活**旧内容，也不恢复旧授权。
   */
  returnOperationDraft: (identity: {
    epoch: string;
    operationId: string;
  }) => Promise<boolean>;
  /**
   * U5 任务 3.5：该操作对应的草稿**是否仍在**（面板据此决定给不给「返回草稿」）。
   * 按身份找回目标键（待定关联优先，其次收尾关联）后再查草稿仓库 ——
   * 与清理判据同一份仓库，不建"我以为还在"的第二套存在性。
   */
  isOperationDraftPresent: (identity: { epoch: string; operationId: string }) => boolean;

  /**
   * U5 任务 3.6：**已看过的结果通知键**（会话内）。
   * 通知本身是**现算派生**（组件用 `deriveResultNotices` 从订阅状态算），这里只存"哪些键已看过"，
   * 不存在通知队列 ⇒ 重复快照不可能堆出第二份（红线「数据派生不累积」）。
   */
  seenNoticeKeys: Readonly<Record<string, true>>;
  /** 标记为已看（展开操作面板、或用户明确打开某条结果时调用）；无变化 ⇒ 引用不变 */
  markNoticesSeen: (keys: readonly string[]) => void;

  /**
   * U3 任务 2.5：一次性草稿定位目标（草稿列表「定位」动作的载体，与 U2 的
   * pendingFileTarget 同法）。由对应编辑器消费一次后经 `consumeDraftTarget` 清空；
   * 定位失败（运行不可达 / span 不在详情）时保留——列表的复制/放弃仍可用。
   */
  pendingDraftTarget: { runId: string; spanId: string | null; field: DraftKind } | null;
  /**
   * 定位一个草稿条目：创建类 = 打开创建对话框（表单读草稿恢复）；
   * 调用类 = 切到该运行（需要时）+ 步骤页签 + 选中该 span，pending 交编辑器消费。
   */
  openDraftAt: (target: {
    runId: string;
    spanId: string | null;
    field: DraftKind;
  }) => Promise<void>;
  /** 编辑器消费定位目标后清空（一次性；旧目标不抢新页面） */
  consumeDraftTarget: () => void;

  /**
   * 编辑某 tool.invoke 的 result 并重跑；成功刷新列表并自动选中新 run。
   * `execution` 仅隔离父本携带（本次显式 `allowFileWrites:true`）——不传时请求里
   * **不出现该键**，普通父本走既有普通重跑，隔离父本会被 main/core 拒绝（不降级）。
   */
  /**
   * result 分叉重跑（普通父本不带 `execution`；隔离父本必带）：只交代**请求事实**。
   * U5 任务 3.2：不再在 ok 后刷列表 / 选中新 run（见函数体注记）。
   */
  forkAt: (
    parentRunId: string,
    atSpanId: string,
    value: string,
    execution?: IsolatedExecutionMode,
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * 隔离续跑的只读预检（确认区的唯一数据源）：不创建运行、不写文件、不请求模型。
   * 返回判别式联合而不是全局状态——确认区是**单个编辑器**的局部状态（与 2.1 的
   * chooseSource 同法），避免"两个编辑器抢同一份错误状态"。
   */
  loadForkCapability: (
    request: ForkCapabilityRequest,
  ) => Promise<
    { ok: true; data: ForkCapabilityResult } | { ok: false; code: string; message: string }
  >;
  /** prompt fork：编辑启动上下文（system prompt / 首条 user message）从头重跑 */
  promptFork: (
    parentRunId: string,
    edit: PromptForkRequest["edit"],
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * 模型 A/B：dryRun = true 走**只读预览通道**（不占槽、不登记、不联网、不写文件，返回计划）；
   * 真实执行只交代请求事实并返回信封里的计划/结果 —— U5 任务 3.3 起不再在入口刷列表，
   * 各臂结局由终态消费按登记的 `runIds`/`arms` 逐条核实（返回的 ids 不是"哪条臂成功"的结论）。
   */
  modelAb: (
    parentRunId: string,
    arms: ModelAbArm[],
    dryRun: boolean,
    /** U3 任务 3.5：真实执行的提交关联（整批）；预览不传——预览不是提交 */
    submission?: DraftSubmission,
  ) => Promise<ModelAbResult | null>;
  /** 打开新的 A/B 编辑前复位状态 */
  resetModelAb: () => void;
  /** A/B 实验进行中（与 fork 状态分离，两者可并存于不同编辑器） */
  modelAbInFlight: boolean;
  modelAbError: string | null;
  modelAbErrorCode: string | null;
  /** 打开新的分叉编辑前复位状态 */
  resetFork: () => void;

  /**
   * 新建运行（runs:create）：从头执行一个原生 run（纯对话与隔离文件两态同一入口）。
   * 请求由 `lib/create-run.ts` 的 `resolveCreateRunSubmission` 构造（判据与请求同源），
   * store 只负责透传与**请求**状态机。
   *
   * U5 任务 3.1：这里不再消费响应——旧实现在 ok 后 `loadRuns()` + `selectRun(信封里的 id)`，
   * 失败分支也自己刷一次列表。三者都已移除：
   * - 列表刷新与结果核实归**终态消费唯一落点**（`consumeSettledOperations`：回执 → status →
   *   整批至多一次刷新 → 按登记的可信 `runIds` 串行核实），所以编辑器关不关、
   *   响应先到还是轮询先到都不影响收尾；
   * - 失败运行的可见性同一条路：main 在执行开始时就把 runId 挂到该操作上（`onRunIdentified`），
   *   信封失败不改变登记事实 ⇒ 仍按可信 ID 刷列表、读详情，而不是解析错误文案里的 id；
   * - 是否切到新 run 的概览属**导航意图**（任务 3.4），入口一概不做。
   * 返回值只表示"请求是否被明确接受并返回"（供表单交出输入面），**不是**运行结局。
   */
  createRun: (
    request: CreateRunRequest,
    /** U3 任务 3.5：本次创建的提交关联（整份表单）——执行函数负责收尾 */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * 原生目录选择（只读辅助通道，B 1.3）：阻塞至用户选完或取消。
   * 返回 main 的结论（取消为 `{canceled:true}`）；通道失败或结构不合法返回 null 并置 error。
   * 本方法**不签发、不保存**任何授权——副本写入必须由对话框本次显式勾选。
   */
  chooseSource: () => Promise<ChooseSourceResult | null>;
  /** 打开"新建运行"对话框前复位状态 */
  resetCreateRun: () => void;

  /**
   * 隔离**文件检查点**的只读通道（C 1.1/1.2）：
   * - `inspectWorkspace` 取某检查点的清单（省略 stepSpanId = 本 run 初始快照）
   * - `readWorkspaceFile` 读清单内某条逻辑路径的内容
   * 两者都不写任何文件、不调 LLM/工具；失败返回判别式联合而不是全局错误状态，
   * 因为文件视图是**单个面板**的局部状态（与 loadForkCapability 同法）。
   */
  inspectWorkspace: (
    request: WorkspaceInspectRequest,
  ) => Promise<
    { ok: true; data: WorkspaceInspectResult } | { ok: false; code: string; message: string }
  >;
  readWorkspaceFile: (
    request: WorkspaceReadFileRequest,
  ) => Promise<
    { ok: true; data: WorkspaceReadFileResult } | { ok: false; code: string; message: string }
  >;

  loadSettings: () => Promise<boolean>;
  saveSettings: (input: SettingsInput) => Promise<SettingsSaveOutcome>;
  clearSettings: () => Promise<boolean>;

  loadProxyStatus: () => Promise<void>;
  /** 启停即保存（端口/upstream 一并生效）；失败返回 null 并在 error 里给出原因 */
  toggleProxy: (input: ProxyToggleInput) => Promise<ProxyState | null>;
  setSourceFilter: (filter: "all" | "proxy" | "local") => void;

  /** 切换主区域视图（轨迹 / 分支树）；只改 UI 状态，不触发列表重新加载（design D7） */
  setView: (view: SourceView) => void;
  /**
   * 打开创建工作区（全局栏与列表标题区**共用**这一个动作，U5 任务 4.1）。
   * 从别的工作区进来 ⇒ 以当时阅读位置重记来源并推进阅读代次；已在创建页 ⇒ 什么都不动
   * （来源沿用，任务 3.4 的自动导航资格因此不被"重复点击"撤销）。
   */
  openCreateWorkspace: () => void;
  /**
   * 返回本次创建的来源位置（spec 场景「创建工作区任务优先且可返回来源」）。
   * 来源失效（重载 / 运行已不在列表）⇒ 回退到已有可用工作区，不伪造旧位置。
   * 与创建草稿无关：返回不动输入内容，也不解任何冻结。
   */
  returnToCreateSource: () => Promise<void>;
  /**
   * U8 任务 1.3：打开录制工作区（全局页，无运行目标；空态 / 全局栏 / 设置 / 缺凭据提示共用）。
   * 进入/沿用语义与创建页一致；已在录制页 ⇒ 什么都不动。
   */
  openRecordingWorkspace: () => void;
  /**
   * U8 任务 1.3：打开实验工作区并**显式绑定目标**（父 runId + 首次自有 llm.call spanId）。
   * 已在实验页 ⇒ 来源沿用；换目标只能经显式进入动作（含页内对另一目标的入口点击），
   * 侧栏选择/切运行不改目标、不换页面的编辑对象。
   */
  openExperimentWorkspace: (target: ExperimentTarget) => void;
  /** U8 任务 1.3：打开 messages 工作区并显式绑定目标（代理 runId + 自有 llm.call spanId）。 */
  openMessagesWorkspace: (target: MessagesTarget) => void;
  /**
   * U8 任务 1.3：返回某辅助工作区的来源位置（一次性凭据，恢复与回退都算用掉）。
   * 来源失效（重载 / 运行已不在列表）⇒ 回退已有可用工作区并保留草稿，不伪造旧位置。
   */
  returnToAuxSource: (view: AuxWorkspaceView) => Promise<void>;
  /** U8 任务 2.1：写入录制草稿字段（原始文本无损；修订按实际变化推进） */
  writeRecordingDraftFields: (patch: RecordingDraftPatch) => void;
  /** U8 任务 2.2：按修订 CAS 明确放弃录制草稿（旧确认不能删除新输入；零配置写调用） */
  discardRecordingDraftConfirmed: (expectedRevision: number) => boolean;
  /**
   * U8 任务 2.5：保存并应用（toggle）→ 随后**一律回读**真实状态（toggle 非事务：
   * 可能已保存但监听失败——不伪造回滚）。非法字段不接受（纵深防御，组件判据同源）；
   * 在飞期间拒绝重复应用；响应只在修订匹配时更新基线（2.6）。
   */
  applyRecordingDraft: () => Promise<"applied" | "start-failed" | "invalid" | "busy" | "no-draft">;
  /**
   * U8 任务 3.1b：实验目标的**父本源读取**（只读 `runs:get`）。
   * 目标不跟随侧栏选择 ⇒ 工作区不能借用全局 `detail`；本读取不改选中项、
   * 不切页、不碰阅读状态——失败保留旧读取项并允许只读重试。
   */
  experimentSource: ExperimentSourceState;
  readExperimentSource: () => Promise<void>;
  /**
   * U8 任务 5.1b：messages 工作区目标的**源读取**（只读 `runs:get`），判据与
   * experimentSource 同形——目标不跟随侧栏选择 ⇒ 工作区不能借用全局 `detail`；
   * 本读取不改选中项、不切页、不碰阅读状态；失败保留旧读取项并允许只读重试。
   */
  messagesSource: ExperimentSourceState;
  readMessagesSource: () => Promise<void>;
  /** 打开设置并定位到某分区（全局栏「录制接入」用），null = 常规打开 */
  setSettingsSection: (section: "proxy" | null) => void;
  /** 勾选/取消对照（上限 4，超出不加入并给出提示） */
  toggleCompare: (runId: string) => void;
  clearCompare: () => void;
  /**
   * 代理 run 的 messages 单请求重发（`proxy:fork`）：只交代**请求事实**。
   * U5 任务 3.3：与 result / prompt 同形——不再"成功刷新列表并自动选中新 run"；
   * 列表刷新与按可信 ID 核实归终态消费点，是否进入新 run 概览归导航意图（任务 3.4）。
   */
  proxyFork: (
    parentRunId: string,
    atSpanId: string,
    messages: Record<string, unknown>[],
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
}

/** 跨进程数据不可信：统一用 schema 校验后再进状态 */
function describeZodError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 门禁禁用原因 → 稳定码 + 中文文案（renderer 本地结论，请求一次都没发出） */
const LOCAL_BLOCKED: Record<OperationBlockedBy, { code: string; message: string }> = {
  not_handshaked: {
    code: "MAIN_HANDSHAKE_REQUIRED",
    message: "尚未与主进程完成操作握手，本次请求未发送；请重试或重新加载窗口",
  },
  communication_unknown: {
    code: "OPERATION_STATE_UNKNOWN",
    message: "操作状态未确认（状态通道失联或返回非法结构），本次请求未发送；请先核对状态",
  },
  closing: {
    code: "OPERATION_CLOSING",
    message: "应用正在退出协商，本次请求未发送",
  },
  configuration_busy: {
    code: "OPERATION_CONFIGURATION_BUSY",
    message: "运行配置或代理服务正在变更，本次请求未发送；请等变更完成后重试",
  },
  operation_running: {
    code: "OPERATION_BUSY",
    message: "已有操作在执行（或尚未确认结束），本次请求未发送；请等当前操作结束",
  },
};

/**
 * 执行响应的回执核验（任务 4.1「非法操作响应不能解除门禁」的落点）：
 * `ok:true` 但没有可信回执、或回执身份不是我们刚发出的那一次 ⇒ 一律按**未知**处理，
 * 不部分采纳所谓成功字段（调用方因此不会解冻草稿、不会把本地锁当已释放）。
 */
function inspectAck(
  response: ExecutedResponse<unknown>,
  identity: PendingSubmission,
): { readonly ack: OperationAck | null; readonly problem: string | null } {
  if (response.operation === null || response.operation === undefined) {
    return { ack: null, problem: "响应缺少操作回执" };
  }
  const parsed = OperationAckSchema.safeParse(response.operation);
  if (!parsed.success) {
    return { ack: null, problem: `操作回执结构不合法：${describeZodError(parsed.error)}` };
  }
  if (parsed.data.epoch !== identity.epoch || parsed.data.operationId !== identity.operationId) {
    return { ack: null, problem: "操作回执身份与本次提交不匹配" };
  }
  return { ack: parsed.data, problem: null };
}

// ---------------------------------------------------------------------------
// 单路有界轮询（任务 4.5）：判据在 `lib/operation-polling.ts`，这里只管那一个计时器。
// 轮询**只读 status**，绝不重放业务 payload（重放等于自动重发，spec 明令禁止）。
// ---------------------------------------------------------------------------

let pollState: PollState = initialPollState();
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function pollContextOf(session: OperationSession): PollContext {
  return {
    // 本地未确认终态的提交也算"还在跑"：回执丢失时正是需要核对的时候。
    // 任务 4.6：只数**同 epoch** 的在飞身份——旧会话的未知历史该被核对，但不该永远锁住新会话。
    hasActive: session.activeOperationId !== null || hasSameEpochPending(session),
    unknown: session.unknown,
  };
}

/** 任何一步都先清掉旧定时器 ⇒ 同一时刻至多一个待触发的轮询 */
function applyPollStep(step: PollStep): void {
  pollState = step.state;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (step.action.type === "arm") {
    const delay = step.action.delayMs;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void runStatusPoll();
    }, delay);
  }
}

/** 停止自动轮询（保留在飞守卫；手动核对不受它限制） */
export function stopOperationStatusPolling(): void {
  applyPollStep({ state: disarmPoll(pollState), action: { type: "none" } });
}

async function runStatusPoll(): Promise<void> {
  const step = onTimerFired(pollState, pollContextOf(useAppStore.getState().operations));
  pollState = step.state;
  if (step.action.type !== "poll") return;
  const session = await useAppStore.getState().refreshOperationStatus();
  applyPollStep(onPollSettled(pollState, pollContextOf(session), !session.unknown));
}

/** 可信响应/握手之后重新计时（计时起点是"响应完成"，慢响应不会堆积） */
function rescheduleStatusPoll(): void {
  applyPollStep(onResponseSettled(pollState, pollContextOf(useAppStore.getState().operations)));
}

/**
 * 主动执行的统一提交适配器（U4 design D6，tasks 4.1/4.2/4.3 的适配器半边）。
 *
 * 所有主动入口都走这里：读会话门禁 → 新生成 operationId → 包成 `{operation, request}` →
 * 交给对应通道。operationId **每次提交都新**（含失败重试——重试不复用被封禁/已结束的
 * 许可，见 spec「新执行 SHALL 使用新 ID」）。响应原样返回给调用方，由它按
 * 「身份 + 登记版本 + 状态」处理草稿冻结，而不是把裸 `ok/fail` 当操作结局。
 *
 * 门禁（任务 4.1）：
 * - 尚未握手 ⇒ 补一次握手，仍不可用就按**本地未发送**处理（不冻结草稿、不进 Unknown）；
 * - 通信未知 / 关闭协商 / 配置变更中 / 已有操作在飞（含本地尚未确认的提交）⇒ 同样本地拒发。
 *   main 返回 busy 仍是最后防线，界面不能靠"发不出去才报错"当门禁。
 * - 通道抛错 ⇒ 请求是否被 main 接受**不可知**：置 Unknown 并保留该在飞身份，
 *   绝不自动重发（下一次有效 status 才会确认）。
 */
async function submitActive<TRequest, TResponse>(
  call: (request: ExecutedRequest<TRequest>) => Promise<ExecutedResponse<TResponse>>,
  business: TRequest,
  /** U4 任务 4.2：带草稿关联的提交用**关联里已生成的** operationId（身份与快照同步定下） */
  submission?: DraftSubmission,
): Promise<ExecutedResponse<TResponse>> {
  if (deriveGate(useAppStore.getState().operations).blockedBy === "not_handshaked") {
    await useAppStore.getState().refreshOperationStatus();
  }
  const blocked = deriveGate(useAppStore.getState().operations).blockedBy;
  if (blocked !== null) {
    const { code, message } = LOCAL_BLOCKED[blocked];
    return { ok: false, operation: null, error: { code, message } };
  }
  const epoch = useAppStore.getState().operations.epoch as string;
  const identity: PendingSubmission = {
    epoch,
    // 关联里已生成的 operationId 就是本次提交的身份；没有关联（如 dryRun/预览）才另起
    operationId: submission?.operationId ?? crypto.randomUUID(),
    // U5 任务 5.2：本地提交时刻——等待计时的首选基准（会话内存，不进 IPC 信封）
    submittedAt: Date.now(),
  };
  // 关联的 epoch 在真正发出的这一刻绑定（此前它可能是 null = 还没握上手）
  if (submission !== undefined && submission.epoch !== epoch) {
    useAppStore.setState((state) => ({
      draftSubmissions: submissionLib.bindSubmissionEpoch(
        state.draftSubmissions,
        submission,
        epoch,
      ),
    }));
  }
  useAppStore.setState((state) => ({
    operations: beginLocalSubmission(state.operations, identity),
  }));
  let response: ExecutedResponse<TResponse>;
  try {
    // 信封 identity 只带契约里的两键（main 侧 OperationIdentitySchema 是 strict 的，
    // 多一个 submittedAt 都会被判非法形状）——本地时间事实不跨进程外带。
    response = await call({
      operation: { epoch: identity.epoch, operationId: identity.operationId },
      request: business,
    });
  } catch (error) {
    // 未知：保留在飞身份并保守锁住（不重发、不解冻、不假装结束）
    useAppStore.setState((state) => ({ operations: markUnknown(state.operations) }));
    // 任务 4.5：失联 ⇒ 自动轮询停下（手动核对仍可用），不靠重试打爆通道
    stopOperationStatusPolling();
    throw error;
  }
  if (!response.ok && response.error.code === OPERATION_ERROR.staleEpoch) {
    // 新 main 会话：旧 epoch 的响应不采纳。旧身份**不销账**——它的结局仍是未知（任务 4.6）
    useAppStore.setState((state) => ({ operations: markUnknown(state.operations) }));
    // 任务 4.5：状态未确认 ⇒ 停下自动轮询，等用户/下一次握手来核对
    stopOperationStatusPolling();
    return response;
  }
  // 任务 4.6：会话已经换过（epoch 与发出时不同）⇒ 这条迟到的旧响应不得解冻、不得导航、
  // 也不得把会话状态回退。⚠️ 这里**不标通信未知**：新会话的状态刚由一次有效握手确认过，
  // 未知的是"旧那次提交的结局"（永久未知）——把它标成通道失联会连带锁死新会话。
  if (useAppStore.getState().operations.epoch !== identity.epoch) {
    return {
      ok: false,
      operation: null,
      error: {
        code: "OPERATION_SESSION_SWITCHED",
        message: "主进程会话已更换：这次提交（属旧会话）的结局未知，不会自动重发，也不会跳转结果",
      },
    };
  }
  // U6 任务 4.10：main 以来源类稳定码拒绝（父本 ownOnly / 详情不可读）⇒
  // renderer 同步撤销绑定旧父本的可提交状态（检查代次推进 + 确认清空 + 撤销令牌 +1），
  // 恢复必须重新检查；草稿正文不受影响（拒绝不等于放弃输入）。
  if (!response.ok && isLineageRejectionCode(response.error.code)) {
    revokeSourceBoundPermissions();
  }
  // 回执核验：可信回执才销账；缺回执 / 回执身份不匹配 ⇒ 未知（不部分采纳成功字段）
  const { ack, problem } = inspectAck(response as ExecutedResponse<unknown>, identity);
  if (problem !== null || ack === null) {
    useAppStore.setState((state) => ({ operations: markUnknown(state.operations) }));
    return {
      ok: false,
      operation: null,
      error: {
        code: "OPERATION_ACK_INVALID",
        message: `执行响应的操作回执不可信（${problem}）：本次执行状态未确认，请核对状态`,
      },
    };
  }
  if (ack.state !== "running") {
    useAppStore.setState((state) => ({
      operations: endLocalSubmission(state.operations, identity.operationId),
    }));
    /**
     * U5 任务 1.4：拿到**可信终态回执**就立刻取一次 status——`runIds` 只存在于登记快照里，
     * 回执本身只说明"这条操作结束了"。刷新后由 `consumeSettledOperations` 统一收尾，
     * 于是"响应到达"与"轮询/核对到达"走的是同一条核实路径（spec「所有入口实际使用同一适配器」）。
     */
    await useAppStore.getState().refreshOperationStatus();
  }
  // 任务 4.5：计时起点是"这次响应完成"——批次/长请求在飞期间不叠加定时请求
  rescheduleStatusPoll();
  return response;
}

/**
 * 一次按可信 ID 核实结果的实际读取（U5 任务 1.2/1.3）。
 *
 * 三条判据都落在这里，组件无从各写一套：
 * - **去重**（`force=false`）：该身份已在读或已核实 ⇒ 直接交回在场的结论，不发第二次请求
 *   （轮询返回全量快照，逐次快照都重读会把 IO 放大，design 风险段第 3 条）；
 * - **代次**：每次实际读取都递增 `attempt`，响应落地只认当代——期间有人重试 ⇒
 *   这条迟到的旧结论整份丢弃，不覆盖新读取、也不碰其他键（spec「旧读取响应不能污染其他结果」）；
 * - **只读**：整条路径只走 `runs:get`，零执行通道、零列表刷新、零选择/滚动/焦点变更。
 */
async function readRunResult(
  identity: ResultReadIdentity,
  force: boolean,
): Promise<ResultReadEntry> {
  const current = resultReadOf(useAppStore.getState().resultReads, identity);
  if (!force && resultReadAlreadySettledOrInFlight(current)) return current as ResultReadEntry;
  const started = beginResultRead(useAppStore.getState().resultReads, identity);
  useAppStore.setState({ resultReads: started.store });
  const verification = verifyResultPayload(identity.runId, await api.getRun(identity.runId));
  useAppStore.setState((state) => ({
    resultReads: finishResultRead(state.resultReads, identity, started.attempt, verification),
  }));
  // U5 任务 2.2/2.5：读取结论一落地就**立刻**尝试按修订收尾——自动核实、显式只读重试、
  // 面板收起后的轮询都走这一处，组件挂不挂载与它无关（收尾不留在 `.then()` 里）。
  closeDraftClosureFor(identity);
  // 守卫丢弃本次结论时，交回界面上真正在场的那一条（调用方据此呈现，绝不拿废结论去导航）
  return resultReadOf(useAppStore.getState().resultReads, identity) as ResultReadEntry;
}

/**
 * U7 任务 1.4/1.5：一次比较选择集的实际只读请求（design D3 渲染层半边）。
 *
 * 单一咽喉：进入与重试都汇到这里——发请求前记录当代代次，响应落地时把
 * 代次 + 选择集 + 信封一起交给 `applyCompareResponse`（同代次同选择集才采信，
 * 其余整份丢弃）。整条路径零执行通道、零列表刷新、零选择/滚动/焦点变更。
 */
async function requestCompareRead(runIds: readonly string[], generation: number): Promise<void> {
  const envelope = await api.compareRuns({ runIds: [...runIds] });
  useAppStore.setState((state) => ({
    compareRead: applyCompareResponse(state.compareRead, generation, runIds, envelope),
  }));
}

/**
 * U7 2.3：进入比较视图的公共落点（父子入口 / 手动集合共用）。
 *
 * - 页内重复进入：来源沿用、代次不推进（与创建页同一纪律——设置往返/重复点击
 *   不该把本次流程的导航资格撤销掉）；
 * - 跨视图进入：现记来源位置 + 推进阅读代次（显式阅读意图，D1）；
 * - pair 非空时按新序触发 `enterCompareSelection`（换集重读 / 同集幂等都在那里判）。
 */
async function enterCompareView(pair: ComparePair | null): Promise<void> {
  const state = useAppStore.getState();
  const alreadyInCompare = state.view === "compare";
  // U7 4.8：prev pair 必须在 setState 前取——换了 pair（新比较集）两侧步骤选中全清
  const prevPair = state.comparePair;
  let location: CompareReturnLocation | null = null;
  if (!alreadyInCompare) {
    const decision = decideCreateEntry({
      view: state.view,
      selectedRunId: state.selectedRunId,
      reading:
        state.view === "trace" && state.selectedRunId !== null
          ? readingStateOf(state.readingByRun, state.selectedRunId)
          : null,
    });
    // decideCompareEntry 的 keep 分支已在上面判掉；这里只可能是 capture
    if (decision.kind === "capture") location = decision.location;
    noteReadingChanged();
  }
  useAppStore.setState({
    view: "compare",
    ...(alreadyInCompare ? {} : { compareReturnLocation: location }),
    // 6.4 实机坐实：集合进入（0/1/3/4 条）必须清 pair——pair 残留会让工作区卡在
    // 「正在读取详细比较对象…」（结论 runIds 与残留 pair 永不对齐，重试也出不来）。
    // design 2.2 的「无 pair」语义 = comparePair 置 null（指标表模式承载）。
    comparePair: pair,
  });
  if (pair !== null) {
    const changed =
      prevPair === null ||
      prevPair.leftRunId !== pair.leftRunId ||
      prevPair.rightRunId !== pair.rightRunId;
    if (changed) {
      useAppStore.setState({
        compareStepSelection: { left: null, right: null },
        comparePrefixFolded: { left: true, right: true },
      });
    }
    await useAppStore.getState().enterCompareSelection([pair.leftRunId, pair.rightRunId]);
  }
}

/**
 * U7 2.3：按来源引用恢复阅读位置（创建页与比较页的"返回来源"共用——不抄第二份）。
 *
 * 该 run 本来就选中 ⇒ 用既有阅读动作当场对齐（页签/调用/文件定位）；
 * 换运行 ⇒ 先把位置写成该 run 的会话阅读状态，再走 `selectRun`——它自带
 * "按详情校验 + 失效回退"，这里不重复判有效性（判了也不认）。
 */
async function restoreReadingLocation(
  location: Pick<CreateReturnLocation, "runId" | "tab" | "spanId" | "file">,
): Promise<void> {
  const { runId } = location;
  // 无运行可恢复（来源视图不承载单运行位置）⇒ 视图已恢复，无事可做
  if (runId === null) return;
  if (useAppStore.getState().selectedRunId === runId) {
    // 该 run 本来就选中：没有"恢复"这一步可借，直接用既有的阅读动作当场对齐
    if (
      location.tab !== null &&
      readingStateOf(useAppStore.getState().readingByRun, runId).tab !== location.tab
    ) {
      useAppStore.getState().setReadingTab(runId, location.tab);
    }
    const liveSpan = liveSpanOfLocation(
      location,
      (useAppStore.getState().detail?.spans ?? []).map((span) => span.id),
    );
    if (liveSpan !== null && useAppStore.getState().selectedSpanId !== liveSpan) {
      useAppStore.getState().selectSpan(liveSpan);
    }
    const filePatch = filePatchOfLocation(location);
    const liveFile = fileReadingOf(readingStateOf(useAppStore.getState().readingByRun, runId));
    if (
      filePatch !== null &&
      (liveFile.checkpoint !== filePatch.checkpoint || liveFile.path !== filePatch.path)
    ) {
      useAppStore.getState().setFileReading(runId, filePatch);
    }
    return;
  }
  // 换运行：先把位置写成该 run 的会话阅读状态，再走 `selectRun`（判据同上）
  const readingPatch = readingPatchOfLocation(location);
  if (Object.keys(readingPatch).length > 0) {
    useAppStore.setState((current) => ({
      readingByRun: patchReadingState(current.readingByRun, runId, readingPatch),
    }));
  }
  const filePatch = filePatchOfLocation(location);
  if (filePatch !== null) {
    useAppStore.setState((current) => ({
      readingByRun: patchFileReading(current.readingByRun, runId, filePatch),
    }));
  }
  await useAppStore.getState().selectRun(runId);
}

/**
 * U8 任务 1.3：从 store 现场构造辅助工作区进入判据的快照
 * （与 `enterCompareView` / `openCreateWorkspace` 的现场取法同一形状，不抄第二份字段挑选）。
 */
function auxEntrySnapshot(): ReadingLocationSnapshot {
  const state = useAppStore.getState();
  return {
    view: state.view,
    selectedRunId: state.selectedRunId,
    reading:
      state.view === "trace" && state.selectedRunId !== null
        ? readingStateOf(state.readingByRun, state.selectedRunId)
        : null,
  };
}

/** 三个辅助工作区的来源引用与视图的对应（唯一映射，open/return 两处共用） */
function auxLocationKey(
  view: AuxWorkspaceView,
): "recordingReturnLocation" | "experimentReturnLocation" | "messagesReturnLocation" {
  return view === "recording"
    ? "recordingReturnLocation"
    : view === "experiment"
      ? "experimentReturnLocation"
      : "messagesReturnLocation";
}

/** 实验页/messages 页各自的目标状态键（recording 无目标，不进此映射） */
function auxTargetKey(view: AuxWorkspaceView): "experimentTarget" | "messagesTarget" | null {
  return view === "experiment" ? "experimentTarget" : view === "messages" ? "messagesTarget" : null;
}

/**
 * U8 任务 1.3：进入辅助工作区的公共落点（录制 / 实验 / messages 共用）。
 * - 页内重复进入：来源沿用、代次不推进（设置往返视图未变 ⇒ 同一判据覆盖）；
 *   目标仍按本次显式请求写入（同一目标幂等；不同目标 = 用户显式换目标）；
 * - 跨视图进入：现记来源位置 + 推进阅读代次 + 显式绑定目标；
 * - recording 无目标：目标状态永不触碰。
 */
function enterAuxWorkspace(
  view: AuxWorkspaceView,
  target: ExperimentTarget | MessagesTarget | null,
): void {
  const decision = decideAuxEntry(view, auxEntrySnapshot());
  const targetKey = auxTargetKey(view);
  const targetPatch = target === null || targetKey === null ? {} : { [targetKey]: target };
  if (decision.kind === "keep") {
    useAppStore.setState(targetPatch);
    return;
  }
  // 进入辅助页 = 离开原来在看的那条运行 ⇒ 撤销在飞的自动导航资格
  noteReadingChanged();
  useAppStore.setState({
    view,
    [auxLocationKey(view)]: decision.location,
    ...targetPatch,
  });
}

/** U8 3.1b：实验目标父本源的四态（idle = 换目标后待读取） */
export interface ExperimentSourceState {
  readonly phase: "idle" | "reading" | "ready" | "failed";
  readonly detail: RunDetail | null;
  readonly errorMessage: string | null;
}

/** U8 3.1b：初值（换目标/复位共用同一形状） */
export function idleExperimentSource(): ExperimentSourceState {
  return { phase: "idle", detail: null, errorMessage: null };
}

/**
 * 提交目标 → 草稿定位目标（U5 任务 3.5 的「返回草稿」）。
 *
 * 两套编码同源不同形：提交侧的 `DraftSubmitTarget` 用判别联合（A/B 没有 `field` 键，
 * 创建只有 `field:"create"`），而定位通道（`openDraftAt` / `pendingDraftTarget`）要的是
 * 草稿列表那一形（`runId + spanId|null + DraftKind`）。这里只做一次机械换算，
 * **不**新增第二套身份判据 —— A/B 与创建的落地分支仍由 `openDraftAt` 自己判（U3 既有）。
 */
function draftLocatorOf(target: DraftSubmitTarget): {
  runId: string;
  spanId: string | null;
  field: DraftKind;
} {
  if (!("field" in target))
    return { runId: target.runId, spanId: target.spanId, field: "model_ab" };
  if (target.field === "create") return { runId: "", spanId: null, field: "create" };
  return { runId: target.runId, spanId: target.spanId, field: target.field };
}

/**
 * U5 任务 2.3：**显式放弃**某目标草稿时一并释放它的收尾关联。
 *
 * design D3 给关联的寿命是"到 renderer 会话结束或显式放弃相关草稿"为止。用户既然明确说
 * 这份输入不要了，那次执行就不该再留着一份"将来可以替她决定删什么"的凭据——
 * 否则之后重建的同目标草稿（新修订）与该关联同处一室，判据面徒增歧义。
 */
function discardClosureTarget(target: DraftSubmitTarget): void {
  useAppStore.setState((state) => {
    const next = submissionLib.releaseClosuresForTarget(state.draftSubmissions, target);
    return next === state.draftSubmissions ? {} : { draftSubmissions: next };
  });
}

/**
 * U5 任务 2.2/2.4：**按提交修订收尾一份草稿**（读取结论落地后尝试）。
 *
 * 判据全在 `lib/draft-closure`（四道闸 + 修订 CAS），这里只负责"看得见的那一份仓库"：
 * 关联查不到 / 登记里没有该身份 ⇒ 直接返回（宁可留着草稿，也不凭空判一个结局）。
 * 只有**真的删掉了**（或该目标本就无草稿）才释放关联——CAS 输了就留着关联等下一次核实，
 * 免得把"还没清成"的凭据先扔了。创建入口连该提交对应的目录引用一并清掉。
 */
function closeDraftClosureFor(identity: { epoch: string; operationId: string }): void {
  const state = useAppStore.getState();
  const closure = submissionLib.closureOf(
    state.draftSubmissions,
    identity.epoch,
    identity.operationId,
  );
  if (closure === undefined) return;
  const record = state.operations.operations.find(
    (one) => one.epoch === identity.epoch && one.operationId === identity.operationId,
  );
  if (record === undefined) return;
  /**
   * U5 任务 2.3：**只结"当前会话、通信已确认"的账**（design D3）。
   * - 换过 main 会话后旧登记的结局永久未知——哪怕它的结果迟到了、草稿修订也对得上，
   *   也不能拿一份没被现行会话确认过的事实去删用户的输入；
   * - 通信未知时同样不清理：此刻连"这条操作到底停在哪儿"都没确认。
   */
  if (state.operations.epoch !== identity.epoch || state.operations.unknown) return;
  const decision = decideDraftClosure({
    closure,
    draft: draftStateOf(state.drafts, closure.target),
    verdict: verdictOfOperation(record, state.resultReads, closure.expectedArmCount),
    pendingToken: pendingTokenForTarget(state.draftSubmissions.byId, closure),
  });
  if (decision.kind === "keep") return;
  const applied = applyDraftClosure(state.drafts, closure, decision);
  if (!applied.cleaned && decision.kind === "clean") return;
  useAppStore.setState((current) => ({
    drafts: applied.repo,
    draftSubmissions: submissionLib.releaseClosure(current.draftSubmissions, identity),
    // 创建入口：整份表单被清 ⇒ 这次提交对应的目录引用同步失效（不继承给下一份草稿）
    ...(applied.cleaned && closure.channel === "create" ? { createSourceRef: null } : {}),
  }));
}

/**
 * U5 任务 3.4：阅读现场变了 ⇒ **推进代次**（design D6 的撤销面）。
 *
 * 只挂在"用户真的换了在看的东西或进出覆盖模态"的既有动作上（`selectRun` / 换页签 / 选调用 /
 * 换视图 / 开设置 / 开或关创建页 / 草稿定位）。刻意**不**挂在 `resetFork` / `resetCreateRun`
 * 这类展示态复位上：组件卸载与收起不该替用户决定"你不要这次结果"（同一纪律见 design D5
 * "组件卸载或展示状态复位 SHALL NOT 解除冻结"）。
 * 代次只增不减 ⇒「离开再返回不恢复旧自动导航」是自然结论（返回时又推进了一次）。
 */
function noteReadingChanged(): void {
  useAppStore.setState((state) => ({ navGeneration: state.navGeneration + 1 }));
  // U5 任务 4.4：离开现场同样撤销待用的执行确认（切运行 / 换页签 / 换调用 / 换视图 /
  // 进创建页 —— 之前核对的目标已经不是现在要提交的目标）
  clearExecutionConfirmations();
}

/**
 * U6 任务 4.5：详情读取的**代次**计数（每次实际发起 `getRun` 递增）。
 *
 * 与 U5 `resultReads` 的 `attempt` 同一思路，但那是"按可信 runId 的后台结果核实"，
 * 这是"当前选中详情"的读取——两个读写面各持各的代次，互不顶掉（同
 * `reading-request-guard.ts` 的分面纪律）。只增不减、不进渲染状态（不是 UI 状态）。
 * 归属判定（`shouldApplyDetailFailure` / `isCurrentDetailResponse`）挡不住
 * **同 run 的连续重试**——那正是"父文件恢复后重试全量重验"要覆盖的场景：
 * 恢复前的 ownOnly 响应若后到，会把恢复后的 complete 详情盖回去。
 */
let detailReadAttempt = 0;

/**
 * 撤销全部待用的执行确认（U5 任务 4.4，design D2「目标、修订、设置或流程代次变化 SHALL
 * 使旧检查与许可失效」里"离开现场"那一半）。
 *
 * 修订 / 设置 / 检查代次的变化由**现算比对**兜住，这里清的是比对看不出来的那种变化：
 * 用户已经不在当初核对的那个现场了。没有确认时不改引用，避免无谓重渲染。
 */
function clearExecutionConfirmations(): void {
  useAppStore.setState((state) =>
    Object.keys(state.confirmations.byTargetKey).length === 0
      ? {}
      : { confirmations: emptyConfirmationStore() },
  );
}

/**
 * U6 任务 4.10：renderer 得知父本来源不完整/不可读 ⇒ **撤销绑定旧来源的可提交状态**。
 *
 * 触发口有两类（判据 `isLineageRejectionCode` / `completeness === "ownOnly"`）：
 * 1. 详情读取落地为 ownOnly（当前选中 run 的父链已确认不完整）；
 * 2. 预检/执行响应以 `RUN_LINEAGE_INCOMPLETE` / `RUN_DETAIL_UNREADABLE` 拒绝。
 *
 * 撤销面（design D4）：
 * - **检查代次全部推进**（`checkGenerations` 每键 +1）：旧只读检查的响应装不回新确认——
 *   父文件恢复也**不能自动复活**，恢复后必须重新检查；
 * - **确认凭据清空**（与 U5 的"离开现场"同一出口）；
 * - **来源撤销令牌 +1**：编辑器（A/B 计划 / 隔离 capability 结果 / 本次副本授权）订阅它，
 *   变化即清各自的组件局部状态——正文（草稿）一律保留。
 *
 * ⚠️ 这只是 renderer 会话内的展示与许可状态，**不是**第二套执行真相源：
 *    main 在每次新提交中仍会重读并重验来源（不信任任何客户端声明）。
 */
function revokeSourceBoundPermissions(): void {
  useAppStore.setState((state) => {
    const hasChecks = Object.keys(state.checkGenerations).length > 0;
    const hasConfirmations = Object.keys(state.confirmations.byTargetKey).length > 0;
    if (!hasChecks && !hasConfirmations) {
      return { sourceRevocation: state.sourceRevocation + 1 };
    }
    return {
      sourceRevocation: state.sourceRevocation + 1,
      checkGenerations: hasChecks
        ? Object.fromEntries(
            Object.entries(state.checkGenerations).map(([key, generation]) => [
              key,
              generation + 1,
            ]),
          )
        : state.checkGenerations,
      ...(hasConfirmations ? { confirmations: emptyConfirmationStore() } : {}),
    };
  });
}

/**
 * 终态到达后由**流程协调处**尝试一次结果导航（design D4：核实与导航是两个动作）。
 *
 * 入参一律取**调用这一刻**的 store 状态：读取在飞期间用户可能已经离页、开了设置或换了运行，
 * 那时这条意图永久作废（spec「读取途中离页仍不抢焦点」）—— 绝不让读取开始时快照的资格说话。
 * 只有 `wait`（结果还在读）留着意图；导航成功与一切"不跳"的判定都把它收掉：
 * 一次性动作不重复产生（spec「重复快照不得重复导航」）。
 */
async function attemptResultNavigation(
  record: OperationRecord,
  trigger: NavigationTrigger,
): Promise<void> {
  const state = useAppStore.getState();
  const onlyRunId = record.runIds.length === 1 ? record.runIds[0] : undefined;
  const decision = decideResultNavigation({
    intent: navigationIntentOf(state.navIntents, record.operationId),
    generation: state.navGeneration,
    coveringModal: state.settingsSection !== null,
    record,
    entry:
      onlyRunId === undefined
        ? undefined
        : resultReadOf(state.resultReads, {
            epoch: record.epoch,
            operationId: record.operationId,
            runId: onlyRunId,
          }),
    trigger,
  });
  if (decision.kind === "wait") return;
  useAppStore.setState((current) => ({
    navIntents: releaseNavigationIntent(current.navIntents, record.operationId),
  }));
  if (decision.kind !== "navigate") return;
  // 走既有的选择动作（恢复该 run 自己的阅读状态），不在这里另写一份落地逻辑。
  // ⚠️ 同 ID 时 `selectRun` 自己短路 ⇒ 自动导航既不改页签/滚动，也不推进代次。
  await useAppStore.getState().selectRun(decision.runId);
}

/**
 * U5 任务 1.4：**终态消费的唯一落点**（design D3）。
 *
 * 三条入口——有效 status 采纳、有效执行回执后的状态刷新、reconcile 后的状态刷新——
 * 全部汇到本函数，所以"哪个先到"不改变结论，组件挂不挂载也不改变结论：
 * 1. 按身份解冻待定关联（只解这一条）；
 * 2. 整批**至多一次**列表刷新（没有任何新运行就不刷；列表失败也不拦住第 3 步）；
 * 3. 逐条按可信 runId 核实结果（串行发读，去重与代次守卫都在 `readRunResult` 里）。
 *
 * ⚠️ `runIds` 为空的 settled 一条都不读——那是"结果未定位"，只能核对登记，
 *    从列表最新项或错误文案里猜一个 id 正是 spec 禁止的做法。
 */
async function consumeSettledOperations(
  previous: OperationSession,
  trigger: NavigationTrigger,
): Promise<void> {
  const fresh = newlySettledOperations(previous, useAppStore.getState().operations);
  if (fresh.length > 0) {
    const state = useAppStore.getState();
    for (const record of fresh) {
      state.settleDraftByOperation({ epoch: record.epoch, operationId: record.operationId });
    }
    if (fresh.some((record) => record.runIds.length > 0)) await state.loadRuns();
    for (const record of fresh) {
      for (const runId of record.runIds) {
        await readRunResult({ epoch: record.epoch, operationId: record.operationId, runId }, false);
      }
    }
    // U5 任务 3.4：核实全部落地**之后**才谈导航（design D4：核实与导航分开两个动作）
    for (const record of fresh) {
      await attemptResultNavigation(record, trigger);
    }
  }
  // 无论本轮有没有新终态，都在场的关联补一次收尾：结果早于通信恢复读到的情形也要有出路
  closeRemainingClosures();
}

/**
 * 补一轮"遗留关联"的收尾（U5 任务 2.3）。
 *
 * 只处理本轮新终态会漏掉两类事实：通信恢复后旧操作的结果早已读到、以及迟到响应改变了
 * 另一条身份的结论。这里对**在场的每条关联**再走一次同一判据（四道闸 + 修订 CAS 都不变），
 * 所以重复调用只可能"已经清过 ⇒ 什么都不做"，不会删错。
 */
function closeRemainingClosures(): void {
  const closures = useAppStore.getState().draftSubmissions.closures;
  for (const closure of Object.values(closures)) {
    closeDraftClosureFor({ epoch: closure.epoch, operationId: closure.operationId });
  }
}

/**
 * 代理变化订阅的解绑句柄（design D1，tasks 1.3）。
 *
 * 为什么放模块作用域而不是 store 字段：它是**资源句柄**不是 UI 状态
 * （放 state 会让它进渲染依赖，且 StrictMode 双挂载时两次 set 的时序反而更脆）。
 * `null` = 当前没有订阅，`ensureProxyChangeSubscription` 借它做幂等。
 * ⚠️ 测试用 `releaseProxyChangeSubscription` 复位——跨用例残留订阅会让
 * "一条通知触发几次读取"的断言互相污染。
 */
let proxyChangeUnsubscribe: (() => void) | null = null;

/**
 * 代理状态读取的**静默等待者**（tasks 2.1）。
 *
 * 合并调度让 `loadProxyStatus` 在"已有读取在飞"时立即返回（只登记尾随），
 * 于是"await 完就能拿到新事实"这个旧前提对**被合并的那次调用**不再成立。
 * 需要"读到最新事实再判据"的调用方（`reconcileProxyFacts`、messages 打开时的
 * 门禁核对）必须先过这道静默门，否则会把"没读到"当成"没有变化"。
 *
 * 与订阅句柄同理放模块作用域：它是**在飞资源的等待队列**，不是 UI 状态。
 */
const proxyStatusReadWaiters = new Set<() => void>();

/**
 * 等到状态读取完全静默（在途 0 且无尾随）为止。
 *
 * ⚠️ 必须在每次 `settleStatusRead` 之后调用（store 的 `loadProxyStatus` finally 里
 * 已接上）。补发的那次读取会重新置起在途计数，因此**先结算、后唤醒**的顺序很关键：
 * 若在 `shouldRefire` 分支之前唤醒，等待者会在补发还在飞时就返回。
 */
function notifyProxyStatusSettled(): void {
  if (proxyStatusReadWaiters.size === 0) return;
  for (const wake of [...proxyStatusReadWaiters]) wake();
}

/** 已静默则立即 resolve；否则排在 `notifyProxyStatusSettled` 队列里。 */
function settledProxyStatusRead(): Promise<void> {
  const read = useAppStore.getState().proxyStatusRead;
  if (read.inFlight === 0 && read.pending === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    proxyStatusReadWaiters.add(resolve);
  });
}

export const useAppStore = create<AppState>((set, get) => ({
  runs: [],
  failed: [],
  detail: null,
  selectedRunId: null,
  selectedSpanId: null,
  expandedSteps: {},
  readingByRun: {},
  readingInvalidated: false,
  loadingList: false,
  loadingDetail: false,
  listLoaded: false,
  listStale: false,
  error: null,
  operations: initialSession(),
  // U5 任务 1.2：按可信身份读取的结果（会话内，与阅读状态和草稿都分开）
  resultReads: emptyResultReadStore(),
  // U7 任务 1.4/1.5：比较选择集的会话读取状态（design D3 渲染层半边）
  compareRead: emptyCompareReadSession(),
  // U7 任务 2.2/2.3：详细比较 pair（独立于侧栏选择）与比较页来源引用（一次性凭据）
  comparePair: null,
  compareReturnLocation: null,
  // U7 任务 4.8：比较步骤复合定位（左右各一，身份 = 侧 + run + span）
  compareStepSelection: { left: null, right: null },
  // U7 任务 4.14：每侧前缀折叠态（默认折叠；折叠不删记录，展开即恢复）
  comparePrefixFolded: { left: true, right: true },
  // U7 任务 3.1–3.3：分支树的会话观察状态（范围/搜索/视口，不落盘）
  treeScope: null,
  treeQuery: "",
  treeViewport: null,
  treeMode: "graph",
  // U5 任务 3.4：阅读代次 + 各提交的导航意图（同为会话内，不进任何持久化）
  navGeneration: 0,
  navIntents: emptyNavigationIntents(),
  // U5 任务 3.6：已看过的结果通知键（通知本身由 deriveResultNotices 现算）
  seenNoticeKeys: {},
  listRefreshInFlight: 0,
  listRefreshPending: 0,
  proxyFactCursor: initialProxyFactCursor,

  forking: "idle",
  forkError: null,
  forkErrorCode: null,
  creatingRun: "idle",
  createRunError: null,
  createRunErrorCode: null,
  modelAbInFlight: false,
  modelAbError: null,
  modelAbErrorCode: null,
  settings: null,
  proxy: null,
  sourceFilter: "all",
  searchQuery: "",
  initialSelectionAttempted: false,
  sourceUnavailable: false,
  sourceUnavailableReason: "unknown",
  view: "trace",
  compareIds: [],
  compareNotice: null,
  createReturnLocation: null,
  recordingReturnLocation: null,
  experimentReturnLocation: null,
  messagesReturnLocation: null,
  experimentTarget: null,
  messagesTarget: null,
  experimentSource: idleExperimentSource(),
  messagesSource: idleExperimentSource(),
  recordingDraft: null,
  recordingApply: null,
  recordingApplyError: null,
  recordingStatusReadFailed: false,
  proxyReadGeneration: 0,
  proxyStatusRead: initialProxyStatusReadState,
  settingsChangeGeneration: 0,
  settingsSection: null,
  shortIdState: new ShortIdState(),
  // U3 任务 3.4：提交关联仓库（与草稿仓库分开的生命周期，见 draft-submission.ts）
  draftSubmissions: submissionLib.emptySubmissionStore(),

  async loadRuns() {
    // 在途合并（任务 3.4）：重复刷新不并发发射。频繁触发（挂载 + 执行收尾 + 手动重试）
    // 只登记一次尾随，当前请求结束后补发一次——既不丢新记录，也不形成请求雪崩。
    const decision = decideRefresh(get().listRefreshInFlight, get().listRefreshPending);
    if (decision.action === "deferred") {
      set({
        listRefreshInFlight: decision.inFlight,
        listRefreshPending: decision.pending,
        // 刷新意图已受理：让界面保持"正在刷新"的观感，而不是闪回静止
        loadingList: get().listLoaded,
      });
      return;
    }
    set({ listRefreshInFlight: decision.inFlight, listRefreshPending: decision.pending });

    try {
      await get().refreshRunsOnce();
    } finally {
      const settled = settleRefresh(get().listRefreshInFlight, get().listRefreshPending);
      set({ listRefreshInFlight: settled.inFlight, listRefreshPending: settled.pending });
      // 尾随补发：执行收尾在请求在途时产生的新记录，必须能在这一轮之后可见。
      // 走 loadRuns 自身（而非旁路 refreshRunsOnce）——由它按 decideRefresh 重新登记
      // 在途数，否则补发的这次请求无人递减计数，计数器永久残留。
      if (settled.shouldRefire) await get().loadRuns();
    }
  },

  /**
   * 订阅 main 的代理变化通知（design D1，tasks 1.3）。**幂等**。
   *
   * 三条纪律：
   * - **零主动登记**：这条订阅不碰 `operations:status`、不占执行槽、不发任何请求
   *   （delta「通知只包含受控元信息」的 renderer 半边：证明没有自动请求/自动重发）；
   * - **先订阅后首读**：调用方必须在本方法之后才 `loadProxyStatus`，
   *   否则订阅与首读之间落盘的记录两边都看不到；
   * - **载荷过 schema 才采纳**：非法载荷整条丢弃（不按"看起来像"的部分字段处理），
   *   否则一个坏载荷能把 hasKey 之类的门禁事实带歪。
   */
  ensureProxyChangeSubscription() {
    // 幂等：StrictMode 下挂载 effect 会跑两次，重复订阅会让一次落盘触发两次刷新
    if (proxyChangeUnsubscribe !== null) return;
    proxyChangeUnsubscribe = api.onProxyChanged((payload) => {
      const parsed = ProxyChangeEventSchema.safeParse(payload);
      if (!parsed.success) return;
      const plan = shouldApplyChange(get().proxyFactCursor, parsed.data);
      // 规则 4：`records` 才刷列表。刷新一律走 loadRuns（自带在途合并 + 尾随补发），
      // **不**旁路 refreshRunsOnce —— 旁路那次请求无人递减在途计数，计数器永久残留。
      if (plan.reloadRuns) void get().loadRuns();
      if (plan.reloadStatus) void get().loadProxyStatus();
      // 游标在**发起读取之前**推进：读到的是异步结果，若推进放在后面，
      // 同一 tick 里的第二条通知会因游标未动而被当成新变化，重复触发读取。
      set({ proxyFactCursor: plan.cursor });
    });
  },

  releaseProxyChangeSubscription() {
    proxyChangeUnsubscribe?.();
    proxyChangeUnsubscribe = null;
  },

  /**
   * 只读核对代理事实版本（失焦/激活补读，design D1）。
   *
   * 失焦期间可能错过任意多条通知；重新激活时读一次状态，
   * 只有 `recordsRevision` 确实落后才补刷列表——否则每次点回窗口都白读全量 traces。
   * **只读**：不启动监听、不调上游、不产生模型请求。
   *
   * ⚠️ 这里**必须等状态读取静默**（tasks 2.1）：`loadProxyStatus` 在飞时会把本次意图
   * 合并成尾随并**立即返回**，此时游标一个字都没动。若不等待就拿游标做判据，
   * "没读到" 又会被误判成"没有变化"，失焦期间漏掉的落盘永远补不上。
   */
  async reconcileProxyFacts() {
    const before = get().proxyFactCursor;
    await get().loadProxyStatus();
    await settledProxyStatusRead();
    const readOk = get().proxy !== null;
    const after = get().proxyFactCursor;
    // 读取失败/载荷非法时 loadProxyStatus 把 proxy 置 null 且**游标不前进**
    // （见上面的 `loadProxyStatus`）。⚠️ 这时**不能**直接把 `after` 当"已核实版本"：
    // 游标没动 ⇒ epoch 仍与 `before` 相同 ⇒ `shouldReconcileOnActivate` 会走
    // "无落后"分支返回 false，正好把"这次什么都没读到"误判成"没有变化"，
    // 于是失焦期间漏掉的落盘永远补不上。故此处把 epoch 置 null 显式表达
    // "本次未取得任何版本事实"，由判据一律要求补刷。
    const observed: ProxyFactCursor = readOk ? after : { ...after, epoch: null };
    if (shouldReconcileOnActivate(before, observed).reloadRuns) await get().loadRuns();
  },

  /**
   * 门禁事实的只读核对（tasks 2.1）。
   *
   * 与 `reconcileProxyFacts` 刻意分开：那个判"要不要补刷列表"，这个只刷新门禁事实。
   * 分开的理由是**代价不对称**——打开 messages 编辑器时补刷一次全量 traces 是白读，
   * 而窗口激活时漏掉一次落盘补读是事实缺失（delta 两条场景各自点名）。
   */
  async reconcileProxyGate() {
    await get().loadProxyStatus();
    await settledProxyStatusRead();
  },

  /**
   * 单次列表读取（不含合并调度）。
   * 失败时**保留旧记录**：刷新失败只标记「未更新」，不清空已成功加载的列表与阅读位置。
   */
  async refreshRunsOnce() {
    const hadLoadedBefore = get().listLoaded;
    set({ loadingList: true, error: null });
    const envelope = await api.listRuns();
    if (!envelope.ok) {
      const failure = resolveRefreshFailure(hadLoadedBefore);
      set({
        loadingList: false,
        // 失败不倒退：runs/failed 原样保留；仅标记未更新（首次失败不标）
        listStale: failure.stale,
        error: hadLoadedBefore
          ? `刷新 run 列表失败（仍显示上次结果）：${envelope.error.message}`
          : `读取 run 列表失败：${envelope.error.message}`,
      });
      return;
    }
    const parsed = ListRunsDataSchema.safeParse(envelope.data);
    if (!parsed.success) {
      const failure = resolveRefreshFailure(hadLoadedBefore);
      set({
        loadingList: false,
        listStale: failure.stale,
        error: hadLoadedBefore
          ? `刷新 run 列表失败（仍显示上次结果）：列表数据结构校验失败：${describeZodError(parsed.error)}`
          : `列表数据结构校验失败：${describeZodError(parsed.error)}`,
      });
      return;
    }
    // 成功落地：列表数据替换，但**不动** selectedRunId / detail / readingByRun
    // ——单纯刷新不自动选择新记录，也不清空已成功加载的阅读位置。
    set({
      runs: parsed.data.runs,
      failed: parsed.data.failed,
      loadingList: false,
      listLoaded: true,
      listStale: false,
    });
    // 刷新后按**列表当前事实**重算源可用性（任务 3.5）：源文件被删/变不可读时
    // 屏幕上的旧内容保留，但执行入口要禁用；重新出现即自动恢复。
    const availability = resolveSourceAvailability({
      runs: parsed.data.runs,
      failed: parsed.data.failed,
      selectedRunId: get().selectedRunId,
      listLoaded: true,
    });
    set({
      sourceUnavailable: availability.unavailable,
      sourceUnavailableReason: availability.reason,
    });
  },

  async reopenRun(id) {
    // spec「结果不可读不重执行且不锁配置」要求"按同 ID 重试读取"。
    // `selectRun` 对已选中的同一 ID 短路（切换标签不该白重读），那正好是重试的场景
    // ⇒ 先清选中再走原详情通道。只重读，**不**触碰任何主动执行通道。
    if (get().selectedRunId === id) set({ selectedRunId: null });
    await get().selectRun(id);
  },

  async selectRun(id) {
    // U5 任务 4.1：创建页在场时"要看某条运行"就是离开创建去读它。放在同 ID 短路**之前**——
    // 否则在创建页里"打开结果"（结果恰是上一条选中的运行）会被短路成什么都不发生。
    if (get().view === "create") set({ view: "trace", createReturnLocation: null });
    // U7 2.3：比较页在场时"打开单侧运行"也离开比较视图——但**保留** comparePair
    // 与 compareReturnLocation（「打开单侧 → 返回比较 → 再返回来源」的往返靠它们；
    // 与创建页的一次性凭据不同，来源引用只在真正返回/换视图时用掉）
    if (get().view === "compare") set({ view: "trace" });
    // U8 1.3：辅助工作区同比较页口径——离开页面但**保留**来源引用与显式目标
    // （「切运行不更换实验父本」：目标只能被显式进入动作替换，侧栏选择动不了它）
    if (get().view === "recording" || get().view === "experiment" || get().view === "messages") {
      set({ view: "trace" });
    }
    if (get().selectedRunId === id) return;
    // U5 3.4：换"在看哪条 run"= 改变阅读对象 ⇒ 撤销在飞的自动导航资格。
    // 放在同 ID 短路**之后**：自动导航自己调用它时不会把代次白推进一次。
    noteReadingChanged();

    // U6 任务 4.5：本次实际发起的读取代次——同 run 的连续重试全靠它区分新旧
    const attemptAtRequest = ++detailReadAttempt;

    // 切走前无需手动保存：selectSpan/toggleStep/滚动读写已逐步写入 readingByRun。
    // 进入新 run 时**恢复**它自己的阅读状态（页签/选中/展开/滚动由该 run 记录决定），
    // 但**不在**此处置 selectedSpanId——它要先经详情校验（失效对象安全回退，任务 3.2）。
    const restored = readingStateOf(get().readingByRun, id);
    set({
      selectedRunId: id,
      selectedSpanId: restored.spanId,
      expandedSteps: restored.expandedSteps,
      detail: null,
      loadingDetail: true,
      error: null,
    });
    // 请求归属（3.3）：记录**发出请求时**的选中 run。此后任何分支落地前都要与此比对，
    // 否则 A 的慢响应 / A 的失败收尾会盖掉用户已经切到的 B。
    const selectedAtRequest = get().selectedRunId;
    const envelope = await api.getRun(id);
    if (!envelope.ok) {
      // 已切走 ⇒ 这次失败与当前界面无关，**不清** loadingDetail（那是新 run 的加载态）
      if (!shouldApplyDetailFailure(selectedAtRequest, get().selectedRunId, id)) return;
      // U6 4.5：旧代次的失败收尾一律不落地（不清 loadingDetail、不写 error）
      if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempt)) return;
      set({ loadingDetail: false, error: `读取 run 失败：${envelope.error.message}` });
      return;
    }
    // 跨进程数据不可信：先确认载荷自称的 run id 与请求一致（防 main 回错 / 信封串号），
    // 再看目标 run 是否仍是当前选中——两道都过才允许落地。
    if (!isDetailPayloadForRun(envelope.data, id)) {
      if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
      if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempt)) return;
      set({
        loadingDetail: false,
        error: "轨迹数据归属校验失败（载荷与请求的 run 不一致）：拒绝加载",
      });
      return;
    }
    // 版本守卫先于 schema 转换：zod 会剥离未知键，"v1 载荷私带隔离字段"必须在此拒绝，
    // 而不是被剥掉后当成合法 v1 继续渲染（B 任务 1.1）
    const versionViolation = findRunDetailVersionViolation(envelope.data);
    if (versionViolation !== null) {
      if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
      if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempt)) return;
      set({
        loadingDetail: false,
        error: `轨迹数据版本校验失败（拒绝加载）：${versionViolation}`,
      });
      return;
    }
    const parsed = RunDetailSchema.safeParse(envelope.data);
    if (!parsed.success) {
      if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
      if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempt)) return;
      set({
        loadingDetail: false,
        error: `轨迹数据结构校验失败：${describeZodError(parsed.error)}`,
      });
      return;
    }
    // 所有校验通过后仍需确认"目标 run 还是当前选中 run"——校验期间用户可能又切走了
    if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
    // U6 4.5：旧代次的响应整体丢弃——期间已有更新的读取发起（同 run 重试），
    // 它的结论才是现状；这里什么都不写（不覆盖新读取的 loading/detail/error）。
    if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempt)) return;
    // U6 4.5：落地时**现取**阅读历史——读取在飞期间用户的 selectSpan / toggleStep /
    // 换页签都已写进 readingByRun，旧快照会把这些新位置覆盖回去（「读取重试不改变阅读位置」）。
    const landed = readingStateOf(get().readingByRun, id);
    // 默认展开全部 step，用户可折叠；但恢复的历史状态优先（用户折叠过的保持折叠）
    const expandedSteps: Record<string, boolean> = {};
    for (const span of parsed.data.spans) {
      if (span.kind === "agent.step") expandedSteps[span.id] = true;
    }
    const mergedExpanded = { ...expandedSteps, ...landed.expandedSteps };
    // 统一走优先级解析（任务 3.2/3.6 接线）：显式目标 > 有效历史 > 默认位置。
    // 详情到手才做——此前 store 里可能还留着**另一个 run** 的未校验 spanId，
    // 直接当选中项会导致"轨迹树高亮一个不属于本 run 的 span"。
    const resolved = resolveReading({
      detail: {
        spans: parsed.data.spans,
        leafSpanIds: parsed.data.leafSpanIds,
        hasFiles: parsed.data.meta.workspace !== undefined,
      },
      history: { tab: landed.tab, spanId: landed.spanId },
      target: null,
      currentTab: landed.tab,
    });
    const readingByRun = patchReadingState(get().readingByRun, id, {
      tab: resolved.tab,
      spanId: resolved.spanId,
      expandedSteps: mergedExpanded,
    });
    set({
      detail: parsed.data,
      expandedSteps: mergedExpanded,
      selectedSpanId: resolved.spanId,
      readingByRun,
      loadingDetail: false,
      // 失效回退只提示一次；成功后重新选中会清掉（见 selectSpan）
      readingInvalidated: resolved.invalidated,
    });
    // U6 任务 4.10：落地的是 ownOnly ⇒ 当前父本来源已确认不完整，
    // 撤销绑定它的检查代次/确认/A-B 计划/副本授权（草稿正文保留；恢复须重新检查）。
    if (parsed.data.completeness === "ownOnly") revokeSourceBoundPermissions();
  },

  selectSpan(id) {
    const runId = get().selectedRunId;
    // U5 3.4：换"看哪一次调用"= 改变阅读对象 ⇒ 撤销在飞的自动导航资格
    noteReadingChanged();
    // 明确选择即"换到用户要看的位置"⇒ 失效提示作废（它说的是"原位置不可用，已回退"）
    set({ selectedSpanId: id, readingInvalidated: false });
    if (runId !== null) {
      set({ readingByRun: patchReadingState(get().readingByRun, runId, { spanId: id }) });
    }
  },

  toggleStep(id) {
    const { expandedSteps, selectedRunId, readingByRun } = get();
    const next = { ...expandedSteps, [id]: !expandedSteps[id] };
    set({ expandedSteps: next });
    if (selectedRunId !== null) {
      set({
        readingByRun: patchReadingState(readingByRun, selectedRunId, { expandedSteps: next }),
      });
    }
  },

  async autoSelectInitialRun() {
    const decision = resolveInitialSelection({
      runs: get().runs,
      selectedRunId: get().selectedRunId,
      listLoaded: get().listLoaded,
      attempted: get().initialSelectionAttempted,
      // U5 任务 4.1：用户已经走进创建工作区 ⇒ 迟到的首次读取不能把他从创建页拽出来
      // U8 任务 1.3：三个辅助工作区同口径（迟到的自动选择不得把用户从录制/实验/messages 拽走）
      userWorkspace:
        get().view === "create" ||
        get().view === "recording" ||
        get().view === "experiment" ||
        get().view === "messages",
    });
    if (decision.runId === null) return;
    // 先落守卫再发起请求：详情失败时 selectRun 会把错误留在该 run 上（原位可重试），
    // 而本守卫保证我们**不会**再去试下一条——失败就是失败，不静默遍历列表。
    set({ initialSelectionAttempted: true });
    await get().selectRun(decision.runId);
  },

  setSearchQuery(query) {
    // 只改条件，不改选：筛选隐藏当前运行时主工作区照常显示（任务 3.5）
    set({ searchQuery: query });
  },

  sourceAvailability() {
    return resolveSourceAvailability({
      runs: get().runs,
      failed: get().failed,
      selectedRunId: get().selectedRunId,
      listLoaded: get().listLoaded,
    });
  },

  filterVisibility() {
    return resolveFilterVisibility({
      runs: get().runs,
      selectedRunId: get().selectedRunId,
      query: get().searchQuery,
      filter: get().sourceFilter,
    });
  },

  canExecuteFromSource() {
    const availability = get().sourceAvailability();
    return resolveExecutionGate({
      unavailable: availability.unavailable,
      reading: get().loadingDetail,
      listLoaded: get().listLoaded,
      // U6 任务 5.12：详情为 ownOnly（父链不完整）⇒ 依赖父本的执行入口一并禁用，
      // 就近原因沿用各编辑器既有的"源记录不可用"行；main 侧来源门禁仍是权威防线
      lineageIncomplete: get().detail?.completeness === "ownOnly",
    });
  },

  readingOf(runId) {
    return readingStateOf(get().readingByRun, runId);
  },

  setReadingTab(runId, tab) {
    // U5 3.4：换页签（概览 / 步骤 / 文件）= 改变阅读对象 ⇒ 撤销在飞的自动导航资格
    noteReadingChanged();
    set({ readingByRun: patchReadingState(get().readingByRun, runId, { tab }) });
  },

  setReadingScroll(runId, where, top) {
    set({
      readingByRun: patchReadingState(
        get().readingByRun,
        runId,
        where === "overview" ? { overviewScrollTop: top } : { stepsScrollTop: top },
      ),
    });
  },

  setCallReading(runId, spanId, patch) {
    set({ readingByRun: patchCallReading(get().readingByRun, runId, spanId, patch) });
  },

  fileReadingOf(runId) {
    return fileReadingOf(readingStateOf(get().readingByRun, runId));
  },

  fileReadingEntered(runId) {
    return readingStateOf(get().readingByRun, runId).files !== undefined;
  },

  setFileReading(runId, patch) {
    set({ readingByRun: patchFileReading(get().readingByRun, runId, patch) });
  },

  pendingFileTarget: null,

  openFileAt(runId, file) {
    // 登记目标并切到该 run 的文件页；目标由文件页承载组件消费一次后清空
    set({
      pendingFileTarget: { runId, file },
      readingByRun: patchReadingState(get().readingByRun, runId, { tab: "files" }),
    });
  },

  drafts: draftLib.emptyDraftRepo(),

  callDraftOf(key) {
    return draftLib.callDraftOf(get().drafts, key);
  },

  ensureCallDraft(key, baseline, source) {
    const next = draftLib.ensureCallDraft(get().drafts, key, baseline, source);
    // 无变化（条目已存在）时仓库引用不变，不触发无关订阅者
    if (next.repo !== get().drafts) set({ drafts: next.repo });
    return next.entry;
  },

  writeCallDraftText(key, text) {
    // U3 任务 3.4：待定提交冻结修改（design D5）——冻结期间仓库拒绝写入，界面同时禁用输入。
    // 拦在 store 而不是只靠组件禁用：提交快照必须独立于编辑器挂载与后续输入。
    if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return;
    const next = draftLib.writeCallDraftText(get().drafts, key, text);
    // 相同文本 / 未 ensure：仓库引用不变，不推进修订
    if (next !== get().drafts) set({ drafts: next });
  },

  discardCallDraft(key, expectedRevision) {
    // U3 任务 3.4：冻结期间拒绝放弃（含迟到确认）——待定请求引用的就是这份快照
    if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return false;
    const next = draftLib.discardCallDraft(get().drafts, key, expectedRevision);
    // 未删除（修订已推进 / 条目不存在）：仓库引用不变
    if (next.repo !== get().drafts) set({ drafts: next.repo });
    // U5 任务 2.3：显式放弃 ⇒ 该目标的收尾关联一并释放（用户已明确说这份输入不要了）
    if (next.discarded) {
      discardClosureTarget(key);
      // U5 4.4：这份输入已经不要了 ⇒ 它的确认一并作废（不留给下一份草稿）
      get().releaseExecutionConfirmation(key);
    }
    return next.discarded;
  },

  createRunDraftOf() {
    return get().drafts.create;
  },

  ensureCreateRunDraft() {
    const next = draftLib.ensureCreateRunDraft(get().drafts);
    if (next.repo !== get().drafts) set({ drafts: next.repo });
    return next.entry;
  },

  writeCreateRunDraft(patch) {
    // U3 任务 3.5：待定提交冻结整份创建草稿（对话框输入同时禁用）
    if (submissionLib.submissionOf(get().draftSubmissions, CREATE_SUBMIT_TARGET) !== undefined) {
      return;
    }
    const next = draftLib.writeCreateRunDraft(get().drafts, patch);
    if (next !== get().drafts) set({ drafts: next });
  },

  discardCreateRunDraft(expectedRevision) {
    // U3 任务 3.5：冻结期间拒绝放弃创建草稿（含迟到确认）
    if (submissionLib.submissionOf(get().draftSubmissions, CREATE_SUBMIT_TARGET) !== undefined) {
      return false;
    }
    const next = draftLib.discardCreateRunDraft(get().drafts, expectedRevision);
    if (next.repo !== get().drafts) set({ drafts: next.repo });
    // U5 任务 2.3：显式放弃 ⇒ 释放该目标的收尾关联（目录引用由创建页同轮清，见 CreateRunWorkspace）
    if (next.discarded) {
      discardClosureTarget(CREATE_SUBMIT_TARGET);
      // U5 4.4：创建草稿被弃 ⇒ 本次执行的确认一并作废
      get().releaseExecutionConfirmation(CREATE_SUBMIT_TARGET);
    }
    return next.discarded;
  },

  modelAbDraftOf(key) {
    return draftLib.modelAbDraftOf(get().drafts, key);
  },

  ensureModelAbDraft(key, baselineArms, source) {
    const next = draftLib.ensureModelAbDraft(get().drafts, key, baselineArms, source);
    if (next.repo !== get().drafts) set({ drafts: next.repo });
    return next.entry;
  },

  setModelAbRows(key, rows) {
    // U3 任务 3.5：待定执行冻结整批（增删/改参数的入口同时禁用）
    if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return;
    const next = draftLib.setModelAbRows(get().drafts, key, rows);
    if (next !== get().drafts) set({ drafts: next });
  },

  discardModelAbDraft(key, expectedRevision) {
    // U3 任务 3.5：冻结期间拒绝放弃整批（含迟到确认）
    if (submissionLib.submissionOf(get().draftSubmissions, key) !== undefined) return false;
    const next = draftLib.discardModelAbDraft(get().drafts, key, expectedRevision);
    if (next.repo !== get().drafts) set({ drafts: next.repo });
    // U5 任务 2.3：显式放弃 ⇒ 释放该目标的收尾关联
    if (next.discarded) {
      discardClosureTarget(key);
      // U5 4.4：这份输入已经不要了 ⇒ 它的确认一并作废（不留给下一份草稿）
      get().releaseExecutionConfirmation(key);
    }
    return next.discarded;
  },

  createSourceRef: null,

  setCreateSourceRef(ref) {
    set({ createSourceRef: ref });
  },

  beginDraftSubmission({ channel, target, confirmation }) {
    /**
     * U5 任务 4.4：带确认的提交先验一次**当下**现场（不是"提交前某刻看过一眼"）。
     * 修订、设置快照或检查代次与确认时不同 ⇒ 直接拒绝登记，组件因此一次 IPC 都不发。
     */
    if (
      confirmation !== undefined &&
      decideConfirmation(get().confirmations, confirmation).kind !== "confirmed"
    ) {
      return null;
    }
    // 原子取提交快照：三类草稿各自的可核对串（同一步内读修订与内容，不会读到半新半旧）
    let submittedRevision: number;
    let submittedText: string;
    // U5 任务 2.1/2.4：A/B 整批的预期臂数——只在这次提交里说一次，之后登记缺臂也以此为准
    let expectedArmCount: number | null = null;
    if (!("field" in target)) {
      // A/B 批次（整批）：行内容 JSON，与草稿列表的 copyText 同形
      const entry = draftLib.modelAbDraftOf(get().drafts, target);
      if (entry === undefined) return null;
      submittedRevision = entry.revision;
      submittedText = JSON.stringify(
        entry.rows.map((row) => ({ model: row.model, paramsText: row.paramsText })),
      );
      expectedArmCount = entry.rows.length;
    } else if (target.field === "create") {
      // 创建表单（整份）
      const entry = get().drafts.create;
      if (entry === null) return null;
      submittedRevision = entry.revision;
      submittedText = JSON.stringify({
        mode: entry.mode,
        systemPrompt: entry.systemPrompt,
        userMessage: entry.userMessage,
      });
    } else {
      // 调用类：草稿原文（提交值直接取它）
      const entry = draftLib.callDraftOf(get().drafts, target);
      // 未登记基线 ⇒ 没有可提交的草稿（正常提交路径必经 ensure）；不猜测快照
      if (entry === undefined) return null;
      submittedRevision = entry.revision;
      submittedText = entry.text;
    }
    const next = submissionLib.beginSubmission(get().draftSubmissions, {
      channel,
      target,
      submittedRevision,
      submittedText,
      // U4 任务 4.2：身份与草稿快照在同一步原子定下——operationId 现在就生成，
      // epoch 等真正发出时由 `submitActive` 绑定（未握手 ⇒ null，请求根本不会离开）
      operationId: crypto.randomUUID(),
      epoch: get().operations.epoch,
      // U5 任务 2.1/2.4：A/B 的预期臂数与快照同一步定下（解冻后仍留在收尾关联里）
      expectedArmCount,
    });
    // 该目标已有待定提交：拒绝重复提交，不覆盖旧关联（旧关联的响应仍能正确收尾）
    if (next.submission === null) return null;
    const submitted = next.submission;
    /**
     * U5 任务 3.4：**登记导航意图的唯一咽喉**。七类入口的提交都只经这里登记
     * （组件不许各自登记，否则必然漂出七套语义）。代次取当下：之后任何一次
     * 主动换阅读对象都会把它作废（判据在 `lib/navigation-intent.ts`）。
     */
    set((state) => ({
      draftSubmissions: next.store,
      navIntents: armNavigationIntent(state.navIntents, submitted.operationId, state.navGeneration),
      // U5 4.4：确认是**一次性**凭据——登记成功即消费，重新执行要重新确认
      ...(confirmation === undefined
        ? {}
        : { confirmations: releaseConfirmation(state.confirmations, target) }),
    }));
    return submitted;
  },

  settleDraftSubmission(submission) {
    const next = submissionLib.settleSubmission(get().draftSubmissions, submission);
    // 令牌不匹配（旧回调）/ 已被收尾 ⇒ 引用不变
    if (next !== get().draftSubmissions) set({ draftSubmissions: next });
  },

  finishDraftSubmission(submission, response) {
    // 用**仓库里当前那条**判定：epoch 是发出时才绑上的，入参可能是绑定前的旧快照
    const current = submissionLib.submissionOf(get().draftSubmissions, submission.target);
    if (current === undefined || current.token !== submission.token) return;
    const ack = response.operation ?? null;
    const decision = submissionLib.decideSettle(
      current,
      ack,
      response.ok ? null : response.error.code,
    );
    if (decision === "settle") get().settleDraftSubmission(current);
  },

  settleDraftByOperation({ epoch, operationId }) {
    const next = submissionLib.settleSubmissionByOperation(
      get().draftSubmissions,
      epoch,
      operationId,
    );
    if (next !== get().draftSubmissions) set({ draftSubmissions: next });
  },

  isDraftFrozen(target) {
    return submissionLib.submissionOf(get().draftSubmissions, target) !== undefined;
  },

  confirmations: emptyConfirmationStore(),
  checkGenerations: {},
  sourceRevocation: 0,

  currentConfirmationBinding(channel, target) {
    const state = get();
    // 修订一律现取（与 `beginDraftSubmission` 读同一份草稿），组件传不进旧值
    let revision = -1;
    if (!("field" in target)) {
      revision = draftLib.modelAbDraftOf(state.drafts, target)?.revision ?? -1;
    } else if (target.field === "create") {
      revision = state.drafts.create?.revision ?? -1;
    } else {
      revision = draftLib.callDraftOf(state.drafts, target)?.revision ?? -1;
    }
    return {
      channel,
      target,
      revision,
      settingsStamp: settingsStampOf({ settings: state.settings, proxy: state.proxy }),
      generation: state.checkGenerations[confirmationTargetKey(target)] ?? 0,
    };
  },

  armExecutionConfirmation(binding) {
    set((state) => {
      const next = armConfirmation(state.confirmations, binding);
      return next === state.confirmations ? {} : { confirmations: next };
    });
  },

  releaseExecutionConfirmation(target) {
    set((state) => {
      const next = releaseConfirmation(state.confirmations, target);
      return next === state.confirmations ? {} : { confirmations: next };
    });
  },

  executionConfirmationReady(binding) {
    // 现算：现场（修订 / 设置 / 代次）任一不同即未确认——不缓存"已确认"的布尔
    return decideConfirmation(get().confirmations, binding).kind === "confirmed";
  },

  restartExecutionCheck(target) {
    const key = confirmationTargetKey(target);
    set((state) => ({
      checkGenerations: {
        ...state.checkGenerations,
        [key]: (state.checkGenerations[key] ?? 0) + 1,
      },
      confirmations: releaseConfirmation(state.confirmations, target),
    }));
  },

  async refreshOperationStatus() {
    // 先记代次再发请求：期间若有新握手，本次响应整份丢弃（迟到响应不得覆盖新状态）
    const previous = get().operations;
    const issuing = beginHandshake(previous);
    set({ operations: issuing });
    let envelope: Awaited<ReturnType<typeof api.operationsStatus>>;
    try {
      envelope = await api.operationsStatus();
    } catch {
      // 通道失联 ⇒ 未知：保留既有事实与锁，等下一次有效 status 才清
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    // 快照不合契约（含不自洽的槽引用）就当未知，绝不部分采纳所谓成功字段
    const parsed = envelope.ok ? OperationStatusResultSchema.safeParse(envelope.data) : null;
    if (parsed === null || !parsed.success) {
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    const applied = applyStatus(get().operations, parsed.data, issuing.generation);
    set({ operations: applied.session });
    // U5 任务 1.4：只有**被采纳的**快照才驱动终态消费（失联/非法/迟到都不动任何收尾）
    if (applied.applied) await consumeSettledOperations(previous, "status");
    return get().operations;
  },

  async ensureOperationStatusPolling() {
    // 挂载/重载入口：没握过手先握手一次，再按"当前有没有在跑的操作"决定要不要轮询。
    // 已有定时器在排 ⇒ 不叠加（单路守卫在 `lib/operation-polling.ts`）。
    const session =
      get().operations.epoch === null ? await get().refreshOperationStatus() : get().operations;
    rescheduleStatusPoll();
    return session;
  },

  stopOperationStatusPolling() {
    stopOperationStatusPolling();
  },

  async reconcileOperation(operationId) {
    const epoch = get().operations.epoch;
    if (epoch === null) return get().operations;
    const generation = captureGeneration(get().operations);
    let envelope: Awaited<ReturnType<typeof api.operationsReconcile>>;
    try {
      envelope = await api.operationsReconcile({ epoch, operationId });
    } catch {
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    const parsed = envelope.ok ? ReconcileResultSchema.safeParse(envelope.data) : null;
    if (parsed === null || !parsed.success) {
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    const previous = get().operations;
    const applied = applyReconcile(previous, parsed.data, generation);
    set({ operations: applied.session });
    /**
     * U4 任务 6.5 的接线在 U5 任务 1.4 里并入统一落点：spec 把「核对到 settled/notAccepted」
     * 列为**唯一**能把待定关联解冻的合法入口（响应丢失时不自动重发、只能重新核对），
     * 而解冻、单次列表刷新与按 ID 核实必须走同一条路——所以这里不再单独调
     * `settleDraftByOperation`，交给 `consumeSettledOperations`（只处理本轮新进终态的记录）。
     * U5 任务 3.4：显式核对到达的终态**只通知**——导航意图当场作废，不跳到结果概览。
     */
    if (applied.applied) await consumeSettledOperations(previous, "reconcile");
    return get().operations;
  },

  async verifyRunResult(identity) {
    // U5 任务 1.2/1.3：核实动作**只**读详情通道并写自己的读取项。
    // 不 selectRun / reopenRun（那会换选中项、恢复阅读状态、动 loadingDetail 与全局 error），
    // 不 loadRuns（列表失败与按 ID 核实互不相干），不碰任何执行通道。
    return readRunResult(identity, false);
  },

  async retryResultRead(identity) {
    return readRunResult(identity, true);
  },

  async enterCompareSelection(runIds) {
    // U7 1.4：合法性判据与 IPC schema 同源（findCompareSelectionViolation 复用
    // CompareRunsRequestSchema），非法请求连 state 都不动
    const violation = findCompareSelectionViolation(runIds);
    if (violation !== null) return "invalid";
    const current = get().compareRead;
    // 幂等：同序同 id 的重复进入不重读——保留在场结论与（后续 §2 的）阅读位置，
    // 「不以每次开比较清空工作区状态换取简单实现」（design D1）
    if (sameCompareSelection(current.selection, runIds)) return "unchanged";
    const started = beginCompareRead(current, runIds);
    set({ compareRead: started });
    await requestCompareRead(started.selection as string[], started.generation);
    return "started";
  },

  async retryCompareSelectionRead() {
    // U7 1.5：同选择集全量重读；旧结论在 beginCompareRead 内先行撤销
    const next = retryCompareReadState(get().compareRead);
    if (next === null) return false;
    set({ compareRead: next });
    await requestCompareRead(next.selection as string[], next.generation);
    return true;
  },

  leaveCompare() {
    // U7 1.4：销毁守卫——在飞请求作废、结论清空；代次递增使迟到响应永不复活
    set({ compareRead: destroyCompareRead(get().compareRead) });
  },

  async openCompareWithParent(runId) {
    // U7 2.1：入口判据必须喂「当前正读的那条」的已校验详情——detail 归属不符
    // （迟到响应/串号）时按无入口处理，绝不从列表或操作登记猜父本
    const detail = get().detail;
    if (detail === null || detail.meta.id !== runId) return "hidden";
    const decision = decideCompareWithParent(detail);
    if (decision.kind !== "open") return decision.kind;
    await enterCompareView(decision.pair);
    return "opened";
  },

  async openComparePair(leftRunId, rightRunId) {
    // U7 5.3：显式选两条。相同 ID 不构成两条比较；两枚 id 都必须在当前对照集合内
    //（指标表的列本来就来自集合——这里判集合而不是判结论，避免"结论未到就点不动"）
    if (leftRunId === rightRunId) return "rejected";
    const ids = get().compareIds;
    if (!ids.includes(leftRunId) || !ids.includes(rightRunId)) return "rejected";
    // 页内换 pair = 显式换阅读对象 ⇒ 推进代次（与 setCompareSide/swap 同款）
    noteReadingChanged();
    await enterCompareView({ leftRunId, rightRunId });
    return "opened";
  },

  async openCompareWorkspace() {
    // U7 2.2/2.5 + 5.2：手动集合的进入路径。恰好两条 ⇒ 加入顺序定左右（先子后父不重排）；
    // 三/四条 ⇒ 不自动选两条，如实提示后仍进工作区（宽幅指标表显式选择）；
    // 零/一条 ⇒ 无 pair（指标表引导 / 单条自有指标）。
    const decision = decideManualPair(get().compareIds);
    if (decision.kind === "none" && decision.reason === "explicit-select") {
      set({ compareNotice: "已选三条及以上：请在指标表中显式选择两条进入详细比较" });
    }
    await enterCompareView(decision.kind === "pair" ? decision.pair : null);
    // U7 5.2：无 pair 的进入也要让宽幅指标表有数据——对整个对照集合发起一次
    // 只读比较读取（1–4 条均合法；零条无可读）。同集合幂等，不重复请求。
    if (decision.kind === "none" && get().compareIds.length >= 1) {
      await get().enterCompareSelection(get().compareIds);
    }
  },

  async setCompareSide(side, runId) {
    const pair = get().comparePair;
    if (pair === null) return "rejected";
    const decision = decidePairSideEdit(pair, side, runId);
    if (decision.kind === "unchanged") return "unchanged";
    if (decision.kind === "rejected") return "rejected";
    // 更换对象 = 显式换阅读对象 ⇒ 推进阅读代次；**不**调 selectRun、不动侧栏选择
    // 与全局对照集合（scenario「更换交换不改变侧栏选择」）
    noteReadingChanged();
    set({ comparePair: decision.pair });
    // U7 4.8：被换侧的步骤选中随旧对象失效；另一侧保留
    set({
      compareStepSelection: {
        left: side === "left" ? null : get().compareStepSelection.left,
        right: side === "right" ? null : get().compareStepSelection.right,
      },
      comparePrefixFolded: {
        left: side === "left" ? true : get().comparePrefixFolded.left,
        right: side === "right" ? true : get().comparePrefixFolded.right,
      },
    });
    await get().enterCompareSelection([decision.pair.leftRunId, decision.pair.rightRunId]);
    return "replaced";
  },

  async swapCompareSides() {
    const pair = get().comparePair;
    if (pair === null) return "none";
    const swapped = swapComparePair(pair);
    noteReadingChanged();
    set({ comparePair: swapped });
    // U7 4.8：交换 = 左右内容对调 ⇒ 步骤选中随对象一起对调（不是清空）
    const selection = get().compareStepSelection;
    const folded = get().comparePrefixFolded;
    set({
      compareStepSelection: { left: selection.right, right: selection.left },
      comparePrefixFolded: { left: folded.right, right: folded.left },
    });
    // 交换使旧序请求失效（design D3「快速替换、交换、移出或离开使旧请求失效」）
    await get().enterCompareSelection([swapped.leftRunId, swapped.rightRunId]);
    return "swapped";
  },

  selectCompareStep(side, spanId) {
    // U7 4.8：复合定位只动本侧——选左不改变右（重复的 s_01 各归各列）
    const current = get().compareStepSelection;
    set({
      compareStepSelection:
        side === "left" ? { ...current, left: spanId } : { ...current, right: spanId },
    });
  },

  toggleComparePrefix(side) {
    // U7 4.14：折叠/展开只动本侧（折叠是视图压缩，记录不删——展开即恢复）
    const current = get().comparePrefixFolded;
    set({
      comparePrefixFolded:
        side === "left"
          ? { ...current, left: !current.left }
          : { ...current, right: !current.right },
    });
  },

  async returnFromCompare() {
    const state = get();
    const decision = decideCreateReturn({
      location: state.compareReturnLocation,
      knownRunIds: state.runs.map((run) => run.id),
    });
    // 一次性凭据：恢复与回退都算用掉（与创建页同纪律）
    set({ compareReturnLocation: null });
    const target = decision.kind === "restore" ? decision.location.view : decision.view;
    noteReadingChanged();
    set({ view: target });
    if (decision.kind !== "restore" || decision.location.runId === null) return;
    await restoreReadingLocation(decision.location);
  },

  async openCompareSideError(runId, llmCallSpanId) {
    // U7 4.5：单侧错误跳转 = 打开该侧运行并定位自有失败调用（同 openOperationFailure
    // 的「先落地、再定位」次序——详情读不出来就不做任何定位）。
    // selectRun 走既有读取通路：比较结论里的 detail 不复用为导航真相源；
    // 2.3 纪律：离开比较视图但保留 pair 与来源引用 ⇒ 「返回比较」仍成立。
    // ⚠️ selectRun 在读取失败时也会落 selectedRunId（原位可重试）——
    // 「落地」判据必须是详情已读出且归属相符，不能只看 selectedRunId。
    await get().selectRun(runId);
    const detail = get().detail;
    if (get().selectedRunId !== runId || detail === null || detail.meta.id !== runId) {
      return false;
    }
    get().setReadingTab(runId, "steps");
    get().selectSpan(llmCallSpanId);
    return true;
  },

  returnToCompare() {
    // U7 2.3：单侧往返的回程。pair 与 compareRead 会话都在（打开单侧不清它们）；
    // 同 pair 下 enterCompareSelection 幂等 ⇒ 这里只切视图，不重读
    if (get().view === "compare") return;
    noteReadingChanged();
    set({ view: "compare" });
  },

  async openCompareSideFiles(side) {
    const pair = get().comparePair;
    if (pair === null) return "failed";
    const runId = side === "left" ? pair.leftRunId : pair.rightRunId;
    // 能力判据的**唯一输入** = 比较响应里该侧的已校验详情（不拿当前选中 run 冒充）
    const conclusion = get().compareRead.conclusion;
    const item =
      conclusion?.kind === "verified"
        ? conclusion.items.find((candidate) => candidate.runId === runId)
        : undefined;
    const detail = item?.status === "ready" ? item.detail : null;
    const reading = readingStateOf(get().readingByRun, runId);
    const entry = deriveCompareFileEntry({
      detail,
      selectedSpanId:
        side === "left" ? get().compareStepSelection.left : get().compareStepSelection.right,
      savedTab: reading.files !== undefined ? "files" : undefined,
    });
    if (entry.kind !== "available") return "unsupported";

    await get().selectRun(runId);
    // 落地判据（同 openCompareSideError）：详情读出、归属相符、且能力仍成立
    const live = get().detail;
    if (get().selectedRunId !== runId || live === null || live.meta.id !== runId) return "failed";
    if (!isIsolatedRun(live)) return "failed";
    // 5.7：显式步骤定位目标必须在**落地后的详情**上复核为合法自有完成步骤
    if (entry.targetCheckpointStepId !== null) {
      if (isOwnStepTarget(live, entry.targetCheckpointStepId)) {
        get().setFileReading(runId, { checkpoint: entry.targetCheckpointStepId });
      }
      // 复核不过 ⇒ 不写：走 U2 已保存合法位置或默认检查点（不提示成功也不伪造定位）
    }
    get().setReadingTab(runId, "files");
    set({ view: "trace" });
    return "opened";
  },

  armTreeSession() {
    // U7 3.1：首次进入的初始范围与焦点。幂等：已有会话范围就原样沿用（返回树
    // 恢复视口、不重复强制居中——显式定位才再次居中，D2）
    const existing = get().treeScope;
    if (existing !== null) {
      return { scope: existing, focusRunId: null };
    }
    const decision = decideTreeInitialFocus(get().selectedRunId);
    set({ treeScope: decision.scope });
    return { scope: decision.scope, focusRunId: decision.focusRunId };
  },

  setTreeScope(scope) {
    // U7 3.1：显式范围切换（观察参数；不影响选中运行与阅读位置）
    set({ treeScope: scope });
  },

  setTreeQuery(query) {
    // U7 3.2：搜索词只进会话状态；无命中时渲染层明确提示，不丢原选择
    set({ treeQuery: query });
  },

  setTreeViewport(viewport) {
    // U7 3.3：视口落会话（缩放/平移/定位/适应画布都汇到这里）；返回树恢复
    set({ treeViewport: viewport });
  },

  setTreeMode(mode) {
    // U7 3.6：呈现模式落会话（返回树保留来源模式）；不影响选中与对比集合
    set({ treeMode: mode });
  },

  async openOperationResult(identity) {
    // 3.5：用户主动 ⇒ 不经导航意图；但只走既有选择动作，落地口径与手动切运行完全一致
    get().markNoticesSeen([resultReadKeyOf(identity)]);
    await get().selectRun(identity.runId);
  },

  async openOperationFailure(identity) {
    const entry = resultReadOf(get().resultReads, identity);
    const spanId = entry?.facts?.failure.llmCallSpanId ?? null;
    if (spanId === null) return false;
    await get().openOperationResult(identity);
    // 详情读不出来 ⇒ 不做任何定位（不跳到一个"大概在那里"的调用上）
    if (get().selectedRunId !== identity.runId) return false;
    get().setReadingTab(identity.runId, "steps");
    get().selectSpan(spanId);
    return true;
  },

  async returnOperationDraft({ epoch, operationId }) {
    const target = submissionLib.submissionTargetOf(get().draftSubmissions, epoch, operationId);
    if (target === null) return false;
    // 草稿不在（已按修订清理 / 已显式放弃）⇒ 交给视图说清"为什么不返回"，这里不复活内容
    if (!draftStateOf(get().drafts, target).exists) return false;
    await get().openDraftAt(draftLocatorOf(target));
    return true;
  },

  isOperationDraftPresent({ epoch, operationId }) {
    const target = submissionLib.submissionTargetOf(get().draftSubmissions, epoch, operationId);
    return target !== null && draftStateOf(get().drafts, target).exists;
  },

  markNoticesSeen(keys) {
    if (keys.length === 0) return;
    set((state) => {
      let changed = false;
      const next = { ...state.seenNoticeKeys };
      for (const key of keys) {
        if (next[key] === true) continue;
        next[key] = true;
        changed = true;
      }
      return changed ? { seenNoticeKeys: next } : {};
    });
  },

  pendingDraftTarget: null,

  async openDraftAt(target) {
    // 创建草稿：定位 = 恢复创建表单（对话框挂载即 ensure/读取草稿）；
    // 同时清掉可能残留的调用类 pending（一次性目标不跨页面残留）
    if (target.field === "create") {
      // U5 任务 4.1：创建草稿的定位 = 走进创建工作区（与全局栏同一个入口动作，
      // 从别的工作区进来照常取新来源）；同时清掉可能残留的调用类 pending
      set({ pendingDraftTarget: null });
      get().openCreateWorkspace();
      return;
    }
    // U8 任务 1.5：A/B 批次草稿的定位 = 进入实验工作区并按草稿键**显式绑定目标**
    // （精确身份来自条目本身，不跟随侧栏选择；全局「返回草稿」经 draftLocatorOf 走同一分支）。
    // pending 不再交给详情内的旧编辑器（§3.1 提取后工作区编辑器直接读草稿仓库）
    if (target.field === "model_ab") {
      set({ pendingDraftTarget: null });
      if (target.spanId === null) return;
      get().openExperimentWorkspace({ runId: target.runId, spanId: target.spanId });
      return;
    }
    // U8 任务 1.5：messages 草稿的定位 = 进入 messages 编辑工作区（同上口径）
    if (target.field === "messages") {
      set({ pendingDraftTarget: null });
      if (target.spanId === null) return;
      get().openMessagesWorkspace({ runId: target.runId, spanId: target.spanId });
      return;
    }
    set({ pendingDraftTarget: target });
    if (get().selectedRunId !== target.runId) {
      await get().selectRun(target.runId);
    }
    // 运行不可达（selectRun 失败）时 pending 保留：列表的复制/放弃仍可用（spec：详情失败仍能访问输入）
    if (get().selectedRunId === target.runId) {
      get().setReadingTab(target.runId, "steps");
      if (target.spanId !== null) get().selectSpan(target.spanId);
    }
  },

  consumeDraftTarget() {
    set({ pendingDraftTarget: null });
  },

  async forkAt(parentRunId, atSpanId, value, execution, submission) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await submitActive(
      api.forkRun,
      {
        parentRunId,
        atSpanId,
        edit: { field: "result", value },
        // 只在隔离父本时带上 execution：普通父本请求里不出现该键（语义清爽，且便于断言）
        ...(execution === undefined ? {} : { execution }),
      },
      submission,
    );
    // U3 任务 3.4：已明确返回（成功或业务拒绝）⇒ 收尾本次提交关联、解除冻结；
    // **任何响应都不删草稿**（design D5）。通道抛错不进这里，冻结保留（状态未知）。
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.2：ok 只结束"这次请求在飞"的本地标记。旧实现在这里 `loadRuns()` +
    // `selectRun(信封里的 id)`——把响应当成了结局（成功信封 + 运行 error 时照样跳过去）。
    // 列表刷新、按可信 ID 核实与是否导航，与创建同一条路：全部归终态消费点与导航意图。
    set({ forking: "idle" });
    return true;
  },

  resetFork() {
    set({ forking: "idle", forkError: null, forkErrorCode: null });
  },

  async loadForkCapability(request) {
    const envelope = await api.forkCapability(request);
    if (!envelope.ok) {
      return { ok: false, code: envelope.error.code, message: envelope.error.message };
    }
    // 跨进程数据不可信：确认区会把这些数字原样展示给用户，必须先校验形状
    const parsed = ForkCapabilityResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "CAPABILITY_SCHEMA_INVALID",
        message: `续跑能力预检结果结构校验失败：${describeZodError(parsed.error)}`,
      };
    }
    return { ok: true, data: parsed.data };
  },

  async inspectWorkspace(request) {
    const envelope = await api.inspectWorkspace(request);
    if (!envelope.ok) {
      return { ok: false, code: envelope.error.code, message: envelope.error.message };
    }
    // 跨进程数据不可信：清单与数字会原样展示给用户，先校验形状
    const parsed = WorkspaceInspectResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "INSPECT_SCHEMA_INVALID",
        message: `文件清单结构校验失败：${describeZodError(parsed.error)}`,
      };
    }
    return { ok: true, data: parsed.data };
  },

  async readWorkspaceFile(request) {
    const envelope = await api.readWorkspaceFile(request);
    if (!envelope.ok) {
      return { ok: false, code: envelope.error.code, message: envelope.error.message };
    }
    const parsed = WorkspaceReadFileResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "READ_FILE_SCHEMA_INVALID",
        message: `文件内容结构校验失败：${describeZodError(parsed.error)}`,
      };
    }
    return { ok: true, data: parsed.data };
  },

  async createRun(request, submission) {
    set({ creatingRun: "in_progress", createRunError: null, createRunErrorCode: null });
    const envelope = await submitActive(api.createRun, request, submission);
    // U3 任务 3.5：已明确返回（成功或业务拒绝）⇒ 收尾本次提交关联、解除整份冻结；
    // **任何响应都不删草稿**（design D5）。通道抛错不进这里，冻结保留（状态未知）。
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      // 请求事实单独留一行：错误信封说明"这次提交被怎样对待"，不替代运行结局。
      // 失败运行若要可见走的是终态消费（main 已把 runId 挂到该操作上），不在这里刷列表。
      set({
        creatingRun: "error",
        createRunError: envelope.error.message,
        createRunErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.1：ok 只结束"这次请求在飞"的本地标记；没有"success"，也没有导航。
    set({ creatingRun: "idle" });
    return true;
  },

  resetCreateRun() {
    set({ creatingRun: "idle", createRunError: null, createRunErrorCode: null });
  },

  async chooseSource() {
    const envelope = await api.chooseSource();
    if (!envelope.ok) {
      set({ error: `选择源目录失败：${envelope.error.message}` });
      return null;
    }
    // 跨进程数据不可信：核验形状后再交给对话框（"取消"与"失败"必须可分辨）
    const parsed = ChooseSourceResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ error: `目录选择结果结构校验失败：${describeZodError(parsed.error)}` });
      return null;
    }
    return parsed.data;
  },

  async promptFork(parentRunId, edit, submission) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await submitActive(api.promptFork, { parentRunId, edit }, submission);
    // U3 任务 3.4：已明确返回即收尾本次提交关联（草稿保留，见 design D5）
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.2：与 forkAt 同形——响应不决定结局，也不产生导航（失败同样不产生伪 run：
    // 那条 run 是否在列表里、结局如何，只看登记的可信 ID 与它自己的终止事件）。
    set({ forking: "idle" });
    return true;
  },

  async modelAb(parentRunId, arms, dryRun, submission) {
    set({ modelAbInFlight: true, modelAbError: null, modelAbErrorCode: null });
    // 两条分支彻底分开：预览走只读通道（不占主动槽、不需要执行身份、不登记关联），
    // 真实执行走主动通道（整批一个槽，main 判重先于任何副作用）
    type AbResponse = ExecutedResponse<ModelAbResult> | Envelope<ModelAbResult>;
    let envelope: AbResponse;
    if (dryRun === true) {
      envelope = await api.modelAbPlan({ parentRunId, arms, dryRun: true });
    } else {
      const executed = await submitActive(api.modelAb, { parentRunId, arms }, submission);
      // U3 任务 3.5 + U4 任务 4.2：真实执行的返回即按**身份**收尾整批关联
      // （含"部分臂失败"——那仍是明确返回）；草稿与批次一律保留。
      if (submission !== undefined) get().finishDraftSubmission(submission, executed);
      envelope = executed;
    }
    if (!envelope.ok) {
      set({
        modelAbInFlight: false,
        modelAbError: envelope.error.message,
        modelAbErrorCode: envelope.error.code,
      });
      return null;
    }
    set({ modelAbInFlight: false });
    if (dryRun) return envelope.data;
    // U5 任务 3.3：真实执行也不在入口刷列表——各臂的新 run 由终态消费按**登记的 runIds**
    // 刷一次、逐条核实；多臂从不自动聚焦（旧实现连 `selectRun` 都没有，只多刷了一次列表）。
    // 返回的 `data`（信封 ids / 计划）只是请求事实，不是"哪条臂成功"的结论（design D4）。
    return envelope.data;
  },

  resetModelAb() {
    set({ modelAbInFlight: false, modelAbError: null, modelAbErrorCode: null });
  },

  async loadSettings() {
    const envelope = await api.getSettings();
    if (!envelope.ok) {
      set({ settings: null, error: `读取运行配置失败：${envelope.error.message}` });
      return false;
    }
    const parsed = SettingsStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ settings: null, error: `运行配置数据结构校验失败：${describeZodError(parsed.error)}` });
      return false;
    }
    set({ settings: parsed.data });
    return true;
  },

  async saveSettings(input) {
    const envelope = await api.saveSettings(input);
    if (!envelope.ok) {
      set({ error: `保存运行配置失败：${envelope.error.message}` });
      return "save-failed";
    }
    // U5 任务 5.4：保存与回读是**两个结论**——回读失败不否定"已保存"，
    // 但也绝不把旧摘要当新配置事实（loadSettings 失败路径已把 settings 置 null）。
    // U8 任务 3.7：两种成功结局都推进已核实配置变化代次（含仅轮换 key 的保存；
    // 回读失败=已保存但状态未知，同样撤销实验旧计划）；保存失败不推进。
    const outcome = (await get().loadSettings()) ? "saved" : "reread-failed";
    if (outcome === "saved" || outcome === "reread-failed") {
      set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
    }
    return outcome;
  },

  async clearSettings() {
    const envelope = await api.clearSettings();
    if (!envelope.ok) {
      set({ error: `清除运行配置失败：${envelope.error.message}` });
      return false;
    }
    set({ settings: null });
    // U8 任务 3.7：已核实清除推进配置变化代次（实验旧计划随之作废）
    set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
    return true;
  },

  /**
   * 只读读一次代理状态（tasks 2.1：**合并 + 代次守卫 + 快照新旧守卫**）。
   *
   * 三个触发源会叠出并发读取（通知 / messages 打开的核对 / 窗口激活补读），
   * 两条守卫各自挡一种"旧事实覆盖新事实"：
   * - **合并**：在飞时不并发发射，只登记尾随，结束后补发恰好一次；
   * - **快照新旧**：读回的载荷可能比已采纳的事实更旧（请求在途期间又发生了一次变更），
   *   同 epoch 且任一版本维度落后 ⇒ 整份丢弃，一个字节都不写。
   *
   * ⚠️ **为什么没有第三道「代次守卫」**（变异验证的结论，别照着旧注释再加回去）：
   * 合并已经保证同时至多一个读取在飞，因此"响应对不上自己那次请求"在这条链路上
   * **不可达**。曾加过一道 `isLatestStatusRead` 断言，变异测试（改成 `if (false)`）
   * 显示 14 条 store 用例全绿——它从未真正拒绝过任何响应。留着它等于挂一个永不
   * 触发的"保险"，读代码的人会以为并发防护靠它。故移除；真正的并发防线是合并，
   * 真正的乱序防线是快照新旧守卫（变异后 3 条用例变红，见 proxy-status-read.test.ts）。
   *
   * ⚠️ 失败时游标**不前进**：状态未知时不能断言"版本没变"——否则失焦期间漏掉的落盘
   * 会被这次失败读取"确认"成没有变化（design D1）。
   */
  async loadProxyStatus() {
    const decision = beginStatusRead(get().proxyStatusRead);
    set({ proxyStatusRead: decision.state });
    if (decision.action === "deferred") {
      // 刷新意图已受理：不发射、不返回事实。尾随补发由在飞那次收尾时完成。
      return;
    }
    try {
      // ⚠️ **通道本身抛错也必须被吞进失败分支**（tasks 2.1 实施期坐实）：本方法被
      // `openMessagesWorkspace` / `returnToAuxSource` 以 `void` 方式发起（fire-and-forget），
      // 一旦这里把异常抛出去就变成**未处理拒绝**——既没有可重试入口，也不会有人看见。
      // 实测：`aux-workspace-store.test.ts` 的 api 桩没有 proxyStatus，8 处未处理错误
      // 全部来自这一条路径。读通道失败与"读到一个失败信封"是同一件事：状态未知。
      let envelope: Awaited<ReturnType<typeof api.proxyStatus>>;
      try {
        envelope = await api.proxyStatus();
      } catch (e) {
        envelope = {
          ok: false as const,
          error: { code: "PROXY_STATUS_UNAVAILABLE", message: (e as Error).message },
        };
      }
      // U8 任务 2.6：每次真正发射的读取推进状态代次（守卫锚点；读取本身零写通道）
      set({ proxyReadGeneration: get().proxyReadGeneration + 1 });
      if (!envelope.ok) {
        set({
          proxy: null,
          error: `读取代理状态失败：${envelope.error.message}`,
          // U8 任务 2.5：回读失败如实呈现「状态待读取」，允许只读重试（不重新 toggle）
          recordingStatusReadFailed: true,
        });
        // ⚠️ 游标**不前进**（理由见上方注释）
        // 草稿在场 ⇒ baseline 撤到 null（没有可核实的当前应用值；输入原样保留）
        const draft = get().recordingDraft;
        if (draft !== null) set({ recordingDraft: applyRecordingBaseline(draft, null) });
        return;
      }
      const parsed = ProxyStateSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({ proxy: null, error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
        return;
      }
      // 规则 3（快照新旧）：载荷比已采纳事实更旧 ⇒ 整份丢弃。
      // ⚠️ 这一条**不能**由 cursorFromStatus 兜住：它只保证游标数字不回退，
      // 而 `proxy` 状态对象仍会被这份旧载荷写下去（hasKey 由 true 按回 false）。
      const ruling = acceptProxySnapshot(get().proxyFactCursor, parsed.data);
      if (!ruling.accept) return;
      set({ proxy: parsed.data, recordingStatusReadFailed: false, proxyFactCursor: ruling.cursor });
      // U8 任务 2.1：草稿在场 ⇒ baseline 跟随最近可核实事实（输入原样，dirty 随之重算）
      const draft = get().recordingDraft;
      if (draft !== null)
        set({ recordingDraft: applyRecordingBaseline(draft, recordingBaselineOf(parsed.data)) });
    } finally {
      const settled = settleStatusRead(get().proxyStatusRead);
      set({ proxyStatusRead: settled.state });
      // 尾随补发走本方法自身（由它登记在途数）——旁路直发 IPC 会让补发那次
      // 无人递减计数，此后所有读取都被"合并"成尾随而永不发射。
      //
      // ⚠️ 这里**不写 `return`**：`finally` 里的 return 会吞掉 try 块的控制流，
      // 且 Biome 直接把它标成错误（`noUnsafeFinally`）。改成 if/else 让两条路径互斥。
      if (settled.shouldRefire) {
        await get().loadProxyStatus();
      } else {
        // 只在**不再补发**时唤醒等待者：补发会在上面的 await 里重新置起在途计数，
        // 先唤醒会让"等静默"的调用方在补发还在飞时就拿到判断依据。
        notifyProxyStatusSettled();
      }
    }
  },

  async toggleProxy(input) {
    set({ error: null });
    const envelope = await api.proxyToggle(input);
    if (!envelope.ok) {
      set({ error: `代理操作失败：${envelope.error.message}` });
      return null;
    }
    const parsed = ProxyStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
      return null;
    }
    set({ proxy: parsed.data });
    return parsed.data;
  },

  setSourceFilter(filter) {
    set({ sourceFilter: filter });
  },

  setView(view) {
    // U5 3.4：轨迹 / 分支树之间切换也是"换了在看的东西"⇒ 撤销在飞的自动导航资格
    noteReadingChanged();
    // U5 4.1：从创建页切去别的工作区 = 本次来源用掉（下次进入按新位置重记）。
    // ⚠️ 刻意**不清**创建草稿——离开创建保留它是 U3 的既有语义。
    // U7 2.3：比较页的来源引用同纪律（经 setView 离开 = 用掉；selectRun 打开单侧
    // 时保留，那是比较自己的往返流）
    // U8 1.3：三个辅助工作区的来源引用同一纪律（经 setView 离开 = 用掉；
    // selectRun 离开时保留——目标是显式凭据，不随视图切换被抹）
    set({
      view,
      createReturnLocation: null,
      compareReturnLocation: null,
      recordingReturnLocation: null,
      experimentReturnLocation: null,
      messagesReturnLocation: null,
    });
  },

  openCreateWorkspace() {
    const state = get();
    const selected = state.selectedRunId;
    const decision = decideCreateEntry({
      view: state.view,
      selectedRunId: selected,
      // 文件定位由 `reading.files` 自己表达（undefined = 从未进入文件页）——
      // 不在这里另传一份"进入过"布尔，两处判据会漂移
      reading:
        state.view === "trace" && selected !== null
          ? readingStateOf(state.readingByRun, selected)
          : null,
    });
    // 已经在创建页：来源沿用、代次不推进（重复点「新建」不该把这次流程的导航资格撤销掉）
    if (decision.kind === "keep") return;
    // 进入创建页 = 离开原来在看的那条运行 ⇒ 撤销在飞的自动导航资格
    noteReadingChanged();
    set({ view: "create", createReturnLocation: decision.location });
  },

  async returnToCreateSource() {
    const state = get();
    const decision = decideCreateReturn({
      location: state.createReturnLocation,
      knownRunIds: state.runs.map((run) => run.id),
    });
    // 一次性凭据：恢复与回退都算用掉，不存在"回到创建页再按一次返回来源"的旧位置复活
    set({ createReturnLocation: null });
    const target = decision.kind === "restore" ? decision.location.view : decision.view;
    noteReadingChanged();
    set({ view: target });
    if (decision.kind !== "restore" || decision.location.runId === null) return;
    await restoreReadingLocation(decision.location);
  },

  openRecordingWorkspace() {
    enterAuxWorkspace("recording", null);
    // U8 任务 2.1：进录制页即确保草稿在场（从当前已核实状态初始化；已有草稿原样保留）
    const state = get();
    useAppStore.setState({
      recordingDraft: ensureRecordingDraft(
        state.recordingDraft,
        state.proxy !== null ? recordingBaselineOf(state.proxy) : null,
      ),
    });
  },

  openExperimentWorkspace(target) {
    enterAuxWorkspace("experiment", target);
    // U8 3.1b：换目标 ⇒ 父本源回到待读取（容器按目标发起只读读取；旧目标的详情不残留）
    useAppStore.setState({ experimentSource: idleExperimentSource() });
  },

  openMessagesWorkspace(target) {
    enterAuxWorkspace("messages", target);
    // U8 5.1b：换目标 ⇒ 源回到待读取（容器按目标发起只读读取；旧目标的详情不残留）
    useAppStore.setState({ messagesSource: idleExperimentSource() });
    // 任务 2.1：打开 messages 即核对当前代理事实（design D2「messages 初次打开…
    // 均可核对」）。场景「打开重发即核对当前状态」：store 里可能还留着旧的
    // hasKey=false，用户不必先去录制页手动重读。
    void get().reconcileProxyGate();
  },

  async returnToAuxSource(view) {
    const state = get();
    const location = state[auxLocationKey(view)];
    const decision = decideAuxReturn({
      location,
      knownRunIds: state.runs.map((run) => run.id),
    });
    // 一次性凭据：恢复与回退都算用掉（与创建页同一纪律，旧位置不复活）
    useAppStore.setState({ [auxLocationKey(view)]: null });
    const target = decision.kind === "restore" ? decision.location.view : decision.view;
    noteReadingChanged();
    set({ view: target });
    // 任务 2.1：从录制页返回 messages ⇒ 代理启停/凭据接入的**结果**要立刻进 gate。
    // 场景「打开重发即核对当前状态」的另一半：刚在录制页启用了代理，回来就重发
    // 时不能还拿着启停之前的门禁事实。⚠️ 只在落到 messages 时核对——
    // 落到 trace/tree 时读状态是白读一次 IPC。
    if (target === "messages") void get().reconcileProxyGate();
    // U8 6.11 实机坐实：辅助工作区「返回来源」后焦点落回工作区主容器（不落 body）——
    // 场景 THEN「返回有效来源焦点」；U7 5.9「返回比较」的 data-compare-primary 同款。
    // 返回目标是主工作区视图（trace 等）时落回 main（App 侧 tabIndex=-1）。
    requestAnimationFrame(() => {
      (
        document.querySelector<HTMLElement>("[data-aux-frame]") ??
        document.querySelector<HTMLElement>("main")
      )?.focus();
    });
    if (decision.kind !== "restore" || decision.location.runId === null) return;
    await restoreReadingLocation(decision.location);
  },

  writeRecordingDraftFields(patch) {
    const draft = get().recordingDraft;
    if (draft === null) return;
    useAppStore.setState({ recordingDraft: writeRecordingDraft(draft, patch) });
  },

  discardRecordingDraftConfirmed(expectedRevision) {
    const draft = get().recordingDraft;
    if (draft === null) return false;
    const result = discardRecordingDraftState(draft, expectedRevision);
    if (!result.discarded) return false;
    set({ recordingDraft: result.draft });
    return true;
  },

  async applyRecordingDraft() {
    const draft = get().recordingDraft;
    if (draft === null) return "no-draft";
    if (get().recordingApply !== null) return "busy";
    const request = recordingApplyRequest(draft);
    // 纵深防御：组件判据同源，但这里再拦一次——非法字段连在飞标记都不该出现
    if (!request.ok) return "invalid";
    const submittedRevision = draft.revision;
    set({ recordingApply: submittedRevision, recordingApplyError: null });
    const envelope = await api.proxyToggle(request.input);
    // toggle 非事务（design D2）：无论启动成败都回读真实状态——成功确认「已保存意图」，
    // 回读给出「监听事实」；回读失败 ⇒ 状态待读取，两层诊断分别呈现
    const startOk = envelope.ok;
    const startMessage = envelope.ok ? "" : envelope.error.message;
    await get().loadProxyStatus();
    const current = get();
    // U8 任务 2.6：响应只在「与当前草稿修订匹配」时更新基线——在飞期间的后来输入
    // 不被旧响应覆写；诊断照报（它属于真实发生过的那次应用）
    const stale =
      current.recordingDraft === null || current.recordingDraft.revision !== submittedRevision;
    const patch: {
      recordingApply: number | null;
      recordingApplyError: string | null;
      recordingDraft?: RecordingDraft;
    } = { recordingApply: null, recordingApplyError: startOk ? null : startMessage };
    if (startOk && !stale && current.recordingDraft !== null) {
      patch.recordingDraft = applyRecordingBaseline(current.recordingDraft, {
        enabled: request.input.enabled,
        port: request.input.port,
        upstreamBaseUrl: request.input.upstreamBaseUrl,
      });
    }
    set(patch);
    return startOk ? "applied" : "start-failed";
  },

  async readExperimentSource() {
    const target = get().experimentTarget;
    if (target === null) return;
    // 只读 runs:get：不改选中项、不切视图、不碰阅读状态（design D1「后台核实不切页」）
    set({ experimentSource: { phase: "reading", detail: null, errorMessage: null } });
    const envelope = await api.getRun(target.runId);
    if (!envelope.ok) {
      set({
        experimentSource: { phase: "failed", detail: null, errorMessage: envelope.error.message },
      });
      return;
    }
    const parsed = RunDetailSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({
        experimentSource: {
          phase: "failed",
          detail: null,
          errorMessage: `父本详情数据结构校验失败：${describeZodError(parsed.error)}`,
        },
      });
      return;
    }
    set({ experimentSource: { phase: "ready", detail: parsed.data, errorMessage: null } });
  },

  async readMessagesSource() {
    // U8 5.1b：与 readExperimentSource 同判据（只读 runs:get，不改选中/视图/代次），
    // 只是目标换成 messagesTarget——不抄第二份状态形状，复用 ExperimentSourceState。
    const target = get().messagesTarget;
    if (target === null) return;
    set({ messagesSource: { phase: "reading", detail: null, errorMessage: null } });
    const envelope = await api.getRun(target.runId);
    if (!envelope.ok) {
      set({
        messagesSource: { phase: "failed", detail: null, errorMessage: envelope.error.message },
      });
      return;
    }
    const parsed = RunDetailSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({
        messagesSource: {
          phase: "failed",
          detail: null,
          errorMessage: `源详情数据结构校验失败：${describeZodError(parsed.error)}`,
        },
      });
      return;
    }
    set({ messagesSource: { phase: "ready", detail: parsed.data, errorMessage: null } });
  },

  setSettingsSection(section) {
    // U5 3.4：进设置 SHALL 撤销自动导航资格（delta「结果导航尊重用户当前阅读意图」）
    if (section !== null) noteReadingChanged();
    // U5 4.4：设置往返本身即撤销待用的执行确认（进出都算——确认时看到的模型/接入
    // 与回来后可能已经不是同一份配置了）
    else clearExecutionConfirmations();
    set({ settingsSection: section });
  },

  toggleCompare(runId) {
    const { compareIds } = get();
    if (compareIds.includes(runId)) {
      set({
        compareIds: compareIds.filter((id) => id !== runId),
        compareNotice: null,
      });
      return;
    }
    if (compareIds.length >= MAX_COMPARE) {
      set({ compareNotice: `最多同时对照 ${MAX_COMPARE} 条运行` });
      return;
    }
    set({ compareIds: [...compareIds, runId], compareNotice: null });
  },

  clearCompare() {
    set({ compareIds: [], compareNotice: null });
  },

  async proxyFork(parentRunId, atSpanId, messages, submission) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    // tasks 2.2b：把**提交这一刻**看到的代理事实随请求带上，供main 在副作用前核对。
    // renderer 的门禁只是 UX：确认到提交之间外部应用随时可能经过代理捕获新 key，
    // 也可能有人改了代理配置——那两种都必须由 main 拒绝，而不是靠这里"应该已经不旧了"。
    // ⚠️ 状态未知（proxy=null）时不编造版本：交0/空串让main 拒绝，这比"猜一个放行"安全。
    const proxy = get().proxy;
    const envelope = await submitActive(
      api.proxyFork,
      {
        parentRunId,
        atSpanId,
        messages,
        expectedKeyCaptureRevision: proxy?.keyCaptureRevision ?? 0,
        expectedUpstreamBaseUrl: proxy?.upstreamBaseUrl ?? "",
        expectedPort: proxy?.port ?? 0,
      },
      submission,
    );
    // U3 任务 3.4：已明确返回即收尾本次提交关联（草稿保留，见 design D5）
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.3：messages 重发也不消费响应——旧实现 `forking: "success"` + `loadRuns()` +
    // `selectRun(信封里的 id)`。delta 对这条入口的改判：执行结束 SHALL 刷新列表并按可信身份核实结果，
    // 自动导航仅在本次流程意图仍有效时进行（任务 3.4），所以这里只把请求标记复位。
    set({ forking: "idle" });
    return true;
  },
}));
