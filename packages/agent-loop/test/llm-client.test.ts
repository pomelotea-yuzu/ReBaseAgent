import { describe, expect, it } from "vitest";
import {
  LlmRequestError,
  OpenAiCompatClient,
  aggregateSseStream,
  buildRequestBody,
} from "../src/index";
import { fetchReturningSse, sampleConfig, sampleTools, sseData } from "./helpers";

const DONE_MARK = "data: [DONE]";

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(parts[i]));
      i += 1;
    },
  });
}

const chunk = (delta: Record<string, unknown>) => sseData({ choices: [{ delta }] });
const usageChunk = (inTokens: number, outTokens: number) =>
  sseData({
    choices: [{ delta: {} }],
    usage: { prompt_tokens: inTokens, completion_tokens: outTokens },
  });

describe("SSE 聚合器", () => {
  it("content 多块拼接 + usage", async () => {
    const parts = [
      chunk({ content: "你好" }),
      chunk({ content: "，世界" }),
      usageChunk(1830, 210),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.content).toBe("你好，世界");
    expect(result.reasoningContent).toBeNull();
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ in: 1830, out: 210 });
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
  });

  it("reasoning_content（推理模型扩展）完整拼接", async () => {
    const parts = [
      chunk({ reasoning_content: "先分析" }),
      chunk({ reasoning_content: "再执行" }),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.reasoningContent).toBe("先分析再执行");
    expect(result.content).toBeNull();
  });

  it("tool_calls 按 index 聚合 arguments 分片", async () => {
    const parts = [
      chunk({
        tool_calls: [
          { index: 0, id: "call_001", function: { name: "read_file", arguments: '{"pa' } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }),
      usageChunk(100, 20),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.toolCalls).toEqual([
      {
        id: "call_001",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      },
    ]);
  });

  it("多个 tool_calls 并行聚合且顺序稳定（按 index 排序）", async () => {
    const parts = [
      chunk({
        tool_calls: [
          { index: 1, id: "call_002", function: { name: "b_tool", arguments: "{}" } },
          { index: 0, id: "call_001", function: { name: "a_tool", arguments: "{}" } },
        ],
      }),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.toolCalls.map((c) => c.id)).toEqual(["call_001", "call_002"]);
  });

  it("流结束但无任何有效内容 → 抛 LlmRequestError", async () => {
    await expect(aggregateSseStream(streamOf([`${DONE_MARK}\n\n`]))).rejects.toThrow(
      LlmRequestError,
    );
  });

  it("数据块 JSON 非法 → 抛 LlmRequestError", async () => {
    await expect(aggregateSseStream(streamOf(["data: {broken\n\n"]))).rejects.toThrow(
      LlmRequestError,
    );
  });
});

describe("buildRequestBody（前缀稳定）", () => {
  it("包含 stream / include_usage / tools（带 sideEffect）/ params 平铺", () => {
    const tools = sampleTools().map(({ handler: _h, ...def }) => def);
    const config = sampleConfig({ tools, params: { temperature: 0.7 } });
    const body = buildRequestBody(config, [{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.7);
    expect(body.tools?.[0]?.function.name).toBe("read_file");
    expect(body.tools?.[0]?.function.sideEffect).toBe(false);
    expect(body.tools?.[1]?.function.sideEffect).toBeUndefined();
  });

  it("无工具时省略 tools 字段", () => {
    const body = buildRequestBody(sampleConfig({ tools: [] }), [{ role: "user", content: "hi" }]);
    expect(body.tools).toBeUndefined();
  });

  it("同输入两次构造逐字节一致（JSON 序列化）", () => {
    const tools = sampleTools().map(({ handler: _h, ...def }) => def);
    const config = sampleConfig({ tools, params: { temperature: 0.7 } });
    const messages = [
      { role: "system", content: "你是文件助手。" },
      { role: "user", content: "读取 README.md" },
    ] as const;
    const a = JSON.stringify(buildRequestBody(config, [...messages]));
    const b = JSON.stringify(buildRequestBody(config, [...messages]));
    expect(a).toBe(b);
  });
});

describe("OpenAiCompatClient", () => {
  it("流式响应完整聚合（fetch 注入 mock）", async () => {
    const parts = [chunk({ content: "任务完成" }), usageChunk(500, 30), `${DONE_MARK}\n\n`];
    const client = new OpenAiCompatClient(sampleConfig(), fetchReturningSse(parts) as never);
    const { response, requestBody } = await client.complete(
      [{ role: "user", content: "hi" }],
      null,
    );
    expect(response.content).toBe("任务完成");
    expect(response.usage).toEqual({ in: 500, out: 30 });
    expect(requestBody.model).toBe("deepseek-chat");
  });

  it("HTTP 401 → LlmRequestError 含状态码", async () => {
    const client = new OpenAiCompatClient(
      sampleConfig(),
      (async () => new Response("unauthorized", { status: 401 })) as never,
    );
    await expect(client.complete([{ role: "user", content: "hi" }], null)).rejects.toSatisfy(
      (e: unknown) => e instanceof LlmRequestError && e.status === 401,
    );
  });

  it("网络失败（fetch 抛错）→ LlmRequestError", async () => {
    const client = new OpenAiCompatClient(sampleConfig(), (async () => {
      throw new Error("ECONNREFUSED");
    }) as never);
    await expect(client.complete([{ role: "user", content: "hi" }], null)).rejects.toThrow(
      /LLM 请求失败/,
    );
  });

  it("空 body → LlmRequestError", async () => {
    const client = new OpenAiCompatClient(
      sampleConfig(),
      (async () => new Response(null, { status: 200 })) as never,
    );
    await expect(client.complete([{ role: "user", content: "hi" }], null)).rejects.toThrow(
      /空 body/,
    );
  });
});
