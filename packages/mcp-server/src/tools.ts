import type { ToolDefinition } from "./server.js";

/**
 * 只读诊断工具的注册表（design D5/D7：**只发布这七个**，不提供 prompts/resources 旁路）。
 *
 * 4.1 只建缝：清单为空时 `tools/list` 如实返回空数组——不注册占位工具，
 * 也不提前声称某个工具可用。4.2 定义 strict 入参与统一信封后逐项实装并在此登记：
 * `list_runs`、`get_run`、`get_step`、`compare_runs`、`inspect_checkpoint`、
 * `read_checkpoint_file`、`compare_checkpoint_files`。
 */
export const READONLY_TOOLS: readonly ToolDefinition[] = [];
