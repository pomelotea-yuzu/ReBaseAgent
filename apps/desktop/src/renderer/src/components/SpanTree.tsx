import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { SpanNode } from "@shared/derive";
import { buildSpanTree, deriveStepStats } from "@shared/derive";
import { useMemo } from "react";
import { formatDuration, formatTokens } from "../lib/format";
import { useAppStore } from "../store";

const KIND_LABEL: Record<SpanLine["kind"], string> = {
  "agent.step": "步骤",
  "llm.call": "LLM",
  "tool.invoke": "工具",
};

/** span 类型的语义色：步骤中性、LLM 蓝紫、工具青 */
const KIND_COLOR: Record<SpanLine["kind"], string> = {
  "agent.step": "text-gray-700",
  "llm.call": "text-violet-700",
  "tool.invoke": "text-cyan-700",
};

function nodeLabel(span: SpanLine): string {
  if (span.kind === "agent.step") return `第 ${span.n} 轮`;
  if (span.kind === "llm.call") return "LLM 调用";
  return span.tool;
}

function hasError(span: SpanLine): boolean {
  return span.kind === "tool.invoke" && span.error !== null;
}

function SpanRow({ node, depth }: { node: SpanNode; depth: number }) {
  const selectedSpanId = useAppStore((s) => s.selectedSpanId);
  const expandedSteps = useAppStore((s) => s.expandedSteps);
  const selectSpan = useAppStore((s) => s.selectSpan);
  const toggleStep = useAppStore((s) => s.toggleStep);

  const { span, children } = node;
  const isStep = span.kind === "agent.step";
  const expanded = isStep ? expandedSteps[span.id] !== false : true;
  const selected = selectedSpanId === span.id;
  const errored = hasError(span);
  const stats = useMemo(() => deriveStepStats(node), [node]);

  return (
    <div>
      <div
        className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs ${
          selected ? "bg-blue-100" : "hover:bg-gray-100"
        } ${errored ? "text-red-700" : KIND_COLOR[span.kind]}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          selectSpan(span.id);
          if (isStep && children.length > 0) toggleStep(span.id);
        }}
      >
        {isStep && children.length > 0 ? (
          <span className="w-2 shrink-0 text-[9px] text-gray-400">{expanded ? "▼" : "▶"}</span>
        ) : (
          <span className="w-2 shrink-0" />
        )}

        <span className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-500">
          {KIND_LABEL[span.kind]}
        </span>

        <span className={`truncate ${errored ? "font-medium" : ""}`} title={nodeLabel(span)}>
          {nodeLabel(span)}
        </span>

        {node.orphan ? (
          <span className="shrink-0 text-[10px] text-amber-600" title="父 span 不在此轨迹中">
            孤立
          </span>
        ) : null}

        {errored ? <span className="shrink-0 text-[10px]">✕</span> : null}

        <span className="ml-auto shrink-0 pl-2 font-code text-[10px] text-gray-400">
          {formatDuration(stats.durationMs)}
          {isStep && stats.tokensIn + stats.tokensOut > 0
            ? ` · ${formatTokens(stats.tokensIn + stats.tokensOut)}`
            : ""}
        </span>
      </div>

      {expanded
        ? children.map((child) => <SpanRow key={child.span.id} node={child} depth={depth + 1} />)
        : null}
    </div>
  );
}

export function SpanTree() {
  const detail = useAppStore((s) => s.detail);
  const loadingDetail = useAppStore((s) => s.loadingDetail);

  const roots = useMemo(() => (detail === null ? [] : buildSpanTree(detail.spans)), [detail]);

  if (loadingDetail) {
    return (
      <section className="w-96 shrink-0 border-r border-gray-200 bg-white px-3 py-6 text-xs text-gray-500">
        加载中…
      </section>
    );
  }

  if (detail === null) {
    return (
      <section className="w-96 shrink-0 border-r border-gray-200 bg-white px-3 py-6 text-xs text-gray-500">
        从左侧选择一次运行。
      </section>
    );
  }

  return (
    <section className="flex w-96 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="text-sm font-semibold text-gray-800">轨迹</div>
        <div className="text-[11px] text-gray-500">{detail.spans.length} 个 span · 只读呈现</div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {roots.map((node) => (
          <SpanRow key={node.span.id} node={node} depth={0} />
        ))}
      </div>
    </section>
  );
}
