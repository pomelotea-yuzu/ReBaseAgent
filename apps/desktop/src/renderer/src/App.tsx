import { useEffect, useState } from "react";
import { BranchTree } from "./components/BranchTree";
import { ComparePanel } from "./components/ComparePanel";
import { CreateRunDialog } from "./components/CreateRunDialog";
import { DetailPanel } from "./components/DetailPanel";
import { GlobalBar } from "./components/GlobalBar";
import { RunList } from "./components/RunList";
import { NoRunsEmpty, RunHeader, RunWorkspace } from "./components/RunWorkspace";
import { SettingsDialog } from "./components/SettingsDialog";
import { SpanTree } from "./components/SpanTree";
import { isIsolatedRun } from "./lib/isolated-fork";
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

  // 外壳布局（任务 4.3）：断点、宽度偏好、自动折叠。**自动折叠不写回偏好**。
  const layout = useLayoutState({ tab, editing: false });

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
      <GlobalBar onOpenSettings={openSettings} />

      {error !== null ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-[11px] text-red-700">
          {error}
        </div>
      ) : null}

      <main className="relative flex min-h-0 flex-1">
        {view === "trace" ? (
          <>
            {/* 运行导航（任务 4.3）：宽度可调 220–360；自动折叠只在显示层生效 */}
            {layout.navVisible ? (
              <RunList
                width={layout.navWidth}
                onWidth={layout.setNavWidth}
                onWidthKey={layout.handleNavKey}
                onToggleCollapsed={layout.toggleNavCollapsed}
              />
            ) : null}
            {empty ? (
              // 无运行时：主工作区给两个**真实可用**的入口（delta「首次打开与无运行入口」），
              // 不是展示性欢迎页。步骤目录此时本就没有内容，一并卸下。
              <NoRunsEmpty onCreate={() => setCreateDialogOpen(true)} onRecord={openRecording} />
            ) : (
              <>
                {/* 步骤目录（任务 4.3）：宽度可调 200–320；480px 二次约束不满足时自动收起 */}
                {layout.stepsVisible ? (
                  <SpanTree
                    width={layout.stepsWidth}
                    onWidth={layout.setStepsWidth}
                    onWidthKey={layout.handleStepsKey}
                  />
                ) : null}
                <WorkspaceShell />
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
    </div>
  );
}

/**
 * 详情列外壳（任务 4.2）。
 *
 * 把「任务头 + 概览/步骤/文件页签 + 正文」从「详情列内部一个开关」上提为工作区承载：
 *   - 页签是**工作区级**的（同一 run 的概览 / 步骤 / 文件），不是详情列内部的局部开关
 *   - 「文件」页签只在合法隔离 run 上出现（`isIsolatedRun` 要求有效的 `meta.workspace`）
 *   - 页签状态进阅读状态（`readingByRun[runId].tab`），切运行再返回要恢复
 *
 * ⚠️ 本任务**不**把 SpanTree 从三栏里搬走（那是 5.4 的范围）：这里只承载详情列，
 *    SpanTree 仍是左侧独立一栏。故 `steps` 在本壳里等价于既有的「轨迹」详情
 *    （步骤目录始终在左栏可见），与 DetailPanel 内部 tab 的 `trajectory` 同义。
 */
function WorkspaceShell() {
  const detail = useAppStore((s) => s.detail);
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const tab = useAppStore((s) =>
    s.selectedRunId === null ? "overview" : s.readingOf(s.selectedRunId).tab,
  );
  const setReadingTab = useAppStore((s) => s.setReadingTab);
  const isolated = isIsolatedRun(detail);

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
      <DetailPanel />
    </RunWorkspace>
  );
}
