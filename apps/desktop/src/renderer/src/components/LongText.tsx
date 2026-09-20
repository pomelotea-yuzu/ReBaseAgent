/**
 * 长文本区块：默认折叠（只显示摘要行），展开后为**完整原文**——不做任何截断丢弃。
 *
 * 单独成文件的原因（B 任务 3.1）：spec 场景「超长消息」要求"默认折叠并可展开，展开后为
 * 完整原文，无截断省略"，把折叠判据与文案抽成纯函数后，可用 `react-dom/server` 在无 DOM
 * 环境下对这三点直接断言（本包 vitest 是 node 环境，没有 jsdom）。
 */

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

export function LongText({ text, label }: { text: string; label: string }) {
  if (!shouldCollapse(text)) {
    return (
      <pre className="whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    );
  }
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[11px] text-gray-500 hover:text-gray-700">
        {collapsedLabel(text, label)}
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-code text-[11px] leading-5 text-gray-800">
        {text}
      </pre>
    </details>
  );
}
