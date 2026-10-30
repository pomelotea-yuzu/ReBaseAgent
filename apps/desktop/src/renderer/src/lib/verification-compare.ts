import type { Translator } from "@rebaseagent/i18n";
import { compareVerificationFacts } from "@rebaseagent/project-verification/facts";
import type { VerificationFactsSide } from "@rebaseagent/project-verification/facts";
import type { VerificationGetMeta, VerificationGetResult } from "@shared/ipc";
import type { RunSummary } from "@shared/ipc";
import { formatBytes } from "./format";

/**
 * R3 任务 5.4 / MCP2 任务 2.5：两条验证的**比较判据**（D07/P24/P25 的渲染半边）。
 *
 * MCP2 起，条件状态与结论**只出自** `@rebaseagent/project-verification/facts`
 * 的共享纯事实（design D7）：argv 按数组比较、对象按规范值比较、缺项 unknown、
 * 结论顺序 outcome-unknown → evidence-incomplete → conditions-differ →
 * conditions-unknown → failed-to-passed → same-conditions-other-outcome。
 * 本模块保留**展示适配**：中文标签、格式化串（join 仅用于显示）、干预措辞与
 * limitation 文案；state/verdict 不再在本地重算（V02：桌面与 MCP 同判据）。
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

function checkpointLabelOf(
  meta: VerificationGetMeta | null,
  translator: Translator,
): string | null {
  if (meta === null) return null;
  return meta.checkpoint.kind === "initial"
    ? translator.t("verification.checkpointInitial")
    : translator.t("verification.checkpointStep", { stepSpanId: meta.checkpoint.stepSpanId });
}

function interventionOf(run: RunSummary | undefined, translator: Translator): string {
  if (run === undefined) return translator.t("verification.cmpInterventionNoRun");
  if (run.fork === null) {
    return translator.t("verification.cmpInterventionRoot");
  }
  const parent =
    run.parent === null
      ? translator.t("verification.cmpInterventionParentUnknown")
      : translator.t("verification.cmpInterventionParent", { runId: run.parent });
  const experiment =
    run.fork.experiment_id === null
      ? ""
      : translator.t("verification.cmpInterventionExperiment", {
          experimentId: run.fork.experiment_id,
        });
  return translator.t("verification.cmpInterventionRecorded", {
    field: run.fork.edit_field,
    span: run.fork.at_span,
    parent,
    experiment,
  });
}

function formatToolchain(toolchain: {
  readonly node: string;
  readonly npm: string;
  readonly typescript: string;
}): string {
  return `node ${toolchain.node} / npm ${toolchain.npm} / TypeScript ${toolchain.typescript}`;
}

function formatLimits(
  limits: NonNullable<VerificationGetMeta["environment"]>["limits"],
  translator: Translator,
): string {
  const tmpfs = limits.tmpfsCountsTowardMemoryBudget ? translator.t("verification.cmpTmpfs") : "";
  return [
    translator.t("verification.cmpCpu", { count: limits.cpus }),
    translator.t("verification.cmpMemory", {
      memory: formatBytes(limits.memoryBytes),
      tmpfs,
    }),
    translator.t("verification.cmpPids", { pids: limits.pidsLimit }),
    translator.t("verification.cmpCommandTimeout", { ms: limits.commandTimeoutMs }),
    translator.t("verification.cmpTotalTimeout", { ms: limits.totalTimeoutMs }),
    translator.t("verification.cmpStdoutRetained", {
      bytes: formatBytes(limits.stdoutBudgetBytes),
    }),
    translator.t("verification.cmpStderrRetained", {
      bytes: formatBytes(limits.stderrBudgetBytes),
    }),
    translator.t("verification.cmpTotalOutput", {
      bytes: formatBytes(limits.totalOutputLimitBytes),
    }),
    translator.t("verification.cmpArtifact", {
      bytes: formatBytes(limits.artifactUniqueContentBudgetBytes),
    }),
  ].join(" · ");
}

function formatSecurity(
  security: NonNullable<VerificationGetMeta["environment"]>["security"],
  translator: Translator,
): string {
  return [
    translator.t("verification.secRunAsUser", { runAsUser: security.runAsUser }),
    translator.t(
      security.readOnlyRootfs ? "verification.secReadOnlyRoot" : "verification.secWritableRoot",
    ),
    translator.t(security.capDropAll ? "verification.secCapDropAll" : "verification.secKeepCaps"),
    translator.t(
      security.noNewPrivileges
        ? "verification.secNoNewPrivileges"
        : "verification.secAllowPrivilege",
    ),
    translator.t("verification.secNetwork", { mode: security.networkMode }),
    translator.t(
      security.supervisorPid1 ? "verification.secSupervisor" : "verification.secNoSupervisor",
    ),
  ].join(" · ");
}

function sideOf(
  result: VerificationGetResult,
  run: RunSummary | undefined,
  translator: Translator,
): VerificationCompareSide {
  const meta = result.meta;
  const command = commandFactsOf(result);
  return {
    verificationId: result.verificationId,
    status: result.status,
    runId: meta?.runId ?? null,
    checkpointLabel: checkpointLabelOf(meta, translator),
    snapshotId: meta?.snapshotId ?? null,
    outcome: result.terminated?.outcome ?? null,
    detail: result.terminated?.detail ?? null,
    evidenceComplete: result.terminated?.evidenceComplete ?? null,
    exitCode: command?.exitCode ?? null,
    durationMs: command?.durationMs ?? null,
    sourceStatus: result.sourceStatus,
    intervention: interventionOf(run, translator),
    logBytes: logBytesOf(result),
  };
}

function limitationList(
  left: VerificationGetResult,
  right: VerificationGetResult,
  sourceVerified: boolean | null,
  translator: Translator,
): string[] {
  const limitations: string[] = [
    translator.t("verification.cmpLimitAgentText"),
    translator.t("verification.cmpLimitNoAutoFix"),
  ];
  if (sourceVerified === false) {
    limitations.push(translator.t("verification.cmpLimitSourceUnverified"));
  }
  if (left.sourceStatus === "missing" || right.sourceStatus === "missing") {
    limitations.push(translator.t("verification.cmpLimitSourceMissing"));
  }
  if (left.meta?.environment === null || right.meta?.environment === null) {
    limitations.push(translator.t("verification.cmpLimitEnvironmentMissing"));
  }
  if (left.meta === null || right.meta === null) {
    limitations.push(translator.t("verification.cmpLimitMetaMissing"));
  }
  limitations.push(translator.t("verification.cmpLimitPlanBinding"));
  limitations.push(translator.t("verification.cmpLimitEnvVars"));
  return limitations;
}

/** 从桌面 IPC 结果构造共享判据入参（locatedSnapshotId/currentAssets 尚未接线 ⇒ null） */
function factsSideOf(
  result: VerificationGetResult,
  command: CommandFacts | null,
): VerificationFactsSide {
  const env = result.meta?.environment ?? null;
  return {
    verificationId: result.verificationId,
    status: result.status,
    profileId: result.meta?.profileId ?? null,
    manifestVersion: result.meta?.manifestVersion ?? null,
    planBindingDigest: result.meta?.planBindingDigest ?? null,
    commandId: result.meta?.commandId ?? null,
    executable: command?.executable ?? null,
    argv: command?.argv ?? null,
    cwd: command?.cwd ?? null,
    environment:
      env === null
        ? null
        : {
            platform: env.platform,
            imageDigest: env.imageDigest,
            toolchain: env.toolchain,
            limits: env.limits,
            security: env.security,
          },
    outcome: result.terminated?.outcome ?? null,
    evidenceComplete: result.terminated?.evidenceComplete ?? null,
    recordedSnapshotId: result.meta?.snapshotId ?? null,
    sourceStatus: result.sourceStatus,
    locatedSnapshotId: null,
    currentAssetsAvailable: null,
  };
}

export function compareVerifications(
  leftResult: VerificationGetResult,
  rightResult: VerificationGetResult,
  runs: readonly RunSummary[],
  translator: Translator,
): VerificationComparison {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const left = sideOf(
    leftResult,
    leftResult.meta === null ? undefined : byId.get(leftResult.meta.runId),
    translator,
  );
  const right = sideOf(
    rightResult,
    rightResult.meta === null ? undefined : byId.get(rightResult.meta.runId),
    translator,
  );
  const leftMeta = leftResult.meta;
  const rightMeta = rightResult.meta;
  const leftCommand = commandFactsOf(leftResult);
  const rightCommand = commandFactsOf(rightResult);

  // 共享判据（@rebaseagent/project-verification/facts）：状态与结论只出自这里
  const facts = compareVerificationFacts(
    factsSideOf(leftResult, leftCommand),
    factsSideOf(rightResult, rightCommand),
  );
  const stateByKey = new Map(facts.conditions.map((condition) => [condition.key, condition.state]));

  const displayRows: [string, string, string | null, string | null][] = [
    [
      "profileId",
      translator.t("verification.cmpProfile"),
      leftMeta?.profileId ?? null,
      rightMeta?.profileId ?? null,
    ],
    [
      "manifestVersion",
      translator.t("verification.cmpManifestVersion"),
      leftMeta === null ? null : String(leftMeta.manifestVersion),
      rightMeta === null ? null : String(rightMeta.manifestVersion),
    ],
    [
      "planBindingDigest",
      translator.t("verification.cmpPlanBinding"),
      leftMeta?.planBindingDigest ?? null,
      rightMeta?.planBindingDigest ?? null,
    ],
    [
      "commandId",
      translator.t("verification.cmpCommand"),
      leftMeta?.commandId ?? null,
      rightMeta?.commandId ?? null,
    ],
    [
      "command",
      translator.t("verification.cmpExecutable"),
      // join 仅用于显示；判等由共享判据按数组完成
      leftCommand === null ? null : `${leftCommand.executable} ${leftCommand.argv.join(" ")}`,
      rightCommand === null ? null : `${rightCommand.executable} ${rightCommand.argv.join(" ")}`,
    ],
    [
      "cwd",
      translator.t("verification.cmpCwd"),
      leftCommand?.cwd ?? null,
      rightCommand?.cwd ?? null,
    ],
    [
      "platform",
      translator.t("verification.cmpPlatform"),
      leftMeta?.environment?.platform ?? null,
      rightMeta?.environment?.platform ?? null,
    ],
    [
      "imageDigest",
      translator.t("verification.cmpImageDigest"),
      leftMeta?.environment?.imageDigest ?? null,
      rightMeta?.environment?.imageDigest ?? null,
    ],
    [
      "toolchain",
      translator.t("verification.cmpToolchain"),
      leftMeta?.environment === null || leftMeta?.environment === undefined
        ? null
        : formatToolchain(leftMeta.environment.toolchain),
      rightMeta?.environment === null || rightMeta?.environment === undefined
        ? null
        : formatToolchain(rightMeta.environment.toolchain),
    ],
    [
      "limits",
      translator.t("verification.cmpLimits"),
      leftMeta?.environment === null || leftMeta?.environment === undefined
        ? null
        : formatLimits(leftMeta.environment.limits, translator),
      rightMeta?.environment === null || rightMeta?.environment === undefined
        ? null
        : formatLimits(rightMeta.environment.limits, translator),
    ],
    [
      "security",
      translator.t("verification.cmpSecurity"),
      leftMeta?.environment === null || leftMeta?.environment === undefined
        ? null
        : formatSecurity(leftMeta.environment.security, translator),
      rightMeta?.environment === null || rightMeta?.environment === undefined
        ? null
        : formatSecurity(rightMeta.environment.security, translator),
    ],
  ];
  const conditions: VerificationCompareRow[] = displayRows.map(
    ([key, label, leftText, rightText]) => ({
      key,
      label,
      left: leftText,
      right: rightText,
      state: stateByKey.get(key as (typeof facts.conditions)[number]["key"]) ?? "unknown",
    }),
  );
  const differences = conditions.filter((one) => one.state === "different").map((one) => one.label);
  const unknowns = conditions.filter((one) => one.state === "unknown").map((one) => one.label);
  const codeSame = facts.codeSame;

  let verdict: VerificationCompareVerdict;
  switch (facts.verdict.kind) {
    case "outcome-unknown":
      verdict = {
        kind: "outcome-unknown",
        headline: translator.t("verification.cmpVerdictOutcomeUnknown"),
      };
      break;
    case "evidence-incomplete":
      verdict = {
        kind: "evidence-incomplete",
        headline: translator.t(
          facts.evidenceIncompleteFromCurrentAssets
            ? "verification.cmpVerdictAssetsUnverifiable"
            : "verification.cmpVerdictEvidenceIncomplete",
        ),
      };
      break;
    case "conditions-differ":
      verdict = {
        kind: "conditions-differ",
        headline: translator.t("verification.cmpVerdictConditionsDiffer"),
        differences,
      };
      break;
    case "conditions-unknown":
      verdict = {
        kind: "conditions-unknown",
        headline: translator.t("verification.cmpVerdictConditionsUnknown"),
        unknowns,
      };
      break;
    case "failed-to-passed":
      verdict = {
        kind: "failed-to-passed",
        headline: translator.t("verification.cmpVerdictFailedToPassed"),
      };
      break;
    default:
      verdict = {
        kind: "same-conditions-other-outcome",
        headline: translator.t("verification.cmpVerdictSameOther", {
          left: left.outcome ?? translator.t("verification.compareUnknownShort"),
          right: right.outcome ?? translator.t("verification.compareUnknownShort"),
        }),
      };
  }

  return {
    left,
    right,
    conditions,
    verdict,
    codeSame,
    limitations: limitationList(leftResult, rightResult, facts.sourceVerified, translator),
  };
}
