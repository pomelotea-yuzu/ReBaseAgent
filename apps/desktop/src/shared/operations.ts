import { z } from "zod";

/**
 * U4 操作登记契约（design D1/D2/D4）：执行 envelope、操作判别联合、目标/臂摘要
 * 与 status/reconcile 快照。main 与 renderer 共用——两侧都必须先校验后采信。
 *
 * 三条贯穿全文件的纪律：
 * 1. **只放受限元数据**：任务正文、messages 内容、编辑值、sourceToken、授权值、
 *    apiKey、原始 Error/stack 一律没有对应字段（schema 是 strict 的，多一个字段即非法）；
 * 2. **状态联合自洽**：running/settled/notAccepted 各自允许与禁止哪些字段，
 *    写进 schema 级精炼，而不只靠注释——这样「非法操作响应不能解除门禁」有机器判据；
 * 3. **长度有界**：id / 错误码 / 诊断文案 / 列表都有上限，防止失控载荷进入 IPC。
 */

/** 会话 id（epoch）与 operationId 共用的形状上限（uuid 为 36 字符，留余量） */
export const OPERATION_ID_MAX = 128;
/** 稳定错误码与诊断码的长度上限 */
export const OPERATION_CODE_MAX = 64;
/** 单条诊断文案的长度上限（脱敏后仍限长，避免把上游响应整段带出） */
export const OPERATION_DIAGNOSTIC_MESSAGE_MAX = 512;
/** 一条操作最多携带的诊断条数：main 追加时超过即丢弃新条目（终态与 runIds 永不裁剪） */
export const OPERATION_DIAGNOSTIC_MAX = 32;
/** runIds / 臂摘要的条数上限（桌面批次远达不到，仅作为失控载荷的护栏） */
export const OPERATION_SUMMARY_LIST_MAX = 1024;
/** status 单次返回的操作记录条数上限（本阶段全量返回，超限即视为非法快照） */
export const OPERATION_STATUS_LIST_MAX = 10_000;

const OperationIdSchema = z.string().min(1).max(OPERATION_ID_MAX);
/** main 每次启动生成的 epoch 与 renderer 提交时生成的 operationId 都是 UUID */
export const OperationUuidSchema = z.string().uuid("epoch / operationId 必须是 UUID");
const RunIdSchema = z.string().min(1).max(OPERATION_ID_MAX);
const CodeSchema = z.string().min(1).max(OPERATION_CODE_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// 执行 envelope（D1/D2）：身份与业务请求分离，业务形状仍由各通道 schema 单独 parse
// ---------------------------------------------------------------------------

/** 执行身份：每次主动提交由 renderer 新生成的 operationId + 当前 main epoch */
export const OperationIdentitySchema = z
  .object({
    epoch: OperationUuidSchema,
    operationId: OperationUuidSchema,
  })
  .strict();
export type OperationIdentity = z.infer<typeof OperationIdentitySchema>;

/**
 * 主动执行请求的外层信封。
 *
 * `request` 刻意保持 `z.unknown()`：业务 schema 必须在入口**只 parse 一次**并生成
 * 该请求的不可变业务快照（D2）。若这里再嵌一层业务 schema，同一条请求就会被解析两次、
 * 可能补出两套缺省值——正是「指纹与执行使用同一解析快照」要排除的情形。
 */
export const ExecutionEnvelopeSchema = z
  .object({
    operation: OperationIdentitySchema,
    request: z.unknown(),
  })
  .strict();
export type ExecutionEnvelope = z.infer<typeof ExecutionEnvelopeSchema>;

/** 七个主动入口的统一请求形状（业务形状仍由各通道 schema 单独 parse 一次） */
export type ExecutedRequest<T> = { operation: OperationIdentity; request: T };

/** 登记版本（每次登记变更单调递增）：renderer 据此丢弃乱序快照 */
export const RegistryVersionSchema = z.number().int().positive();
export type RegistryVersion = z.infer<typeof RegistryVersionSchema>;

/** 执行响应的登记回执：renderer 只认「匹配身份 + 登记版本」的终态，不认裸 ok/fail */
export const OperationAckSchema = z
  .object({
    epoch: OperationUuidSchema,
    operationId: OperationUuidSchema,
    registryVersion: RegistryVersionSchema,
    state: z.enum(["running", "settled", "notAccepted"]),
  })
  .strict();
export type OperationAck = z.infer<typeof OperationAckSchema>;

/**
 * 主动执行通道的响应：**两个分支都带登记回执**。
 *
 * `ok:false` 同样携带 `operation`（只有"接受之前"的拒绝——不可信 sender、形状不合、
 * 旧 epoch——才是 `null`），这样 renderer 一律按「身份 + 登记版本 + 状态」决定解冻与
 * 门禁，而不是把裸 `ok/fail` 当成操作结局（design D2「不再以任意 ok/fail 解冻」）。
 */
export function executedResponseSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), operation: OperationAckSchema, data }).strict(),
    z
      .object({
        ok: z.literal(false),
        operation: OperationAckSchema.nullable(),
        error: z.object({ code: CodeSchema, message: z.string().min(1).max(2048) }).strict(),
      })
      .strict(),
  ]);
}
export type ExecutedResponse<T> =
  | { ok: true; operation: OperationAck; data: T }
  | { ok: false; operation: OperationAck | null; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// 操作事实（D1）：七类主动入口归为五种 kind，create/result 各带普通/隔离模式
// ---------------------------------------------------------------------------

export const OperationKindSchema = z.enum(["create", "result", "prompt", "proxy", "modelAb"]);
export type OperationKind = z.infer<typeof OperationKindSchema>;

/**
 * 目标摘要（按 kind 判别）：只带**定位用的 id 与被编辑字段名**，
 * 不带编辑内容、messages、任务正文或 sourceToken——那些只存活于执行上下文。
 */
export const OperationTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      /** plain = 纯对话创建；isolated = 隔离文件世界创建（副本写入授权已在本请求内声明） */
      mode: z.enum(["plain", "isolated"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      mode: z.enum(["plain", "isolated"]),
      parentRunId: RunIdSchema,
      atSpanId: RunIdSchema,
      /** MVP 只有 tool.invoke 的 result 字段可编辑 */
      editField: z.literal("result"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prompt"),
      parentRunId: RunIdSchema,
      editField: z.enum(["system_prompt", "user_message"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("proxy"),
      parentRunId: RunIdSchema,
      atSpanId: RunIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("modelAb"),
      parentRunId: RunIdSchema,
      /** 批次的臂数（A/B 整批占一个槽，故摘要也按批次记） */
      armCount: z.number().int().min(2).max(OPERATION_SUMMARY_LIST_MAX),
    })
    .strict(),
]);
export type OperationTarget = z.infer<typeof OperationTargetSchema>;

export const OperationStateSchema = z.enum(["running", "settled", "notAccepted"]);
export type OperationState = z.infer<typeof OperationStateSchema>;

/** 请求层结局：settled 才有值；A/B 的 `returned` 可能含失败臂，不冒充全部成功 */
export const RequestOutcomeSchema = z.enum(["returned", "failed", "rejected"]);
export type RequestOutcome = z.infer<typeof RequestOutcomeSchema>;

/**
 * notAccepted 的稳定拒绝原因。`reconcile_tombstone` = 该 ID 先被核对过，
 * 自此永久封禁（迟到请求不得复活）。冲突（同 ID 异参）不是登记状态，不在此列。
 */
export const NotAcceptedReasonSchema = z.enum([
  "busy",
  "closing",
  "configuration_busy",
  "reconcile_tombstone",
]);
export type NotAcceptedReason = z.infer<typeof NotAcceptedReasonSchema>;

/**
 * 操作层自己的稳定错误码（业务拒绝沿用各通道既有码，两者在响应里可分辨）。
 * renderer 只按码分支，不按文案分支——文案可以改，码不可以。
 */
export const OPERATION_ERROR = {
  /** 同 ID 携带不同规范化请求（含跨通道复用）：原登记不变，不执行 */
  conflict: "OPERATION_CONFLICT",
  /** 同 ID 同参的重复提交：main 只关联原操作与原终态，本次不执行（重试须换新 ID） */
  duplicated: "OPERATION_DUPLICATED",
  /** 未接受（忙碌 / 关闭协商 / 配置变更 / 已被核对封禁）：不执行，重试须换新 ID */
  notAccepted: "OPERATION_NOT_ACCEPTED",
  /** 缺身份 / 非 UUID / 信封形状不合：在副作用之前拒绝 */
  invalidIdentity: "OPERATION_INVALID_IDENTITY",
  /** 发送者不是已登记窗口的主 frame：在副作用之前拒绝 */
  untrustedSender: "OPERATION_UNTRUSTED_SENDER",
  /** 请求携带旧 main epoch：零副作用，绝不释放当前槽 */
  staleEpoch: "OPERATION_STALE_EPOCH",
} as const;

/** 单个 A/B 臂的摘要：未开始的臂 id 与结局均为 null，绝不生成假身份 */
export const OperationArmSummarySchema = z
  .object({
    index: z.number().int().nonnegative(),
    id: RunIdSchema.nullable(),
    outcome: RequestOutcomeSchema.nullable(),
  })
  .strict();
export type OperationArmSummary = z.infer<typeof OperationArmSummarySchema>;

/** 受控诊断：稳定码 + 限长文案，不含原始 Error、stack、模型响应或输入 */
export const OperationDiagnosticSchema = z
  .object({
    code: CodeSchema,
    stage: z.enum(["execute", "identity", "finalize", "cleanup", "rejection"]),
    message: z.string().min(1).max(OPERATION_DIAGNOSTIC_MESSAGE_MAX),
  })
  .strict();
export type OperationDiagnostic = z.infer<typeof OperationDiagnosticSchema>;

/** 一条操作携带的诊断列表（main 追加时的上限即由此定义，超限只丢新条目） */
export const OperationDiagnosticsListSchema = z
  .array(OperationDiagnosticSchema)
  .max(OPERATION_DIAGNOSTIC_MAX);

/** 可信运行身份与臂摘要列表（同一上限，main 侧永不裁剪终态） */
export const OperationRunIdsListSchema = z.array(RunIdSchema).max(OPERATION_SUMMARY_LIST_MAX);
export const OperationArmsListSchema = z
  .array(OperationArmSummarySchema)
  .max(OPERATION_SUMMARY_LIST_MAX);

/**
 * 一条操作的登记记录。状态联合的精炼（下方 refine）是**契约的一部分**：
 * main 构造与 renderer 采信走同一份判据，任何一侧造出不自洽的记录都会被拒绝。
 */
export const OperationRecordSchema = z
  .object({
    epoch: OperationUuidSchema,
    operationId: OperationUuidSchema,
    /** reconcile 先到的 tombstone：没有执行事实可陈述，target 为 null（不伪造身份与目标） */
    target: OperationTargetSchema.nullable(),
    state: OperationStateSchema,
    /** 仅 notAccepted 有值 */
    rejection: NotAcceptedReasonSchema.nullable(),
    /** tombstone 不伪造执行时间：startedAt 为 null */
    startedAt: TimestampSchema.nullable(),
    settledAt: TimestampSchema.nullable(),
    /** 去重后的可信运行身份；来自实际回调/结构化结果，未产生运行时为空数组 */
    runIds: OperationRunIdsListSchema,
    experimentId: RunIdSchema.nullable(),
    /** 仅 modelAb 批次有条目，其余操作为空数组 */
    arms: OperationArmsListSchema,
    /** 仅 settled 有值 */
    requestOutcome: RequestOutcomeSchema.nullable(),
    /** 业务拒绝/失败的稳定错误码（原字段级校验错误不入登记） */
    errorCode: CodeSchema.nullable(),
    diagnostics: OperationDiagnosticsListSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (new Set(record.runIds).size !== record.runIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "runIds 必须去重" });
    }
    if (new Set(record.arms.map((arm) => arm.index)).size !== record.arms.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "臂索引不得重复" });
    }
    if (record.target === null) {
      // 无目标 ⇒ 只能是 reconcile 先到的封禁，不得携带任何执行事实
      if (record.state !== "notAccepted" || record.rejection !== "reconcile_tombstone") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "target 为 null 仅允许 reconcile_tombstone 的 notAccepted",
        });
      }
    } else if (record.state === "notAccepted" && record.rejection === "reconcile_tombstone") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "已知目标的操作不是 reconcile 封禁" });
    }
    switch (record.state) {
      case "running": {
        if (
          record.settledAt !== null ||
          record.requestOutcome !== null ||
          record.errorCode !== null ||
          record.rejection !== null
        ) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "running 不得携带终态字段" });
        }
        break;
      }
      case "settled": {
        // 被接受的操作必然先经过 running ⇒ 一定有开始时间（tombstone 才是 target/时间为 null）
        if (
          record.startedAt === null ||
          record.settledAt === null ||
          record.requestOutcome === null ||
          record.rejection !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "settled 必须携带开始/结束时间与请求结局",
          });
        }
        if (record.requestOutcome === "returned" && record.errorCode !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "returned 不得携带错误码" });
        }
        if (record.requestOutcome === "rejected" && record.errorCode === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "业务拒绝必须给出稳定错误码" });
        }
        break;
      }
      case "notAccepted": {
        if (
          record.startedAt !== null ||
          record.settledAt !== null ||
          record.requestOutcome !== null ||
          record.rejection === null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "notAccepted 不得携带执行时间、结局，且必须有稳定拒绝原因",
          });
        }
        if (record.runIds.length > 0 || record.arms.length > 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "notAccepted 不得关联运行身份" });
        }
        break;
      }
    }
    // 臂摘要与批次一致性：只有 modelAb 携带臂，且只有它可有 experimentId
    if (record.arms.length > 0 && record.target?.kind !== "modelAb") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "非 A/B 操作不得携带臂摘要" });
    }
    if (record.experimentId !== null && record.target?.kind !== "modelAb") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "非 A/B 操作不得携带 experimentId" });
    }
  });
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

/**
 * 登记快照的「当前全局状态」部分：status 与 reconcile 都带，renderer 的锁由它派生，
 * 而**不由被查询的单条操作**派生（否则核对旧操作会误解锁）。
 */
export const OperationSlotStateSchema = z
  .object({
    epoch: OperationUuidSchema,
    registryVersion: RegistryVersionSchema,
    activeOperationId: OperationUuidSchema.nullable(),
    closing: z.boolean(),
    configurationBusy: z.boolean(),
  })
  .strict();
export type OperationSlotState = z.infer<typeof OperationSlotStateSchema>;

/** status 不自洽的判据（两侧共用）：槽引用与登记必须互相吻合 */
export function findSlotStateViolation(
  state: OperationSlotState,
  operations: readonly OperationRecord[],
): string | null {
  const byId = new Map<string, OperationRecord>();
  for (const record of operations) {
    if (record.epoch !== state.epoch) return "登记记录属于其他 epoch";
    if (byId.has(record.operationId)) return "登记中 operationId 重复";
    byId.set(record.operationId, record);
  }
  const running = operations.filter((record) => record.state === "running");
  if (running.length > 1) return "同时存在多个 running";
  if (state.activeOperationId === null) {
    return running.length === 1 ? "activeOperationId 未指向在跑的操作" : null;
  }
  const active = byId.get(state.activeOperationId);
  if (active === undefined) return "activeOperationId 指向不存在的操作";
  if (active.state !== "running") return "activeOperationId 指向非 running 的操作";
  return null;
}

/**
 * `operations:status` 的结果：本 epoch 全部操作的受限元数据（含 settled/notAccepted），
 * 不按 renderer 关联或面板开合裁剪——重载后的首次握手必须能恢复终态与封禁。
 */
export const OperationStatusResultSchema = OperationSlotStateSchema.extend({
  operations: z.array(OperationRecordSchema).max(OPERATION_STATUS_LIST_MAX),
})
  .strict()
  .superRefine((snapshot, ctx) => {
    const violation = findSlotStateViolation(snapshot, snapshot.operations);
    if (violation !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation });
    }
  });
export type OperationStatusResult = z.infer<typeof OperationStatusResultSchema>;

/** `operations:reconcile` 的请求：只有身份，没有任何业务输入 */
export const ReconcileRequestSchema = OperationIdentitySchema;
export type ReconcileRequest = z.infer<typeof ReconcileRequestSchema>;

/**
 * reconcile 的结果：被核对操作的事实 + main 当前槽与登记版本。
 * 全局锁由后者决定——查旧操作不会解除另一操作的锁。
 */
export const ReconcileResultSchema = OperationSlotStateSchema.extend({
  operation: OperationRecordSchema,
})
  .strict()
  .superRefine((result, ctx) => {
    if (result.operation.epoch !== result.epoch) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "核对结果与快照 epoch 不匹配" });
    }
    if (result.operation.operationId !== result.activeOperationId) {
      // running 的操作必然就是当前槽 owner，否则快照自相矛盾
      if (result.operation.state === "running") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "running 操作未占据当前槽" });
      }
    } else if (result.operation.state !== "running") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "当前槽指向非 running 的操作",
      });
    }
  });
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;
