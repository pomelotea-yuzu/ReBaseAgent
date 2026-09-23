/**
 * 文件正文（Monaco diff）滚动位置的**行列锚点**派生（U2 任务 4.3 / 5.3）。
 *
 * design D1 明写：「listScrollTop、contentScroll | 列表位置按检查点保存；正文按
 * run/step/path/**侧**记录行列锚点与滚动偏移」。
 *
 * 为什么正文不能像列表那样只存一个像素值：正文内容**随 (检查点, 路径) 整体更换**，
 * 同一像素偏移在另一份内容里指向完全不同的位置（甚至越界被夹到 0）。故正文记的是
 * **行列锚点 + 相对偏移**：
 *   - `line`：保存时**首个可见行**的行号（1 基）；
 *   - `offset`：`scrollTop − 该行顶部像素`，即"这一行被卷上去多少像素"。
 * 恢复时按当前内容重算该行顶部像素再叠加偏移 —— 内容长短变化、换行开关切换、
 * 字体/缩放变化都不会让位置指向错误的地方（只可能被夹到合法范围）。
 *
 * 纪律（与 `scroll-restore.ts` 同源）：
 * - **不知道 ≠ 0**：容器尚未布局（`scrollHeight`/`clientHeight` 为 0）时返回 `null`，
 *   调用方**不得**写入 —— 写 0 会把用户记住的位置抹掉。
 * - **锚点必须匹配对象**：`stepSpanId` + `path` 都相等才算"这是同一个阅读对象"，
 *   否则不得套用（跨 run 同名 step/同名 path 正是本段禁止的串状态）。
 * - **数值一律按不可信输入处理**：非有限值、行号 < 1 一律归一。
 */

import { resolveRestoreScrollTop } from "./scroll-restore";

/**
 * 正文滚动锚点（存进 `FileReadingState.contentScroll`）。
 *
 * ⚠️ 只含**位置**，不含任何正文副本、行内容或编辑器实例（design D1/D6 纪律）。
 */
export interface ContentScrollAnchor {
  /** 该位置属于哪个检查点（null = 本 run 初始状态） */
  readonly stepSpanId: string | null;
  /** 该位置属于哪个完整逻辑路径 */
  readonly path: string;
  /** 首个可见行（1 基） */
  readonly line: number;
  /** 「该行顶部被卷上去的像素数」（≥0） */
  readonly offset: number;
}

/** 把任意行号归一到合法的 1 基行号（NaN / Infinity / <1 / 小数一律收敛） */
export function clampAnchorLine(line: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.max(1, Math.floor(line));
}

/**
 * 由编辑器当前的可见状态构造锚点。
 *
 * @param topLine    首个可见行号（`getVisibleRanges()[0].startLineNumber`）
 * @param lineTop    当前内容里该行顶部的像素位置（`getTopForLineNumber`）
 * @param scrollTop  当前 `scrollTop`
 */
export function buildContentAnchor(input: {
  stepSpanId: string | null;
  path: string;
  topLine: number;
  lineTop: number;
  scrollTop: number;
}): ContentScrollAnchor {
  const line = clampAnchorLine(input.topLine);
  const scrollTop = Number.isFinite(input.scrollTop) ? input.scrollTop : 0;
  // lineTop 不可信时偏移记 0：宁可"恢复到行顶"，也不记一个来路不明的像素量
  const offset = Number.isFinite(input.lineTop) ? Math.max(0, scrollTop - input.lineTop) : 0;
  return { stepSpanId: input.stepSpanId, path: input.path, line, offset };
}

/** 两个锚点是否**指向同一位置**（用于滚动事件去重，避免每次滚动都写 store） */
export function sameAnchor(a: ContentScrollAnchor | null, b: ContentScrollAnchor | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.stepSpanId === b.stepSpanId &&
    a.path === b.path &&
    a.line === b.line &&
    Math.abs(a.offset - b.offset) < 1
  );
}

/**
 * 锚点是否属于当前阅读对象（run 内的 step + path）。
 *
 * ⚠️ 只比 step 与 path —— run 身份由**调用方**保证（阅读状态本就按 runId 隔离）。
 *    同名 path 在不同 run / 不同 step 下**不得**互认（delta「不借用另一运行或同名路径」）。
 */
export function anchorMatches(
  anchor: ContentScrollAnchor | null | undefined,
  stepSpanId: string | null,
  path: string | null,
): anchor is ContentScrollAnchor {
  if (anchor === null || anchor === undefined) return false;
  if (path === null) return false;
  return anchor.stepSpanId === stepSpanId && anchor.path === path;
}

/**
 * 计算恢复时要写回的 `scrollTop`。
 *
 * @param anchor 保存的锚点
 * @param ctx    **当前内容**的实测值：该行顶部像素、编辑器滚动高度与可视高度
 * @returns 可写回的 top；`null` = 此刻不可恢复（容器尚未布局，**保持用户当前位置不动**）
 */
export function resolveAnchorScrollTop(
  anchor: ContentScrollAnchor,
  ctx: { lineTop: number; scrollHeight: number; clientHeight: number },
): number | null {
  if (!Number.isFinite(ctx.lineTop)) return null;
  // 复用统一裁剪：越界夹到 [0, scrollHeight - clientHeight]，NaN/±Infinity 另有口径
  return resolveRestoreScrollTop(ctx.lineTop + Math.max(0, anchor.offset), {
    scrollHeight: ctx.scrollHeight,
    clientHeight: ctx.clientHeight,
  });
}
