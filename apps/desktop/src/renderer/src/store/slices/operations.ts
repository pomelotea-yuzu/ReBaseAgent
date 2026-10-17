// AppState 分片：Operations 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type {
  ChooseSourceResult,
  CreateRunRequest,
  ForkCapabilityRequest,
  ForkCapabilityResult,
  IsolatedExecutionMode,
  ModelAbResult,
  WorkspaceExportOutcome,
  WorkspaceExportRequest,
  WorkspaceInspectRequest,
  WorkspaceInspectResult,
  WorkspaceReadFileRequest,
  WorkspaceReadFileResult,
} from "../../../../shared/ipc";
import type { ModelAbArm, PromptForkRequest } from "../../../../shared/ipc";
import type { DraftSubmission } from "../../lib/draft-submission";
import type { OperationSession } from "../../lib/operation-session";
import type { WorkspaceExportFeedback } from "../../lib/workspace-export-state";

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

  /** 运行配置状态（不含 apiKey；null = 尚未加载成功） */
  modelAbInFlight: boolean;
  modelAbError: string | null;
  modelAbErrorCode: string | null;
  /** 打开新的分叉编辑前复位状态 */
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
   * U5 任务 1.2：按可信身份读取到的**结果读取项**（design D3）。
   * 键为 `(epoch, operationId, runId)`；只存 renderer 会话内存，
   * 不落盘、不进 URL/日志/操作 IPC，也**不是**第二套执行真相源——
   * 它只说明"renderer 看到了哪条已校验的结局"。
   */
  forkAt: (
    parentRunId: string,
    atSpanId: string,
    value: string,
    execution?: IsolatedExecutionMode,
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * 隔离续跑的只读预检（确认区的唯一数据源）：不创建运行、不写文件、不请求模型。
   * 返回判别式联合而不是全局状态——确认区是**单个编辑器**的局部状态（与 2.1 的
   * chooseSource 同法），避免"两个编辑器抢同一份错误状态"。
   */
  promptFork: (
    parentRunId: string,
    edit: PromptForkRequest["edit"],
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * 模型 A/B：dryRun = true 走**只读预览通道**（不占槽、不登记、不联网、不写文件，返回计划）；
   * 真实执行只交代请求事实并返回信封里的计划/结果 —— U5 任务 3.3 起不再在入口刷列表，
   * 各臂结局由终态消费按登记的 `runIds`/`arms` 逐条核实（返回的 ids 不是"哪条臂成功"的结论）。
   */
  proxyFork: (
    parentRunId: string,
    atSpanId: string,
    messages: Record<string, unknown>[],
    /** U3 任务 3.4：本次提交关联——执行函数负责收尾（任何响应都不清草稿） */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  modelAb: (
    parentRunId: string,
    arms: ModelAbArm[],
    dryRun: boolean,
    /** U3 任务 3.5：真实执行的提交关联（整批）；预览不传——预览不是提交 */
    submission?: DraftSubmission,
  ) => Promise<ModelAbResult | null>;
  /** 打开新的 A/B 编辑前复位状态 */
  createRun: (
    request: CreateRunRequest,
    /** U3 任务 3.5：本次创建的提交关联（整份表单）——执行函数负责收尾 */
    submission?: DraftSubmission,
  ) => Promise<boolean>;
  /**
   * 原生目录选择（只读辅助通道，B 1.3）：阻塞至用户选完或取消。
   * 返回 main 的结论（取消为 `{canceled:true}`）；通道失败或结构不合法返回 null 并置 error。
   * 本方法**不签发、不保存**任何授权——副本写入必须由对话框本次显式勾选。
   */
  resetFork: () => void;

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
  resetModelAb: () => void;
  /** A/B 实验进行中（与 fork 状态分离，两者可并存于不同编辑器） */
  resetCreateRun: () => void;

  /**
   * 隔离**文件检查点**的只读通道（C 1.1/1.2）：
   * - `inspectWorkspace` 取某检查点的清单（省略 stepSpanId = 本 run 初始快照）
   * - `readWorkspaceFile` 读清单内某条逻辑路径的内容
   * 两者都不写任何文件、不调 LLM/工具；失败返回判别式联合而不是全局错误状态，
   * 因为文件视图是**单个面板**的局部状态（与 loadForkCapability 同法）。
   */
  loadForkCapability: (
    request: ForkCapabilityRequest,
  ) => Promise<
    { ok: true; data: ForkCapabilityResult } | { ok: false; code: string; message: string }
  >;
  /** prompt fork：编辑启动上下文（system prompt / 首条 user message）从头重跑 */
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
   * R2.1 任务 5.3：按提交 run/step 保存的**导出反馈会话状态**（离开文件页仍存活）。
   * - 键 = `workspaceExportKey(runId, stepSpanId)`，值带提交时代次；
   * - 同 key 旧响应（A→B→A 往返、连续重试）按代次丢弃，旧成功/失败/收尾都**不覆盖**
   *   新对象；不同 key 互不影响；
   * - 切页不中止 main 写入：没有任何取消通道，迟到响应仍按 key 落库，返回可查看；
   * - renderer 重载后本状态为空 = 结果未知——UI 必须如实说明并指引检查目标清单，
   *   不自动重发（本动作也不提供重发入口）。
   * 返回本次 outcome（代次被更新的提交顶掉时返回 null——反馈已不归本次所有）。
   */
  chooseSource: () => Promise<ChooseSourceResult | null>;
  /** 打开"新建运行"对话框前复位状态 */
  exportCheckpoint: (request: WorkspaceExportRequest) => Promise<WorkspaceExportOutcome | null>;
  /** 导出反馈（按提交 run/step 键控；重载后为空 = 结果未知，不自动重发） */
  workspaceExports: Record<string, WorkspaceExportFeedback>;
  /** 每个 key 最近一次提交的请求代次（旧响应按代次丢弃的判据） */
  workspaceExportGenerations: Record<string, number>;
}
