import { PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { BranchTree } from "./components/BranchTree";
import { ComparePanel } from "./components/ComparePanel";
import { ConfirmDialogHost } from "./components/ConfirmDialog";
import { CreateRunDialog } from "./components/CreateRunDialog";
import { DetailPanel } from "./components/DetailPanel";
import { DraftCloseLockOverlay } from "./components/DraftCloseLockOverlay";
import { GlobalBar } from "./components/GlobalBar";
import { FOCUS_RING } from "./components/IconButton";
import { OverviewPanel } from "./components/OverviewPanel";
import { RunList } from "./components/RunList";
import { NoRunsEmpty, RunHeader, RunWorkspace, resolveVisibleTab } from "./components/RunWorkspace";
import { SettingsDialog } from "./components/SettingsDialog";
import { SpanTree } from "./components/SpanTree";
import { WorkspaceFilesPanel } from "./components/WorkspaceFilesPanel";
import { isIsolatedRun } from "./lib/isolated-fork";
import { useDraftCloseGuard } from "./lib/use-draft-close-guard";
import { useLayoutState } from "./lib/use-layout";
import { useAppStore } from "./store";

export default function App() {
  const error = useAppStore((s) => s.error);
  const runs = useAppStore((s) => s.runs);
  const failed = useAppStore((s) => s.failed);
  const loadingList = useAppStore((s) => s.loadingList);
  const createDialogOpen = useAppStore((s) => s.createDialogOpen);
  const setCreateDialogOpen = useAppStore((s) => s.setCreateDialogOpen);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const view = useAppStore((s) => s.view);
  const tab = useAppStore((s) =>
    s.selectedRunId === null ? "overview" : s.readingOf(s.selectedRunId).tab,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  // U3 任务 4.2：关闭协商客户端（握手/查询应答/dirty 上报）与输入锁；锁定期渲染全文档遮罩
  const draftCloseLocked = useDraftCloseGuard();

  // 外壳布局（任务 4.3）：断点、宽度偏好、自动折叠。**自动折叠不写回偏好**。
  const layout = useLayoutState({ tab, editing: false });
  const navReplacesWorkspace =
    layout.navVisible && (layout.breakpoint === "narrow" || layout.breakpoint === "single");
  const stepsReplaceWorkspace =
    tab === "steps" && layout.stepsVisible && layout.stepsFullWidth && !navReplacesWorkspace;

  // Replacing the workspace must also move keyboard focus into the visible pane.
  useEffect(() => {
    if (view !== "trace" || (!navReplacesWorkspace && !stepsReplaceWorkspace)) return;
    const pane = document.getElementById(
      navReplacesWorkspace ? "run-navigation" : "steps-navigation",
    );
    const returnSelector = navReplacesWorkspace ? "#run-navigation-toggle" : "[data-open-steps]";
    pane?.querySelector<HTMLElement>(navReplacesWorkspace ? "input" : "button")?.focus();
    return () => {
      const restore =
        document.activeElement === document.body || pane?.contains(document.activeElement);
      if (restore)
        requestAnimationFrame(() => document.querySelector<HTMLElement>(returnSelector)?.focus());
    };
  }, [navReplacesWorkspace, stepsReplaceWorkspace, view]);

  // 挂载时加载一次列表与运行配置。只读工具，不做文件监听——目录内容变化后重新打开即可
  useEffect(() => {
    void (async () => {
      await useAppStore.getState().loadRuns();
      // 首次自动选择（任务 3.5）：列表首次成功加载且尚无选中项时，尝试最近可读摘要
      // 对应的运行并进入概览。只尝试一条——详情失败留在该 run 的原位错误态，不遍历其他记录。
      await useAppStore.getState().autoSelectInitialRun();
    })();
    void useAppStore.getState().loadSettings();
    void useAppStore.getState().loadProxyStatus();
  }, []);

  /** 录制入口（全局栏 / 空态共用）：打开设置并定位到代理分区 */
  const openRecording = (): void => {
    setSettingsSection("proxy");
    setSettingsOpen(true);
  };

  const openSettings = (): void => {
    setSettingsSection(null);
    setSettingsOpen(true);
  };

  const empty = !loadingList && runs.length === 0 && failed.length === 0;

  return (
    <div className="flex h-full flex-col">
      <GlobalBar
        onOpenSettings={openSettings}
        navigation={
          view === "trace"
            ? {
                visible: layout.navVisible && !stepsReplaceWorkspace,
                onToggle:
                  layout.navVisible && !stepsReplaceWorkspace ? layout.closeNav : layout.openNav,
              }
            : undefined
        }
      />

      {error !== null ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700">
          {error}
        </div>
      ) : null}

      {/* 任务 7.1 布局修复：钳定主工作区高度，任何一列超高只在其自身滚动容器内滚动，
          不把 <main> 撑高 → 左列表不再随右侧详情一起整页移动 */}
      <main
        className="relative flex min-h-0 flex-1 overflow-hidden"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          if (navReplacesWorkspace) {
            event.preventDefault();
            layout.closeNav();
          } else if (stepsReplaceWorkspace) {
            event.preventDefault();
            layout.toggleStepsCollapsed();
          }
        }}
      >
        {view === "trace" ? (
          <>
            {/* 运行导航（任务 4.3）：宽度可调 220–360；自动折叠只在显示层生效 */}
            {layout.navVisible && !stepsReplaceWorkspace ? (
              <RunList
                width={layout.navWidth}
                onWidth={layout.setNavWidth}
                onWidthKey={layout.handleNavKey}
                onToggleCollapsed={layout.closeNav}
                fullWidth={navReplacesWorkspace}
                onSelected={layout.navOpened ? layout.closeNav : undefined}
              />
            ) : null}
            {navReplacesWorkspace ? null : empty ? (
              // 无运行时：主工作区给两个**真实可用**的入口（delta「首次打开与无运行入口」），
              // 不是展示性欢迎页。步骤目录此时本就没有内容，一并卸下。
              <NoRunsEmpty onCreate={() => setCreateDialogOpen(true)} onRecord={openRecording} />
            ) : (
              <>
                {/*
                 * 步骤目录（任务 5.4 · design D1）：**只在步骤页挂载**。
                 *
                 * 四条本挂载点负责的边界：
                 *   1. 目录是**步骤页的一部分**，不是常驻第三栏——概览/文件页不挂（D1
                 *      「文件模式不挂 SpanTree」「步骤：可收起目录 + 完整调用详情」；
                 *      delta「文件承载区不附带步骤目录」）。
                 *   2. 宽度可调 200–320；480px 二次约束由 `layout.stepsVisible` 判。
                 *   3. `onToggleCollapsed` 走 `toggleStepsCollapsed`（**唯一**写偏好者）。
                 *   4. 目录卸下时**当前调用身份不丢**（`selectedSpanId` 在 store，
                 *      见 delta「窄窗口收起目录后保留当前调用身份」）。
                 */}
                {tab === "steps" && layout.stepsVisible ? (
                  <SpanTree
                    width={layout.stepsWidth}
                    onWidth={layout.setStepsWidth}
                    onWidthKey={layout.handleStepsKey}
                    onToggleCollapsed={layout.toggleStepsCollapsed}
                    fullWidth={stepsReplaceWorkspace}
                    onSelected={stepsReplaceWorkspace ? layout.toggleStepsCollapsed : undefined}
                  />
                ) : null}
                {!stepsReplaceWorkspace ? (
                  <WorkspaceShell
                    // 窄窗口/用户收起后「重新打开步骤目录」的入口（**在正文里**，不是树内部——
                    // 目录都没挂载，入口自然不能在它里面）
                    onOpenSteps={
                      tab === "steps" && !layout.stepsVisible
                        ? () => layout.setStepsOpened(true)
                        : null
                    }
                  />
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            <BranchTree />
            <ComparePanel />
          </>
        )}
      </main>

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {/* 「新建运行」对话框在 App 层单例：全局栏与列表标题区共用同一个 createDialogOpen */}
      {createDialogOpen ? <CreateRunDialog onClose={() => setCreateDialogOpen(false)} /> : null}
      {/* U3 任务 5.2：放弃确认的单实例模态宿主（requestConfirm 驱动） */}
      <ConfirmDialogHost />
      {/* U3 任务 4.2：关闭核对期间禁止一切新输入（键盘/粘贴由 hook 的捕获监听挡） */}
      {draftCloseLocked ? <DraftCloseLockOverlay /> : null}
    </div>
  );
}

/**
 * 详情列外壳（任务 4.2 / 5.1 / 5.4 / 6.1）。
 *
 * 把「任务头 + 概览/步骤/文件页签 + 正文」从「详情列内部一个开关」上提为工作区承载：
 *   - 页签是**工作区级**的（同一 run 的概览 / 步骤 / 文件），不是详情列内部的局部开关
 *   - 「文件」页签只在合法隔离 run 上出现（`isIsolatedRun` 要求有效的 `meta.workspace`）
 *   - 页签状态进阅读状态（`readingByRun[runId].tab`），切运行再返回要恢复
 *   - **概览页有独立内容**（任务 5.1）：不再把"概览"当成"详情列的另一个名字"
 *   - **文件页是一级承载**（任务 6.1）：`WorkspaceFilesPanel` 与概览同级；此前文件页躲在
 *     `DetailPanel` 一个**不与工作区页签同步的局部 tab** 后面 ⇒ 工作区「文件」页签点不动
 *   - **步骤目录由 App 在 `tab === "steps"` 时挂载**（任务 5.4）：本壳只承载正文，
 *     以及目录被收起时的「重新打开步骤目录」入口（`onOpenSteps`；null = 不显示入口）
 */
function WorkspaceShell({ onOpenSteps }: { onOpenSteps: (() => void) | null }) {
  const detail = useAppStore((s) => s.detail);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const tab = useAppStore((s) =>
    s.selectedRunId === null ? "overview" : s.readingOf(s.selectedRunId).tab,
  );
  const setReadingTab = useAppStore((s) => s.setReadingTab);
  const isolated = isIsolatedRun(detail);
  // 概览是**独立内容**，只有步骤/文件页才落到既有详情列（任务 5.1）
  const visible = resolveVisibleTab(tab, isolated);

  return (
    <RunWorkspace
      tab={tab}
      onTab={(next) => {
        if (selectedRunId === null) return;
        setReadingTab(selectedRunId, next);
      }}
      isIsolated={isolated}
      header={<RunHeader />}
    >
      {visible === "steps" && onOpenSteps !== null ? (
        // 目录被收起（窄窗口或用户显式收起）时，正文顶部给一个真实可用的重开入口
        <StepsDirectoryEntry onOpen={onOpenSteps} />
      ) : null}
      {/*
       * 三分支：概览（5.1）/ 文件（6.1）/ 步骤（其余）。
       * 文件页与概览同级、**都不经 DetailPanel**——DetailPanel 内部那个
       * `trajectory`/`files` 局部 tab 从不与工作区页签同步，是 6.1 修掉的旧形态。
       */}
      {visible === "overview" ? (
        <OverviewPanel />
      ) : visible === "files" ? (
        <WorkspaceFilesPanel />
      ) : (
        <DetailPanel />
      )}
    </RunWorkspace>
  );
}

/**
 * 「重新打开步骤目录」入口（任务 5.4 · delta「保留...重新打开目录的入口」）。
 *
 * 目录收起后**当前调用身份仍保留**（`selectedSpanId` 在 store，卸载不丢）——
 * 故这里只负责"把目录要回来"，不提示"选择会被重置"（那会是假承诺）。
 * 收起是**临时**的：点这里走 `stepsOpened` 临时打开，不动用户偏好（D2）。
 *
 * ⚠️ 导出供测试直接渲染（本包无 jsdom，`renderToStaticMarkup` 只做静态结构断言）：
 *    入口必须是**真实可点的 button**，不是一段说明文字。
 */
export function StepsDirectoryEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="border-b border-gray-200 px-4 py-1.5">
      <button
        data-open-steps
        type="button"
        onClick={onOpen}
        className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-reading-meta text-gray-600 hover:bg-gray-100 ${FOCUS_RING}`}
      >
        <PanelLeftOpen size={13} aria-hidden="true" focusable="false" role="presentation" />
        <span>重新打开步骤目录</span>
      </button>
    </div>
  );
}
