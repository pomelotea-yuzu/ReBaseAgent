import type { WorkspaceSnapshot } from "@rebaseagent/trace-sdk";
import { WorkspaceBlobError, createWorkspaceBlobStore } from "./blob-store.js";
import type { ExportVerifiedFile } from "./export-api.js";
import { ExportDiffError, buildUnifiedDiff, diffBytesAndHash } from "./export-diff.js";
import { tryDecodeUtf8 } from "./utf8.js";

/**
 * 补丁资格（R2.1 design D4，任务 3.2/3.3b）：补丁始终以**同一 run 的初始快照**为基线，
 * 只表达可证明的文本修改与新增——绝不用缺失/损坏/读取失败冒充空侧。
 *
 * 逐路径分类（initial = 初始清单，selected = 选定快照的已复核文件）：
 * - 双方同路径且哈希相同 → 无变化，跳过（连基线附件都不必读）；
 * - 双方同路径但哈希不同 → 必须读基线附件并复核：失败 → **整份补丁 not_available**
 *   （baseline_missing/baseline_corrupt/baseline_io，列明路径）；双方都是严格 UTF-8 文本
 *   → 修改候选；任一侧是二进制 → excluded(binary)；
 * - 仅选定侧有（初始合法清单证明不存在）→ 选定侧是已校验文本 → 新增候选（旧头 /dev/null）；
 *   否则 excluded(binary)；
 * - 仅初始侧有 → excluded(deletion)（R1 file-tools-v1 无删除操作，但按事实如实标注）。
 *
 * 状态判定：
 * - 有 covered 且无基线失败、无超限 → `written`（生成完整 unified diff 文本）；
 * - 毫无变化（covered 与 excluded 都为空）→ `no_text_changes`；
 * - 其余情况（只有 binary/deletion、基线附件不可用、工作量超限）→ `not_available`，
 *   **不生成看似完整的部分补丁**；完整选定快照的文件导出始终不受影响。
 */

/** 补丁未覆盖原因（清单 patch.excluded[].reason 的固定枚举） */
export type ExportPatchExcludedReason =
  | "binary"
  | "deletion"
  | "baseline_missing"
  | "baseline_corrupt"
  | "baseline_io";

export interface ExportPatchExcludedEntry {
  readonly path: string;
  readonly reason: ExportPatchExcludedReason;
}

export interface ExportPatchPlan {
  readonly status: "written" | "no_text_changes" | "not_available";
  /** status === "written" 时的补丁全文（UTF-8 落盘即 changes.patch）；其余为 null */
  readonly diffText: string | null;
  /** 仅 written 时非空：补丁覆盖的逻辑路径（UTF-16 码元序） */
  readonly covered: readonly string[];
  /** 逐路径未覆盖原因（含基线失败；written 时为 binary/deletion 项） */
  readonly excluded: readonly ExportPatchExcludedEntry[];
  /** not_available 的整体原因说明（如工作量超限）；其余为 null */
  readonly reason: string | null;
  /** 仅 written 时有值：补丁字节数与 SHA-256 */
  readonly bytesAndHash: { readonly bytes: number; readonly sha256: string } | null;
}

export interface ComputeExportPatchInput {
  readonly dataDir: string;
  /** 本 run 初始快照（解析期已通过清单 id 复核的合法清单） */
  readonly initial: WorkspaceSnapshot;
  /** 选定快照的已复核文件（字节在手，来自 verifyExportAttachments） */
  readonly selected: readonly ExportVerifiedFile[];
  /** 单文件 diff 工作量上限（透传 buildUnifiedDiff；缺省用其默认值） */
  readonly maxDiffCells?: number;
}

export async function computeExportPatch(input: ComputeExportPatchInput): Promise<ExportPatchPlan> {
  const store = createWorkspaceBlobStore(input.dataDir);
  const selectedByPath = new Map(input.selected.map((file) => [file.file.path, file]));
  const initialByPath = new Map(input.initial.files.map((file) => [file.path, file]));

  const excluded: ExportPatchExcludedEntry[] = [];
  const modifications: Array<{ path: string; oldText: string; newText: string }> = [];
  const additions: Array<{ path: string; newText: string }> = [];
  let baselineFailed = false;

  // 删除：初始有、选定无（不需要基线字节——两份合法清单本身就证明这次变化）
  for (const file of input.initial.files) {
    if (!selectedByPath.has(file.path)) {
      excluded.push({ path: file.path, reason: "deletion" });
    }
  }

  for (const file of input.selected) {
    const initialEntry = initialByPath.get(file.file.path);
    if (initialEntry === undefined) {
      // 新增：初始合法清单证明此路径不存在；选定侧文本才可进补丁
      const newText = tryDecodeUtf8(file.data);
      if (newText === null) {
        excluded.push({ path: file.file.path, reason: "binary" });
      } else {
        additions.push({ path: file.file.path, newText });
      }
      continue;
    }
    if (initialEntry.sha256 === file.file.sha256) {
      continue; // 同路径同内容
    }

    // 修改候选：必须读基线附件并复核——任一失败撤销整份补丁
    const baselineRead = await store.readVerified(initialEntry).catch((error: unknown) => {
      if (error instanceof WorkspaceBlobError && error.code === "io") {
        return { state: "io" as const, reason: error.message };
      }
      throw error;
    });
    if (baselineRead.state === "io") {
      baselineFailed = true;
      excluded.push({ path: file.file.path, reason: "baseline_io" });
      continue;
    }
    if (baselineRead.state === "missing") {
      baselineFailed = true;
      excluded.push({ path: file.file.path, reason: "baseline_missing" });
      continue;
    }
    if (baselineRead.state === "corrupt") {
      baselineFailed = true;
      excluded.push({ path: file.file.path, reason: "baseline_corrupt" });
      continue;
    }
    const oldText = tryDecodeUtf8(baselineRead.data);
    const newText = tryDecodeUtf8(file.data);
    if (oldText === null || newText === null) {
      excluded.push({ path: file.file.path, reason: "binary" });
      continue;
    }
    modifications.push({ path: file.file.path, oldText, newText });
  }

  const byPath = (x: { path: string }, y: { path: string }): number =>
    x.path < y.path ? -1 : x.path > y.path ? 1 : 0;
  excluded.sort(byPath);
  // 覆盖路径整体按 UTF-16 码元序排列（与 diff 生成顺序一致）
  const changes = [
    ...modifications.map((mod) => ({ kind: "modify" as const, ...mod })),
    ...additions.map((add) => ({ kind: "add" as const, ...add })),
  ].sort(byPath);

  if (!baselineFailed && changes.length > 0) {
    // 有可证明的文本变化：逐文件生成 diff；任一超限 → 整份补丁不可用
    let diffText = "";
    try {
      for (const change of changes) {
        diffText +=
          change.kind === "add"
            ? buildUnifiedDiff(null, change.path, "", change.newText, input.maxDiffCells)
            : buildUnifiedDiff(
                change.path,
                change.path,
                change.oldText,
                change.newText,
                input.maxDiffCells,
              );
      }
    } catch (error) {
      if (error instanceof ExportDiffError) {
        return {
          status: "not_available",
          diffText: null,
          covered: [],
          excluded,
          reason: error.message,
          bytesAndHash: null,
        };
      }
      throw error;
    }
    return {
      status: "written",
      diffText,
      covered: changes.map((change) => change.path),
      excluded,
      reason: null,
      bytesAndHash: diffBytesAndHash(diffText),
    };
  }

  if (changes.length === 0 && excluded.length === 0) {
    return {
      status: "no_text_changes",
      diffText: null,
      covered: [],
      excluded: [],
      reason: null,
      bytesAndHash: null,
    };
  }

  return {
    status: "not_available",
    diffText: null,
    covered: [],
    excluded,
    reason: baselineFailed ? "补丁基线附件不可用，整份补丁撤销" : null,
    bytesAndHash: null,
  };
}
