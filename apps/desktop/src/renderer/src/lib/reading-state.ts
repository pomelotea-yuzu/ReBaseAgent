/**
 * 会话内按运行恢复阅读位置（U1 共用派生 · 任务 3.1 / 3.2 的纯逻辑层）。
 *
 * 本模块只做**纯函数**：把「每个 run 各自的阅读状态」组织成一个可序列化的结构，
 * 并提供合并/读取/校验辅助。不需要 Electron，也不需要 store——store 只是它的持有者。
 *
 * 纪律（对应 desktop-ui delta「会话内按运行恢复阅读位置」）：
 * - **只存会话**：不写 trace、不落盘、不承诺重启恢复。因此本结构**只含阅读位置**，
 *   绝不包含草稿、授权、凭据、正文副本——那些是编辑态/执行态的东西。
 * - **按 run 身份隔离**：不同 run 中相同 span ID **不得**串状态，故状态以 runId 为键、
 *   以 spanId 为内层键；读取时必须带 runId。
 * - **文件页只有页签**：文件内部检查点/路径/滚动属既有文件视图，本模块不承诺。
 */

/** 单次调用详情的阅读分区（详情面板内的分段/展开） */
export interface CallReadingState {
  /** 输入/输出切换 */
  io?: "input" | "output";
  /** 已展开的长文本块标识（如 "content" / "reasoning" / "tool_result"） */
  expanded?: string[];
  /** 该调用详情内的滚动位置（像素；仅会话记忆） */
  scrollTop?: number;
}

/** 单个 run 的阅读状态 */
export interface RunReadingState {
  /** 当前页签 */
  tab: "overview" | "steps" | "files";
  /** 选中的 span id（null = 尚未选择） */
  spanId: string | null;
  /** 展开的 step span id 集合 */
  expandedSteps: Record<string, boolean>;
  /** 该 run 概览区的滚动位置 */
  overviewScrollTop: number;
  /** 该 run 步骤目录的滚动位置 */
  stepsScrollTop: number;
  /** 每次调用的分区阅读状态（按 spanId 键） */
  calls: Record<string, CallReadingState>;
}

/** 全部 run 的阅读状态（store 持有） */
export type ReadingStateByRun = Record<string, RunReadingState>;

/** 新建一个 run 的默认阅读状态：首次访问进入概览（design D1） */
export function defaultReadingState(): RunReadingState {
  return {
    tab: "overview",
    spanId: null,
    expandedSteps: {},
    overviewScrollTop: 0,
    stepsScrollTop: 0,
    calls: {},
  };
}

/** 读取某 run 的阅读状态（不存在时返回默认值，不改动入参） */
export function readingStateOf(byRun: ReadingStateByRun, runId: string): RunReadingState {
  return byRun[runId] ?? defaultReadingState();
}

/** 不可变地更新某 run 的阅读状态片段（存在则合并，不存在则以默认值起底） */
export function patchReadingState(
  byRun: ReadingStateByRun,
  runId: string,
  patch: Partial<RunReadingState>,
): ReadingStateByRun {
  const current = readingStateOf(byRun, runId);
  return { ...byRun, [runId]: { ...current, ...patch } };
}

/** 不可变地更新某 run 某次调用的分区状态 */
export function patchCallReading(
  byRun: ReadingStateByRun,
  runId: string,
  spanId: string,
  patch: Partial<CallReadingState>,
): ReadingStateByRun {
  const current = readingStateOf(byRun, runId);
  const call = current.calls[spanId] ?? {};
  return {
    ...byRun,
    [runId]: { ...current, calls: { ...current.calls, [spanId]: { ...call, ...patch } } },
  };
}

/**
 * 校验阅读状态里的对象是否仍属于当前详情。
 *
 * 对应 delta「失效阅读对象安全回退」：重读后保存的 span / 展开对象不存在时，
 * 必须提示并清理失效引用，**不**选择另一个 run 的同 ID span。
 *
 * @returns 清理后的状态与是否发生了失效（供界面提示）
 */
export function reconcileReadingState(
  state: RunReadingState,
  detail: { spans: ReadonlyArray<{ id: string }>; hasFiles: boolean },
): { state: RunReadingState; invalidated: boolean } {
  const ids = new Set(detail.spans.map((span) => span.id));
  let invalidated = false;

  let spanId = state.spanId;
  if (spanId !== null && !ids.has(spanId)) {
    spanId = null; // 失效：清空，交由优先级逻辑选默认位置
    invalidated = true;
  }

  const expandedSteps: Record<string, boolean> = {};
  for (const [id, expanded] of Object.entries(state.expandedSteps)) {
    if (ids.has(id)) expandedSteps[id] = expanded;
    else invalidated = true;
  }

  const calls: Record<string, CallReadingState> = {};
  for (const [id, call] of Object.entries(state.calls)) {
    if (ids.has(id)) calls[id] = call;
    else invalidated = true;
  }

  // 文件页签不再适用（非隔离 run）⇒ 回退概览，不适用文件页
  let tab = state.tab;
  if (tab === "files" && !detail.hasFiles) {
    tab = "overview";
    invalidated = true;
  }

  if (!invalidated) return { state, invalidated: false };
  return { state: { ...state, spanId, expandedSteps, calls, tab }, invalidated: true };
}
