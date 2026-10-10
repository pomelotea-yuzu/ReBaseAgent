/**
 * 单运行工作区（U1 任务 4.2 · design D1）。
 *
 * 职责：承载「任务头 + 概览 | 步骤 | 文件」三平级页签，并按页签决定挂载什么。
 *
 * 三条本组件负责的边界（都有 spec/design 出处）：
 *   1. **文件页不挂步骤目录**：文件模式传 `withSteps={false}` 给正文……（实际做法是
 *      按页签切换正文内容，见下）。文件页占整个主工作区正文，没有无关步骤目录
 *      （delta「文件承载区不附带步骤目录」）。
 *   2. **只有隔离 run 才有文件页**：v1 老 trace 没有文件世界，给它们一个空 tab
 *      等于把"没有"显示成"有"（C 段显示义务）。
 *   3. **页签进阅读状态**：页签属 `readingByRun[runId].tab`，切运行再返回要恢复
 *      （delta「会话内按运行恢复阅读位置」）。
 *
 * ⚠️ 本任务**不**搬移 SpanTree 的挂载位置（那是 5.4 的范围）：这里只把"当前 run 的
 *    页签承载"从 DetailPanel 内部上提到工作区，SpanTree 仍是三栏里的独立一栏。
 *    真正"文件页时卸下步骤目录"由本组件的 `stepsMounted` 传给 App 消费。
 */

import { deriveTerminalReason } from "@shared/derive";
import type { RunSummary } from "@shared/ipc";
import { FileCode2, LayoutDashboard, ListTree } from "lucide-react";
import type { ReactNode } from "react";
import { isIsolatedRun, isolatedRunNoticeView } from "../lib/isolated-fork";
import { useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";
import { RunStatusBadge } from "./RunStatusBadge";

/** 页头需要的最小输入（与 RunDetail 结构相容，便于测试喂纯对象） */
type RunDetailInput = Parameters<typeof isIsolatedRun>[0];

/** 三个平级页签的稳定标识（与 `RunReadingState.tab` 同口径） */
export const WORKSPACE_TABS = ["overview", "steps", "files"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/** 页签显示名与图标（图标 + 文字：名称不靠猜） */
const TAB_META: Record<WorkspaceTab, { label: string; icon: typeof ListTree }> = {
  overview: { label: "概览", icon: LayoutDashboard },
  steps: { label: "步骤", icon: ListTree },
  files: { label: "文件", icon: FileCode2 },
};

/**
 * 该 run 实际可用的页签。
 *
 * **文件页只在合法隔离 run 上出现**：判断依据是 `isIsolatedRun`（要求有效
 * `meta.workspace`），不是"有没有附件"——空文件世界的隔离 run 也该能看到文件页并
 * 得到既有异常说明，而普通 run 不该出现虚假文件页。两者不可混为一谈。
 */
export function availableTabs(isolated: boolean): WorkspaceTab[] {
  return isolated ? ["overview", "steps", "files"] : ["overview", "steps"];
}

/**
 * 恢复页签：保存的 tab 在当前 run 上不可用（如文件页对非隔离 run）⇒ 回退概览。
 *
 * 与 `reconcileReadingState` 同口径，但这里不写状态——只算出"该显示哪个"，
 * 由调用方决定要不要落库（避免渲染期写 store）。
 */
export function resolveVisibleTab(saved: WorkspaceTab, isolated: boolean): WorkspaceTab {
  return availableTabs(isolated).includes(saved) ? saved : "overview";
}

/** 工作区外壳：页头 + 页签栏 + 正文槽 */
export function RunWorkspace({
  tab,
  onTab,
  isIsolated,
  header,
  actions,
  children,
}: {
  tab: WorkspaceTab;
  onTab: (next: WorkspaceTab) => void;
  isIsolated: boolean;
  /** 页头内容（任务/状态/来源由调用方给，本组件不猜数据） */
  header: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const tabs = availableTabs(isIsolated);
  const visible = resolveVisibleTab(tab, isIsolated);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-white">
      {header}

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-gray-200 px-3 py-1">
        <div className="flex items-center gap-1" role="tablist" aria-label="运行工作区页签">
          {tabs.map((key) => {
            const meta = TAB_META[key];
            const Icon = meta.icon;
            const selected = visible === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={selected}
                // 键盘切页签用原生 button 的 Tab 焦点 + aria-selected，不自行实现方向键
                // （完整方向键导航归 4.3/7.3 的键盘实测）
                title={meta.label}
                onClick={() => onTab(key)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-reading-meta ${
                  selected
                    ? "bg-sky-100 font-medium text-sky-900"
                    : "text-gray-600 hover:bg-gray-100"
                } ${FOCUS_RING}`}
              >
                <Icon size={13} aria-hidden="true" focusable="false" role="presentation" />
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>
        {actions ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

/**
 * 空状态：数据目录没有任何运行（也不存在读取失败的文件）。
 *
 * delta「首次打开与无运行入口」要求**可操作的新建和录制入口**，不看营销欢迎页。
 * 两个入口都指向真实动作（同全局栏），不是装饰按钮。
 */
export function NoRunsEmpty({
  onCreate,
  onRecord,
}: {
  onCreate: () => void;
  onRecord: () => void;
}): ReactNode {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-white px-6">
      <div className="text-reading-body text-gray-700">数据目录里还没有运行记录</div>
      <div className="max-w-md text-center text-reading-meta leading-5 text-gray-500">
        可以直接在这里跑一个 run（纯对话或隔离文件运行，不需要代理、不需要写代码），
        也可以在设置里打开录制代理，把你现有 Agent 的 base_url 指过来。
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCreate}
          className={`rounded bg-sky-600 px-3 py-1.5 text-reading-meta text-white hover:bg-sky-700 ${FOCUS_RING}`}
        >
          新建运行
        </button>
        <button
          type="button"
          onClick={onRecord}
          className={`rounded border border-gray-300 px-3 py-1.5 text-reading-meta text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          接入录制
        </button>
      </div>
      <div className="text-reading-meta text-gray-400">
        也可以把已有 *.jsonl 放进数据目录的 traces/ 后重新打开。
      </div>
    </section>
  );
}

/**
 * 运行页头：当前任务、状态与来源。
 *
 * 「保持当前任务、状态和来源可辨」（delta 第一条 requirement）——三者都在这里出现，
 * 不靠颜色单打独斗（状态带文字，见 RunStatusBadge）。
 *
 * ⚠️ 数据来源：任务/模型取**列表摘要**（`runs` 里选中那条），状态取**详情**。
 *    两者不等价——摘要没有 `status` 字段，详情才有；列表还没加载出选中项时
 *    如实显示"尚未选择运行"，不拿别的 run 的摘要顶上。
 *
 * ⚠️ 取值与渲染分离（`RunHeaderView`）：本包无 jsdom，`renderToStaticMarkup` 下
 *    zustand v5 的 `useSyncExternalStore` 会走 `getServerSnapshot`（恒为初始值），
 *    组件测试喂不进状态。故把"数据 → 视图"这一段抽成纯展示组件，配 store 的
 *    薄壳只在真实应用里用。
 */
export function RunHeader({ showSourceSummary = true }: { showSourceSummary?: boolean } = {}) {
  const detail = useAppStore((s) => s.detail);
  const runs = useAppStore((s) => s.runs);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  return (
    <RunHeaderView
      detail={detail}
      runs={runs}
      selectedRunId={selectedRunId}
      showSourceSummary={showSourceSummary}
    />
  );
}

/** 页头展示组件（纯输入 → 输出，测试直接喂数据） */
export function RunHeaderView({
  detail,
  runs,
  selectedRunId,
  showSourceSummary = true,
}: {
  detail: RunDetailInput | null;
  runs: ReadonlyArray<RunSummary>;
  selectedRunId: string | null;
  showSourceSummary?: boolean;
}) {
  const isolated = isIsolatedRun(detail);
  // UI 密度 change 1.3（design D2）：页头只留**紧凑来源摘要**一行——完整的隔离保真
  // 边界由详情提示区（DetailNotices）的「来源与技术详情」disclosure 承载。
  // 此前页头与文件区各自渲染同一段长说明 ⇒ 同屏重复（2026-10-06 实机评审抓到）。
  const noticeView = isolatedRunNoticeView(detail);

  // 摘要可能还没刷出来（刚 fork 出的新 run）⇒ 用详情兜底，但**不**编造任务名
  const summary = runs.find((run) => run.id === selectedRunId) ?? null;
  const task = summary?.task ?? detail?.meta.task ?? null;
  const model = summary?.model ?? null;
  const id = selectedRunId;

  return (
    <div className="border-b border-gray-200 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div
          className="min-w-0 flex-1 basis-[260px] truncate text-reading-body font-medium text-gray-900"
          title={task ?? undefined}
        >
          {task ?? "尚未选择运行"}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-reading-meta text-gray-500">
          {/*
           * 终止原因走**唯一来源** `deriveTerminalReason`（任务 6.2）。
           * 此前这里硬编码 `reason={null}` ⇒ 任何正常结束的 run 在页头都被显示成
           * 「运行中断」，与列表/概览自相矛盾。
           */}
          <RunStatusBadge
            status={detail?.status ?? null}
            reason={
              detail === null
                ? null
                : deriveTerminalReason({ status: detail.status, events: detail.events })
            }
          />
          <span className="font-code" title="运行 ID">
            {id ?? "—"}
          </span>
          <span className="truncate" title={model ?? undefined}>
            {model ?? "—"}
          </span>
          {isolated ? (
            <span className="rounded bg-violet-100 px-1 text-violet-800">文件隔离</span>
          ) : null}
          {!showSourceSummary && detail?.meta.workspace !== undefined ? (
            <span className="text-violet-800" data-source-identity>
              {detail.meta.workspace.origin.kind === "checkpoint"
                ? `父运行 ${detail.meta.workspace.origin.run_id} · 检查点 ${detail.meta.workspace.origin.step_span}`
                : "独立采集的文件世界"}
            </span>
          ) : null}
        </div>
      </div>
      {showSourceSummary && noticeView !== null ? (
        <div
          className="mt-1 text-reading-meta leading-5 text-violet-900"
          data-isolated-compact="true"
        >
          {noticeView.compact}
        </div>
      ) : null}
    </div>
  );
}
