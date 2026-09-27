import type { OperationRecord } from "@shared/operations";
import { formatDuration } from "./format";

/**
 * U5（unify-run-execution-workflow）任务 5.2：**真实等待计时**（design D6 第一段）。
 *
 * spec「跨页操作反馈展示真实等待与分层状态」的时间半边。四条判据，全部是**现算派生**：
 *
 * 1. **只用给得出的时间事实**：首选 renderer 本地提交时刻（`PendingSubmission.submittedAt`），
 *    其次 main 的 `startedAt`/`settledAt`。本地时刻在重载后丢失 ⇒ 退回 main `startedAt`
 *    并**明标"自接受起等待"**——那不是从提交起算的时长，措辞必须说清。
 * 2. **终态停增**：`settledAt` 在场 ⇒ 时长定格，文本明说"计时已停止"；
 *    执行中的时长是**等待时长**，不是模型耗时，更不是进度。
 * 3. **无时间事实不造数**：notAccepted / reconcile 封禁没有开始与结束时间（U4 契约），
 *    本地也没有提交时刻的未知历史 ⇒ 一律 null，界面什么都不显示。
 * 4. **时钟由调用方注入**（`nowMs`）：本模块不 `Date.now()`、不起定时器——
 *    计时不驱动任何轮询、执行或推测（可见性受控时钟在 `lib/use-wait-clock.ts`）。
 */

export type WaitBasis = "submitted" | "accepted";

export interface WaitView {
  /** 完整人话句子（含时长与口径标注） */
  readonly text: string;
  /** 还在增长吗（false = 终态定格；文本里也写死，组件不二次判断） */
  readonly growing: boolean;
  /** 时长基准：本地提交时刻，还是 main 接受时刻 */
  readonly basis: WaitBasis;
}

function isoToMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 非有限数值（NaN/Infinity）不是时间事实——绝不渲染 "NaNms" 这类假时长 */
function finiteOr(value: number | null, floorNow: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  // 未来时刻（本地与 main 时钟抖动）不给负等待：以"现在"为上限回退到 0 起点
  return Math.min(value, floorNow);
}

function clampElapsed(startMs: number, endMs: number): number {
  // 跨时钟源（本地 Date.now ↔ main ISO 时间）同机秒级一致，但乱序/舍入不得产出负数
  return Math.max(0, endMs - startMs);
}

const BASIS_TEXT: Record<WaitBasis, string> = {
  submitted: "自提交起",
  accepted: "自接受起",
};

/**
 * 一条操作的等待呈现。`record` = 登记事实（未知历史传 null），
 * `submittedAt` = 本地提交时刻（重载后没有 ⇒ null）。
 */
export function deriveWaitView(input: {
  record: OperationRecord | null;
  submittedAt: number | null;
  nowMs: number;
}): WaitView | null {
  const { record } = input;
  const nowMs = input.nowMs;
  const submittedAt = finiteOr(input.submittedAt, nowMs);

  if (record === null) {
    // 未知历史：只有"本地提交了多久"是可陈述事实，它**不是**执行时长，更不是结局
    if (submittedAt === null) return null;
    return {
      text: `${BASIS_TEXT.submitted}已过 ${formatDuration(clampElapsed(submittedAt, nowMs))}（结局未知：这段时间不表示执行进度）`,
      growing: true,
      basis: "submitted",
    };
  }

  switch (record.state) {
    case "notAccepted":
      // 没有开始也没有结束时间（U4 契约禁止给 notAccepted 造时间）——不造数
      return null;
    case "running": {
      const startMs = submittedAt ?? isoToMs(record.startedAt);
      if (startMs === null) return null;
      const basis: WaitBasis = submittedAt !== null ? "submitted" : "accepted";
      return {
        text: `${BASIS_TEXT[basis]}已等待 ${formatDuration(clampElapsed(startMs, nowMs))}（等待时长，不是模型耗时，也没有进度含义）`,
        growing: true,
        basis,
      };
    }
    case "settled": {
      const endMs = isoToMs(record.settledAt);
      const startMs = submittedAt ?? isoToMs(record.startedAt);
      if (endMs === null || startMs === null) return null;
      const basis: WaitBasis = submittedAt !== null ? "submitted" : "accepted";
      return {
        text: `${BASIS_TEXT[basis]}等待 ${formatDuration(clampElapsed(startMs, endMs))} 后收口（计时已停止）`,
        growing: false,
        basis,
      };
    }
  }
}
