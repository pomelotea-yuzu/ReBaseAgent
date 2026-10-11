import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { WorkspaceFile, WorkspaceSnapshot } from "@rebaseagent/trace-sdk";
import { WorkspaceBlobError, createWorkspaceBlobStore } from "./blob-store.js";
import type { BlobReadResult } from "./blob-store.js";
import { locateSnapshotInRun, readWorkspaceRun } from "./read-api.js";
import type {
  LocatedWorkspaceSnapshot,
  WorkspaceLocateFailure,
  WorkspaceLocateFailureCode,
} from "./read-api.js";

/**
 * 包层**导出**接口（R2.1 design D1）：把一个已校验的初始/本 run 自有完成检查点
 * 复制到调用方明确选定的空目录。
 *
 * 与只读接口（read-api）的边界分工：
 * - 本层**只校验当前 run 自有记录、选定检查点、目标目录和选定快照的全部附件**，
 *   不读取父链、不识别桌面 ownOnly、不读源目录——父链完整性是桌面 main（readRunLineage）
 *   的事，包层不以父文件缺失否定自足的自有快照。
 * - **不接受**物理 blob 路径、source 根、任意快照对象或单文件 path 选择：非法请求、
 *   普通无 workspace run、祖先步骤、损坏 trace 一律返回可辨认的结构化失败。
 * - 读取时点固定：`resolveExportSnapshots` 对 run 文件**只读一次**，在同一份记录上同时
 *   取「选定快照」与「初始快照」（后者是补丁基线，任务 3.x 消费）；未封存的 run 可能仍在
 *   追加，两次读取会拼接出不同时点的清单。
 * - 附件先全量复核（长度 + SHA-256），任一缺失/损坏/真实 I/O 故障都使整次导出失败，
 *   不用源目录、祖先检查点或其他 run 补齐（scenario「附件缺失或损坏不生成伪完整导出」）。
 *
 * 本文件固定的是**契约与三个前置阶段**（任务 1.1–1.4）：目标校验 → 快照定位 → 附件复核。
 * 文件物化、清单与补丁（任务 2.x/3.x）在此基础上叠加；任何写入都发生在三个阶段全部通过之后。
 */

/** 导出布局：项目文件树的根目录名（design D3；与根部元信息文件命名空间分离） */
export const EXPORT_FILES_ROOT = "files";

/**
 * 导出请求（包层契约）。`targetDir` 必须是调用方（桌面 main）已经取得用户明确选择的目录；
 * renderer 侧永远只传 runId/stepSpanId，物理路径不越过 main。缺省 `stepSpanId` 表示初始快照。
 */
export interface ExportWorkspaceSnapshotRequest {
  readonly dataDir: string;
  readonly runId: string;
  readonly stepSpanId?: string;
  readonly targetDir: string;
}

/**
 * 导出失败码。前五个与 read-api 的定位失败码**同码同义**（桌面 main 按既有稳定拒绝码映射）；
 * 其余是导出语境新增：
 * - `target_invalid`：目标不存在/不是普通目录/是链接/非空；
 * - `target_conflicts_data_dir`：目标与 dataDir 相同或互为祖先后代；
 * - `target_race`：写入前目标已出现同名条目/目录（竞争写入），不覆盖竞争者内容；
 * - `attachment_unavailable`：选定快照的某条附件缺失或损坏（`path` 给出对应逻辑路径）；
 * - `io`：真实 I/O 故障（读目标/读附件/写目标/目标字节复核不符），不是数据状态，
 *   不伪装成 `target_invalid`/`missing`。
 */
export type WorkspaceExportFailureCode =
  | WorkspaceLocateFailureCode
  | "target_invalid"
  | "target_conflicts_data_dir"
  | "target_race"
  | "attachment_unavailable"
  | "io";

export interface WorkspaceExportFailure {
  readonly code: WorkspaceExportFailureCode;
  readonly reason: string;
  /** 附件相关失败给出对应的逻辑路径 */
  readonly path?: string;
}

export type ExportStageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: WorkspaceExportFailure };

function fail(code: WorkspaceExportFailureCode, reason: string): ExportStageResult {
  return { ok: false, failure: { code, reason } };
}

// ---------------------------------------------------------------------------
// 任务 1.2：目标目录校验
// ---------------------------------------------------------------------------

export type ExportTargetValidationResult = ExportStageResult;

/**
 * 校验导出目标目录：存在、是普通目录、为空，且与 dataDir 没有包含关系。
 *
 * - 目标本身的 symlink/junction 一律拒绝（`lstat` 判定，不解析到链接目标）；父链中间的
 *   链接由 `realpath` 归一后参与 dataDir 关系判定，不额外拒绝。
 * - 与 dataDir 相同、在 dataDir 内部、或是 dataDir 的祖先都拒绝——导出绝不能写进数据目录，
 *   也不能让数据目录成为导出目录的子目录（反过来会被后续清理性删除波及）。
 * - 「为空」在关系判定之后检查：进入本函数不代表可以写入，真正写入前（任务 2.x）还会重验。
 * - 非法目标返回可辨认的拒绝；真实 I/O 故障（权限/磁盘）返回 `io`，不冒充数据状态。
 */
export async function validateExportTargetDir(
  dataDir: string,
  targetDir: string,
): Promise<ExportTargetValidationResult> {
  if (targetDir.length === 0) {
    return fail("target_invalid", "目标目录不得为空");
  }

  let stats: Stats;
  try {
    stats = await lstat(targetDir);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return fail("target_invalid", `目标目录不存在：${targetDir}`);
    }
    return fail("io", `检查目标目录失败：${describeError(error)}`);
  }
  if (stats.isSymbolicLink()) {
    return fail("target_invalid", `目标是符号链接/junction，拒绝作为导出目标：${targetDir}`);
  }
  if (!stats.isDirectory()) {
    return fail("target_invalid", `目标不是目录：${targetDir}`);
  }

  // realpath 归一（Windows 大小写、父链中间链接都在这一步消化），再做相对位置判定
  let targetReal: string;
  let dataReal: string;
  try {
    targetReal = await realpath(targetDir);
    dataReal = await realpath(dataDir);
  } catch (error) {
    return fail("io", `解析目标/数据目录真实路径失败：${describeError(error)}`);
  }
  const conflict = findDataDirRelationViolation(dataReal, targetReal);
  if (conflict !== null) {
    return fail("target_conflicts_data_dir", conflict);
  }

  let entries: string[];
  try {
    entries = await readdir(targetDir);
  } catch (error) {
    return fail("io", `读取目标目录失败：${describeError(error)}`);
  }
  if (entries.length > 0) {
    return fail(
      "target_invalid",
      `目标目录非空（含 ${entries.length} 项），不覆盖既有内容：${targetDir}`,
    );
  }
  return { ok: true };
}

/** 目标与 dataDir 的包含关系判定（入参都是 realpath 归一后的绝对路径） */
function findDataDirRelationViolation(dataReal: string, targetReal: string): string | null {
  if (targetReal === dataReal) {
    return "目标目录与数据目录相同";
  }
  // relative() 跨盘符（Windows）返回绝对路径，isAbsolute 分支视为无关
  const targetFromData = relative(dataReal, targetReal);
  if (targetFromData !== "" && !targetFromData.startsWith("..") && !isAbsolute(targetFromData)) {
    return "目标目录在数据目录内部";
  }
  const dataFromTarget = relative(targetReal, dataReal);
  if (dataFromTarget !== "" && !dataFromTarget.startsWith("..") && !isAbsolute(dataFromTarget)) {
    return "目标目录是数据目录的祖先目录";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 任务 1.2（续）：物化路径预检——按宿主规则明确拒绝，不静默改名
// ---------------------------------------------------------------------------

/**
 * 宿主单条路径长度上限：Windows 扩展长度路径硬上限 32767（`\\?\` 前缀形态）；
 * POSIX `PATH_MAX` 为 4096。名称级规则（保留设备名/ADS/尾随点空格等）已由
 * trace-sdk 的逻辑路径契约在清单解析期排除，这里只兜长度。
 */
const HOST_MAX_PATH_LENGTH = process.platform === "win32" ? 32767 : 4096;

/**
 * 预检快照里每条逻辑路径物化到 `<targetDir>/<EXPORT_FILES_ROOT>/…` 后的物理路径长度。
 *
 * 逻辑路径契约保证单段名称合法，但**拼接后的总长度**取决于用户选的目标目录——超出宿主
 * 上限的路径在写入前在这里明确拒绝（可辨认、可展示），绝不静默改名或截断。
 * `maxPathLength` 仅供测试钉行为；生产调用使用宿主默认值。
 */
export function findExportMaterializationViolation(
  targetDir: string,
  logicalPaths: readonly string[],
  maxPathLength: number = HOST_MAX_PATH_LENGTH,
): string | null {
  for (const logicalPath of logicalPaths) {
    const physical = join(targetDir, EXPORT_FILES_ROOT, ...logicalPath.split("/"));
    if (physical.length > maxPathLength) {
      return `物化路径超出宿主长度上限（${physical.length} > ${maxPathLength} 字符）：${logicalPath}——导出被拒绝，不做改名或截断`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 任务 1.3：固定读取选定快照与初始快照（一次读取）
// ---------------------------------------------------------------------------

export type ResolveExportSnapshotResult =
  | {
      readonly ok: true;
      readonly value: {
        /** 选定检查点：初始快照（`stepSpanId` 为 null）或本 run 自有完成步骤的检查点 */
        readonly selected: LocatedWorkspaceSnapshot;
        /** 本 run 初始快照（补丁基线，任务 3.x 消费）；与 selected 出自同一份读取时点 */
        readonly initialSnapshot: WorkspaceSnapshot;
      };
    }
  | { readonly ok: false; readonly failure: WorkspaceExportFailure };

/**
 * 定位导出源：对 run 文件只读一次，在同一份记录上解析选定快照并保留初始快照引用。
 *
 * 拒绝语义与 `locateWorkspaceSnapshot` 完全一致（祖先步骤、非 agent.step、缺检查点都是
 * `step_not_found`）；父 run 文件是否存在不在此关心——包层只对本 run 自有记录负责。
 */
export function resolveExportSnapshots(
  dataDir: string,
  runId: string,
  stepSpanId?: string,
): ResolveExportSnapshotResult {
  const run = readWorkspaceRun(dataDir, runId);
  if (!run.ok) {
    return { ok: false, failure: run.failure };
  }
  const located = locateSnapshotInRun(runId, run.value.workspace, run.value.record, stepSpanId);
  if (!located.ok) {
    return { ok: false, failure: located.failure };
  }
  return {
    ok: true,
    value: {
      selected: located.value,
      initialSnapshot: run.value.workspace.initial_snapshot,
    },
  };
}

// ---------------------------------------------------------------------------
// 任务 1.4：选定快照全部附件的逐文件复核
// ---------------------------------------------------------------------------

/** 一条通过长度与 SHA-256 复核的附件：清单条目 + 原始字节（供 2.x 物化直接消费） */
export interface ExportVerifiedFile {
  readonly file: WorkspaceFile;
  readonly data: Uint8Array;
}

export type VerifyExportAttachmentsResult =
  | { readonly ok: true; readonly value: readonly ExportVerifiedFile[] }
  | { readonly ok: false; readonly failure: WorkspaceExportFailure };

/**
 * 逐文件复核选定快照的全部附件（长度 + SHA-256），并保留通过复核的字节。
 *
 * - 任一附件 `missing`/`corrupt` → `attachment_unavailable`，`path` 指向对应逻辑路径，
 *   整次导出失败（不用源目录/祖先/空文件兜底，不生成伪完整导出）；
 * - 真实 I/O 故障由 blob store 抛 `WorkspaceBlobError("io")`，映射为 `io` 失败并保留原因；
 * - 顺序与清单一致（清单本身按规范序排列），失败按清单顺序报告第一条；
 * - 只读 blob store（内容寻址、物理路径只能由已校验哈希推导），不存在回读 source 的通道。
 */
export async function verifyExportAttachments(
  dataDir: string,
  snapshot: WorkspaceSnapshot,
): Promise<VerifyExportAttachmentsResult> {
  const store = createWorkspaceBlobStore(dataDir);
  const verified: ExportVerifiedFile[] = [];
  for (const file of snapshot.files) {
    let blob: BlobReadResult;
    try {
      blob = await store.readVerified(file);
    } catch (error) {
      if (error instanceof WorkspaceBlobError) {
        return {
          ok: false,
          failure: {
            code: "io",
            reason: `读取附件失败：${error.message}`,
            path: file.path,
          },
        };
      }
      throw error;
    }
    if (blob.state !== "ok") {
      return {
        ok: false,
        failure: {
          code: "attachment_unavailable",
          reason: blob.reason,
          path: file.path,
        },
      };
    }
    verified.push({ file, data: blob.data });
  }
  return { ok: true, value: verified };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
