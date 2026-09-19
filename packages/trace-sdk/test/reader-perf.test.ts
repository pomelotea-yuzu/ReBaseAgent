import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentStepSpan, RunRecord } from "../src/index";
import { readRun } from "../src/index";
import { tempDir } from "./helpers";
import { PERF_PATHS, corpusEntries, writePerfCorpus } from "./perf-fixtures";
import type { PerfCorpus } from "./perf-fixtures";

/**
 * 7.7：完整 reader 解析的**耗时 / 常驻内存增量 / 正确性**。
 *
 * 验证点（tasks.md 7.7）：`trace-format/根与分支快照往返`、`无附件仍能看轨迹`。
 *
 * ## 测量口径（比数字本身更重要）
 *
 * - **先预热、再读数**：每档先解析一个 run，然后才开始计时。预热抵消的只是"模块加载 + JIT
 *   首次编译"。⚠️ 它**不代表 OS 冷缓存** —— 语料是本次进程刚写下的，读它时页缓存多半是热的。
 *   所以下面报出的数字应读作"**进程内热态**下的解析成本"。要测真正的 OS 冷读必须重启或丢弃
 *   页缓存，本项不做、也不在结论里声称。
 * - **正确性优先**：每条读数都配一组逐字段结构断言。只有耗时、没有正确性的基准，测不出
 *   "解析器悄悄少读了一份清单"这种退化；另有一条**反向用例**证明校验确实在跑（篡改清单
 *   会被拒），避免"跳过校验换性能"。
 * - **门限刻意宽松**：只设"灾难级退化"门限（数量级），不做性能目标断言 —— CI 机器抖动会让
 *   紧门限变成随机红。
 * - **内存是"常驻增量"不是"峰值"**：进程内没有可靠的峰值采样（无 `--expose-gc`，GC 时机
 *   不可控），记录的是"解析结果被保留时 heapUsed 的增量"，RSS 变化作旁证。
 *
 * ## 零 blob
 *
 * 语料目录里只有 `.jsonl`（无 `workspace-blobs/`），而清单里引用的哈希在磁盘上没有对应附件
 * —— 普通解析不加载附件，所以照样读得完整（`无附件仍能看轨迹`）。
 */

const ROUNDS = 10;
const ENV = ((): string => {
  const cpu = cpus()[0];
  return [
    `node=${process.version}`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `cpu=${cpu?.model ?? "unknown"}`,
    `cores=${String(cpus().length)}`,
    `mem=${(totalmem() / 1024 ** 3).toFixed(1)}GB`,
  ].join(" ");
})();

let corpus: PerfCorpus;
let v1Corpus: PerfCorpus;
let cleanup: () => void;

beforeAll(() => {
  const temp = tempDir();
  cleanup = temp.cleanup;
  corpus = writePerfCorpus({ dir: join(temp.dir, "v2"), runCount: 50, rounds: ROUNDS });
  v1Corpus = writePerfCorpus({
    dir: join(temp.dir, "v1"),
    runCount: 10,
    rounds: ROUNDS,
    format: "v1-plain",
  });
  console.log(`[7.7] 环境：${ENV}`);
  console.log(
    `[7.7] 语料：v2 50 run / 每 run ${String(ROUNDS)} 轮 ⇒ 每 run ${String(ROUNDS + 1)} 份清单，合计 ${String(corpus.totalBytes)} 字节（平均 ${String(Math.round(corpus.totalBytes / 50))} 字节/run）；v1 对照 10 run（${String(v1Corpus.totalBytes)} 字节）`,
  );
}, 120_000);

afterAll(() => {
  cleanup?.();
});

function stepsOf(record: RunRecord): AgentStepSpan[] {
  return record.spans.filter((span): span is AgentStepSpan => span.kind === "agent.step");
}

/** 逐字段核对一个 run 的解析结果（正确性判据，与规模无关） */
function assertRecordShape(record: RunRecord, id: string): void {
  expect(record.meta.id).toBe(id);
  expect(record.meta.format_version).toBe(2);
  expect(record.status).toBe("completed");
  expect(record.events).toHaveLength(1);

  // 每轮 3 个 span（agent.step + llm.call + tool.invoke）
  expect(record.spans).toHaveLength(ROUNDS * 3);
  const steps = stepsOf(record);
  expect(steps).toHaveLength(ROUNDS);

  // 11 份清单：初始快照 1 份 + 每轮 1 份；每份都是那 4 条边界路径
  expect(record.meta.workspace?.initial_snapshot.files).toHaveLength(PERF_PATHS.length);
  for (const step of steps) {
    const snapshot = step.workspace_snapshot;
    expect(snapshot, `第 ${String(step.n)} 轮缺检查点`).toBeDefined();
    expect(snapshot?.files.map((file) => file.path)).toEqual(PERF_PATHS);
  }
  // 清单 id 能读出来就说明 reader 的重算校验通过（不符会在解析期抛错）
  expect(record.meta.workspace?.initial_snapshot.id).toMatch(/^[0-9a-f]{64}$/);
}

function heapMiB(): { heap: number; rss: number } {
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed / 1024 ** 2, rss: usage.rss / 1024 ** 2 };
}

describe("7.7 reader 解析：正确性 + 耗时 + 常驻内存增量", () => {
  for (const runCount of [1, 10, 50]) {
    it(`${String(runCount)} 个 v2 隔离 run（每 run ${String(ROUNDS + 1)} 份清单）`, () => {
      const subset = corpus.files.slice(0, runCount);
      const bytes = subset.reduce((sum, entry) => sum + entry.bytes, 0);
      // 预热：只抵消模块加载与 JIT 首次编译，**不代表 OS 冷缓存**（见文件头）
      readRun(subset[0]?.file ?? "");

      const before = heapMiB();
      const started = performance.now();
      const records = subset.map((entry) => readRun(entry.file));
      const elapsedMs = performance.now() - started;
      const after = heapMiB();

      // ── 正确性：每一个 run 都逐字段核对 ────────────────────────────────────────────
      expect(records).toHaveLength(runCount);
      for (const [index, record] of records.entries()) {
        assertRecordShape(record, subset[index]?.id ?? "");
      }
      // 让 records 保持存活到最后，避免 GC 在测量窗口里提前回收（内存读数的前提）
      expect(records[records.length - 1]?.spans.length).toBe(ROUNDS * 3);

      const perRunMs = elapsedMs / runCount;
      console.log(
        `[7.7] v2 ${String(runCount).padStart(2)} run：${String(bytes).padStart(8)} 字节  ${elapsedMs.toFixed(1).padStart(7)} ms（${perRunMs.toFixed(2)} ms/run）  heap +${(after.heap - before.heap).toFixed(1)} MiB  rss +${(after.rss - before.rss).toFixed(1)} MiB`,
      );

      // 灾难级退化门限（数量级），不是性能目标
      expect(elapsedMs).toBeLessThan(runCount * 1000 + 2000);
    });
  }

  it("v1 对照：同结构 v1 语料（无 workspace/检查点）", () => {
    const subset = v1Corpus.files.slice(0, 10);
    const bytes = subset.reduce((sum, entry) => sum + entry.bytes, 0);
    readRun(subset[0]?.file ?? ""); // 预热

    const before = heapMiB();
    const started = performance.now();
    const records = subset.map((entry) => readRun(entry.file));
    const elapsedMs = performance.now() - started;
    const after = heapMiB();

    expect(records).toHaveLength(10);
    for (const [index, record] of records.entries()) {
      expect(record.meta.id).toBe(subset[index]?.id);
      expect(record.meta.format_version).toBe(1);
      expect(record.meta.workspace).toBeUndefined();
      expect(record.status).toBe("completed");
      expect(record.spans).toHaveLength(ROUNDS * 3);
      // v1 的 agent.step 不带检查点（隔离字段不得渗进普通产物）
      expect(stepsOf(record).every((step) => step.workspace_snapshot === undefined)).toBe(true);
    }

    console.log(
      `[7.7] v1 10 run：${String(bytes).padStart(8)} 字节  ${elapsedMs.toFixed(1).padStart(7)} ms（${(elapsedMs / 10).toFixed(2)} ms/run）  heap +${(after.heap - before.heap).toFixed(1)} MiB  rss +${(after.rss - before.rss).toFixed(1)} MiB`,
    );
    expect(elapsedMs).toBeLessThan(20_000);
  });
});

describe("7.7 零 blob 与校验未被省略", () => {
  it("语料目录里只有 .jsonl：解析不创建附件目录，也不改动词料一个字节", () => {
    const namesBefore = corpusEntries(corpus.dir);
    const sizesBefore = namesBefore.map((name) => statSync(join(corpus.dir, name)).size);
    expect(namesBefore).toHaveLength(50);
    expect(namesBefore.every((name) => name.endsWith(".jsonl"))).toBe(true);
    expect(existsSync(join(corpus.dir, "workspace-blobs"))).toBe(false);

    // 清单里引用的哈希在磁盘上**没有**对应附件 —— 解析照样完整返回
    const first = readRun(corpus.files[0]?.file ?? "");
    const hash = first.meta.workspace?.initial_snapshot.files[0]?.sha256 ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(corpus.dir, "workspace-blobs", "sha256", hash))).toBe(false);

    expect(corpusEntries(corpus.dir)).toEqual(namesBefore);
    expect(corpusEntries(corpus.dir).map((name) => statSync(join(corpus.dir, name)).size)).toEqual(
      sizesBefore,
    );
  });

  it("解析确实在校验清单（不是只扫 span）：篡改一条文件哈希 ⇒ 因清单 id 不符被拒", () => {
    const source = corpus.files[0];
    expect(source).toBeDefined();
    if (source === undefined) {
      return;
    }
    // 篡改件写到**语料目录之外**，免得污染"目录里只有 50 个 jsonl"的断言
    const scratch = tempDir();
    try {
      const lines = readFileSync(source.file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const meta = JSON.parse(lines[0] ?? "{}") as {
        workspace?: { initial_snapshot?: { files?: Array<{ sha256: string }> } };
      };
      expect(meta.workspace?.initial_snapshot?.files?.length).toBe(PERF_PATHS.length);
      const target = meta.workspace?.initial_snapshot?.files?.[0];
      if (target === undefined) {
        return;
      }
      const original = target.sha256;
      target.sha256 = "f".repeat(64);
      expect(target.sha256).not.toBe(original); // 内容真的变了，拒绝才有意义
      lines[0] = JSON.stringify(meta);

      const tampered = join(scratch.dir, "tampered.jsonl");
      writeFileSync(tampered, `${lines.join("\n")}\n`);
      // 清单哈希与内容不符 ⇒ 解析期就拒绝（reader 会重算清单 id）
      expect(() => readRun(tampered)).toThrow();
    } finally {
      scratch.cleanup();
    }
  });
});
