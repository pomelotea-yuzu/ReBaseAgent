import { ok } from "@shared/ipc";
import type {
  Envelope,
  VerificationCapabilityResult,
  VerificationGetResult,
  VerificationPreparePlanResult,
  VerificationPrepareResult,
  VerificationReadLogRequest,
  VerificationReadLogResult,
  VerificationRunResult,
  WindowApi,
  WorkspaceExportOutcome,
} from "@shared/ipc";
import type { OperationIdentity } from "@shared/operations";
import type {
  OperationRecord,
  OperationStatusResult,
  ReconcileRequest,
  ReconcileResult,
} from "@shared/operations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import {
  decideVerificationConfirmation,
  matchVerificationRecords,
  verificationTargetKey,
} from "../src/renderer/src/lib/verification-entry";
import {
  FAKE_EPOCH,
  executedFail,
  executedOk,
  installOperationChannels,
  statusSnapshot,
} from "./helpers/operation-channels";

/**
 * R3 任务 5.1：verification 分片 + 提交动作的 **store 接线**。
 *
 * 判据来源（delta 场景逐字）：
 * - D01「计划预览和不可用原因」：打开面板只发起只读核对；失败如实呈现；
 * - D02「当前确认与计划漂移」：确认现算判定——漂移/换目标/换命令 ⇒ stale；
 *   stale/missing 提交**本地拒发零 IPC**（不隐式执行）；
 * - M02/R3 端点契约：提交走唯一 submitActive 序列（握手 → operationId → 回执核验）。
 *
 * ⚠️ 复位纪律：共享 store 单例；verification 域用 closeVerification 复位（代次单调推进
 * 是设计行为——迟到了也不许同名次碰撞），operations 域复位 initialSession。
 */

const RUN_A = "run_ver_a";
const RUN_B = "run_ver_b";
const STEP = "s_02";

function capabilityOf(
  overrides?: Partial<VerificationCapabilityResult>,
): VerificationCapabilityResult {
  return {
    planToken: "token-1",
    prepared: null,
    engine: { available: true, engineVersion: "29.9.2", reason: null },
    source: { snapshotId: "snap-1", fileCount: 2, totalBytes: 2048, stepSpanId: null },
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

const planFixture: VerificationPreparePlanResult = {
  planDigest: "1b64a8946d1f5e2c3f7a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
  planToken: "token-1",
  plan: {
    profileId: "node-ts-v1",
    manifestVersion: 3,
    manifestDigest: "2c75b9a57e2f6d3c4a8b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e10",
    downloads: [
      {
        source: "docker.m.daocloud.io/library/node@sha256:base",
        approxBytes: 61337515,
        license: "MIT",
      },
    ],
    networkScopeNote: "仅本次准备允许联网；正式测试断网。",
    spaceEstimateBytes: 509875138,
  },
};

const prepareResult: VerificationPrepareResult = {
  preparationId: "prep-1",
  imageDigest: "sha256:env",
  toolchain: { node: "22.23.4", typescript: "5.9.3" },
  recordPath: "verification-environments/prep-1.jsonl",
};

const runResult: VerificationRunResult = {
  verificationId: "ver-1",
  outcome: "check_failed",
  detail: "typecheck 非零退出",
  evidenceComplete: true,
  recordPath: "verifications/ver-1.jsonl",
};

const calls: string[] = [];

// —— 可控应答（默认全绿；用例按需改写）——
type CapabilityCall = {
  runId: string;
  checkpoint: { kind: string; stepSpanId?: string };
};
type ExecCall = (request: { operation: OperationIdentity }) => Promise<unknown>;

/** 默认核对应答：initial/合法 step 全绿；stepSpanId="bad" 回稳定拒绝（核对失败用例共用） */
const defaultCapabilityImpl = async (
  request: CapabilityCall,
): Promise<Envelope<VerificationCapabilityResult>> => {
  if (request.checkpoint.kind === "step" && request.checkpoint.stepSpanId === "bad") {
    return {
      ok: false,
      error: { code: "R3_PROFILE_MISMATCH", message: "profile 不受支持" },
    } as unknown as Envelope<VerificationCapabilityResult>;
  }
  return ok(capabilityOf());
};

let capabilityImpl: (request: CapabilityCall) => Promise<Envelope<VerificationCapabilityResult>> =
  defaultCapabilityImpl;
let planImpl: () => Promise<Envelope<VerificationPreparePlanResult>> = async () => ok(planFixture);
let prepareImpl: ExecCall = executedOk(prepareResult);
let runImpl: ExecCall = executedOk(runResult);
// —— 5.2：可控 status/reconcile 应答（操作登记核实与停止寻路）——
let statusImpl: () => Promise<Envelope<OperationStatusResult>> = async () => ok(statusSnapshot());
let reconcileImpl: ((request: ReconcileRequest) => ReconcileResult) | null = null;
/** 停止通道的可控应答（默认成功置停止信号；幂等/失败用例改写） */
const verificationStopStub: {
  alreadySettled: boolean;
  fail: { code: string; message: string } | null;
} = { alreadySettled: false, fail: null };
// —— 5.3：记录/日志只读通道的可控应答 ——
let getImpl: (request: { verificationId: string }) => Promise<Envelope<VerificationGetResult>> =
  async (request) => ok(recordFixture(request.verificationId));
let readLogImpl: (
  request: VerificationReadLogRequest,
) => Promise<Envelope<VerificationReadLogResult>> = async () => ok(logPage("aaa", 3, 5));
// —— 5.5：验证输入导出通道 ——
let exportImpl: (request: {
  verificationId?: string;
  runId?: string;
  stepSpanId?: string;
}) => Promise<Envelope<WorkspaceExportOutcome>> = async () => ok(exportOutcomeFixture());

/** 5.3/5.4 夹具：封存记录（记录头 + 一条命令的双口径字节 + 终局） */
function recordFixture(verificationId = "ver-1"): VerificationGetResult {
  return {
    verificationId,
    status: "sealed",
    events: [
      { type: "stage", phase: "executing" },
      {
        type: "command_end",
        commandId: "test",
        exitCode: 1,
        durationMs: 1850,
        stdout: { byteLength: 1048576, totalBytes: 2097152, truncated: true },
        stderr: { byteLength: 42, totalBytes: 42, truncated: false },
      },
    ],
    error: null,
    meta: {
      runId: "run_a",
      checkpoint: { kind: "initial" },
      snapshotId: "snap_1",
      profileId: "node-ts-v1",
      manifestVersion: 3,
      commandId: "test",
      planBindingDigest: "a".repeat(64),
      createdAt: "2026-10-25T10:00:00.000Z",
      environment: null,
    },
    terminated: {
      outcome: "check_failed",
      detail: "测试断言失败",
      evidenceComplete: true,
      at: "2026-10-25T10:00:06.000Z",
    },
    sourceStatus: "present",
  };
}

function logPage(text: string, nextOffset: number, remaining: number): VerificationReadLogResult {
  return { text, totalBytes: nextOffset + remaining, nextOffset, remaining, truncated: false };
}

/** 5.5 夹具：验证输入导出成功结局（快照与验证记录一致） */
function exportOutcomeFixture(
  verificationId = "ver-1",
  snapshotId = "a".repeat(64),
): Extract<WorkspaceExportOutcome, { status: "exported" }> {
  return {
    status: "exported",
    targetDir: "D:/exports/ver-1",
    filesRoot: "files",
    fileCount: 2,
    totalFileBytes: 20,
    snapshotId,
    stepSpanId: null,
    patch: { status: "no_text_changes", covered: [], excluded: [] },
    unpreserved: {
      permissions: "未保留（原状态未知）",
      executable_bit: "未保留（原状态未知）",
      timestamps: "未保留（原状态未知）",
      links: "未保留（原状态未知）",
      empty_directories: "未保留（原状态未知）",
      external_services: "未保留（原状态未知）",
    },
    verificationId,
    verificationSnapshotId: snapshotId,
  };
}

const apiStub: Record<string, unknown> = {
  verificationGet: (request: { verificationId: string }) => {
    calls.push(`get:${request.verificationId}`);
    return getImpl(request);
  },
  verificationReadLog: (request: VerificationReadLogRequest) => {
    calls.push(
      `readLog:${request.verificationId}:${request.commandId}:${request.stream}:${request.offset}`,
    );
    return readLogImpl(request);
  },
  exportCheckpoint: (request: {
    verificationId?: string;
    runId?: string;
    stepSpanId?: string;
  }) => {
    calls.push(`export:${JSON.stringify(request)}`);
    return exportImpl(request);
  },
  verificationCapability: (request: CapabilityCall) => {
    calls.push(
      `capability:${request.runId}:${request.checkpoint.kind}${
        request.checkpoint.kind === "step" ? `:${request.checkpoint.stepSpanId ?? ""}` : ""
      }`,
    );
    return capabilityImpl(request);
  },
  verificationPreparePlan: () => {
    calls.push("preparePlan");
    return planImpl();
  },
  verificationPrepare: (request: { operation: OperationIdentity }) => {
    calls.push(`prepare:${JSON.stringify(request)}`);
    return prepareImpl(request);
  },
  verificationRun: (request: { operation: OperationIdentity }) => {
    calls.push(`run:${JSON.stringify(request)}`);
    return runImpl(request);
  },
  verificationStop: (request: { epoch: string; operationId: string; domainId: string }) => {
    calls.push(`stop:${JSON.stringify(request)}`);
    if (verificationStopStub.fail !== null) {
      return Promise.resolve({ ok: false as const, error: verificationStopStub.fail });
    }
    return Promise.resolve({
      ok: true as const,
      data: {
        stopping: !verificationStopStub.alreadySettled,
        alreadySettled: verificationStopStub.alreadySettled,
        reason: verificationStopStub.alreadySettled ? "操作已收尾（settled），无需停止" : null,
      },
    });
  },
  // 自有 status/reconcile 桩（installOperationChannels 的 ??= 不覆盖已有键）
  operationsStatus: () => {
    calls.push("status");
    return statusImpl();
  },
  operationsReconcile: (request: ReconcileRequest) => {
    calls.push(`reconcile:${request.operationId}`);
    const result = reconcileImpl?.(request);
    return result === null || result === undefined
      ? {
          ok: false,
          error: { code: "RECONCILE_STUB_MISSING", message: "桩未实现核对" },
        }
      : ok(result);
  },
};
installOperationChannels(apiStub);

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const stateOf = () => useAppStore.getState();

function resetVerification(): void {
  stateOf().closeVerification();
  useAppStore.setState({ operations: initialSession() });
}

/** 受控延迟（迟到响应用例用：先开新目标，再放旧响应） */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  calls.length = 0;
  capabilityImpl = defaultCapabilityImpl;
  planImpl = async () => ok(planFixture);
  prepareImpl = executedOk(prepareResult);
  runImpl = executedOk(runResult);
  statusImpl = async () => ok(statusSnapshot());
  reconcileImpl = null;
  verificationStopStub.alreadySettled = false;
  verificationStopStub.fail = null;
  getImpl = async (request) => ok(recordFixture(request.verificationId));
  readLogImpl = async () => ok(logPage("aaa", 3, 5));
  exportImpl = async () => ok(exportOutcomeFixture());
  resetVerification();
});

// ---------------------------------------------------------------------------
// 5.2 夹具：R3 登记记录（与 @shared/operations 的登记精炼自洽）
// ---------------------------------------------------------------------------

const ACTIVE_OP_ID = "77777777-7777-4777-8777-777777777777";

function runningVerificationRecord(overrides?: Partial<OperationRecord>): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: ACTIVE_OP_ID,
    target: {
      kind: "verification",
      runId: RUN_A,
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
    ...overrides,
  };
}

function reconcileResultOf(record: OperationRecord): ReconcileResult {
  return {
    epoch: FAKE_EPOCH,
    registryVersion: 5,
    activeOperationId: record.state === "running" ? record.operationId : null,
    closing: false,
    configurationBusy: false,
    operation: record,
  };
}

describe("openVerification（显式 selector 与只读核对）", () => {
  it("打开 ⇒ 绑定显式目标并发起两个只读核对（capability + preparePlan），无执行通道调用", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    expect(stateOf().verificationTarget).toEqual({ runId: RUN_A, checkpoint: { kind: "initial" } });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
      expect(stateOf().verificationPlan).not.toBeNull();
    });
    expect(calls).toContain(`capability:${RUN_A}:initial`);
    expect(calls).toContain("preparePlan");
    // 零副作用预览（D01）：没有任何 prepare/run/模型/容器通道被调
    expect(calls.some((one) => one.startsWith("prepare:") || one.startsWith("run:"))).toBe(false);
  });

  it("步骤检查点 ⇒ selector 显式携带 stepSpanId（不得无声回落初始）", async () => {
    stateOf().openVerification(RUN_A, { kind: "step", stepSpanId: STEP });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapabilityState).toBe("ready");
    });
    expect(calls).toContain(`capability:${RUN_A}:step:${STEP}`);
  });

  it("核对失败 ⇒ 结构化错误如实呈现（state=error + 码），不冒充可用", async () => {
    stateOf().openVerification(RUN_A, { kind: "step", stepSpanId: "bad" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapabilityState).toBe("error");
    });
    expect(stateOf().verificationCapabilityError?.code).toBe("R3_PROFILE_MISMATCH");
    expect(stateOf().verificationCapability).toBeNull();
  });

  it("迟到响应守卫：开 A 后立刻开 B ⇒ A 的迟到核对整包丢弃，B 的核对生效", async () => {
    const gateA = deferred<Envelope<VerificationCapabilityResult>>();
    capabilityImpl = () => {
      if (calls.filter((one) => one.startsWith("capability:")).length <= 1) return gateA.promise;
      return Promise.resolve(ok(capabilityOf({ planToken: "token-B" })));
    };
    stateOf().openVerification(RUN_A, { kind: "initial" });
    // A 的请求已发出（gen N）；切换到 B（内容清空、gen N+1）
    stateOf().openVerification(RUN_B, { kind: "step", stepSpanId: STEP });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    gateA.resolve(ok(capabilityOf({ planToken: "token-A-late" })));
    // 微任务排空后 A 的迟到响应仍不得覆盖 B 的结果
    await new Promise((r) => setTimeout(r, 0));
    expect(stateOf().verificationTarget?.runId).toBe(RUN_B);
    expect(stateOf().verificationCapability?.planToken).toBe("token-B");
  });

  it("closeVerification ⇒ 全域复位（目标/核对/确认/呈现清空，代次只进不退）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationPrepare();
    const generationBefore = stateOf().verificationOutcomeGeneration;
    stateOf().closeVerification();
    expect(stateOf().verificationTarget).toBeNull();
    expect(stateOf().verificationCapability).toBeNull();
    expect(stateOf().verificationPrepareConfirmation).toBeNull();
    expect(stateOf().verificationOutcomeGeneration).toBeGreaterThan(generationBefore);
  });
});

describe("两份独立确认（D02：准备与执行许可不互相替代）", () => {
  it("核对缺失 ⇒ 确认拒绝武装（没有可绑定的计划 token）", () => {
    expect(stateOf().confirmVerificationPrepare()).toBe(false);
    expect(stateOf().verificationPrepareConfirmation).toBeNull();
  });

  it("确认武装绑定当前 token 与目标键；两份确认互不替代", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    expect(stateOf().confirmVerificationPrepare()).toBe(true);
    expect(stateOf().verificationRunConfirmation).toBeNull();
    stateOf().confirmVerificationRun();
    const targetKey = verificationTargetKey({
      runId: RUN_A,
      checkpoint: { kind: "initial" },
    });
    expect(stateOf().verificationPrepareConfirmation?.planToken).toBe("token-1");
    expect(stateOf().verificationPrepareConfirmation?.targetKey).toBe(targetKey);
    expect(stateOf().verificationRunConfirmation?.commandId).toBe("test");
  });

  it("计划漂移（重新核对返回新 token）⇒ 旧确认现算判 stale， store 不假装仍有效", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationPrepare();
    // 环境变化：重新核对返回新计划 token
    capabilityImpl = async () => ok(capabilityOf({ planToken: "token-2" }));
    await stateOf().refreshVerificationCapability();
    const target = stateOf().verificationTarget;
    const decision = decideVerificationConfirmation({
      armed: stateOf().verificationPrepareConfirmation,
      currentPlanToken: stateOf().verificationCapability?.planToken ?? null,
      currentTargetKey: target === null ? "" : verificationTargetKey(target),
    });
    expect(decision.kind).toBe("stale");
  });

  it("D16 撤销未提交确认：清空两份许可，保留显式目标与只读核对，零新增调用", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    const target = stateOf().verificationTarget;
    const callsBefore = calls.length;
    stateOf().confirmVerificationPrepare();
    stateOf().confirmVerificationRun();
    stateOf().revokeVerificationConfirmations();
    expect(stateOf().verificationPrepareConfirmation).toBeNull();
    expect(stateOf().verificationRunConfirmation).toBeNull();
    expect(stateOf().verificationTarget).toEqual(target);
    expect(stateOf().verificationCapability).not.toBeNull();
    expect(calls.length).toBe(callsBefore);
  });

  it("换目标 ⇒ 旧确认清空（openVerification 内容复位）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationPrepare();
    stateOf().confirmVerificationRun();
    stateOf().openVerification(RUN_B, { kind: "initial" });
    expect(stateOf().verificationPrepareConfirmation).toBeNull();
    expect(stateOf().verificationRunConfirmation).toBeNull();
  });
});

describe("提交门（D02：不隐式执行——stale/missing 本地拒发零 IPC）", () => {
  it("未确认 ⇒ 本地拒发（VERIFICATION_CONFIRMATION_STALE），prepare 通道零调用", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapabilityState).toBe("ready");
    });
    const accepted = await stateOf().submitVerificationPrepare();
    expect(accepted).toBe(false);
    expect(stateOf().verificationSubmitError?.code).toBe("VERIFICATION_CONFIRMATION_STALE");
    expect(calls.some((one) => one.startsWith("prepare:"))).toBe(false);
  });

  it("已确认 ⇒ 走 submitActive 序列：请求形状精确（target/profile/planToken/allowPrepare）", async () => {
    stateOf().openVerification(RUN_A, { kind: "step", stepSpanId: STEP });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapabilityState).toBe("ready");
    });
    stateOf().confirmVerificationPrepare();
    const accepted = await stateOf().submitVerificationPrepare();
    expect(accepted).toBe(true);
    const prepareCall = calls.find((one) => one.startsWith("prepare:"));
    expect(prepareCall).toBeDefined();
    const request = JSON.parse((prepareCall ?? "{}").slice("prepare:".length)) as {
      operation: unknown;
      request: {
        target: { runId: string; checkpoint: { kind: string; stepSpanId?: string } };
        profileId: string;
        planToken: string;
        allowPrepare: boolean;
      };
    };
    expect(request.request.target).toEqual({
      runId: RUN_A,
      checkpoint: { kind: "step", stepSpanId: STEP },
    });
    expect(request.request.profileId).toBe("node-ts-v1");
    expect(request.request.planToken).toBe("token-1");
    expect(request.request.allowPrepare).toBe(true);
    expect(stateOf().verificationLastOutcome?.kind).toBe("prepare");
    expect(stateOf().verificationLastOutcome?.preparationId).toBe("prep-1");
    expect(stateOf().verificationSubmitting).toBe("idle");
  });

  it("计划漂移后提交 ⇒ 本地拒发（旧确认失效，不自动提交新计划）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationPrepare();
    capabilityImpl = async () => ok(capabilityOf({ planToken: "token-2" }));
    await stateOf().refreshVerificationCapability();
    const accepted = await stateOf().submitVerificationPrepare();
    expect(accepted).toBe(false);
    expect(stateOf().verificationSubmitError?.code).toBe("VERIFICATION_CONFIRMATION_STALE");
    expect(calls.some((one) => one.startsWith("prepare:"))).toBe(false);
  });

  it("main 门内拒绝（稳定码）⇒ 呈现 submitError，无 outcome", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationPrepare();
    prepareImpl = executedFail("R3_PREPARE_PLAN_STALE", "计划漂移：重新核对后再确认");
    const accepted = await stateOf().submitVerificationPrepare();
    expect(accepted).toBe(false);
    expect(stateOf().verificationSubmitError?.code).toBe("R3_PREPARE_PLAN_STALE");
    expect(stateOf().verificationLastOutcome).toBeNull();
  });

  it("run 未确认 ⇒ 本地拒发；命令切换后旧确认失效同样拒发", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    expect(await stateOf().submitVerificationRun()).toBe(false);
    expect(calls.some((one) => one.startsWith("run:"))).toBe(false);
    stateOf().confirmVerificationRun();
    stateOf().setVerificationCommand("typecheck");
    expect(await stateOf().submitVerificationRun()).toBe(false);
    expect(stateOf().verificationSubmitError?.code).toBe("VERIFICATION_CONFIRMATION_STALE");
    expect(calls.some((one) => one.startsWith("run:"))).toBe(false);
  });

  it("run 已确认 ⇒ 请求携带确认时的命令与 allowExecution:true；领域结局随 ok 信封呈现", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationRun();
    const accepted = await stateOf().submitVerificationRun();
    expect(accepted).toBe(true);
    const runCall = calls.find((one) => one.startsWith("run:"));
    const request = JSON.parse((runCall ?? "{}").slice("run:".length)) as {
      request: { commandId: string; allowExecution: boolean; planToken: string };
    };
    expect(request.request.commandId).toBe("test");
    expect(request.request.allowExecution).toBe(true);
    expect(stateOf().verificationLastOutcome?.kind).toBe("run");
    expect(stateOf().verificationLastOutcome?.outcome).toBe("check_failed");
    expect(stateOf().verificationLastOutcome?.verificationId).toBe("ver-1");
  });

  it("提交期间目标切换 ⇒ 迟到的成功结局按代次丢弃（不显示在新目标下）", async () => {
    const gate = deferred<unknown>();
    const captured: { identity: OperationIdentity | undefined } = { identity: undefined };
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationPrepare();
    prepareImpl = (request) => {
      captured.identity = request.operation;
      return gate.promise;
    };
    const submitting = stateOf().submitVerificationPrepare();
    // 等请求真的发出（submitActive 先握手再调用——别在握手前就放行旧响应）
    await vi.waitFor(() => {
      expect(captured.identity).toBeDefined();
    });
    // 在飞期间收起（目标代次推进）
    stateOf().closeVerification();
    // 回执身份回显本次请求（inspectAck 按身份核验；身份不符会走 OPERATION_ACK_INVALID）
    const ackIdentity = captured.identity;
    if (ackIdentity === undefined) return;
    gate.resolve({
      ok: true,
      operation: { ...ackIdentity, registryVersion: 2, state: "settled" },
      data: prepareResult,
    });
    expect(await submitting).toBe(true);
    expect(stateOf().verificationLastOutcome).toBeNull();
    expect(stateOf().verificationTarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5.2：操作登记核实、可信领域 ID 与停止反馈（D03/D04/D05/D10/M01/M02）
// ---------------------------------------------------------------------------

describe("在飞操作身份与停止寻路（D05）", () => {
  it("提交 run ⇒ 铸出 operationId 并登记为在飞身份；请求携带同一身份；明确返回后清除", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationRun();
    const accepted = await stateOf().submitVerificationRun();
    expect(accepted).toBe(true);
    // 请求的 operation 身份 = 提交期间登记的在飞身份（停止/核对按它寻路）
    const runCall = calls.find((one) => one.startsWith("run:"));
    const request = JSON.parse((runCall ?? "{}").slice("run:".length)) as {
      operation: { operationId: string };
    };
    expect(request.operation.operationId).toBeTypeOf("string");
    // 明确返回 ⇒ 在飞身份清除（结局由 lastOutcome 与登记承载）
    expect(stateOf().verificationActiveOperation).toBeNull();
    expect(stateOf().verificationLastOutcome?.operationId).toBe(request.operation.operationId);
  });

  it("通道抛错 ⇒ 在飞身份保留（unknown 只核对）；reconcile 取得可信领域 ID 后停止成功", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationRun();
    runImpl = () => {
      throw new Error("通道炸了");
    };
    expect(await stateOf().submitVerificationRun()).toBe(false);
    const active = stateOf().verificationActiveOperation;
    expect(active?.kind).toBe("run");
    // 登记里还没有记录 ⇒ 先 reconcile 核对（D03：复用核对，不猜）
    reconcileImpl = () =>
      reconcileResultOf(
        runningVerificationRecord({
          operationId: stateOf().verificationActiveOperation?.operationId ?? ACTIVE_OP_ID,
        }),
      );
    await stateOf().requestVerificationStop();
    expect(calls).toContain(`reconcile:${active?.operationId}`);
    const stopCall = calls.find((one) => one.startsWith("stop:"));
    expect(stopCall).toBeDefined();
    const stopRequest = JSON.parse((stopCall ?? "{}").slice("stop:".length)) as {
      epoch: string;
      operationId: string;
      domainId: string;
    };
    expect(stopRequest.epoch).toBe(FAKE_EPOCH);
    expect(stopRequest.operationId).toBe(active?.operationId);
    expect(stopRequest.domainId).toBe("ver-trusted");
    expect(stateOf().verificationStopRequested).toBe(true);
  });

  it("reconcile 也拿不到可信身份 ⇒ 如实说明并放弃（零停止，不猜测目标）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationRun();
    runImpl = () => {
      throw new Error("通道炸了");
    };
    await stateOf().submitVerificationRun();
    reconcileImpl = () => reconcileResultOf(runningVerificationRecord({ verificationIds: [] }));
    await stateOf().requestVerificationStop();
    expect(calls.some((one) => one.startsWith("stop:"))).toBe(false);
    expect(stateOf().verificationStopNotice).toEqual({ kind: "identity_pending" });
    expect(stateOf().verificationStopRequested).toBe(false);
  });

  it("重复停止幂等：alreadySettled ⇒ no-op 呈现，不伪造停止", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationRun();
    runImpl = () => {
      throw new Error("通道炸了");
    };
    await stateOf().submitVerificationRun();
    const active = stateOf().verificationActiveOperation;
    reconcileImpl = () =>
      reconcileResultOf(
        runningVerificationRecord({ operationId: active?.operationId ?? ACTIVE_OP_ID }),
      );
    await stateOf().requestVerificationStop();
    expect(stateOf().verificationStopRequested).toBe(true);
    calls.length = 0;
    // 重复停止：在飞已注销 ⇒ main 幂等 no-op（不新建执行、不停止新 owner）
    verificationStopStub.alreadySettled = true;
    await stateOf().requestVerificationStop();
    expect(calls.filter((one) => one.startsWith("stop:"))).toHaveLength(1);
    expect(stateOf().verificationStopRequested).toBe(false);
    expect(stateOf().verificationStopNotice).toEqual({
      kind: "already_settled",
      detail: expect.anything(),
    });
  });

  it("停止通道失败码如实呈现（R3_STOP_IDENTITY_MISMATCH 不吞）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationRun();
    runImpl = () => {
      throw new Error("通道炸了");
    };
    await stateOf().submitVerificationRun();
    const active = stateOf().verificationActiveOperation;
    reconcileImpl = () =>
      reconcileResultOf(
        runningVerificationRecord({
          operationId: active?.operationId ?? ACTIVE_OP_ID,
        }),
      );
    verificationStopStub.fail = { code: "R3_STOP_IDENTITY_MISMATCH", message: "领域 ID 不一致" };
    await stateOf().requestVerificationStop();
    expect(stateOf().verificationStopError?.code).toBe("R3_STOP_IDENTITY_MISMATCH");
    expect(stateOf().verificationStopRequested).toBe(false);
  });
});

describe("操作登记核实（D03/M01/D04：身份只来自登记）", () => {
  it("status 快照带运行中验证记录 ⇒ 按显式目标匹配到登记（含领域 ID）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    statusImpl = async () =>
      ok(
        statusSnapshot({
          registryVersion: 4,
          activeOperationId: ACTIVE_OP_ID,
          operations: [runningVerificationRecord()],
        }),
      );
    await stateOf().refreshOperationStatus();
    const matched = matchVerificationRecords(stateOf().operations, {
      runId: RUN_A,
      checkpoint: { kind: "initial" },
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.verificationIds).toEqual(["ver-trusted"]);
    expect(stateOf().verificationActiveOperation).toBeNull();
  });

  it("提交成功 + 登记回执（settled 记录）⇒ 结局分层呈现的事实齐备（D04）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationRun();
    const accepted = await stateOf().submitVerificationRun();
    expect(accepted).toBe(true);
    // 响应层事实（测试结局 + 证据完整性与请求收尾分开）
    expect(stateOf().verificationLastOutcome?.outcome).toBe("check_failed");
    expect(stateOf().verificationLastOutcome?.evidenceComplete).toBe(true);
    // 登记层事实（领域 ID 从附件来，与响应层互证）：status 带回 settled 记录
    const settledRecord = runningVerificationRecord({
      state: "settled",
      settledAt: "2026-10-25T10:05:00.000Z",
      requestOutcome: "returned",
      errorCode: null,
    });
    statusImpl = async () =>
      ok(statusSnapshot({ registryVersion: 7, operations: [settledRecord] }));
    await stateOf().refreshOperationStatus();
    const matched = matchVerificationRecords(stateOf().operations, {
      runId: RUN_A,
      checkpoint: { kind: "initial" },
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.requestOutcome).toBe("returned");
  });

  it("M02：登记显示 R3 占槽（activeOperationId）⇒ 另一主动请求本地拒发（OPERATION_BUSY 零 IPC）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().confirmVerificationPrepare();
    statusImpl = async () =>
      ok(
        statusSnapshot({
          registryVersion: 4,
          activeOperationId: ACTIVE_OP_ID,
          operations: [runningVerificationRecord()],
        }),
      );
    await stateOf().refreshOperationStatus();
    const accepted = await stateOf().submitVerificationPrepare();
    expect(accepted).toBe(false);
    expect(stateOf().verificationSubmitError?.code).toBe("OPERATION_BUSY");
    expect(calls.some((one) => one.startsWith("prepare:"))).toBe(false);
  });
});

describe("记录与日志读取（5.3/D09/P13/P16：只读可信身份，迟到不混入）", () => {
  async function openAndFocus(verificationId: string): Promise<void> {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().focusVerificationRecord(verificationId);
    await vi.waitFor(() => {
      expect(stateOf().verificationRecordState).toBe("ready");
    });
  }

  it("聚焦可信身份 ⇒ 只调 verification:get 读取记录；不准备/不执行/不停止/不清理", async () => {
    await openAndFocus("ver-trusted");
    expect(calls).toContain("get:ver-trusted");
    expect(stateOf().verificationRecordData?.verificationId).toBe("ver-trusted");
    expect(stateOf().verificationRecordData?.status).toBe("sealed");
    expect(stateOf().verificationRecordError).toBeNull();
    // 只读：除打开面板的两个只读核对与本次 get 外，没有任何变更通道
    expect(
      calls.some(
        (one) =>
          one.startsWith("prepare:") ||
          one.startsWith("run:") ||
          one.startsWith("stop:") ||
          one.startsWith("status"),
      ),
    ).toBe(false);
  });

  it("切换验证后旧记录响应迟到 ⇒ 整包丢弃（不混入新身份，D09）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    const gateA = deferred<Envelope<VerificationGetResult>>();
    let getCount = 0;
    getImpl = (request) => {
      getCount += 1;
      if (getCount === 1) return gateA.promise;
      return Promise.resolve(ok(recordFixture(request.verificationId)));
    };
    stateOf().focusVerificationRecord("ver-a");
    stateOf().focusVerificationRecord("ver-b");
    await vi.waitFor(() => {
      expect(stateOf().verificationRecordData?.verificationId).toBe("ver-b");
    });
    gateA.resolve(ok(recordFixture("ver-a")));
    await new Promise((r) => setTimeout(r, 0));
    expect(stateOf().verificationRecordFocus).toBe("ver-b");
    expect(stateOf().verificationRecordData?.verificationId).toBe("ver-b");
  });

  it("关闭面板时在飞记录响应迟到 ⇒ 不落地（代次随 open/close 推进）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    const gate = deferred<Envelope<VerificationGetResult>>();
    getImpl = () => gate.promise;
    stateOf().focusVerificationRecord("ver-a");
    stateOf().closeVerification();
    gate.resolve(ok(recordFixture("ver-a")));
    await new Promise((r) => setTimeout(r, 0));
    expect(stateOf().verificationRecordFocus).toBeNull();
    expect(stateOf().verificationRecordData).toBeNull();
    expect(stateOf().verificationRecordState).toBe("idle");
  });

  it("记录结构不合法 ⇒ 稳定码呈现且不落地（跨进程数据不可信）", async () => {
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    getImpl = async () =>
      ok({ verificationId: "ver-1", status: "bogus", events: [], error: null } as never);
    stateOf().focusVerificationRecord("ver-1");
    await vi.waitFor(() => {
      expect(stateOf().verificationRecordState).toBe("error");
    });
    expect(stateOf().verificationRecordError?.code).toBe("R3_RECORD_SCHEMA_INVALID");
    expect(stateOf().verificationRecordData).toBeNull();
  });

  it("日志整段重读 ⇒ 覆盖而不拼接（不混上一条正文）", async () => {
    await openAndFocus("ver-1");
    stateOf().readVerificationLog("test", "stdout", "replace");
    await vi.waitFor(() => {
      expect(stateOf().verificationLogState).toBe("ready");
    });
    expect(stateOf().verificationLogText).toBe("aaa");
    expect(calls).toContain("readLog:ver-1:test:stdout:0");
    readLogImpl = async () => ok(logPage("bbb", 6, 0));
    stateOf().readVerificationLog("test", "stdout", "replace");
    await vi.waitFor(() => {
      expect(stateOf().verificationLogText).toBe("bbb");
    });
    expect(stateOf().verificationLogMeta?.remaining).toBe(0);
  });

  it("续读 ⇒ 用 nextOffset 追加；换流/换命令的 append 退化为首页（offset=0 且清空）", async () => {
    await openAndFocus("ver-1");
    stateOf().readVerificationLog("test", "stdout", "replace");
    await vi.waitFor(() => {
      expect(stateOf().verificationLogState).toBe("ready");
    });
    readLogImpl = async () => ok(logPage("bbb", 6, 0));
    stateOf().readVerificationLog("test", "stdout", "append");
    await vi.waitFor(() => {
      expect(stateOf().verificationLogText).toBe("aaabbb");
    });
    expect(calls).toContain("readLog:ver-1:test:stdout:3");
    // 换到 stderr 的 append 不是同一份正文的续读
    readLogImpl = async () => ok(logPage("err", 3, 0));
    stateOf().readVerificationLog("test", "stderr", "append");
    await vi.waitFor(() => {
      expect(stateOf().verificationLogText).toBe("err");
    });
    expect(calls).toContain("readLog:ver-1:test:stderr:0");
  });

  it("换焦点 ⇒ 旧日志正文与身份清空，旧日志迟到响应丢弃（D09）", async () => {
    await openAndFocus("ver-1");
    const gate = deferred<Envelope<VerificationReadLogResult>>();
    readLogImpl = () => gate.promise;
    stateOf().readVerificationLog("test", "stdout", "replace");
    expect(stateOf().verificationLogIdentity?.verificationId).toBe("ver-1");
    stateOf().focusVerificationRecord("ver-2");
    await vi.waitFor(() => {
      expect(stateOf().verificationRecordData?.verificationId).toBe("ver-2");
    });
    gate.resolve(ok(logPage("stale-body", 10, 0)));
    await new Promise((r) => setTimeout(r, 0));
    expect(stateOf().verificationLogIdentity).toBeNull();
    expect(stateOf().verificationLogText).toBe("");
  });

  it("附件损坏 ⇒ 稳定码如实呈现，正文保持空（不以损坏字节冒充正文）", async () => {
    await openAndFocus("ver-1");
    readLogImpl = async () => ({
      ok: false as const,
      error: { code: "R3_LOG_ASSET_CORRUPT", message: "附件哈希不符" },
    });
    stateOf().readVerificationLog("test", "stdout", "replace");
    await vi.waitFor(() => {
      expect(stateOf().verificationLogState).toBe("error");
    });
    expect(stateOf().verificationLogError?.code).toBe("R3_LOG_ASSET_CORRUPT");
    expect(stateOf().verificationLogText).toBe("");
    expect(stateOf().verificationLogMeta).toBeNull();
  });
});

describe("双验证比较读取（5.4/D07/P24/P25：只读、身份显式、迟到不混）", () => {
  it("两侧选齐 ⇒ 只调两次 verification:get；取回两侧记录头", async () => {
    stateOf().selectVerificationCompareSide("left", "ver-left");
    expect(calls.filter((one) => one.startsWith("get:"))).toHaveLength(0);
    stateOf().selectVerificationCompareSide("right", "ver-right");
    await vi.waitFor(() => {
      expect(stateOf().verificationCompareState).toBe("ready");
    });
    expect(stateOf().verificationCompareData?.left.verificationId).toBe("ver-left");
    expect(stateOf().verificationCompareData?.right.verificationId).toBe("ver-right");
    expect(calls.filter((one) => one.startsWith("get:"))).toHaveLength(2);
    // 只读：比较读取不触碰准备/执行/停止/登记
    expect(
      calls.some(
        (one) =>
          one.startsWith("prepare:") ||
          one.startsWith("run:") ||
          one.startsWith("stop:") ||
          one.startsWith("status"),
      ),
    ).toBe(false);
  });

  it("同一验证不能与自己比较（稳定码，不改动两侧）", () => {
    stateOf().selectVerificationCompareSide("left", "ver-1");
    stateOf().selectVerificationCompareSide("right", "ver-1");
    expect(stateOf().verificationCompareError?.code).toBe("R3_COMPARE_SAME_ID");
    expect(stateOf().verificationCompareRight).toBeNull();
    expect(calls.some((one) => one.startsWith("get:"))).toBe(false);
  });

  it("换侧时旧比较响应迟到 ⇒ 整包丢弃（代次守卫）", async () => {
    const gate = deferred<Envelope<VerificationGetResult>>();
    let getCount = 0;
    getImpl = (request) => {
      getCount += 1;
      if (getCount === 1) return gate.promise;
      return Promise.resolve(ok(recordFixture(request.verificationId)));
    };
    stateOf().selectVerificationCompareSide("left", "ver-left");
    stateOf().selectVerificationCompareSide("right", "ver-right");
    // 换左：旧左响应仍在飞
    stateOf().selectVerificationCompareSide("left", "ver-left-2");
    await vi.waitFor(() => {
      expect(stateOf().verificationCompareData?.left.verificationId).toBe("ver-left-2");
    });
    gate.resolve(ok(recordFixture("ver-left")));
    await new Promise((r) => setTimeout(r, 0));
    expect(stateOf().verificationCompareLeft).toBe("ver-left-2");
    expect(stateOf().verificationCompareData?.left.verificationId).toBe("ver-left-2");
  });

  it("清除比较 ⇒ 内容复位；在飞响应迟到不复活", async () => {
    const gate = deferred<Envelope<VerificationGetResult>>();
    getImpl = () => gate.promise;
    stateOf().selectVerificationCompareSide("left", "ver-left");
    stateOf().selectVerificationCompareSide("right", "ver-right");
    stateOf().clearVerificationComparison();
    gate.resolve(ok(recordFixture("ver-left")));
    await new Promise((r) => setTimeout(r, 0));
    expect(stateOf().verificationCompareLeft).toBeNull();
    expect(stateOf().verificationCompareRight).toBeNull();
    expect(stateOf().verificationCompareData).toBeNull();
    expect(stateOf().verificationCompareState).toBe("idle");
  });

  it("读取失败 ⇒ 稳定码如实呈现，比较数据不落地", async () => {
    getImpl = async () => ({
      ok: false as const,
      error: { code: "R3_VERIFICATION_NOT_FOUND", message: "记录不存在" },
    });
    stateOf().selectVerificationCompareSide("left", "ver-left");
    stateOf().selectVerificationCompareSide("right", "ver-right");
    await vi.waitFor(() => {
      expect(stateOf().verificationCompareState).toBe("error");
    });
    expect(stateOf().verificationCompareError?.code).toBe("R3_VERIFICATION_NOT_FOUND");
    expect(stateOf().verificationCompareData).toBeNull();
  });
});

describe("比较读取重试（5.4/D03：只读重试不再执行）", () => {
  it("失败后原选择不变，重试只再发两个 get 并取回结果", async () => {
    getImpl = async () => ({
      ok: false as const,
      error: { code: "R3_VERIFICATION_READ_FAILED", message: "暂时读不到" },
    });
    stateOf().selectVerificationCompareSide("left", "ver-left");
    stateOf().selectVerificationCompareSide("right", "ver-right");
    await vi.waitFor(() => {
      expect(stateOf().verificationCompareState).toBe("error");
    });
    expect(stateOf().verificationCompareLeft).toBe("ver-left");
    expect(stateOf().verificationCompareRight).toBe("ver-right");
    calls.length = 0;
    getImpl = async (request) => ok(recordFixture(request.verificationId));
    await stateOf().loadVerificationComparison();
    expect(stateOf().verificationCompareState).toBe("ready");
    expect(calls.filter((one) => one.startsWith("get:"))).toHaveLength(2);
    expect(
      calls.some(
        (one) =>
          one.startsWith("prepare:") ||
          one.startsWith("run:") ||
          one.startsWith("stop:") ||
          one.startsWith("status"),
      ),
    ).toBe(false);
  });
});

describe("验证输入导出反馈（5.5/W03/W04/D08：按验证身份绑定）", () => {
  it("成功 ⇒ 只调 exportCheckpoint(verificationId)，反馈按 id 留存且回带快照", async () => {
    const outcome = await stateOf().exportVerificationInput("ver-1");
    expect(outcome?.status).toBe("exported");
    expect(calls.filter((one) => one.startsWith("export:"))).toEqual([
      'export:{"verificationId":"ver-1"}',
    ]);
    const feedback = stateOf().verificationExports["ver-1"];
    expect(feedback?.kind).toBe("exported");
    if (feedback?.kind === "exported") {
      expect(feedback.outcome.verificationId).toBe("ver-1");
      expect(feedback.outcome.verificationSnapshotId).toBe("a".repeat(64));
    }
    // 零准备/执行/停止/登记
    expect(
      calls.some(
        (one) =>
          one.startsWith("prepare:") ||
          one.startsWith("run:") ||
          one.startsWith("stop:") ||
          one.startsWith("status"),
      ),
    ).toBe(false);
  });

  it("信封失败 ⇒ 稳定码如实呈现，不冒充成功", async () => {
    exportImpl = async () => ({
      ok: false as const,
      error: { code: "VERIFICATION_EXPORT_SNAPSHOT_DRIFT", message: "快照不一致" },
    });
    const outcome = await stateOf().exportVerificationInput("ver-1");
    expect(outcome).toBeNull();
    const feedback = stateOf().verificationExports["ver-1"];
    expect(feedback?.kind).toBe("failed");
    if (feedback?.kind === "failed") {
      expect(feedback.code).toBe("VERIFICATION_EXPORT_SNAPSHOT_DRIFT");
      expect(feedback.retained).toEqual([]);
    }
  });

  it("同一验证重复导出：旧响应迟到不覆盖新反馈（按 id 代次）", async () => {
    const gate = deferred<Envelope<WorkspaceExportOutcome>>();
    let exportCount = 0;
    exportImpl = () => {
      exportCount += 1;
      if (exportCount === 1) return gate.promise;
      return Promise.resolve(ok(exportOutcomeFixture("ver-1", "b".repeat(64))));
    };
    void stateOf().exportVerificationInput("ver-1");
    await stateOf().exportVerificationInput("ver-1");
    const second = stateOf().verificationExports["ver-1"];
    expect(second?.kind).toBe("exported");
    if (second?.kind !== "exported") return;
    expect(second.outcome.snapshotId).toBe("b".repeat(64));
    gate.resolve(ok(exportOutcomeFixture("ver-1", "c".repeat(64))));
    await new Promise((r) => setTimeout(r, 0));
    const after = stateOf().verificationExports["ver-1"];
    expect(after?.kind).toBe("exported");
    if (after?.kind === "exported") expect(after.outcome.snapshotId).toBe("b".repeat(64));
  });

  it("取消 ⇒ canceled；关闭面板不丢反馈（离开页面结果仍可回看）", async () => {
    exportImpl = async () => ok({ status: "canceled" as const });
    await stateOf().exportVerificationInput("ver-1");
    expect(stateOf().verificationExports["ver-1"]?.kind).toBe("canceled");
    stateOf().closeVerification();
    expect(stateOf().verificationExports["ver-1"]?.kind).toBe("canceled");
  });

  it("导出结果结构不合法 ⇒ R3_EXPORT_SCHEMA_INVALID，不落地伪造结果", async () => {
    exportImpl = async () => ok({ status: "exported" } as never);
    await stateOf().exportVerificationInput("ver-1");
    const feedback = stateOf().verificationExports["ver-1"];
    expect(feedback?.kind).toBe("failed");
    if (feedback?.kind === "failed") {
      expect(feedback.code).toBe("R3_EXPORT_SCHEMA_INVALID");
    }
  });
});

describe("验证面板不改动其他阅读/草稿/比较状态（5.6/D12）", () => {
  it("open/close 验证不导航、不动草稿/阅读/比较选择、不恢复旧执行许可", async () => {
    useAppStore.setState({
      view: "trace",
      comparePair: { leftRunId: "run_l", rightRunId: "run_r" },
      compareIds: ["run_l", "run_r"],
    });
    const before = {
      view: stateOf().view,
      readingByRun: stateOf().readingByRun,
      drafts: stateOf().drafts,
      comparePair: stateOf().comparePair,
      compareIds: stateOf().compareIds,
      selectedRunId: stateOf().selectedRunId,
    };
    stateOf().openVerification(RUN_A, { kind: "initial" });
    await vi.waitFor(() => {
      expect(stateOf().verificationCapability).not.toBeNull();
    });
    stateOf().closeVerification();
    expect(stateOf().view).toBe(before.view);
    expect(stateOf().readingByRun).toBe(before.readingByRun);
    expect(stateOf().drafts).toBe(before.drafts);
    expect(stateOf().comparePair).toEqual(before.comparePair);
    expect(stateOf().compareIds).toEqual(before.compareIds);
    expect(stateOf().selectedRunId).toBe(before.selectedRunId);
    // D12：返回不恢复旧执行许可（确认/提交态必须为空）
    expect(stateOf().verificationPrepareConfirmation).toBeNull();
    expect(stateOf().verificationRunConfirmation).toBeNull();
    expect(stateOf().verificationSubmitting).toBe("idle");
  });
});
