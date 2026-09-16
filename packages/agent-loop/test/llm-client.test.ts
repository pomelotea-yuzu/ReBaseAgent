import { describe, expect, it } from "vitest";
import {
  LlmRequestError,
  OpenAiCompatClient,
  aggregateSseStream,
  buildRequestBody,
} from "../src/index";
import {
  fetchReturningSse,
  fetchReturningSseDelayed,
  sampleConfig,
  sampleTools,
  sseData,
  sseStreamDelayed,
} from "./helpers";
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
    // ⚠️ 该断言不足以发现取时点错误（`0` 与 `2` 都通过）——它正是本缺陷逃逸的直接原因。
    // ttft 的真实保障见本文件末尾「ttft 取时点（可证伪旧实现）」用例组。
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

  it("Ollama 形态：纯 reasoning 字段聚合进 reasoning_content", async () => {
    const parts = [
      chunk({ reasoning: "思考一" }),
      chunk({ reasoning: "思考二" }),
      chunk({ content: "答复" }),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.reasoningContent).toBe("思考一思考二");
    expect(result.content).toBe("答复");
  });

  it("两字段跨块并存 → 按到达顺序拼接（不去重）", async () => {
    const parts = [
      chunk({ reasoning: "A" }),
      chunk({ reasoning_content: "B" }),
      chunk({ reasoning: "C" }),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.reasoningContent).toBe("ABC");
  });

  it("同块两字段并存 → 只取 reasoning_content（块内不翻倍）", async () => {
    const parts = [chunk({ reasoning: "忽略我", reasoning_content: "保留我" }), `${DONE_MARK}\n\n`];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.reasoningContent).toBe("保留我");
  });

  it("ttft 按首个 reasoning delta 计（思考模型不再记成首正文 token）", async () => {
    const parts = [chunk({ reasoning: "先想" }), chunk({ content: "再说" }), `${DONE_MARK}\n\n`];
    const body = sseStreamDelayed(parts, { firstDelayMs: 60, restDelayMs: 0 });
    const result = await aggregateSseStream(body);
    expect(result.reasoningContent).toBe("先想");
    expect(result.ttftMs).toBeGreaterThanOrEqual(60);
  });

  it("空字符串 reasoning 不计为内容 delta（ttft 保底为 0）", async () => {
    const parts = [chunk({ reasoning: "" }), usageChunk(10, 1), `${DONE_MARK}\n\n`];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.reasoningContent).toBeNull();
    expect(result.ttftMs).toBe(0);
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

  it("流中出现 usage:null 中间块 → 容错跳过，usage 取自后续有效块（deepseek v4-flash 实测形态）", async () => {
    const parts = [
      chunk({ content: "你好" }),
      sseData({ choices: [{ delta: {} }], usage: null }),
      usageChunk(1830, 210),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.content).toBe("你好");
    expect(result.usage).toEqual({ in: 1830, out: 210 });
  });

  it("usage 对象缺失 prompt_tokens/completion_tokens → 缺省为 0，不崩溃", async () => {
    const parts = [
      chunk({ content: "你好" }),
      sseData({ choices: [{ delta: {} }], usage: { completion_tokens: 5 } }),
      `${DONE_MARK}\n\n`,
    ];
    const result = await aggregateSseStream(streamOf(parts));
    expect(result.content).toBe("你好");
    expect(result.usage).toEqual({ in: 0, out: 5 });
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

  it("标量 params（字符串 / 布尔）原样平铺进顶层", () => {
    const config = sampleConfig({
      params: { reasoning_effort: "none", think: false, temperature: 0.2 },
    });
    const body = buildRequestBody(config, [{ role: "user", content: "hi" }]);
    expect(body.reasoning_effort).toBe("none");
    expect(body.think).toBe(false);
    expect(body.temperature).toBe(0.2);
    // 固定键不被覆盖
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
  });

  it("标量 params 不改变逐字节稳定性", () => {
    const config = sampleConfig({ params: { reasoning_effort: "none", think: false } });
    const messages = [{ role: "user", content: "hi" }] as const;
    const a = JSON.stringify(buildRequestBody(config, [...messages]));
    const b = JSON.stringify(buildRequestBody(config, [...messages]));
    expect(a).toBe(b);
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

// ---------------------------------------------------------------------------
// 诊断文本脱敏与限长（add-llm-error-detail）
// 顺序铁律：先脱敏、后截断——提前切片会漏掉落在切片之外的凭据，或让凭据只剩前缀。
// ---------------------------------------------------------------------------
describe("诊断文本：凭据不回显、长度受限", () => {
  const KEY = "sk-live-credential-abcd1234";

  it("HTTP 401 响应体回显 apiKey → 报错文本已脱敏（客户端侧）", async () => {
    const client = new OpenAiCompatClient(
      sampleConfig({ apiKey: KEY }),
      (async () =>
        new Response(`{"error":{"message":"invalid key ${KEY}"}}`, { status: 401 })) as never,
    );
    const err = await client
      .complete([{ role: "user", content: "hi" }], null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).message).not.toContain(KEY);
    expect((err as LlmRequestError).message).toContain("[已脱敏]");
    expect((err as LlmRequestError).status).toBe(401);
  });

  it("凭据位于旧 200 字符切片之外 → 仍被完整替换（证明脱敏在截断之前）", async () => {
    const padding = "filler-".repeat(40); // 240 字符 > 旧切片 200
    const client = new OpenAiCompatClient(
      sampleConfig({ apiKey: KEY }),
      (async () => new Response(`${padding}key=${KEY}`, { status: 500 })) as never,
    );
    const err = (await client
      .complete([{ role: "user", content: "hi" }], null)
      .catch((e: unknown) => e)) as LlmRequestError;
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(KEY.slice(0, 10));
  });

  it("超长响应体 → 统一限长 1024（含截断标记），且不残留凭据前缀", async () => {
    const client = new OpenAiCompatClient(
      sampleConfig({ apiKey: KEY }),
      (async () => new Response(`${"x".repeat(3000)}${KEY}`, { status: 502 })) as never,
    );
    const err = (await client
      .complete([{ role: "user", content: "hi" }], null)
      .catch((e: unknown) => e)) as LlmRequestError;
    expect(err.message.length).toBe(1024);
    expect(err.message.endsWith("…[已截断]")).toBe(true);
    expect(err.message).not.toContain(KEY);
  });

  it("SSE 非法数据块回显凭据（位于旧 100 字符切片之外）→ 仍被脱敏", async () => {
    const bad = `{"padding":"${"y".repeat(150)}","key":"${KEY}"`; // 非法 JSON，凭据在 100 字符之后
    const client = new OpenAiCompatClient(
      sampleConfig({ apiKey: KEY }),
      (async () =>
        new Response(streamOf([`data: ${bad}\n\n`]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })) as never,
    );
    const err = (await client
      .complete([{ role: "user", content: "hi" }], null)
      .catch((e: unknown) => e)) as LlmRequestError;
    expect(err.message).toContain("JSON 解析失败");
    expect(err.message).not.toContain(KEY);
    expect(err.message.length).toBeLessThanOrEqual(1024);
  });

  it("无参数调用聚合函数保持兼容（不传脱敏上下文）", async () => {
    const result = await aggregateSseStream(
      streamOf([sseData({ choices: [{ delta: { content: "正常" } }] }), `${DONE_MARK}\n\n`]),
    );
    expect(result.content).toBe("正常");
  });
});

// ---------------------------------------------------------------------------
// 回归：ttft 取时点（原实现把计时起点放在"读完整条流之后"，量到的是解析耗时）
// 判据来自 archive/2026-09-03-add-agent-loop/design.md:40 —— 首个含内容 delta 的
// chunk 与**请求发出时刻**之差。下列用例在旧实现上必须失败。
// ---------------------------------------------------------------------------
describe("ttft 取时点（可证伪旧实现）", () => {
  it("首块延时进入流内 ⇒ ttftMs 不小于该延时（旧实现给 ≈0ms 的解析耗时）", async () => {
    const parts = [chunk({ content: "你好" }), usageChunk(10, 5), `${DONE_MARK}\n\n`];

    const startedAt = Date.now();
    const result = await aggregateSseStream(sseStreamDelayed(parts, { firstDelayMs: 120 }));
    const elapsed = Date.now() - startedAt;

    expect(result.content).toBe("你好");
    expect(result.ttftMs).toBeGreaterThanOrEqual(100);
    // ttft 不可能超过本次总耗时（否则就是量到了"总时长"这种错法）
    expect(result.ttftMs).toBeLessThanOrEqual(elapsed);
  });

  it("块数无关性：同首块延时下，1 块与 10 块的 ttftMs 基本一致（差分对照）", async () => {
    const head = chunk({ content: "A" });
    const tail = Array.from({ length: 9 }, (_, i) => chunk({ content: `B${i}` }));

    const few = await aggregateSseStream(
      sseStreamDelayed([head, `${DONE_MARK}\n\n`], { firstDelayMs: 50 }),
    );
    const many = await aggregateSseStream(
      sseStreamDelayed([head, ...tail, `${DONE_MARK}\n\n`], { firstDelayMs: 50, restDelayMs: 0 }),
    );

    expect(few.ttftMs).toBeGreaterThanOrEqual(40);
    expect(many.ttftMs).toBeGreaterThanOrEqual(40);
    // 旧实现下两者都退化成"解析耗时"→ 上面两个下界先失败；即便侥幸非零，也会
    // 随块数增长 ⇒ 下面的差分断言把"分块越多、值越大"的伪相关钉死。
    // 容差 = 共同首块延时（50ms）的 2 倍：慢速 CI runner（2 核容器 + vitest 并行）
    // 调度抖动实测可达 40ms+（40ms 定值在 Gitee Go 云端首验即抖红 46ms）。
    // 该差分拦截的是粗大缩放错误（如每块误延时 ⇒ 差 ≥ 9×延时），100ms 不损判别力。
    expect(Math.abs(many.ttftMs - few.ttftMs)).toBeLessThanOrEqual(100);
  });

  it("仅有 usage、无任何内容 delta ⇒ ttftMs 为 0（保底语义不变，且 0 非'未测量'）", async () => {
    // 首块照样延时 30ms：若实现把延时误当"首个 delta"，这里就不会是 0
    const parts = [usageChunk(12, 0), `${DONE_MARK}\n\n`];
    const result = await aggregateSseStream(sseStreamDelayed(parts, { firstDelayMs: 30 }));

    expect(result.content).toBeNull();
    expect(result.usage).toEqual({ in: 12, out: 0 });
    expect(result.ttftMs).toBe(0);
  });

  it("端到端：complete() 的 ttftMs 落在 (0, 该次总耗时] 内", async () => {
    // 必须用**延时** fetch：零延时 mock 下首块与请求同刻到达，ttftMs 可为 0
    const parts = [chunk({ content: "任务完成" }), usageChunk(500, 30), `${DONE_MARK}\n\n`];
    const client = new OpenAiCompatClient(
      sampleConfig(),
      fetchReturningSseDelayed(parts, { firstDelayMs: 80 }) as never,
    );

    const startedAt = Date.now();
    const { response } = await client.complete([{ role: "user", content: "hi" }], null);
    const elapsed = Date.now() - startedAt;

    expect(response.content).toBe("任务完成");
    expect(response.ttftMs).toBeGreaterThan(0);
    expect(response.ttftMs).toBeLessThanOrEqual(elapsed);
  });
});

// ---------------------------------------------------------------------------
// 缓存命中解析（A2 记账层）：provider 前缀缓存的命中/未命中 tokens
// ---------------------------------------------------------------------------

describe("SSE 聚合器：缓存命中字段解析", () => {
  /** 带缓存字段的 usage 块（形态由调用方给，便于覆盖扁平 / 嵌套 / 并存） */
  const cacheChunk = (usage: Record<string, unknown>) =>
    sseData({ choices: [{ delta: {} }], usage });

  it("DeepSeek 扁平字段被记录（in 仍为 prompt_tokens 原值）", async () => {
    const result = await aggregateSseStream(
      streamOf([
        cacheChunk({
          prompt_tokens: 1000,
          completion_tokens: 40,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
        }),
        `${DONE_MARK}\n\n`,
      ]),
    );
    expect(result.usage).toEqual({ in: 1000, out: 40, cache_hit: 800, cache_miss: 200 });
  });

  it("零命中如实记录为 0（不得因假值省略）", async () => {
    const result = await aggregateSseStream(
      streamOf([
        cacheChunk({
          prompt_tokens: 1000,
          completion_tokens: 40,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 1000,
        }),
        `${DONE_MARK}\n\n`,
      ]),
    );
    // 0 是"实测零命中"（全量计费），是有值——用 truthiness 判定会静默丢掉这个最高频路径
    expect("cache_hit" in result.usage).toBe(true);
    expect(result.usage.cache_hit).toBe(0);
    expect(result.usage.cache_miss).toBe(1000);
    // 老口径不受影响：in/out 不变
    expect(result.usage.in).toBe(1000);
    expect(result.usage.out).toBe(40);
  });

  it("OpenAI 嵌套字段被记录（无 cache_miss 等价物 ⇒ 省略）", async () => {
    const result = await aggregateSseStream(
      streamOf([
        cacheChunk({
          prompt_tokens: 1000,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 800 },
        }),
        `${DONE_MARK}\n\n`,
      ]),
    );
    expect(result.usage.cache_hit).toBe(800);
    expect("cache_miss" in result.usage).toBe(false);
  });

  it("两种形态并存时扁平优先", async () => {
    const result = await aggregateSseStream(
      streamOf([
        cacheChunk({
          prompt_tokens: 1000,
          completion_tokens: 40,
          prompt_cache_hit_tokens: 700,
          prompt_cache_miss_tokens: 300,
          prompt_tokens_details: { cached_tokens: 999 },
        }),
        `${DONE_MARK}\n\n`,
      ]),
    );
    expect(result.usage.cache_hit).toBe(700);
    expect(result.usage.cache_miss).toBe(300);
  });

  it("未返回缓存字段时整组省略（不写 0 冒充未知）", async () => {
    const result = await aggregateSseStream(streamOf([usageChunk(1830, 210), `${DONE_MARK}\n\n`]));
    expect(result.usage).toEqual({ in: 1830, out: 210 });
    expect("cache_hit" in result.usage).toBe(false);
    expect("cache_miss" in result.usage).toBe(false);
  });

  it("非法值（非数字 / 负数 / 非整数）降级为缺失，不写脏值进 trace", async () => {
    const result = await aggregateSseStream(
      streamOf([
        cacheChunk({
          prompt_tokens: 500,
          completion_tokens: 10,
          prompt_cache_hit_tokens: -1,
          prompt_cache_miss_tokens: "many",
        }),
        `${DONE_MARK}\n\n`,
      ]),
    );
    expect(result.usage).toEqual({ in: 500, out: 10 });
    expect("cache_hit" in result.usage).toBe(false);
  });
});
