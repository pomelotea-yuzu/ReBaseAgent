import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, ModelAbResult, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationArmSummary, OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { ModelAbDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import type { DraftSubmission } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { deriveRunSummary } from "../src/shared/derive";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 3.3：**代理 messages 与 A/B 真实执行接进结果收尾**。
 *
 * 与前两支同一判据（3.1 `create-entry-closure` / 3.2 `fork-entry-closure`）：入口不再把响应
 * 当结局。这一支另管两件事：
 * 1. **dry-run 独立路径**——预览只走只读通道，不登记操作、不读结果、不消费、不清批次；
 * 2. **A/B 的臂身份取自登记**（`runIds`/`arms`），不取自信封的 `ids`——缺臂时信封可能多报，
 *    按登记读才符合「实验缺臂部分失败与未核实保留整批」。
 *
 * 至此五条通道（普通/隔离 create、普通/隔离 result、prompt、messages、A/B）都走同一个落点，
 * 「全部七类入口使用相同核实路径」的覆盖也在此收口（1.4 注记当时只到三条消费入口）。
 * ~~组件侧的批次结果面板仍显示信封 `ModelAbResult`（请求事实），其"按臂呈现读取状态"属 §5.1~~
 * ⇒ **5.1 已接线**：`ModelAbEditor` 的批次结果区改吃登记快照 + 读取项（`deriveAbBatchResult`，
 * 见 `operation-request-facts.test.ts`）；本文件的 store 侧判据不受影响、一字未改。
 */

/** 信封 id：U5 起不驱动任何读取（旧实现拿它 selectRun / 当作臂的清单） */
const ENVELOPE_PROXY = "run_proxy_envelope";
const ENVELOPE_ARM_A = "run_ab_envelope_a";
const ENVELOPE_ARM_B = "run_ab_envelope_b";
/** 登记的可信 id：唯一允许被读的那些 */
const REGISTERED_PROXY = "run_registered_proxy";
const ARM_A = "run_registered_arm_a";
const ARM_B = "run_registered_arm_b";

const PARENT = "u1_fork_parent";
const SPAN = "s_03";
const MESSAGES_KEY = { runId: PARENT, spanId: SPAN, field: "messages" } as const;
const AB_KEY: ModelAbDraftKey = { runId: PARENT, spanId: SPAN };

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
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
}

const PROXY_TARGET = { kind: "proxy", parentRunId: PARENT, atSpanId: SPAN } as const;
const AB_TARGET = {
  kind: "modelAb",
  parentRunId: PARENT,
  armCount: 2,
} as const;

function arm(index: number, id: string): OperationArmSummary {
  return { index, id, outcome: "returned" };
}

/** A/B 登记记录：默认两臂齐、都可读（缺臂/失败由用例覆盖） */
function abRecord(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: "66666666-6666-4666-8666-666666666666",
    target: AB_TARGET,
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [ARM_A, ARM_B],
    experimentId: "exp_1",
    arms: [arm(0, ARM_A), arm(1, ARM_B)],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

function proxyRecord(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    epoch: FAKE_EPOCH,
    operationId: "66666666-6666-4666-8666-666666666666",
    target: PROXY_TARGET,
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [REGISTERED_PROXY],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const AB_RESULT: ModelAbResult = {
  experimentId: "exp_1",
  ids: [ENVELOPE_ARM_A, ENVELOPE_ARM_B],
  ok: true,
  plan: [],
  sideEffectsAllowed: false,
};

const calls: string[] = [];
let snapshot: () => OperationRecord[] = () => [];
let registryVersion = 1;
let details: Record<string, Envelope<RunDetail>> = {};

function execStub(channel: string, data: unknown) {
  return async (envelope: { operation: { epoch: string; operationId: string } }) => {
    calls.push(channel);
    return toExecuted(ok(data), envelope.operation, registryVersion + 1);
  };
}

const apiStub: Record<string, unknown> = {
  operationsStatus: async () => {
    calls.push("operations:status");
    registryVersion += 1;
    return ok(statusSnapshot({ registryVersion, operations: snapshot(), activeOperationId: null }));
  },
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本文件不测核对路径" },
  }),
  listRuns: async (): Promise<Envelope<ListRunsData>> => {
    calls.push("runs:list");
    const summary = { ...deriveRunSummary(recordOf("u1-ok")), id: REGISTERED_PROXY };
    return ok({ runs: [summary], failed: [] });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    return details[id] ?? ok(detailOf("u1-ok", id));
  },
  proxyFork: execStub("proxy:fork", { id: ENVELOPE_PROXY }),
  modelAb: execStub("runs:modelAb", AB_RESULT),
  // 预览：只读通道（不带操作回执，也不该被登记消费）
  modelAbPlan: async (request: unknown) => {
    calls.push("runs:modelAbPlan");
    planRequests.push(request);
    return ok(AB_RESULT);
  },
};

const planRequests: unknown[] = [];

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const listCount = () => calls.filter((one) => one === "runs:list").length;
const readCalls = () => calls.filter((one) => one.startsWith("runs:get:"));
/** 消费序列（去首通道名、按出现顺序去重）：U5 3.4 的自动导航会再读一次详情，不改变"走了哪几步" */
const tailCalls = () => [...new Set(calls.slice(1))].join(" → ");
const entryOf = (assoc: DraftSubmission, runId: string) =>
  useAppStore.getState().resultReads.byKey[
    resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId })
  ];

function seedMessages(edited: string, overrides: Partial<OperationRecord> = {}): DraftSubmission {
  const store = useAppStore.getState();
  store.ensureCallDraft(MESSAGES_KEY, '[{"role":"user","content":"原请求"}]');
  store.writeCallDraftText(MESSAGES_KEY, edited);
  const assoc = store.beginDraftSubmission({ channel: "messages", target: MESSAGES_KEY });
  if (assoc === null) throw new Error("messages 提交关联登记失败");
  snapshot = () => [proxyRecord({ operationId: assoc.operationId, ...overrides })];
  return assoc;
}

function seedAbBatch(overrides: Partial<OperationRecord> = {}): DraftSubmission {
  const store = useAppStore.getState();
  store.ensureModelAbDraft(AB_KEY, [
    { model: "model-a", paramsText: "" },
    { model: "model-b", paramsText: '{"temperature":0.2}' },
  ]);
  const assoc = store.beginDraftSubmission({ channel: "model_ab", target: AB_KEY });
  if (assoc === null) throw new Error("A/B 批次关联登记失败");
  snapshot = () => [abRecord({ operationId: assoc.operationId, ...overrides })];
  return assoc;
}

beforeEach(async () => {
  calls.length = 0;
  planRequests.length = 0;
  registryVersion = 1;
  details = {};
  snapshot = () => [];
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
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
    modelAbInFlight: false,
    modelAbError: null,
    modelAbErrorCode: null,
  });
  await useAppStore.getState().refreshOperationStatus();
  calls.length = 0;
});

describe("3.3 代理 messages 入口不再消费响应", () => {
  it("「编辑并重发成功」的可信 ID 一侧：核实后清该草稿，序列与其余入口同形", async () => {
    const assoc = seedMessages('[{"role":"user","content":"改过的请求"}]');

    const sent = await useAppStore
      .getState()
      .proxyFork(PARENT, SPAN, [{ role: "user", content: "改过的请求" }], assoc);

    expect(sent).toBe(true);
    // 读过的只有登记的那条（U5 3.4 的自动导航会再读一次同一 id）；信封 id 一次都不读
    expect([...new Set(readCalls())]).toEqual([`runs:get:${REGISTERED_PROXY}`]);
    expect(calls).not.toContain(`runs:get:${ENVELOPE_PROXY}`);
    // 与 create / result / prompt 完全同形的那条序列（「全部七类入口使用相同核实路径」）
    expect(tailCalls()).toBe("operations:status → runs:list → runs:get:run_registered_proxy");
    expect(listCount()).toBe(1);
    const state = useAppStore.getState();
    expect(entryOf(assoc, REGISTERED_PROXY)?.facts?.normalEnd).toBe(true);
    expect(state.drafts.calls[PARENT]?.[SPAN]?.messages).toBeUndefined();
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeUndefined();
    // U5 3.4：留在流程内 ⇒ 协调器按登记 id 进入概览；入口自己不再拿信封 id 抢导航
    expect(state.selectedRunId).toBe(REGISTERED_PROXY);
    expect(state.detail?.meta.id).toBe(REGISTERED_PROXY);
    expect(state.forking).toBe("idle");
  });

  it("重发成功但自有事件是 error ⇒ 保留草稿与关联，不显示正常完成", async () => {
    details[REGISTERED_PROXY] = ok(detailOf("u1-error-detail", REGISTERED_PROXY));
    const assoc = seedMessages('[{"role":"user","content":"会失败的请求"}]');

    await useAppStore
      .getState()
      .proxyFork(PARENT, SPAN, [{ role: "user", content: "会失败的请求" }], assoc);

    const state = useAppStore.getState();
    expect(entryOf(assoc, REGISTERED_PROXY)?.facts?.normalEnd).toBe(false);
    expect(state.drafts.calls[PARENT]?.[SPAN]?.messages?.text).toBe(
      '[{"role":"user","content":"会失败的请求"}]',
    );
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
    expect(state.forking).toBe("idle");
  });
});

describe("3.3 A/B 真实执行按登记臂身份收尾", () => {
  it("「全部预期实验臂正常才清理整批」：逐臂按登记 ID 读一次，整批一次刷新", async () => {
    const assoc = seedAbBatch();

    const result = await useAppStore
      .getState()
      .modelAb(
        PARENT,
        [{ model: "model-a" }, { model: "model-b", params: { temperature: 0.2 } }],
        false,
        assoc,
      );

    // 信封数据原样回给界面（请求事实），但它**不决定**清理与导航
    expect(result).toEqual(AB_RESULT);
    // 逐臂读取按登记的 runIds 顺序，信封里的两个 id 一次都不读
    expect(readCalls()).toEqual([`runs:get:${ARM_A}`, `runs:get:${ARM_B}`]);
    expect(calls).not.toContain(`runs:get:${ENVELOPE_ARM_A}`);
    expect(calls).not.toContain(`runs:get:${ENVELOPE_ARM_B}`);
    expect(listCount()).toBe(1);
    const state = useAppStore.getState();
    expect(state.drafts.modelAb[PARENT]?.[SPAN]).toBeUndefined();
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeUndefined();
    // 多臂不自动聚焦：选中项与详情都没动
    expect(state.selectedRunId).toBeNull();
    expect(state.modelAbInFlight).toBe(false);
  });

  it("一条臂自有事件是 error ⇒ 两臂都核实、整批草稿与关联全保留", async () => {
    details[ARM_B] = ok(detailOf("u1-error-detail", ARM_B));
    const assoc = seedAbBatch();

    await useAppStore
      .getState()
      .modelAb(PARENT, [{ model: "model-a" }, { model: "model-b" }], false, assoc);

    expect(readCalls()).toEqual([`runs:get:${ARM_A}`, `runs:get:${ARM_B}`]);
    const state = useAppStore.getState();
    expect(entryOf(assoc, ARM_A)?.facts?.normalEnd).toBe(true);
    expect(entryOf(assoc, ARM_B)?.facts?.normalEnd).toBe(false);
    // 「保留整份配置」：一条失败不清批次，另一条正常也不单独清
    expect(state.modelAbDraftOf(AB_KEY)?.rows).toHaveLength(2);
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
  });

  it("「实验缺臂部分失败与未核实保留整批」：信封多报 id 也只读登记里的那条", async () => {
    const assoc = seedAbBatch({
      runIds: [ARM_A],
      arms: [arm(0, ARM_A)],
    });

    const result = await useAppStore
      .getState()
      .modelAb(PARENT, [{ model: "model-a" }, { model: "model-b" }], false, assoc);

    // 信封仍回两条 ids（请求事实），登记只有一条 ⇒ 只读一条，也不"按信封补读"
    expect(result?.ids).toEqual([ENVELOPE_ARM_A, ENVELOPE_ARM_B]);
    expect(readCalls()).toEqual([`runs:get:${ARM_A}`]);
    expect(calls).not.toContain(`runs:get:${ENVELOPE_ARM_B}`);
    const state = useAppStore.getState();
    expect(state.modelAbDraftOf(AB_KEY)?.rows).toHaveLength(2);
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
  });
});

describe("3.3 dry-run 保持独立只读路径", () => {
  it("预览不占主动通道、不登记消费、不清批次", async () => {
    const assoc = seedAbBatch();
    // 预览不传提交关联（组件如此），且 status 桩里那条登记根本不该被消费
    const plan = await useAppStore
      .getState()
      .modelAb(PARENT, [{ model: "model-a" }, { model: "model-b" }], true);

    expect(plan).toEqual(AB_RESULT);
    expect(calls).toEqual(["runs:modelAbPlan"]);
    expect(Object.keys(useAppStore.getState().resultReads.byKey)).toHaveLength(0);
    expect(listCount()).toBe(0);
    // 计划与结果都不隐式清理批次（delta「实验预览和结果不隐式清理批次」）
    expect(useAppStore.getState().modelAbDraftOf(AB_KEY)?.rows).toHaveLength(2);
    expect(
      subLib.closureOf(useAppStore.getState().draftSubmissions, FAKE_EPOCH, assoc.operationId),
    ).toBeUndefined();
  });
});

describe("3.3 接线契约：messages 与 A/B 的局部分支不得复活", () => {
  const STORE_SRC = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/store.ts"),
    "utf8",
  );
  const PANEL = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
    "utf8",
  );

  it("proxyFork 与 modelAb 体内不刷列表、不选中新 run、不碰草稿仓库", () => {
    for (const [start, end] of [
      ["async proxyFork(parentRunId, atSpanId, messages, submission) {", "}));"],
      ["async modelAb(parentRunId, arms, dryRun, submission) {", "resetModelAb() {"],
    ] as const) {
      const at = STORE_SRC.indexOf(start);
      expect(at, start).toBeGreaterThan(-1);
      const body = STORE_SRC.slice(at, STORE_SRC.indexOf(end, at + 1));
      expect(body, start).not.toContain("get().loadRuns(");
      expect(body, start).not.toContain("get().selectRun(");
      expect(body, start).not.toContain("drafts");
    }
    // 五条通道的响应侧都不再写"成功"态
    expect(STORE_SRC).not.toContain('forking: "idle" | "in_progress" | "success" | "error"');
    expect(STORE_SRC).not.toContain('set({ forking: "success" })');
  });

  it("「SDK run 无此入口」：messages 入口只给已封存代理 run 的自有 llm.call", () => {
    expect(PANEL).toContain('const isProxy = run?.meta.source?.kind === "proxy";');
    expect(PANEL).toContain(
      'const canResend = isProxy === true && leafOwned && run?.status === "completed";',
    );
    expect(PANEL).toContain("{canResend && run !== null ? (");
  });

  it("「未修改禁用」与「未捕获 key」：提交按钮判据仍含两者（门禁不由响应替代）", () => {
    const at = PANEL.indexOf("onClick={doResend}");
    const disabled = PANEL.slice(at, PANEL.indexOf("title={", at + 1));
    expect(at).toBeGreaterThan(-1);
    expect(disabled).toContain("unchanged ||");
    expect(disabled).toContain("proxy?.running !== true");
    expect(PANEL).toContain("const unchanged = value === messagesBaseline;");
    // 拒绝码的就近指引仍在（未捕获 key ⇒ 说清"先把应用经代理跑一次"）
    expect(PANEL).toContain('forkErrorCode === "PROXY_NO_KEY"');
  });
});
