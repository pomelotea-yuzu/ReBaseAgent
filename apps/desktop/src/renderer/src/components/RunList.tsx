import { deriveNavLabel, filterRuns } from "@shared/nav";
import { useEffect, useRef, useState } from "react";
import { formatDuration, formatTime, formatTokens } from "../lib/format";
import { NAV_MAX, NAV_MIN } from "../lib/layout";
import { copyValueForRun, resolveEmptyCause, resolveNavListState } from "../lib/nav-notice";
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
  fullWidth = false,
  onSelected,
}: {
  width: number;
  onWidth: (width: number) => void;
  onWidthKey: (key: string) => boolean;
  onToggleCollapsed: () => void;
  fullWidth?: boolean;
  onSelected?: () => void;
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

  // 刷新 / 失败 / 空结果（任务 4.5）：刷新失败保留旧列表并提示「未更新」+ 可重试；
  // 「筛选后为空」与「真的没有记录」成因分开，不把前者说成后者（否则误导用户去 traces/ 找文件）
  const listStale = useAppStore((s) => s.listStale);
  const error = useAppStore((s) => s.error);
  const reload = useAppStore((s) => s.loadRuns);
  const navState = resolveNavListState({
    loading: loadingList,
    stale: listStale,
    error,
    hasAnyData: runs.length + failed.length > 0,
  });
  const emptyCause = resolveEmptyCause({
    hasActiveFilters: visibility.hasActiveFilters,
    hasAnyData: filtered.length + failed.length > 0,
  });

  // 短 ID 复制反馈（任务 4.5）：复制的是**完整 ID**（copyValueForRun），短 ID 只是显示。
  // 「已复制」短暂显示后复原；组件卸载时清掉定时器，避免在已卸载组件上 setState。
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copyRunId = async (runId: string): Promise<void> => {
    const value = copyValueForRun(runId);
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(runId);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(null), 1200);
    } catch {
      // 剪贴板不可用（权限/无安全上下文）时不假装成功——静默保持短 ID 显示
      setCopiedId(null);
    }
  };

  return (
    <aside
      id="run-navigation"
      aria-label="运行列表"
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-gray-200 bg-white"
      style={fullWidth ? { width: "100%", minWidth: 0 } : { width, minWidth: width }}
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
              aria-label={fullWidth ? "返回当前运行" : "收起运行列表"}
              title={fullWidth ? "返回当前运行" : "收起运行列表"}
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

      {/* 刷新失败（任务 4.5）：曾成功加载 ⇒ 提示「未更新」不盖掉旧记录；首次失败给可重试错误。
          刷新进行中保留旧列表，不显示"加载中…"覆盖已有内容。 */}
      {navState.failure !== null && navState.showStale ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-4 text-amber-800">
          列表未更新，仍显示上次结果。
          <button
            type="button"
            onClick={() => void reload()}
            className="ml-1 underline hover:text-amber-900"
          >
            重试
          </button>
        </div>
      ) : null}

      {navState.failure !== null && !navState.showStale ? (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-[11px] leading-4 text-red-700">
          <span className="break-all">{navState.failure}</span>
          <button
            type="button"
            onClick={() => void reload()}
            className="ml-1 shrink-0 underline hover:text-red-800"
          >
            重试
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {navState.showLoading ? (
          <div className="px-3 py-6 text-xs text-gray-500">加载中…</div>
        ) : null}

        {emptyCause !== null ? (
          <div className="px-3 py-6 text-xs leading-5 text-gray-500">
            {emptyCause === "filtered" ? (
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
            <div
              key={run.id}
              className={`group relative border-b border-gray-100 hover:bg-gray-50 ${
                selectedRunId === run.id ? "bg-blue-50 hover:bg-blue-50" : ""
              }`}
            >
              {/* 选择区：整行可点。复制入口是**兄弟节点**（不嵌在按钮内）——
                  HTML 不允许 button 套 button，2.4 的短 ID 又要能单独点。 */}
              <button
                type="button"
                onClick={() => {
                  void selectRun(run.id);
                  onSelected?.();
                }}
                className="block w-full px-3 py-2 text-left"
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

                {/* 第二行：短 ID + 分支 + 模型（缺失显「未记录」，不借当前配置） */}
                <div className="mt-1 flex items-center gap-2 text-reading-meta text-gray-500">
                  {/* 短 ID 是界面标识；复制入口在**行右侧**（绝对定位的兄弟按钮，见下） */}
                  <span className="font-code" title={`完整 ID：${run.id}`}>
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

              {/* 复制完整 ID（任务 4.5）：短 ID 是界面标识，复制**永远给完整值**
                  （`copyValueForRun` 单点钉住）。放在选择按钮之外——HTML 不允许 button 套 button。 */}
              <button
                type="button"
                onClick={() => void copyRunId(run.id)}
                aria-label={`复制完整运行 ID ${run.id}`}
                title={`点击复制完整 ID：${run.id}`}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1.5 py-0.5 text-reading-meta text-gray-400 opacity-0 hover:bg-gray-200 hover:text-gray-700 focus-visible:opacity-100 group-hover:opacity-100"
              >
                {copiedId === run.id ? "已复制" : "复制 ID"}
              </button>
            </div>
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
      {!fullWidth ? (
        <ResizeGrip
          label="运行导航宽度"
          width={width}
          min={NAV_MIN}
          max={NAV_MAX}
          onWidth={onWidth}
          onWidthKey={onWidthKey}
        />
      ) : null}
    </aside>
  );
}
