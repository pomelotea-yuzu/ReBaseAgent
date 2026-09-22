import {
  buildRunForest,
  deriveAncestorIds,
  deriveChainTotals,
  indexRunsById,
  layoutRunTree,
} from "@shared/derive";
import type { RunSummary } from "@shared/ipc";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import { formatTime, formatTokens } from "../lib/format";
import { useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";
import { RunStatusBadge } from "./RunStatusBadge";

/**
 * 分支树（U1 任务 6.2）。
 *
 * 判据来源：branch-tree delta「分支树以节点-边图呈现运行与分叉」——
 *   - 节点展示状态/任务名/创建时间/本 run 增量（步数 · tokens）；边标注分叉摘要与分叉点
 *   - **节点状态 SHALL 与运行列表及概览使用一致的状态文字和语义色**（见下）
 *   - `completed` 仅表示封存，不单凭该值展示正常成功；`crashed` 中性色、不推断为仍在执行；
 *     未知 reason 显示「结束原因未知」且原值可查看
 *   - 工具曾出错但最终正常结束 ⇒ 仍按终止原因展示，**不把工具错误数当作整次运行失败**
 *   - 选中某 run ⇒ 高亮从根到它的整条祖先链（即与兄弟分支共享的前缀）；点击节点行为与列表一致
 *
 * ⚠️ **状态渲染已统一到 `RunStatusBadge`**（6.2 之前这里是自造的 `statusDotClass` 色点 +
 *    `reasonLabel`，与列表/概览各说一套：例如把 `toolErrors > 0` 染红、把 `crashed` 染琥珀、
 *    把 `completed` 一律染绿）。现在文字与配色都来自 `classifyOutcome`／`outcomeBadgeClass`
 *    这一份唯一判据，工具错误数由列表/概览单独呈现，不再冒充终止原因。
 *
 * ⚠️ 取值与渲染分离（`BranchTreeView`）：本包无 jsdom，store 薄壳在 `renderToStaticMarkup`
 *    下走 `getServerSnapshot`（恒初始值）⇒ 组件测试喂不进状态。故把"数据 → 视图"抽成纯展示
 *    组件，测试直接喂 `runs` / `selectedRunId` 钉住各场景（本组件此前**完全没有测试**）。
 */

/** 缩放档位（不做自由拖拽与无限缩放，见 design Non-goals） */
const ZOOM_LEVELS = [75, 100, 150] as const;
export type Zoom = (typeof ZOOM_LEVELS)[number];

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

/** store 薄壳：只负责把 store 数据与动作接进纯展示层 */
export function BranchTree() {
  const runs = useAppStore((s) => s.runs);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const selectRun = useAppStore((s) => s.selectRun);
  const compareIds = useAppStore((s) => s.compareIds);
  const toggleCompare = useAppStore((s) => s.toggleCompare);
  const setView = useAppStore((s) => s.setView);
  const [zoom, setZoom] = useState<Zoom>(100);

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
      zoom={zoom}
      onZoom={setZoom}
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
  zoom,
  onZoom,
}: {
  runs: ReadonlyArray<RunSummary>;
  selectedRunId: string | null;
  compareIds: ReadonlyArray<string>;
  onSelect: (id: string) => void;
  onToggleCompare: (id: string) => void;
  /** 切到轨迹视图查看所选 run 的详情（树里没有详情面板，需要显式导航） */
  onOpenDetail: () => void;
  zoom: Zoom;
  onZoom: (next: Zoom) => void;
}) {
  const layout = useMemo(() => layoutRunTree(buildRunForest(runs)), [runs]);
  const byId = useMemo(() => indexRunsById(runs), [runs]);
  const highlighted = useMemo(
    () => (selectedRunId === null ? new Set<string>() : deriveAncestorIds(byId, selectedRunId)),
    [byId, selectedRunId],
  );
  const scale = zoom / 100;

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
        <div className="ml-auto flex items-center gap-1 text-[11px]">
          {ZOOM_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => onZoom(level)}
              className={`rounded px-2 py-0.5 ${
                zoom === level ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {level}%
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
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

            {layout.nodes.map((node) => {
              const run = node.run;
              const totals = deriveChainTotals(byId, run.id);
              const selected = selectedRunId === run.id;
              const onPath = highlighted.has(run.id);
              const checked = compareIds.includes(run.id);

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
                    className="h-full w-full overflow-hidden rounded-lg px-2 py-1.5 text-left hover:bg-gray-50"
                    title={`${run.task} · ${run.id}`}
                  >
                    <div className="flex items-center gap-1.5 pr-5">
                      <span className="truncate text-xs font-medium text-gray-800">{run.task}</span>
                    </div>

                    {/* 单行不换行（卡片高度由 layoutRunTree 固定 76px，换行会顶破卡片） */}
                    <div className="mt-0.5 flex items-center gap-1 overflow-hidden text-[11px] text-gray-500">
                      {/* 状态文字 + 语义色：与运行列表 / 概览同一判据（不需要颜色也能读懂） */}
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

                    <div className="mt-1 text-[11px] leading-4 text-gray-500">
                      本 run 增量 {run.steps} 步 · {formatTokens(run.tokensIn + run.tokensOut)}{" "}
                      tokens
                    </div>
                    <div
                      className="text-[11px] leading-4 text-gray-400"
                      title="沿 parent 链把各代增量逐段求和；不等于从头连续跑一次的消耗"
                    >
                      累计增量（沿链求和）{" "}
                      {totals === null
                        ? "—"
                        : `${totals.steps} 步 · ${formatTokens(totals.tokens)}`}
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

      <div className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500">
        点击节点选中该运行（与在列表中点击一致）；选中后用标题栏的入口或全局栏的「轨迹」切回详情页。
        勾选节点加入右侧对照。连线上的标签是分叉时改了哪个字段，分叉点 span id 见详情面板。
      </div>
    </section>
  );
}
