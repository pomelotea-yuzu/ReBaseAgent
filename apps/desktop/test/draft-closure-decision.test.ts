import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { ok } from "@shared/ipc";
import type { RunDetail } from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { CallDraftKey, DraftRepo } from "../src/renderer/src/lib/debugging-drafts";
import type { ModelAbDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import {
  applyDraftClosure,
  decideDraftClosure,
  draftStateOf,
  pendingTokenForTarget,
  verdictOfOperation,
} from "../src/renderer/src/lib/draft-closure";
import { CREATE_SUBMIT_TARGET } from "../src/renderer/src/lib/draft-submission";
import type * as subLib from "../src/renderer/src/lib/draft-submission";
import type { ResultReadEntry } from "../src/renderer/src/lib/result-verification";
import {
  emptyResultReadStore,
  resultReadEntryOf,
  setResultRead,
  verifyResultPayload,
} from "../src/renderer/src/lib/result-verification";

/**
 * U5（unify-run-execution-workflow）任务 2.2/2.4：**按提交修订清理草稿**的判据半边。
 *
 * 判据来源：delta「正常结束仅清理提交对应草稿修订」的六个场景 + design D5 的四道闸：
 * 结果核实正常 → 目标在场 → 修订逐字相同 → 无更晚令牌。
 *
 * ⚠️ 清理是唯一"删用户输入"的动作 ⇒ 每个"必须保留"的分支都配一条"齐备即清理"的对照，
 *    防止判据写成恒保留（那看着也"没丢数据"，实则 spec 要求的自动清理永远不发生）。
 */

const EPOCH = "11111111-1111-1111-8111-111111111111";
const OP_A = "22222222-2222-2222-8222-222222222222";
const RUN_A = "run_closure_a";
const RUN_B = "run_closure_b";

const keyA: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "result" };
const keyB: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "messages" };
const abKey: ModelAbDraftKey = { runId: "r_01", spanId: "s_02" };

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

function entryFor(
  runId: string,
  fixture: "u1-ok" | "u1-error-detail" | "u1-aborted" | "u1-crashed",
): ResultReadEntry {
  return resultReadEntryOf(verifyResultPayload(runId, ok(detailNamed(fixture, runId))), 1);
}
function unreadableEntry(runId: string): ResultReadEntry {
  return resultReadEntryOf(
    verifyResultPayload(runId, { ok: false, error: { code: "RUN_NOT_FOUND", message: "缺文件" } }),
    1,
  );
}
function readsOf(entries: Array<[string, ResultReadEntry]>) {
  let store = emptyResultReadStore();
  for (const [runId, entry] of entries) {
    store = setResultRead(store, { epoch: EPOCH, operationId: OP_A, runId }, entry);
  }
  return store;
}

function opRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: EPOCH,
    operationId: OP_A,
    target: {
      kind: "result",
      mode: "plain",
      parentRunId: "r_01",
      atSpanId: "s_03",
      editField: "result",
    },
    state: "settled",
    rejection: null,
    startedAt: "2026-09-27T00:00:00.000Z",
    settledAt: "2026-09-27T00:00:05.000Z",
    runIds: [RUN_A],
    experimentId: null,
    arms: [],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

function closureOf(overrides: Partial<subLib.SubmissionClosure> = {}): subLib.SubmissionClosure {
  return {
    id: `${EPOCH}|${OP_A}`,
    epoch: EPOCH,
    operationId: OP_A,
    target: keyA,
    targetKey: "r_01|s_03|result",
    channel: "result",
    submittedRevision: 4,
    token: 1,
    expectedArmCount: null,
    ...overrides,
  };
}

describe("verdictOfOperation：只有核实过的自有正常终止才算 normal", () => {
  it("单运行已核实正常结束 ⇒ normal（对照组）", () => {
    expect(
      verdictOfOperation(opRecord(), readsOf([[RUN_A, entryFor(RUN_A, "u1-ok")]]), null),
    ).toEqual({ kind: "normal", runIds: [RUN_A] });
  });

  it("成功信封但运行 error ⇒ 非正常，并带真实结局文字", () => {
    const verdict = verdictOfOperation(
      opRecord({ requestOutcome: "returned" }),
      readsOf([[RUN_A, entryFor(RUN_A, "u1-error-detail")]]),
      null,
    );
    expect(verdict.kind === "not-normal" && verdict.reason).toContain("出错终止");
  });

  it("中止与中断都不算正常结束", () => {
    for (const fixture of ["u1-aborted", "u1-crashed"] as const) {
      const verdict = verdictOfOperation(
        opRecord(),
        readsOf([[RUN_A, entryFor(RUN_A, fixture)]]),
        null,
      );
      expect(verdict.kind).toBe("not-normal");
    }
  });

  it("结果不可读与尚未读到 ⇒ 都保留输入，绝不等同于「没执行」", () => {
    const unreadable = verdictOfOperation(
      opRecord(),
      readsOf([[RUN_A, unreadableEntry(RUN_A)]]),
      null,
    );
    expect(unreadable.kind === "not-normal" && unreadable.reason).toContain("结果不可读");
    const missing = verdictOfOperation(opRecord(), emptyResultReadStore(), null);
    expect(missing.kind === "not-normal" && missing.reason).toContain("未读到结果");
  });

  it("settled 无身份 / notAccepted / running ⇒ 都拿不出结果结论", () => {
    const unlocated = verdictOfOperation(opRecord({ runIds: [] }), emptyResultReadStore(), null);
    expect(unlocated.kind === "not-normal" && unlocated.reason).toContain("未定位");
    const notAccepted = verdictOfOperation(
      opRecord({
        state: "notAccepted",
        runIds: [],
        startedAt: null,
        settledAt: null,
        requestOutcome: null,
        rejection: "busy",
      }),
      emptyResultReadStore(),
      null,
    );
    expect(notAccepted.kind === "not-normal" && notAccepted.reason).toContain("本次未接受");
    const running = verdictOfOperation(
      opRecord({ state: "running", runIds: [], settledAt: null, requestOutcome: null }),
      emptyResultReadStore(),
      null,
    );
    expect(running.kind === "not-normal" && running.reason).toContain("仍在执行");
  });
});

describe("verdictOfOperation：A/B 以提交时的预期臂数为基准", () => {
  const abTarget = { kind: "modelAb" as const, parentRunId: "r_01", armCount: 2 };
  const arm = (
    index: number,
    id: string | null,
    outcome: "returned" | "failed" | null = "returned",
  ) => ({ index, id, outcome });
  const abRecord = (arms: OperationRecord["arms"], runIds: string[]): OperationRecord =>
    opRecord({ target: abTarget, arms, runIds, experimentId: "exp_1" });

  it("两条预期臂各自核实正常结束 ⇒ 整批 normal", () => {
    const record = abRecord([arm(0, RUN_A), arm(1, RUN_B)], [RUN_A, RUN_B]);
    const reads = readsOf([
      [RUN_A, entryFor(RUN_A, "u1-ok")],
      [RUN_B, entryFor(RUN_B, "u1-ok")],
    ]);
    expect(verdictOfOperation(record, reads, 2)).toEqual({
      kind: "normal",
      runIds: [RUN_A, RUN_B],
    });
  });

  it("缺臂 / null ID / 失败臂 ⇒ 整批保留并指名那一条", () => {
    const cases: Array<[OperationRecord["arms"], string[], string]> = [
      [[arm(0, RUN_A)], [RUN_A], "第 1 臂缺席"],
      [[arm(0, RUN_A), arm(1, null)], [RUN_A], "第 1 臂没有可信运行 id"],
      [[arm(0, RUN_A), arm(1, RUN_B, "failed")], [RUN_A, RUN_B], "第 1 臂请求结局是 failed"],
    ];
    for (const [arms, runIds, expected] of cases) {
      const reads = readsOf(runIds.map((runId) => [runId, entryFor(runId, "u1-ok")]));
      const verdict = verdictOfOperation(abRecord(arms, runIds), reads, 2);
      expect(verdict.kind === "not-normal" && verdict.reason).toContain(expected);
    }
  });

  it("登记 arms 为空但预期两臂 ⇒ 不成立（空集合恒真就是这里的口子）", () => {
    const reads = readsOf([[RUN_A, entryFor(RUN_A, "u1-ok")]]);
    const verdict = verdictOfOperation(abRecord([], [RUN_A]), reads, 2);
    expect(verdict.kind === "not-normal" && verdict.reason).toContain("第 0 臂缺席");
    // 提交时没带臂数凭据（旧关联）⇒ 一律不判定整批：结果全读到了也不清
    const noBaseline = verdictOfOperation(
      abRecord([arm(0, RUN_A), arm(1, RUN_B)], [RUN_A, RUN_B]),
      readsOf([
        [RUN_A, entryFor(RUN_A, "u1-ok")],
        [RUN_B, entryFor(RUN_B, "u1-ok")],
      ]),
      null,
    );
    expect(noBaseline.kind === "not-normal" && noBaseline.reason).toContain("缺少提交时的预期臂数");
  });

  it("重复运行身份与缺实验身份都不算整批具备资格", () => {
    const reads = readsOf([
      [RUN_A, entryFor(RUN_A, "u1-ok")],
      [RUN_B, entryFor(RUN_B, "u1-ok")],
    ]);
    const duplicated = verdictOfOperation(
      abRecord([arm(0, RUN_A), arm(1, RUN_A)], [RUN_A, RUN_B]),
      reads,
      2,
    );
    expect(duplicated.kind === "not-normal" && duplicated.reason).toContain("重复运行 id");
    const noExperiment = verdictOfOperation(
      { ...abRecord([arm(0, RUN_A), arm(1, RUN_B)], [RUN_A, RUN_B]), experimentId: null },
      reads,
      2,
    );
    expect(noExperiment.kind === "not-normal" && noExperiment.reason).toContain("实验身份");
  });

  it("一条臂不可读 ⇒ 整批保留（部分成功不冒充全臂成功）", () => {
    const record = abRecord([arm(0, RUN_A), arm(1, RUN_B)], [RUN_A, RUN_B]);
    const reads = readsOf([
      [RUN_A, entryFor(RUN_A, "u1-ok")],
      [RUN_B, unreadableEntry(RUN_B)],
    ]);
    const verdict = verdictOfOperation(record, reads, 2);
    expect(verdict.kind === "not-normal" && verdict.reason).toContain(RUN_B);
  });
});

describe("decideDraftClosure：四道闸各有对照组", () => {
  const normal = { kind: "normal", runIds: [RUN_A] } as const;

  it("目标在场 + 修订相同 + 结局正常 + 无更晚提交 ⇒ clean", () => {
    expect(
      decideDraftClosure({
        closure: closureOf({ submittedRevision: 4 }),
        draft: { exists: true, revision: 4 },
        verdict: normal,
        pendingToken: null,
      }),
    ).toMatchObject({ kind: "clean" });
  });

  it("修订推进 ⇒ 保留（判据只看修订，内容改回一样也不算）", () => {
    const decision = decideDraftClosure({
      closure: closureOf({ submittedRevision: 4 }),
      draft: { exists: true, revision: 5 },
      verdict: normal,
      pendingToken: null,
    });
    expect(decision.kind).toBe("keep");
    expect(decision.reason).toContain("草稿修订已推进");
  });

  it("更晚令牌的待定提交 ⇒ 旧操作无权清理；令牌相同仍可清理", () => {
    expect(
      decideDraftClosure({
        closure: closureOf({ token: 3 }),
        draft: { exists: true, revision: 4 },
        verdict: normal,
        pendingToken: 4,
      }).reason,
    ).toContain("更晚的提交");
    expect(
      decideDraftClosure({
        closure: closureOf({ token: 5 }),
        draft: { exists: true, revision: 4 },
        verdict: normal,
        pendingToken: 5,
      }).kind,
    ).toBe("clean");
  });

  it("结局非正常 ⇒ 保留；草稿已不在场 ⇒ 只释放关联", () => {
    expect(
      decideDraftClosure({
        closure: closureOf(),
        draft: { exists: true, revision: 4 },
        verdict: { kind: "not-normal", reason: "超出预算" },
        pendingToken: null,
      }),
    ).toMatchObject({ kind: "keep", reason: "超出预算" });
    expect(
      decideDraftClosure({
        closure: closureOf(),
        draft: { exists: false, revision: -1 },
        verdict: normal,
        pendingToken: null,
      }).kind,
    ).toBe("release");
  });

  it("pendingTokenForTarget 只看同一个目标", () => {
    const byId = { "r_01|s_03|result": { token: 9 } };
    expect(pendingTokenForTarget(byId, closureOf())).toBe(9);
    expect(
      pendingTokenForTarget(byId, closureOf({ target: keyB, targetKey: "r_01|s_03|messages" })),
    ).toBeNull();
  });

  it("draftStateOf 三类草稿同源读修订", () => {
    let repo = draftLib.ensureCallDraft(draftLib.emptyDraftRepo(), keyA, "原结果").repo;
    repo = draftLib.writeCallDraftText(repo, keyA, "编辑后的结果");
    expect(draftStateOf(repo, keyA)).toEqual({
      exists: true,
      revision: repo.calls.r_01?.s_03?.result?.revision,
    });
    expect(draftStateOf(repo, keyB)).toEqual({ exists: false, revision: -1 });
    repo = draftLib.ensureCreateRunDraft(repo).repo;
    expect(draftStateOf(repo, CREATE_SUBMIT_TARGET).exists).toBe(true);
    const ab = draftLib.ensureModelAbDraft(repo, abKey, [{ model: "m", paramsText: "{}" }]).repo;
    expect(draftStateOf(ab, abKey)).toMatchObject({ exists: true, revision: expect.any(Number) });
  });
});

describe("applyDraftClosure：只清匹配的那一份，其他草稿不动", () => {
  function repoWithDrafts(): DraftRepo {
    let repo = draftLib.ensureCallDraft(draftLib.emptyDraftRepo(), keyA, "原结果").repo;
    repo = draftLib.writeCallDraftText(repo, keyA, "编辑后的结果");
    repo = draftLib.ensureCallDraft(repo, keyB, "原 messages").repo;
    repo = draftLib.writeCallDraftText(repo, keyB, "[]");
    repo = draftLib.ensureCreateRunDraft(repo).repo;
    return draftLib.writeCreateRunDraft(repo, { userMessage: "长任务" });
  }

  it("调用类清理只删该目标：同 run 另一字段与创建草稿原样在场", () => {
    const repo = repoWithDrafts();
    const revision = draftLib.callDraftOf(repo, keyA)?.revision as number;
    const applied = applyDraftClosure(repo, closureOf({ submittedRevision: revision }), {
      kind: "clean",
      reason: "测试",
    });
    expect(applied.cleaned).toBe(true);
    expect(draftLib.callDraftOf(applied.repo, keyA)).toBeUndefined();
    expect(draftLib.callDraftOf(applied.repo, keyB)?.text).toBe("[]");
    expect(applied.repo.create?.userMessage).toBe("长任务");
  });

  it("修订不符时 CAS 拒绝删除：仓库引用不变", () => {
    const repo = repoWithDrafts();
    const applied = applyDraftClosure(repo, closureOf({ submittedRevision: 999 }), {
      kind: "clean",
      reason: "测试",
    });
    expect(applied.cleaned).toBe(false);
    expect(applied.repo).toBe(repo);
  });

  it("非 clean 决定一律不删", () => {
    const repo = repoWithDrafts();
    expect(applyDraftClosure(repo, closureOf(), { kind: "keep", reason: "结局非正常" })).toEqual({
      repo,
      cleaned: false,
      reason: "结局非正常",
    });
  });

  it("创建清整份表单；A/B 清整批（不逐臂）", () => {
    const repo = repoWithDrafts();
    const createRevision = repo.create?.revision as number;
    const createApplied = applyDraftClosure(
      repo,
      closureOf({
        target: CREATE_SUBMIT_TARGET,
        targetKey: "|create",
        channel: "create",
        submittedRevision: createRevision,
      }),
      { kind: "clean", reason: "测试" },
    );
    expect(createApplied.cleaned).toBe(true);
    expect(createApplied.repo.create).toBeNull();

    let abRepo = draftLib.ensureModelAbDraft(repo, abKey, [
      { model: "m-a", paramsText: "{}" },
      { model: "m-b", paramsText: "{}" },
    ]).repo;
    abRepo = draftLib.setModelAbRows(abRepo, abKey, [
      { key: "arm-1", model: "m-a", paramsText: "{}" },
      { key: "arm-2", model: "m-b", paramsText: '{"temperature":1}' },
    ]);
    const abRevision = draftLib.modelAbDraftOf(abRepo, abKey)?.revision as number;
    const abApplied = applyDraftClosure(
      abRepo,
      closureOf({
        target: abKey,
        targetKey: "r_01|s_02|model_ab",
        channel: "model_ab",
        submittedRevision: abRevision,
      }),
      { kind: "clean", reason: "测试" },
    );
    expect(abApplied.cleaned).toBe(true);
    expect(draftLib.modelAbDraftOf(abApplied.repo, abKey)).toBeUndefined();
  });
});
