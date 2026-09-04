import { describe, expect, it } from "vitest";
import {
  AgentStepSpanSchema,
  LlmCallSpanSchema,
  RunEventSchema,
  RunMetaSchema,
  ToolInvokeSpanSchema,
  TraceLineSchema,
} from "../src/schema";
import { sampleRequest, sampleResponse } from "./helpers";

describe("schema：合法样例通过", () => {
  it("run.meta（根 run）", () => {
    const line = RunMetaSchema.parse({
      type: "run.meta",
      id: "r_01",
      format_version: 1,
      task: "测试",
      model: "deepseek-chat",
      created_at: "2026-01-15T00:00:00Z",
      parent: null,
      fork: null,
      config_hash: "sha256:abc",
    });
    expect(line.id).toBe("r_01");
  });

  it("run.meta（分支 run，含 fork）", () => {
    const line = RunMetaSchema.parse({
      type: "run.meta",
      id: "r_02",
      format_version: 1,
      task: "测试",
      model: "deepseek-chat",
      created_at: "2026-01-15T00:00:00Z",
      parent: "r_01",
      fork: { at_span: "s_04", edit: { field: "result", value: "新结果" } },
      config_hash: "sha256:abc",
    });
    expect(line.fork?.at_span).toBe("s_04");
  });

  it("run.meta（声明预算上限时含 budget，其余字段不变）", () => {
    const line = RunMetaSchema.parse({
      type: "run.meta",
      id: "r_03",
      format_version: 1,
      task: "测试",
      model: "deepseek-chat",
      created_at: "2026-01-15T00:00:00Z",
      parent: null,
      fork: null,
      budget: { max_total_tokens: 60000 },
      config_hash: "sha256:abc",
    });
    expect(line.budget?.max_total_tokens).toBe(60000);
    expect(line.format_version).toBe(1);
  });

  it("agent.step", () => {
    const span = AgentStepSpanSchema.parse({
      type: "span",
      id: "s_01",
      kind: "agent.step",
      parent: null,
      n: 1,
    });
    expect(span.n).toBe(1);
  });

  it("llm.call（非推理模型，reasoning_content 为 null）", () => {
    const span = LlmCallSpanSchema.parse({
      type: "span",
      id: "s_02",
      kind: "llm.call",
      parent: "s_01",
      request: sampleRequest(),
      response: sampleResponse(),
    });
    expect(span.response.reasoning_content).toBeNull();
  });

  it("llm.call（推理模型，reasoning_content 完整保存；request.messages 原样保留额外字段）", () => {
    const span = LlmCallSpanSchema.parse({
      type: "span",
      id: "s_02",
      kind: "llm.call",
      parent: "s_01",
      request: {
        ...sampleRequest(),
        messages: [{ role: "user", content: "hi", extra_field: "原样保留" }],
      },
      response: sampleResponse({ reasoning_content: "思维链内容" }),
    });
    expect(span.response.reasoning_content).toBe("思维链内容");
    expect(span.request.messages[0]).toHaveProperty("extra_field", "原样保留");
  });

  it("llm.call（省略 tool_calls 时默认为空数组）", () => {
    const span = LlmCallSpanSchema.parse({
      type: "span",
      id: "s_02",
      kind: "llm.call",
      parent: "s_01",
      request: sampleRequest(),
      response: sampleResponse({ tool_calls: undefined }),
    });
    expect(span.response.tool_calls).toEqual([]);
  });

  it("tool.invoke（成功与失败：error 是数据不是异常）", () => {
    const ok = ToolInvokeSpanSchema.parse({
      type: "span",
      id: "s_03",
      kind: "tool.invoke",
      parent: "s_01",
      tool: "read_file",
      args: { path: "README.md" },
      result: "# 内容",
      dur_ms: 12,
      error: null,
    });
    expect(ok.error).toBeNull();

    const fail = ToolInvokeSpanSchema.parse({
      type: "span",
      id: "s_03",
      kind: "tool.invoke",
      parent: "s_01",
      tool: "read_file",
      args: { path: "missing.json" },
      result: null,
      dur_ms: 2,
      error: "ENOENT: no such file or directory",
    });
    expect(fail.error).toBe("ENOENT: no such file or directory");
  });

  it("run.event（全部 reason 枚举均合法）", () => {
    for (const reason of [
      "completed",
      "max_iterations",
      "budget_exceeded",
      "aborted",
      "error",
    ] as const) {
      const line = RunEventSchema.parse({
        type: "run.event",
        event: "stopped",
        reason,
        at: 25,
      });
      expect(line.reason).toBe(reason);
    }
  });
});

describe("schema：缺字段/错类型被拒绝", () => {
  it("缺 type 字段", () => {
    expect(() => TraceLineSchema.parse({ id: "s_01" })).toThrow();
  });

  it("非法 span kind", () => {
    expect(() =>
      TraceLineSchema.parse({ type: "span", id: "s_01", kind: "db.query", parent: null }),
    ).toThrow();
  });

  it("format_version 为 2（未来版本）", () => {
    expect(() =>
      RunMetaSchema.parse({
        type: "run.meta",
        id: "r_01",
        format_version: 2,
        task: "t",
        model: "m",
        created_at: "2026-01-15T00:00:00Z",
        parent: null,
        fork: null,
        config_hash: "sha256:abc",
      }),
    ).toThrow();
  });

  it("tool.invoke 缺 error 字段", () => {
    expect(() =>
      ToolInvokeSpanSchema.parse({
        type: "span",
        id: "s_03",
        kind: "tool.invoke",
        parent: "s_01",
        tool: "read_file",
        args: {},
        result: null,
        dur_ms: 1,
      }),
    ).toThrow();
  });

  it("usage 为负数", () => {
    expect(() =>
      LlmCallSpanSchema.parse({
        type: "span",
        id: "s_02",
        kind: "llm.call",
        parent: null,
        request: sampleRequest(),
        response: sampleResponse({ usage: { in: -1, out: 0 } }),
      }),
    ).toThrow();
  });

  it("fork 缺 at_span", () => {
    expect(() =>
      RunMetaSchema.parse({
        type: "run.meta",
        id: "r_02",
        format_version: 1,
        task: "t",
        model: "m",
        created_at: "2026-01-15T00:00:00Z",
        parent: "r_01",
        fork: { edit: { field: "result", value: "x" } },
        config_hash: "sha256:abc",
      }),
    ).toThrow();
  });

  it("budget.max_total_tokens 为 0（需 positive）", () => {
    expect(() =>
      RunMetaSchema.parse({
        type: "run.meta",
        id: "r_03",
        format_version: 1,
        task: "t",
        model: "m",
        created_at: "2026-01-15T00:00:00Z",
        parent: null,
        fork: null,
        budget: { max_total_tokens: 0 },
        config_hash: "sha256:abc",
      }),
    ).toThrow();
  });
});
