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

function limitationList(
  left: VerificationGetResult,
  right: VerificationGetResult,
  sourceVerified: boolean | null,
): string[] {
  const limitations: string[] = [
    "Agent 文本不进入条件与结论；本区只读验证记录与运行分叉元数据。",
    "R3 不自动发起模型修复；干预是否成立以运行记录的分叉元数据为准。",
  ];
  if (sourceVerified === false) {
    limitations.push("至少一侧来源 trace 缺失或快照与记录不符：不宣称已核验修复分支或代码因果。");
  }
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
  const leftCommand = commandFactsOf(leftResult);
  const rightCommand = commandFactsOf(rightResult);

  // 共享判据（@rebaseagent/project-verification/facts）：状态与结论只出自这里
  const facts = compareVerificationFacts(
    factsSideOf(leftResult, leftCommand),
    factsSideOf(rightResult, rightCommand),
  );
  const stateByKey = new Map(facts.conditions.map((condition) => [condition.key, condition.state]));

  const displayRows: [string, string, string | null, string | null][] = [
    ["profileId", "profile", leftMeta?.profileId ?? null, rightMeta?.profileId ?? null],
    [
      "manifestVersion",
      "manifest 版本",
      leftMeta === null ? null : String(leftMeta.manifestVersion),
      rightMeta === null ? null : String(rightMeta.manifestVersion),
    ],
    [
      "planBindingDigest",
      "计划绑定摘要（计划×策略×配方）",
      leftMeta?.planBindingDigest ?? null,
      rightMeta?.planBindingDigest ?? null,
    ],
    ["commandId", "检查命令", leftMeta?.commandId ?? null, rightMeta?.commandId ?? null],
    [
      "command",
      "executable + argv",
      // join 仅用于显示；判等由共享判据按数组完成
      leftCommand === null ? null : `${leftCommand.executable} ${leftCommand.argv.join(" ")}`,
      rightCommand === null ? null : `${rightCommand.executable} ${rightCommand.argv.join(" ")}`,
    ],
    ["cwd", "工作目录", leftCommand?.cwd ?? null, rightCommand?.cwd ?? null],
    [
      "platform",
      "平台",
      leftMeta?.environment?.platform ?? null,
      rightMeta?.environment?.platform ?? null,
    ],
    [
      "imageDigest",
      "实际镜像摘要",
      leftMeta?.environment?.imageDigest ?? null,
      rightMeta?.environment?.imageDigest ?? null,
    ],
    [
      "toolchain",
      "运行时版本",
      leftMeta?.environment === null || leftMeta?.environment === undefined
        ? null
        : formatToolchain(leftMeta.environment.toolchain),
      rightMeta?.environment === null || rightMeta?.environment === undefined
        ? null
        : formatToolchain(rightMeta.environment.toolchain),
    ],
    [
      "limits",
      "资源限额",
      leftMeta?.environment === null || leftMeta?.environment === undefined
        ? null
        : formatLimits(leftMeta.environment.limits),
      rightMeta?.environment === null || rightMeta?.environment === undefined
        ? null
        : formatLimits(rightMeta.environment.limits),
    ],
    [
      "security",
      "隔离基线",
      leftMeta?.environment === null || leftMeta?.environment === undefined
        ? null
        : formatSecurity(leftMeta.environment.security),
      rightMeta?.environment === null || rightMeta?.environment === undefined
        ? null
        : formatSecurity(rightMeta.environment.security),
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
        headline: "至少一侧记录未封存/不可读：不形成比较结论（不以未完成事实冒充结果）。",
      };
      break;
    case "evidence-incomplete":
      verdict = {
        kind: "evidence-incomplete",
        headline: facts.evidenceIncompleteFromCurrentAssets
          ? "至少一侧当前必需资产不可核验：不形成可核查的修复结论（历史结局不改写）。"
          : "至少一侧证据不完整：不形成修复结论（缺项不能以模型文本补齐）。",
      };
      break;
    case "conditions-differ":
      verdict = {
        kind: "conditions-differ",
        headline: "条件不同：不构成同条件失败→通过。",
        differences,
      };
      break;
    case "conditions-unknown":
      verdict = {
        kind: "conditions-unknown",
        headline: "条件未知（记录缺字段）：不构成同条件失败→通过。",
        unknowns,
      };
      break;
    case "failed-to-passed":
      verdict = {
        kind: "failed-to-passed",
        headline:
          "同条件失败→通过：仅指该固定检查在两侧已记录的相同条件下由 check_failed 变为 passed；不宣布完整正确或因果关系。",
      };
      break;
    default:
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
    limitations: limitationList(leftResult, rightResult, facts.sourceVerified),
  };
}
