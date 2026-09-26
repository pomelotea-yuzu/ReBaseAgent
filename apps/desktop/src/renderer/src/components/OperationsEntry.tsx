import { Waypoints } from "lucide-react";
import { useState } from "react";
import { type OperationRow, deriveOperationRows, operationBadge } from "../lib/operation-list";
import { useAppStore } from "../store";
import { FOCUS_RING } from "./IconButton";

/**
 * U4 任务 4.7：全局栏的**最小操作入口**。
 *
 * 只呈现 main 给得出的事实：类型、目标定位、running/settled/notAccepted/unknown、
 * 可信 runIds、受控诊断条数。**没有**进度百分比、"第几步"、停止/取消按钮
 * （spec 明令不显示虚构阶段与取消能力；取消归 U5）。
 *
 * 两个动作走两条不同通道，界面上就不可能混用：
 * - 「核对状态」→ `operations:reconcile(operationId)`（只读操作事实，不读 run 文件）；
 * - 「打开记录」→ 既有运行详情通道（`reopenRun(runId)`：同一 ID 也真的重读，含 v1/v2 版本守卫）。
 * 读取失败只允许按同一 runId 重试读取，**不会**重新执行，也不会去核对另一个 ID。
 *
 * 结果一律**由用户明确打开**：核对、轮询、快照更新都不改当前页面（design D6 末段）。
 */

const PHASE_STYLES: Record<OperationRow["phase"], string> = {
  running: "border-sky-300 bg-sky-50 text-sky-800",
  settled: "border-gray-200 bg-gray-50 text-gray-600",
  notAccepted: "border-amber-300 bg-amber-50 text-amber-800",
  unknown: "border-violet-300 bg-violet-50 text-violet-800",
};

const PHASE_LABELS: Record<OperationRow["phase"], string> = {
  running: "执行中",
  settled: "已收口",
  notAccepted: "未接受",
  unknown: "待核对",
};

function OperationRowView({
  row,
  onReconcile,
  onOpenRun,
}: {
  row: OperationRow;
  onReconcile: (operationId: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <li className="mt-1 rounded border border-gray-200 bg-white p-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${PHASE_STYLES[row.phase]}`}
        >
          {PHASE_LABELS[row.phase]}
        </span>
        <span className="min-w-0 break-all text-[11px] font-semibold text-gray-800">
          {row.kindLabel ?? "（类型未知）"}
        </span>
        <button
          type="button"
          onClick={() => {
            onReconcile(row.operationId);
          }}
          title={`operations:reconcile(${row.operationId})——只核对操作事实，不读运行文件`}
          className={`ml-auto shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
        >
          核对状态
        </button>
      </div>
      <div className="mt-0.5 break-all text-[10px] leading-4 text-gray-500">{row.targetText}</div>
      <div className="break-all font-code text-[10px] leading-4 text-gray-400">
        操作 {row.operationId}
      </div>
      <div className="mt-0.5 text-[10px] leading-4 text-gray-600">{row.hint}</div>
      {row.runLinks.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {row.runLinks.map((link) => (
            <li key={link.runId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 break-all font-code text-[10px] text-gray-700">
                {link.runId}
              </span>
              <span className="text-[10px] text-gray-400">{link.note}</span>
              <button
                type="button"
                onClick={() => {
                  onOpenRun(link.runId);
                }}
                title={`按既有运行详情通道读取 ${link.runId}（读取失败只重试读取，不会重新执行）`}
                className={`ml-auto shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
              >
                打开记录
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {row.experimentId !== null ? (
        <div className="mt-0.5 break-all font-code text-[10px] text-gray-400">
          实验 {row.experimentId}
        </div>
      ) : null}
      {row.diagnosticCount > 0 ? (
        <div className="mt-0.5 text-[10px] leading-4 text-gray-500">
          另有 {row.diagnosticCount} 条受控诊断（不含正文与凭据）
        </div>
      ) : null}
    </li>
  );
}

export function OperationsEntry() {
  const session = useAppStore((s) => s.operations);
  const reconcileOperation = useAppStore((s) => s.reconcileOperation);
  const reopenRun = useAppStore((s) => s.reopenRun);
  const refreshOperationStatus = useAppStore((s) => s.refreshOperationStatus);
  const [open, setOpen] = useState(false);
  const rows = deriveOperationRows(session);
  const badge = operationBadge(rows);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open ? "true" : "false"}
        aria-controls="operations-panel"
        onClick={() => {
          // 打开即读一次当前状态（spec：查询可在握手、提交返回、窗口重新获得焦点与用户点击时触发）
          if (!open) void refreshOperationStatus();
          setOpen((prev) => !prev);
        }}
        title="本会话的主动操作登记（只存主进程内存；关闭应用即清空）"
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded border px-2 py-0.5 text-reading-meta ${
          badge.attention
            ? "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100"
            : "border-gray-300 text-gray-700 hover:bg-gray-50"
        } ${FOCUS_RING}`}
      >
        <Waypoints size={12} aria-hidden="true" focusable="false" role="presentation" />
        {badge.label}
      </button>
      {open ? (
        <div
          id="operations-panel"
          className="absolute right-0 top-full z-40 mt-1 max-h-80 w-96 max-w-[90vw] overflow-y-auto rounded border border-gray-200 bg-white p-2 shadow-xl"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-gray-700">本会话操作</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  void refreshOperationStatus();
                }}
                className={`rounded px-1.5 py-0.5 text-[11px] text-gray-600 hover:bg-gray-100 ${FOCUS_RING}`}
                title="重新读取主进程的操作快照（只读）"
              >
                刷新
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className={`rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 ${FOCUS_RING}`}
                aria-label="关闭操作列表"
              >
                ✕
              </button>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="px-1 py-2 text-[11px] leading-4 text-gray-500">
              本会话还没有主动操作：新建运行、结果重跑、改提示词、代理重发或模型 A/B
              提交后，会在这里显示真实状态与可信运行 ID。
            </p>
          ) : (
            <ul>
              {rows.map((row) => (
                <OperationRowView
                  key={row.key}
                  row={row}
                  onReconcile={(operationId) => {
                    void reconcileOperation(operationId);
                  }}
                  onOpenRun={(runId) => {
                    // 明确打开：只有这个动作会切页面；核对与轮询都不导航
                    setOpen(false);
                    void reopenRun(runId);
                  }}
                />
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] leading-4 text-gray-400">
            「核对状态」只查操作登记（不读运行文件）；「打开记录」按运行 ID 走既有详情通道。
            登记不显示进度或取消按钮——主进程没有这些事实。
          </p>
        </div>
      ) : null}
    </div>
  );
}
