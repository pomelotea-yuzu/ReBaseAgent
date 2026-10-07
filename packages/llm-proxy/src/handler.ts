import { createParser } from "eventsource-parser";
import {
  GENERIC_PROXY_FAILURE,
  credentialLiteralsOf,
  extractUpstreamErrorMessage,
  normalizeProxyFailureText,
  sanitizeProxyDiagnosticText,
} from "./diagnostic.js";
import type {
  ProxyForkMeta,
  ProxyKeyStore,
  ProxyRecorder,
  ProxyRecording,
  ProxyRecordingError,
  ProxyRequestContext,
  ProxyRequestSnapshot,
  ProxyResponseSnapshot,
} from "./types.js";

/**
 * 代理处理器核心（纯逻辑，fetch 可注入 → 测试零真实 API）。
 *
 * 保真度边界：请求体逐字节原样转发；转发头走白名单（content-type / authorization）——
 * 其余头（host / content-length / accept-encoding 等）由 fetch 重算或丢弃，
 * 避免 accept-encoding 透明解压破坏响应字节保真。代理只观察不修改内容。
 */

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** 注入的 fetch 类型（与 agent-loop 的 FetchLike 同构，避免跨包依赖） */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  },
) => Promise<Response>;

export interface ProxyHandlerOptions {
  /** upstream 转发目标（如 https://api.deepseek.com）——只用于转发，不进 trace */
  upstreamBaseUrl: string;
  /** 代理自身监听地址（如 http://127.0.0.1:18787/v1）——写入 meta.source.base_url */
  proxyBaseUrl: string;
  recorder: ProxyRecorder;
  keyStore: ProxyKeyStore;
  fetchImpl?: FetchLike;
  /**
   * 捕获到**非空** Authorization 时的只读回调（design D1）。
   *
   * 为什么需要它：key 的写入发生在本包内（`keyStore.lastKey = auth`），
   * 注入方拿不到"何时发生了捕获"这个事实——而桌面侧必须据此推进捕获版本、
   * 让已打开的编辑器的旧确认失效（`llm-proxy` delta「凭据捕获与更换可观测」）。
   * 两种替代方案被否掉：① 让注入方用 `Object.defineProperty` 陷阱监视属性写入
   * （隐式契约、无法在类型上看出来）；② 把 keyStore 换成回调式（会改既有注入面）。
   *
   * 纪律：
   * - **每次捕获都调用**，即使 `lastKey` 的字面量与上次相同（"是否换 key"不是本回调的判据，
   *   那是桌面侧捕获版本与 renderer 确认绑定的事）；未捕获到凭据的请求不调用。
   * - 参数是原始 Authorization 字符串，**只传给注入方**：本包不记录、不转发、日志不打印。
   * - 回调抛错不得影响转发（与 recorder 同纪律）；此时捕获仍已写入 keyStore。
   */
  onAuthorizationCaptured?: (authorization: string) => void;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  /** 录制完成 promise；null = 本次请求不产生录制（路径/方法/体不合法） */
  recording: Promise<ProxyRecording | null>;
  /** 服务壳在响应完整送达客户端后调用 */
  clientOk(): void;
  /** 流式转发中客户端断连时调用（录制落为 crashed） */
  clientFailed(): void;
}

export interface ProxyHandler {
  /** fork 传入时，录制结果由 recorder 附带 fork 元数据（desktop 据此写 parent/fork meta） */
  handle(ctx: ProxyRequestContext, fork?: ProxyForkMeta): Promise<ProxyResult>;
}

/** 请求体不合法（JSON 解析失败 / 缺 model 或 messages） */
export class ProxyBadRequestError extends Error {}

function jsonResult(status: number, payload: Record<string, unknown>): ProxyResult {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    status,
    headers: { "content-type": "application/json" },
    body: new Response(new Uint8Array(body)).body as ReadableStream<Uint8Array>,
    recording: Promise.resolve(null),
    clientOk() {},
    clientFailed() {},
  };
}

export function createProxyHandler(options: ProxyHandlerOptions): ProxyHandler {
  // 运行时 Buffer 是 Uint8Array 子类，可直接交给 undici fetch；类型上收敛为 RequestInit
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit));

  /** 录制数据交给 recorder（异步，不阻塞响应转发）；recorder 异常不炸转发路径 */
  function deliver(
    recording: ProxyRecording | Promise<ProxyRecording>,
    fork?: ProxyForkMeta,
  ): Promise<ProxyRecording | null> {
    return Promise.resolve(recording)
      .then((rec) => {
        try {
          const r = options.recorder.record(rec, fork);
          return Promise.resolve(r).then(() => rec);
        } catch {
          return rec; // recorder 失败不影响客户端拿到响应
        }
      })
      .catch(() => null);
  }

  /**
   * 构造失败录制的诊断（design D4）。
   *
   * `status` 只在**真的拿到上游状态码**时写。fetch 抛异常、或空 body 这类
   * "代理自己生成了 502"的场景一律省略——把本地 502 记成上游状态码，
   * 等于在 trace 里伪造一次从没发生过的上游响应。
   *
   * secrets 三个来源（delta「已知凭据和通用凭据形式」）：本请求 Authorization
   * 头值、从它剥出的裸 token、以及当时 keyStore 里最近捕获的凭据。前两者治
   * "本次请求回显"，第三者治"上游拿着上一次请求的 key 报错"。
   */
  function buildError(
    rawText: string,
    requestAuthorization: string | undefined,
    status?: number,
  ): ProxyRecordingError {
    const secrets = [
      ...credentialLiteralsOf(requestAuthorization),
      ...credentialLiteralsOf(options.keyStore.lastKey),
    ];
    const message = sanitizeProxyDiagnosticText(normalizeProxyFailureText(rawText), secrets);
    return status === undefined ? { message } : { message, status };
  }

  /** 失败 llm.call 的 response 空占位（design D4） */
  function failurePlaceholderResponse(): ProxyResponseSnapshot {
    return {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 0, out: 0 },
      // 无 TTFT 概念（没有正文抵达）；0 在这里是**占位**，UI 不得解读为实测延迟
      ttft_ms: 0,
    };
  }

  return {
    async handle(ctx: ProxyRequestContext, fork?: ProxyForkMeta): Promise<ProxyResult> {
      const startedAt = new Date().toISOString();

      // 1. 路径 / 方法白名单：诚实拒绝，不静默透传，不产生录制
      if (ctx.path !== CHAT_COMPLETIONS_PATH) {
        return jsonResult(404, {
          error: {
            message: `ReBaseAgent 录制代理仅支持 POST ${CHAT_COMPLETIONS_PATH}，收到 ${ctx.path}`,
          },
        });
      }
      if (ctx.method !== "POST") {
        return jsonResult(405, {
          error: { message: `ReBaseAgent 录制代理仅支持 POST，收到 ${ctx.method}` },
        });
      }

      // 2. 请求体须可解析且含 model/messages（无法对齐 llm.call 语义的不录制）
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(ctx.rawBody.toString("utf8")) as Record<string, unknown>;
      } catch {
        return jsonResult(400, {
          error: {
            message: "请求体不是合法 JSON，录制代理无法记录（原样转发语义不适用于不可解析的请求）",
          },
        });
      }
      const model = parsed.model;
      const messages = parsed.messages;
      if (typeof model !== "string" || model.length === 0 || !Array.isArray(messages)) {
        return jsonResult(400, {
          error: { message: "请求体缺少 model 或 messages，录制代理无法记录" },
        });
      }
      const stream = parsed.stream === true;

      // 3. 捕获 key（仅内存暂存；永不进录制数据 / 日志 / IPC 回传）
      const auth = ctx.headers.authorization;
      if (typeof auth === "string" && auth.length > 0) {
        options.keyStore.lastKey = auth;
        // 捕获事实通知注入方（design D1）。回调异常不得影响转发，也不回滚已写入的 key。
        try {
          options.onAuthorizationCaptured?.(auth);
        } catch {
          // 注入方的记账/通知失败不改变"凭据已捕获"这一事实
        }
      }

      // 4. 录制请求快照：messages/model/tools 原样；顶层其余字段平铺进 params
      const requestSnapshot = snapshotRequest(parsed, model, messages);

      // 5. 透明转发（body 逐字节原样；头走白名单）
      const forwardHeaders: Record<string, string> = {};
      const contentType = ctx.headers["content-type"];
      if (typeof contentType === "string") {
        forwardHeaders["content-type"] = contentType;
      }
      const authorization = ctx.headers.authorization;
      if (typeof authorization === "string") {
        forwardHeaders.authorization = authorization;
      }
      // 诊断脱敏用的凭据来源（收窄成 `string | undefined`）：本请求实际携带的
      // Authorization 头。数组形态（重复头）不当作凭据——node 会把它折叠成数组，
      // 这里取首个元素即可，宁可漏脱敏一个不常见的形态，也不让类型退化成联合。
      const requestAuthorization =
        typeof authorization === "string" ? authorization : authorization?.[0];

      let upstream: Response;
      try {
        upstream = await fetchImpl(`${options.upstreamBaseUrl}${ctx.path}`, {
          method: "POST",
          headers: forwardHeaders,
          body: ctx.rawBody,
        });
      } catch (e) {
        // upstream 连接失败等价于 upstream 不可用：原样语义给客户端 502，录制为 error。
        // 🔴 **不写 status**：502 是代理本地生成的，不是上游的状态码（delta「连接失败不伪造
        // 上游状态码」）。客户端仍拿到明确的 502，但 trace 里没有这次不存在的上游响应。
        const recording = buildRecording(
          requestSnapshot,
          failurePlaceholderResponse(),
          "error",
          options.proxyBaseUrl,
          model,
          startedAt,
          buildError(`upstream 请求失败：${(e as Error).message}`, requestAuthorization),
        );
        return {
          ...jsonResult(502, { error: { message: `upstream 请求失败：${(e as Error).message}` } }),
          recording: deliver(recording, fork),
        };
      }

      if (!upstream.ok) {
        // upstream 非 2xx：错误响应原样回传；录制失败 llm.call（request 完整 + 顶层 error）
        const bytes = Buffer.from(await upstream.arrayBuffer());
        const recording = buildRecording(
          requestSnapshot,
          failurePlaceholderResponse(),
          "error",
          options.proxyBaseUrl,
          model,
          startedAt,
          buildError(
            upstreamErrorMessage(bytes) ?? GENERIC_PROXY_FAILURE,
            requestAuthorization,
            upstream.status,
          ),
        );
        return {
          status: upstream.status,
          headers: pickResponseHeaders(upstream),
          body: new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>,
          recording: deliver(recording, fork),
          clientOk() {},
          clientFailed() {},
        };
      }

      if (!stream) {
        // 非流式：读全包 → 原样字节回传；ttft_ms 记 0（无 TTFT 概念，诚实为零）
        const bytes = Buffer.from(await upstream.arrayBuffer());
        const responseSnapshot = snapshotNonStreamResponse(bytes);
        // 200 但 body 非 JSON：无法对齐 llm.call.response 语义，按 crashed 诚实记录
        const outcome = responseSnapshot === null ? "crashed" : "completed";
        const recording = buildRecording(
          requestSnapshot,
          responseSnapshot,
          outcome,
          options.proxyBaseUrl,
          model,
          startedAt,
        );
        return {
          status: upstream.status,
          headers: pickResponseHeaders(upstream),
          body: new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>,
          recording: deliver(recording, fork),
          clientOk() {},
          clientFailed() {},
        };
      }

      // 流式：tee 出聚合分支，边收边转发（不缓冲整响应）
      if (upstream.body === null) {
        // 上游回了 200 但没有 body：客户端拿到的是**代理本地**生成的 502，
        // 同连接失败一样不写 status（那个 200 不代表这次调用成功）。
        const recording = buildRecording(
          requestSnapshot,
          failurePlaceholderResponse(),
          "error",
          options.proxyBaseUrl,
          model,
          startedAt,
          buildError("upstream 返回空 body", requestAuthorization),
        );
        return {
          ...jsonResult(502, { error: { message: "upstream 返回空 body" } }),
          recording: deliver(recording, fork),
        };
      }
      const [clientBranch, aggregateBranch] = upstream.body.tee();
      let clientDone = false;
      let clientFailed = false;
      const recordingPromise = (async (): Promise<ProxyRecording> => {
        const responseSnapshot = await snapshotStreamResponse(aggregateBranch);
        const outcome = clientDone ? "completed" : clientFailed ? "crashed" : "completed";
        return buildRecording(
          requestSnapshot,
          responseSnapshot,
          outcome,
          options.proxyBaseUrl,
          model,
          startedAt,
        );
      })();

      return {
        status: upstream.status,
        headers: pickResponseHeaders(upstream),
        body: clientBranch,
        recording: deliver(recordingPromise, fork),
        clientOk() {
          clientDone = true;
        },
        clientFailed() {
          clientFailed = true;
        },
      };
    },
  };
}

function snapshotRequest(
  parsed: Record<string, unknown>,
  model: string,
  messages: unknown[],
): ProxyRequestSnapshot {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== "model" && k !== "messages" && k !== "tools" && k !== "stream") {
      params[k] = v;
    }
  }
  const tools = parsed.tools;
  return {
    model,
    messages: messages as Record<string, unknown>[],
    tools: Array.isArray(tools) ? (tools as Record<string, unknown>[]) : undefined,
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}

function buildRecording(
  request: ProxyRequestSnapshot,
  response: ProxyResponseSnapshot | null,
  outcome: ProxyRecording["outcome"],
  proxyBaseUrl: string,
  model: string,
  startedAt: string,
  error?: ProxyRecordingError,
): ProxyRecording {
  return {
    meta: { task: "(llm-proxy)", model, source: { kind: "proxy", base_url: proxyBaseUrl } },
    started_at: startedAt,
    request,
    response,
    outcome,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * 从非 2xx 响应体抽摘要（delta「错误正文为空或无法解析」）。
 *
 * ⚠️ **解码失败不抛**：整段包在 try 里，任何意外都退到 `null`，由调用方
 * 落固定兜底文案——「有个非空可读的诊断」比「诊断解码成功」重要。
 * 抽不出时用 `GENERIC_PROXY_FAILURE` 兜底，绝不把完整响应体塞进 trace。
 */
function upstreamErrorMessage(bytes: Buffer): string | null {
  try {
    return extractUpstreamErrorMessage(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/** 响应头白名单（content-type 必须保留；其余由 node 重算，避免 chunked/长度矛盾） */
function pickResponseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) {
    headers["content-type"] = contentType;
  }
  return headers;
}

/** 非流式响应快照：OpenAI 格式 choices[0].message + usage；ttft_ms = 0 */
function snapshotNonStreamResponse(bytes: Buffer): ProxyResponseSnapshot | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    // upstream 返回 200 但 body 非 JSON：无法对齐 llm.call.response，按 crashed 处理
    return null;
  }
  const message = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
    | Record<string, unknown>
    | undefined;
  const usage = parsed.usage as Record<string, unknown> | undefined;
  return {
    content: typeof message?.content === "string" ? message.content : null,
    reasoning_content:
      typeof message?.reasoning_content === "string" ? message.reasoning_content : null,
    tool_calls: Array.isArray(message?.tool_calls)
      ? (message.tool_calls as Record<string, unknown>[])
      : [],
    usage: {
      in: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      out: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
    },
    ttft_ms: 0,
  };
}

interface StreamAggregation {
  content: string | null;
  reasoning: string | null;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  usage: { in: number; out: number } | null;
  sawAnything: boolean;
  firstTokenAt: number | null;
}

/**
 * 流式响应快照：SSE 逐事件聚合（边转发边旁路聚合，不缓冲整响应）。
 * 与 agent-loop llm-client 同标准：usage:null 中间块容错；结束时仍无 usage 兜底 {0,0}。
 * 聚合自身不抛错——流异常/事件损坏按"尽力聚合、可能截断"处理（outcome 由客户端送达决定）。
 */
async function snapshotStreamResponse(
  body: ReadableStream<Uint8Array>,
): Promise<ProxyResponseSnapshot> {
  const agg: StreamAggregation = {
    content: null,
    reasoning: null,
    toolCalls: new Map(),
    usage: null,
    sawAnything: false,
    firstTokenAt: null,
  };
  const startedAt = Date.now();
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === "[DONE]") return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return; // 损坏事件跳过，尽力聚合
      }
      const delta = (parsed.choices as Array<{ delta?: Record<string, unknown> } | undefined>)?.[0]
        ?.delta;
      if (delta !== undefined) {
        const c = delta.content;
        if (typeof c === "string" && c.length > 0) {
          agg.content = (agg.content ?? "") + c;
          agg.sawAnything = true;
        }
        // 与 llm-client 同标准：块内二选一（优先 reasoning_content），跨块按到达顺序拼接
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === "string" && r.length > 0) {
          agg.reasoning = (agg.reasoning ?? "") + r;
          agg.sawAnything = true;
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
              entry.name += tc.function.name;
            }
            if (typeof tc.function?.arguments === "string") {
              entry.arguments += tc.function.arguments;
            }
            agg.toolCalls.set(idx, entry);
          }
          agg.sawAnything = true;
        }
        if (agg.firstTokenAt === null && agg.sawAnything) {
          agg.firstTokenAt = Date.now() - startedAt;
        }
      }
      const u = parsed.usage;
      // usage:null / 缺 prompt_tokens 的中间块容错（deepseek v4-flash 实测），只在拿到对象时记录
      if (typeof u === "object" && u !== null) {
        const usage = u as { prompt_tokens?: unknown; completion_tokens?: unknown };
        agg.usage = {
          in: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
          out: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
        };
      }
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
  } catch {
    // 流中断：尽力聚合（截断数据仍是有价值的调试信息）
  }

  const tool_calls: Record<string, unknown>[] = [...agg.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));

  return {
    content: agg.content,
    reasoning_content: agg.reasoning,
    tool_calls,
    usage: agg.usage ?? { in: 0, out: 0 },
    ttft_ms: agg.firstTokenAt ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 单请求级最小分叉（方案 a）
// ---------------------------------------------------------------------------

/** 空 fork 防线：编辑后 messages 与原值深度一致 */
export class EmptyForkError extends Error {
  constructor() {
    super("未对 messages 做任何修改（空 fork 被拒绝），编辑后再重发");
  }
}

/** 递归深比较（键序无关），供空 fork 判定 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

export interface ForkSourceRequest {
  model: string;
  messages: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  params?: Record<string, unknown>;
}

/**
 * 构造分叉重发请求体：messages 用编辑后值，model/params/tools 用原录制值。
 * 恒为 stream:true（走统一聚合路径，TTFT 可测）。
 *
 * 固定键集与 `agent-loop` 的 `RESERVED_BODY_KEYS` 一致——新增固定键须同步该常量
 * （params 平铺进顶层，保留键冲突等于请求体注入）。
 * @throws EmptyForkError 未修改
 */
export function buildForkRequest(
  source: ForkSourceRequest,
  editedMessages: Record<string, unknown>[],
): { body: Record<string, unknown>; changed: boolean } {
  if (deepEqual(source.messages, editedMessages)) {
    throw new EmptyForkError();
  }
  const body: Record<string, unknown> = {
    model: source.model,
    messages: editedMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (source.tools !== undefined && source.tools.length > 0) {
    body.tools = source.tools;
  }
  if (source.params !== undefined) {
    for (const [k, v] of Object.entries(source.params)) {
      body[k] = v;
    }
  }
  return { body, changed: true };
}

/** fork 分叉经代理内部路径发起时的上下文构造辅助（key 用暂存值，不落任何盘） */
export function buildForkContext(
  body: Record<string, unknown>,
  authorization: string,
): ProxyRequestContext {
  return {
    method: "POST",
    path: CHAT_COMPLETIONS_PATH,
    headers: { "content-type": "application/json", authorization },
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

export type { ProxyForkMeta, ProxyRecording, ProxyRecorder, ProxyRequestContext, ProxyKeyStore };
