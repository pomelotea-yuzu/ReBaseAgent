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
export function verificationTargetLabel(checkpoint: VerificationCheckpoint): string {
  return checkpoint.kind === "initial" ? "初始检查点" : `步骤检查点 ${checkpoint.stepSpanId}`;
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
): readonly VerificationBlocker[] {
  if (capability === null) return [];
  const blockers: VerificationBlocker[] = [];
  if (!capability.engine.available) {
    blockers.push({
      code: "engine_unavailable",
      reason: `本机受限后端不可用：${capability.engine.reason ?? "原因未提供"}。安装或启动 Docker Desktop（Linux containers）后重试；应用不会自动安装，也不会回退到宿主 Shell。`,
      gates: "prepare",
    });
  }
  if (capability.sourceFailure !== null) {
    blockers.push({
      code: capability.sourceFailure.code,
      reason: `验证输入不成立：${capability.sourceFailure.reason}（固定检查只能从合法隔离 run 的自有检查点执行；换一个有文件世界的 run/步骤，或先修该 run 的来源完整性）`,
      gates: "run",
    });
  }
  if (capability.prepared === null) {
    blockers.push({
      code: "prepare_missing",
      reason:
        "尚未准备环境：先完成下方的「环境准备」（一次性），等它成功后再执行固定检查。准备与执行分开确认。",
      gates: "run",
    });
  }
  return blockers;
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

export type VerificationConfirmationDecision =
  | { readonly kind: "confirmed" }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "stale"; readonly reason: string };

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
    return { kind: "missing", reason: "尚未确认：先核对本次目标与边界，再显式确认" };
  }
  if (armed.targetKey !== input.currentTargetKey) {
    return { kind: "stale", reason: "验证目标已变化：旧确认绑定的是另一个检查点，须重新核对确认" };
  }
  if (input.currentPlanToken === null) {
    return {
      kind: "stale",
      reason: "当前计划未知（核对结果缺失或已失效）：旧确认不能沿用，请重新核对",
    };
  }
  if (armed.planToken !== input.currentPlanToken) {
    return {
      kind: "stale",
      reason: "计划已变化（计划/策略/配方任一漂移）：旧确认失效，请重新核对当前计划再确认",
    };
  }
  if (
    armed.commandId !== undefined &&
    input.currentCommandId !== undefined &&
    armed.commandId !== input.currentCommandId
  ) {
    return {
      kind: "stale",
      reason: "固定检查命令已变化：旧确认绑定的是另一条命令，须重新确认",
    };
  }
  return { kind: "confirmed" };
}

// ---------------------------------------------------------------------------
// 披露行（D01：精确输入与当前条件；复用 U5 的 ConfirmationDisclosure 形状）
// ---------------------------------------------------------------------------

/** 限额/安全基线的单行摘要（数字来自 capability 的 profile 投影，不在渲染层另存） */
export function profileLimitsLine(limits: {
  cpus: number;
  memoryBytes: number;
  pidsLimit: number;
  commandTimeoutMs: number;
  totalTimeoutMs: number;
}): string {
  return `CPU ${limits.cpus} 核 · 内存 ${formatBytes(limits.memoryBytes)} · PIDs ${limits.pidsLimit} · 单命令 ${Math.round(limits.commandTimeoutMs / 1000)} s · 整次 ${Math.round(limits.totalTimeoutMs / 1000)} s`;
}

const READONLY_CHECKS = [
  "只读核对 `verification:capability`：零下载、零容器、零执行、零模型调用",
  "只读计划预览 `verification:preparePlan`：只展示固定计划，不安装任何东西",
] as const;

function targetFacts(runId: string, checkpointLabel: string): ConfirmationDisclosure["facts"] {
  return [
    { label: "目标 run", value: runId },
    { label: "检查点（显式选定）", value: checkpointLabel },
  ];
}

/** 环境准备确认的披露（D02：与执行确认措辞分开，各说各的边界） */
export function verificationPrepareDisclosure(input: {
  readonly runId: string;
  readonly checkpointLabel: string;
  readonly capability: VerificationCapabilityResult | null;
  readonly plan: VerificationPreparePlanResult | null;
}): ConfirmationDisclosure {
  const { capability, plan } = input;
  return {
    summary: "一次性环境准备 · 仅准备阶段按固定来源联网下载 · 不执行项目测试",
    facts: [
      ...targetFacts(input.runId, input.checkpointLabel),
      {
        label: "profile",
        value:
          plan === null
            ? "尚未取得计划（打开面板时会自动核对）"
            : `${plan.plan.profileId} · manifest v${plan.plan.manifestVersion}`,
      },
      ...(plan === null
        ? []
        : plan.plan.downloads.map((download, index): ConfirmationDisclosure["facts"][number] => ({
            label: `下载来源 ${index + 1}`,
            value: `${download.source} · 约 ${formatBytes(download.approxBytes)} · ${download.license}`,
          }))),
      ...(plan === null
        ? []
        : [{ label: "磁盘占用估计", value: formatBytes(plan.plan.spaceEstimateBytes) }]),
      {
        label: "本机后端",
        value:
          capability === null
            ? "尚未核对"
            : capability.engine.available
              ? `Docker 引擎 ${capability.engine.engineVersion ?? "（版本未知）"}`
              : `不可用：${capability.engine.reason ?? "原因未提供"}`,
      },
      { label: "本次授权", value: "确认后仅授予这一次环境准备（allowPrepare），不授予测试执行" },
    ],
    checks: [...READONLY_CHECKS],
    limits: [
      ...(plan === null ? [] : [plan.plan.networkScopeNote]),
      "准备与测试分开确认：这里只构建环境，不物化代码、不执行任何检查；执行要单独核对确认。",
      "确认绑定当前计划：计划/策略/配方任一变化后旧确认失效，须重新核对确认；不会自动提交新计划。",
    ],
  };
}

/** 固定检查执行确认的披露（D02：已准备环境 ≠ 同意执行；结果只认测试事实） */
export function verificationRunDisclosure(input: {
  readonly runId: string;
  readonly checkpointLabel: string;
  readonly commandId: "typecheck" | "test";
  readonly capability: VerificationCapabilityResult | null;
}): ConfirmationDisclosure {
  const { capability } = input;
  const source = capability?.source ?? null;
  const prepared = capability?.prepared ?? null;
  const limits = capability?.profileSummary ?? null;
  return {
    summary: `执行固定检查 ${input.commandId} · 受限断网容器 · 结果只来自退出码与可信测试报告`,
    facts: [
      ...targetFacts(input.runId, input.checkpointLabel),
      {
        label: "固定命令",
        value: `${input.commandId}（executable/argv/cwd 由 manifest 冻结；不接受自定义命令、路径或环境变量）`,
      },
      {
        label: "精确输入",
        value:
          source === null
            ? "来源预检未通过（见下方原因）：没有可验证的输入"
            : `快照 ${source.snapshotId} · ${source.fileCount} 个文件 · ${formatBytes(source.totalBytes)}`,
      },
      {
        label: "执行环境",
        value:
          prepared === null
            ? "尚未准备（先完成环境准备并等它成功）"
            : `已准备 ${prepared.preparationId} · 镜像 ${prepared.imageDigest}`,
      },
      {
        label: "工具链",
        value:
          prepared === null
            ? "未知（取决于准备结果）"
            : `Node ${prepared.toolchain.node} · TypeScript ${prepared.toolchain.typescript}`,
      },
      ...(limits === null
        ? []
        : [
            { label: "资源限额", value: profileLimitsLine(limits.limits) },
            {
              label: "隔离基线",
              value: `非 root（${limits.security.runAsUser}）· 只读 rootfs · cap-drop ALL · no-new-privileges · 断网（${limits.security.networkMode}）`,
            },
          ]),
      {
        label: "本次授权",
        value: "确认后仅授予这一次执行（allowExecution）；已准备环境不等于同意执行",
      },
    ],
    checks: [...READONLY_CHECKS],
    limits: [
      "结果只来自真实退出码与可信测试报告（TAP 计数精确匹配）：Agent 文本、日志内容都不能替代测试事实。",
      "测试来自固定环境 /opt/r3 的受信测试与 runner：不读取项目可改的测试文件与 npm scripts；改源码冒充修复会被采集门拒绝。",
      "准备与执行许可不互相替代：执行前仍须本次显式确认；确认绑定当前计划与目标，变化后失效且不自动提交。",
      "执行在受限容器内进行：断网、非 root、只读 rootfs；输出与时间超限会被停止并如实记为对应结局。",
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
