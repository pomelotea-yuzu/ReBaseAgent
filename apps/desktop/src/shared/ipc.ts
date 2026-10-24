import { RunEventSchema, RunMetaSchema, SpanSchema } from "@rebaseagent/trace-sdk/schema";
import { z } from "zod";
import { CHANNELS } from "./channels";
import type {
  ExecutedRequest,
  ExecutedResponse,
  OperationStatusResult,
  ReconcileRequest,
  ReconcileResult,
} from "./operations";

import {
  COMPARE_REASON_MAX,
  type CompareRunsRequest,
  type CompareRunsResult,
  type ListRunsData,
  type RunDetail,
  type WorkspaceInspectRequest,
  type WorkspaceInspectResult,
  type WorkspaceReadFileRequest,
  type WorkspaceReadFileResult,
} from "@rebaseagent/run-query/schema";

// 运行/详情/比较/检查点领域 schema 已迁至 @rebaseagent/run-query/schema；
// 本文件保持旧出口，IPC 信封、执行/操作/代理/导出 schema 仍留在 desktop。
export {
  ChainHopSchema,
  COMPARE_CODE_MAX,
  COMPARE_REASON_MAX,
  COMPARE_RUN_MAX,
  COMPARE_RUN_MIN,
  CompareRunItemSchema,
  CompareRunsRequestSchema,
  CompareRunsResultSchema,
  FailedFileSchema,
  ListRunsDataSchema,
  RunDetailSchema,
  RunLineageSchema,
  RunSummarySchema,
  WorkspaceInspectFileSchema,
  WorkspaceInspectRequestSchema,
  WorkspaceInspectResultSchema,
  WorkspaceReadFileRequestSchema,
  WorkspaceReadFileResultSchema,
} from "@rebaseagent/run-query/schema";
export type {
  CompareRunItem,
  CompareRunsRequest,
  CompareRunsResult,
  FailedFile,
  ListRunsData,
  RunDetail,
  RunLineage,
  RunSummary,
  WorkspaceInspectFile,
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceReadFileRequest,
  WorkspaceReadFileResult,
} from "@rebaseagent/run-query/schema";

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
 * 普通 prompt fork 请求：编辑父 run 首次 llm.call 启动上下文中的一项。
 * 与 runs:fork（tool_result 编辑，共享父前缀）语义正交：prompt fork
 * 从头重跑、不共享前缀；一次只允许修改 system_prompt 或 user_message 其一。
 *
 * 隔离 prompt 实验是**显式**的第二分支（`executionMode:"isolated"`）：必须携带
 * 计划指纹与配置修订；缺 mode 的隔离请求不会落到普通分支（两个分支都 strict，
 * 多余/缺失键直接 shape 失败）。普通载荷保持兼容。
 */
/** 单项启动指令编辑（一次只允许一个字段；strict 拒绝组合修改与多余键） */
export const IsolatedPromptEditSchema = z
  .object({
    field: z.enum(["system_prompt", "user_message"]),
    value: z.string(),
  })
  .strict();
export type IsolatedPromptEdit = z.infer<typeof IsolatedPromptEditSchema>;

export const PlainPromptForkRequestSchema = z
  .object({
    parentRunId: z.string().min(1),
    edit: IsolatedPromptEditSchema,
  })
  .strict();
export type PlainPromptForkRequest = z.infer<typeof PlainPromptForkRequestSchema>;

export const IsolatedPromptForkRequestSchema = z
  .object({
    executionMode: z.literal("isolated"),
    parentRunId: z.string().min(1),
    edit: IsolatedPromptEditSchema,
    /** 本次请求的副本写入授权：字面量 true，不继承父 trace 的审计标注 */
    allowFileWrites: z.literal(true),
    /** capability 返回的 opaque 配置修订；main 与当前实际配置比较 */
    expectedConfigRevision: z.string().min(1),
    /** capability 返回的计划指纹；提交时重验完整来源/计划 */
    expectedPlanFingerprint: z.string().min(1),
    hypothesis: z.string().max(4000).optional(),
    acceptanceCriterion: z.string().max(4000).optional(),
  })
  .strict();
export type IsolatedPromptForkRequest = z.infer<typeof IsolatedPromptForkRequestSchema>;

export const PromptForkRequestSchema = z.union([
  IsolatedPromptForkRequestSchema,
  PlainPromptForkRequestSchema,
]);
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

/**
 * 渲染层应用响应前的错配判定（场景「比较拒绝非法身份和错配载荷」的响应半边）：
 * 逐项数量、顺序与 runId 必须与请求一一对应；响应内 runId 不得重复。
 * 返回中文违规原因；null = 与请求相容，可以进渲染层。
 */
export function findCompareResponseMismatch(
  requestIds: readonly string[],
  result: CompareRunsResult,
): string | null {
  if (result.items.length !== requestIds.length) {
    return `响应项数与请求不符：期望 ${requestIds.length}，实际 ${result.items.length}`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < result.items.length; i += 1) {
    const item = result.items[i];
    if (item === undefined) {
      return `响应第 ${i + 1} 项缺失`;
    }
    if (seen.has(item.runId)) {
      return `响应内 run 重复：${item.runId}`;
    }
    seen.add(item.runId);
    const expected = requestIds[i];
    if (item.runId !== expected) {
      return `响应第 ${i + 1} 项身份与请求不符：期望 ${expected ?? "（无）"}，实际 ${item.runId}`;
    }
  }
  return null;
}

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
  /**
   * main 会话 epoch（design D1）。与 `operations:status` 的 epoch 同源，
   * 用途是**新旧会话判别**：renderer 不得用旧 main 的 revision 拒绝新 main 的事实。
   * ⚠️ 它不是凭据、不是指纹，只是一个会话标识。
   */
  epoch: z.string().min(1),
  /**
   * 状态 revision：凭据捕获/更换、监听启停、恢复完成或失败时单调推进。
   * 「同样 hasKey=true 的 key 更换」也推进（见 design D2 的捕获版本语义）。
   */
  revision: z.number().int().min(0),
  /**
   * 记录 revision：**仅成功落盘**推进（recorder.write 失败不推进，见 design D4）。
   * renderer 用它判断"订阅前/失焦期间是否漏了记录"，进而补读列表。
   */
  recordsRevision: z.number().int().min(0),
  /**
   * 凭据捕获版本：**仅内存的捕获次数**（design D2），捕获/更换 key 时单调推进。
   *
   * ⚠️ 它**不是** key 指纹、不是凭据值：渲染层拿到它只能知道"凭据又换过"，
   * 无法反推任何 key  material（llm-proxy delta「状态回读只含 hasKey 与捕获
   * 版本，不含 key、headers、messages」）。
   *
   * 存在的理由：`hasKey` 是布尔，同样 `hasKey=true` 的**更换**不会改变它——
   * 而"用哪个 key 重发"直接决定这次花谁的钱，执行确认必须能因此失效。
   * 它也**不持久化**：重启后 main 不恢复 key，捕获版本回到 0 是事实而非回退。
   */
  keyCaptureRevision: z.number().int().min(0),
  /**
   * 启动恢复阶段（design D3 / tasks 2.3a）：`stopped` / `recovering` / `failed`。
   *
   * ⚠️ 它**不是** `enabled` 的同义词：`enabled` 是保存的意图，`running` 是真实监听，
   * 两者之间还夹着这个阶段——「已启用但正在恢复」「已启用但恢复失败」都不是
   * 「已停用」。渲染层要区分这三者，否则会把"还没恢复完"显示成"用户关了代理"。
   */
  recovery: z.enum(["stopped", "recovering", "failed"]),
  /**
   * 恢复失败的**受控诊断**（脱敏 + 限长，tasks 2.3a）：只保留稳定错误类别与可读原因。
   * - `null` = 当前没有失败事实（未恢复过/ 已恢复成功 / 未尝试）；
   * - 只含脱敏限长文本与类别，**不含** stack、异常对象、headers 或 upstream 地址。
   *
   * 失败**不伪造 enabled 回滚**：`enabled` 保持用户保存的意图，由渲染层把
   * 「已启用但未监听」如实呈现（delta「不把失败说成已停用」）。
   */
  recoveryFailure: z
    .object({
      /** 稳定错误类别（跨平台可比，不含本地化文案） */
      code: z.enum(["PORT_UNAVAILABLE", "LISTEN_FAILED", "UNKNOWN"]),
      /** 脱敏限长后的可读原因 */
      message: z.string().min(1),
    })
    .nullable(),
});
export type ProxyState = z.infer<typeof ProxyStateSchema>;

/**
 * 代理变化类别（design D1）。刻意只有两项：受控元信息，不携带载荷。
 * - `records`：有 run 成功落盘（被动外部请求或主动重发）
 * - `status`：凭据捕获/更换、监听启停、恢复阶段变化
 */
export const PROXY_CHANGE_KINDS = ["records", "status"] as const;
export type ProxyChangeKind = (typeof PROXY_CHANGE_KINDS)[number];

/**
 * `proxy:changed` 的载荷：**只有**会话 epoch、单调 revision 与变化类别。
 *
 * 纪律（design D1 + llm-proxy delta「通知只包含受控元信息」）：
 * - 不含 key、key 指纹、headers、messages、错误体或任何原始异常；
 * - 不创建 operation、不占主动执行槽、不触发模型调用；
 * - `changes` 至少一项——空通知没有意义，main 不该发。
 *
 * `recordsRevision` 一并回传，让 renderer 能在**不额外读状态**的前提下判断
 * "这次通知是否含新的成功落盘"（失焦期间漏读后的补读判据）。
 */
export const ProxyChangeEventSchema = z.object({
  epoch: z.string().min(1),
  revision: z.number().int().min(0),
  recordsRevision: z.number().int().min(0),
  changes: z.array(z.enum(PROXY_CHANGE_KINDS)).min(1),
});
export type ProxyChangeEvent = z.infer<typeof ProxyChangeEventSchema>;

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
  /**
   * 提交这一刻 renderer 看到的**凭据捕获版本**（design D2/tasks 2.2b）。
   *
   * ⚠️ 这是「预期」而不是「事实」：renderer 的 fresh 状态**不替代** main 的检查。
   * 确认到提交之间 main 可能又捕获了新 key（外部应用随时会经过代理），此时
   * main 在**任何副作用之前**（不发上游、不写run）拒绝，要求重新核对。
   * 只传计数，不传凭据本身或任何指纹。
   */
  expectedKeyCaptureRevision: z.number().int().min(0),
  /**
   * 提交这一刻 renderer 看到的代理目标（`upstreamBaseUrl` 与 `port`）。
   *
   * 同上：用户核对时看到的是这台上游，提交前若配置变了（设置往返、
   * 另一个窗口改了代理），这次重发就打去别处 ⇒ 必须重新核对费用归属。
   */
  expectedUpstreamBaseUrl: z.string(),
  expectedPort: z.number().int().min(1).max(65535),
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

// ---------------------------------------------------------------------------
// workspaces:isolatedPromptCapability —— 隔离 prompt 实验只读能力预检（R2.2）
// ---------------------------------------------------------------------------

/** 领域预检失败码（与 replay 包层稳定码一一对应；外层信封失败码另见 handler） */
export const ISOLATED_PROMPT_ERROR_CODES = [
  "invalid_request",
  "parent_not_root",
  "parent_chain_invalid",
  "parent_not_forkable",
  "parent_not_isolated",
  "startup_unavailable",
  "profile_mismatch",
  "source_changed",
  "invalid_edit",
  "empty_edit",
  "config_unreconstructable",
  "initial_snapshot_invalid",
  "attachment_missing",
  "attachment_corrupt",
  "storage_io",
] as const;
export type IsolatedPromptErrorCode = (typeof ISOLATED_PROMPT_ERROR_CODES)[number];

/** 对中文原因的跨进程上限（不透传异常栈/物理路径，有界防伪造超大载荷） */
export const ISOLATED_PROMPT_REASON_MAX = 512;

/**
 * 能力预检请求（**严格只读**）：只接受根 id、一项编辑与可选说明。
 * 刻意没有 model/config/handler/dataDir/allowFileWrites——模型与启动消息来自根事实，
 * 端点/key/限制由 main 当前配置决定；副本写入授权只在正式提交时由当前请求声明。
 */
export const IsolatedPromptCapabilityRequestSchema = z
  .object({
    rootRunId: z.string().min(1),
    edit: IsolatedPromptEditSchema,
    hypothesis: z.string().max(4000).optional(),
    acceptanceCriterion: z.string().max(4000).optional(),
  })
  .strict();
export type IsolatedPromptCapabilityRequest = z.infer<typeof IsolatedPromptCapabilityRequestSchema>;

/** 启动消息的 IPC 形状：首版只允许 system/user + 字符串 content + 可选 name */
export const IsolatedPromptMessageSchema = z
  .object({
    role: z.enum(["system", "user"]),
    content: z.string(),
    name: z.string().optional(),
  })
  .strict();
export type IsolatedPromptMessage = z.infer<typeof IsolatedPromptMessageSchema>;

export const IsolatedPromptExecutionPlanSchema = z
  .object({
    model: z.string().min(1),
    /** 根首次请求的无损标量参数；缺省与显式空对象保持区别 */
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    providerEndpoint: z.string().min(1),
    maxIterations: z.number().int().positive(),
    budget: z
      .object({
        maxTotalTokens: z.number().int().positive(),
        maxCost: z.number().positive().optional(),
      })
      .strict(),
    tokenBudgetSource: z.enum(["recorded", "current"]),
    historicalUnknowns: z.array(z.enum(["provider_backend", "max_iterations", "token_budget"])),
  })
  .strict();
export type IsolatedPromptExecutionPlan = z.infer<typeof IsolatedPromptExecutionPlanSchema>;

const IsolatedPromptSuccessSchema = z
  .object({
    status: z.literal("ok"),
    rootId: z.string().min(1),
    baselineLlmSpanId: z.string().min(1),
    initialSnapshotId: z.string().regex(/^[0-9a-f]{64}$/),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().nonnegative(),
    originalValue: z.string(),
    editedValue: z.string(),
    systemPrompt: z.string(),
    messages: z.array(IsolatedPromptMessageSchema),
    execution: IsolatedPromptExecutionPlanSchema,
    configHash: z.string().min(1),
    planFingerprint: z.string().min(1),
    /** main 会话内 opaque 配置修订（不写 trace/operation，不是可重用授权） */
    configRevision: z.string().min(1),
    hypothesis: z.string().max(4000).optional(),
    acceptanceCriterion: z.string().max(4000).optional(),
    /** 执行前 usage/价格/缓存未知，不得用 0 冒充真实费用 */
    billing: z
      .object({
        usage: z.literal("unknown_until_execution"),
        price: z.literal("unknown"),
        cache: z.literal("unknown"),
      })
      .strict(),
  })
  .strict();

const IsolatedPromptUnavailableSchema = z
  .object({
    status: z.literal("unavailable"),
    code: z.enum(ISOLATED_PROMPT_ERROR_CODES),
    reason: z.string().min(1).max(ISOLATED_PROMPT_REASON_MAX),
    /** 仅 parent_not_root 且父链完整可验证时出现：导航建议，不是执行授权 */
    rootId: z.string().min(1).optional(),
  })
  .strict();

/**
 * capability 结果：领域拒绝是**数据状态**（ok 信封内的 status=unavailable），
 * 请求形状非法/配置读取失败才走失败信封。这样 renderer 能拿到非根时的 rootId 导航建议。
 */
export const IsolatedPromptCapabilityResultSchema = z.discriminatedUnion("status", [
  IsolatedPromptSuccessSchema,
  IsolatedPromptUnavailableSchema,
]);
export type IsolatedPromptCapabilityResult = z.infer<typeof IsolatedPromptCapabilityResultSchema>;

// ---------------------------------------------------------------------------
// workspaces:compareSnapshots / compareFile —— 跨运行检查点比较（R2.2 4.x）
// ---------------------------------------------------------------------------

/** 比较侧 selector：缺省 stepSpanId = 初始快照（不是桌面"最近一步"） */
export const CompareSideSelectorSchema = z
  .object({
    runId: z.string().min(1),
    stepSpanId: z.string().min(1).optional(),
  })
  .strict();
export type CompareSideSelector = z.infer<typeof CompareSideSelectorSchema>;

export const CompareSideFailureCodeSchema = z.enum([
  "invalid_request",
  "run_not_found",
  "trace_invalid",
  "no_workspace",
  "step_not_found",
  "identity_mismatch",
]);
export type CompareSideFailureCode = z.infer<typeof CompareSideFailureCodeSchema>;

export const CompareSideFailureSchema = z
  .object({
    code: CompareSideFailureCodeSchema,
    reason: z.string().min(1).max(COMPARE_REASON_MAX),
  })
  .strict();
export type CompareSideFailure = z.infer<typeof CompareSideFailureSchema>;

export const CompareSideIdentitySchema = z
  .object({
    runId: z.string().min(1),
    stepSpanId: z.string().min(1).nullable(),
    snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
    initialSnapshotId: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type CompareSideIdentity = z.infer<typeof CompareSideIdentitySchema>;

export const CompareSideResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      requestedRunId: z.string().min(1),
      requestedStepSpanId: z.string().min(1).nullable(),
      selected: CompareSideIdentitySchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      requestedRunId: z.string().min(1),
      requestedStepSpanId: z.string().min(1).nullable(),
      failure: CompareSideFailureSchema,
    })
    .strict(),
]);
export type CompareSideResult = z.infer<typeof CompareSideResultSchema>;

export const CompareFileReferenceSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type CompareFileReference = z.infer<typeof CompareFileReferenceSchema>;

export const ComparePathEntrySchema = z
  .object({
    path: z.string().min(1),
    presence: z.enum(["both", "left_only", "right_only"]),
    left: CompareFileReferenceSchema.nullable(),
    right: CompareFileReferenceSchema.nullable(),
    reference: z.enum(["same", "different"]).nullable(),
  })
  .strict();
export type ComparePathEntry = z.infer<typeof ComparePathEntrySchema>;

export const CompareWorkspaceSnapshotsRequestSchema = z
  .object({
    left: CompareSideSelectorSchema,
    right: CompareSideSelectorSchema,
  })
  .strict();
export type CompareWorkspaceSnapshotsRequest = z.infer<
  typeof CompareWorkspaceSnapshotsRequestSchema
>;

export const CompareWorkspaceSnapshotsResultSchema = z
  .object({
    left: CompareSideResultSchema,
    right: CompareSideResultSchema,
    unionComplete: z.boolean(),
    entries: z.array(ComparePathEntrySchema),
  })
  .strict();
export type CompareWorkspaceSnapshotsResult = z.infer<typeof CompareWorkspaceSnapshotsResultSchema>;

export const ExpectedSnapshotIdsSchema = z
  .object({
    left: z.string().regex(/^[0-9a-f]{64}$/),
    right: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ExpectedSnapshotIds = z.infer<typeof ExpectedSnapshotIdsSchema>;

export const CompareWorkspaceFileRequestSchema = z
  .object({
    left: CompareSideSelectorSchema,
    right: CompareSideSelectorSchema,
    path: z.string().min(1),
    expectedSnapshotIds: ExpectedSnapshotIdsSchema,
  })
  .strict();
export type CompareWorkspaceFileRequest = z.infer<typeof CompareWorkspaceFileRequestSchema>;

const ComparedFileBase = {
  path: z.string().min(1),
} as const;

export const ComparedFileSideSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("text"),
      ...ComparedFileBase,
      file: CompareFileReferenceSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("binary"),
      ...ComparedFileBase,
      /** 二进制只给哈希/大小，不跨进程传字节，也不生成文本 diff */
      file: CompareFileReferenceSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_found"),
      ...ComparedFileBase,
      reason: z.string().max(COMPARE_REASON_MAX),
    })
    .strict(),
  z
    .object({
      status: z.literal("missing"),
      ...ComparedFileBase,
      file: CompareFileReferenceSchema,
      reason: z.string().max(COMPARE_REASON_MAX),
    })
    .strict(),
  z
    .object({
      status: z.literal("corrupt"),
      ...ComparedFileBase,
      file: CompareFileReferenceSchema,
      reason: z.string().max(COMPARE_REASON_MAX),
    })
    .strict(),
  z
    .object({
      status: z.literal("too_large"),
      ...ComparedFileBase,
      file: CompareFileReferenceSchema,
      reason: z.string().max(COMPARE_REASON_MAX),
    })
    .strict(),
  z
    .object({
      status: z.literal("io"),
      ...ComparedFileBase,
      file: CompareFileReferenceSchema,
      reason: z.string().max(COMPARE_REASON_MAX),
    })
    .strict(),
  z
    .object({
      status: z.literal("selection_changed"),
      ...ComparedFileBase,
      expectedSnapshotId: z.string().min(1),
      actualSnapshotId: z.string().min(1),
      reason: z.string().max(COMPARE_REASON_MAX),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      ...ComparedFileBase,
      failure: CompareSideFailureSchema,
    })
    .strict(),
]);
export type ComparedFileSide = z.infer<typeof ComparedFileSideSchema>;

export const ComparedWorkspaceFileResultSchema = z
  .object({
    path: z.string().min(1),
    left: ComparedFileSideSchema,
    right: ComparedFileSideSchema,
    conclusion: z.enum([
      "same",
      "different",
      "left_only",
      "right_only",
      "not_found",
      "unavailable",
    ]),
    textDiffEligible: z.boolean(),
  })
  .strict();
export type ComparedWorkspaceFileResult = z.infer<typeof ComparedWorkspaceFileResultSchema>;

// ---------------------------------------------------------------------------
// workspaces:export —— 导出选定检查点（R2.1；唯一显式写目标目录的 workspaces 通道）
// ---------------------------------------------------------------------------

/**
 * 导出请求：只接 `runId` 与可选 `stepSpanId`（省略 = 本 run 初始快照）。
 * `.strict()` 钉死封闭形状——dataDir/source/blob/targetDir 等物理路径键一律拒绝：
 * 目标目录只能由 main 的原生对话框取得，renderer 永不写物理路径。
 */
export const WorkspaceExportRequestSchema = z
  .object({
    runId: z.string().min(1),
    stepSpanId: z.string().min(1).optional(),
  })
  .strict();
export type WorkspaceExportRequest = z.infer<typeof WorkspaceExportRequestSchema>;

/** 补丁逐路径排除原因（与包层 ExportPatchExcludedReason 同枚举，跨进程钉死） */
export const WORKSPACE_EXPORT_EXCLUDED_REASONS = [
  "binary",
  "deletion",
  "baseline_missing",
  "baseline_corrupt",
  "baseline_io",
] as const;

/** 补丁三态（包层 ExportPatchPlan 的跨进程裁剪：只有 written 携带补丁文件事实） */
export const WorkspaceExportPatchSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("written"),
    file: z.literal("changes.patch"),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** 补丁覆盖的逻辑路径（UTF-16 码元序） */
    covered: z.array(z.string().min(1)),
    /** 未覆盖变化（二进制/删除等）逐路径原因 */
    excluded: z.array(
      z.object({
        path: z.string().min(1),
        reason: z.enum(WORKSPACE_EXPORT_EXCLUDED_REASONS),
      }),
    ),
  }),
  z.object({
    status: z.literal("no_text_changes"),
    covered: z.array(z.string().min(1)),
    excluded: z.array(
      z.object({
        path: z.string().min(1),
        reason: z.enum(WORKSPACE_EXPORT_EXCLUDED_REASONS),
      }),
    ),
  }),
  z.object({
    status: z.literal("not_available"),
    covered: z.array(z.string().min(1)),
    excluded: z.array(
      z.object({
        path: z.string().min(1),
        reason: z.enum(WORKSPACE_EXPORT_EXCLUDED_REASONS),
      }),
    ),
    /** not_available 的整体原因（超限/基线不可用）；仅有排除项时为 null */
    reason: z.string().min(1).nullable(),
  }),
]);
export type WorkspaceExportPatch = z.infer<typeof WorkspaceExportPatchSchema>;

/** 六类未保留状态：文案由包层固定（"未保留（原状态未知）"），schema 钉死六键 */
export const WorkspaceUnpreservedSchema = z.object({
  permissions: z.string().min(1),
  executable_bit: z.string().min(1),
  timestamps: z.string().min(1),
  links: z.string().min(1),
  empty_directories: z.string().min(1),
  external_services: z.string().min(1),
});
export type WorkspaceUnpreserved = z.infer<typeof WorkspaceUnpreservedSchema>;

/**
 * 导出结局（判别式，永不让异常跨越进程边界）：
 * - `canceled`：用户取消目录选择，零写入；
 * - `exported`：完整导出成功（目标/files/、数量/字节、补丁三态、未保留说明）；
 * - `failed`：业务拒绝或写入失败。`code` 是稳定码：来源检查用 main 既有
 *   `RUN_LINEAGE_INCOMPLETE` / `RUN_DETAIL_UNREADABLE`，其余透传包层失败码
 *   （target_invalid / target_conflicts_data_dir / target_race / attachment_unavailable /
 *   io / step_not_found / no_workspace / invalid_request / run_not_found / trace_invalid）；
 *   main 在飞保护用 `WORKSPACE_EXPORT_IN_FLIGHT`；兜底 `WORKSPACE_EXPORT_FAILED`。
 *   `retained` 是清理未完成时的残留相对路径（相对目标目录），完整清理为空数组。
 */
export const WorkspaceExportOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("canceled") }),
  z.object({
    status: z.literal("exported"),
    /** 实际目标目录（main 侧 realpath 归一后的绝对路径） */
    targetDir: z.string().min(1),
    filesRoot: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
    /** 全部文件字节数（不含清单/补丁等元信息） */
    totalFileBytes: z.number().nonnegative(),
    snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
    /** null = 初始快照 */
    stepSpanId: z.string().min(1).nullable(),
    patch: WorkspaceExportPatchSchema,
    unpreserved: WorkspaceUnpreservedSchema,
  }),
  z.object({
    status: z.literal("failed"),
    code: z.string().min(1),
    reason: z.string().min(1),
    retained: z.array(z.string().min(1)),
  }),
]);
export type WorkspaceExportOutcome = z.infer<typeof WorkspaceExportOutcomeSchema>;

/* ------------------------------------------------------------------ *
 * U3 关闭协商协议（design D6）：main 持有决策，renderer 只报告元数据。
 *
 * 纪律：
 * - 所有载荷都是**纯元数据**——草稿正文、run 内容、sourceToken、授权、apiKey
 *   一律不出现在任何消息里（凭据与草稿分离，场景「旧会话伪造发送者和乱序消息
 *   不影响关闭」同时要求"不传输草稿正文、sourceToken、授权或凭据"）；
 * - 计数是有界非负整数（拒绝 NaN / 负数 / 超界 / 非整数的伪造载荷）；
 * - schema 校验只发生在 main 侧（preload 在 sandbox 下不能引入 zod），
 *   renderer 侧代码可以（也应当）复用这里的类型。
 * ------------------------------------------------------------------ */

/** 协议计数字段（dirtyCount）的 schema 上限：有界非负整数，防伪造超大载荷 */
export const DRAFT_CLOSE_DIRTY_MAX = 1_000_000;
/** 协议序号字段（sequence）的 schema 上限：renderer 会话内单调递增的消息计数 */
export const DRAFT_CLOSE_SEQUENCE_MAX = Number.MAX_SAFE_INTEGER;
/** 会话 / 请求 id 的长度上限（uuid 为 36 字符，留余量） */
export const DRAFT_CLOSE_ID_MAX = 128;

const DraftCloseIdSchema = z.string().min(1).max(DRAFT_CLOSE_ID_MAX);

/** main → renderer（did-finish-load 后推送）：本文档会话的 id（renderer 侧可丢弃，握手 invoke 兜底） */
export const DraftCloseSessionPayloadSchema = z.object({
  sessionId: DraftCloseIdSchema,
});
export type DraftCloseSessionPayload = z.infer<typeof DraftCloseSessionPayloadSchema>;

/** main → renderer：关闭查询。应答只认当前 requestId（迟到的旧应答一律拒绝） */
export const DraftCloseQuerySchema = z.object({
  sessionId: DraftCloseIdSchema,
  requestId: DraftCloseIdSchema,
});
export type DraftCloseQuery = z.infer<typeof DraftCloseQuerySchema>;

/**
 * renderer → main：dirty 元数据上报（单向 send，无应答）。
 * `sequence` 是 renderer 会话内单调递增的消息序号——main 拒绝 ≤ 已接受序号的消息（乱序防护）。
 */
export const DraftCloseReportSchema = z.object({
  sessionId: DraftCloseIdSchema,
  sequence: z.number().int().min(0).max(DRAFT_CLOSE_SEQUENCE_MAX),
  dirtyCount: z.number().int().min(0).max(DRAFT_CLOSE_DIRTY_MAX),
});
export type DraftCloseReport = z.infer<typeof DraftCloseReportSchema>;

/**
 * renderer → main：关闭查询应答（单向 send）。
 * `inputSettled=true` 表示：锁前已接收输入完成同步进 store，且没有待收尾的输入法组合。
 * false 或应答缺失都**不得**当作 clean。
 */
export const DraftCloseAnswerSchema = DraftCloseReportSchema.extend({
  requestId: DraftCloseIdSchema,
  inputSettled: z.boolean(),
});
export type DraftCloseAnswer = z.infer<typeof DraftCloseAnswerSchema>;

/**
 * main → renderer：本次关闭决定已出（取消或完成）。renderer 收到后解除输入锁并
 * 恢复编辑焦点；与查询的 requestId 匹配才生效（旧查询的 release 不解锁新核对）。
 */
export const DraftCloseReleaseSchema = z.object({
  sessionId: DraftCloseIdSchema,
  requestId: DraftCloseIdSchema,
});
export type DraftCloseRelease = z.infer<typeof DraftCloseReleaseSchema>;

/**
 * preload 暴露给渲染层的受限接口。
 *
 * 两类通道形状不同（U4 之后的契约）：
 * - **主动执行**（`forkRun` / `promptFork` / `modelAb` / `createRun` / `proxyFork`）：
 *   请求是 `{operation:{epoch,operationId}, request}`，响应两个分支都带登记回执。
 *   main 在判重与占槽之后才开始任何副作用；缺身份、旧 epoch 或在途重复提交一律不执行。
 * - **只读与预览**（取数、`compareRuns`（U7 只读比较）、`chooseSource` / `forkCapability` /
 *   `inspectWorkspace` / `readWorkspaceFile`、`modelAbPlan`、`getSettings` / `proxyStatus`、
 *   `operationsStatus`）：
 *   不带执行身份、不占主动槽、不消耗授权。
 *
 * A/B 的 dryRun 走 `modelAbPlan` —— `modelAb` 收到 `dryRun:true` 会被拒（两条分支不混用）。
 * settings 写通道与代理启停由 main 判锁；apiKey / 代理 key 均单向进入 main，永不回传。
 */
export interface WindowApi {
  listRuns(): Promise<Envelope<ListRunsData>>;
  getRun(id: string): Promise<Envelope<RunDetail>>;
  /**
   * 只读比较（U7 design D3）：一次带 1–4 个互异 run id，main 在单次读取上下文内
   * 逐项回 ready/unavailable；不带执行身份、不占主动槽、不消耗授权。
   * 请求形状非法走信封失败；单侧读取失败是数据状态，仍以 ok 信封逐项返回。
   */
  compareRuns(request: CompareRunsRequest): Promise<Envelope<CompareRunsResult>>;
  forkRun(request: ExecutedRequest<ForkRunRequest>): Promise<ExecutedResponse<ForkRunResult>>;
  promptFork(
    request: ExecutedRequest<PromptForkRequest>,
  ): Promise<ExecutedResponse<PromptForkResult>>;
  /** A/B 真实执行：整批占一个主动槽（dry-run 请用 `modelAbPlan`） */
  modelAb(request: ExecutedRequest<ModelAbRequest>): Promise<ExecutedResponse<ModelAbResult>>;
  /** A/B 计划预览：只读、零网络、零文件、不占主动槽，因而**不**要求执行身份 */
  modelAbPlan(request: ModelAbRequest): Promise<Envelope<ModelAbResult>>;
  createRun(request: ExecutedRequest<CreateRunRequest>): Promise<ExecutedResponse<CreateRunResult>>;
  /**
   * R3 环境准备（4.2）：主动执行通道——登记 verificationPrepare 目标并关联真实
   * preparationId；准备与测试分开确认，计划 token 漂移 ⇒ 零副作用拒绝（P07/D02）。
   */
  verificationPrepare(
    request: ExecutedRequest<VerificationPrepareRequest>,
  ): Promise<ExecutedResponse<VerificationPrepareResult>>;
  /**
   * R3 项目验证执行（4.2）：一次确认执行一次；领域结局（D6 九行表）随 returned
   * 数据返回（D04 分层），runIds 恒空——领域身份不冒充 Agent run（M01）。
   */
  verificationRun(
    request: ExecutedRequest<VerificationRunRequest>,
  ): Promise<ExecutedResponse<VerificationRunResult>>;
  /** 原生目录选择：只签发会话 token，不导入、不写 trace/blob；取消返回 {canceled:true} */
  chooseSource(): Promise<Envelope<ChooseSourceResult>>;
  /**
   * 隔离分叉的只读能力预检（确认区数据源）：不创建运行、不写文件、不请求模型。
   * 失败（历史 run 无检查点 / 附件不可用 / 非隔离父本等）返回可操作的错误信封。
   */
  forkCapability(request: ForkCapabilityRequest): Promise<Envelope<ForkCapabilityResult>>;
  /**
   * 隔离 prompt 实验的只读能力预检（R2.2）：不创建运行、不写文件、不请求模型、
   * 不登记 operation。领域拒绝以 ok 信封里的 status=unavailable 返回（含 rootId 导航建议）。
   */
  isolatedPromptCapability(
    request: IsolatedPromptCapabilityRequest,
  ): Promise<Envelope<IsolatedPromptCapabilityResult>>;
  /**
   * 两个自有检查点的清单比较（只读）：缺省 stepSpanId=初始；单侧失败是数据状态，
   * 两侧都可用时才给出完整路径并集与清单引用状态。
   */
  compareWorkspaceSnapshots(
    request: CompareWorkspaceSnapshotsRequest,
  ): Promise<Envelope<CompareWorkspaceSnapshotsResult>>;
  /**
   * 比较并集内某条路径的正文（只读）：按 path 延迟核验字节；
   * expectedSnapshotIds 不符时逐侧 selection_changed，不拼旧清单与新正文。
   */
  readComparedWorkspaceFile(
    request: CompareWorkspaceFileRequest,
  ): Promise<Envelope<ComparedWorkspaceFileResult>>;
  /** 文件检查点清单（只读）：省略 stepSpanId 取本 run 初始快照；不写任何文件、不调 LLM */
  inspectWorkspace(request: WorkspaceInspectRequest): Promise<Envelope<WorkspaceInspectResult>>;
  /** 读取清单内某条逻辑路径的文本（只读）：二进制/不存在/缺失/损坏各自可辨认 */
  readWorkspaceFile(request: WorkspaceReadFileRequest): Promise<Envelope<WorkspaceReadFileResult>>;
  /**
   * 导出选定检查点（R2.1）：请求只带 runId/可选 stepSpanId，目标目录由 main 的原生
   * 对话框取得。成功/取消/失败都以 ok 信封里的判别式 outcome 返回；信封失败只留给
   * 请求形状非法。不登记 operation、不占主动槽、不消费授权。
   */
  exportCheckpoint(request: WorkspaceExportRequest): Promise<Envelope<WorkspaceExportOutcome>>;
  getSettings(): Promise<Envelope<SettingsState>>;
  saveSettings(input: SettingsInput): Promise<Envelope<{ configured: true }>>;
  clearSettings(): Promise<Envelope<{ configured: false }>>;
  proxyStatus(): Promise<Envelope<ProxyState>>;
  proxyToggle(input: ProxyToggleInput): Promise<Envelope<ProxyState>>;
  proxyFork(request: ExecutedRequest<ProxyForkRequest>): Promise<ExecutedResponse<ProxyForkResult>>;
  /**
   * 订阅代理事实变化（design D1）：成功落盘、凭据捕获/更换、监听启停、恢复结果。
   *
   * 载荷只含 epoch/revision/recordsRevision 与受控类别（见 `ProxyChangeEventSchema`），
   * **不含** key、headers、messages 或错误体；订阅本身不创建 operation、不占执行槽。
   * 返回解绑函数（renderer 卸载时必须调用，否则监听器泄漏）。
   */
  onProxyChanged(listener: (event: ProxyChangeEvent) => void): () => void;
  /* ---- U3 关闭协商（design D6）：受限报告与订阅/解绑，不暴露 ipcRenderer ---- */
  /**
   * 关闭协商握手：renderer 挂载后调用，取当前文档会话 id；
   * main 据此把该文档会话标记为「已完成握手」（未握手的会话在关闭时走 unknown 降级）。
   */
  draftCloseHandshake(): Promise<Envelope<DraftCloseSessionPayload>>;
  /** 向 main 上报 dirty 元数据（单向 send，无应答；载荷只含元数据） */
  draftCloseReport(report: DraftCloseReport): void;
  /** 应答 main 的关闭查询（单向 send；main 只认当前 requestId） */
  draftCloseAnswer(answer: DraftCloseAnswer): void;
  /** 订阅文档会话 id 推送（did-finish-load 后）；返回解绑函数 */
  onDraftCloseSession(listener: (payload: DraftCloseSessionPayload) => void): () => void;
  /** 订阅关闭查询；返回解绑函数 */
  onDraftCloseQuery(listener: (query: DraftCloseQuery) => void): () => void;
  /** 订阅关闭决定释放（取消/完成后解锁）；返回解绑函数 */
  onDraftCloseRelease(listener: (release: DraftCloseRelease) => void): () => void;
  /* ---- U4 操作登记（design D4/D6）：状态查询与原子核对，都不执行业务 ---- */
  /**
   * 只读握手 / 快照：返回 main 当前 epoch、单调登记版本、活跃槽、配置变更与关闭标记，
   * 以及本会话全部操作的受限元数据（含 settled 与 notAccepted 封禁）。
   */
  operationsStatus(): Promise<Envelope<OperationStatusResult>>;
  /**
   * 按 epoch/operationId 原子核对：已有登记返回真实状态，从未接受的 ID 建立永久封禁。
   * 不读 run 文件、不消费授权——按 ID 看记录仍走 getRun 的详情版本守卫。
   */
  operationsReconcile(request: ReconcileRequest): Promise<Envelope<ReconcileResult>>;
}

// ---------------------------------------------------------------------------
// verification:prepare / verification:run —— R3 环境准备与项目验证（design D3）
// ---------------------------------------------------------------------------

/** R3 检查点定位（渲染侧显式二选一，UI 不得无声换点；与包层 selector 同构） */
export const VerificationCheckpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initial") }).strict(),
  z.object({ kind: z.literal("step"), stepSpanId: z.string().min(1) }).strict(),
]);
export type VerificationCheckpoint = z.infer<typeof VerificationCheckpointSchema>;

/**
 * verification:prepare 请求：检查点定位（进目标摘要）+ 当前准备计划 token +
 * 显式授权。物理路径/镜像/env/限额无字段可传（P08）；`allowPrepare` 必须显式
 * true（P04：与测试授权分开，历史确认不延续）。
 */
export const VerificationPrepareRequestSchema = z
  .object({
    target: z
      .object({
        runId: z.string().min(1),
        checkpoint: VerificationCheckpointSchema,
      })
      .strict(),
    profileId: z.literal("node-ts-v1"),
    planToken: z.string().min(1),
    allowPrepare: z.literal(true),
  })
  .strict();
export type VerificationPrepareRequest = z.infer<typeof VerificationPrepareRequestSchema>;

/** verification:prepare 结果：真实创建的准备记录身份 + 镜像事实（P04/P08） */
export const VerificationPrepareResultSchema = z
  .object({
    preparationId: z.string().min(1),
    imageDigest: z.string().min(1),
    toolchain: z.object({ node: z.string().min(1), typescript: z.string().min(1) }).strict(),
    recordPath: z.string().min(1),
  })
  .strict();
export type VerificationPrepareResult = z.infer<typeof VerificationPrepareResultSchema>;

/**
 * verification:run 请求：精确 selector + 枚举命令 + 当前计划 token + 显式授权
 * （P07/P08：命令仅枚举、镜像/路径/env/限额无处可传——main 从已准备记录解析镜像）。
 */
export const VerificationRunRequestSchema = z
  .object({
    target: z
      .object({
        runId: z.string().min(1),
        checkpoint: VerificationCheckpointSchema,
      })
      .strict(),
    profileId: z.literal("node-ts-v1"),
    commandId: z.enum(["typecheck", "test"]),
    planToken: z.string().min(1),
    allowExecution: z.literal(true),
  })
  .strict();
export type VerificationRunRequest = z.infer<typeof VerificationRunRequestSchema>;

/**
 * verification:run 结果：请求收尾与测试结局**分层**（D04）——`outcome` 是测试/
 * 环境事实（D6 九行表），不等于请求结局；请求层成败由信封与登记回执表达。
 */
export const VerificationRunResultSchema = z
  .object({
    verificationId: z.string().min(1),
    outcome: z.enum([
      "check_failed",
      "passed",
      "environment_failed",
      "start_failed",
      "process_failed",
      "timed_out",
      "output_limit",
      "cancelled",
      "artifact_invalid",
      "evidence_incomplete",
      "unknown",
    ]),
    detail: z.string().min(1),
    evidenceComplete: z.boolean(),
    recordPath: z.string().min(1),
  })
  .strict();
export type VerificationRunResult = z.infer<typeof VerificationRunResultSchema>;
