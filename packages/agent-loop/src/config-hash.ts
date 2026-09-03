import { createHash } from "node:crypto";
import type { ToolDef } from "./config.js";

/**
 * config 指纹：sha256(规范化 JSON of { systemPrompt, tools })。
 * - 只覆盖"源代码"（system prompt + 工具表）；model/params 不参与——
 *   同源代码换模型/温度属于合法对比实验
 * - 规范化：键排序、工具按 name 排序、无空白，保证跨平台稳定
 */
export function configHash(systemPrompt: string, tools: ToolDef[]): string {
  const canonical = {
    systemPrompt,
    tools: [...tools]
      .map((t) => ({
        description: t.description,
        name: t.name,
        parameters: t.parameters,
        ...(t.sideEffect === undefined ? {} : { sideEffect: t.sideEffect }),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical)).digest("hex")}`;
}

/** 规范化 JSON：键排序、无缩进（对象键按字典序） */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
