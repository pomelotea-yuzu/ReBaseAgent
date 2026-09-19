import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceFile } from "../src/index";
import { JsonlTracer } from "../src/index";
import { createWorkspaceSnapshot } from "../src/workspace-hash";
import { sampleRequest, sampleResponse } from "./helpers";

/**
 * 7.7：**可复用的 reader 性能语料**（1/10/50 run、每 run 11 份清单、v1 对照）。
 *
 * ## 语料长什么样
 *
 * - 每个 run **默认 10 轮** ⇒ 落盘 **11 份清单**（`run.meta.workspace.initial_snapshot` 一份
 *   + 每轮 `agent.step` 带来的轮末检查点 10 份）。"清单份数"是解析成本的主要来源之一，
 *   所以它是一个显式参数而不是顺带产物。
 * - 每轮 3 个 span（`agent.step` + `llm.call` + `tool.invoke`），走**真实 `JsonlTracer`** 落盘
 *   —— 语料是"写出来的合法文件"，不是手拼的字符串（手拼容易在 schema 收紧后悄悄变成非法样本，
 *   那样基准测的就是"解析失败有多快"）。
 * - **路径覆盖**：短路径、**长度恰好 512 UTF-16 单元**的 ASCII 路径、**恰好 512 单元**的中文
 *   路径（512 个汉字；按字节是 1536，所以这条同时钉住"长度按单元不按字节"的口径）、
 *   **深度恰好 32 段**的路径。全部压在契约边界上——边界处的字符串处理最容易出现意外的
 *   二次开销。
 * - **v1 对照**：`format === "v1-plain"` 时产出同结构的 v1 语料（无 `workspace`、`agent.step`
 *   不带快照），用来对照"v2 隔离字段带来的额外解析成本"。
 *
 * ## 零附件
 *
 * 语料**只有 `.jsonl`**：从不创建 `workspace-blobs/`，清单里引用的哈希在磁盘上并无对应附件。
 * 这既满足 7.7 的"零 blob 读取/写入"，也正好是 `trace-format/无附件仍能看轨迹` 的场景
 * —— 普通解析不加载附件，所以文件照样读得完整。
 */

/** 短路径 */
export const SHORT_PATH = "a.txt";
/** **长度恰好 512 UTF-16 单元**的 ASCII 路径（508 + ".txt"） */
export const LONG_ASCII_PATH = `${"a".repeat(508)}.txt`;
/** **恰好 512 单元**的中文路径（512 个汉字按单元算 512，按字节算是 1536） */
export const LONG_CJK_PATH = "中".repeat(512);
/** **深度恰好 32 段**的路径（31 个目录段 + 文件名段） */
export const DEEP_PATH = `${Array.from({ length: 31 }, () => "d").join("/")}/f.txt`;

/**
 * 每份清单固定包含的 4 条路径（边界形态各一）。
 *
 * ⚠️ **顺序就是规范序**（UTF-16 代码单元序）：`a.txt` < `aaa…a.txt`（第 2 个字符 `.`=0x2E < `a`=0x61）
 * < `d/d/…/f.txt`（`d`=0x64）< `中…`（0x4E2D）。测试直接拿它与解析结果的路径序列比对，
 * 于是"排序是否真的发生、口径是否是单元序"一并被钉住。
 */
export const PERF_PATHS: readonly string[] = [
  SHORT_PATH,
  LONG_ASCII_PATH,
  DEEP_PATH,
  LONG_CJK_PATH,
];

export type PerfFormat = "v2-isolated" | "v1-plain";

export interface PerfRunFile {
  readonly id: string;
  readonly file: string;
  readonly bytes: number;
}

export interface PerfCorpus {
  readonly dir: string;
  readonly format: PerfFormat;
  readonly rounds: number;
  /** 规范序（run id 升序）；测试按需要取前 N 个做不同规模的档位 */
  readonly files: readonly PerfRunFile[];
  readonly totalBytes: number;
}

export interface WritePerfCorpusOptions {
  readonly dir: string;
  readonly runCount: number;
  /** 轮数；默认 10 ⇒ 每 run 11 份清单 */
  readonly rounds?: number;
  readonly format?: PerfFormat;
  readonly prefix?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 第 `round` 轮结束时的清单（4 条边界路径，哈希随轮次变化 ⇒ 每份清单内容不同） */
function filesForRound(round: number): WorkspaceFile[] {
  return [
    { path: SHORT_PATH, sha256: sha256(`short@${String(round)}`), bytes: 64 },
    { path: LONG_ASCII_PATH, sha256: sha256(`long-ascii@${String(round)}`), bytes: 512 },
    { path: LONG_CJK_PATH, sha256: sha256(`long-cjk@${String(round)}`), bytes: 1536 },
    { path: DEEP_PATH, sha256: sha256(`deep@${String(round)}`), bytes: 128 },
  ];
}

/**
 * 写出一份性能语料并返回索引。调用方负责临时目录的清理。
 *
 * 同步实现：语料生成本身不是被测对象（被测的是解析），生成期用同步 IO 最省事。
 */
export function writePerfCorpus(options: WritePerfCorpusOptions): PerfCorpus {
  const rounds = options.rounds ?? 10;
  const format = options.format ?? "v2-isolated";
  const prefix = options.prefix ?? "perf";
  mkdirSync(options.dir, { recursive: true });

  const files: PerfRunFile[] = [];
  for (let index = 0; index < options.runCount; index++) {
    const id = `${prefix}_${String(index).padStart(3, "0")}`;
    const file = join(options.dir, `${id}.jsonl`);
    const tracer = new JsonlTracer(file);

    tracer.startRun({
      id,
      format_version: format === "v2-isolated" ? 2 : 1,
      task: "reader 性能语料",
      model: "deepseek-chat",
      created_at: "2026-09-19T00:00:00.000Z",
      parent: null,
      fork: null,
      config_hash: "sha256:perf",
      ...(format === "v2-isolated"
        ? {
            workspace: {
              profile: "file-tools-v1",
              world_id: id,
              write_authorized: true,
              initial_snapshot: createWorkspaceSnapshot(filesForRound(0)),
              origin: { kind: "import" as const },
            },
          }
        : {}),
    });

    for (let round = 1; round <= rounds; round++) {
      const step = tracer.startSpan({ kind: "agent.step", n: round });
      const llm = tracer.startSpan({
        kind: "llm.call",
        parent: step,
        request: sampleRequest(),
      });
      tracer.endSpan(llm, { response: sampleResponse() });
      const tool = tracer.startSpan({
        kind: "tool.invoke",
        parent: step,
        tool: "read_file",
        args: { path: SHORT_PATH },
      });
      tracer.endSpan(tool, { result: "文件内容", dur_ms: 1, error: null });
      // v2 的跨行约束要求：已落盘的 `agent.step` 必须带检查点 ⇒ v2 语料每轮都注入一份
      tracer.endSpan(
        step,
        format === "v2-isolated"
          ? { workspace_snapshot: createWorkspaceSnapshot(filesForRound(round)) }
          : {},
      );
    }

    tracer.endRun({ event: "stopped", reason: "completed", at: rounds });
    files.push({ id, file, bytes: statSync(file).size });
  }

  return {
    dir: options.dir,
    format,
    rounds,
    files,
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/** 语料目录里的文件清单（用于"没有附件目录"这类零 blob 断言） */
export function corpusEntries(dir: string): string[] {
  return [...readdirSync(dir)].sort();
}
