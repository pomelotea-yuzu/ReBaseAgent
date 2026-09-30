import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import {
  deriveDifferentRootFacts,
  deriveDirectEditEvidence,
  deriveHopChains,
} from "../src/shared/compare-edit-evidence";
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

function llmSpan(
  id: string,
  messages: Array<{ role: string; content: string }> = [
    { role: "system", content: "系统提示词" },
    { role: "user", content: "用户消息" },
  ],
): Extract<SpanLine, { kind: "llm.call" }> {
  return {
    type: "span",
    id,
    parent: "t_step",
    kind: "llm.call",
    request: { model: "m", messages },
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
  leafSpanIds?: string[],
): RunDetail {
  return {
    meta: meta(id, parent, fork, formatVersion),
    spans,
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    chain,
    leafSpanIds: leafSpanIds ?? spans.map((span) => span.id),
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
  leafSpanIds?: string[],
): Extract<CompareRunItem, { status: "ready" }> {
  const chain =
    parent === null ? [hop(id, null, fork)] : [hop(parent, null, null), hop(id, parent, fork)];
  return {
    status: "ready",
    runId: id,
    detail: detail(id, parent, fork, spans, chain, formatVersion, leafSpanIds),
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

  it("model_params 字段 ⇒ FIELD_NOT_PROJECTED（§5 实验门禁承载，普通比较不投影）", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), llmSpan("t_01")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "model_params", value: "新值" } },
      [],
    );
    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "FIELD_NOT_PROJECTED",
      field: "model_params",
      updated: { kind: "value", value: "新值" },
    });
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

describe("U7 4.11 system/user prompt 与 messages：实际父请求取值", () => {
  const PARENT_SPANS = [
    stepSpan("t_step"),
    llmSpan("t_01", [
      { role: "system", content: "原系统提示词" },
      { role: "user", content: "原用户消息" },
    ]),
  ];

  it("system_prompt verified：原值 = 父自有首次 llm.call 的 system content，语义 from-scratch", () => {
    const parent = ready("r_p", null, P_FORK, PARENT_SPANS);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "system_prompt", value: "新系统提示词" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status !== "verified") return;
    expect(evidence).toMatchObject({
      sourceRunId: "r_p",
      targetRunId: "r_c",
      field: "system_prompt",
      atSpanId: "t_01",
      semantics: "from-scratch",
      tool: null,
    });
    expect(evidence.original).toEqual({ kind: "value", value: "原系统提示词" });
    expect(evidence.updated).toEqual({ kind: "value", value: "新系统提示词" });
  });

  it("user_message verified：原值 = 首条 user 消息 content", () => {
    const parent = ready("r_p", null, P_FORK, PARENT_SPANS);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "user_message", value: "新用户消息" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status === "verified") {
      expect(evidence.original).toEqual({ kind: "value", value: "原用户消息" });
      expect(evidence.semantics).toBe("from-scratch");
    }
  });

  it("messages verified：原值 = 父自有首次请求的整份 messages，语义 single-request", () => {
    const parent = ready("r_p", null, P_FORK, PARENT_SPANS);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "messages", value: [{ role: "user", content: "改写" }] } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status !== "verified") return;
    expect(evidence.semantics).toBe("single-request");
    expect(evidence.original).toEqual({
      kind: "value",
      value: [
        { role: "system", content: "原系统提示词" },
        { role: "user", content: "原用户消息" },
      ],
    });
  });

  it("反例：父是 result 分叉（合并视图含祖先 llm.call）⇒ 取父自有首次调用，不取祖先请求", () => {
    // 祖先 llm.call 在合并前缀里（system 内容是祖先的）；父自有调用在 leafSpanIds 内
    const parentSpans = [
      stepSpan("g_step"),
      llmSpan("g_01", [{ role: "system", content: "祖先的系统提示词" }]),
      stepSpan("p_step", 2),
      llmSpan("p_01", [{ role: "system", content: "父本的系统提示词" }]),
    ];
    const parent = ready(
      "r_p",
      "r_g",
      { at_span: "g_01", edit: { field: "result", value: "x" } },
      parentSpans,
      1,
      ["p_step", "p_01"],
    );
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "p_01", edit: { field: "system_prompt", value: "新提示词" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status === "verified") {
      expect(evidence.original).toEqual({ kind: "value", value: "父本的系统提示词" });
    }
  });

  it("父无自有 llm.call ⇒ START_CONTEXT_UNRECORDED，不猜启动上下文", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", "结果")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "system_prompt", value: "新提示词" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "START_CONTEXT_UNRECORDED",
      original: { kind: "unrecorded" },
      updated: { kind: "value", value: "新提示词" },
    });
  });

  it("首次请求无 system 消息 ⇒ START_CONTEXT_UNRECORDED（不补空串）", () => {
    const parent = ready("r_p", null, P_FORK, [
      stepSpan("t_step"),
      llmSpan("t_01", [{ role: "user", content: "用户消息" }]),
    ]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "system_prompt", value: "新提示词" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "START_CONTEXT_UNRECORDED",
      original: { kind: "unrecorded" },
    });
  });
});

describe("U7 4.2 多跳/兄弟：逐跳编辑证据链", () => {
  // A → B → C 与 A → D：C 侧 2 跳、D 侧 1 跳（共同祖先 A）
  const aSpans = [stepSpan("a_step"), toolSpan("a_t", "A 的工具结果")];
  const bFork: Fork = { at_span: "a_t", edit: { field: "result", value: "B 的编辑" } };
  const bSpans = [...aSpans, toolSpan("b_t", "A 的工具结果"), stepSpan("b_step", 2)];
  const cFork: Fork = { at_span: "b_t", edit: { field: "result", value: "C 的编辑" } };
  const cSpans = [...bSpans, stepSpan("c_step", 3)];
  const dFork: Fork = { at_span: "a_t", edit: { field: "result", value: "D 的编辑" } };

  function chainItem(
    id: string,
    parent: string | null,
    fork: Fork | null,
    spans: SpanLine[],
  ): Extract<CompareRunItem, { status: "ready" }> {
    return ready(id, parent, fork, spans);
  }

  it("兄弟两臂：各侧从共同祖先逐跳列出，跳数 = 链长（不压缩成一次编辑）", () => {
    const a = chainItem("r_a", null, null, aSpans);
    const b = chainItem("r_b", "r_a", bFork, bSpans);
    const c = chainItem("r_c", "r_b", cFork, cSpans);
    const d = chainItem("r_d", "r_a", dFork, aSpans);

    const chains = deriveHopChains([b, d], "r_a");
    expect(chains).toHaveLength(2);

    const sideB = chains.find((s) => s.runId === "r_b");
    expect(sideB?.hops).toHaveLength(1);
    expect(sideB?.hops[0]).toMatchObject({
      status: "verified",
      sourceRunId: "r_a",
      targetRunId: "r_b",
      field: "result",
      atSpanId: "a_t",
    });

    const sideC = chains.find((s) => s.runId === "r_c");
    // 注意：deriveHopChains 按 items 里 ready 侧逐侧产出；C 不在 items 里所以没有
    expect(sideC).toBeUndefined();
  });

  it("多跳链：C 侧两跳身份连续（A→B→C），每跳直接父核对通过，值从该侧投影视图取", () => {
    const b = chainItem("r_b", "r_a", bFork, bSpans);
    // C 的 chain 必须是完整三跳（root..leaf）：A → B → C
    const c: Extract<CompareRunItem, { status: "ready" }> = {
      status: "ready",
      runId: "r_c",
      detail: detail("r_c", "r_b", cFork, cSpans, [
        hop("r_a", null, null),
        hop("r_b", "r_a", bFork),
        hop("r_c", "r_b", cFork),
      ]),
      chainSummaries: [],
    };

    const chains = deriveHopChains([c], "r_a");
    const sideC = chains[0];
    expect(sideC?.hops).toHaveLength(2);

    const hop1 = sideC?.hops[0];
    expect(hop1).toMatchObject({
      status: "verified",
      sourceRunId: "r_a",
      targetRunId: "r_b",
      atSpanId: "a_t",
      semantics: "shared-prefix",
    });
    if (hop1?.status === "verified") {
      // C 的 resolved 视图含 A 的 tool.invoke 原值
      expect(hop1.original).toEqual({ kind: "value", value: "A 的工具结果" });
      expect(hop1.updated).toEqual({ kind: "value", value: "B 的编辑" });
    }

    const hop2 = sideC?.hops[1];
    expect(hop2).toMatchObject({
      status: "verified",
      sourceRunId: "r_b",
      targetRunId: "r_c",
      atSpanId: "b_t",
    });
  });

  it("祖先未确认（ancestorId=null）⇒ 空链（不按可见链首项推断根）", () => {
    const a = chainItem("r_a", null, null, aSpans);
    const b = chainItem("r_b", "r_a", bFork, bSpans);
    expect(deriveHopChains([a, b], null)).toEqual([]);
  });

  it("ownOnly 侧：跳身份保留、值 SPAN_NOT_IN_VIEW（分叉点不在自有视图）", () => {
    // ownOnly 叶子：chain 只含自身，spanScope=own
    const orphanFork: Fork = { at_span: "x_t", edit: { field: "result", value: "孤儿编辑" } };
    const orphanDetail: RunDetail = {
      meta: meta("r_o", "r_x", orphanFork),
      spans: [stepSpan("o_step"), toolSpan("o_t", "自有结果")],
      events: [{ type: "run.event", event: "stopped", reason: "completed" }],
      status: "completed",
      chain: [hop("r_o", "r_x", orphanFork)],
      leafSpanIds: ["o_step", "o_t"],
      completeness: "ownOnly",
      spanScope: "own",
      lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: "r_x" },
    };
    const orphan: Extract<CompareRunItem, { status: "ready" }> = {
      status: "ready",
      runId: "r_o",
      detail: orphanDetail,
      chainSummaries: [],
    };
    const other = chainItem("r_d", null, null, aSpans);

    // 关系不完整时上游不传祖先 id ⇒ 空链；这里验证防御分支：即便传了缺失祖先 id 也不猜
    const chains = deriveHopChains([orphan, other], "r_x");
    const sideO = chains.find((s) => s.runId === "r_o");
    // r_x 不在 orphan 的 chain 内 ⇒ 空链
    expect(sideO?.hops).toEqual([]);
  });

  it("prompt fork 叶（兄弟对中另一臂）：context 跳的来源不在对内 ⇒ SPAN_NOT_IN_VIEW", () => {
    const promptFork: Fork = {
      at_span: "a_01",
      edit: { field: "system_prompt", value: "新提示词" },
    };
    const b = chainItem("r_b", "r_a", promptFork, [stepSpan("b_step")]);
    const d = chainItem("r_d", "r_a", dFork, aSpans);

    const chains = deriveHopChains([b, d], "r_a");
    const sideB = chains.find((s) => s.runId === "r_b");
    expect(sideB?.hops[0]).toMatchObject({
      status: "unavailable",
      reasonCode: "SPAN_NOT_IN_VIEW",
      sourceRunId: "r_a",
      targetRunId: "r_b",
      field: "system_prompt",
      updated: { kind: "value", value: "新提示词" },
    });
  });

  it("prompt fork 直接父子：来源（父）在对内 ⇒ 走实际请求取值（与 4.1 同源）", () => {
    const promptFork: Fork = {
      at_span: "a_01",
      edit: { field: "system_prompt", value: "新提示词" },
    };
    const parent = chainItem("r_p", null, null, [
      stepSpan("t_step"),
      llmSpan("a_01", [{ role: "system", content: "原系统提示词" }]),
    ]);
    const child = chainItem("r_c", "r_p", promptFork, [stepSpan("c_step")]);

    const chains = deriveHopChains([child, parent], "r_p");
    const sideChild = chains.find((s) => s.runId === "r_c");
    expect(sideChild?.hops[0]).toMatchObject({
      status: "verified",
      semantics: "from-scratch",
      sourceRunId: "r_p",
      targetRunId: "r_c",
    });
    if (sideChild?.hops[0]?.status === "verified") {
      expect(sideChild.hops[0].original).toEqual({ kind: "value", value: "原系统提示词" });
    }
  });
});

describe("U7 4.3 不同根：只核对实际输入配置", () => {
  function rootItem(
    id: string,
    opts: {
      model?: string;
      messages?: Array<{ role: string; content: string }>;
      params?: Record<string, unknown>;
    } = {},
  ): Extract<CompareRunItem, { status: "ready" }> {
    const msgs = opts.messages ?? [
      { role: "system", content: `${id} 的系统提示词` },
      { role: "user", content: `${id} 的用户消息` },
    ];
    const call = llmSpan("t_01", msgs);
    const request = {
      model: opts.model ?? "model-a",
      messages: msgs,
      ...(opts.params !== undefined ? { params: opts.params } : {}),
    };
    return {
      status: "ready",
      runId: id,
      detail: detail(
        id,
        null,
        null,
        [stepSpan("t_step"), { ...call, request }],
        [hop(id, null, null)],
      ),
      chainSummaries: [],
    };
  }

  it("unrelated ⇒ 两侧事实并排：模型/启动输入/参数取各自实际请求", () => {
    const left = rootItem("r_l", { model: "model-a", params: { temperature: 0.7 } });
    const right = rootItem("r_r", { model: "model-b" });

    const facts = deriveDifferentRootFacts(left, right, { kind: "unrelated" });
    expect(facts.status).toBe("facts");
    if (facts.status !== "facts") return;
    const [l, r] = facts.sides;
    expect(l).toMatchObject({ runId: "r_l" });
    expect(l.model).toEqual({ kind: "value", value: "model-a" });
    expect(l.systemPrompt).toEqual({ kind: "value", value: "r_l 的系统提示词" });
    expect(l.params).toEqual({ kind: "value", value: { temperature: 0.7 } });
    expect(r.model).toEqual({ kind: "value", value: "model-b" });
    // 未带 params：unrecorded（不是空对象）
    expect(r.params).toEqual({ kind: "unrecorded" });
  });

  it("无自有 llm.call 的侧：各项 unrecorded，不补空串", () => {
    const left = rootItem("r_l");
    const right = ready("r_r", null, null, [stepSpan("t_step")]); // 无 llm.call

    const facts = deriveDifferentRootFacts(left, right, { kind: "unrelated" });
    expect(facts.status).toBe("facts");
    if (facts.status === "facts") {
      const r = facts.sides[1];
      expect(r?.model).toEqual({ kind: "unrecorded" });
      expect(r?.systemPrompt).toEqual({ kind: "unrecorded" });
      expect(r?.userMessage).toEqual({ kind: "unrecorded" });
      expect(r?.params).toEqual({ kind: "unrecorded" });
    }
  });

  it("relation 非 unrelated ⇒ notApplicable（共同祖先未确认不得按不同根呈现）", () => {
    const left = rootItem("r_l");
    const right = rootItem("r_r");
    expect(deriveDifferentRootFacts(left, right, { kind: "common" })).toMatchObject({
      status: "notApplicable",
    });
    expect(deriveDifferentRootFacts(left, right, { kind: "incomplete" })).toMatchObject({
      status: "notApplicable",
    });
  });

  it("存在不可读侧 ⇒ notApplicable（不构成完整对照）", () => {
    const left = rootItem("r_l");
    const facts = deriveDifferentRootFacts(left, unavailable("r_r"), { kind: "unrelated" });
    expect(facts.status).toBe("notApplicable");
  });
});

describe("U7 4.4 三态与空值边界收口", () => {
  it("fork.edit.value 字面缺失（undefined）⇒ EDIT_VALUE_UNRECORDED，与真实空串分开", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", "原值")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: undefined } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence).toMatchObject({
      status: "unavailable",
      reasonCode: "EDIT_VALUE_UNRECORDED",
      original: { kind: "unrecorded" },
      updated: { kind: "unrecorded" },
    });
  });

  it("双真实空值并存：null 原值 + 空串新值 ⇒ verified（都是已记录值）", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step"), toolSpan("t_01", null)]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_01", edit: { field: "result", value: "" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("verified");
    if (evidence.status === "verified") {
      expect(evidence.original).toEqual({ kind: "value", value: null });
      expect(evidence.updated).toEqual({ kind: "value", value: "" });
    }
  });

  it("不可用结论恒携带身份四元组与受控原因（不伪空文本、不借对侧顶替）", () => {
    const parent = ready("r_p", null, P_FORK, [stepSpan("t_step")]);
    const child = ready(
      "r_c",
      "r_p",
      { at_span: "t_missing", edit: { field: "result", value: "新值" } },
      [],
    );

    const evidence = deriveDirectEditEvidence(child, parent);
    expect(evidence.status).toBe("unavailable");
    if (evidence.status !== "unavailable") return;
    expect(evidence.sourceRunId).toBe("r_p");
    expect(evidence.targetRunId).toBe("r_c");
    expect(evidence.field).toBe("result");
    expect(evidence.atSpanId).toBe("t_missing");
    expect(evidence.reason.length).toBeGreaterThan(0);
    expect(evidence.reason).not.toContain("D:");
    expect(evidence.reason).not.toContain("\\");
  });
});
