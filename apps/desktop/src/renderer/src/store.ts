import type {
  ChooseSourceResult,
  CreateRunRequest,
  Envelope,
  ForkCapabilityRequest,
  ForkCapabilityResult,
  IsolatedExecutionMode,
  ModelAbResult,
  ProxyState,
  ProxyToggleInput,
  SettingsInput,
  SettingsState,
  WorkspaceExportOutcome,
  WorkspaceExportRequest,
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceReadFileRequest,
  WorkspaceReadFileResult,
} from "@shared/ipc";
import type { ModelAbArm, PromptForkRequest } from "@shared/ipc";
import {
  ChooseSourceResultSchema,
  ForkCapabilityResultSchema,
  ProxyChangeEventSchema,
  ProxyStateSchema,
  RunDetailSchema,
  SettingsStateSchema,
  WorkspaceExportOutcomeSchema,
  WorkspaceInspectResultSchema,
  WorkspaceReadFileResultSchema,
} from "@shared/ipc";
import type {
  ExecutedRequest,
  ExecutedResponse,
  OperationAck,
  OperationRecord,
  OperationStatusResult,
} from "@shared/operations";
import {
  OPERATION_ERROR,
  OperationAckSchema,
  OperationStatusResultSchema,
  ReconcileResultSchema,
} from "@shared/operations";
import { create } from "zustand";
import { api } from "./lib/api";
import type { CreateReturnLocation } from "./lib/create-workspace";
import {
  filePatchOfLocation,
  liveSpanOfLocation,
  readingPatchOfLocation,
} from "./lib/create-workspace";
import { isLineageRejectionCode } from "./lib/detail-completeness";
import {
  applyDraftClosure,
  decideDraftClosure,
  draftStateOf,
  pendingTokenForTarget,
  verdictOfOperation,
} from "./lib/draft-closure";
import type { DraftKind } from "./lib/draft-list";
import type { DraftSubmission, DraftSubmitTarget } from "./lib/draft-submission";
import * as submissionLib from "./lib/draft-submission";
import { emptyConfirmationStore, releaseConfirmation } from "./lib/execution-confirmation";
import {
  type NavigationIntentStore,
  type NavigationTrigger,
  decideResultNavigation,
  emptyNavigationIntents,
  navigationIntentOf,
  releaseNavigationIntent,
} from "./lib/navigation-intent";
import {
  type OperationBlockedBy,
  type OperationSession,
  type PendingSubmission,
  applyReconcile,
  applyStatus,
  beginHandshake,
  beginLocalSubmission,
  captureGeneration,
  deriveGate,
  endLocalSubmission,
  initialSession,
  markUnknown,
  newlySettledOperations,
} from "./lib/operation-session";
import type { ProxyFactCursor } from "./lib/proxy-changes";
import {
  initialProxyFactCursor,
  shouldApplyChange,
  shouldReconcileOnActivate,
} from "./lib/proxy-changes";
import type { ProxyStatusReadState } from "./lib/proxy-status-read";
import {
  acceptProxySnapshot,
  beginStatusRead,
  initialProxyStatusReadState,
  settleStatusRead,
} from "./lib/proxy-status-read";
import {
  fileReadingOf,
  patchFileReading,
  patchReadingState,
  readingStateOf,
} from "./lib/reading-state";
import type { RecordingDraft, RecordingDraftPatch } from "./lib/recording-draft";
import {
  applyRecordingBaseline,
  discardRecordingDraft as discardRecordingDraftState,
  recordingApplyRequest,
  recordingBaselineOf,
  writeRecordingDraft,
} from "./lib/recording-draft";
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
} from "./lib/result-verification";
import type { SettingsSaveOutcome } from "./lib/settings-form";
import { feedbackFromOutcome, workspaceExportKey } from "./lib/workspace-export-state";
import type { WorkspaceExportFeedback } from "./lib/workspace-export-state";
import { createCreateReturnFactsCache } from "./store/runtime/create-return-facts-cache";
import { createOperationPollingRuntime } from "./store/runtime/operation-polling";
import { createProxyCoordinationRuntime } from "./store/runtime/proxy-coordination";
// 兼容导出（4.1）：ExperimentSourceState/idleExperimentSource 迁 slices/navigation，指向同一实现
import { createCompareSlice } from "./store/slices/compare";
import { createDraftsSlice } from "./store/slices/drafts";
import { idleExperimentSource } from "./store/slices/navigation";
import { createNavigationSlice } from "./store/slices/navigation";
import { createDetailReadAttempts, createReadingSlice } from "./store/slices/reading";
import { createRunsSlice } from "./store/slices/runs";
import type { AppState } from "./store/types";
export { idleExperimentSource };
export type { ExperimentSourceState } from "./store/slices/navigation";
/**
 * UI 状态：只存选择状态与原始数据。
 * 聚合数字一律在组件里用 shared/derive 的纯函数现算，不进 store、不落缓存。
 */

// MAX_COMPARE（5.3）随 compare 分片迁 slices/compare.ts；此处兼容再导出指向同一实现。
export { MAX_COMPARE } from "./store/slices/compare";

/** 跨进程数据不可信：统一用 schema 校验后再进状态 */
function describeZodError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 门禁禁用原因 → 稳定码 + 中文文案（renderer 本地结论，请求一次都没发出） */
const LOCAL_BLOCKED: Record<OperationBlockedBy, { code: string; message: string }> = {
  not_handshaked: {
    code: "MAIN_HANDSHAKE_REQUIRED",
    message: "尚未与主进程完成操作握手，本次请求未发送；请重试或重新加载窗口",
  },
  communication_unknown: {
    code: "OPERATION_STATE_UNKNOWN",
    message: "操作状态未确认（状态通道失联或返回非法结构），本次请求未发送；请先核对状态",
  },
  closing: {
    code: "OPERATION_CLOSING",
    message: "应用正在退出协商，本次请求未发送",
  },
  configuration_busy: {
    code: "OPERATION_CONFIGURATION_BUSY",
    message: "运行配置或代理服务正在变更，本次请求未发送；请等变更完成后重试",
  },
  operation_running: {
    code: "OPERATION_BUSY",
    message: "已有操作在执行（或尚未确认结束），本次请求未发送；请等当前操作结束",
  },
};

/**
 * 执行响应的回执核验（任务 4.1「非法操作响应不能解除门禁」的落点）：
 * `ok:true` 但没有可信回执、或回执身份不是我们刚发出的那一次 ⇒ 一律按**未知**处理，
 * 不部分采纳所谓成功字段（调用方因此不会解冻草稿、不会把本地锁当已释放）。
 */
function inspectAck(
  response: ExecutedResponse<unknown>,
  identity: PendingSubmission,
): { readonly ack: OperationAck | null; readonly problem: string | null } {
  if (response.operation === null || response.operation === undefined) {
    return { ack: null, problem: "响应缺少操作回执" };
  }
  const parsed = OperationAckSchema.safeParse(response.operation);
  if (!parsed.success) {
    return { ack: null, problem: `操作回执结构不合法：${describeZodError(parsed.error)}` };
  }
  if (parsed.data.epoch !== identity.epoch || parsed.data.operationId !== identity.operationId) {
    return { ack: null, problem: "操作回执身份与本次提交不匹配" };
  }
  return { ack: parsed.data, problem: null };
}

// ---------------------------------------------------------------------------
// 单路有界轮询（refactor-renderer 4.2）：判据在 `lib/operation-polling.ts`，
// 计时器资源整体迁 `store/runtime/operation-polling.ts`（唯一所有者，见文件尾组合）。
// 轮询**只读 status**，绝不重放业务 payload（重放等于自动重发，spec 明令禁止）。
// ---------------------------------------------------------------------------

/**
 * 主动执行的统一提交适配器（U4 design D6，tasks 4.1/4.2/4.3 的适配器半边）。
 *
 * 所有主动入口都走这里：读会话门禁 → 新生成 operationId → 包成 `{operation, request}` →
 * 交给对应通道。operationId **每次提交都新**（含失败重试——重试不复用被封禁/已结束的
 * 许可，见 spec「新执行 SHALL 使用新 ID」）。响应原样返回给调用方，由它按
 * 「身份 + 登记版本 + 状态」处理草稿冻结，而不是把裸 `ok/fail` 当操作结局。
 *
 * 门禁（任务 4.1）：
 * - 尚未握手 ⇒ 补一次握手，仍不可用就按**本地未发送**处理（不冻结草稿、不进 Unknown）；
 * - 通信未知 / 关闭协商 / 配置变更中 / 已有操作在飞（含本地尚未确认的提交）⇒ 同样本地拒发。
 *   main 返回 busy 仍是最后防线，界面不能靠"发不出去才报错"当门禁。
 * - 通道抛错 ⇒ 请求是否被 main 接受**不可知**：置 Unknown 并保留该在飞身份，
 *   绝不自动重发（下一次有效 status 才会确认）。
 */
async function submitActive<TRequest, TResponse>(
  call: (request: ExecutedRequest<TRequest>) => Promise<ExecutedResponse<TResponse>>,
  business: TRequest,
  /** U4 任务 4.2：带草稿关联的提交用**关联里已生成的** operationId（身份与快照同步定下） */
  submission?: DraftSubmission,
): Promise<ExecutedResponse<TResponse>> {
  if (deriveGate(useAppStore.getState().operations).blockedBy === "not_handshaked") {
    await useAppStore.getState().refreshOperationStatus();
  }
  const blocked = deriveGate(useAppStore.getState().operations).blockedBy;
  if (blocked !== null) {
    const { code, message } = LOCAL_BLOCKED[blocked];
    return { ok: false, operation: null, error: { code, message } };
  }
  const epoch = useAppStore.getState().operations.epoch as string;
  const identity: PendingSubmission = {
    epoch,
    // 关联里已生成的 operationId 就是本次提交的身份；没有关联（如 dryRun/预览）才另起
    operationId: submission?.operationId ?? crypto.randomUUID(),
    // U5 任务 5.2：本地提交时刻——等待计时的首选基准（会话内存，不进 IPC 信封）
    submittedAt: Date.now(),
  };
  // 关联的 epoch 在真正发出的这一刻绑定（此前它可能是 null = 还没握上手）
  if (submission !== undefined && submission.epoch !== epoch) {
    useAppStore.setState((state) => ({
      draftSubmissions: submissionLib.bindSubmissionEpoch(
        state.draftSubmissions,
        submission,
        epoch,
      ),
    }));
  }
  useAppStore.setState((state) => ({
    operations: beginLocalSubmission(state.operations, identity),
  }));
  let response: ExecutedResponse<TResponse>;
  try {
    // 信封 identity 只带契约里的两键（main 侧 OperationIdentitySchema 是 strict 的，
    // 多一个 submittedAt 都会被判非法形状）——本地时间事实不跨进程外带。
    response = await call({
      operation: { epoch: identity.epoch, operationId: identity.operationId },
      request: business,
    });
  } catch (error) {
    // 未知：保留在飞身份并保守锁住（不重发、不解冻、不假装结束）
    useAppStore.setState((state) => ({ operations: markUnknown(state.operations) }));
    // 任务 4.5：失联 ⇒ 自动轮询停下（手动核对仍可用），不靠重试打爆通道
    stopOperationStatusPolling();
    throw error;
  }
  if (!response.ok && response.error.code === OPERATION_ERROR.staleEpoch) {
    // 新 main 会话：旧 epoch 的响应不采纳。旧身份**不销账**——它的结局仍是未知（任务 4.6）
    useAppStore.setState((state) => ({ operations: markUnknown(state.operations) }));
    // 任务 4.5：状态未确认 ⇒ 停下自动轮询，等用户/下一次握手来核对
    stopOperationStatusPolling();
    return response;
  }
  // 任务 4.6：会话已经换过（epoch 与发出时不同）⇒ 这条迟到的旧响应不得解冻、不得导航、
  // 也不得把会话状态回退。⚠️ 这里**不标通信未知**：新会话的状态刚由一次有效握手确认过，
  // 未知的是"旧那次提交的结局"（永久未知）——把它标成通道失联会连带锁死新会话。
  if (useAppStore.getState().operations.epoch !== identity.epoch) {
    return {
      ok: false,
      operation: null,
      error: {
        code: "OPERATION_SESSION_SWITCHED",
        message: "主进程会话已更换：这次提交（属旧会话）的结局未知，不会自动重发，也不会跳转结果",
      },
    };
  }
  // U6 任务 4.10：main 以来源类稳定码拒绝（父本 ownOnly / 详情不可读）⇒
  // renderer 同步撤销绑定旧父本的可提交状态（检查代次推进 + 确认清空 + 撤销令牌 +1），
  // 恢复必须重新检查；草稿正文不受影响（拒绝不等于放弃输入）。
  if (!response.ok && isLineageRejectionCode(response.error.code)) {
    revokeSourceBoundPermissions();
  }
  // 回执核验：可信回执才销账；缺回执 / 回执身份不匹配 ⇒ 未知（不部分采纳成功字段）
  const { ack, problem } = inspectAck(response as ExecutedResponse<unknown>, identity);
  if (problem !== null || ack === null) {
    useAppStore.setState((state) => ({ operations: markUnknown(state.operations) }));
    return {
      ok: false,
      operation: null,
      error: {
        code: "OPERATION_ACK_INVALID",
        message: `执行响应的操作回执不可信（${problem}）：本次执行状态未确认，请核对状态`,
      },
    };
  }
  if (ack.state !== "running") {
    useAppStore.setState((state) => ({
      operations: endLocalSubmission(state.operations, identity.operationId),
    }));
    /**
     * U5 任务 1.4：拿到**可信终态回执**就立刻取一次 status——`runIds` 只存在于登记快照里，
     * 回执本身只说明"这条操作结束了"。刷新后由 `consumeSettledOperations` 统一收尾，
     * 于是"响应到达"与"轮询/核对到达"走的是同一条核实路径（spec「所有入口实际使用同一适配器」）。
     */
    await useAppStore.getState().refreshOperationStatus();
  }
  // 任务 4.5：计时起点是"这次响应完成"——批次/长请求在飞期间不叠加定时请求
  rescheduleStatusPoll();
  return response;
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
  const current = resultReadOf(useAppStore.getState().resultReads, identity);
  if (!force && resultReadAlreadySettledOrInFlight(current)) return current as ResultReadEntry;
  const started = beginResultRead(useAppStore.getState().resultReads, identity);
  useAppStore.setState({ resultReads: started.store });
  const verification = verifyResultPayload(identity.runId, await api.getRun(identity.runId));
  useAppStore.setState((state) => ({
    resultReads: finishResultRead(state.resultReads, identity, started.attempt, verification),
  }));
  // U5 任务 2.2/2.5：读取结论一落地就**立刻**尝试按修订收尾——自动核实、显式只读重试、
  // 面板收起后的轮询都走这一处，组件挂不挂载与它无关（收尾不留在 `.then()` 里）。
  closeDraftClosureFor(identity);
  // 守卫丢弃本次结论时，交回界面上真正在场的那一条（调用方据此呈现，绝不拿废结论去导航）
  return resultReadOf(useAppStore.getState().resultReads, identity) as ResultReadEntry;
}

/**
 * U7 2.3：按来源引用恢复阅读位置（创建页与比较页的"返回来源"共用——不抄第二份）。
 *
 * 该 run 本来就选中 ⇒ 用既有阅读动作当场对齐（页签/调用/文件定位）；
 * 换运行 ⇒ 先把位置写成该 run 的会话阅读状态，再走 `selectRun`——它自带
 * "按详情校验 + 失效回退"，这里不重复判有效性（判了也不认）。
 */
async function restoreReadingLocation(
  location: Pick<CreateReturnLocation, "runId" | "tab" | "spanId" | "file">,
): Promise<void> {
  const { runId } = location;
  // 无运行可恢复（来源视图不承载单运行位置）⇒ 视图已恢复，无事可做
  if (runId === null) return;
  if (useAppStore.getState().selectedRunId === runId) {
    // 该 run 本来就选中：没有"恢复"这一步可借，直接用既有的阅读动作当场对齐
    if (
      location.tab !== null &&
      readingStateOf(useAppStore.getState().readingByRun, runId).tab !== location.tab
    ) {
      useAppStore.getState().setReadingTab(runId, location.tab);
    }
    const liveSpan = liveSpanOfLocation(
      location,
      (useAppStore.getState().detail?.spans ?? []).map((span) => span.id),
    );
    if (liveSpan !== null && useAppStore.getState().selectedSpanId !== liveSpan) {
      useAppStore.getState().selectSpan(liveSpan);
    }
    const filePatch = filePatchOfLocation(location);
    const liveFile = fileReadingOf(readingStateOf(useAppStore.getState().readingByRun, runId));
    if (
      filePatch !== null &&
      (liveFile.checkpoint !== filePatch.checkpoint || liveFile.path !== filePatch.path)
    ) {
      useAppStore.getState().setFileReading(runId, filePatch);
    }
    return;
  }
  // 换运行：先把位置写成该 run 的会话阅读状态，再走 `selectRun`（判据同上）
  const readingPatch = readingPatchOfLocation(location);
  if (Object.keys(readingPatch).length > 0) {
    useAppStore.setState((current) => ({
      readingByRun: patchReadingState(current.readingByRun, runId, readingPatch),
    }));
  }
  const filePatch = filePatchOfLocation(location);
  if (filePatch !== null) {
    useAppStore.setState((current) => ({
      readingByRun: patchFileReading(current.readingByRun, runId, filePatch),
    }));
  }
  await useAppStore.getState().selectRun(runId);
}

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
  const state = useAppStore.getState();
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
  useAppStore.setState((current) => ({
    drafts: applied.repo,
    draftSubmissions: submissionLib.releaseClosure(current.draftSubmissions, identity),
    // 创建入口：整份表单被清 ⇒ 这次提交对应的目录引用同步失效（不继承给下一份草稿）
    ...(applied.cleaned && closure.channel === "create" ? { createSourceRef: null } : {}),
  }));
}

/**
 * U5 任务 3.4：阅读现场变了 ⇒ **推进代次**（design D6 的撤销面）。
 *
 * 只挂在"用户真的换了在看的东西或进出覆盖模态"的既有动作上（`selectRun` / 换页签 / 选调用 /
 * 换视图 / 开设置 / 开或关创建页 / 草稿定位）。刻意**不**挂在 `resetFork` / `resetCreateRun`
 * 这类展示态复位上：组件卸载与收起不该替用户决定"你不要这次结果"（同一纪律见 design D5
 * "组件卸载或展示状态复位 SHALL NOT 解除冻结"）。
 * 代次只增不减 ⇒「离开再返回不恢复旧自动导航」是自然结论（返回时又推进了一次）。
 */
function noteReadingChanged(): void {
  useAppStore.setState((state) => ({ navGeneration: state.navGeneration + 1 }));
  // U5 任务 4.4：离开现场同样撤销待用的执行确认（切运行 / 换页签 / 换调用 / 换视图 /
  // 进创建页 —— 之前核对的目标已经不是现在要提交的目标）
  clearExecutionConfirmations();
}

/**
 * 撤销全部待用的执行确认（U5 任务 4.4，design D2「目标、修订、设置或流程代次变化 SHALL
 * 使旧检查与许可失效」里"离开现场"那一半）。
 *
 * 修订 / 设置 / 检查代次的变化由**现算比对**兜住，这里清的是比对看不出来的那种变化：
 * 用户已经不在当初核对的那个现场了。没有确认时不改引用，避免无谓重渲染。
 */
function clearExecutionConfirmations(): void {
  useAppStore.setState((state) =>
    Object.keys(state.confirmations.byTargetKey).length === 0
      ? {}
      : { confirmations: emptyConfirmationStore() },
  );
}

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
function revokeSourceBoundPermissions(): void {
  useAppStore.setState((state) => {
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
  const state = useAppStore.getState();
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
  useAppStore.setState((current) => ({
    navIntents: releaseNavigationIntent(current.navIntents, record.operationId),
  }));
  if (decision.kind !== "navigate") return;
  // 走既有的选择动作（恢复该 run 自己的阅读状态），不在这里另写一份落地逻辑。
  // ⚠️ 同 ID 时 `selectRun` 自己短路 ⇒ 自动导航既不改页签/滚动，也不推进代次。
  await useAppStore.getState().selectRun(decision.runId);
}

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
async function consumeSettledOperations(
  previous: OperationSession,
  trigger: NavigationTrigger,
): Promise<void> {
  const fresh = newlySettledOperations(previous, useAppStore.getState().operations);
  if (fresh.length > 0) {
    const state = useAppStore.getState();
    for (const record of fresh) {
      state.settleDraftByOperation({ epoch: record.epoch, operationId: record.operationId });
    }
    if (fresh.some((record) => record.runIds.length > 0)) await state.loadRuns();
    for (const record of fresh) {
      for (const runId of record.runIds) {
        await readRunResult({ epoch: record.epoch, operationId: record.operationId, runId }, false);
      }
    }
    // U5 任务 3.4：核实全部落地**之后**才谈导航（design D4：核实与导航分开两个动作）
    for (const record of fresh) {
      await attemptResultNavigation(record, trigger);
    }
  }
  // 无论本轮有没有新终态，都在场的关联补一次收尾：结果早于通信恢复读到的情形也要有出路
  closeRemainingClosures();
}

/**
 * 补一轮"遗留关联"的收尾（U5 任务 2.3）。
 *
 * 只处理本轮新终态会漏掉两类事实：通信恢复后旧操作的结果早已读到、以及迟到响应改变了
 * 另一条身份的结论。这里对**在场的每条关联**再走一次同一判据（四道闸 + 修订 CAS 都不变），
 * 所以重复调用只可能"已经清过 ⇒ 什么都不做"，不会删错。
 */
function closeRemainingClosures(): void {
  const closures = useAppStore.getState().draftSubmissions.closures;
  for (const closure of Object.values(closures)) {
    closeDraftClosureFor({ epoch: closure.epoch, operationId: closure.operationId });
  }
}

/**
 * 代理变化订阅的解绑句柄与状态读取静默等待者（refactor-renderer 4.3）：
 * 订阅句柄、等待队列与"先结算、后唤醒"顺序整体迁 `store/runtime/proxy-coordination.ts`
 * （唯一所有者，见文件尾组合）；这里的两个薄包装让既有调用点逐字保持。
 */

/**
 * `createReturnFactsOf` 的**按引用缓存**已迁 `store/runtime/create-return-facts-cache.ts`
 * （refactor-renderer 4.4，唯一所有者，见文件尾组合）；action 只交输入引用与判据回调。
 */

/** 已静默则立即 resolve；否则排在 `notifyProxyStatusSettled` 队列里。 */
function settledProxyStatusRead(): Promise<void> {
  return proxyCoordination.settledProxyStatusRead();
}

function notifyProxyStatusSettled(): void {
  proxyCoordination.notifyProxyStatusSettled();
}

// 详情读取代次（5.1）：唯一持有者住在 slices/reading 的工厂；这里按 store 实例创建一次，
// runs 分片经注入访问（分片之间无运行时互相导入，design D2）。
const detailReadAttempts = createDetailReadAttempts();

// 派生缓存 runtime 组合（4.4/5.3）：`createReturnFactsOf` 按引用缓存的唯一所有者住在
// `store/runtime/create-return-facts-cache.ts`，这里按 store 实例组合一次（create 回调
// 需要把它注入 navigation 分片 ⇒ 必须先于 create 初始化；模块加载不预热缓存）。
const createReturnFactsRuntime = createCreateReturnFactsCache();

export const useAppStore = create<AppState>((set, get) => ({
  // --- 5.1 分片组合：runs/reading（实现迁 slices/；跨域协调者显式注入，design D2）---
  ...createRunsSlice({
    set,
    get,
    noteReadingChanged,
    revokeSourceBoundPermissions,
    describeZodError,
    detailReadAttempts,
  }),
  ...createReadingSlice({ set, get, noteReadingChanged }),
  // 5.2：drafts 分片（草稿仓库/提交关联/执行确认；discardClosureTarget 随域迁入）
  ...createDraftsSlice({ set, get }),
  // 5.3：compare/navigation 分片（域内协调者随域迁入；noteReadingChanged/
  // restoreReadingLocation/describeZodError/createReturnFactsRuntime 注入）
  ...createCompareSlice({ set, get, noteReadingChanged, restoreReadingLocation }),
  ...createNavigationSlice({
    set,
    get,
    noteReadingChanged,
    restoreReadingLocation,
    createReturnFactsRuntime,
    describeZodError,
  }),

  // R2.1 任务 5.3：导出反馈的会话状态（离开文件页仍存活；重载后为空 = 结果未知）
  workspaceExports: {},
  workspaceExportGenerations: {},
  operations: initialSession(),
  // U5 任务 1.2：按可信身份读取的结果（会话内，与阅读状态和草稿都分开）
  resultReads: emptyResultReadStore(),
  // U5 任务 3.4：阅读代次 + 各提交的导航意图（同为会话内，不进任何持久化）
  navGeneration: 0,
  navIntents: emptyNavigationIntents(),
  // U5 任务 3.6：已看过的结果通知键（通知本身由 deriveResultNotices 现算）
  seenNoticeKeys: {},
  proxyFactCursor: initialProxyFactCursor,

  forking: "idle",
  forkError: null,
  forkErrorCode: null,
  creatingRun: "idle",
  createRunError: null,
  createRunErrorCode: null,
  modelAbInFlight: false,
  modelAbError: null,
  modelAbErrorCode: null,
  settings: null,
  proxy: null,
  recordingDraft: null,
  recordingApply: null,
  recordingApplyError: null,
  recordingStatusReadFailed: false,
  proxyReadGeneration: 0,
  proxyStatusRead: initialProxyStatusReadState,
  settingsChangeGeneration: 0,
  settingsSection: null,

  /**
   * 订阅 main 的代理变化通知（design D1，tasks 1.3）。**幂等**。
   *
   * 三条纪律：
   * - **零主动登记**：这条订阅不碰 `operations:status`、不占执行槽、不发任何请求
   *   （delta「通知只包含受控元信息」的 renderer 半边：证明没有自动请求/自动重发）；
   * - **先订阅后首读**：调用方必须在本方法之后才 `loadProxyStatus`，
   *   否则订阅与首读之间落盘的记录两边都看不到；
   * - **载荷过 schema 才采纳**：非法载荷整条丢弃（不按"看起来像"的部分字段处理），
   *   否则一个坏载荷能把 hasKey 之类的门禁事实带歪。
   */
  ensureProxyChangeSubscription() {
    proxyCoordination.ensureSubscription();
  },

  releaseProxyChangeSubscription() {
    proxyCoordination.releaseSubscription();
  },

  /**
   * 只读核对代理事实版本（失焦/激活补读，design D1）。
   *
   * 失焦期间可能错过任意多条通知；重新激活时读一次状态，
   * 只有 `recordsRevision` 确实落后才补刷列表——否则每次点回窗口都白读全量 traces。
   * **只读**：不启动监听、不调上游、不产生模型请求。
   *
   * ⚠️ 这里**必须等状态读取静默**（tasks 2.1）：`loadProxyStatus` 在飞时会把本次意图
   * 合并成尾随并**立即返回**，此时游标一个字都没动。若不等待就拿游标做判据，
   * "没读到" 又会被误判成"没有变化"，失焦期间漏掉的落盘永远补不上。
   */
  async reconcileProxyFacts() {
    const before = get().proxyFactCursor;
    await get().loadProxyStatus();
    await settledProxyStatusRead();
    const readOk = get().proxy !== null;
    const after = get().proxyFactCursor;
    // 读取失败/载荷非法时 loadProxyStatus 把 proxy 置 null 且**游标不前进**
    // （见上面的 `loadProxyStatus`）。⚠️ 这时**不能**直接把 `after` 当"已核实版本"：
    // 游标没动 ⇒ epoch 仍与 `before` 相同 ⇒ `shouldReconcileOnActivate` 会走
    // "无落后"分支返回 false，正好把"这次什么都没读到"误判成"没有变化"，
    // 于是失焦期间漏掉的落盘永远补不上。故此处把 epoch 置 null 显式表达
    // "本次未取得任何版本事实"，由判据一律要求补刷。
    const observed: ProxyFactCursor = readOk ? after : { ...after, epoch: null };
    if (shouldReconcileOnActivate(before, observed).reloadRuns) await get().loadRuns();
  },

  /**
   * 门禁事实的只读核对（tasks 2.1）。
   *
   * 与 `reconcileProxyFacts` 刻意分开：那个判"要不要补刷列表"，这个只刷新门禁事实。
   * 分开的理由是**代价不对称**——打开 messages 编辑器时补刷一次全量 traces 是白读，
   * 而窗口激活时漏掉一次落盘补读是事实缺失（delta 两条场景各自点名）。
   */
  async reconcileProxyGate() {
    await get().loadProxyStatus();
    await settledProxyStatusRead();
  },

  async refreshOperationStatus() {
    // 先记代次再发请求：期间若有新握手，本次响应整份丢弃（迟到响应不得覆盖新状态）
    const previous = get().operations;
    const issuing = beginHandshake(previous);
    set({ operations: issuing });
    let envelope: Awaited<ReturnType<typeof api.operationsStatus>>;
    try {
      envelope = await api.operationsStatus();
    } catch {
      // 通道失联 ⇒ 未知：保留既有事实与锁，等下一次有效 status 才清
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    // 快照不合契约（含不自洽的槽引用）就当未知，绝不部分采纳所谓成功字段
    const parsed = envelope.ok ? OperationStatusResultSchema.safeParse(envelope.data) : null;
    if (parsed === null || !parsed.success) {
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    const applied = applyStatus(get().operations, parsed.data, issuing.generation);
    set({ operations: applied.session });
    // U5 任务 1.4：只有**被采纳的**快照才驱动终态消费（失联/非法/迟到都不动任何收尾）
    if (applied.applied) await consumeSettledOperations(previous, "status");
    return get().operations;
  },

  async ensureOperationStatusPolling() {
    // 挂载/重载入口：没握过手先握手一次，再按"当前有没有在跑的操作"决定要不要轮询。
    // 已有定时器在排 ⇒ 不叠加（单路守卫在 `lib/operation-polling.ts`）。
    const session =
      get().operations.epoch === null ? await get().refreshOperationStatus() : get().operations;
    rescheduleStatusPoll();
    return session;
  },

  stopOperationStatusPolling() {
    stopOperationStatusPolling();
  },

  async reconcileOperation(operationId) {
    const epoch = get().operations.epoch;
    if (epoch === null) return get().operations;
    const generation = captureGeneration(get().operations);
    let envelope: Awaited<ReturnType<typeof api.operationsReconcile>>;
    try {
      envelope = await api.operationsReconcile({ epoch, operationId });
    } catch {
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    const parsed = envelope.ok ? ReconcileResultSchema.safeParse(envelope.data) : null;
    if (parsed === null || !parsed.success) {
      set({ operations: markUnknown(get().operations) });
      return get().operations;
    }
    const previous = get().operations;
    const applied = applyReconcile(previous, parsed.data, generation);
    set({ operations: applied.session });
    /**
     * U4 任务 6.5 的接线在 U5 任务 1.4 里并入统一落点：spec 把「核对到 settled/notAccepted」
     * 列为**唯一**能把待定关联解冻的合法入口（响应丢失时不自动重发、只能重新核对），
     * 而解冻、单次列表刷新与按 ID 核实必须走同一条路——所以这里不再单独调
     * `settleDraftByOperation`，交给 `consumeSettledOperations`（只处理本轮新进终态的记录）。
     * U5 任务 3.4：显式核对到达的终态**只通知**——导航意图当场作废，不跳到结果概览。
     */
    if (applied.applied) await consumeSettledOperations(previous, "reconcile");
    return get().operations;
  },

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

  async forkAt(parentRunId, atSpanId, value, execution, submission) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await submitActive(
      api.forkRun,
      {
        parentRunId,
        atSpanId,
        edit: { field: "result", value },
        // 只在隔离父本时带上 execution：普通父本请求里不出现该键（语义清爽，且便于断言）
        ...(execution === undefined ? {} : { execution }),
      },
      submission,
    );
    // U3 任务 3.4：已明确返回（成功或业务拒绝）⇒ 收尾本次提交关联、解除冻结；
    // **任何响应都不删草稿**（design D5）。通道抛错不进这里，冻结保留（状态未知）。
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.2：ok 只结束"这次请求在飞"的本地标记。旧实现在这里 `loadRuns()` +
    // `selectRun(信封里的 id)`——把响应当成了结局（成功信封 + 运行 error 时照样跳过去）。
    // 列表刷新、按可信 ID 核实与是否导航，与创建同一条路：全部归终态消费点与导航意图。
    set({ forking: "idle" });
    return true;
  },

  resetFork() {
    set({ forking: "idle", forkError: null, forkErrorCode: null });
  },

  async loadForkCapability(request) {
    const envelope = await api.forkCapability(request);
    if (!envelope.ok) {
      return { ok: false, code: envelope.error.code, message: envelope.error.message };
    }
    // 跨进程数据不可信：确认区会把这些数字原样展示给用户，必须先校验形状
    const parsed = ForkCapabilityResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "CAPABILITY_SCHEMA_INVALID",
        message: `续跑能力预检结果结构校验失败：${describeZodError(parsed.error)}`,
      };
    }
    return { ok: true, data: parsed.data };
  },

  async inspectWorkspace(request) {
    const envelope = await api.inspectWorkspace(request);
    if (!envelope.ok) {
      return { ok: false, code: envelope.error.code, message: envelope.error.message };
    }
    // 跨进程数据不可信：清单与数字会原样展示给用户，先校验形状
    const parsed = WorkspaceInspectResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "INSPECT_SCHEMA_INVALID",
        message: `文件清单结构校验失败：${describeZodError(parsed.error)}`,
      };
    }
    return { ok: true, data: parsed.data };
  },

  async readWorkspaceFile(request) {
    const envelope = await api.readWorkspaceFile(request);
    if (!envelope.ok) {
      return { ok: false, code: envelope.error.code, message: envelope.error.message };
    }
    const parsed = WorkspaceReadFileResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "READ_FILE_SCHEMA_INVALID",
        message: `文件内容结构校验失败：${describeZodError(parsed.error)}`,
      };
    }
    return { ok: true, data: parsed.data };
  },

  async exportCheckpoint(request) {
    const key = workspaceExportKey(request.runId, request.stepSpanId ?? null);
    // 请求代次：同 key 的每次提交都递增——旧响应（A→B→A、连续重试）回来时
    // 代次对不上就整包丢弃，旧成功/失败/收尾都不会覆盖新提交的状态。
    const generation = (get().workspaceExportGenerations[key] ?? 0) + 1;
    set((state) => ({
      workspaceExportGenerations: { ...state.workspaceExportGenerations, [key]: generation },
      workspaceExports: {
        ...state.workspaceExports,
        [key]: {
          kind: "in-flight",
          runId: request.runId,
          stepSpanId: request.stepSpanId ?? null,
          generation,
        },
      },
    }));

    // 切页不中止：没有取消通道，await 期间导航离开不影响这次调用；响应仍按 key 落库
    const envelope = await api.exportCheckpoint(request);
    // 跨进程数据不可信：信封失败与 schema 不合法都折成可展示的 failed（受控码）
    let outcome: WorkspaceExportOutcome;
    if (!envelope.ok) {
      outcome = {
        status: "failed",
        code: envelope.error.code,
        reason: envelope.error.message,
        retained: [],
      };
    } else {
      const parsed = WorkspaceExportOutcomeSchema.safeParse(envelope.data);
      if (!parsed.success) {
        outcome = {
          status: "failed",
          code: "EXPORT_SCHEMA_INVALID",
          reason: `导出结果结构校验失败：${describeZodError(parsed.error)}`,
          retained: [],
        };
      } else {
        outcome = parsed.data;
      }
    }

    // 代次守卫：不是最新一代提交 ⇒ 一个字节都不写，反馈已归新提交所有
    if (get().workspaceExportGenerations[key] !== generation) return null;
    const identity = {
      runId: request.runId,
      stepSpanId: request.stepSpanId ?? null,
      generation,
    };
    set((state) => ({
      workspaceExports: {
        ...state.workspaceExports,
        [key]: feedbackFromOutcome(identity, outcome),
      },
    }));
    return outcome;
  },

  async createRun(request, submission) {
    set({ creatingRun: "in_progress", createRunError: null, createRunErrorCode: null });
    const envelope = await submitActive(api.createRun, request, submission);
    // U3 任务 3.5：已明确返回（成功或业务拒绝）⇒ 收尾本次提交关联、解除整份冻结；
    // **任何响应都不删草稿**（design D5）。通道抛错不进这里，冻结保留（状态未知）。
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      // 请求事实单独留一行：错误信封说明"这次提交被怎样对待"，不替代运行结局。
      // 失败运行若要可见走的是终态消费（main 已把 runId 挂到该操作上），不在这里刷列表。
      set({
        creatingRun: "error",
        createRunError: envelope.error.message,
        createRunErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.1：ok 只结束"这次请求在飞"的本地标记；没有"success"，也没有导航。
    set({ creatingRun: "idle" });
    return true;
  },

  resetCreateRun() {
    set({ creatingRun: "idle", createRunError: null, createRunErrorCode: null });
  },

  async chooseSource() {
    const envelope = await api.chooseSource();
    if (!envelope.ok) {
      set({ error: `选择源目录失败：${envelope.error.message}` });
      return null;
    }
    // 跨进程数据不可信：核验形状后再交给对话框（"取消"与"失败"必须可分辨）
    const parsed = ChooseSourceResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ error: `目录选择结果结构校验失败：${describeZodError(parsed.error)}` });
      return null;
    }
    return parsed.data;
  },

  async promptFork(parentRunId, edit, submission) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    const envelope = await submitActive(api.promptFork, { parentRunId, edit }, submission);
    // U3 任务 3.4：已明确返回即收尾本次提交关联（草稿保留，见 design D5）
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.2：与 forkAt 同形——响应不决定结局，也不产生导航（失败同样不产生伪 run：
    // 那条 run 是否在列表里、结局如何，只看登记的可信 ID 与它自己的终止事件）。
    set({ forking: "idle" });
    return true;
  },

  async modelAb(parentRunId, arms, dryRun, submission) {
    set({ modelAbInFlight: true, modelAbError: null, modelAbErrorCode: null });
    // 两条分支彻底分开：预览走只读通道（不占主动槽、不需要执行身份、不登记关联），
    // 真实执行走主动通道（整批一个槽，main 判重先于任何副作用）
    type AbResponse = ExecutedResponse<ModelAbResult> | Envelope<ModelAbResult>;
    let envelope: AbResponse;
    if (dryRun === true) {
      envelope = await api.modelAbPlan({ parentRunId, arms, dryRun: true });
    } else {
      const executed = await submitActive(api.modelAb, { parentRunId, arms }, submission);
      // U3 任务 3.5 + U4 任务 4.2：真实执行的返回即按**身份**收尾整批关联
      // （含"部分臂失败"——那仍是明确返回）；草稿与批次一律保留。
      if (submission !== undefined) get().finishDraftSubmission(submission, executed);
      envelope = executed;
    }
    if (!envelope.ok) {
      set({
        modelAbInFlight: false,
        modelAbError: envelope.error.message,
        modelAbErrorCode: envelope.error.code,
      });
      return null;
    }
    set({ modelAbInFlight: false });
    if (dryRun) return envelope.data;
    // U5 任务 3.3：真实执行也不在入口刷列表——各臂的新 run 由终态消费按**登记的 runIds**
    // 刷一次、逐条核实；多臂从不自动聚焦（旧实现连 `selectRun` 都没有，只多刷了一次列表）。
    // 返回的 `data`（信封 ids / 计划）只是请求事实，不是"哪条臂成功"的结论（design D4）。
    return envelope.data;
  },

  resetModelAb() {
    set({ modelAbInFlight: false, modelAbError: null, modelAbErrorCode: null });
  },

  async loadSettings() {
    const envelope = await api.getSettings();
    if (!envelope.ok) {
      set({ settings: null, error: `读取运行配置失败：${envelope.error.message}` });
      return false;
    }
    const parsed = SettingsStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ settings: null, error: `运行配置数据结构校验失败：${describeZodError(parsed.error)}` });
      return false;
    }
    set({ settings: parsed.data });
    return true;
  },

  async saveSettings(input) {
    const envelope = await api.saveSettings(input);
    if (!envelope.ok) {
      set({ error: `保存运行配置失败：${envelope.error.message}` });
      return "save-failed";
    }
    // U5 任务 5.4：保存与回读是**两个结论**——回读失败不否定"已保存"，
    // 但也绝不把旧摘要当新配置事实（loadSettings 失败路径已把 settings 置 null）。
    // U8 任务 3.7：两种成功结局都推进已核实配置变化代次（含仅轮换 key 的保存；
    // 回读失败=已保存但状态未知，同样撤销实验旧计划）；保存失败不推进。
    const outcome = (await get().loadSettings()) ? "saved" : "reread-failed";
    if (outcome === "saved" || outcome === "reread-failed") {
      set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
    }
    return outcome;
  },

  async clearSettings() {
    const envelope = await api.clearSettings();
    if (!envelope.ok) {
      set({ error: `清除运行配置失败：${envelope.error.message}` });
      return false;
    }
    set({ settings: null });
    // U8 任务 3.7：已核实清除推进配置变化代次（实验旧计划随之作废）
    set({ settingsChangeGeneration: get().settingsChangeGeneration + 1 });
    return true;
  },

  /**
   * 只读读一次代理状态（tasks 2.1：**合并 + 代次守卫 + 快照新旧守卫**）。
   *
   * 三个触发源会叠出并发读取（通知 / messages 打开的核对 / 窗口激活补读），
   * 两条守卫各自挡一种"旧事实覆盖新事实"：
   * - **合并**：在飞时不并发发射，只登记尾随，结束后补发恰好一次；
   * - **快照新旧**：读回的载荷可能比已采纳的事实更旧（请求在途期间又发生了一次变更），
   *   同 epoch 且任一版本维度落后 ⇒ 整份丢弃，一个字节都不写。
   *
   * ⚠️ **为什么没有第三道「代次守卫」**（变异验证的结论，别照着旧注释再加回去）：
   * 合并已经保证同时至多一个读取在飞，因此"响应对不上自己那次请求"在这条链路上
   * **不可达**。曾加过一道 `isLatestStatusRead` 断言，变异测试（改成 `if (false)`）
   * 显示 14 条 store 用例全绿——它从未真正拒绝过任何响应。留着它等于挂一个永不
   * 触发的"保险"，读代码的人会以为并发防护靠它。故移除；真正的并发防线是合并，
   * 真正的乱序防线是快照新旧守卫（变异后 3 条用例变红，见 proxy-status-read.test.ts）。
   *
   * ⚠️ 失败时游标**不前进**：状态未知时不能断言"版本没变"——否则失焦期间漏掉的落盘
   * 会被这次失败读取"确认"成没有变化（design D1）。
   */
  async loadProxyStatus() {
    const decision = beginStatusRead(get().proxyStatusRead);
    set({ proxyStatusRead: decision.state });
    if (decision.action === "deferred") {
      // 刷新意图已受理：不发射、不返回事实。尾随补发由在飞那次收尾时完成。
      return;
    }
    try {
      // ⚠️ **通道本身抛错也必须被吞进失败分支**（tasks 2.1 实施期坐实）：本方法被
      // `openMessagesWorkspace` / `returnToAuxSource` 以 `void` 方式发起（fire-and-forget），
      // 一旦这里把异常抛出去就变成**未处理拒绝**——既没有可重试入口，也不会有人看见。
      // 实测：`aux-workspace-store.test.ts` 的 api 桩没有 proxyStatus，8 处未处理错误
      // 全部来自这一条路径。读通道失败与"读到一个失败信封"是同一件事：状态未知。
      let envelope: Awaited<ReturnType<typeof api.proxyStatus>>;
      try {
        envelope = await api.proxyStatus();
      } catch (e) {
        envelope = {
          ok: false as const,
          error: { code: "PROXY_STATUS_UNAVAILABLE", message: (e as Error).message },
        };
      }
      // U8 任务 2.6：每次真正发射的读取推进状态代次（守卫锚点；读取本身零写通道）
      set({ proxyReadGeneration: get().proxyReadGeneration + 1 });
      if (!envelope.ok) {
        set({
          proxy: null,
          error: `读取代理状态失败：${envelope.error.message}`,
          // U8 任务 2.5：回读失败如实呈现「状态待读取」，允许只读重试（不重新 toggle）
          recordingStatusReadFailed: true,
        });
        // ⚠️ 游标**不前进**（理由见上方注释）
        // 草稿在场 ⇒ baseline 撤到 null（没有可核实的当前应用值；输入原样保留）
        const draft = get().recordingDraft;
        if (draft !== null) set({ recordingDraft: applyRecordingBaseline(draft, null) });
        return;
      }
      const parsed = ProxyStateSchema.safeParse(envelope.data);
      if (!parsed.success) {
        set({ proxy: null, error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
        return;
      }
      // 规则 3（快照新旧）：载荷比已采纳事实更旧 ⇒ 整份丢弃。
      // ⚠️ 这一条**不能**由 cursorFromStatus 兜住：它只保证游标数字不回退，
      // 而 `proxy` 状态对象仍会被这份旧载荷写下去（hasKey 由 true 按回 false）。
      const ruling = acceptProxySnapshot(get().proxyFactCursor, parsed.data);
      if (!ruling.accept) return;
      set({ proxy: parsed.data, recordingStatusReadFailed: false, proxyFactCursor: ruling.cursor });
      // U8 任务 2.1：草稿在场 ⇒ baseline 跟随最近可核实事实（输入原样，dirty 随之重算）
      const draft = get().recordingDraft;
      if (draft !== null)
        set({ recordingDraft: applyRecordingBaseline(draft, recordingBaselineOf(parsed.data)) });
    } finally {
      const settled = settleStatusRead(get().proxyStatusRead);
      set({ proxyStatusRead: settled.state });
      // 尾随补发走本方法自身（由它登记在途数）——旁路直发 IPC 会让补发那次
      // 无人递减计数，此后所有读取都被"合并"成尾随而永不发射。
      //
      // ⚠️ 这里**不写 `return`**：`finally` 里的 return 会吞掉 try 块的控制流，
      // 且 Biome 直接把它标成错误（`noUnsafeFinally`）。改成 if/else 让两条路径互斥。
      if (settled.shouldRefire) {
        await get().loadProxyStatus();
      } else {
        // 只在**不再补发**时唤醒等待者：补发会在上面的 await 里重新置起在途计数，
        // 先唤醒会让"等静默"的调用方在补发还在飞时就拿到判断依据。
        notifyProxyStatusSettled();
      }
    }
  },

  async toggleProxy(input) {
    set({ error: null });
    const envelope = await api.proxyToggle(input);
    if (!envelope.ok) {
      set({ error: `代理操作失败：${envelope.error.message}` });
      return null;
    }
    const parsed = ProxyStateSchema.safeParse(envelope.data);
    if (!parsed.success) {
      set({ error: `代理状态数据结构校验失败：${describeZodError(parsed.error)}` });
      return null;
    }
    set({ proxy: parsed.data });
    return parsed.data;
  },

  writeRecordingDraftFields(patch) {
    const draft = get().recordingDraft;
    if (draft === null) return;
    useAppStore.setState({ recordingDraft: writeRecordingDraft(draft, patch) });
  },

  discardRecordingDraftConfirmed(expectedRevision) {
    const draft = get().recordingDraft;
    if (draft === null) return false;
    const result = discardRecordingDraftState(draft, expectedRevision);
    if (!result.discarded) return false;
    set({ recordingDraft: result.draft });
    return true;
  },

  async applyRecordingDraft() {
    const draft = get().recordingDraft;
    if (draft === null) return "no-draft";
    if (get().recordingApply !== null) return "busy";
    const request = recordingApplyRequest(draft);
    // 纵深防御：组件判据同源，但这里再拦一次——非法字段连在飞标记都不该出现
    if (!request.ok) return "invalid";
    const submittedRevision = draft.revision;
    set({ recordingApply: submittedRevision, recordingApplyError: null });
    const envelope = await api.proxyToggle(request.input);
    // toggle 非事务（design D2）：无论启动成败都回读真实状态——成功确认「已保存意图」，
    // 回读给出「监听事实」；回读失败 ⇒ 状态待读取，两层诊断分别呈现
    const startOk = envelope.ok;
    const startMessage = envelope.ok ? "" : envelope.error.message;
    await get().loadProxyStatus();
    const current = get();
    // U8 任务 2.6：响应只在「与当前草稿修订匹配」时更新基线——在飞期间的后来输入
    // 不被旧响应覆写；诊断照报（它属于真实发生过的那次应用）
    const stale =
      current.recordingDraft === null || current.recordingDraft.revision !== submittedRevision;
    const patch: {
      recordingApply: number | null;
      recordingApplyError: string | null;
      recordingDraft?: RecordingDraft;
    } = { recordingApply: null, recordingApplyError: startOk ? null : startMessage };
    if (startOk && !stale && current.recordingDraft !== null) {
      patch.recordingDraft = applyRecordingBaseline(current.recordingDraft, {
        enabled: request.input.enabled,
        port: request.input.port,
        upstreamBaseUrl: request.input.upstreamBaseUrl,
      });
    }
    set(patch);
    return startOk ? "applied" : "start-failed";
  },

  setSettingsSection(section) {
    // U5 3.4：进设置 SHALL 撤销自动导航资格（delta「结果导航尊重用户当前阅读意图」）
    if (section !== null) noteReadingChanged();
    // U5 4.4：设置往返本身即撤销待用的执行确认（进出都算——确认时看到的模型/接入
    // 与回来后可能已经不是同一份配置了）
    else clearExecutionConfirmations();
    set({ settingsSection: section });
  },

  async proxyFork(parentRunId, atSpanId, messages, submission) {
    set({ forking: "in_progress", forkError: null, forkErrorCode: null });
    // tasks 2.2b：把**提交这一刻**看到的代理事实随请求带上，供main 在副作用前核对。
    // renderer 的门禁只是 UX：确认到提交之间外部应用随时可能经过代理捕获新 key，
    // 也可能有人改了代理配置——那两种都必须由 main 拒绝，而不是靠这里"应该已经不旧了"。
    // ⚠️ 状态未知（proxy=null）时不编造版本：交0/空串让main 拒绝，这比"猜一个放行"安全。
    const proxy = get().proxy;
    const envelope = await submitActive(
      api.proxyFork,
      {
        parentRunId,
        atSpanId,
        messages,
        expectedKeyCaptureRevision: proxy?.keyCaptureRevision ?? 0,
        expectedUpstreamBaseUrl: proxy?.upstreamBaseUrl ?? "",
        expectedPort: proxy?.port ?? 0,
      },
      submission,
    );
    // U3 任务 3.4：已明确返回即收尾本次提交关联（草稿保留，见 design D5）
    if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
    if (!envelope.ok) {
      set({
        forking: "error",
        forkError: envelope.error.message,
        forkErrorCode: envelope.error.code,
      });
      return false;
    }
    // U5 任务 3.3：messages 重发也不消费响应——旧实现 `forking: "success"` + `loadRuns()` +
    // `selectRun(信封里的 id)`。delta 对这条入口的改判：执行结束 SHALL 刷新列表并按可信身份核实结果，
    // 自动导航仅在本次流程意图仍有效时进行（任务 3.4），所以这里只把请求标记复位。
    set({ forking: "idle" });
    return true;
  },
}));

// ---------------------------------------------------------------------------
// 轮询 runtime 组合（refactor-renderer 4.2）：单路有界轮询的唯一所有者住在
// `store/runtime/operation-polling.ts`，这里按 store 实例组合一次（design D3）。
// store 依赖用惰性回调注入（调用时才 `getState()`），与搬迁前逐字等价；
// 模块加载不启动任何资源（轮询全部由 action/组件调用点惰性触发）。
// ---------------------------------------------------------------------------
const operationPolling = createOperationPollingRuntime({
  getSession: () => useAppStore.getState().operations,
  refreshOperationStatus: () => useAppStore.getState().refreshOperationStatus(),
});

/** 可信响应/握手之后重新计时（计时起点是"响应完成"，慢响应不会堆积） */
function rescheduleStatusPoll(): void {
  operationPolling.rescheduleStatusPoll();
}

/** 停止自动轮询（保留在飞守卫；手动核对不受它限制）——原入口兼容导出，指向同一 runtime 实现 */
export function stopOperationStatusPolling(): void {
  operationPolling.stopOperationStatusPolling();
}

// ---------------------------------------------------------------------------
// 代理协调 runtime 组合（refactor-renderer 4.3）：订阅句柄与静默等待者的唯一
// 所有者住在 `store/runtime/proxy-coordination.ts`，这里按 store 实例组合一次。
// 通知处理体逐字随迁；store 依赖用惰性回调注入（调用时才 `getState()`）。
// ---------------------------------------------------------------------------
const proxyCoordination = createProxyCoordinationRuntime({
  onProxyChanged: (handler) => api.onProxyChanged(handler),
  handleEvent: (payload) => {
    const parsed = ProxyChangeEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const plan = shouldApplyChange(useAppStore.getState().proxyFactCursor, parsed.data);
    // 规则 4：`records` 才刷列表。刷新一律走 loadRuns（自带在途合并 + 尾随补发），
    // **不**旁路 refreshRunsOnce —— 旁路那次请求无人递减在途计数，计数器永久残留。
    if (plan.reloadRuns) void useAppStore.getState().loadRuns();
    if (plan.reloadStatus) void useAppStore.getState().loadProxyStatus();
    // 游标在**发起读取之前**推进：读到的是异步结果，若推进放在后面，
    // 同一 tick 里的第二条通知会因游标未动而被当成新变化，重复触发读取。
    useAppStore.setState({ proxyFactCursor: plan.cursor });
  },
  getProxyStatusRead: () => useAppStore.getState().proxyStatusRead,
});
