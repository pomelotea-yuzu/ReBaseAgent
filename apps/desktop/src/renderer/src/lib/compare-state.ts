import type { CompareRunItem, Envelope } from "@shared/ipc";
import {
  CompareRunsRequestSchema,
  CompareRunsResultSchema,
  findCompareResponseMismatch,
} from "@shared/ipc";

/**
 * U7（improve-branch-comparison）tasks 1.4/1.5：比较选择集的**会话读取状态**
 * （design D3 渲染层半边）。
 *
 * 与 U5 `resultReads` 的同一思路落到比较上，但粒度是**整个选择集**：
 * - 一次比较 = 对 1–4 个互异 run 的单次只读请求（main 共享读取上下文）；
 * - **选择集代次**（`generation`）：每次选择变更 / 显式重试 / 离开比较都递增，
 *   响应只认同代次同选择集的在飞请求 ⇒ 快速更换、交换、移出、离开时
 *   迟到的旧响应整份丢弃（场景「快速更换交换移出不串内容」）；
 * - **结论撤销先行**：进入新读取的那一刻旧结论就被清掉——刷新明确撤销旧比较
 *   结论后再展示新结论，不把旧成功当本次成功（场景「比较重试恢复必须全量重验」）；
 * - **响应双核对**：schema（CompareRunsResultSchema）+ 与请求的有序身份集比对
 *   （findCompareResponseMismatch），任一不符整份拒绝，绝无半截采信；
 * - 只读：整条路径只走 `runs:compare`，零执行通道、零列表刷新、零草稿/授权变更。
 *
 * 选择集阅读状态（每侧滚动/页签/调用定位）属 §2 的 pair 状态，不在这里。
 */

/** 当前活动比较的一次结论（`generation`/`runIds` 标明它属于哪次读取） */
export type CompareConclusion =
  | {
      readonly generation: number;
      readonly runIds: readonly string[];
      readonly kind: "verified";
      /** 逐项结论，顺序恒等于请求顺序（ready 含 detail+chainSummaries） */
      readonly items: readonly CompareRunItem[];
    }
  | {
      readonly generation: number;
      readonly runIds: readonly string[];
      readonly kind: "rejected";
      /** 请求级稳定码（信封错误码 / 载荷错配受控码） */
      readonly code: string;
      /** 受控中文原因（不暴露路径/凭据） */
      readonly reason: string;
    };

export interface CompareReadSession {
  /**
   * 当前活动选择集（有序互异，1–4）；null = 不在比较。
   * 顺序即左右语义的输入（§2 消费），本模块只保序不改序。
   */
  readonly selection: readonly string[] | null;
  /** 选择集代次：单调递增、永不复用 ⇒ 「离开再返回」不复用旧结论 */
  readonly generation: number;
  /** 在飞请求（同代次同选择集的响应才被采信）；null = 无在飞（迟到响应必被丢弃） */
  readonly request: { readonly generation: number; readonly runIds: readonly string[] } | null;
  /** 当代结论；进入新读取/重试/离开即撤销（先行清空，不等新结论就绪） */
  readonly conclusion: CompareConclusion | null;
}

export function emptyCompareReadSession(): CompareReadSession {
  return { selection: null, generation: 0, request: null, conclusion: null };
}

/**
 * 选择集合法性（与 CompareRunsRequestSchema 数量/唯一/非空同源——直接复用
 * schema 判定，不抄第二份判据）。返回首条受控原因；null = 合法。
 */
export function findCompareSelectionViolation(runIds: readonly string[]): string | null {
  const parsed = CompareRunsRequestSchema.safeParse({ runIds: [...runIds] });
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "比较请求不合法";
}

/** 两个选择集是否同一份（同序同 id 才算同一——顺序是左右语义的一部分） */
export function sameCompareSelection(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * 进入/更换比较对象：换集即发起新读取（旧结论撤销、在飞请求被代次淘汰）。
 * 调用方须先用 `findCompareSelectionViolation` 确认合法；本函数不重复校验。
 */
export function beginCompareRead(
  state: CompareReadSession,
  runIds: readonly string[],
): CompareReadSession {
  const generation = state.generation + 1;
  const selection = [...runIds];
  return {
    selection,
    generation,
    request: { generation, runIds: selection },
    conclusion: null,
  };
}

/**
 * 显式重试：**同选择集**全量重读（design D3「重试重新读取整组选中对象以保持
 * 共同基线一致」）。无活动选择集 ⇒ null（无可重试，调用方不得伪造请求）。
 */
export function retryCompareRead(state: CompareReadSession): CompareReadSession | null {
  if (state.selection === null) return null;
  return beginCompareRead(state, state.selection);
}

/** 离开比较（销毁守卫）：在飞请求作废、结论清空；代次仍递增 ⇒ 迟到响应永不复活 */
export function destroyCompareRead(state: CompareReadSession): CompareReadSession {
  return {
    selection: null,
    generation: state.generation + 1,
    request: null,
    conclusion: null,
  };
}

/** 载荷/错配拒绝的受控码（与 main 的稳定码并列，renderer 侧自有两枚） */
export const COMPARE_PAYLOAD_INVALID = "COMPARE_PAYLOAD_INVALID";
export const COMPARE_RESPONSE_MISMATCH = "COMPARE_RESPONSE_MISMATCH";

/**
 * 应用一次比较响应：**只认同代次同选择集的在飞请求**。
 *
 * 迟到（代次不符）、串号（选择集不符）、无主（request 已被销毁/替换清空）的
 * 响应整份丢弃——引用原样返回，绝不覆盖新读取或当前结论。
 * 请求级失败（信封 fail / 载荷不合法 / 与请求错配）都收敛为 rejected 结论：
 * 不伪空文本、不借另一对象顶替、不降级 ownOnly。
 */
export function applyCompareResponse(
  state: CompareReadSession,
  generation: number,
  runIds: readonly string[],
  envelope: Envelope<unknown>,
): CompareReadSession {
  const request = state.request;
  if (
    request === null ||
    request.generation !== generation ||
    !sameCompareSelection(request.runIds, runIds)
  ) {
    return state;
  }

  let conclusion: CompareConclusion;
  if (!envelope.ok) {
    conclusion = {
      generation,
      runIds: request.runIds,
      kind: "rejected",
      code: envelope.error.code,
      reason: envelope.error.message,
    };
  } else {
    const parsed = CompareRunsResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      conclusion = {
        generation,
        runIds: request.runIds,
        kind: "rejected",
        code: COMPARE_PAYLOAD_INVALID,
        reason: `比较载荷结构校验失败：${parsed.error.issues[0]?.message ?? "未知结构错误"}`,
      };
    } else {
      const mismatch = findCompareResponseMismatch(request.runIds, parsed.data);
      if (mismatch !== null) {
        conclusion = {
          generation,
          runIds: request.runIds,
          kind: "rejected",
          code: COMPARE_RESPONSE_MISMATCH,
          reason: `比较响应与请求不符：${mismatch}`,
        };
      } else {
        conclusion = {
          generation,
          runIds: request.runIds,
          kind: "verified",
          items: parsed.data.items,
        };
      }
    }
  }

  // 结论落地即在飞出清：同一代次不会有第二次响应（重试/更换都会推进代次）
  return { ...state, request: null, conclusion };
}
