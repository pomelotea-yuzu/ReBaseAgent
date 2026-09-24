import type { CallDraftEntry, CallDraftKey } from "./debugging-drafts";

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

/** 提交通道：与既有执行入口一一对应（U3 只接线 result / prompt / messages） */
export type DraftSubmitChannel = "result" | "prompt" | "messages";

/** 单次提交关联：提交时的身份 + 修订 + 请求快照 */
export interface DraftSubmission {
  /** 目标标识 `${runId}|${spanId}|${field}`（与草稿列表 listKey 同编码，不作编辑身份） */
  readonly id: string;
  /** 编辑身份：当前父本 runId + 调用 spanId + 字段 */
  readonly key: CallDraftKey;
  readonly channel: DraftSubmitChannel;
  /** 提交时该草稿的修订——U5 的清理条件之一（"相同修订"） */
  readonly submittedRevision: number;
  /** 提交时原子的请求快照（提交值取自此处，不取组件可能过期的局部值） */
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
export function submissionIdOf(key: CallDraftKey): string {
  return `${key.runId}|${key.spanId}|${key.field}`;
}

/** 读取某目标的待定提交；无则 undefined（= 未冻结） */
export function submissionOf(
  store: SubmissionStore,
  key: CallDraftKey,
): DraftSubmission | undefined {
  return store.byId[submissionIdOf(key)];
}

export interface BeginSubmissionInput {
  readonly channel: DraftSubmitChannel;
  readonly key: CallDraftKey;
  /** 提交时的草稿条目（store 原子读取的当前值；快照与修订都取自它） */
  readonly entry: CallDraftEntry;
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
 * - 快照与修订取自 `entry`（提交值 = 此刻 store 里的原文）。
 */
export function beginSubmission(
  store: SubmissionStore,
  input: BeginSubmissionInput,
): BeginSubmissionResult {
  const id = submissionIdOf(input.key);
  if (store.byId[id] !== undefined) return { store, submission: null };
  const submission: DraftSubmission = {
    id,
    key: input.key,
    channel: input.channel,
    submittedRevision: input.entry.revision,
    submittedText: input.entry.text,
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
