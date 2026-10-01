import type { OperationRecord } from "@shared/operations";
import type { OperationResultView } from "./operation-result-view";
import { deriveOperationResultView, requestFactsLineOf } from "./operation-result-view";
import type { ResultReadStore } from "./result-verification";

/**
 * U8（unify-recording-and-experiment-workspaces）任务 5.4：**messages 工作区结果区的
 * 唯一派生口**（design D7：操作和结果直接复用 proxyFork 提交、登记、按 ID 核实）。
 *
 * 三条边界：
 * 1. **只认 main 登记**：只取 `target.kind === "proxy"` 且 `parentRunId`/`atSpanId`
 *    与目标逐字一致的登记记录——被动录制的 run 没有 operation 身份，结构上进不了
 *    本派生口（任务 5.5「主动重发结果不借被动记录」的承载面之一）；
 * 2. **逐条呈现复用 `deriveOperationResultView`**（U5 3.5/3.6 的判据，不抄第二份）：
 *    running / not-accepted / unlocated / items 四态 + 可信 ID 动作 + 返回草稿
 *    （draftPresentOf 由容器从 store 注入）；
 * 3. **请求事实单独一行**（`requestFactsLineOf`）：失败信封与运行结局分层——
 *    失败/未知都保留输入（清理判据归 store 的收尾汇合点，这里只呈现）。
 */

/** 一次 messages 重发提交在工作区结果区的呈现 */
export interface MessagesResultView {
  /** main 会话 id（动作身份的一部分） */
  readonly epoch: string;
  readonly operationId: string;
  /** 逐条呈现（与操作面板同一派生口径） */
  readonly view: OperationResultView;
  /** 信封侧请求事实（与逐条运行结局分层）；null = running / notAccepted */
  readonly requestLine: string | null;
}

export function deriveMessagesResults(input: {
  readonly targetRunId: string;
  readonly targetSpanId: string;
  readonly operations: readonly OperationRecord[];
  readonly reads: ResultReadStore;
  readonly draftPresentOf: (record: OperationRecord) => boolean;
}): readonly MessagesResultView[] {
  const records = input.operations.filter(
    (record) =>
      record.target?.kind === "proxy" &&
      record.target.parentRunId === input.targetRunId &&
      record.target.atSpanId === input.targetSpanId,
  );
  const sorted = [...records].sort((a, b) => {
    const ta = a.startedAt ?? "";
    const tb = b.startedAt ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0;
  });
  return sorted.map((record) => ({
    epoch: record.epoch,
    operationId: record.operationId,
    view: deriveOperationResultView({
      record,
      reads: input.reads,
      draftPresent: input.draftPresentOf(record),
    }),
    requestLine: requestFactsLineOf(record),
  }));
}
