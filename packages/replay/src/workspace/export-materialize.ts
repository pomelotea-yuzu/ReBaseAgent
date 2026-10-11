import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hashWorkspaceContent } from "./blob-store.js";
import { EXPORT_FILES_ROOT } from "./export-api.js";
import type {
  ExportVerifiedFile,
  WorkspaceExportFailure,
  WorkspaceExportFailureCode,
} from "./export-api.js";

/**
 * 导出目标写入引擎（R2.1 design D2，任务 2.1–2.3）：把已复核的字节物化到用户选定目录下的
 * `files/<逻辑路径>` 文件树，并保证"失败只清本次产物"。
 *
 * 三条硬约束（由结构保证）：
 * 1. **一切排他创建**：目录逐级 `mkdir`（非 recursive）、文件 `open(wx)`，目标里碰巧出现的
 *    条目（竞争者的产物）一律不覆盖——撞上即按 `target_race` 失败，且绝不清理获胜者产物。
 * 2. **产物登记 + 逆序清理**：每个成功创建的目录/文件按创建顺序登记；失败时逆序回收——
 *    文件先核对**所有权**（字节与登记哈希一致才删，被替换的未知内容保留并报告），目录用
 *    非递归 `rmdir`（非空即保留并报告），从不递归删除用户目标根本身。
 * 3. **目标字节复核**：每个文件写入并刷盘后读回比对长度+SHA-256，全部写完后再整树复核一遍；
 *    复核不符按真实故障（`io`）处理，不产出"看起来成功"的半成品。
 *
 * 半成品处理：`wx` 排他创建成功后的写入失败，该名字下的残片**只可能**是本次请求创建的
 * （排他性保证），在失败点立即尽力移除；移除失败并入清理诊断，不吞掉原始错误。
 *
 * 写入顺序（清单最后完成）由调用方编排：本引擎只提供带登记的写入原语，3.x 的清单/补丁
 * 写入也走同一原语（登记进同一份清理账本），保证失败时一并逆序回收。
 */

/** 相对路径统一用 `/` 分隔（与逻辑路径一致），物化时才转宿主分隔符 */
export type ExportRelativePath = string;

/** 一条成功物化的文件：逻辑路径 + 复核过的字节数与哈希（清单 files[] 的直接来源） */
export interface ExportMaterializedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** 未能回收的登记条目：`path` 为相对目标目录的残留路径（场景「残留相对路径」） */
export interface ExportRetainedEntry {
  readonly path: ExportRelativePath;
  readonly reason: string;
}

/** 清理报告：`removed` 是确认已不在目标的相对路径；`complete` = 无保留条目 */
export interface ExportCleanupReport {
  readonly removed: readonly ExportRelativePath[];
  readonly retained: readonly ExportRetainedEntry[];
  readonly complete: boolean;
}

export type MaterializeExportFilesResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly files: readonly ExportMaterializedFile[];
        /** 同一写入会话：补丁/清单（3.x）必须续用它，共享登记与清理账本 */
        readonly writer: WorkspaceExportWriter;
      };
    }
  | {
      readonly ok: false;
      readonly failure: WorkspaceExportFailure;
      readonly cleanup: ExportCleanupReport;
    };

/** 写入引擎内部错误：`code` 直接映射导出失败码，原始 I/O 错误挂在 cause 上 */
export class ExportWriteError extends Error {
  readonly code: Extract<WorkspaceExportFailureCode, "target_race" | "io">;

  constructor(code: "target_race" | "io", message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExportWriteError";
    this.code = code;
  }
}

type RegisteredEntry =
  | { readonly kind: "dir"; readonly physical: string; readonly relative: ExportRelativePath }
  | {
      readonly kind: "file";
      readonly physical: string;
      readonly relative: ExportRelativePath;
      readonly sha256: string;
      readonly bytes: number;
    };

/**
 * 一个导出目标的写入会话：登记本会话创建的每个条目，支撑失败逆序清理。
 * 一个目标目录一个实例；同一个实例覆盖 files/ 文件树、补丁与清单（3.x 接入）。
 */
export class WorkspaceExportWriter {
  /** 创建顺序登记（逆序清理依赖此顺序） */
  private readonly entries: RegisteredEntry[] = [];
  /** 已创建目录的相对路径集合（幂等 ensureDir + 目录竞争判定） */
  private readonly createdDirs = new Set<ExportRelativePath>();
  /** 即时清理阶段的遗留问题（半成品移除失败等），并入最终清理报告 */
  private readonly earlyCleanupIssues: ExportRetainedEntry[] = [];

  constructor(readonly targetDir: string) {}

  /** 相对路径 → 物理路径（只接受 `/` 分隔的相对路径，不接受绝对路径） */
  physical(relativePath: ExportRelativePath): string {
    if (relativePath.length === 0) {
      throw new ExportWriteError("io", "相对路径不得为空");
    }
    if (relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.includes(":")) {
      throw new ExportWriteError("io", `相对路径不合法（不得含盘符/分隔符转义）：${relativePath}`);
    }
    return join(this.targetDir, ...relativePath.split("/"));
  }

  /**
   * 排他创建目录（逐级调用，非 recursive）。本会话已创建过则幂等放行；
   * 被其他请求/进程抢先创建按 `target_race` 失败，不覆盖。
   */
  async ensureDir(relativePath: ExportRelativePath): Promise<void> {
    if (this.createdDirs.has(relativePath)) {
      return;
    }
    const physical = this.physical(relativePath);
    try {
      await mkdir(physical);
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        throw new ExportWriteError(
          "target_race",
          `目录已存在（竞争写入或其他来源），不覆盖既有条目：${relativePath}`,
          { cause: error },
        );
      }
      throw new ExportWriteError("io", `创建目录失败：${relativePath}：${describeError(error)}`, {
        cause: error,
      });
    }
    this.entries.push({ kind: "dir", physical, relative: relativePath });
    this.createdDirs.add(relativePath);
  }

  /**
   * 排他创建并写入一个文件，写入后立即读回复核字节（长度 + SHA-256）。
   * 竞争（`wx` 撞 EEXIST）→ `target_race`，不登记、不清理；写入故障 → 即时移除本次
   * 创建的半成品后抛 `io`；登记在复核通过之后，保证清理账本里只有"确认属于本次"的产物。
   */
  async writeFile(relativePath: ExportRelativePath, data: Uint8Array): Promise<void> {
    const physical = this.physical(relativePath);
    let handle: FileHandle;
    try {
      handle = await open(physical, "wx");
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        throw new ExportWriteError(
          "target_race",
          `写入前目标已出现同名条目，不覆盖竞争者的内容：${relativePath}`,
          { cause: error },
        );
      }
      throw new ExportWriteError(
        "io",
        `创建目标文件失败：${relativePath}：${describeError(error)}`,
        { cause: error },
      );
    }

    try {
      await handle.writeFile(data);
      // 刷盘后再关闭：内容先落地，名字才算数（与 blob store 同一口径）
      await handle.sync();
    } catch (error) {
      // 排他创建已成功 ⇒ 这个名字下的半成品只可能是本次请求的：立即尽力移除
      await this.removeOwnPartialNow(physical, relativePath);
      throw new ExportWriteError(
        "io",
        `写入目标文件失败：${relativePath}：${describeError(error)}`,
        { cause: error },
      );
    } finally {
      // 关闭失败不掩盖原始错误：sync 已刷盘，句柄最终由进程退出兜底
      await handle.close().catch(() => undefined);
    }

    // 目标字节复核：读回比对，防"写入假成功"（截断/卷错误静默吞字节）
    const written = await readFile(physical).catch((error) => {
      throw new ExportWriteError(
        "io",
        `目标字节复核读取失败：${relativePath}：${describeError(error)}`,
        { cause: error },
      );
    });
    if (written.byteLength !== data.byteLength) {
      throw new ExportWriteError(
        "io",
        `目标字节复核不符（长度）：${relativePath}：期望 ${data.byteLength}，实际 ${written.byteLength}`,
      );
    }
    const sha256 = hashWorkspaceContent(data);
    if (hashWorkspaceContent(written) !== sha256) {
      throw new ExportWriteError("io", `目标字节复核不符（哈希）：${relativePath}`);
    }

    this.entries.push({
      kind: "file",
      physical,
      relative: relativePath,
      sha256,
      bytes: data.byteLength,
    });
  }

  /** 全部产物写完后的整树复核：每个登记文件重读比对（防写入后的并发替换漏检） */
  async verifyAll(): Promise<void> {
    for (const entry of this.entries) {
      if (entry.kind !== "file") {
        continue;
      }
      const data = await readFile(entry.physical).catch((error) => {
        throw new ExportWriteError(
          "io",
          `目标复核读取失败：${entry.relative}：${describeError(error)}`,
          { cause: error },
        );
      });
      if (data.byteLength !== entry.bytes || hashWorkspaceContent(data) !== entry.sha256) {
        throw new ExportWriteError("io", `目标复核不符：${entry.relative} 的字节与本次写入不一致`);
      }
    }
  }

  /** 登记的物化文件（清单 files[] 直接来源；调用时机 = 全部成功之后） */
  materializedFiles(): readonly ExportMaterializedFile[] {
    return this.entries
      .filter((entry): entry is Extract<RegisteredEntry, { kind: "file" }> => entry.kind === "file")
      .map((entry) => ({
        path: relativeToLogical(entry.relative),
        bytes: entry.bytes,
        sha256: entry.sha256,
      }));
  }

  /**
   * 逆序清理本次产物：文件先核对所有权（与登记哈希一致才删），目录非递归删除。
   * 未知条目（被替换的内容、塞进来的文件）一律保留并报告，绝不递归删除目标根。
   */
  async cleanup(): Promise<ExportCleanupReport> {
    const removed: ExportRelativePath[] = [];
    const retained: ExportRetainedEntry[] = [...this.earlyCleanupIssues];

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.kind === "file") {
        let data: Awaited<ReturnType<typeof readFile>>;
        try {
          data = await readFile(entry.physical);
        } catch (error) {
          if (isErrnoCode(error, "ENOENT")) {
            removed.push(entry.relative);
            continue;
          }
          retained.push({
            path: entry.relative,
            reason: `清理读取失败：${describeError(error)}`,
          });
          continue;
        }
        if (data.byteLength !== entry.bytes || hashWorkspaceContent(data) !== entry.sha256) {
          retained.push({
            path: entry.relative,
            reason: "内容与本次导出登记不符（疑被替换），保留不删",
          });
          continue;
        }
        try {
          await unlink(entry.physical);
          removed.push(entry.relative);
        } catch (error) {
          retained.push({ path: entry.relative, reason: `删除失败：${describeError(error)}` });
        }
        continue;
      }

      // 目录：非递归删除；空了才消失，非空即保留（里面的内容不是本会话能确认的）
      try {
        await rmdir(entry.physical);
        removed.push(entry.relative);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) {
          removed.push(entry.relative);
          continue;
        }
        if (isErrnoCode(error, "ENOTEMPTY")) {
          retained.push({
            path: entry.relative,
            reason: "目录非空（含未知或未能删除的条目），不做递归删除",
          });
          continue;
        }
        retained.push({ path: entry.relative, reason: `删除目录失败：${describeError(error)}` });
      }
    }

    return { removed, retained, complete: retained.length === 0 };
  }

  /** 半成品即时移除（尽力而为；失败并入清理诊断，不吞原始写入错误） */
  private async removeOwnPartialNow(
    physical: string,
    relativePath: ExportRelativePath,
  ): Promise<void> {
    try {
      await unlink(physical);
    } catch (error) {
      this.earlyCleanupIssues.push({
        path: relativePath,
        reason: `半成品移除失败：${describeError(error)}`,
      });
    }
  }
}

/**
 * 物化选定的文件集合到 `<targetDir>/files/` 文件树（任务 2.1）。
 *
 * - 空集合同样成功：创建空的 `files/` 目录（空快照导出空文件树）；
 * - 任何失败（竞争/写入/复核）都会先逆序清理本次已登记的产物，再返回失败与清理报告；
 * - 不重验目标为空/与 dataDir 的关系——那是 1.2 校验的职责，本函数只负责排他写入；
 *   竞争窗口内的入侵由排他创建兜住。
 */
export async function materializeExportFiles(
  targetDir: string,
  files: readonly ExportVerifiedFile[],
): Promise<MaterializeExportFilesResult> {
  const writer = new WorkspaceExportWriter(targetDir);
  try {
    await writer.ensureDir(EXPORT_FILES_ROOT);
    for (const verified of files) {
      const logicalPath = verified.file.path;
      // 逐级排他创建父目录（`files` 本身已在上面登记），再排他写文件
      const segments = logicalPath.split("/");
      for (let depth = 1; depth < segments.length; depth++) {
        await writer.ensureDir([EXPORT_FILES_ROOT, ...segments.slice(0, depth)].join("/"));
      }
      await writer.writeFile([EXPORT_FILES_ROOT, ...segments].join("/"), verified.data);
    }
    await writer.verifyAll();
    return { ok: true, value: { files: writer.materializedFiles(), writer } };
  } catch (error) {
    const failure = toExportFailure(error);
    const cleanup = await writer.cleanup();
    return { ok: false, failure, cleanup };
  }
}

function toExportFailure(error: unknown): WorkspaceExportFailure {
  if (error instanceof ExportWriteError) {
    return { code: error.code, reason: error.message };
  }
  return { code: "io", reason: `导出写入失败：${describeError(error)}` };
}

/** `files/<逻辑路径>` 形式的登记相对路径还原成逻辑路径 */
function relativeToLogical(relative: ExportRelativePath): string {
  return relative.slice(EXPORT_FILES_ROOT.length + 1);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
