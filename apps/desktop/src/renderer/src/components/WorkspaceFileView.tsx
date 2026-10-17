import type { RunDetail, WorkspaceInspectResult, WorkspaceReadFileResult } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveChangeFilter } from "../lib/file-directory";
import {
  type ListReadState,
  RequestGuard,
  type SideReadState,
  settleList,
  settleSide,
  sideResult,
} from "../lib/reading-request-guard";
import { workspaceExportKey } from "../lib/workspace-export-state";
import {
  defaultCheckpointStepId,
  deriveCheckpointOptions,
  resolveCheckpoint,
  validateSavedPath,
} from "../lib/workspace-files";
import { useAppStore } from "../store";
import {
  WorkspaceFileViewBody,
  WorkspaceFileViewBodyProps,
} from "./workspace-file/WorkspaceFileViewBody";
import { type Selected, type Selection, checkpointLabel } from "./workspace-file/types";

// 兼容导出：原入口导出指向同一实现（design D1，S01）。新消费方应直接用 workspace-file/* 模块。
export { WorkspaceFileViewBody } from "./workspace-file/WorkspaceFileViewBody";
export type { WorkspaceFileViewBodyProps } from "./workspace-file/WorkspaceFileViewBody";

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
   * R2.1 任务 6.1：**导出选定检查点**的接线。
   *
   * 资格判据只取「清单已核实 + 全部附件可用」——与 Monaco 挂载、选中文件、diff、
   * 二进制完全解耦（初始/空快照/无变化/纯二进制都可导出）；已知附件失败 ⇒ 禁用并
   * 说明（main 提交时仍会复验全部附件，这里的资格只是入口引导，不是安全边界）。
   * 反馈按提交 run/step 绑定（5.3 会话状态）：切换检查点后旧反馈不再显示、确认卡收起。
   */
  const exportCheckpoint = useAppStore((s) => s.exportCheckpoint);
  const exportFeedback =
    useAppStore((s) => s.workspaceExports[workspaceExportKey(run.meta.id, effectiveStepSpanId)]) ??
    null;
  const [exportExpanded, setExportExpanded] = useState(false);
  const exportEligible = inspect !== null && inspect.unavailableCount === 0;
  const exportIneligibleReason =
    inspect === null
      ? "检查点清单尚未读取，暂不可导出"
      : inspect.unavailableCount > 0
        ? `有 ${inspect.unavailableCount} 个附件缺失或损坏；导出要求全部附件可验证`
        : null;

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
        // 确认对象绑定检查点：切换检查点即收起确认卡（用户重看新目标的确认说明再提交）
        setExportExpanded(false);
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
      exportPanel={{
        eligible: exportEligible,
        ineligibleReason: exportIneligibleReason,
        feedback: exportFeedback,
        expanded: exportExpanded,
        onToggleExpanded: () => setExportExpanded((v) => !v),
        onConfirm: () => {
          // 提交后反馈由 store 会话状态承载（绑定本次 run/step）；返回值不在此消费
          void exportCheckpoint(
            effectiveStepSpanId === null
              ? { runId: run.meta.id }
              : { runId: run.meta.id, stepSpanId: effectiveStepSpanId },
          );
        },
      }}
    />
  );
}

/** 所选侧的通道失败（展示层原字段名保留，减少改动面）。 */
function contentFailure(state: SideReadState): { code: string; message: string } | null {
  return state.kind === "failed" ? { code: state.code, message: state.message } : null;
}
