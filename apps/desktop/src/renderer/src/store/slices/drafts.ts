// AppState 分片：Drafts 域（refactor-renderer 4.1；成员逐字随迁，归属依据 change 的 ownership-map.md）
import type { ExecutedResponse } from "../../../../shared/operations";
import type {
  CallDraftEntry,
  CallDraftKey,
  CallDraftSource,
  CreateRunDraftEntry,
  CreateRunDraftPatch,
  CreateSourceRef,
  DraftRepo,
  ModelAbArmRow,
  ModelAbDraftEntry,
  ModelAbDraftKey,
} from "../../lib/debugging-drafts";
import type { DraftKind } from "../../lib/draft-list";
import type {
  DraftSubmission,
  DraftSubmitChannel,
  DraftSubmitTarget,
  SubmissionStore,
} from "../../lib/draft-submission";
import type { ConfirmationBinding, ConfirmationStore } from "../../lib/execution-confirmation";

export interface DraftsState {
  drafts: DraftRepo;
  /** 读取某编辑目标的草稿条目（无则 undefined；返回仓库内对象，引用稳定） */
  draftSubmissions: SubmissionStore;
  /**
   * 开始一次提交：返回关联（快照 `submittedText` + 匹配令牌），目标已有待定提交时返回
   * null（拒绝重复提交，不覆盖旧关联）。调用类提交值必须取自返回的快照，不用组件可能
   * 过期的局部值；A/B 与创建的快照由本动作按同类草稿拼出。
   *
   * U5 任务 4.4：入口可以带上**本次执行确认**（只给目标即可——修订与设置快照由 store
   * 当场取，组件传不进旧值）。带确认的提交在登记前先验一次现场：不是 `confirmed`
   * ⇒ 返回 null，一次 IPC 都不发；通过后这份确认即被消费（重新执行要重新确认）。
   */
  confirmations: ConfirmationStore;
  /** 只读检查代次（按目标键）：重启检查即推进，旧响应不可安装新确认 */
  checkGenerations: Record<string, number>;
  /**
   * U6 任务 4.10：**来源撤销令牌**（会话内单调递增）。
   * 详情落地为 ownOnly、或预检/执行响应以来源类稳定码拒绝时 +1；
   * 编辑器据此撤销绑定旧父本的 A/B 计划 / capability 结果 / 本次副本授权。
   * 只增不减 ⇒ 父文件恢复不能自动复活（恢复后必须重新检查）。
   */
  sourceRevocation: number;
  /** 当前现场确认绑定：修订与设置快照都由 store 现取，组件传不进旧值 */
  createSourceRef: CreateSourceRef | null;
  pendingDraftTarget: { runId: string; spanId: string | null; field: DraftKind } | null;
  /**
   * 定位一个草稿条目：创建类 = 打开创建对话框（表单读草稿恢复）；
   * 调用类 = 切到该运行（需要时）+ 步骤页签 + 选中该 span，pending 交编辑器消费。
   */
  callDraftOf: (key: CallDraftKey) => CallDraftEntry | undefined;
  /**
   * 编辑器打开时登记基线（来自已校验详情的原文）。已存在同 key 条目则原样保留：
   * 不覆盖基线、不推进修订——重开编辑不得覆盖已有输入（design D2）。
   * `source` 为任务 1.4 的源基线（captureCallDraftSource 的产物），只在条目创建时落库。
   */
  ensureCallDraft: (
    key: CallDraftKey,
    baseline: string,
    source?: CallDraftSource,
  ) => CallDraftEntry;
  /**
   * 输入事件**同步**写入原始文本（不得仅靠 debounce/失焦/卸载保存最后一次输入）；
   * 实际内容变化才推进修订。须先 ensureCallDraft——未登记基线的目标不接收写入。
   */
  writeCallDraftText: (key: CallDraftKey, text: string) => void;
  /**
   * U3 任务 1.2：按 key + revision 的放弃校验（CAS）。仅当目标修订与确认时一致才删除；
   * 确认等待期间内容已推进或条目不存在时不动仓库。返回是否真的放弃。
   */
  discardCallDraft: (key: CallDraftKey, expectedRevision: number) => boolean;
  /** 创建表单草稿（会话内单份；null = 默认空表单）；打开创建流程时 ensure */
  createRunDraftOf: () => CreateRunDraftEntry | null;
  ensureCreateRunDraft: () => CreateRunDraftEntry;
  /** 合并写入创建草稿（切模式只传 mode ⇒ 文本保留）；实际内容变化才推进修订 */
  writeCreateRunDraft: (patch: CreateRunDraftPatch) => void;
  /** 放弃创建草稿（CAS）：确认后恢复默认空表单；旧确认不动新修订 */
  discardCreateRunDraft: (expectedRevision: number) => boolean;
  /** A/B 批次草稿读写（稳定行 ID；授权/计划不进草稿） */
  modelAbDraftOf: (key: ModelAbDraftKey) => ModelAbDraftEntry | undefined;
  ensureModelAbDraft: (
    key: ModelAbDraftKey,
    baselineArms: ReadonlyArray<{ model: string; paramsText: string }>,
    source?: CallDraftSource,
  ) => ModelAbDraftEntry;
  /** 整批替换行列表（增删/改内容/重排都经此）；语义不变仅行 ID 变化不推进修订 */
  setModelAbRows: (key: ModelAbDraftKey, rows: ReadonlyArray<ModelAbArmRow>) => void;
  /** 放弃整个 A/B 批次（CAS） */
  discardModelAbDraft: (key: ModelAbDraftKey, expectedRevision: number) => boolean;
  /**
   * 创建源目录的独立受限会话引用（design D4）：仅 main 已签发 token + 核对用
   * name/path。**不属于**草稿仓库：有效期由 main 判定，授权/计划不在此。
   */
  setCreateSourceRef: (ref: CreateSourceRef | null) => void;

  /**
   * U3 任务 3.4/3.5：提交关联（renderer 本地，与草稿仓库和授权都分开）。提交时**原子**
   * 取到目标、当前修订与请求快照，据此冻结该草稿的修改/放弃；收尾由既有执行函数负责——
   * 组件卸载、`resetFork`/`resetCreateRun`/`resetModelAb`、展示状态复位都不是解冻依据
   * （design D5）。调用类冻结单个字段，A/B 冻结整批，创建冻结整份。
   */
  beginDraftSubmission: (input: {
    channel: DraftSubmitChannel;
    target: DraftSubmitTarget;
    /** 已给出的本次确认（缺省 = 该入口尚未接入确认门禁，见 tasks 4.4 边界条） */
    confirmation?: ConfirmationBinding;
  }) => DraftSubmission | null;
  /**
   * 收尾一次提交（解除冻结）：只认令牌相同的关联，旧回调不解冻新提交。仅"已明确有结论"
   * 的路径可调用（响应到达 / 本地校验拒绝）；通道断开等不确定状态保留冻结。
   */
  settleDraftSubmission: (submission: DraftSubmission) => void;
  /**
   * U4 任务 4.2：执行响应到达后**按身份**收尾（spec「核对终态只解冻对应修订」
   * 「迟到回调与未知状态不能错误解冻」）。
   * 判据在 `decideSettle`：回执身份必须等于本次提交绑定的 `epoch`/`operationId` 且已进终态；
   * running、身份不匹配、回执不可信 ⇒ 保留冻结。一律不删草稿。
   */
  finishDraftSubmission: (submission: DraftSubmission, response: ExecutedResponse<unknown>) => void;
  /**
   * U4 任务 4.2/4.5：核对到某身份已进终态时按身份解冻（reconcile 与迟到响应的唯一合法解冻口）。
   * 身份查不到（已结束 / 从未登记）⇒ 状态不变。
   */
  settleDraftByOperation: (identity: { epoch: string; operationId: string }) => void;
  /** 该目标是否被待定提交冻结（冻结期间仓库拒绝写入与放弃） */
  isDraftFrozen: (target: DraftSubmitTarget) => boolean;

  /**
   * U5 任务 4.4：**执行前确认**（会话内凭据，design D2）。
   *
   * 绑"目标 + 草稿修订 + 设置快照 + 检查代次"，任一变化即失效；判据在
   * `lib/execution-confirmation.ts`。它**不授予执行资格**（门禁仍是 U4 的统一槽 +
   * main 的重复校验），也不落盘 / 不进 URL/日志/操作 IPC。
   */
  currentConfirmationBinding: (
    channel: DraftSubmitChannel,
    target: DraftSubmitTarget,
  ) => ConfirmationBinding;
  /** 记下一次确认（"已核对目标与边界"） */
  armExecutionConfirmation: (binding: ConfirmationBinding) => void;
  /** 撤销确认：返回编辑、切换对象、进入设置、重新执行、显式放弃都走这个出口 */
  releaseExecutionConfirmation: (target: DraftSubmitTarget) => void;
  /** 该现场现在还算不算已确认（现算，不缓存结论） */
  executionConfirmationReady: (binding: ConfirmationBinding) => boolean;
  /** 重新开始一次只读检查：推进代次并作废既有确认 */
  restartExecutionCheck: (target: DraftSubmitTarget) => void;

  /**
   * U4 任务 4.1：读一次 `operations:status` 并**校验后整份采纳**。
   * 三种结论都保留保守锁：通道失败、载荷不合契约（含不自洽的槽引用）⇒ `unknown`；
   * 旧代次/低登记版本的迟到快照 ⇒ 整份丢弃（不部分采纳所谓成功字段）。
   * 返回采纳后的会话，界面按 `deriveGate` 禁用入口。
   */
  openDraftAt: (target: {
    runId: string;
    spanId: string | null;
    field: DraftKind;
  }) => Promise<void>;
  /** 编辑器消费定位目标后清空（一次性；旧目标不抢新页面） */
  consumeDraftTarget: () => void;

  /**
   * 编辑某 tool.invoke 的 result 并重跑；成功刷新列表并自动选中新 run。
   * `execution` 仅隔离父本携带（本次显式 `allowFileWrites:true`）——不传时请求里
   * **不出现该键**，普通父本走既有普通重跑，隔离父本会被 main/core 拒绝（不降级）。
   */
  /**
   * result 分叉重跑（普通父本不带 `execution`；隔离父本必带）：只交代**请求事实**。
   * U5 任务 3.2：不再在 ok 后刷列表 / 选中新 run（见函数体注记）。
   */
}
