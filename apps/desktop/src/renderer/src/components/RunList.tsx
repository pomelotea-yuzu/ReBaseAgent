import { deriveNavLabel, filterRuns } from "@shared/nav";
import { formatDuration, formatTime, formatTokens } from "../lib/format";
import { NAV_MAX, NAV_MIN } from "../lib/layout";
import { useAppStore } from "../store";
import { ResizeGrip } from "./ResizeGrip";
import { RunStatusBadge } from "./RunStatusBadge";

/**
 * 运行导航（任务 4.3）。
 *
 * 宽度由外壳计算并传入（`width` / `onWidth` / `onWidthKey`）——组件**不自己夹宽度**，
 * 那会让"220–360"这条规则散成两份。收起/展开同理由外壳决定挂不挂载。
 */
export function RunList({
  width,
  onWidth,
  onWidthKey,
  onToggleCollapsed,
}: {
  width: number;
  onWidth: (width: number) => void;
  onWidthKey: (key: string) => boolean;
  onToggleCollapsed: () => void;
}) {
  const runs = useAppStore((s) => s.runs);
  const failed = useAppStore((s) => s.failed);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const loadingList = useAppStore((s) => s.loadingList);
  const selectRun = useAppStore((s) => s.selectRun);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);

  // "新建运行"对话框开关（任务 4.2）：**与全局栏共用同一位于 store 的开关**，
  // 写的是同一个 CreateRunDialog 单例，不是两份各开各的（spec：共用同一现有创建流程）
  const setCreateDialogOpen = useAppStore((s) => s.setCreateDialogOpen);

  // 短 ID（任务 4.4）：长度记忆存于 store——会话内**只增不减**，
  // 若放组件内则运行列表一卸载（切页签）就会忘记已扩展的长度，刷新后碰撞项重现
  const shortIdState = useAppStore((s) => s.shortIdState);
  const shortIds = shortIdState.update(runs.map((r) => r.id));

  // 搜索与来源条件求交集（任务 2.4 的共用派生）；无 source 字段的老文件归入"本地记录"
  const filtered = filterRuns(runs, searchQuery, sourceFilter);
  // 当前选中运行是否被筛选隐藏（任务 3.5）：隐藏时**不改选**，只在导航提示并给清除入口
  const visibility = useAppStore((s) => s.filterVisibility)();
  const clearFilters = () => {
    setSearchQuery("");
    setSourceFilter("all");
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-gray-200 bg-white"
      style={{ width, minWidth: width }}
    >
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-gray-800">运行记录</div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              title="直接在桌面端跑一个 run（纯对话，或隔离文件运行；不需代理、不需写代码）"
              className="flex shrink-0 items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
            >
              ＋ 新建运行
            </button>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="收起运行列表"
              title="收起运行列表（宽度由外壳按可用空间管理，收起后仍可用全局栏新建）"
              className="rounded px-1.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              ‹
            </button>
          </div>
        </div>
        <div className="text-[11px] text-gray-500">按创建时间倒序 · trace 只读</div>
      </div>

      <div className="border-b border-gray-200 px-3 py-1.5">
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="搜索完整任务或运行 ID"
          className="w-full rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
        />
        <div className="mt-1.5 flex items-center gap-1 text-[11px]">
          {(
            [
              ["all", "全部"],
              ["proxy", "代理录制"],
              ["local", "本地记录"],
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

      {/* 当前运行不在筛选结果中（任务 3.5）：明确提示 + 清除条件入口，**不**自动改选其他运行 */}
      {visibility.hidden ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-4 text-amber-800">
          当前运行的记录不在筛选结果中，主工作区仍显示它。
          <button
            type="button"
            onClick={clearFilters}
            className="ml-1 underline hover:text-amber-900"
          >
            清除条件
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {loadingList && runs.length === 0 ? (
          <div className="px-3 py-6 text-xs text-gray-500">加载中…</div>
        ) : null}

        {!loadingList && filtered.length === 0 && failed.length === 0 ? (
          <div className="px-3 py-6 text-xs leading-5 text-gray-500">
            {visibility.hasActiveFilters ? (
              <>
                当前条件下没有匹配的运行记录。
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-1 underline hover:text-gray-700"
                >
                  清除条件
                </button>
              </>
            ) : (
              <>
                还没有运行记录：点上方「＋ 新建运行」直接跑一个，
                <br />
                或把 *.jsonl 放进数据目录的 traces/。
              </>
            )}
          </div>
        ) : null}

        {filtered.map((run) => {
          // 导航摘要（任务 4.4）：短 ID 只是**界面标识**，完整 ID 仍用于复制与 title
          const label = deriveNavLabel(run, shortIds.get(run.id) ?? run.id, {
            time: formatTime(run.created_at),
            source: run.source === "proxy" ? "代理录制" : "本地记录",
          });
          return (
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
              {/* 第一行：状态 + 来源 + 任务（紧凑条目优先 task/model/status/短ID/时间/来源） */}
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex shrink-0 items-center gap-1">
                  <RunStatusBadge status={run.status} reason={run.reason} />
                  {run.source === "proxy" ? (
                    <span
                      className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-reading-meta leading-4 text-sky-800"
                      title="经本地录制代理录制（可在其 llm.call 详情编辑 messages 重发）"
                    >
                      代理录制
                    </span>
                  ) : null}
                </span>
                {/* 任务最多两行；超长由 CSS 截断，完整值在 title 里（不改原值） */}
                <span
                  className={`line-clamp-2 min-w-0 flex-1 text-reading-meta font-medium ${
                    label.isFallback ? "text-gray-500" : "text-gray-800"
                  }`}
                  title={run.task}
                >
                  {label.title}
                </span>
              </div>

              {/* 第二行：短 ID（复制用完整值）+ 分支 + 模型（缺失显「未记录」，不借当前配置） */}
              <div className="mt-1 flex items-center gap-2 text-reading-meta text-gray-500">
                <span className="font-code" title={`完整 ID：${run.id}（点击复制入口见任务 4.5）`}>
                  {shortIds.get(run.id) ?? run.id}
                </span>
                {run.parent !== null ? <span className="text-violet-600">分支</span> : null}
                <span className="truncate" title={label.model}>
                  {label.model}
                </span>
              </div>

              {/* 第三行：既有指标一个不删（steps/tools/errors/token/duration/cache） */}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-reading-meta text-gray-500">
                <span>{formatTime(run.created_at)}</span>
                <span>{run.steps} 步</span>
                <span>{run.toolCalls} 工具</span>
                {run.toolErrors > 0 ? (
                  <span className="text-red-600">{run.toolErrors} 出错</span>
                ) : null}
                <span>{formatTokens(run.tokensIn + run.tokensOut)} tokens</span>
                {/* run 级累计缓存命中：null = 无数据（未知，不显示）；0 = 实测零命中（照常显示） */}
                {run.cacheHit === null ? null : (
                  <span
                    className={run.cacheHit > 0 ? "text-emerald-600" : "text-amber-600"}
                    title="本 run 自有 llm.call 的已记录命中量（不含祖先共享前缀，非全运行命中率）"
                  >
                    命中 {formatTokens(run.cacheHit)}
                  </span>
                )}
                <span>{formatDuration(run.durationMs)}</span>
              </div>
            </button>
          );
        })}

        {failed.map((item) => (
          <div key={item.file} className="border-b border-gray-100 bg-red-50 px-3 py-2">
            <div className="text-xs font-medium text-red-700">读取失败：{item.file}</div>
            <div className="mt-0.5 break-all text-[11px] leading-4 text-red-600">{item.error}</div>
          </div>
        ))}
      </div>

      {/* 宽度调节柄（任务 4.3）：220–360，拖动或 ←/→ 均可 */}
      <ResizeGrip
        label="运行导航宽度"
        width={width}
        min={NAV_MIN}
        max={NAV_MAX}
        onWidth={onWidth}
        onWidthKey={onWidthKey}
      />
    </aside>
  );
}
