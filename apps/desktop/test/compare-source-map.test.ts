import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import { deriveResultSourceMapping } from "../src/shared/compare-source-map";
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

describe("deriveResultSourceMapping：纯 v1 链分段", () => {
  it("双跳链 A→B：两段——A 段止于 B.at_span（带编辑标注），B 段为自有", () => {
    // A.spans = a1(step) a2(tool)；B fork at a2，B.spans = b1(step) b2(tool)
    const view = [stepSpan("a1"), toolSpan("a2", "a1"), stepSpan("b1"), toolSpan("b2", "b1")];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], view);

    const mapping = deriveResultSourceMapping(detail);
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
      stepSpan("b1"),
      toolSpan("b2", "b1"),
      stepSpan("c1"),
      toolSpan("c2", "c1"),
    ];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const cFork: Fork = { at_span: "b2", edit: { field: "result", value: "C 的编辑" } };
    const detail = detailOf(
      "r_c",
      [hop("r_a", null, null), hop("r_b", "r_a", bFork), hop("r_c", "r_b", cFork)],
      view,
    );

    const mapping = deriveResultSourceMapping(detail);
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

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping).toEqual({
      status: "mapped",
      segments: [{ sourceRunId: "r_a", spanIds: ["a1", "a2"], boundaryEdit: null }],
    });
  });
});

describe("deriveResultSourceMapping：边界核验（不可靠不折叠）", () => {
  it("边界 span 缺失于视图 ⇒ unreliable（对照链结构验证失败）", () => {
    const view = [stepSpan("a1"), toolSpan("a2", "a1"), stepSpan("b1")];
    const bFork: Fork = { at_span: "a_missing", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], view);

    const mapping = deriveResultSourceMapping(detail);
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
      stepSpan("b1"),
      toolSpan("a2", "b1"), // 同名 id 再次出现
    ];
    const bFork: Fork = { at_span: "a2", edit: { field: "result", value: "B 的编辑" } };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork)], view);

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "unreliable" });
    if (mapping.status === "unreliable") {
      expect(mapping.reason).toContain("2 次");
    }
  });
});

describe("deriveResultSourceMapping：独立边界与防御分支", () => {
  it("独立边界叶子（system_prompt，4.13 改判）：视图即重置后自有段 ⇒ 单段映射成立", () => {
    // 4.7 期该用例断言 notPlainV1；4.13 推广后重置视图本就可映射（真实数据该叶子
    // spanScope=own，走单段分支）——改判留痕见 tasks 4.13 注记
    const view = [stepSpan("p1")];
    const pFork: Fork = { at_span: "a1", edit: { field: "system_prompt", value: "新提示词" } };
    const detail = detailOf("r_p", [hop("r_a", null, null), hop("r_p", "r_a", pFork)], view);

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping.status).toBe("mapped");
    if (mapping.status === "mapped") {
      expect(mapping.segments).toEqual([
        { sourceRunId: "r_p", spanIds: ["p1"], boundaryEdit: null },
      ]);
    }
  });

  it("链中 hop 缺 fork 元数据（防御分支）⇒ notResultChain，不猜", () => {
    const view = [stepSpan("a1")];
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", null)], view);

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "notResultChain" });
    if (mapping.status === "notResultChain") {
      expect(mapping.reason).toContain("无 fork 元数据");
    }
  });

  it("spanScope=own（ownOnly / 独立执行叶子）⇒ 单段全归属叶子，无前缀可折叠", () => {
    const detail = detailOf(
      "r_o",
      [hop("r_o", "r_x", { at_span: "x1", edit: { field: "result", value: "编辑" } })],
      [stepSpan("o1"), toolSpan("o2", "o1")],
      { spanScope: "own" },
    );

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping).toEqual({
      status: "mapped",
      segments: [{ sourceRunId: "r_o", spanIds: ["o1", "o2"], boundaryEdit: null }],
    });
  });
});

describe("deriveResultSourceMapping 4.13：隔离 v2 整轮边界", () => {
  it("v2 双段：父段止于 resume_after_step 子树末尾（同轮兄弟工具保留在前缀段），boundaryEdit 标注", () => {
    // A：step a1 内两个工具 a2、a3（a2 被编辑，a3 是同轮兄弟）；B 隔离续跑自 a1 整轮之后
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"), // 被编辑点（在子树内）
      toolSpan("a3", "a1"), // 同轮兄弟（整轮边界 ⇒ 保留）
      stepSpan("b1"),
      toolSpan("b2", "b1"),
    ];
    const bFork: Fork = {
      at_span: "a2",
      resume_after_step: "a1",
      edit: { field: "result", value: "隔离续跑的编辑" },
    };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork, 2)], view);

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping.status).toBe("mapped");
    if (mapping.status !== "mapped") return;
    expect(mapping.segments).toEqual([
      {
        sourceRunId: "r_a",
        spanIds: ["a1", "a2", "a3"], // 整轮：a3 不被 v1 式截断丢掉
        boundaryEdit: { targetRunId: "r_b", field: "result" },
      },
      { sourceRunId: "r_b", spanIds: ["b1", "b2"], boundaryEdit: null },
    ]);
  });

  it("编辑点不属于 resume_after_step 那一轮 ⇒ unreliable（拒绝而不猜）", () => {
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"),
      stepSpan("a9", 2), // 另一轮（不在 a1 子树）
      toolSpan("a8", "a9"), // 编辑点声明在 a9 轮内 —— 与 resume_after_step=a1 冲突
    ];
    const bFork: Fork = {
      at_span: "a8",
      resume_after_step: "a1",
      edit: { field: "result", value: "编辑" },
    };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork, 2)], view);

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "unreliable" });
    if (mapping.status === "unreliable") {
      expect(mapping.reason).toContain("不属于整轮边界");
    }
  });

  it("resume_after_step 不在视图中 ⇒ unreliable", () => {
    const view = [stepSpan("a1"), toolSpan("a2", "a1"), toolSpan("b2", "a2")];
    const bFork: Fork = {
      at_span: "a2",
      resume_after_step: "step_missing",
      edit: { field: "result", value: "编辑" },
    };
    const detail = detailOf("r_b", [hop("r_a", null, null), hop("r_b", "r_a", bFork, 2)], view);

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping).toMatchObject({ status: "unreliable" });
  });

  it("混合链 A(v1)→B(v2)→C(v1)：三段连续，v2 与 v1 边界各自核验", () => {
    // A: a1(step)+a2(tool)；B 隔离续跑自 a1 整轮后，自有 b1(step)+b2(tool)；
    // C 从 B 的 b2 之后 fork（v1）
    const view = [
      stepSpan("a1"),
      toolSpan("a2", "a1"),
      stepSpan("b1"),
      toolSpan("b2", "b1"),
      stepSpan("c1"),
      toolSpan("c2", "c1"),
    ];
    const bFork: Fork = {
      at_span: "a2",
      resume_after_step: "a1",
      edit: { field: "result", value: "B 的隔离编辑" },
    };
    const cFork: Fork = { at_span: "b2", edit: { field: "result", value: "C 的编辑" } };
    const detail = detailOf(
      "r_c",
      [hop("r_a", null, null), hop("r_b", "r_a", bFork, 2), hop("r_c", "r_b", cFork)],
      view,
    );

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping.status).toBe("mapped");
    if (mapping.status !== "mapped") return;
    expect(mapping.segments.map((seg) => seg.sourceRunId)).toEqual(["r_a", "r_b", "r_c"]);
    expect(mapping.segments[0]?.spanIds).toEqual(["a1", "a2"]);
    expect(mapping.segments[1]?.spanIds).toEqual(["b1", "b2"]);
    expect(mapping.segments[1]?.boundaryEdit).toEqual({ targetRunId: "r_c", field: "result" });
    expect(mapping.segments[2]?.spanIds).toEqual(["c1", "c2"]);
  });

  it("独立边界之后接 v2：重置 hop 为首段来源，v2 子树边界在其后核验", () => {
    // A → P(system_prompt，独立边界，视图重置) → B(v2 隔离续跑自 p1 整轮后)
    const view = [stepSpan("p1"), toolSpan("p2", "p1"), stepSpan("b1"), toolSpan("b2", "b1")];
    const pFork: Fork = { at_span: "a1", edit: { field: "system_prompt", value: "新提示词" } };
    const bFork: Fork = {
      at_span: "p2",
      resume_after_step: "p1",
      edit: { field: "result", value: "隔离续跑" },
    };
    const detail = detailOf(
      "r_b",
      [hop("r_a", null, null), hop("r_p", "r_a", pFork), hop("r_b", "r_p", bFork, 2)],
      view,
    );

    const mapping = deriveResultSourceMapping(detail);
    expect(mapping.status).toBe("mapped");
    if (mapping.status !== "mapped") return;
    expect(mapping.segments).toEqual([
      {
        sourceRunId: "r_p",
        spanIds: ["p1", "p2"],
        boundaryEdit: { targetRunId: "r_b", field: "result" },
      },
      { sourceRunId: "r_b", spanIds: ["b1", "b2"], boundaryEdit: null },
    ]);
  });
});
