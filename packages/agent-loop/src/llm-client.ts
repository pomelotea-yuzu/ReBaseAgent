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
    const aggregated = await aggregateSseStream(response.body);
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

/** 从 SSE 字节流聚合出完整响应。流中断 / 无有效内容抛 LlmRequestError。 */
export async function aggregateSseStream(body: ReadableStream<Uint8Array>): Promise<LlmResponse> {
  const events: EventSourceMessage[] = [];
  const parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      events.push(event);
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
  let ttftDone = false;
  let ttftMs = 0;
  const startedAt = Date.now();

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
      const r = delta.reasoning_content;
      if (typeof r === "string" && r.length > 0) {
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
      if (!ttftDone && sawAnything) {
        ttftMs = Date.now() - startedAt;
        ttftDone = true;
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

  return {
    content: agg.content,
    reasoningContent: agg.reasoning,
    toolCalls: calls,
    usage: agg.usage ?? { in: 0, out: 0 },
    ttftMs,
  };
}
