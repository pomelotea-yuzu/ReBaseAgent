import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { SpanNode } from "@shared/derive";
import { buildSpanTree, deriveStepStats } from "@shared/derive";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, formatTokens } from "../lib/format";
import { STEPS_MAX, STEPS_MIN } from "../lib/layout";
import { decideRestore, initialRestoreState, restoreIdentity } from "../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../lib/scroll-restore";
import { readingScrollOf } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { ResizeGrip } from "./ResizeGrip";

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

/**
 * 节点是否有错误。`error` 两个分支同名异构，**先按 kind 缩窄再取各自判据**：
 * - `tool.invoke.error` 是 `string | null` ⇒ `!== null` 才是失败（null = 成功）；
 * - `llm.call.error` 是 `object | undefined` ⇒ `!== undefined` 才是失败（缺省 = 未记录，
 *   不等于成功，但也没有失败可标记——不得猜造）。
 */
function hasError(span: SpanLine): boolean {
  if (span.kind === "tool.invoke") return span.error !== null;
  if (span.kind === "llm.call") return span.error !== undefined;
  return false;
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

  // 展开/选中由 click 与 keyboard 共享
  const activate = (): void => {
    selectSpan(span.id);
    if (isStep && children.length > 0) toggleStep(span.id);
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs ${
          selected ? "bg-blue-100" : "hover:bg-gray-100"
        } ${errored ? "text-red-700" : KIND_COLOR[span.kind]}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={activate}
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
      </button>

      {expanded
        ? children.map((child) => <SpanRow key={child.span.id} node={child} depth={depth + 1} />)
        : null}
    </div>
  );
}

export function SpanTree({
  width,
  onWidth,
  onWidthKey,
}: {
  width: number;
  onWidth: (width: number) => void;
  onWidthKey: (key: string) => boolean;
}) {
  const detail = useAppStore((s) => s.detail);
  const loadingDetail = useAppStore((s) => s.loadingDetail);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  /** 该 run 是否已有阅读条目（区分「没记过」与「记的就是 0」） */
  const runReading = useAppStore((s) =>
    s.selectedRunId === null ? null : (s.readingByRun[s.selectedRunId] ?? null),
  );
  const stepsScrollTop = useAppStore((s) =>
    s.selectedRunId === null ? 0 : s.readingOf(s.selectedRunId).stepsScrollTop,
  );
  const setReadingScroll = useAppStore((s) => s.setReadingScroll);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [restore, setRestore] = useState(initialRestoreState);

  /** 内容身份 = meta.id + span 指纹（同 run 重读后内容变了也要重新恢复） */
  const detailKey = detail === null ? null : restoreIdentity(detail);
  const roots = useMemo(() => (detail === null ? [] : buildSpanTree(detail.spans)), [detail]);

  /**
   * 内容挂载后恢复步骤目录滚动（design D6）。
   *
   * 三个前置条件缺一不可，故走 `decideRestore` 而不是在 effect 里直接写：
   * 详情已就绪、容器已布局可测、且**这一内容身份还没恢复过**（否则用户往下滚了
   * 几屏后任何一次重渲染都会把他顶回旧位置）。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const decision = decideRestore({
      state: restore,
      detailKey,
      contentReady: detail !== null && !loadingDetail,
      // 内容可恢复的前提：该 run 确实**记过**步骤目录的位置。
      // ⚠️ 用 `readingScrollOf(..., known)` 而不是直接比 `stepsScrollTop !== undefined`——
      // `readingOf` 对没条目的 run 返回默认值（0），"记的就是 0"与"没记过"必须分清。
      measurable:
        el.clientHeight > 0 &&
        readingScrollOf(runReading ?? {}, "steps", runReading !== null) !== undefined,
    });
    if (!decision.restore) return;
    const top = resolveScrollRestore(stepsScrollTop, {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    setRestore(decision.next);
    if (top !== null) el.scrollTop = top;
  }, [detailKey, detail, loadingDetail, stepsScrollTop, restore, runReading]);

  /** 滚动时按 run 记录位置（**只写 store 的阅读状态**，不动 trace、不落盘） */
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null || selectedRunId === null) return;
    // 未完成布局时不记录：此刻的 scrollTop 恒为 0，会把记住的位置抹掉
    if (resolveRestoreScrollTop(el.scrollTop, el) === null) return;
    setReadingScroll(selectedRunId, "steps", el.scrollTop);
  }, [selectedRunId, setReadingScroll]);

  if (loadingDetail) {
    return (
      <section
        className="shrink-0 border-r border-gray-200 bg-white px-3 py-6 text-xs text-gray-500"
        style={{ width, minWidth: width }}
      >
        加载中…
      </section>
    );
  }

  if (detail === null) {
    return (
      <section
        className="shrink-0 border-r border-gray-200 bg-white px-3 py-6 text-xs text-gray-500"
        style={{ width, minWidth: width }}
      >
        从左侧选择一次运行。
      </section>
    );
  }

  return (
    <section
      className="relative flex shrink-0 flex-col border-r border-gray-200 bg-white"
      style={{ width, minWidth: width }}
    >
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="text-sm font-semibold text-gray-800">轨迹</div>
        <div className="text-[11px] text-gray-500">{detail.spans.length} 个 span · 只读呈现</div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-1" onScroll={handleScroll}>
        {roots.map((node) => (
          <SpanRow key={node.span.id} node={node} depth={0} />
        ))}
      </div>

      {/* 宽度调节柄（任务 4.3）：200–320，拖动或 ←/→ 均可；480px 二次约束由外壳判 */}
      <ResizeGrip
        label="步骤目录宽度"
        width={width}
        min={STEPS_MIN}
        max={STEPS_MAX}
        onWidth={onWidth}
        onWidthKey={onWidthKey}
      />
    </section>
  );
}
