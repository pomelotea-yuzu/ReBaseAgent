import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RegularFileError, ensureRegularFile } from "./fs-guards.js";
import { assetPath } from "./layout.js";
import { RecordReadError, type VerificationRecordRead } from "./reader.js";

/**
 * 记录绑定的资产定位与核验后的安全文本视图（MCP2 design D4/D5，tasks 2.3/2.4）。
 *
 * 定位纪律（M08/V04）：
 * - 日志只能由该记录的 command_end 解析，产物只能由该记录的 artifacts 清单解析；
 *   **不接裸 hash、宿主路径、URL**；
 * - 重复 command_end / 重复产物 path 一律拒绝——不取第一项掩盖歧义；
 * - 记录内引用先过格式校验（64 位十六进制），再构造读取目标；
 * - 附件读取前先整体验证普通文件形态 + 完整大小/SHA-256，再返回内容。
 *
 * 三层事实分开（M10）：capture（记录内 byteLength/totalBytes/truncated，执行时
 * 保留 vs 观测）、fullAsset（完整核验附件的 size/hash）、response（本响应的码点
 * 范围/截断/续读位置）。读完保留部分不消除执行时丢弃。
 *
 * 严格 UTF-8（M11/V03）：文本视图先严格解码**完整**字节再按 Unicode 码点切片——
 * 不按字节段分别解码（旧 readLog 字节切片可能切断多字节字符，该字节接口保持
 * 既有兼容语义不动）；非法 UTF-8/二进制只给元数据，不出替换字符、不 base64。
 */

// ---------------------------------------------------------------------------
// 定位错误（结构化；文案映射到 MCP 错误码在 mcp-server）
// ---------------------------------------------------------------------------

export type AssetResolveErrorCode =
  | "LOG_NOT_RECORDED"
  | "AMBIGUOUS_COMMAND"
  | "ARTIFACTS_NOT_RECORDED"
  | "ARTIFACT_NOT_FOUND"
  | "DUPLICATE_ARTIFACT_PATH"
  | "INVALID_REFERENCE";

export class AssetResolveError extends Error {
  constructor(
    readonly code: AssetResolveErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AssetResolveError";
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 命令/流定位的记录事实（capture 双口径原样带出） */
export interface ResolvedLogAsset {
  readonly sha256: string;
  readonly capture: {
    readonly byteLength: number;
    readonly totalBytes: number;
    readonly truncated: boolean;
  };
}

/** 从记录内唯一 command_end 解析日志附件（重复命令拒绝，不取第一项） */
export function resolveLogAsset(
  record: VerificationRecordRead,
  commandId: "typecheck" | "test",
  stream: "stdout" | "stderr",
): ResolvedLogAsset {
  const ends = record.events.filter(
    (event) => event.type === "command_end" && event.commandId === commandId,
  );
  if (ends.length === 0) {
    throw new AssetResolveError(
      "LOG_NOT_RECORDED",
      `记录 ${record.verificationId} 没有命令 ${commandId} 的执行事实`,
    );
  }
  if (ends.length > 1) {
    throw new AssetResolveError(
      "AMBIGUOUS_COMMAND",
      `记录 ${record.verificationId} 中命令 ${commandId} 有 ${String(ends.length)} 条 command_end，定位歧义`,
    );
  }
  const end = ends[0];
  if (end?.type !== "command_end") {
    throw new AssetResolveError("LOG_NOT_RECORDED", "没有命令执行事实");
  }
  const side = stream === "stdout" ? end.stdout : end.stderr;
  if (!HASH_PATTERN.test(side.sha256)) {
    throw new AssetResolveError("INVALID_REFERENCE", `记录内 ${stream} 哈希不符合 64 位十六进制`);
  }
  return {
    sha256: side.sha256,
    capture: {
      byteLength: side.byteLength,
      totalBytes: side.totalBytes,
      truncated: side.truncated,
    },
  };
}

/** 产物定位的记录事实 */
export interface ResolvedArtifactAsset {
  readonly sha256: string;
  readonly size: number;
  /** 该记录 artifacts 清单的排除规则原样带出（M09） */
  readonly excludedPatterns: readonly string[];
}

/**
 * 从记录内 artifacts 清单解析产物附件（M09）：
 * - 无 artifacts 事件 = 未采集（ARTIFACTS_NOT_RECORDED），与「合法空清单」分开；
 * - 空清单内查任何 path 都是 ARTIFACT_NOT_FOUND；
 * - 同 path 多条 = 清单冲突（DUPLICATE_ARTIFACT_PATH），不取第一项。
 */
export function resolveArtifactAsset(
  record: VerificationRecordRead,
  path: string,
): ResolvedArtifactAsset {
  const artifactEvents = record.events.filter((event) => event.type === "artifacts");
  if (artifactEvents.length === 0) {
    throw new AssetResolveError(
      "ARTIFACTS_NOT_RECORDED",
      `记录 ${record.verificationId} 没有产物清单（未采集）`,
    );
  }
  if (artifactEvents.length > 1) {
    throw new AssetResolveError(
      "DUPLICATE_ARTIFACT_PATH",
      `记录 ${record.verificationId} 有多条 artifacts 事件，清单歧义`,
    );
  }
  const event = artifactEvents[0];
  if (event?.type !== "artifacts") {
    throw new AssetResolveError("ARTIFACTS_NOT_RECORDED", "没有产物清单");
  }
  const matches = event.entries.filter((entry) => entry.path === path);
  if (matches.length === 0) {
    throw new AssetResolveError(
      "ARTIFACT_NOT_FOUND",
      `产物 ${path.length > 80 ? `${path.slice(0, 80)}…` : path} 不在该验证的清单内`,
    );
  }
  if (matches.length > 1) {
    throw new AssetResolveError(
      "DUPLICATE_ARTIFACT_PATH",
      `产物清单中 ${path.length > 80 ? `${path.slice(0, 80)}…` : path} 出现 ${String(matches.length)} 次`,
    );
  }
  const entry = matches[0];
  if (entry === undefined || !HASH_PATTERN.test(entry.sha256)) {
    throw new AssetResolveError("INVALID_REFERENCE", "记录内产物哈希不符合 64 位十六进制");
  }
  return {
    sha256: entry.sha256,
    size: entry.size,
    excludedPatterns: [...event.excludedPatterns],
  };
}

// ---------------------------------------------------------------------------
// 完整核验与安全文本视图（M10/M11/V03）
// ---------------------------------------------------------------------------

export interface VerifiedAsset {
  readonly sha256: string;
  readonly size: number;
}

/** 守卫失败 → 结构化读取错误（与 reader 的映射同一口径） */
function guardAssetFile(file: string): void {
  try {
    ensureRegularFile(file, "附件");
  } catch (error) {
    if (error instanceof RegularFileError) throw toRecordReadError(error);
    throw error;
  }
}

/** 整体核验附件：普通文件形态 + 完整 SHA-256（先核验，后允许读内容） */
export function verifyAsset(root: string, sha256Hex: string): VerifiedAsset {
  if (!HASH_PATTERN.test(sha256Hex)) {
    throw new RecordReadError("INVALID_REQUEST", `非法附件哈希：${sha256Hex.slice(0, 12)}`);
  }
  const file = assetPath(root, sha256Hex);
  guardAssetFile(file);
  const bytes = readFileSync(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256Hex) {
    throw new RecordReadError(
      "ASSET_CORRUPT",
      `附件字节与引用哈希不一致：${sha256Hex.slice(0, 12)}`,
    );
  }
  return { sha256: sha256Hex, size: bytes.length };
}

export type AssetBodyView =
  | { readonly kind: "text"; readonly totalChars: number }
  | { readonly kind: "binary"; readonly size: number };

/**
 * 判定完整附件是严格 UTF-8 文本还是二进制（先整体核验哈希）。
 * 只判形态不解码全文——正文由调用方经 sliceAssetText 按码点范围取。
 */
export function classifyAssetBody(root: string, sha256Hex: string): AssetBodyView {
  const file = assetPath(root, requireHash(sha256Hex));
  guardAssetFile(file);
  const bytes = readFileSync(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256Hex) {
    throw new RecordReadError(
      "ASSET_CORRUPT",
      `附件字节与引用哈希不一致：${sha256Hex.slice(0, 12)}`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "binary", size: bytes.length };
  }
  return { kind: "text", totalChars: [...bytes.toString("utf8")].length };
}

export interface AssetTextSlice {
  /** 本段文本（完整解码后的码点切片；保留 CRLF/空串/尾随换行） */
  readonly text: string;
  readonly totalChars: number;
  /** 本段起始码点（回显请求值，便于续读核对） */
  readonly start: number;
  readonly nextStart: number;
  readonly remaining: number;
  readonly truncated: boolean;
}

/**
 * 严格 UTF-8 文本的码点范围切片（M11）：**先**整体严格解码（非法序列已在
 * classifyAssetBody 判二进制——此处对同一哈希再解码，保证两次看到同一字节），
 * **再**按码点切；跨段不丢字、不补替换字符。
 */
export function sliceAssetText(
  root: string,
  sha256Hex: string,
  request: { start?: number; maxChars?: number } = {},
): AssetTextSlice {
  const maxChars = request.maxChars ?? 4096;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RecordReadError("INVALID_REQUEST", "maxChars 必须为正整数");
  }
  const start = request.start ?? 0;
  if (!Number.isInteger(start) || start < 0) {
    throw new RecordReadError("INVALID_REQUEST", "start 必须为非负整数");
  }
  const file = assetPath(root, requireHash(sha256Hex));
  guardAssetFile(file);
  const bytes = readFileSync(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256Hex) {
    throw new RecordReadError(
      "ASSET_CORRUPT",
      `附件字节与引用哈希不一致：${sha256Hex.slice(0, 12)}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RecordReadError("INVALID_REQUEST", "附件不是严格 UTF-8 文本（应走二进制视图）");
  }
  const chars = [...text];
  const sliceStart = Math.min(start, chars.length);
  const slice = chars.slice(sliceStart, sliceStart + maxChars);
  const nextStart = sliceStart + slice.length;
  return {
    text: slice.join(""),
    totalChars: chars.length,
    start: sliceStart,
    nextStart,
    remaining: chars.length - nextStart,
    truncated: nextStart < chars.length,
  };
}

function requireHash(sha256Hex: string): string {
  if (!HASH_PATTERN.test(sha256Hex)) {
    throw new RecordReadError("INVALID_REQUEST", `非法附件哈希：${sha256Hex.slice(0, 12)}`);
  }
  return sha256Hex;
}

function toRecordReadError(error: RegularFileError): RecordReadError {
  return new RecordReadError(
    error.failure === "MISSING" ? "ASSET_MISSING" : "ASSET_CORRUPT",
    error.message,
  );
}

// re-export 供调用方统一错误处理
export { RegularFileError } from "./fs-guards.js";
