import type { RunDetail } from "./ipc";
import type { Outcome } from "./outcome";
import type { ErrorTarget, OwnOutput } from "./overview";
import { deriveOwnOutput } from "./overview";
import { deriveOwnTerminalFacts } from "./terminal-facts";

/**
 * U7（improve-branch-comparison）tasks 4.5：比较侧的**单侧输出事实**。
 *
 * design D4：「输出使用 `deriveOwnOutput` 与同一结局分类，错误定位带
 * `(runId, spanId)`。」——本模块是**薄组合层**，不重写任何判据：
 * - 结局/终止原因/失败定位复用 `deriveOwnTerminalFacts`（U5 的自有终止事实：
 *   正常结束只认末条 `stopped+completed`、自有段由 leafSpanIds 界定、
 *   展示结局走 `classifyOutcome`）；
 * - 输出选择复用 `deriveOwnOutput`（四条件最终输出、中间正文不冒充、
 *   绝不借用祖先正文）。
 *
 * 三条不许猜的纪律全部由上游模块承载，这里只补**侧身份**：
 * - `failure.runId` —— 跳转目标必须与该侧 run 绑定，视图据此给「打开该侧的
 *   失败调用」入口（store 动作 `openCompareSideError` 消费 (runId, spanId)）；
 * - 只在 error 终止时 `failure` 才有定位目标（上游同款：非 error 终止
 *   不产生错误目标），`missingDetail` 如实区分「错误详情未记录」。
 */

/** 比较中一侧 run 的输出事实（输入是该侧已校验 RunDetail） */
export interface SideOutputFacts {
  /** 该侧 run id（= detail.meta.id；跳转目标绑定的身份） */
  readonly runId: string;
  /** 自有终止原因（crashed ⇒ null，不猜；与结局分类同源） */
  readonly reason: string | null;
  /** 展示结局（唯一判据来源 classifyOutcome，与列表/概览同源） */
  readonly outcome: Outcome;
  /** 自有输出选择（最终输出/中间正文/缺失分型；不借祖先） */
  readonly output: OwnOutput;
  /** 错误定位目标：带 runId 的可跳转事实（error 终止且自有失败调用在场时有定位） */
  readonly failure: ErrorTarget & { readonly runId: string };
}

/** 从该侧已校验详情派生输出事实（纯函数，零 Electron / 零 Node） */
export function deriveSideOutputFacts(detail: RunDetail): SideOutputFacts {
  const terminal = deriveOwnTerminalFacts({
    status: detail.status,
    events: detail.events,
    spans: detail.spans,
    leafSpanIds: detail.leafSpanIds,
  });
  const output = deriveOwnOutput({
    spans: detail.spans,
    leafSpanIds: detail.leafSpanIds,
    reason: terminal.reason,
  });
  return {
    runId: detail.meta.id,
    reason: terminal.reason,
    outcome: terminal.outcome,
    output,
    failure: { ...terminal.failure, runId: detail.meta.id },
  };
}

// ---------------------------------------------------------------------------
// tasks 4.6（纯派生半边）：只读文本 diff 的门禁
//
// delta 判据：「只有两侧均为已记录最终文本时才能进入文本 diff；错误、未记录、
// reasoning-only 不能作为空文本参与 diff」——门禁不可用时不产生伪空 diff，
// 并如实说明缺的是哪一侧、缺成什么样。
// ---------------------------------------------------------------------------

/** diff 门禁结论：可用（双方最终文本就绪）或不可用（各侧真实状态如实说明） */
export type CompareDiffGate =
  | {
      readonly status: "available";
      /** 左右最终正文（已记录最终输出，非空字符串） */
      readonly leftText: string;
      readonly rightText: string;
      /** 各自产出 span（供「打开该调用」） */
      readonly leftSpanId: string;
      readonly rightSpanId: string;
    }
  | {
      readonly status: "unavailable";
      /** 受控中文原因（指出哪一侧、缺成什么型），不生成伪空 diff */
      readonly reason: string;
    };

const MISSING_TEXT: Record<NonNullable<OwnOutput["missingReason"]> | "aborted", string> = {
  "no-llm-call": "未记录任何自有模型调用",
  "empty-content": "最终调用无正文",
  "has-error": "最终调用带错误",
  "pending-tool-calls": "有待执行的工具调用（循环未竟）",
  aborted: "非正常终止且无正文",
};

/**
 * 只读文本 diff 门禁：两侧 `deriveSideOutputFacts` 就绪后调用。
 * 双方均有已记录最终输出（非空正文 + 正常结束 + 无错误 + 无待执行工具）
 * 才可用；任一侧缺失 ⇒ unavailable，绝不用中间正文/空串顶替。
 */
export function deriveCompareDiffGate(
  left: SideOutputFacts,
  right: SideOutputFacts,
): CompareDiffGate {
  const sides: readonly [SideOutputFacts, SideOutputFacts] = [left, right];
  for (let i = 0; i < sides.length; i++) {
    const side = sides[i];
    if (side === undefined) continue;
    const label = i === 0 ? "左侧" : "右侧";
    const { finalOutput } = side.output;
    if (finalOutput === null) {
      const detail =
        side.output.missingReason !== null
          ? MISSING_TEXT[side.output.missingReason]
          : "未记录最终输出";
      return {
        status: "unavailable",
        reason: `${label}（${side.runId}）${detail}：不能作为空文本参与 diff`,
      };
    }
  }
  const leftOut = left.output.finalOutput;
  const rightOut = right.output.finalOutput;
  if (leftOut === null || rightOut === null) {
    return { status: "unavailable", reason: "最终输出未就绪" };
  }
  return {
    status: "available",
    leftText: leftOut.content,
    rightText: rightOut.content,
    leftSpanId: leftOut.spanId,
    rightSpanId: rightOut.spanId,
  };
}
