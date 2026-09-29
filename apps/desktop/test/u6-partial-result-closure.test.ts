import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord, SpanLine } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey, ModelAbDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import { isLineageRejectionCode } from "../src/renderer/src/lib/detail-completeness";
import { closureOf } from "../src/renderer/src/lib/draft-submission";
import { buildOperationResultViews } from "../src/renderer/src/lib/operation-result-view";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import {
  emptyResultReadStore,
  resultReadEntryOf,
  resultReadKeyOf,
  verifyResultPayload,
} from "../src/renderer/src/lib/result-verification";
import { FAKE_EPOCH, executedFail, statusSnapshot } from "./helpers/operation-channels";

/**
 * U6（add-partial-run-reading）任务 4.6–4.9：部分详情沿用 U5 的结果核实与草稿收尾。
 *
 * 对应 delta 场景：
 *   - 「ownOnly 正常结果仍按原修订清理」：自有 stopped/completed 照常进入原子修订清理；
 *     较新 revision/token 不被删除；面板同时显示自有结局与来源缺失；
 *   - 「ownOnly 失败定位只使用自有调用」：error/限制/中断保留草稿；有自有失败调用才给定位，
 *     否则诚实说明；不从祖先补错；
 *   - 「部分实验结果保留完整批次判据」：ownOnly 臂不影响"全部预期臂唯一、齐全、同批、
 *     各自正常终止"的整批判据；缺臂/null ID/不可读任一存在均保留整批；
 *   - 「后台重试不导航也不重发执行」：手动重试更新匹配身份与代次的读取项；
 *     可核实正常终止时只按尚存在的原关联清理；不猜草稿、不抢焦点、不重复通知、不执行。
 *
 * ⚠️ 全部经**真实 store 动作**驱动（`refreshOperationStatus` / `retryResultRead`）；
 *    面板呈现用 `buildOperationResultViews`（只吃 records + reads，无 store 依赖）。
 */

const calls: string[] = [];
let registry: () => OperationRecord[] = () => [];
let registryVersion = 1;
let details: Record<string, Envelope<RunDetail>> = {};

function settledRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    target: {
      kind: "result",
      mode: "plain",
      parentRunId: "run_viewing",
      atSpanId: "s_03",
      editField: "result",
    },
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [TRUSTED],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

function abRecord(
  arms: OperationRecord["arms"],
  runIds: string[],
  overrides: Partial<OperationRecord> = {},
): OperationRecord {
  return settledRecord({
    target: AB_TARGET,
    arms,
    runIds,
    experimentId: "exp_1",
    ...overrides,
  });
}

function defaultStatusHandler() {
  return async () => {
    calls.push("operations:status");
    registryVersion += 1;
    return ok(statusSnapshot({ registryVersion, operations: registry() }));
  };
}

const apiStub: Record<string, unknown> = {
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    return ok({ runs: [], failed: [] });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    return details[id] ?? ok(ownOnlyNamed(id));
  },
  operationsStatus: defaultStatusHandler(),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
  }),
  forkRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  promptFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  proxyFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  modelAb: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  createRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const KEY_A: CallDraftKey = { runId: "run_viewing", spanId: "s_03", field: "result" };
const AB_KEY: ModelAbDraftKey = { runId: "run_viewing", spanId: "s_02" };
const AB_TARGET = { kind: "modelAb" as const, parentRunId: "run_viewing", armCount: 2 };
const TRUSTED = "run_from_registry";
const RUN_A = "run_arm_a";
const RUN_B = "run_arm_b";
const MISSING = "r_missing_ancestor";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");

/**
 * ownOnly 详情夹具：真实 fixture 的 meta/spans 改造——parent 指向缺失祖先、
 * chain 只剩当前 hop（parent = missingRunId 且不在链内，过 run-detail-integrity）。
 */
function ownOnlyNamed(
  id: string,
  options: {
    /** 末个自有 llm.call 是否携带 error（造"自有失败调用"） */
    ownLlmError?: string;
    events?: RunDetail["events"];
  } = {},
): RunDetail {
  const record: RunRecord = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
  const spans: SpanLine[] =
    options.ownLlmError === undefined
      ? record.spans
      : record.spans.map((span) =>
          span.kind === "llm.call" && span.id === "s_08"
            ? ({ ...span, error: { message: options.ownLlmError } } as SpanLine)
            : span,
        );
  const meta = {
    ...record.meta,
    id,
    parent: MISSING,
    fork: { at_span: "s_01", edit: { field: "result", value: "改过的结果" } },
  };
  return {
    meta,
    spans,
    events: options.events ?? [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: record.status,
    chain: [{ meta, fork: meta.fork }],
    leafSpanIds: spans.map((span) => span.id),
    completeness: "ownOnly",
    spanScope: "own",
    lineage: { status: "incomplete", reason: "ANCESTOR_NOT_FOUND", missingRunId: MISSING },
  } as RunDetail;
}

const { useAppStore } = await import("../src/renderer/src/store");

function submitDraft(key: CallDraftKey, text: string) {
  const store = useAppStore.getState();
  store.ensureCallDraft(key, "原结果", undefined);
  store.writeCallDraftText(key, text);
  const submission = store.beginDraftSubmission({ channel: "result", target: key });
  if (submission === null) throw new Error("unreachable：应能登记提交关联");
  return submission;
}

function beginAbBatch() {
  const store = useAppStore.getState();
  store.ensureModelAbDraft(AB_KEY, [
    { model: "m-a", paramsText: "{}" },
    { model: "m-b", paramsText: "{}" },
  ]);
  const submission = store.beginDraftSubmission({ channel: "model_ab", target: AB_KEY });
  if (submission === null) throw new Error("unreachable：应能登记整批关联");
  return submission;
}

beforeEach(async () => {
  calls.length = 0;
  registryVersion = 1;
  details = {};
  registry = () => [];
  apiStub.operationsStatus = defaultStatusHandler();
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: { byId: {}, closures: {}, nextToken: 1 },
    createSourceRef: null,
    confirmations: { byTargetKey: {} },
    checkGenerations: {},
    sourceRevocation: 0,
    forking: "idle" as const,
    view: "trace",
    createReturnLocation: null,
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    error: null,
    selectedRunId: null,
    selectedSpanId: null,
    detail: null,
    loadingDetail: false,
    readingByRun: {},
    readingInvalidated: false,
  });
  await useAppStore.getState().refreshOperationStatus();
});

describe("4.6 ownOnly 正常结果仍按原修订清理", () => {
  it("ownOnly + 自有 stopped/completed ⇒ 进入原 U5 清理；读取项携带来源缺失", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    details = { [TRUSTED]: ok(ownOnlyNamed(TRUSTED)) };
    calls.length = 0;

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    // 草稿按提交修订清理、关联释放
    expect(draftLib.callDraftOf(state.drafts, KEY_A)).toBeUndefined();
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeUndefined();
    // 读取项已核实，且**携带**来源完整性（ownOnly 不影响核实，但必须跟着结论走）
    const entry =
      state.resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: submission.operationId, runId: TRUSTED })
      ];
    expect(entry?.phase).toBe("verified");
    expect(entry?.facts?.normalEnd).toBe(true);
    expect(entry?.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: MISSING,
    });
  });

  it("面板同一行显示自有结局与来源警告：正常结束不被读成可重跑", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    const record = settledRecord({ operationId: submission.operationId });
    registry = () => [record];
    details = { [TRUSTED]: ok(ownOnlyNamed(TRUSTED)) };

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    const views = buildOperationResultViews({
      records: state.operations.operations,
      reads: state.resultReads,
      draftPresentOf: () => false,
    });
    const view = views[`${record.epoch}/${record.operationId}`];
    expect(view?.kind).toBe("items");
    const item = view?.kind === "items" ? view.items[0] : undefined;
    // 展示口径走 classifyOutcome（"已结束"）；严格清理判据（stopped+completed）是另一层
    expect(item?.label).toBe("已结束");
    expect(item?.sourceWarning).toContain("仅显示本运行记录，父链不完整");
    expect(item?.sourceWarning).toContain(MISSING);
    expect(item?.sourceWarning).toContain("不等于可以重跑");
  });
});

describe("4.7 ownOnly 失败定位只使用自有调用", () => {
  it("ownOnly + 自有 error 终止 ⇒ 保留草稿；定位给自有失败调用（不取祖先）", async () => {
    const submission = submitDraft(KEY_A, "会保留的输入");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    details = {
      [TRUSTED]: ok(
        ownOnlyNamed(TRUSTED, {
          ownLlmError: "上游超时",
          events: [{ type: "run.event", event: "stopped", reason: "error" }],
        }),
      ),
    };

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)?.text).toBe("会保留的输入");
    const entry =
      state.resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: submission.operationId, runId: TRUSTED })
      ];
    // 失败定位只认 leafSpanIds 内的调用——ownOnly 的 spans 全是自有，定位必在其中
    expect(entry?.facts?.failure.llmCallSpanId).toBe("s_08");
    const views = buildOperationResultViews({
      records: state.operations.operations,
      reads: state.resultReads,
      draftPresentOf: () => false,
    });
    const item =
      views[`${FAKE_EPOCH}/${submission.operationId}`]?.kind === "items"
        ? (
            views[`${FAKE_EPOCH}/${submission.operationId}`] as {
              items: Array<{ actions: string[]; sourceWarning: string | null }>;
            }
          ).items[0]
        : undefined;
    expect(item?.actions).toContain("view-failure");
    expect(item?.sourceWarning).not.toBeNull();
  });

  it("ownOnly + error 终止但无自有失败详情 ⇒ 诚实说明，不给定位入口", async () => {
    const submission = submitDraft(KEY_A, "会保留的输入");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    // u1-ok 的自有调用都没有 error ⇒ failure.missingDetail
    details = {
      [TRUSTED]: ok(
        ownOnlyNamed(TRUSTED, {
          events: [{ type: "run.event", event: "stopped", reason: "error" }],
        }),
      ),
    };

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)).toBeDefined();
    const views = buildOperationResultViews({
      records: state.operations.operations,
      reads: state.resultReads,
      draftPresentOf: () => false,
    });
    const item =
      views[`${FAKE_EPOCH}/${submission.operationId}`]?.kind === "items"
        ? (
            views[`${FAKE_EPOCH}/${submission.operationId}`] as {
              items: Array<{ actions: string[]; failureNote: string | null }>;
            }
          ).items[0]
        : undefined;
    expect(item?.actions).not.toContain("view-failure");
    expect(item?.failureNote).toContain("没有失败的模型调用详情");
  });
});

describe("4.8 部分实验结果保留完整批次判据", () => {
  it("两臂均为 ownOnly 正常终止 ⇒ 整批照常清理（ownOnly 不另设门槛）", async () => {
    const submission = beginAbBatch();
    registry = () => [
      abRecord(
        [
          { index: 0, id: RUN_A, outcome: "returned" },
          { index: 1, id: RUN_B, outcome: "returned" },
        ],
        [RUN_A, RUN_B],
        { operationId: submission.operationId },
      ),
    ];
    details = { [RUN_A]: ok(ownOnlyNamed(RUN_A)), [RUN_B]: ok(ownOnlyNamed(RUN_B)) };
    calls.length = 0;

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(draftLib.modelAbDraftOf(state.drafts, AB_KEY)).toBeUndefined();
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeUndefined();
  });

  it("缺臂 / null ID / 不可读臂任一存在 ⇒ 整批保留，不推断胜出臂", async () => {
    const cases: Array<[OperationRecord["arms"], string[], Record<string, Envelope<RunDetail>>]> = [
      [
        [{ index: 0, id: RUN_A, outcome: "returned" }],
        [RUN_A],
        { [RUN_A]: ok(ownOnlyNamed(RUN_A)) },
      ],
      [
        [
          { index: 0, id: RUN_A, outcome: "returned" },
          { index: 1, id: null, outcome: null },
        ],
        [RUN_A],
        { [RUN_A]: ok(ownOnlyNamed(RUN_A)) },
      ],
      [
        [
          { index: 0, id: RUN_A, outcome: "returned" },
          { index: 1, id: RUN_B, outcome: "returned" },
        ],
        [RUN_A, RUN_B],
        {
          [RUN_A]: ok(ownOnlyNamed(RUN_A)),
          [RUN_B]: { ok: false, error: { code: "GET_RUN_FAILED", message: "不可读" } },
        },
      ],
    ];
    for (const [arms, runIds, detailMap] of cases) {
      useAppStore.setState({
        drafts: draftLib.emptyDraftRepo(),
        draftSubmissions: { byId: {}, closures: {}, nextToken: 1 },
        resultReads: emptyResultReadStore(),
      });
      const submission = beginAbBatch();
      registry = () => [abRecord(arms, runIds, { operationId: submission.operationId })];
      details = detailMap;
      await useAppStore.getState().refreshOperationStatus();
      const state = useAppStore.getState();
      expect(draftLib.modelAbDraftOf(state.drafts, AB_KEY)?.rows).toHaveLength(2);
      expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
    }
  });
});

describe("4.9 手动重试：只读、不导航、只按尚存关联清理", () => {
  it("不可读 → ownOnly 正常：重试后按原关联清理；全程零执行通道、不换选中项", async () => {
    const submission = submitDraft(KEY_A, "等重试收尾的输入");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    // 第一次自动核实：不可读（文件暂时读不出来）
    details = {
      [TRUSTED]: { ok: false, error: { code: "GET_RUN_FAILED", message: "暂时读不出" } },
    };
    await useAppStore.getState().refreshOperationStatus();
    expect(
      useAppStore.getState().resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: submission.operationId, runId: TRUSTED })
      ]?.phase,
    ).toBe("unreadable");

    // 父文件恢复 ⇒ 手动重试读到 ownOnly 正常终止
    useAppStore.setState({ selectedRunId: "run_elsewhere" });
    calls.length = 0;
    details = { [TRUSTED]: ok(ownOnlyNamed(TRUSTED)) };
    const entry = await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });

    expect(entry.phase).toBe("verified");
    expect(entry.facts?.normalEnd).toBe(true);
    expect(entry.lineage?.status).toBe("incomplete");
    // 只走了只读通道；没有执行通道、没有导航（选中项原地不动）
    expect(calls).toEqual([`runs:get:${TRUSTED}`]);
    expect(useAppStore.getState().selectedRunId).toBe("run_elsewhere");
    // 匹配修订被清理
    expect(draftLib.callDraftOf(useAppStore.getState().drafts, KEY_A)).toBeUndefined();
  });

  it("重试前草稿已推进新修订 ⇒ 不被删除（无关联/修订不匹配不猜草稿）", async () => {
    const submission = submitDraft(KEY_A, "第一版输入");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    details = {
      [TRUSTED]: { ok: false, error: { code: "GET_RUN_FAILED", message: "暂时读不出" } },
    };
    await useAppStore.getState().refreshOperationStatus();

    // 重试发生前用户继续编辑（修订推进）——旧结果无权删它
    useAppStore.getState().writeCallDraftText(KEY_A, "重试前又改了一版");

    details = { [TRUSTED]: ok(ownOnlyNamed(TRUSTED)) };
    const entry = await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });

    expect(entry.facts?.normalEnd).toBe(true);
    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)?.text).toBe("重试前又改了一版");
    // 关联保留：CAS 输了就留着等下一次核实，不凭空判结局
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
  });

  it("verifyResultPayload + resultReadEntryOf：ownOnly 载荷核实通过并携带 lineage（纯层回归）", () => {
    const verification = verifyResultPayload(TRUSTED, ok(ownOnlyNamed(TRUSTED)));
    expect(verification.ok).toBe(true);
    const entry = resultReadEntryOf(verification, 1);
    expect(entry.phase).toBe("verified");
    expect(entry.lineage?.status).toBe("incomplete");
    expect(entry.lineage?.status === "incomplete" && entry.lineage.missingRunId === MISSING).toBe(
      true,
    );
  });
});

describe("4.10 renderer 得知来源不完整 ⇒ 撤销旧预检/计划/确认/授权", () => {
  it("isLineageRejectionCode：只认两类来源稳定码（纯判据）", () => {
    expect(isLineageRejectionCode("RUN_LINEAGE_INCOMPLETE")).toBe(true);
    expect(isLineageRejectionCode("RUN_DETAIL_UNREADABLE")).toBe(true);
    expect(isLineageRejectionCode("PARENT_NOT_ISOLATED")).toBe(false);
    expect(isLineageRejectionCode("GET_RUN_FAILED")).toBe(false);
  });

  /** 完整详情夹具（与 ownOnlyNamed 相同底料，completeness=complete） */
  function completeNamed(id: string): RunDetail {
    const record: RunRecord = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
    const meta = { ...record.meta, id };
    return {
      meta,
      spans: record.spans,
      events: record.events,
      status: record.status,
      chain: [{ meta, fork: null }],
      leafSpanIds: record.spans.map((span) => span.id),
      completeness: "complete",
      spanScope: "own",
      lineage: { status: "complete" },
    } as RunDetail;
  }

  /** 预置一份草稿 + 已推进的检查代次 + 已武装的确认（先检查后确认，与真实流程同序） */
  function armPermissionState(): {
    revocation: number;
    generation: number | undefined;
    armed: number;
  } {
    const store = useAppStore.getState();
    store.ensureCallDraft(KEY_A, "原结果", undefined);
    store.writeCallDraftText(KEY_A, "确认过的输入");
    store.restartExecutionCheck(KEY_A);
    store.armExecutionConfirmation(store.currentConfirmationBinding("result", KEY_A));
    const state = useAppStore.getState();
    const keys = Object.keys(state.checkGenerations);
    expect(keys.length).toBe(1);
    return {
      revocation: state.sourceRevocation,
      generation: state.checkGenerations[keys[0] ?? ""],
      armed: Object.keys(state.confirmations.byTargetKey).length,
    };
  }

  it("详情落地为 ownOnly ⇒ 撤销令牌 +1 且检查代次推进（complete 则都不动）", async () => {
    const before = armPermissionState();
    details = { run_own: ok(ownOnlyNamed("run_own")) };

    await useAppStore.getState().selectRun("run_own");

    const keys = Object.keys(useAppStore.getState().checkGenerations);
    const state = useAppStore.getState();
    expect(state.sourceRevocation).toBe(before.revocation + 1);
    // 检查代次 +1：旧检查的响应装不回新确认；父文件恢复也不能复活
    expect(state.checkGenerations[keys[0] ?? ""]).toBe((before.generation ?? 0) + 1);

    // 对照组：complete 落地不撤销（注意 selectRun 自身会清确认——那是 U5 的"离开现场"，
    // 与来源撤销无关；判别面是撤销令牌与检查代次）
    const beforeComplete = armPermissionState();
    details = { run_complete: ok(completeNamed("run_complete")) };
    await useAppStore.getState().selectRun("run_complete");
    const keys2 = Object.keys(useAppStore.getState().checkGenerations);
    const state2 = useAppStore.getState();
    expect(state2.sourceRevocation).toBe(beforeComplete.revocation);
    expect(state2.checkGenerations[keys2[0] ?? ""]).toBe(beforeComplete.generation);
  });

  it("执行响应以来源类稳定码拒绝 ⇒ 撤销并清空确认；其他错误码不撤销", async () => {
    // 来源类拒绝：forkRun 桩返回 RUN_LINEAGE_INCOMPLETE（带合法回执）
    const before = armPermissionState();
    expect(before.armed).toBe(1);
    apiStub.forkRun = executedFail("RUN_LINEAGE_INCOMPLETE", "来源不完整：祖先文件缺失");
    const accepted = await useAppStore.getState().forkAt("run_viewing", "s_03", "编辑后的结果");
    expect(accepted).toBe(false);
    let state = useAppStore.getState();
    expect(state.sourceRevocation).toBe(before.revocation + 1);
    expect(Object.keys(state.confirmations.byTargetKey)).toHaveLength(0);

    // 非 source 类拒绝：不触发撤销（确认原样保留——那是 U5 既有语义）
    const beforeOther = armPermissionState();
    expect(beforeOther.armed).toBe(1);
    apiStub.forkRun = executedFail("PARENT_NOT_ISOLATED", "普通父本不带隔离声明");
    await useAppStore.getState().forkAt("run_viewing", "s_03", "再次编辑");
    state = useAppStore.getState();
    expect(state.sourceRevocation).toBe(beforeOther.revocation);
    expect(Object.keys(state.confirmations.byTargetKey)).toHaveLength(1);
  });
});
