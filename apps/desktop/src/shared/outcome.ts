import type { Translator } from "@rebaseagent/i18n";
import type { OutcomeKind, OutcomeTone } from "@rebaseagent/run-query/facts";

// 结局分类已迁至 @rebaseagent/run-query/facts；Tailwind 类名是视图映射，留在 desktop。
export { classifyOutcome, isKnownReason } from "@rebaseagent/run-query/facts";
export type { Outcome, OutcomeKind, OutcomeTone } from "@rebaseagent/run-query/facts";

/** 结局短标签的展示投影：领域包只给稳定 kind，文案随 UI 语言。 */
export function outcomeLabelOf(kind: OutcomeKind, translator: Translator): string {
  switch (kind) {
    case "completed":
      return translator.t("run.outcomeCompleted");
    case "error":
      return translator.t("run.outcomeError");
    case "max_iterations":
      return translator.t("run.outcomeMaxIterations");
    case "budget_exceeded":
      return translator.t("run.outcomeBudgetExceeded");
    case "aborted":
      return translator.t("run.outcomeAborted");
    case "interrupted":
      return translator.t("run.outcomeInterrupted");
    case "unknown":
      return translator.t("run.outcomeUnknown");
  }
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

/**
 * 语义色调 → 纯**文字色**类名（同一份映射的第二形态，U1 6.2 补）。
 *
 * 用在**密集表格**里（对照面板的一列只有 ~56px，放不下带内边距的徽章）：
 * 文字仍是主要载体（`label`），颜色只做辅助——与徽章口径同源，不新增判断。
 * 同样是静态完整类名（Tailwind JIT 需可静态识别，不得动态拼 `text-${tone}-700`）。
 */
export function outcomeTextClass(tone: OutcomeTone): string {
  switch (tone) {
    case "success":
      return "text-emerald-700";
    case "danger":
      return "text-red-700";
    case "warn":
      return "text-amber-700";
    case "neutral":
      return "text-gray-600";
  }
}
