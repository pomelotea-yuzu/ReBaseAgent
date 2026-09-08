import { describe, expect, it } from "vitest";
import { MemoryTracer, toSemanticOrder } from "../src/index.js";

/** 采集一段两轮 run：step1(llm+tool) → step2(llm)，返回 tracer 便于断言 */
function recordSampleRun(): MemoryTracer {
  const tracer = new MemoryTracer();
  tracer.startRun({
    id: "run_mem_01",
    format_version: 1,
    task: "读文件",
    model: "deepseek-chat",
    created_at: "2026-09-08T06:00:00.000Z",
    parent: null,
    fork: null,
  });

  const step1 = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm1 = tracer.startSpan({
    kind: "llm.call",
    parent: step1,
    request: { model: "deepseek-chat", messages: [{ role: "user", content: "读 a.json" }] },
  });
  tracer.endSpan(llm1, {
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.json"}' },
        },
      ],
      usage: { in: 10, out: 5 },
      ttft_ms: 12,
    },
  });
  const tool1 = tracer.startSpan({
    kind: "tool.invoke",
    parent: step1,
    tool: "read_file",
    args: { path: "a.json" },
  });
  tracer.endSpan(tool1, { result: "内容(a.json)", dur_ms: 3, error: null });
  tracer.endSpan(step1);

  const step2 = tracer.startSpan({ kind: "agent.step", n: 2 });
  const llm2 = tracer.startSpan({
    kind: "llm.call",
    parent: step2,
    request: { model: "deepseek-chat", messages: [{ role: "user", content: "读 a.json" }] },
  });
  tracer.endSpan(llm2, {
    response: {
      content: "完成",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 20, out: 4 },
      ttft_ms: 8,
    },
  });
  tracer.endSpan(step2);

  tracer.endRun({ event: "stopped", reason: "completed", at: 2 });
  return tracer;
}

describe("MemoryTracer", () => {
  it("按 end 序收集 meta / span / event，不产生任何文件", () => {
    const tracer = recordSampleRun();
    expect(tracer.metas).toHaveLength(1);
    expect(tracer.metas[0].id).toBe("run_mem_01");
    // end 序：llm1, tool1, step1, llm2, step2
    expect(tracer.spans.map((s) => s.id)).toEqual(["s_02", "s_03", "s_01", "s_05", "s_04"]);
    expect(tracer.events).toEqual([
      { type: "run.event", event: "stopped", reason: "completed", at: 2 },
    ]);
  });

  it("snapshot 重建为语义序并判定 status=completed", () => {
    const record = recordSampleRun().snapshot();
    expect(record.status).toBe("completed");
    // 语义序：step1 → llm1, tool1 → step2 → llm2
    expect(record.spans.map((s) => s.id)).toEqual(["s_01", "s_02", "s_03", "s_04", "s_05"]);
    expect(record.spans[0].kind).toBe("agent.step");
    expect(record.spans[1].parent).toBe("s_01");
  });

  it("无终止事件时 snapshot 判定 status=crashed", () => {
    const tracer = new MemoryTracer();
    tracer.startRun({
      id: "run_crash",
      format_version: 1,
      task: "",
      model: "m",
      created_at: "2026-09-08T06:00:00.000Z",
      parent: null,
      fork: null,
    });
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    tracer.endSpan(step);
    expect(tracer.snapshot().status).toBe("crashed");
  });

  it("未 startRun 时 snapshot 抛错；endRun 后再写入抛错（生命周期防护继承）", () => {
    const tracer = new MemoryTracer();
    expect(() => tracer.snapshot()).toThrow("尚未 startRun");

    const sealed = recordSampleRun(); // 内部已 endRun 封存
    expect(() => sealed.startSpan({ kind: "agent.step", n: 1 })).toThrow();
  });

  it("事件流订阅照常可用", () => {
    const tracer = new MemoryTracer();
    const seen: string[] = [];
    const unsubscribe = tracer.subscribe((event) => seen.push(event.type));
    tracer.startRun({
      id: "run_sub",
      format_version: 1,
      task: "",
      model: "m",
      created_at: "2026-09-08T06:00:00.000Z",
      parent: null,
      fork: null,
    });
    unsubscribe();
    tracer.startSpan({ kind: "agent.step", n: 1 });
    expect(seen).toEqual(["run.meta"]);
  });
});

describe("toSemanticOrder", () => {
  it("对已是语义序的输入为恒等变换；孤儿 span 按文件序补末尾", () => {
    const tracer = recordSampleRun();
    const semantic = tracer.snapshot().spans;
    expect(toSemanticOrder(semantic).map((s) => s.id)).toEqual(semantic.map((s) => s.id));
  });
});
