import type { ProxyState } from "@shared/ipc";
import type { ProxyFactCursor } from "./proxy-changes";
import { cursorFromStatus } from "./proxy-changes";

/**
 * 代理状态回读的**在途合并与采纳守卫**（design D2，tasks 2.1）。
 *
 * 背景：`proxy:status` 原来每次调用都直接发一次 IPC（`loadProxyStatus`），
 * 于是三个触发源会叠出并发读取——通知（§1 的 `proxy:changed`）、messages 打开的
 * 门禁核对（2.1）、窗口激活补读（D1）。两次并发读取的响应**乱序到达**时，
 * 旧快照会把新事实按回去：用户刚打开 messages 完成核对（`hasKey=true`），
 * 早先那次读到 `hasKey=false` 的响应才回来 ⇒ 门禁谎报未捕获、确认被无谓撤销。
 *
 * 本模块给出两条可逐条证伪的规则（纯函数、无 store 依赖）：
 *
 * 1. **合并**：已有读取在飞 ⇒ 不并发发射，只登记"还需要一次"；当前请求结束后
 *    补发**恰好一次**（不排队 N 次）。与 `list-refresh` 同形但**独立计数**——
 *    列表读取的守卫锚点是阅读位置，状态读取的锚点是门禁事实，合并不许互相影响。
 *    ⚠️ 合并同时也是**并发响应的唯一防线**：它保证任一时刻至多一个读取在飞，
 *    所以"响应对不上自己那次请求"在这条链路上不可达（曾加的代次断言经变异验证为
 *    死代码，已移除——理由写在 store 的 `loadProxyStatus` 注释里）。
 * 2. **快照新旧**：响应载荷自身若比已采纳的游标更旧（同 epoch 且任一版本维度落后），
 *    即使它就是最新那次读取也**不可采纳**——它描述的是过去。跨 epoch 一律采纳
 *    （那是新一届 main 的事实，数字不可比，由 `cursorFromStatus` 整份重来）。
 *
 * ⚠️ `generation` 仍然保留（每次**真正发射**推进，被合并的不算）：它是可诊断的
 * 读取代次锚点，便于事后判断"这轮读了几次"。它**不是**并发守卫——别把它当那种东西用。
 */

export interface ProxyStatusReadState {
  /** 在途读取数（合并语义下恒为 0 或 1；保留计数形状以便断言"没有并发"） */
  readonly inFlight: number;
  /** 已登记的尾随次数（合并语义下恒为 0 或 1） */
  readonly pending: number;
  /** 已发起的读取代次：守卫锚点，单调递增（每次**真正发射**推进，被合并的不算） */
  readonly generation: number;
}

export const initialProxyStatusReadState: ProxyStatusReadState = {
  inFlight: 0,
  pending: 0,
  generation: 0,
};

/** 一次读取的调度决定 */
export type ProxyStatusReadDecision =
  /** 发射请求；`token` 是本次的代次，采纳时必须原样交回 */
  | { readonly action: "start"; readonly token: number; readonly state: ProxyStatusReadState }
  /** 已有读取在飞：只登记尾随，本次不发射 */
  | { readonly action: "deferred"; readonly state: ProxyStatusReadState };

export function beginStatusRead(state: ProxyStatusReadState): ProxyStatusReadDecision {
  if (state.inFlight > 0) {
    // 合并：无论来多少次意图，只登记"还需要一次"
    return { action: "deferred", state: { ...state, pending: 1 } };
  }
  const generation = state.generation + 1;
  return {
    action: "start",
    token: generation,
    state: { ...state, inFlight: state.inFlight + 1, generation },
  };
}

/**
 * 一次读取结束后的收尾。
 *
 * @returns `shouldRefire` 为 true 时调用方应再走一次**完整的** `loadProxyStatus`
 *   （由它按 `beginStatusRead` 登记在途数），而不是旁路直发 IPC——旁路那次无人递减
 *   在途计数，计数永久残留，之后所有读取都会被"合并"成尾随而永不发射。
 */
export function settleStatusRead(state: ProxyStatusReadState): {
  state: ProxyStatusReadState;
  shouldRefire: boolean;
} {
  const inFlight = Math.max(0, state.inFlight - 1);
  const shouldRefire = inFlight === 0 && state.pending > 0;
  return { state: { inFlight, pending: 0, generation: state.generation }, shouldRefire };
}

/** 读取中（UI 表达「核对中」；合并语义下即"有请求在飞"）。派生布尔，供组件订阅。 */
export function isStatusReadChecking(state: ProxyStatusReadState): boolean {
  return state.inFlight > 0;
}

/** 载荷自带的版本事实（`proxy:status` 载荷里我们只消费这三个字段） */
export type ProxyVersionFacts = Pick<ProxyState, "epoch" | "revision" | "recordsRevision">;

export type ProxySnapshotRuling =
  /** 采纳：返回推进后的游标（可能与旧游标同引用无关——调用方自行比较） */
  | { readonly accept: true; readonly cursor: ProxyFactCursor }
  /**
   * 拒绝：载荷比已采纳的事实更旧（同 epoch 且 revision 落后）。
   * 调用方**什么都不写**——不是写别的东西。
   */
  | { readonly accept: false; readonly reason: "older-than-adopted" };

/**
 * 规则 3：这份快照描述的是**现在**还是**过去**？
 *
 * 与规则 2 的分工：规则 2 管"响应是不是最新那次请求的"，本函数管"这份载荷是不是
 * 最新事实"。两者都要过——最新发起的读取完全可能带回一份较旧的快照（请求在途期间
 * 又发生了一次变更），把它写下去就是一次实打实的状态回退。
 *
 * ⚠️ **两个计数器都要比**，不能只看 `revision`：载荷是"过去"的判据是任一版本维度的
 * 落后。当前 main 总是成功落盘时同时推进两者（`notifyRecord` 里 revision 与
 * recordsRevision 一起 +1），所以"revision 相同但 recordsRevision 更旧"在真实链路上
 * 不可达；但守卫的成本是零，而它挡住的是一类**一旦发生就静默回退游标**的坏数据
 * （例如将来有人加了只推进单个维度的通知路径）。
 */
export function acceptProxySnapshot(
  cursor: ProxyFactCursor,
  incoming: ProxyVersionFacts,
): ProxySnapshotRuling {
  const sameSession = cursor.epoch !== null && cursor.epoch === incoming.epoch;
  if (
    sameSession &&
    (incoming.revision < cursor.revision || incoming.recordsRevision < cursor.recordsRevision)
  ) {
    return { accept: false, reason: "older-than-adopted" };
  }
  return { accept: true, cursor: cursorFromStatus(cursor, incoming) };
}
