import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import { deriveV1ResultSourceMapping } from "../src/shared/compare-source-map";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 4.7：普通 v1 result 链的只读来源映射。
 *
 * 判据来源：desktop-ui delta「result 共享前缀保留真实边界」：
 * - 按 span 截断（v1）标记前缀，映射给出每个 span 的物理来源 run；
 * - 边界 span 是被编辑点：共同区保留原值，映射携带编辑标注（视图标编辑标记）；
 * - 边界缺失/错序/重复 ⇒ 不可靠，不折叠前缀；
 * - 两侧重复的 s_01 不作为共享执行证明——映射只认已校验链结构。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function meta(
  id: string,
  parent: string | null,
  fork: Fork | null,
  formatVersion: 1 | 2 = 1,
): RunDetail["meta"] {
  return {
    type: "run.meta",
    id,
    format_version: formatVersion,
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

function toolSpan(id: string, parent: string | null): Extract<SpanLine, { kind: "tool.invoke" }> {
  return {
    type: "span",
    id,
    parent,
    kind: "tool.invoke",
    tool: "write_file",
    args: {},
    result: "值",
    dur_ms: 1,
    error: null,
  };
}

function hop(
  id: string,
  parent: string | null,
  fork: Fork | null,
  formatVersion: 1 | 2 = 1,
): RunDetail["chain"][number] {
  return { meta: meta(id, parent, fork, formatVersion), fork };
}

/**
 * v1 纯 result 链 detail：`viewSpans` 是 resolveBranch 的拼接结果
 * （各段 spans 顺序相接；段末 = 下一跳 at_span）。
 */
function detailOf(
  id: string,
  chain: RunDetail["chain"],
  viewSpans: SpanLine[],
  opts: { spanScope?: "resolved" | "own"; leafSpanIds?: string[] } = {},
): RunDetail {
  return {
    meta: chain[chain.length - 1]?.meta ?? meta(id, null, null),
    spans: viewSpans,
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain,
    leafSpanIds: opts.leafSpanIds ?? viewSpans.map((span) => span.id),
    completeness: "complete",
    spanScope: opts.spanScope ?? "resolved",
    lineage: { status: "complete" },
  };
}

describe("deriveV1ResultSourceMapping：纯 v1 链分段", () => {
  it("双跳链 A→B：两段——A 段止于 B.at_span（带编辑标注），B 段为自有", () => {
    // A.spans = a1(step) a2(tool)；B fork at a2，B.spans = b1(step) b2(tool)
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"),
      stepSpan("b1", 1, "a2"),
      toolSpan("b2", "b1"),
    ];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], view);

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping.status).toBe("mapped");
    if (mapping.status !== "mapped") return;

    expect(mapping.segments).toEqual([
      {
        sourceRunId: "r_a",
        spanIds: ["a1", "a2"],
        boundaryEdit: { targetRunId: "r_b", field: "result" },
      },
      { sourceRunId: "r_b", spanIds: ["b1", "b2"], boundaryEdit: null },
    ]);
  });

  it("三跳链 A→B→C：三段连续，边界逐跳递进（被覆写值仍在共同区、标注不隐藏）", () => {
    // B fork at a2；C fork at b2
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"),
      stepSpan("b1", 1, "a2"),
      toolSpan("b2", "b1"),
      stepSpan("c1", 1, "b2"),
      toolSpan("c2", "c1"),
    ];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const cFork: Fork = { at_span: "b2", edit: { field: "result", value: "C 的编辑" } };
    const detail = detailOf(
      "r_c",
      [hop("r_a", null, null), hop("r_b", "r_a", bFork), hop("r_c", "r_b", cFork)],
      view,
    );

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping.status).toBe("mapped");
    if (mapping.status !== "mapped") return;

    expect(mapping.segments.map((s) => s.sourceRunId)).toEqual(["r_a", "r_b", "r_c"]);
    expect(mapping.segments[0]?.spanIds).toEqual(["a1", "a2"]);
    expect(mapping.segments[0]?.boundaryEdit).toEqual({ targetRunId: "r_b", field: "result" });
    expect(mapping.segments[1]?.spanIds).toEqual(["b1", "b2"]);
    expect(mapping.segments[1]?.boundaryEdit).toEqual({ targetRunId: "r_c", field: "result" });
    expect(mapping.segments[2]?.spanIds).toEqual(["c1", "c2"]);
    expect(mapping.segments[2]?.boundaryEdit).toBeNull();
  });

  it("根 run（单跳）：单段全自有", () => {
    const detail = detailOf(
      "r_a",
      [hop("r_a", null, null)],
      [stepSpan("a1"), toolSpan("a2", "a1")],
    );

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping).toEqual({
      status: "mapped",
      segments: [{ sourceRunId: "r_a", spanIds: ["a1", "a2"], boundaryEdit: null }],
    });
  });
});

describe("deriveV1ResultSourceMapping：边界核验（不可靠不折叠）", () => {
  it("边界 span 缺失于视图 ⇒ unreliable（对照链结构验证失败）", () => {
    const view = [stepSpan("a1"), toolSpan("a2", "a1"), stepSpan("b1", 1, "a2")];
    const bFork: Fork = { at_span: "a_missing", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], view);

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "unreliable" });
    if (mapping.status === "unreliable") {
      expect(mapping.reason).toContain("a_missing");
    }
  });

  it("边界 span 在视图中重复出现 ⇒ unreliable（分段歧义）", () => {
    // a2 出现两次：段内一次 + 叶子自有段又出现同名 id（重编号碰撞的防御）
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"),
      stepSpan("b1", 1, "a2"),
      toolSpan("a2", "b1"), // 同名 id 再次出现
    ];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], view);

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "unreliable" });
    if (mapping.status === "unreliable") {
      expect(mapping.reason).toContain("2 次");
    }
  });
});

describe("deriveV1ResultSourceMapping：不越界（非 v1 纯链）", () => {
  it("链含独立边界跳（system_prompt）⇒ notPlainV1，由步骤目录承载", () => {
    const view = [stepSpan("p1")];
    const pFork: Fork = { at_span: "a1", edit: { field: "system_prompt", value: "新提示词" } };
    const detail = detailOf("r_p", [hop("r_a", null, null), hop("r_p", "r_a", pFork)], view);

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "notPlainV1" });
    if (mapping.status === "notPlainV1") {
      expect(mapping.reason).toContain("system_prompt");
    }
  });

  it("链含 v2 隔离跳（format_version=2）⇒ notPlainV1，由 4.13 的 v2 映射承载", () => {
    const view = [stepSpan("a1"), toolSpan("a2", "a1"), stepSpan("w1", 1, "a2")];
    const bFork: Fork = {
      at_span: "a2",
      resume_after_step: "a1",
      edit: { field: "result", value: "隔离续跑" },
    };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork, 2)], view);

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "notPlainV1" });
  });

  it("spanScope=own（ownOnly / 独立执行叶子）⇒ 单段全归属叶子，无前缀可折叠", () => {
    const detail = detailOf(
      "r_o",
      [hop("r_o", "r_x", { at_span: "x1", edit: { field: "result", value: "编辑" } })],
      [stepSpan("o1"), toolSpan("o2", "o1")],
      { spanScope: "own" },
    );

    const mapping = deriveV1ResultSourceMapping(detail);
    expect(mapping).toEqual({
      status: "mapped",
      segments: [{ sourceRunId: "r_o", spanIds: ["o1", "o2"], boundaryEdit: null }],
    });
  });
});
