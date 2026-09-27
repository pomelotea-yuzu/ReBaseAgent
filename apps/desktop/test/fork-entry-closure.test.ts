import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type {
  Envelope,
  IsolatedExecutionMode,
  ListRunsData,
  RunDetail,
  WindowApi,
} from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import type { DraftSubmission, DraftSubmitChannel } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { deriveRunSummary } from "../src/shared/derive";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 3.2：**普通 / 隔离 result 与 prompt 接进结果收尾**。
 *
 * 与 3.1（`create-entry-closure.test.ts`）同一判据、另两个入口：
 * 旧 `store.forkAt` / `store.promptFork` 在 ok 之后 `loadRuns()` + `selectRun(信封里的 id)`，
 * 于是"成功信封 + 该 run 自有事件是 errored"这条路会**跳进一个被当成成功的失败结果**。
 * U5 起三条入口（create / result / prompt）在响应侧只留请求事实，其余全部汇到
 * `consumeSettledOperations` 这一个落点——本文件因此也承担
 * 「所有入口实际使用同一适配器」的**调用序列同形**核对。
 *
 * 验收场景（delta 逐字标题）：「成功信封但运行错误」「所有入口实际使用同一适配器」。
 */

/** 信封里的 id：旧实现拿它去 selectRun；U5 起它不驱动任何读取 */
const ENVELOPE_FORK = "run_fork_envelope";
const ENVELOPE_PROMPT = "run_prompt_envelope";
/** main 登记的可信 id（与信封 id 刻意不同） */
const REGISTERED_FORK = "run_registered_fork";
const REGISTERED_PROMPT = "run_registered_prompt";

const PARENT = "u1_fork_parent";
const SPAN = "s_03";
const RESULT_KEY: CallDraftKey = { runId: PARENT, spanId: SPAN, field: "result" };
const PROMPT_KEY: CallDraftKey = { runId: PARENT, spanId: "s_05", field: "system_prompt" };

const EXECUTION: IsolatedExecutionMode = {
  mode: "isolated_files",
  allowFileWrites: true,
};

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

/** 登记记录：result / prompt 两条入口只差 target 与 runIds（其余填自洽值） */
function record(overrides: Partial<OperationRecord>): OperationRecord {
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
    runIds: [REGISTERED_FORK],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const PROMPT_TARGET = {
  kind: "prompt",
  parentRunId: PARENT,
  editField: "system_prompt",
} as const;

const calls: string[] = [];
let snapshot: () => OperationRecord[] = () => [];
let registryVersion = 1;
/** 按登记 id 覆盖详情载荷（默认一律给"自有正常终止"的 fixture） */
let details: Record<string, Envelope<RunDetail>> = {};
const execRequests: Array<{ channel: string; request: unknown }> = [];

/** 主动执行通道的共用桩：记录请求、按**请求带来的身份**回 settled 回执 */
function execStub(channel: string, envelopeData: { id: string }) {
  return async (envelope: {
    operation: { epoch: string; operationId: string };
    request: unknown;
  }) => {
    calls.push(channel);
    execRequests.push({ channel, request: envelope.request });
    return toExecuted(ok(envelopeData), envelope.operation, registryVersion + 1);
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
    const summary = { ...deriveRunSummary(recordOf("u1-ok")), id: REGISTERED_FORK };
    return ok({ runs: [summary], failed: [] });
  },
  getRun: async (id: string): Promise<Envelope<RunDetail>> => {
    calls.push(`runs:get:${id}`);
    return details[id] ?? ok(detailOf("u1-ok", id));
  },
  forkRun: execStub("runs:fork", { id: ENVELOPE_FORK }),
  promptFork: execStub("runs:promptFork", { id: ENVELOPE_PROMPT }),
};

(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const listCount = () => calls.filter((one) => one === "runs:list").length;
const readCalls = () => calls.filter((one) => one.startsWith("runs:get:"));
/**
 * 消费序列（去掉首个通道名、按出现顺序去重）——"同一适配器"的判据。
 * 去重是必要的：U5 3.4 起，留在流程内且结果可读时协调器会再走一次 `selectRun`
 * （它自己还要读一次详情），序列里同一项出现两次不改变"走的是哪几步"这件事。
 */
const tailCalls = () => [...new Set(calls.slice(1))].join(" → ");
const entryOf = (assoc: DraftSubmission, runId: string) =>
  useAppStore.getState().resultReads.byKey[
    resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: assoc.operationId, runId })
  ];

/** 与编辑器同形：登记调用草稿 → 写入编辑值 → 原子取提交关联，并把该身份的终态接进 status 桩 */
function seed(
  key: CallDraftKey,
  channel: DraftSubmitChannel,
  text: string,
  overrides: Partial<OperationRecord>,
): DraftSubmission {
  const store = useAppStore.getState();
  store.ensureCallDraft(key, "父 run 录下的原值");
  store.writeCallDraftText(key, text);
  const assoc = store.beginDraftSubmission({ channel, target: key });
  if (assoc === null) throw new Error("提交关联登记失败");
  snapshot = () => [record({ operationId: assoc.operationId, ...overrides })];
  return assoc;
}

beforeEach(async () => {
  calls.length = 0;
  execRequests.length = 0;
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
  });
  await useAppStore.getState().refreshOperationStatus();
  calls.length = 0;
});

describe("3.2 result 入口不再消费响应（普通与隔离）", () => {
  it("「成功信封但运行错误」：按登记 ID 读出失败，草稿保留、进的是失败概览", async () => {
    details[REGISTERED_FORK] = ok(detailOf("u1-error-detail", REGISTERED_FORK));
    const assoc = seed(RESULT_KEY, "result", "编辑后的结果", {});

    const okFork = await useAppStore
      .getState()
      .forkAt(PARENT, SPAN, "编辑后的结果", undefined, assoc);

    // 信封是 ok 的（返回 true 只表示请求明确返回并被接受），但结局由详情自己的事件说话
    expect(okFork).toBe(true);
    // 被读的只有**登记的那个 id**（导航自己会再读一次同一条）；信封 id 一次都不读
    expect([...new Set(readCalls())]).toEqual([`runs:get:${REGISTERED_FORK}`]);
    expect(calls).not.toContain(`runs:get:${ENVELOPE_FORK}`);
    expect(entryOf(assoc, REGISTERED_FORK)?.phase).toBe("verified");
    expect(entryOf(assoc, REGISTERED_FORK)?.facts?.normalEnd).toBe(false);
    expect(entryOf(assoc, REGISTERED_FORK)?.facts?.outcome.label).not.toBe("已结束");
    // 不显示"正常完成" ⇒ 也不清理：草稿逐字保留、关联留着等下一次核实
    const state = useAppStore.getState();
    expect(state.drafts.calls[PARENT]?.[SPAN]?.result?.text).toBe("编辑后的结果");
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
    // 列表刷新只有终态消费那一次（入口不再自己刷）
    expect(listCount()).toBe(1);
    // 「响应即成功」的展示态不再出现在 result 路径上
    expect(state.forking).toBe("idle");
    expect(state.forkError).toBeNull();
    // U5 3.4：跳不跳由**导航意图**判，不由入口判。用户没离开过流程 ⇒ 进失败概览
    //（spec「留在当前流程可进入成功或失败概览」；"跳向信封 id"仍被上面两条钉住）
    expect(state.selectedRunId).toBe(REGISTERED_FORK);
    expect(state.detail?.meta.id).toBe(REGISTERED_FORK);
    // 普通父本的请求里不出现 execution 键
    expect(execRequests).toEqual([
      {
        channel: "runs:fork",
        request: expect.objectContaining({ parentRunId: PARENT, atSpanId: SPAN }),
      },
    ]);
    expect("execution" in (execRequests[0]?.request as Record<string, unknown>)).toBe(false);
  });

  it("自有正常终止 + 修订未变 ⇒ 按提交修订清该调用草稿（其他草稿不受牵连）", async () => {
    const assoc = seed(RESULT_KEY, "result", "只清这一份", {});
    // 另一目标一份草稿：清理只认提交关联里的那个键
    const otherKey: CallDraftKey = { runId: PARENT, spanId: "s_09", field: "result" };
    useAppStore.getState().ensureCallDraft(otherKey, "别的运行");
    useAppStore.getState().writeCallDraftText(otherKey, "别的输入");

    await useAppStore.getState().forkAt(PARENT, SPAN, "只清这一份", undefined, assoc);

    const repo = useAppStore.getState().drafts;
    expect(repo.calls[PARENT]?.[SPAN]).toBeUndefined();
    expect(repo.calls[PARENT]?.s_09?.result?.text).toBe("别的输入");
    expect(
      subLib.closureOf(useAppStore.getState().draftSubmissions, FAKE_EPOCH, assoc.operationId),
    ).toBeUndefined();
  });

  it("隔离 result（带 execution）走同一条消费：请求透传、序列同形", async () => {
    const assoc = seed(RESULT_KEY, "result", "隔离续跑值", {
      target: {
        kind: "result",
        mode: "isolated",
        parentRunId: PARENT,
        atSpanId: SPAN,
        editField: "result",
      },
    });

    const okFork = await useAppStore
      .getState()
      .forkAt(PARENT, SPAN, "隔离续跑值", EXECUTION, assoc);

    expect(okFork).toBe(true);
    expect((execRequests[0]?.request as Record<string, unknown>).execution).toEqual(EXECUTION);
    expect([...new Set(readCalls())]).toEqual([`runs:get:${REGISTERED_FORK}`]);
    expect(listCount()).toBe(1);
    expect(useAppStore.getState().drafts.calls[PARENT]?.[SPAN]).toBeUndefined();
    // U5 3.4：留在流程内 ⇒ 协调器跳向**登记的那条**（入口自己不再拿信封 id 抢导航）
    expect(useAppStore.getState().selectedRunId).toBe(REGISTERED_FORK);
    // 与 3.1 的创建入口同一条序列：通道 → status → 一次列表 → 一次按 ID 读取
    expect(tailCalls()).toBe("operations:status → runs:list → runs:get:run_registered_fork");
  });
});

describe("3.2 prompt 入口不再消费响应", () => {
  it("成功信封 + 自有正常终止 ⇒ 核实后清该字段草稿，跳转只指向登记 ID", async () => {
    const assoc = seed(PROMPT_KEY, "prompt", "新的 system prompt", {
      target: PROMPT_TARGET,
      runIds: [REGISTERED_PROMPT],
    });

    const okFork = await useAppStore
      .getState()
      .promptFork(PARENT, { field: "system_prompt", value: "新的 system prompt" }, assoc);

    expect(okFork).toBe(true);
    expect([...new Set(readCalls())]).toEqual([`runs:get:${REGISTERED_PROMPT}`]);
    expect(calls).not.toContain(`runs:get:${ENVELOPE_PROMPT}`);
    expect(entryOf(assoc, REGISTERED_PROMPT)?.facts?.normalEnd).toBe(true);
    const state = useAppStore.getState();
    expect(state.drafts.calls[PARENT]?.s_05?.system_prompt).toBeUndefined();
    // U5 3.4：留在流程内 ⇒ 协调器跳的是**登记的那条**；入口自己不再拿信封 id 抢导航
    expect(state.selectedRunId).toBe(REGISTERED_PROMPT);
    expect(state.detail?.meta.id).toBe(REGISTERED_PROMPT);
    expect(state.forking).toBe("idle");
    // 与 result / create 同一条消费序列（同一适配器）
    expect(tailCalls()).toBe("operations:status → runs:list → runs:get:run_registered_prompt");
  });

  it("成功信封但运行 error ⇒ 呈现失败、保留草稿与关联", async () => {
    details[REGISTERED_PROMPT] = ok(detailOf("u1-error-detail", REGISTERED_PROMPT));
    const assoc = seed(PROMPT_KEY, "prompt", "会失败的 prompt", {
      target: PROMPT_TARGET,
      runIds: [REGISTERED_PROMPT],
    });

    await useAppStore
      .getState()
      .promptFork(PARENT, { field: "system_prompt", value: "会失败的 prompt" }, assoc);

    const state = useAppStore.getState();
    expect(entryOf(assoc, REGISTERED_PROMPT)?.facts?.normalEnd).toBe(false);
    expect(state.drafts.calls[PARENT]?.s_05?.system_prompt?.text).toBe("会失败的 prompt");
    expect(subLib.closureOf(state.draftSubmissions, FAKE_EPOCH, assoc.operationId)).toBeDefined();
    // 失败也进概览（进的是失败概览），但跳的是登记的那条，不是信封 id
    expect(state.selectedRunId).toBe(REGISTERED_PROMPT);
  });
});

describe("3.2 接线契约：result / prompt 的局部分支不得复活", () => {
  const STORE_SRC = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/store.ts"),
    "utf8",
  );

  it("forkAt 与 promptFork 体内既不打列表也不选中新 run", () => {
    for (const [start, end] of [
      ["async forkAt(parentRunId, atSpanId, value, execution, submission) {", "resetFork() {"],
      ["async promptFork(parentRunId, edit, submission) {", "async modelAb("],
    ] as const) {
      const at = STORE_SRC.indexOf(start);
      expect(at, start).toBeGreaterThan(-1);
      const body = STORE_SRC.slice(at, STORE_SRC.indexOf(end, at + 1));
      expect(body, start).not.toContain("get().loadRuns(");
      expect(body, start).not.toContain("get().selectRun(");
      // 收尾凭据只在消费点与关联转存处动：入口不碰草稿仓库
      expect(body, start).not.toContain("drafts");
    }
  });
});
