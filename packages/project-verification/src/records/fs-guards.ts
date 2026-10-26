import { type Stats, lstatSync } from "node:fs";

/**
 * 根内普通文件守卫（MCP2 design D4）：记录/附件必须是数据根内的**普通文件**。
 *
 * 拒绝：symlink/junction/reparse point（Node 的 lstat 把三者都报成符号链接）、
 * 目录替身、设备/管道等非普通文件。路径构造本身已由 layout.ts 的 ID/哈希校验
 * 收窄（无穿越/盘符/UNC 形态），本守卫负责最后一层「文件系统对象形态」判定。
 * lstat 不跟随链接：指向数据根内部的合法链接同样拒绝——读取面只认记录引用的
 * 原位文件，不做替身解析（V04）。错误以结构化形态上抛，文案映射归调用方。
 */

export type RegularFileFailure = "MISSING" | "SYMLINK" | "NOT_REGULAR";

export class RegularFileError extends Error {
  constructor(
    readonly failure: RegularFileFailure,
    readonly kind: "记录" | "附件",
  ) {
    super(`${kind}不是可读的普通文件（${failure}）`);
    this.name = "RegularFileError";
  }
}

export function ensureRegularFile(path: string, kind: "记录" | "附件"): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      throw new RegularFileError("MISSING", kind);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new RegularFileError("SYMLINK", kind);
  }
  if (!stat.isFile()) {
    throw new RegularFileError("NOT_REGULAR", kind);
  }
}
