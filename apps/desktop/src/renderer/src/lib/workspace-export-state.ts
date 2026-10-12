import type { WorkspaceExportOutcome } from "@shared/ipc";

/**
 * R2.1 任务 5.3：导出反馈的**会话状态**（纯逻辑层，无 React）。
 *
 * 设计 D5 的三条硬约束都由本模块 + store 的组合形状保证：
 * - **反馈绑定提交身份**：键 = run + step（缺省 step = 初始快照），值携带**提交时的
 *   请求代次**——同 key 重试也有不同代次，旧响应按代次丢弃（与 reading-request-guard
 *   同一判据，但导出的反馈要**离开页面后仍然存活**，因此活在全局 store 而不是组件闭包）。
 * - **切页不中止 main 写入**：本模块没有任何取消/中止通道——发起后即使导航离开，
 *   响应仍按 key 落进 store，返回文件页时可查看匹配会话的反馈。
 * - **重载丢失回执 = 结果未知**：renderer 重载后 store 为空 ⇒ 没有反馈可言；
 *   UI（6.x）必须把"无反馈"显示为结果未知并指引检查目标清单，**不得自动重发**
 *   （本模块也不提供重发入口）。
 */

/** 导出请求的会话键：run + step（null step 用固定哨兵，避免与真实 span id 歧义） */
export function workspaceExportKey(runId: string, stepSpanId: string | null): string {
  return `${runId}|${stepSpanId ?? "initial"}`;
}

/** 一次导出提交的反馈（kind 与 main 的 outcome 三态对齐，另加 in-flight） */
export type WorkspaceExportFeedback =
  | {
      readonly kind: "in-flight";
      readonly runId: string;
      readonly stepSpanId: string | null;
      /** 提交时的请求代次（单调递增；响应回来时代次不匹配即丢弃） */
      readonly generation: number;
    }
  | {
      readonly kind: "canceled";
      readonly runId: string;
      readonly stepSpanId: string | null;
      readonly generation: number;
    }
  | {
      readonly kind: "exported";
      readonly runId: string;
      readonly stepSpanId: string | null;
      readonly generation: number;
      /** main 的 exported outcome 原样保存（目标/files/、数量/字节、补丁三态、未保留） */
      readonly result: Extract<WorkspaceExportOutcome, { status: "exported" }>;
    }
  | {
      readonly kind: "failed";
      readonly runId: string;
      readonly stepSpanId: string | null;
      readonly generation: number;
      /** 稳定拒绝码（来源检查/包层失败/在飞保护/兜底，见 shared/ipc 的 outcome 注释） */
      readonly code: string;
      readonly reason: string;
      /** 清理未完成时的残留相对路径（完整清理为空数组） */
      readonly retained: readonly string[];
    };

/** 把 main 的 outcome 折成带提交身份的反馈（代次由调用方附上） */
export function feedbackFromOutcome(
  identity: { runId: string; stepSpanId: string | null; generation: number },
  outcome: WorkspaceExportOutcome,
): WorkspaceExportFeedback {
  switch (outcome.status) {
    case "canceled":
      return {
        kind: "canceled",
        runId: identity.runId,
        stepSpanId: identity.stepSpanId,
        generation: identity.generation,
      };
    case "exported":
      return {
        kind: "exported",
        runId: identity.runId,
        stepSpanId: identity.stepSpanId,
        generation: identity.generation,
        result: outcome,
      };
    case "failed":
      return {
        kind: "failed",
        runId: identity.runId,
        stepSpanId: identity.stepSpanId,
        generation: identity.generation,
        code: outcome.code,
        reason: outcome.reason,
        retained: outcome.retained,
      };
  }
}
