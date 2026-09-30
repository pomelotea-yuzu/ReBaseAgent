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

/** 一行的全部展示事实（在 U1 SpanRowView 之上补物理来源与编辑标记） */
export type CompareStepRow = SpanRowView & {
  /** 该行 spans 的物理来源 run id；来源映射不可靠时为 null（不猜） */
  readonly sourceRunId: string | null;
  /**
   * 4.14：该行是某跳 fork 编辑边界（共同区被覆写值所在，仍保留原值）时的编辑
   * 标注——编辑发生在 `targetRunId` 那一跳，字段为 `field`。非边界行为 null。
   */
  readonly editMarker: { readonly targetRunId: string; readonly field: string } | null;
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

  // span → 物理来源 run / 编辑边界：仅映射可靠时可得；查不到（不该发生）宁可 null 不猜
  const sourceOf = (spanId: string): string | null => {
    if (mapping.status !== "mapped") return null;
    for (const segment of mapping.segments) {
      if (segment.spanIds.includes(spanId)) return segment.sourceRunId;
    }
    return null;
  };
  const editMarkerOf = (spanId: string): CompareStepRow["editMarker"] => {
    if (mapping.status !== "mapped") return null;
    for (const segment of mapping.segments) {
      const last = segment.spanIds[segment.spanIds.length - 1];
      if (segment.boundaryEdit !== null && last === spanId) {
        return { targetRunId: segment.boundaryEdit.targetRunId, field: segment.boundaryEdit.field };
      }
    }
    return null;
  };

  const ownIds = new Set(detail.leafSpanIds);
  const rows: CompareStepRow[] = flattenSpanRows(buildSpanTree(detail.spans), {
    ownIds,
  }).map((row) => ({
    ...row,
    sourceRunId: sourceOf(row.spanId),
    editMarker: editMarkerOf(row.spanId),
  }));

  return {
    runId: detail.meta.id,
    rows,
    prefixUnknown: detail.completeness === "ownOnly",
    attribution,
  };
}

// ---------------------------------------------------------------------------
// tasks 4.14：前缀折叠/展开
//
// design D4 / delta：「仅对已校验 result 分叉的真实共同执行部分提供可展开折叠，
// 保留被编辑值的差异」「可展开全部记录，折叠不删记录」——折叠只是**视图压缩**：
// 摘要行携带来源与编辑清单，展开即恢复全部行（行本身不删不改）。
// ---------------------------------------------------------------------------

/** 折叠摘要携带的编辑条目（共同区被覆写值仍保留原值，差异不隐藏） */
export interface PrefixEditEntry {
  /** 编辑边界 span（折叠前它在前缀行里，展开可见） */
  readonly spanId: string;
  /** 编辑发生在哪一跳（target run）与字段 */
  readonly targetRunId: string;
  readonly field: string;
}

/** 前缀折叠摘要（null = 该侧没有可折叠的前缀） */
export interface PrefixSummary {
  /** 被折叠的前缀行数 */
  readonly rowCount: number;
  /** 前缀的物理来源 run（按视图序去重） */
  readonly sourceRunIds: readonly string[];
  /** 前缀内的编辑边界清单（保留编辑差异） */
  readonly edits: readonly PrefixEditEntry[];
}

/** 折叠视图的一行：span 行或前缀摘要行（二者互斥） */
export type CatalogViewRow =
  | { readonly rowKind: "span"; readonly row: CompareStepRow }
  | { readonly rowKind: "prefix-summary"; readonly summary: PrefixSummary };

/**
 * 该侧是否可折叠、折叠摘要是什么。
 * - 无前缀行（根 run / ownOnly / 独立执行叶子）⇒ null（无东西可折）；
 * - 来源映射不可靠 ⇒ null（归属不明就不折叠，如实说明）。
 */
export function prefixSummaryOf(catalog: SideStepCatalog): PrefixSummary | null {
  if (catalog.attribution.kind === "unavailable") return null;
  const prefixRows = catalog.rows.filter((row) => !row.own);
  if (prefixRows.length === 0) return null;

  const sourceRunIds: string[] = [];
  const edits: PrefixEditEntry[] = [];
  for (const row of prefixRows) {
    if (row.sourceRunId !== null && !sourceRunIds.includes(row.sourceRunId)) {
      sourceRunIds.push(row.sourceRunId);
    }
    if (row.editMarker !== null) {
      edits.push({
        spanId: row.spanId,
        targetRunId: row.editMarker.targetRunId,
        field: row.editMarker.field,
      });
    }
  }
  return { rowCount: prefixRows.length, sourceRunIds, edits };
}

/**
 * 应用折叠态生成目录视图行。
 * - `folded === false` 或无前缀可折 ⇒ 全部 span 行（原样，不删不改）；
 * - `folded === true` 且有前缀 ⇒ 一条摘要行 + **自有行**（前缀行收进摘要，
 *   记录不删——展开即恢复）。
 */
export function foldCatalogRows(
  catalog: SideStepCatalog,
  folded: boolean,
): readonly CatalogViewRow[] {
  const summary = folded ? prefixSummaryOf(catalog) : null;
  if (summary === null) {
    return catalog.rows.map((row) => ({ rowKind: "span" as const, row }));
  }
  const view: CatalogViewRow[] = [{ rowKind: "prefix-summary", summary }];
  for (const row of catalog.rows) {
    if (row.own) view.push({ rowKind: "span", row });
  }
  return view;
}
