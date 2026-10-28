/** 受控 Trans 槽位白名单；翻译文本只能使用这些标签，链接目标由代码提供。 */
export const RICH_TEXT_TAGS = ["code", "strong", "link"] as const;

export type RichTextTag = (typeof RICH_TEXT_TAGS)[number];
