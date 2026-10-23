import { compareCheckpointFilesTool } from "./query/compare-checkpoint-files.js";
import { compareRunsTool } from "./query/compare-runs.js";
import { getRunTool } from "./query/get-run.js";
import { getStepTool } from "./query/get-step.js";
import { inspectCheckpointTool } from "./query/inspect-checkpoint.js";
import { listRunsTool } from "./query/list-runs.js";
import { readCheckpointFileTool } from "./query/read-checkpoint-file.js";
import type { ToolDefinition } from "./server.js";

/**
 * 只读诊断工具的注册表（design D5/D7：**只发布这七个**，不提供 prompts/resources 旁路）。
 *
 * 本表登记的是「契约 + 实现」的成品，逐批接入：
 * - `list_runs`、`get_run` ⇒ 4.3；`get_step` ⇒ 4.4；`compare_runs` ⇒ 4.5；
 * - `inspect_checkpoint` / `read_checkpoint_file` ⇒ 4.6；`compare_checkpoint_files` ⇒ 4.7。
 *
 * 纪律：**没实现就不登记**。空位不是"少一个工具"而是"能力不存在"——注册一个会抛错的
 * 占位工具是谎报可用，而让 `tools/list` 如实反映已实现的部分，客户端拿到的声明
 * 与它实际能调通的东西始终一致。
 *
 * 七条都登记齐了不等于 S03 通过：分页游标（5.2）、64 KiB 实际预算（5.1）、结构凭据过滤（4.8）
 * 与真实客户端整链（6.2）仍在后面；未登记的工具名由服务层直接拒（`server.ts`，S04），
 * 不会因为契约里写了七行就扩大服务范围。
 */
export const READONLY_TOOLS: readonly ToolDefinition[] = [
  listRunsTool,
  getRunTool,
  getStepTool,
  compareRunsTool,
  inspectCheckpointTool,
  readCheckpointFileTool,
  compareCheckpointFilesTool,
];
