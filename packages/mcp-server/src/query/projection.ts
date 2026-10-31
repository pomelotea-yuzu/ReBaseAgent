import type { Translator } from "@rebaseagent/i18n";
import { classifyOutcome } from "@rebaseagent/run-query";
import type {
  CompareSideFailureCode,
  OutcomeKind,
  RunDetail,
  RunQueryToolErrorCode,
  RunSummary,
  WorkspaceInspectFile,
  WorkspaceInspectResult,
} from "@rebaseagent/run-query";
import { z } from "zod";
import type { ProvenanceRunInput } from "../envelope.js";
import {
  type ProjectedToolError,
  TOOL_ERROR_MESSAGE_KEYS,
  ToolErrorCodeSchema,
  boundedMessage,
  retryableOf,
} from "../error-projection.js";
import { LOGICAL_PATH_MAX, MESSAGE_MAX, PAGE_LIMIT_DEFAULT, RUN_ID_MAX } from "../limits.js";
import type { RUN_STATUS_FILTERS } from "../tool-contracts.js";

/** span 的行类型由共享层的详情派生（本包不直接依赖 trace-sdk 的类型出口） */
export type ProjectedSpanInput = RunDetail["spans"][number];

/**
 * 外部投影的共用件（design D5/D7 的白名单那一段）。
 *
 * 三条纪律：
 * - **判据不重写**：结局分类调共享层 `classifyOutcome`，摘要数字用共享层
 *   `deriveRunSummary` 的产出；本层只做「哪些字段可以外发」的裁剪与改名。
 * - **正文一律不出门**：`fork.edit.value`、`llm.call.request.messages`、
 *   `llm.call.response.content/reasoning_content`、`tool.invoke.result/args`、
 *   `prompt_experiment.original_value/hypothesis/acceptance_criterion` 都不在本表的字段集里
 *   都不在本表的字段集里（要正文只能走 get_step 的显式 section）。
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

/**
 * 摘要 → 白名单条目。
 *
 * 带 `formatVersion` 的重载只为一件事：调用方**读过**记录（get_run/compare_runs 的详情侧）
 * 时版本是已知事实，类型上就不该还能是 `undefined`；列表侧（list_runs）用的是同一次扫描
 * 带来的版本，同样走这一支。省略参数 = 本次没把这个事实拿来，字段缺席而不是补 0。
 */
export function projectRunSummary(summary: RunSummary): RunSummaryItem;
export function projectRunSummary(
  summary: RunSummary,
  formatVersion: number,
): RunSummaryItem & { formatVersion: number };
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

// ---------------------------------------------------------------------------
// 干预段：get_run 与 compare_runs 共用（「同一件事在两处说法不同」是本包最容易漂的地方）
// ---------------------------------------------------------------------------

/**
 * 64 位小写十六进制内容哈希：快照 id 与附件哈希是同一形状（一处正则，两个语义名）。
 * envelope 里 snapshotId 的自检判据与此一致。
 */
export const ContentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "内容哈希必须是 64 位小写十六进制");

const SnapshotIdSchema = ContentHashSchema;

export const InterventionSchema = z
  .object({
    fork: z
      .object({
        atSpan: z.string().min(1),
        editField: z.string().min(1),
        /** v1 分叉没有整轮边界字段 ⇒ null（不是"边界是空字符串"） */
        resumeAfterStep: z.string().min(1).nullable(),
        /** 实验组标签：仅 model_params 分叉有值，由共享层摘要派生，不碰 edit.value */
        experimentId: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    /**
     * v3 隔离 prompt 实验的**身份**。刻意不含：`original_value`（原值正文）、
     * `hypothesis`/`acceptance_criterion`（假设与人工判据）、`execution.params` 表本身
     * 与 `provider_endpoint`（端点面，design D7）——参数只说「录没录」，
     * 因为「未录」与「录了空对象」是两种事实。
     */
    experiment: z
      .object({
        baselineRunId: z.string().min(1),
        baselineLlmSpanId: z.string().min(1),
        initialSnapshotId: SnapshotIdSchema,
        execution: z
          .object({
            model: z.string().min(1),
            maxIterations: z.number().int().positive(),
            maxTotalTokens: z.number().int().positive(),
            configFingerprint: z.string().min(1),
            paramsRecorded: z.boolean(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Intervention = z.infer<typeof InterventionSchema>;

export function projectIntervention(detail: RunDetail, ownSummary: RunSummary): Intervention {
  const fork = detail.meta.fork;
  const experiment = detail.meta.prompt_experiment;
  return {
    fork:
      fork === null
        ? null
        : {
            atSpan: fork.at_span,
            editField: fork.edit.field,
            resumeAfterStep: fork.resume_after_step ?? null,
            experimentId: projectRunSummary(ownSummary).fork?.experimentId ?? null,
          },
    experiment:
      experiment === undefined
        ? null
        : {
            baselineRunId: experiment.baseline_run_id,
            baselineLlmSpanId: experiment.baseline_llm_span_id,
            initialSnapshotId: experiment.initial_snapshot_id,
            execution: {
              model: experiment.execution.model,
              maxIterations: experiment.execution.max_iterations,
              maxTotalTokens: experiment.execution.budget,
              configFingerprint: experiment.execution.config_fingerprint,
              paramsRecorded: experiment.execution.params !== undefined,
            },
          },
  };
}

// ---------------------------------------------------------------------------
// 消耗段：get_run 与 compare_runs 共用同一口径
// ---------------------------------------------------------------------------

/**
 * 本次消耗（= 本 run **自有** spans 的聚合）。
 *
 * 缓存覆盖用 `{recorded,total,hitTotal}` 三件而非一个数字：`recorded<total` 说的是
 * 「部分调用没录 cache_hit」，这时 `hitTotal` 只是**已录部分**的和，不能当全量命中读。
 */
export const OwnConsumptionSchema = z
  .object({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().nullable(),
    toolCalls: z.number().int().nonnegative(),
    toolErrors: z.number().int().nonnegative(),
    cache: z
      .object({
        recorded: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        /** null = 没有任何一次调用录了 cache_hit（未知）；0 = 实测零命中 */
        hitTotal: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * 沿 parent 链求和的**累计增量**。措辞纪律：这是「沿链求和的累计增量」，
 * 不是"总耗时/总成本"——它不代表从头连续跑一次会花多少（design D4/branch-tree 同源）。
 * 链上任一段缺失或成环 ⇒ 整条为 null，不补 0、不估算。
 */
export const ChainTotalsSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    toolErrors: z.number().int().nonnegative(),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().nullable(),
  })
  .strict();

/** 相对共同祖先的增量差 = 该侧累计 − 祖先累计；无可比基线时为 null */
export const AncestorDeltaSchema = z
  .object({
    tokens: z.number().int(),
    durationMs: z.number().nullable(),
  })
  .strict();

/** 失败项按安全文件标识升序（同一序列里位置稳定，分页才无重不漏） */
export function compareFileOrder(a: { file: string }, b: { file: string }): number {
  if (a.file === b.file) return 0;
  return a.file < b.file ? -1 : 1;
}

// ---------------------------------------------------------------------------
// span 索引项与来源段：get_run 的索引、get_step 的归属同一份形状（两处不漂）
// ---------------------------------------------------------------------------

const SpanTimingSchema = z
  .object({ startedAt: z.string().min(1), endedAt: z.string().min(1) })
  .strict();

/**
 * span 索引项的公共段。
 *
 * `ownerRunId` 取自共享投影的**逐位置归属**（不是按 id 猜）：重名 span 只能靠位置区分。
 * `ambiguousOwner` 提前告诉客户端「这个 id 在链上还属于别的 run」，免得它拿同一个 id
 * 去调 get_step 才被 SPAN_AMBIGUOUS 弹回来。
 */
const SpanItemCommon = {
  kind: z.literal("span"),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullable(),
  ownerRunId: z.string().min(1),
  /** true = 属于本次请求的 run；false = 继承自来源链 */
  own: z.boolean(),
  ambiguousOwner: z.boolean(),
  /** null = 该 span 没录 timing（时间未知，不拿 created_at 凑） */
  timing: SpanTimingSchema.nullable(),
};

export const SpanItemSchema = z.discriminatedUnion("spanKind", [
  z
    .object({
      ...SpanItemCommon,
      spanKind: z.literal("agent.step"),
      /** 所属 run 自己的轮号，绝不按合并轨迹沿链累加 */
      iteration: z.number().int().positive(),
      hasWorkspaceSnapshot: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...SpanItemCommon,
      spanKind: z.literal("llm.call"),
      requestModel: z.string().min(1),
      usage: z
        .object({
          in: z.number().int().nonnegative(),
          out: z.number().int().nonnegative(),
          /** null = 本次调用未录 cache_hit（未知）；0 = 实测零命中 */
          cacheHit: z.number().int().nonnegative().nullable(),
        })
        .strict(),
      /** 只说「有没有录到错误详情」；正文由 section=error 显式取 */
      errorRecorded: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...SpanItemCommon,
      spanKind: z.literal("tool.invoke"),
      tool: z.string().min(1),
      durationMs: z.number().nonnegative(),
      /** 工具录有错误 ≠ 运行出错（design D5），两者各自呈现 */
      errorRecorded: z.boolean(),
    })
    .strict(),
]);
export type SpanItem = z.infer<typeof SpanItemSchema>;

/** 元数据投影：按 kind 只带结构性事实，一个正文字段都不碰 */
export function projectSpanItem(
  span: ProjectedSpanInput,
  ownerRunId: string,
  own: boolean,
  ambiguousOwner: boolean,
): SpanItem {
  const base = {
    kind: "span" as const,
    spanId: span.id,
    parentSpanId: span.parent,
    ownerRunId,
    own,
    ambiguousOwner,
    timing:
      span.timing === undefined
        ? null
        : { startedAt: span.timing.started_at, endedAt: span.timing.ended_at },
  };
  switch (span.kind) {
    case "agent.step":
      return {
        ...base,
        spanKind: "agent.step",
        iteration: span.n,
        hasWorkspaceSnapshot: span.workspace_snapshot !== undefined,
      };
    case "llm.call":
      return {
        ...base,
        spanKind: "llm.call",
        requestModel: span.request.model,
        usage: {
          in: span.response.usage.in,
          out: span.response.usage.out,
          cacheHit: span.response.usage.cache_hit ?? null,
        },
        errorRecorded: span.error !== undefined,
      };
    case "tool.invoke":
      return {
        ...base,
        spanKind: "tool.invoke",
        tool: span.tool,
        durationMs: span.dur_ms,
        errorRecorded: span.error !== null,
      };
  }
}

/**
 * 逐物理 run 的来源段：`sealed` 由各自记录判（不拿叶子状态往上套），
 * 轨迹范围与来源完整性只对**本次读过轨迹的那个叶子**成立（其余留空 = 未判定）。
 *
 * `detail.chain` 与 `chainSummaries` 必须同长同序（同一个 `outcome.records` 派生）；
 * 对不上就是投影异常，返回 null 由调用方拒绝，不按位置猜一个来源标签发出去。
 */
export function provenanceRunsOf(
  detail: RunDetail,
  chainSummaries: readonly RunSummary[],
): ProvenanceRunInput[] | null {
  if (chainSummaries.length !== detail.chain.length) return null;
  const lastIndex = detail.chain.length - 1;
  return detail.chain.map((hop, index) => ({
    runId: hop.meta.id,
    formatVersion: hop.meta.format_version,
    sealed: chainSummaries[index]?.status === "completed",
    ...(index === lastIndex ? { lineage: detail.lineage.status, spanScope: detail.spanScope } : {}),
  }));
}

// ---------------------------------------------------------------------------
// 检查点段：get_run 索引、inspect_checkpoint 清单、read_checkpoint_file 的 selector
// 三处共用同一形状（4.6 上收；同一件事在三处说法不同是本包最容易漂的地方）
// ---------------------------------------------------------------------------

/** 世界来源：与共享层 `WorkspaceOrigin` 同形，只做跨进程改名（snake_case → camelCase） */
export const WorldOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("import") }).strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      runId: z.string().min(1),
      stepSpanId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("initial"),
      runId: z.string().min(1),
      snapshotId: SnapshotIdSchema,
    })
    .strict(),
]);
export type WorldOrigin = z.infer<typeof WorldOriginSchema>;

export function projectWorldOrigin(
  origin:
    | { readonly kind: "import" }
    | { readonly kind: "checkpoint"; readonly run_id: string; readonly step_span: string }
    | { readonly kind: "initial"; readonly run_id: string; readonly snapshot_id: string },
): WorldOrigin {
  switch (origin.kind) {
    case "import":
      return { kind: "import" };
    case "checkpoint":
      return { kind: "checkpoint", runId: origin.run_id, stepSpanId: origin.step_span };
    case "initial":
      return { kind: "initial", runId: origin.run_id, snapshotId: origin.snapshot_id };
  }
}

export const CheckpointItemSchema = z
  .object({
    kind: z.literal("checkpoint"),
    /** null = 本 run 的初始快照（`inspect_checkpoint` 省略 stepSpanId 时的那一份） */
    stepSpanId: z.string().min(1).nullable(),
    /** 本 run 自己的轮号；初始快照恒为 null */
    iteration: z.number().int().positive().nullable(),
    snapshotId: SnapshotIdSchema,
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    /** 只有初始快照带世界来源；自有 step 的检查点本来就属于本 run */
    worldOrigin: WorldOriginSchema.nullable(),
  })
  .strict();
export type CheckpointItem = z.infer<typeof CheckpointItemSchema>;

function snapshotFileFacts(files: readonly { bytes: number }[]): {
  fileCount: number;
  totalBytes: number;
} {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/**
 * 本 run 的自有检查点索引：初始快照在前（省略 selector 时 `inspect_checkpoint` 给的就是它），
 * 其后按本 run 自有记录序。**祖先步骤天然不在内**——不代填、不换最近步骤（Q13）。
 *
 * 「自有」用 `leafSpanIds`（= 本 run 文件里那些 span 的 id），与 `get_run` 检查点段 4.3 起
 * 的判据逐字相同：提取共用件时不换判据。合并详情里出现重名 id 会在共享层的载荷自检就被拒
 * （`spans 存在重复 id`），所以这里不存在「按 id 判自有会挑中祖先」的可达形态——
 * 不为一支不可达的归属分支改写既有事实。
 */
export function ownCheckpointItems(
  detail: RunDetail,
  ownSpanIds: ReadonlySet<string>,
): CheckpointItem[] {
  const items: CheckpointItem[] = [];
  const workspace = detail.meta.workspace;
  if (workspace !== undefined) {
    items.push({
      kind: "checkpoint",
      stepSpanId: null,
      iteration: null,
      snapshotId: workspace.initial_snapshot.id,
      ...snapshotFileFacts(workspace.initial_snapshot.files),
      worldOrigin: projectWorldOrigin(workspace.origin),
    });
  }
  for (const span of detail.spans) {
    if (span.kind !== "agent.step" || !ownSpanIds.has(span.id)) continue;
    const snapshot = span.workspace_snapshot;
    if (snapshot === undefined) continue;
    items.push({
      kind: "checkpoint",
      stepSpanId: span.id,
      iteration: span.n,
      snapshotId: snapshot.id,
      ...snapshotFileFacts(snapshot.files),
      worldOrigin: null,
    });
  }
  return items;
}

/**
 * 按 selector 取本 run 自有检查点；`undefined` = 当前可读投影里没有这份自有检查点。
 * `stepSpanId = null` 表示初始快照（与「没有这个 step」不是同一件事）。
 */
export function ownCheckpointOf(
  items: readonly CheckpointItem[],
  stepSpanId: string | null,
): CheckpointItem | undefined {
  return items.find((item) => item.stepSpanId === stepSpanId);
}

/**
 * 清单里的一条文件（`inspect_checkpoint` 的分页条目）。
 *
 * `sha256`/`bytes` 属于**清单记录的完整历史文件**，不是任何片段的校验值（design D6/D7）；
 * 正文一律不在这里——要内容只能显式走 `read_checkpoint_file` 的 `path`。
 */
export const CheckpointFileItemSchema = z
  .object({
    path: z.string().min(1).max(LOGICAL_PATH_MAX),
    bytes: z.number().int().nonnegative(),
    sha256: SnapshotIdSchema,
    /** 相对**本 run 初始快照**的状态；判据只有「路径 + 哈希」，不使用 mtime */
    change: z.enum(["added", "modified", "unchanged", "initial"]),
    /** 三态必须可分辨：缺失/损坏不得渲染成空文件 */
    availability: z.enum(["ok", "missing", "corrupt"]),
    unavailableReason: z.string().min(1).max(MESSAGE_MAX).nullable(),
  })
  .strict();
export type CheckpointFileItem = z.infer<typeof CheckpointFileItemSchema>;

export function projectCheckpointFile(file: WorkspaceInspectFile): CheckpointFileItem {
  return {
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    change: file.change,
    availability: file.availability,
    unavailableReason:
      file.unavailableReason === null ? null : boundedMessage(file.unavailableReason),
  };
}

/** 检查点头：清单定位与汇总数字（逐项文件走分页，不在这里重复一遍） */
export const CheckpointHeadSchema = z
  .object({
    runId: z.string().min(1),
    ownerRunId: z.string().min(1),
    /** null = 本次读的就是初始快照 */
    stepSpanId: z.string().min(1).nullable(),
    snapshotId: SnapshotIdSchema,
    /** 本 run 的初始快照 id：分支 run 的「相对初始」是它自己的初始，不是父 run 的 */
    initialSnapshotId: SnapshotIdSchema,
    localIteration: z.number().int().positive().nullable(),
    profile: z.string(),
    worldId: z.string(),
    worldOrigin: WorldOriginSchema,
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    unavailableCount: z.number().int().nonnegative(),
  })
  .strict();
export type CheckpointHead = z.infer<typeof CheckpointHeadSchema>;

export function projectCheckpointHead(result: WorkspaceInspectResult): CheckpointHead {
  return {
    runId: result.runId,
    ownerRunId: result.ownerRunId,
    stepSpanId: result.stepSpanId,
    snapshotId: result.snapshotId,
    initialSnapshotId: result.initialSnapshotId,
    localIteration: result.localIteration,
    profile: result.profile,
    worldId: result.worldId,
    worldOrigin: result.origin,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
    unavailableCount: result.unavailableCount,
  };
}

// ---------------------------------------------------------------------------
// 检查点定位失败 → 稳定码（design D4 的码表封闭）
// ---------------------------------------------------------------------------

/**
 * 两种载体、一份映射：`inspectWorkspace` 的 `outcome.code` 是 `WORKSPACE_<大写码>`
 * （桌面 IPC 沿用，D2 不得改），`readWorkspaceFileForView` 的 `rejected.code` 与
 * 比较层的 `failure.code` 是裸码（比较层多一码 `identity_mismatch`）。
 * 先归一成裸码再查表——两处各写一份映射才是漂移的起点。
 */
const CODE_BY_LOCATE: Readonly<Record<CompareSideFailureCode, RunQueryToolErrorCode>> = {
  invalid_request: "INVALID_ARGUMENT",
  run_not_found: "RUN_NOT_FOUND",
  trace_invalid: "RUN_INVALID",
  no_workspace: "NO_WORKSPACE",
  step_not_found: "STEP_NOT_FOUND",
  identity_mismatch: "IDENTITY_MISMATCH",
};

function isKnownLocateCode(code: string): code is CompareSideFailureCode {
  return Object.prototype.hasOwnProperty.call(CODE_BY_LOCATE, code);
}

/**
 * 定位失败码映射到封闭码表；表里没有的码一律落 `RUN_INVALID`（D4 的兜底口径：
 * 无法可靠细分就按「记录无法通过校验」收口，不自行造码）。
 *
 * `STEP_NOT_FOUND` 与 `get_step` 同码不同景（4.4 已把该码文案扩为「在当前可读投影里
 * 不可定位」）：这里承载「指定 step 不是本 run 自有完成步骤」，两种情形靠 `ref` 区分。
 */
export function toolCodeOfLocateFailure(code: string): RunQueryToolErrorCode {
  const bare = code.startsWith("WORKSPACE_") ? code.slice("WORKSPACE_".length).toLowerCase() : code;
  return isKnownLocateCode(bare) ? CODE_BY_LOCATE[bare] : "RUN_INVALID";
}

/** 失败定位只给结构（run / step / 逻辑路径），不给共享层的中文原因与任何物理路径 */
export function locateRefOf(input: {
  runId: string;
  stepSpanId?: string | undefined;
  path?: string | undefined;
}): string {
  const parts = [`run:${input.runId}`];
  if (input.stepSpanId !== undefined) parts.push(`step:${input.stepSpanId}`);
  if (input.path !== undefined) parts.push(`path:${boundedMessage(input.path)}`);
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// 逐侧形状：compare_runs（4.5）与 compare_checkpoint_files（4.7）共用同一种说法
// ---------------------------------------------------------------------------

/** 左右恒定的两侧名；「这一侧不可读」因此才有确定含义（design D5） */
export const SideNameSchema = z.enum(["left", "right"]);
export type SideName = z.infer<typeof SideNameSchema>;

/**
 * 坏侧的公开形状：**保留真实身份 + 稳定码 + 码表文案**，另一侧照常（Q11）。
 * 一格都不会因为另一格坏了而被省掉，也不把坏侧当"空运行"。
 */
export const UnavailableSideSchema = z
  .object({
    side: SideNameSchema,
    status: z.literal("unavailable"),
    /** 该侧真实身份（不伪空、不借另一侧顶替） */
    runId: z.string().min(1).max(RUN_ID_MAX),
    code: ToolErrorCodeSchema,
    message: z.string().min(1).max(MESSAGE_MAX),
    retryable: z.boolean(),
  })
  .strict();
export type UnavailableSide = z.infer<typeof UnavailableSideSchema>;

/** 由投影后的错误造坏侧格（文案取自码表，不取自异常文本） */
export function unavailableSideOf(
  side: SideName,
  runId: string,
  error: ProjectedToolError,
): UnavailableSide {
  return {
    side,
    status: "unavailable",
    runId,
    code: error.code,
    message: boundedMessage(error.message),
    retryable: error.retryable,
  };
}

/** 稳定码 → 坏侧格（比较层逐侧的定位失败走这一条，与 `ToolFailure` 同一张码表） */
export function unavailableSideOfCode(
  side: SideName,
  runId: string,
  code: RunQueryToolErrorCode,
  translator: Translator,
): UnavailableSide {
  return {
    side,
    status: "unavailable",
    runId,
    code,
    message: boundedMessage(translator.t(TOOL_ERROR_MESSAGE_KEYS[code])),
    retryable: retryableOf(code),
  };
}
