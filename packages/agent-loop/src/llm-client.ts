import type { LlmUsage } from "@rebaseagent/trace-sdk";
import { type EventSourceMessage, createParser } from "eventsource-parser";
import type { Message, RunConfig, ToolCall } from "./config.js";
import { buildRedactionSecrets, sanitizeDiagnosticText } from "./diagnostic.js";

/**
 * LLM 一次调用的聚合响应（与 trace-sdk llm.call span 的 response 同构）。
 *
 * `usage` 直接用 trace-sdk 的 `LlmUsage`（同一语义只写一处）：含可选的
 * `cache_hit` / `cache_miss`——**有值**的判据是 `!== undefined`（`0` = 实测零命中，
 * 是有值），**字段缺失** = provider 未返回、命中未知。该维度是 `in` 的组成部分，
 * 不参与既有 token 合计。
 */
export interface LlmResponse {
  content: string | null;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: LlmUsage;
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

/**
 * 从抛出物提取 HTTP 状态码——**只认 `LlmRequestError.status`**，普通异常与字符串
 * 一律不猜（避免把 message 里的数字当状态码）。loop 落盘失败详情时复用本函数。
 */
export function extractHttpStatus(e: unknown): number | undefined {
  if (!(e instanceof LlmRequestError)) return undefined;
  const status = e.status;
  return typeof status === "number" && Number.isInteger(status) && status > 0 ? status : undefined;
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
  /**
   * 本次配置的已知 secrets（apiKey + baseURL 内嵌凭据），构造时算一次。
   * 客户端各抛错点必须传下去：**先脱敏、后截断**——提前切片会让密钥只剩前缀、
   * 无法按完整值替换（详见 diagnostic.ts 的顺序铁律）。
   */
  private readonly secrets: readonly string[];

  constructor(config: RunConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.secrets = buildRedactionSecrets(config);
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
      throw new LlmRequestError(
        sanitizeDiagnosticText(`LLM 请求失败：${(e as Error).message}`, this.secrets),
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // 不提前切片：先对完整响应文本脱敏，再统一限长（1024，含截断标记）
      throw new LlmRequestError(
        sanitizeDiagnosticText(
          `LLM 端点返回 HTTP ${response.status}${text ? `：${text}` : ""}`,
          this.secrets,
        ),
        response.status,
      );
    }
    if (response.body === null) {
      throw new LlmRequestError("LLM 端点返回空 body");
    }
    const aggregated = await aggregateSseStream(response.body, { sentAt, secrets: this.secrets });
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
  usage: LlmUsage | null;
}

/** 非负整数才接受（provider 数据脏时降级为"未知"，不把脏值写进 trace） */
function nonNegativeIntOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 从 usage 块提取缓存命中维度（可选）。
 *
 * 形态兼容（同一语义只写一处）：
 * - 命中：DeepSeek 扁平 `prompt_cache_hit_tokens` 优先，OpenAI 嵌套 `prompt_tokens_details.cached_tokens` 兜底
 * - 未命中：仅扁平形态 `prompt_cache_miss_tokens` 携带（嵌套无等价物 ⇒ 省略）
 * - **`0` 是有值**（实测零命中 = 全量计费），只有字段缺失/非法才是"未知"——判据是 `!== undefined`，
 *   不得用 truthiness（那会让最高频的"零命中"被静默吞掉）
 */
function parseCacheUsage(u: Record<string, unknown>): Pick<LlmUsage, "cache_hit" | "cache_miss"> {
  const flatHit = nonNegativeIntOrUndefined(u.prompt_cache_hit_tokens);
  const nested = u.prompt_tokens_details;
  const nestedHit =
    typeof nested === "object" && nested !== null
      ? nonNegativeIntOrUndefined((nested as { cached_tokens?: unknown }).cached_tokens)
      : undefined;
  const hit = flatHit ?? nestedHit;
  const miss = nonNegativeIntOrUndefined(u.prompt_cache_miss_tokens);
  return {
    ...(hit === undefined ? {} : { cache_hit: hit }),
    ...(miss === undefined ? {} : { cache_miss: miss }),
  };
}

/** `aggregateSseStream` 的可选项 */
export interface AggregateOptions {
  /**
   * 请求发出时刻（`Date.now()` 的毫秒值）。缺省取函数入口时刻。
   * 调用方应在 `fetch` 之前取时，以保证 ttft 含"等待响应头"那一段。
   */
  sentAt?: number;
  /**
   * 脱敏上下文（本次配置的已知 secrets）。**可选**——既有无参数调用保持兼容，
   * 但内置客户端必须传入（SSE 异常文本可能回显凭据）。缺省为空数组 = 只走通用规则。
   */
  secrets?: readonly string[];
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
  const secrets = options.secrets ?? [];
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
    throw new LlmRequestError(
      sanitizeDiagnosticText(`SSE 流中断：${(e as Error).message}`, secrets),
    );
  }

  const agg: Aggregation = { content: null, reasoning: null, toolCalls: new Map(), usage: null };
  let sawAnything = false;

  for (const event of events) {
    if (event.data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      // 不提前切片（原为前 100 字符）：先对**完整**数据块脱敏，再统一限长——
      // 提前切片会让凭据只剩前缀、无法按完整值替换
      throw new LlmRequestError(
        sanitizeDiagnosticText(`SSE 数据块 JSON 解析失败：${event.data}`, secrets),
      );
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
      // 覆盖式赋值：缓存字段与 in/out 必须同一次写入（跨块累加或分开赋值会丢字段）
      agg.usage = {
        in: typeof input === "number" ? input : 0,
        out: typeof output === "number" ? output : 0,
        ...parseCacheUsage(u as Record<string, unknown>),
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
