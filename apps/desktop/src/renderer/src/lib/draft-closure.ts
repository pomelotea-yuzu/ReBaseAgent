import type { OperationRecord } from "@shared/operations";
import type { DraftRepo } from "./debugging-drafts";
import {
  callDraftOf,
  discardCallDraft,
  discardCreateRunDraft,
  discardModelAbDraft,
  modelAbDraftOf,
} from "./debugging-drafts";
import type { SubmissionClosure } from "./draft-submission";
import { submissionIdOf } from "./draft-submission";
import type { ResultReadStore } from "./result-verification";
import { viewOperationResult } from "./result-verification";

/**
 * U5（unify-run-execution-workflow）任务 2.2/2.4：**按提交修订清理草稿**。
 *
 * design D5 的落点。清理是整条链路里唯一**删除用户输入**的动作，所以每道闸门都得自己站得住：
 *
 * 1. **只认核实过的自有终止事实**（任务 1.1/1.2）：`event=stopped` + `reason=completed`。
 *    文件封存、IPC ok、`requestOutcome=returned`、A/B 的成功 id 子集都不算——
 *    错误 / 上限 / 中止 / 中断 / 未知 / 不可读一律保留输入。
 * 2. **compare-and-delete**：当前草稿的目标与修订必须逐字等于提交时那份。
 *    内容相同也不行——用户"改回原样"同样推进了修订，旧结果无权删它。
 * 3. **不越过更晚的提交**：同目标已有更新令牌的待定提交 ⇒ 本次操作无权清理
 *    （spec「同修订再次提交也不被旧操作清理」）。
 * 4. **A/B 以提交时的预期臂数为基准**：登记的 `arms` 缺臂时更短，而"每条都正常"对空集合恒真
 *    ⇒ 必须每一条预期臂都有唯一可信 id、请求结局 `returned`、各自核实正常终止（任务 2.4）。
 *
 * 本模块只回答"该不该删、删哪一份"，不碰导航、通知与执行通道；清理完成只释放关联。
 */

/** 目标当前的草稿状态（`exists === false` = 已被显式放弃或从未登记） */
export interface DraftState {
  readonly exists: boolean;
  readonly revision: number;
}

/** 读取某目标当前草稿的修订（三类草稿同一入口，避免各写一份判据） */
export function draftStateOf(repo: DraftRepo, target: SubmissionClosure["target"]): DraftState {
  if (!("field" in target)) {
    const entry = modelAbDraftOf(repo, target);
    return { exists: entry !== undefined, revision: entry?.revision ?? -1 };
  }
  if (target.field === "create") {
    const entry = repo.create;
    return { exists: entry !== null, revision: entry?.revision ?? -1 };
  }
  const entry = callDraftOf(repo, target);
  return { exists: entry !== undefined, revision: entry?.revision ?? -1 };
}

/** 一条操作的结果核实结论（design D4 表格的聚合） */
export type OutcomeVerdict =
  | { readonly kind: "not-normal"; readonly reason: string }
  | { readonly kind: "normal"; readonly runIds: readonly string[] };

/**
 * 结果核实结论：`normal` 要求**该操作登记的每一条**可信 runId 都已读到、且自有终止事实
 * 是严格正常结束。批次另按预期臂数核对（`batchGapOf`）。
 */
export function verdictOfOperation(
  record: OperationRecord,
  reads: ResultReadStore,
  expectedArmCount: number | null,
): OutcomeVerdict {
  const view = viewOperationResult(record, reads);
  if (view.kind !== "results") {
    return {
      kind: "not-normal",
      reason:
        view.kind === "running"
          ? "仍在执行，不判定结局"
          : view.kind === "not-accepted"
            ? "本次未接受，没有结果可核实"
            : "结果未定位（登记里没有可信运行 id）",
    };
  }
  const missing: string[] = [];
  const unreadable: string[] = [];
  const abnormal: string[] = [];
  for (const item of view.items) {
    if (item.entry === undefined || item.entry.phase === "reading") {
      missing.push(item.runId);
      continue;
    }
    if (item.entry.phase === "unreadable") {
      unreadable.push(item.runId);
      continue;
    }
    if (item.entry.facts?.normalEnd !== true) {
      abnormal.push(`${item.runId}：${item.entry.facts?.outcome.label ?? "结局未知"}`);
    }
  }
  const gap = batchGapOf(record, view.items.length, expectedArmCount);
  if (missing.length > 0) {
    return { kind: "not-normal", reason: `仍有可信运行未读到结果：${missing.join("、")}` };
  }
  if (unreadable.length > 0) {
    return { kind: "not-normal", reason: `结果不可读：${unreadable.join("、")}` };
  }
  if (abnormal.length > 0) {
    return { kind: "not-normal", reason: `非正常终止：${abnormal.join("、")}` };
  }
  if (gap !== null) return { kind: "not-normal", reason: gap };
  return { kind: "normal", runIds: record.runIds };
}

/**
 * A/B 批次的预期臂完整性（任务 2.4）。非 A/B 入口返回 null（不适用）。
 *
 * ⚠️ 基准是**提交时用户交出去的臂数**：登记的 `arms` 在缺臂时更短，
 *    以它为准就是"少跑了也算全绿"。
 */
function batchGapOf(
  record: OperationRecord,
  verifiedCount: number,
  expectedArmCount: number | null,
): string | null {
  if (record.target?.kind !== "modelAb") return null;
  if (expectedArmCount === null) return "A/B 收尾关联缺少提交时的预期臂数，不判定整批";
  if (expectedArmCount !== record.target.armCount) {
    return `提交预期 ${expectedArmCount} 臂，登记目标声明 ${record.target.armCount} 臂：身份不一致`;
  }
  if (record.experimentId === null) return "批次缺少可信实验身份";
  for (let index = 0; index < expectedArmCount; index += 1) {
    const arm = record.arms.find((one) => one.index === index);
    if (arm === undefined) return `第 ${index} 臂缺席（登记里没有该索引）`;
    if (arm.id === null) return `第 ${index} 臂没有可信运行 id`;
    if (arm.outcome !== "returned") return `第 ${index} 臂请求结局是 ${arm.outcome ?? "null"}`;
  }
  const armIds = record.arms.map((arm) => arm.id);
  if (new Set(armIds).size !== armIds.length) return "批次臂之间存在重复运行 id";
  // 每一条预期臂的运行都必须就在这次登记的可信 runIds 里：不在就等于那条臂没被核实过
  const runIdSet = new Set(record.runIds);
  if (armIds.some((id) => id === null || !runIdSet.has(id))) {
    return "有臂的运行不在登记的可信 runIds 里，整批不判定为已核实";
  }
  if (verifiedCount !== expectedArmCount) {
    return `已核实 ${verifiedCount} 条，与预期 ${expectedArmCount} 臂不符`;
  }
  return null;
}

/** 收尾决定：只有 `clean` 才删草稿；`release` 表示已无草稿可管，只把关联收掉 */
export type ClosureDecision =
  | { readonly kind: "clean"; readonly reason: string }
  | { readonly kind: "keep"; readonly reason: string }
  | { readonly kind: "release"; readonly reason: string };

/**
 * 清理决定（四道闸，顺序即优先级）。
 *
 * `pendingToken` = 同目标当前待定提交的令牌（没有则 null）。更晚的提交接管了这个目标 ⇒
 * 旧操作即使核实正常也不得清理（spec「同修订再次提交也不被旧操作清理」）。
 */
export function decideDraftClosure(input: {
  closure: SubmissionClosure;
  draft: DraftState;
  verdict: OutcomeVerdict;
  pendingToken: number | null;
}): ClosureDecision {
  const { closure, draft, verdict, pendingToken } = input;
  if (pendingToken !== null && pendingToken > closure.token) {
    return { kind: "keep", reason: "该目标已被更晚的提交接管，旧操作无权清理" };
  }
  if (!draft.exists) {
    return { kind: "release", reason: "该目标已无草稿（已被显式放弃或从未登记）" };
  }
  if (verdict.kind !== "normal") return { kind: "keep", reason: verdict.reason };
  if (draft.revision !== closure.submittedRevision) {
    return {
      kind: "keep",
      reason: `草稿修订已推进（提交 ${closure.submittedRevision} → 当前 ${draft.revision}），保留输入`,
    };
  }
  return { kind: "clean", reason: "自有正常终止已核实且仍匹配提交修订" };
}

export interface ApplyClosureResult {
  readonly repo: DraftRepo;
  /** 是否真的删掉了这一份草稿（CAS 失败为 false） */
  readonly cleaned: boolean;
  readonly reason: string;
}

/**
 * 执行清理决定：`clean` 才删，且删除本身仍走 U3 的修订 CAS——
 * 判据与仓库之间哪怕被别的写入插进来，也只可能"没删成"，不可能删掉新修订。
 *
 * 创建入口清整份表单（对应的目录引用由 store 侧一并清）；A/B 只清整批，不逐臂删。
 */
export function applyDraftClosure(
  repo: DraftRepo,
  closure: SubmissionClosure,
  decision: ClosureDecision,
): ApplyClosureResult {
  if (decision.kind !== "clean") {
    return { repo, cleaned: false, reason: decision.reason };
  }
  const target = closure.target;
  if (!("field" in target)) {
    const next = discardModelAbDraft(repo, target, closure.submittedRevision);
    return {
      repo: next.repo,
      cleaned: next.discarded,
      reason: next.discarded ? "已清理匹配的 A/B 批次" : "批次修订已推进，保留整份配置",
    };
  }
  if (target.field === "create") {
    const next = discardCreateRunDraft(repo, closure.submittedRevision);
    return {
      repo: next.repo,
      cleaned: next.discarded,
      reason: next.discarded ? "已清理匹配的创建草稿" : "创建草稿修订已推进，保留整份表单",
    };
  }
  const next = discardCallDraft(repo, target, closure.submittedRevision);
  return {
    repo: next.repo,
    cleaned: next.discarded,
    reason: next.discarded ? "已清理匹配的调用草稿" : "该目标修订已推进，保留输入",
  };
}

/** 同目标的待定提交令牌（没有待定 ⇒ null）。清理判定只看这一个目标的。 */
export function pendingTokenForTarget(
  byId: Readonly<Record<string, { token: number }>>,
  closure: SubmissionClosure,
): number | null {
  return byId[submissionIdOf(closure.target)]?.token ?? null;
}
