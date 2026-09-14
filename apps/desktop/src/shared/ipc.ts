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
  /**
   * 分叉摘要（根 run 与老文件为 null）：只带分叉点 span id 与被编辑字段名，
   * 不带 value——value 可能是整段工具结果或完整 messages，列表载荷一次性传输 N 条，
   * 放大会直接拖慢冷启动；要看具体内容时读详情。
   */
  fork: z
    .object({
      at_span: z.string().min(1),
      edit_field: z.string().min(1),
      /**
       * 实验组标签（仅 model_params 分叉有值）：同一批 A/B 的所有臂共享同一个
       * experimentId，分支树与对照面板据此聚成一组。短字符串，不影响载荷纪律。
       */
      experiment_id: z.string().min(1).nullable(),
    })
    .nullable(),
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
  /** 录制来源：代理录制为 "proxy"；SDK / agent-loop 直录为 null（老文件同 null） */
  source: z.enum(["proxy"]).nullable(),
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
// runs:promptFork —— prompt fork 写通道（编辑启动上下文，从头重跑）
// ---------------------------------------------------------------------------

/**
 * prompt fork 请求：编辑父 run 首次 llm.call 启动上下文中的一项。
 * 与 runs:fork（tool_result 编辑，共享父前缀）语义正交：prompt fork
 * 从头重跑、不共享前缀；一次只允许修改 system_prompt 或 user_message 其一。
 */
export const PromptForkRequestSchema = z.object({
  parentRunId: z.string().min(1),
  edit: z.object({
    field: z.enum(["system_prompt", "user_message"]),
    value: z.string(),
  }),
});
export type PromptForkRequest = z.infer<typeof PromptForkRequestSchema>;

/** runs:promptFork 成功结果：新 fork run 的 id */
export const PromptForkResultSchema = z.object({
  id: z.string().min(1),
});
export type PromptForkResult = z.infer<typeof PromptForkResultSchema>;

// ---------------------------------------------------------------------------
// runs:modelAb —— 模型 A/B 实验（一次调用 = 一批，至少两个 arm 真实重跑）
// ---------------------------------------------------------------------------

/** 单个实验臂：模型名 + 可选数值采样参数 + 可选的副作用确认声明 */
export const ModelAbArmSchema = z.object({
  model: z.string().min(1, "model 不能为空"),
  /** 标量采样参数（string / number / boolean）；整体覆盖父 run 录制值 */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** 显式确认允许带副作用的工具（全批一致为 true 才放行） */
  allowSideEffects: z.boolean().optional(),
});
export type ModelAbArm = z.infer<typeof ModelAbArmSchema>;

/**
 * 模型实验请求。dryRun = true 时只做校验并返回计划：不调用模型、不写文件，
 * 但父 run 门禁、双真相源、工具策略、同源校验全部照跑（预览即真实判据）。
 */
export const ModelAbRequestSchema = z.object({
  parentRunId: z.string().min(1),
  arms: z.array(ModelAbArmSchema).min(2, "模型实验至少需要 2 个 arm"),
  dryRun: z.boolean().optional(),
});
export type ModelAbRequest = z.infer<typeof ModelAbRequestSchema>;

/** 静默忽略告警（知识库命中；空数组 = 未命中，不承诺"已生效"） */
export const SilentIgnoreWarningSchema = z.object({
  key: z.string(),
  provider: z.string(),
  reason: z.string(),
  workaround: z.string(),
});

/**
 * dry-run 的计划条目：该臂相对父 run 实际改变了什么。
 * 四个展示字段（params / overridden / added / discarded / warnings）由编排层
 * （replay 的 modelReplayRunMany）计算一次，渲染层只读不重算——双端口径同源。
 */
export const ModelArmPlanSchema = z.object({
  index: z.number().int().nonnegative(),
  model: z.string(),
  /** 最终生效 params（含继承的父录值） */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  changed: z.array(z.string()),
  /** arm 显式给出、且父 run 也有的键（标"覆盖"） */
  overridden: z.array(z.string()),
  /** arm 显式给出、但父 run 没有的键（标"新增"） */
  added: z.array(z.string()),
  /** 父录值中被整体替换丢弃的项（arm 未给 params 时为 {}） */
  discarded: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** 知识库命中的静默忽略告警 */
  warnings: z.array(SilentIgnoreWarningSchema),
  allowSideEffects: z.boolean(),
});
export type ModelArmPlan = z.infer<typeof ModelArmPlanSchema>;

/** runs:modelAb 结果：dry-run 只有 plan，真实执行额外给出各臂 run id */
export const ModelAbResultSchema = z.object({
  experimentId: z.string().min(1),
  /** 各臂落盘的 fork run id（dry-run 为空数组） */
  ids: z.array(z.string()),
  /** 全部 arm 成功（dry-run 恒为 true） */
  ok: z.boolean(),
  plan: z.array(ModelArmPlanSchema),
  /** 逃生舱放行：含副作用工具已被真实执行，UI 需标注"顺序执行、外部状态可能已被前一臂改变" */
  sideEffectsAllowed: z.boolean(),
});
export type ModelAbResult = z.infer<typeof ModelAbResultSchema>;

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

// ---------------------------------------------------------------------------
// proxy —— 本地 LLM 录制代理（key 永不回传渲染层，状态只回 hasKey 布尔）
// ---------------------------------------------------------------------------

/** 代理状态（渲染层可见；key 只体现为 hasKey 布尔） */
export const ProxyStateSchema = z.object({
  /** 用户意图（settings 里保存的开关） */
  enabled: z.boolean(),
  /** 服务当前是否在监听 */
  running: z.boolean(),
  port: z.number().int().min(1).max(65535),
  upstreamBaseUrl: z.string(),
  /** 本会话是否捕获到 key（值本身永不出 main） */
  hasKey: z.boolean(),
});
export type ProxyState = z.infer<typeof ProxyStateSchema>;

/** 启停即保存：toggle 同时持久化端口与 upstream（免第四个通道） */
export const ProxyToggleInputSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  upstreamBaseUrl: z.string().url("upstream 必须是合法 URL"),
});
export type ProxyToggleInput = z.infer<typeof ProxyToggleInputSchema>;

/** 代理分叉（方案 a：编辑 messages 重发单请求） */
export const ProxyForkRequestSchema = z.object({
  parentRunId: z.string().min(1),
  atSpanId: z.string().min(1),
  /** 编辑后的完整 messages 数组（原样作为请求体 messages） */
  messages: z.array(z.record(z.string(), z.unknown())).min(1),
});
export type ProxyForkRequest = z.infer<typeof ProxyForkRequestSchema>;

/** proxy:fork 成功结果：新 fork run 的 id */
export const ProxyForkResultSchema = z.object({
  id: z.string().min(1),
});
export type ProxyForkResult = z.infer<typeof ProxyForkResultSchema>;

/**
 * preload 暴露给渲染层的受限接口。
 * 取数两个方法 + forkRun / promptFork / modelAb / proxyFork 四个写通道 + settings 三件套 + 代理三件套
 * （apiKey / 代理 key 均单向进入 main，永不回传）。
 */
export interface WindowApi {
  listRuns(): Promise<Envelope<ListRunsData>>;
  getRun(id: string): Promise<Envelope<RunDetail>>;
  forkRun(request: ForkRunRequest): Promise<Envelope<ForkRunResult>>;
  promptFork(request: PromptForkRequest): Promise<Envelope<PromptForkResult>>;
  modelAb(request: ModelAbRequest): Promise<Envelope<ModelAbResult>>;
  getSettings(): Promise<Envelope<SettingsState>>;
  saveSettings(input: SettingsInput): Promise<Envelope<{ configured: true }>>;
  clearSettings(): Promise<Envelope<{ configured: false }>>;
  proxyStatus(): Promise<Envelope<ProxyState>>;
  proxyToggle(input: ProxyToggleInput): Promise<Envelope<ProxyState>>;
  proxyFork(request: ProxyForkRequest): Promise<Envelope<ProxyForkResult>>;
}
