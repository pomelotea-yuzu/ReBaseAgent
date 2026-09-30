import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { deriveRunSummary } from "../shared/derive";
import type { ListRunsData, RunDetail, RunSummary } from "../shared/ipc";
import { findIllegalRunIdViolation } from "./run-lineage-read";
import { RunReadContext } from "./run-read-context";

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
   * U7 1.2 起：详情构建委托给 `RunReadContext`（每次调用一个新上下文——单 run
   * 读取没有可复用对象；比较通道才按请求建一个共享上下文）。行为逐字不变：
   * 完整性标签（U6 §2，main 依据已校验 fork 类型生成，renderer 不猜）：
   * - 根 / prompt / 代理 messages：spanScope=own（独立执行不是降级）；
   * - 普通/隔离 result（完整链）：spanScope=resolved（既有 resolveBranch 合并语义）；
   * - prompt/代理缺祖先：ownOnly/own + ANCESTOR_NOT_FOUND，chain 在缺失点截断
   *   （§2 起 schema 不容许 complete 标签配截断链，故在此结构化；展示层消费归 §4）；
   * - 普通/隔离 result 缺祖先：保持 §1 的严格失败，ownOnly 详情信封归 §3。
   */
  getRun(id: string): RunDetail {
    return new RunReadContext(this.tracesDir).detailOf(id);
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
