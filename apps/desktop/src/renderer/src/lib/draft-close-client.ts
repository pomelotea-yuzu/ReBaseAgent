import type {
  DraftCloseAnswer,
  DraftCloseQuery,
  DraftCloseRelease,
  DraftCloseReport,
  DraftCloseSessionPayload,
  WindowApi,
} from "@shared/ipc";

/**
 * U3 任务 4.2：关闭协商的 **renderer 侧客户端**（纯逻辑，依赖全部注入——
 * api / dirty 计数 / 输入同步 / 锁回调都可打桩，vitest 直测协议状态机；
 * React 接线在 `use-draft-close-guard.ts`，electron 实机在 §6 承载）。
 *
 * 协议角色（design D6）：main 持有关闭决策，本客户端只**报告元数据**：
 * - `start()`：完成握手（取文档会话 id）+ 订阅查询/释放/会话推送；
 * - 查询到达：**先同步已接收输入 → 再上锁 → 再应答**（D6 顺序，防
 *   "已回 clean 又继续输入"竞态）；应答携带最新 dirtyCount 与 inputSettled；
 * - 释放到达（main 已决定取消/完成）：解除锁（焦点恢复由 UI 层做）；
 * - dirtyCount 变化时上报 report（store 订阅驱动；单调序号保证乱序防护）。
 *
 * 锁期间**不缓冲、不重放**任何被阻止的输入（D6）；输入法组合的 inputSettled
 * 细化在任务 4.3 接入（本文件当前恒 true）。
 */

/** 客户端依赖的最小 api 面（WindowApi 的关闭协商子集） */
export type DraftCloseApi = Pick<
  WindowApi,
  | "draftCloseHandshake"
  | "draftCloseReport"
  | "draftCloseAnswer"
  | "onDraftCloseSession"
  | "onDraftCloseQuery"
  | "onDraftCloseRelease"
>;

export interface DraftCloseClientDeps {
  readonly api: DraftCloseApi;
  /** 当前 dirty 草稿计数（应答/上报时**现取**，不得缓存旧值） */
  readonly getDirtyCount: () => number;
  /**
   * 锁前输入同步：把控件/Monaco model 已接收文本同步进 store。
   * §2 的编辑器已在变更事件同步写入 store（无 debounce），此处为收口点；
   * 输入法组合的锁前已接收文字同样经变更事件入 store（组合中的插入文本会触发
   * Monaco 的 model content 变更）。
   */
  readonly flushInputs: () => void;
  /**
   * 输入是否已收尾（任务 4.3）：`false` = 有进行中的输入法组合——
   * 组合尚未结束⇒不得报告可直接退出的 clean（D6），main 据此走 unknown 降级。
   * 锁前组合的尾随 compositionend 之后该值翻回 true，但**不会**重发应答：
   * main 对未收尾应答的原生确认照常进行，收尾不自动关闭确认（D6）。
   */
  readonly isInputSettled: () => boolean;
  /** 锁状态变化（true = 关闭核对期间，禁止新编辑/粘贴/放弃/提交） */
  readonly onLockChange: (locked: boolean) => void;
  readonly onRejected?: (reason: string) => void;
}

export class DraftCloseClient {
  private sessionId: string | null = null;
  /** 会话内单调递增的消息序号（报告 + 应答共用一条流） */
  private sequence = 0;
  private locked = false;
  private pendingRequestId: string | null = null;
  private lastReportedDirtyCount: number | null = null;
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly deps: DraftCloseClientDeps) {}

  /** 挂载时调用：订阅事件并完成握手。重复调用安全（幂等） */
  start(): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(
      this.deps.api.onDraftCloseSession((payload: DraftCloseSessionPayload) => {
        this.adoptSession(payload.sessionId);
      }),
      this.deps.api.onDraftCloseQuery((query: DraftCloseQuery) => {
        this.handleQuery(query);
      }),
      this.deps.api.onDraftCloseRelease((release: DraftCloseRelease) => {
        this.handleRelease(release);
      }),
    );
    void this.deps.api.draftCloseHandshake().then((envelope) => {
      if (envelope.ok) {
        this.adoptSession(envelope.data.sessionId);
      } else {
        this.deps.onRejected?.(`handshake:${envelope.error.code}`);
      }
    });
  }

  /** 卸载时调用：解绑全部订阅并解锁 */
  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.setLocked(false);
    this.sessionId = null;
    this.pendingRequestId = null;
    this.lastReportedDirtyCount = null;
  }

  /** dirtyCount 变化时上报（store 订阅驱动；值未变不发，避免消息洪泛） */
  reportDirtyIfChanged(): void {
    if (this.sessionId === null) return;
    const dirtyCount = this.deps.getDirtyCount();
    if (dirtyCount === this.lastReportedDirtyCount) return;
    this.lastReportedDirtyCount = dirtyCount;
    const report: DraftCloseReport = {
      sessionId: this.sessionId,
      sequence: this.nextSequence(),
      dirtyCount,
    };
    this.deps.api.draftCloseReport(report);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** 采用新文档会话（握手成功或 main 推送）：序号/上报缓存/遗留锁全部重置 */
  private adoptSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.sequence = 0;
    this.lastReportedDirtyCount = null;
    this.pendingRequestId = null;
    // 新文档会话不应有遗留锁；保险解除（D6：重载后 renderer 从干净状态开始）
    this.setLocked(false);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * 关闭查询：D6 处理顺序——同步输入 → 上锁 → 记录请求身份 → 应答。
   * 旧会话的查询直接忽略（main 对旧会话本就走 unknown 降级）。
   */
  private handleQuery(query: DraftCloseQuery): void {
    if (this.sessionId === null || query.sessionId !== this.sessionId) {
      this.deps.onRejected?.("query:stale_session");
      return;
    }
    this.deps.flushInputs();
    this.setLocked(true);
    this.pendingRequestId = query.requestId;
    const answer: DraftCloseAnswer = {
      sessionId: this.sessionId,
      requestId: query.requestId,
      sequence: this.nextSequence(),
      dirtyCount: this.deps.getDirtyCount(),
      inputSettled: this.deps.isInputSettled(), // 任务 4.3：组合进行中 = false（不得冒充 clean）
    };
    this.deps.api.draftCloseAnswer(answer);
  }

  /** 关闭决定释放：requestId 与当前核对匹配才解锁（旧查询的释放不解锁新核对） */
  private handleRelease(release: DraftCloseRelease): void {
    if (this.sessionId === null || release.sessionId !== this.sessionId) return;
    if (release.requestId !== this.pendingRequestId) {
      this.deps.onRejected?.("release:stale_request");
      return;
    }
    this.pendingRequestId = null;
    this.setLocked(false);
  }

  private setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.deps.onLockChange(locked);
  }
}
