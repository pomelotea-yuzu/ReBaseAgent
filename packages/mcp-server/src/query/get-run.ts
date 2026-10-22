import {
  RunReadContext,
  RunRepository,
  deriveChainTotals,
  deriveOwnConsumption,
  findIllegalExternalRunIdViolation,
  indexRunsById,
} from "@rebaseagent/run-query";
import { z } from "zod";
import type { LimitationInput, ProvenanceRefInput } from "../envelope.js";
import { PAGE_LIMIT_DEFAULT } from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { type GetRunArgs, requireContract } from "../tool-contracts.js";
import { ToolFailure, defineTool } from "../tool-definition.js";
import {
  RunSummaryItemSchema,
  SpanItemSchema,
  outcomeTagOf,
  projectRunSummary,
  projectSpanItem,
  provenanceRunsOf,
  takeWindow,
} from "./projection.js";
import { computeReadVersion } from "./read-version.js";

/**
 * `get_run`（design D5 第二行；S03「先摘要后正文」的第一跳）。
 *
 * 返回的各段各有明确边界：
 * - `run`：**与列表同一份白名单**（`RunSummaryItemSchema`），列表说的和详情说的不会漂；
 * - `record`/`lineage`/`chain`：来源完整性与父链溯源（`ownOnly` 时链在缺失点截断）；
 * - `intervention`：分叉字段与 v3 实验**身份**——`fork.edit.value`、
 *   `prompt_experiment.original_value/hypothesis/acceptance_criterion` 是正文，不在这里；
 *   `execution.provider_endpoint` 属端点面（design D7），也不在这里；
 * - `consumption`：`own` = 本 run 自有 spans 的本次消耗；`alongChain` = 沿 parent 链
 *   求和的**累计增量**（链不完整时 null，不是 0，也不叫「总耗时/总成本」）；
 * - `index`：一条线性序列——span 项按**投影序**（继承项带真实 owner），其后接检查点项
 *   （初始快照在前，其余按本 run 自有记录序）。两段共用同一个位置坐标系，
 *   分页与续读游标（5.2）才有唯一含义。
 *
 * span 的定位就在 `data.index.items` 里，不再重复抄进 `provenance.refs`；
 * `refs` 只收本次页面给出的检查点（run + step + 快照 id 三元组，可回桌面逐项核对）。
 */

const SnapshotIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "快照标识必须是 64 位小写十六进制");

/** 世界来源：与共享层 `WorkspaceOrigin` 同形，只做跨进程改名（snake_case → camelCase） */
const WorldOriginSchema = z.discriminatedUnion("kind", [
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

/** span 索引项的形状与元数据投影都在 `projection.ts`（get_run 与 get_step 共用同一份） */

const CheckpointItemSchema = z
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
type CheckpointItem = z.infer<typeof CheckpointItemSchema>;

const ChainHopItemSchema = z
  .object({
    runId: z.string().min(1),
    formatVersion: z.number().int().positive(),
    createdAt: z.string().min(1),
    parentRunId: z.string().min(1).nullable(),
    fork: z
      .object({
        atSpan: z.string().min(1),
        editField: z.string().min(1),
        resumeAfterStep: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    /** true = 这一跳就是本次请求的 run */
    isSelf: z.boolean(),
  })
  .strict();

const GetRunDataSchema = z
  .object({
    run: RunSummaryItemSchema.extend({ formatVersion: z.number().int().positive() }).strict(),
    record: z
      .object({
        completeness: z.enum(["complete", "ownOnly"]),
        spanScope: z.enum(["resolved", "own"]),
        /** 源配置声明的累计 token 预算；未录 ⇒ null（未知不补默认值） */
        budgetMaxTotalTokens: z.number().int().positive().nullable(),
        /** 反事实重放的同源判据；代理录制诚实缺省 ⇒ null */
        configHash: z.string().min(1).nullable(),
        configHashReason: z.enum(["no_system", "invalid_tool"]).nullable(),
      })
      .strict(),
    lineage: z
      .object({
        status: z.enum(["complete", "incomplete"]),
        missingRunId: z.string().min(1).nullable(),
      })
      .strict(),
    chain: z.array(ChainHopItemSchema).min(1),
    intervention: z
      .object({
        fork: z
          .object({
            atSpan: z.string().min(1),
            editField: z.string().min(1),
            resumeAfterStep: z.string().min(1).nullable(),
            experimentId: z.string().min(1).nullable(),
          })
          .strict()
          .nullable(),
        /** v3 隔离 prompt 实验身份（不含原值/假设/判据/端点，见文件头边界说明） */
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
                /**
                 * 根首次请求有没有录采样参数：`false` = 未录，`true` = 录了（可能是显式空对象）。
                 * 两者语义不同（源字段是可选的），所以分开说；参数表本身不外发。
                 */
                paramsRecorded: z.boolean(),
              })
              .strict(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    consumption: z
      .object({
        own: z
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
                hitTotal: z.number().int().nonnegative().nullable(),
              })
              .strict(),
          })
          .strict(),
        /** 沿 parent 链求和的累计增量；链上有缺失/成环 ⇒ null（不补 0、不猜根） */
        alongChain: z
          .object({
            steps: z.number().int().nonnegative(),
            toolCalls: z.number().int().nonnegative(),
            toolErrors: z.number().int().nonnegative(),
            tokensIn: z.number().int().nonnegative(),
            tokensOut: z.number().int().nonnegative(),
            tokens: z.number().int().nonnegative(),
            durationMs: z.number().nonnegative().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    index: z
      .object({
        items: z.array(z.union([SpanItemSchema, CheckpointItemSchema])),
        totals: z
          .object({
            spans: z.number().int().nonnegative(),
            checkpoints: z.number().int().nonnegative(),
            listed: z.number().int().nonnegative(),
            remaining: z.number().int().nonnegative(),
            limit: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type GetRunData = z.infer<typeof GetRunDataSchema>;

function snapshotFileFacts(files: readonly { bytes: number }[]): {
  fileCount: number;
  totalBytes: number;
} {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function projectWorldOrigin(
  origin:
    | { readonly kind: "import" }
    | { readonly kind: "checkpoint"; readonly run_id: string; readonly step_span: string }
    | { readonly kind: "initial"; readonly run_id: string; readonly snapshot_id: string },
): z.infer<typeof WorldOriginSchema> {
  switch (origin.kind) {
    case "import":
      return { kind: "import" };
    case "checkpoint":
      return { kind: "checkpoint", runId: origin.run_id, stepSpanId: origin.step_span };
    case "initial":
      return { kind: "initial", runId: origin.run_id, snapshotId: origin.snapshot_id };
  }
}

export const getRunTool: ToolDefinition = defineTool(
  requireContract("get_run"),
  async (args: GetRunArgs, root: DataRoot) => {
    /**
     * 游标签发与续读核验归 5.2：现在没有可发的游标，就不能把带游标的请求当首页重放
     * （那会让客户端以为自己已经翻过页，实际反复拿到同一批条目）。
     */
    if (args.cursor !== undefined) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }
    /**
     * 非法标识在任何读取之前按参数问题拒绝（design D3 + Q05）。共享层同样会在拼路径前
     * 挡住，但那层的分类是「记录校验不通过」；对调用方来说真正的原因是「你给的 ID
     * 不合规」——这一层判得更准，就不必让客户去猜。
     */
    if (findIllegalExternalRunIdViolation(args.runId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "runId");
    }

    const repository = new RunRepository(root.tracesDir);
    const readVersion = computeReadVersion("get_run", args, repository);
    /** 每请求一个新上下文：同一物理 run 本次最多解析一次，事实不跨请求缓存（Q02） */
    const context = new RunReadContext(root.tracesDir);
    const { detail, chainSummaries, ownerIndex } = context.readWithOwners(args.runId);
    if (ownerIndex.status !== "ok") {
      // owner 投影与详情轨迹对不上 ⇒ 归属说不清，宁可不发索引也不按 id 猜
      throw new ToolFailure("RUN_INVALID", `run:${detail.meta.id}`);
    }
    const leafRunId = detail.meta.id;
    const ownSpanIds = new Set(detail.leafSpanIds);

    const spanItems = detail.spans.map((span, position) => {
      const owner = ownerIndex.projectedOwners[position];
      if (owner === undefined || owner.spanId !== span.id) {
        // 位置对不上就是投影异常：拒绝，不把归属写错
        throw new ToolFailure("RUN_INVALID", `run:${leafRunId}`);
      }
      return projectSpanItem(
        span,
        owner.ownerRunId,
        ownSpanIds.has(span.id),
        (ownerIndex.ownersBySpanId.get(span.id) ?? []).length > 1,
      );
    });

    /**
     * 检查点段：初始快照在前（省略 selector 时 `inspect_checkpoint` 给的就是它），
     * 其后按本 run 自有记录序。祖先步骤天然不在内——不代填、不换最近步骤。
     */
    const checkpointItems: CheckpointItem[] = [];
    const workspace = detail.meta.workspace;
    if (workspace !== undefined) {
      checkpointItems.push({
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
      checkpointItems.push({
        kind: "checkpoint",
        stepSpanId: span.id,
        iteration: span.n,
        snapshotId: snapshot.id,
        ...snapshotFileFacts(snapshot.files),
        worldOrigin: null,
      });
    }

    const window = takeWindow([...spanItems, ...checkpointItems], args.limit);
    const summary = chainSummaries[chainSummaries.length - 1];
    if (summary === undefined) {
      throw new ToolFailure("RUN_INVALID", `run:${leafRunId}`);
    }
    const fork = detail.meta.fork;
    const experiment = detail.meta.prompt_experiment;
    const sealed = outcomeTagOf(summary).sealed;

    const data = GetRunDataSchema.parse({
      run: projectRunSummary(summary, detail.meta.format_version),
      record: {
        completeness: detail.completeness,
        spanScope: detail.spanScope,
        budgetMaxTotalTokens: detail.meta.budget?.max_total_tokens ?? null,
        configHash: detail.meta.config_hash ?? null,
        configHashReason: detail.meta.config_hash_reason ?? null,
      },
      lineage: {
        status: detail.lineage.status,
        missingRunId: detail.lineage.status === "incomplete" ? detail.lineage.missingRunId : null,
      },
      chain: detail.chain.map((hop) => ({
        runId: hop.meta.id,
        formatVersion: hop.meta.format_version,
        createdAt: hop.meta.created_at,
        parentRunId: hop.meta.parent,
        fork:
          hop.fork === null
            ? null
            : {
                atSpan: hop.fork.at_span,
                editField: hop.fork.edit.field,
                resumeAfterStep: hop.fork.resume_after_step ?? null,
              },
        isSelf: hop.meta.id === leafRunId,
      })),
      intervention: {
        fork:
          fork === null
            ? null
            : {
                atSpan: fork.at_span,
                editField: fork.edit.field,
                resumeAfterStep: fork.resume_after_step ?? null,
                // 实验组标签从摘要取（model_params 分叉才有值），不碰 edit.value
                experimentId: projectRunSummary(summary).fork?.experimentId ?? null,
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
      },
      consumption: {
        own: deriveOwnConsumption({ spans: detail.spans, leafSpanIds: detail.leafSpanIds }),
        alongChain: deriveChainTotals(indexRunsById(chainSummaries), leafRunId),
      },
      index: {
        items: window.items,
        totals: {
          spans: spanItems.length,
          checkpoints: checkpointItems.length,
          listed: window.items.length,
          remaining: window.remaining,
          limit: args.limit ?? PAGE_LIMIT_DEFAULT,
        },
      },
    });

    const limitations: LimitationInput[] = [];
    if (!sealed) {
      limitations.push({
        code: "TERMINATION_NOT_RECORDED",
        ref: `run:${leafRunId}`,
        message: "没有终止事件：以上只到已落盘的记录为止，不能据此判断该运行仍在进行",
      });
    }
    if (detail.lineage.status === "incomplete") {
      limitations.push({
        code: "ANCESTOR_NOT_FOUND",
        ref: `run:${detail.lineage.missingRunId}`,
        message: "祖先记录确实缺失：父链在缺失点截断，继承前缀与祖先增量为未知",
      });
    }
    if (fork !== null || experiment !== undefined) {
      limitations.push({
        code: "BODY_NOT_EXPOSED",
        ref: `run:${leafRunId}`,
        message:
          "分叉编辑正文与实验的原值/假设/判据不在本工具返回：按需用 get_step 读对应 span，或在桌面按完整 ID 查看",
      });
    }

    const refs: ProvenanceRefInput[] = window.items
      .filter((item): item is CheckpointItem => item.kind === "checkpoint")
      .map((item) => ({
        runId: leafRunId,
        ...(item.stepSpanId === null ? {} : { stepSpanId: item.stepSpanId }),
        snapshotId: item.snapshotId,
      }));

    const runs = provenanceRunsOf(detail, chainSummaries);
    if (runs === null) {
      // 链与逐 run 摘要对不上：归属与版本都说不清，宁可拒绝也不按位置猜着发
      throw new ToolFailure("RUN_INVALID", `run:${leafRunId}`);
    }

    return {
      readVersion,
      data,
      truncated: window.truncated,
      runs,
      refs,
      limitations,
      headline: [
        `get_run：${spanItems.length} 个 span / ${checkpointItems.length} 个检查点`,
        sealed ? "已封存" : "未封存",
        window.truncated
          ? `本页 ${window.items.length} 条，尚有 ${window.remaining} 条`
          : "全部在本页",
      ].join(" / "),
    };
  },
);
