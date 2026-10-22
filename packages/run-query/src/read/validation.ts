import { isAbsolute } from "node:path";
import { findLogicalPathViolation } from "@rebaseagent/trace-sdk";

/**
 * run-query 的输入安全边界：只接受可安全拼进 `<dataDir>/traces` 的标识、
 * 只接受查询键（spanId）与逻辑路径，不接受任意物理路径。
 *
 * 这些判据在**任何文件读取之前**执行；返回受控中文原因，`null` = 合法。
 */

export const MAX_RUN_ID_LENGTH = 200;
export const MAX_SPAN_ID_LENGTH = 128;
export const MAX_LOGICAL_PATH_INPUT_LENGTH = 4096;

/** run id 用于拼 `<traces>/<id>.jsonl`：挡穿越、绝对路径与 NUL（旧 IPC 行为不变） */
export function findIllegalRunIdViolation(id: string): string | null {
  if (id.length === 0) return "不能为空";
  if (id.includes("\0")) return "不能包含空字符";
  if (id.includes("/") || id.includes("\\")) return "不能包含路径分隔符";
  if (id.includes("..")) return "不能包含目录穿越片段";
  if (isAbsolute(id) || /^[a-zA-Z]:/.test(id)) return "必须是相对文件标识";
  return null;
}

/**
 * MCP/工具输入的外部长度边界（design D3：runId 最长 200）。
 *
 * 与 `findIllegalRunIdViolation` 分开是刻意的：旧 IPC 对超长 id 仍按形状处理并
 * 由响应 schema 有界化，避免提取共享层时收紧桌面行为（design D2）；外部投影
 * 在进入工具前用本函数拒绝。
 */
export function findIllegalExternalRunIdViolation(id: string): string | null {
  const shape = findIllegalRunIdViolation(id);
  if (shape !== null) return shape;
  if (id.length > MAX_RUN_ID_LENGTH) return `超过 ${MAX_RUN_ID_LENGTH} 字符`;
  return null;
}

/** span id 只作为查询键（不拼路径）：限制长度与 NUL，不虚构字符集 */
export function findIllegalSpanIdViolation(id: string): string | null {
  if (id.length === 0) return "不能为空";
  if (id.length > MAX_SPAN_ID_LENGTH) return `超过 ${MAX_SPAN_ID_LENGTH} 字符`;
  if (id.includes("\0")) return "不能包含空字符";
  return null;
}

/** 文件名（或请求 id）必须与记录内的 meta.id 一致；不一致即身份错配 */
export function findRunIdentityViolation(expectedId: string, actualId: string): string | null {
  if (expectedId === actualId) return null;
  return `run 标识 ${expectedId} 与记录 meta.id ${actualId} 不一致`;
}

/**
 * 逻辑路径的输入边界。语义规则仍由 trace-sdk 的 `findLogicalPathViolation`
 * 承担（相对、`/` 分隔、深度/长度/保留名等）；这里只加 MCP 层的输入上限、
 * 空值与 NUL 预检，不复制第二份路径规则。
 */
export function findIllegalLogicalPathViolation(path: string): string | null {
  if (path.length === 0) return "不能为空";
  if (path.length > MAX_LOGICAL_PATH_INPUT_LENGTH) {
    return `超过 ${MAX_LOGICAL_PATH_INPUT_LENGTH} 字符`;
  }
  if (path.includes("\0")) return "不能包含空字符";
  return findLogicalPathViolation(path);
}
