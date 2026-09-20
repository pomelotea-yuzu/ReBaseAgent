import { DiffEditor } from "@monaco-editor/react";
import type { RunDetail } from "@shared/ipc";
import type { WorkspaceInspectResult, WorkspaceReadFileResult } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes } from "../lib/format";
import {
  availabilityLabel,
  canCompareText,
  changeLabel,
  checkpointOriginNote,
  deriveCheckpointOptions,
  detectFileLanguage,
  inspectSummaryLine,
  resolveDiffSides,
} from "../lib/workspace-files";
import type { CheckpointOption } from "../lib/workspace-files";
import { useAppStore } from "../store";

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
type Loaded = { readonly key: string; readonly result: WorkspaceReadFileResult };

/** 检查点选择项：每次选择都要带上 stepSpanId（null = 初始） */
interface Selection {
  readonly stepSpanId: string | null;
}

/**
 * 请求的稳定键：用于"在飞结果回来后判断是不是当前选择"（避免慢响应覆盖新选择）。
 * 与 `isolated-fork.ts` 的 `verifying.value === value` 同法。
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
 */
export function WorkspaceFileView({ run }: { run: RunDetail }) {
  const inspectWorkspace = useAppStore((s) => s.inspectWorkspace);
  const readWorkspaceFile = useAppStore((s) => s.readWorkspaceFile);

  const options = useMemo(() => deriveCheckpointOptions(run), [run]);
  const [selection, setSelection] = useState<Selection>({ stepSpanId: null });
  const [inspect, setInspect] = useState<Selected | null>(null);
  const [inspectError, setInspectError] = useState<{ code: string; message: string } | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  /** 当前查看的文件内容（按请求键存，键不符 = 旧结果，不渲染） */
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [contentError, setContentError] = useState<{ code: string; message: string } | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  /** 窄窗口：列表 / 内容 二选一（宽窗口下两栏并排） */
  const [pane, setPane] = useState<"list" | "content">("list");

  /**
   * 切换 run ⇒ 复位（不同 run 的检查点编号体系不同，绝不能沿用旧选择）。
   *
   * `DetailPanel` 侧已用 `key={detail.meta.id}` 让本组件随 run 重挂载，所以这里的
   * 复位在多数组装下是冗余的；保留它是为了**组件自身不依赖调用方给 key**——
   * 少了这一层，复用者一旦忘了 key 就会出现"上一个 run 的文件选择串到下一个 run"。
   * biome 的 `useExhaustiveDependencies` 只看"effect 读了哪些绑定"，读不出这个意图
   * （它要的是"effect 里没有引用 `run.meta.id`"），故显式抑制并写明原因。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按 run 身份复位，语义上依赖 run.meta.id
  useEffect(() => {
    setSelection({ stepSpanId: null });
    setSelectedPath(null);
    setLoaded(null);
    setContentError(null);
    setInspectError(null);
    setPane("list");
  }, [run.meta.id]);

  // 拉清单：选择变化即重新拉（判据是"当前选择"，与渲染同源）
  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setInspectError(null);
    const request =
      selection.stepSpanId === null
        ? { runId: run.meta.id }
        : { runId: run.meta.id, stepSpanId: selection.stepSpanId };
    void inspectWorkspace(request)
      .then((outcome) => {
        if (cancelled) return;
        if (!outcome.ok) {
          setInspect(null);
          setInspectError({ code: outcome.code, message: outcome.message });
          return;
        }
        setInspect(outcome.data);
        // 选中路径在新清单里可能已不存在（切检查点后文件集变化）⇒ 清掉选择
        setSelectedPath((current) =>
          current !== null && outcome.data.files.some((f) => f.path === current) ? current : null,
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectWorkspace, run.meta.id, selection.stepSpanId]);

  // 读取"初始"与"当前"两侧内容（diff 需要两份；不做任何写入）
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

  const loadContent = useCallback(
    async (path: string, stepSpanId: string | null): Promise<void> => {
      const key = requestKey(run.meta.id, stepSpanId, path);
      setLoadingContent(true);
      setContentError(null);
      try {
        const outcome = await readWorkspaceFile(
          stepSpanId === null
            ? { runId: run.meta.id, path }
            : { runId: run.meta.id, stepSpanId, path },
        );
        if (!outcome.ok) {
          setContentError({ code: outcome.code, message: outcome.message });
          setLoaded(null);
          return;
        }
        setLoaded({ key, result: outcome.data });
      } finally {
        setLoadingContent(false);
      }
    },
    [readWorkspaceFile, run.meta.id],
  );

  const currentKey =
    selectedPath === null ? null : requestKey(run.meta.id, selection.stepSpanId, selectedPath);
  const current = loaded !== null && loaded.key === currentKey ? loaded.result : null;

  // 选中文件时拉内容；新增文件（初始侧不存在）也照常读——初始侧缺席由 diff 侧呈现
  useEffect(() => {
    if (selectedPath === null) {
      setLoaded(null);
      return;
    }
    void loadContent(selectedPath, selection.stepSpanId);
  }, [selectedPath, selection.stepSpanId, loadContent]);

  return (
    <WorkspaceFileViewBody
      run={run}
      options={options}
      selection={selection}
      onSelect={(stepSpanId) => {
        setSelection({ stepSpanId });
        setPane("list");
      }}
      inspect={inspect}
      inspectError={inspectError}
      loadingList={loadingList}
      selectedPath={selectedPath}
      onSelectPath={(path) => {
        setSelectedPath(path);
        setPane("content");
      }}
      current={current}
      currentKey={currentKey}
      currentLabel={checkpointLabel(options, selection.stepSpanId)}
      loadingContent={loadingContent}
      contentError={contentError}
      pane={pane}
      onPane={setPane}
      fetchInitial={readSide}
    />
  );
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
  readonly pane: "list" | "content";
  readonly onPane: (pane: "list" | "content") => void;
  readonly fetchInitial: (
    stepSpanId: string | null,
    path: string,
  ) => Promise<WorkspaceReadFileResult | null>;
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
  pane,
  onPane,
  fetchInitial,
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
 * 分三种呈现（判据全来自派生层，组件不做二次判断）：
 * - **可比较**（两侧都有文本，或一侧缺席但有另一侧）：进 DiffEditor 并排
 * - **不可比较**（二进制 / 缺失 / 损坏）：只展示状态与大小/哈希，**不进编辑器**
 * - **两侧皆缺席**：明确说"两侧都没有内容"，不渲染空编辑器
 */
function FileContent({
  path,
  file,
  current,
  currentLabel,
  loading,
  error,
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
  fetchInitial: (
    stepSpanId: string | null,
    path: string,
  ) => Promise<WorkspaceReadFileResult | null>;
}) {
  const [initial, setInitial] = useState<WorkspaceReadFileResult | null>(null);

  // 初始侧只在"当前不是初始快照"且当前已读出时拉一次（同一文件、同一 run）
  useEffect(() => {
    let cancelled = false;
    if (current === null || current.status === "rejected") return;
    void fetchInitial(null, path).then((result) => {
      if (!cancelled) setInitial(result);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchInitial, path, current]);

  if (loading && current === null) {
    return <div className="px-4 py-6 text-[11px] text-gray-400">读取文件内容…</div>;
  }
  if (error !== null) {
    return (
      <div className="m-4 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
        读取失败（{error.code}）：{error.message}
      </div>
    );
  }
  if (current === null) {
    return <div className="px-4 py-6 text-[11px] text-gray-400">尚未读取该文件。</div>;
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

  if (!sides.hasContent) {
    return (
      <>
        {header}
        <div className="m-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-600">
          初始与所选检查点在两侧都没有可显示的内容（不渲染空编辑器冒充"文件是空的"）。
        </div>
      </>
    );
  }

  const leftMissing = sides.left === null;
  const rightMissing = sides.right === null;

  return (
    <>
      {header}
      <div className="px-4 py-1.5 text-[10px] text-gray-400">
        左：本 run 初始状态{leftMissing ? "（该侧不存在）" : ""} · 右：{sides.rightLabel}
        {rightMissing ? "（该侧不存在）" : ""}
      </div>
      <div className="mx-4 mb-4 overflow-hidden rounded border border-gray-200">
        <DiffEditor
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
      {leftMissing || rightMissing ? (
        <div className="mx-4 mb-4 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">
          {leftMissing
            ? "初始快照里没有这条路径（本 run 新增的文件）；左侧标作不存在，未用空文本冒充。"
            : "所选检查点没有这条路径；右侧标作不存在（可能是初始有、后轮被移出世界）。"}
        </div>
      ) : null}
    </>
  );
}
