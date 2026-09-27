import { isDetailPayloadForRun } from "@shared/detail-request";
import { findRunDetailVersionViolation } from "@shared/detail-version-guard";
import type { Envelope, RunDetail } from "@shared/ipc";
import { RunDetailSchema } from "@shared/ipc";
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
  /** `verified` = 详情已通过全部核对；`unreadable` = 执行已结束但结果不可读/未定位 */
  readonly phase: "verified" | "unreadable";
  /** 经校验的自有终止事实；不可读时为 null（不造结论） */
  readonly facts: OwnTerminalFacts | null;
  /** 不可读的诚实说明（含原诊断）；已核实时为 null */
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

/** 把核对结论收敛成读取项（本文件唯一的构造口，store 与测试同源） */
export function resultReadEntryOf(verification: ResultVerification): ResultReadEntry {
  return verification.ok
    ? { phase: "verified", facts: verification.facts, reason: null }
    : { phase: "unreadable", facts: null, reason: verification.reason };
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
