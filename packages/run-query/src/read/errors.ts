import { TraceReadError } from "@rebaseagent/trace-sdk";
import { FsBoundaryError } from "@rebaseagent/trace-sdk/fs-boundary";
import type { RunLineageDiagnostic } from "./lineage.js";

/**
 * 稳定错误码命名空间（design D4）。不解析中文异常文本，不向外部透传物理路径。
 *
 * - 启动域：只有 `DATA_DIR_INVALID`，由 CLI 在服务初始化前以 stderr + 非零退出承载；
 * - 工具错误域：业务失败的结构化 `error.code`；
 * - limitation 域单独定义，只有提示、不导致失败。
 */
export type RunQueryStartupCode = "DATA_DIR_INVALID";

export type RunQueryToolErrorCode =
  | "INVALID_ARGUMENT"
  | "RUN_NOT_FOUND"
  | "RUN_INVALID"
  | "UNSUPPORTED_TRACE_VERSION"
  | "IDENTITY_MISMATCH"
  | "ANCESTOR_INVALID"
  | "ANCESTOR_UNREADABLE"
  | "LINEAGE_CYCLE"
  | "FORK_INVALID"
  | "STEP_NOT_FOUND"
  | "SPAN_AMBIGUOUS"
  | "NO_WORKSPACE"
  | "CHECKPOINT_NOT_FOUND"
  | "STORAGE_IO"
  | "STALE_CURSOR"
  | "RESPONSE_LIMIT";

export type RunQueryErrorCode = RunQueryStartupCode | RunQueryToolErrorCode;

export type RunQueryLimitationCode =
  | "TERMINATION_NOT_RECORDED"
  | "ANCESTOR_NOT_FOUND"
  | "BODY_NOT_EXPOSED"
  | "REDACTED";

/**
 * 把读取诊断映射为工具错误码。`ANCESTOR_NOT_FOUND` 是结构化缺失（limitation），
 * 不是错误；若误入错误路径，按 `RUN_INVALID` 处理，不伪装成缺失。
 */
export function classifyLineageDiagnostic(
  diagnostic: RunLineageDiagnostic | null,
): RunQueryToolErrorCode {
  switch (diagnostic) {
    case "CURRENT_RUN_NOT_FOUND":
      return "RUN_NOT_FOUND";
    case "ANCESTOR_INVALID":
      return "ANCESTOR_INVALID";
    case "ANCESTOR_UNREADABLE":
      return "ANCESTOR_UNREADABLE";
    case "LINEAGE_CYCLE":
      return "LINEAGE_CYCLE";
    case "FORK_INVALID":
      return "FORK_INVALID";
    case "ANCESTOR_NOT_FOUND":
    case null:
      return "RUN_INVALID";
  }
}

/**
 * 按结构分类读取异常，不比较异常文本。版本错误在读取器尚未提供结构化码前
 * 统一落 `RUN_INVALID`（design D4：无法可靠细分时用 RUN_INVALID）。
 */
export function classifyReadFailure(error: unknown): RunQueryToolErrorCode {
  if (error instanceof FsBoundaryError) {
    return error.code === "not_found" ? "RUN_NOT_FOUND" : "STORAGE_IO";
  }
  if (error instanceof TraceReadError) return "RUN_INVALID";
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOENT") return "RUN_NOT_FOUND";
  return "STORAGE_IO";
}
