import {
  type DraftCloseAnswer,
  DraftCloseAnswerSchema,
  type DraftCloseQuery,
  DraftCloseReportSchema,
} from "../shared/ipc";

/**
 * U3 关闭协商（design D6）的 main 侧**纯逻辑核心**：会话登记、握手、
 * sender/frame/session/sequence 校验与关闭查询的请求身份登记。
 *
 * 本文件**不 import electron**——全部依赖以普通数据注入（webContentsId / frame
 * routingId 只是数字），使其可在 vitest 下直接单测；electron 事件 → 受限数据的
 * 适配在 `draft-close-attach.ts`（测试路径之外）。
 *
 * 校验链（场景「旧会话伪造发送者和乱序消息不影响关闭」）：
 * 1. sender 的 webContents 必须是已登记的目标窗口（拒绝其他 webContents）；
 * 2. sender 的 frame 必须是目标窗口的**主 frame**（拒绝子 frame）；
 * 3. 载荷必须通过严格 schema（拒绝非法 / 负数 / 超界 / 非整数计数）；
 * 4. 载荷的 sessionId 必须等于当前文档会话（拒绝旧会话 / 伪造会话）；
 * 5. 消息序号必须**严格大于**已接受的最大序号（拒绝乱序与重放）；
 * 6. 应答的 requestId 必须等于当前挂起的查询（拒绝迟到 / 伪造应答）。
 *
 * 任何一条不满足都只拒绝该条消息——不影响 guard 的其余状态，也不产生关闭放行。
 */

/** 渲染层发来的消息的受限发送者描述（electron 适配层从 event 中提取） */
export interface DraftCloseSender {
  readonly webContentsId: number;
  readonly frameRoutingId: number;
}

/** 一个被装配的目标窗口（每个文档会话一份状态） */
export interface DraftCloseTargetState {
  readonly webContentsId: number;
  /** 主 frame routingId 的取值函数（导航可能更换 frame 实例，事件时现取） */
  readonly getMainFrameRoutingId: () => number;
  /** 当前文档会话 id；did-finish-load（含重载）轮换 */
  sessionId: string;
  /** 本文档会话是否完成握手（未握手 ⇒ 关闭时走 unknown 降级） */
  handshaken: boolean;
  /** 已接受的最大消息序号；-1 = 尚未接受任何消息 */
  lastAcceptedSequence: number;
  /** 最近一次被接受的 dirty 上报（仅供参考；关闭决策总是发起新鲜查询） */
  lastReported: { sequence: number; dirtyCount: number } | null;
}

/** 一次挂起的关闭查询（同一时间至多一个） */
export interface DraftClosePendingQuery {
  readonly requestId: string;
}

export interface DraftCloseGuardOptions {
  /** 文档会话 id 生成器（默认 crypto.randomUUID；测试可注入固定值） */
  newSessionId?: () => string;
  /**
   * 会话轮换通知（did-finish-load 后调用）：electron 适配层用它把
   * `{sessionId}` 推给 renderer；纯逻辑测试可不注入。
   */
  onSessionRotated?: (target: DraftCloseTargetState, sessionId: string) => void;
  /** 校验拒绝的可观测回调（测试断言拒绝原因；生产可接日志） */
  onRejected?: (reason: string, sender: DraftCloseSender | null) => void;
  /**
   * 关闭决定释放通知（取消/完成后调用）：electron 适配层用它把
   * `{sessionId, requestId}` 发给 renderer，令其解除输入锁并恢复焦点。
   */
  onQueryReleased?: (target: DraftCloseTargetState, sessionId: string, requestId: string) => void;
  /**
   * 关闭应答被接受时通知（装配层转发给关闭决策流 `DraftCloseFlow`）。
   * 只在**通过全部校验**后回调——拒绝的伪造/迟到应答不会到达决策流。
   */
  onAnswerAccepted?: (webContentsId: number, answer: DraftCloseAnswer) => void;
}

export type DraftCloseGuardResult = { ok: true } | { ok: false; reason: string };

export type DraftCloseHandshakeResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string };

export class DraftCloseGuard {
  private readonly targets = new Map<number, DraftCloseTargetState>();
  private readonly pendingQueries = new Map<number, DraftClosePendingQuery>();
  private readonly newSessionId: () => string;
  private readonly onSessionRotated?: DraftCloseGuardOptions["onSessionRotated"];
  private readonly onRejected?: DraftCloseGuardOptions["onRejected"];
  private readonly onQueryReleased?: DraftCloseGuardOptions["onQueryReleased"];
  private readonly onAnswerAccepted?: DraftCloseGuardOptions["onAnswerAccepted"];
  /** 每窗口最近一次被接受的关闭应答（由 takeAnswer 消费） */
  private readonly lastAnswer = new Map<number, DraftCloseAnswer>();

  constructor(options: DraftCloseGuardOptions = {}) {
    this.newSessionId = options.newSessionId ?? ((): string => crypto.randomUUID());
    this.onSessionRotated = options.onSessionRotated;
    this.onRejected = options.onRejected;
    this.onQueryReleased = options.onQueryReleased;
    this.onAnswerAccepted = options.onAnswerAccepted;
  }

  /**
   * 登记 / 轮换一个窗口的文档会话。窗口创建时与每次 did-finish-load（含重载）
   * 各调用一次：**每次调用都生成新 sessionId 并重置握手与序号**——
   * 旧文档会话的一切消息自此失效（重载不能用旧会话继续说话）。
   *
   * 轮换away时评估旧会话（design D6）：旧会话 dirty 或状态不明（未握手 /
   * 从未上报）⇒ 置「会话状态丢失」遗留标志——新 renderer 的空仓库**不能**
   * 静默消除它，下次关闭必须明确说明先前草稿可能已丢失。
   */
  rotateSession(spec: {
    webContentsId: number;
    getMainFrameRoutingId: () => number;
  }): DraftCloseTargetState {
    const previous = this.targets.get(spec.webContentsId);
    if (previous !== undefined && this.isSessionUnresolved(previous)) {
      this.pendingLoss = true;
    }
    const sessionId = this.newSessionId();
    const state: DraftCloseTargetState = {
      webContentsId: spec.webContentsId,
      getMainFrameRoutingId: spec.getMainFrameRoutingId,
      sessionId,
      handshaken: false,
      lastAcceptedSequence: -1,
      lastReported: null,
    };
    this.targets.set(spec.webContentsId, state);
    this.pendingQueries.delete(spec.webContentsId);
    this.onSessionRotated?.(state, sessionId);
    return state;
  }

  /** 旧会话是否「dirty 或状态不明」（D6：重载时据此保留遗留标志） */
  private isSessionUnresolved(state: DraftCloseTargetState): boolean {
    return !state.handshaken || state.lastReported === null || state.lastReported.dirtyCount > 0;
  }

  /**
   * renderer 崩溃（render-process-gone）：旧会话状态永久不明 ⇒ 直接置遗留标志
   * （崩溃后不一定发生重载，不能只依赖 did-finish-load 轮换评估）。
   */
  markPendingLoss(): void {
    this.pendingLoss = true;
  }

  /** 是否存在未解决的会话丢失标志（关闭决策的 clean 前置条件之一） */
  hasPendingLoss(): boolean {
    return this.pendingLoss;
  }

  /**
   * 用户在退出确认中明确选择「返回」（已知悉先前草稿可能丢失）⇒ 清除遗留标志，
   * 新会话之后的关闭走正常核对。renderer 的新鲜上报**无权**清除本标志。
   */
  acknowledgePendingLoss(): void {
    this.pendingLoss = false;
  }

  private pendingLoss = false;

  /** 窗口销毁：解除登记与挂起查询（electron 适配层在 closed 事件时调用） */
  detach(webContentsId: number): void {
    this.targets.delete(webContentsId);
    this.pendingQueries.delete(webContentsId);
    this.lastAnswer.delete(webContentsId);
  }

  targetOf(webContentsId: number): DraftCloseTargetState | undefined {
    return this.targets.get(webContentsId);
  }

  pendingQueryOf(webContentsId: number): DraftClosePendingQuery | undefined {
    return this.pendingQueries.get(webContentsId);
  }

  /**
   * 关闭协商握手：renderer 挂载后调用，取当前文档会话 id 并标记「已完成握手」。
   * 校验 sender 是已登记目标窗口的主 frame。
   */
  handshake(sender: DraftCloseSender): DraftCloseHandshakeResult {
    const target = this.targets.get(sender.webContentsId);
    if (target === undefined) {
      this.onRejected?.("handshake:unknown_target", sender);
      return { ok: false, reason: "handshake:unknown_target" };
    }
    if (sender.frameRoutingId !== target.getMainFrameRoutingId()) {
      this.onRejected?.("handshake:non_main_frame", sender);
      return { ok: false, reason: "handshake:non_main_frame" };
    }
    target.handshaken = true;
    return { ok: true, sessionId: target.sessionId };
  }

  /**
   * renderer 的 dirty 元数据上报（单向 send）。全部校验链通过后才更新
   * lastAcceptedSequence / lastReported。
   */
  handleReport(sender: DraftCloseSender, payload: unknown): DraftCloseGuardResult {
    return this.handleMetadataMessage(
      sender,
      payload,
      DraftCloseReportSchema,
      "report",
      (target, _sessionId, sequence, dirtyCount) => {
        target.lastAcceptedSequence = sequence;
        target.lastReported = { sequence, dirtyCount };
      },
    );
  }

  /**
   * 关闭查询应答（单向 send）。在元数据校验链之上还要求：
   * 存在挂起查询且 requestId 匹配——迟到的旧应答一律拒绝。
   */
  handleAnswer(sender: DraftCloseSender, payload: unknown): DraftCloseGuardResult {
    const parsed = DraftCloseAnswerSchema.safeParse(payload);
    if (!parsed.success) {
      this.onRejected?.("answer:invalid_payload", sender);
      return { ok: false, reason: "answer:invalid_payload" };
    }
    const answer: DraftCloseAnswer = parsed.data;
    const target = this.targets.get(sender.webContentsId);
    if (target === undefined) {
      this.onRejected?.("answer:unknown_target", sender);
      return { ok: false, reason: "answer:unknown_target" };
    }
    if (sender.frameRoutingId !== target.getMainFrameRoutingId()) {
      this.onRejected?.("answer:non_main_frame", sender);
      return { ok: false, reason: "answer:non_main_frame" };
    }
    if (!target.handshaken) {
      this.onRejected?.("answer:not_handshaken", sender);
      return { ok: false, reason: "answer:not_handshaken" };
    }
    if (answer.sessionId !== target.sessionId) {
      this.onRejected?.("answer:stale_session", sender);
      return { ok: false, reason: "answer:stale_session" };
    }
    if (answer.sequence <= target.lastAcceptedSequence) {
      this.onRejected?.("answer:stale_sequence", sender);
      return { ok: false, reason: "answer:stale_sequence" };
    }
    const pending = this.pendingQueries.get(sender.webContentsId);
    if (pending === undefined || pending.requestId !== answer.requestId) {
      this.onRejected?.("answer:unknown_request", sender);
      return { ok: false, reason: "answer:unknown_request" };
    }
    target.lastAcceptedSequence = answer.sequence;
    target.lastReported = { sequence: answer.sequence, dirtyCount: answer.dirtyCount };
    // 应答只对当前 requestId 有效：接受即消费挂起查询（迟到重放自然失效）
    this.pendingQueries.delete(sender.webContentsId);
    this.lastAnswer.set(sender.webContentsId, answer);
    this.onAnswerAccepted?.(sender.webContentsId, answer);
    return { ok: true };
  }

  /** 取走（并清除）当前窗口最近一次被接受的关闭应答——关闭决策流消费它 */
  takeAnswer(webContentsId: number): DraftCloseAnswer | undefined {
    const answer = this.lastAnswer.get(webContentsId);
    this.lastAnswer.delete(webContentsId);
    return answer;
  }

  /**
   * 发起关闭查询：登记请求身份并返回查询载荷（main → renderer）。
   * 返回 null 表示目标不存在（窗口已销毁）。
   */
  beginQuery(webContentsId: number): DraftCloseQuery | null {
    const target = this.targets.get(webContentsId);
    if (target === undefined) return null;
    const pending: DraftClosePendingQuery = { requestId: crypto.randomUUID() };
    this.pendingQueries.set(webContentsId, pending);
    return { sessionId: target.sessionId, requestId: pending.requestId };
  }

  /** 关闭决定已出（或本次核对取消）：清除挂起查询，迟到应答不再被接受 */
  cancelQuery(webContentsId: number): void {
    this.pendingQueries.delete(webContentsId);
  }

  /**
   * 关闭决定已出并通知 renderer 解锁：清除挂起查询 + 发 `draft-close:release`。
   * 返回是否通知成功（目标不存在 = false）。renderer 按 requestId 匹配才解锁。
   */
  releaseQuery(webContentsId: number): boolean {
    const pending = this.pendingQueries.get(webContentsId);
    const target = this.targets.get(webContentsId);
    if (pending === undefined || target === undefined) {
      this.pendingQueries.delete(webContentsId);
      return false;
    }
    this.pendingQueries.delete(webContentsId);
    this.onQueryReleased?.(target, target.sessionId, pending.requestId);
    return true;
  }

  /** 元数据消息（report）共用的校验链；answer 的差异部分在 handleAnswer 内自行处理 */
  private handleMetadataMessage(
    sender: DraftCloseSender,
    payload: unknown,
    schema: typeof DraftCloseReportSchema,
    prefix: string,
    apply: (
      target: DraftCloseTargetState,
      sessionId: string,
      sequence: number,
      dirtyCount: number,
    ) => void,
  ): DraftCloseGuardResult {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.onRejected?.(`${prefix}:invalid_payload`, sender);
      return { ok: false, reason: `${prefix}:invalid_payload` };
    }
    const data = parsed.data;
    const target = this.targets.get(sender.webContentsId);
    if (target === undefined) {
      this.onRejected?.(`${prefix}:unknown_target`, sender);
      return { ok: false, reason: `${prefix}:unknown_target` };
    }
    if (sender.frameRoutingId !== target.getMainFrameRoutingId()) {
      this.onRejected?.(`${prefix}:non_main_frame`, sender);
      return { ok: false, reason: `${prefix}:non_main_frame` };
    }
    if (!target.handshaken) {
      this.onRejected?.(`${prefix}:not_handshaken`, sender);
      return { ok: false, reason: `${prefix}:not_handshaken` };
    }
    if (data.sessionId !== target.sessionId) {
      this.onRejected?.(`${prefix}:stale_session`, sender);
      return { ok: false, reason: `${prefix}:stale_session` };
    }
    if (data.sequence <= target.lastAcceptedSequence) {
      this.onRejected?.(`${prefix}:stale_sequence`, sender);
      return { ok: false, reason: `${prefix}:stale_sequence` };
    }
    apply(target, data.sessionId, data.sequence, data.dirtyCount);
    return { ok: true };
  }
}
