export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export type DesktopLocalePreference = "system" | Locale;

/** 显式语言只接受两个规范值；不做大小写或区域猜测。 */
export function parseExplicitLocale(value: unknown): Locale | null {
  return value === "zh-CN" || value === "en-US" ? value : null;
}

export function isLocale(value: unknown): value is Locale {
  return parseExplicitLocale(value) !== null;
}

/**
 * 系统语言规范化：zh 及其区域/编码变体归 zh-CN，其余与无法识别值归 en-US。
 * 用于桌面“跟随系统”和 CLI 的系统环境候选，不用于显式 --locale 校验。
 */
export function resolveSystemLocale(raw: string | null | undefined): Locale {
  if (raw == null) return "en-US";
  const normalized = raw.trim().replace(/_/g, "-").toLowerCase();
  if (normalized === "" || normalized === "c" || normalized === "posix") return "en-US";
  const primary = normalized.split(/[.-]/, 1)[0];
  return primary === "zh" ? "zh-CN" : "en-US";
}

export function resolveDesktopLocale(
  preference: DesktopLocalePreference | null | undefined,
  systemLanguage: string | null | undefined,
): Locale {
  const explicit = parseExplicitLocale(preference);
  return explicit ?? resolveSystemLocale(systemLanguage);
}
