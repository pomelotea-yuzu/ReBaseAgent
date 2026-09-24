import type { RunDetail } from "@shared/ipc";
import type { WorkspaceInspectResult, WorkspaceReadFileResult } from "@shared/ipc";
import type { editor as MonacoEditorNs } from "monaco-editor/editor/editor.api";
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
  type ContentScrollAnchor,
  anchorMatches,
  buildContentAnchor,
  clampAnchorLine,
  resolveAnchorScrollTop,
  sameAnchor,
} from "../lib/file-scroll";
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
import { decideRestore, initialRestoreState } from "../lib/restore-gate";
import { resolveRestoreScrollTop, resolveScrollRestore } from "../lib/scroll-restore";
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
  resolveCheckpoint,
  resolveDiffSides,
  validateSavedPath,
} from "../lib/workspace-files";
import type { CheckpointOption, DiffSides } from "../lib/workspace-files";
import { useAppStore } from "../store";
import { MonacoCodeEditor, MonacoDiffEditor } from "./MonacoEditor";

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
  const fileReadingEntered = useAppStore((s) => s.fileReadingEntered(run.meta.id));
  const setFileReading = useAppStore((s) => s.setFileReading);

  const options = useMemo(() => deriveCheckpointOptions(run), [run]);
  /** 首次进入要用的默认检查点（最近自有完成步骤；无则 null = 初始） */
  const defaultStepSpanId = useMemo(() => defaultCheckpointStepId(run), [run]);

  /**
   * U2 任务 2.4：选择/pane/偏好**接入会话状态**，不再用组件局部 state。
   * C 时代这些是 `useState`，而 `WorkspaceFilesPanel` 以 `key={detail.meta.id}` 硬重挂载
   * ⇒ 每次「文件 → 步骤 → 文件」都回到初始状态（R7 复现的缺陷）。
   *
   * ⚠️ 恢复前必须**重新校验**：保存的 step / path 可能已不在当前详情里。
   */
  const saved = fileReading;

  /**
   * 有效检查点（U2 5.6 实机缺陷修复，判据见 `resolveCheckpoint` 的注释）：
   * - **从未进入文件页** ⇒ 默认（最近自有完成步骤；无自有完成步骤时即初始）；
   * - 已进入 + 保存的 step 仍有效 ⇒ 保持保存值（含用户**明确**选的初始）；
   * - 已进入 + 保存的 step 已失效（stale）⇒ 提示并回退默认。
   */
  const resolved = resolveCheckpoint(run, {
    entered: fileReadingEntered,
    checkpoint: saved.checkpoint,
  });
  const effectiveStepSpanId = resolved.stepSpanId;
  const checkpointInvalidated = resolved.invalidated;

  /**
   * 首次进入：把解析出的默认检查点**写进会话状态**。
   *
   * 为什么必须写：`patchFileReading` 以 `DEFAULT_FILE_READING_STATE`（`checkpoint: null`）起底，
   * 若不在首帧写下来，之后任何一次 patch（选文件 / 切 pane / 换行 / 筛选 / 滚动…）都会把状态
   * 变成"已进入 + checkpoint=null" ⇒ 界面**突然跳回初始**，与刚显示的默认步骤自相矛盾。
   *
   * ⚠️ 写入前**再查一次新鲜状态**：显式文件目标由父组件（`WorkspaceFilesPanel`）在同一提交里
   *    写入，不能因为拿到的是旧渲染快照就把它的 checkpoint 覆盖掉。
   */
  useEffect(() => {
    if (fileReadingEntered) return;
    if (useAppStore.getState().fileReadingEntered(run.meta.id)) return;
    setFileReading(run.meta.id, { checkpoint: defaultStepSpanId });
  }, [fileReadingEntered, defaultStepSpanId, run.meta.id, setFileReading]);

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

  /**
   * U2 5.3 实机缺口修复（2026-09-23）：**失效引用要真的清掉，不能每次挂载重算一遍**。
   *
   * 依据（原文）：
   *   - design D2：「保存的 step 不再属于该 run 时，**清理 step/path/对应滚动**并提示」；
   *     「path … 不存在则**提示、清空选择**、显示列表」。
   *   - spec：「前者提示并清理相关位置…；后者提示并**清空文件选择**、显示列表」，且
   *     「**仅清单确认 path 不存在时清空**，读取失败保留定位意图供重试」。
   *
   * 原实现只把失效值**在本帧算成 fallback**（`effectiveStepSpanId` / `effectivePath`），
   * 从不写回 ⇒ 失效 path 一直留在会话状态里：每次往返都重新提示（"清理"退化成了"永久告警"），
   * 与"清空"的字面要求也不符。故这里补上**一次性写回清理**。
   *
   * ⚠️ 清理后判据立刻变假 ⇒ 提示会跟着消失（等于"静默回退"）。因此把"发生过失效"**锁存**
   *    在本组件这一次挂载里（`invalidNotice`），保证"提示"与"清理"同时成立。下次往返时
   *    状态已是干净的、判据不再触发，提示自然不再反复出现——这正是"一次性清理"的语义。
   */
  const [invalidNotice, setInvalidNotice] = useState({ checkpoint: false, path: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在**失效判据成立**时执行一次清理；setFileReading 是稳定引用
  useEffect(() => {
    if (!checkpointInvalidated && !pathInvalidated) return;
    setFileReading(run.meta.id, {
      ...(checkpointInvalidated ? { checkpoint: effectiveStepSpanId, contentScroll: null } : {}),
      ...(pathInvalidated ? { path: null, contentScroll: null } : {}),
    });
    setInvalidNotice((prev) => ({
      checkpoint: prev.checkpoint || checkpointInvalidated,
      path: prev.path || pathInvalidated,
    }));
  }, [checkpointInvalidated, pathInvalidated, effectiveStepSpanId, run.meta.id]);

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
      contentAnchor={saved.contentScroll}
      onContentAnchor={(contentScroll) => setFileReading(run.meta.id, { contentScroll })}
      fetchInitial={readSide}
      onRetryList={() => setListRetry((n) => n + 1)}
      onRetryContent={() => setSelectedRetry((n) => n + 1)}
      onRetryInitial={() => setInitialRetry((n) => n + 1)}
      checkpointInvalidated={checkpointInvalidated || invalidNotice.checkpoint}
      pathInvalidated={pathInvalidated || invalidNotice.path}
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
          ref={listScrollRef}
          onScroll={onListScrollTop === undefined ? undefined : onListScroll}
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
  stepSpanId,
  contentAnchor = null,
  onContentAnchor,
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
  /** U2 任务 4.3：本位置属于哪个检查点（锚点匹配用；null = 初始状态） */
  stepSpanId: string | null;
  contentAnchor?: ContentScrollAnchor | null;
  onContentAnchor?: (anchor: ContentScrollAnchor) => void;
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
  /**
   * U2 任务 5.4：**单侧只读视图**的编辑器实例。
   *
   * `diffEditorRef` 在单侧视图下恒为 null（那条路径不渲染 diff）⇒ 若查找只认 diff 编辑器，
   * 单侧可读时"查找"会点在空气上（按钮可用但无反应，正是本段禁止的"看着像能用"）。
   */
  const singleEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const [diffCount, setDiffCount] = useState(0);
  /** 最近一次上报/恢复的锚点：用于滚动事件去重（位置没变就不写 store） */
  const lastAnchorRef = useRef<ContentScrollAnchor | null>(null);

  /**
   * U2 任务 4.3：把当前可见位置上报为锚点（首个可见行 + 相对该行的偏移）。
   *
   * 两条拒绝条件，都是"宁可不记，也不能记错"：
   * - `onContentAnchor` 未接线 ⇒ 不报（静态渲染/能力缺失）；
   * - 编辑器尚未布局（`scrollHeight` 为 0）⇒ 此刻 `scrollTop` 恒为 0，记下去等于把位置抹掉。
   */
  const reportAnchor = useCallback(
    (editor: MonacoEditorNs.IStandaloneCodeEditor): void => {
      if (onContentAnchor === undefined) return;
      if (editor.getScrollHeight() <= 0) return;
      const ranges = editor.getVisibleRanges();
      const first = ranges[0] ?? null;
      const topLine = first === null ? 1 : first.startLineNumber;
      const anchor = buildContentAnchor({
        stepSpanId,
        path,
        topLine,
        lineTop: editor.getTopForLineNumber(clampAnchorLine(topLine)),
        scrollTop: editor.getScrollTop(),
      });
      if (sameAnchor(anchor, lastAnchorRef.current)) return;
      lastAnchorRef.current = anchor;
      onContentAnchor(anchor);
    },
    [onContentAnchor, stepSpanId, path],
  );

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
      const modified = editor.getModifiedEditor();

      /**
       * U2 任务 4.3：**恢复正文滚动位置**。
       *
       * ⚠️ 这是 4.3 被误勾的缺口之二：连接层只保存了列表偏移，正文位置**根本没有字段**
       *    ⇒「滚动到长文本中部再往返」实测必然回到顶部。
       *
       * 只在锚点**属于当前 (检查点, 路径)** 时套用；按保存的首个可见行重算该行顶部像素
       * 再叠加偏移 —— 内容变长/变短/换行开关变化都不会指向错误位置（越界由统一裁剪处理）。
       */
      if (anchorMatches(contentAnchor, stepSpanId, path)) {
        const top = resolveAnchorScrollTop(contentAnchor, {
          lineTop: modified.getTopForLineNumber(clampAnchorLine(contentAnchor.line)),
          scrollHeight: modified.getScrollHeight(),
          clientHeight: modified.getLayoutInfo().height,
        });
        if (top !== null) {
          modified.setScrollTop(top);
          lastAnchorRef.current = contentAnchor;
        }
      }

      // 之后每次滚动把新位置写回会话状态（去重后写，避免每次滚动都改 store）
      modified.onDidScrollChange(() => reportAnchor(modified));
    },
    [refreshDiffCount, contentAnchor, stepSpanId, path, reportAnchor],
  );

  /** 上一/下一差异：驱动真实 Monaco 命令（不是装饰性按钮）。 */
  const goPrevDiff = useCallback((): void => {
    diffEditorRef.current?.goToDiff("previous");
  }, []);
  const goNextDiff = useCallback((): void => {
    diffEditorRef.current?.goToDiff("next");
  }, []);
  /** 查找：走 Monaco 内置查找控件（只读，不开放替换/写入）——当前**活动**编辑器优先。 */
  const openFind = useCallback((): void => {
    const editor = diffEditorRef.current?.getModifiedEditor() ?? singleEditorRef.current ?? null;
    editor?.trigger("u2-toolbar", "actions.find", null);
  }, []);

  /**
   * U2 任务 5.4：单侧只读视图挂载后**接住实例**（供"查找"用；无此接线按钮即空转）。
   *
   * ⚠️ 静态渲染不跑 effect / 不挂 monaco ⇒ 恒不触发，调用方判据须能退化。
   */
  const onSingleSideMount = useCallback((editor: MonacoEditorNs.IStandaloneCodeEditor): void => {
    singleEditorRef.current = editor;
  }, []);

  /**
   * U2 任务 5.4 实机缺陷修复（第二处）：**初始侧是否有可展示的原文**。
   *
   * 下面三个早返回（"所选侧加载中 / 失败 / 还没结果"）原本是**独占卡**：一旦命中就直接
   * return，**整张卡只有一句话**。若此时初始侧**已读到文本**，可读侧原文就此消失、复制/查找
   * 也被判禁 —— 违反 delta「可读侧完整展示并可复制查找」（实机 `sides` B 型即此形态）。
   *
   * 因此给三个早返回追加"另一侧也读不出东西"的条件：另一侧可读时**不**走独占卡，落入
   * 下方统一的两侧呈现（`!diffEligibility.ok` 分支：两侧状态行 + 单侧只读编辑器 + 重试）；
   * 所选侧的失败明细（`error.code`/`message`）在该分支内一并补出，错误码不丢。
   */
  const initialReadableText = initial !== null && initial.status === "text" ? initial.text : null;

  // 所选侧：加载中（且尚无结果）⇒ 该侧是"读取中"，**不是**不存在
  if (loading && current === null && initialReadableText === null) {
    return (
      <div className="px-4 py-6 text-[11px] text-gray-400">
        读取文件内容…
        {loadingInitial ? <span className="ml-2 text-gray-300">（初始快照同步读取中）</span> : null}
      </div>
    );
  }
  if (error !== null && initialReadableText === null) {
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
  if (current === null && initialReadableText === null) {
    return (
      <div className="px-4 py-6 text-[11px] text-gray-400">
        {loadingInitial ? "正在读取初始快照…" : "尚未读取该文件。"}
      </div>
    );
  }
  // ⚠️ 走到这里 `current` 可能为 null（另一侧可读时不再走上面的独占卡）⇒ 必须先判非空
  if (current !== null && current.status === "rejected") {
    return (
      <div className="m-4 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
        请求被拒绝（{current.code}）：{current.reason}
      </div>
    );
  }
  if (current !== null && current.status === "not_found") {
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
  /**
   * U2 任务 5.4 实机缺陷修复：**唯一可读的那一侧**。
   *
   * 两侧都 text 时它是"多余的"（此时走 diff）；只有进不了 diff 时它才决定"谁被完整展示"。
   * `null` 表示两侧都没有文本可展示（都不可读 / 都未读）——那种情况**不渲染任何编辑器**。
   */
  const readableSide: "left" | "right" | null =
    sides.leftNote === "text" ? "left" : sides.rightNote === "text" ? "right" : null;
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
    // U2 5.4：编辑器就绪 ≠ 能进 diff —— 单侧只读视图同样"就绪"（见 file-tools.ts 注释）
    editorReady: diffEligibility.ok || readableSide !== null,
    mode,
    // U2 任务 4.5：**真实**差异条数（由 onDidUpdateDiff 从 Monaco 取），不再写死
    diffCount,
  });

  const meta = copyableMeta(current);

  /**
   * 头部的大小/哈希来源：所选侧读出来了就用它，否则退回**清单里的记录**（`file`）。
   *
   * U2 5.4 实机修复后 `current` 可能为 null（另一侧可读 ⇒ 不再走独占卡），此处必须先兜底，
   * 否则头部的 `current.bytes` 会直接抛异常（新测试 `初始侧 text + 所选侧加载中` 已坐实）。
   */
  const headerMeta: { bytes: number; sha256: string } | null = current ?? file;

  const header = (
    <div className="border-b border-gray-200 px-4 py-2">
      <div className="break-all font-code text-[11px] text-gray-800">{path}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[10px] text-gray-500">
        {headerMeta === null ? null : (
          <>
            <span>{formatBytes(headerMeta.bytes)}</span>
            <span className="font-code">sha256 {headerMeta.sha256.slice(0, 12)}…</span>
          </>
        )}
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

  /**
   * 一侧的状态说明文案（两个"进不了 diff"分支共用；`failed`/`loadingWhile` 分侧传入）。
   */
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

  /**
   * U2 任务 5.4 实机缺陷修复：**单侧可读时的完整展示通道**（只读，绝非 diff）。
   *
   * spec delta「不可用侧不伪装为空差异」（原文）：两侧分别标出真实状态，**可读侧完整展示并可
   * 复制查找**，禁止把不可用侧置空进行 diff；**左右互换同样成立**。
   *
   * 5.4 实机坐实：两个早返回分支（所选侧不可比较 / 不能进 diff）都只渲染 header + toolbar +
   * 状态卡、**没有任何编辑器** ⇒ 可读侧原文既拿不到、查找/换行还被判禁（左右互换亦然）。
   * 这里补一条**只读单侧编辑器**压住该缺口：
   * - 锚点用**独立**的 `single-side-editor`（**不得**复用 `diff-editor`：那会让"绝不置空 diff"
   *   的既有断言失去意义）；
   * - 不可比较的那一侧仍只出状态卡，绝不置空参与 diff（不渲染任何 diff 编辑器）；
   * - `readOnly: true` + 无替换入口，与 diff 侧同一条只读红线。
   */
  const singleSideView =
    readableSide === null || diffEligibility.ok ? null : (
      <>
        <div className="px-4 py-1.5 text-[10px] text-gray-400">
          {readableSide === "left" ? `左：${sides.leftLabel}` : `右：${sides.rightLabel}`}
          （该侧原文完整展示；另一侧不可比较，未用空文本参与 diff）
        </div>
        {/* ⚠️ 锚点挂在**真实 DOM 包裹层**上，不挂在 <Editor> 上：`@monaco-editor/react` 只通过
            `wrapperProps` 透传 `data-*`，直接给 <Editor> 的 `data-testid` 在编辑器**已加载**
            时不落到 DOM（只在懒加载占位期间存在）⇒ 用它判"有没有单侧视图"会得到假结果。 */}
        <div
          data-testid="single-side-editor"
          className="mx-4 mb-4 overflow-hidden rounded border border-gray-200"
        >
          <MonacoCodeEditor
            height="min(60vh, 640px)"
            language={detectFileLanguage(readableSide === "left" ? sides.left : sides.right)}
            value={(readableSide === "left" ? sides.left : sides.right) ?? ""}
            onMount={onSingleSideMount}
            options={{
              readOnly: true,
              fontSize: 13,
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: wordWrap ? "on" : "off",
              scrollbar: { vertical: "auto", horizontal: "auto" },
              folding: true,
              showFoldingControls: "always",
            }}
          />
        </div>
      </>
    );

  // 不可比较：只呈现状态，明确不渲染伪空文件
  // ⚠️ `current !== null` 是**类型收窄 + 语义显式**：`canCompareText(null)` 恒为 ok，故此分支
  //    本来就不会被"所选侧无结果"命中；但 5.4 的门控让 `current` 之后可能为 null，TS 需要它。
  if (current !== null && !comparability.ok) {
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
          {/* U2 5.4：本分支原先**只标所选侧**（卡片标题/原因都是它），初始侧状态完全不可见 ⇒
              左右互换（初始侧可读、所选侧不可比较）时用户看不到"另一侧有文本"。补统一的
              两侧状态行，与「不进入文本差异」分支同源同文案。 */}
          <div className="mt-1 text-gray-600">
            初始快照侧：{noteText(sides.leftNote, initialFailed, loadingInitial)}；所选检查点侧：
            {noteText(sides.rightNote, selectedFailed, loading)}。
          </div>
          {sides.leftNote === "unread" && onRetryInitial !== undefined ? (
            <div className="mt-1">
              <button
                type="button"
                onClick={onRetryInitial}
                className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
              >
                重新读取初始快照
              </button>
            </div>
          ) : null}
        </div>
        {singleSideView}
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
          {/* U2 5.4：所选侧通道失败时不再走独占错误卡（其条件是"另一侧也读不出东西"），
              错误码/原因必须在这里补出，否则"读取失败"只剩一句状态、丢失可诊断信息。 */}
          {error === null ? null : (
            <div className="mt-1 text-red-700">
              读取失败（{error.code}）：{error.message}（这是只读通道的失败，并不表示该文件不存在）
            </div>
          )}
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
        {singleSideView}
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
