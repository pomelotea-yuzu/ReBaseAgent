import type { AnyObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { ZodObject, ZodRawShape } from "zod";

/**
 * 入参声明的唯一来源：zod strict schema ⇒ JSON Schema（tools/list 发布给客户端的那份）。
 *
 * 为什么不在这里再写一份 JSON Schema：两份声明一定会漂（改了一边忘了另一边），
 * 漂了就变成"客户端看到的约束和服务器实际执行的不一致"。所以**只写 zod**，
 * 发布形状由 SDK 自带的转换器派生；本模块只做两件小事——
 * 去掉 `$schema` 顶层键（MCP 的 inputSchema 不需要它），以及把类型收窄到对象 schema。
 *
 * 校验本身仍由我们的 zod schema 在服务层执行：SDK 生成的 issue 文本不会进入
 * 错误信封（design D4：不透传 SDK/Zod 原始参数与异常）。
 */
export function toJsonSchemaDeclaration(
  schema: ZodObject<ZodRawShape>,
): Readonly<Record<string, unknown>> {
  const declaration = toJsonSchemaCompat(schema as unknown as AnyObjectSchema) as Record<
    string,
    unknown
  >;
  // 去掉顶层 `$schema`：MCP 的 inputSchema 不需要它，留着会让部分客户端多做一次解引用
  const { $schema: _dropped, ...selfContained } = declaration;
  return selfContained;
}
