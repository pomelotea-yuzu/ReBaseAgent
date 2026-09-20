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
  /**
   * 本 run 自有 spans 的累计缓存命中 tokens（前缀缓存生效的证据）。
   * `null` = 全部 llm.call 都没有 cache_hit 字段（未知，不得显示为 0）；`0` = 实测零命中。
   */
  cacheHit: z.number().int().nonnegative().nullable(),
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
// runs:fork —— 显式写通道之一（分叉重跑；另一条是 runs:create）
// ---------------------------------------------------------------------------

/** 隔离执行模式声明（runs:fork 用）：mode 固定，副本写入授权必须显式 true */
export const IsolatedExecutionModeSchema = z
  .object({
    mode: z.literal("isolated_files"),
    allowFileWrites: z.literal(true),
  })
  .strict();
export type IsolatedExecutionMode = z.infer<typeof IsolatedExecutionModeSchema>;

/** 分叉重跑请求：用户显式选择的父 run、分叉点 span、编辑值 */
export const ForkRunRequestSchema = z.object({
  parentRunId: z.string().min(1),
  atSpanId: z.string().min(1),
  /** MVP 只开放 tool.invoke 的 result 字段 */
  edit: z.object({ field: z.literal("result"), value: z.string() }),
  /**
   * 执行模式（B 1.4，可选）：隔离父本**必须**携带 `{mode:"isolated_files", allowFileWrites:true}`
   * 才能走隔离续跑；漏传时请求会落进普通 replayRun 并被 A 的隔离父本门禁拒绝——
   * "隔离模式与父本严格匹配，不允许漏传后落到普通 handler"。非隔离父本携带本字段
   * 则在预检处以 parent_not_isolated 拒绝（普通 result 分叉没有文件世界可续）。
   */
  execution: IsolatedExecutionModeSchema.optional(),
});
export type ForkRunRequest = z.infer<typeof ForkRunRequestSchema>;

/** runs:fork 成功结果：新 fork run 的 id */
export const ForkRunResultSchema = z.object({
  id: z.string().min(1),
});
export type ForkRunResult = z.infer<typeof ForkRunResultSchema>;

// ---------------------------------------------------------------------------
// runs:create —— 原生 run 创建写通道（从头执行一个 run，无父 run）
// ---------------------------------------------------------------------------

/**
 * 新建运行请求：systemPrompt 可空（空 ⇒ config_hash = configHash("", [])），
 * userMessage 必填非空（空消息无法驱动 agent loop）。
 *
 * 没有 task 字段：`run.meta.task` 由 runLoop 从首条 user 消息派生
 * （packages/agent-loop/src/run-loop.ts:69），runLoop 无 task 入参。
 *
 * workspace（B 1.3/1.4，可选）：缺省 = 纯对话（空工具表、v1）。提供时必须是
 * `isolated_files` 模式 + 用户**本次**显式勾选的副本写入授权（literal(true)：
 * false / "true" / 1 在 schema 层即拒）+ 选择器签发的 sourceToken（main 消费换出
 * 真实路径）。renderer SHALL NOT 传 handler / 物理 blob 路径 / 配额覆盖——
 * schema 是 strict 的，多余字段直接拒绝。
 */
export const IsolatedWorkspaceSelectionSchema = z
  .object({
    mode: z.literal("isolated_files"),
    /** workspaces:chooseSource 签发的会话令牌（一次性；main 消费换出真实路径） */
    sourceToken: z.string().min(1),
    /** 本次执行的副本写入授权：必须显式 true，不继承历史 write_authorized 审计标注 */
    allowFileWrites: z.literal(true),
  })
  .strict();
export type IsolatedWorkspaceSelection = z.infer<typeof IsolatedWorkspaceSelectionSchema>;

export const CreateRunRequestSchema = z.object({
  systemPrompt: z.string(),
  userMessage: z.string().min(1, "userMessage 不能为空"),
  workspace: IsolatedWorkspaceSelectionSchema.optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/** runs:create 成功结果：新 run 的 id */
export const CreateRunResultSchema = z.object({
  id: z.string().min(1),
});
export type CreateRunResult = z.infer<typeof CreateRunResultSchema>;

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

// ---------------------------------------------------------------------------
// workspaces:chooseSource —— 原生目录选择（只读；B 1.3）
// ---------------------------------------------------------------------------

/**
 * 选择结果：取消时不签发 token（`{canceled:true}`）；成功时回传 token + 显示名 +
 * 完整路径。路径回传给渲染层仅为展示（确认区需要让用户核对选了哪个目录）——
 * 真实校验在提交时由 main（token 换出）与 A 包（validateSourceRoot）负责。
 */
export const ChooseSourceResultSchema = z.discriminatedUnion("canceled", [
  z.object({ canceled: z.literal(true) }),
  z.object({
    canceled: z.literal(false),
    sourceToken: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    /** token 有效期止（ISO 字符串）；过期后提交会被拒，需重新选择 */
    expiresAt: z.string().min(1),
  }),
]);
export type ChooseSourceResult = z.infer<typeof ChooseSourceResultSchema>;

// ---------------------------------------------------------------------------
// workspaces:forkCapability —— 隔离分叉的只读能力预检（B 1.5）
// ---------------------------------------------------------------------------

/** 预检请求：直接父 run、分叉点（直接父自有 tool.invoke）、编辑值（空 fork 在此即拒） */
export const ForkCapabilityRequestSchema = z.object({
  parentRunId: z.string().min(1),
  atSpanId: z.string().min(1),
  edit: z.object({ field: z.literal("result"), value: z.string() }),
});
export type ForkCapabilityRequest = z.infer<typeof ForkCapabilityRequestSchema>;

/**
 * 预检结论（A 的 IsolatedReplayCapability 的 IPC 裁剪面）：
 * 轮末快照的**完整清单不跨进程**（可能上千条目，且文件清单展示是 C 的职责）——
 * 确认区只需要定位三元组、规模统计与指纹。
 */
export const ForkCapabilityResultSchema = z.object({
  /** 直接父 run id（= 检查点所属 run） */
  parentId: z.string().min(1),
  /** 被编辑的工具 span id */
  atSpanId: z.string().min(1),
  /** 该工具所属的 agent.step span id（= fork.resume_after_step 的取值） */
  stepSpanId: z.string().min(1),
  /** 检查点所属 run id（恒等于 parentId；显式保留以固定 {ownerRunId,stepSpanId,localIteration} 三元组） */
  ownerRunId: z.string().min(1),
  /** 本地轮号 = 该 step 的原始 agent.step.n（按所属 run 计，不沿链累加） */
  localIteration: z.number().int().positive(),
  /**
   * 轮末快照 id：裸 64 位 hex 指纹（无 `sha256:` 前缀）。
   * 这里按注释收紧成 hex —— 确认区会把它的前 12 位显示给用户，形状不对时宁可拒绝加载，
   * 也不要展示一个来路不明的"检查点指纹"（A 侧 `snapshot.id` 恒为 64 位 hex）。
   */
  snapshotId: z.string().regex(/^[0-9a-f]{64}$/, "快照 id 必须是 64 位十六进制指纹"),
  /** 起点清单的文件数与总字节（附件逐项 verify 通过后的派生值） */
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  /** 直接父的 config_hash（已与本次提交将用的配置一致） */
  configHash: z.string().min(1),
});
export type ForkCapabilityResult = z.infer<typeof ForkCapabilityResultSchema>;

/**
 * preload 暴露给渲染层的受限接口。
 * 取数两个方法 + forkRun / promptFork / modelAb / createRun / proxyFork 五个写通道
 * + chooseSource / forkCapability 两个只读辅助通道（B 1.3/1.5）
 * + settings 三件套 + 代理三件套（apiKey / 代理 key 均单向进入 main，永不回传）。
 */
export interface WindowApi {
  listRuns(): Promise<Envelope<ListRunsData>>;
  getRun(id: string): Promise<Envelope<RunDetail>>;
  forkRun(request: ForkRunRequest): Promise<Envelope<ForkRunResult>>;
  promptFork(request: PromptForkRequest): Promise<Envelope<PromptForkResult>>;
  modelAb(request: ModelAbRequest): Promise<Envelope<ModelAbResult>>;
  createRun(request: CreateRunRequest): Promise<Envelope<CreateRunResult>>;
  /** 原生目录选择：只签发会话 token，不导入、不写 trace/blob；取消返回 {canceled:true} */
  chooseSource(): Promise<Envelope<ChooseSourceResult>>;
  /**
   * 隔离分叉的只读能力预检（确认区数据源）：不创建运行、不写文件、不请求模型。
   * 失败（历史 run 无检查点 / 附件不可用 / 非隔离父本等）返回可操作的错误信封。
   */
  forkCapability(request: ForkCapabilityRequest): Promise<Envelope<ForkCapabilityResult>>;
  getSettings(): Promise<Envelope<SettingsState>>;
  saveSettings(input: SettingsInput): Promise<Envelope<{ configured: true }>>;
  clearSettings(): Promise<Envelope<{ configured: false }>>;
  proxyStatus(): Promise<Envelope<ProxyState>>;
  proxyToggle(input: ProxyToggleInput): Promise<Envelope<ProxyState>>;
  proxyFork(request: ProxyForkRequest): Promise<Envelope<ProxyForkResult>>;
}
