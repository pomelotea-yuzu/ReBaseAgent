import type { SpanLine } from "@rebaseagent/trace-sdk";
import { buildSpanTree, spanDurationMs } from "@shared/derive";
import type { SpanNode } from "@shared/derive";
import type { ModelArmPlan, RunDetail } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { presentStepDetail, resolveIoView } from "../lib/call-detail-view";
import { isModelAbDraftDirty, newArmRowKey } from "../lib/debugging-drafts";
import { draftBadgeForSpan } from "../lib/draft-list";
import { deriveEntryGate } from "../lib/entry-gate";
import type { EntryGate } from "../lib/entry-gate";
import { formatDuration } from "../lib/format";
import { isolatedParentExecutionNotice } from "../lib/isolated-fork";
import { decideRestore, initialRestoreState, restoreIdentity } from "../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../lib/scroll-restore";
import { validateCheckpointStepId } from "../lib/workspace-files";
import { readingScrollOf } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { BudgetMap } from "./BudgetMap";
import { requestConfirm } from "./ConfirmDialog";
import { ConfirmationBlock } from "./ConfirmationBlock";
import { DetailNotices } from "./DetailNotices";
import { isLongTextExpanded, toggleLongTextExpanded } from "./LongText";
import {
  ForkCacheHintView,
  IsolatedParentUnsupportedNotice,
  KeyValue,
  RunDraftListSection,
  Section,
} from "./detail/DetailShared";
import { LlmCallDetailView } from "./detail/LlmCallDetail";
import { PromptForkEditor } from "./detail/PromptForkEditor";
import { ForkEditor } from "./detail/ResultForkEditor";
import { StepDetailView } from "./detail/StepDetailView";
import { ToolInvokeDetailView } from "./detail/ToolInvokeDetail";

// 兼容导出：原入口导出指向同一实现（design D1，S01）。新消费方应直接用 detail/* 模块。
export {
  CacheHitRow,
  ForkCacheHintView,
  ISOLATED_PARENT_UNSUPPORTED_KEY,
  IsolatedParentUnsupportedNotice,
} from "./detail/DetailShared";
export { LlmCallDetailView } from "./detail/LlmCallDetail";
export { StepDetailView } from "./detail/StepDetailView";
export { ToolInvokeDetailView } from "./detail/ToolInvokeDetail";

/** llm.call 详情：完整请求 + 响应（思维链与正文分区）；代理 run 提供编辑重发 */
function LlmCallDetail({
  span,
  run,
}: { span: Extract<SpanLine, { kind: "llm.call" }>; run: RunDetail | null }) {
  const { request, response, error } = span;
  const leafOwned = run?.leafSpanIds.includes(span.id) ?? false;
  const isProxy = run?.meta.source?.kind === "proxy";
  const canResend = isProxy === true && leafOwned && run?.status === "completed";
  // U8 5.1b：就地编辑器已迁 messages 工作区——步骤页只留**入口**（同一草稿键、
  // 同一目标身份，不是第二份表单状态）；SDK run / 未封存 / 非自有调用不给入口。
  const openMessagesWorkspace = useAppStore((s) => s.openMessagesWorkspace);

  /**
   * 长文本块的展开状态按 run + 调用隔离存会话（任务 3.6）。
   *
   * 键用**稳定字段名**（"error" / "reasoning" / "content" / "tool_calls" / `msg:<序号>` /
   * "tools" / "params"），不用数组下标或渲染顺序——否则重读后块的位置一变，恢复就串了。
   * 消息项用其在 request.messages 里的序号（design D6：不可变记录内的序号）。
   */
  const runId = run?.meta.id ?? null;
  const expandedSections = useAppStore((s) =>
    runId === null || s.selectedRunId !== runId
      ? undefined
      : s.readingOf(runId).calls[span.id]?.expanded,
  );
  /**
   * 输入/输出切换（任务 5.5 · design D6 的 `CallReadingState.io`）。
   *
   * 与展开状态同存一处（`readingByRun[runId].calls[spanId]`）——切换是**阅读位置**的一种，
   * 切走再回来要恢复用户看的那半。`undefined` = 没切过 ⇒ 按 `defaultIoView` 定默认。
   */
  const ioState = useAppStore((s) =>
    runId === null || s.selectedRunId !== runId ? undefined : s.readingOf(runId).calls[span.id]?.io,
  );
  const setCallReading = useAppStore((s) => s.setCallReading);
  const io = resolveIoView(span, ioState);
  const longTextProps = (
    key: string,
  ): { expanded: boolean; onToggle: (next: boolean) => void } => ({
    expanded: isLongTextExpanded(expandedSections, key),
    onToggle: () => {
      if (runId === null) return;
      // 只翻转目标键的开关，`next` 由 store 里的当前值推导——受控组件不自己猜状态
      setCallReading(runId, span.id, {
        expanded: toggleLongTextExpanded(expandedSections, key),
      });
    },
  });

  /**
   * 空正文文案：失败 / 仅有工具调用 / 仅有思维链 / 真空正文 四态。
   * 旧实现一律写"无正文，仅有工具调用"——对失败调用与 reasoning-only 成功响应都是错的。
   */
  const emptyContentHint =
    error !== undefined
      ? "（调用失败，无响应正文）"
      : response.tool_calls.length > 0
        ? "（无正文，仅有工具调用）"
        : response.reasoning_content !== null
          ? "（无正文，仅有思维链）"
          : "（响应为空正文）";

  // U3 任务 2.5：该调用的会话草稿标记（徽章数据从草稿仓库派生，useMemo 保引用稳定）
  const drafts = useAppStore((s) => s.drafts);
  const llmDraftBadge = useMemo(
    () => (runId === null ? null : draftBadgeForSpan(drafts, runId, span.id)),
    [drafts, runId, span.id],
  );

  return (
    <LlmCallDetailView
      span={span}
      io={io}
      onIo={(next) => {
        if (runId === null) return;
        setCallReading(runId, span.id, { io: next });
      }}
      emptyContentHint={emptyContentHint}
      longTextProps={longTextProps}
      draftBadge={llmDraftBadge}
    >
      {(() => {
        // prompt fork 入口：仅限首次 llm.call（启动上下文的事实源）。
        // 代理 run 在录制侧已补 config_hash 时与引擎 run 同判据（不再无条件排除 proxy）；
        // 无 hash 的代理 run 不显示编辑器（服务端 loadForkParent 按缺因兜底）。
        const forkEntriesAvailable =
          run !== null &&
          run.status === "completed" &&
          run.meta.config_hash !== undefined &&
          leafOwned;
        const firstLlmId = run?.spans.find((s) => s.kind === "llm.call")?.id;
        if (!forkEntriesAvailable || run === null) return null;
        if (firstLlmId === span.id) {
          // 隔离父本：两个入口都禁用并说明原因（内核对同一批请求也拒绝，见 1.2 的用例）。
          // UI 密度 change 1.3：原因改为「紧凑一行 + 可展开详情」——不适用这一事实常驻，
          // 完整原因（为什么/内核同样拒绝/可用方式）收进共享 Disclosure 机制，可查询。
          if (isolatedParentExecutionNotice(run) !== null) {
            return <IsolatedParentUnsupportedNotice run={run} />;
          }
          return (
            <>
              <PromptForkEditor key={span.id} span={span} run={run} />
              {/* U8 3.1b：模型 A/B 编辑器迁往实验工作区（运行级「更多操作」入口进入；
                  步骤页不再挂第二份编辑表单——同一草稿键、同一执行通道，不存在两份配置真相）。
                  隔离 notice 的文案里保留 A/B 字样（门禁事实不变）。 */}
            </>
          );
        }
        return (
          <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
            prompt fork 与模型 A/B 只从首次 llm.call 的启动上下文出发；打开首次 llm.call（
            {firstLlmId}）使用编辑入口。
          </div>
        );
      })()}

      {canResend && run !== null ? (
        /* U8 5.1b：MessagesForkEditor 已迁 messages 编辑工作区（design D1：原详情
            不另养一份编辑器）。入口按钮打开工作区并显式绑定目标（runId + spanId）；
            「SDK run 无此入口」由 canResend 的 source.kind 门槛承担。 */
        <div className="border-t border-sky-100 px-4 py-2">
          <button
            type="button"
            data-messages-workspace-entry
            onClick={() => openMessagesWorkspace({ runId: run.meta.id, spanId: span.id })}
            className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-700"
          >
            编辑 messages 重发
          </button>
          <div className="mt-1 text-[11px] text-gray-400">
            在 messages 编辑工作区打开：单请求级分叉 · 源 run 不会被修改 · 重发使用最近捕获的 key
          </div>
        </div>
      ) : isProxy && run !== null && run.status === "crashed" ? (
        <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400">
          该 run 运行中断（未封存），不允许作为重发起点。
        </div>
      ) : null}
    </LlmCallDetailView>
  );
}

/** tool.invoke 详情：入参、结果、错误（错误是数据，不改变 run 状态）＋ 分叉入口 */
function ToolInvokeDetail({
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

export function DetailPanel({
  focusActive = false,
  focusControlsInHeader = false,
  onEnterFocus,
  onExitFocus,
}: {
  /** UI 密度 2.4：专注编辑态（App 层按当前工作区身份比对生效；显示覆盖，不写偏好） */
  readonly focusActive?: boolean;
  readonly focusControlsInHeader?: boolean;
  readonly onEnterFocus?: (mode: "edit" | "diff") => void;
  readonly onExitFocus?: () => void;
}) {
  const detail = useAppStore((s) => s.detail);
  const selectedSpanId = useAppStore((s) => s.selectedSpanId);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const loadingDetail = useAppStore((s) => s.loadingDetail);
  const detailScrollTop = useAppStore((s) =>
    s.selectedRunId === null ? 0 : s.readingOf(s.selectedRunId).overviewScrollTop,
  );
  /** 该 run 是否已有阅读条目（区分「没记过」与「记的就是 0」） */
  const runReading = useAppStore((s) =>
    s.selectedRunId === null ? null : (s.readingByRun[s.selectedRunId] ?? null),
  );
  const setReadingScroll = useAppStore((s) => s.setReadingScroll);
  const selectSpan = useAppStore((s) => s.selectSpan);
  const openFileAt = useAppStore((s) => s.openFileAt);

  // 切换 run / 重读 ⇒ 内容身份变化（meta.id + span 指纹）⇒ 重新武装恢复窗口
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [restore, setRestore] = useState(initialRestoreState);
  const detailKey = detail === null ? null : restoreIdentity(detail);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const decision = decideRestore({
      state: restore,
      detailKey,
      contentReady: detail !== null && !loadingDetail,
      measurable:
        el.clientHeight > 0 &&
        readingScrollOf(runReading ?? {}, "overview", runReading !== null) !== undefined,
    });
    if (!decision.restore) return;
    const top = resolveScrollRestore(detailScrollTop, {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    setRestore(decision.next);
    if (top !== null) el.scrollTop = top;
  }, [detailKey, detail, loadingDetail, detailScrollTop, restore, runReading]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null || selectedRunId === null) return;
    // 未完成布局时不记录（此刻 scrollTop 恒为 0，会把记住的位置抹掉）
    if (resolveRestoreScrollTop(el.scrollTop, el) === null) return;
    setReadingScroll(selectedRunId, "overview", el.scrollTop);
  };

  const span = useMemo(
    () => detail?.spans.find((s) => s.id === selectedSpanId) ?? null,
    [detail, selectedSpanId],
  );

  /**
   * 选中的 step 在 span 树里的节点（任务 5.5）。
   *
   * ⚠️ 必须从**树**里取节点而不是直接拿 span：step 详情要列它的直接子调用、并让
   *    `deriveStepStats` 算子树消耗——这些都只有 `SpanNode` 有，`SpanLine` 没有。
   *    树缺失（detail 未加载）时为 null，分支自然回落到"尚未选择"。
   */
  const stepNode = useMemo(() => {
    if (detail === null || span === null || span.kind !== "agent.step") return null;
    const roots = buildSpanTree(detail.spans);
    const find = (nodes: SpanNode[]): SpanNode | null => {
      for (const node of nodes) {
        if (node.span.id === span.id) return node;
        const hit = find(node.children);
        if (hit !== null) return hit;
      }
      return null;
    };
    return find(roots);
  }, [detail, span]);

  /**
   * U2 任务 2.3/5.3：步骤页的**自有步骤文件入口**。
   *
   * ⚠️ 这是 5.3 实机暴露的真实缺口：`store.openFileAt`（一次性显式文件目标）写好了、
   *    `WorkspaceFilesPanel` 也接好了消费端，但**全仓没有任何调用方** ⇒ spec 场景
   *    「显式文件定位覆盖历史」的 WHEN「用户从当前运行的自有步骤打开该轮文件」在界面上
   *    根本不可达（又一个"能力断言不钉接线"的复发）。
   *
   * 判据必须与选择器同源（`validateCheckpointStepId(...) === "valid"` = 该 step 是本 run
   * 的自有完成步骤）：祖先步骤 / 已删轮次 / 拼错 id 一律**不给入口**，否则就是
   * delta 明令禁止的"把祖先当本 run 检查点"。
   */
  const openStepFiles = useMemo(() => {
    if (detail === null || span === null || span.kind !== "agent.step") return null;
    if (validateCheckpointStepId(detail, span.id) !== "valid") return null;
    const runId = detail.meta.id;
    const stepSpanId = span.id;
    return () => openFileAt(runId, { stepSpanId });
  }, [detail, span, openFileAt]);

  // 步骤页 = 详情提示区 + 主区正文。
  // ⚠️ 文件页**不在这里**：U1 6.1 已把它上提为工作区一级承载（`WorkspaceFilesPanel`），
  //    由 App 在 `files` 页签挂载。此前这里是 `tab === "files"` 的内部分支，但那个
  //    `tab` 是**组件局部 useState**、从不与 store 的工作区页签同步 ⇒ 点工作区的
  //    「文件」页签时这里仍是 trajectory，文件视图根本不出现（只读阅读路径断裂）。
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-white">
      {/* 2.4 专注编辑：显示覆盖（收起草稿列表与消耗图），不写偏好、目标变化由 App 层清空 */}
      {focusActive && !focusControlsInHeader ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-violet-200 bg-violet-50 px-3 py-1"
          data-focus-bar="edit"
        >
          <span className="text-[11px] font-medium text-violet-900">
            专注编辑 · 草稿列表与消耗图已临时收起（选择与阅读状态不变，退出后按原布局恢复）
          </span>
          <button
            type="button"
            data-exit-focus="true"
            onClick={onExitFocus}
            className="ml-auto rounded border border-violet-300 bg-white px-2 py-0.5 text-[11px] text-violet-900 hover:bg-violet-100"
          >
            退出专注
          </button>
        </div>
      ) : null}
      {!focusActive && !focusControlsInHeader && onEnterFocus !== undefined ? (
        <div className="shrink-0 border-b border-gray-100 px-3 py-1">
          <button
            type="button"
            data-enter-focus="edit"
            onClick={() => onEnterFocus("edit")}
            title="临时收起草稿列表与消耗图，把空间让给编辑区（退出后按原布局恢复）"
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
          >
            专注编辑
          </button>
        </div>
      ) : null}
      <DetailNotices />
      {!focusActive && selectedRunId !== null ? (
        <RunDraftListSection runId={selectedRunId} />
      ) : null}

      <div ref={scrollRef} className="flex-1 overflow-y-auto pb-8" onScroll={handleScroll}>
        {!focusActive && detail !== null ? (
          <BudgetMap key={detail.meta.id} detail={detail} />
        ) : null}
        {span === null ? (
          <div className="px-4 py-6 text-xs text-gray-500">
            {detail === null ? "尚未选择运行。" : "尚未选择 span。"}
          </div>
        ) : span.kind === "llm.call" ? (
          <LlmCallDetail span={span} run={detail} />
        ) : span.kind === "tool.invoke" ? (
          // key=span.id：切换 span 时重置分叉编辑器的编辑状态
          <ToolInvokeDetail key={span.id} span={span} run={detail} />
        ) : stepNode !== null ? (
          // step 详情（任务 5.5）：已记录调用 + 错误 + 派生消耗，可下钻到原始调用
          <StepDetailView
            key={span.id}
            view={presentStepDetail(stepNode)}
            onOpenCall={(id) => selectSpan(id)}
            onOpenStepFiles={openStepFiles ?? undefined}
          />
        ) : (
          <Section title="步骤概要">
            <KeyValue
              items={[
                ["迭代序号", String(span.n)],
                ["耗时", formatDuration(spanDurationMs(span))],
              ]}
            />
            <div className="mt-2 text-[11px] text-gray-500">
              展开该步骤可查看其下的 LLM 调用与工具执行。
            </div>
          </Section>
        )}
      </div>
    </section>
  );
}
