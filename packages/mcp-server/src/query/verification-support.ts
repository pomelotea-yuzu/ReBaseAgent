import { readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  AssetResolveError,
  RecordReadError,
  RegularFileError,
  VerificationDirReadError,
  getVerification,
  type VerificationRecordRead,
} from "@rebaseagent/project-verification/read";
import type { DataRoot } from "../startup.js";
import { ToolFailure } from "../tool-definition.js";

/**
 * MCP2 验证查询的共享支撑（design D3/D4/D6，tasks 3.x/4.x）：
 * - 验证域错误投影：共享读取层的结构化错误 → 稳定码 ToolFailure（不透传原始异常）；
 * - 验证 readVersion（D6/4.1）：候选集合台账 = verifications/、verification-
 *   environments/、verification-assets/sha256/、**traces/**（参与来源）四个目录的
 *   stat 台账（只 stat 不读内容）+ 工具名 + 入参 + 调用方 extra（日志/产物工具绑定
 *   附件哈希）；每请求重新计算，读后再核对一次——**读中来源变化 ⇒ STALE_CURSOR，
 *   不发布混合事实**；进程重启换密钥 ⇒ 旧会话游标一律 STALE_CURSOR（cursor.ts）；
 * - 记录读取缝：getVerification + tracesRoot 来源状态，异常一律先投影。
 */

// ---------------------------------------------------------------------------
// 错误投影
// ---------------------------------------------------------------------------

/** 文件级权限/形态错误 → 稳定码；其余（真正的程序缺陷）返回 null 由上层继续上抛 */
export function verificationToolError(error: unknown): ToolFailure | null {
  if (error instanceof RecordReadError) {
    switch (error.code) {
      case "RECORD_NOT_FOUND":
        return new ToolFailure("VERIFICATION_NOT_FOUND", "verificationId");
      case "RECORD_UNUSUAL":
        return new ToolFailure("VERIFICATION_UNREADABLE", "verificationId");
      case "RECORD_CORRUPT":
      case "RECORD_UNSUPPORTED_VERSION":
        return new ToolFailure("VERIFICATION_RECORD_INVALID", "verificationId");
      case "ASSET_MISSING":
        return new ToolFailure("VERIFICATION_ASSET_MISSING", "asset");
      case "ASSET_CORRUPT":
        return new ToolFailure("VERIFICATION_ASSET_CORRUPT", "asset");
      case "INVALID_REQUEST":
        return new ToolFailure("INVALID_ARGUMENT");
    }
  }
  if (error instanceof AssetResolveError) {
    switch (error.code) {
      case "LOG_NOT_RECORDED":
        return new ToolFailure("VERIFICATION_LOG_NOT_RECORDED", "commandId");
      case "AMBIGUOUS_COMMAND":
        return new ToolFailure("VERIFICATION_PATH_REJECTED", "commandId");
      case "ARTIFACTS_NOT_RECORDED":
        return new ToolFailure("VERIFICATION_ARTIFACTS_NOT_RECORDED", "path");
      case "ARTIFACT_NOT_FOUND":
        return new ToolFailure("VERIFICATION_ARTIFACT_NOT_FOUND", "path");
      case "DUPLICATE_ARTIFACT_PATH":
        return new ToolFailure("VERIFICATION_PATH_REJECTED", "path");
      case "INVALID_REFERENCE":
        return new ToolFailure("INVALID_ARGUMENT", "record");
    }
  }
  if (error instanceof VerificationDirReadError) {
    // 目录级枚举失败 → STORAGE_IO（与文件级不可读两域不互串，design D3）
    return new ToolFailure("STORAGE_IO");
  }
  if (error instanceof RegularFileError) {
    return new ToolFailure(
      error.failure === "MISSING"
        ? "VERIFICATION_ASSET_MISSING"
        : "VERIFICATION_ASSET_CORRUPT",
      "asset",
    );
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EISDIR") {
    // 文件级不可读（含权限）→ VERIFICATION_UNREADABLE（design D3）
    return new ToolFailure("VERIFICATION_UNREADABLE");
  }
  return null;
}

/** 读取单条验证记录：异常一律先投影成稳定码 */
export function readRecordOrThrow(
  root: DataRoot,
  verificationId: string,
): VerificationRecordRead {
  try {
    return getVerification(root.dataDir, verificationId, { tracesRoot: root.tracesDir });
  } catch (error) {
    const projected = verificationToolError(error);
    throw projected ?? error;
  }
}

// ---------------------------------------------------------------------------
// 验证 readVersion（stat 台账）
// ---------------------------------------------------------------------------

const READ_VERSION_TAG = "rvv1";

interface LedgerEntry {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** 目录台账：不存在 = 空段（缺目录是合法状态，不是变化）；只 stat 不读内容 */
function dirLedger(dir: string, suffix: string): LedgerEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const name of names.sort()) {
    if (suffix !== "" && !name.endsWith(suffix)) continue;
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) continue;
      entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // stat 失败的项记为不可读占位：变化时一定换摘要
      entries.push({ name, size: -1, mtimeMs: -1 });
    }
  }
  return entries;
}

/**
 * 验证域 readVersion（design D6）：四目录 stat 台账 + 工具名 + 入参 + 调用方 extra
 * （日志/产物工具把解析出的附件哈希放进来，附件替换/删除必换摘要 ⇒ 续读 STALE_CURSOR）。
 * traces/ 台账覆盖参与来源（get/compare 的 sourceStatus 依据）；检查点附件不进台账——
 * 验证工具不读检查点内容，只引用记录内 snapshotId。
 * 不逐字节哈希：与 MCP1 read-version 同一取舍（不承诺抵御保留 size/mtime 的本机改写）。
 */
export function computeVerificationReadVersion(
  tool: string,
  args: unknown,
  root: DataRoot,
  extra: unknown = null,
): string {
  const material = JSON.stringify([
    READ_VERSION_TAG,
    tool,
    args,
    verificationLedger(root),
    extra,
  ]);
  return `${READ_VERSION_TAG}:${createHash("sha256")
    .update(Buffer.from(material, "utf8"))
    .digest("hex")}`;
}

/** 四目录 stat 台账（存在/类型/size/mtime；缺目录 = 空段） */
function verificationLedger(root: DataRoot): unknown {
  return [
    dirLedger(join(root.dataDir, "verifications"), ".jsonl"),
    dirLedger(join(root.dataDir, "verification-environments"), ".jsonl"),
    dirLedger(join(root.dataDir, "verification-assets", "sha256"), ""),
    dirLedger(root.tracesDir, ".jsonl"),
  ];
}

/**
 * 读后一致性核验（D6/4.1，M12）：全部读取完成后再算一次摘要；
 * 与读取前不同 ⇒ 期间有来源变化，本轮结果可能是混合事实，发 STALE_CURSOR 让客户端
 * 从首页重查。工具实现必须在**返回 payload 之前**调用（正文读取之后的最后一步）。
 */
export function assertReadUnchanged(
  tool: string,
  requestArgs: unknown,
  root: DataRoot,
  extra: unknown,
  before: string,
): void {
  if (computeVerificationReadVersion(tool, requestArgs, root, extra) !== before) {
    throw new ToolFailure("STALE_CURSOR");
  }
}
