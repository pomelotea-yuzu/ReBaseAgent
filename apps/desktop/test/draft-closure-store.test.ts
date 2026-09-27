import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey, ModelAbDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import { CREATE_SUBMIT_TARGET, closureOf } from "../src/renderer/src/lib/draft-submission";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { stripComments } from "../src/renderer/src/lib/overview-view";
import { emptyResultReadStore, resultReadKeyOf } from "../src/renderer/src/lib/result-verification";
import { FAKE_EPOCH, statusSnapshot, toExecuted } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 2.2 的 **store 接线**：
 * 核实到自有正常终止 ⇒ 按提交修订清理草稿；任何不确定性都保留输入。
 *
 * 判据来源：delta「正常结束仅清理提交对应草稿修订」的
 *   - 「单运行正常结束清理匹配修订」——只清该目标，其他草稿不受影响
 *   - 「解冻后修改不被旧结果删除」——旧结果晚到时新修订逐字保留
 *   - 「成功错误和部分失败均保留草稿」（清理只在独立核实之后）
 * tasks 2.2 另要求"包括创建对应目录引用"。
 *
 * ⚠️ 全部经**真实 store 动作**驱动（`beginDraftSubmission` + `refreshOperationStatus` +
 *    `retryResultRead`），不直接调 lib——判据在 lib 里绿不代表接上了消费点（工程约定
 *    「import 了但没消费 = 功能缺口」）。
 */

const KEY_A: CallDraftKey = { runId: "run_viewing", spanId: "s_03", field: "result" };
const KEY_B: CallDraftKey = { runId: "run_viewing", spanId: "s_03", field: "messages" };
const TRUSTED = "run_from_registry";
const OTHER_TRUSTED = "run_other_arm";
/** A/B 两臂的可信运行 id */
const RUN_A = "run_arm_a";
const RUN_B = "run_arm_b";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
function detailNamed(fixture: string, id: string): RunDetail {
  const record: RunRecord = readRun(resolve(FIXTURE_DIR, `${fixture}.jsonl`));
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

const calls: string[] = [];
let registry: () => OperationRecord[] = () => [];
let registryVersion = 1;
/** 详情按 id 给不同结论（默认正常结束的那条） */
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

/** 默认 status 应答：按 `registry()` 出快照（用例可临时替换成新 epoch/失联） */
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
    return details[id] ?? ok(detailNamed("u1-ok", id));
  },
  operationsStatus: defaultStatusHandler(),
  operationsReconcile: async () => ({
    ok: false as const,
    error: { code: "NOT_STUBBED", message: "本桩未实现核对" },
  }),
  selectDirectory: async () => ok(null),
  forkRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  promptFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  proxyFork: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  createRun: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  modelAb: async () => ({ ok: false as const, error: { code: "UNUSED", message: "默认桩" } }),
  modelAbPlan: async () =>
    ok({ experimentId: "e", ids: [], ok: true, plan: [], sideEffectsAllowed: false }),
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

/** 打开编辑器 → 编辑 → 登记提交关联（与 DetailPanel 的调用序同形） */
function submitDraft(key: CallDraftKey, text: string) {
  const store = useAppStore.getState();
  store.ensureCallDraft(key, "原结果", undefined);
  store.writeCallDraftText(key, text);
  const submission = store.beginDraftSubmission({ channel: "result", target: key });
  if (submission === null) throw new Error("unreachable：应能登记提交关联");
  return submission;
}

beforeEach(async () => {
  calls.length = 0;
  registryVersion = 1;
  details = {};
  registry = () => [];
  // 上一支用例可能替换过 status 实现（换 epoch / 失联）⇒ 每支都从默认应答开始
  apiStub.operationsStatus = defaultStatusHandler();
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: { byId: {}, closures: {}, nextToken: 1 },
    createSourceRef: null,
    createDialogOpen: false,
    runs: [],
    failed: [],
    listLoaded: false,
    listStale: false,
    error: null,
    selectedRunId: null,
    detail: null,
    readingByRun: {},
  });
  await useAppStore.getState().refreshOperationStatus();
});

describe("2.2 单运行正常终止后的原子修订清理", () => {
  it("核实到自有 stopped/completed ⇒ 清掉匹配修订，同 run 另一字段与创建草稿不动", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    // 另一份草稿：同一步的 messages 字段 + 整份创建表单（都必须原样留下）
    const store = useAppStore.getState();
    store.ensureCallDraft(KEY_B, "原 messages", undefined);
    store.writeCallDraftText(KEY_B, '[{"role":"user"}]');
    store.ensureCreateRunDraft();
    store.writeCreateRunDraft({ userMessage: "长任务" });
    useAppStore.setState({
      createSourceRef: { token: "tok", name: "src", path: "D:/x/src" },
    });
    registry = () => [settledRecord({ operationId: submission.operationId })];
    calls.length = 0;

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)).toBeUndefined();
    expect(draftLib.callDraftOf(state.drafts, KEY_B)?.text).toBe('[{"role":"user"}]');
    expect(state.drafts.create?.userMessage).toBe("长任务");
    // 非创建入口的清理不得顺手清掉目录引用
    expect(state.createSourceRef).not.toBeNull();
    // 关联已释放（收尾完成），读取项留着"已核实"
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeUndefined();
    expect(calls).toContain(`runs:get:${TRUSTED}`);
  });

  it("创建入口正常结束 ⇒ 整份表单与这次提交的目录引用一并清理", async () => {
    const store = useAppStore.getState();
    store.ensureCreateRunDraft();
    store.writeCreateRunDraft({ userMessage: "隔离任务" });
    const submission = store.beginDraftSubmission({
      channel: "create",
      target: CREATE_SUBMIT_TARGET,
    });
    if (submission === null) throw new Error("unreachable：应能登记创建提交");
    useAppStore.setState({
      createSourceRef: { token: "tok", name: "src", path: "D:/x/src" },
    });
    registry = () => [
      settledRecord({
        operationId: submission.operationId,
        target: { kind: "create", mode: "isolated" },
      }),
    ];

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(state.drafts.create).toBeNull();
    expect(state.createSourceRef).toBeNull();
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeUndefined();
  });

  it("运行 error / 中止 / 不可读 ⇒ 草稿逐字保留，关联留着等下一次核实", async () => {
    const cases: Array<[string, Envelope<RunDetail> | undefined]> = [
      ["u1-error-detail", undefined],
      ["u1-aborted", undefined],
      ["unreadable", { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } }],
    ];
    for (const [fixture, envelope] of cases) {
      useAppStore.setState({
        drafts: draftLib.emptyDraftRepo(),
        draftSubmissions: { byId: {}, closures: {}, nextToken: 1 },
        resultReads: emptyResultReadStore(),
      });
      const submission = submitDraft(KEY_A, "编辑后的结果");
      details =
        envelope === undefined
          ? { [TRUSTED]: ok(detailNamed(fixture, TRUSTED)) }
          : { [TRUSTED]: envelope };
      registry = () => [settledRecord({ operationId: submission.operationId })];

      await useAppStore.getState().refreshOperationStatus();

      const state = useAppStore.getState();
      expect(draftLib.callDraftOf(state.drafts, KEY_A)?.text).toBe("编辑后的结果");
      expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
    }
  });

  it("解冻后用户又改了草稿 ⇒ 迟到的正常结果不清新修订（内容改回一样也不清）", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    // 第一次核实：不可读 ⇒ 解冻但保留输入
    details = { [TRUSTED]: { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } } };
    registry = () => [settledRecord({ operationId: submission.operationId })];
    await useAppStore.getState().refreshOperationStatus();
    expect(useAppStore.getState().isDraftFrozen(KEY_A)).toBe(false);

    // 用户在解冻后继续编辑（修订推进），然后把文本改回提交时的原样
    useAppStore.getState().writeCallDraftText(KEY_A, "临时改动");
    useAppStore.getState().writeCallDraftText(KEY_A, "编辑后的结果");
    // 结果现在可读了，而且是正常结束
    details = { [TRUSTED]: ok(detailNamed("u1-ok", TRUSTED)) };
    const entry = await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });
    expect(entry.facts?.normalEnd).toBe(true);

    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)?.text).toBe("编辑后的结果");
    // 判据是修订而不是内容：关联仍在（等下一次真正匹配修订的核实）
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)?.revision).toBeGreaterThan(
      submission.submittedRevision,
    );
  });

  it("同目标被更晚的提交接管 ⇒ 旧操作即使核实正常也不清理（草稿归新提交冻结）", async () => {
    const first = submitDraft(KEY_A, "第一次提交的内容");
    registry = () => [settledRecord({ operationId: first.operationId })];
    // 先只解冻（running→settled 的 status 消费会顺带读取；这里让它读不到结果以留关联）
    details = { [TRUSTED]: { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } } };
    await useAppStore.getState().refreshOperationStatus();
    const closure = closureOf(
      useAppStore.getState().draftSubmissions,
      FAKE_EPOCH,
      first.operationId,
    );
    expect(closure).toBeDefined();

    // 用户在新一次提交里改了内容并再次提交（更新令牌 + 新身份）
    useAppStore.getState().writeCallDraftText(KEY_A, "第二次提交的内容");
    const second = useAppStore
      .getState()
      .beginDraftSubmission({ channel: "result", target: KEY_A });
    if (second === null) throw new Error("unreachable：应能再次登记");
    // 同目标新提交 ⇒ 旧关联作废（第二道闸 pendingToken 由纯判据用例钉住；这里两道都在场，
    // 摘掉任一道另一道仍会拦住——所以两道各自都有独立的判据用例）
    expect(
      closureOf(useAppStore.getState().draftSubmissions, FAKE_EPOCH, first.operationId),
    ).toBeUndefined();

    // 旧操作的迟到读取现在成功且正常结束 ⇒ 一个字都不删
    details = { [TRUSTED]: ok(detailNamed("u1-ok", TRUSTED)) };
    await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: first.operationId,
      runId: TRUSTED,
    });
    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)?.text).toBe("第二次提交的内容");
    expect(state.isDraftFrozen(KEY_A)).toBe(true);
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, second.operationId)).toBeUndefined();
  });

  it("清理幂等：重复 status 与重复读取重试都不再产生第二次删除", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    await useAppStore.getState().refreshOperationStatus();
    expect(draftLib.callDraftOf(useAppStore.getState().drafts, KEY_A)).toBeUndefined();
    const repoAfterClean = useAppStore.getState().drafts;

    await useAppStore.getState().refreshOperationStatus();
    await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });
    // 仓库引用不变（没有第二次删除），也不会"顺手"删掉别的草稿
    expect(useAppStore.getState().drafts).toBe(repoAfterClean);
    expect(useAppStore.getState().drafts.create).toBeNull();
  });

  it("另一条操作的核实不影响本目标的草稿（按身份各管各的）", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    const other = settledRecord({
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runIds: [OTHER_TRUSTED],
    });
    details = { [OTHER_TRUSTED]: { ok: false, error: { code: "X", message: "坏" } } };
    registry = () => [other];
    await useAppStore.getState().refreshOperationStatus();
    // 别的操作核实失败 ⇒ 本目标的待定提交与草稿都不动
    expect(draftLib.callDraftOf(useAppStore.getState().drafts, KEY_A)?.text).toBe("编辑后的结果");
    expect(useAppStore.getState().isDraftFrozen(KEY_A)).toBe(true);
    expect(submission.operationId).not.toBe(other.operationId);
  });
});

describe("2.3 显式放弃、重建与旧会话：不确定就不删", () => {
  it("显式放弃 ⇒ 关联一并释放；重建同目标草稿后，迟到结果也不误删", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    details = { [TRUSTED]: { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } } };
    registry = () => [settledRecord({ operationId: submission.operationId })];
    await useAppStore.getState().refreshOperationStatus();
    const withClosure = useAppStore.getState();
    expect(
      closureOf(withClosure.draftSubmissions, FAKE_EPOCH, submission.operationId),
    ).toBeDefined();

    // 用户显式放弃（解冻后才允许）⇒ 条目与关联一起走
    const revision = withClosure.callDraftOf(KEY_A)?.revision as number;
    expect(useAppStore.getState().discardCallDraft(KEY_A, revision)).toBe(true);
    const afterDiscard = useAppStore.getState();
    expect(draftLib.callDraftOf(afterDiscard.drafts, KEY_A)).toBeUndefined();
    expect(
      closureOf(afterDiscard.draftSubmissions, FAKE_EPOCH, submission.operationId),
    ).toBeUndefined();

    // 重建同目标草稿（单调修订，绝不复用旧修订）⇒ 迟到的正常结果没有可清理的凭据
    useAppStore.getState().ensureCallDraft(KEY_A, "原结果", undefined);
    useAppStore.getState().writeCallDraftText(KEY_A, "编辑后的结果");
    details = { [TRUSTED]: ok(detailNamed("u1-ok", TRUSTED)) };
    await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });
    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)?.text).toBe("编辑后的结果");
    expect((draftLib.callDraftOf(state.drafts, KEY_A)?.revision as number) > revision).toBe(true);
  });

  it("旧 main 会话的关联：换新 epoch 后迟到的正常结果也不清理", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    // 第一次核实读不到 ⇒ 解冻但保留输入与关联（关联属于当前 FAKE_EPOCH）
    details = { [TRUSTED]: { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } } };
    registry = () => [settledRecord({ operationId: submission.operationId })];
    await useAppStore.getState().refreshOperationStatus();
    expect(
      closureOf(useAppStore.getState().draftSubmissions, FAKE_EPOCH, submission.operationId),
    ).toBeDefined();

    // main 换新会话：epoch 变了、旧登记不在新快照里（旧操作结局永久未知）
    registry = () => [];
    const NEW_EPOCH = "99999999-9999-9999-8999-999999999999";
    apiStub.operationsStatus = async () => {
      calls.push("operations:status");
      registryVersion += 1;
      return ok(statusSnapshot({ epoch: NEW_EPOCH, registryVersion, operations: [] }));
    };
    await useAppStore.getState().refreshOperationStatus();
    expect(useAppStore.getState().operations.epoch).toBe(NEW_EPOCH);

    // 旧身份的结果现在读得到且正常结束 ⇒ 仍不得清理（只结当前会话的账）
    details = { [TRUSTED]: ok(detailNamed("u1-ok", TRUSTED)) };
    const entry = await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });
    expect(entry.facts?.normalEnd).toBe(true);
    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)?.text).toBe("编辑后的结果");
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
  });

  it("通信未知时即使核实到正常结束也不清理（先确认通信，再谈删输入）", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    details = { [TRUSTED]: { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } } };
    await useAppStore.getState().refreshOperationStatus();
    // 让通道失联一次 ⇒ unknown；此时任何收尾都不该发生
    apiStub.operationsStatus = async () => ({
      ok: false as const,
      error: { code: "STATUS_FAILED", message: "断开" },
    });
    await useAppStore.getState().refreshOperationStatus();
    expect(useAppStore.getState().operations.unknown).toBe(true);

    details = { [TRUSTED]: ok(detailNamed("u1-ok", TRUSTED)) };
    await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });
    expect(draftLib.callDraftOf(useAppStore.getState().drafts, KEY_A)?.text).toBe("编辑后的结果");
    expect(
      closureOf(useAppStore.getState().draftSubmissions, FAKE_EPOCH, submission.operationId),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 任务 2.4：A/B 预期臂完整性核对与整批清理
// ---------------------------------------------------------------------------
const AB_KEY: ModelAbDraftKey = { runId: "run_viewing", spanId: "s_02" };
const AB_TARGET = { kind: "modelAb" as const, parentRunId: "run_viewing", armCount: 2 };

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

/** 整批草稿（两臂）+ 提交关联；返回本次提交的关联 */
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

describe("2.4 A/B 批次：全部预期臂正常才清整批", () => {
  it("两条预期臂各自核实正常结束 ⇒ 整批一次清干净（不逐臂删配置）", async () => {
    const submission = beginAbBatch();
    expect(submission.expectedArmCount).toBe(2);
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
    calls.length = 0;

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(draftLib.modelAbDraftOf(state.drafts, AB_KEY)).toBeUndefined();
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeUndefined();
    // 两条臂各读一次，都走只读通道；列表只刷一次
    expect(calls.filter((one) => one === `runs:get:${RUN_A}`)).toHaveLength(1);
    expect(calls.filter((one) => one === `runs:get:${RUN_B}`)).toHaveLength(1);
    expect(calls.filter((one) => one === "runs:list")).toHaveLength(1);
  });

  it("缺臂 / null ID / 失败臂 ⇒ 整批配置与关联都保留", async () => {
    const cases: Array<[OperationRecord["arms"], string[]]> = [
      [[{ index: 0, id: RUN_A, outcome: "returned" }], [RUN_A]],
      [
        [
          { index: 0, id: RUN_A, outcome: "returned" },
          { index: 1, id: null, outcome: null },
        ],
        [RUN_A],
      ],
      [
        [
          { index: 0, id: RUN_A, outcome: "returned" },
          { index: 1, id: RUN_B, outcome: "failed" },
        ],
        [RUN_A, RUN_B],
      ],
    ];
    for (const [arms, runIds] of cases) {
      useAppStore.setState({
        drafts: draftLib.emptyDraftRepo(),
        draftSubmissions: { byId: {}, closures: {}, nextToken: 1 },
        resultReads: emptyResultReadStore(),
      });
      const submission = beginAbBatch();
      registry = () => [abRecord(arms, runIds, { operationId: submission.operationId })];
      await useAppStore.getState().refreshOperationStatus();
      const state = useAppStore.getState();
      expect(draftLib.modelAbDraftOf(state.drafts, AB_KEY)?.rows).toHaveLength(2);
      expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
    }
  });

  it("一条臂结果不可读 ⇒ 整批保留（部分成功不冒充全臂成功）", async () => {
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
    details = {
      [RUN_A]: ok(detailNamed("u1-ok", RUN_A)),
      [RUN_B]: { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } },
    };

    await useAppStore.getState().refreshOperationStatus();

    const state = useAppStore.getState();
    expect(draftLib.modelAbDraftOf(state.drafts, AB_KEY)?.rows).toHaveLength(2);
    // 已读到的那条臂的结论照常在场（不因为它正常就清整批）
    const readA =
      state.resultReads.byKey[
        resultReadKeyOf({ epoch: FAKE_EPOCH, operationId: submission.operationId, runId: RUN_A })
      ];
    expect(readA?.facts?.normalEnd).toBe(true);
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
  });

  it("执行信封把 ids 全带回来，但登记与核实未跟上 ⇒ 整批保留", async () => {
    const submission = beginAbBatch();
    // 真实执行：信封回了两条 id，但登记快照里还没有这条操作的事实
    apiStub.modelAb = async (envelope: { operation: { epoch: string; operationId: string } }) =>
      toExecuted(
        ok({
          experimentId: "exp_1",
          ids: [RUN_A, RUN_B],
          ok: true,
          plan: [],
          sideEffectsAllowed: false,
        }),
        envelope.operation,
      );
    const result = await useAppStore.getState().modelAb("run_viewing", [], false, submission);
    expect(result?.ids).toEqual([RUN_A, RUN_B]);
    const state = useAppStore.getState();
    // spec「IPC 返回 ID 不能触发清理」：没有独立核实的正常终止 ⇒ 整批一字不动
    expect(draftLib.modelAbDraftOf(state.drafts, AB_KEY)?.rows).toHaveLength(2);
    expect(Object.keys(state.resultReads.byKey)).toHaveLength(0);
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeDefined();
  });

  it("dry-run 预览既不登记新关联也不读结果", async () => {
    const submission = beginAbBatch();
    // 预览不占提交口：走 modelAbPlan 只读通道
    const plan = await useAppStore.getState().modelAb("run_viewing", [], true);
    expect(plan).not.toBeNull();
    const state = useAppStore.getState();
    expect(draftLib.modelAbDraftOf(state.drafts, AB_KEY)?.rows).toHaveLength(2);
    // 预览不是提交：既没有新关联，也不动已在场的那条待定提交的冻结
    expect(Object.keys(state.draftSubmissions.closures)).toHaveLength(0);
    expect(state.isDraftFrozen(AB_KEY)).toBe(true);
    expect(submission.channel).toBe("model_ab");
    expect(Object.keys(state.resultReads.byKey)).toHaveLength(0);
    expect(calls.filter((one) => one.startsWith("runs:get"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 任务 2.5：失败与读取恢复**分别**收尾的接线反证
// ---------------------------------------------------------------------------
describe("2.5 读取恢复后清理：只读通道、组件无关", () => {
  /** 主动执行通道被调用的次数（读取重试必须是零增量） */
  function execCalls(): number {
    return calls.filter((one) =>
      ["runs:fork", "runs:promptFork", "proxy:fork", "runs:create", "runs:modelAb"].includes(one),
    ).length;
  }

  it("运行失败 ⇒ 保留；只读重试读到正常终止 ⇒ 才清理，全程零执行调用", async () => {
    const submission = submitDraft(KEY_A, "编辑后的结果");
    registry = () => [settledRecord({ operationId: submission.operationId })];
    details = { [TRUSTED]: ok(detailNamed("u1-error-detail", TRUSTED)) };

    await useAppStore.getState().refreshOperationStatus();

    const afterFailure = useAppStore.getState();
    expect(afterFailure.callDraftOf(KEY_A)?.text).toBe("编辑后的结果");
    expect(
      closureOf(afterFailure.draftSubmissions, FAKE_EPOCH, submission.operationId),
    ).toBeDefined();
    /**
     * U5 3.4 起，这一轮"留在流程内 + 首次自动读取可读"会由**导航协调器**跳到那条记录
     * （失败也进概览，spec「留在当前流程可进入成功或失败概览」）。本用例关心的是
     * **只读重试不再产生任何导航** ⇒ 判据改成"重试前后选择不变"，而不是"从头就没跳过"。
     */
    const navigatedByStatus = afterFailure.selectedRunId;
    const before = { exec: execCalls(), list: calls.filter((one) => one === "runs:list").length };

    // 组件侧复位（等价于编辑器卸载、局部 forking 状态清空）——收尾归 store，不靠挂载中的组件
    useAppStore.getState().resetFork();
    details = { [TRUSTED]: ok(detailNamed("u1-ok", TRUSTED)) };
    const restored = await useAppStore.getState().retryResultRead({
      epoch: FAKE_EPOCH,
      operationId: submission.operationId,
      runId: TRUSTED,
    });

    expect(restored.facts?.normalEnd).toBe(true);
    const state = useAppStore.getState();
    expect(draftLib.callDraftOf(state.drafts, KEY_A)).toBeUndefined();
    expect(closureOf(state.draftSubmissions, FAKE_EPOCH, submission.operationId)).toBeUndefined();
    // 只读重试：执行通道零增量，也不额外刷列表
    expect(execCalls()).toBe(before.exec);
    expect(calls.filter((one) => one === "runs:list")).toHaveLength(before.list);
    // 读取重试不产生导航：选择项与状态视图都不被它改动（结果清理与"跳到那次结果"是两件事）
    expect(state.selectedRunId).toBe(navigatedByStatus);
    expect(state.view).toBe("trace");
  });

  it("源码级接线契约：清理判据只在 store 里被消费，组件不复写第二份", () => {
    const storeSrc = stripComments(
      readFileSync(resolve(import.meta.dirname, "../src/renderer/src/store.ts"), "utf8"),
    );
    // 1) 读取结论落地后尝试收尾；终态消费末尾再补一轮 ⇒ 两处消费点
    const consumers = storeSrc.match(/closeDraftClosureFor\(/g) ?? [];
    expect(consumers.length).toBeGreaterThanOrEqual(3); // 定义 + 两处调用
    // 2) 组件侧不得出现清理判据（否则"响应即清草稿"的旧分支会复活）
    const componentDir = resolve(import.meta.dirname, "../src/renderer/src/components");
    const offenders = readdirSync(componentDir)
      .filter((name) => name.endsWith(".tsx"))
      .map(
        (name) => [name, stripComments(readFileSync(resolve(componentDir, name), "utf8"))] as const,
      )
      .filter(([, src]) =>
        /applyDraftClosure|decideDraftClosure|verdictOfOperation|releaseClosure\s*\(/.test(src),
      )
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
