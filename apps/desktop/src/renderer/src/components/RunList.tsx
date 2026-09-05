import { formatDuration, formatTime, formatTokens, reasonLabel } from "../lib/format";
import { useAppStore } from "../store";

/** 状态徽章：completed 与 crashed 两态，崩溃明确标注"运行中断" */
function StatusBadge({
  status,
  reason,
}: { status: "completed" | "crashed"; reason: string | null }) {
  const crashed = status === "crashed";
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[11px] leading-4 ${
        crashed ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
      }`}
      title={crashed ? "进程中断，无终止事件" : undefined}
    >
      {crashed ? "运行中断" : reasonLabel(reason)}
    </span>
  );
}

export function RunList() {
  const runs = useAppStore((s) => s.runs);
  const failed = useAppStore((s) => s.failed);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const loadingList = useAppStore((s) => s.loadingList);
  const selectRun = useAppStore((s) => s.selectRun);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);

  // 来源过滤：proxy meta 缺失的老文件归入"本地直录"
  const filtered =
    sourceFilter === "all"
      ? runs
      : sourceFilter === "proxy"
        ? runs.filter((r) => r.source === "proxy")
        : runs.filter((r) => r.source !== "proxy");

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="text-sm font-semibold text-gray-800">运行记录</div>
        <div className="text-[11px] text-gray-500">按创建时间倒序 · 只读</div>
      </div>

      <div className="border-b border-gray-200 px-3 py-1.5">
        <div className="flex items-center gap-1 text-[11px]">
          {(
            [
              ["all", "全部"],
              ["proxy", "仅代理"],
              ["local", "仅本地直录"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSourceFilter(value)}
              className={`rounded px-2 py-0.5 ${
                sourceFilter === value
                  ? "bg-blue-600 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loadingList && runs.length === 0 ? (
          <div className="px-3 py-6 text-xs text-gray-500">加载中…</div>
        ) : null}

        {!loadingList && filtered.length === 0 && failed.length === 0 ? (
          <div className="px-3 py-6 text-xs leading-5 text-gray-500">
            {sourceFilter === "all"
              ? "数据目录的 traces/ 下还没有 trace 文件。"
              : "该来源下暂无运行记录。"}
            <br />
            {sourceFilter === "all" ? "把 *.jsonl 放进去后重新打开即可。" : ""}
          </div>
        ) : null}

        {filtered.map((run) => (
          <button
            type="button"
            key={run.id}
            onClick={() => {
              void selectRun(run.id);
            }}
            className={`block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 ${
              selectedRunId === run.id ? "bg-blue-50 hover:bg-blue-50" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <StatusBadge status={run.status} reason={run.reason} />
              {run.source === "proxy" ? (
                <span
                  className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] leading-4 text-sky-800"
                  title="经本地录制代理录制（可在其 llm.call 详情编辑 messages 重发）"
                >
                  代理
                </span>
              ) : null}
              <span className="truncate text-xs font-medium text-gray-800" title={run.task}>
                {run.task}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
              <span className="font-code">{run.id}</span>
              {run.parent !== null ? <span className="text-violet-600">分支</span> : null}
              <span className="truncate">{run.model}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
              <span>{formatTime(run.created_at)}</span>
              <span>{run.steps} 步</span>
              <span>{run.toolCalls} 工具</span>
              {run.toolErrors > 0 ? (
                <span className="text-red-600">{run.toolErrors} 出错</span>
              ) : null}
              <span>{formatTokens(run.tokensIn + run.tokensOut)} tokens</span>
              <span>{formatDuration(run.durationMs)}</span>
            </div>
          </button>
        ))}

        {failed.map((item) => (
          <div key={item.file} className="border-b border-gray-100 bg-red-50 px-3 py-2">
            <div className="text-xs font-medium text-red-700">读取失败：{item.file}</div>
            <div className="mt-0.5 break-all text-[11px] leading-4 text-red-600">{item.error}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
