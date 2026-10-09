import type { ReactNode } from "react";
import { useState } from "react";
import type { ExperimentArmSelectability, ExperimentBatchView } from "../lib/experiment-results";
import { experimentArmSelectabilityOf, experimentCompareHintOf } from "../lib/experiment-results";
import type { AbArmResultView, ResultAction } from "../lib/operation-result-view";
import type { ResultReadIdentity } from "../lib/result-verification";
import { AbBatchResultSection } from "./AbBatchResult";
import { Disclosure } from "./Disclosure";
import { FOCUS_RING } from "./IconButton";

/**
 * U8 任务 4.1/4.2：**实验工作区的批次结果区**（design D5：结果面板绑定明确批次、
 * 按 main 登记呈现）。
 *
 * 只吃 props 的纯视图（本包无 jsdom；派生由 `deriveExperimentBatches` 完成，
 * 接线在 `ExperimentWorkspace`）。呈现义务：
 *
 * 1. **批次身份只来自 main 登记**：组头展示登记的 operationId 与 experimentId；
 *    experimentId 缺席时如实说"未登记"——预览（dry-run）标签在结构上进不了本组件，
 *    不充当真实批次身份（delta 明令）；
 * 2. **同父同模型不合并**：每批一个独立块，组序由派生层保证确定（startedAt + operationId）；
 * 3. **对照选择与进入比较**（U8 任务 4.5）：有可信 ID 的臂加入/移出全局对照集合
 *    （`compareIds`，上限 4 由 store 承担）；两条按选择顺序进详细比较、三四条进指标表
 *    再显式选两条——分流话术由 `experimentCompareHintOf` 给出，进入决策由 store 的
 *    `openCompareWorkspace` 现算（本组件不复制判据）。未关联臂禁用选择并显示原因，
 *    但不隐藏（比较拒绝由 U7 呈现，结果页不冒充"比较成功"）。
 */
export function ExperimentResultsSection({
  batches,
  onArmAction,
  compareIds = [],
  compareNotice = null,
  onToggleCompare,
  onEnterCompare,
}: {
  readonly batches: readonly ExperimentBatchView[];
  readonly onArmAction: (action: ResultAction, identity: ResultReadIdentity) => void;
  /** 全局对照集合（U7 共用；缺省空 = 只呈现不提供选择面） */
  readonly compareIds?: readonly string[];
  /** store 的对照操作提示（超上限等）；null = 无 */
  readonly compareNotice?: string | null;
  readonly onToggleCompare?: (runId: string) => void;
  readonly onEnterCompare?: () => void;
}): ReactNode {
  const selection =
    onToggleCompare === undefined
      ? null
      : {
          isSelectedOf: (runId: string): boolean => compareIds.includes(runId),
          selectabilityOf: (arm: AbArmResultView): ExperimentArmSelectability =>
            experimentArmSelectabilityOf(arm),
          onToggle: onToggleCompare,
        };
  const hint = onEnterCompare === undefined ? null : experimentCompareHintOf(compareIds.length);
  // 3.4（design D5）：技术说明收进 Disclosure——主文案用户语言，细节"可查但不占位"
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div className="mt-3" data-experiment-results>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-gray-700">实验结果</span>
        {batches.length > 0 ? (
          <span className="text-[10px] text-gray-400">{batches.length} 批</span>
        ) : null}
      </div>
      {batches.length === 0 ? (
        <div className="rounded border border-gray-100 bg-gray-50/60 px-2 py-1.5 text-[11px] leading-4 text-gray-500">
          尚未执行实验：确认执行后，各臂的结果会按批次出现在这里。
        </div>
      ) : (
        <div className="space-y-2">
          {batches.map((batch) => (
            <div
              key={batch.operationId}
              data-experiment-batch={batch.operationId}
              className="rounded border border-gray-200 bg-white px-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-[10px] font-semibold text-gray-600">批次</span>
                <span className="break-all font-code text-[10px] text-gray-600">
                  {batch.operationId}
                </span>
                {batch.experimentId !== null ? (
                  <span className="break-all font-code text-[10px] text-gray-400">
                    实验组 {batch.experimentId}
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-400">实验组身份未登记</span>
                )}
              </div>
              <AbBatchResultSection view={batch.view} onAct={onArmAction} selection={selection} />
            </div>
          ))}
        </div>
      )}
      {onEnterCompare !== undefined ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-experiment-enter-compare
            disabled={compareIds.length < 2}
            title={
              compareIds.length < 2
                ? "先选择至少两条已关联的臂结果"
                : "进入共用比较工作区（只读；不改批次事实与结果读取）"
            }
            onClick={onEnterCompare}
            className={`rounded border border-sky-400 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-800 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
          >
            进入比较（已选 {compareIds.length}/4）
          </button>
          {hint !== null ? <span className="text-[10px] text-gray-500">{hint}</span> : null}
        </div>
      ) : null}
      {compareNotice !== null ? (
        <output className="mt-1 block break-all text-[10px] leading-4 text-amber-800">
          {compareNotice}
        </output>
      ) : null}
      <Disclosure
        summary="结果说明"
        expanded={detailsOpen}
        onToggle={() => setDetailsOpen((prev) => !prev)}
        controlsId="experiment-results-details"
        className="mt-1"
      >
        <div className="px-1 pb-1 text-[10px] leading-4 text-gray-500">
          批次按这次执行的登记身份分组：同父同模型的两批不合并，不同批的臂不混成一组；
          逐臂事实与动作同操作面板口径。预览（dry-run）不产生批次，预览标签也不充当批次身份。
        </div>
      </Disclosure>
    </div>
  );
}
