import { join } from "node:path";

/**
 * 验证数据根的目录布局（design D4）：
 *
 * ```text
 * <root>/verifications/<verificationId>.jsonl
 * <root>/verification-assets/sha256/<hash>
 * <root>/verification-environments/<preparationId>.jsonl
 * <root>/verification-runtime/<resourceOwnerId>.json
 * ```
 *
 * ⚠️ 记录内引用（附件、来源）一律存**相对**该 root 的路径——数据根整体迁移后仍可
 * 只读（P15）；读取侧不得依赖旧绝对路径。
 */

/**
 * 记录 ID 的合法字符集：小写字母/数字开头，允许 `-`/`_`，总长 ≤64。
 * 把 ID 收窄到无路径语义的形态，`../`、盘符、分隔符在入口即被拒绝（防穿越）。
 */
export const RECORD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 校验记录 ID；非法（含路径穿越形态）直接抛错。 */
export function requireRecordId(kind: string, id: string): string {
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new Error(`非法${kind}（仅小写字母/数字/-/_，≤64 字符）：${id}`);
  }
  return id;
}

export function verificationRecordPath(root: string, verificationId: string): string {
  return join(root, "verifications", `${requireRecordId("verificationId", verificationId)}.jsonl`);
}

export function preparationRecordPath(root: string, preparationId: string): string {
  return join(
    root,
    "verification-environments",
    `${requireRecordId("preparationId", preparationId)}.jsonl`,
  );
}

export function assetPath(root: string, sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
    throw new Error(`非法附件哈希（64 位小写十六进制）：${sha256Hex}`);
  }
  return join(root, "verification-assets", "sha256", sha256Hex);
}

export function runtimeRegistrationPath(root: string, resourceOwnerId: string): string {
  return join(
    root,
    "verification-runtime",
    `${requireRecordId("resourceOwnerId", resourceOwnerId)}.json`,
  );
}
