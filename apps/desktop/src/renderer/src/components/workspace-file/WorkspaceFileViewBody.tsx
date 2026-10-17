import type { RunDetail, WorkspaceReadFileResult } from "@shared/ipc";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DirectoryEmptyReason,
  deriveDirectoryEmptyReason,
  directoryCounts,
  directoryEmptyMessage,
  filterFiles,
} from "../../lib/file-directory";
import {
  FILE_DIR_DEFAULT,
  FILE_DIR_MAX,
  FILE_DIR_MIN,
  type FilePane,
  clampRestoredDirWidth,
  decideDirResident,
  initialFileLayoutPrefs,
  preserveFilePrefs,
  resolveFilePaneVisibility,
  stepFileDirWidth,
} from "../../lib/file-layout";
import type { ContentScrollAnchor } from "../../lib/file-scroll";
import { formatBytes } from "../../lib/format";
import { decideRestore, initialRestoreState } from "../../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../../lib/scroll-restore";
import { useContainerWidth } from "../../lib/use-file-layout";
import type { WorkspaceExportFeedback } from "../../lib/workspace-export-state";
import {
  type CheckpointOption,
  availabilityLabel,
  changeLabel,
  checkpointOriginNote,
  inspectSummaryLine,
} from "../../lib/workspace-files";
import { WorkspaceExportPanel } from "../WorkspaceExportPanel";
import { WorkspaceHeading } from "../WorkspaceHeading";
import { FileContent } from "./FileContent";
import { type Selected, type Selection, checkpointLabel } from "./types";

/**
 * 展示层（纯函数组件）：只吃 props，不碰 store、不拉数据。
 * 结构断言直接打在这一层（`renderToStaticMarkup` 可渲染）。
 */
export interface WorkspaceFileViewBodyProps {
  readonly run: RunDetail;
  readonly options: readonly CheckpointOption[];
  readonly selection: Selection;
  readonly onSelect: (stepSpanId: string | null) => void;
  readonly inspect: Selected | null;
  readonly inspectError: { code: string; message: string } | null;
  readonly loadingList: boolean;
  readonly selectedPath: string | null;
  readonly onSelectPath: (path: string) => void;
  readonly current: WorkspaceReadFileResult | null;
  readonly currentKey: string | null;
  readonly currentLabel: string;
  readonly loadingContent: boolean;
  readonly contentError: { code: string; message: string } | null;
  /** U2 任务 3.2：**初始侧**由连接层独立维持（三件套：加载 / 成功 / 失败）。 */
  readonly initial?: WorkspaceReadFileResult | null;
  readonly initialKey?: string | null;
  readonly loadingInitial?: boolean;
  readonly initialFailed?: boolean;
  readonly selectedFailed?: boolean;
  readonly pane: FilePane;
  readonly onPane: (pane: FilePane) => void;
  /** U2 任务 3.4：搜索词与解析后的变化筛选 */
  readonly query?: string;
  readonly onQuery?: (query: string) => void;
  readonly changeFilter?: "all" | "changed";
  readonly onFilter?: (filter: "auto" | "all" | "changed") => void;
  readonly filterPreference?: "auto" | "all" | "changed";
  /** U2 任务 4.1：目录宽度/收起（用户偏好） */
  readonly dirWidth?: number;
  readonly onDirWidth?: (width: number) => void;
  readonly dirCollapsed?: boolean;
  readonly onDirCollapsed?: (collapsed: boolean) => void;
  /** U2 任务 4.2：diff 模式偏好与换行 */
  readonly diffPreference?: "auto" | "inline" | "sideBySide";
  readonly onDiffPreference?: (pref: "auto" | "inline" | "sideBySide") => void;
  readonly wordWrap?: boolean;
  readonly onWordWrap?: (on: boolean) => void;
  /** U2 任务 4.3：列表滚动位置 */
  readonly listScrollTop?: number;
  readonly onListScrollTop?: (top: number) => void;
  /** U2 任务 4.3：正文滚动锚点（按检查点 + 路径匹配，跨内容不复用） */
  readonly contentAnchor?: ContentScrollAnchor | null;
  readonly onContentAnchor?: (anchor: ContentScrollAnchor) => void;
  readonly fetchInitial: (
    stepSpanId: string | null,
    path: string,
  ) => Promise<WorkspaceReadFileResult | null>;
  /** U2 任务 3.3：**独立重试**回调（真的重新调用只读 IPC）。 */
  readonly onRetryList?: () => void;
  readonly onRetryContent?: () => void;
  readonly onRetryInitial?: () => void;
  /** U2：保存的检查点已失效 */
  readonly checkpointInvalidated?: boolean;
  /** U2：保存的路径在所选清单里已不存在 */
  readonly pathInvalidated?: boolean;
  /** R2.1 任务 6.1：导出选定检查点面板（资格/确认/反馈全部由连接层提供） */
  readonly exportPanel?: {
    readonly eligible: boolean;
    readonly ineligibleReason: string | null;
    readonly feedback: WorkspaceExportFeedback | null;
    readonly expanded: boolean;
    readonly onToggleExpanded: () => void;
    readonly onConfirm: () => void;
  };
}

export function WorkspaceFileViewBody({
  run,
  options,
  selection,
  onSelect,
  inspect,
  inspectError,
  loadingList,
  selectedPath,
  onSelectPath,
  current,
  currentKey,
  currentLabel,
  loadingContent,
  contentError,
  initial = null,
  initialKey = null,
  loadingInitial = false,
  initialFailed = false,
  selectedFailed = false,
  pane,
  onPane,
  query = "",
  onQuery,
  changeFilter = "all",
  onFilter,
  filterPreference = "auto",
  dirWidth = FILE_DIR_DEFAULT,
  onDirWidth,
  dirCollapsed = false,
  onDirCollapsed,
  diffPreference = "auto",
  onDiffPreference,
  wordWrap = true,
  onWordWrap,
  listScrollTop = 0,
  onListScrollTop,
  contentAnchor = null,
  onContentAnchor,
  fetchInitial,
  onRetryList,
  onRetryContent,
  onRetryInitial,
  checkpointInvalidated = false,
  pathInvalidated = false,
  exportPanel,
}: WorkspaceFileViewBodyProps) {
  const selectedFile = inspect?.files.find((f) => f.path === selectedPath) ?? null;

  /**
   * U2 任务 4.1：**容器实测宽度**驱动布局（不是窗口断点）。静态渲染下回落到 1280，
   * 让组件测试可断言布局分支。
   */
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>(1280);
  const dirPrefs = useMemo(
    () =>
      preserveFilePrefs({
        ...initialFileLayoutPrefs,
        dirWidth,
        dirUserCollapsed: dirCollapsed,
        diffPreference,
        wordWrap,
      }),
    [dirWidth, dirCollapsed, diffPreference, wordWrap],
  );
  const dirResident = decideDirResident({ prefs: dirPrefs, containerWidth });
  const paneVisibility = resolveFilePaneVisibility({ dirResident, pane });

  /**
   * U2 任务 3.4：目录的搜索/筛选/空态/计数**全部走纯派生层**（`lib/file-directory.ts`），
   * 组件不自己 `filter` 一遍。计数基于**完整清单**（不被搜索/筛选影响）。
   */
  const visibleFiles = useMemo(
    () => (inspect === null ? [] : filterFiles(inspect.files, query, changeFilter)),
    [inspect, query, changeFilter],
  );
  const emptyReason = useMemo<DirectoryEmptyReason>(
    () =>
      inspect === null ? "empty-list" : deriveDirectoryEmptyReason(inspect, query, changeFilter),
    [inspect, query, changeFilter],
  );
  const visibleCounts = useMemo(
    () =>
      inspect === null
        ? { total: 0, visible: 0, filtered: false }
        : directoryCounts(inspect, query, changeFilter),
    [inspect, query, changeFilter],
  );

  /**
   * U2 任务 4.3：**恢复列表滚动位置**。
   *
   * ⚠️ 这是 4.3 被误勾的缺口之一：`onListScrollTop` 一直只**写**（`data-list-scroll-top`
   *    只出不进），从未**读回** —— 文件→步骤→文件往返后列表位置永远回到顶部。
   *
   * 恢复必须过门控（`decideRestore`）并按**内容身份**记账：
   *   - 身份 = 检查点 + 清单规模（清单换一份 ⇒ 旧偏移不可复用）；
   *   - 容器未布局（`hidden` / 尚未量到高）⇒ 不恢复也**不记账**，等布局好再来；
   *   - 每个身份只恢复一次，避免迟到的恢复把用户后续滚动顶回去。
   */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const [listRestore, setListRestore] = useState(initialRestoreState);
  const listIdentity = `${selection.stepSpanId ?? "initial"}#${inspect === null ? "none" : inspect.files.length}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: listRestore 是**恢复记账**，写回后需重算门控
  useEffect(() => {
    const el = listScrollRef.current;
    if (el === null) return;
    const decision = decideRestore({
      state: listRestore,
      detailKey: listIdentity,
      contentReady: inspect !== null,
      measurable: el.clientHeight > 0 && el.scrollHeight > 0,
    });
    if (!decision.restore) return;
    const top = resolveScrollRestore(listScrollTop, {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    setListRestore(decision.next);
    if (top !== null) el.scrollTop = top;
  }, [listIdentity, inspect, listScrollTop, listRestore, paneVisibility.showList]);

  /**
   * 列表滚动上报。未完成布局（`scrollTop` 恒为 0）时**不记**——那会把记住的位置抹掉
   * （与 `DetailPanel.handleScroll` 同一口径，见 `scroll-restore.ts` 文件头）。
   */
  const onListScroll = useCallback((): void => {
    const el = listScrollRef.current;
    if (el === null) return;
    if (resolveRestoreScrollTop(el.scrollTop, el) === null) return;
    onListScrollTop?.(el.scrollTop);
  }, [onListScrollTop]);

  /**
   * U2 任务 4.6：**文件列表键盘导航 + 焦点恢复**。
   *
   * - `ArrowUp`/`ArrowDown` 在可见列表里移动选择（越过被筛掉/不可用的项）；
   * - `Home`/`End` 跳首/尾；`Enter`/`Space` 来自按钮原生行为，
   *   这里处理方向键让容器也能导航；
   * - 选择后把焦点交回**原文件项**（若已不在可见列表，落到列表容器），
   *   满足 delta「返回列表聚焦原文件或有效列表项」。
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  const moveSelection = useCallback(
    (delta: 1 | -1 | "home" | "end"): void => {
      if (visibleFiles.length === 0) return;
      const currentIndex = visibleFiles.findIndex((f) => f.path === selectedPath);
      let nextIndex: number;
      if (delta === "home") nextIndex = 0;
      else if (delta === "end") nextIndex = visibleFiles.length - 1;
      else if (currentIndex < 0) nextIndex = delta === 1 ? 0 : visibleFiles.length - 1;
      else nextIndex = Math.min(visibleFiles.length - 1, Math.max(0, currentIndex + delta));
      const target = visibleFiles[nextIndex];
      if (target === undefined) return;
      onSelectPath(target.path);
      // 焦点交回目标项（等重渲染后按钮已存在）
      const el = listRef.current?.querySelector<HTMLButtonElement>(
        `[data-file-path="${CSS.escape(target.path)}"]`,
      );
      el?.focus();
    },
    [visibleFiles, selectedPath, onSelectPath],
  );
  const onListKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveSelection(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveSelection(-1);
          break;
        case "Home":
          e.preventDefault();
          moveSelection("home");
          break;
        case "End":
          e.preventDefault();
          moveSelection("end");
          break;
        default:
          break;
      }
    },
    [moveSelection],
  );

  /**
   * U2 任务 4.1 + 4.6：**目录宽度可调整**（拖拽 + 键盘）。
   *
   * ⚠️ 这是 4.1 被误勾的缺口：`stepFileDirWidth`/`clampRestoredDirWidth` 此前是**死导入**
   *    ——纯逻辑写全了、单测也绿，但**没有任何 UI 控件消费它** ⇒ 目录宽实际上不可调。
   *
   * - 键盘：在分隔条上按 ArrowLeft/ArrowRight（16px 步进）/ Home / End（到边界）；
   * - 拖拽：pointerdown 后按 clientX 增量换算，全部经 `clampRestoredDirWidth` 夹取，
   *   拖拽与键盘**同走** `onDirWidth`（写回会话状态，与 4.1「尺寸变化写 store」一致）。
   */
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      const next = stepFileDirWidth(dirWidth, e.key);
      if (next === null) return;
      e.preventDefault();
      onDirWidth?.(next);
    },
    [dirWidth, onDirWidth],
  );
  const onResizerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      dragStateRef.current = { startX: e.clientX, startWidth: dirWidth };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [dirWidth],
  );
  const onResizerPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragStateRef.current;
      if (drag === null) return;
      const next = clampRestoredDirWidth(drag.startWidth + (e.clientX - drag.startX));
      onDirWidth?.(next);
    },
    [onDirWidth],
  );
  const onResizerPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>): void => {
    dragStateRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const originNote = useMemo(() => {
    if (inspect === null) return null;
    const parentStepId = inspect.origin.kind === "checkpoint" ? inspect.origin.stepSpanId : null;
    const parentStep =
      parentStepId === null
        ? null
        : run.spans.find((span) => span.id === parentStepId && span.kind === "agent.step");
    const parentIteration =
      parentStep !== undefined && parentStep !== null && parentStep.kind === "agent.step"
        ? parentStep.n
        : null;
    return checkpointOriginNote(inspect, parentIteration);
  }, [inspect, run.spans]);

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 flex-col"
      data-file-container-width={Math.round(containerWidth)}
    >
      {/* 检查点选择器 + 来源说明 */}
      <div className="border-b border-gray-200 px-4 py-2">
        <WorkspaceHeading
          title={<span className="text-reading-meta text-gray-600">文件检查点</span>}
          target={
            <div className="flex flex-wrap items-center gap-1">
              {options.map((option) => (
                <button
                  key={option.stepSpanId ?? "__initial__"}
                  type="button"
                  onClick={() => onSelect(option.stepSpanId)}
                  className={`rounded px-2 py-0.5 text-[11px] ${
                    selection.stepSpanId === option.stepSpanId
                      ? "bg-violet-600 text-white"
                      : "border border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                  title={
                    option.stepSpanId === null
                      ? "本 run 的文件世界起点（导入快照或父 run 检查点）"
                      : `检查点所属 step：${option.stepSpanId}`
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
          actions={
            inspect !== null ? (
              <span className="text-reading-meta text-gray-500">{inspectSummaryLine(inspect)}</span>
            ) : null
          }
          summary={<span className="text-violet-800">只读文件快照 · 相对本 run 初始状态比较</span>}
          detailsLabel="检查点来源与说明"
          details={
            <div className="space-y-1 py-1 text-reading-meta leading-5 text-gray-500">
              {originNote !== null ? <p className="text-violet-800">{originNote}</p> : null}
              <p>
                只读视图：仅按 trace
                引用读取附件，不写文件、不补快照、不调用模型；没有任何回写源目录的入口。
              </p>
              {inspect !== null ? (
                <p className="break-all font-code">
                  快照 {inspect.snapshotId} · profile {inspect.profile}
                </p>
              ) : null}
            </div>
          }
        />
        {checkpointInvalidated ? (
          <div className="mt-1 text-[11px] leading-4 text-amber-800">
            上次保存的检查点已不属于本
            run（可能来自祖先步骤或已删除的轮次），已回到最近的自有完成步骤。
          </div>
        ) : null}
        {pathInvalidated ? (
          <div className="mt-1 text-[11px] leading-4 text-amber-800">
            上次阅读的文件不在所选清单里，已清空选择并显示列表（不会改选同名的其它路径）。
          </div>
        ) : null}
        {exportPanel === undefined ? null : (
          <WorkspaceExportPanel
            runId={run.meta.id}
            stepSpanId={selection.stepSpanId}
            checkpointLabel={checkpointLabel(options, selection.stepSpanId)}
            eligible={exportPanel.eligible}
            ineligibleReason={exportPanel.ineligibleReason}
            feedback={exportPanel.feedback}
            expanded={exportPanel.expanded}
            onToggleExpanded={exportPanel.onToggleExpanded}
            onConfirm={exportPanel.onConfirm}
          />
        )}
      </div>

      {/* 目录/内容切换：目录非常驻时才需要（常驻时两者并排） */}
      {dirResident ? null : (
        <div className="flex items-center gap-1 border-b border-gray-200 px-4 py-1">
          <button
            type="button"
            onClick={() => onPane("list")}
            aria-label="显示文件列表"
            className={`rounded px-2 py-0.5 text-[11px] ${
              pane === "list" ? "bg-gray-800 text-white" : "border border-gray-300 text-gray-600"
            }`}
          >
            文件列表
          </button>
          <button
            type="button"
            onClick={() => onPane("content")}
            aria-label="显示文件内容"
            className={`rounded px-2 py-0.5 text-[11px] ${
              pane === "content" ? "bg-gray-800 text-white" : "border border-gray-300 text-gray-600"
            }`}
          >
            内容
          </button>
          {onDirCollapsed === undefined ? null : (
            <button
              type="button"
              onClick={() => onDirCollapsed(!dirCollapsed)}
              aria-expanded={dirCollapsed ? "false" : "true"}
              aria-label={dirCollapsed ? "展开文件目录" : "收起文件目录"}
              className="ml-auto min-h-[28px] rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none"
            >
              {dirCollapsed ? "展开目录" : "收起目录"}
            </button>
          )}
        </div>
      )}

      {inspectError !== null ? (
        <div className="mx-4 mt-2 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
          文件清单不可用（{inspectError.code}）：{inspectError.message}
          <div className="mt-0.5 text-red-600">
            原因来自 main 的只读读取；界面不会用"当前目录"或父 run 的历史快照兜底。
          </div>
          {onRetryList === undefined ? null : (
            <button
              type="button"
              onClick={onRetryList}
              className="mt-1 rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
            >
              重新读取清单
            </button>
          )}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* 文件目录 */}
        <div
          className={`min-h-0 overflow-y-auto border-gray-200 md:border-r ${
            dirResident ? "md:block md:shrink-0" : "w-full md:w-full"
          } ${paneVisibility.showList ? "block" : "hidden"}`}
          style={dirResident ? { width: dirWidth } : undefined}
          ref={listScrollRef}
          onScroll={onListScrollTop === undefined ? undefined : onListScroll}
          data-list-scroll-top={listScrollTop}
        >
          {/*
            UI 密度 change 1.2（design D1）：目录列自带标题行，显式收起入口**就近**
            放在标题旁——收起的是这一列，控制就该在这一列（此前放在页头检查点行，
            离目录远且看不出控制对象）。标题行与搜索/筛选行同在一个 sticky 容器内
            （避免两段 sticky 的偏移量互相踩）。收起后的「展开目录」由 pane 切换条
            承载（显示相反动作 + aria-expanded）。
          */}
          <div className="sticky top-0 z-10 border-b border-gray-100 bg-white">
            <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-1.5">
              <span className="text-[11px] font-semibold text-gray-500">目录</span>
              {dirResident && onDirCollapsed !== undefined ? (
                <button
                  type="button"
                  onClick={() => onDirCollapsed(true)}
                  aria-expanded="false"
                  aria-label="收起文件目录（可随时重新展开）"
                  title="收起文件目录（可随时重新展开）"
                  className="shrink-0 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none"
                >
                  收起目录
                </button>
              ) : null}
            </div>
            {/* U2 任务 3.4：搜索框 + 变化筛选 */}
            <div className="px-2 py-1.5">
              <input
                type="search"
                value={query}
                onChange={(e) => onQuery?.(e.target.value)}
                placeholder="按完整路径搜索"
                aria-label="按完整路径搜索文件"
                className="w-full rounded border border-gray-300 px-2 py-0.5 font-code text-[11px] text-gray-800"
              />
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {(
                  [
                    ["auto", "自动"],
                    ["all", "全部"],
                    ["changed", "有变化"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onFilter?.(value)}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      filterPreference === value
                        ? "bg-violet-600 text-white"
                        : "border border-gray-300 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <span className="ml-auto text-[10px] text-gray-400">
                  {visibleCounts.filtered
                    ? `筛出 ${visibleCounts.visible} / 共 ${visibleCounts.total}`
                    : `共 ${visibleCounts.total} 个`}
                </span>
              </div>
            </div>
          </div>

          {loadingList && inspect === null ? (
            <div className="px-3 py-4 text-[11px] text-gray-400">读取文件清单…</div>
          ) : inspect === null ? (
            <div className="px-3 py-4 text-[11px] text-gray-400">选择上方任一检查点查看文件。</div>
          ) : visibleFiles.length > 0 ? (
            <div
              ref={listRef}
              // biome-ignore lint/a11y/useSemanticElements: 需要 roving tabindex + 方向键导航，select 无法承载
              onKeyDown={onListKeyDown}
              role="listbox"
              tabIndex={0}
              aria-label="工作区文件列表"
              className="divide-y divide-gray-100 focus:outline-none"
            >
              {visibleFiles.map((file) => {
                const active = file.path === selectedPath;
                const usable = file.availability === "ok";
                return (
                  <div key={file.path} role="presentation">
                    <button
                      type="button"
                      data-file-path={file.path}
                      // roving tabindex：方向键移动选择（WAI-ARIA listbox 模式）
                      tabIndex={active ? 0 : -1}
                      // biome-ignore lint/a11y/useSemanticElements: listbox 的 option 由按钮承载（roving tabindex + 方向键），select 无法承载
                      role="option"
                      aria-selected={active}
                      onClick={() => onSelectPath(file.path)}
                      className={`block w-full px-3 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${
                        active ? "bg-violet-50" : "hover:bg-gray-50"
                      }`}
                    >
                      <div className="break-all font-code text-[11px] leading-4 text-gray-800">
                        {file.path}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px]">
                        <span className="text-gray-400">{formatBytes(file.bytes)}</span>
                        <span
                          className={
                            file.change === "added"
                              ? "text-emerald-700"
                              : file.change === "modified"
                                ? "text-amber-700"
                                : "text-gray-400"
                          }
                        >
                          {changeLabel(file.change)}
                        </span>
                        {usable ? null : (
                          <span className="rounded bg-red-100 px-1 text-red-700">
                            {availabilityLabel(file.availability)}
                          </span>
                        )}
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-4 text-[11px] text-gray-400">
              {directoryEmptyMessage(emptyReason, { query, filter: changeFilter })}
              {emptyReason === "no-match" && onQuery !== undefined ? (
                <button
                  type="button"
                  onClick={() => onQuery("")}
                  className="ml-2 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50"
                >
                  清空搜索
                </button>
              ) : null}
              {emptyReason === "no-change" && onFilter !== undefined ? (
                <button
                  type="button"
                  onClick={() => onFilter("all")}
                  className="ml-2 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50"
                >
                  查看全部
                </button>
              ) : null}
            </div>
          )}
        </div>

        {/* U2 任务 4.1 + 4.6：目录宽分隔条（拖拽 + 键盘；常驻时才显示） */}
        {dirResident && onDirWidth !== undefined ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文件目录宽度"
            aria-valuenow={Math.round(dirWidth)}
            aria-valuemin={FILE_DIR_MIN}
            aria-valuemax={FILE_DIR_MAX}
            tabIndex={0}
            onKeyDown={onResizerKeyDown}
            onPointerDown={onResizerPointerDown}
            onPointerMove={onResizerPointerMove}
            onPointerUp={onResizerPointerUp}
            className="hidden w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-violet-300 focus:bg-violet-400 focus:outline-none md:block"
          />
        ) : null}

        {/* 内容 / 差异 */}
        <div
          className={`min-h-0 min-w-0 flex-1 overflow-y-auto ${paneVisibility.showContent ? "block" : "hidden"}`}
        >
          {selectedPath === null ? (
            <div className="px-4 py-6 text-[11px] text-gray-400">
              从左侧选择一个文件查看内容与相对初始快照的差异。
            </div>
          ) : (
            <FileContent
              key={currentKey ?? ""}
              path={selectedPath}
              file={selectedFile}
              current={current}
              currentLabel={currentLabel}
              loading={loadingContent}
              error={contentError}
              initial={initial}
              initialKey={initialKey}
              loadingInitial={loadingInitial}
              initialFailed={initialFailed}
              selectedFailed={selectedFailed}
              fetchInitial={fetchInitial}
              onRetryContent={onRetryContent}
              onRetryInitial={onRetryInitial}
              contentAreaWidth={dirResident ? containerWidth - dirWidth - 12 : containerWidth}
              diffPreference={diffPreference}
              onDiffPreference={onDiffPreference}
              wordWrap={wordWrap}
              onWordWrap={onWordWrap}
              stepSpanId={selection.stepSpanId}
              contentAnchor={contentAnchor}
              onContentAnchor={onContentAnchor}
            />
          )}
        </div>
      </div>
    </div>
  );
}
