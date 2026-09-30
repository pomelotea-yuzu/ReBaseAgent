import { FORMAT_VERSION } from "@rebaseagent/trace-sdk/schema";
import type { SpanLine } from "@rebaseagent/trace-sdk/schema";
import type { RunDetail } from "./ipc";

/**
 * U7（improve-branch-comparison）tasks 4.7/4.13：result 链的**只读来源映射**
 * （v1 按 span 截断边界；v2 按 `resume_after_step` 整轮边界）。
 *
 * design D4：「共享前缀通过严格解析的 result 链及已校验分叉边界生成来源映射；
 * 映射包含源 run ID 和原 span ID，不能靠两侧重复的 s_01 或轮号求交集。…
 * v1 保持 span 边界，v2 保持 `resume_after_step` 整轮边界；共同区中被覆写的
 * 工具结果仍显示编辑标记，不隐藏差异。…不能另造截断算法。」
 *
 * 本模块**不做任何截断**：输入就是 `runs:compare` 已校验的 RunDetail——其
 * `spans` 是读取层 `resolveBranch` / `resolveWholeRound` / `projectMixedChainSpans`
 * 产出的投影视图。映射按链结构推导「视图里每个 span 来自哪个物理 run」：
 *
 * - 第 i 跳对视图的贡献段始于**上一段边界之后**；段边界由下一跳的 fork 决定：
 *   v1 = `at_span`（单 span，含）；v2 = `resume_after_step` 所指 step 的**整段子树**
 *   （step 及其全部后代，含）——同轮兄弟工具保留在前缀里，正是整轮边界的语义；
 * - **共同区中被覆写的值仍保留原值**：段末边界携带 `boundaryEdit`（编辑发生在
 *   下一跳），视图据此显示编辑标记、不隐藏差异（前后值证据由
 *   compare-edit-evidence 承载）；
 * - 「对照原完整轨迹验证」落在边界核验上：边界 span/子树必须在视图中按链序
 *   出现、v2 的编辑点必须属于该轮子树且子树在视图内连续——任何违背 ⇒
 *   `unreliable`（视图不得折叠前缀，如实说明，不猜）；
 * - 链上含独立边界跳（prompt / messages / model_params）⇒ `notResultChain`：
 *   投影在**最后一个**独立边界处重置，更早 hop 的 spans 不在视图内——重置之后
 *   的段结构仍按本映射推导（首个贡献段 = 重置 hop 的自有 spans）；
 * - `spanScope === "own"`（ownOnly 截断 / 根 run）：视图只含叶子自有 spans ⇒
 *   单段全归属叶子，天然可靠（没有可折叠的前缀）。
 *
 * ⚠️ 4.13 改判留痕：4.7 的 `deriveV1ResultSourceMapping` / `notPlainV1` 在本任务
 * 推广为 `deriveResultSourceMapping` / `notResultChain`——v2 隔离跳由本映射承载
 * （不再 notPlainV1），独立边界跳的语义不变。
 */

/** 来源映射的一个连续段：视图内这些 span 都来自同一个物理 run */
export interface SourceSegment {
  /** 该段 spans 的物理来源 run id */
  readonly sourceRunId: string;
  /** 视图内该段的 span id（按视图序连续；段末可以是编辑边界 span/子树末尾） */
  readonly spanIds: readonly string[];
  /**
   * 段末是下一跳 fork 编辑边界时的编辑标注（共同区被覆写值仍显示原值）：
   * 编辑发生在 `targetRunId` 那一跳，字段为 `field`。非边界段为 null。
   */
  readonly boundaryEdit: { readonly targetRunId: string; readonly field: string } | null;
}

export type SourceMapping =
  | { readonly status: "mapped"; readonly segments: readonly SourceSegment[] }
  | {
      readonly status: "unreliable";
      /** 受控中文原因：边界缺失/错序/重复/子树断裂——视图不得据此折叠前缀 */
      readonly reason: string;
    }
  | {
      readonly status: "notResultChain";
      /** 链上含独立边界跳（prompt/messages/model_params）：视图自重置点起映射，更早 hop 不在视图 */
      readonly reason: string;
    };

const RESULT_FIELD = "result";

/** 链上某跳的边界形态：v1 单 span；v2 整轮子树 */
type HopBoundary =
  | { readonly kind: "v1"; readonly atSpan: string }
  | { readonly kind: "v2"; readonly stepId: string; readonly atSpan: string };

function boundaryOfHop(hop: RunDetail["chain"][number]): HopBoundary | null {
  const fork = hop.fork;
  if (fork === null || fork.edit.field !== RESULT_FIELD) return null;
  if (hop.meta.format_version === FORMAT_VERSION) {
    // v2 隔离分支：schema 保证 resume_after_step 在场；缺失按不可靠处理（调用方兜底）
    return fork.resume_after_step === undefined
      ? null
      : { kind: "v2", stepId: fork.resume_after_step, atSpan: fork.at_span };
  }
  return { kind: "v1", atSpan: fork.at_span };
}

/**
 * 从已校验详情推导 result 链的来源映射（纯函数，零 Electron / 零 Node）。
 * 恒可用、不抛异常；`unreliable` / `notResultChain` 是诚实的结论而非错误。
 */
export function deriveResultSourceMapping(detail: RunDetail): SourceMapping {
  const { chain, spans, spanScope } = detail;

  // 叶子自有视图（ownOnly / 根）：全部 spans 归属叶子自己
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

  // 最后一个独立边界 hop 之前的贡献都不在视图内（投影在此重置）
  let firstContributing = 0;
  for (let i = 1; i < chain.length; i++) {
    const hop = chain[i];
    if (hop === undefined) break;
    if (hop.fork === null) {
      return {
        status: "notResultChain",
        reason: `链上 ${hop.meta.id} 无 fork 元数据：不是可映射的 result 链`,
      };
    }
    if (hop.fork.edit.field !== RESULT_FIELD) firstContributing = i;
  }

  // 视图首段来源 = 首个贡献 hop（无独立边界时是根 run）
  const firstSource = chain[firstContributing]?.meta.id ?? detail.meta.id;

  // 逐边界分段：第 i 跳（i > firstContributing）的 fork 决定上一段的末尾
  const segments: SourceSegment[] = [];
  let cursor = 0;
  for (let i = firstContributing + 1; i < chain.length; i++) {
    const hop = chain[i];
    if (hop === undefined || hop.fork === null) break;
    const boundary = boundaryOfHop(hop);
    if (boundary === null) {
      return {
        status: "notResultChain",
        reason: `链上 ${hop.meta.id} 携带独立边界（${hop.fork.edit.field}）：其后的段结构由步骤目录承载`,
      };
    }

    const endIdx =
      boundary.kind === "v1"
        ? locateV1Boundary(spans, boundary.atSpan, cursor)
        : locateV2Boundary(spans, boundary, cursor);
    if (typeof endIdx !== "number") {
      return { status: "unreliable", reason: endIdx };
    }

    segments.push({
      sourceRunId: chain[i - 1]?.meta.id ?? firstSource,
      spanIds: spans.slice(cursor, endIdx + 1).map((span) => span.id),
      boundaryEdit: { targetRunId: hop.meta.id, field: RESULT_FIELD },
    });
    cursor = endIdx + 1;
  }

  // 尾段 = 叶子自有贡献（可能为空：空段不入列，但恒保证至少一段）
  const tail = spans.slice(cursor).map((span) => span.id);
  if (tail.length > 0 || segments.length === 0) {
    segments.push({
      sourceRunId: chain[chain.length - 1]?.meta.id ?? detail.meta.id,
      spanIds: tail,
      boundaryEdit: null,
    });
  }
  return { status: "mapped", segments };
}

/** v1 边界：at_span 必须在视图中恰好出现一次，且不早于当前游标 */
function locateV1Boundary(
  spans: readonly SpanLine[],
  atSpan: string,
  cursor: number,
): number | string {
  let occurrences = 0;
  let found = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i]?.id === atSpan) {
      occurrences += 1;
      if (i >= cursor) found = i;
    }
  }
  if (occurrences !== 1) {
    return `边界 span ${atSpan} 在投影视图中出现 ${occurrences} 次（应为 1）：来源映射不可靠，不折叠前缀`;
  }
  if (found === -1) {
    return `边界 span ${atSpan} 未按链序出现在投影视图中：来源映射不可靠，不折叠前缀`;
  }
  return found;
}

/**
 * v2 边界：定位 `resume_after_step` 子树在视图中的末尾。
 * 核验（拒绝而不猜）：step 在视图中恰好一次且是 agent.step；编辑点 at_span
 * 属于该子树（且不是 step 本身）；子树在视图内连续。
 */
function locateV2Boundary(
  spans: readonly SpanLine[],
  boundary: Extract<HopBoundary, { kind: "v2" }>,
  cursor: number,
): number | string {
  const { stepId, atSpan } = boundary;

  let occurrences = 0;
  let stepIdx = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i]?.id === stepId) {
      occurrences += 1;
      if (i >= cursor) stepIdx = i;
    }
  }
  if (occurrences !== 1 || stepIdx === -1) {
    return `整轮边界 step ${stepId} 在投影视图中出现 ${occurrences} 次（应为 1）：来源映射不可靠，不折叠前缀`;
  }
  const step = spans[stepIdx];
  if (step === undefined || step.kind !== "agent.step") {
    return `整轮边界 ${stepId} 是 ${step?.kind ?? "未知"} 而非 agent.step：来源映射不可靠，不折叠前缀`;
  }

  // 子树 = step + 其全部后代（沿视图 parent 链收集；父先于子，一遍扫描）
  const subtree = new Set<string>([stepId]);
  for (const span of spans) {
    if (span.parent !== null && subtree.has(span.parent)) {
      subtree.add(span.id);
    }
  }
  if (!subtree.has(atSpan)) {
    return `编辑点 ${atSpan} 不属于整轮边界 ${stepId} 所指的那一轮：来源映射不可靠，不折叠前缀`;
  }
  if (atSpan === stepId) {
    return `编辑点 ${atSpan} 不能等于整轮边界 ${stepId}：编辑点是轮内的工具调用，不是轮次容器`;
  }

  // 子树末尾 = 最后一个子树成员的下标；区间内必须全是子树成员（连续性核验）
  let lastIdx = -1;
  for (let i = stepIdx; i < spans.length; i++) {
    if (subtree.has(spans[i]?.id ?? "")) lastIdx = i;
  }
  for (let i = stepIdx; i <= lastIdx; i++) {
    if (!subtree.has(spans[i]?.id ?? "")) {
      return `整轮边界 ${stepId} 的子树在投影视图中不连续：来源映射不可靠，不折叠前缀`;
    }
  }
  return lastIdx;
}
