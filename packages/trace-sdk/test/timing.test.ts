import { describe, expect, it } from "vitest";
import { NullTracer, parseRunText } from "../src/index";
import { AgentStepSpanSchema } from "../src/index";
import type { SpanLine } from "../src/index";
import { recordDemoRun, sampleMeta } from "./helpers";

/** 一条无 timing 的老格式 span（历史文件与手工构造数据） */
const LEGACY_SPAN = JSON.stringify({
  type: "span",
  id: "s_01",
  kind: "agent.step",
  parent: null,
  n: 1,
});

const LEGACY_RUN = [
  JSON.stringify({ type: "run.meta", ...sampleMeta() }),
  LEGACY_SPAN,
  JSON.stringify({ type: "run.event", event: "stopped", reason: "completed", at: 1 }),
];

/** span 的墙上耗时（毫秒）；timing 缺省时返回 null——时间未知不得臆造 */
export function spanDurationMs(span: SpanLine): number | null {
  if (span.timing === undefined) return null;
  return Date.parse(span.timing.ended_at) - Date.parse(span.timing.started_at);
}

describe("schema：timing 可选且成对", () => {
  it("缺失 timing 的 span 合法（老文件）", () => {
    const span = AgentStepSpanSchema.parse({
      type: "span",
      id: "s_01",
      kind: "agent.step",
      parent: null,
      n: 1,
    });
    expect(span.timing).toBeUndefined();
  });

  it("timing 成对时通过校验", () => {
    const span = AgentStepSpanSchema.parse({
      type: "span",
      id: "s_01",
      kind: "agent.step",
      parent: null,
      n: 1,
      timing: { started_at: "2026-01-15T10:00:00.000Z", ended_at: "2026-01-15T10:00:01.500Z" },
    });
    expect(span.timing).toEqual({
      started_at: "2026-01-15T10:00:00.000Z",
      ended_at: "2026-01-15T10:00:01.500Z",
    });
  });

  it("timing 缺一半则校验失败（不允许有起点没终点）", () => {
    expect(() =>
      AgentStepSpanSchema.parse({
        type: "span",
        id: "s_01",
        kind: "agent.step",
        parent: null,
        n: 1,
        timing: { started_at: "2026-01-15T10:00:00.000Z" },
      }),
    ).toThrow();
  });
});

describe("Tracer：自动记录起止时刻", () => {
  it("每个 span 落盘时都带成对的 timing", () => {
    const tracer = new NullTracer();
    const spans: SpanLine[] = [];
    tracer.subscribe((e) => {
      if (e.type === "span.end") spans.push(e.span);
    });

    recordDemoRun(tracer);

    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.timing).toBeDefined();
      expect(span.timing?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(span.timing?.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("子 span 的时间区间落在父 span 之内", () => {
    const tracer = new NullTracer();
    const spans: SpanLine[] = [];
    tracer.subscribe((e) => {
      if (e.type === "span.end") spans.push(e.span);
    });

    recordDemoRun(tracer);

    const step = spans.find((s) => s.kind === "agent.step");
    const llm = spans.find((s) => s.kind === "llm.call");
    const tool = spans.find((s) => s.kind === "tool.invoke");
    if (!step?.timing || !llm?.timing || !tool?.timing) throw new Error("timing 应存在");

    const stepStart = Date.parse(step.timing.started_at);
    const stepEnd = Date.parse(step.timing.ended_at);
    expect(Date.parse(llm.timing.started_at)).toBeGreaterThanOrEqual(stepStart);
    expect(Date.parse(llm.timing.ended_at)).toBeLessThanOrEqual(stepEnd);
    expect(Date.parse(tool.timing.started_at)).toBeGreaterThanOrEqual(stepStart);
    expect(Date.parse(tool.timing.ended_at)).toBeLessThanOrEqual(stepEnd);
  });

  it("耗时计算正确：区间长度等于两端时刻之差", () => {
    const record = parseRunText([
      JSON.stringify({ type: "run.meta", ...sampleMeta() }),
      JSON.stringify({
        type: "span",
        id: "s_manual",
        kind: "tool.invoke",
        parent: null,
        tool: "sleep",
        args: {},
        result: null,
        dur_ms: 1500,
        error: null,
        timing: { started_at: "2026-01-15T10:00:00.000Z", ended_at: "2026-01-15T10:00:01.500Z" },
      }),
    ]);
    expect(spanDurationMs(record.spans[0] as SpanLine)).toBe(1500);
  });

  it("子 span 的耗时不超过父 span 的耗时", () => {
    const tracer = new NullTracer();
    const spans: SpanLine[] = [];
    tracer.subscribe((e) => {
      if (e.type === "span.end") spans.push(e.span);
    });
    recordDemoRun(tracer);

    const step = spans.find((s) => s.kind === "agent.step");
    const llm = spans.find((s) => s.kind === "llm.call");
    if (!step || !llm) throw new Error("DemoRun 应含 step 与 llm.call");
    const stepMs = spanDurationMs(step);
    const llmMs = spanDurationMs(llm);
    expect(stepMs).not.toBeNull();
    expect(llmMs).not.toBeNull();
    if (stepMs === null || llmMs === null) throw new Error("unreachable");
    expect(llmMs).toBeLessThanOrEqual(stepMs);
    expect(stepMs).toBeGreaterThanOrEqual(0);
  });
});

describe("读取器：老文件与 fixtures", () => {
  it("无 timing 的老文件照常读取，不报错", () => {
    const record = parseRunText(LEGACY_RUN);
    expect(record.spans).toHaveLength(1);
    expect(record.spans[0]?.timing).toBeUndefined();
    expect(spanDurationMs(record.spans[0] as SpanLine)).toBeNull();
    expect(record.status).toBe("completed");
  });
});
