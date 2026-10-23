import { lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * 附件 stat 台账（design D6「续读核对所需附件」）。
 *
 * 只 `lstat` 内容寻址附件（`workspace-blobs/sha256/<hash>`），**不读字节**：
 * 名称/类型/字节数/修改时刻足以发现删除、替换、目录顶替；同字节数且保留 mtime 的
 * 原地改写不在承诺内（与 `readVersion` 的 trace 台账同一口径）。
 *
 * `kind` 刻意保留 `dir`/`symlink`/`other`：只比 size/mtime 会把「文件被目录顶替」
 * 读成同一份附件。哈希来自已校验的快照/清单 schema，仍做形状预检以防第二来源。
 */

export type AttachmentKind = "file" | "dir" | "symlink" | "missing" | "other";

export interface AttachmentLedgerEntry {
  readonly sha256: string;
  readonly kind: AttachmentKind;
  readonly bytes: number | null;
  readonly mtimeMs: number | null;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function attachmentLedger(
  dataDir: string,
  hashes: Iterable<string>,
): AttachmentLedgerEntry[] {
  const unique = [...new Set(hashes)].sort();
  return unique.map((sha256) => {
    if (!HASH_PATTERN.test(sha256)) {
      return { sha256, kind: "other", bytes: null, mtimeMs: null };
    }
    try {
      const stat = lstatSync(join(dataDir, "workspace-blobs", "sha256", sha256));
      const kind: AttachmentKind = stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "dir"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other";
      return { sha256, kind, bytes: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      return {
        sha256,
        kind: code === "ENOENT" ? "missing" : "other",
        bytes: null,
        mtimeMs: null,
      };
    }
  });
}
