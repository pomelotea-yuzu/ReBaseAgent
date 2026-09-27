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
import { deriveResultNotices, noticeKeyOf } from "../src/renderer/src/lib/result-notices";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 3.5 / 3.6 的 **store 接线**。
 *
 * 判据来源：design D6 末段 + delta「失败定位和返回草稿明确可达」「核对结果只由用户明确打开」
 * 「恢复核对重试与批次结果只通知」。呈现与动作可用性的判据在
 * `lib/operation-result-view.ts` / `lib/result-notices.ts`（纯函数，已单测），
 * 本文件钉的是"点了真的发生、不点就什么都不动"这一半。
 *
 * 每支都在开头断言一次**自动导航没抢先**：3.4 的规则是"留在流程内才跳"，
 * 这里把创建对话框留着（覆盖模态在场 ⇒ `wait`），于是页面动没动只可能由本文件的显式动作造成。
 */

const PARENT = "u1_act_parent";
const SPAN = "s_03";
const REGISTERED = "run_act_registered";
const ENVELOPE_RUN = "run_act_envelope";
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

function actRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: "66666666-6666-4666-8666-666666666666",
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
    return ok({ runs: [], failed: [] });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    return details[id] ?? ok(detailOf("u1-ok", id));
  },
  forkRun: async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push("runs:fork");
    return toExecuted(ok({ id: ENVELOPE_RUN }), envelope.operation, registryVersion + 1);
  },
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const identityOf = (assoc: DraftSubmission, runId = REGISTERED) => ({
  epoch: FAKE_EPOCH,
  operationId: assoc.operationId,
  runId,
});
const entryOf = (assoc: DraftSubmission, runId = REGISTERED) =>
  useAppStore.getState().resultReads.byKey[resultReadKeyOf(identityOf(assoc, runId))];
const noticeCount = () => {
  // 与组件同一条派生路（测试不另算一套）：records 就是会话镜像里的登记
  const state = useAppStore.getState();
  return deriveResultNotices({
    records: state.operations.operations,
    reads: state.resultReads,
    seenKeys: state.seenNoticeKeys,
  }).unreadCount;
};

/** 与编辑器同形：登记草稿 + 提交关联，并把该身份的终态接进 status 桩 */
function seed(overrides: Partial<OperationRecord> = {}): DraftSubmission {
  const store = useAppStore.getState();
  useAppStore.setState({ selectedRunId: PARENT, detail: detailOf("u1-ok", PARENT) });
  store.ensureCallDraft(KEY, "父 run 录下的原值");
  store.writeCallDraftText(KEY, "编辑后的结果");
  const assoc = store.beginDraftSubmission({ channel: "result", target: KEY });
  if (assoc === null) throw new Error("提交关联登记失败");
  snapshot = () => [actRecord({ operationId: assoc.operationId, ...overrides })];
  return assoc;
}

/** 断言"自动导航没抢在显式动作之前"（覆盖模态在场 ⇒ 3.4 判 wait） */
function expectNoAutoNavigation(): void {
  const state = useAppStore.getState();
  expect(state.createDialogOpen).toBe(true);
  expect(state.selectedRunId).toBe(PARENT);
}

beforeEach(async () => {
  calls.length = 0;
  registryVersion = 1;
  details = {};
  snapshot = () => [];
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    navIntents: emptyNavigationIntents(),
    navGeneration: 0,
    seenNoticeKeys: {},
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
    pendingDraftTarget: null,
    forking: "idle",
    forkError: null,
    forkErrorCode: null,
    // 覆盖模态在场：本文件的每一次跳转都必须是显式动作造成的
    createDialogOpen: true,
    settingsSection: null,
  });
  await useAppStore.getState().refreshOperationStatus();
  calls.length = 0;
});

describe("3.5 明确打开：不受导航意图约束，也不碰别的身份", () => {
  it("「打开结果」真的切到那条运行，并把这条通知标成已看", async () => {
    const assoc = seed();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    expectNoAutoNavigation();
    expect(entryOf(assoc)?.phase).toBe("verified");
    expect(noticeCount()).toBe(1);

    await useAppStore.getState().openOperationResult(identityOf(assoc));

    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(REGISTERED);
    expect(state.detail?.meta.id).toBe(REGISTERED);
    expect(noticeCount()).toBe(0);
    // 明确动作也不发起执行、不重跑别的操作
    expect(calls.filter((one) => one === "runs:fork")).toHaveLength(1);
  });

  it("「失败定位和返回草稿明确可达」：只跳真实自有失败调用，并落到步骤页签", async () => {
    details[REGISTERED] = ok(detailOf("u1-error-detail", REGISTERED));
    const assoc = seed();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    expectNoAutoNavigation();
    const failureSpanId = entryOf(assoc)?.facts?.failure.llmCallSpanId ?? null;
    expect(failureSpanId).not.toBeNull();

    const located = await useAppStore.getState().openOperationFailure(identityOf(assoc));

    expect(located).toBe(true);
    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(REGISTERED);
    expect(state.selectedSpanId).toBe(failureSpanId);
    expect(state.readingOf(REGISTERED).tab).toBe("steps");
    expect(state.forking).toBe("idle");
  });

  it("拿不到自有失败调用 ⇒ 返回 false 且一点也不动页面（不跳祖先、不跳最后一个）", async () => {
    const assoc = seed();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    expectNoAutoNavigation();
    // u1-ok：正常结束，自有失败调用不存在
    expect(entryOf(assoc)?.facts?.failure.llmCallSpanId).toBeNull();

    const located = await useAppStore.getState().openOperationFailure(identityOf(assoc));

    expect(located).toBe(false);
    const state = useAppStore.getState();
    expect(state.selectedRunId).toBe(PARENT);
    expect(state.selectedSpanId).toBeNull();
    expect(state.detail?.meta.id).toBe(PARENT);
    // 也没顺手读别的记录
    expect(calls.filter((one) => one.startsWith("runs:get:"))).toEqual([`runs:get:${REGISTERED}`]);
  });

  it("「核对结果只由用户明确打开」：reconcile 与只读重试都不切页面，明确打开才切", async () => {
    const assoc = seed();
    // 核对到达终态：补事实 + 按身份核实，但**不**跳转（3.4 的 trigger 判据）
    await useAppStore.getState().reconcileOperation(assoc.operationId);
    expect(entryOf(assoc)?.phase).toBe("verified");
    expect(useAppStore.getState().selectedRunId).toBe(PARENT);
    // 只读重试同样只更新这一条读取项（绕过"已核实"的去重，但绝不重发执行）
    await useAppStore.getState().retryResultRead(identityOf(assoc));
    expect(useAppStore.getState().selectedRunId).toBe(PARENT);
    expect(calls.filter((one) => one === "runs:fork")).toHaveLength(0);
    expect(calls.filter((one) => one.startsWith("runs:get:")).length).toBeGreaterThan(1);

    await useAppStore.getState().openOperationResult(identityOf(assoc));
    expect(useAppStore.getState().selectedRunId).toBe(REGISTERED);
  });

  it("「返回草稿明确可达」：失败保留时恢复原编辑目标；被清理后不返回也不复活", async () => {
    // 失败结局 ⇒ 草稿按判据保留（3.2）⇒ 「返回草稿」必须可达
    details[REGISTERED] = ok(detailOf("u1-error-detail", REGISTERED));
    const assoc = seed();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    expectNoAutoNavigation();
    expect(useAppStore.getState().drafts.calls[PARENT]?.[SPAN]?.result).toBeDefined();

    const back = await useAppStore.getState().returnOperationDraft({
      epoch: FAKE_EPOCH,
      operationId: assoc.operationId,
    });
    expect(back).toBe(true);
    expect(useAppStore.getState().pendingDraftTarget).toEqual({
      runId: PARENT,
      spanId: SPAN,
      field: "result",
    });
    // 返回不是"复活"：草稿仍是仓库里那一份（正文与修订都没被这次返回动过），执行状态也不变
    expect(useAppStore.getState().drafts.calls[PARENT]?.[SPAN]?.result?.text).toBe("编辑后的结果");
    expect(useAppStore.getState().forking).toBe("idle");
  });

  it("草稿已按修订清理 ⇒ 返回 false：不登记定位目标，也不凭空写回一份草稿", async () => {
    // 默认详情是自有正常终止 ⇒ 3.1/3.2 的收尾会把这份草稿清掉
    const assoc = seed();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    expect(useAppStore.getState().drafts.calls[PARENT]?.[SPAN]?.result).toBeUndefined();

    expect(
      await useAppStore.getState().returnOperationDraft({
        epoch: FAKE_EPOCH,
        operationId: assoc.operationId,
      }),
    ).toBe(false);
    const state = useAppStore.getState();
    expect(state.pendingDraftTarget).toBeNull();
    expect(state.drafts.calls[PARENT]?.[SPAN]?.result).toBeUndefined();
    expect(state.selectedRunId).toBe(PARENT);
  });

  it("isOperationDraftPresent：待定关联 / 收尾关联 / 都不在 三态分开", async () => {
    const assoc = seed();
    expect(
      useAppStore.getState().isOperationDraftPresent({
        epoch: FAKE_EPOCH,
        operationId: assoc.operationId,
      }),
    ).toBe(true);

    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    // 已解冻并核实正常终止 ⇒ 草稿被清理 ⇒ 不该再给"返回草稿"
    expect(useAppStore.getState().drafts.calls[PARENT]?.[SPAN]?.result).toBeUndefined();
    expect(
      useAppStore.getState().isOperationDraftPresent({
        epoch: FAKE_EPOCH,
        operationId: assoc.operationId,
      }),
    ).toBe(false);
    expect(
      useAppStore.getState().isOperationDraftPresent({
        epoch: FAKE_EPOCH,
        operationId: "88888888-8888-4888-8888-888888888888",
      }),
    ).toBe(false);
  });
  it("守卫：关联在场但草稿已不在 ⇒ 返回 false（不定位到一份空表单）", async () => {
    // ⚠️ 这条刻意**直接造状态**：今天没有任何路径会留下"关联在、草稿不在"的组合
    //（清理与释放关联同一步，显式放弃也同时释放关联），所以它钉的是那道守卫本身的语义——
    // 将来若 §5 把"释放关联"与"清理草稿"拆成两步，缺了这道守卫就会把用户定位到空表单，
    // 看起来像"草稿被系统弄丢了"。
    const assoc = seed();
    expect(useAppStore.getState().drafts.calls[PARENT]?.[SPAN]?.result).toBeDefined();
    // 直接从仓库里抹掉这一格（正常通道在冻结期会拒绝放弃，这正是"造状态"的意义）
    useAppStore.setState((state) => {
      const spans = { ...state.drafts.calls[PARENT] };
      delete spans[SPAN];
      return { drafts: { ...state.drafts, calls: { ...state.drafts.calls, [PARENT]: spans } } };
    });
    // 关联仍在（未解冻）：身份查得到目标，但仓库里已经没有草稿
    expect(useAppStore.getState().drafts.calls[PARENT]?.[SPAN]?.result).toBeUndefined();
    expect(
      subLib.submissionByOperation(
        useAppStore.getState().draftSubmissions,
        FAKE_EPOCH,
        assoc.operationId,
      ),
    ).toBeDefined();

    const state = useAppStore.getState();
    expect(
      state.isOperationDraftPresent({ epoch: FAKE_EPOCH, operationId: assoc.operationId }),
    ).toBe(false);
    expect(
      await state.returnOperationDraft({ epoch: FAKE_EPOCH, operationId: assoc.operationId }),
    ).toBe(false);
    expect(useAppStore.getState().pendingDraftTarget).toBeNull();
  });
});

describe("3.6 只通知路径：重复与后台读取都不放大", () => {
  it("重复快照（轮询再来两轮）不把同一结论数成两条", async () => {
    const assoc = seed();
    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);
    expect(noticeCount()).toBe(1);

    await useAppStore.getState().refreshOperationStatus();
    await useAppStore.getState().refreshOperationStatus();

    expect(noticeCount()).toBe(1);
    // 也没重读、没重刷列表、没跳转
    expect(calls.filter((one) => one.startsWith("runs:get:"))).toHaveLength(1);
    expect(calls.filter((one) => one === "runs:list")).toHaveLength(1);
    expectNoAutoNavigation();
  });

  it("标记已看是幂等的：再标一次不改引用", () => {
    const key = noticeKeyOf(FAKE_EPOCH, actRecord().operationId, REGISTERED);
    const before = useAppStore.getState().seenNoticeKeys;
    useAppStore.getState().markNoticesSeen([]);
    expect(useAppStore.getState().seenNoticeKeys).toBe(before);
    useAppStore.getState().markNoticesSeen([key]);
    const marked = useAppStore.getState().seenNoticeKeys;
    expect(marked[key]).toBe(true);
    useAppStore.getState().markNoticesSeen([key]);
    expect(useAppStore.getState().seenNoticeKeys).toBe(marked);
  });

  it("后台读取（自动核实）不碰当前阅读现场：页签、滚动、选中调用都不动", async () => {
    const assoc = seed();
    useAppStore.getState().setReadingScroll(PARENT, "overview", 120);
    const before = {
      tab: useAppStore.getState().readingOf(PARENT).tab,
      overviewScrollTop: useAppStore.getState().readingOf(PARENT).overviewScrollTop,
      spanId: useAppStore.getState().selectedSpanId,
      selected: useAppStore.getState().selectedRunId,
    };

    await useAppStore.getState().forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);

    const state = useAppStore.getState();
    expect(entryOf(assoc)?.phase).toBe("verified");
    expect(state.readingOf(PARENT).tab).toBe(before.tab);
    expect(state.readingOf(PARENT).overviewScrollTop).toBe(120);
    expect(state.selectedSpanId).toBe(before.spanId);
    expect(state.selectedRunId).toBe(before.selected);
    expect(state.error).toBeNull();
  });

  it("接线契约：跳转与定位的唯一入口是 store 动作，组件不自己拼", () => {
    const storeSrc = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/store.ts"),
      "utf8",
    );
    const failure = storeSrc.slice(
      storeSrc.indexOf("async openOperationFailure(identity)"),
      storeSrc.indexOf("async returnOperationDraft"),
    );
    // 失败定位只认 facts.failure.llmCallSpanId；不重新派生第二份判据
    expect(failure).toContain("facts?.failure.llmCallSpanId");
    expect(failure).not.toContain("deriveErrorTarget");
    expect(failure).not.toContain("leafSpanIds");
    // 明确动作都不走执行通道，也不读列表
    for (const [start, end] of [
      ["async openOperationResult(identity)", "async openOperationFailure"],
      ["async openOperationFailure(identity)", "async returnOperationDraft"],
      ["async returnOperationDraft(", "  isOperationDraftPresent("],
    ] as const) {
      const at = storeSrc.indexOf(start);
      expect(at, start).toBeGreaterThan(-1);
      const body = storeSrc.slice(at, storeSrc.indexOf(end, at + 1));
      expect(body, start).not.toContain("submitActive(");
      expect(body, start).not.toContain("loadRuns(");
    }
  });
});
