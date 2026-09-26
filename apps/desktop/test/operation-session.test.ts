import type { OperationRecord, OperationStatusResult, ReconcileResult } from "@shared/operations";
import { describe, expect, it } from "vitest";
import {
  type OperationSession,
  applyReconcile,
  applyStatus,
  beginHandshake,
  beginLocalSubmission,
  captureGeneration,
  deriveGate,
  endLocalSubmission,
  initialSession,
  markUnknown,
  operationOf,
} from "../src/renderer/src/lib/operation-session";

/**
 * U4 任务 4.1：renderer 侧操作会话的**守卫判据**（design D4/D6）。
 *
 * 判据来源：tasks.md 4.1 + delta spec `desktop-ui`（逐字标题）：
 * - 「初始握手失败禁用主动入口」——`epoch === null` 时提交与配置写入口都不可用，
 *   且原因仍是"未握手"（允许下一次提交自动补握手，而不是冒充"曾有会话后失联"）；
 * - 「乱序快照不回退新状态」——低 `registryVersion` 的快照、旧请求代次的迟到响应整份丢弃；
 *   settled 不因旧 running 快照回退，新槽不被旧槽覆盖；
 * - 「非法操作响应不能解除门禁」——通道失败/载荷非法 ⇒ 保守锁（有会话后才是 unknown）；
 * - 「握手和快照自洽」「核对旧操作不解除另一操作的锁」——锁由**当前槽**派生，
 *   不由被查询的那条操作派生；
 * - 「新 main 会话不伪造旧操作结局」——epoch 改变只由有效 status 确认；
 *   reconcile 带别的 epoch ⇒ 整份丢弃，旧 epoch 的在飞身份不销账。
 *
 * 这里只测纯转移（`lib/operation-session.ts`），store 侧的接线判据在
 * `test/operation-session-store.test.ts`（真调 `window.api` 桩，测"发没发出去"）。
 */

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";
const OP_A = "aaaaaaaa-0000-4000-8000-000000000001";
const OP_B = "bbbbbbbb-0000-4000-8000-000000000002";

const AT = "2026-09-26T00:00:00.000Z";

function recordOf(
  operationId: string,
  state: OperationRecord["state"],
  overrides: Partial<OperationRecord> = {},
): OperationRecord {
  const base: OperationRecord = {
    epoch: EPOCH_A,
    operationId,
    target: { kind: "create", mode: "plain" },
    state,
    rejection: null,
    startedAt: AT,
    settledAt: state === "running" ? null : AT,
    runIds: state === "settled" ? ["run_x"] : [],
    experimentId: null,
    arms: [],
    requestOutcome: state === "settled" ? "returned" : null,
    errorCode: null,
    diagnostics: [],
  };
  if (state === "notAccepted") {
    return {
      ...base,
      ...base,
      startedAt: null,
      rejection: "busy",
      ...overrides,
    } as OperationRecord;
  }
  return { ...base, ...overrides };
}

function statusOf(overrides: Partial<OperationStatusResult> = {}): OperationStatusResult {
  return {
    epoch: EPOCH_A,
    registryVersion: 1,
    activeOperationId: null,
    closing: false,
    configurationBusy: false,
    operations: [],
    ...overrides,
  };
}

function reconcileOf(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    epoch: EPOCH_A,
    registryVersion: 1,
    activeOperationId: null,
    closing: false,
    configurationBusy: false,
    operation: recordOf(OP_A, "settled"),
    ...overrides,
  };
}

/** 采纳一次 status（按当前代次发出，等价于 store 的正常路径） */
function withStatus(session: OperationSession, snapshot: OperationStatusResult) {
  const issued = beginHandshake(session);
  return applyStatus(issued, snapshot, issued.generation);
}

describe("4.1 初始未确认与 Unknown 保守锁", () => {
  it("没握过手 ⇒ 主动入口与配置写入口都禁用，原因是不知握手而非未知", () => {
    const gate = deriveGate(initialSession());
    expect(gate.canSubmit).toBe(false);
    expect(gate.canChangeConfiguration).toBe(false);
    expect(gate.blockedBy).toBe("not_handshaked");
  });

  it("有效握手后空闲 ⇒ 两个入口都开放", () => {
    const { session } = withStatus(initialSession(), statusOf({ registryVersion: 1 }));
    expect(session.epoch).toBe(EPOCH_A);
    expect(deriveGate(session)).toEqual({
      canSubmit: true,
      canChangeConfiguration: true,
      blockedBy: null,
    });
  });

  it("main 有 running / closing / configurationBusy ⇒ 按优先级给出禁用原因", () => {
    const running = withStatus(initialSession(), statusOf({ activeOperationId: OP_A })).session;
    expect(deriveGate(running).blockedBy).toBe("operation_running");
    // 关闭协商优先于配置变更，配置变更优先于槽
    const both = withStatus(
      initialSession(),
      statusOf({ activeOperationId: OP_A, closing: true, configurationBusy: true }),
    ).session;
    expect(deriveGate(both).blockedBy).toBe("closing");
    const config = withStatus(
      initialSession(),
      statusOf({ activeOperationId: OP_A, configurationBusy: true }),
    ).session;
    expect(deriveGate(config).blockedBy).toBe("configuration_busy");
  });

  it("从未有会话时通道失败仍是「未握手」；已有会话后失败才转 Unknown", () => {
    // 从未握手：markUnknown 不冒充"曾有会话后失联"（否则下一次提交不再自动补握手）
    const fresh = markUnknown(initialSession());
    expect(fresh.unknown).toBe(false);
    expect(deriveGate(fresh).blockedBy).toBe("not_handshaked");

    // 已有会话：失联 ⇒ unknown 锁，且保留既有事实（不静默变回空闲）
    const established = withStatus(initialSession(), statusOf({ registryVersion: 4 })).session;
    const lost = markUnknown(established);
    expect(lost.unknown).toBe(true);
    expect(deriveGate(lost).blockedBy).toBe("communication_unknown");
    expect(lost.epoch).toBe(EPOCH_A);
    expect(lost.registryVersion).toBe(4);
  });

  it("Unknown 只由下一次有效 status 清除；reconcile 只补事实、不解未知", () => {
    const established = withStatus(initialSession(), statusOf({ registryVersion: 4 })).session;
    const lost = markUnknown(established);
    const generation = captureGeneration(lost);
    const afterReconcile = applyReconcile(
      lost,
      reconcileOf({ registryVersion: 5 }),
      generation,
    ).session;
    expect(afterReconcile.unknown).toBe(true);
    expect(deriveGate(afterReconcile).blockedBy).toBe("communication_unknown");
    // 事实被补上了
    expect(afterReconcile.registryVersion).toBe(5);
    // 完整快照才确认通信恢复
    const healed = withStatus(afterReconcile, statusOf({ registryVersion: 6 })).session;
    expect(healed.unknown).toBe(false);
    expect(deriveGate(healed).blockedBy).toBe(null);
  });
});

describe("4.1 乱序快照与请求代次守卫", () => {
  it("低登记版本的迟到快照整份丢弃：settled 不回退 running、新槽不被旧槽覆盖", () => {
    const current = withStatus(
      initialSession(),
      statusOf({ registryVersion: 9, activeOperationId: OP_B }),
    ).session;
    const stale = current;
    const issued = beginHandshake(stale);
    const result = applyStatus(
      issued,
      statusOf({
        registryVersion: 8,
        activeOperationId: OP_A,
        operations: [recordOf(OP_A, "running")],
      }),
      issued.generation,
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("stale_version");
    expect(result.session.activeOperationId).toBe(OP_B);
    expect(result.session.registryVersion).toBe(9);
  });

  it("旧请求代次的迟到响应不得使用（期间又发起过新握手）", () => {
    const session = withStatus(initialSession(), statusOf({ registryVersion: 1 })).session;
    beginHandshake(session); // 新一次握手已发出（代次前进）
    const late = applyStatus(session, statusOf({ registryVersion: 42, closing: true }), 0);
    expect(late.applied).toBe(false);
    expect(late.reason).toBe("stale_generation");
    expect(late.session.closing).toBe(false);
    expect(late.session.registryVersion).toBe(1);
  });

  it("等版本快照可采纳（同 registryVersion 不属于旧响应判据）", () => {
    const session = withStatus(initialSession(), statusOf({ registryVersion: 3 })).session;
    const applied = withStatus(session, statusOf({ registryVersion: 3, closing: true }));
    expect(applied.applied).toBe(true);
    expect(applied.session.closing).toBe(true);
  });

  it("epoch 改变只由有效 status 确认：整份替换 + 清 unknown，并报告 new_epoch", () => {
    const established = markUnknown(
      withStatus(initialSession(), statusOf({ registryVersion: 4 })).session,
    );
    const switched = withStatus(
      established,
      statusOf({ epoch: EPOCH_B, registryVersion: 1, operations: [] }),
    );
    expect(switched.reason).toBe("new_epoch");
    expect(switched.session.epoch).toBe(EPOCH_B);
    expect(switched.session.unknown).toBe(false);
    expect(switched.session.registryVersion).toBe(1);
  });

  it("reconcile 带别的 epoch ⇒ 整份丢弃且不切换会话", () => {
    const session = withStatus(initialSession(), statusOf({ registryVersion: 2 })).session;
    const result = applyReconcile(
      session,
      reconcileOf({ epoch: EPOCH_B, registryVersion: 99 }),
      captureGeneration(session),
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("epoch_mismatch");
    expect(result.session.epoch).toBe(EPOCH_A);
    expect(result.session.registryVersion).toBe(2);
  });
});

describe("4.1 核对旧操作不解除另一操作的锁", () => {
  it("B 在跑时核对到 A settled：A 不再占槽，但全局仍是 operation_running", () => {
    const base = withStatus(
      initialSession(),
      statusOf({
        registryVersion: 5,
        activeOperationId: OP_B,
        operations: [recordOf(OP_B, "running")],
      }),
    ).session;
    const generation = captureGeneration(base);
    const result = applyReconcile(
      base,
      reconcileOf({
        registryVersion: 6,
        activeOperationId: OP_B,
        operation: recordOf(OP_A, "settled"),
      }),
      generation,
    );
    expect(result.applied).toBe(true);
    const record = result.session.operations.find((one) => one.operationId === OP_A);
    expect(record?.state).toBe("settled");
    expect(deriveGate(result.session).blockedBy).toBe("operation_running");
    // 槽指向的 B 仍是 running 事实（快照自洽），锁由它派生
    expect(result.session.activeOperationId).toBe(OP_B);
  });

  it("核对到当前槽已空 ⇒ 锁释放（B settled 后允许下一次提交）", () => {
    const base = withStatus(
      initialSession(),
      statusOf({
        registryVersion: 5,
        activeOperationId: OP_B,
        operations: [recordOf(OP_B, "running")],
      }),
    ).session;
    const result = applyReconcile(
      base,
      reconcileOf({
        registryVersion: 7,
        activeOperationId: null,
        operation: recordOf(OP_B, "settled"),
      }),
      captureGeneration(base),
    );
    expect(deriveGate(result.session).blockedBy).toBe(null);
  });
});

describe("4.1 本地尚未确认的提交也参与门禁", () => {
  const identity = { epoch: EPOCH_A, operationId: OP_A };

  it("发出一次提交即锁住跨入口；可信终态回执才销账", () => {
    const idle = withStatus(initialSession(), statusOf()).session;
    const busy = beginLocalSubmission(idle, identity);
    expect(deriveGate(busy).blockedBy).toBe("operation_running");
    const settled = endLocalSubmission(busy, OP_A);
    expect(deriveGate(settled).blockedBy).toBe(null);
    // 销账幂等：不认识的 operationId 不改引用（旧回调不能解别人的锁）
    expect(endLocalSubmission(settled, OP_B)).toBe(settled);
  });

  it("销账只认终态事实：登记里 running 或查不到都不算结束", () => {
    const busy = beginLocalSubmission(withStatus(initialSession(), statusOf()).session, identity);
    // 快照里该操作仍 running ⇒ 仍在飞
    const stillRunning = withStatus(
      busy,
      statusOf({ registryVersion: 2, operations: [recordOf(OP_A, "running")] }),
    );
    expect(stillRunning.session.pending).toHaveLength(1);
    // 快照里查不到该身份 ⇒ 绝不因"没看到"就当没执行过
    const missing = withStatus(busy, statusOf({ registryVersion: 3, operations: [] }));
    expect(missing.session.pending).toHaveLength(1);
    // 终态（settled / notAccepted）才销账
    const done = withStatus(
      busy,
      statusOf({ registryVersion: 4, operations: [recordOf(OP_A, "settled")] }),
    );
    expect(done.session.pending).toHaveLength(0);
    const banned = withStatus(
      beginLocalSubmission(done.session, { epoch: EPOCH_A, operationId: OP_B }),
      statusOf({ registryVersion: 5, operations: [recordOf(OP_B, "notAccepted")] }),
    );
    expect(banned.session.pending).toHaveLength(0);
  });

  it("新 main 会话不伪造旧在飞身份的结局：旧身份保持、且不再被新快照销账", () => {
    const busy = beginLocalSubmission(withStatus(initialSession(), statusOf()).session, identity);
    const switched = withStatus(
      busy,
      statusOf({ epoch: EPOCH_B, registryVersion: 1, operations: [recordOf(OP_A, "settled")] }),
    );
    // 该记录属于 EPOCH_A，不能解释新会话里这次提交（身份查询按 epoch 收窄）
    expect(operationOf(switched.session, EPOCH_A, OP_A)).toBeUndefined();
    expect(switched.session.pending).toEqual([identity]);
    expect(deriveGate(switched.session).blockedBy).toBe("operation_running");
  });
});
