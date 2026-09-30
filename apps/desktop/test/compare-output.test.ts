import type { SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import { deriveCompareDiffGate, deriveSideOutputFacts } from "../src/shared/compare-output";
import type { SideOutputFacts } from "../src/shared/compare-output";
import type { RunDetail } from "../src/shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 4.5：比较侧的单侧输出事实。
 *
 * 判据来源：desktop-ui delta「最终输出不借中间正文或祖先」：
 * - 正常完成侧显示完整最终输出；
 * - 失败/受限/仅思维链侧明确未记录最终输出并保留中间内容，**不借祖先或更早正文补齐**；
 * - 真实自有错误可定位（带 (runId, spanId)）；
 * - 判据全部复用上游派生（deriveOwnTerminalFacts / deriveOwnOutput），本层只补侧身份。
 *
 * ⚠️ 反例纪律：刻意构造「祖先前缀与自有内容并存」的合并视图，
 *    证明输出/错误都来自自有段（leafSpanIds 界定）而非祖先段。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function meta(id: string): RunDetail["meta"] {
  return {
    type: "run.meta",
    id,
    format_version: 1,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    parent: null,
    fork: null,
  };
}

function stepSpan(id: string, n = 1): Extract<SpanLine, { kind: "agent.step" }> {
  return { type: "span", id, parent: null, kind: "agent.step", n };
}

function llmSpan(
  id: string,
  opts: {
    content?: string | null;
    reasoning?: string | null;
    toolCalls?: Array<Record<string, unknown>>;
    error?: { message: string; status?: number };
    parent?: string;
  } = {},
): Extract<SpanLine, { kind: "llm.call" }> {
  return {
    type: "span",
    id,
    parent: opts.parent ?? "s_01",
    kind: "llm.call",
    request: { model: "controlled-model", messages: [] },
    response: {
      content: opts.content ?? null,
      reasoning_content: opts.reasoning ?? null,
      tool_calls: opts.toolCalls ?? [],
      usage: { in: 1, out: 1, cache_hit: 0 },
      ttft_ms: 0,
    },
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  };
}

function detailOf(
  id: string,
  opts: {
    status?: "completed" | "crashed";
    reason?: "completed" | "error" | "max_iterations" | "budget_exceeded";
    spans: SpanLine[];
    leafSpanIds?: string[];
  },
): RunDetail {
  const events =
    opts.status === "crashed"
      ? []
      : [
          {
            type: "run.event" as const,
            event: "stopped" as const,
            reason: opts.reason ?? "completed",
          },
        ];
  return {
    meta: meta(id),
    spans: opts.spans,
    events,
    status: opts.status ?? "completed",
    chain: [{ meta: meta(id), fork: null }],
    leafSpanIds: opts.leafSpanIds ?? opts.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "resolved",
    lineage: { status: "complete" },
  };
}

describe("deriveSideOutputFacts：正常完成侧", () => {
  it("最终输出 = 最后自有调用正文，结局 completed，无错误目标", () => {
    const detail = detailOf("r_ok", {
      reason: "completed",
      spans: [stepSpan("s_01"), llmSpan("c_01", { content: "最终正文" })],
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.runId).toBe("r_ok");
    expect(facts.reason).toBe("completed");
    expect(facts.outcome).toMatchObject({ kind: "completed", normalEnd: true });
    expect(facts.output.finalOutput).not.toBeNull();
    expect(facts.output.finalOutput?.content).toBe("最终正文");
    expect(facts.output.finalOutput?.spanId).toBe("c_01");
    // 非 error 终止 ⇒ 无错误目标（与概览同款：缺失提示只对 error 终止有意义）
    expect(facts.failure.llmCallSpanId).toBeNull();
    expect(facts.failure.missingDetail).toBe(false);
  });

  it("反例：合并视图含祖先前缀 ⇒ 最终输出取自有段，不借祖先正文", () => {
    const detail = detailOf("r_child", {
      reason: "completed",
      spans: [
        stepSpan("g_01"),
        llmSpan("g_c1", { content: "祖先的正文", parent: "g_01" }),
        stepSpan("s_01", 2),
        llmSpan("c_01", { content: "自有的最终正文" }),
      ],
      leafSpanIds: ["s_01", "c_01"], // resolved 视图：前两项是祖先前缀
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.output.finalOutput?.content).toBe("自有的最终正文");
    expect(facts.output.finalOutput?.spanId).toBe("c_01");
  });
});

describe("deriveSideOutputFacts：失败与受限侧", () => {
  it("error 终止 + 自有失败调用 ⇒ 错误定位带 (runId, spanId)；中间正文保留为 latestIntermediate", () => {
    const detail = detailOf("r_err", {
      reason: "error",
      spans: [
        stepSpan("s_01"),
        llmSpan("c_01", { content: "中断前的中间正文" }),
        llmSpan("c_02", { error: { message: "上游 500", status: 500 } }),
      ],
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.outcome).toMatchObject({ kind: "error" });
    // 最终输出四条件不满足：不冒充，但中间正文如实保留
    expect(facts.output.finalOutput).toBeNull();
    expect(facts.output.latestIntermediate?.content).toBe("中断前的中间正文");
    // 可跳转目标：runId + 失败调用 span
    expect(facts.failure).toMatchObject({
      runId: "r_err",
      llmCallSpanId: "c_02",
      message: "上游 500",
      status: 500,
    });
  });

  it("反例：祖先前缀里的失败调用不冒充本次失败原因", () => {
    const detail = detailOf("r_child_err", {
      reason: "error",
      spans: [
        stepSpan("g_01"),
        llmSpan("g_c1", { error: { message: "祖先的失败" }, parent: "g_01" }),
        stepSpan("s_01", 2),
        llmSpan("c_01", { error: { message: "自有的失败" } }),
      ],
      leafSpanIds: ["s_01", "c_01"],
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.failure.llmCallSpanId).toBe("c_01");
    expect(facts.failure.message).toBe("自有的失败");
  });

  it("error 终止但自有记录无失败调用 ⇒ missingDetail 如实标注，不虚构入口", () => {
    const detail = detailOf("r_err_quiet", {
      reason: "error",
      spans: [stepSpan("s_01"), llmSpan("c_01", { content: "普通调用" })],
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.failure.missingDetail).toBe(true);
    expect(facts.failure.llmCallSpanId).toBeNull();
    expect(facts.failure.runId).toBe("r_err_quiet");
  });

  it("仅思维链侧：lastOutputKind=reasoning-only，最终输出缺失分型如实", () => {
    const detail = detailOf("r_reason", {
      reason: "completed",
      spans: [stepSpan("s_01"), llmSpan("c_01", { reasoning: "只有思维链" })],
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.output.finalOutput).toBeNull();
    expect(facts.output.lastOutputKind).toBe("reasoning-only");
    expect(facts.output.missingReason).toBe("empty-content");
  });

  it("pending tool_calls：循环未竟 ⇒ 不当作最终输出", () => {
    const detail = detailOf("r_pending", {
      reason: "max_iterations",
      spans: [
        stepSpan("s_01"),
        llmSpan("c_01", { content: "中间正文", toolCalls: [{ id: "t1" }] }),
      ],
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.output.finalOutput).toBeNull();
    expect(facts.output.missingReason).toBe("pending-tool-calls");
    expect(facts.outcome).toMatchObject({ kind: "max_iterations" });
  });

  it("crashed（无终止事件）⇒ 结局 interrupted、reason null、无错误目标", () => {
    const detail = detailOf("r_crash", {
      status: "crashed",
      spans: [stepSpan("s_01"), llmSpan("c_01", { content: "中断前正文" })],
    });

    const facts = deriveSideOutputFacts(detail);
    expect(facts.reason).toBeNull();
    expect(facts.outcome).toMatchObject({ kind: "interrupted", normalEnd: false });
    expect(facts.output.finalOutput).toBeNull();
    expect(facts.failure.llmCallSpanId).toBeNull();
  });
});

describe("deriveCompareDiffGate 4.6：只读文本 diff 门禁", () => {
  const readySide = (id: string, content: string): SideOutputFacts =>
    deriveSideOutputFacts(
      detailOf(id, {
        reason: "completed",
        spans: [stepSpan("s_01"), llmSpan("c_01", { content })],
      }),
    );
  const failedSide = (id: string): SideOutputFacts =>
    deriveSideOutputFacts(
      detailOf(id, {
        reason: "error",
        spans: [stepSpan("s_01"), llmSpan("c_01", { error: { message: "上游 500" } })],
      }),
    );

  it("双方最终文本就绪 ⇒ available，携带左右正文与产出 span", () => {
    const gate = deriveCompareDiffGate(readySide("r_l", "左侧正文"), readySide("r_r", "右侧正文"));
    expect(gate).toEqual({
      status: "available",
      leftText: "左侧正文",
      rightText: "右侧正文",
      leftSpanId: "c_01",
      rightSpanId: "c_01",
    });
  });

  it("一侧 error 终止 ⇒ unavailable（错误不作为空文本参与 diff）", () => {
    const gate = deriveCompareDiffGate(readySide("r_l", "左侧正文"), failedSide("r_r"));
    expect(gate).toMatchObject({
      status: "unavailable",
    });
    if (gate.status === "unavailable") {
      expect(gate.reason).toContain("右侧");
      expect(gate.reason).toContain("带错误");
    }
  });

  it("一侧仅思维链 ⇒ unavailable（reasoning-only 不参与伪空比较）", () => {
    const reasoningSide = deriveSideOutputFacts(
      detailOf("r_r", {
        reason: "completed",
        spans: [stepSpan("s_01"), llmSpan("c_01", { reasoning: "思维链" })],
      }),
    );
    const gate = deriveCompareDiffGate(readySide("r_l", "左侧正文"), reasoningSide);
    expect(gate.status).toBe("unavailable");
    if (gate.status === "unavailable") {
      expect(gate.reason).toContain("无正文");
    }
  });

  it("一侧无自有调用 ⇒ unavailable（未记录不顶替）", () => {
    const emptySide = deriveSideOutputFacts(detailOf("r_r", { spans: [stepSpan("s_01")] }));
    const gate = deriveCompareDiffGate(readySide("r_l", "左侧正文"), emptySide);
    expect(gate.status).toBe("unavailable");
    if (gate.status === "unavailable") {
      expect(gate.reason).toContain("未记录任何自有模型调用");
    }
  });
});
