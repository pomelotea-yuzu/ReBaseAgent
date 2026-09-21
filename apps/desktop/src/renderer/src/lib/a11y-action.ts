/**
 * 图标按钮的可访问名称与提示（U1 任务 4.1 的纯判据层）。
 *
 * 对应 desktop-ui delta 场景「键盘导航及工具名称」：
 *   「操作有可见焦点和可访问名称……图标悬停可辨用途，长内容和状态无需仅靠颜色理解」
 *
 * 为什么把这件事抽成纯函数而不是只写在组件里：**名称是内容，不是样式**。
 * 「图标按钮必须有名称」「名称必须是给人读的短语」「禁用时要给出原因」这三条
 * 都能在不渲染组件的情况下钉住，且在 4.2–4.5 接线时可以直接复用（不用逐组件重写一遍）。
 *
 * 纪律：
 *   - **名称不能由图标名反推**：`RefreshCw` → "refresh cw" 是标识符泄漏，不是给用户读的。
 *     故这里只接受显式传入的 `label`，不做任何图标名到文案的推导。
 *   - **状态不得只靠颜色**：开关态进 `aria-pressed`；仅凭颜色差异表达状态会被此判据拒绝
 *     （调用方须给出文字/图标/形状线索，见 `describeActiveState`）。
 *   - **禁用要说原因**：`disabled` 且无 `hint` 时给出明确信号——"按钮灰了但不知道为什么"
 *     是调试台里最容易让人卡住的一类界面（用户会反复点）。
 */

/** 一个交互控件的可访问性描述（渲染前即可校验） */
export interface AccessibleAction {
  /** 语义化名称（进 aria-label / 可见文字） */
  label: string;
  /** 提示（进 title / tooltip） */
  hint?: string;
  /** 开关/选中态 */
  active?: boolean;
  disabled?: boolean;
  /** 是否有可见文字（true = 图标旁带文字，此时 label 可与文字一致） */
  hasVisibleText?: boolean;
}

/** 可访问性问题（供测试与开发期断言） */
export interface A11yIssue {
  kind: "missing-name" | "identifier-leak" | "disabled-without-reason" | "color-only-state";
  message: string;
}

/**
 * 名称是否像"泄漏的标识符"而不是给人读的短语。
 *
 * 判据：全 ASCII 且不含空格，且长度 ≥ 3 —— 例如 `RefreshCw`、`refreshCw`、`list-reload`。
 * 中文名一律不算泄漏（中文没有"单词"概念，短名如"刷新"完全可读）。
 */
export function looksLikeIdentifier(label: string): boolean {
  if (label.trim() === "") return false;
  // 含 CJK 或含空格 ⇒ 视为自然语言
  if (/[\u4e00-\u9fff]/.test(label)) return false;
  if (/\s/.test(label)) return false;
  // 驼峰 / 短横线 / 下划线的纯 ASCII 标识符形态
  return /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(label);
}

/** 校验一个动作的可访问性，返回全部问题（空数组 = 合格） */
export function auditAccessibleAction(action: AccessibleAction): A11yIssue[] {
  const issues: A11yIssue[] = [];

  const label = action.label.trim();
  if (label === "") {
    // 纯图标按钮没有名称 ⇒ 读屏读成"按钮"，鼠标用户靠猜
    issues.push({ kind: "missing-name", message: "纯图标控件必须有可访问名称" });
  } else if (looksLikeIdentifier(label)) {
    issues.push({
      kind: "identifier-leak",
      message: `名称「${label}」像标识符而不像给人读的短语`,
    });
  }

  if (action.disabled === true && (action.hint === undefined || action.hint.trim() === "")) {
    issues.push({
      kind: "disabled-without-reason",
      message: `「${label}」已禁用但未给出原因（hint）`,
    });
  }

  // 有色状态但无文字载体 ⇒ 只靠颜色传达状态
  if (action.active === true && action.hasVisibleText !== true && action.hint === undefined) {
    issues.push({
      kind: "color-only-state",
      message: `「${label}」的激活态只由视觉呈现，未提供 aria/title 层面的说明`,
    });
  }

  return issues;
}

/**
 * 组装最终的 `title` 文案：名称 + 原因/说明。
 *
 * 规则：空 hint 等同于没有 hint（不产生 `「刷新（）」` 这种空括号）。
 */
export function actionTitle(label: string, hint?: string): string {
  const trimmed = hint?.trim() ?? "";
  return trimmed === "" ? label : `${label}（${trimmed}）`;
}
