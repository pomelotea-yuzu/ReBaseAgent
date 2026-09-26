import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { DraftSubmission } from "../src/renderer/src/lib/draft-submission";
import { submissionByOperation, submissionIdOf } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { ok } from "../src/shared/ipc";
import type { Envelope } from "../src/shared/ipc";
import type { ExecutedRequest, OperationAck } from "../src/shared/operations";
import { FAKE_EPOCH, installOperationChannels, statusSnapshot } from "./helpers/operation-channels";

/**
 * U4 任务 4.2：提交关联绑定 **main 操作身份**（`epoch` + `operationId`），解冻只按身份判。
 *
 * 判据来源：tasks.md 4.2 + design D6；delta spec `desktop-ui`（逐字标题）：
 * - 「提交快照独立于编辑器挂载」——身份在**登记关联时就生成**，与草稿快照同一步原子取到，
 *   之后组件卸载/复位都不改它；
 * - 「核对终态只解冻对应修订」——只有 `epoch`/`operationId` 都对得上、且已进终态
 *   （settled / notAccepted）的回执才解冻本次关联；
 * - 「迟到回调与未知状态不能错误解冻」——`running` 回执、身份不匹配的回执、
 *   回执不可信（缺字段/形状非法）都保留冻结；通道抛错同样保留；
 * - 「初始握手失败禁用主动入口」的另一面——本地门禁拦下（请求没发出）时**必须**解冻，
 *   否则一次没发出去的提交会把草稿永远锁死；
 * - `settleDraftByOperation` 是 reconcile 驱动的唯一解冻口：只解匹配身份那一条，
 *   身份查不到 ⇒ 仓库引用一字不动。
 *
 * 一律不删草稿（U3 design D5）：解冻只解除"修改/放弃"的冻结。
 */

const KEY = { runId: "r_01", spanId: "s_03", field: "result" } as const;
const OTHER_KEY = { runId: "r_02", spanId: "s_09", field: "result" } as const;

interface Sent {
  request: ExecutedRequest<unknown> | null;
}
const sent: Sent = { request: null };

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<{ runs: never[]; failed: never[] }>> =>
    ok({ runs: [], failed: [] }),
  getRun: async (id: string) => ({
    ok: false as const,
    error: { code: "RUN_UNREADABLE", message: `桩不提供详情：${id}` },
  }),
  forkRun: async () => {
    return { ok: false as const, error: { code: "UNUSED", message: "默认桩" } };
  },
};
installOperationChannels(apiStub);
(globalThis as Record<string, unknown>).window = { api: apiStub };

const { useAppStore } = await import("../src/renderer/src/store");

function reset(): void {
  sent.request = null;
  useAppStore.setState({
    operations: initialSession(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    forking: "idle",
    forkError: null,
    forkErrorCode: null,
  });
}

beforeEach(async () => {
  reset();
  // 默认：握手可用 + 编辑器同形（打开登记基线 → 编辑 → 登记关联）
  apiStub.operationsStatus = async () => ok(statusSnapshot());
  await useAppStore.getState().refreshOperationStatus();
  useAppStore.getState().ensureCallDraft(KEY, "原结果", undefined);
  useAppStore.getState().writeCallDraftText(KEY, "编辑后的结果");
});

function ackOf(
  operationId: string,
  state: OperationAck["state"],
  epoch = FAKE_EPOCH,
): OperationAck {
  return { epoch, operationId, registryVersion: 5, state };
}

function stubFork(
  build: (identity: OperationAck["operationId"]) => {
    operation: OperationAck | null;
    ok: boolean;
    data?: { id: string };
    error?: { code: string; message: string };
  },
): DraftSubmission | null {
  const assoc = useAppStore.getState().beginDraftSubmission({ channel: "result", target: KEY });
  if (assoc === null) return null;
  apiStub.forkRun = async (request: ExecutedRequest<unknown>) => {
    sent.request = request;
    const built = build(request.operation.operationId);
    return {
      ok: built.ok,
      operation: built.operation,
      ...(built.ok ? { data: built.data ?? { id: "run_new" } } : { error: built.error }),
    } as never;
  };
  return assoc;
}

function frozen(): boolean {
  return useAppStore.getState().isDraftFrozen(KEY);
}

describe("4.2 关联携带 main 操作身份", () => {
  it("operationId 在登记时就生成（UUID），且请求里出现的是同一个身份", async () => {
    const assoc = stubFork((operationId) => ({
      ok: true,
      operation: ackOf(operationId, "settled"),
    }));
    if (assoc === null) throw new Error("unreachable：应能登记关联");
    expect(assoc.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(assoc.epoch).toBe(FAKE_EPOCH);

    await useAppStore.getState().forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc);
    if (sent.request === null) throw new Error("unreachable：请求应已发出");
    expect(sent.request.operation.operationId).toBe(assoc.operationId);
    expect(sent.request.operation.epoch).toBe(FAKE_EPOCH);
  });

  it("未握手时登记关联 ⇒ epoch 先为 null；真正发出时才绑上，之后按身份收尾", async () => {
    reset();
    useAppStore.getState().ensureCallDraft(KEY, "原结果", undefined);
    useAppStore.getState().writeCallDraftText(KEY, "编辑后的结果");
    const assoc = useAppStore.getState().beginDraftSubmission({ channel: "result", target: KEY });
    if (assoc === null) throw new Error("unreachable：应能登记关联");
    expect(assoc.epoch).toBeNull();

    apiStub.forkRun = async (request: ExecutedRequest<unknown>) => {
      sent.request = request;
      return {
        ok: true,
        operation: ackOf(request.operation.operationId, "settled"),
        data: { id: "run_new" },
      } as never;
    };
    await useAppStore.getState().forkAt("r_01", KEY.spanId, "值", undefined, assoc);
    // 发出去了 ⇒ 说明适配器补到了 epoch；仓库里的关联也被绑定后才收尾
    if (sent.request === null) throw new Error("unreachable：请求应已发出");
    expect(sent.request.operation.epoch).toBe(FAKE_EPOCH);
    expect(useAppStore.getState().isDraftFrozen(KEY)).toBe(false);
  });
});

describe("4.2 按身份解冻", () => {
  it("同身份 + settled ⇒ 解冻，草稿原文保留", async () => {
    const assoc = stubFork((operationId) => ({
      ok: true,
      operation: ackOf(operationId, "settled"),
    }));
    if (assoc === null) throw new Error("unreachable");
    expect(frozen()).toBe(true);
    expect(
      await useAppStore
        .getState()
        .forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc),
    ).toBe(true);
    expect(frozen()).toBe(false);
    expect(useAppStore.getState().callDraftOf(KEY)?.text).toBe("编辑后的结果");
  });

  it("同身份 + notAccepted（main 拒了这次提交）⇒ 同样解冻：这是可信终态，不是未知", async () => {
    const assoc = stubFork((operationId) => ({
      ok: false,
      operation: ackOf(operationId, "notAccepted"),
      error: { code: "OPERATION_NOT_ACCEPTED", message: "未接受" },
    }));
    if (assoc === null) throw new Error("unreachable");
    expect(
      await useAppStore
        .getState()
        .forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc),
    ).toBe(false);
    expect(frozen()).toBe(false);
    expect(useAppStore.getState().callDraftOf(KEY)?.text).toBe("编辑后的结果");
  });

  it("running 回执 ⇒ 保留冻结（执行还在进行，不能假装结束）", async () => {
    const assoc = stubFork((operationId) => ({
      ok: true,
      operation: ackOf(operationId, "running"),
    }));
    if (assoc === null) throw new Error("unreachable");
    await useAppStore.getState().forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc);
    expect(frozen()).toBe(true);
  });

  it("身份不匹配的回执（main 回了别人的操作）⇒ 保留冻结 + 不解锁门禁", async () => {
    const assoc = stubFork(() => ({
      ok: true,
      operation: ackOf("99999999-9999-4999-8999-999999999999", "settled"),
    }));
    if (assoc === null) throw new Error("unreachable");
    const done = await useAppStore
      .getState()
      .forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc);
    expect(done).toBe(false);
    expect(useAppStore.getState().forkErrorCode).toBe("OPERATION_ACK_INVALID");
    expect(frozen()).toBe(true);
    expect(useAppStore.getState().callDraftOf(KEY)?.text).toBe("编辑后的结果");
    // 门禁也进未知：不能因为一条冒充的回执就放行下一次提交
    expect(useAppStore.getState().operations.pending).toHaveLength(1);
  });

  it("旧提交的回执不能解冻新提交（身份 + 令牌双守卫）", async () => {
    const first = stubFork((operationId) => ({
      ok: true,
      operation: ackOf(operationId, "settled"),
    }));
    if (first === null) throw new Error("unreachable");
    // 手工收尾第一条（模拟响应已到达）
    useAppStore.getState().settleDraftSubmission(first);
    const second = useAppStore.getState().beginDraftSubmission({ channel: "result", target: KEY })!;
    expect(second.operationId).not.toBe(first.operationId);

    // 拿 first 的身份回执去收尾：新关联必须不动
    useAppStore.getState().finishDraftSubmission(second, {
      ok: true,
      operation: ackOf(first.operationId, "settled"),
      data: { id: "run_stale" },
    });
    expect(frozen()).toBe(true);
    // 用 second 自己的身份才解得开
    useAppStore.getState().finishDraftSubmission(second, {
      ok: true,
      operation: ackOf(second.operationId, "settled"),
      data: { id: "run_new" },
    });
    expect(frozen()).toBe(false);
  });

  it("本地门禁拦下（请求未发出）⇒ 解冻，草稿可以改可以再提", async () => {
    const assoc = stubFork((operationId) => ({
      ok: true,
      operation: ackOf(operationId, "settled"),
    }));
    if (assoc === null) throw new Error("unreachable");
    // 让 main 报"有操作在跑"：本次提交在 renderer 里就被拦下，operation 为 null
    apiStub.operationsStatus = async () =>
      ok(
        statusSnapshot({
          registryVersion: 6,
          activeOperationId: "88888888-8888-4888-8888-888888888888",
          operations: [
            {
              epoch: FAKE_EPOCH,
              operationId: "88888888-8888-4888-8888-888888888888",
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
            },
          ],
        }),
      );
    await useAppStore.getState().refreshOperationStatus();
    const blocked = await useAppStore
      .getState()
      .forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc);
    expect(blocked).toBe(false);
    expect(useAppStore.getState().forkErrorCode).toBe("OPERATION_BUSY");
    expect(sent.request).toBeNull();
    expect(frozen()).toBe(false);
    expect(useAppStore.getState().callDraftOf(KEY)?.text).toBe("编辑后的结果");
  });

  it("通道抛错 ⇒ 冻结保留（状态未知，不自动重发）", async () => {
    const assoc = stubFork((operationId) => ({
      ok: true,
      operation: ackOf(operationId, "settled"),
    }));
    if (assoc === null) throw new Error("unreachable");
    apiStub.forkRun = async () => {
      throw new Error("ipc channel gone");
    };
    await expect(
      useAppStore.getState().forkAt("r_01", KEY.spanId, assoc.submittedText, undefined, assoc),
    ).rejects.toThrow("ipc channel gone");
    expect(frozen()).toBe(true);
  });
});

describe("4.2 reconcile 驱动的解冻口（settleDraftByOperation）", () => {
  it("只解匹配身份那一条；别的待定关联与查不到的身份都不改仓库引用", () => {
    const first = useAppStore.getState().beginDraftSubmission({ channel: "result", target: KEY })!;
    useAppStore.getState().ensureCallDraft(OTHER_KEY, "原结果 2", undefined);
    useAppStore.getState().writeCallDraftText(OTHER_KEY, "编辑后的结果 2");
    const second = useAppStore
      .getState()
      .beginDraftSubmission({ channel: "result", target: OTHER_KEY })!;

    // 身份查不到 ⇒ 引用不变（不"顺手清一条"，也不按列表位置猜）
    const before = useAppStore.getState().draftSubmissions;
    useAppStore.getState().settleDraftByOperation({
      epoch: FAKE_EPOCH,
      operationId: "77777777-7777-4777-8777-777777777777",
    });
    expect(useAppStore.getState().draftSubmissions).toBe(before);

    // 按 first 的身份核对到终态 ⇒ 只解 first
    useAppStore.getState().settleDraftByOperation({
      epoch: first.epoch as string,
      operationId: first.operationId,
    });
    expect(useAppStore.getState().isDraftFrozen(KEY)).toBe(false);
    expect(useAppStore.getState().isDraftFrozen(OTHER_KEY)).toBe(true);
    // 仓库里再也找不到该身份（终态只解一次），而 second 的身份仍在
    const store = useAppStore.getState().draftSubmissions;
    expect(submissionByOperation(store, first.epoch as string, first.operationId)).toBeUndefined();
    expect(submissionByOperation(store, second.epoch as string, second.operationId)?.id).toBe(
      submissionIdOf(OTHER_KEY),
    );
  });
});
