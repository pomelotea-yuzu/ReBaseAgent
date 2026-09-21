/**
 * 列表刷新的**在途合并**判定（U1 共用派生 · 任务 3.4）。
 *
 * 场景：列表刷新没有前端按钮时的重复触发（挂载、执行收尾、用户手动重试），
 * 以及"刷新请求在途时执行收尾又要求刷新"。
 * 若不加合并，两条 `listRuns` 会并发发射：后发先至时旧结果覆盖新结果，
 * 用户刚跑完的 run 会从列表里"消失"（要再点一次刷新才出现）。
 *
 * 纪律（对应 desktop-ui delta「刷新合并且保留阅读」）：
 *   - **在途合并**：已有请求在途 ⇒ 不并发发射，只登记"还需要一次"；
 *   - **尾随补发一次**：当前请求结束后若有登记，补发**恰好一次**（不排队 N 次，
 *     N 次重复刷新只换来一次补发——否则频繁触发会形成雪崩）；
 *   - **单纯刷新不选新记录**：合并与补发都只动列表数据，不改 selectedRunId。
 *
 * 纯函数、无 store 依赖：store 只负责把结果落到状态与计数器。
 */

/** 刷新的调度决定 */
export type RefreshDecision =
  /** 立即发射请求 */
  | { action: "start"; inFlight: number; pending: number }
  /** 已有请求在途：只登记尾随，不发射 */
  | { action: "deferred"; inFlight: number; pending: number };

/**
 * 收到一次刷新意图时应当做什么。
 *
 * @param inFlight 当前在途的刷新请求数（正常恒为 0 或 1）
 * @param pending  已登记的尾随次数（合并语义下恒为 0 或 1）
 */
export function decideRefresh(inFlight: number, pending: number): RefreshDecision {
  if (inFlight > 0) {
    // 合并：无论来多少次，只登记"还需要一次"
    return { action: "deferred", inFlight, pending: 1 };
  }
  return { action: "start", inFlight: inFlight + 1, pending };
}

/**
 * 一次刷新请求结束时，是否应当补发尾随请求。
 *
 * @returns `nextInFlight` 为**本次请求收尾后**的在途数（补发前）；
 *          `shouldRefire` 为 true 时调用方应再走一次完整的 `loadRuns`
 *          （由它自己按 `decideRefresh` 登记在途数），而不是旁路直发请求——
 *          旁路直发会让补发的那次请求无人递减在途计数，计数器永久残留。
 */
export function settleRefresh(
  inFlight: number,
  pending: number,
): { inFlight: number; pending: number; shouldRefire: boolean } {
  const nextInFlight = Math.max(0, inFlight - 1);
  // 只有"没有别的请求还在途"时才补发，否则继续合并
  const shouldRefire = nextInFlight === 0 && pending > 0;
  return { inFlight: nextInFlight, pending: 0, shouldRefire };
}

/**
 * 刷新失败后的状态结论：**保留旧记录**，只标记"未更新"。
 *
 * 「列表刷新失败可重试」要求：已有列表的刷新失败 ⇒ 保留旧记录并显示未更新；
 * 首次读取失败（从未成功过）⇒ 显示可重试错误。两者都不生成假记录、不清空阅读位置。
 */
export function resolveRefreshFailure(hadLoadedBefore: boolean): {
  keepRuns: boolean;
  stale: boolean;
  clearFailedFiles: boolean;
} {
  return {
    // 旧记录一律保留（含 failed 文件列表）：失败不倒退
    keepRuns: true,
    // 有过成功加载 ⇒ 标记列表未更新；首次失败不算"未更新"（本来就没有可过期的数据）
    stale: hadLoadedBefore,
    clearFailedFiles: false,
  };
}
