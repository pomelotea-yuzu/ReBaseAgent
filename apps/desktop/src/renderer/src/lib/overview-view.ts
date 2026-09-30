/**
 * 概览的展示判据与安全文本判据（U1 任务 5.1 结果区 + 5.2 结局/错误区 · design D4/D7）。
 *
 * 为什么抽成纯函数：本包**没有 jsdom**，组件层只能用 `renderToStaticMarkup` 做静态断言。
 * 把"该显示什么"从"怎么渲染"里剥出来，才能在这些无 DOM 的用例里钉住文案与分型，
 * 而不是依赖读源码或只能人工看。
 *
 * 四条不许含糊的纪律：
 *
 * 1. **未记录最终输出时绝不留白**：`deriveOwnOutput`（任务 2.2）给的是
 *    `missingReason` / `lastOutputKind` 两个分型，本模块把它们翻成**具体**的中文说明——
 *    空正文、仅有思维链、仅有工具调用、无自有调用各有各的说法，且都要能打开原调用。
 *    含糊的「（无输出）」会让用户以为是渲染故障。
 *
 * 2. **中间输出绝不冒充最终输出**：用语里必须带「不是本次最终结果」的语义
 *    （"结束前的最后一条正文"而不是"结果"），否则用户会把失败前的半截输出当成果。
 *
 * 3. **结局与错误一律转述上游派生，不自己重判**：结局走 `classifyOutcome`（唯一判据来源）、
 *    错误定位走 `deriveErrorTarget`、工具错误走 `deriveOwnToolErrors`。本模块只加
 *    "这对阅读者意味着什么"的补充说明——自己再写一遍 `reason === "error" ? …`
 *    就会与列表徽标分叉（design D4 要消灭的正是这个）。
 *
 * 4. **模型输出只是文本**：不执行 HTML/脚本、不自动加载远程图片、不把宿主路径当能力。
 *    本模块只提供**判据**（`containsMarkupLikeText` 等）供测试与提示使用；
 *    真正的安全由渲染方式保证——概览一律走 React 文本节点（`{text}`），
 *    没有任何 `dangerouslySetInnerHTML`，也没有 `<img>`/`<iframe>`。
 *    `auditSafeTextRendering` 把这个"渲染方式契约"变成可断言的对象。
 */

import { forkEditLabel, isPromptForkField } from "@shared/derive";
import type { Outcome, OutcomeKind, OutcomeTone } from "@shared/outcome";
import type {
  CacheCoverage,
  ErrorTarget,
  OutputBlock,
  OwnConsumption,
  OwnOutput,
  ToolErrorTarget,
} from "@shared/overview";
import { decideCompareWithParent } from "./compare-navigation";
import { LINEAGE_INCOMPLETE_TEXT, LINEAGE_METRICS_UNKNOWN_TEXT } from "./detail-completeness";

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
// 概况「结局区」：错误定位 / 限制·中止·中断如实展示（U1 任务 5.2 · design D4）
//
// spec 四场景 → 本模块三件输出：
//   「失败概览定位真实自有调用」  ⇒ `LlmErrorSection.detail`（可定位目标）
//   「旧失败记录没有错误详情」    ⇒ `LlmErrorSection.missing`（缺失说明，不虚构入口）
//   「限制中止与中断如实展示」    ⇒ `OutcomeSection`（限制/中止/中断各自的文字与色调）
//   「无最终正文不借用祖先补全」  ⇒ 5.1 已做；本模块只管"结局本身怎么说"
// ---------------------------------------------------------------------------

/** 概览「结局区」：结局标签 + 是否可执行定位 + 纯说明型补充 */
export interface OutcomeSection {
  kind: OutcomeKind;
  /** 结局中文标签（唯一文案来源：`classifyOutcome`，本模块只做补充说明） */
  label: string;
  tone: OutcomeTone;
  /** 纯说明文字（"达到迭代上限"等既有标签之外的补充）；无补充时为 null */
  note: string | null;
}

/** 概览「自有 LLM 错误区」的两种形态（互斥） */
export type LlmErrorSection =
  | {
      /** 有可定位的自有失败调用：显示错误正文 + 「打开该调用并展开所属 step」 */
      form: "located";
      /** 可定位目标（span + 所属 step）；span 恒非 null */
      target: { spanId: string; stepSpanId: string | null };
      message: string;
      /** HTTP 状态码（未记录为 null，不猜） */
      status: number | null;
    }
  | {
      /** error 终止但自有记录里没有 LLM 错误详情：显示缺失说明，**不给**定位入口 */
      form: "missing";
      note: string;
    }
  | {
      /** 非 error 终止：本区不出现（什么都不显示，而不是显示一个空的错误框） */
      form: "none";
    };

const OUTCOME_NOTE: Partial<Record<OutcomeKind, string>> = {
  max_iterations: "循环达到迭代上限后停止，不是正常结束。",
  budget_exceeded: "token / 预算超出上限后停止，不是正常结束。",
  aborted: "运行被中止，不是正常结束；已记录内容保留在下方。",
  interrupted: "没有记录到终止事件（进程可能被强制结束），不代表仍在执行。",
  unknown: "有终止事件但原因不在已知枚举内，原始原因见运行记录。",
};

/**
 * 由 `classifyOutcome` 的结论算出结局区该说什么。
 *
 * ⚠️ **不自己判结局**：kind/label/tone 全部来自 `classifyOutcome`（唯一判据来源），
 *    本函数只提供"这个结局对概览阅读者意味着什么"的**补充说明**。
 *    自己再写一遍 `reason === "error" ? …` 就会与列表徽标分叉（design D4 要消灭的正是这个）。
 */
export function presentOutcome(outcome: Outcome): OutcomeSection {
  return {
    kind: outcome.kind,
    label: outcome.label,
    tone: outcome.tone,
    note: OUTCOME_NOTE[outcome.kind] ?? null,
  };
}

/**
 * 由 `deriveErrorTarget`（任务 2.2）的结论算出错误区该显示什么。
 *
 * 三分支互斥且**不可合并**：
 * - `located`：有带 error 的自有 llm.call ⇒ 给定位入口（打开调用 + 展开 step）。
 * - `missing`：error 终止但自有记录里没有错误详情（含"仅有工具错误"、"只有祖先有错误"）
 *   ⇒ **只给说明、不给入口**。给一个指向不了任何东西的按钮比不给更糟。
 * - `none`：不是 error 终止 ⇒ 整区不渲染。渲染一个空错误框会让用户以为"有错误但没显示出来"。
 */
export function presentLlmError(target: ErrorTarget): LlmErrorSection {
  if (target.missingDetail) {
    return {
      form: "missing",
      note: "本 run 以错误结束，但自有记录里没有 LLM 错误详情——不反推原因，也不借用祖先的错误。",
    };
  }
  if (target.llmCallSpanId === null) return { form: "none" };
  return {
    form: "located",
    target: { spanId: target.llmCallSpanId, stepSpanId: target.stepSpanId },
    message: target.message ?? "",
    status: target.status,
  };
}

/** 概览「工具错误区」的一行 */
export interface ToolErrorRow {
  spanId: string;
  stepSpanId: string | null;
  tool: string;
  message: string;
}

/**
 * 工具错误的展示行。
 *
 * ⚠️ **刻意与 LLM 错误分区**：工具错误是**数据**、不是终止根因（delta「不断言其为终止根因」）。
 *    两者合并成一个"本次失败原因"框，正是 spec 明文禁止的误归因。
 *    本函数只做透传 + 保证"有工具错误也不影响 LLM 缺失判定"（那是 `presentLlmError` 的事）。
 */
export function presentToolErrors(rows: readonly ToolErrorTarget[]): ToolErrorRow[] {
  return rows.map((row) => ({
    spanId: row.spanId,
    stepSpanId: row.stepSpanId,
    tool: row.tool,
    message: row.message,
  }));
}

// ---------------------------------------------------------------------------
// 概览「本次消耗 / 缓存覆盖 / 父本来源」（U1 任务 5.3 · design D5）
//
// spec「本次指标不累计共享前缀」→ 本模块 `ConsumptionSection` / `CacheSection`；
// spec「来源和隔离边界保持真实」→ 本模块 `SourceSection`。
// ---------------------------------------------------------------------------

/**
 * 概览「本次消耗」区的展示形态。
 *
 * ⚠️ **只呈现"已记录范围"**：`durationMs === null` 时显示「未记录时间跨度」而不是
 *    `—`（那个看上去像"瞬时"）、更不是 `0`——时间未知。同理 token 是**已记录**的合计，
 *    不补零、不估算；失败调用占位 `usage=0` 属于"已记录 0"，`note` 里明说它可能是
 *    占位而非真实零消费（design D5）。
 */
export interface ConsumptionSection {
  tokensIn: number;
  tokensOut: number;
  /** 已记录时间跨度（毫秒）；null = 未记录（界面显示「未记录时间跨度」） */
  durationMs: number | null;
  toolCalls: number;
  toolErrors: number;
  /** 本次消耗的**口径说明**（固定文案，钉住"只算自有段"与"未知不补零"） */
  scopeNote: string;
  /** 失败占位零用量的说明；无占位时为 null */
  zeroUsageNote: string | null;
  cache: CacheSection;
}

/** 概览「缓存覆盖」区的展示形态（与消耗同源，只报已记录范围） */
export interface CacheSection {
  /** 记录了 cache_hit 的自有调用次数（`0` 命中算记录） */
  recorded: number;
  /** 自有调用总次数 */
  total: number;
  /** 已记录命中合计；null = 全无字段（未知 ≠ 0，界面不显示虚构零命中） */
  hitTotal: number | null;
  /** 覆盖说明文字（"已记录 X / Y 次调用的命中量"等） */
  note: string;
}

/**
 * 由 `deriveOwnConsumption`（任务 2.3）的结论算出「本次消耗」区显示什么。
 *
 * ⚠️ **口径说明是判据的一部分，不是装饰**：spec 要求「只派生自有消耗，说明已记录
 *    时间/缓存范围，缺失不补零」。把这段话交给渲染层随手指拼，回归时极易被删；
 *    放在纯函数里就能被断言钉住。
 */
export function presentConsumption(
  consumption: OwnConsumption,
  /** U6 任务 4.1：ownOnly 时追加"沿链指标未知"的固定口径说明（complete 省略） */
  options: { lineageIncomplete?: boolean } = {},
): ConsumptionSection {
  const cache = presentCacheCoverage(consumption.cache);
  return {
    tokensIn: consumption.tokensIn,
    tokensOut: consumption.tokensOut,
    durationMs: consumption.durationMs,
    toolCalls: consumption.toolCalls,
    toolErrors: consumption.toolErrors,
    scopeNote: `仅本次运行自有调用的已记录值；祖先共享前缀不计入，缺失项不补零。${
      options.lineageIncomplete === true ? LINEAGE_METRICS_UNKNOWN_TEXT : ""
    }`,
    // 有自有调用但 token 全为 0：可能是失败调用的占位零用量，也可能确实是空输入/输出。
    // 两种都不声称"实际零消费"——如实说明它只是"记录值"。
    zeroUsageNote:
      consumption.tokensIn === 0 && consumption.tokensOut === 0
        ? "本次自有调用的记录用量为 0——这可能是失败调用的占位值，不据此断言实际零消费。"
        : null,
    cache,
  };
}

/**
 * 缓存覆盖说明。
 *
 * ⚠️ **`recorded === 0` 与 `hitTotal === 0` 是两件事**：
 *    - 无任何 `cache_hit` 字段（`recorded === 0`）⇒ 覆盖"未记录"，`hitTotal` 为 null，
 *      界面**不显示**"0 命中"（那是把"不知道"说成"没有"）。
 *    - 记录下来 0 命中（`recorded > 0` 且 `hitTotal === 0`）⇒ 照常显示"0"（0 是有值）。
 *    概览**不生成**整次确定命中率（design D5：部分记录不能说成整次命中率）。
 */
export function presentCacheCoverage(cache: CacheCoverage): CacheSection {
  if (cache.recorded === 0) {
    return {
      recorded: 0,
      total: cache.total,
      hitTotal: null,
      note:
        cache.total === 0
          ? "本次运行没有自有模型调用，无缓存记录。"
          : `本次 ${cache.total} 次自有模型调用均未记录缓存命中字段，命中量未知。`,
    };
  }
  return {
    recorded: cache.recorded,
    total: cache.total,
    hitTotal: cache.hitTotal,
    note: `已记录 ${cache.recorded} / ${cache.total} 次自有调用的命中量（部分记录不构成整次命中率）。`,
  };
}

// ---------------------------------------------------------------------------
// 父本来源（spec「来源和隔离边界保持真实」）
// ---------------------------------------------------------------------------

/** 概览「来源」区展示形态 */
export interface SourceSection {
  /** 直接父 run id；根 run 为 null */
  parentId: string | null;
  /** 被编辑字段（原值）；根 run 或无分叉为 null */
  editField: string | null;
  /** 编辑字段的中文标签（`forkEditLabel`）；无分叉为 null */
  editLabel: string | null;
  /**
   * 来源关系的**执行语义**说明：
   * - `"shared-prefix"`：result 分叉——父轨迹截至分叉点作为共享前缀；
   * - `"independent"`：prompt fork / model_params——从头重跑的独立新轨迹；
   * - `"proxy"`：代理录制分叉（单请求级编辑重发），不适用"共享前缀"措辞；
   * - `"root"`：根 run，没有来源关系。
   */
  relation: "shared-prefix" | "independent" | "proxy" | "root";
  /** 关系说明文字（唯一文案来源；禁止对独立执行说"共享前缀"） */
  relationNote: string;
  /**
   * U6 任务 4.1：ownOnly 时来源区必须出现的缺失说明（固定提示 + 缺失祖先 run ID）；
   * complete 时为 null。文案唯一来源是 `lib/detail-completeness.ts`，本模块只转述。
   */
  incompleteNote: string | null;
  /** 隔离边界说明（仅隔离 run；否则 null） */
  isolationNote: string | null;
  /** 是否提供「返回父记录」入口（有直接父时才给） */
  canOpenParent: boolean;
  /**
   * U7 任务 2.1：「与父运行对比」入口的可用性（判据唯一来源
   * `decideCompareWithParent`）：
   * - `"available"`：有真实直接父且非 model_params 臂——父左子右打开；
   * - `"blocked-model-params"`：模型实验臂走实验门禁（design D5），不渲染普通入口；
   * - `null`：无 parent 引用（根 run），入口不显示。
   */
  compareWithParent: "available" | "blocked-model-params" | null;
}

/**
 * 由 `detail` 的 meta/chain 派生来源区显示什么。
 *
 * ⚠️ **三条不许含糊**：
 *   1. **父是直接父**：`meta.parent`（不是链首、不是"某个祖先"）。
 *   2. **执行语义按 fork 字段分流**：result 分叉共享前缀，prompt/messages（prompt fork）
 *      与 `model_params` 是**独立执行**——绝不能对它们说"共享执行前缀"（design D5）。
 *   3. **隔离边界如实陈述**：隔离续跑说"父 run 该轮轮末检查点为源"，绝不是"改了文件"——
 *      本模块不复用 `isolatedRunNotice` 那类长文案，只给概览所需的**一句**边界事实；
 *      完整说明仍在 RunWorkspace 顶部（不重复实现）。
 */
export function presentSource(detail: {
  meta: {
    id: string;
    parent: string | null;
    fork: { at_span: string; edit: { field: string } } | null;
    source?: { kind: string } | undefined;
    workspace?: { world_id: string; origin: { kind: string; run_id?: string } } | undefined;
  };
  chain: ReadonlyArray<unknown>;
  /**
   * U6 任务 4.1：详情完整性元数据（载荷受校验，renderer 不从 chain 长度猜）。
   * 省略 = complete（老调用方兼容：本包内只有 OverviewPanel 传入完整 detail）。
   */
  completeness?: "complete" | "ownOnly";
  lineage?: { status: "complete" } | { status: "incomplete"; reason: string; missingRunId: string };
}): SourceSection {
  const { parent, fork } = detail.meta;
  const isolated = detail.meta.workspace !== undefined;
  // ownOnly 展示事实（唯一判据来源：detail-completeness；这里只转述，不另写文案）
  const incompleteView =
    detail.completeness === "ownOnly" &&
    detail.lineage !== undefined &&
    detail.lineage.status === "incomplete"
      ? {
          missingRunId: detail.lineage.missingRunId,
          note: `${LINEAGE_INCOMPLETE_TEXT}（缺失祖先 run：${detail.lineage.missingRunId}）`,
        }
      : null;

  // 根 run：无来源关系（隔离根 run 的 world 是从源目录采集来的，仍算"无父"，另给隔离说明）
  if (parent === null && fork === null) {
    return {
      parentId: null,
      editField: null,
      editLabel: null,
      relation: "root",
      relationNote: isolated
        ? "这是隔离文件世界的根运行：文件世界由选定源目录采集而来，没有上游运行记录。"
        : "这是根运行，没有上游来源记录。",
      incompleteNote: incompleteView?.note ?? null,
      isolationNote: isolated
        ? "隔离文件运行：文件读写只发生在独立世界里，源目录不会被修改。"
        : null,
      canOpenParent: false,
      // 根 run：无 parent 引用 ⇒ 比较入口不显示（scenario「无 parent 不显示入口」）
      compareWithParent: null,
    };
  }

  const field = fork?.edit.field ?? null;
  const isProxy = detail.meta.source?.kind === "proxy";

  let relation: SourceSection["relation"];
  let relationNote: string;
  if (isProxy) {
    // 代理分叉：单请求级编辑重发——不复用 result 分叉的"共享前缀"措辞
    relation = "proxy";
    relationNote =
      "代理录制的分叉运行（单请求级编辑重发）：来源关系见父链列表，本 run 只呈现自身记录。";
  } else if (field !== null && isPromptForkField(field)) {
    relation = "independent";
    relationNote =
      "prompt fork（从头重跑）：本 run 是独立执行，不共享父轨迹前缀，父 run 仅作溯源对照。";
  } else if (field === "model_params") {
    relation = "independent";
    relationNote =
      "模型 A/B 臂（从头重跑）：本 run 是独立执行，不共享父轨迹前缀，父 run 仅作对照。";
  } else if (incompleteView !== null) {
    // U6 任务 4.1：ownOnly 的 result 分支**不得**声称共享前缀——父前缀没进时间线，
    // 沿链指标未知。固定提示 + 缺失 ID 走 incompleteNote，这里只换掉关系说明。
    relation = "shared-prefix";
    relationNote =
      "父链不完整：仅显示本运行记录的自有轨迹，共享前缀与祖先增量未知，不补零、不推算。";
  } else {
    relation = "shared-prefix";
    relationNote = "父 run 的轨迹截至分叉点为共享前缀（来自父 run 文件，本 run 只记录新增 span）。";
  }

  return {
    parentId: parent,
    editField: field,
    editLabel: field === null ? null : forkEditLabel(field),
    relation,
    relationNote,
    incompleteNote: incompleteView?.note ?? null,
    // 隔离 branch：origin.run_id 才是"从哪个 run 续跑"的真实来源（不冒充共享前缀）
    isolationNote: isolated
      ? detail.meta.workspace?.origin.kind === "checkpoint"
        ? `隔离续跑：从运行 ${detail.meta.workspace.origin.run_id ?? parent} 的轮末检查点出发，文件读写只发生在独立世界里。`
        : "隔离文件运行：文件读写只发生在独立世界里，源目录不会被修改。"
      : null,
    canOpenParent: parent !== null,
    // U7 2.1：父子比较入口判据唯一来源在 compare-navigation（父左子右 / 实验门禁）
    compareWithParent: (() => {
      const decision = decideCompareWithParent(detail);
      switch (decision.kind) {
        case "open":
          return "available" as const;
        case "blocked":
          return "blocked-model-params" as const;
        case "hidden":
          return null;
      }
    })(),
  };
}

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
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 源码级"禁用型"断言的**通用审计**：先剥注释，再逐个查禁用片段，返回命中的那些。
 *
 * ⚠️ 存在的理由（血泪）：这条纪律在本 change 里**反复**被违反——5.1、5.2、5.7、6.2 四次
 *    都把禁用写法写进了自己的文档注释（"从不 `dangerouslySetInnerHTML`"、"不再自造
 *    `statusDotClass`"），然后手写 `expect(src).not.toContain(...)` 就被自己的注释判红。
 *    每次现场手写 `not.toContain` 都会重踩 ⇒ 统一收敛到本函数，调用方只断言返回值是空数组。
 *
 * @param source 待审计的源码文本
 * @param forbidden 禁用片段（标识符 / 标签 / 表达式）
 * @returns 命中的禁用片段（空数组 = 合规）
 */
export function auditForbiddenTokens(source: string, forbidden: readonly string[]): string[] {
  const code = stripComments(source);
  return forbidden.filter((token) => code.includes(token));
}
