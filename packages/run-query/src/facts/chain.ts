import type { RunSummary } from "../schema.js";

/**
 * 运行链累计与对照的纯事实派生：只吃 `RunSummary[]`，不读文件、不发起 IPC。
 * 全部口径：沿 parent 链求和是「累计增量」，不是"从头连续跑一次"的消耗。
 */

/** 沿 parent 链求和得到的累计量（口径见 derive.ts 文件头） */
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
