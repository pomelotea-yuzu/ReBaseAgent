import type { Translator } from "@rebaseagent/i18n";
import { type ReactNode, useId, useState } from "react";
import { useTranslator } from "../i18n";
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
  translator: Translator,
): string {
  return reason === "no-detail"
    ? translator.t("detail.experimentEntryNoDetail")
    : reason === "isolated"
      ? translator.t("detail.experimentEntryIsolated")
      : translator.t("detail.experimentEntryNoCall");
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
  const translator = useTranslator();
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
            ? translator.t("detail.experimentEntryOpenTitle")
            : experimentEntryReason(decision.reason, translator)
        }
        className={
          open
            ? `cursor-pointer rounded border border-gray-300 px-2 py-0.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`
            : `cursor-not-allowed rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-reading-meta text-gray-400 ${FOCUS_RING}`
        }
      >
        {translator.t("run.workspaceExperiment")}
      </button>
      {!open ? (
        compact ? (
          <Disclosure
            summary={translator.t("detail.experimentUnavailableSummary")}
            expanded={reasonExpanded}
            onToggle={() => setReasonExpanded(!reasonExpanded)}
            controlsId={reasonId}
            className="text-reading-meta text-gray-500"
          >
            <p className="max-w-sm py-1" data-experiment-entry-reason>
              {experimentEntryReason(decision.reason, translator)}
            </p>
          </Disclosure>
        ) : (
          <span className="text-reading-meta text-gray-500" data-experiment-entry-reason>
            {experimentEntryReason(decision.reason, translator)}
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
