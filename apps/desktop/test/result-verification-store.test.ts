import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import {
  emptyResultReadStore,
  resultReadKeyOf,
  viewOperationResult,
} from "../src/renderer/src/lib/result-verification";
import type { Deferred } from "./helpers/deterministic-schedule";
import { deferred } from "./helpers/deterministic-schedule";
import { FAKE_EPOCH, statusSnapshot } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 1.2 的 **store 接线半边**：
 * 核实动作与导航动作真的分开了（不是只有纯函数能用）。
 *
 * 判据来源：desktop-ui delta「结果按可信运行身份核实且读取重试不执行」两个场景：
 *   - 「失败信封仍可打开可信记录」——按 main 登记的 runId 读取，不扫描列表最新项顶替
 *   - 「列表失败不阻断已知结果」——核实不依赖列表能否刷新，也不改写列表的加载态
 * tasks 1.2 明令：直接调用核实动作，断言**成功/失败/重试均不改变**当前运行/页签/调用、
 * 滚动或焦点。
 *
 * ⚠️ 判据形状：把"除 `resultReads` 之外的全部状态"整份快照做等值比较——
 * 只断言其中一两样（如 selectedRunId）时，`selectRun` 顺带改掉的页签/滚动/全局 error
 * 都能悄悄溜过去。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const read = (name: string): RunRecord => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));

function detailFor(record: RunRecord, id: string): RunDetail {
  const meta = record.meta.id === id ? record.meta : { ...record.meta, id };
  return {
    meta,
    spans: record.spans,
    events: record.events,
    status: record.status,
    chain: [{ meta, fork: record.meta.fork }],
    leafSpanIds: record.spans.map((span) => span.id),
  };
}

/** 用户此刻正在读的运行（核实目标刻意与它不同） */
const VIEWING_ID = "run_viewing";
/** main 登记的可信新运行 id：列表里**没有**这一条（刷新还失败了） */
const TRUSTED_ID = "run_trusted_new";

const calls: string[] = [];
let getRunEnvelope: Envelope<RunDetail> = ok(detailFor(read("u1-ok"), TRUSTED_ID));
/**
 * 在途闸门（任务 1.3 的时序判据）：非空时按调用序取用一条 deferred，
 * 由用例自己决定"哪一次响应先落地"——用来钉住旧代次的迟到响应。
 */
let getRunGates: Array<Deferred<Envelope<RunDetail>>> = [];

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    return { ok: false, error: { code: "LIST_FAILED", message: "列表读取失败（桩）" } };
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    const gate = getRunGates.shift();
    if (gate !== undefined) return gate.promise;
    return getRunEnvelope;
  },
  operationsStatus: async () => ok(statusSnapshot({ operations: [settledRecord()] })),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
  }),
  selectDirectory: async () => ok(null),
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
  modelAbPlan: async () =>
    ok({ experimentId: "exp", ids: [], ok: true, plan: [], sideEffectsAllowed: false }),
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

/** 已登记的可信终态：执行信封失败（业务拒绝）不影响"这条 run 已经产生"这一事实 */
function settledRecord(): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: "55555555-5555-5555-8555-555555555555",
    target: { kind: "create", mode: "plain" },
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [TRUSTED_ID],
    experimentId: null,
    arms: [],
    requestOutcome: "rejected",
    errorCode: "CREATE_RUN_FAILED",
    diagnostics: [],
  };
}

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

/** 除 `resultReads` 外的全部状态快照（函数与在途计时器不参与渲染状态，按类型滤掉） */
function stateWithoutResultReads() {
  const { resultReads: _ignored, ...rest } = useAppStore.getState();
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value !== "function") data[key] = value;
  }
  return data;
}

/** 把界面摆在"用户正在读某条 run 的步骤页、选中某次调用、滚到中段"的位置上 */
async function placeUserReading(): Promise<void> {
  await useAppStore.getState().refreshOperationStatus();
  useAppStore.setState({
    selectedRunId: VIEWING_ID,
    selectedSpanId: "s_02",
    detail: detailFor(read("u1-ok"), VIEWING_ID),
    view: "trace",
    loadingList: false,
    listLoaded: true,
    listStale: true,
    error: "刷新 run 列表失败（仍显示上次结果）：列表读取失败（桩）",
    compareIds: [VIEWING_ID],
    readingInvalidated: false,
  });
  useAppStore.getState().setReadingTab(VIEWING_ID, "steps");
  useAppStore.getState().setReadingScroll(VIEWING_ID, "overview", 320);
  useAppStore.getState().openFileAt(VIEWING_ID, { stepSpanId: "s_01", path: "README.md" });
}

const identity = { epoch: FAKE_EPOCH, operationId: settledRecord().operationId, runId: TRUSTED_ID };

beforeEach(async () => {
  calls.length = 0;
  getRunGates = [];
  getRunEnvelope = ok(detailFor(read("u1-ok"), TRUSTED_ID));
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    readingByRun: {},
    pendingFileTarget: null,
    pendingDraftTarget: null,
    createDialogOpen: false,
    initialSelectionAttempted: false,
  });
  await placeUserReading();
});

describe("verifyRunResult：核实不改变用户正在读的东西", () => {
  it("成功核实 ⇒ 只多出读取项；运行/页签/调用/滚动/全局错误逐字不动", async () => {
    const before = stateWithoutResultReads();
    const entry = await useAppStore.getState().verifyRunResult(identity);

    expect(entry).toMatchObject({ phase: "verified", reason: null });
    expect(entry.facts?.outcome.label).toBe("已结束");
    expect(stateWithoutResultReads()).toEqual(before);
    // 读了该读的那一条，没顺手动列表
    expect(calls).toEqual([`runs:get:${TRUSTED_ID}`]);
  });

  it("读取失败 ⇒ 不可读只落在本条读取项，全局 error 与列表 stale 都不被改写", async () => {
    getRunEnvelope = { ok: false, error: { code: "RUN_NOT_FOUND", message: "记录尚不存在" } };
    const before = stateWithoutResultReads();
    const entry = await useAppStore.getState().verifyRunResult(identity);

    expect(entry.phase).toBe("unreadable");
    expect(entry.reason).toContain("RUN_NOT_FOUND");
    expect(stateWithoutResultReads()).toEqual(before);
    expect(useAppStore.getState().error).toContain("仍显示上次结果");
    expect(useAppStore.getState().listStale).toBe(true);
  });

  it("同一身份的重复核实去重：只读一次详情；显式只读重试才发第二次读取", async () => {
    const before = stateWithoutResultReads();
    await useAppStore.getState().verifyRunResult(identity);
    await useAppStore.getState().verifyRunResult(identity);
    expect(calls).toEqual([`runs:get:${TRUSTED_ID}`]);

    const retried = await useAppStore.getState().retryResultRead(identity);
    expect(calls).toEqual([`runs:get:${TRUSTED_ID}`, `runs:get:${TRUSTED_ID}`]);
    expect(retried).toMatchObject({ phase: "verified", attempt: 2 });
    expect(
      calls.some(
        (one) => one.startsWith("runs:fork") || one === "runs:create" || one === "runs:list",
      ),
    ).toBe(false);
    expect(stateWithoutResultReads()).toEqual(before);
  });

  it("结果不可读 ⇒ 只按同一条可信 runId 重试读取，恢复后即为已核实（零执行调用）", async () => {
    getRunEnvelope = { ok: false, error: { code: "RUN_NOT_FOUND", message: "记录尚未归位" } };
    const first = await useAppStore.getState().verifyRunResult(identity);
    expect(first).toMatchObject({ phase: "unreadable", attempt: 1 });

    // 文件归位后重试：仍是同一条 runId，且整条路径只有 runs:get
    getRunEnvelope = ok(detailFor(read("u1-ok"), TRUSTED_ID));
    const retried = await useAppStore.getState().retryResultRead(identity);
    expect(retried).toMatchObject({ phase: "verified", attempt: 2 });
    expect(retried.facts?.normalEnd).toBe(true);
    expect(calls).toEqual([`runs:get:${TRUSTED_ID}`, `runs:get:${TRUSTED_ID}`]);
  });

  it("旧读取响应迟到 ⇒ 只认当代代次：不覆盖新结论，也不碰其他身份与其他状态", async () => {
    const otherIdentity = { ...identity, operationId: "66666666-6666-6666-8666-666666666666" };
    // 另一条身份先核实到"已结束"，本次竞争里它必须原样在场
    await useAppStore.getState().verifyRunResult(otherIdentity);

    const staleGate = deferred<Envelope<RunDetail>>();
    const currentGate = deferred<Envelope<RunDetail>>();
    getRunGates = [staleGate, currentGate];
    const first = useAppStore.getState().verifyRunResult(identity); // attempt 1（在途）
    await Promise.resolve();
    const second = useAppStore.getState().retryResultRead(identity); // attempt 2（在途）
    await Promise.resolve();

    // attempt 2 先回：读到的是一条出错终止的记录
    currentGate.resolve(ok(detailFor(read("u1-error-detail"), TRUSTED_ID)));
    const secondEntry = await second;
    expect(secondEntry).toMatchObject({ phase: "verified", attempt: 2 });
    expect(secondEntry.facts?.outcome.kind).toBe("error");

    // attempt 1 的响应后到（内容刻意不同）⇒ 整份丢弃
    staleGate.resolve(ok(detailFor(read("u1-ok"), TRUSTED_ID)));
    const firstEntry = await first;
    expect(firstEntry).toMatchObject({ attempt: 2 }); // 交回的是在场的结论，不是废结论
    expect(useAppStore.getState().resultReads.byKey[resultReadKeyOf(identity)]).toMatchObject({
      attempt: 2,
      facts: { outcome: { kind: "error" } },
    });
    // 其他身份与其他状态一概不动
    expect(useAppStore.getState().resultReads.byKey[resultReadKeyOf(otherIdentity)]).toMatchObject({
      attempt: 1,
      facts: { outcome: { kind: "completed" } },
    });
  });
});

describe("settled 无身份与 notAccepted：不产出任何猜测的结果", () => {
  it("登记里没有可信 runId ⇒ 呈现为未定位，读取项里一条结论都没有", () => {
    const record = { ...settledRecord(), runIds: [] };
    const view = viewOperationResult(record, useAppStore.getState().resultReads);
    expect(view).toEqual({ kind: "unlocated" });
    expect(Object.keys(useAppStore.getState().resultReads.byKey)).toHaveLength(0);
    // 未定位不产生任何读取：详情通道一次都没被调用
    expect(calls.filter((one) => one.startsWith("runs:get"))).toHaveLength(0);
  });

  it("notAccepted ⇒ 本次未接受（带稳定拒绝原因），没有核实成功的路径", () => {
    const record: OperationRecord = {
      ...settledRecord(),
      state: "notAccepted",
      rejection: "busy",
      startedAt: null,
      settledAt: null,
      requestOutcome: null,
      errorCode: null,
      runIds: [],
    };
    const view = viewOperationResult(record, useAppStore.getState().resultReads);
    expect(view).toEqual({ kind: "not-accepted", rejection: "busy" });
    expect(calls.filter((one) => one.startsWith("runs:get"))).toHaveLength(0);
  });
});

describe("失败信封仍可打开可信记录 / 列表失败不阻断已知结果", () => {
  it("核实目标取自登记的 runIds，而不是列表项或当前选中项", async () => {
    // 列表里根本没有这条 run（且列表刷新是失败的）——只有登记能给这个 id
    const session = useAppStore.getState().operations;
    const record = session.operations.find((one) => one.operationId === identity.operationId);
    expect(record?.state).toBe("settled");
    expect(record?.requestOutcome).toBe("rejected");
    expect(useAppStore.getState().runs).toHaveLength(0);

    const entry = await useAppStore.getState().verifyRunResult({
      epoch: session.epoch as string,
      operationId: identity.operationId,
      runId: (record?.runIds ?? [])[0] as string,
    });

    expect(entry.phase).toBe("verified");
    expect(calls).toEqual([`runs:get:${TRUSTED_ID}`]);
    // 不扫描列表顶替：列表通道一次都没被调用
    expect(calls.some((one) => one === "runs:list")).toBe(false);
    expect(useAppStore.getState().selectedRunId).toBe(VIEWING_ID);
  });

  it("登记里的结局事实与执行错误码分开在场：rejected 不抹掉真实终止事件", async () => {
    getRunEnvelope = ok(detailFor(read("u1-error-detail"), TRUSTED_ID));
    const entry = await useAppStore.getState().verifyRunResult(identity);

    // 详情可读 ⇒ 自有终止事实照实呈现；请求层的 CREATE_RUN_FAILED 仍在登记里，互不覆盖
    expect(entry.facts).toMatchObject({
      normalEnd: false,
      outcome: { kind: "error", label: "出错终止" },
    });
    expect(entry.facts?.failure.llmCallSpanId).toBe("s_05");
    const record = useAppStore
      .getState()
      .operations.operations.find((one) => one.operationId === identity.operationId);
    expect(record?.errorCode).toBe("CREATE_RUN_FAILED");
    expect(record?.requestOutcome).toBe("rejected");
  });
});
