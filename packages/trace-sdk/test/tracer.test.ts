import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlTracer, NullTracer } from "../src/index";
import type { TraceStreamEvent } from "../src/index";
import { readRun } from "../src/index";
import { recordDemoRun, sampleMeta, tempDir } from "./helpers";

describe("事件流", () => {
  it("NullTracer：事件按发生顺序流出，可被订阅断言（无文件运行）", () => {
    const tracer = new NullTracer();
    const events: TraceStreamEvent[] = [];
    const unsubscribe = tracer.subscribe((e) => events.push(e));

    recordDemoRun(tracer);
    unsubscribe();

    expect(events.map((e) => e.type)).toEqual([
      "run.meta",
      "span.start", // agent.step
      "span.start", // llm.call
      "span.end", // llm.call
      "span.start", // tool.invoke
      "span.end", // tool.invoke
      "span.end", // agent.step
      "run.event",
    ]);
    const meta = events[0];
    if (meta.type !== "run.meta") throw new Error("unreachable");
    expect(meta.meta.id).toBe("r_test");
  });

  it("取消订阅后不再接收事件", () => {
    const tracer = new NullTracer();
    const events: TraceStreamEvent[] = [];
    const unsubscribe = tracer.subscribe((e) => events.push(e));
    unsubscribe();
    recordDemoRun(tracer);
    expect(events).toHaveLength(0);
  });
});

describe("JsonlTracer：文件写入", () => {
  it("完整流程写入 JSONL，readRun 读回内容一致", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "r_test.jsonl");
      const tracer = new JsonlTracer(file);
      recordDemoRun(tracer);

      const record = readRun(file);
      expect(record.meta.id).toBe("r_test");
      // 行序 = endSpan 顺序（span 完成时整行写入；agent.step 最后结束）
      expect(record.spans.map((s) => s.kind)).toEqual(["llm.call", "tool.invoke", "agent.step"]);
      expect(record.status).toBe("completed");
      expect(record.events[0]?.reason).toBe("completed");
    } finally {
      cleanup();
    }
  });

  it("endRun 后再写入任何内容都抛错（文件不可变）", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "sealed.jsonl");
      const tracer = new JsonlTracer(file);
      recordDemoRun(tracer);

      expect(() => tracer.startSpan({ kind: "agent.step", n: 99 })).toThrow(/已结束/);
      expect(() => tracer.endSpan("s_01", {})).toThrow(/已结束/);
      expect(() => tracer.endRun({ event: "stopped", reason: "completed" })).toThrow(/已结束/);
      // 文件未被追加：仍只有 5 行（meta + 3 span + event）
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(5);
    } finally {
      cleanup();
    }
  });

  it("对已封存文件新建 Tracer 也被拒绝（任何路径不得修改）", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "sealed.jsonl");
      const tracer = new JsonlTracer(file);
      recordDemoRun(tracer);

      expect(() => new JsonlTracer(file)).toThrow(/已封存/);
    } finally {
      cleanup();
    }
  });

  it("崩溃模拟：未 endRun 即中断，文件只有完整 JSON 行（无半行），读取器判定 crashed", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "crash.jsonl");
      const tracer = new JsonlTracer(file);
      tracer.startRun(sampleMeta());
      const step = tracer.startSpan({ kind: "agent.step", n: 1 });
      const llm = tracer.startSpan({
        kind: "llm.call",
        parent: step,
        request: {
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      tracer.endSpan(llm, {
        response: {
          content: null,
          reasoning_content: null,
          tool_calls: [],
          usage: { in: 10, out: 5 },
          ttft_ms: 100,
        },
      });
      // 模拟进程崩溃：不再调用 endSpan/endRun

      const text = readFileSync(file, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow(); // 每行都是完整 JSON
      }
      expect(readRun(file).status).toBe("crashed");
    } finally {
      cleanup();
    }
  });

  it("endSpan 不存在的 span 抛错", () => {
    const { dir, cleanup } = tempDir();
    try {
      const tracer = new JsonlTracer(join(dir, "x.jsonl"));
      tracer.startRun(sampleMeta());
      expect(() => tracer.endSpan("s_99", {})).toThrow(/不存在或已结束/);
    } finally {
      cleanup();
    }
  });

  it("未 startRun 直接 startSpan 抛错", () => {
    const tracer = new NullTracer();
    expect(() => tracer.startSpan({ kind: "agent.step", n: 1 })).toThrow(/尚未 startRun/);
  });

  it("NullTracer 不产生任何文件", () => {
    const { dir, cleanup } = tempDir();
    try {
      const tracer = new NullTracer();
      recordDemoRun(tracer);
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
