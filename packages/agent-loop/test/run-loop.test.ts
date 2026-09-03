import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer, NullTracer, readRun } from "@rebaseagent/trace-sdk";
import type { TraceStreamEvent } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { runLoop } from "../src/index";
import {
  MockLlmClient,
  type ScriptedTurn,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "./helpers";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tools = sampleTools();

describe("runLoop：纯函数四不变量", () => {
  it("同输入两次运行轨迹一致（确定性）", async () => {
    const script: ScriptedTurn[] = [
      { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
      { content: "完成" },
    ];
    const run = async () => {
      const events: TraceStreamEvent[] = [];
      const tracer = new NullTracer();
      const unsubscribe = tracer.subscribe((e) => events.push(e));
      const result = await runLoop(
        sampleConfig(),
        initialMessages("读 README"),
        tracer,
        tools,
        new MockLlmClient(script),
      );
      unsubscribe();
      return { events: events.map((e) => e.type), result };
    };
    const a = await run();
    const b = await run();
    expect(a.events).toEqual(b.events);
    expect(a.result.messages).toEqual(b.result.messages);
    expect(a.result.event).toEqual(b.result.event);
  });

  it("历史不可变：初始消息对象不被修改，新消息只追加", async () => {
    const initial = initialMessages("读 README");
    const frozen = JSON.stringify(initial);
    const script: ScriptedTurn[] = [
      { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
      { content: "完成" },
    ];
    const result = await runLoop(
      sampleConfig(),
      initial,
      new NullTracer(),
      tools,
      new MockLlmClient(script),
    );
    expect(JSON.stringify(initial)).toBe(frozen); // 入参未被修改
    // system + user + assistant(tool_calls) + tool + assistant = 5
    expect(result.messages.length).toBe(5);
    expect(result.messages.length).toBeGreaterThan(initial.length);
  });
});

describe("runLoop：终止条件", () => {
  it("任务完成 → completed", async () => {
    const result = await runLoop(
      sampleConfig(),
      initialMessages("任务"),
      new NullTracer(),
      tools,
      new MockLlmClient([{ content: "直接回答" }]),
    );
    expect(result.event).toMatchObject({ event: "stopped", reason: "completed", at: 1 });
  });

  it("死循环停止 → max_iterations", async () => {
    // 每轮都调工具，永不收敛
    const loopTurn: ScriptedTurn = {
      toolCalls: [{ id: "c", name: "read_file", args: '{"path":"README.md"}' }],
    };
    const script = Array.from({ length: 20 }, () => loopTurn);
    const result = await runLoop(
      sampleConfig({ maxIterations: 3 }),
      initialMessages("任务"),
      new NullTracer(),
      tools,
      new MockLlmClient(script),
    );
    expect(result.event).toMatchObject({ event: "stopped", reason: "max_iterations", at: 3 });
  });

  it("预算超限 → budget_exceeded（从 usage 派生）", async () => {
    const script: ScriptedTurn[] = [
      {
        toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }],
        usage: { in: 600, out: 100 },
      },
      {
        toolCalls: [{ id: "c2", name: "read_file", args: '{"path":"README.md"}' }],
        usage: { in: 600, out: 100 },
      },
      { content: "完成" },
    ];
    const result = await runLoop(
      sampleConfig({ budget: { maxTotalTokens: 1000 } }),
      initialMessages("任务"),
      new NullTracer(),
      tools,
      new MockLlmClient(script),
    );
    // 两轮后累计 1400 > 1000
    expect(result.event).toMatchObject({ event: "stopped", reason: "budget_exceeded", at: 2 });
  });
});

describe("runLoop：abort 优雅收尾", () => {
  it("轮间中止 → aborted，无半 span", async () => {
    const controller = new AbortController();
    const script: ScriptedTurn[] = [
      { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
      { content: "完成" },
    ];
    const events: TraceStreamEvent[] = [];
    const tracer = new NullTracer();
    tracer.subscribe((e) => events.push(e));
    // 第一轮完成后、第二轮 LLM 调用前 abort（mock 的 complete 里触发）
    const mockLlm = new MockLlmClient(script);
    const result = await runLoop(
      sampleConfig({ exec: { cwd: "D:/tmp", signal: controller.signal } }),
      initialMessages("任务"),
      tracer,
      tools,
      {
        complete: async (messages, signal) => {
          const r = await mockLlm.complete(messages, signal);
          controller.abort(); // 首轮返回后立即中止
          return r;
        },
      },
    );
    expect(result.event).toMatchObject({ event: "aborted", reason: "aborted", at: 1 });
    // 事件流完整：最后是 run.event，无未闭合迹象
    expect(events[events.length - 1]?.type).toBe("run.event");
  });

  it("LLM 请求失败 → errored（reason: error），已完成的轮次保持完整", async () => {
    const result = await runLoop(sampleConfig(), initialMessages("任务"), new NullTracer(), tools, {
      complete: async () => {
        throw new Error("LLM 端点返回 HTTP 401");
      },
    });
    expect(result.event).toMatchObject({ event: "errored", reason: "error", at: 1 });
    // messages 保持初始（失败轮未追加 assistant）
    expect(result.messages).toHaveLength(2);
  });
});

describe("runLoop：Tracer 集成", () => {
  it("NullTracer：无文件运行，事件流可断言", async () => {
    const events: TraceStreamEvent[] = [];
    const tracer = new NullTracer();
    const unsubscribe = tracer.subscribe((e) => events.push(e));
    await runLoop(
      sampleConfig(),
      initialMessages("读 README"),
      tracer,
      tools,
      new MockLlmClient([
        { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
        { content: "完成" },
      ]),
    );
    unsubscribe();
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "run.meta",
      "span.start", // agent.step 1
      "span.start", // llm.call
      "span.end", // llm.call
      "span.start", // tool.invoke
      "span.end", // tool.invoke
      "span.end", // agent.step
      "span.start", // agent.step 2
      "span.start", // llm.call
      "span.end", // llm.call
      "span.end", // agent.step
      "run.event",
    ]);
  });

  it("JsonlTracer：产物过 readRun 校验（含 config_hash 与 sideEffect）", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const tracer = new JsonlTracer(join(dir, "r.jsonl"));
      const result = await runLoop(
        sampleConfig(),
        initialMessages("读 README"),
        tracer,
        tools,
        new MockLlmClient([
          { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
          { content: "完成" },
        ]),
      );
      const record = readRun(join(dir, "r.jsonl"));
      expect(record.status).toBe("completed");
      expect(record.meta.config_hash).toMatch(/^sha256:/);
      expect(record.spans.some((s) => s.kind === "llm.call")).toBe(true);
      const llmCall = record.spans.find((s) => s.kind === "llm.call");
      expect(llmCall && llmCall.kind === "llm.call" ? llmCall.request.tools?.[0]?.name : null).toBe(
        "read_file",
      );
      expect(result.event.reason).toBe("completed");
    } finally {
      cleanup();
    }
  });

  it("工具失败后 loop 继续（错误是数据）", async () => {
    const result = await runLoop(
      sampleConfig(),
      initialMessages("读缺失文件"),
      new NullTracer(),
      tools,
      new MockLlmClient([
        { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"missing.json"}' }] },
        { content: "文件不存在，任务结束" },
      ]),
    );
    // 失败的 tool 消息（error 渲染）追加后，第二轮照常发起并完成
    expect(result.messages[3]?.role).toBe("tool");
    expect(result.messages[3]?.content).toContain("工具执行失败");
    expect(result.messages[3]?.content).toContain("ENOENT");
    expect(result.event.reason).toBe("completed");
  });

  it("config.tools 与 tools 数量不一致 → 抛错（loop 自身 bug）", async () => {
    await expect(
      runLoop(
        sampleConfig({ tools: [] }), // config.tools 为空但传入 2 个含 handler 的工具
        initialMessages("任务"),
        new NullTracer(),
        tools,
        new MockLlmClient([{ content: "完成" }]),
      ),
    ).rejects.toThrow(/不一致/);
  });
});
