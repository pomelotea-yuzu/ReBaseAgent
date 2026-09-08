import { z } from "zod";

/**
 * 测试定义 schema（v1）。定义独立于 trace：`trace` 路径相对定义文件解析。
 * v1 无 `mode` 字段——唯一执行语义就是卡带重跑；代理录制 run 由 loader 依据
 * meta 自动降级为静态断言路径，不需要用户声明。
 */

export const DEFINITION_FORMAT_VERSION = 1;

export const SpanKindSchema = z.enum(["agent.step", "llm.call", "tool.invoke"]);
export type SpanKindSelector = z.infer<typeof SpanKindSchema>;

/** span 选择器：各条件 AND 叠加；命中集合交给断言的量词/挑选语义 */
export const SelectorSchema = z
  .object({
    kind: SpanKindSchema.optional(),
    tool: z.string().min(1).optional(),
    n: z.number().int().positive().optional(),
    id: z.string().min(1).optional(),
  })
  .refine((s) => Object.keys(s).length > 0, { message: "selector 至少要有一个条件" });
export type Selector = z.infer<typeof SelectorSchema>;

export const RunOutcomeSchema = z.object({
  type: z.literal("run.outcome"),
  /** 对齐 trace 终止 reason 五枚举 */
  equals: z.enum(["completed", "max_iterations", "budget_exceeded", "aborted", "error"]),
});

export const TraceShapeSchema = z.object({
  type: z.literal("trace.shape"),
  /** 结构对齐默认开启（无需声明本断言）；显式声明 false 可按定义关掉 */
  enabled: z.boolean().optional(),
});

/**
 * span.exists：存在性断言。量词恒为 any（默认），不存在 "all"——
 * "全部匹配都要满足什么"在没有谓词时是空话，拒绝它避免静默变弱。
 */
export const SpanExistsSchema = z.object({
  type: z.literal("span.exists"),
  selector: SelectorSchema,
  quantifier: z.literal("any").optional(),
});

/**
 * span.field：字段断言。挑选语义 first / nth / all（默认 all）。
 * nth 用独立的 `nth` 字段指定「第 n 个匹配」（1 起），与 selector.n
 * （agent.step 迭代号）语义解耦。默认 all：零匹配即失败（缺失匹配 SHALL 失败）。
 */
const SpanFieldBase = z.object({
  type: z.literal("span.field"),
  selector: SelectorSchema,
  /** 点路径，如 "tool"、"args.path"、"response.usage.in" */
  field: z.string().min(1),
  equals: z.unknown(),
  quantifier: z.enum(["first", "nth", "all"]).optional(),
  /** quantifier=nth 时的匹配序号（1 起） */
  nth: z.number().int().positive().optional(),
});

export const SpanCountBase = z.object({
  type: z.literal("span.count"),
  selector: SelectorSchema,
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
  equals: z.number().int().nonnegative().optional(),
});

export const AssertionSchema = z
  .discriminatedUnion("type", [
    RunOutcomeSchema,
    TraceShapeSchema,
    SpanExistsSchema,
    SpanFieldBase,
    SpanCountBase,
  ])
  .superRefine((value, ctx) => {
    if (value.type === "span.field" && value.quantifier === "nth" && value.nth === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quantifier=nth 需要提供 nth（第 n 个匹配，1 起）",
      });
    }
    if (
      value.type === "span.count" &&
      value.min === undefined &&
      value.max === undefined &&
      value.equals === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "span.count 需要至少一个数量约束（min/max/equals）",
      });
    }
  });

export type Assertion = z.infer<typeof AssertionSchema>;

export const TraceTestDefinitionSchema = z.object({
  format_version: z.literal(DEFINITION_FORMAT_VERSION),
  name: z.string().min(1),
  /** trace 路径：相对定义文件解析（绝对路径亦可） */
  trace: z.string().min(1),
  assertions: z.array(AssertionSchema).default([]),
  /**
   * 脱敏键列表：报告摘要里命中这些 key 的值以 "***" 代替（键名不区分大小写）。
   * trace 本身含完整 prompt/响应/工具参数——提交进仓库前务必先脱敏或重录。
   */
  redact: z.array(z.string().min(1)).optional(),
});
export type TraceTestDefinition = z.infer<typeof TraceTestDefinitionSchema>;
