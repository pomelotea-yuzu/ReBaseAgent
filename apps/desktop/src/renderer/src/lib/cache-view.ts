/**
 * 缓存命中展示判据（spec `desktop-ui`「缓存命中可视化」）。
 *
 * 本模块把原先内联在 `DetailPanel.CacheHitRow` 里的判据抽出来，使它变成**可断言对象**：
 * 之前那段逻辑长在组件内部、无法在无 jsdom 的本包里单独喂数据，等于没有判据（改错不红）。
 *
 * 三条不许含糊（spec 原文）：
 *   1. **存在性不是 truthiness**：`cache_hit: 0` 是「本次全量计费」——恰是最该被看见的一态；
 *      用 `if (hit)` 会把它静默吞掉。只有**字段缺失**（老 trace / 不支持缓存的 provider）
 *      才整行省略，且**不显示 0**（未知 ≠ 零命中）。
 *   2. **`in === 0` 不做除法**：只展示绝对 tokens；不显示 `0%` 这类无效比例。
 *   3. **措辞按命中量分档**：只有 `hit === 0` 才叫「全量计费」；少量命中不得被写成全量
 *      （spec 场景「少量命中不得被称为全量计费」显式要求区分）。
 */

/** 缓存命中行的展示形态；`null` = 不展示（字段缺失，降级省略） */
export interface CacheHitView {
  /** 判据来源：`cache_hit` 字段确实存在（含 `0`） */
  hit: number;
  /** 输入总量（`usage.in`） */
  input: number;
  /** clamp 后实际展示的命中数（异常数据按输入总量截断，不显示超 100%） */
  shownHit: number;
  /** 占比百分数；`in === 0` 时为 null（不做除法，只给绝对 tokens） */
  percent: number | null;
  /**
   * 展示调性：
   * - `"effective"`：命中为主（占比 ≥ 50%）——前缀缓存生效，本次调用省钱；
   * - `"partial"`：有命中但不是主力——多数输入仍按全价计费；
   * - `"full"`：零命中——全量计费。
   * 三档互斥，语义不同，不得合并（`"full"` 与 `"partial"` 合并就是把 0 与"少量"混为一谈）。
   */
  tone: "effective" | "partial" | "full";
  /** 结论文案（唯一文案来源，不得在 JSX 里另写一版） */
  verdict: string;
  /** 异常口径数据的显式标注（`cache_hit > in`）；正常为 null */
  abnormalNote: string | null;
}

/** 判「命中为主」的占比门槛（spec 用「视觉强调区分命中为主与全量计费」，此处取 50%） */
export const CACHE_EFFECTIVE_PERCENT = 50;

/**
 * 由 llm.call 的 usage 算出缓存命中行显示什么；字段缺失返回 null（降级省略）。
 *
 * ⚠️ **判据是 `!== undefined` 而不是 `if (hit)`**——`0` 是有值，必须照常展示。
 */
export function presentCacheHit(usage: {
  in: number;
  cache_hit?: number;
}): CacheHitView | null {
  const hit = usage.cache_hit;
  if (hit === undefined) return null;

  // 异常口径数据（命中数 > 输入总量）：按输入总量截断并显式标注，不显示负值 / 超 100%
  const abnormal = hit > usage.in;
  const shownHit = abnormal ? usage.in : hit;
  // in === 0 时不做除法（防 0/0），只展示绝对 tokens
  const percent = usage.in > 0 ? Math.round((shownHit / usage.in) * 100) : null;

  const tone: CacheHitView["tone"] =
    hit === 0 ? "full" : (percent ?? 0) >= CACHE_EFFECTIVE_PERCENT ? "effective" : "partial";
  const verdict =
    tone === "full"
      ? "全量计费（无命中）"
      : tone === "effective"
        ? "前缀缓存生效，本次调用省钱"
        : "部分命中，多数输入仍按全价计费";

  return {
    hit,
    input: usage.in,
    shownHit,
    percent,
    tone,
    verdict,
    abnormalNote: abnormal ? "⚠️ 命中数大于输入总量，已按输入总量截断（数据异常）" : null,
  };
}

/** 命中/未命中绝对值；`cache_miss` 缺失时为 null（未知 ≠ 0） */
export function presentCacheMiss(usage: { cache_miss?: number }): number | null {
  return usage.cache_miss === undefined ? null : usage.cache_miss;
}
