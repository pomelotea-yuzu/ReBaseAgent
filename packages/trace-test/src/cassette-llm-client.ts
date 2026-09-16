import {
  type LlmClient,
  LlmRequestError,
  type LlmResponse,
  type Message,
  MessageSchema,
  type RequestBody,
  type RunConfig,
  type ToolCall,
  ToolCallSchema,
  buildRequestBody,
} from "@rebaseagent/agent-loop";
import type { ChatMessage, LlmCallSpan, SpanLine } from "@rebaseagent/trace-sdk";
import { TraceTestConfigError } from "./errors.js";

/** 一次 LLM 请求的结构漂移明细（含首个差异位置；文本差异不参与比较） */
export interface RequestDrift {
  /** 第 n 次 LLM 调用（0 起） */
  callIndex: number;
  /** 首个差异的消息下标；长度不一致时为消息数较大者的越界位置 */
  firstDiff: number;
  detail: string;
}

/**
 * 消息序列的结构指纹：角色序列 + assistant 消息的 tool-call 函数名。
 * 文本内容（system/user 正文、args JSON、响应正文）全部忽略——
 * 改 prompt / 改自由文本不构成硬失败，这是「配置漂移可见」而非「请求硬匹配」的语义。
 */
function structureOf(messages: Array<Message | ChatMessage>): string[] {
  return messages.map((m) => {
    const toolCalls = (m as { tool_calls?: unknown }).tool_calls;
    if (m.role === "assistant" && Array.isArray(toolCalls) && toolCalls.length > 0) {
      const names = toolCalls
        .map((tc) => (tc as { function?: { name?: unknown } }).function?.name)
        .join(",");
      return `assistant(tool_calls:${names})`;
    }
    return m.role;
  });
}

function firstDiffIndex(a: string[], b: string[]): { at: number; detail: string } {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return {
        at: i,
        detail: `第 ${i} 条消息结构不同：录制="${a[i] ?? "<无>"}"，当前="${b[i] ?? "<无>"}"`,
      };
    }
  }
  return { at: -1, detail: "" };
}

/** 把录制响应的 tool_calls（zod record 数组）校验并还原为协议 ToolCall */
function toToolCalls(recorded: Array<Record<string, unknown>>): ToolCall[] {
  return recorded.map((tc, i) => {
    const parsed = ToolCallSchema.safeParse(tc);
    if (!parsed.success) {
      throw new TraceTestConfigError(
        `卡带损坏：第 ${i} 条录制 tool_call 结构非法（${parsed.error.issues[0]?.message ?? "unknown"}），请重录基线`,
      );
    }
    return parsed.data;
  });
}

/**
 * 卡带 LLM 客户端：把录制的 llm.call 响应按调用顺序吐给当前 runLoop。
 *
 * - 按调用序号消费（第 n 次 complete → 第 n 条录制响应），请求差异不硬匹配，
 *   只记入 requestDrift（方案 A：改 prompt / 改工具协议不阻断卡带消费）；
 * - **录制的失败调用重现为失败**：先推进游标（恰好消费一次），再抛
 *   `LlmRequestError(recorded.message, recorded.status)`——用 LlmRequestError 而非普通
 *   Error，否则新 run 的失败 span 取不到 status（"录制有、重放无"）。不返回占位 response、
 *   不置 exhausted，由 runLoop 收成 error outcome；
 * - 卡带耗尽：置 exhausted 标记后抛 TraceTestConfigError（runLoop 会把它
 *   当作 LLM 失败收尾，编排层在 run 结束后检查标记并还原为配置错误）；
 * - 零网络：不发起任何请求，requestBody 仅按当前 config 构造用于透传
 *   LlmClient 接口契约，不出现在任何断言比较里。
 */
export class CassetteLlmClient implements LlmClient {
  private cursor = 0;
  private readonly drift: RequestDrift[] = [];
  private exhaustedFlag = false;

  constructor(
    /** 录制的 llm.call span（按调用顺序；编排层已保证非空） */
    private readonly recorded: LlmCallSpan[],
    private readonly config: RunConfig,
  ) {}

  /** 已消费的卡带响应数 */
  get consumed(): number {
    return this.cursor;
  }

  /** 未消费的剩余卡带响应数 */
  get remaining(): number {
    return this.recorded.length - this.cursor;
  }

  /** 录制响应总数 */
  get total(): number {
    return this.recorded.length;
  }

  /** 请求结构漂移明细（只记录，不影响执行与结果状态） */
  get requestDrift(): readonly RequestDrift[] {
    return this.drift;
  }

  /** 是否发生过卡带耗尽（编排层据此还原配置错误） */
  get exhausted(): boolean {
    return this.exhaustedFlag;
  }

  async complete(
    messages: Message[],
    _signal: AbortSignal | null,
  ): Promise<{ response: LlmResponse; requestBody: RequestBody }> {
    if (this.cursor >= this.recorded.length) {
      this.exhaustedFlag = true;
      throw new TraceTestConfigError(
        `卡带耗尽：第 ${this.cursor + 1} 次 LLM 调用没有录制响应（录制共 ${this.recorded.length} 次）。当前代码的 LLM 调用次数多于录制——若属预期的行为变化，请重录基线。`,
      );
    }
    const span = this.recorded[this.cursor];
    const diff = firstDiffIndex(structureOf(span.request.messages), structureOf(messages));
    if (diff.at >= 0) {
      this.drift.push({ callIndex: this.cursor, firstDiff: diff.at, detail: diff.detail });
    }
    this.cursor += 1;

    // 录制到失败调用：游标已推进（一次录制失败恰好消费一次），此处抛 LlmRequestError
    // 让当前 runLoop 生成 error outcome——不返回占位 response（那会被当成"成功的空回答"）。
    // 缺失 status 时不补造默认值。
    if (span.error !== undefined) {
      throw new LlmRequestError(span.error.message, span.error.status);
    }

    const recordedToolCalls = toToolCalls(span.response.tool_calls);
    return {
      response: {
        content: span.response.content,
        reasoningContent: span.response.reasoning_content,
        toolCalls: recordedToolCalls,
        usage: { ...span.response.usage },
        ttftMs: span.response.ttft_ms,
      },
      requestBody: buildRequestBody(this.config, messages),
    };
  }
}

/**
 * 从录制 trace 提取卡带素材与初始 messages。
 * 初始 messages = 首个 llm.call 的 request.messages（含录制的 system 首条）——
 * VCR 语义：测的是「旧输入 + 新 harness」，prompt 变更走 config drift 提示重录。
 */
export function extractCassette(record: { spans: SpanLine[] }): {
  llmSpans: LlmCallSpan[];
  initialMessages: Message[];
} {
  const llmSpans = record.spans.filter((s): s is LlmCallSpan => s.kind === "llm.call");
  if (llmSpans.length === 0) {
    throw new TraceTestConfigError(
      "录制 trace 中没有任何 llm.call span，无卡带素材可用（代理录制的 run 请走静态断言路径）",
    );
  }
  const parsed = MessageSchema.array().safeParse(llmSpans[0].request.messages);
  if (!parsed.success) {
    throw new TraceTestConfigError(
      `首个 llm.call 的录制 messages 结构非法：${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { llmSpans, initialMessages: parsed.data };
}
