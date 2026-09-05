import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readRun, resolveBranch } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { deriveRunSummary } from "../shared/derive";
import type { ListRunsData, RunDetail, RunSummary } from "../shared/ipc";

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

  /** 读取单个 run；分支 run 返回 resolveBranch 解析后的完整轨迹 */
  getRun(id: string): RunDetail {
    const record = this.loadRunRecord(id);
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

    // 代理分叉 run（fork.edit.field="messages"）：resolveBranch 的"共享前缀拼接"语义
    // 不成立（编辑的是 messages，没有 replay 层应用它，拼接会混排出假时间线）——
    // 降级为父链列表呈现：只返回自身 span，chain 沿 parent 链逐代列出
    if (record.meta.source?.kind === "proxy") {
      return {
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain: this.buildProxyChain(record),
        leafSpanIds,
      };
    }

    const resolved = resolveBranch(id, (runId) => this.loadRunRecord(runId));
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

  /** 代理 run 的父链（从根到本 run）；不做轨迹拼接 */
  private buildProxyChain(leaf: RunRecord): RunDetail["chain"] {
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

  /** 读取单个 run 的原始记录（供 replay/派生等编排层按 id 加载父链） */
  loadRunRecord(id: string): RunRecord {
    return this.read(join(this.tracesDir, `${id}.jsonl`));
  }

  private read(file: string): RunRecord {
    return readRun(file);
  }
}
