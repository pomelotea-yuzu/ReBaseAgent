/**
 * 外部投影的容量与身份上限（design D3/D5/D6）。
 *
 * 这些上限**只约束 MCP 的入参与出参**，不反向收紧桌面读取（D2）：
 * 桌面比较仍按 `COMPARE_RUN_MAX` 取 1–4 个对象，MCP 的比较工具固定"恰两侧对象"。
 */

/** run 标识上限（与共享层 `findIllegalExternalRunIdViolation` 同一口径） */
export const RUN_ID_MAX = 200;
/** span / step 标识上限 */
export const SPAN_ID_MAX = 128;
/** 逻辑路径上限 */
export const LOGICAL_PATH_MAX = 4096;
/** 不透明游标上限（游标由本进程密钥签发，长度仍需有界以防被当正文通道用） */
export const CURSOR_MAX = 512;

/** 条目分页：默认 20、最大 100（D5） */
export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;

/** 正文码点范围：默认 4096、最大 8192（D6；再按实际信封预算缩短） */
export const BODY_CHARS_DEFAULT = 4096;
export const BODY_CHARS_MAX = 8192;

/** 完整工具结果（含 structuredContent/content/来源/错误）的 UTF-8 字节预算（D6） */
export const RESPONSE_BUDGET_BYTES = 64 * 1024;

/** 受控错误与简述文案的码点上限 */
export const MESSAGE_MAX = 512;
/** content 首行简述上限：只给状态与定位，不复制正文 */
export const CONTENT_HEADLINE_MAX = 200;
