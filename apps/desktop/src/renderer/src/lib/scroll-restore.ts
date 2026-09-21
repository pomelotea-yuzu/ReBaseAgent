/**
 * 滚动位置恢复与上限裁剪（U1 共用派生 · 任务 3.6）。
 *
 * 阅读器挂载后恢复滚动位置（design D6：「各阅读器在卸载前保存位置，重新装载内容后
 * 恢复并限制到合法滚动范围」）。本模块只做纯计算，不接触 DOM 类型、不读 store：
 * 组件从元素上读出 `scrollHeight`/`clientHeight` 后调用这里，再把结果写回 `scrollTop`。
 * 概览与步骤目录的"何时恢复"由 `restore-gate` 决定，这里只管"恢复到哪个位置"。
 *
 * 纪律：
 * - **不知道 ≠ 0**：容器还没量到尺寸（`scrollHeight`/`clientHeight` 为 0，如内容尚未挂载、
 *   元素未布局）时返回 `null`，表示"此刻不能恢复"，**不得**拿 0 当"恢复到底部"或"已在顶部"
 *   写进状态——那会把用户记住的位置抹掉。
 * - **裁剪是必须的**：记录的位置来自旧内容（可能更长），重挂载后内容变短时必须夹到
 *   `[0, scrollHeight - clientHeight]`，否则浏览器会静默夹到 0 或最大值，用户看到的位置
 *   与记录对不上。
 * - **负值与 NaN 一律归 0**：记录字段来自渲染层，仍按不可信输入处理。
 */

/** 判断容器是否可以用于恢复（尚未完成布局 ⇒ 不可用） */
export function canRestoreScroll(height: {
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  // scrollHeight 为 0 = 内容还没挂载；clientHeight 为 0 = 元素未布局（display:none 等）
  return height.scrollHeight > 0 && height.clientHeight > 0;
}

/**
 * 计算可写回的 `scrollTop`：不可恢复时返回 `null`（调用方不得写入）。
 *
 * @param saved  会话里记住的位置（可能来自更长的旧内容，也可能是负值/NaN）
 * @param height 当前容器实测高度
 */
export function resolveRestoreScrollTop(
  saved: number,
  height: { scrollHeight: number; clientHeight: number },
): number | null {
  if (!canRestoreScroll(height)) return null;
  const max = Math.max(0, height.scrollHeight - height.clientHeight);
  // NaN 归 0；正无穷等价于"到底部"（夹到上限），负无穷归 0
  if (Number.isNaN(saved)) return 0;
  if (saved === Number.POSITIVE_INFINITY) return max;
  if (saved === Number.NEGATIVE_INFINITY) return 0;
  return Math.min(Math.max(0, saved), max);
}

/**
 * 是否应当把"读到过底部"这一事实继续保留。
 *
 * 内容变短后原来的位置可能不再等于底部；用于判断是否需要把记录刷新为新位置。
 * 内容不足一屏（无需滚动）时**不算**读到过底部——那是"没有可滚动的"，不是"滚到了底"。
 */
export function isAtBottom(
  top: number,
  height: { scrollHeight: number; clientHeight: number },
): boolean {
  if (!canRestoreScroll(height)) return false;
  const max = height.scrollHeight - height.clientHeight;
  if (max <= 0) return false;
  return top >= max;
}

/**
 * 恢复滚动位置：概览 / 步骤目录 / 调用详情共用同一套裁剪规则。
 *
 * @returns 可写回的 top，或 `null` 表示此刻不恢复（**保持用户当前的位置不动**）
 */
export function resolveScrollRestore(
  saved: number | undefined,
  height: { scrollHeight: number; clientHeight: number },
): number | null {
  if (saved === undefined) return null;
  return resolveRestoreScrollTop(saved, height);
}
