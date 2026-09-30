import { deriveChainTotals, findCommonAncestor, indexRunsById } from "./derive";
import type { ChainTotals, CommonAncestor } from "./derive";
import type { RunSummary } from "./ipc";

/**
 * U7（improve-branch-comparison）tasks 1.7：以**本次已校验**的沿链自有摘要为
 * 唯一输入的共同祖先/累计派生。
 *
 * 与列表版 `deriveComparison` 的本质差别在输入：这里只喂比较响应 ready 项的
 * `chainSummaries`（main 从已校验物理记录现算，根→叶有序、含当前 run），绝不回退
 * 列表缓存——列表说完整而文件缺失时，chainSummaries 在缺失点截断，
 * `deriveChainTotals`/`findCommonAncestor` 对截断链自然判 incomplete ⇒
 * 「共同祖先判定不完整、受影响累计未知、所有祖先差不计算」，而完整另一侧的
 * 自有/累计照常可读（场景「列表完整但比较读取缺祖先」）。
 *
 * 复用而非重抄：链遍历、求和口径、增量差全部沿用 derive.ts 的既有纯函数——
 * 「累计增量（沿链求和）」「禁称总耗时/总成本」的措辞纪律同样适用。
 */

/** 派生输入：一个 ready 侧的已校验链摘要（unavailable 侧由调用方排除在外） */
export interface CompareSideInput {
  readonly runId: string;
  /** main 校验产出的沿链自有摘要（根→叶，含当前 run；ownOnly 时截断） */
  readonly chainSummaries: readonly RunSummary[];
}

/** 共同祖先关系的三态判定（分支树既有口径：不得把不完整报成不同根） */
export type CompareRelation =
  | { readonly kind: "common"; readonly ancestorId: string }
  /** 两侧链都完整走到根且确无公共 id */
  | { readonly kind: "unrelated" }
  /** 任一侧链不完整（ownOnly 截断等）——共同祖先不可确认，祖先差禁算 */
  | { readonly kind: "incomplete" };

/** 单侧派生结论：own 摘要、沿链累计（不可得即 null）与相对共同祖先增量 */
export interface CompareSideDerived {
  readonly runId: string;
  /** 当前 run 的自有摘要（输入链的最后一项） */
  readonly own: RunSummary | null;
  /** 沿链累计增量（沿链求和）；链不完整时为 null——不补 0、不估算 */
  readonly totals: ChainTotals | null;
  /** 相对共同祖先的增量差 = 该侧累计 − 祖先累计；不可比时为 null */
  readonly deltaFromAncestor: { tokens: number; durationMs: number | null } | null;
}

export interface VerifiedComparison {
  readonly relation: CompareRelation;
  /** common 时的共同祖先摘要（取自已校验链） */
  readonly ancestor: RunSummary | null;
  /** 与输入侧一一对应（同序同 id），调用方按 runId 对位消费 */
  readonly sides: readonly CompareSideDerived[];
}

/**
 * 从已校验链摘要派生共同祖先与累计。
 * 恒可用（不抛异常）；unavailable 侧不进输入 ⇒ 对应侧不产出结论。
 */
export function deriveVerifiedComparison(sides: readonly CompareSideInput[]): VerifiedComparison {
  // 本次已校验记录的并集是唯一事实源；同名 id 冲突时先到先得（正常链无重名）
  const verifiedRuns: RunSummary[] = [];
  const seen = new Set<string>();
  for (const side of sides) {
    for (const summary of side.chainSummaries) {
      if (!seen.has(summary.id)) {
        seen.add(summary.id);
        verifiedRuns.push(summary);
      }
    }
  }
  const byId = indexRunsById(verifiedRuns);

  const raw = findCommonAncestor(
    byId,
    sides.map((side) => side.runId),
  );
  const relation = toRelation(raw);
  const ancestor = relation.kind === "common" ? (byId.get(relation.ancestorId) ?? null) : null;
  const baseline = ancestor === null ? null : deriveChainTotals(byId, ancestor.id);
  const comparable = relation.kind === "common" && baseline !== null;

  const derived: CompareSideDerived[] = sides.map((side) => {
    const own = byId.get(side.runId) ?? null;
    const totals = deriveChainTotals(byId, side.runId);
    let deltaFromAncestor: CompareSideDerived["deltaFromAncestor"] = null;
    if (comparable && totals !== null && baseline !== null) {
      deltaFromAncestor = {
        tokens: totals.tokens - baseline.tokens,
        durationMs:
          totals.durationMs !== null && baseline.durationMs !== null
            ? totals.durationMs - baseline.durationMs
            : null,
      };
    }
    return { runId: side.runId, own, totals, deltaFromAncestor };
  });

  return { relation, ancestor, sides: derived };
}

function toRelation(raw: CommonAncestor): CompareRelation {
  if (raw.incomplete) return { kind: "incomplete" };
  if (raw.id === null) return { kind: "unrelated" };
  return { kind: "common", ancestorId: raw.id };
}
