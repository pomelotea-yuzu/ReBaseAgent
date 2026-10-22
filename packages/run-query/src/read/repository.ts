import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { assertRegularFileWithinRoot } from "@rebaseagent/trace-sdk/fs-boundary";
import { deriveRunSummary } from "../facts/summary.js";
import type { ListRunsData, RunDetail, RunSummary } from "../schema.js";
import { classifyReadFailure } from "./errors.js";
import type { RunQueryToolErrorCode } from "./errors.js";
import { RunReadContext } from "./read-context.js";
import { findIllegalRunIdViolation, findRunIdentityViolation } from "./validation.js";

/** 失败文件的结构化条目：保留受控原因与稳定码（MCP 外部投影使用） */
export interface RunListFailure {
  readonly file: string;
  readonly code: RunQueryToolErrorCode;
  readonly error: string;
}

/** 列表详细结果：旧 `listRuns` 去掉 code 后保持 IPC 形状不变 */
export interface ListRunsDetailedData {
  readonly runs: RunSummary[];
  readonly failed: RunListFailure[];
}

interface ScannedRun {
  readonly file: string;
  readonly record: RunRecord;
}

/**
 * 共享只读层唯一持有 fs 的地方：扫描 traces 目录、读取并解析 trace 文件。
 * desktop main 与 MCP 共用。
 *
 * 纪律：
 * - 单个文件读取失败必须被隔离——一个坏文件不得拖垮整个列表；
 * - 旧 `listRuns` 保持既有行为（文件名可任意，run id 取 `meta.id`）；
 * - MCP 外部投影用 `listRunsDetailed`：文件名必须等于 `meta.id`，错配是独立失败项，
 *   不冒充合法摘要。
 */
export class RunRepository {
  constructor(readonly tracesDir: string) {}

  /** 列出全部 run（按创建时间倒序）；失败文件单独成列（旧 IPC 形状） */
  listRuns(): ListRunsData {
    const { scanned, failed } = this.scan();
    const runs = scanned.map(({ record }) => deriveRunSummary(record));
    runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { runs, failed: failed.map(({ file, error }) => ({ file, error })) };
  }

  /** 列表详细结果：身份错配 + 稳定码，供 MCP 外部投影 */
  listRunsDetailed(): ListRunsDetailedData {
    const { scanned, failed } = this.scan();
    const runs: RunSummary[] = [];
    const allFailed = [...failed];
    for (const { file, record } of scanned) {
      const identity = findRunIdentityViolation(file.slice(0, -".jsonl".length), record.meta.id);
      if (identity !== null) {
        allFailed.push({ file, code: "IDENTITY_MISMATCH", error: identity });
        continue;
      }
      runs.push(deriveRunSummary(record));
    }
    runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    allFailed.sort((a, b) => a.file.localeCompare(b.file));
    return { runs, failed: allFailed };
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
   * 既有调用方依赖"文件名可任意、身份取 meta.id"，这里不改判。
   */
  loadRunRecord(id: string): RunRecord {
    const illegal = findIllegalRunIdViolation(id);
    if (illegal !== null) {
      throw new Error(`run 标识非法：${illegal}`);
    }
    return this.read(join(this.tracesDir, `${id}.jsonl`));
  }

  private scan(): { scanned: ScannedRun[]; failed: RunListFailure[] } {
    const files = readdirSync(this.tracesDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();

    const scanned: ScannedRun[] = [];
    const failed: RunListFailure[] = [];

    for (const file of files) {
      try {
        scanned.push({ file, record: this.read(join(this.tracesDir, file)) });
      } catch (e) {
        failed.push({
          file,
          code: classifyReadFailure(e),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { scanned, failed };
  }

  private read(file: string): RunRecord {
    assertRegularFileWithinRoot(this.tracesDir, file);
    return readRun(file);
  }
}
