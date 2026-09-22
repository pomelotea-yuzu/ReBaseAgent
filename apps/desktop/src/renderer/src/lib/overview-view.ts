/**
 * 概览「结果区」的展示判据与安全文本判据（U1 任务 5.1 · design D4/D7）。
 *
 * 为什么抽成纯函数：本包**没有 jsdom**，组件层只能用 `renderToStaticMarkup` 做静态断言。
 * 把"该显示什么"从"怎么渲染"里剥出来，才能在这些无 DOM 的用例里钉住文案与分型，
 * 而不是依赖读源码或只能人工看。
 *
 * 三条不许含糊的纪律：
 *
 * 1. **未记录最终输出时绝不留白**：`deriveOwnOutput`（任务 2.2）给的是
 *    `missingReason` / `lastOutputKind` 两个分型，本模块把它们翻成**具体**的中文说明——
 *    空正文、仅有思维链、仅有工具调用、无自有调用各有各的说法，且都要能打开原调用。
 *    含糊的「（无输出）」会让用户以为是渲染故障。
 *
 * 2. **中间输出绝不冒充最终输出**：用语里必须带「不是本次最终结果」的语义
 *    （"结束前的最后一条正文"而不是"结果"），否则用户会把失败前的半截输出当成果。
 *
 * 3. **模型输出只是文本**：不执行 HTML/脚本、不自动加载远程图片、不把宿主路径当能力。
 *    本模块只提供**判据**（`containsMarkupLikeText` 等）供测试与提示使用；
 *    真正的安全由渲染方式保证——概览一律走 React 文本节点（`{text}`），
 *    没有任何 `dangerouslySetInnerHTML`，也没有 `<img>`/`<iframe>`。
 *    `auditSafeTextRendering` 把这个"渲染方式契约"变成可断言的对象。
 */

import type { OutputBlock, OwnOutput } from "@shared/overview";

/** 结果区的内容形态（互斥，供渲染分支与测试一一对应） */
export type ResultKind =
  | "final" // 已记录的最终输出
  | "no-llm-call" // 本 run 没有任何自有 llm.call
  | "empty-content" // 最后自有调用正文为空（且无思维链/工具调用可展示）
  | "reasoning-only" // 最后自有调用仅有思维链
  | "pending-tool-calls" // 最后自有调用仅有/仍带有待执行工具调用（循环本应继续）
  | "has-error" // 最后自有调用带 error
  | "not-normal-end"; // 有正文、无 error、无待执行工具调用，但非正常终止（如 aborted）

export interface ResultPresentation {
  kind: ResultKind;
  /** 结果区主标题（唯一文案来源） */
  title: string;
  /** 一句话说明"为什么不是最终输出"；kind === "final" 时为 null */
  reason: string | null;
  /** 可直接展示的正文块（最终输出或中间输出）；两者皆无时为 null */
  block: OutputBlock | null;
  /** 该块在界面上的角色文案（"最终输出" / "结束前的最后一条正文"） */
  blockLabel: string | null;
  /**
   * 是否应提供「打开原调用」入口（有 block 即给；仅有思维链/工具调用时也给，
   * 因为那正是"要看的内容"所在）。
   */
  openCallTarget: { spanId: string; stepSpanId: string | null } | null;
}

const REASON_TEXT: Record<Exclude<ResultKind, "final">, string> = {
  "no-llm-call": "本 run 没有记录任何自有模型调用，因此没有可展示的输出。",
  "empty-content": "最后一次自有模型调用的响应正文为空。",
  "reasoning-only": "最后一次自有模型调用只记录了思维链，没有正文——已记录内容类型为「思维链」。",
  "pending-tool-calls":
    "最后一次自有模型调用只记录了工具调用，没有正文——已记录内容类型为「工具调用」，循环本应继续。",
  "has-error": "最后一次自有模型调用以错误结束，没有可用的正文结果。",
  "not-normal-end": "本 run 不是正常结束（不是 completed 终止），最后一段正文不作为最终结果。",
};

/**
 * 由 `deriveOwnOutput` 的结论算出结果区该显示什么。
 *
 * `latestIntermediate` 只在**没有**最终输出时才有意义（`deriveOwnOutput` 已保证
 * finalOutput 非 null 时其为 null），这里不重复判断，但也不假定调用方一定传对——
 * 优先展示 finalOutput。
 *
 * ⚠️ **为什么展示层的分型优先看 `lastOutputKind` 而不是直接抄 `missingReason`**：
 *    两者回答的是不同问题——`missingReason` 说「为什么没成为最终输出」，`lastOutputKind`
 *    说「这次调用到底记录了什么」。spec「无最终正文不借用祖先补全」明确要求
 *    「**区分已记录内容类型**」，故当最后调用记录了思维链/工具调用时，
 *    「只记录了思维链」比「正文为空」更准确（前者是内容类型，后者会被误读成"什么都没有"）。
 *    `deriveOwnOutput` 的分型对 2.2 的用例仍有意义（它服务的是「原因归属」），
 *    本模块只是在**文案层**换个更贴近用户问题的角度，不改动上游结论。
 */
export function presentResult(own: OwnOutput): ResultPresentation {
  if (own.finalOutput !== null) {
    return {
      kind: "final",
      title: "最终输出",
      reason: null,
      block: own.finalOutput,
      blockLabel: "最终输出",
      openCallTarget: {
        spanId: own.finalOutput.spanId,
        stepSpanId: own.finalOutput.stepSpanId,
      },
    };
  }

  const kind = resolveMissingKind(own);
  const block = own.latestIntermediate;
  return {
    kind,
    title: "未记录最终输出",
    reason: REASON_TEXT[kind],
    block,
    // 中间输出的措辞必须明确它**不是**本次结果
    blockLabel: block === null ? null : "结束前记录的最后一段正文（不是本次最终结果）",
    openCallTarget: block !== null ? { spanId: block.spanId, stepSpanId: block.stepSpanId } : null,
  };
}

/**
 * 无最终输出时的展示分型（六选一，优先级即用户最想知道的问题顺序）。
 *
 * 顺序刻意如此：
 * 1. 没有自有调用——最根本的原因，先答（此时 `lastOutputKind` 为 null）。
 * 2. 最后调用带 error——失败是用户第一关心的，且此时正文确实不构成结果。
 * 3. 最后调用仍有待执行工具调用——说明循环被中断在半途，**不是**"输出为空"。
 *    这条排在 `empty-content` 之前，是因为它信息量更大（"还有活没干完"≠"什么都没写"）。
 * 4. 仅有思维链 / 仅有工具调用——按**内容类型**如实说明（spec 原文要求）。
 * 5. 正文为空——兜底，确实是空。
 * 6. 有正文但非正常终止（如 aborted）——正文在，只是不是"正常结束"的结果。
 */
function resolveMissingKind(own: OwnOutput): Exclude<ResultKind, "final"> {
  if (own.missingReason === "no-llm-call") return "no-llm-call";
  if (own.missingReason === "has-error") return "has-error";
  if (own.missingReason === "pending-tool-calls") return "pending-tool-calls";
  if (own.lastOutputKind === "reasoning-only") return "reasoning-only";
  if (own.missingReason === "empty-content") return "empty-content";
  return "not-normal-end";
}

/**
 * 「打开原调用」的提示：仅有思维链 / 工具调用时，正文无处可看，那部分内容在原调用详情里。
 * 有正文块时为 null（此时入口在正文块自己身上，不需要额外解释）。
 */
export function openCallHint(own: OwnOutput, presentation: ResultPresentation): string | null {
  if (presentation.block !== null) return null;
  if (own.lastOutputKind === "reasoning-only") return "打开该调用查看完整思维链";
  if (own.lastOutputKind === "tool-calls-only") return "打开该调用查看工具调用详情";
  return null;
}

// ---------------------------------------------------------------------------
// 安全文本（design D7：不执行 HTML/脚本、不自动加载远程图片、不把宿主路径当能力）
// ---------------------------------------------------------------------------

/**
 * 内容里是否**看起来**像标记语言 / 远程资源 / 宿主路径。
 *
 * ⚠️ 这不是"净化函数"——本 change 不做净化，因为渲染层根本不解析标记：
 * 概览一律把模型输出当**纯文本**交给 React（`{text}`），HTML 会原样显示成字面量，
 * 不会被解释成元素。本判据的用途是**测试与提示**：夹具里放这些内容，
 * 断言渲染结果里它们仍是转义后的字面量（而不是真的被解析）。
 */
export function containsMarkupLikeText(text: string): boolean {
  return (
    /<\s*(script|iframe|img|style|svg|object|embed)\b/i.test(text) ||
    /<\s*\/?\s*[a-z][a-z0-9-]*\s*\/?>/i.test(text) ||
    /https?:\/\/[^\s"'<>]+/i.test(text) ||
    /(^|[\s"'(])([A-Za-z]:\\|\/\/|\/(home|usr|etc|var|tmp|Users)\/)/.test(text)
  );
}

/** 渲染安全审计条目 */
export interface SafeTextIssue {
  kind: "parsed-markup" | "auto-loaded-image" | "executed-script";
  detail: string;
}

/**
 * 安全渲染契约的**源码级**断言（本包无 jsdom，打不到真实 DOM 行为）。
 *
 * 为什么要有它：spec「模型输出不产生外部副作用」是**禁用型**要求——"不做什么"很难被
 * 正面用例发现，回归时又极易被无意识地加回来（比如为了"更好看"引入 Markdown 渲染器）。
 * 把三条禁令变成可执行断言，任何人加回危险写法都会红。
 *
 * ⚠️ **必须先剥掉注释再扫**：本模块与 `OverviewPanel` 的说明性注释里**点名**了
 *    `dangerouslySetInnerHTML` / `<img>` 这些禁用写法（正是在解释为什么禁用它们）。
 *    不剥注释就会把"文档里提到禁令"误判成"代码里违反禁令" —— 这是典型的
 *    "判据能红但红错了对象"，第一次实测就抓到（6 条失败里的 1 条）。
 *
 * 入参是组件的**源码文本**，返回发现的问题（空数组 = 合规）。
 */
export function auditSafeTextRendering(source: string): SafeTextIssue[] {
  const code = stripComments(source);
  const issues: SafeTextIssue[] = [];
  if (/dangerouslySetInnerHTML/.test(code)) {
    issues.push({
      kind: "parsed-markup",
      detail: "出现 dangerouslySetInnerHTML：模型输出会被当作 HTML 解析",
    });
  }
  if (/<img\b/.test(code)) {
    issues.push({
      kind: "auto-loaded-image",
      detail: "出现 <img>：模型输出里的远程图片地址会被浏览器自动加载",
    });
  }
  if (/<iframe\b|<script\b|<object\b|<embed\b/i.test(code)) {
    issues.push({
      kind: "executed-script",
      detail: "出现脚本/内嵌文档元素：模型输出可能被执行或外联",
    });
  }
  return issues;
}

/**
 * 剥掉行注释与块注释（够用的近似实现，不追求完整词法分析）。
 *
 * 只处理代码里常见的两种注释形态；字符串字面量里的 `//` 会被误剥——本用途
 * （扫描源码里的 JSX 标签写法）不需要字符串内保真：真正危险的写法出现在 JSX/代码位置，
 * 而字符串里出现 `<img>` 本身不会造成副作用。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
