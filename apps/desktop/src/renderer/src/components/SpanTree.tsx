import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { SpanNode } from "@shared/derive";
import { buildSpanTree, deriveStepStats } from "@shared/derive";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, formatTokens } from "../lib/format";
import { STEPS_MAX, STEPS_MIN } from "../lib/layout";
import { decideRestore, initialRestoreState, restoreIdentity } from "../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../lib/scroll-restore";
import type { SpanRowView } from "../lib/span-tree-view";
import { rowErrorKind, spanRowLabel, stepsEmptyCause } from "../lib/span-tree-view";
import { readingScrollOf } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";
import { ResizeGrip } from "./ResizeGrip";

/**
 * 步骤目录（U1 任务 5.4 · design D1/D2）。
 *
 * 「轨迹以 span 树呈现」的三条本组件必须守住的义务：
 *
 * 1. **展开与选择分离**（delta「展开与调用选择互不干扰」）：展开控件是**独立的按钮**，
 *    点它只切展开、不动选中；点行只选中、不动展开。此前 `activate()` 把两者绑在一个
 *    click 里（点 step 既选中又翻转展开，点一下就把用户看的内容换掉了）——那是本任务要修的。
 * 2. **自有/继承可辨**：有共享前缀的轨迹里，继承段的 step 轮号旁标「继承」，
 *    不冒充本次自有（`leafSpanIds` 界定自有段）。
 * 3. **两类错误各自标记**：`tool.invoke.error` 与 `llm.call.error` 用各自的文字与颜色，
 *    **不改变 run 结局**（错误是数据不是异常）。
 *
 * ⚠️ 本包无 jsdom ⇒ 组件层用 `renderToStaticMarkup` 只能做静态断言；树的行序列与每行事实
 *    由 `lib/span-tree-view.ts` 的纯函数算出（有独立用例），本组件只摆放。
 */

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

/**
 * 一行内容（纯展示，测试可直接喂 `SpanRowView` 数据）。
 *
 * 展开控件与选中是两个**独立按钮**（见文件头纪律 1）：行按钮含标签与标记，
 * 展开按钮只在 `expandable` 时出现且只切展开。
 *
 * ⚠️ 组件名 `SpanRow` 与数据类型 `SpanRowView` 刻意不同名——两者同时出现在本文件，
 *    同名会让「喂进去的数据」与「吐出来的元素」在阅读与测试里互相冒充。
 */
export function SpanRow({
  row,
  selected,
  expanded,
  onSelect,
  onToggleExpand,
  durationMs,
  tokens,
}: {
  row: SpanRowView;
  selected: boolean;
  expanded: boolean;
  onSelect: (spanId: string) => void;
  onToggleExpand: (spanId: string) => void;
  /** 该行（step 为子树）的已记录耗时；null = 未知 */
  durationMs: number | null;
  /** step 行的子树 token 合计（非 step 为 0） */
  tokens: number;
}) {
  const errored = row.errorKind !== null;
  return (
    <div className="flex items-center" style={{ paddingLeft: 8 + row.depth * 14 }}>
      {/* 展开控件：独立按钮，只切展开、不动选中；不可展开时为等宽占位（保持缩进对齐） */}
      {row.expandable ? (
        <button
          type="button"
          onClick={() => onToggleExpand(row.spanId)}
          aria-expanded={expanded}
          aria-label={expanded ? "折叠该步骤" : "展开该步骤"}
          className={`w-5 shrink-0 cursor-pointer rounded text-[9px] text-gray-500 hover:bg-gray-200 ${FOCUS_RING}`}
        >
          {expanded ? "▼" : "▶"}
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}

      {/* 选择控件：只选中，不动展开 */}
      <button
        type="button"
        onClick={() => onSelect(row.spanId)}
        aria-current={selected ? "true" : undefined}
        title={row.label}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs ${
          selected ? "bg-blue-100" : "hover:bg-gray-100"
        } ${errored ? "text-red-700" : KIND_COLOR[row.kind]}`}
      >
        <span className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-500">
          {KIND_LABEL[row.kind]}
        </span>

        <span className={`truncate ${errored ? "font-medium" : ""}`}>{row.label}</span>

        {/* 继承标记：不在本次自有段里 ⇒ 明确标出来源，不冒充自有 */}
        {!row.own ? (
          <span
            className="shrink-0 rounded bg-gray-100 px-1 text-[10px] text-gray-500"
            title="来自父 run 的共享前缀（不是本次自有）"
          >
            继承
          </span>
        ) : null}

        {row.orphan ? (
          <span className="shrink-0 text-[10px] text-amber-600" title="父 span 不在此轨迹中">
            孤立
          </span>
        ) : null}

        {/* 两类错误各自标记（不合并） */}
        {row.errorKind === "tool" ? (
          <span className="shrink-0 text-[10px] text-red-600" title="工具调用记录到错误">
            工具错误
          </span>
        ) : null}
        {row.errorKind === "llm" ? (
          <span className="shrink-0 text-[10px] text-red-600" title="模型调用记录到错误">
            LLM 错误
          </span>
        ) : null}

        <span className="ml-auto shrink-0 pl-2 font-code text-[10px] text-gray-400">
          {formatDuration(durationMs)}
          {tokens > 0 ? ` · ${formatTokens(tokens)}` : ""}
        </span>
      </button>
    </div>
  );
}

/**
 * 一个树节点 + 其子树统计（供行渲染喂 durationMs / tokens）。
 *
 * ⚠️ **`depth` 必须逐层递增**：这是「树结构」在界面上唯一的可见证据（缩进）。
 *    缩进一次接不上（例如恒传 0），整棵树就会拍平成一列——看似"只是样式"，实为
 *    delta「三步运行的树结构」不成立。故 depth 由递归参数给出，**不另设覆盖径**。
 */
function SpanTreeRow({
  node,
  depth,
  onSelected,
}: { node: SpanNode; depth: number; onSelected?: () => void }) {
  const selectedSpanId = useAppStore((s) => s.selectedSpanId);
  const expandedSteps = useAppStore((s) => s.expandedSteps);
  const leafSpanIds = useAppStore((s) => s.detail?.leafSpanIds ?? []);

  const selectSpan = useAppStore((s) => s.selectSpan);
  const toggleStep = useAppStore((s) => s.toggleStep);

  const { span, children } = node;
  const isStep = span.kind === "agent.step";
  const expanded = isStep ? expandedSteps[span.id] !== false : true;
  const stats = useMemo(() => deriveStepStats(node), [node]);
  const ownIds = useMemo(() => new Set(leafSpanIds), [leafSpanIds]);

  const row: SpanRowView = {
    spanId: span.id,
    kind: span.kind,
    depth,
    label: spanRowLabel(span),
    own: ownIds.has(span.id),
    orphan: node.orphan,
    errorKind: rowErrorKind(span),
    expandable: isStep && children.length > 0,
  };

  return (
    <div>
      <SpanRow
        row={row}
        selected={selectedSpanId === span.id}
        expanded={expanded}
        onSelect={(id) => {
          selectSpan(id);
          onSelected?.();
        }}
        onToggleExpand={(id) => {
          if (isStep) toggleStep(id);
        }}
        durationMs={stats.durationMs}
        tokens={isStep ? stats.tokensIn + stats.tokensOut : 0}
      />
      {expanded
        ? children.map((child) => (
            <SpanTreeRow
              key={child.span.id}
              node={child}
              depth={depth + 1}
              onSelected={onSelected}
            />
          ))
        : null}
    </div>
  );
}

export function SpanTree({
  width,
  onWidth,
  onWidthKey,
  onToggleCollapsed,
  fullWidth = false,
  onSelected,
}: {
  width: number;
  onWidth: (width: number) => void;
  onWidthKey: (key: string) => boolean;
  /** 用户显式收起步骤目录（写偏好；自动折叠由外壳按可用空间决定，不走这里） */
  onToggleCollapsed: () => void;
  fullWidth?: boolean;
  onSelected?: () => void;
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
  const panelStyle = fullWidth ? { width: "100%", minWidth: 0 } : { width, minWidth: width };

  /** 内容身份 = meta.id + span 指纹（同 run 重读后内容变了也要重新恢复） */
  const detailKey = detail === null ? null : restoreIdentity(detail);
  const roots = useMemo(() => (detail === null ? [] : buildSpanTree(detail.spans)), [detail]);

  /** 空态成因：空轨迹 vs 有轨迹但无自有调用（两者文案不同，不合并） */
  const emptyCause = useMemo(() => {
    if (detail === null) return "none" as const;
    const own = new Set(detail.leafSpanIds);
    const ownCalls = detail.spans.filter(
      (span) => own.has(span.id) && (span.kind === "llm.call" || span.kind === "tool.invoke"),
    ).length;
    return stepsEmptyCause({ spanCount: detail.spans.length, ownCallCount: ownCalls });
  }, [detail]);

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
        style={panelStyle}
      >
        加载中…
      </section>
    );
  }

  if (detail === null) {
    return (
      <section
        className="shrink-0 border-r border-gray-200 bg-white px-3 py-6 text-xs text-gray-500"
        style={panelStyle}
      >
        从左侧选择一次运行。
      </section>
    );
  }

  return (
    <section
      id="steps-navigation"
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-gray-200 bg-white"
      style={panelStyle}
    >
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-gray-800">轨迹</div>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={fullWidth ? "返回当前调用" : "收起步骤目录"}
            title="收起步骤目录（正文右侧会保留「重新打开步骤目录」入口，当前选中的调用不会丢失）"
            className="shrink-0 rounded px-1.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            ‹
          </button>
        </div>
        <div className="text-[11px] text-gray-500">{detail.spans.length} 个 span · 只读呈现</div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-1" onScroll={handleScroll}>
        {emptyCause === "no-spans" ? (
          <div className="px-3 py-4 text-xs text-gray-500">
            这条记录没有任何 span——没有可展示的步骤。
          </div>
        ) : emptyCause === "no-own-calls" ? (
          <div className="px-3 py-2 text-[11px] leading-5 text-gray-500">
            本 run 没有自有模型/工具调用；下方为继承的共享前缀（首次选择回退到首个可读 span）。
          </div>
        ) : null}
        {roots.map((node) => (
          <SpanTreeRow key={node.span.id} node={node} depth={0} onSelected={onSelected} />
        ))}
      </div>

      {/* 宽度调节柄（任务 4.3）：200–320，拖动或 ←/→ 均可；480px 二次约束由外壳判 */}
      {!fullWidth ? (
        <ResizeGrip
          label="步骤目录宽度"
          width={width}
          min={STEPS_MIN}
          max={STEPS_MAX}
          onWidth={onWidth}
          onWidthKey={onWidthKey}
        />
      ) : null}
    </section>
  );
}
