// AppState 分片：Runs 域（refactor-renderer 4.1 接口 / 5.1 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// 跨域协调者由 store.ts 显式注入（results 域 5.5 迁出前的注入点）。
import {
  isCurrentDetailAttempt,
  isCurrentDetailResponse,
  isDetailPayloadForRun,
  shouldApplyDetailFailure,
} from "@shared/detail-request";
import { findRunDetailVersionViolation } from "@shared/detail-version-guard";
import {
  type FailedFile,
  ListRunsDataSchema,
  type RunDetail,
  RunDetailSchema,
  type RunSummary,
} from "@shared/ipc";
import { decideRefresh, resolveRefreshFailure, settleRefresh } from "@shared/list-refresh";
import { ShortIdState } from "@shared/nav";
import { api } from "../../lib/api";
import { resolveReading } from "../../lib/reading-resolve";
import { patchReadingState, readingStateOf } from "../../lib/reading-state";
import {
  resolveExecutionGate,
  resolveFilterVisibility,
  resolveInitialSelection,
  resolveSourceAvailability,
} from "../../lib/workspace-selection";
import type { FilterVisibility, SourceAvailability } from "../../lib/workspace-selection";
import type { AppState, SliceContext } from "../types";
import type { DetailReadAttempts } from "./reading";

export interface RunsState {
  runs: RunSummary[];
  /** 读取失败的文件（隔离展示，不拖垮列表） */
  failed: FailedFile[];
  detail: RunDetail | null;
  selectedRunId: string | null;
  loadingList: boolean;
  loadingDetail: boolean;
  /** 列表曾成功加载过（用于区分「刷新失败」与「首次读取失败」的提示口径） */
  listLoaded: boolean;
  /** 列表刷新失败但旧记录仍在：界面据此提示「未更新」，不清空列表 */
  listStale: boolean;
  error: string | null;
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
  /** 在途刷新计数与尾随登记（任务 3.4）。不是 UI 状态，不参与渲染；放 store 内便于测试直接断言"读列表次数"。 */
  listRefreshInFlight: number;
  listRefreshPending: number;
  /** 短 ID 长度记忆（跨渲染存活；RunList 直接消费，组件不得自持） */
  shortIdState: ShortIdState;

  loadRuns: () => Promise<void>;
  /** 单次列表读取（不含合并调度；失败保留旧记录） */
  refreshRunsOnce: () => Promise<void>;
  selectRun: (id: string) => Promise<void>;
  /** 按同一 runId 重新读取详情（spec「结果不可读不重执行」的重试口）；不产生任何主动执行 */
  reopenRun: (id: string) => Promise<void>;
  autoSelectInitialRun: () => Promise<void>;
  /** 设置列表搜索词（与来源条件求交集；不改选当前运行） */
  setSearchQuery: (query: string) => void;
  /** 当前选中运行的源记录可用性（列表事实的纯派生，不缓存在字段里） */
  sourceAvailability: () => SourceAvailability;
  /** 当前选中运行是否被搜索/来源条件隐藏（导航据此提示，不改选） */
  filterVisibility: () => FilterVisibility;
  /** 依赖源记录的执行入口是否可用（源不可用 ⇒ 旧内容仍可见但不得执行） */
  canExecuteFromSource: () => boolean;
  setSourceFilter: (filter: "all" | "proxy" | "local") => void;
}

/** runs 分片工厂上下文：完整 set/get + 跨域协调者/共享 helper 的显式注入 */
export interface RunsSliceContext extends SliceContext {
  /** results 域协调者（5.5 迁出前由 store.ts 注入）：换阅读对象 ⇒ 撤销在飞导航资格 */
  noteReadingChanged: () => void;
  /** results→drafts 协调者（5.5 迁出前由 store.ts 注入）：ownOnly 落地 ⇒ 撤销来源绑定许可 */
  revokeSourceBoundPermissions: () => void;
  /** zod 错误统一描述（store.ts 本地 helper 下沉前的注入点，operations 等域共用） */
  describeZodError: (error: unknown) => string;
  /** 详情读取代次（唯一持有者在 reading 分片；selectRun 发起与迟到判据用） */
  detailReadAttempts: DetailReadAttempts;
}

export function createRunsSlice({
  set,
  get,
  noteReadingChanged,
  revokeSourceBoundPermissions,
  describeZodError,
  detailReadAttempts,
}: RunsSliceContext): RunsState {
  return {
    runs: [],
    failed: [],
    detail: null,
    selectedRunId: null,
    loadingList: false,
    loadingDetail: false,
    listLoaded: false,
    listStale: false,
    error: null,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    sourceFilter: "all",
    searchQuery: "",
    initialSelectionAttempted: false,
    sourceUnavailable: false,
    sourceUnavailableReason: "unknown",
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
      const attemptAtRequest = detailReadAttempts.next();

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
        if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempts.current())) return;
        set({ loadingDetail: false, error: `读取 run 失败：${envelope.error.message}` });
        return;
      }
      // 跨进程数据不可信：先确认载荷自称的 run id 与请求一致（防 main 回错 / 信封串号），
      // 再看目标 run 是否仍是当前选中——两道都过才允许落地。
      if (!isDetailPayloadForRun(envelope.data, id)) {
        if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
        if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempts.current())) return;
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
        if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempts.current())) return;
        set({
          loadingDetail: false,
          error: `轨迹数据版本校验失败（拒绝加载）：${versionViolation}`,
        });
        return;
      }
      const parsed = RunDetailSchema.safeParse(envelope.data);
      if (!parsed.success) {
        if (!isCurrentDetailResponse(get().selectedRunId, id)) return;
        if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempts.current())) return;
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
      if (!isCurrentDetailAttempt(attemptAtRequest, detailReadAttempts.current())) return;
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

    setSourceFilter(filter) {
      set({ sourceFilter: filter });
    },
  };
}
