import { compareWorkspaceSnapshots, readComparedWorkspaceFile } from "@rebaseagent/replay";
import type {
  ComparedFileSide as PackageComparedFileSide,
  CompareSideFailure as PackageSideFailure,
} from "@rebaseagent/replay";
import {
  COMPARE_REASON_MAX,
  CompareWorkspaceFileRequestSchema,
  CompareWorkspaceSnapshotsRequestSchema,
  fail,
  ok,
} from "../shared/ipc";
import type {
  CompareFileReference,
  CompareSideFailure,
  CompareSideResult,
  CompareWorkspaceSnapshotsResult,
  ComparedFileSide,
  ComparedWorkspaceFileResult,
  Envelope,
} from "../shared/ipc";

/**
 * `workspaces:compareSnapshots` / `workspaces:compareFile` 的 main 侧纯端点
 * （R2.2 4.x / 5.1）。不 import electron，可直接单测。
 *
 * 只读：不登记 operation、不占主动槽、不消费授权、不写 trace/blob/source。
 * 请求形状非法走失败信封；单侧读取/核验失败是**数据状态**，仍以 ok 信封返回
 * （renderer 必须能逐侧展示，不得把不可用侧当空清单/空文件）。
 *
 * 二进制正文不跨进程传输：清单已有哈希/大小，文本 diff 也只允许 text/text 或
 * text+合法 not_found；把 8 MiB 字节搬进 renderer 没有用途，还会放大 IPC 载荷。
 */

function boundedReason(reason: string): string {
  return reason.length > COMPARE_REASON_MAX ? reason.slice(0, COMPARE_REASON_MAX) : reason;
}

function sideFailureOf(failure: PackageSideFailure): CompareSideFailure {
  return { code: failure.code, reason: boundedReason(failure.reason) };
}

function mapSide(
  side: Awaited<ReturnType<typeof compareWorkspaceSnapshots>>["left"],
): CompareSideResult {
  if (side.status === "unavailable") {
    return {
      status: "unavailable",
      requestedRunId: side.requestedRunId,
      requestedStepSpanId: side.requestedStepSpanId,
      failure: sideFailureOf(side.failure),
    };
  }
  return {
    status: "ok",
    requestedRunId: side.requestedRunId,
    requestedStepSpanId: side.requestedStepSpanId,
    selected: {
      runId: side.selected.runId,
      stepSpanId: side.selected.stepSpanId,
      snapshotId: side.selected.snapshotId,
      initialSnapshotId: side.selected.initialSnapshotId,
    },
  };
}

function fileReferenceOf(file: {
  path: string;
  sha256: string;
  bytes: number;
}): CompareFileReference {
  return { path: file.path, sha256: file.sha256, bytes: file.bytes };
}

function mapComparedSide(side: PackageComparedFileSide): ComparedFileSide {
  switch (side.status) {
    case "text":
      return {
        status: "text",
        path: side.path,
        file: fileReferenceOf(side.file),
        text: side.text,
      };
    case "binary":
      return { status: "binary", path: side.path, file: fileReferenceOf(side.file) };
    case "not_found":
      return { status: "not_found", path: side.path, reason: boundedReason(side.reason) };
    case "missing":
    case "corrupt":
    case "too_large":
    case "io":
      return {
        status: side.status,
        path: side.path,
        file: fileReferenceOf(side.file),
        reason: boundedReason(side.reason),
      };
    case "selection_changed":
      return {
        status: "selection_changed",
        path: side.path,
        expectedSnapshotId: side.expectedSnapshotId,
        actualSnapshotId: side.actualSnapshotId,
        reason: boundedReason(side.reason),
      };
    case "unavailable":
      return {
        status: "unavailable",
        path: side.path,
        failure: sideFailureOf(side.failure),
      };
  }
}

/** 清单比较：两侧各自定位并冻结，路径并集只在双方都可用时给出 */
export function compareWorkspaceSnapshotsEndpoint(
  deps: { readonly dataDir: string },
  request: unknown,
): Envelope<CompareWorkspaceSnapshotsResult> {
  const parsed = CompareWorkspaceSnapshotsRequestSchema.safeParse(request);
  if (!parsed.success) {
    return fail("INVALID_ARGUMENT", parsed.error);
  }
  try {
    const result = compareWorkspaceSnapshots({
      dataDir: deps.dataDir,
      left: parsed.data.left,
      right: parsed.data.right,
    });
    return ok({
      left: mapSide(result.left),
      right: mapSide(result.right),
      unionComplete: result.unionComplete,
      entries: result.entries.map((entry) => ({
        path: entry.path,
        presence: entry.presence,
        left: entry.left,
        right: entry.right,
        reference: entry.reference,
      })),
    });
  } catch (error) {
    return fail("WORKSPACE_COMPARE_FAILED", error);
  }
}

/** 正文比较：按 path 延迟核验；二进制只回哈希/大小 */
export async function readComparedWorkspaceFileEndpoint(
  deps: { readonly dataDir: string },
  request: unknown,
): Promise<Envelope<ComparedWorkspaceFileResult>> {
  const parsed = CompareWorkspaceFileRequestSchema.safeParse(request);
  if (!parsed.success) {
    return fail("INVALID_ARGUMENT", parsed.error);
  }
  try {
    const result = await readComparedWorkspaceFile({
      dataDir: deps.dataDir,
      left: parsed.data.left,
      right: parsed.data.right,
      path: parsed.data.path,
      expectedSnapshotIds: parsed.data.expectedSnapshotIds,
    });
    return ok({
      path: result.path,
      left: mapComparedSide(result.left),
      right: mapComparedSide(result.right),
      conclusion: result.conclusion,
      textDiffEligible: result.textDiffEligible,
    });
  } catch (error) {
    return fail("WORKSPACE_COMPARE_READ_FAILED", error);
  }
}
