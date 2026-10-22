import type { RunRecord } from "@rebaseagent/trace-sdk";
import type { RunDetail } from "../schema.js";
import { projectMixedChainWithOwners } from "./detail-project.js";

/**
 * 投影详情里的 **span → owner** 索引：owner 来自链上各物理记录的自有 spans；
 * 可见性来自与轨迹投影同一套 owner 跟踪，不由 MCP 重拼父链。
 *
 * - 没有 owner 且重名 ⇒ `ambiguous`（不取首项）；
 * - 指定 owner 但该 span 已被投影截断 ⇒ `truncated`（不可通过 owner 偷读祖先）；
 * - 显式 owner 与 span 不匹配 ⇒ `not_found`；
 * - 索引自身与详情轨迹不一致 ⇒ `unreliable`（拒绝猜）。
 */

export interface SpanOwnerIndex {
  readonly status: "ok" | "unreliable";
  readonly reason: string | null;
  /** spanId → 链上拥有该 id 的 run（root→leaf 顺序） */
  readonly ownersBySpanId: ReadonlyMap<string, readonly string[]>;
  /** 可见的 (ownerRunId, spanId) 对 */
  readonly visibleOwnerSpanKeys: ReadonlySet<string>;
}

export type SpanOwnerLookup =
  | { readonly status: "ok"; readonly ownerRunId: string }
  | { readonly status: "ambiguous"; readonly owners: readonly string[] }
  | { readonly status: "truncated"; readonly ownerRunId: string }
  | { readonly status: "not_found" }
  | { readonly status: "unreliable"; readonly reason: string };

function pairKey(runId: string, spanId: string): string {
  return JSON.stringify([runId, spanId]);
}

function unreliable(reason: string): SpanOwnerIndex {
  return {
    status: "unreliable",
    reason,
    ownersBySpanId: new Map(),
    visibleOwnerSpanKeys: new Set(),
  };
}

export function buildSpanOwnerIndex(
  detail: RunDetail,
  records: readonly RunRecord[],
): SpanOwnerIndex {
  const owners = new Map<string, Set<string>>();
  for (const record of records) {
    for (const span of record.spans) {
      const set = owners.get(span.id) ?? new Set<string>();
      set.add(record.meta.id);
      owners.set(span.id, set);
    }
  }

  const visible = new Set<string>();
  if (detail.spanScope === "own") {
    for (const span of detail.spans) {
      visible.add(pairKey(detail.meta.id, span.id));
    }
  } else {
    const projected = projectMixedChainWithOwners(records);
    if (!projected.ok) {
      return unreliable(projected.message);
    }
    if (
      projected.spans.length !== detail.spans.length ||
      projected.spans.some((span, index) => span.id !== detail.spans[index]?.id)
    ) {
      return unreliable("投影 owner 索引与详情轨迹不一致");
    }
    for (const item of projected.owned) {
      visible.add(pairKey(item.ownerRunId, item.span.id));
    }
  }

  const ownersBySpanId = new Map<string, readonly string[]>();
  for (const [spanId, runIds] of owners) {
    ownersBySpanId.set(spanId, [...runIds]);
  }
  return { status: "ok", reason: null, ownersBySpanId, visibleOwnerSpanKeys: visible };
}

export function resolveSpanOwner(
  index: SpanOwnerIndex,
  spanId: string,
  ownerRunId?: string,
): SpanOwnerLookup {
  if (index.status !== "ok") {
    return { status: "unreliable", reason: index.reason ?? "owner 索引不可用" };
  }
  const owners = index.ownersBySpanId.get(spanId);
  if (owners === undefined || owners.length === 0) {
    return { status: "not_found" };
  }

  if (ownerRunId !== undefined) {
    if (!owners.includes(ownerRunId)) {
      return { status: "not_found" };
    }
    if (!index.visibleOwnerSpanKeys.has(pairKey(ownerRunId, spanId))) {
      return { status: "truncated", ownerRunId };
    }
    return { status: "ok", ownerRunId };
  }

  if (owners.length > 1) {
    return { status: "ambiguous", owners };
  }
  const only = owners[0];
  if (only === undefined) return { status: "not_found" };
  if (!index.visibleOwnerSpanKeys.has(pairKey(only, spanId))) {
    return { status: "truncated", ownerRunId: only };
  }
  return { status: "ok", ownerRunId: only };
}
