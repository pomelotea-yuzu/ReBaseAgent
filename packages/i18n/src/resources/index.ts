import type { Locale } from "../locale.js";
import { enUS } from "./en-US.js";
import { zhCN } from "./zh-CN.js";

export { enUS } from "./en-US.js";
export { NAMESPACES, zhCN } from "./zh-CN.js";
export type { MessageKey, Namespace, ResourceShape } from "./zh-CN.js";

export const resources = {
  "zh-CN": zhCN,
  "en-US": enUS,
} satisfies Record<Locale, unknown>;
