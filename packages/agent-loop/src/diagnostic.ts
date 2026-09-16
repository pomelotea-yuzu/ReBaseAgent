/**
 * LLM 失败诊断文本的**唯一**加工入口（归一化 / 脱敏 / 限长）。
 *
 * 本模块是零依赖纯函数集合：不 import `llm-client.js`（避免与客户端形成循环依赖），
 * 不读全局 settings、不依赖 Electron 或任何进程环境——内置客户端、loop 落盘路径
 * 与保留的日志全部复用同一实现（同一语义只写一处；历史上同一套规则写两遍必然跑偏）。
 *
 * 顺序铁律：**先脱敏、后截断**。先把完整文本里的凭据换成占位，再按统一上限截断——
 * 反过来做会让密钥只剩前缀、无法按完整值替换，残留可识别片段。
 */

/** 取不到有效诊断文本时的固定兜底文案（同样经过脱敏与限长） */
export const GENERIC_LLM_FAILURE = "LLM 调用失败，未提供有效错误信息";

/** 诊断文本长度上限：1024 个 UTF-16 代码单元，**含截断标记** */
export const DIAGNOSTIC_MAX_LENGTH = 1024;

/** 截断标记（6 个代码单元，计入上限） */
export const TRUNCATION_MARKER = "…[已截断]";

/** 凭据被替换后的占位文本 */
export const REDACTION_PLACEHOLDER = "[已脱敏]";

/**
 * 归一化：从任意抛出物取出候选诊断文本（**未脱敏**）。
 *
 * - `Error` → `message`；字符串 → 原值；
 * - 其他值 → `String(e)`，**用 try/catch 包住**（`Symbol` 等转换会抛）；不序列化任意对象
 *   （不 `JSON.stringify`，那会把未知对象结构搬进 trace）；
 * - `trim()` 后为空串、`"undefined"`、`"null"`、`"[object Object]"`（`String()` 的标准垃圾产物，
 *   非空但无诊断价值）→ 使用固定兜底文案；
 * - 本函数**绝不抛错**：归一化失败会连带丢掉整条终止记录，代价远大于缺一段文案。
 */
export function normalizeFailureText(e: unknown): string {
  if (e instanceof Error) return usable(e.message);
  if (typeof e === "string") return usable(e);
  let converted: string;
  try {
    converted = String(e);
  } catch {
    return GENERIC_LLM_FAILURE;
  }
  return usable(converted);
}

/** 无诊断价值的字符串（`String()` 标准产物）与空串统一兜底 */
const USELESS_TEXTS = new Set(["", "undefined", "null", "[object Object]"]);

function usable(text: string): string {
  const trimmed = text.trim();
  return USELESS_TEXTS.has(trimmed) ? GENERIC_LLM_FAILURE : trimmed;
}

/**
 * 本次运行的已知 secrets。
 *
 * 来源只有两处（不读全局 settings）：
 * - 非空的 `config.apiKey`；
 * - `config.baseURL` 经 URL 解析出的 userinfo 凭据（`https://user:pass@host`）。
 *   baseURL 不是合法 URL 时**不做额外推断**（宁可不猜）。
 */
export function buildRedactionSecrets(input: {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
}): string[] {
  const secrets: string[] = [];
  const key = input.apiKey?.trim();
  if (key !== undefined && key.length > 0) secrets.push(key);

  const base = input.baseURL;
  if (typeof base === "string" && base.length > 0) {
    try {
      const url = new URL(base);
      if (url.password.length > 0) secrets.push(url.password);
      if (url.username.length > 0) secrets.push(url.username);
    } catch {
      // 非 URL：不猜
    }
  }
  // 去重：user/pass 相同或 key 与凭据重合时不重复替换
  return [...new Set(secrets)];
}

/**
 * `Bearer <token>` / `Authorization: <value>` / URL 内嵌凭据的通用规则。
 * Authorization 规则**先于** Bearer 规则执行（否则头部里的 `Bearer xxx` 会先被
 * 换成占位，随后的 Authorization 规则会把占位再替换一次、留下重复片段）；
 * 头部规则保留 `Authorization:` 键名与 `Bearer` 前缀，只换值。
 */
const AUTH_HEADER_PATTERN = /(authorization\s*[:=]\s*)(bearer\s+)?([^\s,;"')]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s,;"')]+/gi;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;

/**
 * 脱敏：已知 secret 字面量 + 通用凭据规则。
 *
 * 字面量替换用 `split`/`join`（不是正则）——secret 含正则元字符时正则方案会错。
 * **不做长度门槛**：短的假 key 最多让文案变难看，漏掉真凭据才是事故（宁可过度脱敏）。
 * 不承诺识别任意业务文本中的所有秘密（provider 哈希回显、用户自行粘进 prompt 的凭据等）。
 */
export function redactDiagnosticText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(REDACTION_PLACEHOLDER);
  }
  return out
    .replace(URL_USERINFO_PATTERN, `$1${REDACTION_PLACEHOLDER}@`)
    .replace(AUTH_HEADER_PATTERN, `$1$2${REDACTION_PLACEHOLDER}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTION_PLACEHOLDER}`);
}

/**
 * 限长：超过上限时截断并追加截断标记（标记计入上限）。
 * 幂等——已满足上限的文本再调用逐字节不变（客户端脱敏结果再经 loop 兜底不会二次变形）。
 */
export function limitDiagnosticText(text: string, max: number = DIAGNOSTIC_MAX_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/**
 * 对外唯一组合入口：脱敏 → 限长。所有落盘/日志/界面可见的诊断文本都必须经过它。
 * 幂等（脱敏是替换、限长已幂等），因此"客户端处理 + loop 兜底"是安全的。
 */
export function sanitizeDiagnosticText(
  text: string,
  secrets: readonly string[] = [],
  max: number = DIAGNOSTIC_MAX_LENGTH,
): string {
  return limitDiagnosticText(redactDiagnosticText(text, secrets), max);
}
