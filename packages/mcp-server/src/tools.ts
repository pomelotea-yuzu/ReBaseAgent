import { compareCheckpointFilesTool } from "./query/compare-checkpoint-files.js";
import { compareRunsTool } from "./query/compare-runs.js";
import { compareVerificationsTool } from "./query/compare-verifications.js";
import { getRunTool } from "./query/get-run.js";
import { getStepTool } from "./query/get-step.js";
import { getVerificationTool } from "./query/get-verification.js";
import { inspectCheckpointTool } from "./query/inspect-checkpoint.js";
import { inspectVerificationArtifactsTool } from "./query/inspect-verification-artifacts.js";
import { listRunsTool } from "./query/list-runs.js";
import { listVerificationsTool } from "./query/list-verifications.js";
import { readCheckpointFileTool } from "./query/read-checkpoint-file.js";
import { readVerificationArtifactTool } from "./query/read-verification-artifact.js";
import { readVerificationLogTool } from "./query/read-verification-log.js";
import type { ToolDefinition } from "./server.js";

/**
 * 只读诊断工具的注册表（MCP1 design D5/D7 + MCP2 design D2：**只发布这十三个**，
 * 不提供 prompts/resources 旁路，不提供准备/执行/停止/导出工具）。
 *
 * MCP1 七工具：list_runs/get_run/get_step/compare_runs/inspect_checkpoint/
 * read_checkpoint_file/compare_checkpoint_files（名称、参数、行为不变）。
 * MCP2 六工具（tasks 3.1–3.6）：list_verifications/get_verification/
 * read_verification_log/inspect_verification_artifacts/read_verification_artifact/
 * compare_verifications——只读消费 R3 验证记录，与桌面共享同一事实实现。
 *
 * 纪律：**没实现就不登记**；十三个 ≠ M01 通过（生产 stdio 与真实客户端验收在 5.1/5.3）。
 */
export const READONLY_TOOLS: readonly ToolDefinition[] = [
  listRunsTool,
  getRunTool,
  getStepTool,
  compareRunsTool,
  inspectCheckpointTool,
  readCheckpointFileTool,
  compareCheckpointFilesTool,
  listVerificationsTool,
  getVerificationTool,
  readVerificationLogTool,
  inspectVerificationArtifactsTool,
  readVerificationArtifactTool,
  compareVerificationsTool,
];
