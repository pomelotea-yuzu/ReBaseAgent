/**
 * 统一的受控展开/收起控件（UI 密度 change 任务 1.1/1.3 · design D1/D2）。
 *
 * 为什么单独成文件：delta「工作区折叠控制一致且可发现」要求列表、步骤、目录、长文本
 * 与说明的折叠控制使用**同一套**可访问语义——可辨文字/方向、与实际状态一致的
 * `aria-expanded`、至少 28 CSS px 命中区、可见焦点。此前这些控件散在各组件里
 * （页头一个浅色 `‹`、`<summary>` 一行小字、面板条一个小按钮），形态与命中区各异，
 * 正是 2026-10-06 实机评审抓到的「16×16px 浅色箭头是唯一入口」问题的根源。
 *
 * 两件套（都**受控**——状态归调用方，本组件不自持、不建第二份阅读 store）：
 *
 * 1. `DisclosureButton`：单个开关按钮（页头标题行 / 目录开关 / 分区摘要行通用）。
 *    可见文字 + 方向箭头 + `aria-expanded` + `aria-controls` + min-h-[28px] + FOCUS_RING。
 *    图标自身可以小，但**浅色箭头不再是唯一入口**（可见文字承担「收起/展开」含义）。
 * 2. `Disclosure`：摘要行 + 可折叠内容的块（「来源与技术详情」、修改证据等共用；
 *    design D2 的「一个可访问的 disclosure 组件/机制」就落在这里——内容可不同，
 *    机制只有这一份）。
 *
 * 纪律：
 * - 折叠只是**阅读状态**，不等于放弃、取消执行或解除任何门禁（调用方保证）；
 * - 自动适配不得写回手动偏好（调用方保证，本组件只回调）；
 * - Monaco gutter 代码折叠与页面面板折叠是两回事，本组件只服务后者。
 */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { DECORATIVE_ICON_PROPS, FOCUS_RING } from "./IconButton";

/** 方向箭头：展开朝下、收起朝右（旋转过渡只影响视觉，语义在 aria-expanded） */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronDown
      size={13}
      {...DECORATIVE_ICON_PROPS}
      className={`shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
    />
  );
}

/**
 * 单个折叠开关按钮。
 *
 * `label`：可访问名称（描述**动作**，如「收起运行列表」——不是图标名）；
 * `children`：可见内容（文字 + 可选的次要信息）。两者可以不同：
 * 页头标题行按钮的可见内容是「运行记录」，可访问名称是「收起运行列表」。
 */
export function DisclosureButton({
  expanded,
  onToggle,
  label,
  controls,
  title,
  className = "",
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  /** 可访问名称（动作短语；与实际状态一致的语义由 `aria-expanded` 表达） */
  label: string;
  /** 受控区域的 id（aria-controls；调用方保证该 id 存在） */
  controls?: string;
  title?: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded ? "true" : "false"}
      aria-controls={controls}
      aria-label={label}
      title={title ?? label}
      className={`inline-flex min-h-[28px] cursor-pointer items-center gap-1.5 rounded text-left ${FOCUS_RING} ${className}`}
    >
      <Chevron expanded={expanded} />
      {children}
    </button>
  );
}

/**
 * 摘要行 + 可折叠内容的块（受控）。
 *
 * 摘要行整行可点（design D1「一般标题整行可点击」），摘要 = `summary`（可见文字，
 * 如「来源与技术详情」）+ `meta`（紧凑摘要，如来源一行话/字段与修改数）。
 * 收起时内容不渲染（不是 CSS 隐藏——完整原文仍在数据层，展开即取，无截断丢失）。
 *
 * `controlsId`：内容区的 id（aria-controls 指向它）；调用方保证同屏唯一
 * （设计 D2：「唯一 aria-controls」）。
 */
export function Disclosure({
  summary,
  meta,
  expanded,
  onToggle,
  controlsId,
  openLabel = "展开",
  closeLabel = "收起",
  className = "",
  children,
}: {
  /** 摘要标题（可见，如「修改证据」「来源与技术详情」） */
  summary: string;
  /** 紧凑摘要（收起时用户据此判断里面有什么，如「字段 message · 左列 → 右列」） */
  meta?: string;
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
  /** 收起态摘要行上的动作文字（默认「展开」） */
  openLabel?: string;
  /** 展开态摘要行上的动作文字（默认「收起」） */
  closeLabel?: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={className}>
      <DisclosureButton
        expanded={expanded}
        onToggle={onToggle}
        label={`${summary}（${expanded ? closeLabel : openLabel}）`}
        controls={controlsId}
        className="w-full px-1 py-0.5 hover:bg-black/[0.03]"
      >
        <span className="shrink-0 text-[11px] font-semibold">{summary}</span>
        {meta !== undefined ? (
          <span className="min-w-0 truncate text-[11px] opacity-80">{meta}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] underline decoration-dotted opacity-70">
          {expanded ? closeLabel : openLabel}
        </span>
      </DisclosureButton>
      {expanded ? (
        <div id={controlsId} className="min-w-0">
          {children}
        </div>
      ) : null}
    </div>
  );
}
