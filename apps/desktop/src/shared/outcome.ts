/**
 * 结局分类与语义样式映射（U1 共用派生 · 任务 2.1）。
 *
 * 这是列表徽标、概览头、既有分支树节点**唯一**的结局判据来源——同一份数据只写一处，
 * 避免列表说「已结束」而树节点说「出错终止」这类同库自相矛盾。
 *
 * 纪律（对应 desktop-ui delta「run 列表从 traces 目录扫描派生」的状态段）：
 * - **不放宽 schema、不扩充 status 枚举**：`status` 仍只有 `completed` / `crashed` 两态；
 *   更细的结局由 `status + reason` 组合分类得出，`reason` 是既有的 `RunEvent.reason` 枚举。
 * - **不把封存等同于成功**：`completed` 只表示「已结束」，status 文字不得暗示质量验证或测试通过。
 * - **不把无结束记录等同于执行中**：`crashed`（无终止事件）显示「运行中断」，不是「进行中」。
 * - **未知原因保留原值并标为未知**，不回退成「已完成」。
 * - **语义色不只靠颜色**：每种结局都带文字标签，颜色只是辅助。
 * - **event/reason 矛盾以 reason 为准**：`reason` 是既有的稳定枚举，`event` 只用于诊断；
 *     两者不可能矛盾（同一 schema 产出），但若手工编辑文件造出矛盾，按 reason 展示并交由
 *     测试覆盖「矛盾时不静默改判」。
 */

/** 结局种类（由 status + reason 组合得来，不是新的 status 枚举） */
export type OutcomeKind =
  | "completed" // 正常结束（有 completed 终止事件）
  | "error" // 出错终止（有 error 终止事件）
  | "max_iterations" // 达到迭代上限
  | "budget_exceeded" // 超出预算
  | "aborted" // 已中止
  | "interrupted" // 运行中断（无终止事件，status = crashed）
  | "unknown"; // 结束原因未知（有终止事件但 reason 不在既有枚举内）

/** 语义色调（列表/概览/树节点共用；语义色配合文字，不单独承载信息） */
export type OutcomeTone = "success" | "danger" | "warn" | "neutral";

export interface Outcome {
  kind: OutcomeKind;
  /** 中文短标签（唯一文案来源，禁止各组件各写一份） */
  label: string;
  tone: OutcomeTone;
  /** 归属类别，供筛选/统计使用（completed 之外一律为非正常结束） */
  normalEnd: boolean;
  /** 原始 reason（未知原因时保留原值，供排查；正常与中断为 null） */
  reason: string | null;
}

/** 已知终止原因集合（与 `RunEvent.reason` schema 枚举一致，只读不改） */
const KNOWN_REASONS = new Set([
  "completed",
  "error",
  "max_iterations",
  "budget_exceeded",
  "aborted",
]);

/**
 * 结局分类。入参为 `RunSummary` / `RunDetail` / 树节点共同持有的最小形状。
 *
 * 优先级（刻意如此）：
 * 1. `status === "crashed"`（无终止事件）⇒ `interrupted`——**盖过**任何 reason，
 *    因为 crashed 的语义就是「没有结束记录」，此时即便残留 reason 也不可信。
 * 2. 无 reason 但 status 为 completed（数据异常）⇒ `unknown`，不冒充正常结束。
 * 3. reason 不在既有枚举 ⇒ `unknown`，保留原值。
 * 4. 其余按 reason 一一映射。
 */
export function classifyOutcome(input: {
  status: "completed" | "crashed";
  reason: string | null;
}): Outcome {
  if (input.status === "crashed") {
    // 无终止事件：运行中断。不因残留 reason 改判（无结束记录就是无结束记录）。
    return {
      kind: "interrupted",
      label: "运行中断",
      tone: "neutral",
      normalEnd: false,
      reason: null,
    };
  }

  const reason = input.reason;
  if (reason === null) {
    // completed 却没有终止原因：数据异常，保留未知，不冒充「已完成」
    return {
      kind: "unknown",
      label: "结束原因未知",
      tone: "neutral",
      normalEnd: false,
      reason: null,
    };
  }

  switch (reason) {
    case "completed":
      return { kind: "completed", label: "已结束", tone: "success", normalEnd: true, reason };
    case "error":
      return { kind: "error", label: "出错终止", tone: "danger", normalEnd: false, reason };
    case "max_iterations":
      return {
        kind: "max_iterations",
        label: "达到迭代上限",
        tone: "warn",
        normalEnd: false,
        reason,
      };
    case "budget_exceeded":
      return { kind: "budget_exceeded", label: "超出预算", tone: "warn", normalEnd: false, reason };
    case "aborted":
      return { kind: "aborted", label: "已中止", tone: "neutral", normalEnd: false, reason };
    default:
      // 未知原因：保留原值（不丢弃，供排查），但明确标为未知
      return { kind: "unknown", label: "结束原因未知", tone: "neutral", normalEnd: false, reason };
  }
}

/** 已知 reason 判定（供 event/reason 矛盾诊断与测试使用；未知原因返回 false） */
export function isKnownReason(reason: string | null): boolean {
  return reason !== null && KNOWN_REASONS.has(reason);
}

/**
 * 语义色调 → Tailwind 徽标类名（唯一映射，列表/概览/树节点共用）。
 *
 * 返回的是**静态完整类名字符串**（不是拼接片段）——Tailwind 的 JIT 扫描要求类名可静态识别，
 * 动态拼 `bg-${tone}-100` 会因扫描不到而静默丢样式。
 */
export function outcomeBadgeClass(tone: OutcomeTone): string {
  switch (tone) {
    case "success":
      return "bg-emerald-100 text-emerald-800";
    case "danger":
      return "bg-red-100 text-red-800";
    case "warn":
      return "bg-amber-100 text-amber-800";
    case "neutral":
      return "bg-gray-100 text-gray-700";
  }
}
