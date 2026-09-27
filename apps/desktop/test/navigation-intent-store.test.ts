import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import type { DraftSubmission } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { emptyNavigationIntents } from "../src/renderer/src/lib/navigation-intent";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { deriveRunSummary } from "../src/shared/derive";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 3.4 的 **store 接线**：导航意图 → 实际切换。
 *
 * 判据来源：design D4「核实与导航是两个动作」+ D6 + delta「结果导航尊重用户当前阅读意图」。
 * 验收场景（delta 逐字标题）：
 * - 「留在当前流程可进入成功或失败概览」
 * - 「离开再返回不恢复旧自动导航」
 * - 「读取途中离页仍不抢焦点」
 * 另有三条"只通知不跳"的路：显式核对（reconcile）、手动只读重试、A/B 批次，
 * 以及一次性（重复快照不重复跳）与"覆盖模态在场不跳到它背后"。
 *
 * ⚠️ 与 `fork-entry-closure.test.ts` 的分工：那份钉"入口不消费响应"，本份钉
 * "协调器按意图决定跳不跳"。两条路共用同一个落点，所以本份的断言全部直接调 store 动作。
 */

const PARENT = "u1_nav_parent";
const SPAN = "s_03";
const REGISTERED = "run_nav_registered";
/** 信封里的 id：任何情形都不该成为导航目标 */
const ENVELOPE_RUN = "run_nav_envelope";
/** 用户中途切去的那条 run */
const ELSEWHERE = "run_nav_elsewhere";
const KEY: CallDraftKey = { runId: PARENT, spanId: SPAN, field: "result" };

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const recordOf = (name: string): RunRecord => readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));

function detailOf(name: string, id: string): RunDetail {
  const record = recordOf(name);
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

/** 单运行 result 操作的登记（留在流程内 ⇒ 唯一可自动导航的形状） */
function navRecord(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: "77777777-7777-4777-8777-777777777777",
    target: {
      kind: "result",
      mode: "plain",
      parentRunId: PARENT,
      atSpanId: SPAN,
      editField: "result",
    },
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [REGISTERED],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const calls: string[] = [];
let snapshot: () => OperationRecord[] = () => [];
let registryVersion = 1;
let details: Record<string, Envelope<RunDetail>> = {};
/** 详情读取的门：挂起指定 id 的读取，制造"结果还在读"的窗口 */
let gate: { id: string; promise: Promise<void>; release: () => void } | null = null;
/** 回执状态：running = 响应先到、终态后由轮询到达（要能插入用户动作） */
let ackState: "running" | "settled" = "settled";

async function detailEnvelope(id: string): Promise<Envelope<RunDetail>> {
  calls.push(`runs:get:${id}`);
  if (gate !== null && gate.id === id) await gate.promise;
  return details[id] ?? ok(detailOf("u1-ok", id));
}

const apiStub: Record<string, unknown> = {
  operationsStatus: async () => {
    calls.push("operations:status");
    registryVersion += 1;
    return ok(statusSnapshot({ registryVersion, operations: snapshot(), activeOperationId: null }));
  },
  operationsReconcile: async (request: { operationId: string }) => {
    calls.push(`operations:reconcile:${request.operationId}`);
    const target = snapshot().find((one) => one.operationId === request.operationId);
    if (target === undefined) {
      return { ok: false as const, error: { code: "BAD_ID", message: "查不到该操作" } };
    }
    registryVersion += 1;
    return ok({
      epoch: target.epoch,
      registryVersion,
      activeOperationId: null,
      closing: false,
      configurationBusy: false,
      operation: target,
    });
  },
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    return ok({
      runs: [
        { ...deriveRunSummary(recordOf("u1-ok")), id: REGISTERED },
        { ...deriveRunSummary(recordOf("u1-ok")), id: ELSEWHERE },
      ],
      failed: [],
    });
  },
  getRun: detailEnvelope,
  forkRun: async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push("runs:fork");
    const executed = toExecuted(ok({ id: ENVELOPE_RUN }), envelope.operation, registryVersion + 1);
    return { ...executed, operation: { ...executed.operation, state: ackState } };
  },
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const readCalls = () => calls.filter((one) => one.startsWith("runs:get:"));
const intentOf = (operationId: string) =>
  useAppStore.getState().navIntents.byOperationId[operationId];

/** 与编辑器同形：先看父本 → 登记草稿与提交关联（意图在此刻登记） */
function seedSubmission(userValue = "编辑后的结果"): DraftSubmission {
  const store = useAppStore.getState();
  useAppStore.setState({
    selectedRunId: PARENT,
    detail: detailOf("u1-ok", PARENT),
    readingByRun: {},
    selectedSpanId: null,
  });
  store.ensureCallDraft(KEY, "父 run 录下的原值");
  store.writeCallDraftText(KEY, userValue);
  const assoc = store.beginDraftSubmission({ channel: "result", target: KEY });
  if (assoc === null) throw new Error("提交关联登记失败");
  return assoc;
}

/** 让该 operationId 成为"本会话已登记的终态" */
function armSnapshot(assoc: DraftSubmission, overrides: Partial<OperationRecord> = {}): void {
  snapshot = () => [navRecord({ operationId: assoc.operationId, ...overrides })];
}

beforeEach(async () => {
  calls.length = 0;
  registryVersion = 1;
  details = {};
  gate = null;
  ackState = "settled";
  snapshot = () => [];
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    navIntents: emptyNavigationIntents(),
    navGeneration: 0,
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    listRefreshInFlight: 0,
    listRefreshPending: 0,
    error: null,
    selectedRunId: null,
    selectedSpanId: null,
    detail: null,
    readingByRun: {},
    view: "trace",
    forking: "idle",
    forkError: null,
    forkErrorCode: null,
    createReturnLocation: null,
    settingsSection: null,
  });
  await useAppStore.getState().refreshOperationStatus();
  calls.length = 0;
});

describe("3.4 留在本次流程：结果可读即进入其概览", () => {
  it("成功结局 ⇒ 协调器跳到登记的那条；意图一次性释放", async () => {
    const assoc = seedSubmission();
    armSnapshot(assoc);

    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(REGISTERED);
    expect(state.detail?.meta.id).toBe(REGISTERED);
    // 页签回到该 run 自己的默认（概览）：导航只是"打开那条记录"，不擅自选调用、不改滚动
    expect(state.readingOf(REGISTERED).tab).toBe("overview");
    expect(state.readingOf(REGISTERED).overviewScrollTop).toBe(0);
    // 意图已消费：重复快照不会再跳第二次（下面那支用例正面对着断言）
    expect(intentOf(assoc.operationId)).toBeUndefined();
    // 跳转指向的是登记 id，信封 id 一次都不读
    expect(new Set(readCalls())).toEqual(new Set([`runs:get:${REGISTERED}`]));
  });

  it("「留在当前流程可进入成功或失败概览」：失败结局同样进入，且不以打开冒充成功", async () => {
    details[REGISTERED] = ok(detailOf("u1-error-detail", REGISTERED));
    const assoc = seedSubmission();
    armSnapshot(assoc);

    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(REGISTERED);
    const entry =
      state.resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId: REGISTERED })
      ];
    expect(entry?.facts?.normalEnd).toBe(false);
    expect(entry?.facts?.outcome.label).not.toBe("已结束");
    // 失败不清草稿（3.1/3.2 的判据不因导航改变）
    expect(state.drafts.calls[PARENT]?.[SPAN]?.result?.text).toBe("编辑后的结果");
  });

  it("重复快照 ⇒ 只跳一次：第二次消费既不读详情也不改选择", async () => {
    const assoc = seedSubmission();
    armSnapshot(assoc);
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    const before = {
      reads: readCalls().length,
      list: calls.filter((c) => c === "runs:list").length,
    };
    useAppStore.setState({ selectedRunId: ELSEWHERE });

    await useAppStore.getState().refreshOperationStatus();
    await useAppStore.getState().refreshOperationStatus();

    expect(readCalls()).toHaveLength(before.reads);
    expect(calls.filter((c) => c === "runs:list")).toHaveLength(before.list);
    expect(useAppStore.getState().selectedRunId).toBe(ELSEWHERE);
  });

  it("有覆盖模态在场 ⇒ 不跳到它背后（设置模态开着时结果到达也不动页面）", async () => {
    const assoc = seedSubmission();
    armSnapshot(assoc);
    // U5 任务 4.1：创建工作区已是页面，不再是覆盖模态 ⇒ 覆盖模态这一支改由设置承担。
    // 用 setState 而不是 setSettingsSection：后者会推进阅读代次，那是"离开流程"的撤销判据，
    // 会把本用例想钉的"这一刻不跳、意图留着"变成"永久作废"。
    useAppStore.setState({ settingsSection: "proxy" });

    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);

    const state = useAppStore.getState();
    expect(state.selectedRunId).not.toBe(REGISTERED);
    // 模态在场只是"这一刻不跳"，意图留着（与"离开过流程"的永久作废区分开）
    expect(intentOf(assoc.operationId)).toBeDefined();
  });
});

describe("3.4 撤销：离开过就不回来", () => {
  it("「离开再返回不恢复旧自动导航」：切走再切回原 run ⇒ 结果到达也不跳", async () => {
    ackState = "running";
    const assoc = seedSubmission();
    // 提交时 main 还在跑：终态稍后由轮询到达，中间用户可以动
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    armSnapshot(assoc);

    await useAppStore.getState().selectRun(ELSEWHERE); // 主动离页
    await useAppStore.getState().selectRun(PARENT); // 又回到提交时那条 run
    useAppStore.getState().stopOperationStatusPolling();

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(PARENT);
    expect(state.detail?.meta.id).toBe(PARENT);
    // 作废而不是留着等下一次：这条意图永久失效
    expect(intentOf(assoc.operationId)).toBeUndefined();
    // 但结果本身照样读到、照样可核对（导航与核实是两件事）
    expect(readCalls()).toContain(`runs:get:${REGISTERED}`);
  });

  it("提交后走进创建工作区 ⇒ 结果到达不跳，也不把创建页顶掉（U5 4.1）", async () => {
    ackState = "running";
    const assoc = seedSubmission();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    armSnapshot(assoc);
    useAppStore.getState().stopOperationStatusPolling();

    // 用户离开本次流程去做别的：走进创建工作区（它现在是页面，不是"盖住的模态"）
    useAppStore.getState().openCreateWorkspace();
    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(state.view).toBe("create");
    expect(state.selectedRunId).toBe(PARENT);
    // 资格永久作废（不是"这一刻不跳"）：创建页不会替用户认领这次结果
    expect(intentOf(assoc.operationId)).toBeUndefined();
    // 结果本身照样核实到（导航与核实是两件事）
    expect(readCalls()).toContain(`runs:get:${REGISTERED}`);
  });

  it("换页签 / 选调用 / 进设置同样撤销：只推进代次，不改判结局", async () => {
    ackState = "running";
    const assoc = seedSubmission();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    armSnapshot(assoc);
    useAppStore.getState().stopOperationStatusPolling();

    useAppStore.getState().setReadingTab(PARENT, "steps");
    await useAppStore.getState().refreshOperationStatus();

    expect(useAppStore.getState().selectedRunId).toBe(PARENT);
    expect(intentOf(assoc.operationId)).toBeUndefined();
  });

  it("「读取途中离页仍不抢焦点」：详情在飞时用户切走 ⇒ 落地后不覆盖他的页面", async () => {
    ackState = "running";
    const assoc = seedSubmission();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    armSnapshot(assoc);
    useAppStore.getState().stopOperationStatusPolling();

    // 结果读取挂起：这期间用户切到别的 run（读取开始时他是"留在流程内"的）
    let release!: () => void;
    gate = {
      id: REGISTERED,
      promise: new Promise<void>((done) => {
        release = done;
      }),
      release: () => {},
    };
    gate.release = release;
    const pending = useAppStore.getState().refreshOperationStatus();
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));

    await useAppStore.getState().selectRun(ELSEWHERE);
    gate = null;
    release();
    await pending;

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(ELSEWHERE);
    expect(state.detail?.meta.id).toBe(ELSEWHERE);
    // 结局仍按身份核实到（只是不跳）
    expect(
      state.resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId: REGISTERED })
      ]?.phase,
    ).toBe("verified");
  });
});

describe("3.4 只通知不跳的三条路", () => {
  it("「核对结果只由用户明确打开」：reconcile 到达的终态不导航", async () => {
    const assoc = seedSubmission();
    armSnapshot(assoc);

    await useAppStore.getState().reconcileOperation(assoc.operationId);

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(PARENT);
    expect(intentOf(assoc.operationId)).toBeUndefined();
    expect(readCalls()).toContain(`runs:get:${REGISTERED}`);
  });

  it("手动只读重试读到正常终止 ⇒ 仍不跳（重试不是导航也不是重发）", async () => {
    details[REGISTERED] = {
      ok: false,
      error: { code: "RUN_READ_FAILED", message: "该 run 的源文件读取失败" },
    };
    const assoc = seedSubmission();
    armSnapshot(assoc);
    // 第一轮：不可读 ⇒ 作废资格，不跳
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    expect(useAppStore.getState().selectedRunId).toBe(PARENT);

    // 第二轮：用户显式只读重试，结果变得可读
    details = {};
    await useAppStore
      .getState()
      .retryResultRead({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId: REGISTERED });

    const state = useAppStore.getState();
    expect(
      state.resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId: REGISTERED })
      ]?.facts?.normalEnd,
    ).toBe(true);
    expect(state.selectedRunId).toBe(PARENT);
    expect(state.detail?.meta.id).toBe(PARENT);
  });

  it("A/B 只识别出一条臂 ⇒ 批次规则优先：不因「看起来是单运行」就自动聚焦", async () => {
    useAppStore.getState().ensureModelAbDraft({ runId: PARENT, spanId: SPAN }, [
      { model: "model-a", paramsText: "" },
      { model: "model-b", paramsText: "" },
    ]);
    const abAssoc = useAppStore.getState().beginDraftSubmission({
      channel: "model_ab",
      target: { runId: PARENT, spanId: SPAN },
    });
    if (abAssoc === null) throw new Error("A/B 关联登记失败");
    useAppStore.setState({ selectedRunId: PARENT, detail: detailOf("u1-ok", PARENT) });
    // 一条臂没拿到 id（runIds 只有一条）：单运行条件字面上成立，拦住它的只能是批次判据
    snapshot = () => [
      navRecord({
        operationId: abAssoc.operationId,
        target: { kind: "modelAb", parentRunId: PARENT, armCount: 2 },
        runIds: [REGISTERED],
        experimentId: "exp_nav",
        arms: [
          { index: 0, id: REGISTERED, outcome: "returned" },
          { index: 1, id: null, outcome: null },
        ],
      }),
    ];

    await useAppStore.getState().refreshOperationStatus();

    expect(useAppStore.getState().selectedRunId).toBe(PARENT);
    expect(readCalls()).toContain(`runs:get:${REGISTERED}`);
  });

  it("多运行但不是批次 ⇒ 也不跳：单运行是自动导航的硬条件", async () => {
    const assoc = seedSubmission();
    armSnapshot(assoc, { runIds: [REGISTERED, ELSEWHERE] });

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(PARENT);
    // 两条都各自按身份核实（读取与导航仍是两件事）
    expect(readCalls()).toEqual([`runs:get:${REGISTERED}`, `runs:get:${ELSEWHERE}`]);
  });
});

describe("3.4 接线契约：导航只有一个调用点", () => {
  const STORE_SRC = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/store.ts"),
    "utf8",
  );

  it("只有终态消费调协调器；reconcile 走「只通知」那条 trigger", () => {
    const attempts = STORE_SRC.match(/attemptResultNavigation\(/g) ?? [];
    // 定义一次 + 终态消费里一次
    expect(attempts.length).toBe(2);
    const consume = STORE_SRC.slice(
      STORE_SRC.indexOf("async function consumeSettledOperations"),
      STORE_SRC.indexOf("function closeRemainingClosures"),
    );
    expect(consume).toContain("attemptResultNavigation(record, trigger)");
    const at = STORE_SRC.indexOf("async reconcileOperation(operationId) {");
    const reconcile = STORE_SRC.slice(at, STORE_SRC.indexOf("async verifyRunResult", at));
    expect(reconcile).toContain('consumeSettledOperations(previous, "reconcile")');
    // status 那条路才允许自动导航
    const statusAt = STORE_SRC.indexOf("async refreshOperationStatus() {");
    const status = STORE_SRC.slice(
      statusAt,
      STORE_SRC.indexOf("async ensureOperationStatusPolling"),
    );
    expect(status).toContain('consumeSettledOperations(previous, "status")');
  });

  it("组件侧不得自己判导航意图（判据只有一份）", () => {
    const offenders: string[] = [];
    for (const name of [
      "components/DetailPanel.tsx",
      "components/CreateRunWorkspace.tsx",
      "components/RunList.tsx",
      "App.tsx",
    ]) {
      const src = readFileSync(resolve(import.meta.dirname, "../src/renderer/src", name), "utf8");
      if (/decideResultNavigation|navGeneration|armNavigationIntent/.test(src))
        offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
