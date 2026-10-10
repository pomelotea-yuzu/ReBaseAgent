import { type ReactNode, useId, useState } from "react";
import { type ExperimentEntryDecision, decideExperimentEntry } from "../lib/aux-workspace";
import { useAppStore } from "../store";
import { Disclosure } from "./Disclosure";
import { FOCUS_RING } from "./IconButton";

/**
 * U8 任务 1.4：运行级「模型实验」入口（design D1：运行级「更多操作」提供已有实验入口）。
 *
 * 挂在运行页头（WorkspaceShell 的 header 区），对**当前详情**做进入决策：
 * 可进入 ⇒ 打开实验工作区并显式绑定目标；不满足 ⇒ 禁用并给一句可读理由
 * （不是只给灰按钮）。入口可用**不等于**执行许可——完整资格归 §3.2 来源重验与后端门禁。
 *
 * 取值与渲染分离（RunActionsBarView 纯展示）：本包无 jsdom，静态渲染下 zustand
 * 走 getServerSnapshot，容器喂不进状态（RunHeaderView 同款纪律）。
 */

/** 三类禁用原因的可读文案（唯一来源，视图不另写一套） */
export function experimentEntryReason(
  reason: Extract<ExperimentEntryDecision, { kind: "disabled" }>["reason"],
): string {
  return reason === "no-detail"
    ? "详情尚未读取，还不能绑定实验目标"
    : reason === "isolated"
      ? "隔离文件运行不作为实验父本（实验只能从普通运行的首次模型调用出发）"
      : "该运行没有自有模型调用，不能作为实验父本";
}

export function RunActionsBarView({
  decision,
  onOpen,
  compact = false,
}: {
  decision: ExperimentEntryDecision;
  onOpen: () => void;
  compact?: boolean;
}): ReactNode {
  const [reasonExpanded, setReasonExpanded] = useState(false);
  const reasonId = useId();
  const open = decision.kind === "open";
  return (
    <div
      className={
        compact
          ? "flex flex-wrap items-center justify-end gap-2"
          : "flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-1"
      }
    >
      <button
        type="button"
        data-experiment-entry
        onClick={onOpen}
        disabled={!open}
        title={
          open
            ? "以该运行的首次模型调用为父本编排多臂参数对比"
            : experimentEntryReason(decision.reason)
        }
        className={
          open
            ? `cursor-pointer rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`
            : `cursor-not-allowed rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-reading-meta text-gray-400 ${FOCUS_RING}`
        }
      >
        模型实验
      </button>
      {!open ? (
        compact ? (
          <Disclosure
            summary="不可用原因"
            expanded={reasonExpanded}
            onToggle={() => setReasonExpanded(!reasonExpanded)}
            controlsId={reasonId}
            className="text-reading-meta text-gray-500"
          >
            <p className="max-w-sm py-1" data-experiment-entry-reason>
              {experimentEntryReason(decision.reason)}
            </p>
          </Disclosure>
        ) : (
          <span className="text-reading-meta text-gray-500" data-experiment-entry-reason>
            {experimentEntryReason(decision.reason)}
          </span>
        )
      ) : null}
    </div>
  );
}

export function RunActionsBar({ compact = false }: { compact?: boolean } = {}) {
  const detail = useAppStore((s) => s.detail);
  const openExperimentWorkspace = useAppStore((s) => s.openExperimentWorkspace);
  const decision = decideExperimentEntry(detail);
  return (
    <RunActionsBarView
      compact={compact}
      decision={decision}
      onOpen={() => {
        if (decision.kind === "open") openExperimentWorkspace(decision.target);
      }}
    />
  );
}
