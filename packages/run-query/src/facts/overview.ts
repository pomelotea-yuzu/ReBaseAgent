/**
 * 概览的自有输出选择与错误目标派生（U1 共用派生 · 任务 2.2）。
 *
 * 全部为纯函数，零 Electron / 零 Node——输入是 `getRun` 产出的（可能合并了祖先前缀的）
 * 展开轨迹 + `leafSpanIds`，输出是概览直接可用的事实。
 *
 * 三条不许猜的纪律（对应 desktop-ui delta「运行概览呈现自有结果与消耗」）：
 *
 * 1. **只认自有 spans**：`spans` 可能是分支 run 的展开视图，含祖先共享前缀。
 *    祖先的正文 / 错误 / 消耗都属于祖先 run 的记账，**不得**冒充本次结果或本次失败原因。
 *    自有 span 由 `leafSpanIds` 界定（这也是 `readRun` 的 RunRecord 没有该字段、
 *    必须用 `getRun` 的 RunDetail 的原因——见 1.1 记下的数据源陷阱）。
 *
 * 2. **最终输出四条件缺一不可**：正常终止（reason=completed）+ 最后一次自有 `llm.call`
 *    有非空 `content` + 该调用无 `error` + 该调用无待执行 `tool_calls`。
 *    任一不满足 ⇒ 「未记录最终输出」，**绝不**向下回退到更早的自有正文冒充最终结果，
 *    **绝不**借用祖先正文，**绝不**由模型生成总结补全。
 *
 * 3. **失败原因只来自自有记录**：以 error 终止时，只在**自有** `llm.call` 里找带 `error`
 *    的那一个作为可定位目标；找不到就如实说「错误详情未记录」，**不**反推
 *    （零 token / 末尾调用 / 祖先错误都不作为判据）。
 */

import type { SpanLine } from "@rebaseagent/trace-sdk";

/** 概览内容区的一块输出 */
export interface OutputBlock {
  /** 正文（原文，未截断） */
  content: string;
  /** 产出的 span id（供「打开该调用」入口） */
  spanId: string;
  /** 所属 step span id（供展开该 step） */
  stepSpanId: string | null;
  /** 该调用的模型（原值） */
  model: string;
}

/** 自有输出选择结果 */
export interface OwnOutput {
  /** 已记录的最终输出；不满足四条件时为 null */
  finalOutput: OutputBlock | null;
  /**
   * 结束前的最近一条自有非空正文（失败/限制/中止/中断时保留为「中间输出」）。
   * 仅当 `finalOutput === null` 时有意义——它**不是**最终结果，不能冒充。
   */
  latestIntermediate: OutputBlock | null;
  /**
   * 未记录最终输出时的原因分型（供概览如实说明），finalOutput 非 null 时为 null。
   * - "no-llm-call"：本 run 没有任何自有 llm.call
   * - "empty-content"：最后自有调用正文为空
   * - "has-error"：最后自有调用带 error
   * - "pending-tool-calls"：最后自有调用有待执行 tool_calls（循环本应继续）
   */
  missingReason: "no-llm-call" | "empty-content" | "has-error" | "pending-tool-calls" | null;
  /** 最后自有调用的输出类型（供「仅有思维链/工具调用」如实说明）；无自有调用为 null */
  lastOutputKind: "content" | "reasoning-only" | "tool-calls-only" | "empty" | null;
}

function nonEmpty(text: string | null | undefined): text is string {
  return typeof text === "string" && text.length > 0;
}

/** 自有 spans（按 leafSpanIds 过滤；顺序沿用输入顺序，即记录顺序） */
function ownSpansOf(spans: readonly SpanLine[], leafSpanIds: readonly string[]): SpanLine[] {
  const own = new Set(leafSpanIds);
  return spans.filter((span) => own.has(span.id));
}

/** 某 llm.call 所属的 step span id（父子查表；无父或父非 step 时为 null） */
function stepOf(spans: readonly SpanLine[], span: SpanLine): string | null {
  if (span.parent === null) return null;
  const parent = spans.find((candidate) => candidate.id === span.parent);
  return parent !== undefined && parent.kind === "agent.step" ? parent.id : null;
}

function toBlock(
  spans: readonly SpanLine[],
  span: Extract<SpanLine, { kind: "llm.call" }>,
): OutputBlock {
  return {
    content: span.response.content ?? "",
    spanId: span.id,
    stepSpanId: stepOf(spans, span),
    model: span.request.model,
  };
}

/**
 * 从**自有** llm.call 选择最终输出与中间输出。
 *
 * 入参 `spans` 是 `getRun` 的展开轨迹，`leafSpanIds` 界定自有段。
 */
export function deriveOwnOutput(input: {
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
  /** 本 run 的终止原因（自有终止事件）；null = 无终止事件 */
  reason: string | null;
}): OwnOutput {
  const own = ownSpansOf(input.spans, input.leafSpanIds);
  const llmCalls = own.filter(
    (span): span is Extract<SpanLine, { kind: "llm.call" }> => span.kind === "llm.call",
  );
  const last = llmCalls[llmCalls.length - 1];

  if (last === undefined) {
    return {
      finalOutput: null,
      latestIntermediate: null,
      missingReason: "no-llm-call",
      lastOutputKind: null,
    };
  }
  const hasError = last.error !== undefined;
  const pendingToolCalls = last.response.tool_calls.length > 0;
  const hasContent = nonEmpty(last.response.content);

  const lastOutputKind: OwnOutput["lastOutputKind"] = hasContent
    ? "content"
    : nonEmpty(last.response.reasoning_content)
      ? "reasoning-only"
      : pendingToolCalls
        ? "tool-calls-only"
        : "empty";

  // 四条件：正常终止 + 非空正文 + 无 error + 无待执行 tool_calls
  const normalEnd = input.reason === "completed";
  let missingReason: OwnOutput["missingReason"] = null;
  if (normalEnd && hasContent && !hasError && !pendingToolCalls) {
    return {
      finalOutput: toBlock(input.spans, last),
      latestIntermediate: null,
      missingReason: null,
      lastOutputKind,
    };
  }
  // 未成为最终输出：记下原因分型（顺序即优先级，与概览文案对应）
  if (hasError) missingReason = "has-error";
  else if (pendingToolCalls) missingReason = "pending-tool-calls";
  else if (!hasContent) missingReason = "empty-content";
  else missingReason = null; // 有正文、无 error、无待执行 tool_calls，但非正常终止（如 aborted）

  // 最近一条自有非空正文作为「中间输出」；找不到为 null（不借用祖先）
  let latestIntermediate: OutputBlock | null = null;
  for (let i = llmCalls.length - 1; i >= 0; i--) {
    const call = llmCalls[i];
    if (call !== undefined && nonEmpty(call.response.content)) {
      latestIntermediate = toBlock(input.spans, call);
      break;
    }
  }

  return { finalOutput: null, latestIntermediate, missingReason, lastOutputKind };
}

/** 概览可定位的错误目标 */
export interface ErrorTarget {
  /** 可定位的自有失败调用（span id 与所属 step）；无自有错误详情时为 null */
  llmCallSpanId: string | null;
  stepSpanId: string | null;
  /** 错误正文（原值，来自 `llm.call.error.message`） */
  message: string | null;
  /** HTTP 状态码（若有；`null` 表示未记录，不猜） */
  status: number | null;
  /** true 表示以 error 终止但本 run 自有记录里没有失败调用 ⇒ 显示「错误详情未记录」 */
  missingDetail: boolean;
}

/**
 * 派生概览的错误定位目标。
 *
 * - 只在**自有** `llm.call` 中找带 `error` 的调用；祖先错误不作为本次原因。
 * - 多个自有失败调用取**最后一个**（与「最后自有调用」口径一致）。
 * - 非 error 终止（含 crashed / completed / 限制）⇒ 不产生错误目标，
 *   `missingDetail` 也为 false（缺失提示只对 error 终止有意义）。
 */
export function deriveErrorTarget(input: {
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
  reason: string | null;
}): ErrorTarget {
  const empty: ErrorTarget = {
    llmCallSpanId: null,
    stepSpanId: null,
    message: null,
    status: null,
    missingDetail: false,
  };
  if (input.reason !== "error") return empty;

  const own = ownSpansOf(input.spans, input.leafSpanIds);
  const failed = own.filter(
    (span): span is Extract<SpanLine, { kind: "llm.call" }> =>
      span.kind === "llm.call" && span.error !== undefined,
  );
  const last = failed[failed.length - 1];
  if (last === undefined || last.error === undefined) {
    // error 终止但自有 LLM 无 error 详情：保留缺失说明，不虚构入口
    return { ...empty, missingDetail: true };
  }

  const error = last.error;
  return {
    llmCallSpanId: last.id,
    stepSpanId: stepOf(input.spans, last),
    message: error.message,
    status: error.status ?? null,
    missingDetail: false,
  };
}

/** 概览可定位的工具错误（不被断言为终止根因） */
export interface ToolErrorTarget {
  spanId: string;
  stepSpanId: string | null;
  tool: string;
  message: string;
}

/**
 * 列出**自有**工具错误（`error !== null`），供概览独立展示。
 *
 * 刻意与 `deriveErrorTarget` 分开：工具错误是数据、不是终止根因，
 * 两者绝不合并成「本次失败原因」。
 */
export function deriveOwnToolErrors(input: {
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
}): ToolErrorTarget[] {
  return ownSpansOf(input.spans, input.leafSpanIds)
    .filter(
      (span): span is Extract<SpanLine, { kind: "tool.invoke" }> =>
        span.kind === "tool.invoke" && span.error !== null,
    )
    .map((span) => ({
      spanId: span.id,
      stepSpanId: stepOf(input.spans, span),
      tool: span.tool,
      message: span.error ?? "",
    }));
}

// ---------------------------------------------------------------------------
// 本次消耗与缓存覆盖范围（U1 共用派生 · 任务 2.3）
//
// 只统计**自有** spans；祖先共享前缀属于祖先 run 的记账。
// ---------------------------------------------------------------------------

/** 缓存覆盖范围：有多少次自有调用记录了 cache_hit */
export interface CacheCoverage {
  /** 记录了 cache_hit 的自有 llm.call 次数（`0` 命中算记录） */
  recorded: number;
  /** 自有 llm.call 总次数 */
  total: number;
  /**
   * 已记录命中量（各次 cache_hit 之和）；**无任何字段**时为 null（未知 ≠ 0）。
   * `recorded === 0` ⇒ null；`recorded > 0` ⇒ 数值（可能是 0，0 是有值）。
   */
  hitTotal: number | null;
}

/**
 * 缓存覆盖范围：从**自有** llm.call 现算记录数与命中合计。
 *
 * 存在性判据用 `!== undefined`（`0` 是有值）；全无字段 ⇒ `hitTotal = null`，
 * 概览据此说明「未记录」而**不显示虚构的零命中**。
 */
export function deriveCacheCoverage(input: {
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
}): CacheCoverage {
  const llmCalls = ownSpansOf(input.spans, input.leafSpanIds).filter(
    (span): span is Extract<SpanLine, { kind: "llm.call" }> => span.kind === "llm.call",
  );

  let recorded = 0;
  let hitTotal = 0;
  for (const call of llmCalls) {
    const hit = call.response.usage.cache_hit;
    if (hit === undefined) continue;
    recorded += 1;
    hitTotal += hit;
  }
  return { recorded, total: llmCalls.length, hitTotal: recorded === 0 ? null : hitTotal };
}

/** 本次消耗（概览「本次消耗」区；全部由自有 spans 现算，未知不补零） */
export interface OwnConsumption {
  tokensIn: number;
  tokensOut: number;
  /** 已记录耗时（毫秒）；自有 spans 无有效 timing 时为 null（未知 ≠ 0） */
  durationMs: number | null;
  toolCalls: number;
  toolErrors: number;
  cache: CacheCoverage;
}

/**
 * 本次消耗：只聚合**自有** spans 的 token / 已记录时间 / 工具调用与错误 / 缓存覆盖。
 *
 * 与 `deriveRunSummary` 的区别：后者吃 RunLike（本 run 自有 spans 直接传入），
 * 本函数吃 `getRun` 的展开轨迹 + leafSpanIds，由自己完成「自有段」过滤——
 * 分支 run 的展开视图不会把祖先前缀算进本次消耗。
 */
export function deriveOwnConsumption(input: {
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
}): OwnConsumption {
  const own = ownSpansOf(input.spans, input.leafSpanIds);

  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const span of own) {
    if (span.kind === "llm.call") {
      tokensIn += span.response.usage.in;
      tokensOut += span.response.usage.out;
    } else if (span.kind === "tool.invoke") {
      toolCalls += 1;
      if (span.error !== null) toolErrors += 1;
    }
    if (span.timing !== undefined) {
      const start = Date.parse(span.timing.started_at);
      const end = Date.parse(span.timing.ended_at);
      if (!Number.isNaN(start)) earliest = earliest === null ? start : Math.min(earliest, start);
      if (!Number.isNaN(end)) latest = latest === null ? end : Math.max(latest, end);
    }
  }

  return {
    tokensIn,
    tokensOut,
    // 无任一自有 span 带 timing ⇒ null（时间未知，不补 0）
    durationMs: earliest !== null && latest !== null ? Math.max(0, latest - earliest) : null,
    toolCalls,
    toolErrors,
    cache: deriveCacheCoverage(input),
  };
}
