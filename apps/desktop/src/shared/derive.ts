import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunSummary } from "./ipc";

/**
 * 轨迹派生层：全部为纯函数，零 Electron、零 Node 依赖，可单测。
 *
 * 纪律：所有聚合数字（步数、token、耗时、错误数）一律从 spans 现算，
 * 不维护累加器、不写缓存——与 loop 侧"计数从数据派生"的不变量同源，
 * 也让后续编辑场景（Spec #4）下不必失效任何缓存。
 *
 * 口径纪律（分支树相关，务必分清）：
 * - deriveRunSummary 的数字是「本 run 自身新增 span」的聚合——入参是 readRun
 *   的原始记录，不含祖先前缀；而 getRun 返回的是 resolveBranch 拼接后的完整轨迹
 * - 「累计增量（沿链求和）」由本文件下方的 deriveChainTotals 沿 parent 链现算，
 *   物理上不等于"从头连续跑一次"的消耗（各段之间夹着用户思考与编辑的空档，
 *   且子 run 首次 llm.call 的输入含父前缀），措辞禁用"总耗时 / 总成本"
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
    /**
     * 分叉信息（根 run 为 null）。
     * 与 source 一样是刻意窄化的形态：只保留派生需要的字段，
     * 使 main 的 RunMetaLine 与 renderer 的 RunSummary 都能满足本接口。
     * value 用可选（?: unknown）与 zod 的 z.unknown() 推断对齐（zod 把 unknown 视为可缺省）。
     */
    fork: { at_span: string; edit: { field: string; value?: unknown } } | null;
    /** 录制来源（可选；代理录制的 run 为 { kind: "proxy", ... }） */
    source?: { kind: string } | undefined;
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
    // 分叉摘要：只透传分叉点、字段名与实验组标签，不带 value（避免放大列表载荷）
    fork:
      run.meta.fork === null
        ? null
        : {
            at_span: run.meta.fork.at_span,
            edit_field: run.meta.fork.edit.field,
            experiment_id: experimentIdOf(run.meta.fork),
          },
    reason: lastEvent?.reason ?? null,
    steps,
    toolCalls,
    toolErrors,
    tokensIn,
    tokensOut,
    durationMs,
    source: run.meta.source?.kind === "proxy" ? "proxy" : null,
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

// ---------------------------------------------------------------------------
// 分支树派生：森林构建 / 累计增量 / 共同祖先 / 对照
//
// 全部为纯函数，只吃 `runs:list` 已经在手的 RunSummary[]，
// 不读文件、不发起 IPC——树只是既有数据的一次投影，派生结果不进任何缓存。
// ---------------------------------------------------------------------------

/** run 被提为根的原因：父 run 不在列表中 / parent 链成环 */
export type RunOrphanReason = "missing-parent" | "cycle";

export interface RunTreeNode {
  run: RunSummary;
  depth: number;
  /** 非 null 表示该 run 被提为根（父缺失或父链成环），界面必须标注 */
  orphanReason: RunOrphanReason | null;
  children: RunTreeNode[];
}

/** 沿 parent 链求和得到的累计量（口径见文件头「口径纪律」） */
export interface ChainTotals {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  /** in + out 合计 */
  tokens: number;
  /** 沿链各段耗时之和；任一段耗时未知时为 null（不补 0、不估算） */
  durationMs: number | null;
}

/**
 * 共同祖先判定结果。
 * incomplete 为 true 表示链上存在父缺失或成环，**无法确认**真实关系——
 * 此时不得把结论呈现为「分属不同根」（那是把"不知道"说成"不是"）。
 */
export interface CommonAncestor {
  id: string | null;
  incomplete: boolean;
}

/** 对照中的一条分支：自身指标 + 累计增量 + 相对共同祖先的增量差 */
export interface ComparisonEntry {
  run: RunSummary;
  /** 累计增量；父缺失时为 null */
  totals: ChainTotals | null;
  /** 相对共同祖先的增量差；无可比基线或任一侧不可得时为 null */
  deltaFromAncestor: { tokens: number; durationMs: number | null } | null;
}

export interface Comparison {
  entries: ComparisonEntry[];
  commonAncestor: CommonAncestor;
}

/** 确定性排序：创建时间升序，同一时刻按 id 升序（保证同输入同输出） */
function compareRuns(a: RunSummary, b: RunSummary): number {
  const byTime = a.created_at.localeCompare(b.created_at);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

/**
 * 按 `parent` 建分支森林。
 *
 * 异常数据一律降级、绝不丢弃：
 * - 父 run 不在列表中 → 提为根并标 `missing-parent`
 * - parent 链成环 → 把环上被重复访问到的 run 提为根并标 `cycle`
 * 向上行走是迭代式的（深链不爆栈），成环判据与 `buildProxyChain` 的 seen 集合同构。
 */
export function buildRunForest(runs: readonly RunSummary[]): RunTreeNode[] {
  const byId = new Map<string, RunSummary>();
  for (const run of runs) byId.set(run.id, run);

  const orphanReason = new Map<string, RunOrphanReason>();

  for (const run of runs) {
    if (run.parent === null) continue;
    if (!byId.has(run.parent)) {
      orphanReason.set(run.id, "missing-parent");
      continue;
    }
    const path = new Set<string>([run.id]);
    let cursor: string | null = run.parent;
    while (cursor !== null) {
      if (path.has(cursor)) {
        orphanReason.set(cursor, "cycle"); // 环上被重复访问的那个 run 提为根
        break;
      }
      path.add(cursor);
      const parent = byId.get(cursor);
      // 更上层的祖先缺失：本 run 仍能挂到自己的父上，只影响"链是否完整"
      if (parent === undefined) break;
      cursor = parent.parent;
    }
  }

  // 被提为根的 run 不再作为子节点挂载，否则环会重新出现
  const childrenOf = new Map<string, RunSummary[]>();
  for (const run of runs) {
    if (run.parent === null || orphanReason.has(run.id)) continue;
    const siblings = childrenOf.get(run.parent);
    if (siblings === undefined) childrenOf.set(run.parent, [run]);
    else siblings.push(run);
  }
  for (const siblings of childrenOf.values()) siblings.sort(compareRuns);

  const build = (run: RunSummary, depth: number): RunTreeNode => {
    const children = (childrenOf.get(run.id) ?? []).map((child) => build(child, depth + 1));
    return {
      run,
      depth,
      orphanReason: orphanReason.get(run.id) ?? null,
      children,
    };
  };

  return runs
    .filter((run) => run.parent === null || orphanReason.has(run.id))
    .sort(compareRuns)
    .map((run) => build(run, 0));
}

/** 把 run 列表转成 id 索引（累计与对照的输入都按 id 查，避免重复扫描） */
export function indexRunsById(runs: readonly RunSummary[]): Map<string, RunSummary> {
  return new Map(runs.map((run) => [run.id, run]));
}

interface ChainWalk {
  /** 自叶向根的可见段（首个元素是被查的 run 本身） */
  chain: RunSummary[];
  /** true 表示链上有父缺失或成环，无法确认完整关系 */
  incomplete: boolean;
}

/**
 * 自叶向根走一条链。
 * 链不完整时**仍返回可见段**并置 incomplete——两种用途据此各取所需：
 * 累计增量要求整条可得（不可得即为 null），共同祖先则可以在可见范围内给出答案、
 * 同时标注"未经验证"。绝不把"可见范围内没找到"直接说成"不存在"。
 */
function walkUpChain(byId: ReadonlyMap<string, RunSummary>, runId: string): ChainWalk {
  const chain: RunSummary[] = [];
  const seen = new Set<string>();
  let cursor: RunSummary | undefined = byId.get(runId);
  if (cursor === undefined) return { chain, incomplete: true };

  while (cursor !== undefined) {
    if (seen.has(cursor.id)) return { chain, incomplete: true }; // 成环
    seen.add(cursor.id);
    chain.push(cursor);
    if (cursor.parent === null) return { chain, incomplete: false };
    cursor = byId.get(cursor.parent);
    if (cursor === undefined) return { chain, incomplete: true }; // 父缺失
  }
  return { chain, incomplete: true };
}

/**
 * 累计增量：沿 parent 链把各代「本 run 增量」逐段求和。
 * 链上任何一段缺失（父 run 不在列表 / 成环）→ 整条返回 null，不补 0、不估算。
 */
export function deriveChainTotals(
  byId: ReadonlyMap<string, RunSummary>,
  runId: string,
): ChainTotals | null {
  const { chain, incomplete } = walkUpChain(byId, runId);
  if (incomplete) return null;

  const totals: ChainTotals = {
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokens: 0,
    durationMs: 0,
  };
  for (const run of chain) {
    totals.steps += run.steps;
    totals.toolCalls += run.toolCalls;
    totals.toolErrors += run.toolErrors;
    totals.tokensIn += run.tokensIn;
    totals.tokensOut += run.tokensOut;
    if (run.durationMs === null) totals.durationMs = null;
    else if (totals.durationMs !== null) totals.durationMs += run.durationMs;
  }
  totals.tokens = totals.tokensIn + totals.tokensOut;
  return totals;
}

/**
 * 共同祖先：各条链从根开始比对，取最后一个公共 id。
 * 任一条链不完整时 incomplete 为 true——此时即便找到了公共 id 也只是"可见范围内的"，
 * 更深的共同祖先可能随被删的中间 run 一起消失了。
 */
export function findCommonAncestor(
  byId: ReadonlyMap<string, RunSummary>,
  runIds: readonly string[],
): CommonAncestor {
  const rootFirst: string[][] = [];
  let incomplete = false;

  for (const runId of runIds) {
    const walk = walkUpChain(byId, runId);
    if (walk.incomplete) incomplete = true;
    if (walk.chain.length > 0) rootFirst.push(walk.chain.map((run) => run.id).reverse());
  }

  if (rootFirst.length === 0) return { id: null, incomplete: true };

  const base = rootFirst[0] ?? [];
  let common: string | null = null;
  for (let i = 0; i < base.length; i++) {
    const candidate = base[i];
    if (candidate === undefined) break;
    if (rootFirst.every((chain) => chain[i] === candidate)) common = candidate;
    else break;
  }
  return { id: common, incomplete };
}

/**
 * 某 run 的祖先链 id 集合（含自身）：供分支树高亮「根到当前 run」的共享前缀。
 * 链不完整时只返回可见段——高亮到断链处为止，不假装看到了更上面的祖先。
 */
export function deriveAncestorIds(
  byId: ReadonlyMap<string, RunSummary>,
  runId: string,
): Set<string> {
  const { chain } = walkUpChain(byId, runId);
  return new Set(chain.map((run) => run.id));
}

/**
 * 多分支对照：各 run 自身指标 + 累计增量 + 相对共同祖先的增量差。
 * 无可比基线（无共同祖先 / 判定不完整 / 任一侧累计不可得）时增量差为 null。
 */
export function deriveComparison(
  runs: readonly RunSummary[],
  runIds: readonly string[],
): Comparison {
  const byId = indexRunsById(runs);
  const commonAncestor = findCommonAncestor(byId, runIds);
  const baseline = commonAncestor.id === null ? null : deriveChainTotals(byId, commonAncestor.id);
  const comparable = commonAncestor.id !== null && !commonAncestor.incomplete && baseline !== null;

  const entries: ComparisonEntry[] = [];
  for (const runId of runIds) {
    const run = byId.get(runId);
    if (run === undefined) continue;
    const totals = deriveChainTotals(byId, runId);
    let deltaFromAncestor: ComparisonEntry["deltaFromAncestor"] = null;
    if (comparable && totals !== null && baseline !== null) {
      deltaFromAncestor = {
        tokens: totals.tokens - baseline.tokens,
        durationMs:
          totals.durationMs !== null && baseline.durationMs !== null
            ? totals.durationMs - baseline.durationMs
            : null,
      };
    }
    entries.push({ run, totals, deltaFromAncestor });
  }
  return { entries, commonAncestor };
}

// ---------------------------------------------------------------------------
// 分支树布局：确定性纯计算，渲染层只负责把坐标画出来
// ---------------------------------------------------------------------------

export interface RunTreeLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  /** 层间水平间距（连线长度） */
  gapX?: number;
  /** 同层相邻节点的垂直间距 */
  gapY?: number;
  padding?: number;
}

export interface PositionedRunNode {
  id: string;
  run: RunSummary;
  depth: number;
  orphanReason: RunOrphanReason | null;
  /** 节点左上角坐标（容器坐标系，含 padding） */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedRunEdge {
  from: string;
  to: string;
  /** SVG path（三次贝塞尔，父子间水平入/出） */
  path: string;
  /** 边标签锚点 */
  labelX: number;
  labelY: number;
  /** 分叉边标签（「改 tool_result」等）；根 run 的边为 null */
  label: string | null;
  fork: RunSummary["fork"];
}

export interface RunTreeLayout {
  nodes: PositionedRunNode[];
  edges: PositionedRunEdge[];
  width: number;
  height: number;
}

/** 坐标保留两位小数：既避免长浮点尾数，又保持确定性（同输入同字符串） */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** prompt fork 字段（system_prompt / user_message）：从头重跑的独立新轨迹，不共享父前缀 */
export function isPromptForkField(field: string): boolean {
  return field === "system_prompt" || field === "user_message";
}

/** 分叉字段 → 中文边标签（只按字段名映射，不推断编辑内容） */
export function forkEditLabel(field: string): string {
  if (field === "result") return "改 tool_result";
  if (field === "messages") return "改 messages";
  if (field === "system_prompt") return "改 system prompt";
  if (field === "user_message") return "改 user message";
  if (field === "model_params") return "换 model/params（A/B）";
  return `改 ${field}`;
}

/** model_params 分叉的实验组标签（同批所有臂共享）；其它分叉恒为 null */
function experimentIdOf(fork: NonNullable<RunLike["meta"]["fork"]>): string | null {
  if (fork.edit.field !== "model_params") return null;
  const value = fork.edit.value;
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { experimentId?: unknown }).experimentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * 横向树布局（根在左，分支向右）：
 * - 叶子按顺序占一个纵向槽位，非叶节点的 y 取首末子节点 y 的中点（标准 tidy-tree 居中，
 *   缺了这句父节点会偏离子树中心、连线斜得很难看）
 * - 同输入必同输出：不依赖遍历顺序之外的随机源、不依赖容器尺寸
 */
export function layoutRunTree(
  forest: readonly RunTreeNode[],
  options: RunTreeLayoutOptions = {},
): RunTreeLayout {
  const { nodeWidth = 176, nodeHeight = 76, gapX = 72, gapY = 16, padding = 16 } = options;

  const nodes: PositionedRunNode[] = [];
  const edges: PositionedRunEdge[] = [];
  let slot = 0;

  interface Placed {
    tree: RunTreeNode;
    x: number;
    y: number;
    centerY: number;
  }

  const place = (node: RunTreeNode): Placed => {
    const x = padding + node.depth * (nodeWidth + gapX);

    if (node.children.length === 0) {
      const y = padding + slot * (nodeHeight + gapY);
      slot += 1;
      nodes.push({
        id: node.run.id,
        run: node.run,
        depth: node.depth,
        orphanReason: node.orphanReason,
        x: round2(x),
        y: round2(y),
        width: nodeWidth,
        height: nodeHeight,
      });
      return { tree: node, x, y, centerY: y + nodeHeight / 2 };
    }

    const placed = node.children.map(place);
    // 父节点居中于首末子节点之间（标准 tidy-tree）；children.length > 0 由分支保证
    let minCenterY = Number.POSITIVE_INFINITY;
    let maxCenterY = Number.NEGATIVE_INFINITY;
    for (const item of placed) {
      if (item.centerY < minCenterY) minCenterY = item.centerY;
      if (item.centerY > maxCenterY) maxCenterY = item.centerY;
    }
    const centerY = (minCenterY + maxCenterY) / 2;
    const y = centerY - nodeHeight / 2;

    nodes.push({
      id: node.run.id,
      run: node.run,
      depth: node.depth,
      orphanReason: node.orphanReason,
      x: round2(x),
      y: round2(y),
      width: nodeWidth,
      height: nodeHeight,
    });

    for (const child of placed) {
      const startX = x + nodeWidth;
      const endX = child.x;
      const midX = (startX + endX) / 2;
      const childFork = child.tree.run.fork;
      // prompt fork 的边标注「从头重跑」，不把 at_span 呈现为普通分叉点
      const baseLabel = childFork === null ? null : forkEditLabel(childFork.edit_field);
      const label =
        childFork !== null && baseLabel !== null && isPromptForkField(childFork.edit_field)
          ? `${baseLabel} · 从头重跑`
          : baseLabel;
      edges.push({
        from: node.run.id,
        to: child.tree.run.id,
        path: `M${round2(startX)} ${round2(centerY)} C ${round2(midX)} ${round2(centerY)}, ${round2(
          midX,
        )} ${round2(child.centerY)}, ${round2(endX)} ${round2(child.centerY)}`,
        labelX: round2(midX),
        labelY: round2((centerY + child.centerY) / 2 - 6),
        label,
        fork: childFork,
      });
    }

    return { tree: node, x, y, centerY };
  };

  for (const root of forest) place(root);

  const maxX = nodes.reduce((max, node) => Math.max(max, node.x + node.width), 0);
  const width = nodes.length === 0 ? 0 : round2(maxX + padding);
  const height = slot === 0 ? padding * 2 : round2(padding * 2 + slot * (nodeHeight + gapY) - gapY);

  return { nodes, edges, width, height };
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
