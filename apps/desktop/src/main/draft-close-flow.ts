import type { DraftCloseAnswer, DraftCloseQuery } from "../shared/ipc";
import type { DraftCloseGuard } from "./draft-close-guard";

/**
 * U3 任务 4.4：关闭决策流（design D6 处理顺序的 main 侧**纯逻辑核心**，
 * 不 import electron——原生确认 / 关闭窗口 / 发消息都是注入端口，vitest 直测）。
 *
 * 流程（每个窗口一份 flow）：
 * 1. `interceptClose()`（窗口 close 事件入口）：一次性 bypass 在手则放行；
 *    否则 preventDefault（装配层做）并启动协商；
 * 2. 协商一开始先置 main 的 closing 标记（U4 5.1，design D7：期间拒绝新主动执行
 *    与配置变更），再**发起新鲜查询**（renderer 同步输入→上锁→应答）；
 * 3. 应答有效且 dirtyCount=0、inputSettled=true、无会话丢失遗留，**且** main
 *    活跃槽为空、无进行中配置变更 ⇒ 放行（armed bypass 后真正执行关闭）；
 * 4. dirtyCount>0 ⇒ 「有草稿」确认；超时/未握手/应答无效/inputSettled=false ⇒
 *    「暂时无法确认」；有活跃操作或配置变更中 ⇒ **合并进同一次**原生确认（U4 5.2），
 *    默认返回；
 * 5. 用户选择退出 ⇒ armed 一次性 bypass + 重新触发正常关闭（本次协商不复用）；
 *    选择返回 ⇒ 取消查询 + 解除 closing + 通知 renderer 解锁，迟到应答因 requestId 已清除被拒。
 *
 * 并发纪律（4.6 进一步加固）：同一窗口同时至多一个协商/确认——进行中再次触发
 * close 复用当前流程（返回同一个 Promise），不叠加、不重入。
 *
 * 顺序是契约（U4 tasks 5.1）：closing → 同步输入 → 查 dirty → **最后**读 main 活跃槽。
 * 反过来先读槽就会漏掉「询问期间刚提交的那一次」。返回只释放 closing 与输入锁，
 * **不释放执行槽、不删登记**——确认退出也不把活跃操作记成「已取消」。
 */

export type CloseDecision = "clean" | "dirty" | "unknown";
export type CloseOutcome = "closed" | "canceled";

/** main 侧关闭时点必须一并核对的事实（U4 5.1：活跃槽与配置变更标记） */
export interface MainCloseFacts {
  activeOperationId: string | null;
  configurationBusy: boolean;
}

/**
 * 合并确认的构成事实（U4 5.2）：草稿状态与活跃操作/配置变更**一次问完**，
 * 不叠加弹框。`draft = null` 表示草稿侧已知 clean，本次确认只由 main 事实触发。
 */
export interface CloseConfirmFacts {
  draft: "dirty" | "unknown" | null;
  activeOperation: boolean;
  configurationBusy: boolean;
}

/** 由「草稿档 + main 事实」拼出合并确认的构成 */
export function confirmFacts(
  draft: "dirty" | "unknown" | null,
  main: MainCloseFacts,
): CloseConfirmFacts {
  return {
    draft,
    activeOperation: main.activeOperationId !== null,
    configurationBusy: main.configurationBusy,
  };
}

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

/**
 * U4 5.1：clean 直接关闭的**联合**判据 —— U3 全部 clean 条件 **且** 无活跃操作
 * **且** 无进行中配置变更。配置变更没完成时按「状态待定」合入确认，
 * 不冒充主动 run（design D7 / spec「无草稿的活跃操作也需确认」）。
 */
export function evaluateCloseOutcome(
  draft: CloseDecision,
  main: MainCloseFacts,
): { kind: "close" } | { kind: "confirm"; facts: CloseConfirmFacts } {
  if (draft === "clean" && main.activeOperationId === null && !main.configurationBusy) {
    return { kind: "close" };
  }
  return { kind: "confirm", facts: confirmFacts(draft === "clean" ? null : draft, main) };
}

/** 原生确认文案（标题 / 正文 / 按钮），纯数据便于单测；装配层只负责弹框 */
export interface CloseConfirmText {
  title: string;
  message: string;
  detail: string;
  /** 退出按钮文案：有草稿时明确「丢弃草稿」，否则只说退出 */
  quitLabel: string;
}

/**
 * U4 5.2：把「草稿状态 + 活跃操作 + 配置变更 + 会话丢失遗留」合进**一次**文案。
 *
 * 措辞纪律：不诊断 renderer 存活（不写「已崩溃/失联/无响应」）；
 * 活跃操作只陈述「尚未结束」与「退出不会撤销上游请求/费用/副作用」，
 * 不宣称已取消，也不宣称已停止。
 */
export function buildCloseConfirmText(
  facts: CloseConfirmFacts,
  pendingLoss: boolean,
): CloseConfirmText {
  const notes: string[] = [];
  let message: string;
  if (facts.draft === "dirty") {
    message = facts.activeOperation ? "有未放弃的调试草稿，且有操作正在执行" : "有未放弃的调试草稿";
    notes.push("本轮会话中已输入的调试草稿在退出后将丢失，且无法恢复。");
  } else if (facts.draft === "unknown") {
    message = facts.activeOperation
      ? "暂时无法确认草稿状态，且有操作正在执行"
      : "暂时无法确认草稿状态";
    notes.push(
      "暂时无法确认草稿状态，不能确定是否有未放弃的编辑。选择「返回」可继续使用应用，稍后再次退出时会重新核对。",
    );
  } else {
    message = facts.configurationBusy ? "有一次配置变更尚未完成" : "有操作正在执行";
  }
  if (facts.activeOperation) {
    notes.push(
      "还有已登记的主动操作尚未结束：退出不会取消上游请求，也不会撤销已产生的费用或副作用，操作记录同样不会标记为已取消。",
    );
  }
  if (facts.configurationBusy) {
    notes.push("还有一次配置变更尚未完成（保存配置或代理启停），退出不会让它回滚。");
  }
  if (pendingLoss) {
    notes.push("此外，先前会话的调试草稿可能已经丢失（该会话在退出或重载前未能完成核对）。");
  }
  notes.push("要继续编辑或保留当前操作请选择「返回」。");
  return {
    title: "退出 ReBaseAgent",
    message,
    detail: notes.join(""),
    quitLabel: facts.draft === "dirty" ? "退出并丢弃草稿" : "退出",
  };
}

export interface DraftCloseFlowPorts {
  /** main → renderer：发送关闭查询（装配层用 webContents.send） */
  sendQuery(query: DraftCloseQuery): void;
  /** 绑定窗口的原生确认；返回用户选择 */
  showConfirm(facts: CloseConfirmFacts): Promise<"return" | "quit">;
  /** 重新触发正常关闭（bypass 已 armed，close 处理器放行） */
  closeWindow(): void;
  /** main → renderer：取消本次关闭，通知 renderer 解锁并恢复焦点 */
  sendRelease(sessionId: string, requestId: string): void;
  /**
   * U4 5.1：置/解除 main 的 closing 标记（真实端口 = `OperationRegistry.setClosing`）。
   * 协商一开始即置位 ⇒ 期间新主动请求与配置变更在副作用前被拒。
   */
  setClosing(closing: boolean): void;
  /** U4 5.1：读取当前活跃槽与配置变更标记（在应答之后调用，顺序是契约） */
  readMainFacts(): MainCloseFacts;
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

  /**
   * 窗口已销毁（装配层 closed 时调用）：协商随窗口结束，closing 标记必须解除，
   * 否则一次已结束的协商会永久封住主动执行与配置变更。
   * 确认退出路径**不**在此伪造取消——它只释放标记，槽与登记留给进程结束。
   */
  onWindowClosed(): void {
    this.ports.setClosing(false);
  }

  /** 协商核心。返回 "closed" 时 bypass 已 armed 且窗口正在关闭 */
  private async run(): Promise<CloseOutcome> {
    // 顺序契约（U4 5.1）：先置 closing（拒新主动请求与配置变更）→ 再同步输入 → 查 dirty
    this.ports.setClosing(true);
    try {
      const outcome = await this.negotiate();
      // 「closed」保持 closing（进程正在结束）；「canceled」只释放 closing 与输入锁
      if (outcome === "canceled") this.ports.setClosing(false);
      return outcome;
    } catch (error) {
      // 异常清理：确认端口抛错 ⇒ 解除 closing，取消挂起查询并解除 renderer 输入锁（否则锁死）
      this.ports.setClosing(false);
      this.guard.cancelQuery(this.webContentsId);
      this.releaseRendererLock();
      throw error;
    }
  }

  /** 一次协商：新鲜查询 → 有界应答 → 联合 main 事实 → 放行或合并确认 */
  private async negotiate(): Promise<CloseOutcome> {
    const query = this.guard.beginQuery(this.webContentsId);
    if (query === null) {
      // 目标不存在（窗口已销毁）：无可核对对象 ⇒ 保守走 unknown 确认，不静默放行
      return this.confirm(confirmFacts("unknown", this.ports.readMainFacts()));
    }
    this.currentSessionId = query.sessionId;
    this.lastSentRequestId = query.requestId;
    // 发起新鲜查询（D6 第 2 步：无论上次报告是否 clean 都重新查询）
    this.ports.sendQuery(query);
    // 1.5s 有界等待本 requestId 的有效应答；超时 ⇒ unknown 降级（D6 第 4 步）
    const answer = await this.waitForAnswer();
    const target = this.guard.targetOf(this.webContentsId);
    const draft = evaluateCloseAnswer(answer, {
      handshaken: target?.handshaken ?? false,
      hasPendingLoss: this.deps.hasPendingLoss,
    });
    // **最后**读 main 活跃槽：询问期间刚提交的这一次也必须被看见
    const outcome = evaluateCloseOutcome(draft, this.ports.readMainFacts());
    if (outcome.kind === "close") return this.executeQuit();
    return this.confirm(outcome.facts);
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

  /** dirty / unknown / 活跃操作共用：**一次**原生确认（默认返回），退出则一次性放行 */
  private async confirm(facts: CloseConfirmFacts): Promise<CloseOutcome> {
    const choice = await this.ports.showConfirm(facts);
    if (choice === "quit") {
      return this.executeQuit();
    }
    // 返回：取消本次核对，通知 renderer 解锁并恢复焦点；
    // 挂起查询同时清除 ⇒ 迟到应答因 requestId 失配被 guard 拒绝，不会关窗。
    // 用户已看到确认并知悉（含会话丢失说明）⇒ 清除遗留标志，新会话再走正常核对。
    this.guard.cancelQuery(this.webContentsId);
    this.guard.acknowledgePendingLoss();
    this.releaseRendererLock();
    return "canceled";
  }

  /** 解除 renderer 输入锁（携带本次查询身份；无挂起查询时不发释放通知） */
  private releaseRendererLock(): void {
    const sessionId = this.currentSessionId;
    const requestId = this.lastSentRequestId;
    this.currentSessionId = null;
    this.lastSentRequestId = null;
    if (sessionId !== null && requestId !== null) {
      this.ports.sendRelease(sessionId, requestId);
    }
  }

  /** 确认退出 / clean 放行的公共收尾：armed 一次性 bypass + 重新触发正常关闭 */
  private executeQuit(): CloseOutcome {
    this.bypassArmed = true;
    // 窗口即将销毁，renderer 的锁无需恢复；仍发释放以清理其锁状态
    this.releaseRendererLock();
    this.ports.closeWindow();
    return "closed";
  }
}
