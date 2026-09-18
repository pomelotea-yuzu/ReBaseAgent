import { join } from "node:path";
import { findLogicalPathViolation, readRun } from "@rebaseagent/trace-sdk";
import type {
  RunRecord,
  WorkspaceFile,
  WorkspaceOrigin,
  WorkspaceSnapshot,
} from "@rebaseagent/trace-sdk";
import { createWorkspaceBlobStore } from "./blob-store.js";
import { tryDecodeUtf8 } from "./utf8.js";

/**
 * 包层**只读**数据接口（A design §7）：按「已校验的 run / 该 run 自有的完成步骤 / 逻辑路径」
 * 定位清单与附件内容。
 *
 * 三条硬约束（都由结构保证，而不是靠调用方自觉）：
 * 1. **物理路径不外泄**：接口只吃 `dataDir` 与逻辑路径，附件物理位置由包内按已校验哈希推导
 *    （`workspace-blobs/sha256/<hash>`）。逻辑路径即便写成 `sha256/<hash>` 或 `D:/x`，也只是
 *    "清单里没有这条路径"——它永远不会被拼进宿主路径。
 * 2. **只认本 run 自有的步骤**：`stepSpanId` 必须出现在**该 run 自己的 JSONL** 里
 *    （`readRun` 只返回自有记录，祖先前缀是拼接出来的、不存在于文件里）。祖先步骤因此天然
 *    定位不到——跨代拿检查点会让文件起点与消息前缀错配。
 * 3. **两级校验各就各位**：清单 id 是否等于其规范哈希由 **reader** 重算（1.2 就接在 `readRun` 里，
 *    因为那需要 `node:crypto`），篡改过的清单在解析阶段就抛错，本层把它映射成 `trace_invalid`
 *    并保留原始原因；**附件字节**的长度与哈希由本层在校验完清单之后比对（`readVerified`）。
 *    所以"先校验后读字节"是两层拼起来的，不是本层独自完成的。
 *
 * 不写 trace/blob、不调 LLM：整条路径只有 `readFile`。**不需要 run 已封存**——读取不是分叉，
 * 崩溃 run 里已落盘的检查点正是事故现场，理应可读；"未封存不可分叉"是隔离能力预检（4.x）的门禁。
 */

/** 数据目录下存放 trace 的子目录名（与桌面端 `data-dir.ts` 的 `TRACES_DIR_NAME` 一致） */
export const WORKSPACE_TRACES_DIR_NAME = "traces";

/** run id 的长度上限（防超长路径；真实 id 形如 `run_mf3k2z` 或 uuid） */
const MAX_RUN_ID_LENGTH = 200;

/** 一份被定位到的清单：本 run 的初始快照，或本 run 某个自有完成步骤的检查点 */
export interface LocatedWorkspaceSnapshot {
  readonly runId: string;
  /** `null` = 初始快照；否则是该快照所属的 `agent.step` span id */
  readonly stepSpanId: string | null;
  readonly snapshot: WorkspaceSnapshot;
  readonly origin: WorkspaceOrigin;
}

/** 定位失败的原因码（"非法请求"一律是可辨认的拒绝，而不是抛错） */
export type WorkspaceLocateFailureCode =
  | "invalid_request"
  | "run_not_found"
  | "trace_invalid"
  | "no_workspace"
  | "step_not_found";

export interface WorkspaceLocateFailure {
  readonly code: WorkspaceLocateFailureCode;
  readonly reason: string;
}

export type LocateWorkspaceResult =
  | { readonly ok: true; readonly value: LocatedWorkspaceSnapshot }
  | { readonly ok: false; readonly failure: WorkspaceLocateFailure };

/** 定位请求：`stepSpanId` 缺省取初始快照 */
export interface LocateWorkspaceRequest {
  readonly dataDir: string;
  readonly runId: string;
  readonly stepSpanId?: string;
}

/** 读取请求：定位 + 逻辑路径 */
export interface WorkspaceReadRequest extends LocateWorkspaceRequest {
  readonly path: string;
}

/**
 * 读取结果。前五种都是**数据状态**（可辨认、可展示），`rejected` 表示请求本身不成立
 * （run 不存在、步骤不属于本 run、清单被篡改等）。真实 I/O 故障仍抛错，不伪装成状态。
 */
export type WorkspaceFileReadResult =
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
  | { readonly status: "rejected"; readonly failure: WorkspaceLocateFailure };

/** `<dataDir>/traces/<runId>.jsonl` */
export function workspaceTraceFile(dataDir: string, runId: string): string {
  return join(dataDir, WORKSPACE_TRACES_DIR_NAME, `${runId}.jsonl`);
}

/**
 * 定位一份清单（本 run 的初始快照或某个自有完成步骤的检查点）。
 *
 * 同步：底层 `readRun` 就是同步的，异步只会让调用方多一层 `await`。
 */
export function locateWorkspaceSnapshot(request: LocateWorkspaceRequest): LocateWorkspaceResult {
  const invalidRunId = findRunIdViolation(request.runId);
  if (invalidRunId !== null) {
    return reject("invalid_request", invalidRunId);
  }

  const file = workspaceTraceFile(request.dataDir, request.runId);
  let record: RunRecord;
  try {
    record = readRun(file);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return reject("run_not_found", `run 文件不存在：${file}`);
    }
    // 解析失败与完整性失败（如清单 id 与规范哈希不符）都落在这里，原始原因原样带出
    return reject("trace_invalid", `run 文件无法解析或校验失败：${describeError(error)}`);
  }

  const workspace = record.meta.workspace;
  if (workspace === undefined) {
    return reject("no_workspace", `该 run 不是隔离运行（无 run.meta.workspace）：${request.runId}`);
  }

  if (request.stepSpanId === undefined) {
    return {
      ok: true,
      value: {
        runId: request.runId,
        stepSpanId: null,
        snapshot: workspace.initial_snapshot,
        origin: workspace.origin,
      },
    };
  }

  const step = record.spans.find((span) => span.id === request.stepSpanId);
  if (step === undefined) {
    return reject(
      "step_not_found",
      `step ${request.stepSpanId} 不在 ${request.runId} 的自有记录中（祖先步骤不能用来定位本 run 的文件）`,
    );
  }
  if (step.kind !== "agent.step") {
    return reject(
      "step_not_found",
      `${request.stepSpanId} 是 ${step.kind}，不是 agent.step，因此没有文件检查点`,
    );
  }
  const snapshot = step.workspace_snapshot;
  if (snapshot === undefined) {
    return reject(
      "step_not_found",
      `${request.stepSpanId} 没有 workspace_snapshot（v2 已落盘的 agent.step 必然带检查点，读到缺失说明文件被改过）`,
    );
  }
  return {
    ok: true,
    value: {
      runId: request.runId,
      stepSpanId: step.id,
      snapshot,
      origin: workspace.origin,
    },
  };
}

/**
 * 读取清单里某条逻辑路径的内容：文本或二进制，或可辨认的 `not_found` / `missing` / `corrupt`。
 */
export async function readWorkspaceFile(
  request: WorkspaceReadRequest,
): Promise<WorkspaceFileReadResult> {
  const located = locateWorkspaceSnapshot(request);
  if (!located.ok) {
    return { status: "rejected", failure: located.failure };
  }

  const pathViolation = findLogicalPathViolation(request.path);
  if (pathViolation !== null) {
    return {
      status: "not_found",
      path: request.path,
      reason: `逻辑路径不符合契约，不可能出现在任何清单里：${pathViolation}`,
    };
  }

  const file = located.value.snapshot.files.find((entry) => entry.path === request.path);
  if (file === undefined) {
    return {
      status: "not_found",
      path: request.path,
      reason: "所选清单内没有这条路径",
    };
  }

  const store = createWorkspaceBlobStore(request.dataDir);
  const blob = await store.readVerified(file);
  if (blob.state !== "ok") {
    return { status: blob.state, path: file.path, file, reason: blob.reason };
  }

  const text = tryDecodeUtf8(blob.data);
  return text === null
    ? { status: "binary", path: file.path, file, data: blob.data }
    : { status: "text", path: file.path, file, text };
}

function reject(code: WorkspaceLocateFailureCode, reason: string): LocateWorkspaceResult {
  return { ok: false, failure: { code, reason } };
}

/**
 * run id 只用来拼 `<runId>.jsonl`，所以这里挡的是**路径穿越**（分隔符、NUL、`.`/`..`），
 * 而不是给 id 定字符集——id 由内核生成，将来换格式不该被读取层拒掉。
 */
function findRunIdViolation(runId: string): string | null {
  if (runId.length === 0) {
    return "runId 不得为空";
  }
  if (runId.length > MAX_RUN_ID_LENGTH) {
    return `runId 超过 ${MAX_RUN_ID_LENGTH} 字符：${runId.length}`;
  }
  if (runId.includes("/") || runId.includes("\\") || runId.includes("\0")) {
    return `runId 不得包含路径分隔符或 NUL：${JSON.stringify(runId)}`;
  }
  if (runId === "." || runId === "..") {
    return `runId 不得是 "." 或 ".."`;
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
