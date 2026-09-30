import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import { deriveDirectEditEvidence } from "../src/shared/compare-edit-evidence";
import type { CompareRunItem, RunDetail } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 4.1/4.10：直接父子编辑证据投影。
 *
 * 判据来源：desktop-ui delta「直接父子展示真实编辑前后值」「原值缺失未知字段不补空」：
 * - 原值来自已校验父轨迹的 tool.invoke.result，新值来自子 fork.edit.value，
 *   方向按身份（meta.parent）不按左右位置；
 * - 真实空串 / null 与未记录严格分开，不生成伪空 diff；
 * - 未知字段原样保留字段与值 + 不可核对原因；
 * - 隔离（v2）携带 resume_after_step 整轮边界并在来源轨迹定位该 step。
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

function stepSpan(id: string, n = 1): Extract<SpanLine, { kind: "agent.step" }> {
  return { type: "span", id, parent: null, kind: "agent.step", n };
}

function toolSpan(
  id: string,
  result: unknown,
  tool = "write_file",
  parent: string | null = "t_step",
): Extract<SpanLine, { kind: "tool.invoke" }> {
  return {
    type: "span",
    id,
    parent,
    kind: "tool.invoke",
    tool,
    args: { path: "a.txt" },
    result,
    dur_ms: 5,
    error: null,
  };
}

function llmSpan(id: string): Extract<SpanLine, { kind: "llm.call" }> {
  return {
    type: "span",
    id,
    parent: "t_step",
    kind: "llm.call",
    request: { model: "m", messages: [] },
    response: {
      content: "正文",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 1, out: 1, cache_hit: 0 },
      ttft_ms: 0,
    },
  };
}

function hop(id: string, parent: string | null, fork: Fork | null): RunDetail["chain"][number] {
  return { meta: meta(id, parent, fork), fork };
}

/** 完整父子链 detail：chain = [父, 子]，子 spans 含自有段（前缀并入与否不影响本投影） */
function detail(
  id: string,
  parent: string | null,
  fork: Fork | null,
  spans: SpanLine[],
  chain: RunDetail["chain"],
  formatVersion: 1 | 2 = 1,
): RunDetail {
  return {
    meta: meta(id, parent, fork, formatVersion),
    spans,
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain,
    leafSpanIds: spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "resolved",
    lineage: { status: "complete" },
  };
}

function ready(
  id: string,
  parent: string | null,
  fork: Fork | null,
  spans: SpanLine[],
  formatVersion: 1 | 2 = 1,
): Extract<CompareRunItem, { status: "ready" }> {
  const chain =
    parent === null ? [hop(id, null, fork)] : [hop(parent, null, null), hop(id, parent, fork)];
  return {
    status: "ready",
    runId: id,
    detail: detail(id, parent, fork, spans, chain, formatVersion),
    chainSummaries: [],
  };
}

function unavailable(
  id: string,
  code = "RUN_UNREADABLE",
  reason = "读取失败",
): Extract<CompareRunItem, { status: "unavailable" }> {
  return { status: "unavailable", runId: id, code, reason };
}

const P_FORK = null; // 父是根 run，无 fork

describe("U7 4.1 普通 result 直接父子：真实前后值", () => {
  it("verified：原值 = 父 tool.invoke.result，新值 = 子 fork.edit.value，工具名保留", () => {
    const parent = ready("r_p", null, P_FORK, [
      stepSpan("t_step"),
      toolSpan("t_01", "原始工具结果"),
    ]);
    const childFork: Fork = { at_span: "t_01", edit: { field: "result", value: "编辑后的结果" } };
    const child = ready("r_c", "r_p", childFork, [
      toolSpan("t_01", "原始工具结果"),
      stepSpan("c_step", 2),
    ]);

    const evidence = deriveDirectEditEvidence(child, parent); // 左子右父

    expect(evidence.status).toBe("verified");
    if (evidence.status !== "verified") return;
    expect(evidence).toMatchObject({
      sourceRunId: "r_p",
      targetRunId: "r_c",
      field: "result",
      atSpanId: "t_01",
      variant: "plain-v1",
      tool: "write_file",
    });
    expect(evidence.original).toEqual({ kind: "value", value: "原始工具结果" });
    expect(evidence.updated).toEqual({ kind: "value", value: "编辑后的结果" });
    expect(evidence.resumeAfterStep).toBeNull();
    expect(evidence.boundaryStep).toBeNull();
  });

  it("方向按身份不按位置：父左子右与左子右父结论一致", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", "原值")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: "新值" } },
      [],
    );

    const a = deriveDirectEditEvidence(child, parent);
    const b = deriveDirectEditEvidence(parent, child);

    expect(a).toEqual(b);
    if (a.status === "verified") {
      expect(a.sourceRunId).toBe("r_p");
      expect(a.targetRunId).toBe("r_c");
    }
  });

  it("真实空串新值是 value 不是未记录（不生成伪空 diff 的前提）", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", "原值")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: "" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status === "verified") {
      expect(evidence.updated).toEqual({ kind: "value", value: "" });
    }
  });

  it("真实 null 原值照常 verified——null 是已记录值，不是未记录", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", null)]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: "新值" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status === "verified") {
      expect(evidence.original).toEqual({ kind: "value", value: null });
    }
  });
});

describe("U7 4.1 缺证与未知字段：不补空、不猜", () => {
  it("分叉点 span 不在父轨迹中 ⇒ FORK_SPAN_NOT_FOUND，子新值仍可见", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step")]); // 无 t_01
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: "新值" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "FORK_SPAN_NOT_FOUND",
      original: { kind: "unrecorded" },
      updated: { kind: "value", value: "新值" },
      atSpanId: "t_01",
    });
  });

  it("分叉点不是 tool.invoke ⇒ FORK_SPAN_NOT_TOOL", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), llmSpan("t_01")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: "新值" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "FORK_SPAN_NOT_TOOL",
      original: { kind: "unrecorded" },
    });
  });

  it("未知 edit.field ⇒ 原样保留字段与已记录新值", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", "原值")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "mystery_field", value: "新值" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "UNKNOWN_EDIT_FIELD",
      field: "mystery_field",
      original: { kind: "unrecorded" },
      updated: { kind: "value", value: "新值" },
    });
  });

  it("prompt / messages / model_params 字段 ⇒ FIELD_NOT_PROJECTED（4.11 与 §5 分别改判）", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), llmSpan("t_01")]);
    for (const field of ["system_prompt", "user_message", "messages", "model_params"] as const) {
      const child = ready("r_c", "r_p", { at_span: "t_01", edit: { field, value: "新值" } }, []);
      const evidence = deriveDirectEditEvidence(child, parent);
      expect(evidence).toMatchObject({
        status: "unavailable",
        reasonCode: "FIELD_NOT_PROJECTED",
        field,
        updated: { kind: "value", value: "新值" },
      });
    }
  });

  it("来源侧不可读 ⇒ PARENT_UNREADABLE，子新值仍可见（祖先不可得不补空）", () => {
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: "新值" } },
      [],
    );
    const broken = unavailable("r_p", "ANCESTOR_INVALID", "祖先记录损坏");

    const evidence = deriveDirectEditEvidence(child, broken);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "PARENT_UNREADABLE",
      sourceRunId: "r_p",
      targetRunId: "r_c",
      original: { kind: "unrecorded" },
      updated: { kind: "value", value: "新值" },
    });
  });

  it("不可读侧无法参与父子判定时不猜方向 ⇒ notApplicable", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step")]);
    const broken = unavailable("r_x");

    const evidence = deriveDirectEditEvidence(parent, broken);
    expect(evidence).toEqual({ status: "notApplicable", reason: expect.any(String) });
  });

  it("两侧均不可读 ⇒ notApplicable", () => {
    const evidence = deriveDirectEditEvidence(unavailable("r_a"), unavailable("r_b"));
    expect(evidence.status).toBe("notApplicable");
  });
});

describe("U7 4.1 非直接父子：不越界投影", () => {
  it("兄弟对（互不为父）⇒ notApplicable（逐跳链归 4.2）", () => {
    const grandparent = ready("r_g", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", "原值")]);
    const b1 = ready(
      "r_b1",
      "r_g",
      { at_span: "t_01", edit: { field: "result", value: "臂1" } },
      [],
    );
    const b2 = ready(
      "r_b2",
      "r_g",
      { at_span: "t_01", edit: { field: "result", value: "臂2" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(b1, b2);
    expect(evidence.status).toBe("notApplicable");
    // 交叉验证：与祖父母的直接父子各自成立
    expect(deriveDirectEditEvidence(b1, grandparent).status).toBe("verified");
  });

  it("parent 已声明但 fork 为 null（防御分支）⇒ notApplicable，不按分叉投影", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", "原值")]);
    // 构造 parent 声明但 fork=null 的载荷（纯函数防御：读取层正常不会产出该形态）
    const childNoFork: Extract<CompareRunItem, { status: "ready" }> = {
      status: "ready",
      runId: "r_c",
      detail: detail("r_c", "r_p", null, [], [hop("r_p", null, null), hop("r_c", "r_p", null)]),
      chainSummaries: [],
    };

    const evidence = deriveDirectEditEvidence(childNoFork, parent);
    expect(evidence).toMatchObject({
      status: "notApplicable",
      reason: expect.stringContaining("不是分叉"),
    });
  });
});

describe("U7 4.10 隔离（v2）result：同源取值 + 整轮边界", () => {
  it("v2 verified：variant/边界字段就位，resume_after_step 在父轨迹定位到 agent.step", () => {
    const parent = ready("r_p", null, P_FORK, [
      stepSpan("t_step", 3),
      toolSpan("t_01", "原始工具结果"),
    ]);
    const childFork: Fork = {
      at_span: "t_01",
      resume_after_step: "t_step",
      edit: { field: "result", value: "隔离续跑的新结果" },
    };
    const child = ready("r_c", "r_p", childFork, [], 2);

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status !== "verified") return;
    expect(evidence.variant).toBe("isolated-v2");
    expect(evidence.resumeAfterStep).toBe("t_step");
    expect(evidence.boundaryStep).toEqual({ spanId: "t_step", n: 3 });
    expect(evidence.original).toEqual({ kind: "value", value: "原始工具结果" });
    expect(evidence.updated).toEqual({ kind: "value", value: "隔离续跑的新结果" });
  });

  it("v2 边界 step 未在来源轨迹中 ⇒ 前后值仍 verified，边界如实未定位", () => {
    const parent = ready("r_p", null, P_FORK, [toolSpan("t_01", "原始工具结果")]);
    const childFork: Fork = {
      at_span: "t_01",
      resume_after_step: "t_missing",
      edit: { field: "result", value: "新值" },
    };
    const child = ready("r_c", "r_p", childFork, [], 2);

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status === "verified") {
      expect(evidence.boundaryStep).toBeNull();
      expect(evidence.original).toEqual({ kind: "value", value: "原始工具结果" });
    }
  });
});
