import { createHash } from "node:crypto";

/**
 * 规范化序列化与摘要（R3 准备层的计划指纹 / 配方摘要共用）。
 *
 * 对象键**递归排序**后序列化：同一份数据在任何属性插入顺序下得到同一字节串——
 * 计划 token / manifest 摘要因此跨会话、跨进程稳定（比较条件指纹的前提，design D2）。
 * `undefined` 属性跳过（与 JSON 语义一致）；数组保序（有序集合不重排）。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** UTF-8 文本的 sha256（64 位小写十六进制，与 FileHashSchema 同形）。 */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
