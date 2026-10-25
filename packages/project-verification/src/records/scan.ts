import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RECORD_ID_PATTERN } from "./layout.js";
import { getVerification, RecordReadError, type VerificationSummary } from "./reader.js";

/**
 * 完整验证列表扫描（MCP2 design D2）。
 *
 * 与既有 `listVerifications` 的分工（旧接口保持兼容、不改动）：
 * - 损坏/未知版本记录由 reader 判定后以 `status` 显式保留在摘要里（两种接口同），
 *   outcome 为空、不得呈现为 passed；
 * - 旧接口对**读取抛错**（权限/竞态删除）静默跳过——scan 把这类项与非法文件名
 *   一起显式保留为失败项，供 MCP `list_verifications` 展示"有记录但读不出"
 *   而不是伪造空目录（M03/V04）。
 *
 * 目录区分（design D2/M03）：目录不存在是合法空列表且不建目录；目录存在但
 * 枚举失败（权限/IO）抛 `VerificationDirReadError`——**不能当空**，两域不得互串
 * （目录级给 STORAGE_IO，单文件级给 VERIFICATION_UNREADABLE，映射在 mcp-server）。
 *
 * 排序（design D2/M02）：可判定摘要按 createdAt 倒序、verificationId 按 UTF-16
 * 码元升序解同刻（不用 localeCompare——区域排序跨机器不稳定）；无可信时间置后；
 * 失败项整体排末尾，按文件名字节序。
 */

/** 单条读取失败的原因（结构化，不含宿主路径/原始异常文本） */
export type ScanFailureReason = "UNREADABLE" | "CORRUPT" | "UNSUPPORTED_VERSION" | "INVALID_NAME";

export interface VerificationScanFailure {
  readonly kind: "unreadable";
  /** 安全文件标识（仅文件名部分；不含目录） */
  readonly fileName: string;
  /** 文件名可安全解析出记录 ID 时给出；非法名不给 */
  readonly verificationId: string | null;
  readonly reason: ScanFailureReason;
  /** 有界诊断（reader 的行号/短原因；不含异常堆栈） */
  readonly detail: string | null;
}

export type VerificationScanEntry =
  | ({ readonly kind: "record" } & VerificationSummary)
  | VerificationScanFailure;

/** 目录级枚举失败（权限/IO）；文件级不可读走 scan failure 项，两者不混 */
export class VerificationDirReadError extends Error {
  constructor(cause: unknown) {
    super("验证目录枚举失败");
    this.name = "VerificationDirReadError";
    this.cause = cause;
  }
}

function utf16Asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 扫描 `verifications/`（固定时点；含未封存/损坏记录）。
 * 只读：不建目录、不写任何文件；单条读取的异常一律转成失败项，不上抛。
 */
export function scanVerifications(root: string): VerificationScanEntry[] {
  const dir = join(root, "verifications");
  if (!existsSync(dir)) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new VerificationDirReadError(error);
  }
  const records: Array<VerificationScanEntry & { kind: "record" }> = [];
  const failures: VerificationScanFailure[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const verificationId = name.slice(0, -".jsonl".length);
    if (!RECORD_ID_PATTERN.test(verificationId)) {
      failures.push({
        kind: "unreadable",
        fileName: name,
        verificationId: null,
        reason: "INVALID_NAME",
        detail: null,
      });
      continue;
    }
    try {
      const record = getVerification(root, verificationId);
      records.push({
        kind: "record",
        verificationId,
        status: record.status,
        outcome: record.terminated?.outcome,
        runId: record.meta?.target.runId,
        commandId: record.meta?.commandId,
        createdAt: record.meta?.createdAt,
      });
    } catch (error) {
      // reader 的结构化错误带 code；非结构化异常（权限等）归 UNREADABLE——
      // 文件级不可读（含权限）在此显式保留，不与目录级枚举失败互串
      const reason: ScanFailureReason =
        error instanceof RecordReadError
          ? error.code === "RECORD_CORRUPT"
            ? "CORRUPT"
            : error.code === "RECORD_UNSUPPORTED_VERSION"
              ? "UNSUPPORTED_VERSION"
              : "UNREADABLE"
          : "UNREADABLE";
      failures.push({
        kind: "unreadable",
        fileName: name,
        verificationId,
        reason,
        detail: null,
      });
    }
  }
  records.sort((a, b) => {
    const timeA = a.createdAt ?? null;
    const timeB = b.createdAt ?? null;
    if (timeA === null && timeB !== null) return 1;
    if (timeA !== null && timeB === null) return -1;
    if (timeA !== null && timeB !== null && timeA !== timeB) {
      return timeA < timeB ? 1 : -1; // createdAt 倒序
    }
    return utf16Asc(a.verificationId, b.verificationId);
  });
  failures.sort((a, b) => utf16Asc(a.fileName, b.fileName));
  return [...records, ...failures];
}
