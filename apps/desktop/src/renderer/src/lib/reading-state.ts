/**
 * 会话内按运行恢复阅读位置（U1 共用派生 · 任务 3.1 / 3.2；U2 任务 2.1 扩展文件子结构）。
 *
 * 本模块只做**纯函数**：把「每个 run 各自的阅读状态」组织成一个可序列化的结构，
 * 并提供合并/读取/校验辅助。不需要 Electron，也不需要 store——store 只是它的持有者。
 *
 * 纪律（对应 desktop-ui delta「会话内按运行恢复阅读位置」「文件阅读在会话内按运行恢复并校验定位」）：
 * - **只存会话**：不写 trace、不落盘、不承诺重启恢复。因此本结构**只含阅读位置**，
 *   绝不包含草稿、授权、凭据、正文副本——那些是编辑态/执行态的东西。
 * - **按 run 身份隔离**：不同 run 中相同 span ID **不得**串状态，故状态以 runId 为键、
 *   以 spanId 为内层键；读取时必须带 runId。
 * - **U2 起文件内部状态提上来**：检查点/路径/pane/搜索/筛选/布局偏好/滚动位置按 run 保存，
 *   使文件组件卸载重建后仍能恢复（C 时代这些是组件局部 state，一卸载就丢）。
 *   仍然**不存正文/清单/哈希派生/Monaco 实例**——那些每次重新经只读 IPC 取。
 */

import type { ContentScrollAnchor } from "./file-scroll";

/**
 * 单个 run 的文件阅读状态（U2 任务 2.1）。
 *
 * 字段范围刻意**收敛在"阅读意图与位置"**：任何一字段都不能替代 IPC 的真实读取结果。
 * 缺省（`files === undefined`）表示"尚未进入文件页"。
 */
export interface FileReadingState {
  /**
   * 当前检查点。`null` **明确代表初始状态**，与 `undefined`（未初始化）区分。
   * 取值是自有 agent.step 的 span id。
   */
  checkpoint: string | null;
  /** 最后阅读的完整逻辑路径（不按 basename 匹配） */
  path: string | null;
  /** 列表 / 内容 意图（窄容器下二选一） */
  pane: "list" | "content";
  /** 路径搜索词（空串 = 无搜索） */
  query: string;
  /** 变化筛选偏好；auto 在初始取 all、完成步骤取 changed */
  filter: "auto" | "all" | "changed";
  /** 每运行目录首选宽度（px）与用户收起意图 */
  directoryWidth: number;
  directoryCollapsed: boolean;
  /** diff 模式偏好（auto 依空间决定）与换行开关 */
  diffPreference: "auto" | "inline" | "sideBySide";
  wordWrap: boolean;
  /** 列表滚动位置（像素） */
  listScrollTop: number;
  /**
   * 正文滚动锚点（U2 任务 4.3，design D1「正文按 run/step/path/侧记录行列锚点与滚动偏移」）。
   *
   * `null` = 尚无可恢复的正文位置。**必须按 (stepSpanId, path) 匹配后才可套用**——
   * 正文内容随检查点/路径整体更换，像素偏移不可跨内容复用（见 `lib/file-scroll.ts`）。
   */
  contentScroll: ContentScrollAnchor | null;
}

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
  /**
   * 概览页已展开的输出块标识（U1 任务 5.1）。
   *
   * 为什么单独一个字段而不是复用 `calls`：`calls` 的键是 spanId 且会经
   * `reconcileReadingState` 按"该 span 是否仍在详情里"清理；概览的正文块归属
   * **当前 run 的结果**而非某次调用（同一次调用可能既是最终输出又出现在详情里），
   * 混进去会被误清。这里只记一个"概览结果块是否展开"的短键，不随 span 失效而清。
   */
  overviewExpanded: string[];
  /** 每次调用的分区阅读状态（按 spanId 键） */
  calls: Record<string, CallReadingState>;
  /**
   * 文件页内部阅读状态（U2 任务 2.1）。缺省 = 尚未进入文件页。
   *
   * ⚠️ 这里是**可选**字段而不是必填：既有 `DEFAULT_READING_STATE` 是所有未访问 run 的
   * 共享稳定引用，加必填字段会强迫所有读点补默认值；可选字段让"没进过文件页"与
   * "进过但停在初始状态"天然可分（后者 `checkpoint === null` 但 `files !== undefined`）。
   */
  files?: FileReadingState;
}

/** 全部 run 的阅读状态（store 持有） */
export type ReadingStateByRun = Record<string, RunReadingState>;

/**
 * 稳定的默认阅读状态（**共享冻结常量**，非逐次 new）。
 *
 * ⚠️ 7.1 真实 Electron 实测：逐次 `new` 会让"未访问过的 run"的 `readingOf(runId)` 选择器
 *   每次返回**新引用**（`overviewExpanded` 是新建数组）⇒ zustand v5 `useSyncExternalStore`
 *   getSnapshot 引用不稳 ⇒ 无限重渲（`Maximum update depth exceeded`），整个应用启动即崩。
 *   zustand 订阅要求快照**引用稳定**；默认值对所有未初始化 run 共享同一实例即可（读多写少，
 *   全部写路径都走 immutable 的 `patch*`/`reconcile` 新建对象，**从不原地改**默认值）。
 */
const DEFAULT_READING_STATE: RunReadingState = {
  tab: "overview",
  spanId: null,
  expandedSteps: {},
  overviewScrollTop: 0,
  stepsScrollTop: 0,
  overviewExpanded: [],
  calls: {},
};

/** 新建一个 run 的默认阅读状态：首次访问进入概览（design D1） */
export function defaultReadingState(): RunReadingState {
  return DEFAULT_READING_STATE;
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
 * U2：文件阅读默认值（**共享冻结常量**，理由同 `DEFAULT_READING_STATE`——逐次 new 会让
 * 选择器引用不稳）。全部写路径走 `patchFileReading` 的新建对象，**从不原地改**本常量。
 */
const DEFAULT_FILE_READING_STATE: FileReadingState = {
  checkpoint: null,
  path: null,
  pane: "list",
  query: "",
  filter: "auto",
  directoryWidth: 232,
  directoryCollapsed: false,
  diffPreference: "auto",
  wordWrap: true,
  listScrollTop: 0,
  contentScroll: null,
};

/** 读取某 run 的文件阅读状态（缺失时返回共享默认值，不逐次 new） */
export function fileReadingOf(state: RunReadingState): FileReadingState {
  return state.files ?? DEFAULT_FILE_READING_STATE;
}

/**
 * 不可变地更新某 run 的文件阅读状态片段。
 *
 * `undefined` 值视为"不改这一项"——用 `Partial` 传 `pane: undefined` 时不应把 pane 清掉。
 */
export function patchFileReading(
  byRun: ReadingStateByRun,
  runId: string,
  patch: Partial<FileReadingState>,
): ReadingStateByRun {
  const current = readingStateOf(byRun, runId);
  const base = current.files ?? DEFAULT_FILE_READING_STATE;
  const next: FileReadingState = { ...base };
  const mutable = next as unknown as Record<string, unknown>;
  for (const key of Object.keys(patch) as (keyof FileReadingState)[]) {
    const value = patch[key];
    if (value !== undefined) mutable[key] = value;
  }
  return { ...byRun, [runId]: { ...current, files: next } };
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
