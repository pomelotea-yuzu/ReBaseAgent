import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ok } from "@shared/ipc";
import type { WindowApi } from "@shared/ipc";
import { beforeEach, describe, expect, it } from "vitest";
import * as draftLib from "../src/renderer/src/lib/debugging-drafts";
import type { ModelAbDraftKey } from "../src/renderer/src/lib/debugging-drafts";
import * as subLib from "../src/renderer/src/lib/draft-submission";
import { emptyConfirmationStore } from "../src/renderer/src/lib/execution-confirmation";
import { initialSession } from "../src/renderer/src/lib/operation-session";
import { emptyResultReadStore } from "../src/renderer/src/lib/result-verification";
import { installOperationChannels } from "./helpers/operation-channels";

/**
 * U5（unify-run-execution-workflow）任务 4.7：**A/B 的确认对象是当前预览计划**。
 *
 * 判据来源：delta「执行前检查和确认保持各入口真实语义」的场景
 * 「实验确认使用当前预览计划」。A/B 与其他入口的差别在于它的"检查"是一份**真实的只读
 * dry-run**（`runs:modelAbPlan`），所以这里要钉住两件事：
 * 1. 确认绑的是**整批草稿修订 + 检查代次**——改任一臂、或重新预览，旧确认当场作废；
 * 2. 确认按钮的资格来自 `activePlan`（计划与修订同源的那一份），而不是组件里的 `plan`
 *    ——否则"改了臂还拿着旧计划的结论执行"正好是场景要防的事。
 *
 * 无 jsdom ⇒ 行为归 §6 CDP；本份钉 store 接线 + 源码级接线契约。
 */

const apiStub: Record<string, unknown> = {
  listRuns: async () => ok({ runs: [], failed: [] }),
  getRun: async () => ok(null),
};
installOperationChannels(apiStub);
(globalThis as Record<string, unknown>).window = { api: apiStub as unknown as WindowApi };

const { useAppStore } = await import("../src/renderer/src/store");

const stateOf = () => useAppStore.getState();

const AB_KEY: ModelAbDraftKey = { runId: "r_parent", spanId: "s_02" };
const OTHER_KEY: ModelAbDraftKey = { runId: "r_parent", spanId: "s_03" };
const BASELINE = [
  { model: "deepseek-chat", paramsText: "" },
  { model: "deepseek-chat", paramsText: "" },
];

const binding = (key: ModelAbDraftKey = AB_KEY) =>
  stateOf().currentConfirmationBinding("model_ab", key);

function openBatch(): void {
  stateOf().ensureModelAbDraft(AB_KEY, BASELINE);
  stateOf().setModelAbRows(AB_KEY, [
    { key: "arm-1", model: "m-a", paramsText: '{"temperature":0.2}' },
    { key: "arm-2", model: "m-b", paramsText: "" },
  ]);
}

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

describe("4.7 A/B 确认绑整批修订与检查代次", () => {
  it("绑定取的是**整批**修订：改任一臂即作废（不是只认第一次写入的那一版）", () => {
    openBatch();
    const before = binding();
    expect(before.revision).toBe(stateOf().modelAbDraftOf(AB_KEY)?.revision);
    stateOf().armExecutionConfirmation(before);
    expect(stateOf().executionConfirmationReady(binding())).toBe(true);

    stateOf().setModelAbRows(AB_KEY, [
      { key: "arm-1", model: "m-a", paramsText: '{"temperature":0.2}' },
      { key: "arm-2", model: "m-c", paramsText: "" },
    ]);

    // 用**当下**现场判定（传旧绑定对象只会和记录自己比出来一个"相同"）
    const after = binding();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(stateOf().executionConfirmationReady(after)).toBe(false);
    // 登记的执法点同样拒收：组件在点击时取的是当下绑定，旧确认换不到新修订的执行
    expect(
      stateOf().beginDraftSubmission({
        channel: "model_ab",
        target: AB_KEY,
        confirmation: after,
      }),
    ).toBeNull();
  });

  it("确认属于这一批：同一 run 的另一个 span 不共享（各批次各核各的）", () => {
    openBatch();
    stateOf().armExecutionConfirmation(binding());
    expect(stateOf().executionConfirmationReady(binding(OTHER_KEY))).toBe(false);
  });

  it("增删臂与非法参数文本同样作废确认（行写入只有一条路径，草稿本身保留）", () => {
    openBatch();
    stateOf().armExecutionConfirmation(binding());
    const rows = [
      { key: "arm-1", model: "m-a", paramsText: '{"temperature":0.2}' },
      { key: "arm-2", model: "m-b", paramsText: "" },
    ];

    // 加一臂（语义序列长度变化）
    stateOf().setModelAbRows(AB_KEY, [...rows, { key: "arm-3", model: "m-c", paramsText: "" }]);
    expect(stateOf().executionConfirmationReady(binding())).toBe(false);
    expect(stateOf().modelAbDraftOf(AB_KEY)?.rows).toHaveLength(3);

    // 写进一段非法参数 JSON：确认照样作废，而文本逐字留在草稿里（可继续改，不丢输入）
    stateOf().setModelAbRows(AB_KEY, [
      { key: "arm-1", model: "m-a", paramsText: "{temperature: 0.2" },
      { key: "arm-2", model: "m-b", paramsText: "" },
    ]);
    expect(stateOf().executionConfirmationReady(binding())).toBe(false);
    expect(stateOf().modelAbDraftOf(AB_KEY)?.rows[0]?.paramsText).toBe("{temperature: 0.2");
  });

  it("重新预览推进检查代次 ⇒ 那份确认作废，登记口当场拒绝", () => {
    openBatch();
    stateOf().armExecutionConfirmation(binding());
    stateOf().restartExecutionCheck(AB_KEY);

    expect(
      stateOf().beginDraftSubmission({
        channel: "model_ab",
        target: AB_KEY,
        confirmation: binding(),
      }),
    ).toBeNull();
    expect(subLib.submissionOf(stateOf().draftSubmissions, AB_KEY)).toBeUndefined();
  });

  it("确认成立 ⇒ 登记成功并一次性消费：第二次执行要重新确认", () => {
    openBatch();
    stateOf().armExecutionConfirmation(binding());
    expect(
      stateOf().beginDraftSubmission({
        channel: "model_ab",
        target: AB_KEY,
        confirmation: binding(),
      }),
    ).not.toBeNull();
    expect(stateOf().executionConfirmationReady(binding())).toBe(false);
    expect(
      stateOf().beginDraftSubmission({
        channel: "model_ab",
        target: AB_KEY,
        confirmation: binding(),
      }),
    ).toBeNull();
  });

  it("放弃整批 ⇒ 一并撤销待用的确认（不把「已确认」留给下一份批次）", () => {
    openBatch();
    stateOf().armExecutionConfirmation(binding());
    const revision = stateOf().modelAbDraftOf(AB_KEY)?.revision ?? -1;
    expect(stateOf().discardModelAbDraft(AB_KEY, revision)).toBe(true);
    expect(stateOf().confirmations.byTargetKey).toEqual({});
  });
});

describe("4.7 接线契约：确认对象是当前预览计划而非草稿", () => {
  // ⚠️ U8 3.1a 改判留痕：ModelAbEditor 提取为独立文件（逐字搬出），源码级断言改读新文件
  const ab = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/ModelAbEditor.tsx"),
    "utf8",
  );
  const flat = (src: string): string => src.replace(/\s+/g, " ");

  /** 某个控件（以其标签文本定位）自己的 disabled 清单——表达式在标签之前 */
  function disabledOf(label: string): string {
    const labelAt = ab.indexOf(label);
    expect(labelAt, label).toBeGreaterThan(-1);
    const start = ab.lastIndexOf("disabled={", labelAt);
    return flat(ab.slice(start, ab.indexOf("}", start)));
  }

  it("披露喂的是 activePlan：属于旧修订的计划不进确认", () => {
    expect(ab).toContain("核对本次实验");
    expect(flat(ab)).toContain("abDisclosure({");
    expect(flat(ab)).toContain("plan: activePlan,");
    // 反向：不得把组件里的原始 plan 直接交给披露（那正是"旧计划复活"）
    expect(flat(ab)).not.toContain("plan: plan,");
  });

  it("没有生效计划就不给确认按钮（确认的必须先是被校验的那一份）", () => {
    const confirmDisabled = disabledOf("已核对，确认执行实验");
    expect(confirmDisabled).toContain("activePlan === null ||");
    expect(confirmDisabled).toContain("!canSubmit");
    expect(confirmDisabled).toContain("!gate.canSubmit");
    // 已确认之后按钮收起（一次性凭据不给人重复点）
    expect(confirmDisabled).toContain("abConfirmed ||");
  });

  it("执行按钮受确认约束，且原因就近给出（不是只禁不给话）", () => {
    expect(flat(ab)).toContain(
      "disabled={ inProgress || !canSubmit || activePlan === null || !gate.canSubmit || !abConfirmed }",
    );
    expect(ab).toContain("先核对上面的目标与执行边界并确认");
    // 计划属于旧修订时的说明（改臂/改参数后不能只看到一个禁用按钮）
    expect(ab).toContain("这份计划属于旧批次修订");
  });

  it("重新预览 = 重启检查：先推进代次再发只读请求，且只在资格齐备时", () => {
    const at2 = ab.indexOf("const doPreview = ");
    const preview = ab.slice(at2, ab.indexOf("const doExecute = ", at2));
    expect(preview).toContain("restartExecutionCheck(draftKey)");
    expect(preview.indexOf("if (!canSubmit) return;")).toBeLessThan(
      preview.indexOf("restartExecutionCheck(draftKey)"),
    );
    // 预览仍是只读通道：不登记提交关联、不受确认约束
    expect(preview).not.toContain("beginDraftSubmission");
    expect(disabledOf("校验并预览计划")).not.toContain("gate.");
    expect(disabledOf("校验并预览计划")).not.toContain("abConfirmed");
  });

  it("A/B 的原生确认已消失，改为就地核对 + 同一执法点", () => {
    expect(ab).not.toContain("window.confirm");
    expect(flat(ab)).toContain(
      'beginDraftSubmission({ channel: "model_ab", target: draftKey, confirmation: abBinding',
    );
  });
});

// U8 任务 3.7：计划绑定**已核实配置变化代次**（仅轮换 key 的保存也作废旧计划）
describe("U8 3.7 接线契约：预览记录配置代次并传入新鲜度判据（源码级）", () => {
  // ⚠️ `ab` 是上一个 describe 的局部常量，这里自读同一文件
  const ab37 = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/ModelAbEditor.tsx"),
    "utf8",
  );
  it("订阅代次、预览时记录、新鲜度判据消费", () => {
    expect(ab37).toContain(
      "const settingsChangeGeneration = useAppStore((s) => s.settingsChangeGeneration);",
    );
    expect(ab37).toContain("setPlanSettingsGeneration(requestedSettingsGeneration);");
    expect(ab37).toContain("currentSettingsGeneration: settingsChangeGeneration");
  });
});

// U8 任务 3.5：预览的**独立请求状态**（只读 dry-run 自己的在飞标记；防重复不靠按钮单打独斗）
describe("U8 3.5 接线契约：预览独立请求状态（源码级）", () => {
  // 同 3.7：`ab` 在别的 describe 内部——这里自读同一文件
  const ab35 = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/ModelAbEditor.tsx"),
    "utf8",
  );
  it("previewing 状态、就地防重入、finally 解除、独立呈现", () => {
    expect(ab35).toContain("const [previewing, setPreviewing] = useState(false);");
    // 就地防重入（提交口兜底，不只靠按钮 disabled）
    expect(ab35).toContain("if (!canSubmit || previewing) return;");
    // 无论安装与否都解除自己的标记
    expect(ab35).toContain("setPreviewing(false);");
    // 独立呈现：只读通道的在飞文案与执行 busy 分开
    expect(ab35).toContain("data-ab-previewing");
    expect(ab35).toContain("只读 dry-run：不联网、不写文件");
  });
});
