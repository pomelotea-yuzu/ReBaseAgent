import type { OperationRecord, OperationStatusResult, ReconcileResult } from "@shared/operations";

/**
 * U4 任务 4.1：renderer 侧的 **main 操作会话**（design D4/D6）。
 *
 * 这里是纯数据 + 纯转移，store 只做 `set()`——三条判据全靠它可测：
 * - **初始未确认保守锁**：没握过手（`epoch === null`）就不许提交/改配置，
 *   界面不能靠"发不出去时给个错误"当门禁（spec「初始握手失败禁用主动入口」）；
 * - **乱序不回退**：低 `registryVersion` 的快照、旧请求代次的迟到响应一律整份丢弃，
 *   绝不部分采纳所谓成功字段（spec「乱序快照不回退新状态」）；
 * - **通信未知保守锁**：status/reconcile 断开或返回非法结构 ⇒ `unknown`，
 *   只有**下一次有效的 status 应答**才能清除；reconcile 只补事实、不解 unknown
 *   （spec「状态通道不可用保持未知」——恢复动作本身是"重新核对"，而"核对是否恢复"
 *   的判据必须是完整快照握手，不是单条回答）。
 *
 * 另外两件事在本模块里做，是因为它们必须和上面三条共用同一份状态：
 * - **本地在飞计数**（`localPending`）：renderer 已发出但还没有可信回执的提交。
 *   spec 要求门禁由「main 状态 + 通信未知 + 本地尚未确认的提交」共同派生；
 *   只看 main 快照会在"刚发出、main 还没登记"的间隙里允许第二个入口（跨入口忙碌）。
 * - **核对旧操作不解除另一操作的锁**：`reconcile` 返回的是"那条操作的事实 + main 当前槽"，
 *   锁由**当前槽**决定而不是由被查询的那条决定（design D4 表格第 3 行）。
 */

export interface OperationSession {
  /** 当前 main 会话 epoch；`null` = 尚未握手成功 ⇒ 主动入口与配置写入口一律禁用 */
  readonly epoch: string | null;
  /** 已采纳的最新登记版本（乱序守卫的基准；`0` = 还没采纳过任何快照） */
  readonly registryVersion: number;
  /** main 当前执行槽（`null` = 空闲）；只来自 status/reconcile 的自洽快照 */
  readonly activeOperationId: string | null;
  /** main 正在退出协商 */
  readonly closing: boolean;
  /** main 正在做配置变更（settings 写入 / 代理异步启停） */
  readonly configurationBusy: boolean;
  /** 通信未知：status/reconcile 失联或返回非法结构 ⇒ 保守锁 */
  readonly unknown: boolean;
  /** 请求代次：每次"发出握手"递增；只有当代次相符的响应才可采纳 */
  readonly generation: number;
  /** 本会话已知的操作事实（按 operationId 去重，后到的同 ID 记录覆盖旧事实） */
  readonly operations: readonly OperationRecord[];
  /**
   * 本地尚未确认终态的提交身份（epoch + operationId）。
   * spec 的门禁由三样东西共同派生：main 槽、通信未知、**本地尚未确认的提交**。
   * 只看 main 快照会在"请求刚发出、main 还没登记"的间隙里允许第二个入口。
   */
  readonly pending: readonly PendingSubmission[];
}

export interface PendingSubmission {
  readonly epoch: string;
  readonly operationId: string;
}

export function initialSession(): OperationSession {
  return {
    epoch: null,
    registryVersion: 0,
    activeOperationId: null,
    closing: false,
    configurationBusy: false,
    unknown: false,
    generation: 0,
    operations: [],
    pending: [],
  };
}

/** 派生的门禁（spec「现有界面消费统一操作事实」）：界面只读这四个布尔，不再各判一套 */
export interface OperationGate {
  /** 七类主动入口是否可提交 */
  readonly canSubmit: boolean;
  /** settings 保存/清除、代理启停是否可写 */
  readonly canChangeConfiguration: boolean;
  /** 禁用原因（界面文案的分支依据；按码分支，不按文案分支） */
  readonly blockedBy: OperationBlockedBy | null;
}

export type OperationBlockedBy =
  | "not_handshaked"
  | "communication_unknown"
  | "closing"
  | "configuration_busy"
  | "operation_running";

export function deriveGate(session: OperationSession): OperationGate {
  const blockedBy = blockedReasonOf(session);
  return {
    canSubmit: blockedBy === null,
    canChangeConfiguration: blockedBy === null,
    blockedBy,
  };
}

function blockedReasonOf(session: OperationSession): OperationBlockedBy | null {
  if (session.epoch === null) return "not_handshaked";
  if (session.unknown) return "communication_unknown";
  if (session.closing) return "closing";
  if (session.configurationBusy) return "configuration_busy";
  if (session.activeOperationId !== null || hasSameEpochPending(session)) {
    return "operation_running";
  }
  return null;
}

/**
 * 只有**同 epoch** 的在飞身份才锁住可执行性（任务 4.6）。
 *
 * 新 main 会话没有旧登记，spec 要求「只按新 main 的槽决定可执行性」——旧 epoch 的
 * 未确认提交既不能标成功/失败/已取消，也不该把新会话永远锁死。它的正确去处是
 * `stalePendingOf`：留在未知历史里（草稿冻结照旧解除不了，由用户明确处理），
 * 但不参与门禁。
 */
export function hasSameEpochPending(session: OperationSession): boolean {
  return session.pending.some((one) => one.epoch === session.epoch);
}

/** 跨 epoch 的未知历史（界面用它说"这次提交结局未知"，绝不据此猜关联或自动重发） */
export function stalePendingOf(session: OperationSession): PendingSubmission[] {
  return session.pending.filter((one) => one.epoch !== session.epoch);
}

/** 发出一次 status 握手：先记下代次，迟到响应凭它丢弃 */
export function beginHandshake(session: OperationSession): OperationSession {
  return { ...session, generation: session.generation + 1 };
}

export interface StatusApplyResult {
  readonly session: OperationSession;
  /** 采纳结论：`applied` 才改变状态；其余三种都保留原状态（不部分采纳） */
  readonly applied: boolean;
  readonly reason: "applied" | "stale_generation" | "stale_version" | "new_epoch";
}

/**
 * 采纳一次 status 快照（调用方**必须**先用 `OperationStatusResultSchema` 校验通过）。
 *
 * `issuedGeneration` 是发出这次握手时的代次；期间又发起过新握手 ⇒ 整份丢弃。
 *
 * 判定顺序（每一步都不写回脏状态）：
 * 1. 代次不是最新 ⇒ 整份丢弃（旧请求的迟到响应，`stale_generation`）；
 * 2. epoch 与当前不同 ⇒ 新 main 会话：整份替换并清 unknown（`new_epoch`）；
 * 3. epoch 相同但 `registryVersion` 低于已采纳值 ⇒ 丢弃（`stale_version`）；
 *    —— 这一条同时覆盖「settled 快照被旧 running 快照回退」与「旧槽覆盖新槽」。
 */
export function applyStatus(
  session: OperationSession,
  snapshot: OperationStatusResult,
  issuedGeneration: number,
): StatusApplyResult {
  if (issuedGeneration !== session.generation) {
    return { session, applied: false, reason: "stale_generation" };
  }
  if (snapshot.registryVersion < session.registryVersion && snapshot.epoch === session.epoch) {
    return { session, applied: false, reason: "stale_version" };
  }
  const isNewEpoch = session.epoch !== null && snapshot.epoch !== session.epoch;
  const merged: OperationSession = {
    ...session,
    epoch: snapshot.epoch,
    registryVersion: snapshot.registryVersion,
    activeOperationId: snapshot.activeOperationId,
    closing: snapshot.closing,
    configurationBusy: snapshot.configurationBusy,
    // 有效的 status 应答就是"通信已恢复 + 状态已确认"的唯一判据
    unknown: false,
    operations: mergeOperations(session.operations, snapshot.operations),
  };
  return {
    session: settlePendingFromFacts(merged),
    applied: true,
    reason: isNewEpoch ? "new_epoch" : "applied",
  };
}

/**
 * 通信异常（通道 reject / 返回非法结构）：保守锁，epoch 与既有事实都留着。
 *
 * 从没握成功过（`epoch === null`）时**不**标 unknown——原因仍是「未握手」：
 * 两者都禁用入口，但"未握手"允许下一次提交自动补握手（那不是在重发业务请求），
 * 而"曾有会话后失联"必须显式核对才解锁（spec「状态通道不可用保持未知」）。
 */
export function markUnknown(session: OperationSession): OperationSession {
  return session.epoch === null ? session : { ...session, unknown: true };
}

export interface ReconcileApplyResult {
  readonly session: OperationSession;
  readonly applied: boolean;
  readonly reason: "applied" | "epoch_mismatch" | "stale_generation" | "stale_version";
}

/**
 * 采纳一次 reconcile 结果：**只补该操作的事实与当前槽**，不清 unknown。
 *
 * - `epoch_mismatch`：核对结果属于另一个 main 会话 ⇒ 整份丢弃。epoch 的改变
 *   只由当前有效的 status 握手确认（design D4「握手 epoch 变化只由当前有效 status 请求确认」）。
 * - `stale_generation`：核对发出后又有新的握手代次 ⇒ 迟到响应不得覆盖（同 status 口径）。
 * - `stale_version`：登记的版本低于已采纳值 ⇒ 不得让 settled 回退 running。
 * - 采纳时锁仍然由**当前槽**派生：查旧操作 A 不会释放正在跑的 B。
 */
export function applyReconcile(
  session: OperationSession,
  result: ReconcileResult,
  generation: number,
): ReconcileApplyResult {
  if (result.epoch !== session.epoch) {
    return { session, applied: false, reason: "epoch_mismatch" };
  }
  if (generation !== session.generation) {
    return { session, applied: false, reason: "stale_generation" };
  }
  if (result.registryVersion < session.registryVersion) {
    return { session, applied: false, reason: "stale_version" };
  }
  return {
    session: settlePendingFromFacts({
      ...session,
      registryVersion: result.registryVersion,
      activeOperationId: result.activeOperationId,
      closing: result.closing,
      configurationBusy: result.configurationBusy,
      operations: mergeOperations(session.operations, [result.operation]),
    }),
    applied: true,
    reason: "applied",
  };
}

/**
 * 发出一次核对：返回要传给 `applyReconcile` 的代次（核对不递增代次——
 * 它不确认 epoch，只补事实；epoch 的改变只由 status 握手确认）。
 */
export function captureGeneration(session: OperationSession): number {
  return session.generation;
}

/** 一次提交发出：登记本地在飞身份，跨入口门禁从这一刻起生效 */
export function beginLocalSubmission(
  session: OperationSession,
  identity: PendingSubmission,
): OperationSession {
  return { ...session, pending: [...session.pending, identity] };
}

/**
 * 一次提交收口（可信回执到达，或明确"本地未发送"）。
 * **通道抛错不得调用本函数**：状态未知时按 design D4/D6 保留锁，
 * 身份要等下一次有效 status 快照里出现终态才销账（见 `settlePendingFromFacts`）。
 */
export function endLocalSubmission(
  session: OperationSession,
  operationId: string,
): OperationSession {
  const pending = session.pending.filter((one) => one.operationId !== operationId);
  return pending.length === session.pending.length ? session : { ...session, pending };
}

/**
 * 用已采纳的操作事实销掉**已进终态**的在飞身份（settled / notAccepted）。
 * 每次采纳 status 或 reconcile 之后都跑一次：迟到回执、组件卸载都不影响它，
 * 而"登记里查不到该身份"绝不算终态（design D4：status 中不存在记录不是未执行证明）。
 *
 * 只销同 epoch 的身份：新 main 会话里旧 epoch 的在飞记录**保持未知**，
 * 既不销账也不伪造结局（spec「新 main 会话不伪造旧操作结局」）。
 */
export function settlePendingFromFacts(session: OperationSession): OperationSession {
  const stillPending = session.pending.filter(
    (one) =>
      operationOf(session, one.epoch, one.operationId) === undefined ||
      !isSettledState(operationOf(session, one.epoch, one.operationId)),
  );
  return stillPending.length === session.pending.length
    ? session
    : { ...session, pending: stillPending };
}

/** 同 operationId 后到的事实覆盖先到的；顺序按登记首次出现保持（界面列表稳定） */
function mergeOperations(
  current: readonly OperationRecord[],
  incoming: readonly OperationRecord[],
): OperationRecord[] {
  const byId = new Map<string, OperationRecord>();
  for (const record of current) byId.set(record.operationId, record);
  for (const record of incoming) byId.set(record.operationId, record);
  return [...byId.values()];
}

/** 按身份找登记（4.2 的"按 operationId 解冻"用这个，不靠列表位置） */
export function operationOf(
  session: OperationSession,
  epoch: string,
  operationId: string,
): OperationRecord | undefined {
  // 只有同 epoch 的登记才可解释当前提交；旧会话的记录不参与解冻
  if (session.epoch !== epoch) return undefined;
  return session.operations.find((record) => record.operationId === operationId);
}

/**
 * 可信终态（可解冻本次关联）：`settled` 与 `notAccepted`。
 * `running` 与"查不到"都不是终态——status 里不存在记录单独不构成未执行证明（design D4）。
 */
export function isSettledState(record: OperationRecord | undefined): boolean {
  return record !== undefined && (record.state === "settled" || record.state === "notAccepted");
}

// ---------------------------------------------------------------------------
// U5 任务 1.4：终态消费的"新增"判定
//
// 轮询每轮回的是**全量快照**（D1：本阶段不裁历史）。若按"快照里有终态"就动手，
// 同一操作的解冻/列表刷新/结果读取会被重复触发；只认"这一轮第一次进终态"才是幂等的。
// 键含 epoch：新 main 会话的记录与旧会话同名记录互不相干（旧会话的结局仍未知）。
// ---------------------------------------------------------------------------

/** 该记录是否已被本轮快照在场（同 epoch 同 operationId 且已进可信终态） */
function settledKeyOf(record: OperationRecord): string {
  return `${record.epoch}|${record.operationId}`;
}

/**
 * 相对上一份会话，本轮**新进入**可信终态的登记记录（其余操作一律不重复收尾）。
 *
 * renderer 重载后上一份是空的 ⇒ 快照里已有的终态全算"新"——这正是恢复语义要的：
 * 重载只能恢复登记与读取结果，不推测草稿（design D3）。
 */
export function newlySettledOperations(
  previous: OperationSession,
  next: OperationSession,
): OperationRecord[] {
  const already = new Set<string>();
  for (const record of previous.operations) {
    if (isSettledState(record)) already.add(settledKeyOf(record));
  }
  return next.operations.filter(
    (record) => isSettledState(record) && !already.has(settledKeyOf(record)),
  );
}
