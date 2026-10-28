export {
  type DesktopLocalePreference,
  type Locale,
  isLocale,
  parseExplicitLocale,
  resolveDesktopLocale,
  resolveSystemLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
export {
  type CreateTranslatorOptions,
  type MessageParams,
  type MissingKeyEvent,
  type Translator,
  createTranslator,
} from "./create-i18n.js";
export {
  NAMESPACES,
  enUS,
  resources,
  zhCN,
  type MessageKey,
  type Namespace,
  type ResourceShape,
} from "./resources/index.js";
