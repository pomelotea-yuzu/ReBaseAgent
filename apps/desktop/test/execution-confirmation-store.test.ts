import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ok } from "@shared/ipc";
import type { WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import { CREATE_SUBMIT_TARGET } from "../src/renderer/src/lib/draft-submission";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { emptyConfirmationStore } from "../src/renderer/src/lib/execution-confirmation";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore } from "../src/renderer/src/lib/result-verification";
import { installOperationChannels } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 4.4 的 **store 接线**：执行确认作为一次性凭据。
 *
 * 判据来源：design D2 + delta「执行前检查和确认保持各入口真实语义」的场景
 * 「创建和普通重跑只声明已完成的检查」「返回修改与设置往返撤销旧确认」。
 * 纯判据在 `execution-confirmation.test.ts`；本份只钉**接线**：现场绑定由 store 现取
 * （组件传不进旧值）、登记口拒绝不成立的确认、确认登记即被消费。
 */

const apiStub: Record<string, unknown> = {
  // 本文件的动作全部不碰 IPC（确认与登记都是会话内状态），通道用共享桩即可
  listRuns: async () => ok({ runs: [], failed: [] }),
  getRun: async () => ok(null),
};
installOperationChannels(apiStub);
(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const stateOf = () => useAppStore.getState();
const binding = () => stateOf().currentConfirmationBinding("create", CREATE_SUBMIT_TARGET);

beforeEach(() => {
  useAppStore.setState({
    operations: initialSession(),
    resultReads: emptyResultReadStore(),
    drafts: draftLib.emptyDraftRepo(),
    draftSubmissions: subLib.emptySubmissionStore(),
    confirmations: emptyConfirmationStore(),
    checkGenerations: {},
    navIntents: { byOperationId: {} },
    navGeneration: 0,
    view: "trace",
    createReturnLocation: null,
    selectedRunId: null,
    detail: null,
    runs: [],
    failed: [],
    listLoaded: false,
    error: null,
    settings: null,
    proxy: null,
  });
});

/** 建一份可提交的创建草稿（未提交态） */
function seedCreateDraft(userMessage: string): void {
  stateOf().ensureCreateRunDraft();
  stateOf().writeCreateRunDraft({ userMessage });
}

describe("4.4 现场确认绑定由 store 现取", () => {
  it("没有草稿条目 ⇒ 修订是 -1（不猜一个 0 出来当作可确认的现场）", () => {
    expect(binding().revision).toBe(-1);
  });

  it("改输入推进修订 ⇒ 之前那次确认当场不再成立（无需谁去清）", () => {
    seedCreateDraft("第一版任务");
    stateOf().armExecutionConfirmation(binding());
    expect(stateOf().executionConfirmationReady(binding())).toBe(true);

    stateOf().writeCreateRunDraft({ userMessage: "第二版任务" });

    expect(stateOf().executionConfirmationReady(binding())).toBe(false);
  });

  it("换视图 / 进设置 / 常规打开设置 ⇒ 撤销待用的确认（离开现场）", () => {
    seedCreateDraft("任务");
    stateOf().armExecutionConfirmation(binding());
    stateOf().setView("tree");
    expect(stateOf().executionConfirmationReady(binding())).toBe(false);

    stateOf().armExecutionConfirmation(binding());
    stateOf().setSettingsSection("proxy");
    expect(stateOf().executionConfirmationReady(binding())).toBe(false);

    stateOf().armExecutionConfirmation(binding());
    stateOf().setSettingsSection(null);
    expect(stateOf().executionConfirmationReady(binding())).toBe(false);
  });

  it("重启只读检查 ⇒ 代次推进，旧确认作废（隔离预检与后续入口共用同一机制）", () => {
    seedCreateDraft("任务");
    const before = binding();
    stateOf().armExecutionConfirmation(before);
    stateOf().restartExecutionCheck(CREATE_SUBMIT_TARGET);
    expect(binding().generation).toBe(before.generation + 1);
    expect(stateOf().executionConfirmationReady(before)).toBe(false);
  });
});

describe("4.4 登记口是唯一的执法点：确认不成立 ⇒ 拒绝登记", () => {
  it("确认之后又改输入 ⇒ 用**当下**现场登记即被拒（确认记的是旧修订）", () => {
    seedCreateDraft("任务");
    stateOf().armExecutionConfirmation(binding());
    // 确认之后又改了输入：组件在点击时取到的是新修订的绑定
    stateOf().writeCreateRunDraft({ userMessage: "改了但要沿用旧确认" });

    expect(
      stateOf().beginDraftSubmission({
        channel: "create",
        target: CREATE_SUBMIT_TARGET,
        confirmation: binding(),
      }),
    ).toBeNull();
    expect(subLib.submissionOf(stateOf().draftSubmissions, CREATE_SUBMIT_TARGET)).toBeUndefined();
  });

  it("未带确认的登记 ⇒ 保持既有行为（该入口尚未接入确认门禁，不静默宣称已受约束）", () => {
    seedCreateDraft("任务");
    expect(
      stateOf().beginDraftSubmission({ channel: "create", target: CREATE_SUBMIT_TARGET }),
    ).not.toBeNull();
  });

  it("确认成立 ⇒ 登记成功并当场消费：重新执行要重新确认", () => {
    seedCreateDraft("任务");
    stateOf().armExecutionConfirmation(binding());
    expect(
      stateOf().beginDraftSubmission({
        channel: "create",
        target: CREATE_SUBMIT_TARGET,
        confirmation: binding(),
      }),
    ).not.toBeNull();
    expect(stateOf().executionConfirmationReady(binding())).toBe(false);
    // 同一现场确认再用一次 ⇒ 被拒（一次确认只换一次执行）
    expect(
      stateOf().beginDraftSubmission({
        channel: "create",
        target: CREATE_SUBMIT_TARGET,
        confirmation: binding(),
      }),
    ).toBeNull();
  });

  it("显式放弃草稿 ⇒ 一并撤销确认（不把「已经确认过」留给下一份草稿）", () => {
    seedCreateDraft("任务");
    stateOf().armExecutionConfirmation(binding());
    const entry = stateOf().createRunDraftOf();
    expect(stateOf().discardCreateRunDraft(entry?.revision ?? -1)).toBe(true);
    expect(stateOf().confirmations.byTargetKey).toEqual({});
  });
});

describe("4.4 接线契约：确认判据只有一份", () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, "../src/renderer/src", rel), "utf8");

  it("组件侧不得自己比对现场（只调 store 的 ready / arm 动作）", () => {
    const offenders: string[] = [];
    for (const name of [
      "components/CreateRunWorkspace.tsx",
      "components/DetailPanel.tsx",
      "App.tsx",
    ]) {
      const src = read(name);
      if (/decideConfirmation|armConfirmation\(|releaseConfirmation\(/.test(src)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("披露内容全部来自 lib（组件不自己拼「这次会怎样」的句子）", () => {
    const create = read("components/CreateRunWorkspace.tsx");
    const panel = read("components/DetailPanel.tsx");
    expect(create).toContain("createDisclosure({");
    expect(panel).toContain("resultPlainDisclosure({");
    // 两个入口都经同一份 disclosureLines，不存在各写一套顺序
    expect(create).toContain("disclosureLines(");
    expect(panel).toContain("disclosureLines(");
  });
});
