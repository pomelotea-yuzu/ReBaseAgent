import type { LlmCallSpan } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { CassetteLlmClient, extractCassette } from "../src/cassette-llm-client.js";
import { TraceTestConfigError } from "../src/errors.js";
import { cannedResponse, fakeConfig, initialMessages, toolCall } from "./helpers.js";

/** 构造最小合法 LlmCallSpan（作为卡带素材） */
function llmSpan(
  id: string,
  messages: Array<{ role: string; content: string }>,
  toolCallNames: string[] = [],
): LlmCallSpan {
  return {
    type: "span",
    id,
    kind: "llm.call",
    parent: "s_01",
    timing: { started_at: "2026-09-08T06:00:00.000Z", ended_at: "2026-09-08T06:00:01.000Z" },
    request: {
      model: "deepseek-chat",
      messages: messages.map((m) => ({ ...m })),
      tools: [
        { type: "function", function: { name: "read_file", description: "", parameters: {} } },
      ],
    },
    response: {
      content: "正文",
      reasoning_content: null,
      tool_calls: toolCallNames.map((name, i) => ({
        id: `c_${id}_${i}`,
        type: "function",
        function: { name, arguments: '{"path":"a.json"}' },
      })),
      usage: { in: 10, out: 5 },
      ttft_ms: 3,
    },
  };
}

describe("CassetteLlmClient", () => {
  it("按调用顺序消费卡带响应；remaining / consumed 如实记账", async () => {
    const client = new CassetteLlmClient(
      [
        llmSpan("s_02", [{ role: "system", content: "s" }]),
        llmSpan("s_05", [{ role: "system", content: "s" }], ["read_file"]),
      ],
      fakeConfig(),
    );
    expect(client.total).toBe(2);

    const first = await client.complete(initialMessages("t1"), null);
    expect(first.response.content).toBe("正文");
    expect(first.response.toolCalls).toHaveLength(0);
    expect(first.response.usage).toEqual({ in: 10, out: 5 });
    expect(client.consumed).toBe(1);
    expect(client.remaining).toBe(1);

    const second = await client.complete(initialMessages("t2"), null);
    expect(second.response.toolCalls.map((tc) => tc.function.name)).toEqual(["read_file"]);
    expect(client.remaining).toBe(0);
  });

  it("请求结构不一致 → 记 request_drift 但照常返回卡带响应（方案 A：不硬失败）", async () => {
    const client = new CassetteLlmClient(
      [
        llmSpan("s_02", [
          { role: "system", content: "旧 prompt" },
          { role: "user", content: "旧任务" },
        ]),
        llmSpan("s_05", [
          { role: "system", content: "旧 prompt" },
          { role: "user", content: "旧任务" },
        ]),
      ],
      fakeConfig(),
    );
    // 改了 prompt：文本不同但角色序列相同 → 不算 drift
    await client.complete(
      [
        { role: "system", content: "新 prompt" },
        { role: "user", content: "新任务" },
      ],
      null,
    );
    expect(client.requestDrift).toHaveLength(0);

    // 结构不同（缺了 system 首条）→ 记 drift，含首个差异位置；卡带照常消费
    const drifted = await client.complete(initialMessages("t").slice(1), null);
    expect(drifted.response.content).toBe("正文");
    expect(client.requestDrift).toHaveLength(1);
    expect(client.requestDrift[0].callIndex).toBe(1);
    expect(client.requestDrift[0].firstDiff).toBe(0);
    expect(client.requestDrift[0].detail).toContain("system");
  });

  it("卡带耗尽 → exhausted 置位并抛配置错误", async () => {
    const client = new CassetteLlmClient(
      [llmSpan("s_02", [{ role: "user", content: "t" }])],
      fakeConfig(),
    );
    await client.complete(initialMessages("t"), null);
    await expect(client.complete(initialMessages("t"), null)).rejects.toThrow(TraceTestConfigError);
    await expect(client.complete(initialMessages("t"), null)).rejects.toThrow("卡带耗尽");
    expect(client.exhausted).toBe(true);
  });

  it("录制 tool_call 结构损坏 → 配置错误（卡带损坏）", async () => {
    const broken = llmSpan("s_02", [{ role: "user", content: "t" }]);
    (broken.response.tool_calls as unknown as Array<Record<string, unknown>>).push({ id: "bad" });
    const client = new CassetteLlmClient([broken], fakeConfig());
    await expect(client.complete(initialMessages("t"), null)).rejects.toThrow("卡带损坏");
  });
});

describe("extractCassette", () => {
  it("初始 messages = 首个 llm.call 的 request.messages（含录制 system）", () => {
    const { llmSpans, initialMessages: messages } = extractCassette({
      spans: [
        llmSpan("s_02", [
          { role: "system", content: "你是文件助手。" },
          { role: "user", content: "读 a.json" },
        ]),
        llmSpan("s_05", [{ role: "user", content: "后续" }]),
      ],
    });
    expect(llmSpans).toHaveLength(2);
    expect(messages).toEqual([
      { role: "system", content: "你是文件助手。" },
      { role: "user", content: "读 a.json" },
    ]);
  });

  it("没有任何 llm.call → 配置错误", () => {
    expect(() => extractCassette({ spans: [] })).toThrow(TraceTestConfigError);
    expect(() => extractCassette({ spans: [] })).toThrow("llm.call");
  });
});
