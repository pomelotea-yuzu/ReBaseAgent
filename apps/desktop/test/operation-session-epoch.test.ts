import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import {
  deriveGate,
  initialSession,
  stalePendingOf,
} from "../src/renderer/src/lib/operation-session";
import { ok } from "../src/shared/ipc";
import type { Envelope } from "../src/shared/ipc";
import type { OperationRecord } from "../src/shared/operations";
import { installOperationChannels, statusSnapshot } from "./helpers/operation-channels";

/**
 * U4 任务 4.6 的 store 接线：**main 换会话时，旧提交一律按"未知"处理**。
 *
 * 判据（delta spec `desktop-ui` 逐字标题）：
 * - 「新 main 会话不伪造旧操作结局」——旧 epoch 的**成功响应**迟到也不生效：
 *   不导航（不刷列表、不开详情）、不解冻草稿、不把会话回退成旧 epoch；
 *   旧身份留在未知历史里（`stalePendingOf`），既不标成功也不标"从没发生过"；
 * - 同一条判据的另一面：新会话的可执行性**只按新 main 的槽**决定 ⇒ 旧未知历史
 *   不该把新入口永远锁死（但那份草稿仍冻结，由用户明确核对/放弃）；
 * - 「乱序快照不回退新状态」——换会话后旧会话的迟到快照不得覆盖新槽；
 * - 「核对结果只由用户明确打开」——`reconcileOperation` 只更新登记，
 *   不切换当前选中运行。
 */

const EPOCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = { runId: "r_01", spanId: "s_03", field: "result" } as const;

let epoch = EPOCH_A;
let version = 1;
const nav: string[] = [];
let forkGate: { promise: Promise<void>; resolve: () => void } | null = null;

function runningRecord(id: string, at: string): OperationRecord {
  return {
    epoch: at,
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
    nav.push("listRuns");
    return ok({ runs: [], failed: [] });
  },
  getRun: async (id: string) => {
    nav.push(`getRun:${id}`);
    return { ok: false as const, error: { code: "RUN_UNREADABLE", message: `桩：${id}` } };
  },
  operationsStatus: async () => {
    nav.push("status");
    return ok(
      statusSnapshot({
        epoch,
        registryVersion: version,
        activeOperationId: null,
        operations: [],
      }),
    );
  },
  operationsReconcile: async () => {
    nav.push("reconcile");
    return ok(statusSnapshot({ epoch, registryVersion: version }));
  },
  forkRun: async (request: { operation: { epoch: string; operationId: string } }) => {
    nav.push("forkRun");
    // 把响应挂在调用方手里：模拟"请求已发出、main 还在跑，期间 main 重启"
    forkGate = forkGate ?? {
      promise: Promise.resolve(),
      resolve: () => {},
    };
    await forkGate.promise;
    return {
      ok: true as const,
      operation: {
        epoch: request.operation.epoch,
        operationId: request.operation.operationId,
        registryVersion: version + 1,
        state: "settled" as const,
      },
      data: { id: "run_forked_by_old_session" },
    };
  },
};
installOperationChannels(apiStub);
(globalThis as Record<string, unknown>).window = { api: apiStub };

const { useAppStore } = await import("../src/renderer/src/store");

function reset(): void {
  nav.length = 0;
  forkGate = null;
  epoch = EPOCH_A;
  version = 1;
  useAppStore.getState().stopOperationStatusPolling();
  useAppStore.setState({
    operations: initialSession(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    forking: "idle",
    forkError: null,
    forkErrorCode: null,
    selectedRunId: null,
    selectedSpanId: null,
  });
}

beforeEach(reset);

function openDraftAndSubmit(): { promise: Promise<boolean>; operationId: string } {
  useAppStore.getState().ensureCallDraft(KEY, "原结果", undefined);
  useAppStore.getState().writeCallDraftText(KEY, "编辑后的结果");
  const assoc = useAppStore.getState().beginDraftSubmission({ channel: "result", target: KEY });
  if (assoc === null) throw new Error("unreachable：应能登记提交关联");
  const promise = useAppStore
    .getState()
    .forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc);
  return { promise, operationId: assoc.operationId };
}

/** 让待办微任务推进（不靠真实计时） */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("4.6 换 main 会话：旧提交按未知处理", () => {
  it("旧 epoch 的成功响应迟到 ⇒ 不导航、不解冻、不回退会话", async () => {
    let release: () => void = () => {};
    forkGate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      resolve: () => {},
    };
    const { promise, operationId } = openDraftAndSubmit();
    await drain();
    expect(nav).toContain("forkRun");

    // 期间 main 重启：下一次握手确认新 epoch（新会话空闲）
    epoch = EPOCH_B;
    version = 1;
    await useAppStore.getState().refreshOperationStatus();
    expect(useAppStore.getState().operations.epoch).toBe(EPOCH_B);

    // 旧请求这时才返回"成功"
    release();
    const done = await promise;
    expect(done).toBe(false);
    const state = useAppStore.getState();
    expect(state.forkErrorCode).toBe("OPERATION_SESSION_SWITCHED");
    // 不导航：既没刷列表也没打开那条"成功"的运行
    expect(nav.filter((one) => one === "listRuns" || one.startsWith("getRun:"))).toEqual([]);
    // 不解冻：那份草稿仍是待定提交（用户要能复制正文/明确放弃，但不能被旧响应解锁）
    expect(state.isDraftFrozen(KEY)).toBe(true);
    expect(state.callDraftOf(KEY)?.text).toBe("编辑后的结果");
    // 不回退会话，也不伪造结局：旧身份留在未知历史里
    expect(state.operations.epoch).toBe(EPOCH_B);
    expect(stalePendingOf(state.operations).map((one) => one.operationId)).toContain(operationId);
    expect(state.operations.pending).toHaveLength(1);
  });

  it("旧未知历史不锁新会话；新提交照常可用新身份发出", async () => {
    let release: () => void = () => {};
    forkGate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      resolve: () => {},
    };
    const old = openDraftAndSubmit();
    await drain();
    epoch = EPOCH_B;
    await useAppStore.getState().refreshOperationStatus();
    release();
    expect(await old.promise).toBe(false);

    // 新会话的空闲槽 ⇒ 入口可用（spec「只按新 main 的槽决定可执行性」）
    expect(deriveGate(useAppStore.getState().operations).canSubmit).toBe(true);
    // 同一目标的旧提交还冻着 ⇒ 新一次提交被拒（不覆盖旧关联），由用户明确处理
    const again = useAppStore.getState().beginDraftSubmission({ channel: "result", target: KEY });
    expect(again).toBeNull();
    // 换个目标（另一份草稿）就能正常发出
    const otherKey = { runId: "r_02", spanId: "s_05", field: "result" } as const;
    useAppStore.getState().ensureCallDraft(otherKey, "原结果 2", undefined);
    useAppStore.getState().writeCallDraftText(otherKey, "编辑后的结果 2");
    forkGate = { promise: Promise.resolve(), resolve: () => {} };
    const fresh = useAppStore
      .getState()
      .beginDraftSubmission({ channel: "result", target: otherKey });
    if (fresh === null) throw new Error("unreachable：新目标应可提交");
    expect(fresh.epoch).toBe(EPOCH_B);
    await useAppStore.getState().forkAt("r_02", "s_05", fresh.submittedText, undefined, fresh);
    expect(useAppStore.getState().isDraftFrozen(otherKey)).toBe(false);
    expect(useAppStore.getState().isDraftFrozen(KEY)).toBe(true);
  });

  it("换会话后旧会话的迟到快照不得覆盖新槽（不回退状态）", async () => {
    epoch = EPOCH_A;
    version = 5;
    await useAppStore.getState().refreshOperationStatus();
    // 新会话确认
    epoch = EPOCH_B;
    version = 1;
    await useAppStore.getState().refreshOperationStatus();
    // 旧会话的响应这时才到（epoch A，version 更高）
    const late = await useAppStore.getState().refreshOperationStatus();
    expect(epoch).toBe(EPOCH_B);
    expect(late.epoch).toBe(EPOCH_B);
    expect(late.registryVersion).toBe(1);
  });

  it("核对不改变当前选中（结果只由用户明确打开）", async () => {
    epoch = EPOCH_A;
    await useAppStore.getState().refreshOperationStatus();
    useAppStore.setState({ selectedRunId: "r_current", selectedSpanId: "s_keep" });
    apiStub.operationsReconcile = async () =>
      ok({
        epoch: EPOCH_A,
        registryVersion: 2,
        activeOperationId: null,
        closing: false,
        configurationBusy: false,
        operation: {
          ...runningRecord("33333333-3333-4333-8333-333333333333", EPOCH_A),
          state: "settled",
          settledAt: "2026-09-26T00:00:09.000Z",
          runIds: ["run_result_of_that_op"],
          requestOutcome: "returned",
        } satisfies OperationRecord,
      });
    await useAppStore.getState().reconcileOperation("33333333-3333-4333-8333-333333333333");
    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe("r_current");
    expect(state.selectedSpanId).toBe("s_keep");
    // 事实进了登记（供 4.7 的入口展示与用户明确打开），但没有自动跳转
    expect(
      state.operations.operations.find(
        (one) => one.operationId === "33333333-3333-4333-8333-333333333333",
      )?.runIds,
    ).toEqual(["run_result_of_that_op"]);
  });
});
