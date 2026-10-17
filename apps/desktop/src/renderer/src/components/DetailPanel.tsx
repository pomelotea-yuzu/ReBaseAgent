import type { SpanLine } from "@rebaseagent/trace-sdk";
import { buildSpanTree, spanDurationMs } from "@shared/derive";
import type { SpanNode } from "@shared/derive";
import type { ModelArmPlan, RunDetail } from "@shared/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import { presentStepDetail } from "../lib/call-detail-view";
import { isModelAbDraftDirty, newArmRowKey } from "../lib/debugging-drafts";
import { formatDuration } from "../lib/format";
import { decideRestore, initialRestoreState, restoreIdentity } from "../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../lib/scroll-restore";
import { validateCheckpointStepId } from "../lib/workspace-files";
import { readingScrollOf } from "../lib/workspace-selection";
import { useAppStore } from "../store";
import { BudgetMap } from "./BudgetMap";
import { DetailNotices } from "./DetailNotices";
import { KeyValue, RunDraftListSection, Section } from "./detail/DetailShared";
import { LlmCallDetail, LlmCallDetailView } from "./detail/LlmCallDetail";
import { StepDetailView } from "./detail/StepDetailView";
import { ToolInvokeDetail, ToolInvokeDetailView } from "./detail/ToolInvokeDetail";

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
