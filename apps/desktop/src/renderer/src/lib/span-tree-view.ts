/**
 * 步骤目录（span 树）的展示判据（U1 任务 5.4 · design D1/D2）。
 *
 * 为什么抽成纯函数：本包**没有 jsdom**，组件层只能用 `renderToStaticMarkup` 做静态断言，
 * 且 zustand v5 在该环境下走 `getServerSnapshot`（恒初始值）⇒ 组件测试喂不进 store 状态。
 * 把「树 → 该显示哪些行、每行长什么样」从「怎么渲染」里剥出来，才能在无 DOM 的用例里
 * 钉住「展开/选择分离」「自有/继承标记」「两类错误各自标记」这些判据。
 *
 * 三条不许含糊的纪律（对应 desktop-ui delta「轨迹以 span 树呈现」）：
 *
 * 1. **展开与选择是两件事**：展开/折叠 step 不改变当前选中项，选中某个调用也不折叠目录。
 *    故本模块把「行是否展开」（`expanded`）与「行是否选中」（`selected`）**分成两个独立入参**，
 *    绝不从一个推另一个——一旦耦合，用户点 step 想展开结果把详情也换了。
 *
 * 2. **自有与继承可辨**：有共享前缀的轨迹里，祖先 span 与本次自有 span 必须可区分，
 *    且**不累加本地轮号**（`agent.step.n` 是各 run 自己的本地轮号，照抄记录值，不沿链求和）。
 *    `leafSpanIds` 界定自有段：不在其中的就是继承记录。
 *
 * 3. **错误按各自字段标记、不合并**：`tool.invoke.error !== null` 与 `llm.call.error !== undefined`
 *    是两个不同的判据（null 与 undefined 语义不同），且都**不**改变 run 的结局
 *    （「错误是数据不是异常」）——本模块只标注"这一行有错"，不据此改结局。
 */

import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { SpanNode } from "@shared/derive";

/** 行上的错误来源（互斥；null 表示该行无记录错误） */
export type RowErrorKind = "llm" | "tool" | null;

/** 一行的全部展示事实（渲染层只消费，不重判） */
export interface SpanRowView {
  spanId: string;
  kind: SpanLine["kind"];
  /** 缩进层级（根为 0） */
  depth: number;
  /** 行主标签（step 用本地轮号、llm 固定文案、tool 用工具名） */
  label: string;
  /** 该行是否属于**本次自有段**（false = 继承自父 run 的共享前缀） */
  own: boolean;
  /** 父 span 不在此轨迹中（手工编辑过的文件） */
  orphan: boolean;
  /** 该行的错误来源（llm.call.error 存在 / tool.invoke.error 非 null）；无错为 null */
  errorKind: RowErrorKind;
  /** 是否是可展开的 step 且有子节点（决定展开控件是否出现） */
  expandable: boolean;
}

/**
 * `agent.step` 的本地轮号标签。
 *
 * ⚠️ **不沿链累加**：`n` 是记录里的原值（该 run 自己的本地轮号），照抄即可。
 *    合并轨迹里"沿链累计"会给错答案（实测 `[1,2,3,1,1]`）。这里不做任何累加。
 */
export function stepLabel(n: number): string {
  return `第 ${n} 轮`;
}

/** 某 span 的错误来源（按 kind 缩窄后取各自判据；null/undefined 语义不同） */
export function rowErrorKind(span: SpanLine): RowErrorKind {
  if (span.kind === "tool.invoke") return span.error !== null ? "tool" : null;
  if (span.kind === "llm.call") return span.error !== undefined ? "llm" : null;
  return null;
}

/** 一行的标签（只按记录取值，不推断内容） */
export function spanRowLabel(span: SpanLine): string {
  if (span.kind === "agent.step") return stepLabel(span.n);
  if (span.kind === "llm.call") return "LLM 调用";
  return span.tool;
}

/**
 * 树 → 按当前展开状态扁平成行序列（DFS，与记录顺序一致）。
 *
 * `expandedOf(spanId, kind)` 给出「该行此刻是否展开」：**只影响是否下钻子节点**，
 * 不影响 `selected`（那是另一条通道，见文件头纪律 1）。
 */
export function flattenSpanRows(
  roots: readonly SpanNode[],
  options: {
    /** 自有 span id 集合（`RunDetail.leafSpanIds`）；缺省视为全部自有 */
    ownIds?: ReadonlySet<string>;
    /** 该行是否展开（默认全部展开，与 store 的 `expandedSteps[id] !== false` 同口径） */
    expandedOf?: (spanId: string, kind: SpanLine["kind"]) => boolean;
  } = {},
): SpanRowView[] {
  const ownIds = options.ownIds;
  const rows: SpanRowView[] = [];

  const walk = (node: SpanNode, depth: number): void => {
    const { span, children } = node;
    const expandable = span.kind === "agent.step" && children.length > 0;
    const expanded = options.expandedOf?.(span.id, span.kind) ?? true;
    rows.push({
      spanId: span.id,
      kind: span.kind,
      depth,
      label: spanRowLabel(span),
      own: ownIds === undefined ? true : ownIds.has(span.id),
      orphan: node.orphan,
      errorKind: rowErrorKind(span),
      expandable,
    });
    if (!expanded) return;
    for (const child of children) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 0);
  return rows;
}

/** 目录的空态成因（互斥，供界面分流文案） */
export type StepsEmptyCause = "no-spans" | "no-own-calls" | "none";

/**
 * 空态成因：空轨迹与"有轨迹但没有自有调用"是两回事。
 *
 * - `no-spans`：整条轨迹为空 ⇒ 「没有可展示的步骤」（不伪造步骤）
 * - `no-own-calls`：轨迹非空但本 run 无自有调用（如仅有祖先共享前缀的 result 分支）
 *   ⇒ 目录仍有内容（继承段可见），但**首次选择**回退到首个可读 span 而不是硬说有自有调用
 * - `none`：有自有调用，正常
 *
 * ⚠️ 不把 `no-own-calls` 说成空态：继承段是可见的真实记录，说"没有步骤"是错的。
 */
export function stepsEmptyCause(input: {
  spanCount: number;
  ownCallCount: number;
}): StepsEmptyCause {
  if (input.spanCount === 0) return "no-spans";
  if (input.ownCallCount === 0) return "no-own-calls";
  return "none";
}
