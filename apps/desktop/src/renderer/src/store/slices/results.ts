// AppState 分片：Results 域（refactor-renderer 4.1 接口 / 5.5 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// **跨域协调者** noteReadingChanged / revokeSourceBoundPermissions / consumeSettledOperations
// 随域迁入并成为本分片公开成员（5.5 起唯一持有者在此）：runs/reading/compare/navigation
// 分片与 operations 分片经 store.ts 注入本分片实例的成员消费（注入源切换，design D2
// "分片之间无运行时互相导入"），configuration 的 setSettingsSection 走执行时 get()。
// 纯内部协调者 readRunResult / closeDraftClosureFor / closeRemainingClosures /
// attemptResultNavigation / draftLocatorOf 迁工厂闭包（组件无从各写一套）；
// noteReadingChanged 对执行确认的撤销走执行时 get().clearExecutionConfirmations()
// （5.6 起该出口是 drafts 分片公开成员，design D2 跨域调用走 action）。
import type { OperationRecord } from "@shared/operations";
import { api } from "../../lib/api";
import {
  applyDraftClosure,
  decideDraftClosure,
  draftStateOf,
  pendingTokenForTarget,
  verdictOfOperation,
} from "../../lib/draft-closure";
import type { DraftKind } from "../../lib/draft-list";
import type { DraftSubmitTarget } from "../../lib/draft-submission";
import * as submissionLib from "../../lib/draft-submission";
import { emptyConfirmationStore } from "../../lib/execution-confirmation";
import {
  type NavigationIntentStore,
  type NavigationTrigger,
  decideResultNavigation,
  emptyNavigationIntents,
  navigationIntentOf,
  releaseNavigationIntent,
} from "../../lib/navigation-intent";
import { type OperationSession, newlySettledOperations } from "../../lib/operation-session";
import {
  type ResultReadEntry,
  type ResultReadIdentity,
  type ResultReadStore,
  beginResultRead,
  emptyResultReadStore,
  finishResultRead,
  resultReadAlreadySettledOrInFlight,
  resultReadKeyOf,
  resultReadOf,
  verifyResultPayload,
} from "../../lib/result-verification";
import type { SliceContext } from "../types";

export interface ResultsState {
  /**
   * U5 任务 1.2：按可信身份读取到的**结果读取项**（design D3）。
   * 键为 `(epoch, operationId, runId)`；只存 renderer 会话内存，
   * 不落盘、不进 URL/日志/操作 IPC，也**不是**第二套执行真相源——
   * 它只说明"renderer 看到了哪条已校验的结局"。
   */
  resultReads: ResultReadStore;

  /**
   * U5 任务 3.4：**阅读代次**（design D6）。每次"用户主动换阅读对象或进出覆盖模态"都推进它，
   * 提交时登记的导航意图与它一比就知道用户有没有离开本次流程。
   * ⚠️ 单调递增、永不倒退 ⇒「离开再返回同一位置」不恢复旧资格（位置相等恒成立，代次不等）。
   */
  navGeneration: number;
  /** 本次会话各提交的导航意图（键 = operationId；renderer 内存，不落盘 / 不进 IPC / 不进日志） */
  navIntents: NavigationIntentStore;
  /**
   * U5 任务 3.6：**已看过的结果通知键**（会话内）。
   * 通知本身是**现算派生**（组件用 `deriveResultNotices` 从订阅状态算），这里只存"哪些键已看过"，
   * 不存在通知队列 ⇒ 重复快照不可能堆出第二份（红线「数据派生不累积」）。
   */
  seenNoticeKeys: Readonly<Record<string, true>>;

  /** U5 任务 1.2：按可信身份核实一次结局（去重；重试走 `retryResultRead`） */
  verifyRunResult: (identity: ResultReadIdentity) => Promise<ResultReadEntry>;
  /**
   * U5 任务 1.3：**显式只读重试**。只对同一条可信 runId 重读详情（`attempt` 递增），
   * 零执行通道调用——"重试读取"绝不复用执行通道、不重发模型请求（spec
   * 「结果不可读只重试同一记录」；重新执行必须换新 operationId 并重新授权）。
   * 与 `verifyRunResult` 的分工：后者对已在读/已核实的身份去重，本动作绕过那道去重。
   */
  retryResultRead: (identity: ResultReadIdentity) => Promise<ResultReadEntry>;

  /** U5 任务 3.5：打开该提交的结果概览（用户主动 ⇒ 不经导航意图，只走既有选择动作） */
  openOperationResult: (identity: ResultReadIdentity) => Promise<void>;
  /**
   * U5 任务 3.5：**失败定位只到真实自有调用**。
   *
   * 判据取 `deriveOwnTerminalFacts` 的 `failure`（`deriveErrorTarget` 已在 `leafSpanIds` 内找）；
   * 拿不到自有失败 span ⇒ 返回 false 且**一点也不动页面**——绝不跳祖先的错误调用、
   * 绝不跳"最后一个调用"凑数。诚实说明由视图给（`lib/operation-result-view` 的 `failureNote`）。
   */
  openOperationFailure: (identity: ResultReadIdentity) => Promise<boolean>;
  /**
   * U5 任务 3.5：**返回该提交对应的草稿**（复用既有草稿定位通道）。
   *
   * 目标键按身份查：先看待定关联（还在跑/未接受时正文与关联都在），再看收尾关联（解冻后）。
   * 草稿已被清理或从未登记 ⇒ 返回 false，由视图给回退说明；**不复活**旧内容，也不恢复旧授权。
   */
  returnOperationDraft: (identity: {
    epoch: string;
    operationId: string;
  }) => Promise<boolean>;
  /**
   * U5 任务 3.5：该操作对应的草稿**是否仍在**（面板据此决定给不给「返回草稿」）。
   * 按身份找回目标键（待定关联优先，其次收尾关联）后再查草稿仓库 ——
   * 与清理判据同一份仓库，不建"我以为还在"的第二套存在性。
   */
  isOperationDraftPresent: (identity: { epoch: string; operationId: string }) => boolean;
  /** U5 任务 3.6：标记为已看（展开操作面板、或用户明确打开某条结果时调用）；无变化 ⇒ 引用不变 */
  markNoticesSeen: (keys: readonly string[]) => void;

  // —— 跨域协调者（唯一入口在本分片；组件不得直接调用，JSDoc 即契约）——

  /**
   * U5 任务 3.4：阅读现场变了 ⇒ **推进代次**（design D6 的撤销面）。
   *
   * 只挂在"用户真的换了在看的东西或进出覆盖模态"的既有动作上（`selectRun` / 换页签 / 选调用 /
   * 换视图 / 开设置 / 开或关创建页 / 草稿定位）。刻意**不**挂在 `resetFork` / `resetCreateRun`
   * 这类展示态复位上：组件卸载与收起不该替用户决定"你不要这次结果"（同一纪律见 design D5
   * "组件卸载或展示状态复位 SHALL NOT 解除冻结"）。
   * 代次只增不减 ⇒「离开再返回不恢复旧自动导航」是自然结论（返回时又推进了一次）。
   */
  noteReadingChanged: () => void;
  /**
   * U6 任务 4.10：renderer 得知父本来源不完整/不可读 ⇒ **撤销绑定旧来源的可提交状态**。
   *
   * 触发口有两类（判据 `isLineageRejectionCode` / `completeness === "ownOnly"`）：
   * 1. 详情读取落地为 ownOnly（当前选中 run 的父链已确认不完整）；
   * 2. 预检/执行响应以 `RUN_LINEAGE_INCOMPLETE` / `RUN_DETAIL_UNREADABLE` 拒绝。
   *
   * 撤销面（design D4）：
   * - **检查代次全部推进**（`checkGenerations` 每键 +1）：旧只读检查的响应装不回新确认——
   *   父文件恢复也**不能自动复活**，恢复后必须重新检查；
   * - **确认凭据清空**（与 U5 的"离开现场"同一出口）；
   * - **来源撤销令牌 +1**：编辑器（A/B 计划 / 隔离 capability 结果 / 本次副本授权）订阅它，
   *   变化即清各自的组件局部状态——正文（草稿）一律保留。
   *
   * ⚠️ 这只是 renderer 会话内的展示与许可状态，**不是**第二套执行真相源：
   *    main 在每次新提交中仍会重读并重验来源（不信任任何客户端声明）。
   */
  revokeSourceBoundPermissions: () => void;
  /**
   * U5 任务 1.4：**终态消费的唯一落点**（design D3）。
   *
   * 三条入口——有效 status 采纳、有效执行回执后的状态刷新、reconcile 后的状态刷新——
   * 全部汇到本函数，所以"哪个先到"不改变结论，组件挂不挂载也不改变结论：
   * 1. 按身份解冻待定关联（只解这一条）；
   * 2. 整批**至多一次**列表刷新（没有任何新运行就不刷；列表失败也不拦住第 3 步）；
   * 3. 逐条按可信 runId 核实结果（串行发读，去重与代次守卫都在 `readRunResult` 里）。
   *
   * ⚠️ `runIds` 为空的 settled 一条都不读——那是"结果未定位"，只能核对登记，
   *    从列表最新项或错误文案里猜一个 id 正是 spec 禁止的做法。
   */
  consumeSettledOperations: (
    previous: OperationSession,
    trigger: NavigationTrigger,
  ) => Promise<void>;
}

/** results 分片工厂上下文：完整 set/get（5.6 起 clearExecutionConfirmations 改走 get() 跨域调用） */
export interface ResultsSliceContext extends SliceContext {}

export function createResultsSlice({ set, get }: ResultsSliceContext): ResultsState {
  /**
   * 提交目标 → 草稿定位目标（U5 任务 3.5 的「返回草稿」）。
   *
   * 两套编码同源不同形：提交侧的 `DraftSubmitTarget` 用判别联合（A/B 没有 `field` 键，
   * 创建只有 `field:"create"`），而定位通道（`openDraftAt` / `pendingDraftTarget`）要的是
   * 草稿列表那一形（`runId + spanId|null + DraftKind`）。这里只做一次机械换算，
   * **不**新增第二套身份判据 —— A/B 与创建的落地分支仍由 `openDraftAt` 自己判（U3 既有）。
   */
  function draftLocatorOf(target: DraftSubmitTarget): {
    runId: string;
    spanId: string | null;
    field: DraftKind;
  } {
    if (!("field" in target))
      return { runId: target.runId, spanId: target.spanId, field: "model_ab" };
    if (target.field === "create") return { runId: "", spanId: null, field: "create" };
    return { runId: target.runId, spanId: target.spanId, field: target.field };
  }

  /**
   * U5 任务 2.2/2.4：**按提交修订收尾一份草稿**（读取结论落地后尝试）。
   *
   * 判据全在 `lib/draft-closure`（四道闸 + 修订 CAS），这里只负责"看得见的那一份仓库"：
   * 关联查不到 / 登记里没有该身份 ⇒ 直接返回（宁可留着草稿，也不凭空判一个结局）。
   * 只有**真的删掉了**（或该目标本就无草稿）才释放关联——CAS 输了就留着关联等下一次核实，
   * 免得把"还没清成"的凭据先扔了。创建入口连该提交对应的目录引用一并清掉。
   */
  function closeDraftClosureFor(identity: { epoch: string; operationId: string }): void {
    const state = get();
    const closure = submissionLib.closureOf(
      state.draftSubmissions,
      identity.epoch,
      identity.operationId,
    );
    if (closure === undefined) return;
    const record = state.operations.operations.find(
      (one) => one.epoch === identity.epoch && one.operationId === identity.operationId,
    );
    if (record === undefined) return;
    /**
     * U5 任务 2.3：**只结"当前会话、通信已确认"的账**（design D3）。
     * - 换过 main 会话后旧登记的结局永久未知——哪怕它的结果迟到了、草稿修订也对得上，
     *   也不能拿一份没被现行会话确认过的事实去删用户的输入；
     * - 通信未知时同样不清理：此刻连"这条操作到底停在哪儿"都没确认。
     */
    if (state.operations.epoch !== identity.epoch || state.operations.unknown) return;
    const decision = decideDraftClosure({
      closure,
      draft: draftStateOf(state.drafts, closure.target),
      verdict: verdictOfOperation(record, state.resultReads, closure.expectedArmCount),
      pendingToken: pendingTokenForTarget(state.draftSubmissions.byId, closure),
    });
    if (decision.kind === "keep") return;
    const applied = applyDraftClosure(state.drafts, closure, decision);
    if (!applied.cleaned && decision.kind === "clean") return;
    set((current) => ({
      drafts: applied.repo,
      draftSubmissions: submissionLib.releaseClosure(current.draftSubmissions, identity),
      // 创建入口：整份表单被清 ⇒ 这次提交对应的目录引用同步失效（不继承给下一份草稿）
      ...(applied.cleaned && closure.channel === "create" ? { createSourceRef: null } : {}),
    }));
  }

  /**
   * 一次按可信 ID 核实结果的实际读取（U5 任务 1.2/1.3）。
   *
   * 三条判据都落在这里，组件无从各写一套：
   * - **去重**（`force=false`）：该身份已在读或已核实 ⇒ 直接交回在场的结论，不发第二次请求
   *   （轮询返回全量快照，逐次快照都重读会把 IO 放大，design 风险段第 3 条）；
   * - **代次**：每次实际读取都递增 `attempt`，响应落地只认当代——期间有人重试 ⇒
   *   这条迟到的旧结论整份丢弃，不覆盖新读取、也不碰其他键（spec「旧读取响应不能污染其他结果」）；
   * - **只读**：整条路径只走 `runs:get`，零执行通道、零列表刷新、零选择/滚动/焦点变更。
   */
  async function readRunResult(
    identity: ResultReadIdentity,
    force: boolean,
  ): Promise<ResultReadEntry> {
    const current = resultReadOf(get().resultReads, identity);
    if (!force && resultReadAlreadySettledOrInFlight(current)) return current as ResultReadEntry;
    const started = beginResultRead(get().resultReads, identity);
    set({ resultReads: started.store });
    const verification = verifyResultPayload(identity.runId, await api.getRun(identity.runId));
    set((state) => ({
      resultReads: finishResultRead(state.resultReads, identity, started.attempt, verification),
    }));
    // U5 任务 2.2/2.5：读取结论一落地就**立刻**尝试按修订收尾——自动核实、显式只读重试、
    // 面板收起后的轮询都走这一处，组件挂不挂载与它无关（收尾不留在 `.then()` 里）。
    closeDraftClosureFor(identity);
    // 守卫丢弃本次结论时，交回界面上真正在场的那一条（调用方据此呈现，绝不拿废结论去导航）
    return resultReadOf(get().resultReads, identity) as ResultReadEntry;
  }

  /**
   * 终态到达后由**流程协调处**尝试一次结果导航（design D4：核实与导航是两个动作）。
   *
   * 入参一律取**调用这一刻**的 store 状态：读取在飞期间用户可能已经离页、开了设置或换了运行，
   * 那时这条意图永久作废（spec「读取途中离页仍不抢焦点」）—— 绝不让读取开始时快照的资格说话。
   * 只有 `wait`（结果还在读）留着意图；导航成功与一切"不跳"的判定都把它收掉：
   * 一次性动作不重复产生（spec「重复快照不得重复导航」）。
   */
  async function attemptResultNavigation(
    record: OperationRecord,
    trigger: NavigationTrigger,
  ): Promise<void> {
    const state = get();
    const onlyRunId = record.runIds.length === 1 ? record.runIds[0] : undefined;
    const decision = decideResultNavigation({
      intent: navigationIntentOf(state.navIntents, record.operationId),
      generation: state.navGeneration,
      coveringModal: state.settingsSection !== null,
      record,
      entry:
        onlyRunId === undefined
          ? undefined
          : resultReadOf(state.resultReads, {
              epoch: record.epoch,
              operationId: record.operationId,
              runId: onlyRunId,
            }),
      trigger,
    });
    if (decision.kind === "wait") return;
    set((current) => ({
      navIntents: releaseNavigationIntent(current.navIntents, record.operationId),
    }));
    if (decision.kind !== "navigate") return;
    // 走既有的选择动作（恢复该 run 自己的阅读状态），不在这里另写一份落地逻辑。
    // ⚠️ 同 ID 时 `selectRun` 自己短路 ⇒ 自动导航既不改页签/滚动，也不推进代次。
    await get().selectRun(decision.runId);
  }

  /**
   * 补一轮"遗留关联"的收尾（U5 任务 2.3）。
   *
   * 只处理本轮新终态会漏掉两类事实：通信恢复后旧操作的结果早已读到、以及迟到响应改变了
   * 另一条身份的结论。这里对**在场的每条关联**再走一次同一判据（四道闸 + 修订 CAS 都不变），
   * 所以重复调用只可能"已经清过 ⇒ 什么都不做"，不会删错。
   */
  function closeRemainingClosures(): void {
    const closures = get().draftSubmissions.closures;
    for (const closure of Object.values(closures)) {
      closeDraftClosureFor({ epoch: closure.epoch, operationId: closure.operationId });
    }
  }

  return {
    // U5 任务 1.2：按可信身份读取的结果（会话内，与阅读状态和草稿都分开）
    resultReads: emptyResultReadStore(),
    // U5 任务 3.4：阅读代次 + 各提交的导航意图（同为会话内，不进任何持久化）
    navGeneration: 0,
    navIntents: emptyNavigationIntents(),
    // U5 任务 3.6：已看过的结果通知键（通知本身由 deriveResultNotices 现算）
    seenNoticeKeys: {},

    async verifyRunResult(identity) {
      // U5 任务 1.2/1.3：核实动作**只**读详情通道并写自己的读取项。
      // 不 selectRun / reopenRun（那会换选中项、恢复阅读状态、动 loadingDetail 与全局 error），
      // 不 loadRuns（列表失败与按 ID 核实互不相干），不碰任何执行通道。
      return readRunResult(identity, false);
    },

    async retryResultRead(identity) {
      return readRunResult(identity, true);
    },

    async openOperationResult(identity) {
      // 3.5：用户主动 ⇒ 不经导航意图；但只走既有选择动作，落地口径与手动切运行完全一致
      get().markNoticesSeen([resultReadKeyOf(identity)]);
      await get().selectRun(identity.runId);
    },

    async openOperationFailure(identity) {
      const entry = resultReadOf(get().resultReads, identity);
      const spanId = entry?.facts?.failure.llmCallSpanId ?? null;
      if (spanId === null) return false;
      await get().openOperationResult(identity);
      // 详情读不出来 ⇒ 不做任何定位（不跳到一个"大概在那里"的调用上）
      if (get().selectedRunId !== identity.runId) return false;
      get().setReadingTab(identity.runId, "steps");
      get().selectSpan(spanId);
      return true;
    },

    async returnOperationDraft({ epoch, operationId }) {
      const target = submissionLib.submissionTargetOf(get().draftSubmissions, epoch, operationId);
      if (target === null) return false;
      // 草稿不在（已按修订清理 / 已显式放弃）⇒ 交给视图说清"为什么不返回"，这里不复活内容
      if (!draftStateOf(get().drafts, target).exists) return false;
      await get().openDraftAt(draftLocatorOf(target));
      return true;
    },

    isOperationDraftPresent({ epoch, operationId }) {
      const target = submissionLib.submissionTargetOf(get().draftSubmissions, epoch, operationId);
      return target !== null && draftStateOf(get().drafts, target).exists;
    },

    markNoticesSeen(keys) {
      if (keys.length === 0) return;
      set((state) => {
        let changed = false;
        const next = { ...state.seenNoticeKeys };
        for (const key of keys) {
          if (next[key] === true) continue;
          next[key] = true;
          changed = true;
        }
        return changed ? { seenNoticeKeys: next } : {};
      });
    },

    // —— 跨域协调者（5.5 迁入本分片；注入源=本实例，消费方见类型 JSDoc）——

    noteReadingChanged() {
      set((state) => ({ navGeneration: state.navGeneration + 1 }));
      // U5 任务 4.4：离开现场同样撤销待用的执行确认（切运行 / 换页签 / 换调用 / 换视图 /
      // 进创建页 —— 之前核对的目标已经不是现在要提交的目标）。
      // 5.6：出口迁 drafts 分片，经执行时 get() 消费（跨域调用走 action，design D2）。
      get().clearExecutionConfirmations();
    },

    revokeSourceBoundPermissions() {
      set((state) => {
        const hasChecks = Object.keys(state.checkGenerations).length > 0;
        const hasConfirmations = Object.keys(state.confirmations.byTargetKey).length > 0;
        if (!hasChecks && !hasConfirmations) {
          return { sourceRevocation: state.sourceRevocation + 1 };
        }
        return {
          sourceRevocation: state.sourceRevocation + 1,
          checkGenerations: hasChecks
            ? Object.fromEntries(
                Object.entries(state.checkGenerations).map(([key, generation]) => [
                  key,
                  generation + 1,
                ]),
              )
            : state.checkGenerations,
          ...(hasConfirmations ? { confirmations: emptyConfirmationStore() } : {}),
        };
      });
    },

    async consumeSettledOperations(previous, trigger) {
      const fresh = newlySettledOperations(previous, get().operations);
      if (fresh.length > 0) {
        const state = get();
        for (const record of fresh) {
          state.settleDraftByOperation({ epoch: record.epoch, operationId: record.operationId });
        }
        if (fresh.some((record) => record.runIds.length > 0)) await state.loadRuns();
        for (const record of fresh) {
          for (const runId of record.runIds) {
            await readRunResult(
              { epoch: record.epoch, operationId: record.operationId, runId },
              false,
            );
          }
        }
        // U5 任务 3.4：核实全部落地**之后**才谈导航（design D4：核实与导航分开两个动作）
        for (const record of fresh) {
          await attemptResultNavigation(record, trigger);
        }
      }
      // 无论本轮有没有新终态，都在场的关联补一次收尾：结果早于通信恢复读到的情形也要有出路
      closeRemainingClosures();
    },
  };
}
