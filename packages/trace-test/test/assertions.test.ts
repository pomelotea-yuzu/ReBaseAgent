import type { LlmCallSpan, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { evaluateAssertions, matchSpans } from "../src/assertions.js";
import { recordOfSpans, stepSpan } from "./helpers.js";

function toolSpan(id: string, tool: string, args: Record<string, unknown>): ToolInvokeSpan {
  return {
    type: "span",
    id,
    kind: "tool.invoke",
    parent: "s_01",
    tool,
    args,
    result: "r",
    dur_ms: 1,
    error: null,
  };
}

function llmSpan(id: string, usageIn: number): LlmCallSpan {
  return {
    type: "span",
    id,
    kind: "llm.call",
    parent: "s_01",
    request: { model: "deepseek-chat", messages: [] },
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: usageIn, out: 0 },
      ttft_ms: 0,
    },
  };
}

/** 基线：step1 → llm1, tool read_file, tool write_file */
const spans = [
  stepSpan("s_01", 1),
  llmSpan("s_02", 10),
  toolSpan("s_03", "read_file", { path: "a.json" }),
  toolSpan("s_04", "write_file", { path: "b.json", extra: 1 }),
];

describe("matchSpans", () => {
  it("各条件 AND 叠加", () => {
    expect(matchSpans(spans, { kind: "tool.invoke" })).toHaveLength(2);
    expect(matchSpans(spans, { kind: "tool.invoke", tool: "read_file" })).toHaveLength(1);
    expect(matchSpans(spans, { n: 1 })).toHaveLength(1);
    expect(matchSpans(spans, { id: "s_02" })).toHaveLength(1);
    expect(matchSpans(spans, { kind: "tool.invoke", tool: "read_file", n: 1 })).toHaveLength(0);
  });
});

describe("evaluateAssertions", () => {
  it("run.outcome：对齐 reason 五枚举", () => {
    const results = evaluateAssertions(
      [{ type: "run.outcome", equals: "completed" }],
      spans,
      "completed",
    );
    expect(results[0].passed).toBe(true);
    const failed = evaluateAssertions(
      [{ type: "run.outcome", equals: "error" }],
      spans,
      "completed",
    );
    expect(failed[0].passed).toBe(false);
    expect(failed[0].detail).toContain("completed");
  });

  it("span.exists：零匹配即失败；≥1 命中即通过（量词恒 any）", () => {
    const pass = evaluateAssertions(
      [{ type: "span.exists", selector: { kind: "tool.invoke", tool: "read_file" } }],
      spans,
      undefined,
    );
    const fail = evaluateAssertions(
      [{ type: "span.exists", selector: { kind: "tool.invoke", tool: "nope" } }],
      spans,
      undefined,
    );
    expect(pass[0].passed).toBe(true);
    expect(fail[0].passed).toBe(false);
    expect(fail[0].detail).toContain("缺失匹配即失败");
  });

  it("span.field 默认 all：零匹配失败；任一匹配不等即失败并定位", () => {
    const zero = evaluateAssertions(
      [{ type: "span.field", selector: { tool: "nope" }, field: "tool", equals: "read_file" }],
      spans,
      undefined,
    );
    expect(zero[0].passed).toBe(false);
    expect(zero[0].detail).toContain("无匹配 span");

    const mismatch = evaluateAssertions(
      [
        {
          type: "span.field",
          selector: { kind: "tool.invoke" },
          field: "tool",
          equals: "read_file",
        },
      ],
      spans,
      undefined,
    );
    expect(mismatch[0].passed).toBe(false);
    expect(mismatch[0].detail).toContain("write_file");
  });

  it("span.field 点路径与结构化比较（嵌套字段、对象值）", () => {
    const nested = evaluateAssertions(
      [
        {
          type: "span.field",
          selector: { kind: "llm.call" },
          field: "response.usage.in",
          equals: 10,
        },
      ],
      spans,
      undefined,
    );
    expect(nested[0].passed).toBe(true);

    const obj = evaluateAssertions(
      [
        {
          type: "span.field",
          selector: { tool: "read_file" },
          field: "args",
          equals: { path: "a.json" },
        },
      ],
      spans,
      undefined,
    );
    expect(obj[0].passed).toBe(true);

    const missing = evaluateAssertions(
      [
        {
          type: "span.field",
          selector: { tool: "read_file" },
          field: "args.nothing.here",
          equals: 1,
        },
      ],
      spans,
      undefined,
    );
    expect(missing[0].passed).toBe(false);
    expect(missing[0].detail).toContain("不存在字段");
  });

  it("span.field quantifier=first 取首个匹配；nth 用独立 nth 字段（第 n 个匹配，1 起）", () => {
    const args = [
      {
        type: "span.field",
        selector: { kind: "tool.invoke" },
        field: "tool",
        equals: "read_file",
        quantifier: "first",
      },
      {
        type: "span.field",
        selector: { kind: "tool.invoke" },
        field: "tool",
        equals: "write_file",
        quantifier: "nth",
        nth: 2,
      },
      {
        type: "span.field",
        selector: { kind: "tool.invoke" },
        field: "tool",
        equals: "x",
        quantifier: "nth",
        nth: 5,
      },
    ] as const;
    const results = evaluateAssertions([...args], spans, undefined);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
    expect(results[2].passed).toBe(false);
    expect(results[2].detail).toContain("越界");
  });

  it("span.count：equals/min/max 阈值", () => {
    const cases = [
      { type: "span.count", selector: { kind: "tool.invoke" }, equals: 2 },
      { type: "span.count", selector: { kind: "tool.invoke" }, min: 3 },
      { type: "span.count", selector: { kind: "tool.invoke" }, max: 5 },
    ] as const;
    const results = evaluateAssertions([...cases], spans, undefined);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].detail).toContain("至少 3");
    expect(results[2].passed).toBe(true);
  });

  it("脱敏：字段末段命中 redact 列表 → 值以 *** 代替", () => {
    const results = evaluateAssertions(
      [
        {
          type: "span.field",
          selector: { tool: "read_file" },
          field: "args.path",
          equals: "其他值",
        },
      ],
      spans,
      undefined,
      ["path"],
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].detail).toContain("***");
    expect(results[0].detail).not.toContain("a.json");
  });
});

describe("recordOfSpans（helpers）", () => {
  it("event=null → crashed；否则 completed", () => {
    expect(recordOfSpans(spans, null).status).toBe("crashed");
    expect(
      recordOfSpans(spans, { type: "run.event", event: "stopped", reason: "completed", at: 1 })
        .status,
    ).toBe("completed");
  });
});
