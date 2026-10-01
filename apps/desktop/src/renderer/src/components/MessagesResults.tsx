import type { ReactNode } from "react";
import type { MessagesResultView } from "../lib/messages-results";
import type { ResultAction } from "../lib/operation-result-view";
import type { ResultReadIdentity } from "../lib/result-verification";
import { FOCUS_RING } from "./IconButton";
import { ACTION_LABELS, TONE_STYLES } from "./OperationsEntry";

/**
 * U8 任务 5.4：**messages 工作区的重发结果区**（只吃 props 的纯视图；派生由
 * `deriveMessagesResults` 完成，接线在 MessagesWorkspace）。
 *
 * 呈现义务（delta「messages 失败定位与返回不丢草稿」）：
 * 1. 每次提交一个块：状态行（执行中 / 本次未接受 / 结果未定位 / 逐条结果）+
 *    请求事实单独一行 + 逐条结果的动作（打开 / 失败定位 / 只读重试）；
 * 2. 草稿在场 ⇒ 「返回编辑」入口（记录级动作；返回不丢草稿）；
 * 3. 失败与未知只呈现事实与动作，不做任何"用被动记录补结果"的旁路。
 */
export function MessagesResultsSection({
  results,
  onAction,
}: {
  readonly results: readonly MessagesResultView[];
  readonly onAction: (action: ResultAction | "return-draft", identity: ResultReadIdentity) => void;
}): ReactNode {
  return (
    <div className="mt-3" data-messages-results>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold text-gray-700">
          重发结果（按 main 登记提交）
        </span>
        {results.length > 0 ? (
          <span className="text-[10px] text-gray-400">{results.length} 次</span>
        ) : null}
      </div>
      {results.length === 0 ? (
        <div className="rounded border border-gray-100 bg-gray-50/60 px-2 py-1.5 text-[11px] leading-4 text-gray-500">
          本目标还没有重发提交登记：确认重发后，登记与结果会出现在这里（被动录制不会）。
        </div>
      ) : (
        <div className="space-y-2">
          {results.map((result) => (
            <div
              key={result.operationId}
              data-messages-result={result.operationId}
              className="rounded border border-gray-200 bg-white px-2 py-1.5"
            >
              <div className="text-[10px] font-semibold text-gray-600">{result.view.label}</div>
              {result.view.detail !== null ? (
                <div className="mt-0.5 break-all text-[10px] leading-4 text-gray-500">
                  {result.view.detail}
                </div>
              ) : null}
              {result.requestLine !== null ? (
                <div className="mt-0.5 break-all text-[10px] leading-4 text-gray-500">
                  {result.requestLine}
                </div>
              ) : null}
              {result.view.items.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {result.view.items.map((item) => (
                    <li
                      key={item.runId}
                      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-gray-100 bg-gray-50/60 px-1.5 py-1"
                    >
                      <span className="min-w-0 break-all font-code text-[10px] text-gray-700">
                        {item.runId}
                      </span>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                          TONE_STYLES[item.tone]
                        }`}
                      >
                        {item.label}
                      </span>
                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        {item.actions.map((action) => (
                          <button
                            key={action}
                            type="button"
                            onClick={() => {
                              onAction(action, {
                                epoch: result.epoch,
                                operationId: result.operationId,
                                runId: item.runId,
                              });
                            }}
                            title={
                              action === "retry-read"
                                ? `只按同一个可信运行 ID 重读（${item.runId}）：不会重新执行`
                                : action === "view-failure"
                                  ? "只定位这条运行自有的失败调用"
                                  : "按可信运行 ID 打开概览"
                            }
                            className={`shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                          >
                            {ACTION_LABELS[action]}
                          </button>
                        ))}
                      </div>
                      {item.detail !== null ? (
                        <div className="w-full break-all text-[10px] leading-4 text-gray-500">
                          {item.detail}
                        </div>
                      ) : null}
                      {item.sourceWarning !== null ? (
                        <div className="w-full break-all text-[10px] leading-4 text-amber-800">
                          {item.sourceWarning}
                        </div>
                      ) : null}
                      {item.failureNote !== null ? (
                        <div className="w-full break-all text-[10px] leading-4 text-gray-400">
                          {item.failureNote}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.view.canReturnDraft ? (
                <div className="mt-1">
                  <button
                    type="button"
                    data-messages-return-draft={result.operationId}
                    onClick={() => {
                      onAction("return-draft", {
                        epoch: result.epoch,
                        operationId: result.operationId,
                        runId: "",
                      });
                    }}
                    className={`rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-800 hover:bg-sky-100 ${FOCUS_RING}`}
                  >
                    返回编辑
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 text-[10px] leading-4 text-gray-400">
        结果只按 main 登记的提交身份呈现：失败或未知都保留编辑输入，不用被动录制补结果；源 trace
        不会被改写。
      </div>
    </div>
  );
}
