import type { RunDetail } from "@shared/ipc";
import type { WorkspaceInspectResult, WorkspaceReadFileResult } from "@shared/ipc";
import type { editor as MonacoEditorNs } from "monaco-editor";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Monaco diff 编辑器实例类型（U2 任务 4.5 差异导航用） */
type IStandaloneDiffEditor = MonacoEditorNs.IStandaloneDiffEditor;
import {
  type DirectoryEmptyReason,
  deriveDirectoryEmptyReason,
  directoryCounts,
  directoryEmptyMessage,
  filterFiles,
  resolveChangeFilter,
} from "../lib/file-directory";
import {
  type DiffMode,
  FILE_DIR_DEFAULT,
  FILE_DIR_MAX,
  FILE_DIR_MIN,
  type FilePane,
  clampRestoredDirWidth,
  decideDiffMode,
  decideDirResident,
  initialFileLayoutPrefs,
  preserveFilePrefs,
  resolveFilePaneVisibility,
  stepFileDirWidth,
} from "../lib/file-layout";
import {
  type SideReadiness,
  copyableMeta,
  copyableText,
  resolveToolEnablement,
  sideReadiness,
} from "../lib/file-tools";
import { formatBytes } from "../lib/format";
import {
  type ListReadState,
  RequestGuard,
  type SideReadState,
  settleList,
  settleSide,
  sideResult,
} from "../lib/reading-request-guard";
import { useContainerWidth } from "../lib/use-file-layout";
import {
  availabilityLabel,
  canCompareText,
  canEnterTextDiff,
  changeLabel,
  checkpointOriginNote,
  defaultCheckpointStepId,
  deriveCheckpointOptions,
  detectFileLanguage,
  inspectSummaryLine,
  resolveDiffSides,
  validateCheckpointStepId,
  validateSavedPath,
} from "../lib/workspace-files";
import type { CheckpointOption, DiffSides } from "../lib/workspace-files";
import { useAppStore } from "../store";
import { MonacoDiffEditor } from "./MonacoEditor";

/**
 * 隔离文件检查点视图（C 任务 2.1/2.2；U2 任务 2.4/3.x/4.x）。
 *
 * **只读**——没有任何"回写 / 应用到源目录"入口（本段明令禁止）。复用现有 Monaco 离线装配
 * （`monaco-bootstrap.ts` 已在渲染入口配置），DiffEditor 走 `@monaco-editor/react` 的懒加载
 * 组件（`loader` 已指向本地实例，不联网）。
 *
 * U2 起四条渲染纪律：
 * 1. **数字与清单全部来自 main 的只读 IPC**（`workspaces:inspect`）——组件不自己数文件、
 *    不自己算哈希、不自己推轮号。
 * 2. **缺席的一侧显式标"不存在"**，绝不用空文本冒充；二进制/缺失/损坏一律不进编辑器。
 * 3. **布局依容器实测宽度决策**（不是窗口断点）：先保 480px 正文，再决定目录常驻与 inline/并排。
 * 4. **窄容器下二选一**：目录与内容占同一主区，切换入口始终可达。
 */

type Selected = WorkspaceInspectResult;

/** 检查点选择项：每次选择都要带上 stepSpanId（null = 初始） */
interface Selection {
  readonly stepSpanId: string | null;
}

/**
 * 请求的稳定键：标识"逻辑上同一个对象"（同 run 同 step 同 path）。
 *
 * ⚠️ 这个键**只用于识别对象**，**不用来判定新旧**——同对象重试的 key 完全相同，
 *    靠 key 相等无法区分先后（U2 任务 3.1 的根因）。新旧一律由 `RequestGuard` 的
 *    单调代次判（见 `lib/reading-request-guard.ts` 文件头）。
 */
function requestKey(runId: string, stepSpanId: string | null, path: string): string {
  return `${runId}\u0000${stepSpanId ?? ""}\u0000${path}`;
}

/**
 * 连接层：把 store 上的两个只读 IPC 动作接进展示层。
 *
 * 单独拆出来的原因：**可测**（本包无 jsdom，`renderToStaticMarkup` 不跑 effect；把"拉数据"
 * 留在这层、把"排版"留在 `WorkspaceFileViewBody`，就能对展示层做结构断言）+
 * **判据与请求同源**（拉取判据与渲染判据在同一处产生）。
 *
 * U2 任务 3.1 的请求纪律（三条，缺一即回归 C 时代缺陷）：
 * - **清单与两侧各自持有 `RequestGuard` 与显式三态**（`ListReadState` / `SideReadState`）。
 * - **每个响应先过 `accept`**：旧代次一律丢弃（一个字节都不写）。
 * - **loading 由状态机持有**，不在 `finally` 里无条件清除。
 */
export function WorkspaceFileView({ run }: { run: RunDetail }) {
  const inspectWorkspace = useAppStore((s) => s.inspectWorkspace);
  const readWorkspaceFile = useAppStore((s) => s.readWorkspaceFile);
  const fileReading = useAppStore((s) => s.fileReadingOf(run.meta.id));
  const setFileReading = useAppStore((s) => s.setFileReading);

  const options = useMemo(() => deriveCheckpointOptions(run), [run]);

  /**
   * U2 任务 2.4：选择/pane/偏好**接入会话状态**，不再用组件局部 state。
   * C 时代这些是 `useState`，而 `WorkspaceFilesPanel` 以 `key={detail.meta.id}` 硬重挂载
   * ⇒ 每次「文件 → 步骤 → 文件」都回到初始状态（R7 复现的缺陷）。
   *
   * ⚠️ 恢复前必须**重新校验**：保存的 step / path 可能已不在当前详情里。
   */
  const saved = fileReading;

  // 默认检查点：首次进入用最近自有完成步骤；保存的 step 失效则回退默认
  const checkpointCheck = validateCheckpointStepId(run, saved.checkpoint);
  const effectiveStepSpanId =
    checkpointCheck === "valid"
      ? saved.checkpoint
      : checkpointCheck === "stale"
        ? defaultCheckpointStepId(run)
        : saved.checkpoint;
  const checkpointInvalidated = checkpointCheck === "stale";

  /**
   * U2 任务 3.1：三个**各自独立**的请求面。用 `useRef` 而不是 `useState`——
   * 守卫是**命令式**的（begin/accept 要跨渲染保持同一实例），且它自身不会触发渲染。
   */
  const listGuardRef = useRef<RequestGuard | null>(null);
  const initialGuardRef = useRef<RequestGuard | null>(null);
  const selectedGuardRef = useRef<RequestGuard | null>(null);
  if (listGuardRef.current === null) listGuardRef.current = new RequestGuard();
  if (initialGuardRef.current === null) initialGuardRef.current = new RequestGuard();
  if (selectedGuardRef.current === null) selectedGuardRef.current = new RequestGuard();

  const [listState, setListState] = useState<ListReadState>({ kind: "idle" });
  const [initialState, setInitialState] = useState<SideReadState>({ kind: "idle" });
  const [selectedState, setSelectedState] = useState<SideReadState>({ kind: "idle" });

  /** U2 任务 3.3：**独立重试**的非单调计数（加进 effect 依赖即触发重跑）。 */
  const [listRetry, setListRetry] = useState(0);
  const [initialRetry, setInitialRetry] = useState(0);
  const [selectedRetry, setSelectedRetry] = useState(0);

  // 清单结果（成功才有）：渲染与路径校验都从这里取
  const inspect: Selected | null = listState.kind === "ok" ? listState.result : null;
  const inspectError =
    listState.kind === "failed" ? { code: listState.code, message: listState.message } : null;
  const loadingList = listState.kind === "loading";

  // 保存的 path 在新清单里是否仍存在（present/absent/unknown；unknown 不当作消失）
  const pathCheck = validateSavedPath(inspect, inspectError !== null, saved.path);
  const effectivePath = pathCheck === "absent" ? null : saved.path;
  const pathInvalidated = pathCheck === "absent";

  // 拉清单：选择变化即重新拉（判据是"当前选择"，与渲染同源）
  // biome-ignore lint/correctness/useExhaustiveDependencies: listRetry 是**重试触发器**，靠变化重跑本 effect
  useEffect(() => {
    const guard = listGuardRef.current;
    if (guard === null) return;
    const request =
      effectiveStepSpanId === null
        ? { runId: run.meta.id }
        : { runId: run.meta.id, stepSpanId: effectiveStepSpanId };
    const token = guard.begin("list", requestKey(run.meta.id, effectiveStepSpanId, ""));
    setListState({ kind: "loading" });
    void inspectWorkspace(request)
      .then((outcome) => {
        const next = settleList(guard, token, outcome);
        if (next !== null) setListState(next);
      })
      .catch((error: unknown) => {
        const next = settleList(guard, token, {
          ok: false,
          code: "INSPECT_UNEXPECTED",
          message: error instanceof Error ? error.message : String(error),
        });
        if (next !== null) setListState(next);
      });
  }, [inspectWorkspace, run.meta.id, effectiveStepSpanId, listRetry]);

  /**
   * U2 任务 3.2：**两侧独立读取**。初始侧与所选侧各走各的守卫与状态：
   * - 任一侧不可用（失败 / 二进制 / 缺失 / 损坏）**不阻止**另一侧展示；
   * - 通道失败折成 `failed` 状态，**不**折成 `not_found`。
   */
  const readSide = useCallback(
    async (stepSpanId: string | null, path: string): Promise<WorkspaceReadFileResult | null> => {
      const request =
        stepSpanId === null
          ? { runId: run.meta.id, path }
          : { runId: run.meta.id, stepSpanId, path };
      const outcome = await readWorkspaceFile(request);
      return outcome.ok ? outcome.data : null;
    },
    [readWorkspaceFile, run.meta.id],
  );

  const currentKey =
    effectivePath === null ? null : requestKey(run.meta.id, effectiveStepSpanId, effectivePath);
  const initialKey = effectivePath === null ? null : requestKey(run.meta.id, null, effectivePath);

  // 所选检查点侧：路径或检查点变化即重新读（同一对象重试也走这里，代次递增）
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedRetry 是**重试触发器**，靠变化重跑本 effect
  useEffect(() => {
    const guard = selectedGuardRef.current;
    if (guard === null) return;
    if (effectivePath === null || currentKey === null) {
      guard.invalidate();
      setSelectedState({ kind: "idle" });
      return;
    }
    const token = guard.begin("selected", currentKey);
    setSelectedState({ kind: "loading" });
    void readWorkspaceFile(
      effectiveStepSpanId === null
        ? { runId: run.meta.id, path: effectivePath }
        : { runId: run.meta.id, stepSpanId: effectiveStepSpanId, path: effectivePath },
    )
      .then((outcome) => {
        const next = settleSide(guard, token, outcome);
        if (next !== null) setSelectedState(next);
      })
      .catch((error: unknown) => {
        const next = settleSide(guard, token, {
          ok: false,
          code: "READ_UNEXPECTED",
          message: error instanceof Error ? error.message : String(error),
        });
        if (next !== null) setSelectedState(next);
      });
  }, [
    readWorkspaceFile,
    run.meta.id,
    effectivePath,
    effectiveStepSpanId,
    currentKey,
    selectedRetry,
  ]);

  /**
   * 初始侧：**独立**于所选侧读取（不再等"当前已读出"才拉）。
   *
   * ⚠️ 与所选侧分开的关键原因（delta「不可用侧不伪装为空差异」的根因）：C 时代初始侧
   *    以 `current` 成功为前置条件 ⇒ 所选侧一失败，初始侧就永远不读。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialRetry 是**重试触发器**，靠变化重跑本 effect
  useEffect(() => {
    const guard = initialGuardRef.current;
    if (guard === null) return;
    if (effectivePath === null || initialKey === null) {
      guard.invalidate();
      setInitialState({ kind: "idle" });
      return;
    }
    const token = guard.begin("initial", initialKey);
    setInitialState({ kind: "loading" });
    void readWorkspaceFile({ runId: run.meta.id, path: effectivePath })
      .then((outcome) => {
        const next = settleSide(guard, token, outcome);
        if (next !== null) setInitialState(next);
      })
      .catch((error: unknown) => {
        const next = settleSide(guard, token, {
          ok: false,
          code: "READ_UNEXPECTED",
          message: error instanceof Error ? error.message : String(error),
        });
        if (next !== null) setInitialState(next);
      });
  }, [readWorkspaceFile, run.meta.id, effectivePath, initialKey, initialRetry]);

  // 结果层取值：**只有真的成功**才给；failed/loading/idle 一律 null（不是 not_found）
  const current = sideResult(selectedState);
  const initialResult = sideResult(initialState);

  /**
   * U2 任务 3.4：筛选偏好 `auto` 在**连接层**解析（初始检查点看全部、完成步骤看有变化），
   * 展示层只吃解析后的 `all | changed`（不把 auto 下传）。
   */
  const changeFilter = resolveChangeFilter(saved.filter, effectiveStepSpanId === null);

  return (
    <WorkspaceFileViewBody
      run={run}
      options={options}
      selection={{ stepSpanId: effectiveStepSpanId }}
      onSelect={(stepSpanId) => {
        setFileReading(run.meta.id, { checkpoint: stepSpanId, pane: "list" });
      }}
      inspect={inspect}
      inspectError={inspectError}
      loadingList={loadingList}
      selectedPath={effectivePath}
      onSelectPath={(path) => {
        setFileReading(run.meta.id, { path, pane: "content" });
      }}
      current={current}
      currentKey={currentKey}
      currentLabel={checkpointLabel(options, effectiveStepSpanId)}
      loadingContent={selectedState.kind === "loading"}
      contentError={contentFailure(selectedState)}
      initial={initialResult}
      initialKey={initialKey}
      loadingInitial={initialState.kind === "loading"}
      initialFailed={initialState.kind === "failed"}
      selectedFailed={selectedState.kind === "failed"}
      pane={saved.pane}
      onPane={(pane) => setFileReading(run.meta.id, { pane })}
      query={saved.query}
      onQuery={(query) => setFileReading(run.meta.id, { query })}
      changeFilter={changeFilter}
      onFilter={(filter) => setFileReading(run.meta.id, { filter })}
      filterPreference={saved.filter}
      dirWidth={saved.directoryWidth}
      onDirWidth={(width) => setFileReading(run.meta.id, { directoryWidth: width })}
      dirCollapsed={saved.directoryCollapsed}
      onDirCollapsed={(collapsed) => setFileReading(run.meta.id, { directoryCollapsed: collapsed })}
      diffPreference={saved.diffPreference}
      onDiffPreference={(diffPreference) => setFileReading(run.meta.id, { diffPreference })}
      wordWrap={saved.wordWrap}
      onWordWrap={(wordWrap) => setFileReading(run.meta.id, { wordWrap })}
      listScrollTop={saved.listScrollTop}
      onListScrollTop={(listScrollTop) => setFileReading(run.meta.id, { listScrollTop })}
      fetchInitial={readSide}
      onRetryList={() => setListRetry((n) => n + 1)}
      onRetryContent={() => setSelectedRetry((n) => n + 1)}
      onRetryInitial={() => setInitialRetry((n) => n + 1)}
      checkpointInvalidated={checkpointInvalidated}
      pathInvalidated={pathInvalidated}
    />
  );
}

/** 所选侧的通道失败（展示层原字段名保留，减少改动面）。 */
function contentFailure(state: SideReadState): { code: string; message: string } | null {
  return state.kind === "failed" ? { code: state.code, message: state.message } : null;
}

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
  fetchInitial,
  onRetryList,
  onRetryContent,
  onRetryInitial,
  checkpointInvalidated = false,
  pathInvalidated = false,
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-500">文件检查点</span>
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
          {inspect !== null ? (
            <span className="ml-auto font-code text-[10px] text-gray-400">
              {inspectSummaryLine(inspect)}
            </span>
          ) : null}
          {/*
            U2 5.2 实机缺口修复（2026-09-23）：spec「手动布局偏好不被自动折叠覆盖」的 WHEN
            含「用户……收起目录」，但「收起/展开目录」按钮原先只在目录非常驻时渲染
            （pane 切换条内）⇒ 目录常驻（宽档）时用户**没有任何显式收起入口**，偏好
            `dirUserCollapsed` 无法置真。补：目录常驻时在页头提供收起按钮；
            非常驻时仍由 pane 切换条的「展开/收起目录」承载（显示相反动作）。
          */}
          {dirResident && onDirCollapsed !== undefined ? (
            <button
              type="button"
              onClick={() => onDirCollapsed(true)}
              title="收起文件目录（可随时重新展开）"
              className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              收起目录
            </button>
          ) : null}
        </div>

        {originNote !== null ? (
          <div className="mt-1 text-[11px] leading-4 text-violet-800">{originNote}</div>
        ) : null}
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
        <div className="mt-1 text-[10px] leading-4 text-gray-400">
          只读视图：仅按 trace
          引用读取附件，不写文件、不补快照、不调用模型；没有任何回写源目录的入口。
        </div>

        {inspect !== null ? (
          <div className="mt-1 font-code text-[10px] text-gray-400">
            快照 {inspect.snapshotId.slice(0, 12)}… · profile {inspect.profile}
          </div>
        ) : null}
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
              className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-500"
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
          onScroll={
            onListScrollTop === undefined
              ? undefined
              : (e) => onListScrollTop(e.currentTarget.scrollTop)
          }
          data-list-scroll-top={listScrollTop}
        >
          {/* U2 任务 3.4：搜索框 + 变化筛选 */}
          <div className="sticky top-0 z-10 border-b border-gray-100 bg-white px-2 py-1.5">
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
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 选择项文案（当前检查点的可读名，用于 diff 右侧标题） */
function checkpointLabel(options: readonly CheckpointOption[], stepSpanId: string | null): string {
  const found = options.find((option) => option.stepSpanId === stepSpanId);
  return found?.label ?? "本 run 当前检查点";
}

/** 复制反馈的短暂状态（就近提示，不假报成功） */
type CopyFeedback = { readonly kind: "ok" | "fail"; readonly message: string } | null;

/**
 * 单个文件的内容区。
 *
 * U2 任务 3.2 起两侧数据都由连接层独立提供，本组件只排版；任务 4.2 起按**容器宽**决定
 * inline/并排（消去固定 `lg` 与 420px），任务 4.4/4.5 起提供复制/查找/换行/差异导航。
 */
function FileContent({
  path,
  file,
  current,
  currentLabel,
  loading,
  error,
  initial,
  initialKey,
  loadingInitial,
  initialFailed,
  selectedFailed,
  onRetryContent,
  onRetryInitial,
  contentAreaWidth,
  diffPreference,
  onDiffPreference,
  wordWrap,
  onWordWrap,
}: {
  path: string;
  file: {
    bytes: number;
    sha256: string;
    availability: string;
    unavailableReason: string | null;
  } | null;
  current: WorkspaceReadFileResult | null;
  currentLabel: string;
  loading: boolean;
  error: { code: string; message: string } | null;
  initial: WorkspaceReadFileResult | null;
  initialKey: string | null;
  loadingInitial: boolean;
  initialFailed: boolean;
  selectedFailed: boolean;
  fetchInitial: (
    stepSpanId: string | null,
    path: string,
  ) => Promise<WorkspaceReadFileResult | null>;
  onRetryContent?: () => void;
  onRetryInitial?: () => void;
  contentAreaWidth: number;
  diffPreference: "auto" | "inline" | "sideBySide";
  onDiffPreference?: (pref: "auto" | "inline" | "sideBySide") => void;
  wordWrap: boolean;
  onWordWrap?: (on: boolean) => void;
}) {
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);

  /**
   * U2 任务 4.5：**真实差异导航**。
   *
   * `diffEditorRef` 接住 `@monaco-editor/react` 经 `onMount` 外抛的 `IStandaloneDiffEditor`
   * 实例——没有它，差异导航在结构上无法发命令（4.5 被误勾的根因）。`diffCount` 由
   * `onDidUpdateDiff` 在 diff **真正算完**后从 `getLineChanges()` 取真实条数，绝不凭空写死。
   *
   * ⚠️ 静态渲染（`renderToStaticMarkup`）不跑 effect、也不挂载 monaco ⇒ 这里恒为
   *    `null` / `0`，判据必须能优雅退化（按钮禁用 + 诚实说明），不能崩。
   */
  const diffEditorRef = useRef<IStandaloneDiffEditor | null>(null);
  const [diffCount, setDiffCount] = useState(0);

  const refreshDiffCount = useCallback((editor: IStandaloneDiffEditor | null): void => {
    if (editor === null) {
      setDiffCount(0);
      return;
    }
    const changes = editor.getLineChanges();
    setDiffCount(changes === null ? 0 : changes.length);
  }, []);

  const onDiffMount = useCallback(
    (editor: IStandaloneDiffEditor): void => {
      diffEditorRef.current = editor;
      refreshDiffCount(editor);
      // diff 是异步算的：首次 mount 时可能还没算完，靠这个事件拿到真实条数
      editor.onDidUpdateDiff(() => refreshDiffCount(editor));
    },
    [refreshDiffCount],
  );

  /** 上一/下一差异：驱动真实 Monaco 命令（不是装饰性按钮）。 */
  const goPrevDiff = useCallback((): void => {
    diffEditorRef.current?.goToDiff("previous");
  }, []);
  const goNextDiff = useCallback((): void => {
    diffEditorRef.current?.goToDiff("next");
  }, []);
  /** 查找：走 Monaco 内置查找控件（只读，不开放替换/写入）。 */
  const openFind = useCallback((): void => {
    const editor = diffEditorRef.current?.getModifiedEditor() ?? null;
    editor?.trigger("u2-toolbar", "actions.find", null);
  }, []);

  // 所选侧：加载中（且尚无结果）⇒ 该侧是"读取中"，**不是**不存在
  if (loading && current === null) {
    return (
      <div className="px-4 py-6 text-[11px] text-gray-400">
        读取文件内容…
        {loadingInitial ? <span className="ml-2 text-gray-300">（初始快照同步读取中）</span> : null}
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="m-4 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
        读取失败（{error.code}）：{error.message}
        <div className="mt-0.5 text-red-600">
          这是只读通道的失败，并不表示该文件不存在；定位意图已保留，可重试。
        </div>
        {onRetryContent === undefined ? null : (
          <button
            type="button"
            onClick={onRetryContent}
            className="mt-1 rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
          >
            重新读取该文件
          </button>
        )}
      </div>
    );
  }
  if (current === null) {
    return (
      <div className="px-4 py-6 text-[11px] text-gray-400">
        {loadingInitial ? "正在读取初始快照…" : "尚未读取该文件。"}
      </div>
    );
  }
  if (current.status === "rejected") {
    return (
      <div className="m-4 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
        请求被拒绝（{current.code}）：{current.reason}
      </div>
    );
  }
  if (current.status === "not_found") {
    return (
      <div className="m-4 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
        该路径不在所选清单里：{current.reason}
      </div>
    );
  }

  const comparability = canCompareText(current);
  const sides = resolveDiffSides(initial, current, {
    initial: "本 run 初始状态",
    selected: currentLabel,
  });

  const rightReady = sideReadiness(current, { loading, failed: selectedFailed });
  const leftReady = sideReadiness(initial, { loading: loadingInitial, failed: initialFailed });
  const rights = copyableText(current);
  const lefts = copyableText(initial);
  const diffEligibility = canEnterTextDiff(sides);
  const modeDecision = decideDiffMode({
    prefs: preserveFilePrefs({ ...initialFileLayoutPrefs, diffPreference, wordWrap }),
    contentAreaWidth,
  });
  const mode: DiffMode = modeDecision.mode;

  const doCopy = async (text: string | null, label: string): Promise<void> => {
    if (text === null) return;
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setCopyFeedback({ kind: "fail", message: `${label}：当前环境不支持剪贴板` });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback({ kind: "ok", message: `${label}已复制` });
    } catch (e: unknown) {
      setCopyFeedback({
        kind: "fail",
        message: `${label}：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const tools = resolveToolEnablement({
    hasPath: path.length > 0,
    left: leftReady as SideReadiness,
    right: rightReady as SideReadiness,
    diffEligible: diffEligibility.ok,
    mode,
    // U2 任务 4.5：**真实**差异条数（由 onDidUpdateDiff 从 Monaco 取），不再写死
    diffCount,
  });

  const meta = copyableMeta(current);

  const header = (
    <div className="border-b border-gray-200 px-4 py-2">
      <div className="break-all font-code text-[11px] text-gray-800">{path}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[10px] text-gray-500">
        <span>{formatBytes(current.bytes)}</span>
        <span className="font-code">sha256 {current.sha256.slice(0, 12)}…</span>
        {file === null ? null : (
          <span
            className={
              file.availability === "ok" ? "text-gray-400" : "rounded bg-red-100 px-1 text-red-700"
            }
          >
            {availabilityLabel(file.availability as "ok" | "missing" | "corrupt")}
          </span>
        )}
      </div>
    </div>
  );

  /**
   * U2 任务 4.4/4.5/4.6：**只读工具栏**——复制路径/两侧原文/元信息、查找、换行、
   * 上一/下一差异、inline/并排模式。所有按钮按 `tools` 的诚实判据启用/禁用，
   * 禁用时用 `title` 说明原因。**没有**任何编辑/替换/回写入口。
   */
  const toolbar = (
    <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 px-4 py-1 text-[10px]">
      <button
        type="button"
        disabled={!tools.copyPath}
        onClick={() => void doCopy(path, "路径")}
        title="复制完整逻辑路径"
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        复制路径
      </button>
      <button
        type="button"
        disabled={!tools.copyLeftText}
        onClick={() => void doCopy(lefts, "初始侧原文")}
        title={tools.copyLeftText ? "复制初始快照侧完整原文" : "初始侧没有可复制的文本"}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        复制左侧原文
      </button>
      <button
        type="button"
        disabled={!tools.copyRightText}
        onClick={() => void doCopy(rights, "所选侧原文")}
        title={tools.copyRightText ? "复制所选检查点侧完整原文" : "所选侧没有可复制的文本"}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        复制右侧原文
      </button>
      {meta === null ? null : (
        <button
          type="button"
          onClick={() => void doCopy(`${meta.bytes} B\n${meta.sha256}`, "元信息")}
          title="复制真实大小与完整哈希"
          className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600"
        >
          复制元信息
        </button>
      )}
      <button
        type="button"
        disabled={!tools.wordWrap}
        onClick={() => onWordWrap?.(!wordWrap)}
        title={tools.wordWrap ? "切换自动换行" : "内容不可比较时不可换行"}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        换行：{wordWrap ? "开" : "关"}
      </button>
      <button
        type="button"
        disabled={!tools.find}
        onClick={openFind}
        title={tools.find ? "在当前文件查找（只读，不开放替换）" : "内容不可比较时不可查找"}
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        查找
      </button>
      <button
        type="button"
        disabled={!tools.prevDiff}
        onClick={goPrevDiff}
        title={
          tools.prevDiff
            ? "跳到上一处差异"
            : diffCount === 0
              ? "当前两版没有差异可导航"
              : "并排且两侧都有文本时才可导航差异"
        }
        aria-label="上一处差异"
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        上一差异
      </button>
      <button
        type="button"
        disabled={!tools.nextDiff}
        onClick={goNextDiff}
        title={
          tools.nextDiff
            ? "跳到下一处差异"
            : diffCount === 0
              ? "当前两版没有差异可导航"
              : "并排且两侧都有文本时才可导航差异"
        }
        aria-label="下一处差异"
        className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 disabled:opacity-40"
      >
        下一差异
      </button>
      {tools.modeToggle && onDiffPreference !== undefined ? (
        <button
          type="button"
          onClick={() => onDiffPreference(diffPreference === "inline" ? "sideBySide" : "inline")}
          title="切换 inline / 并排"
          className="ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-gray-600"
        >
          模式：
          {diffPreference === "auto" ? "自动" : diffPreference === "inline" ? "inline" : "并排"}
        </button>
      ) : null}
      {copyFeedback === null ? null : (
        <span
          className={`ml-1 ${copyFeedback.kind === "ok" ? "text-emerald-600" : "text-red-600"}`}
        >
          {copyFeedback.message}
        </span>
      )}
    </div>
  );

  // 不可比较：只呈现状态，明确不渲染伪空文件
  if (!comparability.ok) {
    return (
      <>
        {header}
        {toolbar}
        <div className="m-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-5 text-gray-700">
          <div className="font-semibold text-gray-800">
            {current.status === "binary" ? "二进制文件" : "内容不可读"}
          </div>
          <div className="mt-0.5">{comparability.reason}</div>
          {current.status === "binary" ? (
            <div className="mt-1 font-code text-[10px] text-gray-500">
              原始大小 {formatBytes(current.bytes)} · sha256 {current.sha256}
            </div>
          ) : null}
          {current.status === "missing" || current.status === "corrupt" ? (
            <div className="mt-1 text-gray-500">
              清单记录大小 {formatBytes(current.bytes)} · sha256 {current.sha256}
            </div>
          ) : null}
        </div>
      </>
    );
  }

  /**
   * ⚠️ 这里不再有"两侧都没有可显示内容 ⇒ 不渲染编辑器"的粗暴判据（C 时代的它把
   * "初始侧没读出来"和"初始侧确实不存在"混为一谈）。改为先问 `canEnterTextDiff`，
   * 不够格时按**具体原因**分流，绝不置空 diff。
   */
  const leftMissing = sides.left === null;
  const rightMissing = sides.right === null;
  const initialNotRead = initial === null && (loadingInitial || initialFailed);

  if (!diffEligibility.ok) {
    const noteText = (
      note: DiffSides["leftNote"],
      failed: boolean,
      loadingWhile: boolean,
    ): string => {
      switch (note) {
        case "not_found":
          return "清单确认不存在";
        case "unavailable":
          return "内容不可比较（二进制 / 附件缺失 / 损坏）";
        case "unread":
          return failed ? "读取失败（不是不存在）" : loadingWhile ? "正在读取" : "尚未读取";
        case "text":
          return "有文本";
      }
    };
    return (
      <>
        {header}
        {toolbar}
        <div className="m-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-5 text-gray-700">
          <div className="font-semibold text-gray-800">不进入文本差异</div>
          <div className="mt-0.5">{diffEligibility.reason}</div>
          <div className="mt-1 text-gray-600">
            初始快照侧：{noteText(sides.leftNote, initialFailed, loadingInitial)}；所选检查点侧：
            {noteText(sides.rightNote, selectedFailed, loading)}。
          </div>
          <div className="mt-1 text-gray-500">
            绝不会用空编辑器冒充"文件是空的"，也不会把不可用或未读取的一侧置空参与 diff。
          </div>
          {onRetryInitial === undefined && onRetryContent === undefined ? null : (
            <div className="mt-1 flex gap-2">
              {sides.leftNote === "unread" && onRetryInitial !== undefined ? (
                <button
                  type="button"
                  onClick={onRetryInitial}
                  className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                >
                  重新读取初始快照
                </button>
              ) : null}
              {sides.rightNote === "unread" && onRetryContent !== undefined ? (
                <button
                  type="button"
                  onClick={onRetryContent}
                  className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                >
                  重新读取所选侧
                </button>
              ) : null}
            </div>
          )}
        </div>
      </>
    );
  }

  /**
   * 一侧的状态说明。走这里时已由 `canEnterTextDiff` 保证两侧**只有** `text` 或 `not_found`。
   */
  const sideNote = (note: DiffSides["leftNote"]): string =>
    note === "not_found" ? "（该侧不存在）" : "";

  return (
    <>
      {header}
      {toolbar}
      <div className="px-4 py-1.5 text-[10px] text-gray-400">
        左：本 run 初始状态
        {sideNote(sides.leftNote)} · 右：{sides.rightLabel}
        {sideNote(sides.rightNote)}
        {diffCount > 0 ? <span className="ml-2 text-gray-500">共 {diffCount} 处差异</span> : null}
        {modeDecision.downgraded && modeDecision.reason !== null ? (
          <span className="ml-2 text-amber-700">{modeDecision.reason}</span>
        ) : null}
      </div>
      <div className="mx-4 mb-4 overflow-hidden rounded border border-gray-200">
        <MonacoDiffEditor
          data-testid="diff-editor"
          height="min(60vh, 640px)"
          language={detectFileLanguage(sides.right ?? sides.left)}
          original={leftMissing ? "" : (sides.left ?? "")}
          modified={rightMissing ? "" : (sides.right ?? "")}
          onMount={onDiffMount}
          options={{
            readOnly: true,
            renderSideBySide: mode === "sideBySide",
            // ⚠️ U2 5.1 实机缺陷修复（2026-09-23）：
            //   Monaco 默认 `useInlineViewWhenSpaceIsLimited: true` +
            //   `renderSideBySideInlineBreakpoint: 900`：只要**编辑器元素宽 ≤900px**，
            //   Monaco 就无视本层传入的 `renderSideBySide: true` 强行改渲染 inline。
            //   实测复现（CSS 视口 1210，容器 1210）：目录 248 时 monoW=909 正常并排
            //   （447/448，sash=1）；目录 264 时 monoW=893 突变为 36/827、sash 消失 ——
            //   左侧栏被压成 36px 不可读细条。而本层判据 `decideDiffMode` 按
            //   `(contentArea-56)/2 >= 320` 仍判并排（perSide 439），**两层结论冲突**。
            //   spec/design D4 明写并排条件由本层按两侧实际文字区决定，故关闭 Monaco
            //   自己的空间启发式，让 `renderSideBySide` 成为唯一权威。
            useInlineViewWhenSpaceIsLimited: false,
            fontSize: 13,
            minimap: { enabled: false },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: wordWrap ? "on" : "off",
            scrollbar: { vertical: "auto", horizontal: "auto" },
            folding: true,
            showFoldingControls: "always",
            originalEditable: false,
          }}
        />
      </div>
      {leftMissing ? (
        <div className="mx-4 mb-4 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
          初始快照里没有这条路径（本 run 新增的文件）；左侧标作不存在，未用空文本冒充。
        </div>
      ) : null}
      {rightMissing ? (
        <div className="mx-4 mb-4 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
          所选检查点没有这条路径；右侧标作不存在（可能是初始有、后轮被移出世界）。
        </div>
      ) : null}
    </>
  );
}
