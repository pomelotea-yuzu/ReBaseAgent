import { compareLogicalPath, findLogicalPathViolation } from "@rebaseagent/trace-sdk";
import type { RunRecord, WorkspaceFile, WorkspaceSnapshot } from "@rebaseagent/trace-sdk";
import { WorkspaceBlobError, createWorkspaceBlobStore } from "./blob-store.js";
import { WORKSPACE_QUOTA } from "./quota.js";
import { locateSnapshotInRun, readWorkspaceRun } from "./read-api.js";
import type { ReadWorkspaceRunResult, WorkspaceLocateFailureCode } from "./read-api.js";
import { tryDecodeUtf8 } from "./utf8.js";

/**
 * **跨运行检查点文件比较**（R2.2 design D6，tasks 4.1–4.3）。只读：不写 trace/blob/源目录、
 * 不登记 operation、不消费授权、不调用模型/工具。
 *
 * ## 两层语义刻意分开
 *
 * 1. **清单层**（`compareWorkspaceSnapshots`）：两侧各自定位一份**自有**快照（缺省 stepSpanId=初始），
 *    冻结清单并按路径 UTF-16 序求并集。只回答"清单引用是否相同/不同"，**不读附件字节**，
 *    因此相同哈希只能先标"引用相同，内容待核验"。
 * 2. **内容层**（`readComparedWorkspaceFile`）：按 path 延迟读取，逐侧验证长度/哈希后才给出
 *    相同/修改/新增/删除结论；二进制不生成文本 diff；任一侧不可用都保留该侧状态。
 *
 * ## 缺省 stepSpanId 的层级语义
 *
 * 包 API 的缺省值**永远指初始快照**，不承担桌面"最近一个自有完成步骤"的解析。桌面必须先
 * 在已校验详情里把默认选择解析成显式 `stepSpanId`，仅选择初始时才省略；失效 selector
 * 不得自动回落到初始（那会静默换一份清单）。
 *
 * ## 同 run 两个 selector
 *
 * 同一次请求内按 run id 缓存记录读取（可注入 `readRecord` 以便测试计数），两个 selector
 * 共享同一个读取时点；不缓存跨请求——文件替换后必须由显式刷新重新读取。
 */

/** 比较的一侧选择器：`stepSpanId` 缺省 = 初始快照（不是"最近一步"） */
export interface CompareSideSelector {
  readonly runId: string;
  readonly stepSpanId?: string;
}

/** 比较结果的身份/状态（两侧各自独立） */
export interface CompareSideIdentity {
  readonly runId: string;
  /** null = 初始快照；否则是该 run 自有的 agent.step id */
  readonly stepSpanId: string | null;
  readonly snapshotId: string;
  readonly initialSnapshotId: string;
}

export type CompareSideFailureCode = WorkspaceLocateFailureCode | "identity_mismatch";

export interface CompareSideFailure {
  readonly code: CompareSideFailureCode;
  readonly reason: string;
}

export type CompareSideResult =
  | {
      readonly status: "ok";
      readonly requestedRunId: string;
      readonly requestedStepSpanId: string | null;
      readonly selected: CompareSideIdentity;
    }
  | {
      readonly status: "unavailable";
      readonly requestedRunId: string;
      readonly requestedStepSpanId: string | null;
      readonly failure: CompareSideFailure;
    };

/** 清单引用（只证明清单里写了什么，不证明附件字节可读/相同） */
export interface CompareFileReference {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ComparePathEntry {
  readonly path: string;
  readonly presence: "both" | "left_only" | "right_only";
  /** 缺失侧为 null；不把"该侧清单没有"写成空文件 */
  readonly left: CompareFileReference | null;
  readonly right: CompareFileReference | null;
  /**
   * 双方都存在时的**清单引用**比较结果；单侧存在为 null。
   * `same` 只表示哈希/大小相同，内容仍需 `readComparedWorkspaceFile` 核验。
   */
  readonly reference: "same" | "different" | null;
}

export interface CompareWorkspaceSnapshotsResult {
  readonly left: CompareSideResult;
  readonly right: CompareSideResult;
  /**
   * 两侧清单都可用时才为 true。false 时 `entries` 为空——路径并集不完整，
   * 不能把不可用侧当成"没有该文件"。
   */
  readonly unionComplete: boolean;
  readonly entries: readonly ComparePathEntry[];
}

export interface CompareWorkspaceSnapshotsOptions {
  readonly dataDir: string;
  readonly left: CompareSideSelector;
  readonly right: CompareSideSelector;
  /** 测试注入：同一 run 只读一次；生产省略（默认 `readRun`） */
  readonly readRecord?: (file: string) => RunRecord;
}

/** 清单读取时**冻结**的两侧快照 id；正文读取必须携带，防止把旧清单与新正文拼在一起 */
export interface ExpectedSnapshotIds {
  readonly left: string;
  readonly right: string;
}

export interface ReadComparedWorkspaceFileRequest {
  readonly dataDir: string;
  readonly left: CompareSideSelector;
  readonly right: CompareSideSelector;
  /** 逻辑路径；必须来自比较并集或调用方明确选择 */
  readonly path: string;
  readonly expectedSnapshotIds: ExpectedSnapshotIds;
  /** 测试注入：同一 run 只读一次；生产省略 */
  readonly readRecord?: (file: string) => RunRecord;
}

export type ComparedFileSide =
  | {
      readonly status: "text";
      readonly path: string;
      readonly file: WorkspaceFile;
      readonly text: string;
    }
  | {
      readonly status: "binary";
      readonly path: string;
      readonly file: WorkspaceFile;
      readonly data: Uint8Array;
    }
  | { readonly status: "not_found"; readonly path: string; readonly reason: string }
  | {
      readonly status: "missing";
      readonly path: string;
      readonly file: WorkspaceFile;
      readonly reason: string;
    }
  | {
      readonly status: "corrupt";
      readonly path: string;
      readonly file: WorkspaceFile;
      readonly reason: string;
    }
  | {
      readonly status: "too_large";
      readonly path: string;
      readonly file: WorkspaceFile;
      readonly reason: string;
    }
  | {
      readonly status: "io";
      readonly path: string;
      readonly file: WorkspaceFile;
      readonly reason: string;
    }
  | {
      readonly status: "selection_changed";
      readonly path: string;
      readonly expectedSnapshotId: string;
      readonly actualSnapshotId: string;
      readonly reason: string;
    }
  | {
      readonly status: "unavailable";
      readonly path: string;
      readonly failure: CompareSideFailure;
    };

export type ComparedFileConclusion =
  | "same"
  | "different"
  | "left_only"
  | "right_only"
  | "not_found"
  | "unavailable";

export interface ComparedWorkspaceFileResult {
  readonly path: string;
  readonly left: ComparedFileSide;
  readonly right: ComparedFileSide;
  /**
   * 只有两侧字节都核验过（或一侧字节核验 + 另一侧由合法清单证明不存在）才给出
   * same/different/left_only/right_only；两侧清单都证明不存在为 not_found；
   * 其余（missing/corrupt/io/too_large/selection_changed/侧不可用）为 unavailable。
   */
  readonly conclusion: ComparedFileConclusion;
  /**
   * 是否允许生成只读文本 diff：text/text，或 text 与合法清单证明的 not_found。
   * 二进制、不可用与超限一律 false。
   */
  readonly textDiffEligible: boolean;
}

type LoadedSide =
  | {
      readonly status: "ok";
      readonly requestedRunId: string;
      readonly requestedStepSpanId: string | null;
      readonly selected: CompareSideIdentity;
      readonly snapshot: WorkspaceSnapshot;
    }
  | {
      readonly status: "unavailable";
      readonly requestedRunId: string;
      readonly requestedStepSpanId: string | null;
      readonly failure: CompareSideFailure;
    };

type RunCache = (runId: string) => ReadWorkspaceRunResult;

function createRunCache(
  dataDir: string,
  readRecord: ((file: string) => RunRecord) | undefined,
): RunCache {
  const cache = new Map<string, ReadWorkspaceRunResult>();
  return (runId: string): ReadWorkspaceRunResult => {
    const hit = cache.get(runId);
    if (hit !== undefined) return hit;
    // 这里是"同 run 两个 selector 共享同一读取时点"的唯一实现点。
    const loaded = readWorkspaceRun(dataDir, runId, readRecord);
    cache.set(runId, loaded);
    return loaded;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requestedStepOf(selector: CompareSideSelector): string | null {
  return typeof selector.stepSpanId === "string" ? selector.stepSpanId : null;
}

function requestedRunOf(selector: CompareSideSelector): string {
  return typeof selector.runId === "string" ? selector.runId : String(selector.runId);
}

function loadSide(selector: CompareSideSelector, loadRun: RunCache): LoadedSide {
  if (typeof selector !== "object" || selector === null) {
    return {
      status: "unavailable",
      requestedRunId: "",
      requestedStepSpanId: null,
      failure: {
        code: "invalid_request",
        reason: "比较侧选择器必须是 {runId, stepSpanId?} 对象",
      },
    };
  }
  const runId = requestedRunOf(selector);
  const requestedStepSpanId = requestedStepOf(selector);
  if (!isNonEmptyString(selector.runId)) {
    return {
      status: "unavailable",
      requestedRunId: runId,
      requestedStepSpanId,
      failure: {
        code: "invalid_request",
        reason: `runId 必须是非空字符串，实际为 ${JSON.stringify(selector.runId)}`,
      },
    };
  }
  if (selector.stepSpanId !== undefined && !isNonEmptyString(selector.stepSpanId)) {
    return {
      status: "unavailable",
      requestedRunId: runId,
      requestedStepSpanId,
      failure: {
        code: "invalid_request",
        reason: `stepSpanId 若提供必须是非空字符串，实际为 ${JSON.stringify(selector.stepSpanId)}`,
      },
    };
  }

  const loaded = loadRun(runId);
  if (!loaded.ok) {
    return {
      status: "unavailable",
      requestedRunId: runId,
      requestedStepSpanId,
      failure: loaded.failure,
    };
  }
  // 文件名可解析不等于身份可认可：请求 id 必须与 meta.id 一致。
  if (loaded.value.record.meta.id !== runId) {
    return {
      status: "unavailable",
      requestedRunId: runId,
      requestedStepSpanId,
      failure: {
        code: "identity_mismatch",
        reason: `请求的 run ${runId} 与文件内容声明的身份 ${loaded.value.record.meta.id} 不符，不能标为选中的 run`,
      },
    };
  }

  const located = locateSnapshotInRun(
    runId,
    loaded.value.workspace,
    loaded.value.record,
    selector.stepSpanId,
  );
  if (!located.ok) {
    return {
      status: "unavailable",
      requestedRunId: runId,
      requestedStepSpanId,
      failure: located.failure,
    };
  }
  return {
    status: "ok",
    requestedRunId: runId,
    requestedStepSpanId,
    selected: {
      runId: located.value.runId,
      stepSpanId: located.value.stepSpanId,
      snapshotId: located.value.snapshot.id,
      initialSnapshotId: loaded.value.workspace.initial_snapshot.id,
    },
    snapshot: located.value.snapshot,
  };
}

function toPublicSide(side: LoadedSide): CompareSideResult {
  if (side.status === "unavailable") return side;
  return {
    status: "ok",
    requestedRunId: side.requestedRunId,
    requestedStepSpanId: side.requestedStepSpanId,
    selected: side.selected,
  };
}

function sameReference(a: WorkspaceFile, b: WorkspaceFile): boolean {
  return a.sha256 === b.sha256 && a.bytes === b.bytes;
}

/**
 * 两侧清单读取/冻结并按路径并集比较**引用**（不读附件字节）。
 *
 * 任一侧失败时 `entries=[]` 且 `unionComplete=false`；另一侧的身份/失败原因仍完整返回，
 * 调用方不能用"空并集"推断文件不存在。
 */
export function compareWorkspaceSnapshots(
  options: CompareWorkspaceSnapshotsOptions,
): CompareWorkspaceSnapshotsResult {
  const loadRun = createRunCache(options.dataDir, options.readRecord);
  const left = loadSide(options.left, loadRun);
  const right = loadSide(options.right, loadRun);

  if (left.status !== "ok" || right.status !== "ok") {
    return {
      left: toPublicSide(left),
      right: toPublicSide(right),
      unionComplete: false,
      entries: [],
    };
  }

  const byPath = new Map<string, { left?: WorkspaceFile; right?: WorkspaceFile }>();
  for (const file of left.snapshot.files) {
    const entry = byPath.get(file.path) ?? {};
    entry.left = file;
    byPath.set(file.path, entry);
  }
  for (const file of right.snapshot.files) {
    const entry = byPath.get(file.path) ?? {};
    entry.right = file;
    byPath.set(file.path, entry);
  }

  const entries: ComparePathEntry[] = [...byPath.keys()].sort(compareLogicalPath).map((path) => {
    const entry = byPath.get(path) ?? {};
    const leftFile = entry.left;
    const rightFile = entry.right;
    const presence =
      leftFile !== undefined && rightFile !== undefined
        ? "both"
        : leftFile !== undefined
          ? "left_only"
          : "right_only";
    return {
      path,
      presence,
      left:
        leftFile === undefined
          ? null
          : { path: leftFile.path, sha256: leftFile.sha256, bytes: leftFile.bytes },
      right:
        rightFile === undefined
          ? null
          : { path: rightFile.path, sha256: rightFile.sha256, bytes: rightFile.bytes },
      reference:
        leftFile !== undefined && rightFile !== undefined
          ? sameReference(leftFile, rightFile)
            ? "same"
            : "different"
          : null,
    };
  });

  return {
    left: toPublicSide(left),
    right: toPublicSide(right),
    unionComplete: true,
    entries,
  };
}

function isVerified(
  side: ComparedFileSide,
): side is Extract<ComparedFileSide, { status: "text" | "binary" }> {
  return side.status === "text" || side.status === "binary";
}

function sameVerifiedFile(a: WorkspaceFile, b: WorkspaceFile): boolean {
  return a.sha256 === b.sha256 && a.bytes === b.bytes;
}

function conclude(left: ComparedFileSide, right: ComparedFileSide): ComparedFileConclusion {
  if (isVerified(left) && isVerified(right)) {
    return sameVerifiedFile(left.file, right.file) ? "same" : "different";
  }
  if (isVerified(left) && right.status === "not_found") return "left_only";
  if (isVerified(right) && left.status === "not_found") return "right_only";
  if (left.status === "not_found" && right.status === "not_found") return "not_found";
  return "unavailable";
}

function isTextDiffEligible(left: ComparedFileSide, right: ComparedFileSide): boolean {
  if (left.status === "text" && right.status === "text") return true;
  if (left.status === "text" && right.status === "not_found") return true;
  if (right.status === "text" && left.status === "not_found") return true;
  return false;
}

function invalidExpectedResult(
  path: string,
  left: LoadedSide,
  right: LoadedSide,
  reason: string,
): ComparedWorkspaceFileResult {
  const failure: CompareSideFailure = { code: "invalid_request", reason };
  const toSide = (side: LoadedSide): ComparedFileSide =>
    side.status === "ok"
      ? { status: "unavailable", path, failure }
      : { status: "unavailable", path, failure: side.failure };
  return {
    path,
    left: toSide(left),
    right: toSide(right),
    conclusion: "unavailable",
    textDiffEligible: false,
  };
}

async function readOneSide(
  side: LoadedSide,
  expectedSnapshotId: string,
  path: string,
  pathViolation: string | null,
  store: ReturnType<typeof createWorkspaceBlobStore>,
): Promise<ComparedFileSide> {
  if (side.status !== "ok") {
    return { status: "unavailable", path, failure: side.failure };
  }
  if (side.selected.snapshotId !== expectedSnapshotId) {
    return {
      status: "selection_changed",
      path,
      expectedSnapshotId,
      actualSnapshotId: side.selected.snapshotId,
      reason: `所选快照已变化（列表冻结 ${expectedSnapshotId}，当前 ${side.selected.snapshotId}）：等待显式刷新，不把旧清单与新正文拼接`,
    };
  }
  if (pathViolation !== null) {
    return {
      status: "not_found",
      path,
      reason: `逻辑路径不符合契约，不可能出现在任何清单里：${pathViolation}`,
    };
  }
  const file = side.snapshot.files.find((entry) => entry.path === path);
  if (file === undefined) {
    return { status: "not_found", path, reason: "所选清单内没有这条路径" };
  }
  if (file.bytes > WORKSPACE_QUOTA.maxFileBytes) {
    return {
      status: "too_large",
      path,
      file,
      reason: `文件大小 ${file.bytes} 字节超过查看上限 ${WORKSPACE_QUOTA.maxFileBytes} 字节；不生成文本 diff`,
    };
  }

  let blob: Awaited<ReturnType<typeof store.readVerified>>;
  try {
    blob = await store.readVerified(file);
  } catch (error) {
    const reason =
      error instanceof WorkspaceBlobError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { status: "io", path, file, reason: `读取附件发生 I/O 故障：${reason}` };
  }
  if (blob.state !== "ok") {
    return { status: blob.state, path, file, reason: blob.reason };
  }

  const text = tryDecodeUtf8(blob.data);
  return text === null
    ? { status: "binary", path, file, data: blob.data }
    : { status: "text", path, file, text };
}

/**
 * 按逻辑路径延迟读取两侧内容并给结论。
 *
 * - `expectedSnapshotIds` 必须来自同一份清单比较结果；任一侧变化返回该侧
 *   `selection_changed`，另一侧仍可阅读但整体结论为 unavailable；
 * - 逐侧区分 text/binary/not_found/missing/corrupt/too_large/io/selection_changed/unavailable；
 * - `not_found` 只由合法清单证明；附件缺失/损坏不得伪装成不存在；
 * - 不写任何文件、不读源目录、不调模型/工具。
 */
export async function readComparedWorkspaceFile(
  request: ReadComparedWorkspaceFileRequest,
): Promise<ComparedWorkspaceFileResult> {
  const loadRun = createRunCache(request.dataDir, request.readRecord);
  const left = loadSide(request.left, loadRun);
  const right = loadSide(request.right, loadRun);
  const path = typeof request.path === "string" ? request.path : "";

  const expected = request.expectedSnapshotIds;
  if (
    typeof expected !== "object" ||
    expected === null ||
    !isNonEmptyString(expected.left) ||
    !isNonEmptyString(expected.right)
  ) {
    return invalidExpectedResult(
      path,
      left,
      right,
      "expectedSnapshotIds 必须是 {left,right} 两个快照 id（来自同一次清单比较）",
    );
  }
  if (typeof request.path !== "string") {
    return invalidExpectedResult(path, left, right, "path 必须是字符串");
  }

  const pathViolation = findLogicalPathViolation(request.path);
  const store = createWorkspaceBlobStore(request.dataDir);
  const leftSide = await readOneSide(left, expected.left, path, pathViolation, store);
  const rightSide = await readOneSide(right, expected.right, path, pathViolation, store);

  return {
    path,
    left: leftSide,
    right: rightSide,
    conclusion: conclude(leftSide, rightSide),
    textDiffEligible: isTextDiffEligible(leftSide, rightSide),
  };
}
