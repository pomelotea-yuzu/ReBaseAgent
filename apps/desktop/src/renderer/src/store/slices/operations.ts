// AppState 分片：Operations 域（refactor-renderer 4.1 接口 / 5.4 实现迁入；归属依据 change 的 ownership-map.md）
// 工厂以完整 store 的 set/get 为上下文（design D2：无第二 create、不导入 useAppStore）；
// **唯一提交适配器** submitActive（U4 design D6）随域迁入闭包——所有主动入口共用，
// 组件无从各写一套；跨域协调者 revokeSourceBoundPermissions / consumeSettledOperations
// 由 store.ts 显式注入（results 域 5.5 迁出前的注入点）；轮询 runtime 句柄由 store.ts
// 在 create 前组合后注入（submitActive 的停止/重排计时与挂载入口都要用它）。
import type {
  ChooseSourceResult,
  CreateRunRequest,
  Envelope,
  ForkCapabilityRequest,
  ForkCapabilityResult,
  IsolatedExecutionMode,
  IsolatedPromptCapabilityRequest,
  IsolatedPromptCapabilityResult,
  IsolatedPromptForkRequest,
  ModelAbResult,
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
  IsolatedPromptCapabilityResultSchema,
  WorkspaceExportOutcomeSchema,
  WorkspaceInspectResultSchema,
  WorkspaceReadFileResultSchema,
} from "@shared/ipc";
import type { ExecutedRequest, ExecutedResponse, OperationAck } from "@shared/operations";
import {
  OPERATION_ERROR,
  OperationAckSchema,
  OperationStatusResultSchema,
  ReconcileResultSchema,
} from "@shared/operations";
import { api } from "../../lib/api";
import { describeZodError } from "../../lib/describe-zod-error";
import { isLineageRejectionCode } from "../../lib/detail-completeness";
import type { DraftSubmission } from "../../lib/draft-submission";
import * as submissionLib from "../../lib/draft-submission";
import type { NavigationTrigger } from "../../lib/navigation-intent";
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
} from "../../lib/operation-session";
import {
  decideVerificationConfirmation,
  verificationTargetKey,
} from "../../lib/verification-entry";
import { feedbackFromOutcome, workspaceExportKey } from "../../lib/workspace-export-state";
import type { WorkspaceExportFeedback } from "../../lib/workspace-export-state";
import type { OperationPollingRuntime } from "../runtime/operation-polling";
import type { SliceContext } from "../types";

export interface OperationsState {
  operations: OperationSession;

  /**
   * 分叉类入口的**请求**状态（`runs:fork` / `runs:promptFork` / `proxy:fork` 共用一条写通道）。
   *
   * U5 任务 3.1–3.3：取值里没有"成功"——三条入口在 ok 后都回到 `idle`，
   * 因为响应只证明"这次请求明确返回了"；运行结局另由可信身份核实（`resultReads`）给出。
   */
  forking: "idle" | "in_progress" | "error";
  /** 分叉失败的展示信息（来自信封 error） */
  forkError: string | null;
  /** 分叉失败的错误码（渲染层据此给针对性提示，如未配置） */
  forkErrorCode: string | null;

  /**
   * 新建运行的**请求**状态（runs:create 写通道）。
   *
   * U5 任务 3.1：取值里刻意没有"成功"——响应回来只证明"这次请求明确返回了"，
   * 运行结局另由可信身份核实（`resultReads`）给出。ok 之后回到 idle = 输入面已交出。
   */
  creatingRun: "idle" | "in_progress" | "error";
  /** 新建运行失败的展示信息（来自信封 error） */
  createRunError: string | null;
  /** 新建运行失败的错误码（渲染层据此给针对性提示，如未配置） */
  createRunErrorCode: string | null;

  /** A/B 实验进行中（与 fork 状态分离，两者可并存于不同编辑器） */
  modelAbInFlight: boolean;
  modelAbError: string | null;
  modelAbErrorCode: string | null;

  /** U4：与 main 的操作握手/状态核对唯一入口（轮询、回执后的刷新与手动核对同一条路） */
  refreshOperationStatus: () => Promise<OperationSession>;
  /**
   * U4 任务 4.5：挂载/重载时的"接着核对"入口——必要时先握手一次，然后**只在确实有在跑的
   * 操作时**排一次单路轮询（空闲不排、失联不排）。
   */
  ensureOperationStatusPolling: () => Promise<OperationSession>;
  /** 任务 4.5：停止自动轮询（手动核对不受它限制；也不重放任何业务 payload） */
  stopOperationStatusPolling: () => void;
  /**
   * U4 任务 4.1/4.5：按 `operationId` 核对一次。**只补该操作的事实与当前槽，
   * 不清 `unknown`**（通信是否恢复只能由完整快照握手确认），
   * 也绝不因"查到旧操作已 settled"而解除别的操作的锁。
   */
  reconcileOperation: (operationId: string) => Promise<OperationSession>;

  /**
   * U5 任务 1.2/1.3：result fork（编辑某步 tool_result 从该步重跑）。
   * 与 promptFork/proxyFork/modelAb/createRun 同走唯一提交适配器 `submitActive`。
   *
   * U5 任务 3.2：ok 只结束"这次请求在飞"的本地标记——响应不决定结局，也不产生导航。
   */
  forkAt: (
    parentRunId: string,
    atSpanId: string,
    value: string,
    execution?: IsolatedExecutionMode,
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /** prompt fork：编辑启动上下文（system prompt / 首条 user message）从头重跑 */
  promptFork: (
    parentRunId: string,
    edit: PromptForkRequest["edit"],
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * R2.2 6.3：隔离 prompt 实验的真实提交（runs:promptFork 的 executionMode=isolated 分支）。
   * 请求由 `lib/isolated-prompt-card.ts` 的判据构造，必须带计划指纹、配置修订与本次授权；
   * 与普通 prompt 共用 U4 身份/去重/单槽与 U5 结果收尾。
   */
  promptExperiment: (
    request: IsolatedPromptForkRequest,
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * messages 重发（单请求级分叉，llm-proxy design a）：把编辑后的 messages 随提交事实
   * 重发一次；与 forkAt 同形——响应不决定结局，也不产生导航。
   */
  proxyFork: (
    parentRunId: string,
    atSpanId: string,
    messages: Record<string, unknown>[],
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * 模型 A/B：dryRun = true 走**只读预览通道**（不占槽、不登记、不联网、不写文件，返回计划）；
   * 真实执行只交代请求事实并返回信封里的计划/结果 —— U5 任务 3.3 起不再在入口刷列表，
   * 各臂结局由终态消费按登记的 `runIds`/`arms` 逐条核实（返回的 ids 不是"哪条臂成功"的结论）。
   */
  modelAb: (
    parentRunId: string,
    arms: ModelAbArm[],
    dryRun: boolean,
    /** U3 任务 3.5：真实执行的提交关联（整批）；预览不传——预览不是提交 */
    submission?: DraftSubmission,
  ) => Promise<ModelAbResult | null>;
  /**
   * 新建运行（runs:create）：从头执行一个原生 run（纯对话与隔离文件两态同一入口）。
   * 请求由 `lib/create-run.ts` 的 `resolveCreateRunSubmission` 构造（判据与请求同源），
   * store 只负责透传与**请求**状态机。
   *
   * U5 任务 3.1：这里不再消费响应——旧实现在 ok 后 `loadRuns()` + `selectRun(信封里的 id)`，
   * 失败分支也自己刷一次列表。三者都已移除：
   * - 列表刷新与结果核实归**终态消费唯一落点**（`consumeSettledOperations`：回执 → status →
   *   整批至多一次刷新 → 按登记的可信 `runIds` 串行核实），所以编辑器关不关、
   *   响应先到还是轮询先到都不影响收尾；
   * - 失败运行的可见性同一条路：main 在执行开始时就把 runId 挂到该操作上（`onRunIdentified`），
   *   信封失败不改变登记事实 ⇒ 仍按可信 ID 刷列表、读详情，而不是解析错误文案里的 id；
   * - 是否切到新 run 的概览属**导航意图**（任务 3.4），入口一概不做。
   * 返回值只表示"请求是否被明确接受并返回"（供表单交出输入面），**不是**运行结局。
   */
  createRun: (
    request: CreateRunRequest,
    /** U3 任务 3.5：本次创建的提交关联（整份表单）——执行函数负责收尾 */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /** 打开新的分叉编辑前复位状态 */
  resetFork: () => void;
  /**
   * R2.2 6.1：隔离 prompt 实验的只读能力预检（workspaces:isolatedPromptCapability）。
   * 只读：不占执行槽、不登记 operation、不写 trace、不调模型。
   * 领域拒绝以 ok 信封的 status=unavailable 返回（含非根导航建议 rootId）。
   */
  loadIsolatedPromptCapability: (
    request: IsolatedPromptCapabilityRequest,
  ) => Promise<
    | { readonly ok: true; readonly data: IsolatedPromptCapabilityResult }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  /** 打开新的 A/B 编辑前复位状态 */
  resetModelAb: () => void;
  /** 打开"新建运行"对话框前复位状态 */
  resetCreateRun: () => void;

  /**
   * 隔离续跑的只读预检（确认区的唯一数据源）：不创建运行、不写文件、不请求模型。
   * 返回判别式联合而不是全局状态——确认区是**单个编辑器**的局部状态（与 2.1 的
   * chooseSource 同法），避免"两个编辑器抢同一份错误状态"。
   */
  loadForkCapability: (
    request: ForkCapabilityRequest,
  ) => Promise<
    { ok: true; data: ForkCapabilityResult } | { ok: false; code: string; message: string }
  >;

  /**
   * 隔离**文件检查点**的只读通道（C 1.1/1.2）：
   * - `inspectWorkspace` 取某检查点的清单（省略 stepSpanId = 本 run 初始快照）
   * - `readWorkspaceFile` 读清单内某条逻辑路径的内容
   * 两者都不写任何文件、不调 LLM/工具；失败返回判别式联合而不是全局错误状态，
   * 因为文件视图是**单个面板**的局部状态（与 loadForkCapability 同法）。
   */
  inspectWorkspace: (
    request: WorkspaceInspectRequest,
  ) => Promise<
    { ok: true; data: WorkspaceInspectResult } | { ok: false; code: string; message: string }
  >;
  readWorkspaceFile: (
    request: WorkspaceReadFileRequest,
  ) => Promise<
    { ok: true; data: WorkspaceReadFileResult } | { ok: false; code: string; message: string }
  >;

  /**
   * 原生目录选择（只读辅助通道，B 1.3）：阻塞至用户选完或取消。
   * 返回 main 的结论（取消为 `{canceled:true}`）；通道失败或结构不合法返回 null 并置 error。
   * 本方法**不签发、不保存**任何授权——副本写入必须由对话框本次显式勾选。
   */
  chooseSource: () => Promise<ChooseSourceResult | null>;
  /**
   * R2.1 任务 5.3：按提交 run/step 保存的**导出反馈会话状态**（离开文件页仍存活）。
   * - 键 = `workspaceExportKey(runId, stepSpanId)`，值带提交时代次；
   * - 同 key 旧响应（A→B→A 往返、连续重试）按代次丢弃，旧成功/失败/收尾都**不覆盖**
   *   新对象；不同 key 互不影响；
   * - 切页不中止 main 写入：没有任何取消通道，迟到响应仍按 key 落库，返回可查看；
   * - renderer 重载后本状态为空 = 结果未知——UI 必须如实说明并指引检查目标清单，
   *   不自动重发（本动作也不提供重发入口）。
   * 返回本次 outcome（代次被更新的提交顶掉时返回 null——反馈已不归本次所有）。
   */
  exportCheckpoint: (request: WorkspaceExportRequest) => Promise<WorkspaceExportOutcome | null>;
  /** 导出反馈（按提交 run/step 键控；重载后为空 = 结果未知，不自动重发） */
  workspaceExports: Record<string, WorkspaceExportFeedback>;
  /** 每个 key 最近一次提交的请求代次（旧响应按代次丢弃的判据） */
  workspaceExportGenerations: Record<string, number>;

  /**
   * R3 5.1：环境准备提交（verification:prepare）。与七主动入口同一接受序列
   * （submitActive）；发送前现算确认判定（D02：missing/stale ⇒ 本地拒发零 IPC，
   * 不隐式执行），目标/计划 token 来自 verification 分片的显式核对缓存。
   * 在飞/失败/结局呈现面由 verification 分片承载（begin/end/fail/note 驱动口）。
   */
  submitVerificationPrepare: () => Promise<boolean>;
  /** R3 5.1：固定检查执行提交（verification:run）；确认门与 prepare 同形，另绑命令 */
  submitVerificationRun: () => Promise<boolean>;
}

/** operations 分片工厂上下文：完整 set/get + 跨域协调者/共享 helper 的显式注入 */
export interface OperationsSliceContext extends SliceContext {
  /** results→drafts 协调者（results 分片公开成员，5.5 起注入源 = results 实例）：来源类拒绝 ⇒ 撤销来源绑定许可 */
  revokeSourceBoundPermissions: () => void;
  /** results 域协调者（results 分片公开成员，5.5 起注入源 = results 实例）：有效快照/核对后的终态消费唯一落点 */
  consumeSettledOperations: (
    previous: OperationSession,
    trigger: NavigationTrigger,
  ) => Promise<void>;
  /** 轮询 runtime 句柄（唯一所有者在 store/runtime/operation-polling；store.ts create 前组合） */
  polling: OperationPollingRuntime;
}

export function createOperationsSlice({
  set,
  get,
  revokeSourceBoundPermissions,
  consumeSettledOperations,
  polling,
}: OperationsSliceContext): OperationsState {
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
    /**
     * R3 5.2：无草稿关联的入口也可显式携带**本次新铸**的 operationId——验证面板的
     * 停止/核对都按该身份寻路，必须在请求发出前就定下（等响应里的回执就晚了）。
     * 约束不变：每次提交一个新 ID（调用方逐次铸造，不得复用旧身份）。
     */
    operationIdOverride?: string,
  ): Promise<ExecutedResponse<TResponse>> {
    if (deriveGate(get().operations).blockedBy === "not_handshaked") {
      await get().refreshOperationStatus();
    }
    const blocked = deriveGate(get().operations).blockedBy;
    if (blocked !== null) {
      const { code, message } = LOCAL_BLOCKED[blocked];
      return { ok: false, operation: null, error: { code, message } };
    }
    const epoch = get().operations.epoch as string;
    const identity: PendingSubmission = {
      epoch,
      // 关联里已生成的 operationId 就是本次提交的身份；没有关联（如 dryRun/预览）才另起
      operationId: submission?.operationId ?? operationIdOverride ?? crypto.randomUUID(),
      // U5 任务 5.2：本地提交时刻——等待计时的首选基准（会话内存，不进 IPC 信封）
      submittedAt: Date.now(),
    };
    // 关联的 epoch 在真正发出的这一刻绑定（此前它可能是 null = 还没握上手）
    if (submission !== undefined && submission.epoch !== epoch) {
      set((state) => ({
        draftSubmissions: submissionLib.bindSubmissionEpoch(
          state.draftSubmissions,
          submission,
          epoch,
        ),
      }));
    }
    set((state) => ({
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
      set((state) => ({ operations: markUnknown(state.operations) }));
      // 任务 4.5：失联 ⇒ 自动轮询停下（手动核对仍可用），不靠重试打爆通道
      polling.stopOperationStatusPolling();
      throw error;
    }
    if (!response.ok && response.error.code === OPERATION_ERROR.staleEpoch) {
      // 新 main 会话：旧 epoch 的响应不采纳。旧身份**不销账**——它的结局仍是未知（任务 4.6）
      set((state) => ({ operations: markUnknown(state.operations) }));
      // 任务 4.5：状态未确认 ⇒ 停下自动轮询，等用户/下一次握手来核对
      polling.stopOperationStatusPolling();
      return response;
    }
    // 任务 4.6：会话已经换过（epoch 与发出时不同）⇒ 这条迟到的旧响应不得解冻、不得导航、
    // 也不得把会话状态回退。⚠️ 这里**不标通信未知**：新会话的状态刚由一次有效握手确认过，
    // 未知的是"旧那次提交的结局"（永久未知）——把它标成通道失联会连带锁死新会话。
    if (get().operations.epoch !== identity.epoch) {
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
      set((state) => ({ operations: markUnknown(state.operations) }));
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
      set((state) => ({
        operations: endLocalSubmission(state.operations, identity.operationId),
      }));
      /**
       * U5 任务 1.4：拿到**可信终态回执**就立刻取一次 status——`runIds` 只存在于登记快照里，
       * 回执本身只说明"这条操作结束了"。刷新后由 `consumeSettledOperations` 统一收尾，
       * 于是"响应到达"与"轮询/核对到达"走的是同一条核实路径（spec「所有入口实际使用同一适配器」）。
       */
      await get().refreshOperationStatus();
    }
    // 任务 4.5：计时起点是"这次响应完成"——批次/长请求在飞期间不叠加定时请求
    polling.rescheduleStatusPoll();
    return response;
  }

  return {
    // R2.1 任务 5.3：导出反馈的会话状态（离开文件页仍存活；重载后为空 = 结果未知）
    workspaceExports: {},
    workspaceExportGenerations: {},
    operations: initialSession(),

    forking: "idle",
    forkError: null,
    forkErrorCode: null,
    creatingRun: "idle",
    createRunError: null,
    createRunErrorCode: null,
    modelAbInFlight: false,
    modelAbError: null,
    modelAbErrorCode: null,

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
      polling.rescheduleStatusPoll();
      return session;
    },

    stopOperationStatusPolling() {
      polling.stopOperationStatusPolling();
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

    async loadIsolatedPromptCapability(request) {
      const envelope = await api.isolatedPromptCapability(request);
      if (!envelope.ok) {
        return { ok: false, code: envelope.error.code, message: envelope.error.message };
      }
      // 确认卡会原样展示根/文件/模型/端点/费用未知项 ⇒ 先校验形状
      const parsed = IsolatedPromptCapabilityResultSchema.safeParse(envelope.data);
      if (!parsed.success) {
        return {
          ok: false,
          code: "ISOLATED_PROMPT_CAPABILITY_SCHEMA_INVALID",
          message: `隔离 prompt 能力预检结果结构校验失败：${describeZodError(parsed.error)}`,
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

    async promptExperiment(request, submission) {
      set({ forking: "in_progress", forkError: null, forkErrorCode: null });
      const envelope = await submitActive(api.promptFork, request, submission);
      // 与普通 prompt/result 同一收尾口径：任何明确响应都不删草稿、不按信封 id 导航
      if (submission !== undefined) get().finishDraftSubmission(submission, envelope);
      if (!envelope.ok) {
        set({
          forking: "error",
          forkError: envelope.error.message,
          forkErrorCode: envelope.error.code,
        });
        return false;
      }
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

    /**
     * R3 5.1：环境准备/固定检查执行的两条提交。与七主动入口同一 submitActive 接受序列；
     * R3 特有门在发送前现算（D02）：
     * - 核对缺失（capability 为 null）⇒ 本地拒发（没有可绑定的计划 token，请求形状都不完整）；
     * - 确认判定 missing/stale ⇒ 本地拒发**零 IPC**——旧确认失效后绝不自动提交新计划，
     *   main 侧 plan_stale 是第二道防线，不是唯一防线。
     * 在飞/失败/结局呈现面由 verification 分片承载；`outcomeGeneration` 在门通过后捕获，
     * 迟到失败/结局按代次丢弃（提交期间目标切换/收起 ⇒ 结果不属于当前目标）。
     * 通道抛错（响应是否被 main 接受不可知）⇒ 会话已标 Unknown（submitActive 内），
     * 这里按 UNEXPECTED 呈现并保住 in-flight 复位。
     */
    async submitVerificationPrepare() {
      const v = get();
      if (v.verificationTarget === null || v.verificationCapability === null) {
        v.failVerificationSubmit({
          code: "R3_SUBMIT_NOT_READY",
          message: "核对结果缺失：先完成只读核对（打开面板自动进行），再确认与提交",
        });
        return false;
      }
      const target = v.verificationTarget;
      const capability = v.verificationCapability;
      const decision = decideVerificationConfirmation({
        armed: v.verificationPrepareConfirmation,
        currentPlanToken: capability.planToken,
        currentTargetKey: verificationTargetKey(target),
      });
      if (decision.kind !== "confirmed") {
        v.failVerificationSubmit({
          code: "VERIFICATION_CONFIRMATION_STALE",
          message: decision.reason,
        });
        return false;
      }
      const atGeneration = v.verificationOutcomeGeneration;
      v.beginVerificationSubmit("prepare");
      // 5.2/D05：铸出本次 operationId 并登记为在飞身份——停止/核对按它寻路。
      // 通道抛错**不清除**（请求是否被接受未知 ⇒ 靠该身份 reconcile，D03）。
      const operationId = crypto.randomUUID();
      v.noteVerificationActiveOperation("prepare", operationId);
      let envelope: Awaited<ReturnType<typeof api.verificationPrepare>>;
      try {
        envelope = await submitActive(
          api.verificationPrepare,
          {
            target: { runId: target.runId, checkpoint: target.checkpoint },
            profileId: "node-ts-v1",
            planToken: capability.planToken,
            allowPrepare: true,
          },
          undefined,
          operationId,
        );
      } catch (error) {
        get().endVerificationSubmit();
        get().failVerificationSubmit(
          {
            code: "R3_SUBMIT_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
          atGeneration,
        );
        return false;
      }
      get().endVerificationSubmit();
      get().clearVerificationActiveOperation();
      if (!envelope.ok) {
        get().failVerificationSubmit(
          { code: envelope.error.code, message: envelope.error.message },
          atGeneration,
        );
        return false;
      }
      get().noteVerificationOutcome(
        {
          kind: "prepare",
          preparationId: envelope.data.preparationId,
          imageDigest: envelope.data.imageDigest,
          operationId,
        },
        atGeneration,
      );
      // 准备成功后重读一次核对（只读）：面板的执行条件（已准备环境/工具链）随之就绪
      void get().refreshVerificationCapability();
      return true;
    },

    async submitVerificationRun() {
      const v = get();
      if (v.verificationTarget === null || v.verificationCapability === null) {
        v.failVerificationSubmit({
          code: "R3_SUBMIT_NOT_READY",
          message: "核对结果缺失：先完成只读核对（打开面板自动进行），再确认与提交",
        });
        return false;
      }
      const target = v.verificationTarget;
      const capability = v.verificationCapability;
      const commandId = v.verificationCommand;
      const decision = decideVerificationConfirmation({
        armed: v.verificationRunConfirmation,
        currentPlanToken: capability.planToken,
        currentTargetKey: verificationTargetKey(target),
        currentCommandId: commandId,
      });
      if (decision.kind !== "confirmed") {
        v.failVerificationSubmit({
          code: "VERIFICATION_CONFIRMATION_STALE",
          message: decision.reason,
        });
        return false;
      }
      const atGeneration = v.verificationOutcomeGeneration;
      v.beginVerificationSubmit("run");
      // 5.2/D05：在飞身份（停止/核对寻路）；通道抛错保留（unknown ⇒ reconcile 核对）
      const operationId = crypto.randomUUID();
      v.noteVerificationActiveOperation("run", operationId);
      let envelope: Awaited<ReturnType<typeof api.verificationRun>>;
      try {
        envelope = await submitActive(
          api.verificationRun,
          {
            target: { runId: target.runId, checkpoint: target.checkpoint },
            profileId: "node-ts-v1",
            commandId,
            planToken: capability.planToken,
            allowExecution: true,
          },
          undefined,
          operationId,
        );
      } catch (error) {
        get().endVerificationSubmit();
        get().failVerificationSubmit(
          {
            code: "R3_SUBMIT_CHANNEL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
          atGeneration,
        );
        return false;
      }
      get().endVerificationSubmit();
      get().clearVerificationActiveOperation();
      if (!envelope.ok) {
        get().failVerificationSubmit(
          { code: envelope.error.code, message: envelope.error.message },
          atGeneration,
        );
        return false;
      }
      // ok 信封 = 请求收尾；`outcome` 是领域结局（D04 分层：check_failed 也是明确收尾）
      get().noteVerificationOutcome(
        {
          kind: "run",
          verificationId: envelope.data.verificationId,
          outcome: envelope.data.outcome,
          detail: envelope.data.detail,
          evidenceComplete: envelope.data.evidenceComplete,
          operationId,
        },
        atGeneration,
      );
      return true;
    },
  };
}
