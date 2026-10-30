import type { VerificationCapabilityResult, VerificationPreparePlanResult } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { describe, expect, it } from "vitest";
import {
  blockersFor,
  collectVerificationCompareCandidates,
  decideVerificationConfirmation,
  matchVerificationRecords,
  profileLimitsLine,
  trustedVerificationIdsOf,
  verificationBlockers,
  verificationDecisionLine,
  verificationDomainIdOf,
  verificationPrepareDisclosure,
  verificationRecordLine,
  verificationRunDisclosure,
  verificationTargetKey,
  verificationTargetLabel,
} from "../src/renderer/src/lib/verification-entry";
import { createTestTranslator } from "./i18n/render-with-locale";

/**
 * R3 任务 5.1：验证入口与分开确认的**纯判据**。
 *
 * 判据来源：delta 场景 D01「计划预览和不可用原因」/ D02「当前确认与计划漂移」逐字：
 * - D01：显示精确输入和当前条件，失败原因连接可行动说明；
 * - D02：旧确认失效并重新核对，准备与执行许可不互相替代，不自动提交新计划。
 */

const RUN = "run_a";
const STEP = "s_02";
const zh = createTestTranslator("zh-CN");
const en = createTestTranslator("en-US");

function capabilityOf(
  overrides?: Partial<VerificationCapabilityResult>,
): VerificationCapabilityResult {
  return {
    planToken: "token-1",
    prepared: null,
    engine: { available: true, engineVersion: "29.9.2", reason: null },
    source: {
      snapshotId: "snap-1",
      fileCount: 3,
      totalBytes: 1024,
      stepSpanId: null,
    },
    sourceFailure: null,
    profileSummary: {
      profileId: "node-ts-v1",
      manifestVersion: 3,
      platform: "linux/amd64",
      toolchain: { node: "22.23.4", npm: "10.9.9", typescript: "5.9.3" },
      sourceIncludeGlob: "src/**/*.ts",
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
        tmpfsCountsTowardMemoryBudget: true,
      },
      security: {
        runAsUser: "1000:1000",
        readOnlyRootfs: true,
        capDropAll: true,
        noNewPrivileges: true,
        networkMode: "none",
        supervisorPid1: true,
      },
    },
    ...overrides,
  };
}

function planOf(
  overrides?: Partial<VerificationPreparePlanResult["plan"]>,
): VerificationPreparePlanResult {
  return {
    planDigest: "sha256:aa",
    planToken: "token-1",
    plan: {
      profileId: "node-ts-v1",
      manifestVersion: 3,
      manifestDigest: "sha256:bb",
      downloads: [
        {
          source: "docker.m.daocloud.io/library/node@sha256:cc",
          approxBytes: 61337515,
          license: "Node.js 运行时（MIT）",
        },
      ],
      networkScopeNote: "仅本次准备允许联网；正式测试断网。",
      spaceEstimateBytes: 509875138,
      ...overrides,
    },
  };
}

describe("verificationTargetKey（显式 selector 的唯一键）", () => {
  it("initial 与 step 不同；不同 stepSpanId 不同；同目标同键", () => {
    const initial = verificationTargetKey({ runId: RUN, checkpoint: { kind: "initial" } });
    const stepA = verificationTargetKey({
      runId: RUN,
      checkpoint: { kind: "step", stepSpanId: STEP },
    });
    const stepB = verificationTargetKey({
      runId: RUN,
      checkpoint: { kind: "step", stepSpanId: "s_03" },
    });
    const otherRun = verificationTargetKey({ runId: "run_b", checkpoint: { kind: "initial" } });
    expect(initial).not.toBe(stepA);
    expect(stepA).not.toBe(stepB);
    expect(initial).not.toBe(otherRun);
    expect(verificationTargetKey({ runId: RUN, checkpoint: { kind: "initial" } })).toBe(initial);
    expect(
      verificationTargetKey({ runId: RUN, checkpoint: { kind: "step", stepSpanId: STEP } }),
    ).toBe(stepA);
  });

  it("目标可读名区分初始与步骤（确认卡指名'是哪一次'）", () => {
    expect(verificationTargetLabel({ kind: "initial" }, zh)).toBe("初始检查点");
    expect(verificationTargetLabel({ kind: "step", stepSpanId: STEP }, zh)).toContain(STEP);
    expect(verificationTargetLabel({ kind: "initial" }, en)).toBe("Initial checkpoint");
    expect(verificationTargetLabel({ kind: "step", stepSpanId: STEP }, en)).toBe(
      `Step checkpoint ${STEP}`,
    );
  });
});

describe("verificationBlockers（D01：不可用原因可行动）", () => {
  it("尚未核对（null）⇒ 零条目——'没核对'不冒充'没问题'", () => {
    expect(verificationBlockers(null, zh)).toEqual([]);
  });

  it("全部就绪 ⇒ 零条目", () => {
    const allReady = capabilityOf({
      prepared: {
        preparationId: "prep-1",
        imageDigest: "sha256:dd",
        toolchain: { node: "22.23.4", typescript: "5.9.3" },
      },
    });
    expect(verificationBlockers(allReady, zh)).toEqual([]);
  });

  it("引擎不可用 ⇒ 挡准备的可行动原因（说明不自动安装、不回退宿主 Shell）", () => {
    const blockers = verificationBlockers(
      capabilityOf({
        engine: {
          available: false,
          engineVersion: null,
          reason: "未发现可信 Docker Desktop CLI（P01：不隐式安装、不回退宿主 Shell）",
        },
        prepared: {
          preparationId: "prep-1",
          imageDigest: "sha256:dd",
          toolchain: { node: "22.23.4", typescript: "5.9.3" },
        },
      }),
      zh,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.code).toBe("engine_unavailable");
    expect(blockers[0]?.gates).toBe("prepare");
    expect(blockers[0]?.reason).toContain("Docker Desktop");
    expect(blockers[0]?.reason).toContain("不会自动安装");
  });

  it("来源不成立 ⇒ 只挡执行（准备环境不需要来源）", () => {
    const blockers = verificationBlockers(
      capabilityOf({
        source: null,
        sourceFailure: { code: "run_not_found", reason: "运行不存在" },
        prepared: {
          preparationId: "prep-1",
          imageDigest: "sha256:dd",
          toolchain: { node: "22.23.4", typescript: "5.9.3" },
        },
      }),
      zh,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.gates).toBe("run");
    expect(blockers[0]?.code).toBe("run_not_found");
  });

  it("未准备环境 ⇒ 只挡执行，并指向先完成准备", () => {
    const blockers = verificationBlockers(capabilityOf(), zh);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.code).toBe("prepare_missing");
    expect(blockers[0]?.gates).toBe("run");
  });

  it("blockersFor 按 gates 过滤（确认/提交按钮各取所需）", () => {
    const blockers = verificationBlockers(
      capabilityOf({
        engine: { available: false, engineVersion: null, reason: "引擎不可达" },
        source: null,
        sourceFailure: { code: "x", reason: "y" },
      }),
      zh,
    );
    expect(blockersFor(blockers, "prepare").map((one) => one.code)).toEqual(["engine_unavailable"]);
    expect(blockersFor(blockers, "run").map((one) => one.code)).toEqual(["x", "prepare_missing"]);
  });
});

describe("decideVerificationConfirmation（D02：现算判定，漂移即失效）", () => {
  const armed = { planToken: "token-1", targetKey: "k" };

  it("未确认 ⇒ missing（不含糊、说明要先核对确认）", () => {
    const decision = decideVerificationConfirmation({
      armed: null,
      currentPlanToken: "token-1",
      currentTargetKey: "k",
    });
    expect(decision).toEqual({ kind: "missing", reason: "not_armed" });
    expect(verificationDecisionLine(decision, zh)).toContain("尚未确认");
    expect(verificationDecisionLine(decision, en)).toContain("Not confirmed");
  });

  it("目标变化 ⇒ stale（旧确认绑定另一个检查点）", () => {
    const decision = decideVerificationConfirmation({
      armed,
      currentPlanToken: "token-1",
      currentTargetKey: "k2",
    });
    expect(decision).toEqual({ kind: "stale", reason: "target_changed" });
  });

  it("计划 token 漂移 ⇒ stale（计划/策略/配方任一变化）", () => {
    const decision = decideVerificationConfirmation({
      armed,
      currentPlanToken: "token-2",
      currentTargetKey: "k",
    });
    expect(decision).toEqual({ kind: "stale", reason: "plan_changed" });
    expect(verificationDecisionLine(decision, zh)).toContain("旧确认失效");
    expect(verificationDecisionLine(decision, en)).toContain("old confirmation is invalid");
  });

  it("当前计划未知（核对缺失）⇒ stale，不沿用旧确认", () => {
    const decision = decideVerificationConfirmation({
      armed,
      currentPlanToken: null,
      currentTargetKey: "k",
    });
    expect(decision).toEqual({ kind: "stale", reason: "plan_unknown" });
  });

  it("命令变化 ⇒ stale（执行确认绑定命令；准备确认不受命令影响）", () => {
    const runArmed = { planToken: "token-1", targetKey: "k", commandId: "test" as const };
    const switched = decideVerificationConfirmation({
      armed: runArmed,
      currentPlanToken: "token-1",
      currentTargetKey: "k",
      currentCommandId: "typecheck",
    });
    expect(switched).toEqual({ kind: "stale", reason: "command_changed" });
    const same = decideVerificationConfirmation({
      armed: runArmed,
      currentPlanToken: "token-1",
      currentTargetKey: "k",
      currentCommandId: "test",
    });
    expect(same.kind).toBe("confirmed");
    // 准备确认没有 commandId：不受命令切换影响（两份确认独立）
    const prepareArmed = { planToken: "token-1", targetKey: "k" };
    expect(
      decideVerificationConfirmation({
        armed: prepareArmed,
        currentPlanToken: "token-1",
        currentTargetKey: "k",
        currentCommandId: "typecheck",
      }).kind,
    ).toBe("confirmed");
  });

  it("逐分量一致 ⇒ confirmed", () => {
    expect(
      decideVerificationConfirmation({
        armed,
        currentPlanToken: "token-1",
        currentTargetKey: "k",
      }).kind,
    ).toBe("confirmed");
  });
});

describe("披露行（D01：精确输入与当前条件）", () => {
  it("准备披露包含下载来源/体积/许可、网络注记与分开确认边界", () => {
    const disclosure = verificationPrepareDisclosure(
      {
        runId: RUN,
        checkpointLabel: "初始检查点",
        capability: capabilityOf(),
        plan: planOf(),
      },
      zh,
    );
    const labels = disclosure.facts.map((one) => one.label);
    expect(labels).toContain("下载来源 1");
    const download = disclosure.facts.find((one) => one.label === "下载来源 1");
    expect(download?.value).toContain("docker.m.daocloud.io");
    expect(download?.value).toContain("Node.js 运行时（MIT）");
    expect(disclosure.limits.join("\n")).toContain("计划原文：仅本次准备允许联网");
    expect(disclosure.limits.join("\n")).toContain("分开确认");
    expect(disclosure.limits.join("\n")).toContain("自动提交");
  });

  it("准备披露按语言投影标签与边界（原文计划保持原字节）", () => {
    const input = {
      runId: RUN,
      checkpointLabel: "Initial checkpoint",
      capability: capabilityOf(),
      plan: planOf(),
    };
    const english = verificationPrepareDisclosure(input, en);
    expect(english.summary).toContain("One-time environment preparation");
    expect(english.facts.map((one) => one.label)).toContain("Download source 1");
    expect(english.facts.map((one) => one.label)).toContain("Target run");
    expect(english.facts.map((one) => one.label)).toContain("Authorization for this run");
    expect(english.limits.join("\n")).toContain("Plan original text:");
    // 计划正文进入 token：只加原文标签，不改写字节
    expect(english.limits.join("\n")).toContain("仅本次准备允许联网");
    expect(english.checks.join("\n")).toContain("zero model calls");
  });

  it("计划未取得时准备披露如实说明（不冒充有计划）", () => {
    const disclosure = verificationPrepareDisclosure(
      {
        runId: RUN,
        checkpointLabel: "初始检查点",
        capability: null,
        plan: null,
      },
      zh,
    );
    const all = disclosure.facts.map((one) => `${one.label}: ${one.value}`).join("\n");
    expect(all).toContain("尚未取得计划");
  });

  it("执行披露包含精确输入（快照/文件数/字节）、已准备环境与限额隔离基线", () => {
    const disclosure = verificationRunDisclosure(
      {
        runId: RUN,
        checkpointLabel: "步骤检查点 s_02",
        commandId: "test",
        capability: capabilityOf({
          prepared: {
            preparationId: "prep-1",
            imageDigest: "sha256:dd",
            toolchain: { node: "22.23.4", typescript: "5.9.3" },
          },
        }),
      },
      zh,
    );
    const all = [...disclosure.facts.map((one) => `${one.label}: ${one.value}`)].join("\n");
    expect(all).toContain("snap-1");
    expect(all).toContain("3 个文件");
    expect(all).toContain("prep-1");
    expect(all).toContain("sha256:dd");
    expect(all).toContain("Node 22.23.4");
    expect(all).toContain("512");
    expect(all).toContain("断网");
    expect(disclosure.limits.join("\n")).toContain("不互相替代");
    expect(disclosure.limits.join("\n")).toContain("Agent 文本");
  });

  it("执行披露英文：单复数/边界措辞独立成句，事实值不变", () => {
    const disclosure = verificationRunDisclosure(
      {
        runId: RUN,
        checkpointLabel: "Step checkpoint s_02",
        commandId: "typecheck",
        capability: capabilityOf({
          prepared: {
            preparationId: "prep-1",
            imageDigest: "sha256:dd",
            toolchain: { node: "22.23.4", typescript: "5.9.3" },
          },
        }),
      },
      en,
    );
    const all = disclosure.facts.map((one) => `${one.label}: ${one.value}`).join("\n");
    expect(disclosure.summary).toContain("Run fixed check typecheck");
    expect(all).toContain("3 files");
    expect(all).toContain("Prepared prep-1");
    expect(all).toContain("non-root (1000:1000)");
    expect(disclosure.limits.join("\n")).toContain(
      "Preparation and execution permits do not replace each other",
    );
  });

  it("未准备时执行披露如实说明执行环境未知", () => {
    const disclosure = verificationRunDisclosure(
      {
        runId: RUN,
        checkpointLabel: "初始检查点",
        commandId: "typecheck",
        capability: capabilityOf(),
      },
      zh,
    );
    const all = disclosure.facts.map((one) => `${one.label}: ${one.value}`).join("\n");
    expect(all).toContain("尚未准备");
  });
});

describe("profileLimitsLine（限额行的格式化）", () => {
  it("产出单行人类可读限额（数字来自 profile 投影）", () => {
    const limits = {
      cpus: 1,
      memoryBytes: 536870912,
      pidsLimit: 64,
      commandTimeoutMs: 120000,
      totalTimeoutMs: 180000,
    };
    const line = profileLimitsLine(limits, en);
    expect(line).toContain("CPU 1 core");
    expect(line).toContain("Memory 512.0 MB");
    expect(line).toContain("PIDs 64");
    expect(line).toContain("120 s per command");
    expect(line).toContain("180 s total");
    expect(profileLimitsLine(limits, zh)).toContain("1 核");
  });
});

// ---------------------------------------------------------------------------
// 5.2：操作登记核实（D03/D05/M01——可信领域 ID 只来自登记，不猜）
// ---------------------------------------------------------------------------

const RECORD_BASE: OperationRecord = {
  epoch: "44444444-4444-4444-8444-444444444444",
  operationId: "55555555-5555-4555-8555-555555555555",
  target: {
    kind: "verification",
    runId: RUN,
    checkpointKind: "initial",
    stepSpanId: null,
    commandId: "test",
  },
  state: "running",
  rejection: null,
  startedAt: "2026-10-25T10:00:00.000Z",
  settledAt: null,
  runIds: [],
  experimentId: null,
  arms: [],
  preparationIds: [],
  verificationIds: ["ver-trusted"],
  requestOutcome: null,
  errorCode: null,
  diagnostics: [],
};

describe("matchVerificationRecords（按显式目标匹配登记，不猜）", () => {
  const session = { epoch: RECORD_BASE.epoch, operations: [RECORD_BASE] };

  it("run + 检查点形态一致 ⇒ 匹配；runId 不同 ⇒ 不匹配", () => {
    expect(
      matchVerificationRecords(session, { runId: RUN, checkpoint: { kind: "initial" } }),
    ).toHaveLength(1);
    expect(
      matchVerificationRecords(session, { runId: "run_other", checkpoint: { kind: "initial" } }),
    ).toHaveLength(0);
  });

  it("initial 与 step 不互配；stepSpanId 必须一致", () => {
    expect(
      matchVerificationRecords(session, {
        runId: RUN,
        checkpoint: { kind: "step", stepSpanId: STEP },
      }),
    ).toHaveLength(0);
    const stepRecord: OperationRecord = {
      ...RECORD_BASE,
      target: {
        kind: "verificationPrepare",
        runId: RUN,
        checkpointKind: "step",
        stepSpanId: STEP,
      },
    };
    const stepSession = { epoch: RECORD_BASE.epoch, operations: [stepRecord] };
    expect(
      matchVerificationRecords(stepSession, {
        runId: RUN,
        checkpoint: { kind: "step", stepSpanId: STEP },
      }),
    ).toHaveLength(1);
    expect(
      matchVerificationRecords(stepSession, {
        runId: RUN,
        checkpoint: { kind: "step", stepSpanId: "s_other" },
      }),
    ).toHaveLength(0);
  });

  it("tombstone（target=null）不匹配（D03：封禁不冒充执行事实）", () => {
    const tombstone: OperationRecord = {
      ...RECORD_BASE,
      operationId: "66666666-6666-4666-8666-666666666666",
      target: null,
      state: "notAccepted",
      rejection: "reconcile_tombstone",
      startedAt: null,
    };
    expect(
      matchVerificationRecords(
        { epoch: RECORD_BASE.epoch, operations: [tombstone] },
        { runId: RUN, checkpoint: { kind: "initial" } },
      ),
    ).toHaveLength(0);
  });
});

describe("verificationDomainIdOf（D06：领域 ID 只从附件取）", () => {
  it("执行类取 verificationIds；准备类取 preparationIds", () => {
    expect(verificationDomainIdOf(RECORD_BASE, "run")).toBe("ver-trusted");
    expect(verificationDomainIdOf(RECORD_BASE, "prepare")).toBeNull();
    const prepareRecord: OperationRecord = {
      ...RECORD_BASE,
      target: {
        kind: "verificationPrepare",
        runId: RUN,
        checkpointKind: "initial",
        stepSpanId: null,
      },
      verificationIds: [],
      preparationIds: ["prep-trusted"],
    };
    expect(verificationDomainIdOf(prepareRecord, "prepare")).toBe("prep-trusted");
  });

  it("记录缺失或尚未关联 ⇒ null（调用方不得猜测，只能核对）", () => {
    expect(verificationDomainIdOf(undefined, "run")).toBeNull();
    expect(verificationDomainIdOf({ ...RECORD_BASE, verificationIds: [] }, "run")).toBeNull();
  });
});

describe("verificationRecordLine（登记记录摘要行）", () => {
  it("区分类型与状态（执行中/已收尾/未接受）", () => {
    expect(verificationRecordLine(RECORD_BASE)).toContain("项目验证（test）");
    expect(verificationRecordLine(RECORD_BASE)).toContain("执行中");
    expect(
      verificationRecordLine({
        ...RECORD_BASE,
        state: "settled",
        settledAt: "2026-10-25T10:05:00.000Z",
        requestOutcome: "returned",
      }),
    ).toContain("已收尾（returned）");
    expect(
      verificationRecordLine({
        ...RECORD_BASE,
        target: {
          kind: "verificationPrepare",
          runId: RUN,
          checkpointKind: "initial",
          stepSpanId: null,
        },
        state: "notAccepted",
        rejection: "busy",
      }),
    ).toContain("未接受（busy）");
  });
});

describe("trustedVerificationIdsOf（D09/P16：身份只来自登记附件与响应回执）", () => {
  it("登记附件在前、响应回执补后；重复 ID 只出现一次", () => {
    expect(
      trustedVerificationIdsOf(
        [
          { ...RECORD_BASE, verificationIds: ["ver-a", "ver-b"] },
          { ...RECORD_BASE, verificationIds: ["ver-b", "ver-c"] },
        ],
        "ver-d",
      ),
    ).toEqual(["ver-a", "ver-b", "ver-c", "ver-d"]);
    expect(trustedVerificationIdsOf([RECORD_BASE], "ver-trusted")).toEqual(["ver-trusted"]);
  });

  it("无登记附件/无响应 ⇒ 空集（不从时间、日志或最新列表猜测身份）", () => {
    expect(trustedVerificationIdsOf([], null)).toEqual([]);
    expect(trustedVerificationIdsOf([{ ...RECORD_BASE, verificationIds: [] }], undefined)).toEqual(
      [],
    );
  });
});

describe("collectVerificationCompareCandidates（5.4/D07：跨 run 的比较候选只来自登记/响应）", () => {
  const stepRecord: OperationRecord = {
    ...RECORD_BASE,
    operationId: "66666666-6666-4666-8666-666666666666",
    target: {
      kind: "verification",
      runId: "run_fix",
      checkpointKind: "step",
      stepSpanId: STEP,
      commandId: "typecheck",
    },
    verificationIds: ["ver-fix"],
  };

  it("验证类登记的附件逐条成为候选（带 run/检查点/命令/登记状态），准备类不入", () => {
    const prepareRecord: OperationRecord = {
      ...RECORD_BASE,
      operationId: "77777777-7777-4777-8777-777777777777",
      target: {
        kind: "verificationPrepare",
        runId: "run_fix",
        checkpointKind: "initial",
        stepSpanId: null,
      },
      preparationIds: ["prep-1"],
      verificationIds: [],
    };
    const candidates = collectVerificationCompareCandidates(
      [RECORD_BASE, prepareRecord, stepRecord],
      null,
    );
    expect(candidates).toEqual([
      {
        verificationId: "ver-trusted",
        runId: RUN,
        checkpointKind: "initial",
        stepSpanId: null,
        commandId: "test",
        operationState: "running",
      },
      {
        verificationId: "ver-fix",
        runId: "run_fix",
        checkpointKind: "step",
        stepSpanId: STEP,
        commandId: "typecheck",
        operationState: "running",
      },
    ]);
  });

  it("重复附件只出现一次；响应回执补齐登记里还没有的身份（目标摘要为 null，不猜）", () => {
    const candidates = collectVerificationCompareCandidates(
      [RECORD_BASE, { ...RECORD_BASE, operationId: "88888888-8888-4888-8888-888888888888" }],
      "ver-response-only",
    );
    expect(candidates.map((one) => one.verificationId)).toEqual([
      "ver-trusted",
      "ver-response-only",
    ]);
    expect(candidates[1]?.runId).toBeNull();
    expect(candidates[1]?.operationState).toBeNull();
    expect(
      collectVerificationCompareCandidates([RECORD_BASE], "ver-trusted").map(
        (one) => one.verificationId,
      ),
    ).toEqual(["ver-trusted"]);
  });
});
