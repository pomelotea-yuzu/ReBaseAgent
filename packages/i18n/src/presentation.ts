import type { MessageParams, Translator } from "./create-i18n.js";
import { type MessageKey, zhCN } from "./resources/index.js";

type ErrorCatalogKey = keyof typeof zhCN.errors;

/** 稳定展示 id；由 errors namespace 的键契约派生，不随 locale 变化。 */
export type PresentationId = `errors.${ErrorCatalogKey}`;

export const PRESENTATION_IDS = Object.keys(zhCN.errors).map(
  (key) => `errors.${key}`,
) as PresentationId[];

export type PresentationParam = string | number | boolean | readonly (string | number)[];

export interface PresentationMessage {
  readonly id: PresentationId;
  readonly params?: Readonly<Record<string, PresentationParam>>;
}

type ParamKind = "string" | "number" | "boolean" | "stringList" | "numberList";

interface ParamSpec {
  readonly kind: ParamKind;
  readonly maxLength?: number;
  readonly maxItems?: number;
}

const PARAM_SPECS: Record<PresentationId, Readonly<Record<string, ParamSpec>>> = {
  "errors.generic": {},
  "errors.invalidArgument": {
    field: { kind: "string", maxLength: 80 },
    fields: { kind: "stringList", maxItems: 4, maxLength: 40 },
    limit: { kind: "number" },
  },
  "errors.notFound": {
    kind: { kind: "string", maxLength: 32 },
    id: { kind: "string", maxLength: 128 },
  },
  "errors.unknownOperation": { operationId: { kind: "string", maxLength: 128 } },
  "errors.unsupported": { feature: { kind: "string", maxLength: 80 } },
  "errors.conflict": { operationId: { kind: "string", maxLength: 128 } },
  "errors.staleCursor": {},
  "errors.preparationRequired": {},
  "errors.createRunFailed": {},
  "errors.sourceChooseFailed": {},
};

const MAX_ITEMS = 8;
const MAX_ITEM_LENGTH = 80;
const MAX_STRING_LENGTH = 200;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasControlChars(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 参数边界明确拒绝控制字符
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && !hasControlChars(value);
}

function validateParam(value: unknown, spec: ParamSpec): boolean {
  switch (spec.kind) {
    case "string":
      return isBoundedString(value, spec.maxLength ?? MAX_STRING_LENGTH);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "stringList":
      return (
        Array.isArray(value) &&
        value.length <= (spec.maxItems ?? MAX_ITEMS) &&
        value.every((item) => isBoundedString(item, spec.maxLength ?? MAX_ITEM_LENGTH))
      );
    case "numberList":
      return (
        Array.isArray(value) &&
        value.length <= (spec.maxItems ?? MAX_ITEMS) &&
        value.every((item) => typeof item === "number" && Number.isFinite(item))
      );
  }
}

export type PresentationValidation =
  | { readonly ok: true; readonly value: PresentationMessage }
  | { readonly ok: false; readonly reason: string };

/** 严格校验受控描述：只接受内置 id、白名单参数与有界标量/集合。 */
export function validatePresentation(value: unknown): PresentationValidation {
  if (!isPlainRecord(value)) return { ok: false, reason: "NOT_OBJECT" };
  const id = value.id;
  if (typeof id !== "string" || !PRESENTATION_IDS.includes(id as PresentationId)) {
    return { ok: false, reason: "UNKNOWN_ID" };
  }
  const presentationId = id as PresentationId;
  const specs = PARAM_SPECS[presentationId];
  const rawParams = value.params;
  if (rawParams === undefined) return { ok: true, value: { id: presentationId } };
  if (!isPlainRecord(rawParams)) return { ok: false, reason: "BAD_PARAMS" };
  const params: Record<string, PresentationParam> = {};
  for (const [key, paramValue] of Object.entries(rawParams)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return { ok: false, reason: `UNKNOWN_PARAM:${key}` };
    }
    if (!Object.hasOwn(specs, key)) return { ok: false, reason: `UNKNOWN_PARAM:${key}` };
    const spec = specs[key];
    if (spec === undefined || !validateParam(paramValue, spec)) {
      return { ok: false, reason: `BAD_PARAM:${key}` };
    }
    params[key] = paramValue as PresentationParam;
  }
  return { ok: true, value: { id: presentationId, params: Object.freeze(params) } };
}

export function parsePresentation(value: unknown): PresentationMessage | null {
  const result = validatePresentation(value);
  return result.ok ? result.value : null;
}

const LEGACY_PREFIXES: ReadonlyArray<readonly [RegExp, PresentationId]> = [
  [/STALE_CURSOR/, "errors.staleCursor"],
  [/PREPARE_MISSING|PREPARATION_MISSING/, "errors.preparationRequired"],
  [/UNKNOWN_ERROR/, "errors.generic"],
  [/UNKNOWN_OPERATION|OPERATION.*UNKNOWN/, "errors.unknownOperation"],
  [/NOT_FOUND|MISSING/, "errors.notFound"],
  [/UNSUPPORTED|NOT_SUPPORTED/, "errors.unsupported"],
  [/CONFLICT|DUPLICATED|ALREADY/, "errors.conflict"],
  [/INVALID|MALFORMED|MISMATCH|REQUIRED|BAD_/, "errors.invalidArgument"],
];

/** 旧 code / 粗粒度端点 code 的兼容映射；未知 code 落到通用解释。 */
export function legacyPresentationId(code: string): PresentationId {
  const normalized = code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  for (const [pattern, id] of LEGACY_PREFIXES) {
    if (pattern.test(normalized)) return id;
  }
  return "errors.generic";
}

export type ExplanationSource = "presentation" | "legacy" | "fallback";

export interface ErrorExplanation {
  readonly code: string;
  readonly presentation: PresentationMessage;
  readonly text: string;
  readonly source: ExplanationSource;
  readonly degraded: boolean;
}

function paramsForTranslator(
  params: Readonly<Record<string, PresentationParam>> | undefined,
): MessageParams {
  const out: MessageParams = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = Array.isArray(value)
      ? (value as readonly (string | number)[]).join(", ")
      : (value as string | number | boolean);
  }
  return out;
}

/** 展示端翻译受控描述；非法输入降级为通用解释，不把参数当 key/HTML。 */
export function renderPresentation(translator: Translator, value: unknown): string {
  const parsed = parsePresentation(value);
  const id = parsed?.id ?? "errors.generic";
  return translator.t(id as MessageKey, paramsForTranslator(parsed?.params));
}

export interface ExplainErrorInput {
  readonly code?: unknown;
  readonly presentation?: unknown;
}

/** 产品错误解释：保留稳定 code，优先受控描述，旧 code 映射，未知异常只给通用摘要。 */
export function explainError(input: ExplainErrorInput, translator: Translator): ErrorExplanation {
  const rawCode = input.code;
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode)
      ? rawCode
      : "UNKNOWN_ERROR";
  if (input.presentation !== undefined) {
    const parsed = validatePresentation(input.presentation);
    if (parsed.ok) {
      return {
        code,
        presentation: parsed.value,
        text: renderPresentation(translator, parsed.value),
        source: "presentation",
        degraded: false,
      };
    }
  }
  const presentation: PresentationMessage = { id: legacyPresentationId(code) };
  return {
    code,
    presentation,
    text: renderPresentation(translator, presentation),
    source: input.presentation === undefined ? "legacy" : "fallback",
    degraded: input.presentation !== undefined,
  };
}

export interface DegradedError {
  readonly code: string;
  readonly presentation: PresentationMessage;
}

/** 第三方/未知异常降级：只保留稳定类 code（若有），绝不带 message/stack。 */
export function degradeUnknownError(error: unknown): DegradedError {
  const rawCode = isPlainRecord(error) ? error.code : undefined;
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode)
      ? rawCode
      : "UNKNOWN_ERROR";
  return { code, presentation: { id: legacyPresentationId(code) } };
}

/** 兼容现有 Envelope.error：保留 code/message，只追加通过校验的 presentation。 */
export function attachPresentation<T extends { readonly code: string; readonly message: string }>(
  envelope: T,
  presentation?: unknown,
): T & { readonly presentation?: PresentationMessage } {
  const parsed = parsePresentation(presentation);
  return parsed === null ? envelope : { ...envelope, presentation: parsed };
}
