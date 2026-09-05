import { afterAll, describe, expect, it } from "vitest";
import {
  EmptyForkError,
  buildForkContext,
  buildForkRequest,
  createProxyHandler,
  startProxyServer,
} from "../src/index";
import type { ProxyRecorder, ProxyRecording } from "../src/index";

// ---------------------------------------------------------------------------
// 测试基建：stub fetchImpl（零真实 API）+ 收集型 recorder
// ---------------------------------------------------------------------------

const PROXY_BASE = "http://127.0.0.1:18787/v1";
const UPSTREAM = "https://upstream.test";

function makeRecorder() {
  const recordings: ProxyRecording[] = [];
  const forks: Array<Record<string, unknown> | undefined> = [];
  const recorder: ProxyRecorder = {
    record(rec, fork) {
      recordings.push(rec);
      forks.push(fork);
    },
  };
  return { recordings, forks, recorder };
}

/** 构造 handler 请求上下文（模拟服务壳收集到的原始请求） */
function ctxOf(body: string, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...headers },
    rawBody: Buffer.from(body),
  };
}

const REQ_BODY = JSON.stringify({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "你好" }],
  temperature: 0.7,
  stream: false,
});

const UPSTREAM_OK_BODY = JSON.stringify({
  choices: [
    {
      message: {
        role: "assistant",
        content: "你好！有什么可以帮你？",
        reasoning_content: null,
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 8 },
});

function okResponse(body: string, contentType = "application/json"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function sseResponse(sseChunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// 路径 / 方法 / 请求体白名单
// ---------------------------------------------------------------------------

describe("路径与方法白名单：诚实拒绝、不产生录制", () => {
  it("未知路径（/v1/embeddings）→ 404、零录制、不转发 upstream", async () => {
    const { recordings, recorder } = makeRecorder();
    let forwarded = 0;
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => {
        forwarded += 1;
        return okResponse("{}");
      },
    });
    const result = await handler.handle({
      method: "POST",
      path: "/v1/embeddings",
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from("{}"),
    });
    expect(result.status).toBe(404);
    expect(forwarded).toBe(0);
    expect(await result.recording).toBeNull();
    expect(recordings).toHaveLength(0);
  });

  it("非 POST（GET）→ 405、零录制", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => okResponse("{}"),
    });
    const result = await handler.handle({
      method: "GET",
      path: "/v1/chat/completions",
      headers: {},
      rawBody: Buffer.alloc(0),
    });
    expect(result.status).toBe(405);
    expect(await result.recording).toBeNull();
    expect(recordings).toHaveLength(0);
  });

  it("请求体非合法 JSON → 400、零录制", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => okResponse("{}"),
    });
    const result = await handler.handle(ctxOf("not-json{"));
    expect(result.status).toBe(400);
    expect(await result.recording).toBeNull();
    expect(recordings).toHaveLength(0);
  });

  it("缺 model / messages → 400、零录制", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => okResponse("{}"),
    });
    const result = await handler.handle(ctxOf(JSON.stringify({ foo: 1 })));
    expect(result.status).toBe(400);
    expect(await result.recording).toBeNull();
    expect(recordings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 非流式
// ---------------------------------------------------------------------------

describe("非流式转发与录制", () => {
  it("成功：请求体逐字节转发、响应原样回传、录制 completed（params 平铺、ttft_ms=0）", async () => {
    const { recordings, recorder } = makeRecorder();
    const seen: Array<{ url: string; body: Buffer; auth?: string }> = [];
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async (input, init) => {
        seen.push({ url: input, body: init?.body as Buffer, auth: init?.headers?.authorization });
        return okResponse(UPSTREAM_OK_BODY);
      },
    });

    const rawBody = Buffer.from(REQ_BODY);
    const result = await handler.handle({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
      rawBody,
    });

    // 转发保真：URL / body 逐字节 / key 原样
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${UPSTREAM}/v1/chat/completions`);
    expect(Buffer.compare(seen[0]!.body, rawBody)).toBe(0);
    expect(seen[0]!.auth).toBe("Bearer sk-test");

    // 响应保真：字节一致
    const clientBytes = Buffer.from(await new Response(result.body).arrayBuffer());
    expect(clientBytes.toString("utf8")).toBe(UPSTREAM_OK_BODY);
    expect(result.status).toBe(200);

    // 录制
    const rec = await result.recording;
    expect(rec?.outcome).toBe("completed");
    expect(rec?.meta).toEqual({
      task: "(llm-proxy)",
      model: "deepseek-chat",
      source: { kind: "proxy", base_url: PROXY_BASE },
    });
    expect(rec?.request.model).toBe("deepseek-chat");
    expect(rec?.request.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(rec?.request.params).toEqual({ temperature: 0.7 });
    expect(rec?.request.tools).toBeUndefined();
    expect(rec?.response?.content).toBe("你好！有什么可以帮你？");
    expect(rec?.response?.usage).toEqual({ in: 10, out: 8 });
    expect(rec?.response?.ttft_ms).toBe(0);
    expect(recordings).toHaveLength(1);
  });

  it("upstream 500：错误响应原样回传、录制 error（response 为 null）", async () => {
    const { recordings, recorder } = makeRecorder();
    const errBody = JSON.stringify({ error: { message: "limit" } });
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () =>
        new Response(errBody, { status: 500, headers: { "content-type": "application/json" } }),
    });
    const result = await handler.handle(ctxOf(REQ_BODY, { authorization: "Bearer sk-test" }));
    expect(result.status).toBe(500);
    const clientBytes = Buffer.from(await new Response(result.body).arrayBuffer());
    expect(clientBytes.toString("utf8")).toBe(errBody);
    const rec = await result.recording;
    expect(rec?.outcome).toBe("error");
    expect(rec?.response).toBeNull();
    expect(recordings).toHaveLength(1);
  });

  it("upstream 连接失败：502 + 录制 error", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await handler.handle(ctxOf(REQ_BODY));
    expect(result.status).toBe(502);
    const rec = await result.recording;
    expect(rec?.outcome).toBe("error");
    expect(rec?.response).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 流式
// ---------------------------------------------------------------------------

const SSE_CHUNKS = [
  'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"好"}}],"usage":null}\n\n', // usage:null 中间块（deepseek 实测）
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"p"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\\":\\"README.md\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n',
  "data: [DONE]\n\n",
];

describe("流式转发与录制（SSE 透传 + 聚合）", () => {
  it("成功：边收边转发、聚合 content/tool_calls/usage、clientOk 后 completed", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => sseResponse(SSE_CHUNKS),
    });
    const reqBody = JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const result = await handler.handle(ctxOf(reqBody, { authorization: "Bearer sk-test" }));
    expect(result.headers["content-type"]).toBe("text/event-stream");

    // 客户端侧流式读取（模拟逐 chunk 收到）
    const received: Uint8Array[] = [];
    for await (const chunk of result.body) {
      received.push(chunk as Uint8Array);
    }
    result.clientOk();
    const rec = await result.recording;
    const text = Buffer.concat(received.map((c) => Buffer.from(c))).toString("utf8");
    expect(text).toContain('"content":"你"');
    expect(rec?.outcome).toBe("completed");
    expect(rec?.response?.content).toBe("你好");
    expect(rec?.response?.tool_calls).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "read_", arguments: '{"path":"README.md"}' },
      },
    ]);
    expect(rec?.response?.usage).toEqual({ in: 12, out: 5 });
    expect(rec?.response?.ttft_ms).toBeGreaterThanOrEqual(0);
  });

  it("流结束仍无 usage → 兜底 {0,0}", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () =>
        sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]),
    });
    const result = await handler.handle(
      ctxOf(JSON.stringify({ model: "m", messages: [], stream: true })),
    );
    for await (const _ of result.body) {
      /* 消费 */
    }
    result.clientOk();
    const rec = await result.recording;
    expect(rec?.response?.usage).toEqual({ in: 0, out: 0 });
  });

  it("客户端断连（clientFailed）→ crashed（尽力聚合）", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => sseResponse(SSE_CHUNKS),
    });
    const result = await handler.handle(
      ctxOf(JSON.stringify({ model: "m", messages: [], stream: true })),
    );
    result.clientFailed();
    for await (const _ of result.body) {
      /* 消费 */
    }
    const rec = await result.recording;
    expect(rec?.outcome).toBe("crashed");
  });
});

// ---------------------------------------------------------------------------
// key 暂存与不落盘
// ---------------------------------------------------------------------------

describe("key 仅内存暂存、不进录制数据", () => {
  it("Authorization 被捕获进 keyStore；录制数据全文不含 key", async () => {
    const keyStore: { lastKey?: string } = {};
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore,
      fetchImpl: async () => okResponse(UPSTREAM_OK_BODY),
    });
    await handler.handle(ctxOf(REQ_BODY, { authorization: "Bearer sk-secret-value" }));
    const result = await handler.handle(ctxOf(REQ_BODY, { authorization: "Bearer sk-latest" }));
    await result.recording;
    // 最近捕获语义
    expect(keyStore.lastKey).toBe("Bearer sk-latest");
    // 全部录制数据不含 key
    for (const rec of recordings) {
      expect(JSON.stringify(rec)).not.toContain("sk-secret-value");
      expect(JSON.stringify(rec)).not.toContain("sk-latest");
    }
  });
});

// ---------------------------------------------------------------------------
// 单请求级最小分叉
// ---------------------------------------------------------------------------

describe("buildForkRequest（空 fork 防线 + 原值复用）", () => {
  const source = {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "原始消息" }],
    tools: [
      { type: "function", function: { name: "read_file", description: "d", parameters: {} } },
    ],
    params: { temperature: 0.5, max_tokens: 100 },
  };

  it("编辑后重发：messages 用新值，model/params/tools 原样，恒 stream:true", () => {
    const edited = [{ role: "user", content: "编辑后的消息" }];
    const { body, changed } = buildForkRequest(source, edited);
    expect(changed).toBe(true);
    expect(body.model).toBe("deepseek-chat");
    expect(body.messages).toEqual(edited);
    expect(body.tools).toEqual(source.tools);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("未修改（含键序不同的等价结构）→ EmptyForkError", () => {
    expect(() => buildForkRequest(source, source.messages)).toThrow(EmptyForkError);
    // 键序不同但语义相同：仍算未修改
    const reordered = [{ content: "原始消息", role: "user" }];
    expect(() => buildForkRequest(source, reordered as typeof source.messages)).toThrow(
      EmptyForkError,
    );
  });

  it("buildForkContext：构造经代理内部路径的请求上下文（key 暂存值）", () => {
    const ctx = buildForkContext({ model: "m", messages: [] }, "Bearer sk-fork");
    expect(ctx.path).toBe("/v1/chat/completions");
    expect(ctx.method).toBe("POST");
    expect(ctx.headers.authorization).toBe("Bearer sk-fork");
    expect(JSON.parse(ctx.rawBody.toString("utf8"))).toEqual({ model: "m", messages: [] });
  });
});

// ---------------------------------------------------------------------------
// 服务壳（真实 127.0.0.1 网络）
// ---------------------------------------------------------------------------

const servers: Array<{ stop: () => Promise<void> }> = [];
afterAll(async () => {
  for (const s of servers) {
    await s.stop();
  }
});

describe("startProxyServer（node:http 薄壳）", () => {
  it("端到端：仅绑回环、请求经壳到 handler、响应逐字节回传、录制 completed", async () => {
    const { recordings, recorder } = makeRecorder();
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder,
      keyStore: {},
      fetchImpl: async () => okResponse(UPSTREAM_OK_BODY),
    });
    // port:0 → node 分配实际端口（server.port 回读）
    const server = await startProxyServer({ port: 0, handler });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-e2e" },
      body: REQ_BODY,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_OK_BODY);
    await new Promise((r) => setTimeout(r, 20));
    expect(recordings).toHaveLength(1);
    expect(recordings[0]?.outcome).toBe("completed");
    expect(recordings[0] && JSON.stringify(recordings[0])).not.toContain("sk-e2e");
  });

  it("端口被占用 → 明确错误（EADDRINUSE）", async () => {
    const handler = createProxyHandler({
      upstreamBaseUrl: UPSTREAM,
      proxyBaseUrl: PROXY_BASE,
      recorder: makeRecorder().recorder,
      keyStore: {},
      fetchImpl: async () => okResponse("{}"),
    });
    const first = await startProxyServer({ port: 58772, handler });
    servers.push(first);
    await expect(startProxyServer({ port: 58772, handler })).rejects.toThrow(/端口 58772 已被占用/);
  });
});
