import { UNPRESERVED_STATUSES, exportWorkspaceSnapshot } from "@rebaseagent/replay";
import type { WorkspaceExportSuccess } from "@rebaseagent/replay";
import type {
  Envelope,
  WorkspaceExportOutcome,
  WorkspaceExportPatch,
  WorkspaceExportRequest,
} from "../shared/ipc";
import {
  WorkspaceExportRequestSchema,
  fail as failEnvelope,
  ok as okEnvelope,
} from "../shared/ipc";
import { readRunLineage } from "./run-lineage-read";

/**
 * workspaces:export 的 main 端点（R2.1 design D1/D5，任务 5.1/5.2a/5.2b）。
 *
 * 分工（与包层、renderer 的边界，spec delta 的硬约束）：
 * - **main 独占物理路径**：目标目录只能由本端点经原生对话框取得——请求 schema
 *   `.strict()` 拒绝一切物理路径键；包层拿到的是 main 已选定的目标。
 * - **完整来源策略**：目录对话框前做一次早期来源检查（来源不完整直接拒绝，
 *   不让用户白选目录）；目录返回后、一切目标写入前**再验一次**（对话框期间父链
 *   可能变化）——复用 `readRunLineage` 单次读取上下文：ownOnly（祖先缺失）稳定码
 *   `RUN_LINEAGE_INCOMPLETE`，其余读取失败 `RUN_DETAIL_UNREADABLE`。文案是导出语境
 *   的受控中文，不透传 `checkRunSource` 的"父本不能执行"文案，也不修改其执行语义。
 * - **独立在飞保护**：`acquireSlot` 由 main 会话持有（renderer 重载不解除）；
 *   从接受请求到导出结束全程占位，重复请求立即以 `WORKSPACE_EXPORT_IN_FLIGHT`
 *   拒绝，绝不重发已经开始的写操作。
 * - **不登记 operation、不占主动执行槽、不消费授权、不调模型/工具**——本端点不
 *   接触 OperationRegistry；零 operation 由构造保证（deps 里没有 registry）。
 * - 结局一律以判别式 outcome 成功返回（信封失败只留给请求形状非法）：
 *   canceled（零写入）/ exported / failed（稳定码 + 受控原因 + 残留相对路径）。
 */

/** 端点入参：dataDir/tracesDir 由 main 注入；测试注入 pickDirectory/slot/包层桩 */
export interface WorkspaceExportEndpointDeps {
  /** 数据目录（包层导出的 trace/blob 锚点，main 按便携策略解析） */
  dataDir: string;
  /** trace 目录（readRunLineage 的读取根，= repository.tracesDir） */
  tracesDir: string;
  /** 原生目录选择（main 注入 Electron dialog；测试注入桩） */
  pickDirectory: () => Promise<string | null>;
  /**
   * 同 main 的在飞保护：原子 test-and-set。返回 false = 已有导出在飞。
   * 实现由 main 会话持有（闭包变量），renderer 重载不影响。
   */
  acquireSlot: () => boolean;
  /** 释放在飞保护（canceled/exported/failed 都必须释放） */
  releaseSlot: () => void;
  /** 包层导出实现（缺省真实实现；测试注入桩验证调用边界） */
  exportSnapshot?: typeof exportWorkspaceSnapshot;
}

/** 端点出口：请求形状非法走信封失败；其余都以判别式 outcome 成功返回 */
export type WorkspaceExportEndpointResult =
  | { readonly kind: "envelope-failure"; readonly code: string; readonly error: unknown }
  | { readonly kind: "outcome"; readonly outcome: WorkspaceExportOutcome };

/**
 * 端点结果 → IPC 信封（ipcMain.handle 的**唯一**出口形状）。renderer 侧 store 只认
 * `Envelope`（`ok/data` 或 `ok:false/error`）——漏包信封会让 `envelope.ok` 为 undefined，
 * 结算分支读到 `envelope.error.code` 直接抛 TypeError，反馈永久卡在 in-flight
 * （2026-10-12 实机验收 A 段踩坑；端点直测测不出信封层，故此函数独立可测）。
 */
export function workspaceExportEnvelope(
  result: WorkspaceExportEndpointResult,
): Envelope<WorkspaceExportOutcome> {
  return result.kind === "envelope-failure"
    ? failEnvelope(result.code, result.error)
    : okEnvelope(result.outcome);
}

/** 导出语境的在飞拒绝码（main 会话级，renderer 重载不解除） */
export const WORKSPACE_EXPORT_IN_FLIGHT = "WORKSPACE_EXPORT_IN_FLIGHT";
/** 端点兜底码：包层之外的意外异常（不该发生，发生即受控收敛） */
export const WORKSPACE_EXPORT_FAILED = "WORKSPACE_EXPORT_FAILED";

export async function exportWorkspaceEndpoint(
  deps: WorkspaceExportEndpointDeps,
  request: unknown,
): Promise<WorkspaceExportEndpointResult> {
  // 请求形状：strict schema（额外物理路径键在这里被拒绝）
  const parsed = WorkspaceExportRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { kind: "envelope-failure", code: "INVALID_ARGUMENT", error: parsed.error };
  }
  const { runId, stepSpanId }: WorkspaceExportRequest = parsed.data;

  if (!deps.acquireSlot()) {
    return {
      kind: "outcome",
      outcome: {
        status: "failed",
        code: WORKSPACE_EXPORT_IN_FLIGHT,
        reason: "已有导出在进行中：请等待当前导出完成后再试",
        retained: [],
      },
    };
  }

  try {
    // 对话框前的早期来源检查（只用于早期拒绝，省用户白选目录；不替代写入前重验）
    const early = exportSourceRejection(deps.tracesDir, runId);
    if (early !== null) return { kind: "outcome", outcome: early };

    const picked = await deps.pickDirectory();
    if (picked === null) {
      return { kind: "outcome", outcome: { status: "canceled" } };
    }

    // 目录返回后、一切目标写入前的完整父链重验（对话框期间父链可能变化）
    const late = exportSourceRejection(deps.tracesDir, runId);
    if (late !== null) return { kind: "outcome", outcome: late };

    const result = await (deps.exportSnapshot ?? exportWorkspaceSnapshot)({
      dataDir: deps.dataDir,
      runId,
      ...(stepSpanId === undefined ? {} : { stepSpanId }),
      targetDir: picked,
    });

    if (result.ok) {
      const value = result.value;
      const outcome: WorkspaceExportOutcome = {
        status: "exported",
        targetDir: value.targetDir,
        filesRoot: value.filesRoot,
        fileCount: value.fileCount,
        totalFileBytes: value.totalFileBytes,
        snapshotId: value.snapshotId,
        stepSpanId: value.stepSpanId,
        patch: projectPatch(value.patch),
        unpreserved: { ...UNPRESERVED_STATUSES },
      };
      return { kind: "outcome", outcome };
    }

    return {
      kind: "outcome",
      outcome: {
        status: "failed",
        code: result.failure.code,
        reason: result.failure.reason,
        retained: result.cleanup.retained.map((entry) => entry.path),
      },
    };
  } catch (error) {
    // 包层之外的意外异常：收敛为受控失败，绝不让异常跨越进程边界
    return {
      kind: "outcome",
      outcome: {
        status: "failed",
        code: WORKSPACE_EXPORT_FAILED,
        reason: `导出过程出现意外错误：${error instanceof Error ? error.message : String(error)}`,
        retained: [],
      },
    };
  } finally {
    deps.releaseSlot();
  }
}

/**
 * 完整来源检查（ownOnly ⇒ RUN_LINEAGE_INCOMPLETE；其余读取失败 ⇒ RUN_DETAIL_UNREADABLE）。
 * 复用 `readRunLineage` 分类但不复用 `checkRunSource` 的执行语境文案；null = 来源完整。
 */
function exportSourceRejection(
  tracesDir: string,
  runId: string,
): Extract<WorkspaceExportOutcome, { status: "failed" }> | null {
  const outcome = readRunLineage(tracesDir, runId);
  if (outcome.ok && outcome.complete) return null;
  if (outcome.ok) {
    return {
      status: "failed",
      code: "RUN_LINEAGE_INCOMPLETE",
      reason: `导出来源不完整：run ${runId} 只能确认自身及可读上游，祖先 run ${outcome.missingRunId} 的文件缺失；桌面导出要求完整来源（自有文件仍可按原规则阅读）`,
      retained: [],
    };
  }
  return {
    status: "failed",
    code: "RUN_DETAIL_UNREADABLE",
    reason: `导出来源不可读：run ${runId} 的详情读取失败（${outcome.message}）`,
    retained: [],
  };
}

/** 包层补丁计划 → 跨进程三态判别式（只有 written 携带补丁文件事实） */
function projectPatch(patch: WorkspaceExportSuccess["patch"]): WorkspaceExportPatch {
  const excluded = patch.excluded.map((entry) => ({ path: entry.path, reason: entry.reason }));
  if (patch.status === "written") {
    return {
      status: "written",
      file: "changes.patch",
      bytes: patch.bytes ?? 0,
      sha256: patch.sha256 ?? "",
      covered: [...patch.covered],
      excluded,
    };
  }
  if (patch.status === "no_text_changes") {
    return { status: "no_text_changes", covered: [...patch.covered], excluded };
  }
  return {
    status: "not_available",
    covered: [...patch.covered],
    excluded,
    reason: patch.reason,
  };
}
