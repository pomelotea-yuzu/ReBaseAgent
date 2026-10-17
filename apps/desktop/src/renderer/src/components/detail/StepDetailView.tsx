import type { StepDetailView as StepDetailViewData } from "../../lib/call-detail-view";
import { formatDuration } from "../../lib/format";
import { KeyValue, Section } from "./DetailShared";

/**
 * `agent.step` 详情的纯展示部分（U1 任务 5.5）。
 *
 * spec 原文：「选中 step 时 SHALL 展示其已记录调用、错误及派生消耗」，场景
 * 「长请求和原始字段完整可读」还要求「step 摘要仍可进入每个原始调用」。
 *
 * 三条义务：
 *   1. **三块都要在**（`STEP_FIELDS` = calls / errors / consumption），缺一块就等于
 *      把"有调用/有错误/有消耗"显示成"没有"。
 *   2. **消耗来自 `deriveStepStats`（既有轨迹口径）**：`presentStepDetail` 只做取用，
 *      不另算一遍——否则详情与预算地图必然分叉。
 *   3. **每条已记录调用都可点进原始调用**（`onOpenCall(spanId)`）：step 是目录不是终点，
 *      用户必须能从这里下钻到具体 llm.call / tool.invoke。
 *
 * ⚠️ `errorCount` 只合并**计数**不合并语义：llm 的 error 与 tool 的 error 口径不同
 *    （前者 `undefined` = 未记录，后者 `null` = 成功），此处仅计数用于一眼看"这步有没有出错"。
 */
export function StepDetailView({
  view,
  onOpenCall,
  onOpenStepFiles,
}: {
  view: StepDetailViewData;
  onOpenCall: (spanId: string) => void;
  /**
   * U2 任务 2.3/5.3：**从该步骤打开本 run 这一轮的文件**（design D2「自有步骤的文件入口
   * 提供明确轮末定位」）。`undefined` = 该步骤不是本 run 的自有完成步骤，**不渲染入口**
   * —— 祖先步骤不得提供会"冒充当前运行检查点"的入口（delta 明文）。
   */
  onOpenStepFiles?: () => void;
}) {
  return (
    <>
      <Section title="步骤概要">
        {onOpenStepFiles === undefined ? null : (
          <div className="mb-1">
            <button
              type="button"
              onClick={onOpenStepFiles}
              className="rounded border border-violet-300 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-800 hover:bg-violet-100"
            >
              打开该轮文件
            </button>
            <div className="mt-0.5 text-[10px] leading-4 text-gray-500">
              定位到本 run 该轮结束的文件检查点（不是历史检查点，也不借用父 run 的快照）。
            </div>
          </div>
        )}
        <KeyValue
          items={[
            ["迭代序号", String(view.iteration)],
            ["已记录调用", String(view.calls.length)],
            ["其中错误", String(view.errorCount)],
            ["耗时", formatDuration(view.durationMs)],
            ["输入 tokens", String(view.tokensIn)],
            ["输出 tokens", String(view.tokensOut)],
            ["工具调用", String(view.toolCalls)],
          ]}
        />
        <div className="mt-1 text-[11px] leading-5 text-gray-500">
          下列消耗为该步骤子树的派生值（现有轨迹口径）。点任一条调用可打开其原始请求与响应。
        </div>
      </Section>

      <Section title={`已记录调用（${view.calls.length}）`}>
        {view.calls.length === 0 ? (
          <div className="text-[11px] text-gray-400">
            该步骤下没有直接记录的 LLM 调用或工具执行。
          </div>
        ) : (
          <div className="space-y-1">
            {view.calls.map((call) => (
              <button
                key={call.spanId}
                type="button"
                onClick={() => onOpenCall(call.spanId)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-gray-100"
              >
                <span className="rounded bg-gray-200 px-1 font-code text-[10px] text-gray-600">
                  {call.kind === "llm.call" ? "llm" : "tool"}
                </span>
                <span className="min-w-0 flex-1 truncate font-code text-gray-700">
                  {call.label}
                </span>
                {call.errored ? (
                  <span className="rounded bg-red-100 px-1 text-[10px] text-red-800">错误</span>
                ) : null}
                <span className="font-code text-[10px] text-gray-400">
                  {shortSpanId(call.spanId)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

/** 短 ID（与 SpanTree 同一显示口径：只显示不影响复制，复制永远完整 ID） */
function shortSpanId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}
