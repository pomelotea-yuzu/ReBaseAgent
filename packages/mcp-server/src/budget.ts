import { RESPONSE_BUDGET_BYTES } from "./limits.js";
import type { ToolResult } from "./server.js";
import type { ToolPayload } from "./tool-definition.js";

/**
 * 完整工具结果的序列化预算（design D6 / S09/S10）。
 *
 * 量的是**客户端实际收到的 tool result**：`content` + `structuredContent` + `isError`，
 * 不是只量 `data`。`content` 里的 headline 与外层 `provenance/limitations/truncation`
 * 都算在内——只量正文会让"来源信息很长"的请求悄悄越界。
 *
 * 收窄由实现提供**单旋钮**：条目页按条数缩，正文页按码点数缩。两者不能同时缩的
 * 形态目前不存在；真出现时再扩展为二维搜索，不预先抽象。
 */

export interface ToolBudget {
  readonly kind: "items" | "chars";
  /** 已按请求上限裁过的当前规模（预算搜索起点） */
  readonly value: number;
  /** items 最小 1；chars 最小 0（0 = 只给范围/剩余，不发字符） */
  readonly minimum: number;
  /**
   * 以更小的规模重建 payload。必须**单调**：规模变小，结果字节不变或变小；
   * 且不得突破调用方请求的上限（实现内 clamp）。
   */
  readonly fit: (value: number) => ToolPayload;
  /** 最小规模仍装不下时的稳定定位（run/span/snapshot/path，不含物理路径） */
  readonly limitRef: string;
}

export type BudgetFit =
  | { readonly ok: true; readonly result: ToolResult }
  | { readonly ok: false; readonly ref: string };

/** 完整 tool result 的 UTF-8 字节数（`isError` 缺省按 false 计，保守多算几个字节） */
export function toolResultBytes(result: ToolResult): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    }),
    "utf8",
  );
}

/**
 * 把 payload 收进 64 KiB；返回结果或一个 RESPONSE_LIMIT 定位。
 *
 * 先量完整结果，超了才做二分：`fit(minimum)` 仍超 ⇒ 单项/固定段装不下，
 * 不删身份假称完整，交给调用方发 `RESPONSE_LIMIT`。搜索区间是 [minimum, value]，
 * 依赖 `fit` 的单调性（前缀条目/前缀码点只会更小）。
 */
export function fitWithinBudget(
  payload: ToolPayload,
  toResult: (candidate: ToolPayload) => ToolResult,
  fallbackRef: string,
): BudgetFit {
  const initial = toResult(payload);
  if (toolResultBytes(initial) <= RESPONSE_BUDGET_BYTES) return { ok: true, result: initial };

  const budget = payload.budget;
  if (budget === undefined) return { ok: false, ref: fallbackRef };

  const smallest = budget.fit(budget.minimum);
  if (toolResultBytes(toResult(smallest)) > RESPONSE_BUDGET_BYTES) {
    return { ok: false, ref: budget.limitRef };
  }

  let low = budget.minimum;
  let high = budget.value;
  let best = smallest;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = budget.fit(mid);
    if (toolResultBytes(toResult(candidate)) <= RESPONSE_BUDGET_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return { ok: true, result: toResult(best) };
}
