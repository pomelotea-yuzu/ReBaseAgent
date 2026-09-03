import { z } from "zod";

// ---------------------------------------------------------------------------
// 消息（OpenAI chat 协议子集，原样透传给请求体）
// ---------------------------------------------------------------------------

export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/** tool_calls 里的单条工具调用（assistant 消息内） */
export const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    /** JSON 字符串（OpenAI 协议如此，模型输出未解析的 args） */
    arguments: z.string(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** 聊天消息。附加字段（name 等）原样保留，保证前缀逐字节稳定 */
export const MessageSchema = z
  .object({
    role: ChatRoleSchema,
    content: z.string().nullable(),
    tool_calls: z.array(ToolCallSchema).optional(),
    tool_call_id: z.string().optional(),
  })
  .passthrough();
export type Message = z.infer<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * 工具的 JSON Schema 参数定义。
 * parameters 为 JSON Schema 对象（原样透传给请求体与 trace）。
 */
export const ToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema 对象 */
  parameters: z.record(z.string(), z.unknown()),
  /**
   * 副作用标注（默认 true）：供 replay spec 分级——
   * false = pure（可零成本重放），true = best-effort（需真实重执行）
   */
  sideEffect: z.boolean().optional(),
});
export type ToolDef = z.infer<typeof ToolDefSchema>;

/** 工具执行上下文 */
export interface ToolContext {
  /** 工具执行的落点（沙箱/工作目录） */
  cwd: string;
  /** 中止信号；不支持中止的工具可以忽略 */
  signal: AbortSignal | null;
}

/** 工具 handler：返回值即 tool_result 内容；抛出的任何异常都捕获为 error */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string> | string;

/** 已注册的工具（定义 + handler） */
export interface Tool extends ToolDef {
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// RunConfig
// ---------------------------------------------------------------------------

/** 预算上限（至少其一） */
export const BudgetSchema = z
  .object({
    /** 累计 token 上限（in+out 之和，从 messages 派生） */
    maxTotalTokens: z.number().int().positive().optional(),
    /** 累计成本上限（元；单价表由调用方提供时使用，暂以 token 计） */
    maxCost: z.number().positive().optional(),
  })
  .refine((b) => b.maxTotalTokens !== undefined || b.maxCost !== undefined, {
    message: "预算上限需提供 maxTotalTokens 或 maxCost 至少其一",
  });
export type Budget = z.infer<typeof BudgetSchema>;

/** 执行上下文：signal 可为 null（不支持中止） */
export const ExecContextSchema = z.object({
  cwd: z.string().min(1),
  signal: z.instanceof(AbortSignal).nullable().optional(),
});
export type ExecContext = z.infer<typeof ExecContextSchema>;

/** LLM 采样参数（temperature/top_p 等，原样透传） */
export const SampleParamsSchema = z.record(z.string(), z.number()).optional();
export type SampleParams = z.infer<typeof SampleParamsSchema>;

export const RunConfigSchema = z.object({
  /** OpenAI 兼容端点（如 https://api.deepseek.com/v1） */
  baseURL: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string(),
  tools: z.array(ToolDefSchema),
  params: SampleParamsSchema,
  exec: ExecContextSchema,
  maxIterations: z.number().int().positive(),
  budget: BudgetSchema,
});
export type RunConfigInput = z.input<typeof RunConfigSchema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;

/** 校验并规范化配置；非法配置在运行开始前报错 */
export function parseRunConfig(input: unknown): RunConfig {
  return RunConfigSchema.parse(input);
}
