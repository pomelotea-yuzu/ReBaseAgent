/**
 * 调用详情的展示判据（U1 任务 5.5 · design D6/D7）。
 *
 * 对应 desktop-ui delta「详情面板完整展示一步的原始请求与响应」的三条不许含糊的纪律：
 *
 * 1. **原始字段一个都不能少，且"少没少"要能被断言**：spec 逐字段点名了
 *    llm.call（`request.messages` / `request.tools` / `request.params` / `content` /
 *    `reasoning_content` / `tool_calls` / `usage` / `ttft_ms` / 耗时）与 tool.invoke
 *    （`tool` / `args` / `result` / `error` / `dur_ms` / 耗时）。把「该有哪些字段」抽成
 *    **清单常量**并让 `auditCallDetailFields` 逐条核对，才能在无 DOM 的用例里钉住
 *    "不丢字段"——否则只能靠人工看界面，回归删掉一块没人知道。
 *
 * 2. **输入与输出是两半，切换不丢字段**：llm.call 的"输入"= messages/tools/params，
 *    "输出"= content/reasoning_content/tool_calls。切换只改**看哪一半**，
 *    两半都始终在数据里（`resolveIoView` 只返回该显示什么，不搬动数据）。
 *
 * 3. **查找针对原始文本，不是省略后的展示**：`findInText` 在**完整原文**上算命中，
 *    返回的命中位置可直接用于高亮/跳转；`LongText` 折叠与否不影响命中数。
 *
 * ⚠️ 抽出纯函数的原因：本包**没有 jsdom**，组件层只能用 `renderToStaticMarkup` 做
 *    静态断言，且 zustand v5 在该环境下走 `getServerSnapshot`（恒初始值）⇒ 组件测试
 *    喂不进 store 状态。把「数据 → 该显示什么」从「怎么渲染」里剥出来，才能在无 DOM
 *    的用例里钉住这些判据。
 */

import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { SpanNode } from "@shared/derive";
import { deriveStepStats } from "@shared/derive";

// ---------------------------------------------------------------------------
// 字段清单：spec 逐字段点名的"原始字段"，一条都不能少
// ---------------------------------------------------------------------------

/**
 * llm.call 必须可见的原始字段清单（spec「详情面板完整展示一步的原始请求与响应」原文）。
 *
 * ⚠️ 这是**契约**不是建议：`auditCallDetailFields` 用它核对，测试再用它钉住。
 *    往 spec 里加字段时先加到这里，顺序即 spec 的叙述顺序。
 */
export const LLM_CALL_FIELDS = [
  "request.messages",
  "request.tools",
  "request.params",
  "response.content",
  "response.reasoning_content",
  "response.tool_calls",
  "response.usage.in",
  "response.usage.out",
  "response.ttft_ms",
  "duration",
] as const;

/** tool.invoke 必须可见的原始字段清单 */
export const TOOL_INVOKE_FIELDS = [
  "tool",
  "args",
  "result",
  "error",
  "dur_ms",
  "duration",
] as const;

/** agent.step 必须可见的内容（delta「选中 step 时 SHALL 展示其已记录调用、错误及派生消耗」） */
export const STEP_FIELDS = ["calls", "errors", "consumption"] as const;

export type LlmCallField = (typeof LLM_CALL_FIELDS)[number];
export type ToolInvokeField = (typeof TOOL_INVOKE_FIELDS)[number];
export type StepField = (typeof STEP_FIELDS)[number];

/**
 * 可选字段（记录里**可能没有**）——渲染层据此决定"栏目显不显示"，而不是当成漏渲染。
 *
 * `request.tools` / `request.params` 是可选字段：未设置时**不渲染空栏目**是对的
 * （摆一个空的"工具表（0）"会把"没有工具"显示成"有但为空"）。故这两个字段不出现在
 * "必须出现"的断言里，而由 `optionalSectionVisible` 判。
 */
export const OPTIONAL_LLM_FIELDS: readonly LlmCallField[] = [
  "request.tools",
  "request.params",
] as const;

/** 某个可选栏目此刻该不该渲染（记录里有这个字段才渲染） */
export function optionalSectionVisible(
  span: Extract<SpanLine, { kind: "llm.call" }>,
  field: "request.tools" | "request.params",
): boolean {
  return field === "request.tools"
    ? span.request.tools !== undefined
    : span.request.params !== undefined;
}

// ---------------------------------------------------------------------------
// 输入 / 输出切换（design D6 的 `inputOutputTab`，即 CallReadingState.io）
// ---------------------------------------------------------------------------

/** 详情里可切换的两半 */
export type IoView = "input" | "output";

/**
 * 默认看哪一半。
 *
 * 判据**不是**"输入永远第一"：失败调用（有 error）时用户多半是来看失败原因的，
 * 而失败原因在输出侧（错误区与空正文说明），故失败调用默认输出；正常调用默认输入
 * （请求里有什么最能解释这次调用做了什么）。
 *
 * ⚠️ 这只决定**首次**看哪半；用户切过之后以 `io` 记忆为准（`resolveIoView` 的入参）。
 */
export function defaultIoView(span: Extract<SpanLine, { kind: "llm.call" }>): IoView {
  return span.error !== undefined ? "output" : "input";
}

/**
 * 该显示哪一半：用户记忆优先，无记忆时按 `defaultIoView`。
 *
 * `io` 为 `undefined`（没切过）与显式值要分得开——沿用 `readingByRun` 的"只记已切过的"
 * 口径，不把"没切过"当成"切到了 input"。
 */
export function resolveIoView(
  span: Extract<SpanLine, { kind: "llm.call" }>,
  io: IoView | undefined,
): IoView {
  return io ?? defaultIoView(span);
}

/** 一半里包含哪些分区（供界面只渲染该半，且测试能核对"两半合起来=全部原始字段"） */
export const IO_SECTIONS: Record<IoView, readonly string[]> = {
  input: ["request.messages", "request.tools", "request.params"],
  output: [
    "response.content",
    "response.reasoning_content",
    "response.tool_calls",
    "response.usage.in",
    "response.usage.out",
    "response.ttft_ms",
  ],
};

/**
 * 两半的分区并集是否覆盖 spec 点名的全部原始字段（除 `duration` 恒在两半的概要里）。
 *
 * 这是"输入输出切换不丢字段"的可执行判据：**任何一半**都不该把字段整体漏掉，
 * 并集必须等于 `LLM_CALL_FIELDS` 去掉恒显的 `duration`。
 */
export function ioCoversAllFields(): LlmCallField[] {
  const union = new Set<string>([...IO_SECTIONS.input, ...IO_SECTIONS.output, "duration"]);
  return LLM_CALL_FIELDS.filter((field) => !union.has(field));
}

// ---------------------------------------------------------------------------
// step 详情：已记录调用、错误与派生消耗
// ---------------------------------------------------------------------------

/** step 详情里一次已记录调用的摘要行 */
export interface StepCallSummary {
  spanId: string;
  kind: "llm.call" | "tool.invoke";
  /** 显示名（llm 用模型名，tool 用工具名） */
  label: string;
  /** 该调用是否有记录错误（llm.error !== undefined / tool.error !== null） */
  errored: boolean;
}

/** step 详情的展示数据（已记录调用 + 错误 + 派生消耗） */
export interface StepDetailView {
  iteration: number;
  calls: StepCallSummary[];
  /** 已记录错误数（工具错误 + LLM 错误，**不合并语义只合并计数**） */
  errorCount: number;
  /** 该 step 子树的派生消耗（现有 `deriveStepStats` 口径，不新算） */
  tokensIn: number;
  tokensOut: number;
  durationMs: number | null;
  toolCalls: number;
}

/**
 * 把一个 `agent.step` 节点翻成详情要显示的内容。
 *
 * ⚠️ **消耗一律来自 `deriveStepStats`（既有口径），本模块不重算**——delta 要求
 *    "预算仍以既有轨迹口径计算"，自己再累一遍必然与树/预算地图分叉（D4 要消灭的正是这个）。
 * ⚠️ **子树的"已记录调用"只列直接子节点**：step 的顺序与层级由 span 树给出，
 *    这里不递归展开孙节点（那些属各自 step 的详情）。
 */
export function presentStepDetail(node: SpanNode): StepDetailView {
  const stats = deriveStepStats(node);
  const calls: StepCallSummary[] = [];
  let errorCount = 0;

  for (const child of node.children) {
    const { span } = child;
    if (span.kind === "llm.call") {
      const errored = span.error !== undefined;
      if (errored) errorCount += 1;
      calls.push({ spanId: span.id, kind: "llm.call", label: span.request.model, errored });
    } else if (span.kind === "tool.invoke") {
      const errored = span.error !== null;
      if (errored) errorCount += 1;
      calls.push({ spanId: span.id, kind: "tool.invoke", label: span.tool, errored });
    }
  }

  return {
    iteration: node.span.kind === "agent.step" ? node.span.n : 0,
    calls,
    errorCount,
    tokensIn: stats.tokensIn,
    tokensOut: stats.tokensOut,
    durationMs: stats.durationMs,
    toolCalls: stats.toolCalls,
  };
}

// ---------------------------------------------------------------------------
// 长文本查找（spec：长文本 SHALL 可查找、展开和复制）
// ---------------------------------------------------------------------------

/** 一次查找的命中结果（供界面高亮与"第 n / m 个"提示） */
export interface TextFindResult {
  query: string;
  /** 命中区间 [start, end) 列表，按出现顺序 */
  matches: Array<{ start: number; end: number }>;
  /** 当前聚焦的命中下标（-1 = 无命中） */
  index: number;
}

/**
 * 在**完整原文**上查找子串（大小写不敏感）。
 *
 * 三条纪律：
 *   - 查找针对原始文本，**不是省略后的展示**——折叠状态不参与，命中数与展开无关。
 *   - 空查询 ⇒ 无命中（不把"空串"当成命中全部位置，那会让高亮糊满屏）。
 *   - `index` 就是 `from` 规范到 `[0, matches.length)` 的结果——**它是"当前聚焦哪个命中"**，
 *     不含方向语义。移动用 `stepFind`（见下），这样调用方不必知道规范化的细节。
 *
 * @param text   要搜索的完整原文
 * @param query  查询串（空 ⇒ 无命中）
 * @param from   当前聚焦的命中下标（默认 0；越界自动回绕）
 */
export function findInText(text: string, query: string, from = 0): TextFindResult {
  if (query === "") return { query, matches: [], index: -1 };

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  // 逐次取下一个匹配位置；命中不能重叠推进（避免 "aa" 在 "aaaa" 里算出重叠区间）
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    matches.push({ start: at, end: at + needle.length });
    cursor = at + needle.length;
  }
  if (matches.length === 0) return { query, matches: [], index: -1 };

  const index = ((from % matches.length) + matches.length) % matches.length;
  return { query, matches, index };
}

/**
 * 从当前结果移动一步（下一个 / 上一个），越界回绕。
 *
 * 单独成函数而不是塞进 `findInText`：**"算什么"与"往哪走"是两件事**，
 * 混在一起会让"首次命中的 index 是几"依赖方向参数，调用方难以推理。
 * `index` 为 -1（无命中）时恒返回 -1——没有命中就没有"下一个"可言。
 */
export function stepFind(result: TextFindResult, dir: 1 | -1): TextFindResult {
  const total = result.matches.length;
  if (total === 0 || result.index < 0) return result;
  return { ...result, index: (result.index + dir + total) % total };
}

/** 把命中区间切成交替的「非命中 / 命中」片段（供渲染层高亮，本身是纯判据） */
export function splitByMatches(
  text: string,
  result: TextFindResult,
): Array<{ text: string; hit: boolean }> {
  if (result.matches.length === 0) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const match of result.matches) {
    if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), hit: false });
    parts.push({ text: text.slice(match.start, match.end), hit: true });
    cursor = match.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}
