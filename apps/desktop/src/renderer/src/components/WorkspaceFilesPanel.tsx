import type { RunDetail } from "@shared/ipc";
import { useEffect } from "react";
import { useAppStore } from "../store";
import { DetailNotices } from "./DetailNotices";
import { WorkspaceFileView } from "./WorkspaceFileView";

/**
 * 文件页承载（U1 任务 6.1）。
 *
 * 背景——**修的是一个真实断裂的只读阅读路径**：此前 `WorkspaceFileView` 挂在
 * `DetailPanel` 内部的 `tab === "files"` 分支上，而那个 `tab` 是**组件局部
 * `useState("trajectory" | "files")`，从不与 store 的工作区页签同步**。于是点工作区
 * 顶部的「文件」页签时（`visible === "files"` → 仍渲染 `DetailPanel`），内部 tab 还是
 * `"trajectory"` ⇒ **文件视图根本不出现**；文件页只能靠步骤页里那个遗留的「文件」小按钮
 * 进入，两套页签并存且语义分叉。
 *
 * 本组件把文件页上提为**与概览页同级**的一级承载：App 在 `visible === "files"` 时挂它，
 * `DetailPanel` 回归纯步骤页（内部遗留的 `trajectory`/`files` 切换已删除）。
 *
 * 三条边界：
 *   1. **不附带步骤目录**：步骤目录由 App 只在 `tab === "steps"` 时挂载（design D1）
 *      ⇒ 文件页天然没有它（delta「文件承载区不附带步骤目录」）。
 *   2. **保留隔离说明与异常**：与步骤页共用 `DetailNotices`（隔离来源 / 源记录不可用 /
 *      阅读位置失效 / 分支关系 / 错误详情缺失 / 父链）——文件页同样需要知道"这个世界
 *      从哪来"，否则用户会在来历不明的清单上做判断。
 *   3. **按 run 硬重挂载**（`key`）：检查点编号体系随 run 变化，绝不让上一个 run 的
 *      文件选择串到下一个 run（`WorkspaceFileView` 自身也复位，这里是第二道保险）。
 *
 * ⚠️ 取值与渲染分离（`WorkspaceFilesPanelView`）：本包无 jsdom，`renderToStaticMarkup`
 *    下 zustand v5 走 `getServerSnapshot`（恒初始值）⇒ 组件测试喂不进状态。把
 *    "数据 → 视图"抽成纯展示组件，测试才能直接喂 `detail` 钉住"详情就绪时**真的**挂上
 *    文件视图"（源码字符串断言做不到这件事）。
 */
export function WorkspaceFilesPanel({
  focusActive = false,
  focusControlsInHeader = false,
  onEnterFocus,
  onExitFocus,
}: {
  /** UI 密度 2.4：专注差异态（App 层按当前工作区身份比对生效；显示覆盖，不写偏好） */
  readonly focusActive?: boolean;
  readonly focusControlsInHeader?: boolean;
  readonly onEnterFocus?: (mode: "edit" | "diff") => void;
  readonly onExitFocus?: () => void;
}) {
  const detail = useAppStore((s) => s.detail);
  const loadingDetail = useAppStore((s) => s.loadingDetail);
  const runId = useAppStore((s) => s.selectedRunId);
  const setFileReading = useAppStore((s) => s.setFileReading);
  const detailId = detail?.meta.id ?? null;

  /**
   * U2 任务 2.3（接线）：消费**一次性显式文件目标**。
   *
   * 目标由 `selectRun`/定位入口存入 store 的 `pendingFileTarget`，本组件在详情就绪后
   * **消费一次**（清空），把 file 目标落到该 run 的文件阅读状态上：
   * - 有 `path` ⇒ 选中该 path 并把 pane 切到 content（delta「有 path 时显示目标内容」）；
   * - 无 `path` ⇒ 清空旧文件选择并显示列表（delta「无 path 时显示未选文件的列表」）。
   *
   * ⚠️ 有 path 时**必须同时清空搜索并切 `all`**（design D2 原文：「指定合法 path 则显示
   *    内容、**清空阻挡它的搜索并切 all**」）。否则定位"成功"了、内容也显示了，但目标在
   *    列表里仍被搜索词/变化筛选隐藏 —— 用户看不到"它在哪里"，这正是 5.3「搜索隐藏选择」
   *    场景要抓的形态。
   *
   * ⚠️ **无 path 时同样要清空搜索并切 `all`**：定位目的是"显示未选文件的列表"（design D2
   *    原文：「显式目标未指定 path 时清空旧文件选择并显示列表」）。若上一次留下的搜索词/
   *    筛选把清单筛空，用户点「打开该轮文件」后看到的是**空列表**——"显示了列表"却一个文件
   *    都看不到，与"显示列表"的意图相反。这是 5.3 实机抓到的缺口（原本只清有 path 的那支）。
   *
   * ⚠️ 只在**目标 run 与当前详情 run 相同**时消费——否则会把 A 的目标落到 B 上
   *    （delta「异步消费目标受 run 与导航代次约束，旧目标不能抢回当前页」）。
   */
  const pendingTarget = useAppStore((s) => s.pendingFileTarget);
  useEffect(() => {
    if (pendingTarget === null || detailId === null) return;
    if (pendingTarget.runId !== detailId) return;
    const { file } = pendingTarget;
    if (file.path === undefined) {
      setFileReading(detailId, {
        checkpoint: file.stepSpanId,
        path: null,
        pane: "list",
        query: "",
        filter: "all",
      });
    } else {
      setFileReading(detailId, {
        checkpoint: file.stepSpanId,
        path: file.path,
        pane: "content",
        query: "",
        filter: "all",
      });
    }
    useAppStore.setState({ pendingFileTarget: null });
  }, [pendingTarget, detailId, setFileReading]);

  return (
    <WorkspaceFilesPanelView
      detail={detail}
      loadingDetail={loadingDetail}
      runId={runId}
      focusActive={focusActive}
      focusControlsInHeader={focusControlsInHeader}
      onEnterFocus={onEnterFocus}
      onExitFocus={onExitFocus}
    />
  );
}

/**
 * 纯展示层：详情就绪挂文件视图，否则如实说明"正在读"还是"还没选"（不留白、不假装有文件）。
 *
 * UI 密度 2.4：专注差异时顶部渲染专注栏（目标说明 + 退出入口常驻；spec「专注中
 * 目标和恢复操作可见」）；未专注时给「专注差异」进入入口。DetailNotices
 * （异常摘要）**保留**——专注折叠的是辅助区，异常与门禁摘要不随专注隐藏
 * （spec「异常摘要始终可见」）。
 */
export function WorkspaceFilesPanelView({
  detail,
  loadingDetail,
  focusActive = false,
  focusControlsInHeader = false,
  onEnterFocus,
  onExitFocus,
}: {
  detail: RunDetail | null;
  loadingDetail: boolean;
  /** U2：当前 run id（保留入参以便后续接线；本层不消费） */
  runId?: string | null;
  readonly focusActive?: boolean;
  readonly focusControlsInHeader?: boolean;
  readonly onEnterFocus?: (mode: "edit" | "diff") => void;
  readonly onExitFocus?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {focusActive && !focusControlsInHeader ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-violet-200 bg-violet-50 px-3 py-1"
          data-focus-bar="files-diff"
        >
          <span className="text-[11px] font-medium text-violet-900">
            专注差异 · 辅助列表与步骤目录已临时收起（目标与阅读状态不变，退出后按原偏好恢复）
          </span>
          <button
            type="button"
            data-exit-focus="true"
            onClick={onExitFocus}
            className="ml-auto rounded border border-violet-300 bg-white px-2 py-0.5 text-[11px] text-violet-900 hover:bg-violet-100"
          >
            退出专注
          </button>
        </div>
      ) : null}
      {!focusActive && !focusControlsInHeader && onEnterFocus !== undefined ? (
        <div className="shrink-0 border-b border-gray-100 px-3 py-1">
          <button
            type="button"
            data-enter-focus="diff"
            onClick={() => onEnterFocus("diff")}
            title="临时收起运行列表与步骤目录，把空间让给文件差异（退出后按原偏好恢复）"
            className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
          >
            专注差异
          </button>
        </div>
      ) : null}
      {/* 异常摘要**始终可见**（不随专注隐藏——spec「异常摘要始终可见」；2.4 改造时误删，回归钉住） */}
      <DetailNotices />
      <div className="min-h-0 flex-1">
        {detail !== null ? (
          <WorkspaceFileView key={detail.meta.id} run={detail} />
        ) : (
          <div className="px-4 py-6 text-xs text-gray-500">
            {loadingDetail ? "正在读取运行详情…" : "尚未选择运行。"}
          </div>
        )}
      </div>
    </div>
  );
}
