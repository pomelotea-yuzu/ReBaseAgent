import type { RunQueryToolErrorCode } from "@rebaseagent/run-query";

/**
 * MCP2 验证查询的三域码表（design D3）：工具失败错误码、成功 limitation 码、
 * 数据状态。码封闭——实现不得自行造码；本模块是唯一的码清单来源。
 *
 * 与 MCP1 既有四码（INVALID_ARGUMENT/STORAGE_IO/STALE_CURSOR/RESPONSE_LIMIT）和
 * 四 limitation（TERMINATION_NOT_RECORDED 等）的关系：验证工具**复用**这四个错误码，
 * 新增九个 VERIFICATION_* 错误码与七个 VERIFICATION_* limitation 码，不重定义既有码。
 */

// ---------------------------------------------------------------------------
// 工具失败错误码（isError=true 的信封）
// ---------------------------------------------------------------------------

/** MCP2 新增的验证域错误码（design D3 表第一行；九个全部新增） */
export const VERIFICATION_TOOL_ERROR_CODES = [
  "VERIFICATION_NOT_FOUND",
  "VERIFICATION_UNREADABLE",
  "VERIFICATION_RECORD_INVALID",
  "VERIFICATION_LOG_NOT_RECORDED",
  "VERIFICATION_ARTIFACT_NOT_FOUND",
  "VERIFICATION_ARTIFACTS_NOT_RECORDED",
  "VERIFICATION_ASSET_MISSING",
  "VERIFICATION_ASSET_CORRUPT",
  "VERIFICATION_PATH_REJECTED",
] as const;
export type VerificationToolErrorCode = (typeof VERIFICATION_TOOL_ERROR_CODES)[number];

/** MCP 工具错误码全集：MCP1 既有码 + 验证域新增码 */
export type McpToolErrorCode = RunQueryToolErrorCode | VerificationToolErrorCode;

/** 每个新增稳定码一句受控文案（不含物理路径/errno/堆栈；与 error-projection 同纪律） */
export const VERIFICATION_TOOL_ERROR_MESSAGES: Readonly<Record<VerificationToolErrorCode, string>> =
  {
    VERIFICATION_NOT_FOUND: "指定验证不存在",
    VERIFICATION_UNREADABLE: "指定验证的记录文件当前不可读",
    VERIFICATION_RECORD_INVALID: "指定验证的记录无法通过校验",
    VERIFICATION_LOG_NOT_RECORDED: "该验证没有记录指定命令/流的执行事实",
    VERIFICATION_ARTIFACT_NOT_FOUND: "指定产物不在该验证的清单内",
    VERIFICATION_ARTIFACTS_NOT_RECORDED: "该验证没有记录产物清单",
    VERIFICATION_ASSET_MISSING: "该验证引用的附件不存在",
    VERIFICATION_ASSET_CORRUPT: "该验证引用的附件与记录哈希不一致",
    VERIFICATION_PATH_REJECTED: "产物路径不合法或被该验证的清单拒绝",
  };

/** 可重试码：只有"换个时点再来一次"有意义的才 true（文件级不可读随权限修复可重试） */
export const VERIFICATION_RETRYABLE_CODES: ReadonlySet<VerificationToolErrorCode> = new Set([
  "VERIFICATION_UNREADABLE",
]);

// ---------------------------------------------------------------------------
// 成功 limitation 码（不导致失败的限制项）
// ---------------------------------------------------------------------------

/** MCP2 新增的七个 limitation 码（design D3 表第二行） */
export const VERIFICATION_LIMITATION_CODES = [
  "VERIFICATION_UNTERMINATED",
  "VERIFICATION_SOURCE_MISSING",
  "VERIFICATION_SOURCE_INVALID",
  "VERIFICATION_SNAPSHOT_MISMATCH",
  "VERIFICATION_ENVIRONMENT_UNKNOWN",
  "VERIFICATION_CAPTURE_TRUNCATED",
  "VERIFICATION_PREPARATION_UNAVAILABLE",
] as const;
export type VerificationLimitationCode = (typeof VERIFICATION_LIMITATION_CODES)[number];
