import type { OperationRecord } from "@shared/operations";
import type { ResultReadEntry } from "./result-verification";

/**
 * U5（unify-run-execution-workflow）任务 3.4：**结果导航意图**（design D6 + delta
 * 「结果导航尊重用户当前阅读意图」）。
 *
 * 3.1–3.3 把七类入口的"响应即成功 / 无条件 `selectRun(信封 id)`"全部拆掉以后，
 * 桌面**完全没有**"执行结束自动进入结果概览"这件事了。本模块负责把它**按意图加回来**：
 * 只有"用户自始至终没离开这次提交流程、且结果第一次自动读取就可读、且没有覆盖模态在场"
 * 的单运行操作，才允许自动进入它的概览（失败也进——进的是失败概览）。
 *
 * 三条实现纪律：
 *
 * 1. **代次而不是位置**。撤销判据是一个单调递增的"阅读代次"，不是"当前位置等于提交时位置"：
 *    主动切运行 / 换页签 / 换调用 / 换视图 / 进设置 / 打开或关闭创建页都会推进代次，
 *    于是「离开再返回同一位置」也**不会**恢复旧资格（位置相等恒成立，代次不会倒退）。
 * 2. **切换前重验**。判定入参 `generation` 必须是**调用那一刻**的代次；
 *    读取开始时快照下来的代次不得拿来放行导航（spec 明令）。所以本模块是纯函数、
 *    由协调处在 `await` 之后重新读 store 再判。
 * 3. **只通知的路不导航**。显式核对（reconcile）、手动只读重试、A/B 批次、多运行、
 *    settled 无可信 ID、结果不可读 ⇒ 一律作废资格（drop），不是"这次先不跳、下次再试"。
 *    唯一"留着等"的情形是结果**还在读**（wait）。
 *
 * ⚠️ 与收尾关联（`draft-submission.closures`）分开：那份凭据服务"删哪一份草稿"，
 * 这份服务"要不要跳页面"。两者身份同为 `(epoch, operationId)`，但生命周期与判据互不相干。
 */

/** 一次提交登记的导航意图 */
export interface NavigationIntent {
  readonly operationId: string;
  /** 登记那一刻的阅读代次 */
  readonly generation: number;
}

/** 会话内导航意图集合（renderer 内存：不落盘、不进 URL/日志/操作 IPC） */
export interface NavigationIntentStore {
  readonly byOperationId: Readonly<Record<string, NavigationIntent>>;
}

export function emptyNavigationIntents(): NavigationIntentStore {
  return { byOperationId: {} };
}

/**
 * 登记 / 重写一条意图（同 operationId 幂等覆盖）。
 *
 * 只由**提交**触发（`beginDraftSubmission` 这一条咽喉）：入口组件不许各自登记，
 * 否则七个入口会漂移出七套语义。
 */
export function armNavigationIntent(
  store: NavigationIntentStore,
  operationId: string,
  generation: number,
): NavigationIntentStore {
  const current = store.byOperationId[operationId];
  if (current !== undefined && current.generation === generation) return store;
  return { byOperationId: { ...store.byOperationId, [operationId]: { operationId, generation } } };
}

/** 作废一条意图（导航完成、或判定为永不导航时）；查不到 ⇒ 引用不变（幂等） */
export function releaseNavigationIntent(
  store: NavigationIntentStore,
  operationId: string,
): NavigationIntentStore {
  if (store.byOperationId[operationId] === undefined) return store;
  const byOperationId = { ...store.byOperationId };
  delete byOperationId[operationId];
  return { byOperationId };
}

export function navigationIntentOf(
  store: NavigationIntentStore,
  operationId: string,
): NavigationIntent | undefined {
  return store.byOperationId[operationId];
}

/**
 * 终态是怎么被本会话知道的。只有随会话内提交到达的那条路允许自动导航；
 * **显式核对（reconcile）永远不跳**（spec「核对结果只由用户明确打开」）。
 * 手动只读重试压根不调本判据（它只更新读取项），所以不是一种触发方式。
 */
export type NavigationTrigger = "status" | "reconcile";

/** 导航决定：`navigate` 是唯一"要动页面"的出口 */
export type NavigationDecision =
  | { readonly kind: "navigate"; readonly runId: string }
  /** 结果还在读 ⇒ 留着意图（下一次到达同一判据再判） */
  | { readonly kind: "wait"; readonly reason: string }
  /** 永久作废：离开过流程 / 批次或多运行 / 结局不可导航 / 终态来自显式核对 */
  | { readonly kind: "drop"; readonly reason: string }
  /** 本次会话没提交过这条操作（重载恢复）⇒ 什么都不做 */
  | { readonly kind: "none" };

export interface NavigationDecisionInput {
  readonly intent: NavigationIntent | undefined;
  /** **当下**（导航前一刻）的阅读代次，不是读取开始时的快照 */
  readonly generation: number;
  /** 有覆盖模态在场（创建页 / 设置）：不跳到它背后 */
  readonly coveringModal: boolean;
  /** 这条操作在会话镜像里的登记记录（undefined = 本会话镜像里没有） */
  readonly record: OperationRecord | undefined;
  /** 那条唯一可信 runId 的**当下**读取结论（undefined = 还没读过） */
  readonly entry: ResultReadEntry | undefined;
  readonly trigger: NavigationTrigger;
}

/**
 * 判定要不要为这次终态切页面。
 *
 * 顺序即优先级：先问"还有没有资格"（触发方式 / 代次 / 模态），再问"这次操作配不配"
 * （单运行），最后才看"结果读到了什么"。反过来写会把"还在读"误判成"可以跳"。
 */
export function decideResultNavigation(input: NavigationDecisionInput): NavigationDecision {
  const { intent, record, trigger } = input;
  if (intent === undefined) return { kind: "none" };
  if (trigger !== "status") {
    return { kind: "drop", reason: "终态由显式核对得到：只通知，不跳转" };
  }
  if (intent.generation !== input.generation) {
    return { kind: "drop", reason: "离开过本次提交流程（阅读代次已推进），返回同一位置也不恢复" };
  }
  if (input.coveringModal) {
    // 不 drop 而是 wait：模态在场只是"这一刻不许跳到它背后"，撤销资格另有其条件
    // （主动换阅读对象 / 进设置都会推进代次 ⇒ 落到上面的 drop）。
    return { kind: "wait", reason: "有覆盖模态在场：不把结果页跳到它背后" };
  }
  if (record === undefined) {
    return { kind: "drop", reason: "本会话登记镜像里没有这条操作，结局无从判定" };
  }
  if (record.target?.kind === "modelAb") {
    return { kind: "drop", reason: "A/B 批次永不自动聚焦，由用户挑臂" };
  }
  if (record.runIds.length !== 1) {
    return {
      kind: "drop",
      reason:
        record.runIds.length === 0
          ? "结果未定位（登记里没有可信运行 id）：不猜一个 run 去跳"
          : `本次操作关联 ${record.runIds.length} 条运行，不是单运行流程`,
    };
  }
  if (record.state !== "settled") {
    return record.state === "running"
      ? { kind: "wait", reason: "仍在执行，不判定结局" }
      : { kind: "drop", reason: "本次未接受，没有结果可进入" };
  }
  const entry = input.entry;
  if (entry === undefined || entry.phase === "reading") {
    return { kind: "wait", reason: "结果仍在读取" };
  }
  if (entry.phase === "unreadable") {
    return { kind: "drop", reason: `结果不可读：${entry.reason ?? "未知原因"}` };
  }
  // 走到这里 = 首次自动读取即拿到经核实的自有结局：失败也照样进（进的是失败概览）
  return { kind: "navigate", runId: record.runIds[0] as string };
}
