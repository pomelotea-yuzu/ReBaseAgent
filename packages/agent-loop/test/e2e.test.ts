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

/**
 * 端到端：完整多轮对话（含工具调用、工具失败、终止各路径），全部经 mock LLM，零网络请求。
 * 覆盖 spec 的"零 API 测试"Scenario。
 */
describe("端到端 mock 流程", () => {
  it("多轮：读文件失败 → 换路径重读 → 写文件 → 完成", async () => {
    const { dir, cleanup } = mkdtempWithCleanup();
    try {
      const tracer = new JsonlTracer(join(dir, "e2e.jsonl"));
      const script: ScriptedTurn[] = [
        // 第 1 轮：读 missing.json（失败）
        { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"missing.json"}' }] },
        // 第 2 轮：换 README.md（成功）
        { toolCalls: [{ id: "c2", name: "read_file", args: '{"path":"README.md"}' }] },
        // 第 3 轮：写摘要
        { toolCalls: [{ id: "c3", name: "write_file", args: '{"path":"summary.md"}' }] },
        // 第 4 轮：收尾
        { content: "任务完成" },
      ];
      const result = await runLoop(
        sampleConfig(),
        initialMessages("读取并写摘要"),
        tracer,
        sampleTools(),
        new MockLlmClient(script),
      );

      // 终止
      expect(result.event).toMatchObject({ event: "stopped", reason: "completed", at: 4 });

      // 消息演化：system + user + 3×(assistant+tool) + 收尾 assistant = 9
      expect(result.messages).toHaveLength(9);
      // 失败的 tool 消息带 error 渲染，后续照常
      expect(result.messages[3]?.content).toContain("工具执行失败");
      expect(result.messages[3]?.content).toContain("ENOENT");
      expect(result.messages[5]?.content).toBe("内容(README.md)");
      expect(result.messages[8]?.content).toBe("任务完成");

      // trace 产物合法
      const record = readRun(join(dir, "e2e.jsonl"));
      expect(record.status).toBe("completed");
      expect(record.meta.config_hash).toMatch(/^sha256:/);
      const toolSpans = record.spans.filter((s) => s.kind === "tool.invoke");
      expect(toolSpans).toHaveLength(3);
      const failedSpans = toolSpans.filter((s) => s.kind === "tool.invoke" && s.error !== null);
      expect(failedSpans).toHaveLength(1); // 错误是数据不是异常
      expect(record.events[0]).toMatchObject({ event: "stopped", reason: "completed", at: 4 });
    } finally {
      cleanup();
    }
  });

  it("NullTracer 零文件运行 + 事件流完整断言", async () => {
    const events: TraceStreamEvent[] = [];
    const tracer = new NullTracer();
    const unsubscribe = tracer.subscribe((e) => events.push(e));
    const result = await runLoop(
      sampleConfig(),
      initialMessages("任务"),
      tracer,
      sampleTools(),
      new MockLlmClient([
        { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
        { content: "完成" },
      ]),
    );
    unsubscribe();
    expect(result.event.reason).toBe("completed");
    expect(events[0]?.type).toBe("run.meta");
    expect(events[events.length - 1]?.type).toBe("run.event");
    // 两个 agent.step
    const stepEnds = events.filter((e) => e.type === "span.end");
    expect(
      stepEnds.filter((e) => e.type === "span.end" && e.span.kind === "agent.step"),
    ).toHaveLength(2);
  });
});

function mkdtempWithCleanup(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-e2e-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
