import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRun } from "../src/index";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const all = ["normal.jsonl", "tool-error.jsonl", "infinite-loop.jsonl", "branch.jsonl"];

describe("fixtures：全部通过 readRun 校验", () => {
  for (const name of all) {
    it(`${name} 校验通过且已封存`, () => {
      const record = readRun(fixture(name));
      expect(record.status).toBe("completed");
      expect(record.spans.length).toBeGreaterThan(0);
      expect(record.events.length).toBeGreaterThan(0);
    });
  }
});

describe("normal.jsonl：3 步正常任务", () => {
  it("read_file → llm → write_file 的完整结构", () => {
    const r = readRun(fixture("normal.jsonl"));
    expect(r.meta.id).toBe("r_01");
    expect(r.meta.model).toBe("deepseek-chat");
    expect(r.spans.map((s) => s.kind)).toEqual([
      "agent.step",
      "llm.call",
      "tool.invoke", // read_file
      "agent.step",
      "llm.call",
      "tool.invoke", // write_file
      "agent.step",
      "llm.call",
    ]);
    const tools = r.spans.filter((s) => s.kind === "tool.invoke");
    expect(tools.map((s) => (s.kind === "tool.invoke" ? s.tool : ""))).toEqual([
      "read_file",
      "write_file",
    ]);
    expect(r.events[0]).toMatchObject({ event: "stopped", reason: "completed", at: 3 });
  });
});

describe("tool-error.jsonl：错误是数据不是异常", () => {
  it("第 2 步工具报错但 loop 继续，任务完成", () => {
    const r = readRun(fixture("tool-error.jsonl"));
    expect(r.meta.id).toBe("r_03");
    const failed = r.spans.filter((s) => s.kind === "tool.invoke" && s.error !== null);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("ENOENT");
    // trace 未中断：失败 span 之后仍有步骤，且正常终止
    const failedIdx = r.spans.indexOf(failed[0]);
    expect(r.spans.length - failedIdx - 1).toBeGreaterThan(0);
    expect(r.status).toBe("completed");
    expect(r.events[0]?.reason).toBe("completed");
  });
});

describe("infinite-loop.jsonl：死循环被 max_iterations 停止", () => {
  it("run.event 示范 + 推理模型 reasoning_content 完整保存", () => {
    const r = readRun(fixture("infinite-loop.jsonl"));
    expect(r.meta.id).toBe("r_04");
    expect(r.meta.model).toBe("deepseek-reasoner");
    expect(r.events[0]).toMatchObject({
      event: "stopped",
      reason: "max_iterations",
      at: 3,
    });
    const llmSpans = r.spans.filter((s) => s.kind === "llm.call");
    expect(llmSpans.length).toBeGreaterThan(0);
    for (const s of llmSpans) {
      if (s.kind === "llm.call") {
        expect(s.response.reasoning_content).toBeTruthy();
      }
    }
    // 同一工具被反复调用（循环 bug 标本）
    const tools = r.spans.filter((s) => s.kind === "tool.invoke");
    expect(tools.every((s) => s.kind === "tool.invoke" && s.tool === "read_file")).toBe(true);
  });
});

describe("branch.jsonl：fork 元数据示范", () => {
  it("从 r_01 的 s_03 分叉，只记录新增 span", () => {
    const r = readRun(fixture("branch.jsonl"));
    expect(r.meta.parent).toBe("r_01");
    expect(r.meta.fork).toMatchObject({
      at_span: "s_03",
      edit: { field: "result" },
    });
    // 分支文件只含新增 span（s_09 起）
    expect(r.spans.map((s) => s.id)).toEqual(["s_09", "s_10", "s_11", "s_12", "s_13"]);
    // fork 点在父 run 中存在
    const parent = readRun(fixture("normal.jsonl"));
    expect(parent.spans.some((s) => s.id === "s_03")).toBe(true);
  });
});
