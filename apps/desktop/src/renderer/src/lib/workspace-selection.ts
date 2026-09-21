/**
 * 工作区选择状态（U1 共用派生 · 任务 3.5）。
 *
 * 三件事，都是**纯函数**：
 *   1. **首次自动选择**：列表首次成功加载且尚无选中项时，尝试「最近可读摘要」
 *      对应的运行并进入概览；失败**不**遍历其他记录。
 *   2. **筛选隐藏当前运行**：搜索/来源条件把当前选中运行滤掉时，主工作区继续显示它，
 *      只给导航一个「不在筛选结果中」的提示与清除入口——不自动改选。
 *   3. **已选源记录不可用**：刷新确认选中运行的源文件消失或读取失败时，标明源不可用，
 *      并**禁用依赖它的新执行**；重新读取校验通过前不解禁。
 *
 * 纪律（对应 desktop-ui delta）：
 *   - 「最近可读摘要」= 列表倒序第一条（main 已按创建时间倒序），且必须来自 `runs`
 *     而不是 `failed`——`failed` 是**文件级**失败，无法与某条 run 对应。
 *   - 首次自动选择是**一次性**动作：失败后留在该 run 的错误态，由用户原位重试；
 *     绝不因为"这条读不了"就自动去试下一条（那会变成静默遍历整个列表）。
 *   - 源不可用时**旧内容仍在屏幕上**，但不得据此获得执行资格——"看得见"不代表"可执行"。
 */

import type { FailedFile, RunSummary } from "@shared/ipc";
import { matchesSearch, matchesSource } from "@shared/nav";

/** 首次自动选择的结论 */
export interface InitialSelection {
  /** 应当选中的 run id；null = 不做选择 */
  runId: string | null;
  /** 为何不选（供界面呈现，不是错误） */
  reason: "selected" | "already-selected" | "no-runs" | "not-loaded";
}

/**
 * 首次自动选择：只在「列表已成功加载 + 当前无选中项 + 列表非空」时发生。
 *
 * @param runs         当前列表（main 保证按创建时间倒序）
 * @param selectedRunId 当前选中（null = 尚未选择）
 * @param listLoaded   列表是否曾成功加载
 * @param attempted    首次自动选择是否**已经尝试过**（一次性动作的守卫）
 */
export function resolveInitialSelection(input: {
  runs: readonly RunSummary[];
  selectedRunId: string | null;
  listLoaded: boolean;
  attempted: boolean;
}): InitialSelection {
  if (input.selectedRunId !== null) return { runId: null, reason: "already-selected" };
  // 一次性：已尝试过就不再自动选（失败后由用户原位重试，不做静默遍历）
  if (input.attempted) return { runId: null, reason: "already-selected" };
  if (!input.listLoaded) return { runId: null, reason: "not-loaded" };
  const first = input.runs[0];
  if (first === undefined) return { runId: null, reason: "no-runs" };
  return { runId: first.id, reason: "selected" };
}

/** 筛选隐藏判定的结论 */
export interface FilterVisibility {
  /** 当前选中运行是否被筛选条件隐藏 */
  hidden: boolean;
  /** 是否存在任何生效的筛选条件（决定要不要给"清除条件"入口） */
  hasActiveFilters: boolean;
}

/**
 * 当前选中运行是否被搜索/来源条件隐藏。
 *
 * 只读判定，**不改选**：调用方据此在导航里提示并给清除入口，主工作区照常显示该运行。
 */
export function resolveFilterVisibility(input: {
  runs: readonly RunSummary[];
  selectedRunId: string | null;
  query: string;
  filter: "all" | "proxy" | "local";
}): FilterVisibility {
  const hasActiveFilters = input.query.trim() !== "" || input.filter !== "all";
  if (input.selectedRunId === null || !hasActiveFilters) {
    return { hidden: false, hasActiveFilters };
  }
  const selected = input.runs.find((run) => run.id === input.selectedRunId);
  // 选中运行已不在列表里（源消失）⇒ 不是"被筛选隐藏"，归源不可用处理
  if (selected === undefined) return { hidden: false, hasActiveFilters };
  const visible = matchesSource(selected, input.filter) && matchesSearch(selected, input.query);
  return { hidden: !visible, hasActiveFilters };
}

/** 源记录可用性 */
export interface SourceAvailability {
  /** 源记录是否不可用（消失或读取失败） */
  unavailable: boolean;
  /** 不可用的原因，供界面呈现 */
  reason: "available" | "missing" | "unreadable" | "unknown";
}

/**
 * 判定当前选中运行的源记录是否仍可用。
 *
 * 判据（只认列表的当前事实，不猜）：
 *   - 列表里仍有该 run ⇒ `available`；
 *   - 列表里没有它，但同时存在**读取失败的文件** ⇒ `unreadable`
 *     （可能正是它的源文件，但我们**不**断言是哪一条——只报"源记录不可用"）；
 *   - 列表里没有它、且无失败文件 ⇒ `missing`（被删除或移出 traces）；
 *   - 列表尚未成功加载过 ⇒ `unknown`（没有可依据的事实，不误报不可用）。
 */
export function resolveSourceAvailability(input: {
  runs: readonly RunSummary[];
  failed: readonly FailedFile[];
  selectedRunId: string | null;
  listLoaded: boolean;
}): SourceAvailability {
  // 没有选中项 ⇒ 无所谓源可用性（不报不可用）
  if (input.selectedRunId === null) return { unavailable: false, reason: "available" };
  // 列表从未成功加载过 ⇒ 没有任何可依据的事实。**必须**在"列表里没有它"之前判，
  // 否则首次读取失败会被误报成"源记录已消失"（把"不知道"说成"没有"）。
  if (!input.listLoaded) return { unavailable: false, reason: "unknown" };
  if (input.runs.some((run) => run.id === input.selectedRunId)) {
    return { unavailable: false, reason: "available" };
  }
  return {
    unavailable: true,
    reason: input.failed.length > 0 ? "unreadable" : "missing",
  };
}

/**
 * 依赖源记录的执行入口是否应当禁用。
 *
 * 「源记录不可用」时，屏幕上的**旧内容仍在**（不擦掉，用户还看得见正在看的东西），
 * 但**不得据此获得执行资格**——所以 fork/prompt fork/代理重发/模型实验/新建隔离执行的
 * 入口一并禁用，直到重新读取并校验通过。
 *
 * @param editing 是否处于编辑态（读取中/未加载完时也不放行）
 */
export function resolveExecutionGate(input: {
  unavailable: boolean;
  reading: boolean;
  listLoaded: boolean;
}): boolean {
  if (!input.listLoaded) return false;
  if (input.reading) return false;
  return !input.unavailable;
}
