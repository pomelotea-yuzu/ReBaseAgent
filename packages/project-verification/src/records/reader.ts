import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  VerificationEventSchema,
  VerificationMetaEventSchema,
  type VerificationOutcome,
} from "../schema.js";
import { assetPath, requireRecordId, verificationRecordPath } from "./layout.js";

const RECORD_ID_SAFE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 只读读取器（list/get/readLog）——**本模块永不导入执行器**（design D3，MCP2 复用面）。
 *
 * 读取纪律（design D4）：
 * - 每次读取反映**固定时点**的文件内容，不以活跃 registry 猜历史结局；
 * - 逐行验证版本/事件顺序/身份/引用：坏尾、未知版本、身份错配、terminated 非末行、
 *   重复终止 ⇒ 结构化降级为 `corrupt` / `unsupported_version` / `unterminated`，
 *   **任何非 sealed 状态都不得呈现为 passed**（P15）；
 * - 日志按内容寻址附件读取：先整体验证哈希（P16「附件按自身引用校验」），再按
 *   offset/maxLength 有界切片，返回 nextOffset/remaining/truncated（P13）；
 * - 来源缺失只**标注**（sourceStatus），不猜同名来源（P16）；list 只扫
 *   `verifications/`，旧运行列表/MCP1 只扫 traces，互不计入。
 */

/** 单次日志读取的默认与上限（design D4：默认 32 KiB、上限 64 KiB/请求）。 */
export const LOG_READ_DEFAULT_BYTES = 32768;
export const LOG_READ_MAX_BYTES = 65536;

export type VerificationRecordStatus =
  | "sealed"
  | "unterminated"
  | "corrupt"
  | "unsupported_version";

export class RecordReadError extends Error {
  constructor(
    readonly code:
      | "RECORD_NOT_FOUND"
      | "RECORD_CORRUPT"
      | "RECORD_UNSUPPORTED_VERSION"
      | "ASSET_MISSING"
      | "ASSET_CORRUPT"
      | "INVALID_REQUEST",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RecordReadError";
  }
}

export interface VerificationSummary {
  verificationId: string;
  status: VerificationRecordStatus;
  outcome?: VerificationOutcome;
  runId?: string;
  commandId?: string;
  createdAt?: string;
}

export type SourceStatus = "unknown" | "present" | "missing";

export interface VerificationRecordRead {
  verificationId: string;
  status: VerificationRecordStatus;
  meta?: z.infer<typeof VerificationMetaEventSchema>;
  events: z.infer<typeof VerificationEventSchema>[];
  terminated?: z.infer<typeof VerificationEventSchema> & { type: "terminated" };
  /** 错误定位（corrupt 时的行号/原因），供展示与诊断，不含敏感正文。 */
  error?: { lineIndex: number; reason: string };
  sourceStatus: SourceStatus;
}

function parseLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

/** 读取单条验证记录（固定时点；含运行中未封存文件）。 */
export function getVerification(
  root: string,
  verificationId: string,
  opts: { tracesRoot?: string } = {},
): VerificationRecordRead {
  requireRecordId("verificationId", verificationId);
  const file = verificationRecordPath(root, verificationId);
  if (!existsSync(file)) {
    throw new RecordReadError("RECORD_NOT_FOUND", `验证记录不存在：${verificationId}`);
  }
  const text = readFileSync(file, "utf8");
  const lines = parseLines(text);
  // status 在每个返回路径显式赋值；初始值仅为满足严格类型，不会被子路径观察
  const result: VerificationRecordRead = {
    verificationId,
    status: "corrupt",
    events: [],
    sourceStatus: "unknown",
  };

  if (lines.length === 0) {
    result.status = "corrupt";
    result.error = { lineIndex: 0, reason: "空记录文件" };
    return result;
  }

  let meta: unknown;
  try {
    meta = JSON.parse(lines[0]);
  } catch (error) {
    result.status = "corrupt";
    result.error = { lineIndex: 0, reason: `meta 行不是 JSON：${String(error)}` };
    return result;
  }
  const metaVersion = (meta as { schemaVersion?: unknown }).schemaVersion;
  if (metaVersion !== 1) {
    result.status = "unsupported_version";
    result.error = { lineIndex: 0, reason: `未知 schemaVersion：${String(metaVersion)}` };
    return result;
  }
  const metaParsed = VerificationMetaEventSchema.safeParse(meta);
  if (!metaParsed.success || metaParsed.data.verificationId !== verificationId) {
    result.status = "corrupt";
    result.error = {
      lineIndex: 0,
      reason: metaParsed.success ? "meta 身份与请求的 verificationId 不一致" : "meta 形状不合法",
    };
    return result;
  }
  result.meta = metaParsed.data;
  if (opts.tracesRoot !== undefined) {
    // 来源缺失只标注、不猜同名来源（P16）：traces/<runId> 是精确目录名比对
    result.sourceStatus = existsSync(join(opts.tracesRoot, metaParsed.data.target.runId))
      ? "present"
      : "missing";
  }

  let terminatedSeen = false;
  for (let i = 1; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (error) {
      result.status = "corrupt";
      result.error = { lineIndex: i, reason: `第 ${i} 行不是 JSON（坏尾）：${String(error)}` };
      return result;
    }
    const event = VerificationEventSchema.safeParse(parsed);
    if (!event.success) {
      result.status = "corrupt";
      result.error = { lineIndex: i, reason: `第 ${i} 行事件形状不合法` };
      return result;
    }
    if (event.data.type === "meta") {
      result.status = "corrupt";
      result.error = { lineIndex: i, reason: "meta 只能是首行" };
      return result;
    }
    if (event.data.type === "terminated") {
      if (terminatedSeen) {
        result.status = "corrupt";
        result.error = { lineIndex: i, reason: "terminated 事件出现多次" };
        return result;
      }
      if (i !== lines.length - 1) {
        result.status = "corrupt";
        result.error = { lineIndex: i, reason: "terminated 之后仍有事件（必须为末行）" };
        return result;
      }
      terminatedSeen = true;
      result.terminated = event.data;
      continue;
    }
    result.events.push(event.data);
  }

  if (!terminatedSeen) {
    result.status = "unterminated";
    return result;
  }
  result.status = "sealed";
  return result;
}

/** 列出验证记录摘要（只扫 `verifications/`，不触碰 traces/）。 */
export function listVerifications(root: string): VerificationSummary[] {
  const dir = join(root, "verifications");
  if (!existsSync(dir)) {
    return [];
  }
  const summaries: VerificationSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const verificationId = name.slice(0, -".jsonl".length);
    if (!RECORD_ID_SAFE.test(verificationId)) {
      continue;
    }
    try {
      const record = getVerification(root, verificationId);
      summaries.push({
        verificationId,
        status: record.status,
        outcome: record.terminated?.outcome,
        runId: record.meta?.target.runId,
        commandId: record.meta?.commandId,
        createdAt: record.meta?.createdAt,
      });
    } catch {
      // 单条不可读不阻断列表（NOT_FOUND 等结构化错误降级为跳过）
    }
  }
  return summaries.sort((a, b) => a.verificationId.localeCompare(b.verificationId));
}

export interface LogReadResult {
  /** 本段文本（UTF-8 解码；原始字节附件与安全文本视图由调用侧分开处理）。 */
  text: string;
  totalBytes: number;
  nextOffset: number;
  remaining: number;
  truncated: boolean;
}

/**
 * 有界读取内容寻址日志附件：先整体验证哈希（P16），再按 offset/maxLength 切片
 * （P13：内存/落盘有界，超上限自动钳制到 64 KiB）。
 */
export function readLog(
  root: string,
  sha256HexRef: string,
  request: { offset?: number; maxLength?: number } = {},
): LogReadResult {
  if (!/^[0-9a-f]{64}$/.test(sha256HexRef)) {
    throw new RecordReadError("INVALID_REQUEST", `非法附件哈希：${sha256HexRef}`);
  }
  const offset = request.offset ?? 0;
  const maxLength = Math.min(request.maxLength ?? LOG_READ_DEFAULT_BYTES, LOG_READ_MAX_BYTES);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxLength) || maxLength <= 0) {
    throw new RecordReadError(
      "INVALID_REQUEST",
      `offset/maxLength 必须为非负整数：${offset}/${maxLength}`,
    );
  }
  const file = assetPath(root, sha256HexRef);
  if (!existsSync(file)) {
    throw new RecordReadError("ASSET_MISSING", `附件不存在：${sha256HexRef.slice(0, 12)}`);
  }
  const bytes = readFileSync(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256HexRef) {
    throw new RecordReadError(
      "ASSET_CORRUPT",
      `附件字节与引用哈希不一致：${sha256HexRef.slice(0, 12)}`,
    );
  }
  const totalBytes = bytes.length;
  const start = Math.min(offset, totalBytes);
  const end = Math.min(start + maxLength, totalBytes);
  return {
    text: bytes.subarray(start, end).toString("utf8"),
    totalBytes,
    nextOffset: end,
    remaining: totalBytes - end,
    truncated: end < totalBytes,
  };
}
