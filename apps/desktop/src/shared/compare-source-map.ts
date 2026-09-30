import { FORMAT_VERSION } from "@rebaseagent/trace-sdk/schema";
import type { RunDetail } from "./ipc";

/**
 * U7（improve-branch-comparison）tasks 4.7：普通 v1 result 链的**只读来源映射**。
 *
 * design D4：「共享前缀通过严格解析的 result 链及已校验分叉边界生成来源映射；
 * 映射包含源 run ID 和原 span ID，不能靠两侧重复的 s_01 或轮号求交集。…
 * 若当前解析不能提供可靠来源映射，最小提取既有 resolver 的只读投影并对照完整
 * 轨迹验证，不能另造截断算法。」
 *
 * 本模块**不做任何截断**：输入就是 `runs:compare` 已校验的 RunDetail——其
 * `spans` 是读取层 `resolveBranch` / `projectMixedChainSpans` 产出的投影视图。
 * 映射按链结构推导「视图里每个 span 来自哪个物理 run」：
 *
 * - v1 每跳的贡献段以**下一跳的 `fork.at_span`** 结尾（含该 span）——因此
 *   chain 逐跳的 `at_span` 就是视图的段边界序列，按序扫描即可分段；
 * - **共同区中被覆写的值仍保留原值**：段末边界 span 携带 `boundaryEdit`
 *   （编辑发生在下一跳），视图据此显示编辑标记、不隐藏差异（前后值证据由
 *   compare-edit-evidence 承载）；
 * - 「对照原完整轨迹验证」落在边界核验上：每个边界都必须在视图中**恰好出现
 *   一次且按链序递进**，任何缺失/错序/重复 ⇒ `unreliable`（视图不得折叠前缀，
 *   如实说明，不猜）；
 * - 链上任一跳不是 v1 result（prompt / messages / model_params / v2 隔离）⇒
 *   `notPlainV1`——独立边界改变投影形态，由步骤目录（4.8）与 v2 映射（4.13）
 *   分别承载，本函数不越界；
 * - `spanScope === "own"`（ownOnly 截断 / 根 run / 独立执行叶子）：视图只含
 *   叶子自有 spans ⇒ 单段全归属叶子，天然可靠（没有可折叠的前缀）。
 */

/** 来源映射的一个连续段：视图内这些 span 都来自同一个物理 run */
export interface SourceSegment {
  /** 该段 spans 的物理来源 run id */
  readonly sourceRunId: string;
  /** 视图内该段的 span id（按视图序连续；段末可以是编辑边界 span） */
  readonly spanIds: readonly string[];
  /**
   * 段末 span 是下一跳 fork 编辑点时的编辑标注（共同区被覆写值仍显示原值）：
   * 编辑发生在 `targetRunId` 那一跳，字段为 `field`。非边界段为 null。
   */
  readonly boundaryEdit: { readonly targetRunId: string; readonly field: string } | null;
}

export type SourceMapping =
  | { readonly status: "mapped"; readonly segments: readonly SourceSegment[] }
  | {
      readonly status: "unreliable";
      /** 受控中文原因：边界缺失/错序/重复——视图不得据此折叠前缀 */
      readonly reason: string;
    }
  | {
      readonly status: "notPlainV1";
      /** 链上存在非 v1 result 的跳（独立边界 / v2 隔离）：由 4.8/4.13 的映射承载 */
      readonly reason: string;
    };

/** 链上任一非根跳是否「普通 v1 result 分叉」 */
function isPlainV1Hop(hop: RunDetail["chain"][number]): boolean {
  return (
    hop.fork !== null &&
    hop.fork.edit.field === "result" &&
    hop.meta.format_version !== FORMAT_VERSION
  );
}

/**
 * 从已校验详情推导 v1 result 链的来源映射（纯函数，零 Electron / 零 Node）。
 * 恒可用、不抛异常；`unreliable` / `notPlainV1` 是诚实的结论而非错误。
 */
export function deriveV1ResultSourceMapping(detail: RunDetail): SourceMapping {
  const { chain, spans, spanScope } = detail;

  // 叶子自有视图（ownOnly / 根 / 独立执行叶子）：全部 spans 归属叶子自己
  if (spanScope === "own") {
    return {
      status: "mapped",
      segments: [
        {
          sourceRunId: detail.meta.id,
          spanIds: spans.map((span) => span.id),
          boundaryEdit: null,
        },
      ],
    };
  }

  // 非 v1 纯 result 链：投影在独立边界处重置，段结构由各自映射承载
  const nonPlain = chain.findIndex((hop, i) => i > 0 && !isPlainV1Hop(hop));
  if (nonPlain !== -1) {
    const hop = chain[nonPlain];
    return {
      status: "notPlainV1",
      reason:
        hop?.fork === null
          ? `链上 ${hop.meta.id} 无 fork 元数据：不是纯 result 链，本映射不适用`
          : `链上 ${hop?.meta.id ?? "（未知）"} 携带非 v1 result 边界（${
              hop?.fork?.edit.field ?? "v2 隔离"
            }）：由步骤目录 / v2 来源映射承载`,
    };
  }

  // 边界序列 = 第 1..n-1 跳的 fork.at_span（第 i 跳的 at_span 是第 i-1 跳贡献段的末尾）
  const boundaries = chain.slice(1).map((hop) => ({
    atSpan: hop.fork?.at_span ?? "",
    targetRunId: hop.meta.id,
    field: hop.fork?.edit.field ?? "unknown",
  }));

  // 边界必须在视图中恰好出现一次（重复 ⇒ 分段歧义，判不可靠）
  const counts = new Map<string, number>();
  for (const span of spans) {
    counts.set(span.id, (counts.get(span.id) ?? 0) + 1);
  }
  for (const boundary of boundaries) {
    if ((counts.get(boundary.atSpan) ?? 0) !== 1) {
      return {
        status: "unreliable",
        reason: `边界 span ${boundary.atSpan} 在投影视图中出现 ${counts.get(boundary.atSpan) ?? 0} 次（应为 1）：来源映射不可靠，不折叠前缀`,
      };
    }
  }

  // 按序扫描：段末命中当前预期边界 ⇒ 归属切换到下一跳并标注编辑
  const segments: SourceSegment[] = [];
  let current: {
    sourceRunId: string;
    spanIds: string[];
    boundaryEdit: SourceSegment["boundaryEdit"];
  } = { sourceRunId: chain[0]?.meta.id ?? detail.meta.id, spanIds: [], boundaryEdit: null };
  let boundaryIdx = 0;
  for (const span of spans) {
    current.spanIds.push(span.id);
    const next = boundaries[boundaryIdx];
    if (next !== undefined && span.id === next.atSpan) {
      current.boundaryEdit = { targetRunId: next.targetRunId, field: next.field };
      segments.push({ ...current, spanIds: [...current.spanIds] });
      boundaryIdx += 1;
      current = { sourceRunId: next.targetRunId, spanIds: [], boundaryEdit: null };
    }
  }

  // 全部边界都必须按序命中（缺一个 ⇒ 投影与链结构错配，判不可靠）
  if (boundaryIdx !== boundaries.length) {
    const missing = boundaries[boundaryIdx];
    return {
      status: "unreliable",
      reason: `边界 span ${missing?.atSpan ?? "（未知）"} 未按链序出现在投影视图中：来源映射不可靠，不折叠前缀`,
    };
  }
  if (current.spanIds.length > 0 || segments.length === 0) {
    segments.push({ ...current, spanIds: [...current.spanIds] });
  }
  return { status: "mapped", segments };
}
