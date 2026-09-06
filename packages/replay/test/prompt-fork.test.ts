import type { Message } from "@rebaseagent/agent-loop";
import type { RunRecord, SpanLine } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { derivePromptForkState, locateStartupContext } from "../src/index";
import type { PromptForkEdit } from "../src/index";

/**
 * 手工构造的最小合法 RunRecord（prompt fork 只关心首次 llm.call 的录制请求）。
 * 消息形状与 runLoop 录制一致：system / user / assistant(tool_calls) / tool。
 */
const STARTUP_MESSAGES: Message[] = [
  { role: "system", content: "你是文件助手。" },
  { role: "user", content: "读取 README.md 并总结要点。" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "c1", content: "内容(README.md)" },
];

function makeRecord(over: Partial<RunRecord> = {}): RunRecord {
  const firstLlm: SpanLine = {
    type: "span",
    id: "s_02",
    parent: "s_01",
    kind: "llm.call",
    request: {
      model: "deepseek-chat",
      messages: structuredClone(STARTUP_MESSAGES),
      tools: [{ name: "read_file", description: "读", parameters: {} }],
    },
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 100, out: 50 },
      ttft_ms: 10,
    },
  };
  const step: SpanLine = { type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 };
  return {
    meta: {
      type: "run.meta",
      id: "r_parent",
      format_version: 1,
      task: "测试任务",
      model: "deepseek-chat",
      created_at: "2026-09-06T08:00:00.000Z",
      parent: null,
      fork: null,
      config_hash: "sha256:deadbeef",
    },
    spans: [step, firstLlm],
    events: [{ type: "run.event", event: "stopped", reason: "completed", at: 1 }],
    status: "completed",
    ...over,
  };
}

describe("locateStartupContext：首条字符串 system / user 定位", () => {
  it("定位各自的第一条字符串消息，后续同角色消息不影响", () => {
    const ctx = locateStartupContext([
      { role: "system", content: "第一版 system" },
      { role: "user", content: "第一版 user" },
      { role: "system", content: "第二条 system（不算）" },
      { role: "user", content: "第二条 user（不算）" },
    ]);
    expect(ctx.system).toEqual({ index: 0, content: "第一版 system" });
    expect(ctx.user).toEqual({ index: 1, content: "第一版 user" });
  });

  it("非字符串 content（多模态对象）不算命中；缺 system 时 system 为 null", () => {
    const ctx = locateStartupContext([
      { role: "system", content: [{ type: "text", text: "多模态" }] } as never,
      { role: "user", content: "唯一的 user" },
    ]);
    expect(ctx.system).toBeNull();
    expect(ctx.user).toEqual({ index: 1, content: "唯一的 user" });
  });
});

describe("derivePromptForkState：system_prompt 编辑", () => {
  const edit: PromptForkEdit = { field: "system_prompt", value: "你是更严格的文件助手。" };

  it("仅替换 system content，其余消息逐字段一致；systemPrompt 返回编辑值", () => {
    const record = makeRecord();
    const state = derivePromptForkState({ record, edit });

    expect(state.systemPrompt).toBe("你是更严格的文件助手。");
    expect(state.messages[0]?.content).toBe("你是更严格的文件助手。");
    // 其余消息与录制一致
    expect(state.messages.slice(1)).toEqual(STARTUP_MESSAGES.slice(1));
    expect(state.fork).toEqual({
      at_span: "s_02",
      edit: { field: "system_prompt", value: "你是更严格的文件助手。" },
    });
  });

  it("深拷贝语义：派生后父记录的 messages 不变", () => {
    const record = makeRecord();
    const before = structuredClone(record.spans);
    derivePromptForkState({ record, edit });
    expect(record.spans).toEqual(before);
  });
});

describe("derivePromptForkState：user_message 编辑", () => {
  const edit: PromptForkEdit = { field: "user_message", value: "读取 summary.md 并总结。" };

  it("仅替换首条 user content；systemPrompt 保持父 run 原值", () => {
    const state = derivePromptForkState({ record: makeRecord(), edit });

    expect(state.systemPrompt).toBe("你是文件助手。");
    expect(state.messages[1]?.content).toBe("读取 summary.md 并总结。");
    // 多条 user 消息时只动第一条
    const record = makeRecord();
    record.spans[1] = {
      ...(record.spans[1] as Extract<SpanLine, { kind: "llm.call" }>),
      request: {
        model: "deepseek-chat",
        messages: [...STARTUP_MESSAGES, { role: "user", content: "追加的第二条 user（不动）" }],
        tools: [{ name: "read_file", description: "读", parameters: {} }],
      },
    } as SpanLine;
    const multi = derivePromptForkState({ record, edit });
    expect(multi.messages[1]?.content).toBe("读取 summary.md 并总结。");
    expect(multi.messages[4]?.content).toBe("追加的第二条 user（不动）");
  });
});

describe("derivePromptForkState：拒绝路径", () => {
  it("空 fork（编辑前后相同）→ 拒绝", () => {
    expect(() =>
      derivePromptForkState({
        record: makeRecord(),
        edit: { field: "system_prompt", value: "你是文件助手。" },
      }),
    ).toThrow(/空 fork/);
    expect(() =>
      derivePromptForkState({
        record: makeRecord(),
        edit: { field: "user_message", value: "读取 README.md 并总结要点。" },
      }),
    ).toThrow(/空 fork/);
  });

  it("非法编辑目标（既非 system_prompt 也非 user_message）→ 拒绝", () => {
    expect(() =>
      derivePromptForkState({
        record: makeRecord(),
        edit: { field: "messages" as never, value: "x" },
      }),
    ).toThrow(/非法的 prompt fork 编辑目标/);
  });

  it("非字符串编辑值 → 拒绝", () => {
    expect(() =>
      derivePromptForkState({
        record: makeRecord(),
        edit: { field: "system_prompt", value: [{ type: "text", text: "多模态" }] as never },
      }),
    ).toThrow(/必须是字符串/);
  });

  it("缺少首次 llm.call → 拒绝", () => {
    const record = makeRecord({ spans: [] });
    expect(() =>
      derivePromptForkState({ record, edit: { field: "system_prompt", value: "新 prompt" } }),
    ).toThrow(/没有 llm.call 录制/);
  });

  it("缺少字符串 system 消息 → 两种编辑均拒绝（不假定空字符串）", () => {
    const record = makeRecord();
    record.spans[1] = {
      ...(record.spans[1] as Extract<SpanLine, { kind: "llm.call" }>),
      request: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "读取 README.md 并总结要点。" }],
        tools: [{ name: "read_file", description: "读", parameters: {} }],
      },
    } as SpanLine;
    expect(() =>
      derivePromptForkState({ record, edit: { field: "system_prompt", value: "新 prompt" } }),
    ).toThrow(/不含字符串形式的 system 消息/);
    expect(() =>
      derivePromptForkState({
        record,
        edit: { field: "user_message", value: "换一种问法。" },
      }),
    ).toThrow(/不含字符串形式的 system 消息/);
  });

  it("user_message 编辑但无字符串 user 消息 → 拒绝（system_prompt 编辑不受影响）", () => {
    const record = makeRecord();
    record.spans[1] = {
      ...(record.spans[1] as Extract<SpanLine, { kind: "llm.call" }>),
      request: {
        model: "deepseek-chat",
        messages: [{ role: "system", content: "你是文件助手。" }],
        tools: [{ name: "read_file", description: "读", parameters: {} }],
      },
    } as SpanLine;
    expect(() =>
      derivePromptForkState({ record, edit: { field: "user_message", value: "换一种问法。" } }),
    ).toThrow(/不含字符串形式的 user 消息/);
    const ok = derivePromptForkState({
      record,
      edit: { field: "system_prompt", value: "新 prompt" },
    });
    expect(ok.systemPrompt).toBe("新 prompt");
  });
});
