/**
 * 代理失败诊断文本的**唯一**加工入口（脱敏 / 限长），零依赖纯函数集合。
 *
 * ## 为什么自己写一份而不复用 `agent-loop/diagnostic.ts`
 *
 * delta 明写：「采用内部纯 helper 保持 llm-proxy 零 Electron/零 agent-loop 依赖」。
 * `llm-proxy` 的依赖只有 `eventsource-parser`；为了脱敏而引入 agent-loop
 * 会把 trace-sdk/zod 一起拖进这条最窄的转发路径 —— 代价不对称。
 * 因此这里是**独立实现**，规则与 agent-loop 保持一致，并由 desktop 的集成测试
 * （tasks 3.1b）把两边的上限与脱敏/限长边界输入钉在一起，防止单边漂移。
 *
 * ## 顺序铁律：先脱敏、后截断
 *
 * 先把完整文本里的凭据换成占位，再截断。反过来做会让密钥只剩前缀、
 * 无法按完整值替换，残留可识别片段 —— 那等于脱敏失效。
 */

/** 取不到有效诊断文本时的固定兜底文案（同样经过脱敏与限长） */
export const GENERIC_PROXY_FAILURE = "上游请求失败，未提供有效错误信息";

/**
 * 诊断文本长度上限：1024 个 UTF-16 代码单元，**含截断标记**。
 *
 * ⚠️ 与 agent-loop 的 `DIAGNOSTIC_MAX_LENGTH` 数值必须相同（delta「1024 字符上限」）。
 * 这里**刻意不 import 那个常量**（会引入包依赖），改由 desktop 集成测试
 * 断言两者相等 —— 让「等值」成为被验证的事实而不是注释里的承诺。
 */
export const PROXY_DIAGNOSTIC_MAX_LENGTH = 1024;

/** 截断标记（6 个代码单元，计入上限） */
export const TRUNCATION_MARKER = "…[已截断]";

/** 凭据被替换后的占位文本 */
export const REDACTION_PLACEHOLDER = "[已脱敏]";

/** 无诊断价值的字符串（`String()` 标准产物）与空串统一兜底 */
const USELESS_TEXTS = new Set(["", "undefined", "null", "[object Object]"]);

/**
 * 归一化：从任意抛出物 / 任意响应片段取出候选诊断文本（**未脱敏、未限长**）。
 *
 * 绝不抛错：归一化失败会连带丢掉整条终止记录，代价远大于缺一段文案。
 * 不 `JSON.stringify` 未知对象（那会把未知结构搬进 trace）。
 */
export function normalizeProxyFailureText(value: unknown): string {
  if (value instanceof Error) return usable(value.message);
  if (typeof value === "string") return usable(value);
  let converted: string;
  try {
    converted = String(value);
  } catch {
    return GENERIC_PROXY_FAILURE;
  }
  return usable(converted);
}

function usable(text: string): string {
  const trimmed = text.trim();
  return USELESS_TEXTS.has(trimmed) ? GENERIC_PROXY_FAILURE : trimmed;
}

/**
 * 从 `Authorization` 头值里取出裸凭据（`Bearer sk-x` → `sk-x`）。
 *
 * 没有它时，只靠通用规则能干掉 `Bearer sk-x` 整段，但**裸 token 回显**
 * （`"key sk-x is invalid"` 这类服务商文案）会漏。delta 明确要求覆盖
 * 「已知凭据和通用凭据形式」，所以裸值也要进 secret 列表。
 */
export function credentialLiteralsOf(authorization: string | undefined): string[] {
  if (typeof authorization !== "string") return [];
  const trimmed = authorization.trim();
  if (trimmed.length === 0) return [];
  const bearer = /^bearer\s+(.+)$/iu.exec(trimmed);
  const bare = (bearer?.[1] ?? trimmed).trim();
  // 过短的"裸值"（如 `x`）会命中正文里任意同字符片段，把诊断糊成一堆占位。
  // 门槛取 8：真实 key 远长于此，而漏脱敏才是事故，宁可对极短假 key 过度脱敏。
  // 无 Bearer 前缀时 bare === trimmed，去重避免同一字面量替换两遍。
  const out = new Set<string>([trimmed]);
  if (bare.length >= 8 && bare !== trimmed) out.add(bare);
  return [...out];
}

/**
 * 通用凭据形式：`Authorization: <value>` / `Bearer <token>` / URL 内嵌 userinfo。
 *
 * Authorization 规则**先于** Bearer 执行（否则头部里的 `Bearer xxx` 会先被换成占位，
 * 随后的 Bearer 规则再替换一次、留下重复片段）。头部规则保留 `Authorization:` 键名
 * 与 `Bearer` 前缀，只换值。
 */
const AUTH_HEADER_PATTERN = /(authorization\s*[:=]\s*)(bearer\s+)?([^\s,;"')]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s,;"')]+/gi;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;

/**
 * 脱敏：已知 secret 字面量 + 通用凭据规则。
 *
 * 字面量替换用 `split`/`join`（不是正则）—— secret 含正则元字符时正则方案会错。
 * **不做长度门槛**（与 agent-loop 同纪律）：短的假 key 最多让文案变难看，
 * 漏掉真凭据才是事故。不承诺识别任意业务文本中的所有秘密（provider 哈希回显、
 * 用户自行粘进 prompt 的凭据等不在此列）。
 */
export function redactProxyDiagnosticText(text: string, secrets: readonly string[]): string {
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

/** 限长：超过上限时截断并追加截断标记（标记计入上限）。幂等。 */
export function limitProxyDiagnosticText(
  text: string,
  max: number = PROXY_DIAGNOSTIC_MAX_LENGTH,
): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/**
 * 对外唯一组合入口：脱敏 → 限长。
 *
 * 所有会进 trace / 日志 / IPC / 界面的代理诊断文本都必须经过它。
 * 幂等（脱敏是替换、限长已幂等），因此"包层处理 + main 写入兜底"叠加是安全的。
 */
export function sanitizeProxyDiagnosticText(
  text: string,
  secrets: readonly string[] = [],
  max: number = PROXY_DIAGNOSTIC_MAX_LENGTH,
): string {
  return limitProxyDiagnosticText(redactProxyDiagnosticText(text, secrets), max);
}

/**
 * 从非 2xx 响应体抽取摘要（delta「错误正文为空或无法解析」）。
 *
 * 三条判据（按优先级，只取第一条命中的）：
 * 1. JSON 且 `error.message` / `message` 是非空字符串 ⇒ 用它（provider 标准形状）；
 * 2. JSON 且 `error` 是非空字符串 ⇒ 用它；
 * 3. 非 JSON 但有可打印文本 ⇒ 给**限长**文本摘要（不整段塞进 trace）。
 *
 * 都不命中 ⇒ `null`，由调用方落到固定兜底文案。
 *
 * ⚠️ 本函数**不做脱敏与限长**（那是 `sanitizeProxyDiagnosticText` 的职责），
 * 但第3 条自带一个**粗**长度上限：非 JSON 正文可能是整页 HTML，
 * 先粗切再交给脱敏限长，避免把几十 KB 的 HTML 拖进正则。
 */
export function extractUpstreamErrorMessage(bodyText: string): string | null {
  const raw = bodyText.trim();
  if (raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 非 JSON：粗切后给有限文本摘要（HTML 错误页也只留开头）
    const coarse = raw.slice(0, 512);
    return USELESS_TEXTS.has(coarse.trim()) ? null : coarse;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const err = obj.error;
  if (typeof err === "object" && err !== null) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim().length > 0) return msg.trim();
  }
  if (typeof err === "string" && err.trim().length > 0) return err.trim();
  if (typeof obj.message === "string" && obj.message.trim().length > 0) return obj.message.trim();
  // JSON 但无可读文本（如 `{}` 或 `{"code":500}`）：不编造，交给兜底文案
  return null;
}
