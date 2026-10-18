// 代理协调 runtime（refactor-renderer 4.3）：代理变化订阅句柄与状态读取
// 静默等待者的唯一资源所有者。两者都是**在飞资源**，不是 UI 状态
// （放 store 字段会进渲染依赖，且 StrictMode 双挂载下句柄时序更脆）。
//
// store 实例依赖经惰性回调注入（design D2/D3）：本模块不导入 `useAppStore`、
// 不在模块顶层缓存 store 实例；由 store.ts 按实例组合一次（4.3 原在 create 之后，
// 5.6 起 configuration 分片工厂要把句柄注入代理订阅/静默入口 ⇒ 组合点前移到 create 前）。
// ensure/release 的幂等性与"先结算、后唤醒"顺序逐字保持，不因拆分重新设计。
import type { ProxyStatusReadState } from "../../lib/proxy-status-read";

/** 代理协调对 store/通道的全部依赖（惰性回调：调用时才触达当前 store 实例） */
export interface ProxyCoordinationContext {
  /** 订阅 main 通知的通道入口（`api.onProxyChanged`；测试经 `window.api` 桩换掉） */
  onProxyChanged: (handler: (payload: unknown) => void) => () => void;
  /** 每条通知的处理体（载荷过 schema → 计划 → 读取/游标推进；由 store 组合时注入） */
  handleEvent: (payload: unknown) => void;
  /** 当前状态读取面（调用时读取；静默判据 = 在途 0 且无尾随） */
  getProxyStatusRead: () => ProxyStatusReadState;
}

/** 单例资源句柄（每个 store 实例恰好一份，由 store.ts 组合） */
export interface ProxyCoordinationRuntime {
  /** 幂等建立订阅；已有订阅时不再调用通道（重复订阅=一次落盘触发两次刷新） */
  ensureSubscription(): void;
  /** 解绑并清空句柄；未订阅时无害。⚠️ 测试用它复位——跨用例残留订阅会互相污染 */
  releaseSubscription(): void;
  /** 每次状态读取结算后唤醒等待者（`loadProxyStatus` finally 接线） */
  notifyProxyStatusSettled(): void;
  /** 已静默则立即 resolve；否则排在等待队列里 */
  settledProxyStatusRead(): Promise<void>;
}

/**
 * 代理变化订阅的解绑句柄（design D1，tasks 1.3）。
 *
 * `null` = 当前没有订阅，`ensureSubscription` 借它做幂等。
 * ⚠️ 测试用 `releaseSubscription`（经 store action `releaseProxyChangeSubscription`）复位——
 * 跨用例残留订阅会让"一条通知触发几次读取"的断言互相污染。
 */
export function createProxyCoordinationRuntime(
  context: ProxyCoordinationContext,
): ProxyCoordinationRuntime {
  let proxyChangeUnsubscribe: (() => void) | null = null;

  /**
   * 代理状态读取的**静默等待者**（tasks 2.1）。
   *
   * 合并调度让 `loadProxyStatus` 在"已有读取在飞"时立即返回（只登记尾随），
   * 于是"await 完就能拿到新事实"这个旧前提对**被合并的那次调用**不再成立。
   * 需要"读到最新事实再判据"的调用方（`reconcileProxyFacts`、messages 打开时的
   * 门禁核对）必须先过这道静默门，否则会把"没读到"当成"没有变化"。
   */
  const proxyStatusReadWaiters = new Set<() => void>();

  /**
   * 等到状态读取完全静默（在途 0 且无尾随）为止。
   *
   * ⚠️ 必须在每次 `settleStatusRead` 之后调用（store 的 `loadProxyStatus` finally 里
   * 已接上）。补发的那次读取会重新置起在途计数，因此**先结算、后唤醒**的顺序很关键：
   * 若在 `shouldRefire` 分支之前唤醒，等待者会在补发还在飞时就返回。
   */
  function notifyProxyStatusSettled(): void {
    if (proxyStatusReadWaiters.size === 0) return;
    for (const wake of [...proxyStatusReadWaiters]) wake();
  }

  return {
    ensureSubscription() {
      // 幂等：StrictMode 下挂载 effect 会跑两次，重复订阅会让一次落盘触发两次刷新
      if (proxyChangeUnsubscribe !== null) return;
      proxyChangeUnsubscribe = context.onProxyChanged(context.handleEvent);
    },

    releaseSubscription() {
      proxyChangeUnsubscribe?.();
      proxyChangeUnsubscribe = null;
    },

    notifyProxyStatusSettled,

    settledProxyStatusRead() {
      const read = context.getProxyStatusRead();
      if (read.inFlight === 0 && read.pending === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        proxyStatusReadWaiters.add(resolve);
      });
    },
  };
}
