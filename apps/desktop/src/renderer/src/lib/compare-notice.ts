import type { Translator } from "@rebaseagent/i18n";

/** 对照选择的操作提示：store 只记稳定码，文案由展示层按语言派生 */
export type CompareNotice =
  | { readonly code: "max_selected"; readonly limit: number }
  | { readonly code: "pick_two_in_metrics" };

export function compareNoticeText(notice: CompareNotice, translator: Translator): string {
  return notice.code === "max_selected"
    ? translator.t("compare.noticeMaxSelected", { limit: notice.limit })
    : translator.t("compare.noticePickTwoMetrics");
}
