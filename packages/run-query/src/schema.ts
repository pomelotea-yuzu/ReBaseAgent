import {
  ForkSchema,
  RunEventSchema,
  RunMetaSchema,
  SpanSchema,
} from "@rebaseagent/trace-sdk/schema";
import { z } from "zod";
import { findRunDetailIntegrityViolation } from "./run-detail-integrity.js";

/**
 * 桌面 IPC 与 MCP 共用的**领域 schema**。
 *
 * 只包含运行摘要/详情/比较/检查点读取这些只读事实的跨进程形状；
 * CHANNELS、IPC 信封、执行/操作/代理/导出 schema 留在 desktop。
 */

/** run 列表条目：聚合数字全部由 main 侧从 spans 现算，不落任何缓存 */
export const RunSummarySchema = z.object({
  id: z.string(),
  task: z.string(),
  model: z.string(),
  created_at: z.string(),
  status: z.enum(["completed", "crashed"]),
  /** 父 run id；根 run 为 null */
  parent: z.string().nullable(),
  /** 终止原因（崩溃的 run 为 null） */
  reason: z.string().nullable(),
  /**
   * 分叉摘要（根 run 与老文件为 null）：只带分叉点 span id 与被编辑字段名，
   * 不带 value——value 可能是整段工具结果或完整 messages，列表载荷一次性传输 N 条，
   * 放大会直接拖慢冷启动；要看具体内容时读详情。
   */
  fork: z
    .object({
      at_span: z.string().min(1),
      edit_field: z.string().min(1),
      /**
       * 实验组标签（仅 model_params 分叉有值）：同一批 A/B 的所有臂共享同一个
       * experimentId，分支树与对照面板据此聚成一组。短字符串，不影响载荷纪律。
       */
      experiment_id: z.string().min(1).nullable(),
    })
    .nullable(),
  /** 迭代步数（agent.step 计数） */
  steps: z.number().int().nonnegative(),
  /** 工具调用次数 */
  toolCalls: z.number().int().nonnegative(),
  /** 出错的工具调用次数 */
  toolErrors: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /**
   * 本 run 自有 spans 的累计缓存命中 tokens（前缀缓存生效的证据）。
   * `null` = 全部 llm.call 都没有 cache_hit 字段（未知，不得显示为 0）；`0` = 实测零命中。
   */
  cacheHit: z.number().int().nonnegative().nullable(),
  /** 总耗时（毫秒）；span 缺失时间区间时为 null——时间未知不得臆造 */
  durationMs: z.number().nonnegative().nullable(),
  /** 录制来源：代理录制为 "proxy"；SDK / agent-loop 直录为 null（老文件同 null） */
  source: z.enum(["proxy"]).nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** 读取失败的文件：单个文件损坏不得拖垮整个列表 */
export const FailedFileSchema = z.object({
  file: z.string(),
  error: z.string(),
});
export type FailedFile = z.infer<typeof FailedFileSchema>;

export const ListRunsDataSchema = z.object({
  runs: z.array(RunSummarySchema),
  failed: z.array(FailedFileSchema),
});
export type ListRunsData = z.infer<typeof ListRunsDataSchema>;

/** 分支链上的一跳（暴露 fork 元数据，供界面标注分叉点） */
export const ChainHopSchema = z.object({
  meta: RunMetaSchema,
  fork: ForkSchema.nullable(),
});

/**
 * 来源完整性 lineage：complete 恒不带缺失字段；incomplete 只允许
 * ANCESTOR_NOT_FOUND 且必须携带 missingRunId（strict 拒绝未知形态）。
 */
export const RunLineageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete") }).strict(),
  z
    .object({
      status: z.literal("incomplete"),
      reason: z.literal("ANCESTOR_NOT_FOUND"),
      missingRunId: z.string().min(1),
    })
    .strict(),
]);
export type RunLineage = z.infer<typeof RunLineageSchema>;

/**
 * run 详情：分支 run 返回的是 resolveBranch 解析后的完整轨迹。
 *
 * U6 起详情携带受校验的完整性元数据（completeness/spanScope/lineage）：
 * main 依据已校验 fork 类型生成，renderer 不从 chain 长度猜完整性；
 * `own` 不代表降级。载荷内一致性由 superRefine 判定（判据见
 * `run-detail-integrity.ts`，main 自检与 renderer 两处入口共用）。
 */
const RunDetailObjectSchema = z.object({
  meta: RunMetaSchema,
  spans: z.array(SpanSchema),
  events: z.array(RunEventSchema),
  status: z.enum(["completed", "crashed"]),
  /** 祖先链（从最早可读 hop 到本 run）；ownOnly 时在缺失点截断 */
  chain: z.array(ChainHopSchema),
  /** 当前 run（叶子）自身新增 span 的 id（在合并轨迹中区分"自己"与"继承的祖先前缀"） */
  leafSpanIds: z.array(z.string()),
  /** complete = 全链校验通过；ownOnly = 祖先文件确实缺失（只读当前已校验自有记录） */
  completeness: z.enum(["complete", "ownOnly"]),
  /** resolved = 轨迹含已合并的祖先前缀；own = 只有本 run 自有轨迹（独立执行不是降级） */
  spanScope: z.enum(["resolved", "own"]),
  lineage: RunLineageSchema,
});

export const RunDetailSchema = RunDetailObjectSchema.superRefine((detail, ctx) => {
  const violation = findRunDetailIntegrityViolation(detail);
  if (violation !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: violation, path: ["completeness"] });
  }
});
export type RunDetail = z.infer<typeof RunDetailObjectSchema>;

// ---------------------------------------------------------------------------
// runs:compare —— 只读比较（U7 design D3）：1–4 个互异 run id 的一次受校验读取
// ---------------------------------------------------------------------------

/** 比较对象数量边界（与既有指标对照的上限一致；单条也允许，用于单侧自有事实阅读） */
export const COMPARE_RUN_MIN = 1;
export const COMPARE_RUN_MAX = 4;
/** 逐项不可用结论的受控码长度上限（与 operations 的稳定码口径一致） */
export const COMPARE_CODE_MAX = 64;
/** 逐项不可用受控中文原因长度上限（不透传路径/errno/堆栈，有界防伪造超大载荷） */
export const COMPARE_REASON_MAX = 512;

/**
 * 比较请求：数量 1–4、互异、非空。越界路径（穿越/绝对路径/分隔符）等非法 run 标识
 * 的形状校验在 main 侧读取前拒绝（`findIllegalRunIdViolation`）——schema 只钉跨进程
 * 结构，不复制路径判据。
 */
export const CompareRunsRequestSchema = z
  .object({
    runIds: z
      .array(z.string().min(1, "run 标识不能为空"))
      .min(COMPARE_RUN_MIN, `比较至少需要 ${COMPARE_RUN_MIN} 个运行`)
      .max(COMPARE_RUN_MAX, `比较最多 ${COMPARE_RUN_MAX} 个运行`),
  })
  .strict()
  .superRefine((request, ctx) => {
    const seen = new Set<string>();
    for (const id of request.runIds) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `比较对象重复：${id}`,
          path: ["runIds"],
        });
        return;
      }
      seen.add(id);
    }
  });
export type CompareRunsRequest = z.infer<typeof CompareRunsRequestSchema>;

/**
 * 逐项结果：ready 携带与 runs:get 同一 schema 的已校验详情（完整性标签随 detail
 * 自带，ownOnly 不在比较层二次降级）+ 沿链各物理 run 的**自有摘要**（根→叶有序、
 * 含当前 run；每条由对应物理记录现算——共同祖先/累计派生的唯一合法输入，
 * 禁止回退列表缓存）；unavailable 携带稳定码与受控中文原因——该侧真实身份保留，
 * 不伪空文本、不借另一对象顶替。
 */
export const CompareRunItemSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      runId: z.string().min(1),
      detail: RunDetailSchema,
      chainSummaries: z.array(RunSummarySchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      runId: z.string().min(1),
      code: z.string().min(1).max(COMPARE_CODE_MAX),
      reason: z.string().min(1).max(COMPARE_REASON_MAX),
    })
    .strict(),
]);
export type CompareRunItem = z.infer<typeof CompareRunItemSchema>;

export const CompareRunsResultSchema = z
  .object({
    items: z.array(CompareRunItemSchema).min(COMPARE_RUN_MIN).max(COMPARE_RUN_MAX),
  })
  .strict();
export type CompareRunsResult = z.infer<typeof CompareRunsResultSchema>;

// ---------------------------------------------------------------------------
// workspaces:inspect / workspaces:readFile —— 文件检查点与差异（只读；C 1.1）
// ---------------------------------------------------------------------------

/**
 * 清单定位请求：`stepSpanId` 省略 = 本 run 的**初始快照**；指定时只能是该 run
 * **自有**的已完成 `agent.step`（祖先步骤由 A 包拒绝，main 不代填）。
 * renderer 不得传物理路径或存储根——本请求连字段都没有。
 */
export const WorkspaceInspectRequestSchema = z.object({
  runId: z.string().min(1),
  stepSpanId: z.string().min(1).optional(),
});
export type WorkspaceInspectRequest = z.infer<typeof WorkspaceInspectRequestSchema>;

/** 清单里的一条文件：路径、大小、相对初始快照的状态、附件可用性与来源 */
export const WorkspaceInspectFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** 附件内容哈希（64 位小写 hex，裸值无前缀） */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * 相对**本 run 初始快照**的状态：
   * - `added` = 初始清单里没有这条路径
   * - `modified` = 初始清单里有，但内容哈希不同
   * - `unchanged` = 初始清单里有且哈希相同
   * - `initial` = 当前查看的就是初始快照本身（没有"相对"可谈）
   * 判据只有「路径 + 哈希」——不使用 mtime（快照不含时间戳）。
   */
  change: z.enum(["added", "modified", "unchanged", "initial"]),
  /**
   * 附件可用性：`ok` = 磁盘上存在且长度与哈希都对得上；
   * `missing` = 清单引用了但磁盘上没有；`corrupt` = 存在但长度或哈希不符。
   * 三者必须可分辨——缺失/损坏不得渲染成空文件。
   */
  availability: z.enum(["ok", "missing", "corrupt"]),
  /** 不可用时的可读原因（ok 时为 null） */
  unavailableReason: z.string().nullable(),
});
export type WorkspaceInspectFile = z.infer<typeof WorkspaceInspectFileSchema>;

/**
 * 检查点定位（选择器的数据源）。
 *
 * `localIteration` 是该 step **所属 run 自己的** `agent.step.n`——绝不按合并轨迹沿链累加。
 * 初始快照的 `stepSpanId` / `localIteration` 均为 null（它不是"某一轮结束"）。
 * `origin` 说明这份快照从哪来：根 run 为导入，分支 run 为父 run 某轮检查点。
 */
export const WorkspaceInspectResultSchema = z.object({
  runId: z.string().min(1),
  /** null = 初始快照 */
  stepSpanId: z.string().min(1).nullable(),
  /** 快照 id（裸 64 位 hex） */
  snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
  /** 所属 run id（= 检查点所有者；显式保留以固定 {ownerRunId,stepSpanId,localIteration} 三元组） */
  ownerRunId: z.string().min(1),
  /** 本地轮号 = 该 step 的原始 agent.step.n；初始快照为 null */
  localIteration: z.number().int().positive().nullable(),
  profile: z.string().min(1),
  worldId: z.string().min(1),
  origin: z.union([
    z.object({ kind: z.literal("import") }),
    z.object({
      kind: z.literal("checkpoint"),
      runId: z.string().min(1),
      /** 来源（父 run）那次检查点所在的 step span id */
      stepSpanId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("initial"),
      /** 直接父/根 run id（v3 隔离 prompt 实验的基线） */
      runId: z.string().min(1),
      /** 父根初始快照 id */
      snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ]),
  files: z.array(WorkspaceInspectFileSchema),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  /** 不可用附件数（missing + corrupt），供列表顶部汇总 */
  unavailableCount: z.number().int().nonnegative(),
  /** 初始快照 id（分支 run 用来判定"相对初始"；初始快照本身即等于 snapshotId） */
  initialSnapshotId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type WorkspaceInspectResult = z.infer<typeof WorkspaceInspectResultSchema>;

/**
 * 文件读取请求：清单定位 + **逻辑路径**（不是物理路径）。
 * `path` 必须属于所选清单；越权或清单外路径由 main 与 A 包一并拒绝。
 */
export const WorkspaceReadFileRequestSchema = z.object({
  runId: z.string().min(1),
  stepSpanId: z.string().min(1).optional(),
  path: z.string().min(1),
});
export type WorkspaceReadFileRequest = z.infer<typeof WorkspaceReadFileRequestSchema>;

/**
 * 文件读取结果（判别式联合，与 A 包 `WorkspaceFileReadResult` 同形但去掉字节数组——
 * 二进制只需要大小/哈希，**不跨进程传字节**，避免把整份附件塞进 IPC 载荷）。
 *
 * 六态必须可分辨：`text` / `binary` / `not_found`（清单里没有这条路径）/
 * `missing`（清单有但附件不在）/ `corrupt`（附件与哈希不符）/ `rejected`（请求本身不成立）。
 * 无文本的一侧在 diff 里标作"不存在"，不得当空文本。
 */
export const WorkspaceReadFileResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("text"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string(),
  }),
  z.object({
    status: z.literal("binary"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({ status: z.literal("not_found"), path: z.string().min(1), reason: z.string() }),
  z.object({
    status: z.literal("missing"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("corrupt"),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("rejected"),
    code: z.string().min(1),
    reason: z.string(),
  }),
]);
export type WorkspaceReadFileResult = z.infer<typeof WorkspaceReadFileResultSchema>;

export { findRunDetailIntegrityViolation } from "./run-detail-integrity.js";
export type { RunDetailIntegrityInput } from "./run-detail-integrity.js";
