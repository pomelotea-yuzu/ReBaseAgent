import type { MessageKey, Translator } from "@rebaseagent/i18n";
import type {
  VerificationCapabilityResult,
  VerificationCheckpoint,
  VerificationPreparePlanResult,
} from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import type { ConfirmationDisclosure } from "./execution-confirmation";
import { formatBytes } from "./format";

/**
 * R3（add-isolated-project-verification）任务 5.1/5.2：**检查点验证入口、分开确认
 * 与操作登记核实**的纯判据。
 *
 * 与 `execution-confirmation.ts`（U5）同一套思想，但绑定对象不同：验证没有草稿修订，
 * 确认绑的是 **显式 selector（runId + 检查点）+ 当前计划 token（计划×策略×配方）**：
 *
 * - **显式 selector**：目标键由 `verificationTargetKey` 唯一决定；UI 换检查点必须显式
 *   重新进入，target 绝不无声跟随选择器（design D3「UI 不得无声换点」）。
 * - **计划漂移失效**（D02）：capability 每次核对都返回**当前** planToken；已给出的确认
 *   只在「目标相同 ∧ token 相同（∧ 命令相同）」时才算有效——漂移由**现算比对**发现，
 *   不靠"记得去清"。
 * - **准备与执行许可不互相替代**（D02）：两份确认是两个独立的 armed 引用，判定函数
 *   共用、存储分开；已准备环境（prepared 非空）不等于同意执行。
 * - **不隐式执行**（D02）：提交动作在发送前必须现算判定，stale/missing ⇒ 本地拒发
 *   （零 IPC、零副作用）；main 侧 plan_stale 是第二道防线，不是唯一防线。
 *
 * 不可用原因（D01）由 capability 的只读核对结果映射成**可行动**说明——这里只排版事实，
 * 不发明第二套判据（来源/引擎/环境事实全部来自 main）。
 *
 * 5.2（操作/结果状态与停止反馈）：**可信领域 ID 只来自操作登记记录**（main 编排真实
 * 创建记录后的回调附件）——`matchVerificationRecords` 按显式目标精确匹配登记，
 * `verificationDomainIdOf` 从附件提取停止请求的领域 ID；时间、日志、列表一概不作
 * 身份来源（D03/M01：重载/未知只核对，不猜）。

/** R3 显式验证目标（与 IPC selector 同构：初始 或 自有完成步骤） */
export interface VerificationTargetRef {
  readonly runId: string;
  readonly checkpoint: VerificationCheckpoint;
}

/** 显式目标的唯一键（`\u0000` 分隔；与文件视图 requestKey 同一防撞惯例） */
export function verificationTargetKey(target: VerificationTargetRef): string {
  const checkpoint = target.checkpoint;
  return checkpoint.kind === "initial"
    ? `${target.runId}\u0000initial`
    : `${target.runId}\u0000step\u0000${checkpoint.stepSpanId}`;
}

/** 目标的可读名（确认卡与不可用说明里指名"是哪一次"） */
export function verificationTargetLabel(
  checkpoint: VerificationCheckpoint,
  translator: Translator,
): string {
  return checkpoint.kind === "initial"
    ? translator.t("verification.checkpointInitial")
    : translator.t("verification.checkpointStep", { stepSpanId: checkpoint.stepSpanId });
}

// ---------------------------------------------------------------------------
// 不可用原因（D01）：capability 事实 → 可行动说明
// ---------------------------------------------------------------------------

/** 一条不可用原因；`gates` 说明它挡住准备、执行还是两者 */
export interface VerificationBlocker {
  readonly code: string;
  readonly reason: string;
  readonly gates: "prepare" | "run";
}

/**
 * 从 capability 核对结果映射不可用原因。全部**可行动**：说明缺什么、用户能做什么。
 * capability 为 null（尚未核对）时不产生任何条目——"没核对"由加载态如实呈现，
 * 不冒充"没有问题"。
 */
export function verificationBlockers(
  capability: VerificationCapabilityResult | null,
  translator: Translator,
): readonly VerificationBlocker[] {
  if (capability === null) return [];
  const blockers: VerificationBlocker[] = [];
  if (!capability.engine.available) {
    blockers.push({
      code: "engine_unavailable",
      reason: translator.t("verification.blockerEngine", {
        reason: capability.engine.reason ?? translator.t("verification.reasonMissing"),
      }),
      gates: "prepare",
    });
  }
  if (capability.sourceFailure !== null) {
    blockers.push({
      code: capability.sourceFailure.code,
      reason: translator.t("verification.blockerSource", {
        reason: capability.sourceFailure.reason,
      }),
      gates: "run",
    });
  }
  if (capability.prepared === null) {
    blockers.push({
      code: "prepare_missing",
      reason: translator.t("verification.blockerPrepareMissing"),
      gates: "run",
    });
  }
  return blockers;
}

/** 一条不可用原因的单行呈现（原因已本地化，稳定码随后括注） */
export function blockerLine(blocker: VerificationBlocker, translator: Translator): string {
  return translator.t("verification.blockerLine", {
    reason: blocker.reason,
    code: blocker.code,
  });
}

/** 取挡住某一动作的原因（确认/提交按钮的禁用说明） */
export function blockersFor(
  blockers: readonly VerificationBlocker[],
  gates: VerificationBlocker["gates"],
): readonly VerificationBlocker[] {
  return blockers.filter((one) => one.gates === gates);
}

// ---------------------------------------------------------------------------
// 确认判定（D02）：绑定 目标 + 当前计划 token（+ 命令）
// ---------------------------------------------------------------------------

/** 一次已给出的确认（会话内事实；不进草稿、不进 IPC、不持久化） */
export interface VerificationArmedConfirmation {
  /** 确认那一刻 capability 返回的计划 token */
  readonly planToken: string;
  /** 确认那一刻的显式目标键 */
  readonly targetKey: string;
  /** 执行确认额外绑定固定命令（准备确认没有该项） */
  readonly commandId?: "typecheck" | "test";
}

/**
 * 确认失效的稳定原因码（不随语言变化）：领域判定只回事实，展示层按码取文案。
 * store 的提交门也消费它——判定本身不认识 locale，也不需要 translator。
 */
export type VerificationConfirmationReason =
  | "not_armed"
  | "target_changed"
  | "plan_unknown"
  | "plan_changed"
  | "command_changed";

export type VerificationConfirmationDecision =
  | { readonly kind: "confirmed" }
  | { readonly kind: "missing"; readonly reason: "not_armed" }
  | {
      readonly kind: "stale";
      readonly reason: Exclude<VerificationConfirmationReason, "not_armed">;
    };

const CONFIRMATION_REASON_KEY = {
  not_armed: "verification.confirmMissing",
  target_changed: "verification.confirmStaleTarget",
  plan_unknown: "verification.confirmStalePlanUnknown",
  plan_changed: "verification.confirmStalePlanChanged",
  command_changed: "verification.confirmStaleCommand",
} as const satisfies Record<VerificationConfirmationReason, MessageKey>;

/** 判定的展示行（confirmed ⇒ null）；原因码 → 当前语言文案只在这里映射。 */
export function verificationDecisionLine(
  decision: VerificationConfirmationDecision,
  translator: Translator,
): string | null {
  if (decision.kind === "confirmed") return null;
  return translator.t(CONFIRMATION_REASON_KEY[decision.reason]);
}

/**
 * 确认判定：**现算**，任何分量不一致即 stale。
 * `currentPlanToken === null` 表示当前计划未知（核对缺失）——旧确认不能沿用。
 */
export function decideVerificationConfirmation(input: {
  readonly armed: VerificationArmedConfirmation | null;
  readonly currentPlanToken: string | null;
  readonly currentTargetKey: string;
  /** 执行确认必传：选择器当前指向的固定命令 */
  readonly currentCommandId?: "typecheck" | "test";
}): VerificationConfirmationDecision {
  const armed = input.armed;
  if (armed === null) {
    return { kind: "missing", reason: "not_armed" };
  }
  if (armed.targetKey !== input.currentTargetKey) {
    return { kind: "stale", reason: "target_changed" };
  }
  if (input.currentPlanToken === null) {
    return { kind: "stale", reason: "plan_unknown" };
  }
  if (armed.planToken !== input.currentPlanToken) {
    return { kind: "stale", reason: "plan_changed" };
  }
  if (
    armed.commandId !== undefined &&
    input.currentCommandId !== undefined &&
    armed.commandId !== input.currentCommandId
  ) {
    return { kind: "stale", reason: "command_changed" };
  }
  return { kind: "confirmed" };
}

// ---------------------------------------------------------------------------
// 披露行（D01：精确输入与当前条件；复用 U5 的 ConfirmationDisclosure 形状）
// ---------------------------------------------------------------------------

/** 限额/安全基线的单行摘要（数字来自 capability 的 profile 投影，不在渲染层另存） */
export function profileLimitsLine(
  limits: {
    cpus: number;
    memoryBytes: number;
    pidsLimit: number;
    commandTimeoutMs: number;
    totalTimeoutMs: number;
  },
  translator: Translator,
): string {
  return translator.t("verification.limitsLine", {
    count: limits.cpus,
    memory: formatBytes(limits.memoryBytes),
    pids: limits.pidsLimit,
    commandSeconds: Math.round(limits.commandTimeoutMs / 1000),
    totalSeconds: Math.round(limits.totalTimeoutMs / 1000),
  });
}

function readonlyChecks(translator: Translator): readonly string[] {
  return [
    translator.t("verification.checkCapabilityReadonly"),
    translator.t("verification.checkPlanReadonly"),
  ];
}

function targetFacts(
  runId: string,
  checkpointLabel: string,
  translator: Translator,
): ConfirmationDisclosure["facts"] {
  return [
    { label: translator.t("verification.fieldTargetRun"), value: runId },
    { label: translator.t("verification.fieldCheckpoint"), value: checkpointLabel },
  ];
}

/** 环境准备确认的披露（D02：与执行确认措辞分开，各说各的边界） */
export function verificationPrepareDisclosure(
  input: {
    readonly runId: string;
    readonly checkpointLabel: string;
    readonly capability: VerificationCapabilityResult | null;
    readonly plan: VerificationPreparePlanResult | null;
  },
  translator: Translator,
): ConfirmationDisclosure {
  const { capability, plan } = input;
  return {
    summary: translator.t("verification.prepareSummary"),
    facts: [
      ...targetFacts(input.runId, input.checkpointLabel, translator),
      {
        label: translator.t("verification.fieldProfile"),
        value:
          plan === null
            ? translator.t("verification.planMissing")
            : translator.t("verification.planProfile", {
                profileId: plan.plan.profileId,
                manifestVersion: plan.plan.manifestVersion,
              }),
      },
      ...(plan === null
        ? []
        : plan.plan.downloads.map((download, index): ConfirmationDisclosure["facts"][number] => ({
            label: translator.t("verification.fieldDownload", { index: index + 1 }),
            value: translator.t("verification.downloadLine", {
              source: download.source,
              size: formatBytes(download.approxBytes),
              license: download.license,
            }),
          }))),
      ...(plan === null
        ? []
        : [
            {
              label: translator.t("verification.fieldDiskEstimate"),
              value: formatBytes(plan.plan.spaceEstimateBytes),
            },
          ]),
      {
        label: translator.t("verification.fieldLocalBackend"),
        value:
          capability === null
            ? translator.t("verification.backendNotChecked")
            : capability.engine.available
              ? translator.t("verification.backendEngine", {
                  version:
                    capability.engine.engineVersion ??
                    translator.t("verification.backendVersionUnknown"),
                })
              : translator.t("verification.backendUnavailable", {
                  reason: capability.engine.reason ?? translator.t("verification.reasonMissing"),
                }),
      },
      {
        label: translator.t("verification.fieldAuthorization"),
        value: translator.t("verification.authorizationPrepare"),
      },
    ],
    checks: [...readonlyChecks(translator)],
    limits: [
      ...(plan === null
        ? []
        : [translator.t("verification.planNote", { note: plan.plan.networkScopeNote })]),
      translator.t("verification.limitPrepareSeparate"),
      translator.t("verification.limitPrepareBinding"),
    ],
  };
}

/** 固定检查执行确认的披露（D02：已准备环境 ≠ 同意执行；结果只认测试事实） */
export function verificationRunDisclosure(
  input: {
    readonly runId: string;
    readonly checkpointLabel: string;
    readonly commandId: "typecheck" | "test";
    readonly capability: VerificationCapabilityResult | null;
  },
  translator: Translator,
): ConfirmationDisclosure {
  const { capability } = input;
  const source = capability?.source ?? null;
  const prepared = capability?.prepared ?? null;
  const limits = capability?.profileSummary ?? null;
  return {
    summary: translator.t("verification.runSummary", { commandId: input.commandId }),
    facts: [
      ...targetFacts(input.runId, input.checkpointLabel, translator),
      {
        label: translator.t("verification.fieldCommand"),
        value: translator.t("verification.commandValue", { commandId: input.commandId }),
      },
      {
        label: translator.t("verification.fieldExactInput"),
        value:
          source === null
            ? translator.t("verification.runSourceMissing")
            : translator.t("verification.sourceSnapshot", {
                snapshotId: source.snapshotId,
                count: source.fileCount,
                totalBytes: formatBytes(source.totalBytes),
              }),
      },
      {
        label: translator.t("verification.fieldExecutionEnv"),
        value:
          prepared === null
            ? translator.t("verification.envMissing")
            : translator.t("verification.envPrepared", {
                preparationId: prepared.preparationId,
                imageDigest: prepared.imageDigest,
              }),
      },
      {
        label: translator.t("verification.fieldToolchain"),
        value:
          prepared === null
            ? translator.t("verification.toolchainUnknown")
            : translator.t("verification.toolchainValue", {
                node: prepared.toolchain.node,
                typescript: prepared.toolchain.typescript,
              }),
      },
      ...(limits === null
        ? []
        : [
            {
              label: translator.t("verification.fieldLimits"),
              value: profileLimitsLine(limits.limits, translator),
            },
            {
              label: translator.t("verification.fieldIsolationBaseline"),
              value: translator.t("verification.isolationBaseline", {
                runAsUser: limits.security.runAsUser,
                networkMode: limits.security.networkMode,
              }),
            },
          ]),
      {
        label: translator.t("verification.fieldAuthorization"),
        value: translator.t("verification.authorizationRun"),
      },
    ],
    checks: [...readonlyChecks(translator)],
    limits: [
      translator.t("verification.limitEvidence"),
      translator.t("verification.limitTrustedTests"),
      translator.t("verification.limitPermits"),
      translator.t("verification.limitContainer"),
    ],
  };
}

// ---------------------------------------------------------------------------
// 操作登记核实（5.2：D03/D05/M01——可信领域 ID 只来自登记，不猜）
// ---------------------------------------------------------------------------

/** 匹配所需的最小会话形状（避免 lib 依赖完整 OperationSession 类型树） */
export interface VerificationSessionRef {
  readonly epoch: string | null;
  readonly operations: readonly OperationRecord[];
}

/**
 * 按显式目标精确匹配本会话已知的 R3 操作登记记录。
 *
 * 只认 target 摘要（kind + runId + checkpointKind/stepSpanId）——时间、日志、最新列表
 * 一概不作匹配依据（D03/M01：无身份不从猜测来）。reconcile tombstone（target=null）
 * 与其它 kind 的记录天然不匹配。
 */
export function matchVerificationRecords(
  session: VerificationSessionRef,
  target: VerificationTargetRef,
): readonly OperationRecord[] {
  return session.operations.filter((record) => {
    const t = record.target;
    if (t === null) return false;
    if (t.kind !== "verificationPrepare" && t.kind !== "verification") return false;
    if (t.runId !== target.runId) return false;
    if (t.checkpointKind !== target.checkpoint.kind) return false;
    if (
      t.checkpointKind === "step" &&
      target.checkpoint.kind === "step" &&
      t.stepSpanId !== target.checkpoint.stepSpanId
    ) {
      return false;
    }
    return true;
  });
}

/**
 * D09/P16：**可信验证身份集合** = 登记附件（verificationIds）∪ 执行响应回执里的
 * verificationId。两者都是 main 真实创建记录后给出的来源；时间、日志、最新列表
 * 一概不作身份来源。去重保序（登记在前，响应补后）。
 */
export function trustedVerificationIdsOf(
  records: readonly OperationRecord[],
  respondedVerificationId: string | null | undefined,
): string[] {
  const ids: string[] = [];
  for (const record of records) {
    for (const id of record.verificationIds) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  if (
    respondedVerificationId !== null &&
    respondedVerificationId !== undefined &&
    !ids.includes(respondedVerificationId)
  ) {
    ids.push(respondedVerificationId);
  }
  return ids;
}

/** 比较候选（5.4/D07）：本会话登记附件里的验证身份 + 来源标签事实 */
export interface VerificationCompareCandidate {
  readonly verificationId: string;
  /** 登记 target 里的来源 run；响应回执补齐的候选没有目标摘要（null） */
  readonly runId: string | null;
  readonly checkpointKind: "initial" | "step" | null;
  readonly stepSpanId: string | null;
  readonly commandId: "typecheck" | "test" | null;
  readonly operationState: "running" | "settled" | "notAccepted" | null;
}

/**
 * D07/P24：**比较候选** = 本会话登记里的全部验证附件（跨 run/检查点，用户显式
 * A/B 选择）∪ 当前执行响应回执。仍然只来自 main 真实回调/响应，不从时间、日志、
 * 记录列表猜身份（M01 红线）；重载后登记不在 ⇒ 候选自然为空，不补猜。
 */
export function collectVerificationCompareCandidates(
  records: readonly OperationRecord[],
  respondedVerificationId: string | null | undefined,
): VerificationCompareCandidate[] {
  const candidates: VerificationCompareCandidate[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const target = record.target;
    if (target === null || target.kind !== "verification") continue;
    for (const verificationId of record.verificationIds) {
      if (seen.has(verificationId)) continue;
      seen.add(verificationId);
      candidates.push({
        verificationId,
        runId: target.runId,
        checkpointKind: target.checkpointKind,
        stepSpanId: target.stepSpanId,
        commandId: target.commandId,
        operationState: record.state,
      });
    }
  }
  if (
    respondedVerificationId !== null &&
    respondedVerificationId !== undefined &&
    !seen.has(respondedVerificationId)
  ) {
    candidates.push({
      verificationId: respondedVerificationId,
      runId: null,
      checkpointKind: null,
      stepSpanId: null,
      commandId: null,
      operationState: null,
    });
  }
  return candidates;
}

/**
 * 从登记记录提取停止请求的**可信领域 ID**（D06：不接任意容器/PID）。
 * 执行类取 verificationIds 附件、准备类取 preparationIds 附件；kind 与附件不匹配
 * 或尚未关联（编排还没建记录）⇒ null——调用方不得猜测，只能核对后再试。
 */
export function verificationDomainIdOf(
  record: OperationRecord | undefined,
  kind: "prepare" | "run",
): string | null {
  if (record === undefined) return null;
  const ids = kind === "run" ? record.verificationIds : record.preparationIds;
  return ids.length > 0 ? (ids[0] ?? null) : null;
}

/** 登记记录的一行摘要（操作区展示；kind 与状态的可读名在这里集中） */
export function verificationRecordLine(record: OperationRecord): string {
  const kindLabel =
    record.target?.kind === "verificationPrepare"
      ? "环境准备"
      : record.target?.kind === "verification"
        ? `项目验证（${record.target.commandId}）`
        : "未知类型";
  const stateLabel =
    record.state === "running"
      ? "执行中"
      : record.state === "settled"
        ? `已收尾（${record.requestOutcome ?? "未知结局"}）`
        : `未接受（${record.rejection ?? "未知原因"}）`;
  return `${kindLabel} · ${stateLabel}`;
}
