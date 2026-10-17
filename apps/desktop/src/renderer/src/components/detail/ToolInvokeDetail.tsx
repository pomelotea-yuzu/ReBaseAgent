import type { SpanLine } from "@rebaseagent/trace-sdk";
import { spanDurationMs } from "@shared/derive";
import type { RunDetail } from "@shared/ipc";
import { type ReactNode, useMemo } from "react";
import { draftBadgeForSpan } from "../../lib/draft-list";
import { formatDuration, prettyJson } from "../../lib/format";
import { useAppStore } from "../../store";
import { isLongTextExpanded, toggleLongTextExpanded } from "../LongText";
import { LongText } from "../LongText";
import { WorkspaceHeading } from "../WorkspaceHeading";
import { KeyValue, Section } from "./DetailShared";
import { ForkEditor } from "./ResultForkEditor";

/**
 * `tool.invoke` 详情的纯展示部分（U1 任务 5.5）。
 *
 * 与壳 `ToolInvokeDetail` 分离的同一理由：本包无 jsdom、zustand v5 静态渲染走
 * `getServerSnapshot`（恒初始值）⇒ 壳喂不进状态。抽出后测试可直接喂 span 钉住
 * 「args 与 result 就近核对」「error 非空显式呈现」「dur_ms 与墙钟耗时都在」。
 *
 * 三条义务：
 *   1. **args / result 就近核对**（spec 原文「工具 args/result SHALL 在同一详情中便于核对」）：
 *      两块**并排**（宽屏）或上下相邻（窄屏），中间只隔一个"结果"标题，不再被其它栏目冲散。
 *   2. **error 非空必须显式呈现**：`span.error !== null`（`null` = 成功，不是"没有错误字段"）。
 *   3. **耗时两个口径都在**：`dur_ms`（工具自身执行）与墙上耗时（`spanDurationMs`，含排队/传输）——
 *      两者不等恰是排查"工具快但整体慢"的关键，不能只留一个。
 */
export function ToolInvokeDetailView({
  span,
  longTextProps,
  draftBadge,
  children,
  compact = false,
}: {
  span: Extract<SpanLine, { kind: "tool.invoke" }>;
  longTextProps: (key: string) => { expanded: boolean; onToggle: (next: boolean) => void };
  /** U3 任务 2.5：该调用的会话草稿标记（null = 无草稿） */
  draftBadge?: { label: string; dirty: boolean } | null;
  /** fork / 重跑编辑器（由壳提供） */
  children?: ReactNode;
  compact?: boolean;
}) {
  const recordedValues = (
    <div className="grid grid-cols-1 gap-2 py-2 sm:grid-cols-2">
      <div className="min-w-0">
        <div className="mb-1 text-[11px] font-medium text-gray-600">入参</div>
        <LongText text={prettyJson(span.args)} label="args" {...longTextProps("args")} />
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-[11px] font-medium text-gray-600">结果</div>
        <LongText text={prettyJson(span.result)} label="result" {...longTextProps("result")} />
      </div>
    </div>
  );
  return (
    <>
      {compact ? (
        <div className="border-b border-gray-200 px-4 py-2">
          <WorkspaceHeading
            title={<span className="text-reading-body text-gray-800">{span.tool}</span>}
            target={<span className="font-code">{span.id}</span>}
            summary={
              <span className="text-gray-500">
                执行 {span.dur_ms}ms · 墙上耗时 {formatDuration(spanDurationMs(span))}
                {draftBadge ? ` · ${draftBadge.label}` : ""}
              </span>
            }
            detailsLabel="入参与结果"
            details={recordedValues}
          />
        </div>
      ) : (
        <Section title="概要">
          <KeyValue
            items={[
              ["工具", span.tool],
              ["执行耗时", `${span.dur_ms}ms`],
              ["墙上耗时", formatDuration(spanDurationMs(span))],
              ...(draftBadge !== null && draftBadge !== undefined
                ? ([["草稿", draftBadge.label]] as Array<[string, string]>)
                : []),
            ]}
          />
        </Section>
      )}

      {span.error !== null ? (
        <Section title="错误（错误是数据不是异常）">
          <div className="rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5">
            <LongText text={span.error} label="错误信息" {...longTextProps("error")} />
          </div>
        </Section>
      ) : null}

      {/* args / result 就近核对：并排（宽屏）→ 上下相邻（窄屏），中间不被其它栏目隔开 */}
      {!compact ? (
        <Section title="入参与结果">
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] font-medium text-gray-600">入参</div>
              <LongText text={prettyJson(span.args)} label="args" {...longTextProps("args")} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] font-medium text-gray-600">结果</div>
              <LongText
                text={prettyJson(span.result)}
                label="result"
                {...longTextProps("result")}
              />
            </div>
          </div>
        </Section>
      ) : null}

      {children}
    </>
  );
}

/** tool.invoke 详情：入参、结果、错误（错误是数据，不改变 run 状态）＋ 分叉入口 */
export function ToolInvokeDetail({
  span,
  run,
}: {
  span: Extract<SpanLine, { kind: "tool.invoke" }>;
  run: RunDetail | null;
}) {
  const leafOwned = run?.leafSpanIds.includes(span.id) ?? false;
  // 分叉点必须是当前 run 自身段的 tool.invoke，且 run 已封存（crashed 前缀不稳定）
  const canFork = leafOwned && run?.status === "completed";

  // 长文本展开状态按 run + 调用隔离存会话（任务 3.6，与 LlmCallDetail 同一口径）
  const toolRunId = run?.meta.id ?? null;
  const toolExpandedSections = useAppStore((s) =>
    toolRunId === null || s.selectedRunId !== toolRunId
      ? undefined
      : s.readingOf(toolRunId).calls[span.id]?.expanded,
  );
  const setToolCallReading = useAppStore((s) => s.setCallReading);
  // U3 任务 2.5：该调用的会话草稿标记（徽章数据从草稿仓库派生，useMemo 保引用稳定）
  const drafts = useAppStore((s) => s.drafts);
  const toolDraftBadge = useMemo(
    () => (toolRunId === null ? null : draftBadgeForSpan(drafts, toolRunId, span.id)),
    [drafts, toolRunId, span.id],
  );
  const toolLongTextProps = (key: string): { expanded: boolean; onToggle: () => void } => ({
    expanded: isLongTextExpanded(toolExpandedSections, key),
    onToggle: () => {
      if (toolRunId === null) return;
      setToolCallReading(toolRunId, span.id, {
        expanded: toggleLongTextExpanded(toolExpandedSections, key),
      });
    },
  });

  return (
    <ToolInvokeDetailView
      span={span}
      longTextProps={toolLongTextProps}
      draftBadge={toolDraftBadge}
      compact
    >
      {canFork && run !== null ? (
        <ForkEditor span={span} run={run} />
      ) : span.kind === "tool.invoke" && run !== null && !leafOwned && run.chain.length > 1 ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该调用位于祖先前缀（继承自父 run），不属于当前 run 自身段——打开其所属 run 才可在此重跑。
        </div>
      ) : run !== null && leafOwned && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该 run 运行中断（未封存），不允许作为分叉起点。
        </div>
      ) : null}
    </ToolInvokeDetailView>
  );
}
