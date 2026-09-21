/**
 * 长文本区块：默认折叠（只显示摘要行），展开后为**完整原文**——不做任何截断丢弃。
 *
 * 单独成文件的原因（B 任务 3.1）：spec 场景「超长消息」要求"默认折叠并可展开，展开后为
 * 完整原文，无截断省略"，把折叠判据与文案抽成纯函数后，可用 `react-dom/server` 在无 DOM
 * 环境下对这三点直接断言（本包 vitest 是 node 环境，没有 jsdom）。
 *
 * U1 任务 3.6 改造：展开状态**可受控**。此前用非受控 `<details>`，展开状态只活在 DOM 里，
 * 组件卸载即丢——切走再切回、进设置/分支再返回都恢复不出"用户读到哪一块"。现在由父级
 * 传入 `expanded`（键取自 `readingByRun[runId].calls[spanId].expanded`）与 `onToggle`，
 * 组件只负责渲染与回调；不传则退化为**自持状态**（旧行为，保证既有调用点不受影响）。
 */

import { useState } from "react";

/** 折叠阈值（字符数 = UTF-16 单元）：**严格大于**才折叠，正好等于不折叠 */
export const COLLAPSE_THRESHOLD = 600;

/** 是否折叠（判据单独成函数，边界由用例钉住） */
export function shouldCollapse(text: string): boolean {
  return text.length > COLLAPSE_THRESHOLD;
}

/** 折叠摘要文案：带真实字符数——用户据此判断"展开的是多大一块内容" */
export function collapsedLabel(text: string, label: string): string {
  return `${label}（${text.length} 字符，点击展开完整内容）`;
}

/**
 * 某个长文本块在会话里算不算"已展开"。
 *
 * `expanded` 为 `undefined`（该调用还没记录过分区状态）⇒ 未展开（默认折叠）；
 * 与 `CallReadingState.expanded` 的 `string[]` 口径一致——**只记已展开的键**，
 * 不把"没记过"当成"已展开"。
 */
export function isLongTextExpanded(expanded: string[] | undefined, id: string): boolean {
  // 显式 `!== undefined` 而非可选链：返回值必须是**布尔**不是 `boolean | undefined`
  return expanded?.includes(id) === true;
}

/**
 * 切换某个长文本块的展开状态，返回新的 `CallReadingState.expanded`。
 *
 * 保持数组去重与稳定顺序（先出现的保持原序，新展开的追加在尾部）——顺序进测试断言，
 * 不依赖 Set 的迭代顺序实现细节。
 */
export function toggleLongTextExpanded(expanded: string[] | undefined, id: string): string[] {
  const current = expanded ?? [];
  if (current.includes(id)) return current.filter((key) => key !== id);
  return [...current, id];
}

export function LongText({
  text,
  label,
  expanded,
  onToggle,
}: {
  text: string;
  label: string;
  /** 受控展开状态（由父级提供时组件不再自持状态） */
  expanded?: boolean;
  /** 展开状态变化回调（受控时必须提供，否则切换会被 React 忽略成不生效） */
  onToggle?: (next: boolean) => void;
}) {
  // 非受控兜底：既有调用点不传 expanded 时行为与改造前一致
  const [uncontrolled, setUncontrolled] = useState(false);
  const controlled = expanded !== undefined;
  const isExpanded = controlled ? expanded : uncontrolled;

  if (!shouldCollapse(text)) {
    return (
      <pre className="whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    );
  }

  const handleToggle = (next: boolean): void => {
    if (!controlled) setUncontrolled(next);
    onToggle?.(next);
  };

  return (
    <details
      className="group"
      open={isExpanded}
      // 用受控状态驱动 DOM 属性；details 自身的 toggle 只是用户意图的来源
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== isExpanded) handleToggle(next);
      }}
    >
      <summary className="cursor-pointer select-none text-[11px] text-gray-500 hover:text-gray-700">
        {collapsedLabel(text, label)}
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    </details>
  );
}
