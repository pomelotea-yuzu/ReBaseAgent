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
export function WorkspaceFilesPanel() {
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
   * ⚠️ 只在**目标 run 与当前详情 run 相同**时消费——否则会把 A 的目标落到 B 上
   *    （delta「异步消费目标受 run 与导航代次约束，旧目标不能抢回当前页」）。
   */
  const pendingTarget = useAppStore((s) => s.pendingFileTarget);
  useEffect(() => {
    if (pendingTarget === null || detailId === null) return;
    if (pendingTarget.runId !== detailId) return;
    const { file } = pendingTarget;
    if (file.path === undefined) {
      setFileReading(detailId, { checkpoint: file.stepSpanId, path: null, pane: "list" });
    } else {
      setFileReading(detailId, {
        checkpoint: file.stepSpanId,
        path: file.path,
        pane: "content",
      });
    }
    useAppStore.setState({ pendingFileTarget: null });
  }, [pendingTarget, detailId, setFileReading]);

  return <WorkspaceFilesPanelView detail={detail} loadingDetail={loadingDetail} runId={runId} />;
}

/** 纯展示层：详情就绪挂文件视图，否则如实说明"正在读"还是"还没选"（不留白、不假装有文件） */
export function WorkspaceFilesPanelView({
  detail,
  loadingDetail,
}: {
  detail: RunDetail | null;
  loadingDetail: boolean;
  /** U2：当前 run id（保留入参以便后续接线；本层不消费） */
  runId?: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
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
