import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  PreparationEventSchema,
  PreparationMetaEventSchema,
  VerificationEventSchema,
  VerificationMetaEventSchema,
  type VerificationOutcome,
} from "../schema.js";
import {
  assetPath,
  preparationRecordPath,
  requireRecordId,
  verificationRecordPath,
} from "./layout.js";
import { ensureRegularFile, RegularFileError } from "./fs-guards.js";

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
      | "RECORD_UNUSUAL"
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

/** 普通文件守卫失败 → 结构化读取错误（symlink/junction/目录替身拒绝，design D4） */
function guardRegularFile(path: string, kind: "记录" | "附件"): void {
  try {
    ensureRegularFile(path, kind);
  } catch (error) {
    if (error instanceof RegularFileError) {
      if (error.failure === "MISSING") {
        throw new RecordReadError(
          kind === "附件" ? "ASSET_MISSING" : "RECORD_NOT_FOUND",
          error.message,
        );
      }
      throw new RecordReadError(
        kind === "附件" ? "ASSET_CORRUPT" : "RECORD_UNUSUAL",
        error.message,
      );
    }
    throw error;
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
  guardRegularFile(file, "记录");
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
    // 来源缺失只标注、不猜同名来源（P16）：实际布局是 traces/<runId>.jsonl 文件
    //（replay read-api 同一约定；早期按目录名判会恒报 missing，不伪装存在）
    result.sourceStatus = existsSync(join(opts.tracesRoot, `${metaParsed.data.target.runId}.jsonl`))
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
  guardRegularFile(file, "附件");
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

// ---------------------------------------------------------------------------
// 准备记录只读面（4.2 main 解析「已准备环境」用；与验证读取同一纪律）
// ---------------------------------------------------------------------------

export type PreparationRecordStatus = "sealed" | "unterminated" | "corrupt" | "unsupported_version";

export interface PreparationRecordRead {
  preparationId: string;
  status: PreparationRecordStatus;
  meta?: {
    preparationId: string;
    epoch: string;
    operationId: string;
    profileId: string;
    planDigest: string;
    createdAt: string;
  };
  /** prepared 事件（构建成功时恰一条；failed 记录没有） */
  prepared?: { imageDigest: string; node: string; typescript: string; at: string };
  failed?: { reason: string; at: string };
  terminated?: { outcome: "prepared" | "failed"; at: string };
  error?: { lineIndex: number; reason: string };
}

/** 读取单条准备记录（固定时点；含未封存现场）。 */
export function getPreparation(root: string, preparationId: string): PreparationRecordRead {
  requireRecordId("preparationId", preparationId);
  const file = preparationRecordPath(root, preparationId);
  guardRegularFile(file, "记录");
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  const result: PreparationRecordRead = { preparationId, status: "corrupt" };
  if (lines.length === 0) {
    result.error = { lineIndex: 0, reason: "空记录文件" };
    return result;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(lines[0]);
  } catch (error) {
    result.error = { lineIndex: 0, reason: `meta 行不是 JSON：${String(error)}` };
    return result;
  }
  const version = (meta as { schemaVersion?: unknown }).schemaVersion;
  if (version !== 1) {
    result.status = "unsupported_version";
    result.error = { lineIndex: 0, reason: `未知 schemaVersion：${String(version)}` };
    return result;
  }
  const metaParsed = PreparationMetaEventSchema.safeParse(meta);
  if (!metaParsed.success || metaParsed.data.preparationId !== preparationId) {
    result.error = {
      lineIndex: 0,
      reason: metaParsed.success ? "meta 身份与请求的 preparationId 不一致" : "meta 形状不合法",
    };
    return result;
  }
  result.meta = {
    preparationId: metaParsed.data.preparationId,
    epoch: metaParsed.data.epoch,
    operationId: metaParsed.data.operationId,
    profileId: metaParsed.data.profileId,
    planDigest: metaParsed.data.planDigest,
    createdAt: metaParsed.data.createdAt,
  };
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
    const event = PreparationEventSchema.safeParse(parsed);
    if (!event.success) {
      result.status = "corrupt";
      result.error = { lineIndex: i, reason: `第 ${i} 行事件形状不合法` };
      return result;
    }
    const data = event.data;
    if (data.type === "meta") {
      result.status = "corrupt";
      result.error = { lineIndex: i, reason: "meta 只能是首行" };
      return result;
    }
    if (data.type === "prepared" && result.prepared === undefined) {
      result.prepared = {
        imageDigest: data.imageDigest,
        node: data.toolchain.node,
        typescript: data.toolchain.typescript,
        at: data.at,
      };
    }
    if (data.type === "failed" && result.failed === undefined) {
      result.failed = { reason: data.reason, at: data.at };
    }
    if (data.type === "terminated") {
      terminatedSeen = true;
      result.terminated = { outcome: data.outcome, at: data.at };
    }
  }
  result.status = terminatedSeen ? "sealed" : "unterminated";
  return result;
}

export interface PreparationSummary {
  preparationId: string;
  status: PreparationRecordStatus;
  outcome?: "prepared" | "failed";
  createdAt?: string;
}

/** 列出准备记录摘要（只扫 verification-environments/）。 */
export function listPreparations(root: string): PreparationSummary[] {
  const dir = join(root, "verification-environments");
  if (!existsSync(dir)) {
    return [];
  }
  const summaries: PreparationSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const preparationId = name.slice(0, -".jsonl".length);
    if (!RECORD_ID_SAFE.test(preparationId)) {
      continue;
    }
    try {
      const record = getPreparation(root, preparationId);
      summaries.push({
        preparationId,
        status: record.status,
        outcome: record.terminated?.outcome,
        createdAt: record.meta?.createdAt,
      });
    } catch {
      // 单条不可读不阻断列表
    }
  }
  return summaries.sort((a, b) => a.preparationId.localeCompare(b.preparationId));
}

/**
 * 解析「当前已准备环境」（4.2 验证执行的前置事实；main 侧调用）：
 * 只认**已封存且 outcome=prepared** 的记录，取 createdAt 最新的一条——
 * 镜像摘要来自记录内 `prepared.imageDigest`（P08：镜像身份从不来自 renderer 输入）。
 * 没有已准备环境 ⇒ null（调用方给 PREPARE_MISSING 业务拒绝）。
 */
export function readLatestPreparedPreparation(
  root: string,
): { preparationId: string; imageDigest: string } | null {
  const dir = join(root, "verification-environments");
  if (!existsSync(dir)) {
    return null;
  }
  let best: { preparationId: string; imageDigest: string; createdAt: string } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const preparationId = name.slice(0, -".jsonl".length);
    if (!RECORD_ID_SAFE.test(preparationId)) {
      continue;
    }
    let record: PreparationRecordRead;
    try {
      record = getPreparation(root, preparationId);
    } catch {
      continue;
    }
    if (
      record.status !== "sealed" ||
      record.terminated?.outcome !== "prepared" ||
      record.prepared === undefined ||
      record.meta === undefined
    ) {
      continue;
    }
    if (best === null || record.meta.createdAt > best.createdAt) {
      best = {
        preparationId,
        imageDigest: record.prepared.imageDigest,
        createdAt: record.meta.createdAt,
      };
    }
  }
  return best === null
    ? null
    : { preparationId: best.preparationId, imageDigest: best.imageDigest };
}
