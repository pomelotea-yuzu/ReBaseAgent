import { classifyOutcome } from "@rebaseagent/run-query";
import type { OutcomeKind, RunSummary } from "@rebaseagent/run-query";
import { z } from "zod";
import { MESSAGE_MAX, PAGE_LIMIT_DEFAULT, RUN_ID_MAX } from "../limits.js";
import type { RUN_STATUS_FILTERS } from "../tool-contracts.js";

/**
 * 外部投影的共用件（design D5/D7 的白名单那一段）。
 *
 * 三条纪律：
 * - **判据不重写**：结局分类调共享层 `classifyOutcome`，摘要数字用共享层
 *   `deriveRunSummary` 的产出；本层只做「哪些字段可以外发」的裁剪与改名。
 * - **正文一律不出门**：`fork.edit.value`、`llm.call.request.messages`、
 *   `llm.call.response.content/reasoning_content`、`tool.invoke.result/args`、
 *   `prompt_experiment.original_value/hypothesis/acceptance_criterion` 都不在本表的字段集里
 *   （读取正文走 get_step 的 section，4.4）。
 * - **视图事实不带出**：中文标签、语义色（`Outcome.label/tone`）留给桌面，外部只拿
 *   稳定的类别标识。
 */

export type StatusFilter = (typeof RUN_STATUS_FILTERS)[number];

/**
 * 类别筛选 → 结局种类。判据仍是 `classifyOutcome`，本表只回答「哪些算这一类」：
 * - `termination_not_recorded` = 无终止事件（`crashed`），不是「仍在运行」；
 * - `limited` = 迭代上限与超出预算两种「被限制住」；
 * - `unknown`（有终止事件但原因不在既有枚举）只出现在 `all` 下——它既不是出错也不是
 *   正常结束，更不等于没有终止事件，硬塞进任一类别都是把未知说成已知。
 */
export const OUTCOME_BY_FILTER: Readonly<
  Record<Exclude<StatusFilter, "all">, readonly OutcomeKind[]>
> = {
  errored: ["error"],
  ended_without_error: ["completed"],
  limited: ["max_iterations", "budget_exceeded"],
  aborted: ["aborted"],
  termination_not_recorded: ["interrupted"],
};

/** 结局类别（外部稳定标识；中文文案留在桌面） */
export const OutcomeTagSchema = z
  .object({
    kind: z.enum([
      "completed",
      "error",
      "max_iterations",
      "budget_exceeded",
      "aborted",
      "interrupted",
      "unknown",
    ]),
    /** 原始终止原因；未记录终止事件与正常结束都为 null */
    reason: z.string().min(1).max(MESSAGE_MAX).nullable(),
    /** 是否已封存（有终止事件）；`false` 不能反推「仍在运行」 */
    sealed: z.boolean(),
  })
  .strict();
export type OutcomeTag = z.infer<typeof OutcomeTagSchema>;

export function outcomeTagOf(summary: RunSummary): OutcomeTag {
  return {
    kind: classifyOutcome({ status: summary.status, reason: summary.reason }).kind,
    reason: summary.reason,
    sealed: summary.status === "completed",
  };
}

export function matchesOutcome(summary: RunSummary, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  const kinds = OUTCOME_BY_FILTER[filter];
  return kinds.includes(classifyOutcome({ status: summary.status, reason: summary.reason }).kind);
}

/**
 * `query` 只匹配**完整** task 文本与 run 标识（design D5）：不搜正文、不搜模型名、
 * 不对截断后的前缀做匹配（截断匹配会让「搜到 3 条」和桌面看到的条数不一致）。
 */
export function matchesQuery(summary: RunSummary, query: string): boolean {
  const needle = query.toLowerCase();
  return summary.task.toLowerCase().includes(needle) || summary.id.toLowerCase().includes(needle);
}

/**
 * 安全文件标识（design D5「失败项排后按安全文件标识排序」）。
 *
 * 失败文件没有可信身份（它可能就是解析不了的），文件名是唯一能给的定位信息，
 * 但它同时是**文件系统给的**、未经任何 schema 校验的字符串，所以外发前：
 * - 剥掉控制字符与分隔符（防把转义/换行塞进客户端转录，也防被当路径再拼一次）；
 * - 按码点截断（文件名不参与身份核验，截断只影响可读性，完整信息仍在磁盘上，
 *   而摘要段永远不给物理路径）。
 */

/**
 * 判断「不能原样外发」的字符：C0/C1 控制区（会把换行/转义塞进客户端转录）与
 * 路径分隔符（文件名本不该有，出现即剥掉，绝不让它被当成路径再拼一次）。
 * 逐码点过滤而不是正则字符类：控制字符写进字面正则本身就是 lint 告警点。
 */
function isUnsafeFileChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || ch === "/" || ch === "\\";
}

export function safeFileIdentifier(file: string): string {
  const cleaned = [...file].filter((ch) => !isUnsafeFileChar(ch)).join("");
  const chars = [...cleaned];
  return chars.length <= RUN_ID_MAX ? cleaned : `${chars.slice(0, RUN_ID_MAX - 1).join("")}…`;
}

/**
 * 白名单摘要条目：列表行与 get_run 的 `run` 段共用同一字段集，
 * 避免「列表说的」和「详情说的」两处漂移。
 */
export const RunSummaryItemSchema = z
  .object({
    runId: z.string().min(1).max(RUN_ID_MAX),
    task: z.string(),
    model: z.string(),
    createdAt: z.string().min(1),
    /** 列表侧能直接判定的版本（同一次扫描已读到，不做第二次解析） */
    formatVersion: z.number().int().positive().optional(),
    outcome: OutcomeTagSchema,
    parentRunId: z.string().min(1).nullable(),
    /** 分叉事实：只有分叉点与字段名，`edit.value` 正文不在其中（design D5） */
    fork: z
      .object({
        atSpan: z.string().min(1),
        editField: z.string().min(1),
        experimentId: z.string().min(1).nullable(),
      })
      .nullable(),
    /** 录制通道：代理录制为 "proxy"，直录/老文件为 null */
    source: z.enum(["proxy"]).nullable(),
    counts: z
      .object({
        steps: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        toolErrors: z.number().int().nonnegative(),
      })
      .strict(),
    tokens: z
      .object({
        in: z.number().int().nonnegative(),
        out: z.number().int().nonnegative(),
        /** null = 全部 llm.call 都没录 cache_hit（未知）；0 = 实测零命中 */
        cacheHit: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    /** null = 无任一 span 带有效 timing（时间未知） */
    durationMs: z.number().nonnegative().nullable(),
  })
  .strict();
export type RunSummaryItem = z.infer<typeof RunSummaryItemSchema>;

export function projectRunSummary(summary: RunSummary, formatVersion?: number): RunSummaryItem {
  const item: RunSummaryItem = {
    runId: summary.id,
    task: summary.task,
    model: summary.model,
    createdAt: summary.created_at,
    outcome: outcomeTagOf(summary),
    parentRunId: summary.parent,
    fork:
      summary.fork === null
        ? null
        : {
            atSpan: summary.fork.at_span,
            editField: summary.fork.edit_field,
            experimentId: summary.fork.experiment_id,
          },
    source: summary.source,
    counts: {
      steps: summary.steps,
      toolCalls: summary.toolCalls,
      toolErrors: summary.toolErrors,
    },
    tokens: {
      in: summary.tokensIn,
      out: summary.tokensOut,
      cacheHit: summary.cacheHit,
    },
    durationMs: summary.durationMs,
  };
  return formatVersion === undefined ? item : { ...item, formatVersion };
}

/**
 * 分页窗口（design D5 的条目上限；游标签发与续读核验归 5.2）。
 *
 * 4.3 刻意**不发游标**：没有认证游标可发时，被截断的页如实标 `truncated:true` 且
 * `nextCursor` 缺席——客户端据此知道「还有更多，但本版本还不能续读」，
 * 而不是拿到一个假指针反复读到同一页。
 */
export interface PageWindow<T> {
  readonly items: T[];
  readonly truncated: boolean;
  readonly remaining: number;
}

export function takeWindow<T>(all: readonly T[], limit: number | undefined): PageWindow<T> {
  const size = limit ?? PAGE_LIMIT_DEFAULT;
  return {
    items: all.slice(0, size),
    truncated: all.length > size,
    remaining: Math.max(0, all.length - size),
  };
}

/**
 * 排序：摘要按 `created_at` 倒序，同一时刻按 run 标识的 **UTF-16 代码单元升序**。
 *
 * 用代码单元而不是 `localeCompare`：外部协议要给一个与语言环境无关、翻页期间稳定的
 * 顺序（design D5/D6「按固定顺序无重漏分页」），区域设置一变顺序就漂。
 */
export function compareSummaryOrder(
  a: { createdAt: string; runId: string },
  b: { createdAt: string; runId: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

/** 失败项按安全文件标识升序（同一序列里位置稳定，分页才无重不漏） */
export function compareFileOrder(a: { file: string }, b: { file: string }): number {
  if (a.file === b.file) return 0;
  return a.file < b.file ? -1 : 1;
}
