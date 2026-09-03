import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TraceReadError, parseRunText, readRun } from "../src/index";
import { sampleMeta, sampleRequest, sampleResponse, tempDir } from "./helpers";

function metaLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "run.meta", ...sampleMeta(), ...over });
}

function stepLine(id: string, n: number): string {
  return JSON.stringify({ type: "span", id, kind: "agent.step", parent: null, n });
}

function eventLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "run.event", event: "stopped", reason: "completed", ...over });
}

describe("readRun / parseRunText：合法文件", () => {
  it("解析 meta / spans / events，状态 completed", () => {
    const record = parseRunText([
      metaLine(),
      stepLine("s_01", 1),
      JSON.stringify({
        type: "span",
        id: "s_02",
        kind: "llm.call",
        parent: "s_01",
        request: sampleRequest(),
        response: sampleResponse(),
      }),
      eventLine(),
    ]);
    expect(record.meta.id).toBe("r_test");
    expect(record.spans).toHaveLength(2);
    expect(record.events).toHaveLength(1);
    expect(record.status).toBe("completed");
  });

  it("容忍尾部空行", () => {
    const record = parseRunText([metaLine(), stepLine("s_01", 1), eventLine(), ""]);
    expect(record.status).toBe("completed");
  });

  it("readRun 直接读文件", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, "r.jsonl");
      writeFileSync(file, `${[metaLine(), stepLine("s_01", 1), eventLine()].join("\n")}\n`);
      const record = readRun(file);
      expect(record.spans[0]?.id).toBe("s_01");
    } finally {
      cleanup();
    }
  });
});

describe("readRun：崩溃与状态识别", () => {
  it("缺失终止事件 → 状态 crashed（而非报错）", () => {
    const record = parseRunText([metaLine(), stepLine("s_01", 1)]);
    expect(record.status).toBe("crashed");
    expect(record.events).toHaveLength(0);
  });
});

describe("readRun：格式错误", () => {
  it("未来版本：明确报「不支持的格式版本」，不产生部分结果", () => {
    expect(() => parseRunText([metaLine({ format_version: 2 })])).toThrow(/不支持的格式版本 2/);
  });

  it("某行缺 type → 报错指明行号与原因", () => {
    try {
      parseRunText([metaLine(), JSON.stringify({ id: "s_01", kind: "agent.step" })]);
      expect.unreachable("应当抛错");
    } catch (e) {
      expect(e).toBeInstanceOf(TraceReadError);
      const err = e as TraceReadError;
      expect(err.line).toBe(2);
      expect(err.message).toMatch(/第 2 行：.*type 为必填/);
    }
  });

  it("非法 JSON 行 → 第 N 行：JSON 解析失败", () => {
    expect(() => parseRunText([metaLine(), "{broken"])).toThrow(/第 2 行：JSON 解析失败/);
  });

  it("首行不是 run.meta → 报错", () => {
    expect(() => parseRunText([stepLine("s_01", 1)])).toThrow(/首行必须是 run\.meta/);
  });

  it("中途出现第二行 run.meta → 报错", () => {
    expect(() => parseRunText([metaLine(), metaLine()])).toThrow(/run\.meta 只能是首行/);
  });

  it("空文件 → 报错", () => {
    expect(() => parseRunText([])).toThrow(/缺少 run\.meta/);
  });

  it("span 字段类型错误 → 报错含行号", () => {
    const bad = JSON.stringify({
      type: "span",
      id: "s_01",
      kind: "agent.step",
      parent: null,
      n: "一",
    });
    try {
      parseRunText([metaLine(), bad]);
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as TraceReadError).line).toBe(2);
    }
  });
});
