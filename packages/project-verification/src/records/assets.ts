import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assetPath } from "./layout.js";

/**
 * 内容寻址附件的**不可变发布**（design D4：排他发布且不得覆盖）。
 *
 * - 路径 = `verification-assets/sha256/<hash>`，内容由哈希决定，天然去重；
 * - 已存在：逐字节比对，一致则幂等返回 `created:false`；不一致 ⇒ 拒绝（同哈希必须同字节，
 *   不允许借道覆盖）；
 * - 新发布：先写同目录临时文件并 fsync，再 `link()` 原子排他落位（目标存在则 EEXIST），
 *   任何中途崩溃都不会以最终路径留下半截文件。
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface PublishedAsset {
  sha256: string;
  /** 相对数据根的内容寻址路径（记录内引用形态，迁移安全）。 */
  relativePath: string;
  size: number;
  created: boolean;
}

export function publishAsset(root: string, bytes: Uint8Array): PublishedAsset {
  const hash = sha256Hex(bytes);
  const target = assetPath(root, hash);
  const relativePath = join("verification-assets", "sha256", hash);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.length !== bytes.length || !existing.equals(Buffer.from(bytes))) {
      throw new Error(`附件已存在且字节不一致，拒绝覆盖同哈希路径：${hash}`);
    }
    return { sha256: hash, relativePath, size: bytes.length, created: false };
  }
  const temp = join(dir, `.tmp-${hash.slice(0, 16)}-${randomBytes(6).toString("hex")}`);
  const fd = openSync(temp, "wx");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, target); // 排他：目标已存在则抛 EEXIST
  } catch (error) {
    unlinkSync(temp);
    if (!existsSync(target)) {
      throw error;
    }
    // 并发竞态：另一发布者已落位——退回字节比对路径
    const existing = readFileSync(target);
    if (existing.length !== bytes.length || !existing.equals(Buffer.from(bytes))) {
      throw new Error(`附件已存在且字节不一致，拒绝覆盖同哈希路径：${hash}`);
    }
    return { sha256: hash, relativePath, size: bytes.length, created: false };
  }
  unlinkSync(temp);
  return { sha256: hash, relativePath, size: bytes.length, created: true };
}
