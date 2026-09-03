import {
  ForkSchema,
  RunEventSchema,
  RunMetaSchema,
  SpanSchema,
} from "@rebaseagent/trace-sdk/schema";
import { z } from "zod";
import { CHANNELS } from "./channels";

/**
 * 进程间通信的唯一契约：main 与 renderer 共用这些 schema。
 * 跨进程边界不可信——返回结构必须先校验再进渲染层。
 */

export { CHANNELS };

/** run 记录（与 trace-sdk 的 RunRecord 同构，跨进程为纯 JSON） */
export const RunRecordSchema = z.object({
  meta: RunMetaSchema,
  spans: z.array(SpanSchema),
  events: z.array(RunEventSchema),
  status: z.enum(["completed", "crashed"]),
});
export type RunRecordPayload = z.infer<typeof RunRecordSchema>;

/** run 列表条目：聚合数字全部由 main 侧从 spans 现算，不落任何缓存 */
export const RunSummarySchema = z.object({
  id: z.string(),
  task: z.string(),
  model: z.string(),
  created_at: z.string(),
  status: z.enum(["completed", "crashed"]),
  /** 父 run id；根 run 为 null */
  parent: z.string().nullable(),
  /** 终止原因（崩溃的 run 为 null） */
  reason: z.string().nullable(),
  /** 迭代步数（agent.step 计数） */
  steps: z.number().int().nonnegative(),
  /** 工具调用次数 */
  toolCalls: z.number().int().nonnegative(),
  /** 出错的工具调用次数 */
  toolErrors: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** 总耗时（毫秒）；span 缺失时间区间时为 null——时间未知不得臆造 */
  durationMs: z.number().nonnegative().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** 读取失败的文件：单个文件损坏不得拖垮整个列表 */
export const FailedFileSchema = z.object({
  file: z.string(),
  error: z.string(),
});
export type FailedFile = z.infer<typeof FailedFileSchema>;

export const ListRunsDataSchema = z.object({
  runs: z.array(RunSummarySchema),
  failed: z.array(FailedFileSchema),
});
export type ListRunsData = z.infer<typeof ListRunsDataSchema>;

/** 分支链上的一跳（暴露 fork 元数据，供界面标注分叉点） */
export const ChainHopSchema = z.object({
  meta: RunMetaSchema,
  fork: ForkSchema.nullable(),
});

/** run 详情：分支 run 返回的是 resolveBranch 解析后的完整轨迹 */
export const RunDetailSchema = z.object({
  meta: RunMetaSchema,
  spans: z.array(SpanSchema),
  events: z.array(RunEventSchema),
  status: z.enum(["completed", "crashed"]),
  /** 祖先链（从根到本 run）；根 run 只有一跳 */
  chain: z.array(ChainHopSchema),
  /** 当前 run（叶子）自身新增 span 的 id（在合并轨迹中区分"自己"与"继承的祖先前缀"） */
  leafSpanIds: z.array(z.string()),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** 统一信封：任何通道的返回都是这个形状，错误不靠异常跨越进程边界 */
export const EnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** 构造成功信封 */
export function ok<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

/** 构造失败信封（把异常收敛成可跨进程传输的结构） */
export function fail(code: string, error: unknown): Envelope<never> {
  return {
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

// ---------------------------------------------------------------------------
// runs:fork —— 桌面端唯一的显式写通道（分叉重跑）
// ---------------------------------------------------------------------------

/** 分叉重跑请求：用户显式选择的父 run、分叉点 span、编辑值 */
export const ForkRunRequestSchema = z.object({
  parentRunId: z.string().min(1),
  atSpanId: z.string().min(1),
  /** MVP 只开放 tool.invoke 的 result 字段 */
  edit: z.object({ field: z.literal("result"), value: z.string() }),
});
export type ForkRunRequest = z.infer<typeof ForkRunRequestSchema>;

/** runs:fork 成功结果：新 fork run 的 id */
export const ForkRunResultSchema = z.object({
  id: z.string().min(1),
});
export type ForkRunResult = z.infer<typeof ForkRunResultSchema>;

// ---------------------------------------------------------------------------
// settings —— 运行配置（apiKey 永不回传渲染层）
// ---------------------------------------------------------------------------

/** 渲染层可见的运行配置状态（不含 apiKey；加密方式明示给用户） */
export const SettingsStateSchema = z.object({
  configured: z.boolean(),
  baseURL: z.string().nullable(),
  model: z.string().nullable(),
  /** safe / plain：apiKey 是否经系统加密存储 */
  encryption: z.enum(["safe", "plain"]),
});
export type SettingsState = z.infer<typeof SettingsStateSchema>;

/** 保存运行配置的输入（apiKey 为空串表示保持原值不修改） */
export const SettingsInputSchema = z.object({
  baseURL: z.string().url("baseURL 必须是合法 URL"),
  apiKey: z.string(),
  model: z.string().min(1, "model 不能为空"),
});
export type SettingsInput = z.infer<typeof SettingsInputSchema>;

/**
 * preload 暴露给渲染层的受限接口。
 * 取数两个方法 + forkRun 一个写通道 + settings 三件套（单向写入，
 * apiKey 只在 save 时进入 main，永不回传）。
 */
export interface WindowApi {
  listRuns(): Promise<Envelope<ListRunsData>>;
  getRun(id: string): Promise<Envelope<RunDetail>>;
  forkRun(request: ForkRunRequest): Promise<Envelope<ForkRunResult>>;
  getSettings(): Promise<Envelope<SettingsState>>;
  saveSettings(input: SettingsInput): Promise<Envelope<{ configured: true }>>;
  clearSettings(): Promise<Envelope<{ configured: false }>>;
}
