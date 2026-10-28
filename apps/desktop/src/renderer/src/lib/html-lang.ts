import type { Locale } from "@rebaseagent/i18n";

/** HTML lang 跟随有效语言；只改展示属性，不触发编辑器/工作区重建。 */
export function applyHtmlLang(documentElement: Pick<HTMLElement, "lang">, locale: Locale): void {
  documentElement.lang = locale;
}
