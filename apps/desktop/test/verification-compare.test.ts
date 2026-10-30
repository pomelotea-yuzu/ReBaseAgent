import type { RunSummary, VerificationGetResult } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { compareVerifications } from "../src/renderer/src/lib/verification-compare";
import { createTestTranslator } from "./i18n/render-with-locale";

/**
 * R3 任务 5.4：比较判据（D07/P24/P25 逐字）。
 * - 同条件失败→通过只在「全部已记录条件 same + 证据完整 + check_failed→passed」时成立；
 * - 条件不同/缺字段必须显式标注，不得合成同条件；
 * - 干预只来自运行分叉元数据；Agent 文本不进入结论。
 */

const zh = createTestTranslator("zh-CN");
const en = createTestTranslator("en-US");

const D = "a".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;

const ENV = {
  preparationId: "prep-1",
  imageDigest: IMAGE,
  platform: "linux/amd64" as const,
  toolchain: { node: "22.23.4", npm: "10.9.9", typescript: "5.9.3" },
  limits: {
    cpus: 1,
    memoryBytes: 536870912,
    pidsLimit: 64,
    workTmpfsBytes: 167772160,
    tmpTmpfsBytes: 33554432,
    commandTimeoutMs: 120000,
    totalTimeoutMs: 180000,
    stdoutBudgetBytes: 1048576,
    stderrBudgetBytes: 1048576,
    totalOutputLimitBytes: 16777216,
    artifactUniqueContentBudgetBytes: 134217728,
    tmpfsCountsTowardMemoryBudget: true as const,
  },
  security: {
    runAsUser: "1000:1000" as const,
    readOnlyRootfs: true as const,
    capDropAll: true as const,
    noNewPrivileges: true as const,
    networkMode: "none" as const,
    supervisorPid1: true as const,
  },
};

function recordOf(overrides: {
  verificationId?: string;
  runId?: string;
  snapshotId?: string;
  planBindingDigest?: string;
  env?: typeof ENV | null;
  outcome?: "check_failed" | "passed";
  evidenceComplete?: boolean;
  argv?: string[];
  terminated?: boolean;
  sourceStatus?: "present" | "missing" | "unknown";
  status?: VerificationGetResult["status"];
}): VerificationGetResult {
  const outcome = overrides.outcome ?? "check_failed";
  const terminated =
    overrides.terminated === false
      ? null
      : {
          outcome,
          detail: outcome === "passed" ? "tests 2 pass 2" : "断言失败",
          evidenceComplete: overrides.evidenceComplete ?? true,
          at: "2026-10-25T10:00:06.000Z",
        };
  return {
    verificationId: overrides.verificationId ?? "ver-1",
    status: overrides.status ?? (terminated === null ? "unterminated" : "sealed"),
    events: [
      { type: "stage", phase: "executing" },
      {
        type: "command_start",
        commandId: "test",
        executable: "node",
        argv: overrides.argv ?? ["--test", "calc.test.mjs"],
        cwd: "/work",
        startedAt: "2026-10-25T10:00:00.000Z",
      },
      {
        type: "command_end",
        commandId: "test",
        exitCode: outcome === "passed" ? 0 : 1,
        durationMs: 1850,
        stdout: { byteLength: 10, totalBytes: 10, truncated: false },
        stderr: { byteLength: 0, totalBytes: 0, truncated: false },
      },
    ],
    error: null,
    meta: {
      runId: overrides.runId ?? "run_base",
      checkpoint: { kind: "initial" },
      snapshotId: overrides.snapshotId ?? "snap_base",
      profileId: "node-ts-v1",
      manifestVersion: 3,
      commandId: "test",
      planBindingDigest: overrides.planBindingDigest ?? D,
      createdAt: "2026-10-25T10:00:00.000Z",
      environment: overrides.env === undefined ? ENV : overrides.env,
    },
    terminated,
    sourceStatus: overrides.sourceStatus ?? "present",
  };
}

function runOf(overrides: Partial<RunSummary> & { id: string }): RunSummary {
  return {
    task: "修复",
    model: "m",
    created_at: "2026-10-25T09:00:00.000Z",
    status: "completed",
    parent: null,
    reason: "completed",
    fork: null,
    steps: 3,
    toolCalls: 2,
    toolErrors: 0,
    tokensIn: 10,
    tokensOut: 5,
    cacheHit: null,
    durationMs: 1000,
    source: null,
    ...overrides,
  };
}

const BASE_RUN = runOf({ id: "run_base" });
const FIX_RUN = runOf({
  id: "run_fix",
  parent: "run_base",
  fork: { at_span: "s_02", edit_field: "result", experiment_id: null },
});

describe("compareVerifications（D07/P24：同条件失败→通过与干预来源）", () => {
  it("条件全同 + 左 check_failed/右 passed + 证据完整 ⇒ failed-to-passed（声明范围受限）", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old", runId: "run_base", outcome: "check_failed" }),
      recordOf({
        verificationId: "ver-fix",
        runId: "run_fix",
        snapshotId: "snap_fix",
        outcome: "passed",
      }),
      [BASE_RUN, FIX_RUN],
      zh,
    );
    expect(comparison.verdict.kind).toBe("failed-to-passed");
    expect(comparison.verdict.headline).toContain("同条件失败→通过");
    expect(comparison.verdict.headline).toContain("不宣布完整正确或因果关系");
    expect(comparison.conditions.every((one) => one.state === "same")).toBe(true);
    expect(comparison.codeSame).toBe(false);
    expect(comparison.left.intervention).toContain("无记录的分叉");
    expect(comparison.right.intervention).toContain("编辑 result @ s_02");
  });

  it("计划绑定摘要不同 ⇒ conditions-differ，绝不合成失败→通过（P25）", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old", outcome: "check_failed" }),
      recordOf({
        verificationId: "ver-fix",
        runId: "run_fix",
        outcome: "passed",
        planBindingDigest: "c".repeat(64),
      }),
      [BASE_RUN, FIX_RUN],
      zh,
    );
    expect(comparison.verdict.kind).toBe("conditions-differ");
    if (comparison.verdict.kind !== "conditions-differ") return;
    expect(comparison.verdict.differences).toContain("计划绑定摘要（计划×策略×配方）");
    expect(comparison.verdict.headline).toContain("不构成同条件失败→通过");
  });

  it("argv 不同 ⇒ 条件不同（命令事实来自 command_start）", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old" }),
      recordOf({
        verificationId: "ver-fix",
        runId: "run_fix",
        outcome: "passed",
        argv: ["--test", "other.test.mjs"],
      }),
      [BASE_RUN, FIX_RUN],
      zh,
    );
    const command = comparison.conditions.find((one) => one.key === "command");
    expect(command?.state).toBe("different");
    expect(comparison.verdict.kind).toBe("conditions-differ");
  });

  it("环境身份缺字段 ⇒ conditions-unknown（不拿当前 manifest 补）", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old", env: null }),
      recordOf({ verificationId: "ver-fix", runId: "run_fix", outcome: "passed" }),
      [BASE_RUN, FIX_RUN],
      zh,
    );
    expect(comparison.verdict.kind).toBe("conditions-unknown");
    if (comparison.verdict.kind !== "conditions-unknown") return;
    expect(comparison.verdict.unknowns).toEqual(
      expect.arrayContaining(["实际镜像摘要", "运行时版本", "资源限额", "隔离基线"]),
    );
    expect(comparison.conditions.find((one) => one.key === "imageDigest")?.state).toBe("unknown");
  });

  it("通过侧证据不完整 ⇒ evidence-incomplete（P12：缺项不能形成通过）", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old" }),
      recordOf({
        verificationId: "ver-fix",
        runId: "run_fix",
        outcome: "passed",
        evidenceComplete: false,
      }),
      [BASE_RUN, FIX_RUN],
      zh,
    );
    expect(comparison.verdict.kind).toBe("evidence-incomplete");
    expect(comparison.verdict.headline).toContain("不形成修复结论");
  });

  it("未封存记录 ⇒ outcome-unknown，不呈现结局", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old", terminated: false }),
      recordOf({ verificationId: "ver-fix", runId: "run_fix", outcome: "passed" }),
      [BASE_RUN, FIX_RUN],
      zh,
    );
    expect(comparison.verdict.kind).toBe("outcome-unknown");
    expect(comparison.left.outcome).toBeNull();
  });

  it("同条件但两侧都不是失败→通过 ⇒ 如实说实际结局", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-a", outcome: "passed" }),
      recordOf({ verificationId: "ver-b", runId: "run_fix", outcome: "passed" }),
      [BASE_RUN, FIX_RUN],
      zh,
    );
    expect(comparison.verdict.kind).toBe("same-conditions-other-outcome");
    expect(comparison.verdict.headline).toContain("passed / passed");
  });
});

describe("比较的未知与限制（P25/D07）", () => {
  it("来源缺失/环境缺字段/干预不可确认都进 limitations，且 Agent 文本显式排除", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old", sourceStatus: "missing", env: null }),
      recordOf({ verificationId: "ver-fix", runId: "run_fix", outcome: "passed" }),
      [FIX_RUN],
      zh,
    );
    expect(comparison.limitations.join("\n")).toContain("trace 已缺失");
    expect(comparison.limitations.join("\n")).toContain("未保存环境身份");
    expect(comparison.limitations.join("\n")).toContain("Agent 文本不进入条件与结论");
    expect(comparison.limitations.join("\n")).toContain("计划绑定摘要锚定");
    expect(comparison.left.intervention).toContain("不在当前列表");
  });

  it("代码快照同一 ⇒ codeSame=true；缺 meta ⇒ null（不猜相同）", () => {
    const same = compareVerifications(
      recordOf({ verificationId: "ver-a" }),
      recordOf({ verificationId: "ver-b", outcome: "passed" }),
      [BASE_RUN],
      zh,
    );
    expect(same.codeSame).toBe(true);
    const broken = recordOf({ verificationId: "ver-c" });
    const unknown = compareVerifications(
      broken,
      { ...broken, meta: null, status: "corrupt" },
      [],
      zh,
    );
    expect(unknown.codeSame).toBeNull();
  });
});

describe("compareVerifications 英文投影（D19：条件/干预/结论独立成句）", () => {
  it("同条件失败→通过、条件行与干预按英文呈现，事实值不变", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old", runId: "run_base", outcome: "check_failed" }),
      recordOf({
        verificationId: "ver-fix",
        runId: "run_fix",
        snapshotId: "snap_fix",
        outcome: "passed",
      }),
      [BASE_RUN, FIX_RUN],
      en,
    );
    expect(comparison.verdict.kind).toBe("failed-to-passed");
    expect(comparison.verdict.headline).toContain("Same conditions failed → passed");
    expect(comparison.verdict.headline).toContain("does not claim complete correctness");
    const labels = comparison.conditions.map((one) => one.label);
    expect(labels).toContain("Plan binding digest (plan × strategy × recipe)");
    expect(labels).toContain("Runtime versions");
    expect(comparison.left.intervention).toContain("No recorded fork");
    expect(comparison.right.intervention).toContain(
      "Recorded fork: edit result @ s_02 (parent run_base)",
    );
    expect(comparison.conditions.find((one) => one.key === "limits")?.left).toContain("CPU 1 core");
    expect(comparison.conditions.find((one) => one.key === "security")?.left).toContain(
      "non-root 1000:1000",
    );
    expect(comparison.limitations.join("\n")).toContain("Agent text does not enter conditions");
  });

  it("条件不同的差异项使用英文标签（不把中文标签混入英文结论）", () => {
    const comparison = compareVerifications(
      recordOf({ verificationId: "ver-old" }),
      recordOf({
        verificationId: "ver-fix",
        runId: "run_fix",
        outcome: "passed",
        planBindingDigest: "c".repeat(64),
      }),
      [BASE_RUN, FIX_RUN],
      en,
    );
    expect(comparison.verdict.kind).toBe("conditions-differ");
    if (comparison.verdict.kind !== "conditions-differ") return;
    expect(comparison.verdict.differences).toContain(
      "Plan binding digest (plan × strategy × recipe)",
    );
    expect(comparison.verdict.headline).toContain("not a same-condition");
  });
});
