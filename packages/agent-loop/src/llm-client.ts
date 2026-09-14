import { type EventSourceMessage, createParser } from "eventsource-parser";
import type { Message, RunConfig, ToolCall } from "./config.js";

/** LLM 一次调用的聚合响应（与 trace-sdk llm.call span 的 response 同构） */
export interface LlmResponse {
  content: string | null;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: { in: number; out: number };
  ttftMs: number;
}

/** LLM 请求失败（网络 / HTTP 非 2xx / 流中断 / 响应异常） */
export class LlmRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmRequestError";
    this.status = status;
  }
}

/** 请求体里的工具定义（sideEffect 随工具表进入 trace 请求记录） */
export interface RequestBodyTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    sideEffect?: boolean;
  };
}

/** 构造给 OpenAI 兼容端点的请求体（纯函数：同输入逐字节一致） */
export interface RequestBody {
  model: string;
  messages: Message[];
  tools?: RequestBodyTool[];
  stream: true;
  stream_options: { include_usage: true };
  [key: string]: unknown; // 采样参数（temperature 等）平铺
}

/**
 * 构造请求体。**固定键集见 `RESERVED_BODY_KEYS`（agent-loop/config.ts）；
 * 新增固定键必须同步该常量**——采样参数平铺进顶层，保留键冲突等于请求体注入，
 * `SampleParamsSchema` 已在校验阶段拒绝（此处不重复检查）。
 */
export function buildRequestBody(config: RunConfig, messages: Message[]): RequestBody {
  const body: RequestBody = {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (config.tools.length > 0) {
    body.tools = config.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.sideEffect === undefined ? {} : { sideEffect: t.sideEffect }),
      },
    }));
  }
  if (config.params !== undefined) {
    for (const [k, v] of Object.entries(config.params)) {
      body[k] = v;
    }
  }
  return body;
}

/** fetch 实现类型（可注入 mock） */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal | null;
  },
) => Promise<Response>;

export interface LlmClient {
  complete(
    messages: Message[],
    signal: AbortSignal | null,
  ): Promise<{ response: LlmResponse; requestBody: RequestBody }>;
}

/**
 * OpenAI 兼容协议流式直连客户端。
 * 请求体构造用 buildRequestBody（前缀稳定）；fetch 可注入（测试零 API）。
 */
export class OpenAiCompatClient implements LlmClient {
  private readonly config: RunConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: RunConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async complete(
    messages: Message[],
    signal: AbortSignal | null,
  ): Promise<{ response: LlmResponse; requestBody: RequestBody }> {
    const requestBody = buildRequestBody(this.config, messages);
    // 计时起点必须在"请求发出"之前（含 DNS/TCP/TLS + 等待响应头），与 ttft_ms 的
    // 定义一致——故取在 fetchImpl 调用之前、try 之外。
    const sentAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (e) {
      throw new LlmRequestError(`LLM 请求失败：${(e as Error).message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LlmRequestError(
        `LLM 端点返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`,
        response.status,
      );
    }
    if (response.body === null) {
      throw new LlmRequestError("LLM 端点返回空 body");
    }
    const aggregated = await aggregateSseStream(response.body, { sentAt });
    return { response: aggregated, requestBody };
  }
}

// ---------------------------------------------------------------------------
// SSE 聚合（纯增量：只依赖 OpenAI 规范字段 + reasoning_content 扩展）
// ---------------------------------------------------------------------------

interface AggregatingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface Aggregation {
  content: string | null;
  reasoning: string | null;
  toolCalls: Map<number, AggregatingToolCall>;
  usage: { in: number; out: number } | null;
}

/** `aggregateSseStream` 的可选项 */
export interface AggregateOptions {
  /**
   * 请求发出时刻（`Date.now()` 的毫秒值）。缺省取函数入口时刻。
   * 调用方应在 `fetch` 之前取时，以保证 ttft 含"等待响应头"那一段。
   */
  sentAt?: number;
}

/**
 * 判定一个 SSE event 是否含"内容 delta"。
 *
 * 与聚合正文 / 思维链 / tool_calls 的判定**同源**（同一语义只写一处——本缺陷的成因
 * 正是同一语义写两遍、其中一处跑偏）。`JSON.parse` 失败返回 `false` 且不吞错：真正的
 * 解析错误仍由聚合循环抛 `LlmRequestError`（错误语义不变）。
 * 注：`tool_calls: []`（空数组）亦为真，与既有实现及 `llm-proxy` 保持一致。
 */
function hasContentDelta(event: EventSourceMessage): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return false;
  }
  const delta = (parsed as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]
    ?.delta;
  if (delta === undefined) return false;
  const c = delta.content;
  if (typeof c === "string" && c.length > 0) return true;
  if (pickReasoningDelta(delta) !== null) return true;
  return Array.isArray(delta.tool_calls);
}

/**
 * 从单块 delta 中取思维链增量文本。
 *
 * **块内二选一**（优先 `reasoning_content`，`??` 短路）——同一块同时携带两字段时只取一个，
 * 避免同块内容翻倍。跨块的累加由调用方按到达顺序追加（拼接，不去重）：真实 provider 不会
 * 并发两字段，去重需要内容级启发式（前缀/相似度）在流式增量下不可靠。若真的并发，
 * 拼接结果是最佳努力聚合，**不承诺语义正确**。
 */
function pickReasoningDelta(delta: Record<string, unknown>): string | null {
  const r = delta.reasoning_content ?? delta.reasoning;
  return typeof r === "string" && r.length > 0 ? r : null;
}

/** 从 SSE 字节流聚合出完整响应。流中断 / 无有效内容抛 LlmRequestError。 */
export async function aggregateSseStream(
  body: ReadableStream<Uint8Array>,
  options: AggregateOptions = {},
): Promise<LlmResponse> {
  const startedAt = options.sentAt ?? Date.now();
  const events: EventSourceMessage[] = [];
  let firstDeltaAt: number | null = null;
  const parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      events.push(event);
      // 取时点在**流读取过程中**（而非读完之后遍历缓冲事件）——否则量到的是解析耗时
      if (firstDeltaAt === null && hasContentDelta(event)) firstDeltaAt = Date.now();
    },
  });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    throw new LlmRequestError(`SSE 流中断：${(e as Error).message}`);
  }

  const agg: Aggregation = { content: null, reasoning: null, toolCalls: new Map(), usage: null };
  let sawAnything = false;

  for (const event of events) {
    if (event.data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      throw new LlmRequestError(`SSE 数据块 JSON 解析失败：${event.data.slice(0, 100)}`);
    }
    const delta = (parsed as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]
      ?.delta;
    if (delta !== undefined) {
      const c = delta.content;
      if (typeof c === "string" && c.length > 0) {
        agg.content = (agg.content ?? "") + c;
        sawAnything = true;
      }
      const r = pickReasoningDelta(delta);
      if (r !== null) {
        agg.reasoning = (agg.reasoning ?? "") + r;
        sawAnything = true;
      }
      const tcs = delta.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs as Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>) {
          const idx = tc.index ?? 0;
          const entry = agg.toolCalls.get(idx) ?? { id: "", name: "", arguments: "" };
          if (typeof tc.id === "string" && tc.id.length > 0) entry.id = tc.id;
          if (typeof tc.function?.name === "string" && tc.function.name.length > 0) {
            entry.name = entry.name + tc.function.name;
          }
          if (typeof tc.function?.arguments === "string") {
            entry.arguments = entry.arguments + tc.function.arguments;
          }
          agg.toolCalls.set(idx, entry);
        }
        sawAnything = true;
      }
    }
    const u = (parsed as { usage?: unknown }).usage;
    // 部分端点（deepseek v4-flash 实测）会在流中携带 usage:null 或缺失
    // prompt_tokens 的中间块——必须容错跳过，只在拿到完整对象时记录
    if (typeof u === "object" && u !== null) {
      const usage = u as { prompt_tokens?: unknown; completion_tokens?: unknown };
      const input = usage.prompt_tokens;
      const output = usage.completion_tokens;
      agg.usage = {
        in: typeof input === "number" ? input : 0,
        out: typeof output === "number" ? output : 0,
      };
    }
  }

  if (!sawAnything && agg.usage === null) {
    throw new LlmRequestError("SSE 流结束但未聚合到任何有效内容");
  }

  const calls: ToolCall[] = [...agg.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

  // 首个含内容 delta 的 chunk 与请求发出时刻之差；流内无任何内容 delta 时记 0
  const ttftMs = firstDeltaAt === null ? 0 : Math.max(0, firstDeltaAt - startedAt);

  return {
    content: agg.content,
    reasoningContent: agg.reasoning,
    toolCalls: calls,
    usage: agg.usage ?? { in: 0, out: 0 },
    ttftMs,
  };
}
