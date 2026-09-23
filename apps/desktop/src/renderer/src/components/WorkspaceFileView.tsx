import type { RunDetail } from "@shared/ipc";
import type { WorkspaceInspectResult, WorkspaceReadFileResult } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../lib/format";
import {
  type ListReadState,
  RequestGuard,
  type SideReadState,
  settleList,
  settleSide,
  sideResult,
} from "../lib/reading-request-guard";
import {
  availabilityLabel,
  canCompareText,
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
import type { CheckpointOption } from "../lib/workspace-files";
import { useAppStore } from "../store";
import { MonacoDiffEditor } from "./MonacoEditor";

/**
 * 隔离文件检查点视图（C 任务 2.1/2.2）。
 *
 * 与既有编辑器的关系：**只读**——没有任何"回写 / 应用到源目录"入口（本段明令禁止）。
 * 复用现有 Monaco 离线装配（`monaco-bootstrap.ts` 已在渲染入口配置），DiffEditor 走
 * `@monaco-editor/react` 的懒加载组件（`loader` 已指向本地实例，不联网）。
 *
 * 三条渲染纪律：
 * 1. **数字与清单全部来自 main 的只读 IPC**（`workspaces:inspect`）——组件不自己数文件、
 *    不自己算哈希、不自己推轮号（轮号由派生层取 `agent.step.n`）。
 * 2. **缺席的一侧显式标"不存在"**，绝不用空文本冒充；二进制 / 缺失 / 损坏一律不进编辑器。
 * 3. **窄窗口可切换**：列表与内容在窄屏下二选一显示，不互相遮挡，导航控件始终可见。
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
 * 单独拆出来的原因有二：
 * 1. **可测**——本包无 jsdom，`renderToStaticMarkup` 不跑 effect；把"拉数据"留在
 *    这层、把"排版"留在 `WorkspaceFileViewBody`，就能对展示层做结构断言。
 * 2. **判据与请求同源**——拉取判据（选中哪个检查点）与渲染判据在同一处产生，
 *    不在组件里另算一遍。
 *
 * U2 任务 3.1 的请求纪律（三条，缺一即回归 C 时代缺陷）：
 * - **清单与两侧各自持有 `RequestGuard` 与显式三态**（`ListReadState` / `SideReadState`）：
 *   加载 / 成功 / 失败分别维护，**不共用一个布尔**（否则一面请求的收尾会抹掉另一面的 loading）。
 * - **每个响应先过 `accept`**：旧代次的成功/失败/异常一律**丢弃**（一个字节都不写），
 *   这是"同对象重试 / A→B→A 往返"唯一能靠住的判据。
 * - **loading 由状态机持有**，不在 `finally` 里无条件清除——旧请求的收尾不得抹掉新请求的 loading。
 */
export function WorkspaceFileView({ run }: { run: RunDetail }) {
  const inspectWorkspace = useAppStore((s) => s.inspectWorkspace);
  const readWorkspaceFile = useAppStore((s) => s.readWorkspaceFile);
  const fileReading = useAppStore((s) => s.fileReadingOf(run.meta.id));
  const setFileReading = useAppStore((s) => s.setFileReading);

  const options = useMemo(() => deriveCheckpointOptions(run), [run]);

  /**
   * U2 任务 2.4：选择/pane/偏好**接入会话状态**，不再用组件局部 state。
   *
   * C 时代这些是 `useState`，而 `WorkspaceFilesPanel` 以 `key={detail.meta.id}` 硬重挂载
   * ⇒ 每次「文件 → 步骤 → 文件」都回到初始状态（R7 复现的缺陷）。改为读写 store 后，
   * 卸载重建不丢选择；run 隔离由 store 的按 runId 分键保证（不需要组件内复位）。
   *
   * ⚠️ 恢复前必须**重新校验**：保存的 step / path 可能已不在当前详情里（见 2.2 的
   *    `validateCheckpointStepId` / `validateSavedPath`），失效时按优先级回退并提示，
   *    绝不沿用失效引用。
   */
  const saved = fileReading;

  // 默认检查点：首次进入用最近自有完成步骤；保存的 step 失效则回退默认（delta「失效检查点安全回退」）
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
   * 守卫是**命令式**的（begin/accept 要跨渲染保持同一实例），且它自身不会触发渲染；
   * 状态变化由下面的 `useState` 承担。
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
        // 旧代次：不写任何状态（含不清 loading——新请求的 loading 由新请求自己管）
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
  }, [inspectWorkspace, run.meta.id, effectiveStepSpanId]);

  /**
   * U2 任务 3.2：**两侧独立读取**。初始侧与所选侧各走各的守卫与状态：
   * - 任一侧不可用（失败 / 二进制 / 缺失 / 损坏）**不阻止**另一侧展示（delta 明文）；
   * - 通道失败折成 `failed` 状态，**不**折成 `not_found`（"读取失败 SHALL NOT 等同引用消失"）。
   *
   * `readSide` 保留（展示层 `fetchInitial` 契约仍要），但它现在只在**调用方指定**时使用；
   * 视图层的两侧数据由下面两个 effect 独立维持。
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
  }, [readWorkspaceFile, run.meta.id, effectivePath, effectiveStepSpanId, currentKey]);

  /**
   * 初始侧：**独立**于所选侧读取（不再等"当前已读出"才拉）。
   *
   * ⚠️ 与所选侧分开的关键原因（delta「不可用侧不伪装为空差异」的根因）：C 时代初始侧
   *    以 `current` 成功为前置条件 ⇒ 所选侧一失败，初始侧就永远不读，界面只能显示
   *    "两侧都没内容"——把"未读"伪装成了"不存在"。现在两侧各自读、各自表达。
   */
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
  }, [readWorkspaceFile, run.meta.id, effectivePath, initialKey]);

  // 结果层取值：**只有真的成功**才给；failed/loading/idle 一律 null（不是 not_found）
  const current = sideResult(selectedState);
  const initialResult = sideResult(initialState);

  const hasComparisonError = contentFailure(selectedState) !== null;

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
      initialError={sideFailure(initialState)}
      initialFailed={initialState.kind === "failed"}
      selectedFailed={selectedState.kind === "failed"}
      hasComparisonError={hasComparisonError}
      pane={saved.pane}
      onPane={(pane) => setFileReading(run.meta.id, { pane })}
      fetchInitial={readSide}
      checkpointInvalidated={checkpointInvalidated}
      pathInvalidated={pathInvalidated}
    />
  );
}

/** 侧的**通道失败**（IPC 拒绝 / schema 不合法）折成展示层错误对象；其余为 null。 */
function sideFailure(state: SideReadState): { code: string; message: string } | null {
  return state.kind === "failed" ? { code: state.code, message: state.message } : null;
}

/** 所选侧的通道失败（展示层原字段名保留，减少改动面）。 */
function contentFailure(state: SideReadState): { code: string; message: string } | null {
  return state.kind === "failed" ? { code: state.code, message: state.message } : null;
}

/**
 * 展示层（纯函数组件）：只吃 props，不碰 store、不拉数据。
 *
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
  /**
   * U2 任务 3.2：**初始侧**由连接层独立维持（不再由 `FileContent` 内部自行拉取）。
   * 三件套对应"加载 / 成功 / 失败"三态；`initial` 为 null **不代表文件不存在**，
   * 只代表"还没拿到结果"（不存在由 `status === "not_found"` 表达）。
   */
  readonly initial?: WorkspaceReadFileResult | null;
  readonly initialKey?: string | null;
  readonly loadingInitial?: boolean;
  readonly initialError?: { code: string; message: string } | null;
  /** 初始侧通道失败（与"结果说附件缺失"不同层） */
  readonly initialFailed?: boolean;
  /** 所选侧通道失败 */
  readonly selectedFailed?: boolean;
  /** 至少一侧处于**通道失败**（用于禁用比较类工具，而不是假装无差异） */
  readonly hasComparisonError?: boolean;
  readonly pane: "list" | "content";
  readonly onPane: (pane: "list" | "content") => void;
  readonly fetchInitial: (
    stepSpanId: string | null,
    path: string,
  ) => Promise<WorkspaceReadFileResult | null>;
  /** U2：保存的检查点已失效（提示"原检查点不可用，已回退默认"） */
  readonly checkpointInvalidated?: boolean;
  /** U2：保存的路径在所选清单里已不存在（提示"原文件不存在，已清空选择"） */
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
  initialError = null,
  initialFailed = false,
  selectedFailed = false,
  hasComparisonError = false,
  pane,
  onPane,
  fetchInitial,
  checkpointInvalidated = false,
  pathInvalidated = false,
}: WorkspaceFileViewBodyProps) {
  const selectedFile = inspect?.files.find((f) => f.path === selectedPath) ?? null;

  const originNote = useMemo(() => {
    if (inspect === null) return null;
    // 分支 run 的父轮号：从合并轨迹里按 origin.stepSpanId 找那个 step 的 n
    // （与 `resumeBoundaryIteration` 同一判据：只用轨迹里真实存在的 step，不猜）
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
    <div className="flex h-full min-h-0 flex-col">
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
        </div>

        {originNote !== null ? (
          <div className="mt-1 text-[11px] leading-4 text-violet-800">{originNote}</div>
        ) : null}
        {/* U2：失效引用安全回退的**可见说明**（delta「失效检查点和路径安全回退」）——
            回退是静默的坏体验：用户会以为自己看的就是上次那处。 */}
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

      {/* 窄窗口切换（宽窗口下两个按钮仍在，但不影响并排布局） */}
      <div className="flex items-center gap-1 border-b border-gray-200 px-4 py-1 lg:hidden">
        <button
          type="button"
          onClick={() => onPane("list")}
          className={`rounded px-2 py-0.5 text-[11px] ${
            pane === "list" ? "bg-gray-800 text-white" : "border border-gray-300 text-gray-600"
          }`}
        >
          文件列表
        </button>
        <button
          type="button"
          onClick={() => onPane("content")}
          className={`rounded px-2 py-0.5 text-[11px] ${
            pane === "content" ? "bg-gray-800 text-white" : "border border-gray-300 text-gray-600"
          }`}
        >
          内容
        </button>
      </div>

      {inspectError !== null ? (
        <div className="mx-4 mt-2 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
          文件清单不可用（{inspectError.code}）：{inspectError.message}
          <div className="mt-0.5 text-red-600">
            原因来自 main 的只读读取；界面不会用"当前目录"或父 run 的历史快照兜底。
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* 文件表 */}
        <div
          className={`min-h-0 w-full overflow-y-auto border-r border-gray-200 lg:block lg:w-72 lg:shrink-0 ${
            pane === "list" ? "block" : "hidden"
          }`}
        >
          {loadingList && inspect === null ? (
            <div className="px-3 py-4 text-[11px] text-gray-400">读取文件清单…</div>
          ) : inspect === null ? (
            <div className="px-3 py-4 text-[11px] text-gray-400">选择上方任一检查点查看文件。</div>
          ) : inspect.files.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-gray-400">
              该检查点为空清单（世界内没有任何文件）。
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {inspect.files.map((file) => {
                const active = file.path === selectedPath;
                const usable = file.availability === "ok";
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => onSelectPath(file.path)}
                      className={`block w-full px-3 py-1.5 text-left ${
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
                        {/* 状态不只用颜色表达：不可用一律带文字标签 */}
                        {usable ? null : (
                          <span className="rounded bg-red-100 px-1 text-red-700">
                            {availabilityLabel(file.availability)}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 内容 / 差异 */}
        <div
          className={`min-h-0 min-w-0 flex-1 overflow-y-auto ${
            pane === "content" ? "block" : "hidden lg:block"
          }`}
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
              initialError={initialError}
              initialFailed={initialFailed}
              selectedFailed={selectedFailed}
              hasComparisonError={hasComparisonError}
              fetchInitial={fetchInitial}
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

/**
 * 单个文件的内容区。
 *
 * U2 任务 3.2 起，**两侧数据都由连接层独立提供**（`current` / `initial`），本组件只排版：
 *
 * - **两侧都有真实结果**（含新增文件的初始侧 `not_found`）⇒ 进 DiffEditor；
 *   缺席的一侧**显式标"不存在"**、同时仍如实标明它到底是"不存在"还是"加载中/读取失败"。
 * - **任一侧不可比较**（二进制 / 缺失 / 损坏）⇒ 只呈现该侧真实状态，**不进编辑器**。
 * - **任一侧通道失败** ⇒ 显示该侧错误，可用侧**照常展示**（不因另一侧失败而白屏）。
 * - **两侧都没有可读文本** ⇒ 明确说清两侧各自状态，不渲染空编辑器。
 *
 * ⚠️ 与 C 时代的关键差别：此前本组件内部自行拉初始侧，且以"当前侧已读出"为**前置条件**
 *    ⇒ 当前侧一失败，初始侧就永不读取，界面把"未读"显示成"两侧都没有"。现在两侧独立，
 *    且 `initial === null` 只表示"还没拿到结果"，**不表示文件不存在**。
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
  initialError,
  initialFailed,
  selectedFailed,
  hasComparisonError,
  fetchInitial,
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
  initialError: { code: string; message: string } | null;
  initialFailed: boolean;
  selectedFailed: boolean;
  hasComparisonError: boolean;
  fetchInitial: (
    stepSpanId: string | null,
    path: string,
  ) => Promise<WorkspaceReadFileResult | null>;
}) {
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

  // 不可比较：只呈现状态，明确不渲染伪空文件
  if (!comparability.ok) {
    return (
      <>
        {header}
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
   * U2 任务 3.2：**两侧分别标真实状态**。
   *
   * 这里不再有"两侧都没有可显示的内容 ⇒ 不渲染编辑器"的粗暴分支（C 时代的它把
   * "初始侧没读出来"和"初始侧确实不存在"混为一谈）。改为：
   * - 只有两侧**都解析不出任何文本**、且**两侧都没有可展示的真实结果**时才不动编辑器；
   * - 否则渲染，并对每一侧标注它是「不存在」「加载中」还是「读取失败」。
   */
  const leftMissing = sides.left === null;
  const rightMissing = sides.right === null;
  const initialNotRead = initial === null && (loadingInitial || initialFailed);
  const bothUnavailable = leftMissing && rightMissing && initialNotRead;

  if (bothUnavailable) {
    return (
      <>
        {header}
        <div className="m-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-5 text-gray-700">
          <div className="font-semibold text-gray-800">两侧都还没有可读文本</div>
          <div className="mt-0.5">
            初始快照侧：
            {initialFailed
              ? `读取失败（${initialError?.code ?? "未知"}）——不是"不存在"`
              : "正在读取"}
            ；所选检查点侧：{selectedFailed ? "读取失败（不是不存在）" : "无可读文本"}。
          </div>
          <div className="mt-1 text-gray-500">
            不会用空编辑器冒充"文件是空的"，也不会宣称无变化。
          </div>
        </div>
      </>
    );
  }

  /** 一侧的状态说明（区分：真不存在 / 加载中 / 读取失败 / 已有文本） */
  const sideNote = (
    side: WorkspaceReadFileResult | null,
    isInitial: boolean,
    notRead: boolean,
    failed: boolean,
  ): string => {
    if (side !== null && side.status === "text") return "";
    if (failed) return "（该侧读取失败，不是不存在）";
    if (notRead) return "（该侧正在读取）";
    if (side !== null && side.status === "not_found") return "（该侧不存在）";
    if (side === null) return "（该侧尚未读取）";
    return "（该侧不可用）";
  };

  return (
    <>
      {header}
      <div className="px-4 py-1.5 text-[10px] text-gray-400">
        左：本 run 初始状态
        {sideNote(initial, true, loadingInitial, initialFailed)} · 右：{sides.rightLabel}
        {sideNote(current, false, loading, selectedFailed)}
      </div>
      <div className="mx-4 mb-4 overflow-hidden rounded border border-gray-200">
        <MonacoDiffEditor
          data-testid="diff-editor"
          height="420px"
          language={detectFileLanguage(sides.right ?? sides.left)}
          original={leftMissing ? "" : (sides.left ?? "")}
          modified={rightMissing ? "" : (sides.right ?? "")}
          options={{
            readOnly: true,
            renderSideBySide: true,
            fontSize: 12,
            minimap: { enabled: false },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            scrollbar: { vertical: "auto", horizontal: "auto" },
            folding: true,
            showFoldingControls: "always",
            // 只读：本段不提供任何回写入口
            originalEditable: false,
          }}
        />
      </div>
      {hasComparisonError || initialFailed ? (
        <div className="mx-4 mb-4 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-800">
          一侧只读通道失败：显示的文本不完整，差异不可信（不把失败侧当空文本比较）。
        </div>
      ) : null}
      {leftMissing && !initialNotRead ? (
        <div className="mx-4 mb-4 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
          {initial !== null && initial.status === "not_found"
            ? "初始快照里没有这条路径（本 run 新增的文件）；左侧标作不存在，未用空文本冒充。"
            : "初始侧没有可显示文本；左侧标作不可用，未用空文本冒充。"}
        </div>
      ) : null}
      {rightMissing && !selectedFailed && !loading ? (
        <div className="mx-4 mb-4 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
          所选检查点没有这条路径；右侧标作不存在（可能是初始有、后轮被移出世界）。
        </div>
      ) : null}
    </>
  );
}
