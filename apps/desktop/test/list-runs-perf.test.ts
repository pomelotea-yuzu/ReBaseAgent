import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writePerfCorpus } from "../../../packages/trace-sdk/test/perf-fixtures";
import type { PerfCorpus } from "../../../packages/trace-sdk/test/perf-fixtures";
import { RunRepository } from "../src/main/run-repository";
import { deriveRunSummary } from "../src/shared/derive";

/**
 * B 任务 3.4：**真实 `RunRepository.listRuns` 的完整扫描**（1/10/50 run、短/长 ASCII/中文路径、
 * v1 对照），复用 A 段 7.7 的语料生成器（`packages/trace-sdk/test/perf-fixtures.ts`）。
 *
 * 验证场景（specs/desktop-ui）：`真实列表扫描完整且只读`、`浏览过程无写入`。
 *
 * ## 与 A 段 7.7 的关系（别把它当同一件事）
 *
 * 7.7 测的是 **reader**（`readRun`）。这里测的是**桌面列表层**：同一份语料 + `deriveRunSummary`
 * 的逐 run 聚合 + 目录扫描 + created_at 排序。所以：
 * - **不能拿 A 的 ms/run 当桌面结论**（那只是解析那一段）；
 * - 语料字节量也只是**清单部分**，不是桌面读到的全部内容。
 *
 * ## 测量口径（比数字更重要）
 *
 * - **"首次进程"与"重复"分开报**：本测试进程内**第一次** `listRuns`（含模块加载与 JIT 首次
 *   编译）单列；随后每档做 1 次预热 + 3 次计时取**中位数**。
 * - ⚠️ **这不是 OS 冷缓存读数**：语料是本次进程刚写下的，页缓存多半是热的；要测冷读必须重启
 *   机器或丢弃页缓存，本项不做、也不在结论里声称。
 * - **内存是"常驻增量"不是"峰值"**：无 `--expose-gc`，GC 时机不可控 ⇒ 记录"结果保留时
 *   heapUsed 的增量"，RSS 变化作旁证。
 * - **正确性优先**：每档都逐 run 核对"列表汇总 == 完整读取派生"（`deriveRunSummary(readRun)`），
 *   否则"扫得快"可能只是"少读了"；另有一条"篡改件必须进 failed"的反向用例，证明逐文件校验
 *   没有被省略。
 * - **门限只防灾难级退化**（数量级），不做性能目标断言——CI 抖动会让紧门限随机红。
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

let root = "";
const corpus = {} as Record<"v2_1" | "v2_10" | "v2_50" | "v1_10", PerfCorpus>;

/** 数据目录（traces 的父目录）——附件目录 `workspace-blobs` 的正常位置就是它的兄弟 */
const dataDir = (key: keyof typeof corpus): string => join(root, key.replace("_", "-"));

function heapMiB(): { heap: number; rss: number } {
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed / 1024 ** 2, rss: usage.rss / 1024 ** 2 };
}

/** 目录全树指纹（相对路径 + 内容哈希）：判"只读、不写缓存" */
function fingerprint(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const full = join(dir, name);
      const digest = statSync(full).isDirectory()
        ? "dir"
        : createHash("sha256").update(readFileSync(full)).digest("hex");
      return `${name} ${digest}`;
    })
    .join("\n");
}

/** 单次计时扫描（返回值里同时带结果与读数；调用方负责让结果保持存活） */
function timedScan(key: keyof typeof corpus): {
  result: ReturnType<RunRepository["listRuns"]>;
  elapsedMs: number;
  heapDelta: number;
  rssDelta: number;
} {
  const repo = new RunRepository(join(dataDir(key), "traces"));
  const before = heapMiB();
  const started = performance.now();
  const result = repo.listRuns();
  const elapsedMs = performance.now() - started;
  const after = heapMiB();
  return {
    result,
    elapsedMs,
    heapDelta: after.heap - before.heap,
    rssDelta: after.rss - before.rss,
  };
}

/** 汇总一致性：列表里每条必须等于"完整读取 + 派生"的结果（逐字段） */
function assertSummariesMatchFullRead(
  key: keyof typeof corpus,
  list: ReturnType<RunRepository["listRuns"]>,
): void {
  expect(list.failed).toEqual([]);
  for (const summary of list.runs) {
    const full = deriveRunSummary(readRun(join(dataDir(key), "traces", `${summary.id}.jsonl`)));
    expect(summary).toEqual(full);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "list-runs-perf-"));
  corpus.v2_1 = writePerfCorpus({
    dir: join(dataDir("v2_1"), "traces"),
    runCount: 1,
    rounds: ROUNDS,
  });
  corpus.v2_10 = writePerfCorpus({
    dir: join(dataDir("v2_10"), "traces"),
    runCount: 10,
    rounds: ROUNDS,
  });
  corpus.v2_50 = writePerfCorpus({
    dir: join(dataDir("v2_50"), "traces"),
    runCount: 50,
    rounds: ROUNDS,
  });
  corpus.v1_10 = writePerfCorpus({
    dir: join(dataDir("v1_10"), "traces"),
    runCount: 10,
    rounds: ROUNDS,
    format: "v1-plain",
  });
  console.log(`[3.4] 环境：${ENV}`);
  console.log(
    `[3.4] 语料（仅 .jsonl，清单部分）：v2 1/10/50 run = ${String(corpus.v2_1.totalBytes)}/${String(corpus.v2_10.totalBytes)}/${String(corpus.v2_50.totalBytes)} 字节（每 run ${String(ROUNDS + 1)} 份清单）；v1 对照 10 run = ${String(corpus.v1_10.totalBytes)} 字节`,
  );
  // ⚠️ 这里刻意**不调用 listRuns**：第一个用例要读的是"本进程第一次扫描"的数
}, 180_000);

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("3.4 真实 listRuns：首次进程 vs 重复扫描（1/10/50）", () => {
  it("首次进程扫描（50 run，含模块加载与 JIT 首次编译）", () => {
    const first = timedScan("v2_50");
    assertSummariesMatchFullRead("v2_50", first.result);
    expect(first.result.runs).toHaveLength(50);
    console.log(
      `[3.4] 首次进程 ${String(corpus.v2_50.totalBytes).padStart(8)} 字节  ${first.elapsedMs.toFixed(1).padStart(7)} ms  heap +${first.heapDelta.toFixed(1)} MiB  rss +${first.rssDelta.toFixed(1)} MiB`,
    );
  }, 120_000);

  for (const [key, expectedCount] of [
    ["v2_1", 1],
    ["v2_10", 10],
    ["v2_50", 50],
  ] as const) {
    it(`重复扫描 ${String(expectedCount)} run：预热 1 次 + 计时 3 次取中位数`, () => {
      const c = corpus[key];
      const warm = timedScan(key);
      assertSummariesMatchFullRead(key, warm.result);

      const samples: number[] = [];
      let heapMax = 0;
      let rssMax = 0;
      let lastCount = 0;
      for (let i = 0; i < 3; i += 1) {
        const round = timedScan(key);
        assertSummariesMatchFullRead(key, round.result);
        expect(round.result.runs).toHaveLength(c.files.length);
        lastCount = round.result.runs.length;
        samples.push(round.elapsedMs);
        heapMax = Math.max(heapMax, round.heapDelta);
        rssMax = Math.max(rssMax, round.rssDelta);
      }
      const median = [...samples].sort((a, b) => a - b)[1] ?? 0;
      console.log(
        `[3.4] 重复 v2 ${String(c.files.length).padStart(2)} run：${String(c.totalBytes).padStart(8)} 字节  ${samples
          .map((s) => s.toFixed(1))
          .join(
            "/",
          )} ms ⇒ 中位 ${median.toFixed(1)} ms（${(median / c.files.length).toFixed(2)} ms/run）  heap +${heapMax.toFixed(1)} MiB  rss +${rssMax.toFixed(1)} MiB`,
      );
      expect(lastCount).toBe(c.files.length);
      // 灾难级门限（数量级），不是性能目标
      expect(median).toBeLessThan(2000 + c.files.length * 100);
    }, 120_000);
  }

  it("v1 对照 10 run：无 workspace/检查点也走同一条扫描路径", () => {
    const round = timedScan("v1_10");
    assertSummariesMatchFullRead("v1_10", round.result);
    expect(round.result.runs).toHaveLength(10);
    expect(readRun(corpus.v1_10.files[0]?.file ?? "").meta.format_version).toBe(1);
    console.log(
      `[3.4] 重复 v1 10 run：${String(corpus.v1_10.totalBytes).padStart(8)} 字节  ${round.elapsedMs.toFixed(1)} ms（${(round.elapsedMs / 10).toFixed(2)} ms/run）  heap +${round.heapDelta.toFixed(1)} MiB`,
    );
    expect(round.elapsedMs).toBeLessThan(5000);
  }, 120_000);
});

describe("3.4 只读、零 blob、校验没有被省略", () => {
  it("连续扫描不写任何文件：四条语料目录指纹逐字节不变，也不生成附件目录", () => {
    const keys = ["v2_1", "v2_10", "v2_50", "v1_10"] as const;
    const before = Object.fromEntries(
      keys.map((k) => [k, fingerprint(join(dataDir(k), "traces"))]),
    );
    for (const k of keys) timedScan(k);
    for (const k of keys) {
      expect(fingerprint(join(dataDir(k), "traces"))).toBe(before[k]);
      expect(existsSync(join(dataDir(k), "workspace-blobs"))).toBe(false);
    }
    // 清单里引用的哈希在磁盘上没有对应附件 —— 列表照样完整返回（不读 blob）
    const first = readRun(corpus.v2_50.files[0]?.file ?? "");
    const hash = first.meta.workspace?.initial_snapshot.files[0]?.sha256 ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dataDir("v2_50"), "workspace-blobs", "sha256", hash))).toBe(false);
    // 临时根目录下除了四条语料没有任何新增条目
    expect(readdirSync(root).sort()).toEqual(["v1-10", "v2-1", "v2-10", "v2-50"]);
  }, 120_000);

  it("篡改件必须进 failed（逐文件完整校验未被省略，也不拖垮其它 run）", () => {
    const scratch = mkdtempSync(join(tmpdir(), "list-runs-broken-"));
    try {
      const lines = readFileSync(corpus.v2_10.files[0]?.file ?? "", "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
      const meta = JSON.parse(lines[0] ?? "{}") as {
        workspace?: { initial_snapshot?: { files?: Array<{ sha256: string }> } };
      };
      const target = meta.workspace?.initial_snapshot?.files?.[0];
      if (target === undefined) throw new Error("语料缺少初始快照");
      target.sha256 = "f".repeat(64);
      lines[0] = JSON.stringify(meta);

      writeFileSync(
        join(scratch, "ok.jsonl"),
        readFileSync(corpus.v2_10.files[1]?.file ?? "", "utf8"),
      );
      writeFileSync(join(scratch, "broken.jsonl"), `${lines.join("\n")}\n`);

      const result = new RunRepository(scratch).listRuns();
      expect(result.runs.map((r) => r.id)).toEqual([corpus.v2_10.files[1]?.id]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.file).toBe("broken.jsonl");
      expect(result.failed[0]?.error.length).toBeGreaterThan(0);
      // 目录仍只有这两个文件（校验失败不落任何修复产物）
      expect(readdirSync(scratch).sort()).toEqual(["broken.jsonl", "ok.jsonl"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
