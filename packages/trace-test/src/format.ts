/** 报告值格式化：脱敏 + 截断（2.4：失败摘要默认截断且不落敏感原文） */

/** 脱敏 JSON 值：键名命中 redact 列表（不区分大小写）的字符串值以 "***" 代替 */
export function redactValue(value: unknown, redactKeys: readonly string[]): unknown {
  if (redactKeys.length === 0) {
    return value;
  }
  const lower = new Set(redactKeys.map((k) => k.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = lower.has(k.toLowerCase()) ? "***" : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** 单值格式化：JSON 序列化（经脱敏）+ 截断，保证报告行宽稳定 */
export function formatValue(
  value: unknown,
  redactKeys: readonly string[] = [],
  maxLen = 200,
): string {
  const text = JSON.stringify(redactValue(value, redactKeys)) ?? String(value);
  return truncate(text, maxLen);
}

export function truncate(text: string, maxLen = 200): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…（截断，共 ${text.length} 字符）`;
}

/** 结构化深比较（断言 equals 用；与形状比较不同，这里要求值完全相等） */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && a !== null && b !== null) {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const ka = Object.keys(oa);
    const kb = Object.keys(ob);
    if (ka.length !== kb.length) {
      return false;
    }
    return ka.every((k) => deepEqual(oa[k], ob[k]));
  }
  return false;
}
