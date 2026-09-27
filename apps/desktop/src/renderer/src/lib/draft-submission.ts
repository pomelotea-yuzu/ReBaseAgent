import type { OperationAck } from "@shared/operations";
import type { CallDraftKey, ModelAbDraftKey } from "./debugging-drafts";

/**
 * U3（preserve-debugging-drafts）任务 3.4：**提交关联**（design D5）。
 *
 * 与草稿仓库分开：草稿是"用户编辑了什么"，提交关联是"这一份编辑已经发出去了"。
 * 提交那一刻从 store 原子取到目标身份、当前修订与请求快照，据此冻结该草稿的
 * 修改与放弃；响应由**执行函数**按 `token` 匹配收尾，组件卸载、`resetFork`、
 * 展示状态复位都不算解冻依据。
 *
 * 纪律（design D5 原文）：
 * - 一次提交只使用当前目标，不合并其他 prompt/result 草稿；草稿正文不进提交关联之外的
 *   任何通道（不写日志、不发关闭 IPC）。
 * - 临时授权（`writesAuthorized` / `allowSideEffects`）随本次快照消费，**不进**本结构，
 *   不做长期正文保存。
 * - 任何执行结果（ok / 业务拒绝 / 抛错 / 失败运行 / 部分 A/B 结果）都**不删除草稿**；
 *   已明确返回或本地校验拒绝的请求可解除本次冻结，迟到回调不能解除新关联。
 * - 通道断开、无法确定执行是否仍在进行时保留冻结：调用方不得因不确定而调用
 *   `settleSubmission`（宁可保留待处理，也不把未知当已完成）。
 * - 为 U5 保留 `{key, submittedRevision}` 关联位置。
 *
 * U4 任务 4.2 在本结构上追加了 **main 操作身份**（`epoch` + `operationId`）：
 * 提交时生成 operationId、发出时绑定 epoch，收尾一律按身份判定（`decideSettle`）——
 * 不匹配的回执、没有回执但状态未知的码，都不能解除冻结。草稿正文仍永不因执行结果删除。
 */

/** 提交通道：与既有执行入口一一对应（调用类三通道 + A/B 整批 + 创建整份） */
export type DraftSubmitChannel = "result" | "prompt" | "messages" | "model_ab" | "create";

/**
 * 提交目标（任务 3.5 泛化）：调用类 = runId + spanId + 字段；A/B = 父本 runId + 起始
 * llm spanId（无 `field` 键，靠它判别）；创建 = 会话内单份表单（只有 `field: "create"`）。
 * 三类共用同一套「登记 / 冻结 / 令牌收尾」，不各造一份。
 */
export type DraftSubmitTarget = CallDraftKey | ModelAbDraftKey | { readonly field: "create" };

/** 创建表单的提交目标（会话内单份，store 与对话框共用同一常量避免两处各写一份） */
export const CREATE_SUBMIT_TARGET: DraftSubmitTarget = { field: "create" };

/** 单次提交关联：提交时的身份 + 修订 + 请求快照 + U4 的 main 操作身份 */
export interface DraftSubmission {
  /** 目标标识 `${runId}|${spanId}|${field}`（与草稿列表 listKey 同编码，不作编辑身份） */
  readonly id: string;
  /** 提交目标：调用类 / A/B 批次 / 创建表单 */
  readonly target: DraftSubmitTarget;
  readonly channel: DraftSubmitChannel;
  /** 提交时该草稿的修订——U5 的清理条件之一（"相同修订"） */
  readonly submittedRevision: number;
  /**
   * 提交时原子的请求快照：调用类 = 草稿原文（提交值直接取它，不取组件可能过期的局部值）；
   * A/B = 批次行 JSON；创建 = 表单 JSON（后两者与草稿列表 copyText 同形，供 U5 核对与展示）。
   */
  readonly submittedText: string;
  /** 本次提交的匹配令牌（会话内单调）：只有同令牌的响应才可解冻 */
  readonly token: number;
  /**
   * U4 任务 4.2：本次提交的 **main 操作身份**。
   * `operationId` 在登记关联时就生成（与草稿快照同一步原子取到，之后不再换）；
   * `epoch` 在真正发出请求时绑定（握手没成功就是 `null` ⇒ 请求根本没离开 renderer）。
   * 解冻只认这对身份：不匹配的回执（迟到的、冒充的、回执本身不合法的）都不能解锁。
   */
  readonly operationId: string;
  readonly epoch: string | null;
  /**
   * U5 任务 2.1：A/B 批次的**预期臂数**（整批清理基准，任务 2.4）。
   * 其余入口为 null。登记里的 `arms` 只说明 main 观察到几条，缺臂时它会更短——
   * "全部预期臂都正常"必须以提交时用户真正交出去的臂数为基准，不能以登记为准。
   */
  readonly expectedArmCount: number | null;
}

/**
 * U5 任务 2.1：**提交收尾关联**（design D3）。
 *
 * 与 `DraftSubmission` 的分工是刻意的两件事：
 * - 待定提交（`byId`）管"这份草稿现在不能改/不能放弃"——它随解冻消失；
 * - 收尾关联（`closures`）管"这次执行的结局够不够格清掉哪一份草稿"——它必须在解冻**之后**
 *   继续在场，因为结果核实（U5 任务 1.2–1.4）天然晚于解冻：main 登记终态即解冻让用户继续编辑，
 *   而"能不能删草稿"要等详情读到手、自有终止事件核实完才知道。
 *
 * 三条纪律：
 * 1. **只存最小元数据**：目标标识、修订、令牌、身份，外加 A/B 的预期臂数。
 *    正文一份都不复制——草稿与原提交快照各自已有，再抄一份就是第二个真相源。
 * 2. **不能授予执行资格**：它只是"该不该清理"的凭据，界面与门禁都不读它。
 * 3. **只保留每个目标最新一次**：同目标再次提交 ⇒ 旧关联作废（spec
 *    「同修订再次提交也不被旧操作清理」）。否则旧操作核实正常后会把新一次提交引用的
 *    同一份草稿删掉——身份对了，权限却早就换人了。
 */
export interface SubmissionClosure {
  /** 关联键 `${epoch}|${operationId}` */
  readonly id: string;
  readonly epoch: string;
  readonly operationId: string;
  /** 草稿目标（调用类 / A/B 批次 / 创建整份）：清理时按它回查当前草稿 */
  readonly target: DraftSubmitTarget;
  /** 目标标识（`submissionIdOf(target)`）：同目标作废与草稿列表回查都用它 */
  readonly targetKey: string;
  readonly channel: DraftSubmitChannel;
  /** 提交时的草稿修订：清理要求当前修订**逐字相同**（内容相同也不算，见 design D5） */
  readonly submittedRevision: number;
  /** 提交令牌：与更晚的待定提交比较，判断"这份草稿是否已被后来的提交接管" */
  readonly token: number;
  /** A/B 批次的预期臂数（整批清理的基准，任务 2.4）；其余入口为 null */
  readonly expectedArmCount: number | null;
}

export interface SubmissionStore {
  /** 待定提交：目标标识 → 关联（同一目标同时最多一个） */
  readonly byId: Readonly<Record<string, DraftSubmission>>;
  /** 收尾关联：`${epoch}|${operationId}` → 最小清理凭据（解冻后仍保留） */
  readonly closures: Readonly<Record<string, SubmissionClosure>>;
  /** 令牌分配器：只增不减，旧关联的令牌不会与后续提交相同 */
  readonly nextToken: number;
}

export function emptySubmissionStore(): SubmissionStore {
  return { byId: {}, closures: {}, nextToken: 1 };
}

/** 收尾关联的键 */
export function closureIdOf(epoch: string, operationId: string): string {
  return `${epoch}|${operationId}`;
}

/** 目标标识：与 `lib/draft-list.ts` 的 listKey 同编码（不是编辑身份本身） */
export function submissionIdOf(target: DraftSubmitTarget): string {
  // A/B 目标没有 field 键（ModelAbDraftKey 只有 runId + spanId）
  if (!("field" in target)) return `${target.runId}|${target.spanId}|model_ab`;
  // 创建草稿不属于任何运行：与列表的 "|create" 保持一致
  if (target.field === "create") return "|create";
  return `${target.runId}|${target.spanId}|${target.field}`;
}

/** 读取某目标的待定提交；无则 undefined（= 未冻结） */
export function submissionOf(
  store: SubmissionStore,
  target: DraftSubmitTarget,
): DraftSubmission | undefined {
  return store.byId[submissionIdOf(target)];
}

export interface BeginSubmissionInput {
  readonly channel: DraftSubmitChannel;
  readonly target: DraftSubmitTarget;
  /** 提交时的草稿修订（store 原子读取） */
  readonly submittedRevision: number;
  /** 提交时的请求快照（store 原子读取同类草稿拼出，语义见 DraftSubmission.submittedText） */
  readonly submittedText: string;
  /** U4 任务 4.2：本次提交的操作身份（operationId 登记时就定；epoch 发出时绑定，先给 null） */
  readonly operationId: string;
  readonly epoch: string | null;
  /**
   * U5 任务 2.4：A/B 批次的**预期臂数**（整批清理的基准）。
   * 非 A/B 入口不传（= null）；A/B 必须传本次提交的行数——缺臂/null ID 的判断
   * 不能靠登记的 `arms.every()`（空集合恒真）。
   */
  readonly expectedArmCount?: number | null;
}

export interface BeginSubmissionResult {
  /** 未冻结（新建成功）时为新仓库引用；已冻结时与入参同引用 */
  readonly store: SubmissionStore;
  /** null = 该目标已有待定提交（拒绝重复提交，不覆盖旧关联） */
  readonly submission: DraftSubmission | null;
}

/**
 * 开始一次提交：登记关联并冻结目标。
 * - 同一目标已有待定提交 ⇒ 返回 null 且仓库不变（不覆盖旧关联，也不换令牌——
 *   否则旧请求的响应会变成"迟到"而永远解冻不了当前目标）。
 * - 修订与快照由调用方从 store 原子读取后传入（批次/整份各自的可核对串在 store 侧拼）。
 */
export function beginSubmission(
  store: SubmissionStore,
  input: BeginSubmissionInput,
): BeginSubmissionResult {
  const id = submissionIdOf(input.target);
  if (store.byId[id] !== undefined) return { store, submission: null };
  const submission: DraftSubmission = {
    id,
    target: input.target,
    channel: input.channel,
    submittedRevision: input.submittedRevision,
    submittedText: input.submittedText,
    token: store.nextToken,
    operationId: input.operationId,
    epoch: input.epoch,
    expectedArmCount: input.expectedArmCount ?? null,
  };
  // 新一次提交接管这个目标 ⇒ 该目标更早的收尾关联作废（旧操作不得清理新提交的草稿）
  const closures = Object.fromEntries(
    Object.entries(store.closures).filter(([, one]) => one.targetKey !== id),
  );
  return {
    store: {
      byId: { ...store.byId, [id]: submission },
      closures,
      nextToken: store.nextToken + 1,
    },
    submission,
  };
}

/**
 * 收尾一次提交（解除冻结）：
 * - 仅当该目标的待定关联**令牌相同**才删除 —— 旧回调不能解冻后来发起的新提交；
 * - 目标已无待定关联（已被收尾 / 已被放弃）⇒ 幂等，返回原引用；
 * - 只提供给"已明确有结论"的路径调用（响应到达 / 本地校验拒绝）；通道断开等
 *   不确定状态**不得**调用，按 design D5 保留冻结。
 */
/**
 * 收尾一次提交（解除冻结）：
 * - 仅当该目标的待定关联**令牌相同**才删除 —— 旧回调不能解冻后来发起的新提交；
 * - 目标已无待定关联（已被收尾 / 已被放弃）⇒ 幂等，返回原引用；
 * - 只提供给"已明确有结论"的路径调用（响应到达 / 本地校验拒绝）；通道断开等
 *   不确定状态**不得**调用，按 design D5 保留冻结。
 *
 * U5 任务 2.1：解冻**不再丢弃**这次提交的最小元数据——转成交收关联（`SubmissionClosure`），
 * 供晚到的结果核实按修订判断"能不能清草稿"。只有真正发出过（`epoch` 已绑定）的提交才留：
 * 本地未发送的请求根本没有结局，给它挂一条关联等于凭空多出一份可清理凭据。
 */
export function settleSubmission(
  store: SubmissionStore,
  submission: DraftSubmission,
): SubmissionStore {
  const current = store.byId[submission.id];
  if (current === undefined || current.token !== submission.token) return store;
  const nextById = { ...store.byId };
  delete nextById[submission.id];
  return {
    byId: nextById,
    closures: withClosure(store.closures, current),
    nextToken: store.nextToken,
  };
}

/**
 * 把一条刚解冻的提交转成交收关联。
 *
 * **没真正发出过（`epoch === null`）的不生成**：本地未发送的请求没有结局可核对，
 * 留一条关联等于凭空多出一份"将来可以清草稿"的凭据（design D3 的关联只服务已执行的操作）。
 */
function withClosure(
  closures: Readonly<Record<string, SubmissionClosure>>,
  submission: DraftSubmission,
): Readonly<Record<string, SubmissionClosure>> {
  if (submission.epoch === null) return closures;
  const closure: SubmissionClosure = {
    id: closureIdOf(submission.epoch, submission.operationId),
    epoch: submission.epoch,
    operationId: submission.operationId,
    target: submission.target,
    targetKey: submission.id,
    channel: submission.channel,
    submittedRevision: submission.submittedRevision,
    token: submission.token,
    expectedArmCount: submission.expectedArmCount,
  };
  return { ...closures, [closure.id]: closure };
}

/** 按 main 身份查收尾关联（结果核实到达后用） */
export function closureOf(
  store: SubmissionStore,
  epoch: string,
  operationId: string,
): SubmissionClosure | undefined {
  return store.closures[closureIdOf(epoch, operationId)];
}

/**
 * 释放一条收尾关联（清理完成 / 显式放弃该目标草稿）。
 * 查不到该身份 ⇒ 引用不变（幂等：重复 status、重复读取重试都不会多删一次）。
 */
export function releaseClosure(
  store: SubmissionStore,
  identity: { epoch: string; operationId: string },
): SubmissionStore {
  const id = closureIdOf(identity.epoch, identity.operationId);
  if (store.closures[id] === undefined) return store;
  const closures = { ...store.closures };
  delete closures[id];
  return { ...store, closures };
}

// ---------------------------------------------------------------------------
// U4 任务 4.2：按 main 操作身份收尾（epoch + operationId）
// ---------------------------------------------------------------------------

/**
 * 发出请求时把 epoch 绑进关联（`operationId` 在登记时已定，不再改）。
 * 只认令牌相同且 `epoch` 仍为 null 的那一条——旧回调、别的目标的握手结果都写不进来。
 */
export function bindSubmissionEpoch(
  store: SubmissionStore,
  submission: DraftSubmission,
  epoch: string,
): SubmissionStore {
  const current = store.byId[submission.id];
  if (current === undefined || current.token !== submission.token) return store;
  if (current.epoch === epoch) return store;
  return {
    byId: { ...store.byId, [submission.id]: { ...current, epoch } },
    closures: store.closures,
    nextToken: store.nextToken,
  };
}

/** 按身份找待定关联（核对驱动解冻用；身份不含目标，所以要跨目标查） */
export function submissionByOperation(
  store: SubmissionStore,
  epoch: string,
  operationId: string,
): DraftSubmission | undefined {
  return Object.values(store.byId).find(
    (one) => one.epoch === epoch && one.operationId === operationId,
  );
}

/** 按身份收尾：找不到该身份（已结束/从未登记）⇒ 引用不变 */
export function settleSubmissionByOperation(
  store: SubmissionStore,
  epoch: string,
  operationId: string,
): SubmissionStore {
  const found = submissionByOperation(store, epoch, operationId);
  return found === undefined ? store : settleSubmission(store, found);
}

/**
 * "这条请求到底执行了没有"的未知码：响应形似结束、但**不能**据此解冻。
 * - `OPERATION_ACK_INVALID`：main 说成功却给不出可信回执（身份缺失/不匹配/形状非法）；
 * - `OPERATION_STATE_UNKNOWN`：本地已知通信未知 ⇒ 之前发出的请求可能仍在跑，也不能算这条没执行；
 * - `OPERATION_SESSION_SWITCHED`（任务 4.6）：main 已换新会话 ⇒ 旧那次提交的结局**永久未知**，
 *   既不按成功也不按"从没发生"处理（草稿保留，由用户明确核对/放弃）。
 */
export const UNKNOWN_RESULT_CODES: readonly string[] = [
  "OPERATION_ACK_INVALID",
  "OPERATION_STATE_UNKNOWN",
  "OPERATION_SESSION_SWITCHED",
];

export type SettleDecision = "settle" | "keep_unknown";

/**
 * 解冻判据（spec「核对终态只解冻对应修订」「迟到回调与未知状态不能错误解冻」）：
 * - 回执身份 == 本次提交的 `epoch`/`operationId` 且已进终态（settled / notAccepted）⇒ 解冻；
 * - 回执仍是 running ⇒ 保留；
 * - 回执身份不匹配（迟到的旧提交、或 main 回了别人的操作）⇒ 保留；
 * - 没有回执且码属于"接受之前的拒绝"（本地门禁、伪造 sender、旧 epoch、schema 失败）
 *   ⇒ 明确未执行 ⇒ 解冻（草稿仍保留原文，只是可以再次提交）；
 * - 没有回执但码是未知类 ⇒ 保留。
 *
 * 一律**不删草稿**：解冻只解除"修改/放弃"的冻结，正文保留是 U3 已定的纪律（design D5）。
 */
export function decideSettle(
  submission: DraftSubmission,
  ack: OperationAck | null,
  errorCode: string | null,
): SettleDecision {
  if (ack !== null) {
    if (ack.epoch !== submission.epoch || ack.operationId !== submission.operationId) {
      return "keep_unknown";
    }
    return ack.state === "running" ? "keep_unknown" : "settle";
  }
  if (errorCode !== null && UNKNOWN_RESULT_CODES.includes(errorCode)) return "keep_unknown";
  return "settle";
}
