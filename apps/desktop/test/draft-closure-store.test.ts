import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { Envelope, ListRunsData, RunDetail, WindowApi } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import { CREATE_SUBMIT_TARGET, closureOf } from "../src/renderer/src/lib/draft-submission";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore } from "../src/renderer/src/lib/result-verification";
import { FAKE_EPOCH, statusSnapshot } from "./helpers/operation-channels";

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
