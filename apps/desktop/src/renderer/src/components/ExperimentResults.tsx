import type { ReactNode } from "react";
import type { ExperimentBatchView } from "../lib/experiment-results";
import type { ResultAction } from "../lib/operation-result-view";
import type { ResultReadIdentity } from "../lib/result-verification";
import { AbBatchResultSection } from "./AbBatchResult";

/**
 * U8 任务 4.1/4.2：**实验工作区的批次结果区**（design D5：结果面板绑定明确批次、
 * 按 main 登记呈现）。
 *
 * 只吃 props 的纯视图（本包无 jsdom；派生由 `deriveExperimentBatches` 完成，
 * 接线在 `ExperimentWorkspace`）。两条呈现义务：
 *
 * 1. **批次身份只来自 main 登记**：组头展示登记的 operationId 与 experimentId；
 *    experimentId 缺席时如实说"未登记"——预览（dry-run）标签在结构上进不了本组件，
 *    不充当真实批次身份（delta 明令）；
 * 2. **同父同模型不合并**：每批一个独立块，组序由派生层保证确定（startedAt + operationId）。
 */
export function ExperimentResultsSection({
  batches,
  onArmAction,
}: {
  readonly batches: readonly ExperimentBatchView[];
  readonly onArmAction: (action: ResultAction, identity: ResultReadIdentity) => void;
}): ReactNode {
  return (
    <div className="mt-3" data-experiment-results>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-gray-700">
          实验结果（按 main 登记批次）
        </span>
        {batches.length > 0 ? (
          <span className="text-[10px] text-gray-400">{batches.length} 批</span>
        ) : null}
      </div>
      {batches.length === 0 ? (
        <div className="rounded border border-gray-100 bg-gray-50/60 px-2 py-1.5 text-[11px] leading-4 text-gray-500">
          本目标还没有实验批次登记：真实执行提交后，批次会按登记身份出现在这里（预览不产生批次）。
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
                    实验组 {batch.experimentId}（main 登记）
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-400">
                    实验组身份未登记（main 未给出；预览标签不是批次身份）
                  </span>
                )}
              </div>
              <AbBatchResultSection view={batch.view} onAct={onArmAction} />
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 text-[10px] leading-4 text-gray-400">
        分组只按 main 登记的批次身份：同父同模型的两批不合并，不同批的臂不混成一组；逐臂事实与
        动作同操作面板口径。
      </div>
    </div>
  );
}
