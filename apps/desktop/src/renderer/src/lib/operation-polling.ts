/**
 * U4 任务 4.5：**单路有界轮询**的判据（design D6）。
 *
 * 四条规则都写在这里，因为它们必须能被逐条证伪，而不是藏在 `setTimeout` 的顺序里：
 * 1. **计时起点是"上一次响应完成"**，不是"请求发出"——慢响应不堆积定时请求
 *    （spec 原文「对已知 running 使用单路有界轮询（初值 1 秒，不重叠）」）；
 * 2. **在飞期间不再发第二个**（单路）：既不排队，也不叠加定时器；
 * 3. **没有已知 running（也没有本地未确认提交）就停**：轮询只为等在跑的操作，
 *    空闲时不该持续打 IPC；
 * 4. **失联即停**：status 失败/载荷非法 ⇒ 进未知，自动轮询停下，
 *    但**手动核对不受它限制**（spec「状态通道不可用保持未知 ……只允许重新核对」）。
 *
 * 轮询只读 `operations:status`，**绝不重放业务 payload**——重放等于自动重发，
 * 那是 spec 明确禁止的（不自动重发、不生成新 ID）。
 */

/** 初值 1 秒；校准依据见 `docs/engineering/notes/2026-09-26-u4-snapshot-cost.md`（任务 4.5 实测） */
export const POLL_INTERVAL_MS = 1000;

export interface PollState {
  /** 一次 status 请求正在飞（单路守卫） */
  readonly inFlight: boolean;
  /** 已排定下一次轮询（不叠加） */
  readonly armed: boolean;
}

export function initialPollState(): PollState {
  return { inFlight: false, armed: false };
}

/** 轮询该不该继续跑 */
export interface PollContext {
  /** main 快照里有 running，或本地还有未确认终态的提交 */
  readonly hasActive: boolean;
  /** 通信未知（上一次 status/reconcile 失败或载荷非法） */
  readonly unknown: boolean;
}

export type PollAction = { type: "arm"; delayMs: number } | { type: "poll" } | { type: "none" };

export interface PollStep {
  readonly state: PollState;
  readonly action: PollAction;
}

/**
 * 一次执行/核对的响应完成后调用：只有还在跑且通信正常才排下一次。
 * 在飞或已排定 ⇒ 不重复排（同一时刻至多一个定时器）。
 */
export function onResponseSettled(state: PollState, ctx: PollContext): PollStep {
  if (!ctx.hasActive || ctx.unknown || state.armed) {
    return { state: { ...state, armed: false }, action: { type: "none" } };
  }
  return { state: { ...state, armed: true }, action: { type: "arm", delayMs: POLL_INTERVAL_MS } };
}

/** 定时器到点：在飞则不发（丢弃这次触发），否则开始一次轮询 */
export function onTimerFired(state: PollState, ctx: PollContext): PollStep {
  if (state.inFlight || !ctx.hasActive || ctx.unknown) {
    return { state: { ...state, armed: false }, action: { type: "none" } };
  }
  return { state: { inFlight: true, armed: false }, action: { type: "poll" } };
}

/** 轮询返回：成功则按"响应完成"重新计时；失败即停（不再自动打 IPC） */
export function onPollSettled(state: PollState, ctx: PollContext, ok: boolean): PollStep {
  const released: PollState = { inFlight: false, armed: false };
  if (!ok) return { state: released, action: { type: "none" } };
  return onResponseSettled(released, ctx);
}

/** 主动放弃轮询（例如会话未知被外部标记） */
export function disarmPoll(state: PollState): PollState {
  return { inFlight: state.inFlight, armed: false };
}
