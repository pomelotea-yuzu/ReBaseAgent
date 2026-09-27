import { isDetailPayloadForRun } from "@shared/detail-request";
import { findRunDetailVersionViolation } from "@shared/detail-version-guard";
import type { Envelope, RunDetail } from "@shared/ipc";
import { RunDetailSchema } from "@shared/ipc";
import type { NotAcceptedReason, OperationRecord } from "@shared/operations";
import {
  type OwnTerminalFacts,
  deriveOwnTerminalFacts,
  findResultIdentityViolation,
} from "@shared/terminal-facts";

/**
 * U5（unify-run-execution-workflow）任务 1.2：**按可信 runId 独立核实结果**。
 *
 * design D3/D4 的落点。此前"读一次运行详情"只有一条路：`store.selectRun`——
 * 它同时干三件事（换选中运行、恢复该 run 的阅读状态、落地详情），
 * 所以任何"我只是想知道那次执行的结局"的动作都被迫**改掉用户正在读的东西**。
 * U5 要求核实与导航分开：
 * - `verifyResultPayload`（本文件）只做**读取核对**，输入是信封、输出是可信结局事实；
 * - 导航由流程协调处另行调用既有的选择动作（任务 3.4 的"核实后重验资格"）。
 *
 * 三条纪律：
 * 1. **不猜身份**：只读被点名的 `runId`，绝不"取列表最新一条"或"取当前选中项"顶替；
 *    载荷自称的 id、祖先链末跳都必须等于请求的 id，否则这条详情不解释本次操作。
 * 2. **读取失败 ≠ 执行失败**：不可读只产生本条读取项的说明，
 *    不写全局 `error`（那是当前运行自己的加载态），更不发起任何执行通道。
 * 3. **列表失败不阻断结果**：本模块不碰 `listRuns`，列表能不能刷新与按 ID 核实互不相干。
 */

/** 一次结果核实的身份：main 登记的会话 + 操作 + 可信运行 id */
export interface ResultReadIdentity {
  readonly epoch: string;
  readonly operationId: string;
  readonly runId: string;
}

/** 读取项的键（任务 1.3 的代次与去重都以它为单位） */
export function resultReadKeyOf(identity: ResultReadIdentity): string {
  return `${identity.epoch}|${identity.operationId}|${identity.runId}`;
}

/** 一条结果的读取结论 */
export interface ResultReadEntry {
  /**
   * `reading` = 已发出、尚未落地；`verified` = 详情已通过全部核对；
   * `unreadable` = 执行已结束但结果不可读（文件缺失/损坏/版本不支持/身份不符）。
   * 「未定位」（settled 但根本没有可信 runId）不在这里——那是记录级事实，
   * 见 `viewOperationResult`，本表只装**按 ID 读过**的结论。
   */
  readonly phase: "reading" | "verified" | "unreadable";
  /** 读取代次（同键每次实际读取递增）：迟到的旧响应不得覆盖新读取（任务 1.3） */
  readonly attempt: number;
  /** 经校验的自有终止事实；非 `verified` 时为 null（不造结论） */
  readonly facts: OwnTerminalFacts | null;
  /** 不可读的诚实说明（含原诊断）；已核实与在读为 null */
  readonly reason: string | null;
}

/** 核对结论：要么给出可信事实，要么给出**为什么不可读** */
export type ResultVerification =
  | { readonly ok: true; readonly detail: RunDetail; readonly facts: OwnTerminalFacts }
  | { readonly ok: false; readonly reason: string };

function unreadable(reason: string): ResultVerification {
  return { ok: false, reason };
}

/**
 * 核对一次详情读取的载荷（顺序与 `selectRun` 同口径：归属 → 版本 → schema → 终止事件归属）。
 *
 * 版本守卫先于 schema：zod 会剥离未知键，"v1 载荷私带隔离字段"必须在转换前拒掉；
 * 身份核对放在 schema 之后，因为末跳归属要看解析出来的 `chain`。
 * 归属预检与解析后的核对会拒掉同一份串号载荷——保留预检只为与 `selectRun` 的落地顺序一致
 * （先拒串号，再跑版本/schema 判定），两者的说明措辞可分辨。
 */
export function verifyResultPayload(
  requestedRunId: string,
  envelope: Envelope<unknown>,
): ResultVerification {
  if (!envelope.ok) {
    return unreadable(`结果读取失败（${envelope.error.code}）：${envelope.error.message}`);
  }
  if (!isDetailPayloadForRun(envelope.data, requestedRunId)) {
    return unreadable("结果详情归属校验失败（载荷与请求的 run 不一致）：拒绝采信");
  }
  const versionViolation = findRunDetailVersionViolation(envelope.data);
  if (versionViolation !== null) {
    return unreadable(`结果详情版本校验失败：${versionViolation}`);
  }
  const parsed = RunDetailSchema.safeParse(envelope.data);
  if (!parsed.success) {
    return unreadable(`结果详情结构校验失败：${parsed.error.issues[0]?.message ?? "未知结构错误"}`);
  }
  const identityViolation = findResultIdentityViolation({
    requestedRunId,
    detail: parsed.data,
  });
  if (identityViolation !== null) {
    return unreadable(`结果详情身份核对失败：${identityViolation}`);
  }
  return { ok: true, detail: parsed.data, facts: deriveOwnTerminalFacts(parsed.data) };
}

/**
 * 把核对结论收敛成读取项（本文件唯一的构造口，store 与测试同源）。
 * `attempt` 由读取调度给出（见 `beginResultRead`），构造口不自己数次数。
 */
export function resultReadEntryOf(
  verification: ResultVerification,
  attempt: number,
): ResultReadEntry {
  return verification.ok
    ? { phase: "verified", attempt, facts: verification.facts, reason: null }
    : { phase: "unreadable", attempt, facts: null, reason: verification.reason };
}

/** 一次实际读取的开始：代次在此递增（`reading` 占位让重复快照能识别"已经在读"） */
export interface BeginResultRead {
  readonly store: ResultReadStore;
  readonly attempt: number;
}

export function beginResultRead(
  store: ResultReadStore,
  identity: ResultReadIdentity,
): BeginResultRead {
  const attempt = (resultReadOf(store, identity)?.attempt ?? 0) + 1;
  return {
    store: setResultRead(store, identity, { phase: "reading", attempt, facts: null, reason: null }),
    attempt,
  };
}

/**
 * 落地一次读取结论，**只认当代代次**（任务 1.3「旧读取响应不能污染其他结果」）。
 *
 * 期间同键又发起过新读取（`attempt` 已经前进）⇒ 整份丢弃：既不覆盖新读取的结论，
 * 也不动其他键的条目，更不清别的草稿。引用原样返回，调用方因此不必判断"有没有变化"。
 */
export function finishResultRead(
  store: ResultReadStore,
  identity: ResultReadIdentity,
  attempt: number,
  verification: ResultVerification,
): ResultReadStore {
  const current = resultReadOf(store, identity);
  if (current === undefined || current.attempt !== attempt) return store;
  return setResultRead(store, identity, resultReadEntryOf(verification, attempt));
}

/** 该读取项是否已经在读或已核实（重复快照据此**不再**发起第二次读取） */
export function resultReadAlreadySettledOrInFlight(entry: ResultReadEntry | undefined): boolean {
  return entry !== undefined && (entry.phase === "reading" || entry.phase === "verified");
}

// ---------------------------------------------------------------------------
// 操作 → 结果呈现（design D4 表格的读取侧半边）
//
// ⚠️ "未定位"与"本次未接受"都是**记录级**事实：前者根本没有可信 runId 可当键，
//    后者按 U4 契约不关联任何运行身份。两者都不得从邻近记录、列表最新项或
//    错误文案里猜出结果，也不存在"核实成功"的路径。
// ---------------------------------------------------------------------------

/** 单条可信运行 id 的读取结论；`entry` 为 undefined = 尚未读过 */
export interface ResultItemView {
  readonly runId: string;
  readonly entry: ResultReadEntry | undefined;
}

/** 一次操作的结果呈现 */
export type OperationResultView =
  | { readonly kind: "running" }
  | { readonly kind: "not-accepted"; readonly rejection: NotAcceptedReason | null }
  | { readonly kind: "unlocated" }
  | { readonly kind: "results"; readonly items: readonly ResultItemView[] };

/**
 * 由登记记录 + 读取项派生结果呈现。
 *
 * 只读，不发请求：`settled` 且 `runIds` 非空 ⇒ 逐条给出「未读 / 读取中 / 已核实 / 不可读」；
 * `settled` 且 `runIds` 为空 ⇒ `unlocated`（界面据此提示"核对登记"，不给结果链接）。
 */
export function viewOperationResult(
  record: OperationRecord,
  store: ResultReadStore,
): OperationResultView {
  const identityOf = (runId: string): ResultReadIdentity => ({
    epoch: record.epoch,
    operationId: record.operationId,
    runId,
  });
  switch (record.state) {
    case "running":
      return { kind: "running" };
    case "notAccepted":
      return { kind: "not-accepted", rejection: record.rejection };
    case "settled": {
      if (record.runIds.length === 0) return { kind: "unlocated" };
      return {
        kind: "results",
        items: record.runIds.map((runId) => ({
          runId,
          entry: resultReadOf(store, identityOf(runId)),
        })),
      };
    }
  }
}

/** 会话内读取项集合：键见 `resultReadKeyOf`；只存 renderer 内存，不落盘/不进 URL/不进日志 */
export interface ResultReadStore {
  readonly byKey: Readonly<Record<string, ResultReadEntry>>;
}

export function emptyResultReadStore(): ResultReadStore {
  return { byKey: {} };
}

/** 写入/覆盖一条读取结论（不可变更新：引用不变时调用方不必重渲染） */
export function setResultRead(
  store: ResultReadStore,
  identity: ResultReadIdentity,
  entry: ResultReadEntry,
): ResultReadStore {
  return { byKey: { ...store.byKey, [resultReadKeyOf(identity)]: entry } };
}

/** 读某次核实的当前结论；从未核实过 ⇒ undefined（= 未读） */
export function resultReadOf(
  store: ResultReadStore,
  identity: ResultReadIdentity,
): ResultReadEntry | undefined {
  return store.byKey[resultReadKeyOf(identity)];
}
