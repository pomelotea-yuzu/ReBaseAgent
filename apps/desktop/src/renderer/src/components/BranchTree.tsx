import {
  buildRunForest,
  deriveAncestorIds,
  deriveChainTotals,
  forkEditLabel,
  indexRunsById,
  layoutRunTree,
} from "@shared/derive";
import type { RunSummary } from "@shared/ipc";
import { computeShortIds } from "@shared/nav";
import { ArrowRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveRelationEntries, experimentGroupsOf } from "../lib/branch-relations";
import { formatTime, formatTokens } from "../lib/format";
import {
  TREE_ZOOM_LEVELS,
  type TreeScope,
  type TreeSearchHit,
  type TreeViewport,
  fitZoomLevel,
  initialTreeViewport,
  searchTreeNodes,
  visibleRunIdsForScope,
} from "../lib/tree-view";
import { useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";
import { LongText, copyFeedbackText, copyPayload } from "./LongText";
import { RunStatusBadge } from "./RunStatusBadge";

/**
 * 分支树（U1 任务 6.2；U7 任务 3.1–3.4 重构）。
 *
 * 判据来源：branch-tree delta「分支树以节点-边图呈现运行与分叉」+「分支视口可定位
 * 当前运行并恢复阅读」——
 *   - 节点展示任务摘要/稳定唯一短 ID/记录模型/状态/创建时间/本 run 增量；边标注分叉摘要
 *   - **状态渲染统一到 `RunStatusBadge`**（与列表/概览同一份判据）
 *   - U7 D2：**逻辑布局与视口分离**——布局是确定性纯计算，坐标不因窗口/缩放重排；
 *     范围与搜索只决定**哪些节点可见**，不改变坐标；返回树恢复会话视口，显式定位才居中
 *   - U7 3.2：搜索匹配**完整原值**（复用 matchesSearch）；范围外命中可显式定位其树；
 *     空结果明确提示，不丢原选择
 *   - 缺失模型标「未记录」，不根据当前设置补造（3.4）
 *
 * ⚠️ 取值与渲染分离（`BranchTreeView`）：本包无 jsdom ⇒ 纯展示组件测试喂 props；
 *    滚动/居中的真实几何行为归 §6.4 实机验证（已登记的静态渲染盲区）。
 */

/** 孤立节点标注（父缺失 / 父链成环——提为根但如实说明，不假装它是真根） */
function OrphanBadge({ reason }: { reason: "missing-parent" | "cycle" }) {
  return (
    <span
      className="shrink-0 rounded bg-amber-100 px-1 text-[10px] leading-4 text-amber-800"
      title={
        reason === "missing-parent"
          ? "父 run 不在数据目录中（可能被删除或只拷来半个家谱），已提为根"
          : "parent 链成环，已断开并把该 run 提为根"
      }
    >
      {reason === "missing-parent" ? "父缺失" : "父链成环"}
    </span>
  );
}

/** store 薄壳：会话观察状态（范围/搜索/视口/模式）+ 首次进入决策 + 显式打开 */
export function BranchTree() {
  const runs = useAppStore((s) => s.runs);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const selectRun = useAppStore((s) => s.selectRun);
  const compareIds = useAppStore((s) => s.compareIds);
  const toggleCompare = useAppStore((s) => s.toggleCompare);
  const setView = useAppStore((s) => s.setView);
  const treeScope = useAppStore((s) => s.treeScope);
  const treeQuery = useAppStore((s) => s.treeQuery);
  const treeViewport = useAppStore((s) => s.treeViewport);
  const treeMode = useAppStore((s) => s.treeMode);
  const armTreeSession = useAppStore((s) => s.armTreeSession);
  const setTreeScope = useAppStore((s) => s.setTreeScope);
  const setTreeQuery = useAppStore((s) => s.setTreeQuery);
  const setTreeViewport = useAppStore((s) => s.setTreeViewport);
  const setTreeMode = useAppStore((s) => s.setTreeMode);

  return (
    <BranchTreeView
      runs={runs}
      selectedRunId={selectedRunId}
      compareIds={compareIds}
      onSelect={(id) => {
        void selectRun(id);
      }}
      onToggleCompare={(id) => toggleCompare(id)}
      // 分支返回导航（6.2）：切回"轨迹"看该 run 的详情。**不改节点点击语义**——
      // 点节点仍只是选中（与列表一致），切视图是另一个显式动作。
      onOpenDetail={() => setView("trace")}
      // U7 3.5：「打开运行」= 选中（校验/恢复阅读位置）+ 进入运行工作区（两步都是
      // 既有动作，不新开通路；双击节点只是这个动作的快捷方式）
      onOpenRun={(id) => {
        void selectRun(id).then(() => setView("trace"));
      }}
      scope={treeScope}
      query={treeQuery}
      viewport={treeViewport}
      mode={treeMode}
      onArmSession={armTreeSession}
      onScopeChange={setTreeScope}
      onQueryChange={setTreeQuery}
      onViewportChange={setTreeViewport}
      onModeChange={setTreeMode}
    />
  );
}

/** 纯展示层：树只是既有列表数据的一次投影，不新增 IPC、不读文件 */
export function BranchTreeView({
  runs,
  selectedRunId,
  compareIds,
  onSelect,
  onToggleCompare,
  onOpenDetail,
  onOpenRun,
  scope,
  query,
  viewport,
  mode,
  onArmSession,
  onScopeChange,
  onQueryChange,
  onViewportChange,
  onModeChange,
}: {
  runs: ReadonlyArray<RunSummary>;
  selectedRunId: string | null;
  compareIds: ReadonlyArray<string>;
  onSelect: (id: string) => void;
  onToggleCompare: (id: string) => void;
  /** 切到轨迹视图查看所选 run 的详情（树里没有详情面板，需要显式导航） */
  onOpenDetail: () => void;
  /** U7 3.5：「打开运行」= 选中 + 进入运行工作区（独立明确动作；双击只是快捷方式） */
  onOpenRun: (id: string) => void;
  /** null = 本会话尚未初始化（组件挂载时先 arm） */
  scope: TreeScope | null;
  query: string;
  /** null = 尚无视口记录（按初始档渲染） */
  viewport: TreeViewport | null;
  /** U7 3.6：呈现模式（图 / 关系列表）——会话状态，返回保留来源模式 */
  mode: "graph" | "list";
  /** 首次进入决策（幂等）：返回初始范围与焦点节点 */
  onArmSession: () => { scope: TreeScope; focusRunId: string | null };
  onScopeChange: (scope: TreeScope) => void;
  onQueryChange: (query: string) => void;
  onViewportChange: (viewport: TreeViewport) => void;
  onModeChange: (mode: "graph" | "list") => void;
}) {
  const layout = useMemo(() => layoutRunTree(buildRunForest(runs)), [runs]);
  const byId = useMemo(() => indexRunsById(runs), [runs]);
  const highlighted = useMemo(
    () => (selectedRunId === null ? new Set<string>() : deriveAncestorIds(byId, selectedRunId)),
    [byId, selectedRunId],
  );
  const shortIds = useMemo(() => computeShortIds(runs.map((run) => run.id)), [runs]);
  const hits = useMemo(() => searchTreeNodes(runs, query), [runs, query]);
  const selectedRun = selectedRunId === null ? undefined : byId.get(selectedRunId);

  const effectiveScope: TreeScope = scope ?? "all";
  const visible = useMemo(
    () => visibleRunIdsForScope(runs, effectiveScope, selectedRunId),
    [runs, effectiveScope, selectedRunId],
  );
  const shownNodes =
    visible === null ? layout.nodes : layout.nodes.filter((node) => visible.has(node.id));
  // U7 3.6/3.7：关系列表条目 = 同一布局顺序（图同步），范围过滤与图一致
  const listEntries = useMemo(() => {
    const all = deriveRelationEntries(
      runs,
      layout.nodes.map((node) => node.id),
    );
    return visible === null
      ? all
      : all.filter((entry) =>
          entry.kind === "missing-parent" ? visible.has(entry.childId) : visible.has(entry.run.id),
        );
  }, [runs, layout, visible]);
  const groups = useMemo(() => experimentGroupsOf(listEntries), [listEntries]);

  const viewport_ = viewport ?? initialTreeViewport();
  const scale = viewport_.zoom / 100;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 列表渲染中已出示过的实验组头（每次渲染重建；分组头只在首臂前出现一次）
  const shownGroups = new Set<string>();

  /** 把指定节点滚进视野中央（返回是否真的滚了——节点不在可见集/不存在则不滚） */
  const centerOn = (runId: string): boolean => {
    const container = scrollRef.current;
    const node = layout.nodes.find((entry) => entry.id === runId);
    if (container === null || node === undefined) return false;
    const targetLeft = Math.max(
      0,
      node.x * scale + (node.width * scale) / 2 - container.clientWidth / 2,
    );
    const targetTop = Math.max(
      0,
      node.y * scale + (node.height * scale) / 2 - container.clientHeight / 2,
    );
    container.scrollTo({ left: targetLeft, top: targetTop });
    onViewportChange({ zoom: viewport_.zoom, scrollLeft: targetLeft, scrollTop: targetTop });
    return true;
  };

  // 挂载：先 arm 会话（幂等）——首次进入把当前节点滚进视野；返回树恢复存储视口
  useEffect(() => {
    const container = scrollRef.current;
    const armed = onArmSession();
    if (container !== null && viewport !== null) {
      container.scrollTo({ left: viewport.scrollLeft, top: viewport.scrollTop });
    }
    if (armed.focusRunId !== null && viewport === null) {
      centerOn(armed.focusRunId);
    }
    // 只在挂载时做一次：后续恢复/定位都走显式动作（几何行为归 §6.4 实机验证）
  }, []);

  if (runs.length === 0) {
    return (
      <section className="flex flex-1 items-center justify-center bg-white">
        <div className="max-w-sm text-center text-xs leading-6 text-gray-500">
          还没有运行记录，画不出分支树。
          <br />
          先跑一次（接 trace-sdk / agent-loop），或把应用的 base_url 指到本地录制代理录一次。
        </div>
      </section>
    );
  }

  const selectSearchHit = (hit: TreeSearchHit): void => {
    // 范围外命中：显式定位其树——切到「全部」让该树进入视野，再把节点滚到中央
    if (visible !== null && !visible.has(hit.runId)) {
      onScopeChange("all");
    }
    // 下一帧再滚：范围切换后节点才出现（容器几何由 effect/真实 DOM 处理，§6.4 实机验证）
    requestAnimationFrame(() => {
      centerOn(hit.runId);
    });
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2">
        <div className="text-sm font-semibold text-gray-800">分支树</div>
        <div className="text-[11px] text-gray-500">
          {runs.length} 次运行 · 节点为运行、连线为一次分叉 · 只读
        </div>
        {selectedRunId !== null ? (
          // 树里没有详情面板 ⇒ 想看清所选 run 必须切回轨迹视图。给一个**显式**入口，
          // 而不是让用户在全局栏里自己找（此前 footer 写"点击节点查看详情"却没这条路）。
          <button
            type="button"
            onClick={onOpenDetail}
            className={`inline-flex items-center gap-1 rounded border border-sky-300 px-2 py-0.5 text-[11px] text-sky-800 hover:bg-sky-50 ${FOCUS_RING}`}
          >
            查看所选运行详情
            <ArrowRight size={11} aria-hidden="true" focusable="false" role="presentation" />
          </button>
        ) : null}

        {/* U7 3.1：范围切换（当前树 / 全部）——只改可见性，不改逻辑坐标 */}
        <div role="group" aria-label="树范围" className="flex items-center gap-1 text-[11px]">
          <button
            type="button"
            aria-pressed={effectiveScope === "current"}
            onClick={() => onScopeChange("current")}
            className={`rounded px-2 py-0.5 ${FOCUS_RING} ${
              effectiveScope === "current"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            当前树
          </button>
          <button
            type="button"
            aria-pressed={effectiveScope === "all"}
            onClick={() => onScopeChange("all")}
            className={`rounded px-2 py-0.5 ${FOCUS_RING} ${
              effectiveScope === "all"
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            全部关系
          </button>
        </div>

        {/* U7 3.2：完整字段搜索（完整 ID/任务，匹配原值不匹配截断） */}
        <label className="flex items-center gap-1 text-[11px] text-gray-500">
          <Search size={11} aria-hidden="true" focusable="false" role="presentation" />
          <span className="sr-only">搜索运行（完整 ID 或任务）</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="完整 ID 或任务关键词"
            aria-label="搜索运行（完整 ID 或任务）"
            className={`w-40 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-800 ${FOCUS_RING}`}
          />
        </label>

        {/* U7 3.6：呈现模式（图 / 关系列表）——同一份森林与身份，返回保留模式 */}
        <div role="group" aria-label="呈现模式" className="flex items-center gap-1 text-[11px]">
          <button
            type="button"
            aria-pressed={mode === "graph"}
            onClick={() => onModeChange("graph")}
            className={`rounded px-2 py-0.5 ${FOCUS_RING} ${
              mode === "graph" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            图
          </button>
          <button
            type="button"
            aria-pressed={mode === "list"}
            onClick={() => onModeChange("list")}
            className={`rounded px-2 py-0.5 ${FOCUS_RING} ${
              mode === "list" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            关系列表
          </button>
        </div>

        <div className="ml-auto flex items-center gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => {
              if (selectedRunId !== null) centerOn(selectedRunId);
            }}
            className={`rounded px-2 py-0.5 text-gray-600 hover:bg-gray-100 ${FOCUS_RING}`}
          >
            定位当前运行
          </button>
          <button
            type="button"
            onClick={() => {
              const container = scrollRef.current;
              const level = fitZoomLevel(
                layout.width,
                layout.height,
                container?.clientWidth ?? layout.width,
                container?.clientHeight ?? layout.height,
              );
              onViewportChange({ zoom: level, scrollLeft: 0, scrollTop: 0 });
            }}
            className={`rounded px-2 py-0.5 text-gray-600 hover:bg-gray-100 ${FOCUS_RING}`}
          >
            适应画布
          </button>
          {TREE_ZOOM_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={viewport_.zoom === level}
              onClick={() => onViewportChange({ ...viewport_, zoom: level })}
              className={`rounded px-2 py-0.5 ${FOCUS_RING} ${
                viewport_.zoom === level
                  ? "bg-blue-600 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {level}%
            </button>
          ))}
        </div>
      </div>

      {/* U7 3.2：搜索命中列表（唯一身份 + 所属树；范围外命中可显式定位） */}
      {hits !== null ? (
        <div
          data-tree-search-results="true"
          className="border-b border-gray-200 bg-gray-50/60 px-3 py-1.5 text-[11px]"
        >
          {hits.length === 0 ? (
            <div className="text-gray-500">
              没有匹配「{query}」的运行（按完整 ID 与任务原值匹配）。原选择保持不变。
            </div>
          ) : (
            <ul className="flex flex-wrap items-center gap-2">
              {hits.map((hit) => {
                const run = byId.get(hit.runId);
                const outside = visible !== null && !visible.has(hit.runId);
                return (
                  <li key={hit.runId}>
                    <button
                      type="button"
                      onClick={() => selectSearchHit(hit)}
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${FOCUS_RING} ${
                        outside
                          ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                          : "border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
                      }`}
                      title={
                        outside
                          ? `该运行在当前范围之外（所属树根 ${hit.treeRootId}），点击定位其树`
                          : `所属树根 ${hit.treeRootId}`
                      }
                    >
                      <span className="font-code">{shortIds.get(hit.runId) ?? hit.runId}</span>
                      <span className="max-w-40 truncate">{run?.task ?? hit.runId}</span>
                      {outside ? <span className="text-[10px]">范围外</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {/* U7 3.6：图 / 关系列表共用同一份森林、顺序、选中与对比状态；范围/搜索对两者同时生效 */}
      {mode === "graph" ? (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto p-3"
          onScroll={(event) => {
            const element = event.currentTarget;
            // 滚动也是视口的一部分：落会话，返回树恢复（不重排逻辑坐标）
            onViewportChange({
              zoom: viewport_.zoom,
              scrollLeft: element.scrollLeft,
              scrollTop: element.scrollTop,
            });
          }}
        >
          <div style={{ width: layout.width * scale, height: layout.height * scale }}>
            <div
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                position: "relative",
              }}
            >
              <svg
                width={layout.width}
                height={layout.height}
                className="absolute inset-0"
                role="presentation"
              >
                {layout.edges.map((edge) => {
                  const active = highlighted.has(edge.from) && highlighted.has(edge.to);
                  const edgeVisible =
                    visible === null || (visible.has(edge.from) && visible.has(edge.to));
                  if (!edgeVisible) return null;
                  return (
                    <g key={`${edge.from}-${edge.to}`}>
                      <path
                        d={edge.path}
                        fill="none"
                        stroke={active ? "#2563eb" : "#D3D1C7"}
                        strokeWidth={active ? 2 : 1.5}
                      />
                      {edge.label !== null ? (
                        <text
                          x={edge.labelX}
                          y={edge.labelY}
                          textAnchor="middle"
                          fontSize="11"
                          fill={active ? "#2563eb" : "#888780"}
                        >
                          {edge.label}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>

              {shownNodes.map((node) => {
                const run = node.run;
                const selected = selectedRunId === run.id;
                const onPath = highlighted.has(run.id);
                const checked = compareIds.includes(run.id);
                const shortId = shortIds.get(run.id) ?? run.id;

                return (
                  <div
                    key={node.id}
                    data-run-id={run.id}
                    data-on-path={onPath ? "true" : "false"}
                    data-selected={selected ? "true" : "false"}
                    className={`absolute rounded-lg border bg-white ${
                      selected
                        ? "border-2 border-blue-600"
                        : onPath
                          ? "border-blue-400 bg-blue-50/40"
                          : "border-gray-200"
                    }`}
                    style={{
                      left: node.x,
                      top: node.y,
                      width: node.width,
                      height: node.height,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(run.id)}
                      onDoubleClick={() => onOpenRun(run.id)}
                      className="h-full w-full overflow-hidden rounded-lg px-2 py-1.5 text-left hover:bg-gray-50"
                      title={`${run.task} · ${run.id}（双击打开运行）`}
                    >
                      <div className="flex items-center gap-1.5 pr-5">
                        <span className="truncate text-xs font-medium text-gray-800">
                          {run.task}
                        </span>
                      </div>

                      {/* U7 3.4：稳定唯一短 ID + 记录模型（缺失标「未记录」，不按当前设置补造） */}
                      <div className="mt-0.5 flex items-center gap-1 overflow-hidden text-[11px] text-gray-500">
                        <span
                          className="font-code text-gray-700"
                          title={`完整 run id（可复制）：${run.id}`}
                        >
                          {shortId}
                        </span>
                        <RunStatusBadge status={run.status} reason={run.reason} />
                        <span>{formatTime(run.created_at)}</span>
                        {run.source === "proxy" ? (
                          <span className="rounded bg-sky-100 px-1 text-[10px] leading-4 text-sky-800">
                            代理
                          </span>
                        ) : null}
                        {node.orphanReason !== null ? (
                          <OrphanBadge reason={node.orphanReason} />
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] leading-4 text-gray-500">
                        {run.model === "" ? (
                          <span className="text-gray-400" title="记录中无模型字段">
                            模型：未记录
                          </span>
                        ) : (
                          <span title={`记录模型（完整值）：${run.model}`}>模型：{run.model}</span>
                        )}
                      </div>

                      <div className="mt-1 text-[11px] leading-4 text-gray-500">
                        本 run 增量 {run.steps} 步 · {formatTokens(run.tokensIn + run.tokensOut)}{" "}
                        tokens
                      </div>
                      {/* 沿链累计的完整说明在标题提示里（节点高度有限；spec 的详情区展开归 3.5 后续单元） */}
                      <div
                        className="text-[11px] leading-4 text-gray-400"
                        title="沿 parent 链把各代增量逐段求和；不等于从头连续跑一次的消耗；累计值复制完整数字请开运行详情"
                      >
                        累计增量（沿链求和）
                      </div>
                    </button>

                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleCompare(run.id)}
                      aria-label={`把 ${run.id} 加入对照`}
                      title="加入对照（最多 4 条）"
                      className="absolute right-1.5 top-1.5 cursor-pointer"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* U7 3.6/3.7：关系列表——同数据同顺序；缺父占位只显示真实引用且无动作；
           实验分组只按记录 experimentId（不把来源边称为共享前缀） */
        <div data-tree-list="true" className="min-h-0 flex-1 overflow-auto p-3">
          <ul className="space-y-1">
            {listEntries.map((entry) => {
              if (entry.kind === "missing-parent") {
                return (
                  <li
                    key={`missing:${entry.childId}:${entry.referencedId}`}
                    data-tree-placeholder={entry.referencedId}
                    className="rounded border border-dashed border-amber-300 bg-amber-50/50 px-2 py-1 text-[11px] text-amber-900"
                  >
                    缺失的父运行 <span className="font-code">{entry.referencedId}</span>（
                    {entry.reason}）——子运行 {entry.childId} 已提为根
                  </li>
                );
              }
              const run = entry.run;
              const checked = compareIds.includes(run.id);
              const selected = selectedRunId === run.id;
              const shortId = shortIds.get(run.id) ?? run.id;
              const groupHeader =
                entry.experimentId !== null && !shownGroups.has(entry.experimentId);
              if (groupHeader) shownGroups.add(entry.experimentId);
              return (
                <li key={run.id}>
                  {groupHeader ? (
                    <div
                      data-experiment-group={entry.experimentId}
                      className="mb-0.5 mt-1.5 text-[11px] font-semibold text-violet-800"
                    >
                      实验组 {entry.experimentId}（{(groups.get(entry.experimentId) ?? []).length}{" "}
                      臂）
                    </div>
                  ) : null}
                  <div
                    data-run-id={run.id}
                    data-selected={selected ? "true" : "false"}
                    className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-[11px] ${
                      selected ? "border-blue-500 bg-blue-50/50" : "border-gray-200"
                    }`}
                  >
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelect(run.id)}
                      className={`rounded px-1.5 py-0.5 ${FOCUS_RING} ${
                        selected ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      选中
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenRun(run.id)}
                      className={`rounded border border-sky-300 px-1.5 py-0.5 text-sky-800 hover:bg-sky-50 ${FOCUS_RING}`}
                    >
                      打开运行
                    </button>
                    <button
                      type="button"
                      aria-pressed={checked}
                      onClick={() => onToggleCompare(run.id)}
                      className={`rounded px-1.5 py-0.5 ${FOCUS_RING} ${
                        checked ? "bg-emerald-600 text-white" : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      {checked ? "移出对照" : "加入对照"}
                    </button>
                    <span className="font-code text-gray-700" title={`完整 run id：${run.id}`}>
                      {shortId}
                    </span>
                    <span className="max-w-56 truncate text-gray-800">{run.task}</span>
                    <RunStatusBadge status={run.status} reason={run.reason} />
                    {entry.orphan === "missing-parent" ? (
                      <OrphanBadge reason="missing-parent" />
                    ) : null}
                    {entry.experimentId !== null ? (
                      <span
                        className="rounded bg-violet-100 px-1 text-[10px] leading-4 text-violet-800"
                        title="记录的实验组标签（真实 experimentId）"
                      >
                        实验 {entry.experimentId}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* U7 3.4/3.5：选中详情区——长字段完整展开/复制、沿链累计、打开与加入/移出对比 */}
      {selectedRun !== undefined ? (
        <SelectedRunDetail
          run={selectedRun}
          totals={deriveChainTotals(byId, selectedRun.id)}
          inCompare={compareIds.includes(selectedRun.id)}
          onOpen={onOpenRun}
          onToggleCompare={onToggleCompare}
        />
      ) : null}

      <div className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500">
        点击节点选中该运行（与在列表中点击一致）；选中后用标题栏的入口或全局栏的「轨迹」切回详情页。
        勾选节点加入右侧对照。连线上的标签是分叉时改了哪个字段，分叉点 span id 见详情面板。
      </div>
    </section>
  );
}

/**
 * U7 3.4/3.5：选中详情区（纯视图，测试直接喂 props）。
 *
 * 承担两类义务：
 * - **长字段完整阅读**（spec「长节点字段完整可读」）：完整任务用 `LongText`
 *   （展开 + 查找 + 复制），完整 ID 给**复制按钮**（复制目标 = 完整 id，
 *   复用 `copyPayload` 的"复制原文"契约）；模型缺失如实标「未记录」。
 * - **三种动作分离**（spec「选中打开与加入对比分离」）：打开运行（= 选中 +
 *   进入运行工作区）与加入/移出对照是显式按钮；节点单击仍只是选中。
 * 沿链累计挪进详情区（D2：不塞进不足高度的节点），数值复用 deriveChainTotals
 * 的既有口径，缺失显示「—」不补零。
 */
export function SelectedRunDetail({
  run,
  totals,
  inCompare,
  onOpen,
  onToggleCompare,
}: {
  run: RunSummary;
  /** 沿链累计（沿链求和）；链不可得时为 null（显示 —，不补零） */
  totals: ReturnType<typeof deriveChainTotals>;
  inCompare: boolean;
  onOpen: (id: string) => void;
  onToggleCompare: (id: string) => void;
}) {
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "unavailable" | null>(null);
  const copyId = (): void => {
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: unknown } } })
      .navigator?.clipboard;
    if (
      clipboard === undefined ||
      typeof (clipboard as { writeText?: unknown }).writeText !== "function"
    ) {
      setCopyFeedback("unavailable");
      return;
    }
    void (clipboard as { writeText: (t: string) => Promise<void> })
      .writeText(copyPayload(run.id))
      .then(() => setCopyFeedback("copied"))
      .catch(() => setCopyFeedback("unavailable"));
  };
  const fork = run.fork;

  return (
    <section
      data-tree-detail="true"
      aria-label="所选运行详情"
      className="border-t border-gray-200 px-3 py-2 text-[11px]"
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-gray-700">所选运行</span>
        <RunStatusBadge status={run.status} reason={run.reason} />
        <span className="text-gray-500">{formatTime(run.created_at)}</span>
        {run.source === "proxy" ? (
          <span className="rounded bg-sky-100 px-1 text-[10px] leading-4 text-sky-800">代理</span>
        ) : null}
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="break-all font-code text-gray-800">{run.id}</span>
        <button
          type="button"
          onClick={copyId}
          className={`rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          复制完整 ID
        </button>
        {copyFeedback !== null ? (
          <span className="text-gray-500">{copyFeedbackText(copyFeedback)}</span>
        ) : null}
      </div>
      <div className="mb-1 text-gray-700">
        {run.model === "" ? (
          <span className="text-gray-400">模型：未记录（不按当前设置补造）</span>
        ) : (
          <span>模型：{run.model}</span>
        )}
      </div>
      {fork !== null ? (
        <div className="mb-1 text-gray-500">
          入边标注：{forkEditLabel(fork.edit_field)} · 分叉点{" "}
          <span className="font-code">{fork.at_span}</span>
        </div>
      ) : null}
      <div className="mb-1">
        <LongText text={run.task} label="完整任务" />
      </div>
      <div className="text-gray-500">
        沿链累计（沿链求和）：
        {totals === null
          ? "—（链不可得，不补零）"
          : `${totals.steps} 步 · ${formatTokens(totals.tokens)} tokens`}
        ，不等于从头连续跑一次的消耗
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen(run.id)}
          className={`rounded border border-sky-400 px-2 py-0.5 text-sky-800 hover:bg-sky-50 ${FOCUS_RING}`}
        >
          打开运行
        </button>
        <button
          type="button"
          aria-pressed={inCompare}
          onClick={() => onToggleCompare(run.id)}
          className={`rounded px-2 py-0.5 ${FOCUS_RING} ${
            inCompare ? "bg-emerald-600 text-white" : "text-gray-700 hover:bg-gray-100"
          }`}
        >
          {inCompare ? "移出对照" : "加入对照"}
        </button>
      </div>
    </section>
  );
}
