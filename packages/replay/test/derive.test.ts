import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRunText } from "@rebaseagent/trace-sdk";
import type { RunRecord, SpanLine } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { deriveReplayState } from "../src/index";

/** 读取 trace-sdk 包内的 fixture（replay 测试只读引用，不复制） */
function fixture(name: string): RunRecord {
  const path = fileURLToPath(new URL(`../../trace-sdk/fixtures/${name}.jsonl`, import.meta.url));
  return parseRunText(readFileSync(path, "utf8").split(/\r?\n/));
}

const normal = fixture("normal"); // r_01：3 步 completed，read_file → write_file
const branch = fixture("branch"); // r_02：fork 自 r_01 的手工合法分支（编辑 s_03 的 result）

/** branch fixture 里 r_02 首个 llm.call（s_10）的录制 messages——派生结果的权威锚点 */
const branchPrefix = (() => {
  const llm = branch.spans.find(
    (s): s is Extract<SpanLine, { kind: "llm.call" }> => s.kind === "llm.call",
  );
  if (llm === undefined) throw new Error("branch fixture 缺 llm.call");
  return llm.request.messages;
})();

/** r_02 的编辑值（读 branch meta.fork.edit.value） */
const EDITED_VALUE = branch.meta.fork?.edit.value as string;

describe("deriveReplayState：编辑 tool_result 得到新前缀", () => {
  it("对 normal 编辑 s_03(read_file result) → 与手工 branch fixture 的录制前缀逐字段一致", () => {
    const state = deriveReplayState({
      records: [normal],
      atSpanId: "s_03",
      edit: { field: "result", value: EDITED_VALUE },
    });
    // 权威锚点：r_02（手工合法 fork）分叉点后首次 llm.call 的 request.messages
    expect(state.messages).toEqual(branchPrefix);
  });

  it("前缀即录制请求：未编辑消息逐条原样保留（零 API 的依据）", () => {
    const state = deriveReplayState({
      records: [normal],
      atSpanId: "s_03",
      edit: { field: "result", value: "读取到的内容（已改变）" },
    });
    expect(state.messages.length).toBe(branchPrefix.length);
    // 首两条 system/user 与录制逐字段一致
    expect(state.messages[0]).toEqual(branchPrefix[0]);
    expect(state.messages[1]).toEqual(branchPrefix[1]);
    // 仅被编辑 tool 消息 content 不同，其余消息与录制一致
    const edited = state.messages.find((m) => m.role === "tool");
    expect(edited?.content).toBe("读取到的内容（已改变）");
    const fork = state.fork;
    expect(fork).toEqual({
      at_span: "s_03",
      edit: { field: "result", value: "读取到的内容（已改变）" },
    });
  });
});

describe("deriveReplayState：可重放性前置校验", () => {
  it("at_span 不存在 → 报错指明无法定位", () => {
    expect(() =>
      deriveReplayState({
        records: [normal],
        atSpanId: "s_999",
        edit: { field: "result", value: "x" },
      }),
    ).toThrow(/不存在于父 run/);
  });

  it("at_span 指向 llm.call → 报错必须是 tool.invoke", () => {
    expect(() =>
      deriveReplayState({
        records: [normal],
        atSpanId: "s_02",
        edit: { field: "result", value: "x" },
      }),
    ).toThrow(/必须是 tool\.invoke/);
  });

  it("field 非 result → 拒绝（MVP 只开放 result）", () => {
    expect(() =>
      deriveReplayState({
        records: [normal],
        atSpanId: "s_03",
        // @ts-expect-error field 类型上不允许非 result，运行时仍要防御
        edit: { field: "args", value: "x" },
      }),
    ).toThrow(/仅支持编辑.*result/);
  });

  it("空 fork（编辑前后相同）→ 拒绝", () => {
    const original = normal.spans.find((s) => s.id === "s_03");
    expect(original?.kind).toBe("tool.invoke");
    const value = original?.kind === "tool.invoke" ? String(original.result) : "";
    expect(() =>
      deriveReplayState({
        records: [normal],
        atSpanId: "s_03",
        edit: { field: "result", value },
      }),
    ).toThrow(/空 fork 被拒绝/);
  });

  it("at_span 所在 step 的 llm.call 缺对应 tool_call（手工残缺）→ 报错", () => {
    // 构造：s_03(read_file) 所在 step s_01 的 llm.call s_02 录制被清空 tool_calls，
    // 模拟手工残缺文件——正常解析后编程篡改，避免字符串手术破坏 JSON
    const broken = structuredClone(normal);
    const s02 = broken.spans.find((s) => s.id === "s_02");
    expect(s02?.kind).toBe("llm.call");
    if (s02?.kind !== "llm.call") return;
    s02.response.tool_calls = [];
    expect(() =>
      deriveReplayState({
        records: [broken],
        atSpanId: "s_03",
        edit: { field: "result", value: "新值" },
      }),
    ).toThrow(/找不到对应 tool_call/);
  });
});

describe("deriveReplayState：无后续 llm.call 的边界（分叉点在最后一步）", () => {
  it("重建该轮 assistant(tool_calls) + tool 消息为起点", () => {
    // 构造：截断 normal 到 s_06（write_file）为止——其后无 llm.call
    const cut = normal.spans.filter((s) => s.id !== "s_07" && s.id !== "s_08");
    const truncated: RunRecord = {
      meta: normal.meta,
      spans: cut,
      events: [],
      status: "completed",
    };
    const state = deriveReplayState({
      records: [truncated],
      atSpanId: "s_06",
      edit: { field: "result", value: "已写入（编辑值）" },
    });
    // 起点 = s_05(llm.call) 的录制 messages + 本轮 assistant + 该轮 tool 消息(替换后)
    const s05 = normal.spans.find(
      (s): s is Extract<SpanLine, { kind: "llm.call" }> => s.kind === "llm.call" && s.id === "s_05",
    );
    expect(s05).toBeDefined();
    const expectedBase = s05!.request.messages.length;
    expect(state.messages.length).toBe(expectedBase + 2); // + assistant + tool
    const last = state.messages[state.messages.length - 1];
    expect(last).toMatchObject({ role: "tool", content: "已写入（编辑值）" });
    const assistant = state.messages[state.messages.length - 2];
    expect(assistant).toMatchObject({ role: "assistant" });
    expect(assistant?.tool_calls).toHaveLength(1);
  });
});

describe("deriveReplayState：纯函数隔离性", () => {
  it("派生结果不共享父记录对象（深拷贝，多次调用互不影响）", () => {
    const a = deriveReplayState({
      records: [normal],
      atSpanId: "s_03",
      edit: { field: "result", value: "值A" },
    });
    const b = deriveReplayState({
      records: [normal],
      atSpanId: "s_03",
      edit: { field: "result", value: "值B" },
    });
    expect(a.messages).not.toEqual(b.messages);
    // 父记录原样未被污染（s_05 录制 tool 消息 content 仍是原文）
    const s05 = normal.spans.find((s) => s.id === "s_05");
    expect(s05?.kind).toBe("llm.call");
    const rec = s05?.kind === "llm.call" ? s05.request.messages : [];
    const tool = rec.find((m) => m.role === "tool");
    expect(tool?.content).toContain("# ReBaseAgent");
    expect(tool?.content).not.toBe("值A");
  });
});
