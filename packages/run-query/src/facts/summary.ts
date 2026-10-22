import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunSummary } from "../schema.js";

/**
 * 列表摘要派生：全部为纯函数，零 Electron、零 Node 依赖。
 *
 * 纪律：所有聚合数字（步数、token、耗时、错误数）一律从 spans 现算，
 * 不维护累加器、不写缓存——与 loop 侧"计数从数据派生"的不变量同源。
 *
 * 口径：`deriveRunSummary` 的数字是「本 run 自身新增 span」的聚合——入参是
 * `readRun` 的原始记录，不含祖先前缀。沿链累计由 `facts/chain.ts` 现算。
 */

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

/**
 * run 级累计缓存命中（tokens）：只统计传入 spans 内 `llm.call` 的 `usage.cache_hit`。
 *
 * - **只传 run 文件自有的 spans**（与 `tokensIn` / `tokensOut` 同口径）：分支 run 的展开视图
 *   含祖先共享前缀，祖先的命中属于祖先 run 的记账，不得计入本 run——本 run 的合计语义是
 *   「本次重跑实际新发生的计费维度」。
 * - 全无 `cache_hit` 字段 ⇒ 返回 `null`（未知 ≠ 0）；存在 `0` 命中 ⇒ 如实累加（0 是有值）。
 */
export function deriveCacheHitTotal(spans: readonly SpanLine[]): number | null {
  let total: number | null = null;
  for (const span of spans) {
    if (span.kind !== "llm.call") continue;
    // 存在性判定（不是 truthiness）：0 = 实测零命中，undefined = 未知
    const hit = span.response.usage.cache_hit;
    if (hit === undefined) continue;
    total = (total ?? 0) + hit;
  }
  return total;
}

/**
 * 终止原因（**唯一来源**，U1 任务 6.2 提取）。
 *
 * 末条 `run.event` 的 `reason`；`crashed`（无终止事件）⇒ `null`。
 *
 * ⚠️ **crashed 的 reason 不可信**：crashed 的语义就是「没有结束记录」，此时即便残留
 *    一个 reason 也不代表终止原因 ⇒ 这里直接归 `null`（`classifyOutcome` 另有同样规则，
 *    两层都判是刻意的：本函数管"字段值是否可信"，`classifyOutcome` 管"显示成什么"）。
 */
export function deriveTerminalReason(input: {
  status: "completed" | "crashed";
  /** `RunDetail` / `RunRecord` 的 events；数据缺失时按"无终止事件"处理，不猜 */
  events: ReadonlyArray<{ reason: string }> | undefined;
}): string | null {
  if (input.status === "crashed") return null;
  // 事件表里只有 `run.event` 一种（`RunEventSchema` 的 type 是字面量）⇒ 取末条即可，
  // 与 `deriveMissingLlmErrorDetail` 同一取法（两处判据一致）。
  const last = input.events?.[input.events.length - 1];
  return last === undefined ? null : last.reason;
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
    // 终止原因走**唯一来源**（crashed ⇒ null，不把残留 reason 当终止原因）
    reason: deriveTerminalReason({ status: run.status, events: run.events }),
    steps,
    toolCalls,
    toolErrors,
    tokensIn,
    tokensOut,
    // 缓存命中与本文件 spans 同源现算（含 0 命中；全无字段 ⇒ null 表示未知）
    cacheHit: deriveCacheHitTotal(run.spans),
    durationMs,
    source: run.meta.source?.kind === "proxy" ? "proxy" : null,
  };
}

/** model_params 分叉的实验组标签（同批所有臂共享）；其它分叉恒为 null */
function experimentIdOf(fork: NonNullable<RunLike["meta"]["fork"]>): string | null {
  if (fork.edit.field !== "model_params") return null;
  const value = fork.edit.value;
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { experimentId?: unknown }).experimentId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
