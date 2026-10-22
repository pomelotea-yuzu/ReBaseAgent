/**
 * 白名单判据的共用件。
 *
 * 「这个字段没外发」必须按**对象键**判，不能按子串搜：`editField: "result"` 的值里
 * 天然含 "result"，子串搜会把它读成泄漏（也可能反过来——把真正的泄漏读成巧合）。
 */
export function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/** 正文类键的封闭清单：任何一条查询结果里都不该出现（design D5/D7） */
export const FORBIDDEN_KEYS: readonly string[] = [
  "messages",
  "role",
  "content",
  "reasoning_content",
  "tool_calls",
  "request",
  "response",
  "args",
  "value",
  "result",
  "hypothesis",
  "acceptance_criterion",
  "original_value",
  "provider_endpoint",
  "base_url",
  "params",
  "path",
  "dataDir",
  "tracesDir",
];

export function assertNoForbiddenKeys(value: unknown, extra?: readonly string[]): Set<string> {
  const keys = collectKeys(value);
  for (const forbidden of [...FORBIDDEN_KEYS, ...(extra ?? [])]) {
    if (keys.has(forbidden)) {
      throw new Error(`白名单外泄：结果里出现了键「${forbidden}」`);
    }
  }
  return keys;
}

/** 正文 canary：夹具里凡是正文类字段都带 SENTINEL- 前缀，序列化后一个都不该出现 */
export function assertNoSentinels(serialized: string): void {
  if (serialized.includes("SENTINEL-")) {
    const index = serialized.indexOf("SENTINEL-");
    throw new Error(`白名单外泄：结果里出现了夹具正文「${serialized.slice(index, index + 40)}」`);
  }
}
