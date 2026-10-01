import type { OperationRecord } from "@shared/operations";
import type { AbArmResultView, AbBatchResultView } from "./operation-result-view";
import { deriveAbBatchResult } from "./operation-result-view";
import type { ResultReadStore } from "./result-verification";

/**
 * U8（unify-recording-and-experiment-workspaces）任务 4.1/4.2：
 * **实验工作区结果区的唯一派生口**（design D5/D6）。
 *
 * 三条边界（对应 delta「成功臂集合不隐去失败臂」「预览标签不充当真实批次身份」
 * 「同父同模型仍按真实批次分组」「多批实验共存」）：
 *
 * 1. **批次按 main 登记圈定**：只取 `target.kind === "modelAb"` 且
 *    `target.parentRunId === 目标 runId` 的登记记录——不是信封 `ModelAbResult`，
 *    也不是"当前选中运行的邻近记录"。同父先后两批 = 两条登记记录 = 两组，
 *    永不按模型名、时间、experimentId 标签或列表邻近合并。
 * 2. **分组键是 operationId**（一次提交一个批次身份），experimentId 只是**随组展示的
 *    main 登记标签**（null = main 未给出，如实呈现）。dry-run 预览返回的 experimentId
 *    是编辑器局部态，本派生口的输入里根本没有计划——预览标签在结构上进不了结果区。
 * 3. **逐臂呈现复用 `deriveAbBatchResult`**（U5 5.1 的判据，不抄第二份）：
 *    集合基准 = 登记 `target.armCount`，缺臂 / null ID 只给诚实说明；
 *    请求事实与逐臂结局分层；不产出臂间差值或胜出臂。
 *
 * 顺序确定性：按 `startedAt` 升序（null 排最后，防御性——tombstone 不会有 target），
 * 同刻按 operationId 字典序。任何一次渲染的组序都可复现。
 */

/** 一批（一次 modelAb 提交）在工作区结果区的呈现 */
export interface ExperimentBatchView {
  /** 批次的真实分组键：main 登记的提交身份 */
  readonly operationId: string;
  /** main 登记的实验组标签；null = main 未给出（如实呈现，不用预览标签补） */
  readonly experimentId: string | null;
  /** 该批的逐臂呈现（与操作面板同一派生口径） */
  readonly view: AbBatchResultView;
}

export function deriveExperimentBatches(input: {
  readonly targetRunId: string;
  readonly operations: readonly OperationRecord[];
  readonly reads: ResultReadStore;
}): readonly ExperimentBatchView[] {
  const batches = input.operations.filter(
    (record) =>
      record.target?.kind === "modelAb" && record.target.parentRunId === input.targetRunId,
  );
  const sorted = [...batches].sort((a, b) => {
    const ta = a.startedAt ?? "";
    const tb = b.startedAt ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0;
  });
  return sorted.map((record) => ({
    operationId: record.operationId,
    experimentId: record.experimentId,
    view: deriveAbBatchResult({ operationId: record.operationId, record, reads: input.reads }),
  }));
}

// ---------------------------------------------------------------------------
// 任务 4.5：臂 → 对照集合的选择资格与进入提示
// ---------------------------------------------------------------------------

/** 一条臂加入/移出对照的资格 */
export interface ExperimentArmSelectability {
  readonly selectable: boolean;
  /** 不可选时的就近原因；可选 ⇒ null */
  readonly reason: string | null;
}

/**
 * 选择资格只看**是否登记了可信运行 ID**（design D6：未关联 ID 禁用选择并显示原因；
 * 已关联但 ownOnly/不可读/未封存的记录**仍可选中**——由 U7 比较工作区呈现拒绝，
 * 结果页不把它们过滤成"比较成功"）。
 */
export function experimentArmSelectabilityOf(arm: AbArmResultView): ExperimentArmSelectability {
  if (arm.runId === null) {
    return {
      selectable: false,
      reason: "该臂没有登记可信运行 ID：不能进入比较（不从信封 ids、邻近记录或目录猜身份）",
    };
  }
  return { selectable: true, reason: null };
}

/**
 * 已选条数的进入提示（display 用；进入决策由 store 的 `openCompareWorkspace` 现算——
 * 本函数不复制它的判据，只给同口径的话术）。
 */
export function experimentCompareHintOf(selectedCount: number): string | null {
  if (selectedCount < 2) return "选择两条即可进入详细比较；三四条先看指标表再显式选两条";
  if (selectedCount === 2) return "已选两条：进入比较将按选择顺序作为详细比较的左右两侧";
  return "已选三条及以上：进入比较后在指标表中显式选择两条进行详细比较";
}
