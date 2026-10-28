import type { Locale, MissingKeyEvent, Translator } from "@rebaseagent/i18n";
import { createTranslator } from "@rebaseagent/i18n";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../src/renderer/src/i18n/index";

export interface RenderWithLocaleOptions {
  readonly onMissingKey?: (event: MissingKeyEvent) => void;
}

/** 显式 locale 的静态渲染助手：不读宿主环境，不依赖 DOM 或异步加载。 */
export function renderWithLocale(
  locale: Locale,
  element: ReactElement,
  options: RenderWithLocaleOptions = {},
): string {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} onMissingKey={options.onMissingKey}>
      {element}
    </I18nProvider>,
  );
}

/** 文案测试可用的独立 translator；期望值仍应独立书写，不用 t(key) 自证。 */
export function createTestTranslator(locale: Locale): Translator {
  return createTranslator({ locale });
}
