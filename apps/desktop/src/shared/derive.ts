import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunSummary } from "./ipc";

/**
 * 轨迹派生层：全部为纯函数，零 Electron、零 Node 依赖，可单测。
 *
 * 纪律：所有聚合数字（步数、token、耗时、错误数）一律从 spans 现算，
 * 不维护累加器、不写缓存——与 loop 侧"计数从数据派生"的不变量同源，
 * 也让后续编辑场景（Spec #4）下不必失效任何缓存。
 */

/** span 的墙上耗时（毫秒）；timing 缺省返回 null，表示时间未知 */
export function spanDurationMs(span: SpanLine): number | null {
  if (span.timing === undefined) return null;
  const start = Date.parse(span.timing.started_at);
  const end = Date.parse(span.timing.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** span 树节点 */
export interface SpanNode {
  span: SpanLine;
  children: SpanNode[];
  /** true 表示父 span 不在这条轨迹里（手工编辑过的文件）——不静默丢弃，挂到根并标注 */
  orphan: boolean;
}

/**
 * 扁平 span 列表 → 森林（按 parent 建树）。
 * 父 id 不存在的 span 挂到根层并标记 orphan。
 */
export function buildSpanTree(spans: readonly SpanLine[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  for (const span of spans) {
    nodes.set(span.id, { span, children: [], orphan: false });
  }

  const roots: SpanNode[] = [];
  for (const span of spans) {
    const node = nodes.get(span.id);
    if (node === undefined) continue;
    const parent = span.parent === null ? undefined : nodes.get(span.parent);
    if (parent === undefined) {
      // 根 span，或父 span 缺失的孤儿
      if (span.parent !== null) node.orphan = true;
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  return roots;
}

/** 深度优先展开为列表（供键盘导航与扁平渲染复用） */
export function flattenTree(roots: readonly SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (node: SpanNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** 汇总计算的最小输入形状（main 的 RunRecord 与 renderer 的 RunDetail 都满足） */
export interface RunLike {
  meta: {
    id: string;
    task: string;
    model: string;
    created_at: string;
    parent: string | null;
  };
  spans: readonly SpanLine[];
  events: ReadonlyArray<{ reason: string }>;
  status: "completed" | "crashed";
}

/** 单个 span 子树内的聚合（step 的耗时与 token 全部来自其子节点） */
export interface StepStats {
  tokensIn: number;
  tokensOut: number;
  /** 子树耗时（毫秒）；子树内无有效 timing 时为 null */
  durationMs: number | null;
  toolCalls: number;
  toolErrors: number;
  /** 子树内已知 span 耗时的合计（不含 LLM 等待外的空档） */
  knownMs: number;
}

function emptyStats(): StepStats {
  return { tokensIn: 0, tokensOut: 0, durationMs: null, toolCalls: 0, toolErrors: 0, knownMs: 0 };
}

/** 聚合一个 span 子树（含自身） */
export function deriveStepStats(node: SpanNode): StepStats {
  const stats = emptyStats();
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const { span } of flattenTree([node])) {
    if (span.kind === "llm.call") {
      stats.tokensIn += span.response.usage.in;
      stats.tokensOut += span.response.usage.out;
    } else if (span.kind === "tool.invoke") {
      stats.toolCalls += 1;
      if (span.error !== null) stats.toolErrors += 1;
    }
    const ms = spanDurationMs(span);
    if (ms !== null) {
      stats.knownMs += ms;
    }
    if (span.timing !== undefined) {
      const start = Date.parse(span.timing.started_at);
      const end = Date.parse(span.timing.ended_at);
      if (!Number.isNaN(start)) earliest = earliest === null ? start : Math.min(earliest, start);
      if (!Number.isNaN(end)) latest = latest === null ? end : Math.max(latest, end);
    }
  }

  // 子树跨度 = 最晚结束 - 最早开始；无任一 span 带 timing 时为 null（时间未知）
  stats.durationMs = earliest !== null && latest !== null ? Math.max(0, latest - earliest) : null;
  return stats;
}

/** 整个 run 的摘要（列表行所需的全部聚合数字） */
export function deriveRunSummary(run: RunLike): RunSummary {
  let steps = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const span of run.spans) {
    if (span.kind === "agent.step") steps += 1;
    if (span.kind === "tool.invoke") {
      toolCalls += 1;
      if (span.error !== null) toolErrors += 1;
    }
    if (span.kind === "llm.call") {
      tokensIn += span.response.usage.in;
      tokensOut += span.response.usage.out;
    }
    if (span.timing !== undefined) {
      const start = Date.parse(span.timing.started_at);
      const end = Date.parse(span.timing.ended_at);
      if (!Number.isNaN(start)) earliest = earliest === null ? start : Math.min(earliest, start);
      if (!Number.isNaN(end)) latest = latest === null ? end : Math.max(latest, end);
    }
  }

  const durationMs = earliest !== null && latest !== null ? Math.max(0, latest - earliest) : null;
  const lastEvent = run.events[run.events.length - 1];

  return {
    id: run.meta.id,
    task: run.meta.task,
    model: run.meta.model,
    created_at: run.meta.created_at,
    status: run.status,
    parent: run.meta.parent,
    reason: lastEvent?.reason ?? null,
    steps,
    toolCalls,
    toolErrors,
    tokensIn,
    tokensOut,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// 上下文预算地图派生：只从 spans 现算，预算上限在调用方（meta.budget）兜底
// ---------------------------------------------------------------------------

/** 预算地图上的一个数据点（一次 llm.call 的累计 token 占用） */
export interface BudgetPoint {
  /** llm.call 次序（从 1 起）；跳过非 llm 的 span */
  index: number;
  spanId: string;
  tokensIn: number;
  tokensOut: number;
  /** 迄今所有 llm.call 的 in+out 累计（与 loop 侧 deriveTotalTokens 口径一致） */
  cumulative: number;
}

/** 预算曲线：points 按 SpanTree 的 DFS 顺序（与界面树同序） */
export interface BudgetSeries {
  points: BudgetPoint[];
  /** 累计 in+out 总和 */
  total: number;
}

/**
 * 从 spans 派生预算曲线：只收集 `llm.call`，按 `flattenTree` 的 DFS 顺序累加 in+out。
 * 预算上限不在此处读取（由调用方从 meta.budget?.max_total_tokens 取，缺省 null）。
 * 纯函数、无缓存——与同文件纪律一致，编辑后无需失效缓存。
 */
export function deriveBudgetSeries(spans: readonly SpanLine[]): BudgetSeries {
  const points: BudgetPoint[] = [];
  let cumulative = 0;
  for (const { span } of flattenTree(buildSpanTree(spans))) {
    if (span.kind !== "llm.call") continue;
    cumulative += span.response.usage.in + span.response.usage.out;
    points.push({
      index: points.length + 1,
      spanId: span.id,
      tokensIn: span.response.usage.in,
      tokensOut: span.response.usage.out,
      cumulative,
    });
  }
  return { points, total: cumulative };
}
