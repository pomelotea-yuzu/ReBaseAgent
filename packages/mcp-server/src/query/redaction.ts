/**
 * 结构正文的已知凭据过滤（design D7 / S11）。
 *
 * 边界刻意窄，三条都不是"偷懒"而是契约：
 * - **只认结构字段名与可判定的端点 userinfo**：递归遍历对象/数组，键名归一后命中
 *   封闭清单才整值替换；整串是绝对 URL 且带 userinfo 时只换 userinfo。
 * - **不解析、不改写自由文本**：消息正文、工具结果里的普通字符串、以及
 *   `function.arguments` 这类「JSON 编码在字符串里」的值一律原样保留。把它们拆开
 *   重排就是通用解析/重写，既改动了历史记录，也兑现不了"彻底脱敏"的承诺。
 * - **历史文件原文不经过这里**：文件读取走 `read_checkpoint_file` 的逐字节通道，
 *   只保留原始文本与完整文件哈希（D7）。
 *
 * 替换发生在**规范 JSON 之前**：外发正文的范围/总码点因此描述的是过滤后的文本
 * （design D6），客户端不会拿"原文校验值"去对一份已改过的片段。
 */

/** 已知凭据字段被替换后的标记（限制项文案与测试共用同一字面量） */
export const REDACTED_MARKER = "[REDACTED]";

/**
 * 凭据字段名的封闭清单（**归一后**比较：小写并去掉 `-` `_` 与空白）。
 *
 * 归一让 `api_key` / `api-key` / `apiKey` / `APIKEY` 落进同一条；清单只收
 * 含义明确属于凭据的字段，`max_tokens` / `token_count` / `author` 这类不会命中。
 * 新增名字必须同时改这里与设计文档，实现不得在别处另立一份。
 */
const CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "xapikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "token",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "credential",
  "credentials",
  "privatekey",
  "cookie",
  "setcookie",
]);

export function normalizeCredentialFieldName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

export function isCredentialFieldName(name: string): boolean {
  return CREDENTIAL_FIELD_NAMES.has(normalizeCredentialFieldName(name));
}

export interface RedactionResult {
  /** 过滤后的值；没有命中时就是入参本身（不做无谓拷贝） */
  readonly value: unknown;
  /** 被替换的字段/端点凭据个数（0 = 未发生过滤） */
  readonly redactedFields: number;
}

/**
 * 绝对 URL 的 userinfo 过滤。
 *
 * `https://user:pass@host/path` ⇒ `https://[REDACTED]@host/path`：保留端点形态
 * （客户端仍知道它指向哪个 host/path），只去掉凭据。不是完整绝对 URL 的字符串
 * 一律不动——那属于自由文本，不在本层承诺范围内。
 */
function redactUrlUserinfo(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    // 只为确认它是可解析的绝对 URL；不拿 URL 对象的规范化结果回写（那会重排原文）
    new URL(value);
  } catch {
    return null;
  }
  const schemeEnd = value.indexOf("://") + 3;
  let authorityEnd = value.length;
  for (const separator of ["/", "?", "#"]) {
    const index = value.indexOf(separator, schemeEnd);
    if (index >= 0 && index < authorityEnd) authorityEnd = index;
  }
  const authority = value.slice(schemeEnd, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at < 0) return null;
  return `${value.slice(0, schemeEnd)}${REDACTED_MARKER}${value.slice(schemeEnd + at)}`;
}

function redactValue(value: unknown, counter: { count: number }): unknown {
  if (typeof value === "string") {
    const redacted = redactUrlUserinfo(value);
    if (redacted === null) return value;
    counter.count += 1;
    return redacted;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactValue(item, counter);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      if (isCredentialFieldName(key)) {
        counter.count += 1;
        entries.push([key, REDACTED_MARKER]);
        changed = true;
        continue;
      }
      const redacted = redactValue(child, counter);
      if (redacted !== child) changed = true;
      entries.push([key, redacted]);
    }
    // Object.fromEntries 用 CreateDataProperty 落键，`__proto__` 这类键不会改原型
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

/** 过滤结构正文；返回过滤后的值与命中的字段个数（不修改入参） */
export function redactStructuredValue(value: unknown): RedactionResult {
  const counter = { count: 0 };
  return { value: redactValue(value, counter), redactedFields: counter.count };
}
