import type { Translator } from "@rebaseagent/i18n";

/**
 * content 文本投影（6.2 真实客户端修订，owner 2026-10-23 定稿）。
 *
 * 修订前的口径（design 4.2/D4）把完整事实只放在 `structuredContent`，`content[0].text`
 * 只给一行 headline。WorkBuddy 5.9.0 实测**不把 `structuredContent` 交给模型** ⇒
 * 模型连一条路径 / sha256 / 错误消息都引用不出来，S15 的「引用可回查」在真实客户端上落空。
 *
 * 定稿方案：**content 承载 headline + data 紧凑投影，且「正文只承载一次」**——
 * 正文（get_step 的 body、read_checkpoint_file 的 file、compare_checkpoint_files
 * 内容模式的 files.left/right）只进 content 文本；`structuredContent.data` 对应位
 * 换成 `bodyIn:"content"` 指针并保留 `range/truncated/remaining/sha256/status` 等小事实。
 *
 * 纪律：
 * - **只渲染信封里已有的东西**：不新增字段、不补全、不推测；物理路径 / 堆栈在信封构造
 *   之前就被挡住，这里不引入新的泄露面。
 * - **小事实两处都在**：清单条目 / bytes / 哈希 / tokens / 状态 / 结论在 data 投影里
 *   全额呈现（第一轮实跑的 8 项锚点数字全部可从 content 读回）。
 * - **超长自由文本截断并标注**：`LEAF_MAX` 只作用于普通叶子（如 6000 码点的 task 文本），
 *   截断处标注总码点、全文仍在 structuredContent——投影要自足的是「事实」，
 *   不是把无界自由文本复制两遍（那会让 compare_runs 这类无旋钮工具直接翻倍超预算，
 *   6.2 实测整信封版 6 红 / 双承载版 4 红的教训，见 MCP0.md 第 13 条）。
 * - **正文位不截**：正文外发量本就受 8192 码点上限与预算收窄约束，投影再切一刀等于
 *   「文本不自足」；渲染为单行 JSON 字符串，换行 / 引号全部转义，不破坏投影结构。
 * - 输出**确定**：同输入同文本；键序取对象构建序，与 JSON 序列化一致。
 */

/** data 内正文位的定位：自 data 根起的路径（"." 连接，如 `body` / `file` / `files.left`） */
export interface ContentBodyInput {
  readonly at: string;
  readonly text: string;
}

/**
 * 普通叶子的码点上限。取值权衡：
 * - 大于所有「小事实」的常规长度（消息 512、哈希 64、错误文案），保证引用可逐字回查；
 * - 小于 budget 判据里 6000 码点的超长 task，让 compare_runs 这类无旋钮工具的
 *   content 投影不把 structuredContent 已有的自由文本整份复制；
 * - 逻辑路径上限（4096）大于它 ⇒ 极端长路径在投影里截断（真实场景路径远短于此，
 *   全文仍在 structuredContent，截断处有总量标注）。
 */
const LEAF_MAX = 3_000;

/** 嵌套深度上限：信封实际最深约 5 层，留余量但不放开成无界递归 */
const DEPTH_MAX = 8;

function leaf(value: string, translator: Translator): string {
  const chars = [...value];
  if (chars.length <= LEAF_MAX) return JSON.stringify(value);
  return `${JSON.stringify(chars.slice(0, LEAF_MAX).join(""))}${translator.t("mcp.contentTruncated", { count: chars.length })}`;
}

function scalar(value: unknown, translator: Translator): string | null {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return leaf(value, translator);
    case "number":
    case "boolean":
      return String(value);
    default:
      return null;
  }
}

function isBodyInNode(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).bodyIn === "content"
  );
}

/**
 * 渲染一个对象节点。`bodyIn:"content"` 的键在此被替换为正文本体（`text: "<原文>"`），
 * `bodyIn` 键本身不进投影——它在 structuredContent 里是指针，在 content 里本体已在眼前。
 */
function renderObject(
  value: Record<string, unknown>,
  path: string,
  indent: number,
  bodies: ReadonlyMap<string, string>,
  out: string[],
  translator: Translator,
): void {
  const pad = "  ".repeat(indent);
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const childPath = path === "" ? key : `${path}.${key}`;
    if (isBodyInNode(child)) {
      const body = bodies.get(childPath);
      out.push(`${pad}${key}:`);
      for (const [innerKey, inner] of Object.entries(child)) {
        if (innerKey === "bodyIn") {
          // 本体缺失 = 实现层构造了指针却没随结果给正文（结构上不可达，防御性可见）
          out.push(
            `${pad}  text: ${body === undefined ? JSON.stringify(translator.t("mcp.contentBodyPointerMissing")) : JSON.stringify(body)}`,
          );
          continue;
        }
        if (inner !== null && typeof inner === "object") {
          const entries = Array.isArray(inner) ? inner : Object.keys(inner);
          if (entries.length === 0) {
            out.push(`${pad}  ${innerKey}: ${Array.isArray(inner) ? "[]" : "{}"}`);
            continue;
          }
          out.push(`${pad}  ${innerKey}:`);
          renderValue(inner, `${childPath}.${innerKey}`, indent + 2, bodies, out, translator);
        } else {
          out.push(
            `${pad}  ${innerKey}: ${scalar(inner, translator) ?? translator.t("mcp.contentComplexValue")}`,
          );
        }
      }
      continue;
    }
    if (child !== null && typeof child === "object") {
      const entries = Array.isArray(child) ? child : Object.keys(child);
      if (entries.length === 0) {
        out.push(`${pad}${key}: ${Array.isArray(child) ? "[]" : "{}"}`);
        continue;
      }
      out.push(`${pad}${key}:`);
      renderValue(child, childPath, indent + 1, bodies, out, translator);
      continue;
    }
    out.push(
      `${pad}${key}: ${scalar(child, translator) ?? translator.t("mcp.contentComplexValue")}`,
    );
  }
}

function renderValue(
  value: unknown,
  path: string,
  indent: number,
  bodies: ReadonlyMap<string, string>,
  out: string[],
  translator: Translator,
): void {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (item !== null && typeof item === "object" && Object.keys(item).length > 0) {
        const inner: string[] = [];
        renderValue(item, path, indent + 1, bodies, inner, translator);
        out.push(`${pad}-`);
        out.push(...inner);
      } else if (isBodyInNode(item)) {
        // 当前三个工具的正文位都在对象键下、不在数组里；这里按同规则兜底
        const body = bodies.get(path);
        out.push(
          `${pad}- text: ${body === undefined ? translator.t("mcp.contentBodyMissing") : JSON.stringify(body)}`,
        );
      } else {
        out.push(`${pad}- ${scalar(item, translator) ?? translator.t("mcp.contentComplexValue")}`);
      }
    }
    return;
  }
  if (value !== null && typeof value === "object" && indent < DEPTH_MAX) {
    renderObject(value as Record<string, unknown>, path, indent, bodies, out, translator);
    return;
  }
  out.push(`${pad}${scalar(value, translator) ?? translator.t("mcp.contentComplexValue")}`);
}

/**
 * 生成 content 文本：headline 一行 + **data 的紧凑投影**（正文位渲染本体）。
 * ⚠️ 只渲染 data，不渲染整个信封：provenance/refs/limitations/truncation 由 headline
 *    概括、完整值仍在 structuredContent——重复载荷会吃掉 64 KiB 预算（6.2 实测）。
 */
export function buildContentText(
  headline: string,
  data: unknown,
  bodies: readonly ContentBodyInput[],
  translator: Translator,
): string {
  const out: string[] = [headline];
  const bodyMap = new Map(bodies.map((body) => [body.at, body.text]));
  renderValue(data === undefined ? null : data, "", 0, bodyMap, out, translator);
  return out.join("\n");
}
