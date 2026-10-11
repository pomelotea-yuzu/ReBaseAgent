import { EXPORT_FILES_ROOT } from "./export-api.js";
import type { ExportPatchPlan } from "./export-patch.js";

/**
 * 导出清单（R2.1 design D3，任务 3.1/3.4）：`<目标>/rebaseagent-export.json`，
 * `format_version:1`。
 *
 * 确定性口径：
 * - 字段与序列化顺序由本模块**固定**（对象字面量构造顺序 + 2 空格缩进 + 末尾换行）；
 * - `files[]` 按路径 UTF-16 代码单元序排列（与快照清单同一排序口径）；
 * - 除 `created_at` 外的一切内容在输入事实相同时逐字节相同——测试注入固定时钟可整文件
 *   比较；不同动作时间的真实导出仅排除 `created_at` 后比较；
 * - **不写**源目录绝对路径、凭据、消息正文、工具参数或任何未经快照记录的历史。
 */

/** 清单 files[] 里的一条已物化文件 */
export interface ExportManifestFile {
  /** 逻辑路径（相对 files_root），UTF-16 码元序排列 */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** 严格 UTF-8 可解码 → text，否则 binary（字节已通过复核） */
  readonly kind: "text" | "binary";
}

/** 六类当前记录能力不保留的状态——一律"未保留（原状态未知）"，不凭源目录或系统默认值推断 */
export const UNPRESERVED_STATUSES = {
  permissions: "未保留（原状态未知）",
  executable_bit: "未保留（原状态未知）",
  timestamps: "未保留（原状态未知）",
  links: "未保留（原状态未知）",
  empty_directories: "未保留（原状态未知）",
  external_services: "未保留（原状态未知）",
} as const;

export interface BuildExportManifestInput {
  readonly runId: string;
  /** null = 初始快照 */
  readonly stepSpanId: string | null;
  readonly snapshotId: string;
  readonly initialSnapshotId: string;
  readonly files: readonly ExportManifestFile[];
  readonly patch: ExportPatchPlan;
  /** 写入成功时的补丁字节与哈希（plan.bytesAndHash） */
  readonly createdAt: string;
}

/**
 * 生成清单 JSON 文本。键顺序即此处字面量顺序；不要动态拼装对象。
 */
export function buildExportManifestJson(input: BuildExportManifestInput): string {
  const files = [...input.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      kind: file.kind,
      status: "exported",
    }));

  const patchSection =
    input.patch.status === "written"
      ? {
          status: "written",
          file: "changes.patch",
          bytes: input.patch.bytesAndHash?.bytes ?? 0,
          sha256: input.patch.bytesAndHash?.sha256 ?? "",
          covered: [...input.patch.covered],
          excluded: input.patch.excluded.map((entry) => ({
            path: entry.path,
            reason: entry.reason,
          })),
        }
      : input.patch.status === "no_text_changes"
        ? { status: "no_text_changes", covered: [], excluded: [] }
        : {
            status: "not_available",
            covered: [],
            excluded: input.patch.excluded.map((entry) => ({
              path: entry.path,
              reason: entry.reason,
            })),
            ...(input.patch.reason === null ? {} : { reason: input.patch.reason }),
          };

  const manifest = {
    format_version: 1,
    source: {
      run_id: input.runId,
      step_span_id: input.stepSpanId,
      snapshot_id: input.snapshotId,
      initial_snapshot_id: input.initialSnapshotId,
    },
    files_root: EXPORT_FILES_ROOT,
    files,
    unpreserved: { ...UNPRESERVED_STATUSES },
    patch: patchSection,
    created_at: input.createdAt,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
