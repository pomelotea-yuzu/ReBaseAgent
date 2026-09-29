import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { deriveRunSummary } from "../shared/derive";
import type { ListRunsData, RunDetail, RunSummary } from "../shared/ipc";
import { findIllegalRunIdViolation, readRunLineage } from "./run-lineage-read";

/**
 * main 进程唯一持有 fs 的地方：扫描 traces 目录、读取并解析 trace 文件。
 *
 * 纪律：单个文件读取失败必须被隔离——一个坏文件不得拖垮整个列表。
 */
export class RunRepository {
  constructor(readonly tracesDir: string) {}

  /** 列出全部 run（按创建时间倒序）；失败文件单独成列 */
  listRuns(): ListRunsData {
    const files = readdirSync(this.tracesDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();

    const runs: RunSummary[] = [];
    const failed: ListRunsData["failed"] = [];

    for (const file of files) {
      try {
        const record = this.read(join(this.tracesDir, file));
        runs.push(deriveRunSummary(record));
      } catch (e) {
        failed.push({ file, error: e instanceof Error ? e.message : String(e) });
      }
    }

    runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { runs, failed };
  }

  /**
   * 读取单个 run 详情。U6 §1 起：当前 hop 校验（身份/版本/schema/结构）与父链
   * 读取统一走 `readRunLineage` 单次读取上下文——祖先 ENOENT 之外的一切读取失败
   * 都是受控中文的严格失败（信封仍为 GET_RUN_FAILED）。
   *
   * 分支语义（§1 保持现状）：
   * - 普通/隔离 result：父链不完整 = 严格失败（§3 起改为返回 ownOnly 详情信封）；
   * - prompt / 代理 messages：保持既有「链到此为止」呈现（§3.4/3.5 起改 ownOnly）。
   */
  getRun(id: string): RunDetail {
    const outcome = readRunLineage(this.tracesDir, id);
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    // 叶子 run = 连续可读链的最后一跳（complete 与 incomplete 两形态同构）
    const record = outcome.records[outcome.records.length - 1];
    if (record === undefined) {
      // readRunLineage 的成功形态至少包含当前 run；此分支按不变量不可达
      throw new Error(`run ${id} 读取结果为空`);
    }
    // 当前 run 自身新增的 span（分支 run 只记录这部分；合并轨迹其余为继承的祖先前缀）
    const leafSpanIds = record.spans.map((s) => s.id);
    if (record.meta.parent === null) {
      return {
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain: [{ meta: record.meta, fork: record.meta.fork }],
        leafSpanIds,
      };
    }

    const forkField = record.meta.fork?.edit.field;

    // 代理分叉 run（fork.edit.field="messages"）：resolveBranch 的"共享前缀拼接"语义
    // 不成立（编辑的是 messages，没有 replay 层应用它，拼接会混排出假时间线）——
    // 降级为父链列表呈现：只返回自身 span，chain 沿 parent 链逐代列出
    if (record.meta.source?.kind === "proxy") {
      return {
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain: this.buildLineageChain(record),
        leafSpanIds,
      };
    }

    // prompt fork run（fork.edit.field 为 system_prompt / user_message）：
    // 从头重跑的独立新轨迹——所有 span 来自本次实际执行，禁止把父 run 的旧 spans
    // 拼进时间线；chain 仅作父级溯源（沿 parent 链逐代列出）
    if (forkField === "system_prompt" || forkField === "user_message") {
      return {
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain: this.buildLineageChain(record),
        leafSpanIds,
      };
    }

    if (!outcome.complete) {
      // U6 §1 边界：祖先缺失的结构化结论已经拿到（missingRunId 受校验），
      // ownOnly 详情信封在 §2/§3 落地；此前保持严格失败，只用受控原因替换
      // 旧文案里的 errno/物理路径。
      throw new Error(
        `父链不完整：祖先 run ${outcome.missingRunId} 的 trace 文件缺失，无法解析分支轨迹`,
      );
    }

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
      // 完整链的前缀扫描），收敛为受控原因，不透传原始异常
      throw new Error(`分支轨迹解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      meta: resolved.meta,
      spans: resolved.spans,
      events: resolved.events,
      // 分支 run 的结局以叶子 run 为准
      status: record.status,
      chain: resolved.chain.map((hop) => ({ meta: hop.meta, fork: hop.fork })),
      leafSpanIds,
    };
  }

  /**
   * 父级溯源链（从根到本 run），不做任何轨迹拼接。
   * 代理分叉与 prompt fork 共用：两者的详情都只呈现本 run 自身 spans。
   */
  private buildLineageChain(leaf: RunRecord): RunDetail["chain"] {
    const chain: RunDetail["chain"] = [];
    const seen = new Set<string>();
    let current: RunRecord | null = leaf;
    while (current !== null && !seen.has(current.meta.id)) {
      seen.add(current.meta.id);
      chain.unshift({ meta: current.meta, fork: current.meta.fork });
      if (current.meta.parent === null) break;
      try {
        current = this.loadRunRecord(current.meta.parent);
      } catch {
        break; // 祖先文件缺失：链到此为止（不拖垮详情读取）
      }
    }
    return chain;
  }

  /**
   * 读取单个 run 的原始记录（供 replay/派生等编排层按 id 加载父链）。
   * 标识先经形状校验（U6 1.4：目录外读取前拒绝穿越/绝对路径/分隔符）。
   */
  loadRunRecord(id: string): RunRecord {
    const illegal = findIllegalRunIdViolation(id);
    if (illegal !== null) {
      throw new Error(`run 标识非法：${illegal}`);
    }
    return this.read(join(this.tracesDir, `${id}.jsonl`));
  }

  private read(file: string): RunRecord {
    return readRun(file);
  }
}
