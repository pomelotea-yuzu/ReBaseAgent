import {
  isCurrentDetailResponse,
  isDetailPayloadForRun,
  shouldApplyDetailFailure,
} from "@shared/detail-request";
import { findRunDetailVersionViolation } from "@shared/detail-version-guard";
import type {
  ChooseSourceResult,
  CreateRunRequest,
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
  ProxyStateSchema,
  RunDetailSchema,
  SettingsStateSchema,
  WorkspaceInspectResultSchema,
  WorkspaceReadFileResultSchema,
} from "@shared/ipc";
import { decideRefresh, resolveRefreshFailure, settleRefresh } from "@shared/list-refresh";
import { ShortIdState } from "@shared/nav";
import { create } from "zustand";
import { api } from "./lib/api";
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

  /** 分叉重跑进行中状态（runs:fork 的唯一写通道） */
  forking: "idle" | "in_progress" | "success" | "error";
  /** 分叉失败的展示信息（来自信封 error） */
  forkError: string | null;
  /** 分叉失败的错误码（渲染层据此给针对性提示，如未配置） */
  forkErrorCode: string | null;

  /** 新建运行进行中状态（runs:create 写通道） */
  creatingRun: "idle" | "in_progress" | "success" | "error";
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
   * 主区域视图：trace = 既有三栏（列表 / span 树 / 详情），tree = 分支树。
   * 纯 UI 状态，不进 IPC、不持久化（design D7）。
   */
  view: "trace" | "tree";
  /** 加入对照的 run id（上限 4，分支树的 ComparePanel 消费） */
  compareIds: string[];
  /** 对照集合的操作提示（超上限等），空则无提示 */
  compareNotice: string | null;

  /**
   * 「新建运行」对话框是否打开（**全局单例**，任务 4.2）。
   *
   * 为什么进 store 而不是留在组件里：全局栏与列表标题区是**同一个对话框的两个入口**
   * （delta「新建与列表标题区既有入口打开同一现有创建流程」）。若各持一份本地 state，
   * 就会出现两个 CreateRunDialog 实例、两套表单状态，收起列表时全局入口还会失效。
   */
  createDialogOpen: boolean;
  /** 「录制接入」跳转后要高亮的设置分区（null = 常规打开设置） */
  settingsSection: "proxy" | null;

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
  selectRun: (id: string) => Promise<void>;
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
   * 编辑某 tool.invoke 的 result 并重跑；成功刷新列表并自动选中新 run。
   * `execution` 仅隔离父本携带（本次显式 `allowFileWrites:true`）——不传时请求里
   * **不出现该键**，普通父本走既有普通重跑，隔离父本会被 main/core 拒绝（不降级）。
   */
  forkAt: (
    parentRunId: string,
    atSpanId: string,
    value: string,
    execution?: IsolatedExecutionMode,
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
  promptFork: (parentRunId: string, edit: PromptForkRequest["edit"]) => Promise<boolean>;
  /**
   * 模型 A/B：dryRun = true 只校验并返回计划（不联网、不写文件）；
   * 真实执行成功后刷新列表（新 run 带实验组徽章），返回各臂计划与结果。
   */
  modelAb: (
    parentRunId: string,
    arms: ModelAbArm[],
    dryRun: boolean,
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
   * 新建运行（runs:create）：从头执行一个原生 run。
   * 请求由 `lib/create-run.ts` 的 `resolveCreateRunSubmission` 构造（纯对话 / 隔离两态同源），
   * store 只负责透传与状态机。成功刷新列表并自动选中新 run；返回是否成功。
   */
  createRun: (request: CreateRunRequest) => Promise<boolean>;
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

  loadSettings: () => Promise<void>;
  saveSettings: (input: SettingsInput) => Promise<boolean>;
  clearSettings: () => Promise<boolean>;

  loadProxyStatus: () => Promise<void>;
  /** 启停即保存（端口/upstream 一并生效）；失败返回 null 并在 error 里给出原因 */
  toggleProxy: (input: ProxyToggleInput) => Promise<ProxyState | null>;
  setSourceFilter: (filter: "all" | "proxy" | "local") => void;

  /** 切换主区域视图；只改 UI 状态，不触发列表重新加载（design D7） */
  setView: (view: "trace" | "tree") => void;
  /** 打开/关闭全局「新建运行」对话框（全局栏与列表标题区共用同一实例，任务 4.2） */
  setCreateDialogOpen: (open: boolean) => void;
  /** 打开设置并定位到某分区（全局栏「录制接入」用），null = 常规打开 */
  setSettingsSection: (section: "proxy" | null) => void;
  /** 勾选/取消对照（上限 4，超出不加入并给出提示） */
  toggleCompare: (runId: string) => void;
  clearCompare: () => void;
  /** 代理分叉（编辑 messages 经代理重发）；成功刷新列表并自动选中新 run */
  proxyFork: (
    parentRunId: string,
    atSpanId: string,
    messages: Record<string, unknown>[],
  ) => Promise<boolean>;
}

/** 跨进程数据不可信：统一用 schema 校验后再进状态 */
function describeZodError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
  listRefreshInFlight: 0,
  listRefreshPending: 0,

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
  createDialogOpen: false,
  settingsSection: null,
  shortIdState: new ShortIdState(),

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

  async selectRun(id) {
    if (get().selectedRunId === id) return;

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
      set({ loadingDetail: false, error: `读取 run 失败：${envelope.error.message}` });
      return;
    }
    // 跨进程数据不可信：先确认载荷自称的 run id 与请求一致（防 main 回错 / 信封串号），
    // 再看目标 run 是否仍是当前选中——两道都过才允许落地。
    if (!isDetailPayloadForRun(envelope.data, id)) {
      if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
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
      set({
        loadingDetail: false,
        error: `轨迹数据版本校验失败（拒绝加载）：${versionViolation}`,
      });
      return;
    }
    const parsed = RunDetailSchema.safeParse(envelope.data);
    if (!parsed.success) {
      if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
      set({
        loadingDetail: false,
        error: `轨迹数据结构校验失败：${describeZodError(parsed.error)}`,
      });
      return;
    }
    // 所有校验通过后仍需确认"目标 run 还是当前选中 run"——校验期间用户可能又切走了
    if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
    // 默认展开全部 step，用户可折叠；但恢复的历史状态优先（用户折叠过的保持折叠）
    const expandedSteps: Record<string, boolean> = {};
    for (const span of parsed.data.spans) {
      if (span.kind === "agent.step") expandedSteps[span.id] = true;
    }
    const mergedExpanded = { ...expandedSteps, ...restored.expandedSteps };
    // 统一走优先级解析（任务 3.2/3.6 接线）：显式目标 > 有效历史 > 默认位置。
    // 详情到手才做——此前 store 里可能还留着**另一个 run** 的未校验 spanId，
    // 直接当选中项会导致"轨迹树高亮一个不属于本 run 的 span"。
    const resolved = resolveReading({
      detail: {
        spans: parsed.data.spans,
        leafSpanIds: parsed.data.leafSpanIds,
        hasFiles: parsed.data.meta.workspace !== undefined,
      },
      history: { tab: restored.tab, spanId: restored.spanId },
      target: null,
      currentTab: restored.tab,
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
  },

  selectSpan(id) {
    const runId = get().selectedRunId;
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
    });
  },

  readingOf(runId) {
    return readingStateOf(get().readingByRun, runId);
  },

  setReadingTab(runId, tab) {
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

  async forkAt(parentRunId, atSpanId, value, execution) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await api.forkRun({
      parentRunId,
      atSpanId,
      edit: { field: "result", value },
      // 只在隔离父本时带上 execution：普通父本请求里不出现该键（语义清爽，且便于断言）
      ...(execution === undefined ? {} : { execution }),
    });
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // 成功：刷新列表（新 run 带分支徽章）并自动选中新 run（合并轨迹 + 分叉点标注）
    set({ forking: "success" });
    await get().loadRuns();
    await get().selectRun(envelope.data.id);
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

  async createRun(request) {
    set({ creatingRun: "in_progress", createRunError: null, createRunErrorCode: null });
    const envelope = await api.createRun(request);
    if (!envelope.ok) {
      set({
        creatingRun: "error",
        createRunError: envelope.error.message,
        createRunErrorCode: envelope.error.code,
      });
      // 失败也要刷新列表：error run 已按 meta.id 落盘，不刷新用户就看不到它
      // （spec：执行失败不产生半成品，但该 run 应在列表与详情中可查看）
      await get().loadRuns();
      return false;
    }
    // 成功：刷新列表（新 run 归入"本地记录"）并自动选中新 run
    set({ creatingRun: "success" });
    await get().loadRuns();
    await get().selectRun(envelope.data.id);
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

  async promptFork(parentRunId, edit) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await api.promptFork({ parentRunId, edit });
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // 成功：刷新列表并选中新 run（独立新轨迹 + 父级溯源；失败时不产生伪 run）
    set({ forking: "success" });
    await get().loadRuns();
    await get().selectRun(envelope.data.id);
    return true;
  },

  async modelAb(parentRunId, arms, dryRun) {
    set({ modelAbInFlight: true, modelAbError: null, modelAbErrorCode: null });
    const envelope = await api.modelAb({ parentRunId, arms, dryRun });
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
    // 真实执行：刷新列表（各臂新 run 带实验组徽章）；多臂不自动聚焦，由用户在树里挑
    await get().loadRuns();
    return envelope.data;
  },

  resetModelAb() {
    set({ modelAbInFlight: false, modelAbError: null, modelAbErrorCode: null });
  },

  async loadSettings() {
    const envelope = await api.getSettings();
    if (!envelope.ok) {
      set({ settings: null, error: `读取运行配置失败：${envelope.error.message}` });
      return;
    }
    const parsed = SettingsStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ settings: null, error: `运行配置数据结构校验失败：${describeZodError(parsed.error)}` });
      return;
    }
    set({ settings: parsed.data });
  },

  async saveSettings(input) {
    const envelope = await api.saveSettings(input);
    if (!envelope.ok) {
      set({ error: `保存运行配置失败：${envelope.error.message}` });
      return false;
    }
    // 回读状态（baseURL/model/加密方式；apiKey 永不回传）
    await get().loadSettings();
    return true;
  },

  async clearSettings() {
    const envelope = await api.clearSettings();
    if (!envelope.ok) {
      set({ error: `清除运行配置失败：${envelope.error.message}` });
      return false;
    }
    set({ settings: null });
    return true;
  },

  async loadProxyStatus() {
    const envelope = await api.proxyStatus();
    if (!envelope.ok) {
      set({ proxy: null, error: `读取代理状态失败：${envelope.error.message}` });
      return;
    }
    const parsed = ProxyStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ proxy: null, error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
      return;
    }
    set({ proxy: parsed.data });
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
    set({ view });
  },

  setCreateDialogOpen(open) {
    set({ createDialogOpen: open });
  },

  setSettingsSection(section) {
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

  async proxyFork(parentRunId, atSpanId, messages) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await api.proxyFork({ parentRunId, atSpanId, messages });
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    set({ forking: "success" });
    await get().loadRuns();
    await get().selectRun(envelope.data.id);
    return true;
  },
}));
