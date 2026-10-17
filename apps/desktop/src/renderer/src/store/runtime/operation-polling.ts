// 轮询 runtime（refactor-renderer 4.2）：单路有界轮询的唯一资源所有者。
// 判据在 `lib/operation-polling.ts`（纯状态机），这里只管那一个计时器；
// 轮询**只读 status**，绝不重放业务 payload（重放等于自动重发，spec 明令禁止）。
//
// store 实例依赖经惰性回调注入（design D2/D3）：本模块不导入 `useAppStore`、
// 不在模块顶层缓存 store 实例；由 store.ts 在唯一 create 之后按实例组合一次。
// 停止语义与搬迁前逐字一致：清计时器、保留在飞守卫，手动核对不受它限制。
import {
  type PollContext,
  type PollState,
  type PollStep,
  disarmPoll,
  initialPollState,
  onPollSettled,
  onResponseSettled,
  onTimerFired,
} from "../../lib/operation-polling";
import { hasSameEpochPending } from "../../lib/operation-session";
import type { OperationSession } from "../../lib/operation-session";

/** 轮询对 store 的全部依赖（惰性回调：调用时才触达当前 store 实例） */
export interface OperationPollingContext {
  /** 当前操作会话（每次调用时读取，不缓存快照） */
  getSession: () => OperationSession;
  /** 状态读取入口（即 `refreshOperationStatus` action；轮询与手动核对同一条路） */
  refreshOperationStatus: () => Promise<OperationSession>;
}

/** 单路有界轮询的资源句柄（每个 store 实例恰好一份，由 store.ts 组合） */
export interface OperationPollingRuntime {
  /** 可信响应/握手之后重新计时（计时起点是"响应完成"，慢响应不会堆积） */
  rescheduleStatusPoll(): void;
  /** 停止自动轮询（保留在飞守卫；手动核对不受它限制） */
  stopOperationStatusPolling(): void;
}

export function createOperationPollingRuntime(
  context: OperationPollingContext,
): OperationPollingRuntime {
  let pollState: PollState = initialPollState();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function pollContextOf(session: OperationSession): PollContext {
    return {
      // 本地未确认终态的提交也算"还在跑"：回执丢失时正是需要核对的时候。
      // 任务 4.6：只数**同 epoch** 的在飞身份——旧会话的未知历史该被核对，但不该永远锁住新会话。
      hasActive: session.activeOperationId !== null || hasSameEpochPending(session),
      unknown: session.unknown,
    };
  }

  /** 任何一步都先清掉旧定时器 ⇒ 同一时刻至多一个待触发的轮询 */
  function applyPollStep(step: PollStep): void {
    pollState = step.state;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (step.action.type === "arm") {
      const delay = step.action.delayMs;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void runStatusPoll();
      }, delay);
    }
  }

  async function runStatusPoll(): Promise<void> {
    const step = onTimerFired(pollState, pollContextOf(context.getSession()));
    pollState = step.state;
    if (step.action.type !== "poll") return;
    const session = await context.refreshOperationStatus();
    applyPollStep(onPollSettled(pollState, pollContextOf(context.getSession()), !session.unknown));
  }

  return {
    rescheduleStatusPoll() {
      applyPollStep(onResponseSettled(pollState, pollContextOf(context.getSession())));
    },
    stopOperationStatusPolling() {
      applyPollStep({ state: disarmPoll(pollState), action: { type: "none" } });
    },
  };
}
