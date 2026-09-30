import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import { deriveSideStepCatalog } from "../src/renderer/src/lib/compare-steps";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 4.8/4.9：比较的独立步骤目录。
 *
 * 判据来源：desktop-ui delta「重复 span ID 与独立分支不强行对齐」「缺父链仅显示自有步骤」：
 * - 两侧目录各自独立派生，重复的 s_01 / 相同轮号不对齐、不合并；
 * - 行标注物理来源 run（来源映射可靠时）；ownOnly 侧 prefixUnknown 如实标注，
 *   不按可见链首项推断根、不折叠未知祖先；
 * - 行的展示判据复用 U1 flattenSpanRows（展开/选择分离、自有/继承、错误标记）。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function meta(id: string, parent: string | null, fork: Fork | null): RunDetail["meta"] {
  return {
    type: "run.meta",
    id,
    format_version: 1,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    parent,
    fork,
  };
}

function stepSpan(
  id: string,
  n = 1,
  parent: string | null = null,
): Extract<SpanLine, { kind: "agent.step" }> {
  return { type: "span", id, parent, kind: "agent.step", n };
}

function toolSpan(
  id: string,
  parent: string | null,
  opts: { error?: string } = {},
): Extract<SpanLine, { kind: "tool.invoke" }> {
  return {
    type: "span",
    id,
    parent,
    kind: "tool.invoke",
    tool: "write_file",
    args: {},
    result: "值",
    dur_ms: 1,
    error: opts.error ?? null,
  };
}

function hop(id: string, parent: string | null, fork: Fork | null): RunDetail["chain"][number] {
  return { meta: meta(id, parent, fork), fork };
}

function detailOf(
  id: string,
  chain: RunDetail["chain"],
  viewSpans: SpanLine[],
  opts: {
    spanScope?: "resolved" | "own";
    completeness?: "complete" | "ownOnly";
    leafSpanIds?: string[];
    lineage?: RunDetail["lineage"];
  } = {},
): RunDetail {
  return {
    meta: chain[chain.length - 1]?.meta ?? meta(id, null, null),
    spans: viewSpans,
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain,
    leafSpanIds: opts.leafSpanIds ?? viewSpans.map((span) => span.id),
    completeness: opts.completeness ?? "complete",
    spanScope: opts.spanScope ?? "resolved",
    lineage: opts.lineage ?? { status: "complete" },
  };
}

describe("deriveSideStepCatalog：v1 链目录与来源归属（4.8）", () => {
  it("前缀行标注父 run 来源、自有行标注叶子；展开/自有标记照抄 U1 判据", () => {
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"),
      stepSpan("b1", 1, "a2"),
      toolSpan("b2", "b1"),
    ];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], view, {
      leafSpanIds: ["b1", "b2"],
    });

    const catalog = deriveSideStepCatalog(detail);
    expect(catalog.runId).toBe("r_b");
    expect(catalog.attribution).toEqual({ kind: "mapped" });
    expect(catalog.prefixUnknown).toBe(false);
    expect(catalog.rows.map((row) => [row.spanId, row.sourceRunId, row.own])).toEqual([
      ["a1", "r_a", false],
      ["a2", "r_a", false],
      ["b1", "r_b", true],
      ["b2", "r_b", true],
    ]);
  });

  it("两侧重复的 s_01 / 相同轮号：各自目录独立成行，不对齐不合并（身份 = run + span）", () => {
    // 两侧各自从 s_01 重计、轮号都是 1——构建两次独立目录，逐字段相同也互不引用
    const makeSide = (runId: string): RunDetail =>
      detailOf(runId, [hop(runId, null, null)], [stepSpan("s_01", 1), toolSpan("s_02", "s_01")], {
        spanScope: "own",
      });

    const left = deriveSideStepCatalog(makeSide("r_left"));
    const right = deriveSideStepCatalog(makeSide("r_right"));

    // 同形但身份独立：runId 不同，行各自属于各侧（没有跨侧对齐产生的第三种结构）
    expect(left.runId).toBe("r_left");
    expect(right.runId).toBe("r_right");
    expect(left.rows.map((row) => row.spanId)).toEqual(["s_01", "s_02"]);
    expect(right.rows.map((row) => row.spanId)).toEqual(["s_01", "s_02"]);
    expect(left.rows.map((row) => row.sourceRunId)).toEqual(["r_left", "r_left"]);
    expect(right.rows.map((row) => row.sourceRunId)).toEqual(["r_right", "r_right"]);
  });

  it("来源映射不可靠 ⇒ 行不标来源（sourceRunId null）且 attribution 如实 unavailable", () => {
    // 视图缺少 at_span 指向的边界 span ⇒ 映射 unreliable
    const bFork: Fork = { at_span: "a_missing", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf(
      "r_b",
      [hop("r_a", null, null), hop("r_b", "r_a", bFork)],
      [stepSpan("b1"), toolSpan("b2", "b1")],
    );

    const catalog = deriveSideStepCatalog(detail);
    expect(catalog.attribution).toMatchObject({ kind: "unavailable" });
    if (catalog.attribution.kind === "unavailable") {
      expect(catalog.attribution.reason).toContain("a_missing");
    }
    expect(catalog.rows.every((row) => row.sourceRunId === null)).toBe(true);
  });
});

describe("deriveSideStepCatalog：ownOnly 前缀未知（4.9）", () => {
  it("ownOnly 侧：prefixUnknown 如实标注，目录只含自有步骤；不推断根、不折叠未知祖先", () => {
    const orphanFork: Fork = { at_span: "x1", edit: { field: "result", value: "孤儿编辑" } };
    const detail = detailOf(
      "r_o",
      [hop("r_o", "r_x", orphanFork)],
      [stepSpan("o1"), toolSpan("o2", "o1"), toolSpan("o3", "o1", { error: "工具失败" })],
      {
        spanScope: "own",
        completeness: "ownOnly",
        lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_x" },
      },
    );

    const catalog = deriveSideStepCatalog(detail);
    expect(catalog.prefixUnknown).toBe(true);
    expect(catalog.attribution).toEqual({ kind: "own" });
    // 目录 = 已校验自有步骤（含失败标记照抄），无任何「推断出的根/祖先」行
    expect(catalog.rows.map((row) => [row.spanId, row.sourceRunId, row.own])).toEqual([
      ["o1", "r_o", true],
      ["o2", "r_o", true],
      ["o3", "r_o", true],
    ]);
    expect(catalog.rows[2]?.errorKind).toBe("tool");
  });

  it("ownOnly 侧与完整另一侧互不影响：完整侧照常带前缀目录", () => {
    const fullView = [stepSpan("a1"), toolSpan("a2", "a1"), stepSpan("b1", 1, "a2")];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const full = deriveSideStepCatalog(
      detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], fullView, {
        leafSpanIds: ["b1"],
      }),
    );
    const orphanFork: Fork = { at_span: "x1", edit: { field: "result", value: "孤儿编辑" } };
    const orphan = deriveSideStepCatalog(
      detailOf("r_o", [hop("r_o", "r_x", orphanFork)], [stepSpan("o1")], {
        spanScope: "own",
        completeness: "ownOnly",
        lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_x" },
      }),
    );

    expect(full.prefixUnknown).toBe(false);
    expect(full.rows).toHaveLength(3);
    expect(orphan.prefixUnknown).toBe(true);
    expect(orphan.rows).toHaveLength(1);
  });
});
