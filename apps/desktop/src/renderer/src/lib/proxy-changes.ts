import type { ProxyChangeEvent, ProxyState } from "@shared/ipc";

/**
 * 代理变化通知的**消费判据**（design D1，tasks 1.3）。
 *
 * 纯函数、无 store 依赖：store 只负责按结论调用 `loadRuns` / `loadProxyStatus`。
 * 四条规则都写在这里，因为它们必须能被逐条证伪，而不是藏在 `setTimeout` 的顺序里：
 *
 * 1. **先订阅后首读**：订阅必须在首次读状态**之前**建立，否则两者之间落盘的记录
 *    会被双方都漏掉（本模块提供 `shouldApplyChange` 的补读判据，但补的是
 *    "读到的 revision 比通知旧"，补不了"通知根本没发生过"）。
 * 2. **旧会话的通知一律丢弃**：`epoch` 不同 ⇒ 那是上一届 main 的事实，
 *    拿它否决当前 main 会把新事实按回旧状态。
 * 3. **同会话内 revision 不回退**：落后的通知只补读、不回写状态。
 * 4. **`records` 类别才触发列表刷新**；只有 `status` 时不重读列表
 *    ——凭据变化不产生新 run，刷列表是白读一次全量 traces。
 *
 * ⚠️ 刷新一律走 `loadRuns`（它自带在途合并 + 尾随补发），**不得**旁路直发
 * `runs:list`：旁路会让补发的那次请求无人递减在途计数，计数器永久残留
 * （见 `list-refresh.ts` 的纪律）。
 */

/** renderer 侧已采纳的代理事实版本（`null` = 还没读过状态） */
export interface ProxyFactCursor {
  readonly epoch: string | null;
  readonly revision: number;
  readonly recordsRevision: number;
}

export const initialProxyFactCursor: ProxyFactCursor = {
  epoch: null,
  revision: 0,
  recordsRevision: 0,
};

/** 读完 `proxy:status` 后推进游标 */
export function cursorFromStatus(
  cursor: ProxyFactCursor,
  state: Pick<ProxyState, "epoch" | "revision" | "recordsRevision">,
): ProxyFactCursor {
  // 会话轮换 ⇒ 整份重来（不能把新 main 的 revision 与旧 main 的数字放在同一尺度上比）
  if (cursor.epoch !== null && cursor.epoch !== state.epoch) {
    return { epoch: state.epoch, revision: state.revision, recordsRevision: state.recordsRevision };
  }
  return {
    epoch: state.epoch,
    // 乱序守卫：只前进，不回退（status 响应可能与通知交错）
    revision: Math.max(cursor.revision, state.revision),
    recordsRevision: Math.max(cursor.recordsRevision, state.recordsRevision),
  };
}

export interface ProxyChangePlan {
  /** 要重读代理状态（凭据/监听/恢复事实可能已变） */
  readonly reloadStatus: boolean;
  /** 要重读 run 列表（本次通知含成功落盘） */
  readonly reloadRuns: boolean;
  /** 推进后的游标 */
  readonly cursor: ProxyFactCursor;
}

/**
 * 收到一条 `proxy:changed` 后该做什么。
 *
 * @param cursor renderer 当前已采纳的版本
 * @param event  已过 `ProxyChangeEventSchema` 校验的通知载荷
 */
export function shouldApplyChange(
  cursor: ProxyFactCursor,
  event: ProxyChangeEvent,
): ProxyChangePlan {
  const stale: ProxyChangePlan = { reloadStatus: false, reloadRuns: false, cursor };

  // 规则 2：旧 main 会话的通知对当前状态没有意义
  if (cursor.epoch !== null && cursor.epoch !== event.epoch) return stale;
  // 规则 3：同会话内落后的通知（乱序到达）不触发任何读取，也不回写版本
  if (event.revision < cursor.revision) return stale;

  // 规则 4：只有 `records` 才刷列表
  const reloadRuns =
    event.changes.includes("records") && event.recordsRevision > cursor.recordsRevision;
  // 状态始终重读：`status` 类别要更新门禁；`records` 类别也顺带对齐 hasKey
  // （一次外部请求可能既捕获了新 key 又落盘了记录）。
  return {
    reloadStatus: true,
    reloadRuns,
    cursor: {
      epoch: event.epoch,
      revision: Math.max(cursor.revision, event.revision),
      recordsRevision: Math.max(cursor.recordsRevision, event.recordsRevision),
    },
  };
}

/**
 * 窗口重新激活时的**只读补读**判据（design D1：订阅前/失焦期间的变化可补读）。
 *
 * 失焦期间 renderer 可能错过任意多条通知。重新激活时读一次状态，
 * 只有"确实落后了"才刷新列表——否则每次点回窗口都白读一遍全量 traces。
 *
 * ⚠️ `status.epoch` 允许是 `null`：**读取失败时游标不前进**（见 store 的
 * `loadProxyStatus`），此时本函数一律要求补刷——状态未知时不能断言"没有变化"。
 *
 * @param cursor 失焦前已采纳的版本
 * @param status 本次 `proxy:status` 读到的版本事实（读取失败时即原游标）
 */
export function shouldReconcileOnActivate(
  cursor: ProxyFactCursor,
  status: ProxyFactCursor,
): { readonly reloadRuns: boolean } {
  // 从没读过状态（epoch 为 null）：首次进入窗口本就该看到完整列表
  if (status.epoch === null) return { reloadRuns: true };
  // 会话轮换：上一届 main 的游标与本届不可比，一律按"有变化"处理
  if (cursor.epoch === null || cursor.epoch !== status.epoch) return { reloadRuns: true };
  // 落盘版本落后 ⇒ 失焦期间有新 run 落盘，补刷列表
  return { reloadRuns: status.recordsRevision > cursor.recordsRevision };
}
