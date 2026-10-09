import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OperationRecord } from "@shared/operations";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  deriveExperimentBatches,
  experimentArmSelectabilityOf,
  experimentCompareHintOf,
} from "../src/renderer/src/lib/experiment-results";
import { emptyResultReadStore, setResultRead } from "../src/renderer/src/lib/result-verification";

/**
 * U8（unify-recording-and-experiment-workspaces）任务 4.1/4.2：**实验工作区的批次结果区**。
 *
 * 判据来源：delta「成功臂集合不隐去失败臂」（4.1）+「预览标签不充当真实批次身份」
 * 「同父同模型仍按真实批次分组」「多批实验共存」（4.2）。
 * 逐臂呈现的判据本身（armCount 基准 / 缺臂诚实 / 不产出臂间结论）由
 * `operation-request-facts.test.ts` 承载——这里只钉**工作区层的批次圈定与分组**。
 *
 * ⚠️ 本包无 jsdom ⇒ 组件喂 props 走 renderToStaticMarkup（与同族同法）。
 */

(globalThis as Record<string, unknown>).window = { api: {} };
const { ExperimentResultsSection } = await import(
  "../src/renderer/src/components/ExperimentResults"
);

const EPOCH = "66666666-6666-4666-8666-666666666666";
const PARENT = "run_parent";
const OP_1 = "77777777-7777-4777-8777-777777777771";
const OP_2 = "77777777-7777-4777-8777-777777777772";
const OP_OTHER = "77777777-7777-4777-8777-777777777779";
const ARM_A = "run_ab_a";
const ARM_B = "run_ab_b";

function abRecord(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    epoch: EPOCH,
    operationId: OP_1,
    target: { kind: "modelAb", parentRunId: PARENT, armCount: 2 },
    state: "settled",
    rejection: null,
    startedAt: "2026-10-01T08:00:00.000Z",
    settledAt: "2026-10-01T08:00:05.000Z",
    runIds: [ARM_A],
    experimentId: "exp_real_1",
    arms: [
      { index: 0, id: ARM_A, outcome: "returned" },
      { index: 1, id: null, outcome: null },
    ],
    requestOutcome: "returned",
    errorCode: null,
    diagnostics: [],
    ...overrides,
  };
}

const readsWithVerified = (operationId: string, runId: string) =>
  setResultRead(
    emptyResultReadStore(),
    { epoch: EPOCH, operationId, runId },
    { phase: "verified", attempt: 1, facts: null, reason: null },
  );

// ---------------------------------------------------------------------------
// 派生层：批次圈定与分组
// ---------------------------------------------------------------------------

describe("4.1/4.2 批次结果区派生：按 main 登记圈定，分组键是 operationId", () => {
  it("只取本目标的 modelAb 登记：异父批次、非 modelAb、tombstone 一律不进", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [
        abRecord(), // 本父
        abRecord({
          operationId: OP_OTHER,
          target: { kind: "modelAb", parentRunId: "run_other_parent", armCount: 2 },
        }), // 异父
        abRecord({
          operationId: OP_OTHER,
          target: {
            kind: "result",
            mode: "plain",
            parentRunId: PARENT,
            atSpanId: "s_03",
            editField: "result",
          },
        }), // 非 modelAb
        abRecord({
          operationId: OP_OTHER,
          target: null,
          state: "notAccepted",
          rejection: "reconcile_tombstone",
          startedAt: null,
          settledAt: null,
          requestOutcome: null,
          runIds: [],
          arms: [],
          experimentId: null,
        }), // tombstone（无 target，防御性排除）
      ],
      reads: emptyResultReadStore(),
    });
    expect(batches.map((batch) => batch.operationId)).toEqual([OP_1]);
  });

  it("多批共存：同父两批各自成组，按 startedAt + operationId 确定排序", () => {
    const first = abRecord({ operationId: OP_1, startedAt: "2026-10-01T08:00:00.000Z" });
    const second = abRecord({
      operationId: OP_2,
      startedAt: "2026-10-01T09:00:00.000Z",
      experimentId: "exp_real_2",
    });
    for (const [input, expected] of [
      [
        [first, second],
        [OP_1, OP_2],
      ],
      [
        [second, first],
        [OP_1, OP_2],
      ],
    ] as const) {
      const batches = deriveExperimentBatches({
        targetRunId: PARENT,
        operations: input as readonly OperationRecord[],
        reads: emptyResultReadStore(),
      });
      expect(batches.map((batch) => batch.operationId)).toEqual(expected);
      expect(batches[0]!.experimentId).toBe("exp_real_1");
      expect(batches[1]!.experimentId).toBe("exp_real_2");
    }
  });

  it("同父同模型仍按真实批次分组：experimentId 相同也不合并， operationId 才是分组键", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [
        abRecord({ operationId: OP_1, experimentId: "exp_same" }),
        abRecord({ operationId: OP_2, experimentId: "exp_same" }),
      ],
      reads: emptyResultReadStore(),
    });
    expect(batches.length).toBe(2);
    expect(batches[0]!.operationId).not.toBe(batches[1]!.operationId);
    expect(batches.every((batch) => batch.experimentId === "exp_same")).toBe(true);
  });

  it("experimentId 缺席如实呈现为 null；逐臂呈现复用 deriveAbBatchResult（armCount 基准）", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [abRecord({ experimentId: null })],
      reads: readsWithVerified(OP_1, ARM_A),
    });
    expect(batches.length).toBe(1);
    expect(batches[0]!.experimentId).toBeNull();
    // 缺臂（登记 arms 只有臂 0）按 armCount=2 逐位置呈现：臂 2 不从信封 ids 凑
    expect(batches[0]!.view.arms.length).toBe(2);
    expect(batches[0]!.view.arms[0]!.runId).toBe(ARM_A);
    expect(batches[0]!.view.arms[1]!.runId).toBeNull();
    expect(batches[0]!.view.arms[1]!.note).toContain("不生成结果链接");
  });

  it("4.5 选择资格：只看可信 ID；缺 ID 给就近原因；已选条数提示两/三四条分流", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [abRecord()],
      reads: emptyResultReadStore(),
    });
    const armWithId = experimentArmSelectabilityOf(batches[0]!.view.arms[0]!);
    expect(armWithId).toEqual({ selectable: true, reason: null });
    const armWithoutId = experimentArmSelectabilityOf(batches[0]!.view.arms[1]!);
    expect(armWithoutId.selectable).toBe(false);
    expect(armWithoutId.reason).toContain("不能进入比较");

    expect(experimentCompareHintOf(0)).toContain("选择两条");
    expect(experimentCompareHintOf(1)).toContain("选择两条");
    expect(experimentCompareHintOf(2)).toContain("按选择顺序");
    expect(experimentCompareHintOf(3)).toContain("指标表中显式选择两条");
    expect(experimentCompareHintOf(4)).toContain("指标表中显式选择两条");
  });
});

// ---------------------------------------------------------------------------
// 视图：批次身份只来自登记；空态诚实
// ---------------------------------------------------------------------------

describe("4.1/4.2 批次结果区视图：登记身份 + 逐批分块", () => {
  const noop = (): undefined => undefined;

  it("每批独立成块：批次 operationId 与实验组标签（main 登记）逐字在场", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [
        abRecord({ operationId: OP_1 }),
        abRecord({ operationId: OP_2, startedAt: "2026-10-01T09:00:00.000Z", experimentId: null }),
      ],
      reads: emptyResultReadStore(),
    });
    const markup = renderToStaticMarkup(
      createElement(ExperimentResultsSection, { batches, onArmAction: noop }),
    );
    // 3.4：标题与组头去实现术语；分组技术说明收进 Disclosure（收起态不在标记里）
    expect(markup).toContain("实验结果");
    expect(markup).toContain("2 批");
    expect(markup).toContain(`data-experiment-batch="${OP_1}"`);
    expect(markup).toContain(`data-experiment-batch="${OP_2}"`);
    expect(markup).toContain("实验组 exp_real_1");
    expect(markup).not.toContain("（main 登记）");
    // 未登记的实验组身份：如实说明（技术上"预览标签不是批次身份"收进详情）
    expect(markup).toContain("实验组身份未登记");
    expect(markup).toContain('aria-controls="experiment-results-details"');
    expect(markup).not.toContain("同父同模型的两批不合并");
  });

  it("4.3 未关联臂零动作：全部臂都无可信 ID ⇒ 除详情开关外没有任何可点的按钮（只留诚实说明）", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [
        abRecord({
          runIds: [],
          arms: [
            { index: 0, id: null, outcome: null },
            { index: 1, id: null, outcome: null },
          ],
        }),
      ],
      reads: emptyResultReadStore(),
    });
    const markup = renderToStaticMarkup(
      createElement(ExperimentResultsSection, { batches, onArmAction: noop }),
    );
    // 没有可信 ID ⇒ 没有动作按钮（打开/失败定位/重读都不给），不生成伪链接；
    // 3.4 起唯一的按钮是收起的「结果说明」Disclosure 开关（不产结果动作）
    expect(markup.match(/<button/g)?.length).toBe(1);
    expect(markup).not.toContain("打开结果");
    // 但诚实说明必须可读
    expect(markup).toContain("不生成结果链接");
  });

  it("4.5 对照选择：可信臂可切换（选中态 aria-pressed），未关联臂禁用且原因在 title", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [abRecord()],
      reads: emptyResultReadStore(),
    });
    const selected = renderToStaticMarkup(
      createElement(ExperimentResultsSection, {
        batches,
        onArmAction: noop,
        compareIds: [ARM_A],
        onToggleCompare: noop,
        onEnterCompare: noop,
      }),
    );
    // 已选臂：移出对照 + aria-pressed=true
    expect(selected).toContain("移出对照");
    expect(selected).toContain('aria-pressed="true"');
    // 未关联臂：按钮禁用在场，原因就近可读（不隐藏、不冒充可比）
    expect(selected).toContain("加入对照");
    expect(selected).toContain("disabled");
    expect(selected).toContain("不能进入比较");
  });

  it("4.5 进入比较按钮：少于两条禁用；两条启用给顺序说明；store 提示（超上限）原样呈现", () => {
    const batches = deriveExperimentBatches({
      targetRunId: PARENT,
      operations: [abRecord()],
      reads: emptyResultReadStore(),
    });
    const fewer = renderToStaticMarkup(
      createElement(ExperimentResultsSection, {
        batches,
        onArmAction: noop,
        compareIds: [ARM_A],
        onToggleCompare: noop,
        onEnterCompare: noop,
      }),
    );
    expect(fewer).toContain("进入比较（已选 1/4）");
    // 不足两条：进入按钮自身禁用（disabled="" 落在该按钮上）
    expect(fewer).toContain('data-experiment-enter-compare="true" disabled=""');
    expect(fewer).toContain("选择两条即可进入详细比较");

    const two = renderToStaticMarkup(
      createElement(ExperimentResultsSection, {
        batches,
        onArmAction: noop,
        compareIds: [ARM_A, ARM_B],
        onToggleCompare: noop,
        onEnterCompare: noop,
      }),
    );
    expect(two).toContain("进入比较（已选 2/4）");
    expect(two).toContain("按选择顺序作为详细比较的左右两侧");
    // 两条齐备：进入按钮不禁用（disabled 与 title 不同时出现在该按钮上）
    expect(two).toContain('data-experiment-enter-compare="true" title=');
    expect(two).not.toContain('data-experiment-enter-compare="true" disabled');

    const noticed = renderToStaticMarkup(
      createElement(ExperimentResultsSection, {
        batches,
        onArmAction: noop,
        compareIds: [ARM_A, ARM_B],
        compareNotice: "最多同时对照 4 条运行",
        onToggleCompare: noop,
        onEnterCompare: noop,
      }),
    );
    expect(noticed).toContain("最多同时对照 4 条运行");
  });

  it("零批次 ⇒ 引导语（尚未执行实验），不渲染任何批次块", () => {
    const markup = renderToStaticMarkup(
      createElement(ExperimentResultsSection, { batches: [], onArmAction: noop }),
    );
    expect(markup).toContain("尚未执行实验");
    expect(markup).not.toContain("data-experiment-batch=");
  });
});

// ---------------------------------------------------------------------------
// 源码级接线契约：结果区的消费点与呈现纯度
// ---------------------------------------------------------------------------

describe("4.1/4.2 源码级：结果区迁到工作区，编辑器/详情不再持有批次呈现", () => {
  const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), "utf8");

  it("ExperimentWorkspace 接线：deriveExperimentBatches 按目标圈定，动作走既有 store 口", () => {
    const code = read("../src/renderer/src/components/ExperimentWorkspace.tsx");
    expect(code).toContain("deriveExperimentBatches({");
    expect(code).toContain("targetRunId,");
    expect(code).toContain("operations: operations.operations");
    expect(code).toContain("reads: resultReads");
    // 逐臂动作与操作面板同一批 store 口，不自建第二套
    expect(code).toContain("openOperationResult(identity)");
    expect(code).toContain("openOperationFailure(identity)");
    expect(code).toContain("retryResultRead(identity)");
  });

  it("ModelAbEditor 不再持有批次呈现：无结果区、无提交身份指针、无信封消费", () => {
    const code = read("../src/renderer/src/components/ModelAbEditor.tsx");
    expect(code).not.toContain("AbBatchResultSection");
    expect(code).not.toContain("deriveAbBatchResult");
    expect(code).not.toContain("executedOperationId");
    // 信封返回值仍是请求事实（函数返回值原样），但不再有批次呈现分支
    expect(code).not.toContain("abBatchView");
  });

  it("DetailPanel 不再残留死导入（U5 5.1 的批次接线随 U8 4.1 迁走）", () => {
    const code = read("../src/renderer/src/components/DetailPanel.tsx");
    expect(code).not.toContain("deriveAbBatchResult");
    expect(code).not.toContain("AbBatchResultSection");
  });

  it("呈现层纯度：结果区组件与派生层不摸草稿正文/授权/计划/凭据", () => {
    const files = [
      "../src/renderer/src/lib/experiment-results.ts",
      "../src/renderer/src/components/ExperimentResults.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      const imports = src
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"))
        .join("\n");
      for (const forbidden of [
        "debugging-drafts",
        "draft-submission",
        "execution-confirmation",
        "model-ab",
        "apiKey",
        "sourceToken",
      ]) {
        expect(imports, `${rel}:${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("4.4 清理只归 U5：结果区容器不自建第二套收尾/清理/执行路径", () => {
    // 结果读取与草稿清理的唯一汇合点 = store 的 consumeSettledOperations（U5 §3）；
    // 工作区只呈现登记事实与动作，不得出现任何收尾/清理调用（否则 4.1 的迁移
    // 就悄悄长出了第二条清理路径）。核对行为判据由 draft-closure-store 既有两支承载
    // （全臂正常才清 / 缺臂失败不可读整批保留）。
    const code = read("../src/renderer/src/components/ExperimentWorkspace.tsx");
    for (const forbidden of [
      "consumeSettledOperations",
      "settleDraft",
      "discardModelAbDraft",
      "discardRecordingDraft",
      "finishDraftSubmission",
      "beginDraftSubmission",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    const view = read("../src/renderer/src/components/ExperimentResults.tsx");
    for (const forbidden of ["consumeSettledOperations", "settleDraft", "discard"]) {
      expect(view, forbidden).not.toContain(forbidden);
    }
  });
});
