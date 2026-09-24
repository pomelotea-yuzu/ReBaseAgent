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
 * - 为 U5 保留 `{key, submittedRevision}` 关联位置；本次不引入 operationId / main epoch，
 *   也不实现"按 completed 自动清理"。
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

/** 单次提交关联：提交时的身份 + 修订 + 请求快照 */
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
}

export interface SubmissionStore {
  /** 待定提交：目标标识 → 关联（同一目标同时最多一个） */
  readonly byId: Readonly<Record<string, DraftSubmission>>;
  /** 令牌分配器：只增不减，旧关联的令牌不会与后续提交相同 */
  readonly nextToken: number;
}

export function emptySubmissionStore(): SubmissionStore {
  return { byId: {}, nextToken: 1 };
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
  };
  return {
    store: {
      byId: { ...store.byId, [id]: submission },
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
export function settleSubmission(
  store: SubmissionStore,
  submission: DraftSubmission,
): SubmissionStore {
  const current = store.byId[submission.id];
  if (current === undefined || current.token !== submission.token) return store;
  const nextById = { ...store.byId };
  delete nextById[submission.id];
  return { byId: nextById, nextToken: store.nextToken };
}
