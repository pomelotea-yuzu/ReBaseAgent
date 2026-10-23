import {
  RunDetailReadError,
  RunReadContext,
  RunRepository,
  deriveChainTotals,
  deriveOwnConsumption,
  deriveSideOutputFacts,
  deriveVerifiedComparison,
  findIllegalExternalRunIdViolation,
  indexRunsById,
} from "@rebaseagent/run-query";
import type { OutputBlock, RunDetail, RunSummary } from "@rebaseagent/run-query";
import { z } from "zod";
import type { LimitationInput, ProvenanceRefInput, ProvenanceRunInput } from "../envelope.js";
import { projectThrowable } from "../error-projection.js";
import type { ProjectedToolError } from "../error-projection.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { type CompareRunsArgs, requireContract } from "../tool-contracts.js";
import { ToolFailure, defineTool } from "../tool-definition.js";
import {
  AncestorDeltaSchema,
  ChainTotalsSchema,
  InterventionSchema,
  OwnConsumptionSchema,
  RunSummaryItemSchema,
  type SideName,
  SideNameSchema,
  UnavailableSideSchema,
  outcomeTagOf,
  projectIntervention,
  projectRunSummary,
  provenanceRunsOf,
  unavailableSideOf,
} from "./projection.js";
import { computeReadVersion } from "./read-version.js";

/**
 * `compare_runs`（design D5 第四行；Q11/Q12 与 S05 的比较面）。
 *
 * 参数是 `left`/`right` **两个对象**而不是数组（与 `compare_checkpoint_files` 同形）：
 * 左右恒定时「这一侧不可读」才有确定含义，结果也才能按同序两格返回。
 *
 * 三条不猜：
 * - **坏侧不冒充空运行**（Q11）：该侧以稳定码在场并保留自己的身份，另一侧事实照常给出；
 *   只有两侧都读到才判定关系，任一侧读不到 ⇒ `relation.kind = "not-determinable"`
 *   （拿单条链去求"共同祖先"会得出它自己的根，那是把不知道说成结论）。
 * - **来源不完整不称不同根**（Q12）：关系三态直接复用共享层 `deriveVerifiedComparison`——
 *   `incomplete` 就照 `incomplete` 返回，不升格成 `unrelated`；累计增量沿链求和，
 *   链上缺段即 null；相对祖先差只在关系可确认时才计算。
 * - **不判修复、不对齐步骤**：结果里没有「哪一侧更好」「第 N 步对第 N 步」这类字段，
 *   措辞只用「沿链累计增量」，不写「总耗时/总成本」。
 *
 * 正文按引用给：最终输出与错误定位只给 **span 引用 + 码点长度**（这些引用可以直接拿去
 * `get_step(section=...)`），并带一条 `BODY_NOT_EXPOSED` 说明边界。
 */

/**
 * 左右两侧的公开形状与「坏侧保留身份 + 稳定码」这一格的说法都在 `projection.ts`
 * （4.7 的 `compare_checkpoint_files` 共用同一份，两种比较工具不会各说一套）。
 */

const OutputBlockSchema = z
  .object({
    spanId: z.string().min(1),
    stepSpanId: z.string().min(1).nullable(),
    model: z.string().min(1),
    /** 正文的码点数（正文本身要按 `get_step` 的 section 取） */
    textCodePoints: z.number().int().nonnegative(),
  })
  .strict();

const SideOutputSchema = z
  .object({
    /** 已记录的最终输出；null = 没有（缺成哪一类由 `missingReason` 说） */
    final: OutputBlockSchema.nullable(),
    /** 结束前最近一条自有非空正文：它**不是**最终结果，不能冒充（共享层同款纪律） */
    intermediate: OutputBlockSchema.nullable(),
    missingReason: z
      .enum(["no-llm-call", "empty-content", "has-error", "pending-tool-calls"])
      .nullable(),
    lastOutputKind: z.enum(["content", "reasoning-only", "tool-calls-only", "empty"]).nullable(),
  })
  .strict();

const SideFailureSchema = z
  .object({
    /** 自有失败调用定位（非 error 终止时为 null，不反推） */
    llmCallSpanId: z.string().min(1).nullable(),
    stepSpanId: z.string().min(1).nullable(),
    /** 只说「有没有录到错误正文」；正文按 `get_step(section="error")` 取 */
    messageRecorded: z.boolean(),
    /** HTTP 状态码：null = 未记录（不从文本猜） */
    status: z.number().int().nullable(),
    /** true = 以 error 终止但自有记录里没有失败调用 ⇒ 「错误详情未记录」 */
    missingDetail: z.boolean(),
  })
  .strict();

const ReadySideSchema = z
  .object({
    side: SideNameSchema,
    status: z.literal("ready"),
    runId: z.string().min(1),
    /** 与列表/详情同一份白名单 */
    run: RunSummaryItemSchema.extend({ formatVersion: z.number().int().positive() }).strict(),
    lineage: z
      .object({
        status: z.enum(["complete", "incomplete"]),
        missingRunId: z.string().min(1).nullable(),
      })
      .strict(),
    intervention: InterventionSchema,
    consumption: z
      .object({
        own: OwnConsumptionSchema,
        alongChain: ChainTotalsSchema.nullable(),
        /** 相对共同祖先的增量差；关系不可确认时为 null */
        deltaFromAncestor: AncestorDeltaSchema.nullable(),
      })
      .strict(),
    output: SideOutputSchema,
    failure: SideFailureSchema,
  })
  .strict();

const SideSchema = z.discriminatedUnion("status", [ReadySideSchema, UnavailableSideSchema]);

const CompareRunsDataSchema = z
  .object({
    /** 恰两条、与请求同序（左在前）；一格都不因为另一格坏了而被省掉 */
    sides: z.array(SideSchema).length(2),
    comparison: z
      .object({
        /** 两侧都读到才判定关系与祖先差 */
        comparable: z.boolean(),
        relation: z
          .object({
            kind: z.enum(["common", "unrelated", "incomplete", "not-determinable"]),
            ancestorRunId: z.string().min(1).nullable(),
          })
          .strict(),
        /** 共同祖先的自有摘要（仅 `common` 时有；不拿它冒充两侧结论） */
        ancestor: RunSummaryItemSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type CompareRunsData = z.infer<typeof CompareRunsDataSchema>;

type ReadySide = {
  readonly side: SideName;
  readonly status: "ready";
  readonly detail: RunDetail;
  readonly chainSummaries: readonly RunSummary[];
};
/** 内部侧模型：读取失败的那一侧带着投影后的错误，出站前才换成 `UnavailableSideSchema` 的形状 */
type ErroredSide = {
  readonly side: SideName;
  readonly status: "unavailable";
  readonly runId: string;
  readonly error: ProjectedToolError;
};
type Side = ReadySide | ErroredSide;

/**
 * 单侧读取：`RunDetailReadError` 按结构投影成该侧的失败（稳定码 + 码表文案）；
 * 其余异常**继续上抛**——程序缺陷不伪装成业务码（design D4 的分工）。
 */
function readSide(context: RunReadContext, side: SideName, runId: string): Side {
  try {
    const { detail, chainSummaries } = context.readOf(runId);
    return { side, status: "ready", detail, chainSummaries };
  } catch (e) {
    if (e instanceof RunDetailReadError) {
      return { side, status: "unavailable", runId, error: projectThrowable(e) };
    }
    throw e;
  }
}

function projectOutputBlock(block: OutputBlock | null): z.infer<typeof OutputBlockSchema> | null {
  return block === null
    ? null
    : {
        spanId: block.spanId,
        stepSpanId: block.stepSpanId,
        model: block.model,
        textCodePoints: [...block.content].length,
      };
}

function ownSummaryOf(side: ReadySide): RunSummary {
  const summary = side.chainSummaries[side.chainSummaries.length - 1];
  if (summary === undefined) {
    throw new ToolFailure("RUN_INVALID", `run:${side.detail.meta.id}`);
  }
  return summary;
}

export const compareRunsTool: ToolDefinition = defineTool(
  requireContract("compare_runs"),
  async (args: CompareRunsArgs, root: DataRoot) => {
    /** 两侧标识都在任何读取之前按参数问题拒绝（design D3 + Q05） */
    if (findIllegalExternalRunIdViolation(args.left.runId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "left");
    }
    if (findIllegalExternalRunIdViolation(args.right.runId) !== null) {
      throw new ToolFailure("INVALID_ARGUMENT", "right");
    }
    /** 「恰两个不同运行」是语义约束（契约里两条 zod 形状都合法），所以在实现层拒 */
    if (args.left.runId === args.right.runId) {
      throw new ToolFailure("INVALID_ARGUMENT", "left/right");
    }

    const repository = new RunRepository(root.tracesDir);
    const readVersion = computeReadVersion("compare_runs", args, repository);
    /** 一次请求一个上下文：共同祖先在两侧之间只解析一次，事实仍不跨请求缓存（Q02） */
    const context = new RunReadContext(root.tracesDir);
    const sides: readonly Side[] = [
      readSide(context, "left", args.left.runId),
      readSide(context, "right", args.right.runId),
    ];
    const ready = sides.filter((item): item is ReadySide => item.status === "ready");

    /**
     * 沿链求和的输入 = **本次已校验链的并集**（坏侧不参与，也不拿另一侧的链凑）；
     * 这正是共享层 `deriveVerifiedComparison` 的取法，两侧都读到时直接复用它，
     * 只有一侧读到时才只用那一条链求累计。
     */
    const union: RunSummary[] = [];
    const seen = new Set<string>();
    for (const side of ready) {
      for (const summary of side.chainSummaries) {
        if (seen.has(summary.id)) continue;
        seen.add(summary.id);
        union.push(summary);
      }
    }
    const totalsById = indexRunsById(union);
    const verified =
      ready.length === 2
        ? deriveVerifiedComparison(
            ready.map((side) => ({
              runId: side.detail.meta.id,
              chainSummaries: side.chainSummaries,
            })),
          )
        : null;

    const relation =
      verified === null
        ? { kind: "not-determinable" as const, ancestorRunId: null }
        : verified.relation.kind === "common"
          ? { kind: "common" as const, ancestorRunId: verified.relation.ancestorId }
          : { kind: verified.relation.kind, ancestorRunId: null };

    const payloadSides = sides.map((item): z.infer<typeof SideSchema> => {
      if (item.status === "unavailable") {
        return unavailableSideOf(item.side, item.runId, item.error);
      }
      const own = ownSummaryOf(item);
      const facts = deriveSideOutputFacts(item.detail);
      return {
        side: item.side,
        status: "ready",
        runId: item.detail.meta.id,
        run: projectRunSummary(own, item.detail.meta.format_version),
        lineage: {
          status: item.detail.lineage.status,
          missingRunId:
            item.detail.lineage.status === "incomplete" ? item.detail.lineage.missingRunId : null,
        },
        intervention: projectIntervention(item.detail, own),
        consumption: {
          own: deriveOwnConsumption({
            spans: item.detail.spans,
            leafSpanIds: item.detail.leafSpanIds,
          }),
          alongChain: deriveChainTotals(totalsById, item.detail.meta.id),
          deltaFromAncestor:
            verified?.sides.find((entry) => entry.runId === item.detail.meta.id)
              ?.deltaFromAncestor ?? null,
        },
        output: {
          final: projectOutputBlock(facts.output.finalOutput),
          intermediate: projectOutputBlock(facts.output.latestIntermediate),
          missingReason: facts.output.missingReason,
          lastOutputKind: facts.output.lastOutputKind,
        },
        failure: {
          llmCallSpanId: facts.failure.llmCallSpanId,
          stepSpanId: facts.failure.stepSpanId,
          messageRecorded: facts.failure.message !== null,
          status: facts.failure.status,
          missingDetail: facts.failure.missingDetail,
        },
      };
    });

    const data = CompareRunsDataSchema.parse({
      sides: payloadSides,
      comparison: {
        comparable: verified !== null,
        relation,
        ancestor: verified?.ancestor ? projectRunSummary(verified.ancestor) : null,
      },
    });

    const limitations: LimitationInput[] = [];
    const refs: ProvenanceRefInput[] = [];
    const runs: ProvenanceRunInput[] = [];
    for (const side of ready) {
      const own = ownSummaryOf(side);
      if (!outcomeTagOf(own).sealed) {
        limitations.push({
          code: "TERMINATION_NOT_RECORDED",
          ref: `run:${side.detail.meta.id}`,
          message: `该侧没有终止事件：只到已落盘的记录为止，不能据此判断它仍在进行（${side.side}）`,
        });
      }
      if (side.detail.lineage.status === "incomplete") {
        limitations.push({
          code: "ANCESTOR_NOT_FOUND",
          ref: `run:${side.detail.lineage.missingRunId}`,
          message: `该侧父链在缺失点截断（${side.side}）：继承前缀与祖先增量为未知，不称「不同根」`,
        });
      }
      const facts = deriveSideOutputFacts(side.detail);
      if (facts.output.finalOutput !== null) {
        refs.push({
          runId: side.detail.meta.id,
          spanId: facts.output.finalOutput.spanId,
        });
      }
      if (facts.failure.llmCallSpanId !== null) {
        refs.push({ runId: side.detail.meta.id, spanId: facts.failure.llmCallSpanId });
      }
      const provenance = provenanceRunsOf(side.detail, side.chainSummaries);
      if (provenance === null) {
        throw new ToolFailure("RUN_INVALID", `run:${side.detail.meta.id}`);
      }
      for (const run of provenance) {
        const existing = runs.find((entry) => entry.runId === run.runId);
        if (existing === undefined) {
          runs.push(run);
          continue;
        }
        // 同一条链在两侧都出现时（如左是右的祖先），带来源标签的那份才是读过的叶子
        if (existing.lineage === undefined && run.lineage !== undefined) {
          runs[runs.indexOf(existing)] = run;
        }
      }
    }
    limitations.push({
      code: "BODY_NOT_EXPOSED",
      ref: `pair:${args.left.runId}|${args.right.runId}`,
      message:
        "比较结果不含输出正文与分叉编辑正文：`provenance.refs` 里的 span 引用可用 get_step 逐段取，或在桌面按完整 ID 查看",
    });

    const unavailableCount = sides.length - ready.length;
    return {
      readVersion,
      data,
      runs,
      refs,
      limitations,
      headline: [
        `compare_runs：${ready.length} 侧可读、${unavailableCount} 侧不可读`,
        `关系 ${relation.kind}${relation.ancestorRunId === null ? "" : `（祖先 ${relation.ancestorRunId}）`}`,
      ].join(" / "),
    };
  },
);
