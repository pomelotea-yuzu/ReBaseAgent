import type { ToolInvokeSpan } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { TraceTestConfigError } from "../src/errors.js";
import { StubToolTable } from "../src/stub-tools.js";
import { fakeTools, recordOfSpans, stepSpan } from "./helpers.js";

function toolSpan(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  error: string | null = null,
): ToolInvokeSpan {
  return {
    type: "span",
    id,
    kind: "tool.invoke",
    parent: "s_01",
    tool,
    args,
    result,
    dur_ms: 1,
    error,
  };
}

describe("StubToolTable", () => {
  it("按 (tool 名, 调用序号) 取录制结果：同名工具多次调用依次取", async () => {
    const record = recordOfSpans(
      [
        stepSpan("s_01", 1),
        toolSpan("s_02", "read_file", { path: "a.json" }, "第一次(a.json)"),
        toolSpan("s_03", "read_file", { path: "b.json" }, "第二次(b.json)"),
      ],
      { type: "run.event", event: "stopped", reason: "completed", at: 1 },
    );
    const stubs = new StubToolTable(fakeTools(), record);
    const read = stubs.tools.find((t) => t.name === "read_file");
    expect(read).toBeDefined();

    const first = await read?.handler({ path: "x.json" }, { cwd: ".", signal: null });
    const second = await read?.handler({ path: "y.json" }, { cwd: ".", signal: null });
    expect(first).toBe("第一次(a.json)");
    expect(second).toBe("第二次(b.json)");
    expect(stubs.overflows).toHaveLength(0);
  });

  it("录制 error 非 null → handler 抛出错误文本（错误即数据）", async () => {
    const record = recordOfSpans(
      [
        stepSpan("s_01", 1),
        toolSpan(
          "s_02",
          "read_file",
          { path: "missing.json" },
          "",
          "ENOENT: no such file or directory",
        ),
      ],
      { type: "run.event", event: "stopped", reason: "completed", at: 1 },
    );
    const stubs = new StubToolTable(fakeTools(), record);
    const read = stubs.tools.find((t) => t.name === "read_file");
    await expect(read?.handler({ path: "whatever" }, { cwd: ".", signal: null })).rejects.toThrow(
      "ENOENT: no such file or directory",
    );
  });

  it("录制中出现的工具不在当前工具声明中 → 构造期配置错误", () => {
    const record = recordOfSpans([stepSpan("s_01", 1), toolSpan("s_02", "delete_db", {}, "ok")], {
      type: "run.event",
      event: "stopped",
      reason: "completed",
      at: 1,
    });
    expect(() => new StubToolTable(fakeTools(), record)).toThrow(TraceTestConfigError);
    expect(() => new StubToolTable(fakeTools(), record)).toThrow("delete_db");
  });

  it("调用次数超出录制 → 记入 overflows 并抛错", async () => {
    const record = recordOfSpans(
      [stepSpan("s_01", 1), toolSpan("s_02", "read_file", { path: "a.json" }, "唯一一次")],
      { type: "run.event", event: "stopped", reason: "completed", at: 1 },
    );
    const stubs = new StubToolTable(fakeTools(), record);
    const read = stubs.tools.find((t) => t.name === "read_file");
    await read?.handler({ path: "a.json" }, { cwd: ".", signal: null });
    await expect(read?.handler({ path: "a.json" }, { cwd: ".", signal: null })).rejects.toThrow(
      "桩工具卡带耗尽",
    );
    expect(stubs.overflows).toEqual(["read_file"]);
  });

  it("args 值不同（形状相同）→ 无 drift；形状不同 → 记 argsDrift", async () => {
    const record = recordOfSpans(
      [
        stepSpan("s_01", 1),
        toolSpan("s_02", "read_file", { path: "a.json" }, "r1"),
        toolSpan("s_03", "write_file", { path: "b.json", extra: { nested: 1 } }, "r2"),
      ],
      { type: "run.event", event: "stopped", reason: "completed", at: 1 },
    );
    const stubs = new StubToolTable(fakeTools(), record);
    const read = stubs.tools.find((t) => t.name === "read_file");
    const write = stubs.tools.find((t) => t.name === "write_file");

    // 值级差异：形状相同，不算 drift
    await read?.handler({ path: "完全不同的路径" }, { cwd: ".", signal: null });
    expect(stubs.argsDrift).toHaveLength(0);

    // 形状差异：多了 key
    await write?.handler({ path: "b.json" }, { cwd: ".", signal: null });
    expect(stubs.argsDrift).toHaveLength(1);
    expect(stubs.argsDrift[0].tool).toBe("write_file");
    expect(stubs.argsDrift[0].sequence).toBe(1);
    expect(stubs.argsDrift[0].detail).toContain("extra");
  });

  it("录制 result 非字符串时以 JSON 序列化返回（容错代理/手工 trace）", async () => {
    const record = recordOfSpans(
      [stepSpan("s_01", 1), toolSpan("s_02", "read_file", { path: "a.json" }, { lines: 3 })],
      { type: "run.event", event: "stopped", reason: "completed", at: 1 },
    );
    const stubs = new StubToolTable(fakeTools(), record);
    const read = stubs.tools.find((t) => t.name === "read_file");
    const out = await read?.handler({ path: "a.json" }, { cwd: ".", signal: null });
    expect(out).toBe('{"lines":3}');
  });
});
