import { deriveResultSourceMapping } from "@shared/compare-source-map";
import { buildSpanTree } from "@shared/derive";
import type { RunDetail } from "@shared/ipc";
import { flattenSpanRows } from "./span-tree-view";
import type { SpanRowView } from "./span-tree-view";

/**
 * U7（improve-branch-comparison）tasks 4.8/4.9：比较的**独立步骤目录**。
 *
 * design D4 / delta 判据：
 * - **两侧目录完全独立**：各自从该侧已校验 RunDetail 派生，identity = 侧 + run +
 *   span——两侧重复的 `s_01`、相同轮号**不构成对齐依据**（scenario「重复 span ID
 *   与独立分支不强行对齐」：跨独立执行 hop 不展示共享执行前缀，步骤独立排列，
 *   选左不改变右——选中态在 store 的 compareStepSelection，本模块只管目录）；
 * - **来源归属**：来源映射（compare-source-map）可靠时每行标注物理来源 run；
 *   不可靠/不可映射时 sourceRunId 为 null 并如实说明——不猜、不按重复 id 猜；
 * - **ownOnly（4.9）**：祖先确实缺失 ⇒ `prefixUnknown: true`——部分侧只显示已
 *   校验自有步骤并提示前缀未知，**不按可见链首项推断根**、不折叠未知祖先；
 *   完整另一侧照常成目录（两侧互不影响）。
 *
 * 行的展示判据（展开/选择分离、自有/继承、错误标记、本地轮号不累加）全部复用
 * U1 的 `flattenSpanRows` / `buildSpanTree`，本模块只补来源归属与前缀未知位。
 */

/** 一行的全部展示事实（在 U1 SpanRowView 之上补物理来源） */
export type CompareStepRow = SpanRowView & {
  /** 该行 spans 的物理来源 run id；来源映射不可靠时为 null（不猜） */
  readonly sourceRunId: string | null;
};

/** 来源归属状态（决定视图如何标注「继承自哪个 run」） */
export type StepAttribution =
  | { readonly kind: "mapped" }
  | { readonly kind: "own" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** 比较中一侧的步骤目录 */
export interface SideStepCatalog {
  readonly runId: string;
  readonly rows: readonly CompareStepRow[];
  /**
   * 4.9：true = 祖先确实缺失（ownOnly）——视图提示「前缀未知」，
   * 不按可见链首项推断根，不折叠未知祖先。
   */
  readonly prefixUnknown: boolean;
  readonly attribution: StepAttribution;
}

/**
 * 从该侧已校验详情派生独立步骤目录（纯函数，零 Electron / 零 Node）。
 */
export function deriveSideStepCatalog(detail: RunDetail): SideStepCatalog {
  const mapping = deriveResultSourceMapping(detail);

  const attribution: StepAttribution =
    mapping.status === "mapped"
      ? detail.spanScope === "own"
        ? { kind: "own" }
        : { kind: "mapped" }
      : { kind: "unavailable", reason: mapping.reason };

  // span → 物理来源 run：仅映射可靠时可得；查不到（不该发生）宁可 null 不猜
  const sourceOf = (spanId: string): string | null => {
    if (mapping.status !== "mapped") return null;
    for (const segment of mapping.segments) {
      if (segment.spanIds.includes(spanId)) return segment.sourceRunId;
    }
    return null;
  };

  const ownIds = new Set(detail.leafSpanIds);
  const rows: CompareStepRow[] = flattenSpanRows(buildSpanTree(detail.spans), {
    ownIds,
  }).map((row) => ({ ...row, sourceRunId: sourceOf(row.spanId) }));

  return {
    runId: detail.meta.id,
    rows,
    prefixUnknown: detail.completeness === "ownOnly",
    attribution,
  };
}
