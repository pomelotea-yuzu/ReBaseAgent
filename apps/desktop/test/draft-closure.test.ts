import { describe, expect, it } from "vitest";
import type { CallDraftKey, ModelAbDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import { CREATE_SUBMIT_TARGET } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";

/**
 * U5（unify-run-execution-workflow）任务 2.1：**待定冻结**与**结果收尾关联**分离。
 *
 * 判据来源：design D3「解冻待定提交前转存这些最小元数据，正文仍只在 U3 草稿/原提交快照内；
 * 终止清理完成可释放关联，待读取则保留到 renderer 会话结束或显式放弃相关草稿。
 * 此关联不能授予执行资格」+ D5「解冻与清理分开」。
 * delta 侧对应「提交绑定草稿修订且响应不清除草稿」的三个既有场景（本轮作回归）：
 * 「提交快照独立于编辑器挂载」「成功错误和部分失败均保留草稿」「核对终态只解冻对应修订」。
 *
 * ⚠️ 为什么解冻后还要留一条关联：main 登记终态就解冻（用户能继续编辑），
 *    而"能不能把这份草稿删掉"要等详情读到手才知道（任务 1.2–1.4 的核实天然更晚）。
 *    解冻即丢元数据 ⇒ 自动清理永远不会发生（design 风险段第 1 条）。
 */

const EPOCH = "11111111-1111-1111-8111-111111111111";
const OP_A = "22222222-2222-2222-8222-222222222222";
const OP_B = "33333333-3333-3333-8333-333333333333";

const keyA: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "result" };
const keyB: CallDraftKey = { runId: "r_01", spanId: "s_03", field: "messages" };
const abKey: ModelAbDraftKey = { runId: "r_01", spanId: "s_02" };

interface BeginInput {
  target?: subLib.DraftSubmitTarget;
  channel?: subLib.DraftSubmitChannel;
  revision?: number;
  text?: string;
  operationId?: string;
  epoch?: string | null;
  armCount?: number | null;
}

function begin(store: subLib.SubmissionStore, input: BeginInput = {}) {
  return subLib.beginSubmission(store, {
    channel: input.channel ?? "result",
    target: input.target ?? keyA,
    submittedRevision: input.revision ?? 4,
    submittedText: input.text ?? "编辑后的结果正文",
    operationId: input.operationId ?? OP_A,
    epoch: input.epoch === undefined ? EPOCH : input.epoch,
    expectedArmCount: input.armCount ?? null,
  });
}

describe("settleSubmission：解冻即转成交收关联（不复制正文）", () => {
  it("带 main 身份的提交解冻后：byId 清空、closures 留下最小元数据", () => {
    const started = begin(subLib.emptySubmissionStore());
    const submission = started.submission as subLib.DraftSubmission;
    const settled = subLib.settleSubmission(started.store, submission);

    expect(subLib.submissionOf(settled, keyA)).toBeUndefined();
    const closure = subLib.closureOf(settled, EPOCH, OP_A);
    expect(closure).toEqual({
      id: `${EPOCH}|${OP_A}`,
      epoch: EPOCH,
      operationId: OP_A,
      target: keyA,
      targetKey: "r_01|s_03|result",
      channel: "result",
      submittedRevision: 4,
      token: submission.token,
      expectedArmCount: null,
    });
    // ⚠️ 正文一份都不复制（草稿与原提交快照各自已有）：字段集合是封闭的
    expect(Object.keys(closure ?? {}).sort()).toEqual([
      "channel",
      "epoch",
      "expectedArmCount",
      "id",
      "operationId",
      "submittedRevision",
      "target",
      "targetKey",
      "token",
    ]);
    expect(JSON.stringify(closure)).not.toContain("编辑后的结果正文");
  });

  it("没真正发出（epoch=null，本地门禁拦下）⇒ 不留关联：它没有结局可核对", () => {
    const started = begin(subLib.emptySubmissionStore(), { epoch: null });
    const settled = subLib.settleSubmission(
      started.store,
      started.submission as subLib.DraftSubmission,
    );
    expect(Object.keys(settled.closures)).toHaveLength(0);
    // 对照组：同一目标绑定 epoch 后再解冻就留得下来
    const bound = subLib.bindSubmissionEpoch(
      started.store,
      started.submission as subLib.DraftSubmission,
      EPOCH,
    );
    expect(
      Object.keys(
        subLib.settleSubmission(bound, started.submission as subLib.DraftSubmission).closures,
      ),
    ).toHaveLength(1);
  });

  it("旧回调（令牌不符）既不解冻也不生成关联（spec「核对终态只解冻对应修订」）", () => {
    const started = begin(subLib.emptySubmissionStore());
    const stale = { ...(started.submission as subLib.DraftSubmission), token: 999 };
    const after = subLib.settleSubmission(started.store, stale);
    expect(after).toBe(started.store);
    expect(subLib.submissionOf(after, keyA)).toBeDefined();
    expect(Object.keys(after.closures)).toHaveLength(0);
  });

  it("按身份解冻（reconcile 路径）同样转成关联；身份查不到 ⇒ 引用不变", () => {
    const started = begin(subLib.emptySubmissionStore());
    const byOp = subLib.settleSubmissionByOperation(started.store, EPOCH, OP_A);
    expect(subLib.submissionOf(byOp, keyA)).toBeUndefined();
    expect(subLib.closureOf(byOp, EPOCH, OP_A)?.targetKey).toBe("r_01|s_03|result");
    // 身份已被收尾 ⇒ 再核对一次不产生任何新状态
    expect(subLib.settleSubmissionByOperation(byOp, EPOCH, OP_A)).toBe(byOp);
    // 别的 epoch（旧会话）解不开当前关联
    const other = begin(subLib.emptySubmissionStore(), { target: keyB, operationId: OP_B });
    expect(
      subLib.settleSubmissionByOperation(other.store, "99999999-9999-9999-8999-999999999999", OP_B),
    ).toBe(other.store);
  });
});

describe("同目标的新提交作废旧关联（spec「同修订再次提交也不被旧操作清理」）", () => {
  it("旧操作已解冻留有关联 ⇒ 同目标再次提交后，旧关联不再在场", () => {
    let store = begin(subLib.emptySubmissionStore()).store;
    const first = subLib.submissionOf(store, keyA) as subLib.DraftSubmission;
    store = subLib.settleSubmission(store, first);
    expect(subLib.closureOf(store, EPOCH, first.operationId)).toBeDefined();

    const again = begin(store, { operationId: OP_B, revision: 4 });
    expect(subLib.closureOf(again.store, EPOCH, first.operationId)).toBeUndefined();
    expect(Object.keys(again.store.closures)).toHaveLength(0);
  });

  it("作废旧关联只针对**同一目标**：其他目标的关联原样在场", () => {
    let store = begin(subLib.emptySubmissionStore()).store;
    const other = begin(store, { target: keyB, operationId: OP_B }).store;
    store = subLib.settleSubmission(
      other,
      subLib.submissionOf(other, keyA) as subLib.DraftSubmission,
    );
    store = subLib.settleSubmission(
      store,
      subLib.submissionOf(store, keyB) as subLib.DraftSubmission,
    );
    expect(Object.keys(store.closures).sort()).toEqual([`${EPOCH}|${OP_A}`, `${EPOCH}|${OP_B}`]);
    // 同目标第三次提交 ⇒ 只清掉它自己那条旧关联
    const again = begin(store, {
      target: keyB,
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    expect(Object.keys(again.store.closures)).toEqual([`${EPOCH}|${OP_A}`]);
  });
});

describe("releaseClosure：清理完成后的释放，幂等且只删那一条", () => {
  function settled(): subLib.SubmissionStore {
    const started = begin(subLib.emptySubmissionStore());
    return subLib.settleSubmission(started.store, started.submission as subLib.DraftSubmission);
  }

  it("释放后关联不在场；再释放一次引用不变", () => {
    const store = settled();
    const released = subLib.releaseClosure(store, { epoch: EPOCH, operationId: OP_A });
    expect(subLib.closureOf(released, EPOCH, OP_A)).toBeUndefined();
    expect(subLib.releaseClosure(released, { epoch: EPOCH, operationId: OP_A })).toBe(released);
  });

  it("待定提交不受释放影响（两件事各自的生命周期）", () => {
    const started = begin(subLib.emptySubmissionStore());
    const after = subLib.releaseClosure(started.store, { epoch: EPOCH, operationId: OP_A });
    expect(after).toBe(started.store);
    expect(subLib.submissionOf(after, keyA)).toBeDefined();
  });
});

describe("批次预期信息：A/B 的预期臂数随关联留下（任务 2.4 的基准）", () => {
  it("A/B 提交解冻后关联带 expectedArmCount；创建草稿为 null", () => {
    const ab = begin(subLib.emptySubmissionStore(), {
      target: abKey,
      channel: "model_ab",
      armCount: 3,
    });
    const abStore = subLib.settleSubmission(ab.store, ab.submission as subLib.DraftSubmission);
    expect(subLib.closureOf(abStore, EPOCH, OP_A)).toMatchObject({
      targetKey: "r_01|s_02|model_ab",
      expectedArmCount: 3,
    });

    const create = begin(subLib.emptySubmissionStore(), {
      target: CREATE_SUBMIT_TARGET,
      channel: "create",
    });
    const createStore = subLib.settleSubmission(
      create.store,
      create.submission as subLib.DraftSubmission,
    );
    expect(subLib.closureOf(createStore, EPOCH, OP_A)?.expectedArmCount).toBeNull();
  });
});
