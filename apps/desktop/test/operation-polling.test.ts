import type { SpanLine } from "@rebaseagent/trace-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  POLL_INTERVAL_MS,
  type PollContext,
  type PollState,
  disarmPoll,
  initialPollState,
  onPollSettled,
  onResponseSettled,
  onTimerFired,
} from "../src/renderer/src/lib/operation-polling";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { ok } from "../src/shared/ipc";
import type { Envelope } from "../src/shared/ipc";
import type { OperationRecord, OperationStatusResult } from "../src/shared/operations";
import { FAKE_EPOCH, installOperationChannels, statusSnapshot } from "./helpers/operation-channels";

/**
 * U4 任务 4.5：**单路有界轮询**——纯状态机 + store 接线两层。
 *
 * 判据来源：tasks.md 4.5 + design D6；delta spec `desktop-ui`（逐字标题）：
 * - 「状态通道不可用保持未知」——失联 ⇒ 停自动轮询（不靠重试打爆通道），但**手动核对仍可发**；
 * - 「同 main 重载恢复操作」——挂载握手恢复同 epoch 的槽与登记（含 settled / notAccepted 事实），
 *   有在跑的操作才接着轮询；
 * - 「握手和快照自洽」/「核对旧操作不解除另一操作的锁」——轮询只更新会话，
 *   锁始终由快照里的**当前槽**派生；
 * - 单路与计时：**响应完成后**才计时、在飞不叠加、无 running 即停；
 *   且轮询期间**一次业务请求都不发**（不重放 payload）。
 *
 * 计时用 vitest 假时钟（`vi.advanceTimersByTimeAsync`），不靠真实 sleep 赌时序。
 */

const RUNNING = "33333333-3333-4333-8333-333333333333";
const DONE = "44444444-4444-4444-8444-444444444444";

function runningRecord(): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: RUNNING,
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

function settledRecord(): OperationRecord {
  return {
    ...runningRecord(),
    operationId: DONE,
    state: "settled",
    settledAt: "2026-09-26T00:00:05.000Z",
    runIds: ["run_done"],
    requestOutcome: "returned",
  };
}

function notAcceptedRecord(): OperationRecord {
  return {
    ...runningRecord(),
    operationId: "55555555-5555-4555-8555-555555555555",
    state: "notAccepted",
    startedAt: null,
    settledAt: null,
    rejection: "reconcile_tombstone",
    target: null,
  };
}

const ctx = (overrides: Partial<PollContext> = {}): PollContext => ({
  hasActive: true,
  unknown: false,
  ...overrides,
});

describe("4.5 轮询状态机（纯判据）", () => {
  it("响应完成后才计时：有活性 ⇒ 排一次，且已排定时不叠加", () => {
    const first = onResponseSettled(initialPollState(), ctx());
    expect(first.action).toEqual({ type: "arm", delayMs: POLL_INTERVAL_MS });
    // 又一次响应完成（例如同步握手回来）⇒ 不排第二个定时器
    const second = onResponseSettled(first.state, ctx());
    expect(second.action).toEqual({ type: "none" });
  });

  it("没有已知 running / 通信未知 ⇒ 不排轮询", () => {
    expect(onResponseSettled(initialPollState(), ctx({ hasActive: false })).action).toEqual({
      type: "none",
    });
    expect(onResponseSettled(initialPollState(), ctx({ unknown: true })).action).toEqual({
      type: "none",
    });
  });

  it("在飞期间到点 ⇒ 丢弃这次触发（单路，不并发第二个请求）", () => {
    const inFlight = { inFlight: true, armed: true };
    const step = onStep(inFlight);
    expect(step.action).toEqual({ type: "none" });
    expect(step.state.inFlight).toBe(true);
  });

  it("轮询成功 ⇒ 按响应完成重新计时；失败 ⇒ 停（不再自动打通道）", () => {
    const fired = onStep(initialPollState());
    expect(fired.action).toEqual({ type: "poll" });
    const okAgain = onPollSettled(fired.state, ctx(), true);
    expect(okAgain.action).toEqual({ type: "arm", delayMs: POLL_INTERVAL_MS });
    const stopped = onPollSettled(fired.state, ctx(), false);
    expect(stopped.action).toEqual({ type: "none" });
    expect(stopped.state).toEqual({ inFlight: false, armed: false });
  });

  it("disarm 只撤定时器，不动在飞守卫", () => {
    expect(disarmPoll({ inFlight: true, armed: true })).toEqual({
      inFlight: true,
      armed: false,
    });
  });
});

/** onTimerFired 的别名（避免测试里重复长名） */
function onStep(state: PollState, context = ctx()) {
  return onTimerFired(state, context);
}

// ---------------------------------------------------------------------------
// store 接线：假时钟下数得出来的调用次数
// ---------------------------------------------------------------------------

const calls: { status: number; reconcile: number; fork: number } = {
  status: 0,
  reconcile: 0,
  fork: 0,
};

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<{ runs: never[]; failed: never[] }>> =>
    ok({ runs: [], failed: [] }),
  getRun: async (id: string) => ({
    ok: false as const,
    error: { code: "RUN_UNREADABLE", message: `桩不提供详情：${id}` },
  }),
  forkRun: async () => {
    calls.fork += 1;
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
};
installOperationChannels(apiStub);
(globalThis as Record<string, unknown>).window = { api: apiStub };

const { useAppStore } = await import("../src/renderer/src/store");

function snapshotWith(overrides: Partial<OperationStatusResult>): Envelope<OperationStatusResult> {
  return ok(statusSnapshot(overrides));
}

/** 让待办的微任务跑完（假时钟下 async 链靠它推进） */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useRealTimers();
  calls.status = 0;
  calls.reconcile = 0;
  calls.fork = 0;
  useAppStore.setState({
    operations: initialSession(),
    forking: "idle",
    forkError: null,
    forkErrorCode: null,
  });
  // 上一用例遗留的定时器必须清掉，否则计数会被跨用例污染
  useAppStore.getState().stopOperationStatusPolling();
});

describe("4.5 store 接线：单路、有界、失联即停", () => {
  it("有 running ⇒ 每 POLL_INTERVAL_MS 一次；快照转为空闲后自动停", async () => {
    vi.useFakeTimers();
    let running = true;
    apiStub.operationsStatus = async () => {
      calls.status += 1;
      return snapshotWith(
        running
          ? {
              registryVersion: calls.status,
              activeOperationId: RUNNING,
              operations: [runningRecord()],
            }
          : {
              registryVersion: calls.status,
              activeOperationId: null,
              operations: [settledRecord()],
            },
      );
    };

    const session = await useAppStore.getState().ensureOperationStatusPolling();
    expect(session.activeOperationId).toBe(RUNNING);
    const afterHandshake = calls.status; // 握手那一次

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(calls.status).toBe(afterHandshake + 1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(calls.status).toBe(afterHandshake + 2);

    // main 侧跑完 ⇒ 下一次轮询发现无活性 ⇒ 之后不再打通道
    running = false;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const settledCount = calls.status;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(calls.status).toBe(settledCount);
    expect(useAppStore.getState().operations.activeOperationId).toBeNull();
    vi.useRealTimers();
  });

  it("轮询响应很慢时不并发第二个请求（单路）", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    apiStub.operationsStatus = () =>
      new Promise((resolve) => {
        calls.status += 1;
        release = () =>
          resolve(
            snapshotWith({
              registryVersion: calls.status,
              activeOperationId: RUNNING,
              operations: [runningRecord()],
            }),
          );
      });
    const started = useAppStore.getState().ensureOperationStatusPolling();
    await drain();
    release(); // 放行握手那次响应（不 await 会死锁：握手本身就挂在这个 promise 上）
    await started;
    const afterHandshake = calls.status;

    // 到点触发一次轮询，但故意不放行 ⇒ 后续多个周期都不该再发
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(calls.status).toBe(afterHandshake + 1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(calls.status).toBe(afterHandshake + 1);
    release();
    await drain();
    vi.useRealTimers();
  });

  it("失联 ⇒ 停自动轮询，但手动核对仍可发；轮询从不碰业务通道", async () => {
    vi.useFakeTimers();
    let online = true;
    apiStub.operationsStatus = async () => {
      calls.status += 1;
      if (!online) throw new Error("ipc channel gone");
      return snapshotWith({
        registryVersion: calls.status,
        activeOperationId: RUNNING,
        operations: [runningRecord()],
      });
    };
    apiStub.operationsReconcile = async () => {
      calls.reconcile += 1;
      return ok({
        epoch: FAKE_EPOCH,
        registryVersion: 99,
        activeOperationId: RUNNING,
        closing: false,
        configurationBusy: false,
        operation: runningRecord(),
      });
    };

    await useAppStore.getState().ensureOperationStatusPolling();
    const before = calls.status;
    online = false;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(useAppStore.getState().operations.unknown).toBe(true);
    const afterLoss = calls.status;
    expect(afterLoss).toBe(before + 1); // 失败那一次打了
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 8);
    expect(calls.status).toBe(afterLoss); // 之后不再自动打

    // 手动核对不受停轮询影响（且它只读，不重放业务 payload）
    await useAppStore.getState().reconcileOperation(RUNNING);
    expect(calls.reconcile).toBe(1);
    expect(calls.fork).toBe(0);
    vi.useRealTimers();
  });

  it("同 main 重载：握手恢复在跑的操作与既有终态/封禁，不重发也不丢事实", async () => {
    apiStub.operationsStatus = async () =>
      ok(
        statusSnapshot({
          registryVersion: 7,
          activeOperationId: RUNNING,
          operations: [runningRecord(), settledRecord(), notAcceptedRecord()],
        }),
      );
    const session = await useAppStore.getState().ensureOperationStatusPolling();
    expect(session.activeOperationId).toBe(RUNNING);
    // settled 与 notAccepted 都还在快照里（不按面板开合或本地关联裁剪）
    const states = session.operations.map((one) => `${one.operationId}:${one.state}`);
    expect(states).toContain(`${RUNNING}:running`);
    expect(states).toContain(`${DONE}:settled`);
    expect(states).toContain("55555555-5555-4555-8555-555555555555:notAccepted");
    // 锁由当前槽派生：即便查到已 settled 的旧操作，全局仍 locked
    expect(useAppStore.getState().operations.pending).toHaveLength(0);
    const { deriveGate } = await import("../src/renderer/src/lib/operation-session");
    expect(deriveGate(session).blockedBy).toBe("operation_running");
    // 重载后没有自动发出任何业务请求
    expect(calls.fork).toBe(0);
  });
});
