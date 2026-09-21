/**
 * 基础图标按钮与可访问名称（U1 任务 4.1）。
 *
 * 对应 desktop-ui delta 场景「键盘导航及工具名称」：
 *   「操作有可见焦点和可访问名称……图标悬停可辨用途，长内容和状态无需仅靠颜色理解」
 *
 * 三条硬纪律（本文件存在的理由）：
 *   1. **图标必须有名称**：`label` 是必填的，它同时成为 `aria-label` 与原生 `title`
 *      （悬停可辨）。纯图标按钮 + 无名称 = 屏幕阅读器读成"按钮"、鼠标用户靠猜。
 *      ⚠️ 名称**不能**由图标名反推（`RefreshCw` → "refresh cw" 不是给人读的）。
 *   2. **状态不得只靠颜色**：`active` 换的是 `aria-pressed` 与底色，且调用方须同时给出
 *      文字或形状线索；本组件不提供"只有颜色差别"的状态表达。
 *   3. **焦点可见**：统一 `focus-visible` 环；用 `focus-visible` 而非 `focus`——
 *      鼠标点击不该留下焦点环（那会让"键盘用户正在这里"这一信号贬值）。
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { actionTitle } from "../lib/a11y-action";

/** 图标按钮的尺寸档：sm 用于行内/工具条，md 用于页头 */
export type IconButtonSize = "sm" | "md";

const SIZE_CLASS: Record<IconButtonSize, string> = {
  sm: "h-5 w-5",
  md: "h-7 w-7",
};

const ICON_SIZE: Record<IconButtonSize, number> = {
  sm: 13,
  md: 15,
};

/** 焦点环：全应用统一一处，避免各组件各写一套（也便于 4.x 后续复用） */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1";

/**
 * 装饰性图标的属性。
 *
 * ⚠️ lucide 自身已经会输出 `aria-hidden="true"`（实测），所以**只**写 aria-hidden
 * 的代码是在复述库的行为、看不出对错。这里额外显式声明两个本组件负责的语义：
 *   - `focusable={false}`：避免 SVG 在部分引擎里被纳入 Tab 序列（图标不该可聚焦）；
 *   - `role="presentation"`：把"这是装饰"写在元素上，而不是依赖库的默认值。
 */
export const DECORATIVE_ICON_PROPS = {
  "aria-hidden": true,
  focusable: false,
  role: "presentation",
} as const;

export interface IconButtonProps {
  /** 图标组件（lucide-react） */
  icon: LucideIcon;
  /**
   * 可访问名称（必填）。用于 `aria-label` + 原生 `title`。
   * 写成**给用户看的动词短语**（"刷新运行列表"），不是图标名。
   */
  label: string;
  onClick: () => void;
  size?: IconButtonSize;
  /** 选中/开关态：反映为 `aria-pressed`（不是只换颜色） */
  active?: boolean;
  disabled?: boolean;
  /** 补充说明（进 title，与 label 拼接），例如禁用原因 */
  hint?: string;
  className?: string;
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  size = "sm",
  active = false,
  disabled = false,
  hint,
  className = "",
}: IconButtonProps): ReactNode {
  const title = actionTitle(label, hint);
  /**
   * 使用 `aria-pressed` 而非只换底色（场景「长内容和状态无需仅靠颜色理解」）：
   * 读屏用户能听到"已选中"，而不是只能看到一个更深的按钮。
   */
  const pressed = active ? "true" : undefined;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex shrink-0 cursor-pointer items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-40 ${SIZE_CLASS[size]} ${
        active ? "bg-sky-100 text-sky-800" : ""
      } ${FOCUS_RING} ${className}`}
    >
      <Icon size={ICON_SIZE[size]} {...DECORATIVE_ICON_PROPS} />
    </button>
  );
}

/**
 * 图标 + 文字按钮：图标不是唯一信息载体时的首选形态。
 *
 * 与 `IconButton` 的区别是**名称可见**（不是只挂在 aria/title 上）——用在首屏与主要入口，
 * 让"图标悬停可辨用途"退化为"用途直接写在脸上"。
 */
export function TextIconButton({
  icon: Icon,
  children,
  onClick,
  disabled = false,
  active = false,
  hint,
  className = "",
}: {
  icon: LucideIcon;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  /** 补充说明（进 title），例如禁用原因 */
  hint?: string;
  className?: string;
}): ReactNode {
  // 可见文字就是名称：不另加 aria-label（否则读屏会读两遍）
  const visible = typeof children === "string" ? children : "";
  return (
    <button
      type="button"
      aria-pressed={active ? "true" : undefined}
      title={actionTitle(visible, hint)}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded border border-gray-300 bg-white px-2 py-1 text-reading-meta text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "border-sky-400 bg-sky-50 text-sky-800" : ""
      } ${FOCUS_RING} ${className}`}
    >
      <Icon size={13} {...DECORATIVE_ICON_PROPS} />
      <span>{children}</span>
    </button>
  );
}
