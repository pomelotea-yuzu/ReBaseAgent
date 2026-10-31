import { type Locale, parseExplicitLocale, resolveSystemLocale } from "./locale.js";
import type { MessageKey } from "./resources/index.js";

/**
 * 共享 CLI 语言解析（design §2）：--locale > REBASEAGENT_LOCALE >
 * LC_ALL > LC_MESSAGES > LANG > Intl > en-US。
 *
 * 只做纯解析：不读 process.env、不打印、不退出。CLI 入口负责传入 argv/env/Intl 值，
 * 并在加载用户配置、写 baseline、调用模型或初始化协议之前消费结果。
 */

export const CLI_LOCALE_FLAG = "--locale";
export const CLI_LOCALE_ENV = "REBASEAGENT_LOCALE";
/** 非法显式语言的统一退出码（与既有 CLI 配置错误一致）。 */
export const CLI_LOCALE_EXIT_CODE = 2;
export const CLI_LOCALE_SYSTEM_ENV = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

export type CliLocaleSource = "flag" | "env" | "system" | "fallback";

export type CliLocaleErrorReason =
  | "duplicate-flag"
  | "missing-value"
  | "unsupported-value"
  | "invalid-env-value";

const ERROR_MESSAGE_KEYS: Record<CliLocaleErrorReason, MessageKey> = {
  "duplicate-flag": "cli.localeDuplicateFlag",
  "missing-value": "cli.localeMissingValue",
  "unsupported-value": "cli.localeUnsupportedValue",
  "invalid-env-value": "cli.localeInvalidEnvValue",
};

export interface CliLocaleResolution {
  readonly ok: true;
  readonly locale: Locale;
  readonly source: CliLocaleSource;
}

export interface CliLocaleError {
  readonly ok: false;
  /** 受控启动码；stderr 只报这个码与受控说明，不回显原始参数。 */
  readonly code: "INVALID_LOCALE";
  readonly reason: CliLocaleErrorReason;
  readonly messageKey: MessageKey;
  /** 受控说明所用语言：取有效显式值/产品环境变量，否则系统语言；绝不取非法值。 */
  readonly messageLocale: Locale;
}

export type CliLocaleOutcome = CliLocaleResolution | CliLocaleError;

export interface ResolveCliLocaleInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 宿主 Intl 建议语言；没有系统语言（检测不可用或为空）时传 null。 */
  readonly intlLocale?: string | null;
}

/** `null` 表示 --locale 后没有取值（缺值或紧跟另一个参数）。 */
type FlagValue = string | null;

function readFlagValues(argv: readonly string[]): FlagValue[] {
  const values: FlagValue[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== CLI_LOCALE_FLAG) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      values.push(null);
      continue;
    }
    values.push(next);
    i += 1;
  }
  return values;
}

function firstNonEmpty(values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value != null && value.trim() !== "") return value;
  }
  return null;
}

function firstValidExplicit(values: readonly FlagValue[]): Locale | null {
  for (const value of values) {
    const parsed = parseExplicitLocale(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function systemLocaleOf(input: ResolveCliLocaleInput): Locale {
  const envValue = firstNonEmpty(CLI_LOCALE_SYSTEM_ENV.map((name) => input.env[name]));
  return resolveSystemLocale(envValue ?? input.intlLocale);
}

function messageLocaleOf(input: ResolveCliLocaleInput, values: readonly FlagValue[]): Locale {
  return (
    firstValidExplicit(values) ??
    parseExplicitLocale(input.env[CLI_LOCALE_ENV]) ??
    systemLocaleOf(input)
  );
}

function invalid(reason: CliLocaleErrorReason, messageLocale: Locale): CliLocaleError {
  return {
    ok: false,
    code: "INVALID_LOCALE",
    reason,
    messageKey: ERROR_MESSAGE_KEYS[reason],
    messageLocale,
  };
}

export function resolveCliLocale(input: ResolveCliLocaleInput): CliLocaleOutcome {
  const values = readFlagValues(input.argv);
  const envRaw = input.env[CLI_LOCALE_ENV];
  const envLocale = parseExplicitLocale(envRaw);
  const messageLocale = messageLocaleOf(input, values);

  if (values.length > 1) return invalid("duplicate-flag", messageLocale);
  if (values.length === 1 && values[0] === null) return invalid("missing-value", messageLocale);
  if (values.length === 1) {
    const flagLocale = parseExplicitLocale(values[0]);
    if (flagLocale === null) return invalid("unsupported-value", messageLocale);
    return { ok: true, locale: flagLocale, source: "flag" };
  }

  // 产品环境变量严格校验；空串视为未设置（常见 shell 占位），其余非规范值一律失败。
  if (envRaw !== undefined && envRaw !== "" && envLocale === null) {
    return invalid("invalid-env-value", messageLocale);
  }
  if (envLocale !== null) return { ok: true, locale: envLocale, source: "env" };

  const systemRaw = firstNonEmpty(CLI_LOCALE_SYSTEM_ENV.map((name) => input.env[name]));
  if (systemRaw !== null) {
    return { ok: true, locale: resolveSystemLocale(systemRaw), source: "system" };
  }

  const intlRaw = firstNonEmpty([input.intlLocale]);
  if (intlRaw !== null) {
    return { ok: true, locale: resolveSystemLocale(intlRaw), source: "system" };
  }
  return { ok: true, locale: "en-US", source: "fallback" };
}
