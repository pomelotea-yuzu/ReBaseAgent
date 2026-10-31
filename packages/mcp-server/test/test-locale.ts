import { createTranslator } from "@rebaseagent/i18n";
import { toolErrorMessageOf } from "../src/tool-definition.js";
import type { McpToolErrorCode } from "../src/verification-codes.js";

/** 测试固定语言实例：不读宿主环境，也不跨测试共享可变当前语言。 */
export const ZH = createTranslator({ locale: "zh-CN" });
export const EN = createTranslator({ locale: "en-US" });

export function errorMessageOf(code: McpToolErrorCode): string {
  return toolErrorMessageOf(code, ZH);
}
