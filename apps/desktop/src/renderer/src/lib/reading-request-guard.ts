import type { WorkspaceReadFileResult } from "@shared/ipc";

/**
 * U2 任务 3.1：文件清单与两侧读取的**身份 / 代次守卫**（纯逻辑层，无 React）。
 *
 * 为什么需要它——C 时代的 `WorkspaceFileView` 只用了一个 `cancelled` 闭包布尔值：
 *
 * ```ts
 * let cancelled = false;
 * void inspectWorkspace(req).then(o => { if (cancelled) return; ... });
 * return () => { cancelled = true; };
 * ```
 *
 * 这个写法只能挡住**卸载后**的迟到响应，挡不住 delta 明文点名的两类：
 * 1. **同对象重试 / A→B→A 往返**：第二次请求是**新的闭包**（`cancelled` 重新为 `false`），
 *    于是旧 A 的响应依然能写回——它带着和新 A 完全相同的 run/step/path，
 *    "键相等"这种判据根本区分不出新旧，必须靠**单调递增的代次**。
 * 2. **finally 收尾覆盖新请求**：旧请求的 `finally { setLoading(false) }` 会把
 *    新请求刚置起的 loading 抹掉（delta「旧请求 finally 不清除新 loading」）。
 *
 * 因此本模块把"这次响应还算不算数"抽成**一个显式对象**，调用方每次发起请求
 * `begin()` 一次、回来时 `accept(token)` 判定；判定失败则**什么都不写**（不是写别的东西）。
 *
 * ⚠️ 本模块**不做 IO、不持有 React 状态**——它只负责"谁是最新一代"这一件事。
 *    真正的写入仍发生在组件里，且**必须**先过 `accept`。
 */

/**
 * 一次请求的身份：run/step/path/侧 + 全局单调代次。
 *
 * - `key` 是"逻辑上同一个对象"的稳定标识（同 run 同 step 同 path 同一侧）；
 * - `generation` 在**每次** `begin` 时全局递增 ⇒ **同 key 的重试也有不同代次**，
 *   这正是"不能因 run/step/path 相同就接受旧结果"的实现。
 */
export interface RequestToken {
  readonly key: string;
  readonly generation: number;
  /** 该请求属于哪一侧：`"list"` 清单 / `"initial"` 初始快照侧 / `"selected"` 所选检查点侧 */
  readonly side: ReadingRequestSide;
}

export type ReadingRequestSide = "list" | "initial" | "selected";

/**
 * 请求身份守卫：**每个读写面各持一个实例**（清单 / 初始侧 / 所选侧），互不影响。
 *
 * 为什么按面拆开而不是共用一个全局计数器：delta 要求「清单和内容 SHALL 分别维护加载、
 * 成功和失败」「清单和内容可独立重试」——共用计数器会让"读文件内容"把"读清单"的代次
 * 顶掉（或反之）。而同一个面内部用同一个计数器单调递增就足够了。
 */
export class RequestGuard {
  #latest = 0;
  #current: RequestToken | null = null;

  /**
   * 发起一次请求：递增代次并返回本次的身份。返回的 token 必须在响应回来时
   * 原样交给 `accept` —— 不要重新构造。
   */
  begin(side: ReadingRequestSide, key: string): RequestToken {
    this.#latest += 1;
    const token: RequestToken = { key, generation: this.#latest, side };
    this.#current = token;
    return token;
  }

  /**
   * 这次响应还算数吗？
   *
   * 判据是 `generation` **全等**于当前最新一次 `begin` 的代次——比"key 相等"更严：
   * 同 key 的旧请求（A→B→A 的第一次 A、或连续重试的前一次）代次更小，一律不接受。
   */
  accept(token: RequestToken): boolean {
    return this.#current !== null && token.generation === this.#current.generation;
  }

  /** 主动作废（例如选择被清空后不该再显示旧内容）。作废后所有在飞 token 都不再被接受。 */
  invalidate(): void {
    this.#latest += 1;
    this.#current = null;
  }

  /** 当前最新代次（仅测试/诊断用） */
  get generation(): number {
    return this.#latest;
  }
}

/** 一侧的读取状态：**加载 / 成功 / 失败**分别维护（delta 明文），互不冒充。 */
export type SideReadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly result: WorkspaceReadFileResult }
  /**
   * 通道失败（IPC 拒绝 / schema 不合法）——与"结果本身是 missing/binary"是**两回事**：
   * 前者连结果都拿不到，后者拿到了真实事实。二者都不得被当作"文件不存在"。
   */
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/** 清单状态：同样三态，另加"结果为空清单"由 `ok` + `fileCount === 0` 表达（不另立空态）。 */
export type ListReadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly result: import("@shared/ipc").WorkspaceInspectResult }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/**
 * 把一次"发起 + 响应 + 收尾"折进状态更新的**唯一收口**。
 *
 * 调用方（组件）不再手写 `if (cancelled) return;` / `finally { setLoading(false) }`，
 * 而是：
 *
 * ```ts
 * const guard = new RequestGuard();
 * const token = guard.begin("selected", key);
 * setState({ kind: "loading" });
 * void read(...).then(outcome => {
 *   if (!guard.accept(token)) return;          // 旧代次：一个字节都不写
 *   setState(outcome.ok ? {kind:"ok",...} : {kind:"failed",...});
 * });
 * ```
 *
 * 本函数只负责**判定后的状态**，供组件与测试复用同一判据——避免"组件里另写一套
 * 判定"（U1 反复出现的两处判据分叉）。
 */
export function settleList(
  guard: RequestGuard,
  token: RequestToken,
  outcome:
    | { ok: true; data: import("@shared/ipc").WorkspaceInspectResult }
    | { ok: false; code: string; message: string },
): ListReadState | null {
  if (!guard.accept(token)) return null;
  return outcome.ok
    ? { kind: "ok", result: outcome.data }
    : { kind: "failed", code: outcome.code, message: outcome.message };
}

export function settleSide(
  guard: RequestGuard,
  token: RequestToken,
  outcome:
    | { ok: true; data: WorkspaceReadFileResult }
    | { ok: false; code: string; message: string },
): SideReadState | null {
  if (!guard.accept(token)) return null;
  return outcome.ok
    ? { kind: "ok", result: outcome.data }
    : { kind: "failed", code: outcome.code, message: outcome.message };
}

/**
 * 从一侧状态取"读到的结果"，**只为真的成功时**给；其余（含失败）一律 `null`。
 *
 * ⚠️ 这里返回的 `null` 语义是「**没有可用的读取结果**」，**不是**「文件不存在」——
 *    调用方绝不可把它折成 `not_found`（3.2 要消除的正是这种 null 等同不存在）。
 *    文件是否不存在由 `result.status === "not_found"` 表达。
 */
export function sideResult(state: SideReadState): WorkspaceReadFileResult | null {
  return state.kind === "ok" ? state.result : null;
}

/** 该侧是否处于加载中（供 UI 显示 loading，且**不被旧请求 finally 清掉**）。 */
export function sideLoading(state: SideReadState): boolean {
  return state.kind === "loading";
}

/** 该侧是否通道失败（区别于结果层的 missing/binary/not_found）。 */
export function sideFailed(state: SideReadState): boolean {
  return state.kind === "failed";
}
