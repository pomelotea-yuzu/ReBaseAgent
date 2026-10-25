import type { RunSummary, VerificationGetMeta, VerificationGetResult } from "@shared/ipc";
import { formatBytes } from "./format";

/**
 * R3 任务 5.4：两条验证的**比较判据**（D07/P24/P25 的渲染半边）。
 *
 * 纪律（delta 场景逐字）：
 * - 只比较**记录里实际存在的事实**：meta/command_start/terminated。缺字段 ⇒ unknown，
 *   **不**拿当前 manifest 或另一侧的值补（P25：不合成为同条件失败→通过）；
 * - 只有「全部条件行 same ∧ 两侧证据完整 ∧ 左 check_failed ∧ 右 passed」才输出
 *   failed-to-passed，且措辞只声明实际检查结果，不宣布完整正确或因果关系（P24）；
 * - 干预只来自 run 摘要里**记录的分叉**（fork 元数据）；没有记录就如实说明
 *   「不可从记录确认」，不把人工改动归成 Agent 修复（D07/design D7）；
 * - Agent 文本不进入条件与结论——本模块只吃验证记录与运行分叉元数据。
 */

export type CompareConditionState = "same" | "different" | "unknown";

export interface VerificationCompareRow {
  readonly key: string;
  readonly label: string;
  /** null = 该侧记录未保存此字段（unknown 的事实来源） */
  readonly left: string | null;
  readonly right: string | null;
  readonly state: CompareConditionState;
}

export interface VerificationCompareSide {
  readonly verificationId: string;
  readonly status: VerificationGetResult["status"];
  readonly runId: string | null;
  readonly checkpointLabel: string | null;
  readonly snapshotId: string | null;
  readonly outcome: string | null;
  readonly detail: string | null;
  readonly evidenceComplete: boolean | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly sourceStatus: VerificationGetResult["sourceStatus"];
  /** 记录的分叉干预（来自运行列表元数据；未知时如实说明） */
  readonly intervention: string;
  /** 保留/全观测日志字节（command_end 事实；无命令事实 ⇒ null） */
  readonly logBytes: {
    readonly stdout: number;
    readonly stdoutTotal: number;
    readonly stderr: number;
    readonly stderrTotal: number;
  } | null;
}

export type VerificationCompareVerdict =
  | { readonly kind: "failed-to-passed"; readonly headline: string }
  | { readonly kind: "same-conditions-other-outcome"; readonly headline: string }
  | {
      readonly kind: "conditions-differ";
      readonly headline: string;
      readonly differences: readonly string[];
    }
  | {
      readonly kind: "conditions-unknown";
      readonly headline: string;
      readonly unknowns: readonly string[];
    }
  | { readonly kind: "evidence-incomplete"; readonly headline: string }
  | { readonly kind: "outcome-unknown"; readonly headline: string };

export interface VerificationComparison {
  readonly left: VerificationCompareSide;
  readonly right: VerificationCompareSide;
  readonly conditions: readonly VerificationCompareRow[];
  readonly verdict: VerificationCompareVerdict;
  /** 代码快照是否一致；任一侧缺 meta ⇒ null（未知，不说相同/不同） */
  readonly codeSame: boolean | null;
  readonly limitations: readonly string[];
}

interface CommandFacts {
  readonly executable: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

function asRecordObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** 从正文事件里取本记录命令的 start/end 事实（畸形即视为缺字段，不猜）。 */
function commandFactsOf(result: VerificationGetResult): CommandFacts | null {
  const commandId = result.meta?.commandId ?? null;
  let executable: string | null = null;
  let argv: string[] | null = null;
  let cwd: string | null = null;
  let exitCode: number | null = null;
  let durationMs: number | null = null;
  let sawStart = false;
  let sawEnd = false;
  for (const event of result.events) {
    const record = asRecordObject(event);
    if (record === null) continue;
    if (record.type === "command_start") {
      if (commandId !== null && record.commandId !== commandId) continue;
      if (
        typeof record.executable === "string" &&
        Array.isArray(record.argv) &&
        record.argv.every((one) => typeof one === "string") &&
        typeof record.cwd === "string"
      ) {
        executable = record.executable;
        argv = record.argv as string[];
        cwd = record.cwd;
        sawStart = true;
      }
      continue;
    }
    if (record.type === "command_end") {
      if (commandId !== null && record.commandId !== commandId) continue;
      if (record.exitCode === null || typeof record.exitCode === "number") {
        exitCode = record.exitCode;
      }
      if (typeof record.durationMs === "number") durationMs = record.durationMs;
      sawEnd = true;
    }
  }
  if (!sawStart) return null;
  return { executable: executable ?? "", argv: argv ?? [], cwd: cwd ?? "", exitCode, durationMs };
}

function logBytesOf(result: VerificationGetResult): VerificationSideLog | null {
  const commandId = result.meta?.commandId ?? null;
  for (const event of result.events) {
    const record = asRecordObject(event);
    if (record === null || record.type !== "command_end") continue;
    if (commandId !== null && record.commandId !== commandId) continue;
    const stdout = asRecordObject(record.stdout);
    const stderr = asRecordObject(record.stderr);
    const stdoutBytes = stdout?.byteLength;
    const stdoutTotal = stdout?.totalBytes;
    const stderrBytes = stderr?.byteLength;
    const stderrTotal = stderr?.totalBytes;
    if (
      typeof stdoutBytes === "number" &&
      typeof stdoutTotal === "number" &&
      typeof stderrBytes === "number" &&
      typeof stderrTotal === "number"
    ) {
      return {
        stdout: stdoutBytes,
        stdoutTotal,
        stderr: stderrBytes,
        stderrTotal,
      };
    }
  }
  return null;
}

type VerificationSideLog = NonNullable<VerificationCompareSide["logBytes"]>;

function checkpointLabelOf(meta: VerificationGetMeta | null): string | null {
  if (meta === null) return null;
  return meta.checkpoint.kind === "initial"
    ? "初始检查点"
    : `步骤检查点 ${meta.checkpoint.stepSpanId}`;
}

function interventionOf(run: RunSummary | undefined): string {
  if (run === undefined) return "来源 run 不在当前列表：分叉干预未知（不猜）";
  if (run.fork === null) {
    return "无记录的分叉（根运行；人工改文件不可从记录确认）";
  }
  const parent = run.parent === null ? "父 run 未知" : `父 ${run.parent}`;
  const experiment = run.fork.experiment_id === null ? "" : `，实验组 ${run.fork.experiment_id}`;
  return `记录的分叉：编辑 ${run.fork.edit_field} @ ${run.fork.at_span}（${parent}${experiment}）`;
}

function formatToolchain(toolchain: {
  readonly node: string;
  readonly npm: string;
  readonly typescript: string;
}): string {
  return `node ${toolchain.node} / npm ${toolchain.npm} / TypeScript ${toolchain.typescript}`;
}

function formatLimits(limits: NonNullable<VerificationGetMeta["environment"]>["limits"]): string {
  const tmpfs = limits.tmpfsCountsTowardMemoryBudget ? "（tmpfs 计入内存）" : "";
  return [
    `CPU ${limits.cpus}`,
    `内存 ${formatBytes(limits.memoryBytes)}${tmpfs}`,
    `PID ${limits.pidsLimit}`,
    `命令超时 ${limits.commandTimeoutMs}ms`,
    `总超时 ${limits.totalTimeoutMs}ms`,
    `stdout 保留 ${formatBytes(limits.stdoutBudgetBytes)}`,
    `stderr 保留 ${formatBytes(limits.stderrBudgetBytes)}`,
    `总输出上限 ${formatBytes(limits.totalOutputLimitBytes)}`,
    `产物 ${formatBytes(limits.artifactUniqueContentBudgetBytes)}`,
  ].join(" · ");
}

function formatSecurity(
  security: NonNullable<VerificationGetMeta["environment"]>["security"],
): string {
  return [
    `非 root ${security.runAsUser}`,
    security.readOnlyRootfs ? "只读根" : "可写根",
    security.capDropAll ? "cap drop all" : "保留 capabilities",
    security.noNewPrivileges ? "no-new-privileges" : "允许提权",
    `网络 ${security.networkMode}`,
    security.supervisorPid1 ? "supervisor PID 1" : "无 supervisor",
  ].join(" · ");
}

function row(
  key: string,
  label: string,
  left: string | null,
  right: string | null,
): VerificationCompareRow {
  if (left === null || right === null) return { key, label, left, right, state: "unknown" };
  return { key, label, left, right, state: left === right ? "same" : "different" };
}

function sideOf(
  result: VerificationGetResult,
  run: RunSummary | undefined,
): VerificationCompareSide {
  const meta = result.meta;
  const env = meta?.environment ?? null;
  const command = commandFactsOf(result);
  return {
    verificationId: result.verificationId,
    status: result.status,
    runId: meta?.runId ?? null,
    checkpointLabel: checkpointLabelOf(meta),
    snapshotId: meta?.snapshotId ?? null,
    outcome: result.terminated?.outcome ?? null,
    detail: result.terminated?.detail ?? null,
    evidenceComplete: result.terminated?.evidenceComplete ?? null,
    exitCode: command?.exitCode ?? null,
    durationMs: command?.durationMs ?? null,
    sourceStatus: result.sourceStatus,
    intervention: interventionOf(run),
    logBytes: logBytesOf(result),
  };
}

function limitationList(left: VerificationGetResult, right: VerificationGetResult): string[] {
  const limitations: string[] = [
    "Agent 文本不进入条件与结论；本区只读验证记录与运行分叉元数据。",
    "R3 不自动发起模型修复；干预是否成立以运行记录的分叉元数据为准。",
  ];
  if (left.sourceStatus === "missing" || right.sourceStatus === "missing") {
    limitations.push(
      "至少一侧来源 run 的 trace 已缺失：代码差异无法在本机核对（验证记录仍可读）。",
    );
  }
  if (left.meta?.environment === null || right.meta?.environment === null) {
    limitations.push(
      "至少一侧记录未保存环境身份（实际镜像/工具链/限额）：这些条件按未知处理，不拿当前 manifest 冒充。",
    );
  }
  if (left.meta === null || right.meta === null) {
    limitations.push("至少一侧记录头不可读（损坏/版本不受支持）：条件与代码身份未知。");
  }
  limitations.push(
    "测试/runner/依赖锁/模板身份由计划绑定摘要锚定（摘要相同 = 同一配方；这些明细不单独展开）。",
  );
  limitations.push(
    "公开环境变量：产品不注入（命令行不含 --env），容器镜像默认由实际 imageDigest 锚定。",
  );
  return limitations;
}

export function compareVerifications(
  leftResult: VerificationGetResult,
  rightResult: VerificationGetResult,
  runs: readonly RunSummary[],
): VerificationComparison {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const left = sideOf(
    leftResult,
    leftResult.meta === null ? undefined : byId.get(leftResult.meta.runId),
  );
  const right = sideOf(
    rightResult,
    rightResult.meta === null ? undefined : byId.get(rightResult.meta.runId),
  );
  const leftMeta = leftResult.meta;
  const rightMeta = rightResult.meta;
  const leftEnv = leftMeta?.environment ?? null;
  const rightEnv = rightMeta?.environment ?? null;
  const leftCommand = commandFactsOf(leftResult);
  const rightCommand = commandFactsOf(rightResult);
  const conditions: VerificationCompareRow[] = [
    row("profileId", "profile", leftMeta?.profileId ?? null, rightMeta?.profileId ?? null),
    row(
      "manifestVersion",
      "manifest 版本",
      leftMeta === null ? null : String(leftMeta.manifestVersion),
      rightMeta === null ? null : String(rightMeta.manifestVersion),
    ),
    row(
      "planBindingDigest",
      "计划绑定摘要（计划×策略×配方）",
      leftMeta?.planBindingDigest ?? null,
      rightMeta?.planBindingDigest ?? null,
    ),
    row("commandId", "检查命令", leftMeta?.commandId ?? null, rightMeta?.commandId ?? null),
    row(
      "command",
      "executable + argv",
      leftCommand === null ? null : `${leftCommand.executable} ${leftCommand.argv.join(" ")}`,
      rightCommand === null ? null : `${rightCommand.executable} ${rightCommand.argv.join(" ")}`,
    ),
    row("cwd", "工作目录", leftCommand?.cwd ?? null, rightCommand?.cwd ?? null),
    row("platform", "平台", leftEnv?.platform ?? null, rightEnv?.platform ?? null),
    row("imageDigest", "实际镜像摘要", leftEnv?.imageDigest ?? null, rightEnv?.imageDigest ?? null),
    row(
      "toolchain",
      "运行时版本",
      leftEnv === null ? null : formatToolchain(leftEnv.toolchain),
      rightEnv === null ? null : formatToolchain(rightEnv.toolchain),
    ),
    row(
      "limits",
      "资源限额",
      leftEnv === null ? null : formatLimits(leftEnv.limits),
      rightEnv === null ? null : formatLimits(rightEnv.limits),
    ),
    row(
      "security",
      "隔离基线",
      leftEnv === null ? null : formatSecurity(leftEnv.security),
      rightEnv === null ? null : formatSecurity(rightEnv.security),
    ),
  ];
  const differences = conditions.filter((one) => one.state === "different").map((one) => one.label);
  const unknowns = conditions.filter((one) => one.state === "unknown").map((one) => one.label);
  const codeSame =
    leftResult.meta === null || rightResult.meta === null
      ? null
      : leftResult.meta.snapshotId === rightResult.meta.snapshotId;

  let verdict: VerificationCompareVerdict;
  if (left.outcome === null || right.outcome === null) {
    verdict = {
      kind: "outcome-unknown",
      headline: "至少一侧记录未封存/不可读：不形成比较结论（不以未完成事实冒充结果）。",
    };
  } else if (left.evidenceComplete !== true || right.evidenceComplete !== true) {
    verdict = {
      kind: "evidence-incomplete",
      headline: "至少一侧证据不完整：不形成修复结论（缺项不能以模型文本补齐）。",
    };
  } else if (differences.length > 0) {
    verdict = {
      kind: "conditions-differ",
      headline: "条件不同：不构成同条件失败→通过。",
      differences,
    };
  } else if (unknowns.length > 0) {
    verdict = {
      kind: "conditions-unknown",
      headline: "条件未知（记录缺字段）：不构成同条件失败→通过。",
      unknowns,
    };
  } else if (left.outcome === "check_failed" && right.outcome === "passed") {
    verdict = {
      kind: "failed-to-passed",
      headline:
        "同条件失败→通过：仅指该固定检查在两侧已记录的相同条件下由 check_failed 变为 passed；不宣布完整正确或因果关系。",
    };
  } else {
    verdict = {
      kind: "same-conditions-other-outcome",
      headline: `条件一致，但结局不是失败→通过（实际：${left.outcome} / ${right.outcome}）；只声明实际检查结果。`,
    };
  }

  return {
    left,
    right,
    conditions,
    verdict,
    codeSame,
    limitations: limitationList(leftResult, rightResult),
  };
}
