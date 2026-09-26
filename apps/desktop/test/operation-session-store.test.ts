import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import {
  captureGeneration,
  deriveGate,
  initialSession,
} from "../src/renderer/src/lib/operation-session";
import { ok } from "../src/shared/ipc";
import type { Envelope, WindowApi } from "../src/shared/ipc";
import type { OperationRecord, OperationStatusResult } from "../src/shared/operations";
import { FAKE_EPOCH, installOperationChannels, statusSnapshot } from "./helpers/operation-channels";

/**
 * U4 任务 4.1 的 **store 接线半边**：门禁真的接在提交路径上（不是只测纯 reducer）。
 *
 * 判据（delta spec `desktop-ui` 逐字标题）：
 * - 「初始握手失败禁用主动入口」——握手失败/非法快照 ⇒ 业务通道**一次都没被调用**；
 * - 「乱序快照不回退新状态」——旧代次的迟到 status 响应不得覆盖新会话状态；
 * - 「非法操作响应不能解除门禁」——回执身份不匹配 / 缺回执 ⇒ 按未知处理，
 *   本地在飞身份保留、草稿冻结不被解除；
 * - 「状态通道不可用保持未知」——通道抛错 ⇒ unknown，且**不自动重发**，
 *   只有下一次有效 status 应答才解锁；
 * - 「不同入口并发只有一个被接受」——main 报 activeOperationId 时，另一个入口在发出前就被拒。
 *
 * 与 `test/operation-session.test.ts`（纯转移）分工：那份钉"守卫算法"，本份钉"接线"——
 * 每条断言都落在 `window.api` 桩的实际调用次数与 store 可见状态上。
 */

const calls: string[] = [];

/** 自洽快照要求 activeOperationId 指向同 epoch 的 running 记录（否则 schema 当场判非法） */
/** 快照里 activeOperationId 必须指向同 epoch 的 running 记录，且 id 是 UUID——否则整份快照被 schema 拒 ⇒ 未知（这本身就是"不部分采纳"的证据） */
function runningRecord(id: string): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: id,
    target: { kind: "create", mode: "plain" },
    state: "running",
    rejection: null,
    startedAt: "2026-09-26T00:00:00.000Z",
    settledAt: null,
    runIds: [],
    experimentId: null,
    arms: [],
    requestOutcome: null,
    errorCode: null,
    diagnostics: [],
  };
}

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<{ runs: never[]; failed: never[] }>> => {
    calls.push("listRuns");
    return ok({ runs: [], failed: [] });
  },
  selectDirectory: async () => ok(null),
  getRun: async (id: string) => {
    calls.push("runs:get");
    return {
      ok: false as const,
      error: { code: "RUN_UNREADABLE", message: `桩不提供详情：${id}` },
    };
  },
  operationsStatus: async () => {
    calls.push("operations:status");
    return ok(statusSnapshot());
  },
  operationsReconcile: async () => {
    calls.push("operations:reconcile");
    return ok(statusSnapshot());
  },
  forkRun: async () => {
    calls.push("runs:fork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  promptFork: async () => {
    calls.push("runs:promptFork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  proxyFork: async () => {
    calls.push("proxy:fork");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  createRun: async () => {
    calls.push("runs:create");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  modelAb: async () => {
    calls.push("runs:modelAb");
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
  modelAbPlan: async () => {
    calls.push("runs:modelAbPlan");
    return ok({ experimentId: "exp_stub", ids: [], ok: true, plan: [], sideEffectsAllowed: false });
  },
  settingsGet: async () => ok({ configured: true, baseURL: null, model: null, encryption: "safe" }),
  saveSettings: async () => ok(undefined),
  clearSettings: async () => ok(undefined),
  proxyStatus: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
};
installOperationChannels(apiStub);
(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

/** 复位会话与草稿（等价于一个全新 renderer） */
function resetSession(): void {
  calls.length = 0;
  useAppStore.setState({
    operations: initialSession(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    forking: "idle",
    creatingRun: "idle",
    modelAbInFlight: false,
  });
}

beforeEach(resetSession);

function statusWith(snapshot: Partial<OperationStatusResult>): void {
  apiStub.operationsStatus = async () => {
    calls.push("operations:status");
    return ok(statusSnapshot(snapshot));
  };
}

describe("4.1 store：握手失败与非法快照都在发出之前拦住", () => {
  it("握手通道失败 ⇒ 本地未发送，业务通道一次都没被调用", async () => {
    apiStub.operationsStatus = async () => {
      calls.push("operations:status");
      return { ok: false as const, error: { code: "OPERATIONS_STATUS_FAILED", message: "断开" } };
    };
    const response = await useAppStore.getState().forkAt("r_01", "s_03", "值");
    expect(response).toBe(false);
    expect(useAppStore.getState().forkErrorCode).toBe("MAIN_HANDSHAKE_REQUIRED");
    expect(calls).toEqual(["operations:status"]);
    expect(deriveGate(useAppStore.getState().operations).blockedBy).toBe("not_handshaked");
  });

  it("握手返回非法快照 ⇒ 同样未发送，且不部分采纳所谓成功字段", async () => {
    apiStub.operationsStatus = async () =>
      ok({
        epoch: "not-a-uuid",
        registryVersion: 0,
        operations: [],
      } as unknown as OperationStatusResult);
    await useAppStore.getState().createRun({ systemPrompt: "", userMessage: "任务" });
    expect(useAppStore.getState().createRunErrorCode).toBe("MAIN_HANDSHAKE_REQUIRED");
    expect(useAppStore.getState().operations.epoch).toBeNull();
    expect(calls.filter((one) => one === "runs:create")).toHaveLength(0);
  });

  it("main 报 activeOperationId ⇒ 另一个入口在发出前就被拒（跨入口忙碌）", async () => {
    statusWith({
      registryVersion: 1,
      activeOperationId: "33333333-3333-4333-8333-333333333333",
      operations: [runningRecord("33333333-3333-4333-8333-333333333333")],
    });
    expect(await useAppStore.getState().createRun({ systemPrompt: "", userMessage: "任务" })).toBe(
      false,
    );
    expect(useAppStore.getState().createRunErrorCode).toBe("OPERATION_BUSY");
    // 只有握手那一次调用，没有业务请求
    expect(calls.filter((one) => one === "runs:create")).toHaveLength(0);

    statusWith({ registryVersion: 2, activeOperationId: null });
    await useAppStore.getState().refreshOperationStatus();
    await useAppStore.getState().createRun({ systemPrompt: "", userMessage: "任务" });
    expect(calls).toContain("runs:create");
  });
});

describe("4.1 store：本地在飞身份与未知锁", () => {
  it("提交在飞时第二个入口被本地拦住（不等 main 回 busy）", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    apiStub.forkRun = async (request: { operation: { epoch: string; operationId: string } }) => {
      calls.push("runs:fork");
      await gate;
      return {
        ok: true as const,
        operation: { ...request.operation, registryVersion: 3, state: "settled" as const },
        data: { id: "run_forked" },
      };
    };
    statusWith({ registryVersion: 1, activeOperationId: null });

    const first = useAppStore.getState().forkAt("r_01", "s_03", "值");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(calls).toContain("runs:fork");
    expect(deriveGate(useAppStore.getState().operations).blockedBy).toBe("operation_running");

    // 第二个入口：请求还没离开 renderer 就被拒
    const second = await useAppStore.getState().promptFork("r_01", {
      field: "user_message",
      value: "换个问法",
    });
    expect(second).toBe(false);
    expect(calls).not.toContain("runs:promptFork");

    releaseFirst();
    expect(await first).toBe(true);
    // 可信终态回执销账 ⇒ 本地锁释放
    expect(deriveGate(useAppStore.getState().operations).blockedBy).toBe(null);
    expect(useAppStore.getState().operations.pending).toHaveLength(0);
  });

  it("通道抛错 ⇒ 未知锁且保留在飞身份；不自动重发，只有有效 status 才解锁", async () => {
    statusWith({ registryVersion: 1 });
    await useAppStore.getState().refreshOperationStatus();
    apiStub.forkRun = async () => {
      calls.push("runs:fork");
      throw new Error("ipc channel gone");
    };
    await expect(useAppStore.getState().forkAt("r_01", "s_03", "值")).rejects.toThrow(
      "ipc channel gone",
    );
    const locked = useAppStore.getState().operations;
    expect(deriveGate(locked).blockedBy).toBe("communication_unknown");
    expect(locked.pending).toHaveLength(1);

    // 未知期间再次提交：本地拦住，绝不重发（main 那边可能正在跑）
    await expect(useAppStore.getState().forkAt("r_01", "s_03", "值")).resolves.toBe(false);
    expect(calls.filter((one) => one === "runs:fork")).toHaveLength(1);

    // 下一次有效 status 才确认：登记里该身份已 settled ⇒ 销账 + 解锁
    const pendingId = locked.pending[0]?.operationId as string;
    statusWith({
      registryVersion: 5,
      activeOperationId: null,
      operations: [
        {
          epoch: FAKE_EPOCH,
          operationId: pendingId,
          target: {
            kind: "result",
            mode: "plain",
            parentRunId: "r_01",
            atSpanId: "s_03",
            editField: "result",
          },
          state: "settled",
          rejection: null,
          startedAt: "2026-09-26T00:00:00.000Z",
          settledAt: "2026-09-26T00:00:01.000Z",
          runIds: ["run_maybe"],
          experimentId: null,
          arms: [],
          requestOutcome: "returned",
          errorCode: null,
          diagnostics: [],
        },
      ],
    });
    const healed = await useAppStore.getState().refreshOperationStatus();
    expect(deriveGate(healed).blockedBy).toBe(null);
    expect(healed.pending).toHaveLength(0);
    // 只读地知道"可能已经执行"，但不自动重发也不冒充成功：界面按 runIds 让用户明确打开
    expect(healed.operations.find((one) => one.operationId === pendingId)?.runIds).toEqual([
      "run_maybe",
    ]);
  });

  it("回执身份不匹配（main 回了别人的操作）⇒ 按未知处理，不销账也不解冻", async () => {
    statusWith({ registryVersion: 1 });
    await useAppStore.getState().refreshOperationStatus();
    const key = { runId: "r_01", spanId: "s_03", field: "result" } as const;
    useAppStore.getState().ensureCallDraft(key, "原值", undefined);
    useAppStore.getState().writeCallDraftText(key, "编辑后的值");
    const assoc = useAppStore.getState().beginDraftSubmission({ channel: "result", target: key });
    if (assoc === null) throw new Error("unreachable：应能登记提交关联");

    apiStub.forkRun = async () => ({
      ok: true as const,
      operation: {
        epoch: FAKE_EPOCH,
        operationId: "11111111-1111-4111-8111-ffffffffffff",
        registryVersion: 2,
        state: "settled" as const,
      },
      data: { id: "run_wrong_one" },
    });
    const done = await useAppStore
      .getState()
      .forkAt("r_01", "s_03", assoc.submittedText, undefined, assoc);
    expect(done).toBe(false);
    expect(useAppStore.getState().forkErrorCode).toBe("OPERATION_ACK_INVALID");
    // 门禁侧：身份不明的响应既不解锁也不销账（草稿冻结由任务 4.2 钉）
    expect(useAppStore.getState().operations.pending).toHaveLength(1);
    expect(deriveGate(useAppStore.getState().operations).blockedBy).toBe("communication_unknown");
  });

  it("staleEpoch 响应 ⇒ 不采纳、旧身份不销账（它的结局仍是未知）", async () => {
    statusWith({ registryVersion: 1 });
    await useAppStore.getState().refreshOperationStatus();
    apiStub.forkRun = async () => ({
      ok: false as const,
      operation: null,
      error: { code: "OPERATION_STALE_EPOCH", message: "旧 main 会话" },
    });
    expect(await useAppStore.getState().forkAt("r_01", "s_03", "值")).toBe(false);
    const state = useAppStore.getState().operations;
    expect(state.pending).toHaveLength(1);
    expect(deriveGate(state).blockedBy).toBe("communication_unknown");
  });
});

describe("4.1 store：迟到快照不得回退已采纳状态", () => {
  it("先采纳 v9（B 在跑），迟到的 v8 应答整份丢弃", async () => {
    statusWith({
      registryVersion: 9,
      activeOperationId: "55555555-5555-4444-8444-444444444444",
      operations: [runningRecord("55555555-5555-4444-8444-444444444444")],
    });
    await useAppStore.getState().refreshOperationStatus();
    // 期间又发一次握手，但让**旧**应答晚到：手工构造 applyStatus 路径的等价场景
    const generation = captureGeneration(useAppStore.getState().operations);
    statusWith({ registryVersion: 8, activeOperationId: null });
    const late = await useAppStore.getState().refreshOperationStatus();
    expect(late.registryVersion).toBe(9);
    expect(late.activeOperationId).toBe("55555555-5555-4444-8444-444444444444");
    expect(deriveGate(late).blockedBy).toBe("operation_running");
    expect(generation).toBeGreaterThan(0);
  });
});

describe("4.9 真实消费：结果不可读不重执行、也不锁配置", () => {
  it("按可信 runId 读详情失败 ⇒ 无操作占槽、下一次提交与握手照常", async () => {
    statusWith({
      registryVersion: 3,
      activeOperationId: null,
      operations: [
        {
          epoch: FAKE_EPOCH,
          operationId: "66666666-6666-4666-8666-666666666666",
          target: {
            kind: "result",
            mode: "plain",
            parentRunId: "r_01",
            atSpanId: "s_03",
            editField: "result",
          },
          state: "settled",
          rejection: null,
          startedAt: "2026-09-26T00:00:00.000Z",
          settledAt: "2026-09-26T00:00:04.000Z",
          runIds: ["run_unreadable"],
          experimentId: null,
          arms: [],
          requestOutcome: "returned",
          errorCode: null,
          diagnostics: [{ code: "FINALIZE_RENAME_FAILED", stage: "finalize", message: "归位失败" }],
        },
      ],
    });
    apiStub.getRun = async () => {
      calls.push("getRun");
      return { ok: false as const, error: { code: "RUN_READ_FAILED", message: "文件不可读" } };
    };
    await useAppStore.getState().refreshOperationStatus();
    const before = useAppStore.getState().operations;
    expect(before.activeOperationId).toBeNull();

    // 用户明确打开该记录 ⇒ 读取失败只留在详情错误态，不产生任何新的主动执行
    await useAppStore.getState().selectRun("run_unreadable");
    expect(calls).toContain("getRun");
    expect(calls).not.toContain("runs:fork");
    const after = useAppStore.getState().operations;
    // 读取失败不改变登记事实，也不锁住可执行性（配置与下一次提交都还可用）
    expect(after).toEqual(before);
    expect(deriveGate(after).canSubmit).toBe(true);
    expect(deriveGate(after).canChangeConfiguration).toBe(true);

    // 对照项：同一 ID 再次明确打开 ⇒ 真的重读（`selectRun` 会短路，重试口是 reopenRun）
    await useAppStore.getState().reopenRun("run_unreadable");
    expect(calls.filter((one) => one === "getRun")).toHaveLength(2);
    // 两次失败读取都没有触发任何主动执行通道
    expect(calls.filter((one) => one === "runs:fork")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// U4 6.5：核对驱动的解冻接线
// ---------------------------------------------------------------------------
/**
 * spec 把「核对到 settled/notAccepted」定为响应丢失后**唯一**合法的解冻口
 * （不自动重发、只能重新核对）。本轮实机抓到一支"纯逻辑写好、接线少一支"的缺口：
 * `settleDraftByOperation` 此前只有单测直接调用，`reconcileOperation` 从没调它
 * ⇒ 真机上核对永远解不开任何锁。下面钉住接线本身：
 * ① settled / ② notAccepted ⇒ 只解冻该身份那一条；③ running ⇒ 保持冻结；
 * ④ 别人的身份 ⇒ 一条都不解；⑤ 非法载荷 ⇒ 按未知处理且不解锁。
 */
const targetA = "r_a|s_1|result";
const OP_A = "11111111-1111-4111-8111-111111111111";
const OP_B = "22222222-2222-4222-8222-222222222222";
const OP_OTHER = "33333333-3333-4333-8333-333333333333";
const targetB = "r_b|s_2|result";

/** 两条待定关联：A 带本次要核对的身份，B 代表"另一条在飞的提交" */
function seedTwoSubmissions(opA: string): void {
  useAppStore.setState({ operations: { ...initialSession(), epoch: FAKE_EPOCH } });
  let store = subLib.emptySubmissionStore();
  for (const [id, operationId] of [
    [targetA, opA],
    [targetB, OP_B],
  ] as const) {
    const [runId, spanId, field] = id.split("|");
    const begun = subLib.beginSubmission(store, {
      channel: "result",
      target: { runId, spanId, field: field as "result" },
      submittedRevision: 1,
      submittedText: `草稿 ${runId}`,
      operationId,
      epoch: FAKE_EPOCH,
    });
    store = begun.store;
  }
  useAppStore.setState({ draftSubmissions: store });
  calls.length = 0;
}

function frozenTargets(): string[] {
  return Object.keys(useAppStore.getState().draftSubmissions.byId);
}

function reconcileResultFor(operationId: string, state: "settled" | "notAccepted" | "running") {
  // 三种状态各自允许的字段由 schema 精炼钉死（notAccepted 不得带时间/结局/运行身份，
  // settled 必须带开始+结束+结局）——这里造的是**合法**记录，非法载荷另有专测。
  const neverAccepted = state === "notAccepted";
  return {
    epoch: FAKE_EPOCH,
    registryVersion: 9,
    activeOperationId: state === "running" ? operationId : null,
    closing: false,
    configurationBusy: false,
    operation: {
      epoch: FAKE_EPOCH,
      operationId,
      target: {
        kind: "result" as const,
        mode: "plain" as const,
        parentRunId: "r_a",
        atSpanId: "s_1",
        editField: "result" as const,
      },
      state,
      rejection: neverAccepted ? ("busy" as const) : null,
      startedAt: neverAccepted ? null : "2026-09-26T00:00:00.000Z",
      settledAt: state === "settled" ? "2026-09-26T00:00:01.000Z" : null,
      runIds: state === "settled" ? ["run_from_reconcile"] : [],
      experimentId: null,
      arms: [],
      requestOutcome: state === "settled" ? ("returned" as const) : null,
      errorCode: null,
      diagnostics: [],
    },
  };
}

describe("U4 6.5 reconcileOperation 必须走解冻口（只解匹配身份那一条）", () => {
  function stubReconcile(data: unknown): void {
    apiStub.operationsReconcile = async () => ({ ok: true as const, data });
  }

  it("核对到 settled ⇒ 只解冻该身份那一条，另一条仍冻结", async () => {
    seedTwoSubmissions(OP_A);
    stubReconcile(reconcileResultFor(OP_A, "settled"));
    await useAppStore.getState().reconcileOperation(OP_A);
    expect(frozenTargets()).toEqual([targetB]);
  });

  it("核对到 notAccepted（该身份从未被接受）⇒ 同样只解那一条", async () => {
    seedTwoSubmissions(OP_A);
    stubReconcile(reconcileResultFor(OP_A, "notAccepted"));
    await useAppStore.getState().reconcileOperation(OP_A);
    expect(frozenTargets()).toEqual([targetB]);
  });

  it("核对到 running ⇒ 保持冻结（不提前解自己的锁）", async () => {
    seedTwoSubmissions(OP_A);
    stubReconcile(reconcileResultFor(OP_A, "running"));
    await useAppStore.getState().reconcileOperation(OP_A);
    expect(frozenTargets().sort()).toEqual([targetA, targetB].sort());
  });

  it("核对别人的身份 ⇒ 两条都不解冻（解冻口只认匹配身份）", async () => {
    seedTwoSubmissions(OP_A);
    stubReconcile(reconcileResultFor(OP_OTHER, "settled"));
    await useAppStore.getState().reconcileOperation(OP_OTHER);
    expect(frozenTargets().sort()).toEqual([targetA, targetB].sort());
  });

  it("核对载荷不合 schema ⇒ 按未知处理且不解任何锁", async () => {
    seedTwoSubmissions(OP_A);
    apiStub.operationsReconcile = async () =>
      ({ ok: true, data: { epoch: "not-a-uuid" } }) as unknown as Awaited<
        ReturnType<WindowApi["operationsReconcile"]>
      >;
    await useAppStore.getState().reconcileOperation(OP_A);
    expect(frozenTargets().sort()).toEqual([targetA, targetB].sort());
    expect(useAppStore.getState().operations.unknown).toBe(true);
  });

  it("草稿保留：核对解冻不等于删除输入", async () => {
    seedTwoSubmissions(OP_A);
    useAppStore.setState({
      drafts: draftLib.writeCallDraftText(
        draftLib.ensureCallDraft(
          draftLib.emptyDraftRepo(),
          { runId: "r_a", spanId: "s_1", field: "result" },
          "原值",
        ).repo,
        { runId: "r_a", spanId: "s_1", field: "result" },
        "U4-65 待核对的草稿",
      ),
    });
    stubReconcile(reconcileResultFor(OP_A, "settled"));
    await useAppStore.getState().reconcileOperation(OP_A);
    const entry = useAppStore.getState().drafts.calls.r_a?.s_1?.result;
    expect(entry?.text).toBe("U4-65 待核对的草稿");
    expect(useAppStore.getState().draftSubmissions.byId[targetA]).toBeUndefined();
  });
});
