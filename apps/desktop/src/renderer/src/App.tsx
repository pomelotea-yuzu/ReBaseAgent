import { PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { BranchTree } from "./components/BranchTree";
import { CompareSelectionBar } from "./components/CompareSelectionBar";
import { CompareWorkspace } from "./components/CompareWorkspace";
import { ConfirmDialogHost } from "./components/ConfirmDialog";
import { CreateRunWorkspace } from "./components/CreateRunWorkspace";
import { DetailPanel } from "./components/DetailPanel";
import { DraftCloseLockOverlay } from "./components/DraftCloseLockOverlay";
import { GlobalBar } from "./components/GlobalBar";
import { FOCUS_RING } from "./components/IconButton";
import { OverviewPanel } from "./components/OverviewPanel";
import { ResultLiveRegion } from "./components/ResultLiveRegion";
import { RunList } from "./components/RunList";
import { NoRunsEmpty, RunHeader, RunWorkspace, resolveVisibleTab } from "./components/RunWorkspace";
import { SettingsDialog } from "./components/SettingsDialog";
import { SpanTree } from "./components/SpanTree";
import { WorkspaceFilesPanel } from "./components/WorkspaceFilesPanel";
import { isIsolatedRun } from "./lib/isolated-fork";
import {
  COMPARE_STACK_THRESHOLD,
  decideCompareBodyLayout,
  decideCompareNavVisible,
} from "./lib/compare-navigation";
import { useDraftCloseGuard } from "./lib/use-draft-close-guard";
import { useContentWidth, useLayoutState } from "./lib/use-layout";
import { useAppStore } from "./store";

export default function App() {
  const error = useAppStore((s) => s.error);
  const runs = useAppStore((s) => s.runs);
  const failed = useAppStore((s) => s.failed);
  const loadingList = useAppStore((s) => s.loadingList);
  const openCreateWorkspace = useAppStore((s) => s.openCreateWorkspace);
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
  const contentWidth = useContentWidth();
  const navReplacesWorkspace =
    layout.navVisible && (layout.breakpoint === "narrow" || layout.breakpoint === "single");
  // U5 任务 4.1：创建工作区自带正文，不参与"步骤目录占满工作区"的形态
  const stepsReplaceWorkspace =
    view === "trace" &&
    tab === "steps" &&
    layout.stepsVisible &&
    layout.stepsFullWidth &&
    !navReplacesWorkspace;
  // U7 5.8：比较页的导航可见性（窄窗默认收起、退出恢复——纯显示决策，不写偏好）
  const navShowing =
    view === "compare"
      ? decideCompareNavVisible({ view, breakpoint: layout.breakpoint, navVisible: layout.navVisible })
      : layout.navVisible && !stepsReplaceWorkspace;
  // U7 5.8：双运行正文的容器宽度（导航占位扣除后）决定并排/上下排列
  const compareBodyLayout = decideCompareBodyLayout(
    contentWidth - (navShowing ? layout.navWidth : 0),
    COMPARE_STACK_THRESHOLD,
  );

  // Replacing the workspace must also move keyboard focus into the visible pane.
  useEffect(() => {
    if (view === "tree" || (!navReplacesWorkspace && !stepsReplaceWorkspace)) return;
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
    // U4 任务 4.5：挂载即与 main 握手一次并"接着核对"——同 main 重载要恢复在跑的操作与
    // 已有终态/封禁（不重发、不以空草稿仓库解除活跃锁）；空闲会话不会因此持续打 IPC。
    void useAppStore.getState().ensureOperationStatusPolling();
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
        // U5 6.7 实机坐实的接线缺陷修复：录制入口必须走**不清 settingsSection** 的开器——
        // 此前 GlobalBar 只拿到 openSettings（先清 section 再开）⇒ "proxy" 标记在挂载前
        // 就被清掉，设置模态的定位效果（滚到代理分区 + 聚焦首控件）从不发生
        onOpenRecording={openRecording}
        navigation={
          view !== "tree"
            ? {
                visible: navShowing,
                onToggle: navShowing ? layout.closeNav : layout.openNav,
              }
            : undefined
        }
      />

      {/* U5 任务 5.2：全局结果通知区——挂在外壳上，独立于操作面板的开合与当前视图 */}
      <ResultLiveRegion />

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
        {view === "tree" ? (
          <>
            <BranchTree />
            {/* U7 5.2：树视图只保留**对照选择栏**（窄侧栏已替换）；指标对照与
                双运行正文在完整工作区内打开（delta「界面提供分支树与轨迹两种视图」） */}
            <CompareSelectionBar />
          </>
        ) : (
          <>
            {/* 运行导航（任务 4.3）：宽度可调 220–360；自动折叠只在显示层生效。
                U5 任务 4.1：创建工作区同样**保留**它（delta「主工作区显示单列表单且运行导航保留」）。
                U7 5.8：比较页窄窗默认收起（navShowing 已按视图分流）。 */}
            {navShowing ? (
              <RunList
                width={layout.navWidth}
                onWidth={layout.setNavWidth}
                onWidthKey={layout.handleNavKey}
                onToggleCollapsed={layout.closeNav}
                fullWidth={navReplacesWorkspace}
                onSelected={layout.navOpened ? layout.closeNav : undefined}
              />
            ) : null}
            {navReplacesWorkspace ? null : view === "compare" ? (
              // U7 任务 4.12：比较工作区（双运行 + 编辑证据 + 步骤目录 + 指标表）。
              // U7 5.8：正文容器宽度决定并排/上下排列（窄窗上下排列且标题重复）。
              <CompareWorkspace stacked={compareBodyLayout === "stacked"} />
            ) : view === "create" ? (
              // 创建 = 主工作区的一个页面（不是覆盖模态）：切运行、去设置、读文件都不被它挡住。
              // 就近的「运行配置」入口复用 App 的开设置通道（组件不自建第二份设置状态）。
              <CreateRunWorkspace onOpenSettings={openSettings} />
            ) : empty ? (
              // 无运行时：主工作区给两个**真实可用**的入口（delta「首次打开与无运行入口」），
              // 不是展示性欢迎页。步骤目录此时本就没有内容，一并卸下。
              <NoRunsEmpty onCreate={openCreateWorkspace} onRecord={openRecording} />
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
        )}
      </main>

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {/* U5 任务 4.1：创建不再是 App 层的模态单例，而是主工作区的一个视图
          （上面 `view === "create"` 那一支）；全局栏与列表标题区共用 `openCreateWorkspace` */}
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
      header={
        <>
          {/* U7 5.6：比较打开单侧后（pair 保留在 store），页头给常驻「返回比较」入口 */}
          <ReturnToCompareBar />
          <RunHeader />
        </>
      }
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
 * 「返回比较」栏（U7 任务 5.6 · 场景「分别打开文件并返回比较」）。
 *
 * 比较打开单侧运行/调用/文件页后，pair 与来源引用都保留在 store（2.3 纪律）——
 * 这里给一个**常驻可见**的回程入口，不依赖用户记得某个隐藏动作。
 * returnToCompare 同 pair 幂等（不重读，会话结论与阅读位置保留）。
 */
export function ReturnToCompareBar() {
  const comparePair = useAppStore((s) => s.comparePair);
  const returnToCompare = useAppStore((s) => s.returnToCompare);
  if (comparePair === null) return null;
  return (
    <div className="flex items-center gap-2 border-b border-gray-200 bg-sky-50 px-3 py-1">
      <button
        type="button"
        aria-label="返回比较工作区"
        onClick={() => {
          returnToCompare();
          // U7 5.9：异步焦点——返回后焦点落到比较工作区主容器（不落页顶、不丢位置）
          requestAnimationFrame(() => {
            document.querySelector<HTMLElement>("[data-compare-primary]")?.focus();
          });
        }}
        className={`rounded border border-sky-200 px-2 py-0.5 text-reading-meta text-sky-900 hover:bg-sky-100 ${FOCUS_RING}`}
      >
        返回比较
      </button>
      <span className="text-reading-meta text-gray-500">
        比较对象已保留：左 {comparePair.leftRunId} → 右 {comparePair.rightRunId}
      </span>
    </div>
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
