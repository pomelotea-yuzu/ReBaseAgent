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
  constructor(private readonly tracesDir: string) {}

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
    const record = this.loadRun(id);
    if (record.meta.parent === null) {
      return {
        meta: record.meta,
        spans: record.spans,
        events: record.events,
        status: record.status,
        chain: [{ meta: record.meta, fork: record.meta.fork }],
      };
    }

    const resolved = resolveBranch(id, (runId) => this.loadRun(runId));
    return {
      meta: resolved.meta,
      spans: resolved.spans,
      events: resolved.events,
      // 分支 run 的结局以叶子 run 为准
      status: record.status,
      chain: resolved.chain.map((hop) => ({ meta: hop.meta, fork: hop.fork })),
    };
  }

  private loadRun(id: string): RunRecord {
    return this.read(join(this.tracesDir, `${id}.jsonl`));
  }

  private read(file: string): RunRecord {
    return readRun(file);
  }
}
