import { describe, expect, it } from "vitest";
import {
  deriveChainTotals,
  deriveCompareDiffGate,
  deriveDirectEditEvidence,
  deriveResultSourceMapping,
  deriveSideOutputFacts,
  deriveVerifiedComparison,
  findCommonAncestor,
  indexRunsById,
} from "../src/facts";
import type { RunSummary } from "../src/schema";
import type { CompareRunItem, RunDetail } from "../src/schema";

const T0 = "2026-10-22T00:00:00.000Z";

function summary(id: string, parent: string | null, tokensIn = 0, durationMs = 0): RunSummary {
  return {
    id,
    task: `任务 ${id}`,
    model: "m",
    created_at: T0,
    status: "completed",
    parent,
    reason: "completed",
    fork: null,
    steps: 1,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn,
    tokensOut: 0,
    cacheHit: null,
    durationMs,
    source: null,
  };
}

const root = summary("r_root", null, 10, 5);
const left = summary("r_left", "r_root", 5, 2);
const right = summary("r_right", "r_root", 7, 3);

const meta = {
  type: "run.meta",
  id: "r_root",
  format_version: 1,
  task: "任务",
  model: "m",
  created_at: T0,
  parent: null,
  fork: null,
  config_hash: "sha256:root",
} as const;
const childMeta = {
  ...meta,
  id: "r_child",
  parent: "r_root",
  fork: { at_span: "s_01", edit: { field: "result", value: "new" } },
} as const;
const step = { type: "span", id: "s_01", kind: "agent.step", parent: null, n: 1 } as const;
const childStep = { type: "span", id: "s_02", kind: "agent.step", parent: null, n: 1 } as const;
const llm = {
  type: "span",
  id: "s_llm",
  kind: "llm.call",
  parent: "s_01",
  request: { model: "m", messages: [{ role: "user", content: "u" }], tools: [] },
  response: {
    content: "完成",
    reasoning_content: null,
    tool_calls: [],
    usage: { in: 10, out: 5 },
    ttft_ms: 1,
  },
} as const;
const stopped = { type: "run.event", event: "stopped", reason: "completed", at: 1 } as const;

function detailWith(id: string, content: string): RunDetail {
  return {
    meta,
    spans: [step, { ...llm, id: `llm_${id}`, response: { ...llm.response, content } }],
    events: [stopped],
    status: "completed",
    chain: [{ meta, fork: null }],
    leafSpanIds: [step.id, `llm_${id}`],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  } as unknown as RunDetail;
}

describe("运行比较纯派生", () => {
  it("chain 事实：累计只在完整链求和，缺父不补造", () => {
    const byId = indexRunsById([root, left, right]);
    expect(deriveChainTotals(byId, "r_left")).toMatchObject({ tokens: 15, durationMs: 7 });
    expect(findCommonAncestor(byId, ["r_left", "r_right"])).toEqual({
      id: "r_root",
      incomplete: false,
    });

    const orphan = summary("r_orphan", "r_missing");
    const orphanById = indexRunsById([orphan]);
    expect(deriveChainTotals(orphanById, "r_orphan")).toBeNull();
    expect(findCommonAncestor(orphanById, ["r_orphan"])).toEqual({
      id: "r_orphan",
      incomplete: true,
    });
  });

  it("已校验比较：共同祖先与相对增量差可核对", () => {
    const result = deriveVerifiedComparison([
      { runId: "r_left", chainSummaries: [root, left] },
      { runId: "r_right", chainSummaries: [root, right] },
    ]);
    expect(result.relation).toEqual({ kind: "common", ancestorId: "r_root" });
    expect(result.ancestor?.id).toBe("r_root");
    expect(result.sides.map((side) => side.totals?.tokens)).toEqual([15, 17]);
    expect(result.sides.map((side) => side.deltaFromAncestor?.tokens)).toEqual([5, 7]);
  });

  it("一侧缺父时共同祖先判 incomplete，不称不同根", () => {
    const truncated = summary("r_trunc", "r_missing");
    const result = deriveVerifiedComparison([
      { runId: "r_trunc", chainSummaries: [truncated] },
      { runId: "r_right", chainSummaries: [root, right] },
    ]);
    expect(result.relation).toEqual({ kind: "incomplete" });
    expect(result.ancestor).toBeNull();
    expect(result.sides[0]?.totals).toBeNull();
    expect(result.sides[1]?.totals).not.toBeNull();
  });

  it("比较侧输出门禁：两侧最终文本齐备才可用", () => {
    const leftFacts = deriveSideOutputFacts(detailWith("a", "左文本"));
    const rightFacts = deriveSideOutputFacts(detailWith("b", "右文本"));
    expect(leftFacts.outcome.kind).toBe("completed");
    expect(deriveCompareDiffGate(leftFacts, rightFacts)).toMatchObject({
      status: "available",
      leftText: "左文本",
      rightText: "右文本",
    });

    const failed = deriveSideOutputFacts({
      ...detailWith("c", ""),
      spans: [step],
      leafSpanIds: [step.id],
    } as unknown as RunDetail);
    expect(deriveCompareDiffGate(leftFacts, failed)).toMatchObject({ status: "unavailable" });
  });

  it("v1 result 来源映射保留父/子贡献段与编辑边界", () => {
    const result = deriveResultSourceMapping({
      meta: childMeta,
      spans: [step, childStep],
      events: [stopped],
      status: "completed",
      chain: [
        { meta, fork: null },
        { meta: childMeta, fork: childMeta.fork },
      ],
      leafSpanIds: [childStep.id],
      completeness: "complete",
      spanScope: "resolved",
      lineage: { status: "complete" },
    } as unknown as RunDetail);
    expect(result).toEqual({
      status: "mapped",
      segments: [
        {
          sourceRunId: "r_root",
          spanIds: ["s_01"],
          boundaryEdit: { targetRunId: "r_child", field: "result" },
        },
        { sourceRunId: "r_child", spanIds: ["s_02"], boundaryEdit: null },
      ],
    });
  });

  it("两侧均不可读时编辑证据 notApplicable，不猜父子", () => {
    const bad = (runId: string): CompareRunItem => ({
      status: "unavailable",
      runId,
      code: "RUN_INVALID",
      reason: "损坏",
    });
    expect(deriveDirectEditEvidence(bad("r_a"), bad("r_b"))).toMatchObject({
      status: "notApplicable",
    });
  });
});
