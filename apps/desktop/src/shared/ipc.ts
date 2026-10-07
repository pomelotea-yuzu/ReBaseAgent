import {
  ForkSchema,
  RunEventSchema,
  RunMetaSchema,
  SpanSchema,
} from "@rebaseagent/trace-sdk/schema";
import { z } from "zod";
import { CHANNELS } from "./channels";
import type {
  ExecutedRequest,
  ExecutedResponse,
  OperationStatusResult,
  ReconcileRequest,
  ReconcileResult,
} from "./operations";
import { findRunDetailIntegrityViolation } from "./run-detail-integrity";

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

/**
 * 来源完整性 lineage：complete 恒不带缺失字段；incomplete 只允许
 * ANCESTOR_NOT_FOUND 且必须携带 missingRunId（strict 拒绝未知形态）。
 */
export const RunLineageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete") }).strict(),
  z
    .object({
      status: z.literal("incomplete"),
      reason: z.literal("ANCESTOR_NOT_FOUND"),
      missingRunId: z.string().min(1),
    })
    .strict(),
]);
export type RunLineage = z.infer<typeof RunLineageSchema>;

/**
 * run 详情：分支 run 返回的是 resolveBranch 解析后的完整轨迹。
 *
 * U6 起详情携带受校验的完整性元数据（completeness/spanScope/lineage）：
 * main 依据已校验 fork 类型生成，renderer 不从 chain 长度猜完整性；
 * `own` 不代表降级。载荷内一致性由 superRefine 判定（判据见
 * `run-detail-integrity.ts`，main 自检与 renderer 两处入口共用）。
 */
const RunDetailObjectSchema = z.object({
  meta: RunMetaSchema,
  spans: z.array(SpanSchema),
  events: z.array(RunEventSchema),
  status: z.enum(["completed", "crashed"]),
  /** 祖先链（从最早可读 hop 到本 run）；ownOnly 时在缺失点截断 */
  chain: z.array(ChainHopSchema),
  /** 当前 run（叶子）自身新增 span 的 id（在合并轨迹中区分"自己"与"继承的祖先前缀"） */
  leafSpanIds: z.array(z.string()),
  /** complete = 全链校验通过；ownOnly = 祖先文件确实缺失（只读当前已校验自有记录） */
  completeness: z.enum(["complete", "ownOnly"]),
  /** resolved = 轨迹含已合并的祖先前缀；own = 只有本 run 自有轨迹（独立执行不是降级） */
  spanScope: z.enum(["resolved", "own"]),
  lineage: RunLineageSchema,
});

export const RunDetailSchema = RunDetailObjectSchema.superRefine((detail, ctx) => {
  const violation = findRunDetailIntegrityViolation(detail);
  if (violation !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation, path: ["completeness"] });
  }
});
export type RunDetail = z.infer<typeof RunDetailObjectSchema>;

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
// runs:compare —— 只读比较（U7 design D3）：1–4 个互异 run id 的一次受校验读取
// ---------------------------------------------------------------------------

/** 比较对象数量边界（与既有指标对照的上限一致；单条也允许，用于单侧自有事实阅读） */
export const COMPARE_RUN_MIN = 1;
export const COMPARE_RUN_MAX = 4;
/** 逐项不可用结论的受控码长度上限（与 operations 的稳定码口径一致） */
export const COMPARE_CODE_MAX = 64;
/** 逐项不可用受控中文原因长度上限（不透传路径/errno/堆栈，有界防伪造超大载荷） */
export const COMPARE_REASON_MAX = 512;

/**
 * 比较请求：数量 1–4、互异、非空。越界路径（穿越/绝对路径/分隔符）等非法 run 标识
 * 的形状校验在 main 侧读取前拒绝（`findIllegalRunIdViolation`）——schema 只钉跨进程
 * 结构，不复制路径判据。
 */
export const CompareRunsRequestSchema = z
  .object({
    runIds: z
      .array(z.string().min(1, "run 标识不能为空"))
      .min(COMPARE_RUN_MIN, `比较至少需要 ${COMPARE_RUN_MIN} 个运行`)
      .max(COMPARE_RUN_MAX, `比较最多 ${COMPARE_RUN_MAX} 个运行`),
  })
  .strict()
  .superRefine((request, ctx) => {
    const seen = new Set<string>();
    for (const id of request.runIds) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `比较对象重复：${id}`,
          path: ["runIds"],
        });
        return;
      }
      seen.add(id);
    }
  });
export type CompareRunsRequest = z.infer<typeof CompareRunsRequestSchema>;

/**
 * 逐项结果：ready 携带与 runs:get 同一 schema 的已校验详情（完整性标签随 detail
 * 自带，ownOnly 不在比较层二次降级）+ 沿链各物理 run 的**自有摘要**（根→叶有序、
 * 含当前 run；每条由对应物理记录现算——共同祖先/累计派生的唯一合法输入，
 * 禁止回退列表缓存）；unavailable 携带稳定码与受控中文原因——该侧真实身份保留，
 * 不伪空文本、不借另一对象顶替。
 */
export const CompareRunItemSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      runId: z.string().min(1),
      detail: RunDetailSchema,
      chainSummaries: z.array(RunSummarySchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      runId: z.string().min(1),
      code: z.string().min(1).max(COMPARE_CODE_MAX),
      reason: z.string().min(1).max(COMPARE_REASON_MAX),
    })
    .strict(),
]);
export type CompareRunItem = z.infer<typeof CompareRunItemSchema>;

export const CompareRunsResultSchema = z
  .object({
    items: z.array(CompareRunItemSchema).min(COMPARE_RUN_MIN).max(COMPARE_RUN_MAX),
  })
  .strict();
export type CompareRunsResult = z.infer<typeof CompareRunsResultSchema>;

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
// workspaces:inspect / workspaces:readFile —— 文件检查点与差异（只读；C 1.1）
// ---------------------------------------------------------------------------

/**
 * 清单定位请求：`stepSpanId` 省略 = 本 run 的**初始快照**；指定时只能是该 run
 * **自有**的已完成 `agent.step`（祖先步骤由 A 包拒绝，main 不代填）。
 * renderer 不得传物理路径或存储根——本请求连字段都没有。
 */
export const WorkspaceInspectRequestSchema = z.object({
  runId: z.string().min(1),
  stepSpanId: z.string().min(1).optional(),
});
export type WorkspaceInspectRequest = z.infer<typeof WorkspaceInspectRequestSchema>;

/** 清单里的一条文件：路径、大小、相对初始快照的状态、附件可用性与来源 */
export const WorkspaceInspectFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** 附件内容哈希（64 位小写 hex，裸值无前缀） */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * 相对**本 run 初始快照**的状态：
   * - `added` = 初始清单里没有这条路径
   * - `modified` = 初始清单里有，但内容哈希不同
   * - `unchanged` = 初始清单里有且哈希相同
   * - `initial` = 当前查看的就是初始快照本身（没有"相对"可谈）
   * 判据只有「路径 + 哈希」——不使用 mtime（快照不含时间戳）。
   */
  change: z.enum(["added", "modified", "unchanged", "initial"]),
  /**
   * 附件可用性：`ok` = 磁盘上存在且长度与哈希都对得上；
   * `missing` = 清单引用了但磁盘上没有；`corrupt` = 存在但长度或哈希不符。
   * 三者必须可分辨——缺失/损坏不得渲染成空文件。
   */
  availability: z.enum(["ok", "missing", "corrupt"]),
  /** 不可用时的可读原因（ok 时为 null） */
  unavailableReason: z.string().nullable(),
});
export type WorkspaceInspectFile = z.infer<typeof WorkspaceInspectFileSchema>;

/**
 * 检查点定位（选择器的数据源）。
 *
 * `localIteration` 是该 step **所属 run 自己的** `agent.step.n`——绝不按合并轨迹沿链累加。
 * 初始快照的 `stepSpanId` / `localIteration` 均为 null（它不是"某一轮结束"）。
 * `origin` 说明这份快照从哪来：根 run 为导入，分支 run 为父 run 某轮检查点。
 */
export const WorkspaceInspectResultSchema = z.object({
  runId: z.string().min(1),
  /** null = 初始快照 */
  stepSpanId: z.string().min(1).nullable(),
  /** 快照 id（裸 64 位 hex） */
  snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
  /** 所属 run id（= 检查点所有者；显式保留以固定 {ownerRunId,stepSpanId,localIteration} 三元组） */
  ownerRunId: z.string().min(1),
  /** 本地轮号 = 该 step 的原始 agent.step.n；初始快照为 null */
  localIteration: z.number().int().positive().nullable(),
  profile: z.string().min(1),
  worldId: z.string().min(1),
  origin: z.union([
    z.object({ kind: z.literal("import") }),
    z.object({
      kind: z.literal("checkpoint"),
      runId: z.string().min(1),
      /** 来源（父 run）那次检查点所在的 step span id */
      stepSpanId: z.string().min(1),
    }),
  ]),
  files: z.array(WorkspaceInspectFileSchema),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  /** 不可用附件数（missing + corrupt），供列表顶部汇总 */
  unavailableCount: z.number().int().nonnegative(),
  /** 初始快照 id（分支 run 用来判定"相对初始"；初始快照本身即等于 snapshotId） */
  initialSnapshotId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type WorkspaceInspectResult = z.infer<typeof WorkspaceInspectResultSchema>;

/**
 * 文件读取请求：清单定位 + **逻辑路径**（不是物理路径）。
 * `path` 必须属于所选清单；越权或清单外路径由 main 与 A 包一并拒绝。
 */
export const WorkspaceReadFileRequestSchema = z.object({
  runId: z.string().min(1),
  stepSpanId: z.string().min(1).optional(),
  path: z.string().min(1),
});
export type WorkspaceReadFileRequest = z.infer<typeof WorkspaceReadFileRequestSchema>;

/**
 * 文件读取结果（判别式联合，与 A 包 `WorkspaceFileReadResult` 同形但去掉字节数组——
 * 二进制只需要大小/哈希，**不跨进程传字节**，避免把整份附件塞进 IPC 载荷）。
 *
 * 六态必须可分辨：`text` / `binary` / `not_found`（清单里没有这条路径）/
 * `missing`（清单有但附件不在）/ `corrupt`（附件与哈希不符）/ `rejected`（请求本身不成立）。
 * 无文本的一侧在 diff 里标作"不存在"，不得当空文本。
 */
export const WorkspaceReadFileResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("text"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string(),
  }),
  z.object({
    status: z.literal("binary"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({ status: z.literal("not_found"), path: z.string().min(1), reason: z.string() }),
  z.object({
    status: z.literal("missing"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("corrupt"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("rejected"),
    code: z.string().min(1),
    reason: z.string(),
  }),
]);
export type WorkspaceReadFileResult = z.infer<typeof WorkspaceReadFileResultSchema>;

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
  /** 原生目录选择：只签发会话 token，不导入、不写 trace/blob；取消返回 {canceled:true} */
  chooseSource(): Promise<Envelope<ChooseSourceResult>>;
  /**
   * 隔离分叉的只读能力预检（确认区数据源）：不创建运行、不写文件、不请求模型。
   * 失败（历史 run 无检查点 / 附件不可用 / 非隔离父本等）返回可操作的错误信封。
   */
  forkCapability(request: ForkCapabilityRequest): Promise<Envelope<ForkCapabilityResult>>;
  /** 文件检查点清单（只读）：省略 stepSpanId 取本 run 初始快照；不写任何文件、不调 LLM */
  inspectWorkspace(request: WorkspaceInspectRequest): Promise<Envelope<WorkspaceInspectResult>>;
  /** 读取清单内某条逻辑路径的文本（只读）：二进制/不存在/缺失/损坏各自可辨认 */
  readWorkspaceFile(request: WorkspaceReadFileRequest): Promise<Envelope<WorkspaceReadFileResult>>;
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
