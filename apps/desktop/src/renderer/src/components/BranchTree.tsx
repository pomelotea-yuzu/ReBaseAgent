import {
  buildRunForest,
  deriveAncestorIds,
  deriveChainTotals,
  indexRunsById,
  layoutRunTree,
} from "@shared/derive";
import { useMemo, useState } from "react";
import { formatTime, formatTokens, reasonLabel } from "../lib/format";
import { useAppStore } from "../store";

/** 缩放档位（不做自由拖拽与无限缩放，见 design Non-goals） */
const ZOOM_LEVELS = [75, 100, 150] as const;
type Zoom = (typeof ZOOM_LEVELS)[number];

/** 状态语义色：与 RunList / SpanTree 保持一致，不发明新配色 */
function statusDotClass(run: { status: "completed" | "crashed"; toolErrors: number }): string {
  if (run.toolErrors > 0) return "bg-red-500";
  return run.status === "crashed" ? "bg-amber-500" : "bg-emerald-500";
}

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

export function BranchTree() {
  const runs = useAppStore((s) => s.runs);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const selectRun = useAppStore((s) => s.selectRun);
  const compareIds = useAppStore((s) => s.compareIds);
  const toggleCompare = useAppStore((s) => s.toggleCompare);
  const [zoom, setZoom] = useState<Zoom>(100);

  // 树只是既有列表数据的一次投影：渲染层派生，不新增 IPC、不读文件
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
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <div className="text-sm font-semibold text-gray-800">分支树</div>
        <div className="text-[11px] text-gray-500">
          {runs.length} 次运行 · 节点为运行、连线为一次分叉 · 只读
        </div>
        <div className="ml-auto flex items-center gap-1 text-[11px]">
          {ZOOM_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setZoom(level)}
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
                    onClick={() => {
                      void selectRun(run.id);
                    }}
                    className="h-full w-full overflow-hidden rounded-lg px-2 py-1.5 text-left hover:bg-gray-50"
                    title={`${run.task} · ${run.id}`}
                  >
                    <div className="flex items-center gap-1.5 pr-5">
                      <span
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(
                          run,
                        )}`}
                      />
                      <span className="truncate text-xs font-medium text-gray-800">{run.task}</span>
                    </div>

                    <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-gray-500">
                      <span>{formatTime(run.created_at)}</span>
                      <span>·</span>
                      <span>{reasonLabel(run.reason)}</span>
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
                    onChange={() => toggleCompare(run.id)}
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
        点击节点查看详情，勾选节点加入右侧对照。连线上的标签是分叉时改了哪个字段，分叉点 span id
        见详情面板。
      </div>
    </section>
  );
}
