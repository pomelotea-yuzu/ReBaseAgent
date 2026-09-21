/**
 * 运行状态徽章（U1 任务 4.2 提取）。
 *
 * 从 `RunList` 内部提到独立文件，供「运行列表」与「运行工作区页头」**共用同一份口径**——
 * 两处各写一份最容易演变成「列表说运行中断、页头说已完成」这类自相矛盾的界面。
 *
 * 纪律：状态**带文字**，不靠颜色单打独斗（delta「长内容和状态无需仅靠颜色理解」）。
 * 结束原因走 `reasonLabel`（未知原因保留原值，不猜、不折叠成"其他"）。
 */

import { reasonLabel } from "../lib/format";

export function RunStatusBadge({
  status,
  reason,
}: {
  /** null = 详情尚未加载（此时不给状态结论） */
  status: "completed" | "crashed" | null;
  reason: string | null;
}) {
  if (status === null) {
    // 尚未读到状态 ⇒ 如实说"未知"，不默认成"已完成"（缺省 ≠ 成功）
    return (
      <span className="inline-flex shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-reading-meta leading-4 text-gray-600">
        状态未知
      </span>
    );
  }

  const crashed = status === "crashed";
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-reading-meta leading-4 ${
        crashed ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
      }`}
      title={crashed ? "进程中断，无终止事件" : undefined}
    >
      {crashed ? "运行中断" : reasonLabel(reason)}
    </span>
  );
}
