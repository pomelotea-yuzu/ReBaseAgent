import type { Locale } from "../locale.js";
import { enUS } from "./en-US.js";
import { type ResourceCatalog, zhCN } from "./zh-CN.js";

export { enUS } from "./en-US.js";
export { NAMESPACES, zhCN } from "./zh-CN.js";
export type {
  MessageKey,
  MessageValue,
  Namespace,
  PlainMessageKey,
  PluralMessageKey,
  ResourceCatalog,
  ResourceShape,
} from "./zh-CN.js";

export type FlattenedCatalog = Record<string, Record<string, string>>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

deepFreeze(zhCN);
deepFreeze(enUS);

/** 把 { one?, other } 展开成 i18next 的 key_one/key_other；普通字符串原样保留。 */
export function flattenCatalog(catalog: ResourceCatalog): FlattenedCatalog {
  const out: FlattenedCatalog = {};
  for (const [namespace, messages] of Object.entries(catalog)) {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(messages)) {
      if (typeof value === "string") {
        flat[key] = value;
      } else {
        if (value.one !== undefined) flat[`${key}_one`] = value.one;
        flat[`${key}_other`] = value.other;
      }
    }
    out[namespace] = flat;
  }
  return out;
}

export const resources = deepFreeze({
  "zh-CN": flattenCatalog(zhCN),
  "en-US": flattenCatalog(enUS),
} satisfies Record<Locale, FlattenedCatalog>);
