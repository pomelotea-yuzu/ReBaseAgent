import type { Translator } from "@rebaseagent/i18n";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunSummary } from "./ipc";

export {
  deriveCacheHitTotal,
  deriveRunSummary,
  deriveTerminalReason,
  type RunLike,
} from "@rebaseagent/run-query/facts";

export {
  deriveAncestorIds,
  deriveChainTotals,
  deriveComparison,
  findCommonAncestor,
  indexRunsById,
  type ChainTotals,
  type CommonAncestor,
  type Comparison,
  type ComparisonEntry,
} from "@rebaseagent/run-query/facts";

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
 * - 「累计增量（沿链求和）」由 @rebaseagent/run-query/facts 的 deriveChainTotals 沿 parent 链现算，
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

/**
 * 定位某 span 所在 step 的 `llm.call`（main 侧 fork 编排与 renderer 提示**共用同一查表**）。
 *
 * 由 `main/fork-runner.ts` 的私有 `findStepLlm` 上移而来（同一语义只写一处——此前它只存在于
 * main，renderer 想用就得重写第二份）。行为与原实现逐字等价：
 * `atSpanId` 不在 spans 内 / 无父 / 父不是 `agent.step` / 同 step 无 `llm.call` ⇒ `null`。
 *
 * 传 run 文件自有 spans 时用于 fork 编排（分叉点必属本 run 新增段）；传分支 run 的展开视图时
 * 用于界面提示（用户点到祖先 span 时给的是祖先的 model，与 main 侧 `FORK_SPAN_NOT_IN_LEAF`
 * 的拒绝并不冲突）。
 */
export function findStepLlm(
  spans: readonly SpanLine[],
  atSpanId: string,
): Extract<SpanLine, { kind: "llm.call" }> | null {
  const at = spans.find((span) => span.id === atSpanId);
  if (at === undefined || at.parent === null) return null;
  const step = spans.find((span) => span.id === at.parent);
  if (step === undefined || step.kind !== "agent.step") return null;
  const llm = spans.find((span) => span.parent === step.id && span.kind === "llm.call");
  return llm !== undefined && llm.kind === "llm.call" ? llm : null;
}

/**
 * 「错误详情未记录」判定：run 以 `reason: error` 终止，但**本 run 自身**没有任何
 * 记录了失败的 `llm.call`。
 *
 * 两个都不许猜的坑，全部在这里一次性钉死：
 * - **只查本 run 自有 spans**：入参 `spans` 可能是 `getRun` 的展开视图（分支 run 含祖先前缀），
 *   祖先的失败记录不得冒充本次失败原因 ⇒ 必须用 `RunDetail.leafSpanIds` 过滤后再查。
 *   自身没有 `llm.call`（如代理录制的失败 run）同样判为缺失。
 * - **不反推失败原因**：判据只有「终止原因 + 有无 error 字段」，空正文 / 零 token /
 *   末尾 llm.call 一律不参与推断；字段缺失表示"未记录"，不等于"没出错"。
 */
export function deriveMissingLlmErrorDetail(input: {
  events: ReadonlyArray<{ reason: string }>;
  /** `getRun` 返回的（可能是合并后的）轨迹 */
  spans: readonly SpanLine[];
  /** 本 run（叶子）自身新增 span 的 id */
  leafSpanIds: readonly string[];
}): boolean {
  const lastEvent = input.events[input.events.length - 1];
  // 非错误终止（含 crashed：无终止事件）⇒ 不适用缺失提示
  if (lastEvent?.reason !== "error") return false;

  const own = new Set(input.leafSpanIds);
  for (const span of input.spans) {
    if (!own.has(span.id)) continue;
    // 先按 kind 缩窄（llm.call.error 是 object|undefined，判定用 !== undefined）
    if (span.kind === "llm.call" && span.error !== undefined) return false;
  }
  return true;
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

/** 分叉字段 → 边标签（只按字段名映射，不推断编辑内容） */
export function forkEditLabel(field: string, translator: Translator): string {
  if (field === "result") return translator.t("run.forkEditResult");
  if (field === "messages") return translator.t("run.forkEditMessages");
  if (field === "system_prompt") return translator.t("run.forkEditSystemPrompt");
  if (field === "user_message") return translator.t("run.forkEditUserMessage");
  if (field === "model_params") return translator.t("run.forkEditModelParams");
  return translator.t("run.forkEditOther", { field });
}

/**
 * 横向树布局（根在左，分支向右）：
 * - 叶子按顺序占一个纵向槽位，非叶节点的 y 取首末子节点 y 的中点（标准 tidy-tree 居中，
 *   缺了这句父节点会偏离子树中心、连线斜得很难看）
 * - 同输入必同输出：不依赖遍历顺序之外的随机源、不依赖容器尺寸
 */
export function layoutRunTree(
  forest: readonly RunTreeNode[],
  translator: Translator,
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
      const baseLabel = childFork === null ? null : forkEditLabel(childFork.edit_field, translator);
      const label =
        childFork !== null && baseLabel !== null && isPromptForkField(childFork.edit_field)
          ? `${baseLabel} · ${translator.t("run.forkFromStart")}`
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
