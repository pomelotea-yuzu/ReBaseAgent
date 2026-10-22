import type { ToolDefinition } from "./server.js";

/**
 * 只读诊断工具的注册表（design D5/D7：**只发布这七个**，不提供 prompts/resources 旁路）。
 *
 * 4.2 已把**契约**定下来（`tool-contracts.ts`：strict 入参、只读 annotations、由 zod
 * 派生的 JSON Schema；`tool-definition.ts`：入参校验 + 信封装配缝）；本表登记的是
 * "契约 + 实现"的成品，实现逐项来自 4.3–4.7。
 *
 * 首版为空清单是刻意的：空 = "能力尚未接入"，客户端 `tools/list` 看到的就是没有工具；
 * 注册一个会抛错的占位工具反而是谎报可用。
 */
export const READONLY_TOOLS: readonly ToolDefinition[] = [];
