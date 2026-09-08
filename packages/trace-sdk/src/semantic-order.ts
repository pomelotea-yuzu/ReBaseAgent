import type { SpanLine } from "./schema.js";

/**
 * 把 span 序列重建为"父先子后、同层保序"的语义序。
 *
 * JsonlTracer 为防崩溃产生半行，在 endSpan 时整行落盘（append-only），
 * 因此文件中的 span 行是 end 序：一轮内 llm.call → tool.invoke → agent.step，
 * 子 span 先于其父 step 出现。而 trace-format 的语义序（fixture 亦为此序）是
 * start 序：agent.step → 其下 llm.call / tool.invoke。resolveBranch 的前缀截断
 * 与 deriveReplayState 的 lookahead 都依赖语义序，故读取时统一重建：
 * 根（step）按文件序保持时间先后，各根下子 span 按文件序挂回（一轮内
 * llm 先结束、tools 依执行序结束，恰为 start 序）。手工构造的合法文件
 * 若已是语义序，本变换为恒等。
 *
 * 独立成模块：reader（fs 落盘读取）与 MemoryTracer（内存收集）共用，
 * 不为此引入第二套解析器。
 */
export function toSemanticOrder(spans: SpanLine[]): SpanLine[] {
  if (spans.length <= 1) {
    return spans;
  }
  const childrenOf = new Map<string, SpanLine[]>();
  const roots: SpanLine[] = [];
  for (const span of spans) {
    if (span.parent === null) {
      roots.push(span);
    } else {
      const siblings = childrenOf.get(span.parent) ?? [];
      siblings.push(span);
      childrenOf.set(span.parent, siblings);
    }
  }
  const ordered: SpanLine[] = [];
  const visit = (span: SpanLine): void => {
    ordered.push(span);
    for (const child of childrenOf.get(span.id) ?? []) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  // 防御：parent 指向缺失的孤儿 span 按文件序补在末尾（不丢数据）
  if (ordered.length !== spans.length) {
    const seen = new Set(ordered);
    for (const span of spans) {
      if (!seen.has(span)) {
        ordered.push(span);
      }
    }
  }
  return ordered;
}
