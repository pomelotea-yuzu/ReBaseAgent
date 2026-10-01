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

  it("确认态经 store 订阅现算（U5 §6.2 实机首跑坐实的接线缺口）", () => {
    // 缺陷形状：组件只订阅了 ready/arm 的**函数引用**（useAppStore((s) => s.executionConfirmationReady)），
    // armExecutionConfirmation 落库后不触发重渲染 ⇒ 五个入口的确认按钮永远停在未确认态。
    // 修正形状：confirmed 一律在 useAppStore 选择器内现算（订阅返回的布尔值本身）。
    // ⚠️ U8 5.1a 改判留痕（2026-10-01）：确认面随载体迁移拆到四个文件——
    // result/prompt 仍在 DetailPanel；A-B 自 3.1a 起在 ModelAbEditor.tsx；
    // messages 自 5.1a 起在 MessagesForkEditor.tsx。判据不变：每个入口的选择器内现算。
    for (const name of [
      "components/CreateRunWorkspace.tsx",
      "components/DetailPanel.tsx",
      "components/ModelAbEditor.tsx",
      "components/MessagesForkEditor.tsx",
    ]) {
      const flat = read(name).replace(/\s+/g, " ");
      // 旧写法（只订阅函数引用）不得复活
      expect(flat).not.toContain("useAppStore((s) => s.executionConfirmationReady);");
      expect(flat).not.toContain("useAppStore((s) => s.executionConfirmationReady )");
    }
    const create = read("components/CreateRunWorkspace.tsx").replace(/\s+/g, " ");
    expect(create).toContain("s.executionConfirmationReady(confirmation)");
    const panel = read("components/DetailPanel.tsx").replace(/\s+/g, " ");
    for (const binding of ["promptBinding", "executionBinding"]) {
      expect(panel).toContain(`s.executionConfirmationReady(${binding})`);
    }
    const modelAbEditor = read("components/ModelAbEditor.tsx").replace(/\s+/g, " ");
    expect(modelAbEditor).toContain("s.executionConfirmationReady(abBinding)");
    const messagesEditor = read("components/MessagesForkEditor.tsx").replace(/\s+/g, " ");
    expect(messagesEditor).toContain("s.executionConfirmationReady(messagesBinding)");
  });

  it("披露内容全部来自 lib（组件不自己拼「这次会怎样」的句子）", () => {
    const create = read("components/CreateRunWorkspace.tsx");
    const panel = read("components/DetailPanel.tsx");
    expect(create).toContain("createDisclosure({");
    expect(panel).toContain("resultPlainDisclosure({");
    // U5 4.5：隔离侧的"已做的检查 / 本次边界"也出自同一模块
    expect(panel).toContain("resultIsolatedDisclosure({");
    // 两个入口都经同一份 disclosureLines，不存在各写一套顺序
    expect(create).toContain("disclosureLines(");
    expect(panel).toContain("disclosureLines(");
  });

  it("两条 result 路径都把现场确认交给登记口（4.5 起隔离侧不再豁免）", () => {
    const panel = read("components/DetailPanel.tsx");
    const flat = panel.replace(/\s+/g, " ");
    expect(flat).toContain("confirmation: executionBinding,");
    expect(flat).not.toContain("isolated ? {} :");
  });

  it("五个入口各有一处就地确认（不共用一个按钮、也不漏接）", () => {
    // U5 4.7 起 A/B 也接入：口径 4 → 5（result 普通 / result 隔离 / prompt / messages / A-B）
    // ⚠️ U8 5.1a 改判留痕：载体迁移后按文件计数——result 两个在 DetailPanel，
    // A-B 在 ModelAbEditor、messages 在 MessagesForkEditor、创建在 CreateRunWorkspace。
    const panel = read("components/DetailPanel.tsx");
    const create = read("components/CreateRunWorkspace.tsx");
    const modelAbEditor = read("components/ModelAbEditor.tsx");
    const messagesEditor = read("components/MessagesForkEditor.tsx");
    expect(panel.match(/data-confirm-execution/g)?.length).toBe(3);
    expect(create.match(/data-confirm-execution/g)?.length).toBe(1);
    expect(modelAbEditor.match(/data-confirm-execution/g)?.length).toBe(1);
    expect(messagesEditor.match(/data-confirm-execution/g)?.length).toBe(1);
  });

  it("隔离侧的确认按钮要求预检结论与本次授权都在场（无预检就不给确认）", () => {
    const panel = read("components/DetailPanel.tsx");
    const at = panel.indexOf("已核对，确认本次续跑");
    expect(at).toBeGreaterThan(-1);
    // 按钮的 disabled 写在标签之前：往回切出这一支的禁用清单
    const gate = panel
      .slice(
        panel.lastIndexOf("disabled={", at),
        panel.indexOf("}", panel.lastIndexOf("disabled={", at)),
      )
      .replace(/\s+/g, " ");
    expect(gate).toContain("capability === null ||");
    expect(gate).toContain("!writesAuthorized ||");
    // 预检缺席时就近给出原因，而不是只把按钮禁掉
    expect(panel).toContain("还没拿到只读预检结论");
    // 重新启动预检必须先推进检查代次：否则"旧预检 + 新确认"能拼出一条没人核对过的执行
    const from = panel.indexOf("const doCheck");
    const check = panel.slice(from, panel.indexOf("loadForkCapability", from));
    expect(check.length).toBeGreaterThan(20);
    expect(check).toContain("restartExecutionCheck(draftKey)");
    // 而且是在判据通过之后才推进（被挡住的点击不产生代次抖动）
    expect(check.indexOf("if (!checkAllowed) return;")).toBeLessThan(
      check.indexOf("restartExecutionCheck(draftKey)"),
    );
  });

  it("prompt 与 messages 的资格原因就近显示（不是只把按钮禁掉）", () => {
    const panel = read("components/DetailPanel.tsx");
    // prompt：门禁 / 源不可用 / 恢复重验三类原因进确认区（钉**判据形状**：
    // 只写"出现过 submitBlocked"是假门 —— 反向条件也满足它）
    const promptAt = panel.indexOf("已核对，确认从头重跑");
    expect(panel.slice(promptAt, panel.indexOf("</dl>", promptAt) + 900)).toContain(
      "!promptConfirmed && submitBlocked !== null",
    );
    // ⚠️ U8 5.1a/5.2 改判留痕：messages 编辑器迁 MessagesForkEditor.tsx，资格原因
    // 提取为 lib/messages-eligibility.ts 纯判据（顺序判定可单独定向测试）。
    const msgEditor = read("components/MessagesForkEditor.tsx");
    const msgAt = msgEditor.indexOf("已核对，确认本次重发");
    expect(msgAt).toBeGreaterThan(-1);
    expect(msgEditor.slice(msgAt, msgEditor.indexOf("</dl>", msgAt) + 900)).toContain(
      "!messagesConfirmed && ineligible !== null",
    );
    const eligibility = read("lib/messages-eligibility.ts");
    expect(eligibility).toContain("本会话未捕获到 key：先把你的应用经代理跑一次");
    expect(msgEditor).toContain("deriveMessagesIneligibility({");
  });
});
