import { readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import type { RunRecord, SpanLine } from "@rebaseagent/trace-sdk";
import { deriveRunSummary } from "../shared/derive";
import { RunDetailSchema } from "../shared/ipc";
import type { RunDetail, RunSummary } from "../shared/ipc";
import { isPlainResultChain, projectMixedChainSpans } from "./run-detail-project";
import { readRunLineage } from "./run-lineage-read";
import type { RunLineageDiagnostic, RunLineageOutcome } from "./run-lineage-read";

/**
 * 严格读取失败的结构化载体：message 是受控中文原因（与既有 getRun 抛错文本逐字
 * 一致），diagnostic 携带 U6 的六分类（`null` = 当前 run 的普通严格失败）。
 * 比较端点据此映射逐项 unavailable 的稳定码，不解析异常文本。
 */
export class RunDetailReadError extends Error {
  constructor(
    readonly diagnostic: RunLineageDiagnostic | null,
    message: string,
  ) {
    super(message);
    this.name = "RunDetailReadError";
  }
}

/**
 * U7（improve-branch-comparison）design D3：按 run ID 缓存的**单次读取上下文**。
 *
 * 职责：一次比较请求（1–4 个 run）内的所有读取共享同一个上下文实例——
 * 每个物理 run 文件本次最多解析一次（成功结果与失败异常都缓存），共享祖先
 * 在多个比较对象之间只读一份。lineage 结构检查（身份/结构/封存/v2 边界）
 * 沿用 U6 的 `readRunLineage`，语义不变；详情投影（纯 result 链 resolveBranch、
 * 混合链投影、ownOnly 降级、严格失败）与 `RunRepository.getRun` 逐字同源。
 *
 * 边界：这不是文件系统事务快照——封存记录在正常应用内不可变，外部改动只在
 * 下一次显式重读（新上下文）生效；本次已知错误不能被旧缓存掩盖（缓存的失败
 * 只属于本次上下文，不跨请求存活）。
 */

type CachedRead =
  | { readonly ok: true; readonly record: RunRecord }
  | { readonly ok: false; readonly error: unknown };

export class RunReadContext {
  /** 按物理文件路径缓存的单次解析结果（成功与失败都只解析一次） */
  private readonly reads = new Map<string, CachedRead>();
  /** 按请求 id 缓存的 lineage 结论（结构检查结论复用，物理读取仍走 reads 缓存） */
  private readonly lineages = new Map<string, RunLineageOutcome>();

  constructor(
    private readonly tracesDir: string,
    /** 仅供测试注入计数/故障；生产调用方使用默认 `readRun` */
    private readonly readFile: (file: string) => RunRecord = readRun,
  ) {}

  /**
   * 读取单个 run 详情 + 沿链各物理 run 的**自有摘要**（U7 1.7：共同祖先/累计
   * 派生的输入）。语义与 `RunRepository.getRun` 完全一致——严格失败（当前 run
   * 缺失/损坏/版本/成环等）抛受控中文 Error，祖先 ENOENT 之外的一切祖先失败
   * 同样严格失败，唯独结构化缺失走 ownOnly。
   *
   * `chainSummaries` 根→叶有序、含当前 run 自身；每条由对应物理记录（只含自有
   * spans）现算，禁用列表缓存——链在缺失点截断时它也随之截断，下游
   * `deriveChainTotals`/`findCommonAncestor` 由此自然判 incomplete。
   */
  readOf(id: string): { detail: RunDetail; chainSummaries: RunSummary[] } {
    const outcome = this.lineageOf(id);
    if (!outcome.ok) {
      throw new RunDetailReadError(outcome.diagnostic, outcome.message);
    }
    const chainSummaries = outcome.records.map((record) => deriveRunSummary(record));
    return { detail: this.projectDetail(id, outcome), chainSummaries };
  }

  /** 兼容入口：只要详情（U6 getRun 语义，行为零变化） */
  detailOf(id: string): RunDetail {
    const outcome = this.lineageOf(id);
    if (!outcome.ok) {
      throw new RunDetailReadError(outcome.diagnostic, outcome.message);
    }
    return this.projectDetail(id, outcome);
  }

  private projectDetail(id: string, outcome: Extract<RunLineageOutcome, { ok: true }>): RunDetail {
    // 叶子 run = 连续可读链的最后一跳（complete 与 incomplete 两形态同构）
    const record = outcome.records[outcome.records.length - 1];
    if (record === undefined) {
      // readRunLineage 的成功形态至少包含当前 run；此分支按不变量不可达
      throw new RunDetailReadError(null, `run ${id} 读取结果为空`);
    }
    // 当前 run 自身新增的 span（分支 run 只记录这部分；合并轨迹其余为继承的祖先前缀）
    const leafSpanIds = record.spans.map((s) => s.id);
    // 连续可读链：complete 时是根到叶全链；incomplete 时是缺失点截断的可读前段
    const chain = outcome.records.map((hop) => ({ meta: hop.meta, fork: hop.meta.fork }));
    const ownLabels = {
      completeness: outcome.complete ? ("complete" as const) : ("ownOnly" as const),
      spanScope: "own" as const,
      lineage: outcome.complete
        ? ({ status: "complete" as const } as const)
        : ({
            status: "incomplete" as const,
            reason: "ANCESTOR_NOT_FOUND" as const,
            missingRunId: outcome.missingRunId,
          } as const),
    };

    if (record.meta.parent === null) {
      return this.checkedDetail({
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain,
        leafSpanIds,
        completeness: "complete",
        spanScope: "own",
        lineage: { status: "complete" },
      });
    }

    const forkField = record.meta.fork?.edit.field;

    // 代理分叉 run（fork.edit.field="messages"）：resolveBranch 的"共享前缀拼接"语义
    // 不成立（编辑的是 messages，没有 replay 层应用它，拼接会混排出假时间线）——
    // 降级为父链列表呈现：只返回自身 span，chain 沿 parent 链逐代列出
    if (record.meta.source?.kind === "proxy") {
      return this.checkedDetail({
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain,
        leafSpanIds,
        ...ownLabels,
      });
    }

    // prompt fork run（fork.edit.field 为 system_prompt / user_message）与 model_params
    // 实验臂（U6 §3.6：换 model/params 的 A/B 臂同为「从头重跑的独立执行」）——
    // 所有 span 来自本次实际执行，禁止把父 run 的旧 spans 拼进时间线（model_params
    // 不再误合并）；chain 仅作父级溯源（沿 parent 链逐代列出）
    if (
      forkField === "system_prompt" ||
      forkField === "user_message" ||
      forkField === "model_params"
    ) {
      return this.checkedDetail({
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain,
        leafSpanIds,
        ...ownLabels,
      });
    }

    if (!outcome.complete) {
      // U6 §3.2/3.3：祖先文件确实缺失 ⇒ 结构化 ownOnly：只返回当前 run 的已校验
      // 自有 meta/spans/events/status，chain 在缺失点截断，missingRunId 来自最近
      // 可读记录的 meta.parent。继承前缀与祖先增量为未知，不补零、不拼历史。
      return this.checkedDetail({
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain,
        leafSpanIds,
        completeness: "ownOnly",
        spanScope: "own",
        lineage: {
          status: "incomplete",
          reason: "ANCESTOR_NOT_FOUND",
          missingRunId: outcome.missingRunId,
        },
      });
    }

    // U6 §3.8：纯 result 链复用 resolveBranch（既有行为不变）；混合链（链上夹有
    // prompt / messages / model_params 独立边界）走只读投影，不跨独立边界拼接。
    if (isPlainResultChain(outcome.records)) {
      const recordsById = new Map(outcome.records.map((r) => [r.meta.id, r]));
      let resolved: ReturnType<typeof resolveBranch>;
      try {
        resolved = resolveBranch(id, (runId) => {
          const hit = recordsById.get(runId);
          if (hit === undefined) {
            throw new Error(`run ${runId} 不在本次已读取的记录中`);
          }
          return hit;
        });
      } catch (e) {
        // resolveBranch 的报错只含 run/span id（前缀级定位校验：v1 at_span、
        // 完整链的前缀扫描），收敛为受控原因 + FORK_INVALID 诊断，不透传原始异常
        throw new RunDetailReadError(
          "FORK_INVALID",
          `分支轨迹解析失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return this.checkedDetail({
        meta: resolved.meta,
        spans: resolved.spans,
        events: resolved.events,
        // 分支 run 的结局以叶子 run 为准
        status: record.status,
        chain: resolved.chain.map((hop) => ({ meta: hop.meta, fork: hop.fork })),
        leafSpanIds,
        completeness: "complete",
        spanScope: "resolved",
        lineage: { status: "complete" },
      });
    }

    let projectedSpans: SpanLine[];
    try {
      const projected = projectMixedChainSpans(outcome.records);
      if (!projected.ok) {
        throw new Error(projected.message);
      }
      projectedSpans = projected.spans;
    } catch (e) {
      // 投影/整轮截断的报错只含 run/span id，收敛为受控原因 + FORK_INVALID 诊断
      throw new RunDetailReadError(
        "FORK_INVALID",
        `分支轨迹解析失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return this.checkedDetail({
      meta: record.meta,
      spans: projectedSpans,
      events: record.events,
      status: record.status,
      chain,
      leafSpanIds,
      completeness: "complete",
      spanScope: "resolved",
      lineage: { status: "complete" },
    });
  }

  /** lineage 结论按请求 id 记忆；物理读取经缓存 readFile，每个文件最多解析一次 */
  private lineageOf(id: string): RunLineageOutcome {
    const memo = this.lineages.get(id);
    if (memo !== undefined) {
      return memo;
    }
    const outcome = readRunLineage(this.tracesDir, id, (file) => this.cachedRead(file));
    this.lineages.set(id, outcome);
    return outcome;
  }

  private cachedRead(file: string): RunRecord {
    const memo = this.reads.get(file);
    if (memo !== undefined) {
      return memo.ok ? memo.record : throwCached(memo.error);
    }
    try {
      const record = this.readFile(file);
      this.reads.set(file, { ok: true, record });
      return record;
    } catch (e) {
      // 失败同样只解析一次：同上下文内再次走到同一坏文件时重放同一异常
      this.reads.set(file, { ok: false, error: e });
      throw e;
    }
  }

  /**
   * 返回前的 main 侧自检：main 生成的详情必须能通过自家 schema（含完整性一致性）。
   * 这是"main 不产出错配载荷"的不变量守卫，不是对文件事实的二次校验。
   */
  private checkedDetail(detail: RunDetail): RunDetail {
    const parsed = RunDetailSchema.safeParse(detail);
    if (!parsed.success) {
      throw new Error(
        `详情载荷自检失败（内部错误，已阻止出站）：${parsed.error.issues
          .map((issue) => issue.message)
          .join("；")}`,
      );
    }
    return detail;
  }
}

function throwCached(error: unknown): never {
  throw error;
}
