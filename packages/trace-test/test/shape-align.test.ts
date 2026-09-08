import type { LlmCallSpan, RunEventLine, ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { alignShape } from "../src/shape-align.js";
import { recordOfSpans, stepSpan } from "./helpers.js";

const completed: RunEventLine = { type: "run.event", event: "stopped", reason: "completed", at: 2 };

function llmSpan(id: string, parent: string, names: string[]): LlmCallSpan {
  return {
    type: "span",
    id,
    kind: "llm.call",
    parent,
    request: { model: "deepseek-chat", messages: [{ role: "user", content: "t" }] },
    response: {
      content: "正文",
      reasoning_content: null,
      tool_calls: names.map((name, i) => ({
        id: `c_${i}`,
        type: "function",
        function: { name, arguments: "{}" },
      })),
      usage: { in: 1, out: 1 },
      ttft_ms: 1,
    },
  };
}

function toolSpan(
  id: string,
  parent: string,
  tool: string,
  args: Record<string, unknown>,
): ToolInvokeSpan {
  return {
    type: "span",
    id,
    kind: "tool.invoke",
    parent,
    tool,
    args,
    result: "r",
    dur_ms: 1,
    error: null,
  };
}

/** 两轮基线：step1(llm[read_file], tool read_file) → step2(llm[]) */
function baseline() {
  return recordOfSpans(
    [
      stepSpan("s_01", 1),
      llmSpan("s_02", "s_01", ["read_file"]),
      toolSpan("s_03", "s_01", "read_file", { path: "a.json" }),
      stepSpan("s_04", 2),
      llmSpan("s_05", "s_04", []),
    ],
    completed,
  );
}

describe("alignShape", () => {
  it("结构一致（含忽略项差异：timing/文本/usage/ttft）→ aligned", () => {
    const current = baseline();
    // 自由文本、timing、usage、ttft、dur_ms 全部不同，不影响对齐
    (current.spans[1] as LlmCallSpan).response.content = "完全不同的正文";
    (current.spans[2] as ToolInvokeSpan).args = { path: "换了值" };
    (current.spans[2] as ToolInvokeSpan).dur_ms = 999;
    const aligned = alignShape(baseline(), current);
    expect(aligned.aligned).toBe(true);
    expect(aligned.mismatch).toBeNull();
    expect(aligned.comparedSpanCount).toBe(5);
  });

  it("kind 改变 → 在首个差异位失败", () => {
    const current = baseline();
    (current.spans[3] as { kind: string }).kind = "llm.call"; // 第二个 step 变成了 llm.call
    const result = alignShape(baseline(), current);
    expect(result.aligned).toBe(false);
    expect(result.mismatch?.index).toBe(3);
    expect(result.mismatch?.field).toBe("kind");
  });

  it("span 数量不同 → count 差异定位在较短一方末尾", () => {
    const current = baseline();
    current.spans = current.spans.slice(0, 4); // 少了最后的 llm
    const result = alignShape(baseline(), current);
    expect(result.aligned).toBe(false);
    expect(result.mismatch?.field).toBe("count");
    expect(result.mismatch?.index).toBe(4);
    expect(result.mismatch?.detail).toContain("少产生 1 个");
  });

  it("工具名改变 → 失败并定位", () => {
    const current = baseline();
    (current.spans[2] as ToolInvokeSpan).tool = "write_file";
    const result = alignShape(baseline(), current);
    expect(result.aligned).toBe(false);
    expect(result.mismatch?.field).toBe("tool");
    expect(result.mismatch?.index).toBe(2);
  });

  it("args 形状改变（key 集合不同）→ 失败；值改变不失败", () => {
    const valueOnly = baseline();
    (valueOnly.spans[2] as ToolInvokeSpan).args = { path: "别的路径" };
    expect(alignShape(baseline(), valueOnly).aligned).toBe(true);

    const shape = baseline();
    (shape.spans[2] as ToolInvokeSpan).args = { path: "a.json", flag: true };
    const result = alignShape(baseline(), shape);
    expect(result.aligned).toBe(false);
    expect(result.mismatch?.field).toBe("args");
  });

  it("llm tool-call 结构改变（函数名不同）→ 失败", () => {
    const current = baseline();
    (current.spans[1] as LlmCallSpan).response.tool_calls[0] = {
      id: "c_0",
      type: "function",
      function: { name: "write_file", arguments: "{}" },
    };
    const result = alignShape(baseline(), current);
    expect(result.aligned).toBe(false);
    expect(result.mismatch?.field).toBe("tool_calls");
    expect(result.mismatch?.index).toBe(1);
  });

  it("父子关系改变（重挂到别的 step）→ 失败", () => {
    const current = baseline();
    (current.spans[2] as ToolInvokeSpan).parent = "s_04"; // tool 挂到了第二个 step
    const result = alignShape(baseline(), current);
    expect(result.aligned).toBe(false);
    expect(result.mismatch?.field).toBe("parent");
    expect(result.mismatch?.index).toBe(2);
  });

  it("终止 reason 改变 → outcome 失败（index=-1 表示 run 级）", () => {
    const current = baseline();
    current.events = [{ type: "run.event", event: "stopped", reason: "max_iterations", at: 2 }];
    const result = alignShape(baseline(), current);
    expect(result.aligned).toBe(false);
    expect(result.mismatch?.field).toBe("outcome");
    expect(result.mismatch?.index).toBe(-1);
  });
});
