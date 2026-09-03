import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunMetaInput, RunRecord } from "../src/index";
import type { Tracer } from "../src/index";

/** 临时目录（测试完自动清理） */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "trace-sdk-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 合法的 run.meta 输入样例（可覆盖字段） */
export function sampleMeta(over: Partial<RunMetaInput> = {}): RunMetaInput {
  return {
    id: "r_test",
    format_version: 1,
    task: "测试任务",
    model: "deepseek-chat",
    created_at: "2026-01-15T00:00:00.000Z",
    parent: null,
    fork: null,
    config_hash: "sha256:test",
    ...over,
  };
}

export function sampleRequest() {
  return {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "你是文件助手。" },
      { role: "user", content: "读取 README.md" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "读取文件",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
    params: { temperature: 0.7 },
  };
}

export function sampleResponse(over: Record<string, unknown> = {}) {
  return {
    content: "我先读取文件。",
    reasoning_content: null,
    tool_calls: [
      {
        id: "call_001",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      },
    ],
    usage: { in: 1830, out: 210 },
    ttft_ms: 850,
    ...over,
  };
}

/** 用一个最小但完整的 run 流程驱动 tracer（1 步：llm.call + tool.invoke） */
export function recordDemoRun(tracer: Tracer): void {
  tracer.startRun(sampleMeta());
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm = tracer.startSpan({ kind: "llm.call", parent: step, request: sampleRequest() });
  tracer.endSpan(llm, { response: sampleResponse() });
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "read_file",
    args: { path: "README.md" },
  });
  tracer.endSpan(tool, { result: "# 内容", dur_ms: 12, error: null });
  tracer.endSpan(step);
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
}

/** 用 tracer 快速生成一个 RunRecord（内存场景，不经文件） */
export function buildRecord(meta: RunMetaInput, options: { crashed?: boolean } = {}): RunRecord {
  const events: RunRecord["events"] = options.crashed
    ? []
    : [{ type: "run.event", event: "stopped", reason: "completed", at: 1 }];
  return {
    meta: { type: "run.meta", ...meta },
    spans: [],
    events,
    status: options.crashed ? "crashed" : "completed",
  };
}
