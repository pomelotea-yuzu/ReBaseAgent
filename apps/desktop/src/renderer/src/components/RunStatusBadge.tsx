/**
 * 运行状态徽章（U1 任务 4.2 提取；6.2 改为共享判据驱动）。
 *
 * 从 `RunList` 内部提到独立文件，供「运行列表」「运行工作区页头」「分支树节点」**共用同一份
 * 口径**——三处各写一份最容易演变成「列表说运行中断、页头说已完成、树说正常绿」这类
 * 自相矛盾的界面（6.2 之前正是如此：列表/页头走 `reasonLabel` + 硬编码配色，树另有
 * `statusDotClass`，只有概览走了 `classifyOutcome`）。
 *
 * ⚠️ **判据与配色一律来自 `classifyOutcome` / `outcomeBadgeClass`（唯一来源）**：
 *    - `completed` 只表示封存 ⇒ 文案是「已结束」，**不是**「已完成」（不暗示质量已验证）
 *    - `error` ⇒ 红、`max_iterations`/`budget_exceeded` ⇒ 琥珀、`aborted`/`crashed`/未知 ⇒ 中性
 *    - `crashed` ⇒ 「运行中断」且**中性色**（不是执行中，也不该用琥珀暗示"有问题"）
 *    - 未知 reason ⇒ 「结束原因未知」，**原值放 title 可查看**（不丢、不猜）
 *    - **工具错误不参与**：工具曾出错但正常结束仍是「已结束」
 *      （delta「不将工具错误数当作整次运行失败」，出错数由列表单独呈现）
 *
 * 纪律：状态**带文字**，不靠颜色单打独斗（delta「长内容和状态无需仅靠颜色理解」）。
 */

import { classifyOutcome, outcomeBadgeClass } from "@shared/outcome";
import type { Outcome } from "@shared/outcome";

/** 未知/中断/中止等"非成功"结局的补充说明（title，不占正文） */
function outcomeHint(outcome: Outcome): string | undefined {
  switch (outcome.kind) {
    case "interrupted":
      return "进程中断，无终止事件";
    case "unknown":
      // 未知原因时把**原值**放出来（delta：保留可查看的原值）
      return outcome.reason === null ? "没有记录终止原因" : `原始结束原因：${outcome.reason}`;
    case "aborted":
      return "运行被中止（非正常结束）";
    default:
      return undefined;
  }
}

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

  const outcome = classifyOutcome({ status, reason });
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-reading-meta leading-4 ${outcomeBadgeClass(
        outcome.tone,
      )}`}
      title={outcomeHint(outcome)}
    >
      {outcome.label}
    </span>
  );
}
