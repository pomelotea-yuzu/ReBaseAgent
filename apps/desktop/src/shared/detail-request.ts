/**
 * 详情请求的**归属**判定（U1 共用派生 · 任务 3.3）。
 *
 * 场景：用户快速点 run A → run B，A 的 `getRun` 后返回。若不加归属判定，
 * A 的结果会盖掉 B 的详情；又若 A 的请求**失败**，A 的 finally 会把
 * B 正在进行的 `loadingDetail` 清成 false——用户看到 B 在转圈时突然显示空态。
 *
 * 判据：**目标 run 是否仍是当前选中 run**。
 *   - 不同 ⇒ 该响应/收尾属于"已切走的 run"，渲染层必须整体丢弃
 *     （既不写 detail，也不动 loadingDetail/error——那是 B 的）。
 *   - 相同 ⇒ 允许落地；同 run 重试因此天然安全（后发的成功会正常覆盖）。
 *
 * 纯函数、无 store 依赖：组件与 store 用同一份实现，避免两处口径漂移。
 */

import type { RunDetail } from "./ipc";
import type { Envelope } from "./ipc";

/** 详情响应是否属于当前选中的 run */
export function isDetailForSelectedRun(
  selectedRunId: string | null,
  requestedRunId: string,
): boolean {
  return selectedRunId === requestedRunId;
}

/**
 * 失败收尾是否应当落地：只有"仍在等这个 run 的详情"才允许写错误与清加载态。
 *
 * 注意与 `isDetailForSelectedRun` 分开——失败分支要看**请求发出时**的选中 run，
 * 而不是失败到达时的（两者在切换后必然不同）。
 */
export function shouldApplyDetailFailure(
  selectedRunIdAtRequest: string | null,
  selectedRunIdNow: string | null,
  requestedRunId: string,
): boolean {
  return requestedRunId === selectedRunIdAtRequest && requestedRunId === selectedRunIdNow;
}

/** 详情响应是否属于当前选中 run（供成功分支：用**当前**选中判断即可） */
export function isCurrentDetailResponse(
  selectedRunIdNow: string | null,
  requestedRunId: string,
): boolean {
  return selectedRunIdNow === requestedRunId;
}

/**
 * U6 任务 4.5：这次响应/失败收尾是否仍是**当代**详情读取。
 *
 * 为什么只有 run-ID 归属不够：同一 run 的**连续两次重试**（父文件恢复前后各读一次、
 * 或快速双击重试）都是 `selectedRunId === id`——若只按归属判定，先发出、后返回的
 * 旧响应会把新读取刚落地的结论覆盖掉（旧 completeness 冒充现状）。读取调度在每次
 * 实际发请求时递增代次，响应落地前必须与**当前**代次全等；小代次一律整体丢弃
 * （不写 detail、不动 loadingDetail/error——那是新读取的现场）。
 */
export function isCurrentDetailAttempt(attemptAtRequest: number, attemptNow: number): boolean {
  return attemptAtRequest === attemptNow;
}

/** 便捷：从一个信封载荷里取 run id（meta.id），取不到返回 null */
export function runIdOfDetailData(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const meta = (data as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const id = (meta as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/**
 * 落地前的最后一道闸：**载荷自称的 run id 必须与请求的 run id 一致**。
 *
 * 为什么不能只信"目标 run 仍是当前选中"：main 若回错 run（或信封被串），
 * 渲染层会把别的 run 的轨迹当成当前 run 展示——这正是"非法详情不被概览绕过"
 * 要求堵住的口子。不一致 ⇒ 视为非法，不落地。
 */
export function isDetailPayloadForRun(data: unknown, requestedRunId: string): boolean {
  return runIdOfDetailData(data) === requestedRunId;
}

/** 供测试注入的响应延迟钩子（不参与生产逻辑） */
export type DetailResponseEnvelope = Envelope<RunDetail>;
