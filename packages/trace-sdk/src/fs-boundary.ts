import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/**
 * 共享读取边界：目标必须是**数据根真实路径内**的普通文件。
 *
 * - 符号链接/junction（Node 在 lstat 里都报 isSymbolicLink）一律拒绝；
 * - 目录替身（目标位置是目录）拒绝；
 * - realpath 归一后越出根目录拒绝（覆盖其他 reparse point / 中间链接）；
 * - 只返回受控原因，**不含物理路径**；调用方决定错误码与状态。
 *
 * 不承诺抵御有权限的并发换文件进程；读取层仍以 parse/hash 复核内容。
 */

export type FsBoundaryFailureCode = "not_found" | "not_regular_file" | "symlink" | "escaped" | "io";

export interface FsBoundaryFailure {
  readonly code: FsBoundaryFailureCode;
  readonly reason: string;
}

export class FsBoundaryError extends Error {
  constructor(
    readonly code: FsBoundaryFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "FsBoundaryError";
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function isWithin(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal.toLowerCase(), targetReal.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 返回违规原因；合法普通文件返回 null。不抛异常（I/O 故障也变成 failure） */
export function checkRegularFileWithinRoot(
  rootDir: string,
  targetPath: string,
): FsBoundaryFailure | null {
  let rootReal: string;
  try {
    rootReal = realpathSync.native(rootDir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { code: "not_found", reason: "数据根不存在" };
    }
    return { code: "io", reason: "无法解析数据根真实路径" };
  }

  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(targetPath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { code: "not_found", reason: "目标不存在" };
    }
    return { code: "io", reason: "无法读取目标文件状态" };
  }

  if (stats.isSymbolicLink()) {
    return { code: "symlink", reason: "目标经符号链接/junction，拒绝读取" };
  }
  if (!stats.isFile()) {
    return { code: "not_regular_file", reason: "目标不是普通文件" };
  }

  let targetReal: string;
  try {
    targetReal = realpathSync.native(targetPath);
  } catch {
    return { code: "io", reason: "无法解析目标真实路径" };
  }
  if (!isWithin(rootReal, targetReal)) {
    return { code: "escaped", reason: "目标真实路径越过数据根" };
  }
  return null;
}

/** 断言式入口：违规抛受控 FsBoundaryError（message 不含物理路径） */
export function assertRegularFileWithinRoot(rootDir: string, targetPath: string): void {
  const failure = checkRegularFileWithinRoot(rootDir, targetPath);
  if (failure !== null) {
    throw new FsBoundaryError(failure.code, failure.reason);
  }
}
