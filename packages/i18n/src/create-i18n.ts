import { type i18n as I18nInstance, type Resource, createInstance } from "i18next";
import type { Locale } from "./locale.js";
import { SUPPORTED_LOCALES } from "./locale.js";
import { type MessageKey, NAMESPACES, type Namespace, resources } from "./resources/index.js";

const FALLBACK_LOCALE: Locale = "zh-CN";

export type MessageParams = Record<string, string | number | boolean | undefined>;

export interface MissingKeyEvent {
  readonly locale: Locale;
  readonly namespace: string;
  readonly key: string;
}

export interface Translator {
  readonly locale: Locale;
  readonly instance: I18nInstance;
  t(key: MessageKey, params?: MessageParams): string;
  has(key: MessageKey): boolean;
}

export interface CreateTranslatorOptions {
  readonly locale: Locale;
  readonly onMissingKey?: (event: MissingKeyEvent) => void;
}

function splitKey(key: MessageKey): { namespace: Namespace; path: string } {
  const index = key.indexOf(".");
  if (index <= 0) return { namespace: "common", path: key };
  return {
    namespace: key.slice(0, index) as Namespace,
    path: key.slice(index + 1),
  };
}

/** 供 react-i18next 的 Trans 使用：把点分键转成 namespace:key。 */
export function toI18nextKey(key: MessageKey): string {
  const { namespace, path } = splitKey(key);
  return `${namespace}:${path}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

deepFreeze(resources);

/** i18next 会就地合并资源；每个实例拿独立副本，避免跨实例污染。 */
function cloneResources(): Resource {
  const copy: Resource = {};
  for (const [locale, namespaces] of Object.entries(resources)) {
    copy[locale] = {};
    for (const [namespace, messages] of Object.entries(namespaces)) {
      copy[locale][namespace] = { ...messages };
    }
  }
  return copy;
}

/**
 * 创建独立、同步初始化的翻译器。每个桌面根/CLI/MCP server/测试各自持有实例，
 * 不使用共享可变当前语言；initAsync:false 保证首次调用即可同步取到资源。
 */
export function createTranslator(options: CreateTranslatorOptions): Translator {
  const { locale, onMissingKey } = options;
  const instance = createInstance();

  // initAsync:false 下资源同步装载；返回值 Promise 不需要等待。
  void instance.init({
    resources: cloneResources(),
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    defaultNS: "common",
    ns: NAMESPACES,
    initAsync: false,
    keySeparator: ".",
    interpolation: { escapeValue: false },
    returnNull: false,
    saveMissing: true,
    missingKeyHandler: (_lngs, namespace, key) => {
      onMissingKey?.({ locale, namespace, key });
    },
    parseMissingKeyHandler: () => resources[locale].common.messageUnavailable,
  });

  return {
    locale,
    instance,
    t(key, params) {
      const { namespace, path } = splitKey(key);
      return instance.t(path, { ns: namespace, ...params }) as string;
    },
    has(key) {
      const { namespace, path } = splitKey(key);
      return (
        instance.exists(path, { ns: namespace }) !== false ||
        instance.exists(`${path}_other`, { ns: namespace }) !== false
      );
    },
  };
}
