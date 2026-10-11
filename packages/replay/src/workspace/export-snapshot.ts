import { realpath } from "node:fs/promises";
import {
  EXPORT_FILES_ROOT,
  findExportMaterializationViolation,
  resolveExportSnapshots,
  validateExportTargetDir,
  verifyExportAttachments,
} from "./export-api.js";
import type {
  ExportVerifiedFile,
  ExportWorkspaceSnapshotRequest,
  WorkspaceExportFailure,
} from "./export-api.js";
import { DEFAULT_MAX_DIFF_CELLS } from "./export-diff.js";
import { buildExportManifestJson } from "./export-manifest.js";
import type { ExportManifestFile } from "./export-manifest.js";
import { ExportWriteError, materializeExportFiles } from "./export-materialize.js";
import type { ExportCleanupReport } from "./export-materialize.js";
import { computeExportPatch } from "./export-patch.js";
import type { ExportPatchPlan } from "./export-patch.js";
import { tryDecodeUtf8 } from "./utf8.js";

/**
 * 包层导出编排（R2.1 design D1，任务 3.X 收口）：把一个已校验的初始/本 run 自有完成
 * 检查点完整导出到调用方选定的空目录——`files/` 文件树 + `changes.patch`（适用时）+
 * `rebaseagent-export.json`（**最后**写入并关闭，之前任何失败都不存在清单）。
 *
 * 阶段顺序（每一步都只读历史事实或写目标，不碰 source/父链/trace/blob）：
 * 1. `resolveExportSnapshots`——单次读取定位选定快照与初始快照（补丁基线）；
 * 2. `validateExportTargetDir`——目标存在/普通/为空/非链接/排除 dataDir 关系；
 * 3. `verifyExportAttachments`——选定快照全部附件复核，任一失败整次失败；
 * 4. 物化路径预检——宿主长度规则明确拒绝，不静默改名；
 * 5. `materializeExportFiles`——排他物化 files/ 树 + 字节复核；
 * 6. `computeExportPatch`——补丁资格（基线附件按需读取，只影响补丁，不影响文件导出）；
 * 7. written 补丁排他写入 → 清单排他写入（最后）→ 整树复核 → 成功。
 *
 * 第 5 步起任何失败都通过同一写入会话逆序清理本次产物；第 1–4 步零写入，失败时返回
 * 空清理报告。导出不登记主动 operation、不消费授权——那是桌面层（5.x）的事，本层只管
 * 快照/附件/目标的事实校验与受控写入。
 */

export interface ExportWorkspaceSnapshotOptions {
  /**
   * 注入时钟：清单 `created_at`（ISO 字符串）。缺省取当前 UTC 时间——除 created_at 外
   * 清单内容在输入事实相同时确定，测试用固定时钟做整文件比较。
   */
  readonly now?: () => string;
  /** 单文件 diff 工作量上限（测试注入；缺省 DEFAULT_MAX_DIFF_CELLS） */
  readonly maxDiffCells?: number;
}

/** 成功结果（design D5 的包层部分；桌面层据此组织反馈） */
export interface WorkspaceExportSuccess {
  /** 实际目标目录（realpath 归一后的绝对路径） */
  readonly targetDir: string;
  readonly filesRoot: string;
  readonly fileCount: number;
  /** 全部文件字节数（不含清单/补丁等元信息） */
  readonly totalFileBytes: number;
  readonly snapshotId: string;
  readonly stepSpanId: string | null;
  readonly patch: {
    readonly status: ExportPatchPlan["status"];
    /** 仅 written 时为 "changes.patch" */
    readonly file: string | null;
    readonly bytes: number | null;
    readonly sha256: string | null;
    readonly covered: readonly string[];
    readonly excluded: ExportPatchPlan["excluded"];
    /** not_available 的整体原因（超限/基线不可用），其余 null */
    readonly reason: string | null;
  };
}

export type ExportWorkspaceSnapshotResult =
  | { readonly ok: true; readonly value: WorkspaceExportSuccess }
  | {
      readonly ok: false;
      readonly failure: WorkspaceExportFailure;
      readonly cleanup: ExportCleanupReport;
    };

const EMPTY_CLEANUP: ExportCleanupReport = { removed: [], retained: [], complete: true };

/**
 * 导出一个检查点（包层唯一入口）。失败一律返回可辨认的结构化结果，不抛错；
 * 真实 I/O 故障也映射为 `io` 失败并附清理报告。
 */
export async function exportWorkspaceSnapshot(
  request: ExportWorkspaceSnapshotRequest,
  options: ExportWorkspaceSnapshotOptions = {},
): Promise<ExportWorkspaceSnapshotResult> {
  // ① 定位（零写入）
  const resolved = resolveExportSnapshots(request.dataDir, request.runId, request.stepSpanId);
  if (!resolved.ok) {
    return { ok: false, failure: resolved.failure, cleanup: EMPTY_CLEANUP };
  }

  // ② 目标校验（零写入；真正的竞争由第 5 步的排他创建兜住）
  const target = await validateExportTargetDir(request.dataDir, request.targetDir);
  if (!target.ok) {
    return { ok: false, failure: target.failure, cleanup: EMPTY_CLEANUP };
  }

  // ③ 选定快照全部附件复核（零写入）
  const verified = await verifyExportAttachments(request.dataDir, resolved.value.selected.snapshot);
  if (!verified.ok) {
    return { ok: false, failure: verified.failure, cleanup: EMPTY_CLEANUP };
  }

  // ④ 物化路径预检（零写入；超限明确拒绝，不静默改名）
  const violation = findExportMaterializationViolation(
    request.targetDir,
    verified.value.map((file) => file.file.path),
  );
  if (violation !== null) {
    return {
      ok: false,
      failure: { code: "target_invalid", reason: violation },
      cleanup: EMPTY_CLEANUP,
    };
  }

  // ⑤–⑦ 从这里起会落盘：全部失败都逆序清理本次产物
  const materialized = await materializeExportFiles(request.targetDir, verified.value);
  if (!materialized.ok) {
    return { ok: false, failure: materialized.failure, cleanup: materialized.cleanup };
  }
  const { writer, files } = materialized.value;

  try {
    // ⑥ 补丁资格：基线附件按需读取，只影响补丁，不影响已完成的文件导出
    const patch = await computeExportPatch({
      dataDir: request.dataDir,
      initial: resolved.value.initialSnapshot,
      selected: verified.value,
      maxDiffCells: options.maxDiffCells ?? DEFAULT_MAX_DIFF_CELLS,
    });
    if (patch.status === "written" && patch.diffText !== null) {
      await writer.writeFile("changes.patch", new TextEncoder().encode(patch.diffText));
    }

    // ⑦ 清单最后写入：任何更早的失败都不会留下清单
    const manifestFileEntries = toManifestFiles(verified.value);
    const manifestJson = buildExportManifestJson({
      runId: request.runId,
      stepSpanId: resolved.value.selected.stepSpanId,
      snapshotId: resolved.value.selected.snapshot.id,
      initialSnapshotId: resolved.value.initialSnapshot.id,
      files: manifestFileEntries,
      patch,
      createdAt: options.now?.() ?? new Date().toISOString(),
    });
    await writer.writeFile("rebaseagent-export.json", new TextEncoder().encode(manifestJson));

    // 目标复核（含补丁与清单）：完整关闭且字节核对通过才算成功
    await writer.verifyAll();

    const targetDir = await realpath(request.targetDir);
    return {
      ok: true,
      value: {
        targetDir,
        filesRoot: EXPORT_FILES_ROOT,
        fileCount: files.length,
        totalFileBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        snapshotId: resolved.value.selected.snapshot.id,
        stepSpanId: resolved.value.selected.stepSpanId,
        patch: {
          status: patch.status,
          file: patch.status === "written" ? "changes.patch" : null,
          bytes: patch.bytesAndHash?.bytes ?? null,
          sha256: patch.bytesAndHash?.sha256 ?? null,
          covered: patch.covered,
          excluded: patch.excluded,
          reason: patch.reason,
        },
      },
    };
  } catch (error) {
    const cleanup = await writer.cleanup();
    return { ok: false, failure: toExportFailure(error), cleanup };
  }
}

/** 已复核文件 → 清单 files[] 条目（kind 由严格 UTF-8 解码判定） */
function toManifestFiles(files: readonly ExportVerifiedFile[]): readonly ExportManifestFile[] {
  return files.map((file) => ({
    path: file.file.path,
    bytes: file.file.bytes,
    sha256: file.file.sha256,
    kind: tryDecodeUtf8(file.data) === null ? "binary" : "text",
  }));
}

function toExportFailure(error: unknown): WorkspaceExportFailure {
  if (error instanceof ExportWriteError) {
    return { code: error.code, reason: error.message };
  }
  return {
    code: "io",
    reason: `导出写入失败：${error instanceof Error ? error.message : String(error)}`,
  };
}
