import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord, ReconcileRequest, ReconcileResult } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 1.4 的 **store 接线**：三条终态入口汇到同一消费落点。
 *
 * 判据来源：design D3「收尾入口由有效 status 采纳、有效执行回执后的状态刷新、reconcile
 * 后的状态刷新共同触发」+ delta「全部七类入口使用相同核实路径」「未知通信与新会话分开呈现」。
 * tasks 1.4 明令：**用真实 store 动作验证消费点，不只测纯函数**——所以每条断言都落在
 * `window.api` 桩的实际调用序列与 store 可见状态上。
 *
 * ⚠️ 刻意不用"组件挂载后看渲染结果"来代理：编辑器可能已卸载、操作面板可能收起，
 *    收尾照样必须发生——这正是把消费放在 store 而不是 `.then()` 里的理由。
 */

const NEW_RUN = "run_terminal_new";
const SECOND_RUN = "run_terminal_second";
const OP = "77777777-7777-7777-8777-777777777777";
const OP_OTHER = "88888888-8888-8888-8888-888888888888";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const detailOf = (name: string, id: string): RunDetail => {
  const record: RunRecord = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  const meta = record.meta.id === id ? record.meta : { ...record.meta, id };
  return {
    meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta, fork: record.meta.fork }],
    leafSpanIds: record.spans.map((span) => span.id),
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
};

/** 可配置的登记记录：只关心 state / epoch / runIds，其余填自洽值 */
function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  const state = overrides.state ?? "settled";
  const settled = state === "settled";
  return {
    epoch: FAKE_EPOCH,
    operationId: OP,
    target: {
      kind: "result",
      mode: "plain",
      parentRunId: "u1_ok",
      atSpanId: "s_03",
      editField: "result",
    },
    state,
    rejection: state === "notAccepted" ? "busy" : null,
    startedAt: state === "notAccepted" ? null : "2026-09-27T00:00:00.000Z",
    settledAt:
      settled || state === "notAccepted" ? (settled ? "2026-09-27T00:00:05.000Z" : null) : null,
    runIds: settled ? [NEW_RUN] : [],
    experimentId: null,
    arms: [],
    requestOutcome: settled ? "returned" : null,
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const calls: string[] = [];
let snapshot: () => OperationRecord[] = () => [];
let registryVersion = 1;
let statusFails = false;
/** 详情按 id 给出；`detailsFor` 可整体替换（例如让第二条读不到） */
let details: Record<string, Envelope<RunDetail>> = {};
/** reconcile 的应答（默认与 status 同源） */
let reconcileRecord: OperationRecord | null = null;
/** 下一次 status 应答由 `snapshot()` 决定；用例可整体替换本实现 */

function currentSnapshot() {
  registryVersion += 1;
  return statusSnapshot({ registryVersion, operations: snapshot(), activeOperationId: null });
}

/** 默认 status 应答：按 `snapshot()` 出全量快照（用例可临时替换以模拟失联/非法/新会话） */
function defaultOperationsStatus() {
  return async () => {
    calls.push("operations:status");
    if (statusFails) return { ok: false, error: { code: "STATUS_FAILED", message: "通道断开" } };
    return ok(currentSnapshot());
  };
}

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    return ok({ runs: [], failed: [] });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    const envelope = details[id];
    if (envelope !== undefined) return envelope;
    return ok(detailOf("u1-ok", id));
  },
  operationsStatus: defaultOperationsStatus(),
  operationsReconcile: async (request: ReconcileRequest) => {
    calls.push(`operations:reconcile:${request.operationId}`);
    const target =
      reconcileRecord ?? snapshot().find((one) => one.operationId === request.operationId);
    if (target === undefined) {
      return { ok: false, error: { code: "OPERATION_INVALID_IDENTITY", message: "查不到该操作" } };
    }
    registryVersion += 1;
    // ReconcileResult 是**严格**形状：只给槽状态 + 那一条操作（多一个 operations 就非法）
    const result: ReconcileResult = {
      epoch: target.epoch,
      registryVersion,
      activeOperationId: target.state === "running" ? target.operationId : null,
      closing: false,
      configurationBusy: false,
      operation: target,
    };
    return ok(result);
  },
  selectDirectory: async () => ok(null),
  forkRun: async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push("runs:fork");
    return toExecuted(ok({ id: NEW_RUN }), envelope.operation, registryVersion + 1);
  },
  promptFork: async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push("runs:promptFork");
    return toExecuted(ok({ id: NEW_RUN }), envelope.operation, registryVersion + 1);
  },
  proxyFork: async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push("proxy:fork");
    return toExecuted(ok({ id: NEW_RUN }), envelope.operation, registryVersion + 1);
  },
  createRun: async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push("runs:create");
    return toExecuted(ok({ id: NEW_RUN }), envelope.operation, registryVersion + 1);
  },
  modelAb: async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push("runs:modelAb");
    return toExecuted(
      ok({
        experimentId: "exp_1",
        ids: [NEW_RUN, SECOND_RUN],
        ok: true,
        plan: [],
        sideEffectsAllowed: false,
      }),
      envelope.operation,
      registryVersion + 1,
    );
  },
  modelAbPlan: async () =>
    ok({ experimentId: "exp_1", ids: [], ok: true, plan: [], sideEffectsAllowed: false }),
  forkCapability: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  inspectWorkspace: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  readWorkspaceFile: async () => ({
    ok: false as const,
    error: { code: "UNUSED", message: "默认桩" },
  }),
  settingsGet: async () => ok({ configured: true, baseURL: null, model: null, encryption: "safe" }),
  saveSettings: async () => ok(undefined),
  clearSettings: async () => ok(undefined),
  proxyStatus: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
  proxyToggle: async () =>
    ok({ enabled: false, running: false, port: 18787, upstreamBaseUrl: "", hasKey: false }),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const readCount = () => calls.filter((one) => one.startsWith("runs:get:")).length;
const listCount = () => calls.filter((one) => one === "runs:list").length;

/** 直接登记一条待定提交（与 `beginDraftSubmission` 同形状，但身份可指定期望值） */
function seedPendingSubmission(operationId: string, epoch = FAKE_EPOCH): subLib.DraftSubmission {
  const target = { runId: "u1_ok", spanId: "s_03", field: "result" } as const;
  let store = useAppStore.getState().draftSubmissions;
  const begun = subLib.beginSubmission(store, {
    channel: "result",
    target,
    submittedRevision: 1,
    submittedText: "草稿正文",
    operationId,
    epoch,
  });
  store = begun.store;
  useAppStore.setState({
    drafts: draftLib.ensureCallDraft(useAppStore.getState().drafts, target, "草稿正文").repo,
    draftSubmissions: store,
  });
  return begun.submission as subLib.DraftSubmission;
}

beforeEach(async () => {
  calls.length = 0;
  registryVersion = 1;
  statusFails = false;
  details = {};
  reconcileRecord = null;
  snapshot = () => [];
  // 上一支用例可能替换过 status 实现
  apiStub.operationsStatus = defaultOperationsStatus();
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    error: null,
    selectedRunId: null,
    detail: null,
    readingByRun: {},
  });
  // 握手一次（空闲会话），后续用例自行覆盖 `snapshot`
  await useAppStore.getState().refreshOperationStatus();
  calls.length = 0;
});

describe("1.4 三条终态入口共用同一消费落点", () => {
  it("有效 status 采纳 ⇒ 解冻该身份 + 单次列表刷新 + 按可信 ID 核实", async () => {
    const submission = seedPendingSubmission(OP);
    snapshot = () => [record()];

    await useAppStore.getState().refreshOperationStatus();

    expect(calls).toEqual(["operations:status", "runs:list", `runs:get:${NEW_RUN}`]);
    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, submission.target),
    ).toBeUndefined();
    const entry =
      useAppStore.getState().resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP, runId: NEW_RUN })
      ];
    expect(entry).toMatchObject({ phase: "verified" });
    expect(entry?.facts?.outcome.label).toBe("已结束");
    // 列表刷新整批只有一次；核实只走只读通道
    expect(listCount()).toBe(1);
    expect(calls.some((one) => one.startsWith("runs:fork"))).toBe(false);
  });

  it("reconcile 采纳 ⇒ 走同一条消费（解冻 + 刷新 + 核实），结论与 status 路径一致", async () => {
    const submission = seedPendingSubmission(OP);
    reconcileRecord = record();

    await useAppStore.getState().reconcileOperation(OP);

    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, submission.target),
    ).toBeUndefined();
    const byKey = useAppStore.getState().resultReads.byKey;
    expect(Object.keys(byKey)).toEqual([
      resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP, runId: NEW_RUN }),
    ]);
    expect(
      byKey[resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP, runId: NEW_RUN })]?.facts
        ?.normalEnd,
    ).toBe(true);
    expect(listCount()).toBe(1);
  });

  it("执行回执后的状态刷新 ⇒ 回执不自带 runIds，收尾仍由同一落点完成", async () => {
    snapshot = () => [record()];
    const submission = seedPendingSubmission(OP);

    const okFork = await useAppStore
      .getState()
      .forkAt("u1_ok", "s_03", "新值", undefined, submission);

    expect(okFork).toBe(true);
    // 回执 → 立刻取一次 status → 消费（刷新列表 + 按登记 ID 核实）
    expect(calls).toContain("operations:status");
    expect(calls).toContain(`runs:get:${NEW_RUN}`);
    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, submission.target),
    ).toBeUndefined();
    // 详情按登记里的 id 读取，而不是按信封里的 id 猜：登记的 id 才是唯一来源
    expect(calls.filter((one) => one === `runs:get:${NEW_RUN}`).length).toBeGreaterThan(0);
  });
});

describe("1.4 幂等、去重与不猜测", () => {
  it("同一终态的重复快照 ⇒ 不再读、不再刷列表、不再发通知性动作", async () => {
    snapshot = () => [record()];
    await useAppStore.getState().refreshOperationStatus();
    const before = { reads: readCount(), list: listCount() };

    await useAppStore.getState().refreshOperationStatus();
    await useAppStore.getState().refreshOperationStatus();

    expect(readCount()).toBe(before.reads);
    expect(listCount()).toBe(before.list);
  });

  it("一批两条新终态 ⇒ 列表只刷一次，两条各自按身份读取", async () => {
    snapshot = () => [
      record({ operationId: OP, runIds: [NEW_RUN] }),
      record({ operationId: OP_OTHER, runIds: [SECOND_RUN] }),
    ];

    await useAppStore.getState().refreshOperationStatus();

    expect(listCount()).toBe(1);
    expect(calls).toContain(`runs:get:${NEW_RUN}`);
    expect(calls).toContain(`runs:get:${SECOND_RUN}`);
    expect(readCount()).toBe(2);
    const keys = Object.keys(useAppStore.getState().resultReads.byKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("同一条 runId 被两条操作关联 ⇒ 各按自己的身份读一次，不共用结论", async () => {
    snapshot = () => [
      record({ operationId: OP, runIds: [NEW_RUN] }),
      record({ operationId: OP_OTHER, runIds: [NEW_RUN] }),
    ];
    await useAppStore.getState().refreshOperationStatus();
    expect(readCount()).toBe(2);
  });

  it("settled 但无可信 runId ⇒ 零读取、零列表刷新（未定位只能核对登记）", async () => {
    snapshot = () => [record({ runIds: [] })];
    await useAppStore.getState().refreshOperationStatus();
    expect(readCount()).toBe(0);
    expect(listCount()).toBe(0);
    expect(Object.keys(useAppStore.getState().resultReads.byKey)).toHaveLength(0);
  });

  it("notAccepted ⇒ 解冻该身份，但不读结果也不刷列表", async () => {
    const submission = seedPendingSubmission(OP);
    snapshot = () => [
      record({
        state: "notAccepted",
        runIds: [],
        startedAt: null,
        settledAt: null,
        requestOutcome: null,
      }),
    ];

    await useAppStore.getState().refreshOperationStatus();

    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, submission.target),
    ).toBeUndefined();
    expect(readCount()).toBe(0);
    expect(listCount()).toBe(0);
  });

  it("running 的记录 ⇒ 什么都不消费（解冻/读取/刷列表都不发生）", async () => {
    const submission = seedPendingSubmission(OP);
    snapshot = () => [
      record({
        state: "running",
        runIds: [],
        startedAt: "2026-09-27T00:00:00.000Z",
        settledAt: null,
        requestOutcome: null,
      }),
    ];
    useAppStore.setState({
      operations: { ...useAppStore.getState().operations, activeOperationId: OP },
    });

    await useAppStore.getState().refreshOperationStatus();

    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, submission.target),
    ).toBeDefined();
    expect(readCount()).toBe(0);
    expect(listCount()).toBe(0);
  });
});

describe("1.4 未知通信与新会话分开呈现", () => {
  it("status 通道失联 ⇒ 不消费任何收尾，待定关联仍冻结", async () => {
    const submission = seedPendingSubmission(OP);
    snapshot = () => [record()];
    statusFails = true;

    await useAppStore.getState().refreshOperationStatus();

    expect(useAppStore.getState().operations.unknown).toBe(true);
    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, submission.target),
    ).toBeDefined();
    expect(readCount()).toBe(0);
    expect(listCount()).toBe(0);
  });

  it("快照自相矛盾（槽指向不存在的操作）⇒ 整份按未知处理，不消费任何收尾", async () => {
    const submission = seedPendingSubmission(OP);
    snapshot = () => [record()];
    apiStub.operationsStatus = async () => {
      calls.push("operations:status");
      registryVersion += 1;
      return ok(statusSnapshot({ registryVersion, operations: [], activeOperationId: OP_OTHER }));
    };

    await useAppStore.getState().refreshOperationStatus();

    expect(useAppStore.getState().operations.unknown).toBe(true);
    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, submission.target),
    ).toBeDefined();
    expect(readCount()).toBe(0);
    expect(listCount()).toBe(0);
  });

  it("新 main 会话 ⇒ 只消费新 epoch 的记录，旧 epoch 的待定既不解冻也不读取", async () => {
    const OLD_EPOCH = "33333333-3333-3333-8333-333333333333";
    const staleSubmission = seedPendingSubmission(OP, OLD_EPOCH);
    // 旧会话的终态仍留在 renderer 的登记里
    useAppStore.setState({
      operations: {
        ...useAppStore.getState().operations,
        operations: [record({ epoch: OLD_EPOCH, runIds: [NEW_RUN] })],
      },
    });
    calls.length = 0;
    // 新 epoch 的快照：一条属于新会话的终态
    // 刻意不同于 FAKE_EPOCH：新会话的 epoch 必须真的换了
    const newEpoch = "99999999-9999-9999-8999-999999999999";
    snapshot = () => [record({ epoch: newEpoch, operationId: OP_OTHER, runIds: [SECOND_RUN] })];
    apiStub.operationsStatus = async () => {
      calls.push("operations:status");
      registryVersion += 1;
      return ok({
        epoch: newEpoch,
        registryVersion,
        activeOperationId: null,
        closing: false,
        configurationBusy: false,
        operations: snapshot(),
      });
    };

    await useAppStore.getState().refreshOperationStatus();

    // 只读新会话那条的 id；旧会话的 NEW_RUN 一次都不读
    expect(calls).not.toContain(`runs:get:${NEW_RUN}`);
    expect(calls).toContain(`runs:get:${SECOND_RUN}`);
    // 旧 epoch 的待定关联不因新会话的记录被解冻（身份含 epoch）
    expect(
      subLib.submissionOf(useAppStore.getState().draftSubmissions, staleSubmission.target),
    ).toBeDefined();
  });

  it("同 main 重载后的首轮快照 ⇒ 既有终态按恢复语义读取一次（不推测草稿）", async () => {
    snapshot = () => [record()];
    // 模拟重载：会话与提交关联都清空，登记仍在 main
    useAppStore.setState({
      operations: initialSession(),
      draftSubmissions: subLib.emptySubmissionStore(),
      resultReads: emptyResultReadStore(),
    });
    calls.length = 0;

    await useAppStore.getState().refreshOperationStatus();

    expect(calls).toContain(`runs:get:${NEW_RUN}`);
    const entry =
      useAppStore.getState().resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: OP, runId: NEW_RUN })
      ];
    expect(entry?.phase).toBe("verified");
  });
});
