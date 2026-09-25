import type { DraftCloseAnswer, DraftCloseQuery } from "../shared/ipc";
import type { DraftCloseGuard } from "./draft-close-guard";

/**
 * U3 任务 4.4：关闭决策流（design D6 处理顺序的 main 侧**纯逻辑核心**，
 * 不 import electron——原生确认 / 关闭窗口 / 发消息都是注入端口，vitest 直测）。
 *
 * 流程（每个窗口一份 flow）：
 * 1. `interceptClose()`（窗口 close 事件入口）：一次性 bypass 在手则放行；
 *    否则 preventDefault（装配层做）并启动协商；
 * 2. 无论上次报告是否 clean，都**发起新鲜查询**（renderer 同步输入→上锁→应答）；
 * 3. 应答有效且 dirtyCount=0、inputSettled=true、无会话丢失遗留 ⇒ 放行
 *    （armed bypass 后真正执行关闭，跳过协商）；
 * 4. dirtyCount>0 ⇒ 「有草稿」原生确认（默认返回）；超时/未握手/应答无效/
 *    inputSettled=false ⇒ 「暂时无法确认」原生确认（默认返回）；
 * 5. 用户选择退出 ⇒ armed 一次性 bypass + 重新触发正常关闭（本次协商不复用）；
 *    选择返回 ⇒ 取消查询 + 通知 renderer 解锁，迟到应答因 requestId 已清除被拒。
 *
 * 并发纪律（4.6 进一步加固）：同一窗口同时至多一个协商/确认——进行中再次触发
 * close 复用当前流程（返回同一个 Promise），不叠加、不重入。
 */

export type CloseDecision = "clean" | "dirty" | "unknown";
export type CloseOutcome = "closed" | "canceled";

/**
 * 关闭查询的有界等待（design D6）：**设计初值 1.5 秒**，不是实测的 renderer
 * 存活阈值。超时只说明本次未及时取得可信状态 ⇒ unknown 降级（原生确认），
 * 不能据此显示/断言"已崩溃/已失联"，也不能无限等待。若实测需调整阈值，
 * 先同步修改 design/spec 与测试，不宣称此值已在慢机校准。
 */
export const DRAFT_CLOSE_QUERY_TIMEOUT_MS = 1500;

/**
 * 依据当前应答与会话状态裁决关闭（D6 第 3/4 步的判定）：
 * - 未握手 / 无有效应答 / inputSettled=false / 有会话丢失遗留 ⇒ unknown（保守，不猜存活）；
 * - dirtyCount>0 ⇒ dirty；
 * - 其余 ⇒ clean。
 * clean 额外要求无未解决会话丢失状态（4.7 的遗留标志接入 `hasPendingLoss`）。
 */
export function evaluateCloseAnswer(
  answer: DraftCloseAnswer | undefined,
  context: { handshaken: boolean; hasPendingLoss?: () => boolean },
): CloseDecision {
  if (!context.handshaken) return "unknown";
  if (answer === undefined) return "unknown";
  if (!answer.inputSettled) return "unknown";
  if (context.hasPendingLoss?.() === true) return "unknown";
  return answer.dirtyCount > 0 ? "dirty" : "clean";
}

export interface DraftCloseFlowPorts {
  /** main → renderer：发送关闭查询（装配层用 webContents.send） */
  sendQuery(query: DraftCloseQuery): void;
  /** 绑定窗口的原生确认；返回用户选择 */
  showConfirm(kind: "dirty" | "unknown"): Promise<"return" | "quit">;
  /** 重新触发正常关闭（bypass 已 armed，close 处理器放行） */
  closeWindow(): void;
  /** main → renderer：取消本次关闭，通知 renderer 解锁并恢复焦点 */
  sendRelease(sessionId: string, requestId: string): void;
}

export interface DraftCloseFlowDeps {
  /** 未解决的会话丢失标志（4.7 接入；clean 需要其为 false） */
  hasPendingLoss?: () => boolean;
  /** 查询超时毫秒（默认 DRAFT_CLOSE_QUERY_TIMEOUT_MS） */
  queryTimeoutMs?: number;
  /** 可注入的定时器（测试用假时钟）；返回取消函数 */
  scheduleTimeout?: (fn: () => void, ms: number) => () => void;
}

export class DraftCloseFlow {
  private bypassArmed = false;
  private pending: Promise<CloseOutcome> | null = null;
  private answerWaiter: ((answer: DraftCloseAnswer | undefined) => void) | null = null;
  private currentSessionId: string | null = null;
  private lastSentRequestId: string | null = null;

  constructor(
    private readonly webContentsId: number,
    private readonly guard: DraftCloseGuard,
    private readonly ports: DraftCloseFlowPorts,
    private readonly deps: DraftCloseFlowDeps = {},
  ) {}

  /** 是否有进行中的协商/确认（防重入由 pending 复用保证，此为可观测出口） */
  get busy(): boolean {
    return this.pending !== null;
  }

  /**
   * 窗口 close 事件入口。返回 true = 放行本次 close（消费一次性 bypass）；
   * false = 已拦截（装配层必须 preventDefault）并已启动/复用协商。
   */
  interceptClose(): boolean {
    if (this.bypassArmed) {
      this.bypassArmed = false;
      return true;
    }
    void this.requestClose();
    return false;
  }

  /**
   * 发起（或复用进行中的）关闭协商。同一窗口同时至多一个协商/确认：
   * 进行中再次调用返回**同一个 Promise**（连续点击关闭复用当前流程，不叠加）。
   */
  requestClose(): Promise<CloseOutcome> {
    if (this.pending !== null) return this.pending;
    this.pending = this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** guard 接受关闭应答时由装配层转发（装配层不消费应答内容） */
  notifyAnswer(answer: DraftCloseAnswer): void {
    if (this.answerWaiter !== null) {
      const waiter = this.answerWaiter;
      this.answerWaiter = null;
      waiter(answer);
    }
  }

  /** 协商核心。返回 "closed" 时 bypass 已 armed 且窗口正在关闭 */
  private async run(): Promise<CloseOutcome> {
    const query = this.guard.beginQuery(this.webContentsId);
    if (query === null) {
      // 目标不存在（窗口已销毁）：无可核对对象 ⇒ 保守走 unknown 确认，不静默放行
      return this.confirm("unknown");
    }
    this.currentSessionId = query.sessionId;
    this.lastSentRequestId = query.requestId;
    // 发起新鲜查询（D6 第 2 步：无论上次报告是否 clean 都重新查询）
    this.ports.sendQuery(query);
    // 1.5s 有界等待本 requestId 的有效应答；超时 ⇒ unknown 降级（D6 第 4 步）
    const answer = await this.waitForAnswer();
    const target = this.guard.targetOf(this.webContentsId);
    const decision = evaluateCloseAnswer(answer, {
      handshaken: target?.handshaken ?? false,
      hasPendingLoss: this.deps.hasPendingLoss,
    });
    if (decision === "clean") {
      return this.executeQuit();
    }
    return this.confirm(decision);
  }

  /**
   * 有界等待本 requestId 的有效应答：应答先到则取消定时器并返回；
   * 超时先到则以 undefined 完成（走 unknown 降级）。两条路径都清 answerWaiter，
   * 之后到达的应答一律被忽略（迟到应答守卫的另一层，第一层在 guard 的 requestId）。
   */
  private waitForAnswer(): Promise<DraftCloseAnswer | undefined> {
    const answerPromise = new Promise<DraftCloseAnswer | undefined>((resolve) => {
      this.answerWaiter = resolve;
    });
    const timeoutMs = this.deps.queryTimeoutMs ?? DRAFT_CLOSE_QUERY_TIMEOUT_MS;
    const schedule =
      this.deps.scheduleTimeout ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => {
          clearTimeout(t);
        };
      });
    const cancelTimer = schedule(() => this.onQueryTimeout(), timeoutMs);
    return answerPromise.then((answer) => {
      cancelTimer();
      return answer;
    });
  }

  /** 查询超时：清挂起查询（迟到应答随 requestId 失效）并以"无应答"完成等待 */
  private onQueryTimeout(): void {
    this.guard.cancelQuery(this.webContentsId);
    const waiter = this.answerWaiter;
    this.answerWaiter = null;
    waiter?.(undefined);
  }

  /** dirty / unknown 共用：原生确认（默认返回），退出则一次性放行 */
  private async confirm(kind: "dirty" | "unknown"): Promise<CloseOutcome> {
    const choice = await this.ports.showConfirm(kind);
    if (choice === "quit") {
      return this.executeQuit();
    }
    // 返回：取消本次核对，通知 renderer 解锁并恢复焦点；
    // 挂起查询同时清除 ⇒ 迟到应答因 requestId 失配被 guard 拒绝，不会关窗。
    // 用户已看到确认并知悉（含会话丢失说明）⇒ 清除遗留标志，新会话再走正常核对。
    this.guard.cancelQuery(this.webContentsId);
    this.guard.acknowledgePendingLoss();
    const sessionId = this.currentSessionId;
    const requestId = this.lastSentRequestId;
    this.currentSessionId = null;
    this.lastSentRequestId = null;
    if (sessionId !== null && requestId !== null) {
      this.ports.sendRelease(sessionId, requestId);
    }
    return "canceled";
  }

  /** 确认退出 / clean 放行的公共收尾：armed 一次性 bypass + 重新触发正常关闭 */
  private executeQuit(): CloseOutcome {
    this.bypassArmed = true;
    const sessionId = this.currentSessionId;
    const requestId = this.lastSentRequestId;
    this.currentSessionId = null;
    this.lastSentRequestId = null;
    if (sessionId !== null && requestId !== null) {
      // 窗口即将销毁，renderer 的锁无需恢复；仍发释放以清理其锁状态
      this.ports.sendRelease(sessionId, requestId);
    }
    this.ports.closeWindow();
    return "closed";
  }
}
