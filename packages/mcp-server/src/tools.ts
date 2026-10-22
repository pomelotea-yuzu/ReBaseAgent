import { getRunTool } from "./query/get-run.js";
import { listRunsTool } from "./query/list-runs.js";
import type { ToolDefinition } from "./server.js";

/**
 * 只读诊断工具的注册表（design D5/D7：**只发布这七个**，不提供 prompts/resources 旁路）。
 *
 * 本表登记的是「契约 + 实现」的成品，逐批接入：
 * - `list_runs`、`get_run` ⇒ 4.3；
 * - `get_step` ⇒ 4.4；`compare_runs` ⇒ 4.5；`inspect_checkpoint` /
 *   `read_checkpoint_file` ⇒ 4.6；`compare_checkpoint_files` ⇒ 4.7。
 *
 * 纪律：**没实现就不登记**。空位不是"少一个工具"而是"能力不存在"——注册一个会抛错的
 * 占位工具是谎报可用，而让 `tools/list` 如实反映已实现的部分，客户端拿到的声明
 * 与它实际能调通的东西始终一致。
 *
 * 未登记的工具名由服务层直接拒（`server.ts` 的未知工具出口，S04），
 * 不会因为契约里写了七行就扩大服务范围。
 */
export const READONLY_TOOLS: readonly ToolDefinition[] = [listRunsTool, getRunTool];
