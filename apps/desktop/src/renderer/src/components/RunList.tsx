import { deriveNavLabel, filterRuns } from "@shared/nav";
import { classifyOutcome } from "@shared/outcome";
import { useEffect, useRef, useState } from "react";
import { useTranslator } from "../i18n";
import { formatDuration, formatTime, formatTokens } from "../lib/format";
import { NAV_MAX, NAV_MIN } from "../lib/layout";
import { copyValueForRun, resolveEmptyCause, resolveNavListState } from "../lib/nav-notice";
import { describeStoreError } from "../lib/store-error";
import { useAppStore } from "../store";
import { DisclosureButton } from "./Disclosure";
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
  const translator = useTranslator();
  const runs = useAppStore((s) => s.runs);
  const failed = useAppStore((s) => s.failed);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const loadingList = useAppStore((s) => s.loadingList);
  const selectRun = useAppStore((s) => s.selectRun);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);

  // 「新建运行」入口（任务 4.2 / U5 任务 4.1）：**与全局栏共用 store 的同一个入口动作**，
  // 打开的是主工作区里的同一个创建工作区，不是两份各开各的（spec：共用同一创建工作区）
  const openCreateWorkspace = useAppStore((s) => s.openCreateWorkspace);

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
  const errorDescriptor = useAppStore((s) => s.errorDescriptor);
  const errorText =
    error === null
      ? null
      : errorDescriptor === null
        ? error
        : describeStoreError(errorDescriptor, translator);
  const reload = useAppStore((s) => s.loadRuns);
  const navState = resolveNavListState({
    loading: loadingList,
    stale: listStale,
    error: errorText,
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

  // UI 整理 2.4（delta「运行导航突出任务且详细事实可访问」）：次级指标（模型、步数、
  // 工具数、tokens、缓存命中、时长）默认收起，列表级「指标」开关按需展开——
  // 优先呈现任务、结局、时间与短 ID；数据全部来自已在场的 RunSummary，零逐条详情扫描。
  // 展开是列表级视图偏好（会话内临时态），不进 store、不持久化。
  const [metricsOpen, setMetricsOpen] = useState(false);
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
      aria-label={translator.t("run.listAria")}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-gray-200 bg-white"
      style={fullWidth ? { width: "100%", minWidth: 0 } : { width, minWidth: width }}
    >
      <div className="border-b border-gray-200 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          {/*
           * UI 密度 change 1.1（design D1）：标题**整行可点**的折叠开关——
           * 可见「收起」文字 + 方向箭头 + aria-expanded/aria-controls + ≥28px 命中区。
           * 此前的浅色 16px `‹` 箭头不再是唯一入口。fullWidth（窄窗替换工作区）时
           * 动作是「返回当前运行」。与全局栏的同名入口（GlobalBar nav toggle）含义一致：
           * 都描述"收起/打开运行列表"这一个动作，写偏好的唯一路径仍是外壳的 closeNav。
           */}
          <DisclosureButton
            expanded
            onToggle={onToggleCollapsed}
            label={translator.t(fullWidth ? "run.listReturnCurrent" : "common.collapseRunList")}
            controls="run-navigation"
            title={translator.t(
              fullWidth ? "run.listReturnCurrentTitle" : "common.collapseRunList",
            )}
            className="min-w-0 flex-1 justify-between px-1 hover:bg-gray-100"
          >
            <span className="text-sm font-semibold text-gray-800">
              {translator.t("run.listTitle")}
            </span>
            <span className="shrink-0 pl-2 text-[11px] text-gray-500">
              {translator.t(fullWidth ? "common.back" : "common.collapse")}
            </span>
          </DisclosureButton>
          <button
            type="button"
            onClick={openCreateWorkspace}
            title={translator.t("common.newRunHint")}
            className="flex shrink-0 items-center gap-1.5 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
          >
            {translator.t("run.listNewRun")}
          </button>
        </div>
        <div className="text-[11px] text-gray-500">{translator.t("run.listSubtitle")}</div>
      </div>

      <div className="border-b border-gray-200 px-3 py-1.5">
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={translator.t("run.searchPlaceholder")}
          className="w-full rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
        />
        <div className="mt-1.5 flex items-center gap-1 text-[11px]">
          {(
            [
              ["all", translator.t("run.filterAll")],
              ["proxy", translator.t("run.filterProxy")],
              ["local", translator.t("run.filterLocal")],
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
          {/* UI 整理 2.4：次级指标开关（aria-pressed 表达当前态；与来源筛选同一视觉族） */}
          <button
            type="button"
            onClick={() => setMetricsOpen((prev) => !prev)}
            aria-pressed={metricsOpen}
            title={translator.t("run.metricsToggleHint")}
            className={`ml-auto rounded px-2 py-0.5 ${
              metricsOpen ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {translator.t("run.metricsToggle")}
          </button>
        </div>
      </div>

      {/* 当前运行不在筛选结果中（任务 3.5）：明确提示 + 清除条件入口，**不**自动改选其他运行 */}
      {visibility.hidden ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-4 text-amber-800">
          {translator.t("run.selectedHidden")}
          <button
            type="button"
            onClick={clearFilters}
            className="ml-1 underline hover:text-amber-900"
          >
            {translator.t("run.clearFilters")}
          </button>
        </div>
      ) : null}

      {/* 刷新失败（任务 4.5）：曾成功加载 ⇒ 提示「未更新」不盖掉旧记录；首次失败给可重试错误。
          刷新进行中保留旧列表，不显示"加载中…"覆盖已有内容。 */}
      {navState.failure !== null && navState.showStale ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] leading-4 text-amber-800">
          {translator.t("run.listStale")}
          <button
            type="button"
            onClick={() => void reload()}
            className="ml-1 underline hover:text-amber-900"
          >
            {translator.t("run.retry")}
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
            {translator.t("run.retry")}
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {navState.showLoading ? (
          <div className="px-3 py-6 text-xs text-gray-500">{translator.t("common.loading")}</div>
        ) : null}

        {emptyCause !== null ? (
          <div className="px-3 py-6 text-xs leading-5 text-gray-500">
            {emptyCause === "filtered" ? (
              <>
                {translator.t("run.emptyFiltered")}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-1 underline hover:text-gray-700"
                >
                  {translator.t("run.clearFilters")}
                </button>
              </>
            ) : (
              <>{translator.t("run.emptyNoRecords")}</>
            )}
          </div>
        ) : null}

        {filtered.map((run) => {
          // 导航摘要（任务 4.4）：短 ID 只是**界面标识**，完整 ID 仍用于复制与 title
          const label = deriveNavLabel(
            run,
            shortIds.get(run.id) ?? run.id,
            {
              time: formatTime(run.created_at),
              source: translator.t(run.source === "proxy" ? "run.filterProxy" : "run.filterLocal"),
            },
            translator,
          );
          const outcome = classifyOutcome({ status: run.status, reason: run.reason });
          const zeroUsageNeedsExplanation =
            !outcome.normalEnd && run.tokensIn === 0 && run.tokensOut === 0;
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
                        title={translator.t("run.proxyBadgeHint")}
                      >
                        {translator.t("run.filterProxy")}
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

                {/* 第二行：短 ID + 分支 + 时间 + 结局错误（UI 整理 2.4：时间与「N 出错」
                    是默认可辨的身份／结局事实；模型与消耗指标移入「指标」展开区） */}
                <div className="mt-1 flex items-center gap-2 text-reading-meta text-gray-500">
                  {/* 短 ID 是界面标识；复制入口在**行右侧**（绝对定位的兄弟按钮，见下） */}
                  <span className="font-code" title={translator.t("run.fullId", { id: run.id })}>
                    {shortIds.get(run.id) ?? run.id}
                  </span>
                  {run.parent !== null ? (
                    <span className="text-violet-600">{translator.t("run.branchBadge")}</span>
                  ) : null}
                  <span className="ml-auto">{formatTime(run.created_at)}</span>
                  {run.toolErrors > 0 ? (
                    <span className="shrink-0 text-red-600">
                      {translator.t("run.toolErrorsCount", { count: run.toolErrors })}
                    </span>
                  ) : null}
                </div>

                {/* 次级指标区（UI 整理 2.4）：「指标」开关展开后可见；既有指标一个不删
                    （steps/tools/token/duration/cache + 未知语义说明原样保留） */}
                {metricsOpen ? (
                  <div
                    className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-reading-meta text-gray-500"
                    data-run-metrics="true"
                  >
                    <span className="break-all" title={label.model}>
                      {label.model}
                    </span>
                    <span>{translator.t("common.stepCount", { count: run.steps })}</span>
                    <span>{translator.t("run.toolCount", { count: run.toolCalls })}</span>
                    <span
                      title={
                        zeroUsageNeedsExplanation ? translator.t("run.zeroUsageHint") : undefined
                      }
                    >
                      {formatTokens(run.tokensIn + run.tokensOut)} tokens
                      {zeroUsageNeedsExplanation ? translator.t("run.zeroUsageSuffix") : ""}
                    </span>
                    {/* run 级累计缓存命中：null = 无数据（未知，不显示）；0 = 实测零命中（照常显示） */}
                    {run.cacheHit === null ? null : (
                      <span
                        className={run.cacheHit > 0 ? "text-emerald-600" : "text-amber-600"}
                        title={translator.t("run.listCacheHint")}
                      >
                        {translator.t("run.cacheHitShort", { value: formatTokens(run.cacheHit) })}
                      </span>
                    )}
                    <span>{formatDuration(run.durationMs)}</span>
                  </div>
                ) : null}
              </button>

              {/* 复制完整 ID（任务 4.5）：短 ID 是界面标识，复制**永远给完整值**
                  （`copyValueForRun` 单点钉住）。放在选择按钮之外——HTML 不允许 button 套 button。 */}
              <button
                type="button"
                onClick={() => void copyRunId(run.id)}
                aria-label={translator.t("run.copyIdAria", { id: run.id })}
                title={translator.t("run.copyIdTitle", { id: run.id })}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1.5 py-0.5 text-reading-meta text-gray-400 opacity-0 hover:bg-gray-200 hover:text-gray-700 focus-visible:opacity-100 group-hover:opacity-100"
              >
                {translator.t(copiedId === run.id ? "common.copied" : "run.copyId")}
              </button>
            </div>
          );
        })}

        {failed.map((item) => (
          <div key={item.file} className="border-b border-gray-100 bg-red-50 px-3 py-2">
            <div className="text-xs font-medium text-red-700">
              {translator.t("run.loadFailed")}
              {item.file}
            </div>
            <div className="mt-0.5 break-all text-[11px] leading-4 text-red-600">{item.error}</div>
          </div>
        ))}
      </div>

      {/* 宽度调节柄（任务 4.3）：220–360，拖动或 ←/→ 均可 */}
      {!fullWidth ? (
        <ResizeGrip
          label={translator.t("run.navWidth")}
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
