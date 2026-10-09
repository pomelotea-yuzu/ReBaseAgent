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
 *
 * U1 任务 5.5 追加两个"就近"能力（spec：长文本 SHALL 可查找、展开和复制）：
 *   - **复制**：复制的是**原始文本**（`text`），不是省略后的展示；有 `navigator.clipboard`
 *     就用它，没有（无 DOM 的静态渲染）则静默跳过，绝不抛。
 *   - **查找**：在**完整原文**上算命中（`findInText`），支持下一个/上一个循环导航与
 *     "第 n / m 个"提示。查找输入框只在展开后出现——折叠时连原文都看不到，查找无处可用。
 */

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { findInText, splitByMatches, stepFind } from "../lib/call-detail-view";
import { expandedKeysInclude, toggleExpandedKey } from "../lib/reading-state";

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
 * 不把"没记过"当成"已展开"。判据委托 `lib/reading-state.ts` 的通用实现
 * （UI 密度 change 1.3 起运行级说明复用同一语义，不写第二份）。
 */
export function isLongTextExpanded(expanded: string[] | undefined, id: string): boolean {
  return expandedKeysInclude(expanded, id);
}

/**
 * 切换某个长文本块的展开状态，返回新的 `CallReadingState.expanded`。
 * 判据同上：委托通用实现（去重 + 稳定顺序在 reading-state 的用例里钉住）。
 */
export function toggleLongTextExpanded(expanded: string[] | undefined, id: string): string[] {
  return toggleExpandedKey(expanded, id);
}

/** 复制反馈文案（英文/中文各一份？不需要——统一中文，且**如实**区分成功与不可用） */
export function copyFeedbackText(outcome: "copied" | "unavailable"): string {
  return outcome === "copied" ? "已复制原文" : "当前环境不支持复制（可手动选择文本）";
}

/**
 * 复制时**写到剪贴板的文本**。
 *
 * 抽成函数（而不是内联 `writeText(text)`）是因为 spec 明写「复制 SHALL 对应原始文本
 * 而非省略后的展示」——这是一条**可证伪的契约**：只要复制目标不是完整原文就该被断言抓到。
 * 内联写法下，把 `text` 改成摘要/截断串不会有任何用例变红（变异验证发现的盲区）。
 *
 * ⚠️ 当前折叠态只把原文塞在 `<details>` 里（DOM 仍持有全文），故复制目标恒为 `text`；
 *    若将来引入"省略后展示"，此处必须仍返回 `text`（原文），不得返回展示串。
 */
export function copyPayload(text: string): string {
  return text;
}

/** 查找的计数提示；无命中时明确说"无命中"，不显示"0 / 0"让人以为没搜 */
export function findCountLabel(result: { matches: unknown[]; index: number }): string {
  if (result.matches.length === 0) return "无命中";
  return `第 ${result.index + 1} / ${result.matches.length} 个`;
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
  const [query, setQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "unavailable" | null>(null);

  const controlled = expanded !== undefined;
  const isExpanded = controlled ? expanded : uncontrolled;

  const collapsed = shouldCollapse(text);
  // 短文本不必展开，故也不显示查找/复制工具条（无处可用）
  const showTools = !collapsed || isExpanded;

  const copy = (): void => {
    // 复制的是**原始文本**（不是省略后的展示）；无 DOM 环境下 clipboard 不存在 ⇒ 如实提示
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: unknown } } })
      .navigator?.clipboard;
    if (
      clipboard === undefined ||
      typeof (clipboard as { writeText?: unknown }).writeText !== "function"
    ) {
      setCopyFeedback("unavailable");
      return;
    }
    void (clipboard as { writeText: (t: string) => Promise<void> })
      .writeText(copyPayload(text))
      .then(() => setCopyFeedback("copied"))
      .catch(() => setCopyFeedback("unavailable"));
  };

  const find = findInText(text, query, findIndex);
  const parts = splitByMatches(text, find);
  if (!collapsed) {
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
      {/*
       * UI 密度 change 1.2（design D1）：与页面其他折叠控制同一交互语义——
       * 方向箭头（展开朝下/收起朝右）+ 标题（字段、字数与动作，见 collapsedLabel）
       * + 至少 28 CSS px 命中区。原生 `<summary>` 自带展开语义与键盘激活
       * （Enter/Space），不需要再造 aria-expanded。
       */}
      <summary className="inline-flex min-h-[28px] cursor-pointer list-none select-none items-center gap-1.5 py-0.5 text-[11px] text-gray-500 hover:text-gray-700 [&::-webkit-details-marker]:hidden">
        <ChevronDown
          size={13}
          aria-hidden="true"
          focusable={false}
          role="presentation"
          className={`shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
        />
        {collapsedLabel(text, label)}
      </summary>

      {showTools ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
          {/* 查找：在完整原文上算命中；空查询时禁用导航按钮 */}
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFindIndex(0);
            }}
            placeholder="在原文中查找"
            aria-label={`在${label}中查找`}
            className="w-40 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
          />
          <span className="text-gray-500" aria-live="polite">
            {query === "" ? "" : findCountLabel(find)}
          </span>
          <button
            type="button"
            onClick={() => setFindIndex((i) => stepFind(findInText(text, query, i), -1).index)}
            disabled={find.matches.length === 0}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            上一个
          </button>
          <button
            type="button"
            onClick={() => setFindIndex((i) => stepFind(findInText(text, query, i), 1).index)}
            disabled={find.matches.length === 0}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一个
          </button>
          <button
            type="button"
            onClick={copy}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:bg-gray-50"
          >
            复制原文
          </button>
          {copyFeedback !== null ? (
            <span className="text-gray-500">{copyFeedbackText(copyFeedback)}</span>
          ) : null}
        </div>
      ) : null}

      <pre className="mt-1 whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {/* 高亮命中：命中片段包 <mark>，非命中保持文本。片段是位置性的、无稳定 id ⇒ 用下标作 key */}
        {parts.map((part, index) =>
          part.hit ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 文本片段由同一原文切出、位置稳定，无独立 id
            <mark key={index} className="rounded bg-yellow-200">
              {part.text}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            <span key={index}>{part.text}</span>
          ),
        )}
      </pre>
    </details>
  );
}
