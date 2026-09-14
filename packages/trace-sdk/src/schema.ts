import { z } from "zod";

/**
 * trace 格式版本。
 * 读取器遇到更高版本必须显式报"不支持的格式版本"，不得静默降级解析。
 */
export const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// 通用子结构
// ---------------------------------------------------------------------------

/**
 * 聊天消息。除 role 外的字段原样保留——
 * trace 是"原样录制"，llm.call 的 request.messages 必须可直接作为 loop 输入（查表，无需重建）。
 */
export const ChatMessageSchema = z.object({ role: z.string() }).passthrough();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** LLM 采样参数（temperature 等），原样保留 */
export const LlmParamsSchema = z.record(z.string(), z.unknown());
export type LlmParams = z.infer<typeof LlmParamsSchema>;

/** token 用量 */
export const LlmUsageSchema = z.object({
  in: z.number().int().nonnegative(),
  out: z.number().int().nonnegative(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

// ---------------------------------------------------------------------------
// run.meta 首行
// ---------------------------------------------------------------------------

/** 分支描述：从父 run 的哪个 span 之后分叉、编辑了什么 */
export const ForkSchema = z.object({
  /** 分叉点：父 run 轨迹中的 span id（该 span 保留在前缀中，编辑语义由 replay 层应用） */
  at_span: z.string().min(1),
  /** 编辑描述：被修改字段与新值 */
  edit: z.object({
    field: z.string().min(1),
    value: z.unknown(),
  }),
});
export type Fork = z.infer<typeof ForkSchema>;

/**
 * 录制来源（可选）：标记录制通道。
 * 当前仅 "proxy"（本地 LLM 录制代理）；SDK / agent-loop 直录省略该字段。
 * base_url 是代理自身监听地址（即用户在自己应用里填的那个 base_url），
 * 不是 upstream 转发目标——upstream 属代理配置，不进 trace。
 */
export const SourceSchema = z.object({
  kind: z.literal("proxy"),
  base_url: z.string().min(1),
});
export type Source = z.infer<typeof SourceSchema>;

export const RunMetaSchema = z.object({
  type: z.literal("run.meta"),
  /** run id，同时是文件内唯一标识 */
  id: z.string().min(1),
  format_version: z.literal(FORMAT_VERSION),
  task: z.string(),
  model: z.string(),
  /** ISO 8601 时间戳 */
  created_at: z.string().min(1),
  /** 父 run id；根 run 为 null */
  parent: z.string().nullable(),
  /** 分支信息；根 run 为 null */
  fork: ForkSchema.nullable(),
  /** 预算上限（可选）：源配置声明的累计 token 预算，run 自包含该事实源 */
  budget: z
    .object({
      /** 累计 token 上限（所有 llm.call 的 in+out 之和），与 loop 侧 deriveTotalTokens 口径一致 */
      max_total_tokens: z.number().int().positive(),
    })
    .optional(),
  /** 源配置指纹（system prompt + 工具表），反事实重放前比对两次运行是否同源。
   *  可选：代理录制的 run 无源配置可哈希，诚实缺省——无该字段的 run
   *  不可作 replay 分叉父本（校验层拒绝），但可作代理分叉（proxy:fork）父本。 */
  config_hash: z.string().min(1).optional(),
  /** config_hash 缺省时的结构化缺因（与 config_hash 互斥）：代理录制的 run 在无法
   *  派生指纹时写入，供 fork 门禁与桌面端给出可诊断的拒绝文案。
   *  - no_system：首次请求无字符串形式的 system 消息
   *  - invalid_tool：工具表存在无法解包的项
   *  历史文件无该字段，读取不受影响。 */
  config_hash_reason: z.enum(["no_system", "invalid_tool"]).optional(),
  /** 录制来源（可选）：由代理录制时写入；SDK / agent-loop 直录省略 */
  source: SourceSchema.optional(),
});
export type RunMetaLine = z.infer<typeof RunMetaSchema>;
/** startRun 的入参（不含 type 判别字段） */
export type RunMetaInput = Omit<RunMetaLine, "type">;

// ---------------------------------------------------------------------------
// span（三种 kind）
// ---------------------------------------------------------------------------

/**
 * span 的墙上时钟区间（ISO 8601 字符串，毫秒精度）。
 *
 * 成对出现——用嵌套对象而非两个平铺可选字段，避免出现"有起点没终点"的中间态。
 * 可选：老文件与手工构造的 trace 合法缺失，读取器不得报错或以其他字段推断耗时。
 * 与 `tool.invoke.dur_ms` 不冲突：dur_ms 是"工具执行耗时"的权威值，
 * timing 提供跨 span 的统一时间坐标（时间轴、step 聚合）。
 */
export const SpanTimingSchema = z.object({
  /** 起始时刻，ISO 8601（如 2026-09-03T08:55:00.123Z） */
  started_at: z.string().min(1),
  /** 终止时刻，ISO 8601；恒不早于 started_at */
  ended_at: z.string().min(1),
});
export type SpanTiming = z.infer<typeof SpanTimingSchema>;

const SpanCommon = {
  type: z.literal("span"),
  id: z.string().min(1),
  /** 父 span id；根 span 为 null */
  parent: z.string().nullable(),
  /** 起止时刻；缺省表示时间未知（老文件合法） */
  timing: SpanTimingSchema.optional(),
} as const;

/** agent.step：一轮 loop 迭代 */
export const AgentStepSpanSchema = z.object({
  ...SpanCommon,
  kind: z.literal("agent.step"),
  /** 迭代序号，从 1 起 */
  n: z.number().int().positive(),
});
export type AgentStepSpan = z.infer<typeof AgentStepSpanSchema>;

/** llm.call：一次 LLM 调用（request 原样录制完整请求） */
export const LlmCallSpanSchema = z.object({
  ...SpanCommon,
  kind: z.literal("llm.call"),
  request: z.object({
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    params: LlmParamsSchema.optional(),
  }),
  response: z.object({
    content: z.string().nullable(),
    /** 推理模型思维链；非推理模型为 null。UI 侧区别于正文展示 */
    reasoning_content: z.string().nullable(),
    tool_calls: z.array(z.record(z.string(), z.unknown())).default([]),
    usage: LlmUsageSchema,
    /** time to first token，毫秒 */
    ttft_ms: z.number().nonnegative(),
  }),
});
export type LlmCallSpan = z.infer<typeof LlmCallSpanSchema>;
export type LlmRequest = LlmCallSpan["request"];
export type LlmResponse = LlmCallSpan["response"];

/** tool.invoke：一次工具执行（错误是数据不是异常） */
export const ToolInvokeSpanSchema = z.object({
  ...SpanCommon,
  kind: z.literal("tool.invoke"),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown(),
  dur_ms: z.number().nonnegative(),
  /** 工具失败记录于此（非 null），loop 决定继续或停止；trace 本身不因工具错误中断 */
  error: z.string().nullable(),
});
export type ToolInvokeSpan = z.infer<typeof ToolInvokeSpanSchema>;

export const SpanSchema = z.discriminatedUnion("kind", [
  AgentStepSpanSchema,
  LlmCallSpanSchema,
  ToolInvokeSpanSchema,
]);
export type SpanLine = z.infer<typeof SpanSchema>;
export type SpanKind = SpanLine["kind"];

// ---------------------------------------------------------------------------
// run.event 终止事件
// ---------------------------------------------------------------------------

export const RunEventSchema = z.object({
  type: z.literal("run.event"),
  event: z.enum(["stopped", "aborted", "errored"]),
  reason: z.enum(["completed", "max_iterations", "budget_exceeded", "aborted", "error"]),
  /** 停止时所在迭代号 */
  at: z.number().int().nonnegative().optional(),
});
export type RunEventLine = z.infer<typeof RunEventSchema>;
/** endRun 的入参（不含 type 判别字段） */
export type RunEventInput = Omit<RunEventLine, "type">;

// ---------------------------------------------------------------------------
// 行联合：trace 文件的每一行
// ---------------------------------------------------------------------------

/**
 * 行联合：trace 文件的每一行。
 * 不能用 discriminatedUnion：三种 span 的 type 同为 "span"（判别值重复），
 * 且 SpanSchema 自身也是 discriminatedUnion。用普通 union，缺失 type 等场景
 * 由读取器的显式检查兜底（"type 为必填"）。
 */
export const TraceLineSchema = z.union([RunMetaSchema, SpanSchema, RunEventSchema]);
export type TraceLine = z.infer<typeof TraceLineSchema>;
