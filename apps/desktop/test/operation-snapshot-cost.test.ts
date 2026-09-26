import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationRegistry } from "../src/main/operation-registry";
import { OperationStatusResultSchema } from "../src/shared/operations";
import type { OperationTarget } from "../src/shared/operations";

/**
 * U4 任务 4.5 的**性能实测**（不是功能验收，也不替代 §6 实机）。
 *
 * design D4 原文要求：「长会话的全量序列化/传输/校验成本须测量后判断，不预设数百条记录
 * 已构成性能问题」，并据此校准 1 秒轮询初值。三个数分别对应链路上三段，口径逐条写清：
 * 1. **main 构造** = `registry.snapshot()`（含自洽校验）耗时；
 * 2. **字节数** = `JSON.stringify` 长度 ⇒ IPC 载荷的**近似**口径（真实 Electron 结构化克隆
 *    同量级，但真机往返时延不在这里冒充已测，归 §6 实机）；
 * 3. **renderer 校验** = `OperationStatusResultSchema.safeParse` 耗时（采信前的必经一步）。
 *
 * 样本里**混入 notAccepted 封禁**（reconcile 先到的 tombstone），因为 spec 要求终态与
 * 封禁保留至会话结束、不得因成本裁剪——只测 settled 会低估。
 * 产物：`.workbuddy/u4-45-measurements.json`；结论写进
 * `docs/engineering/notes/2026-09-26-u4-snapshot-cost.md`。
 */

const EPOCH = "11111111-1111-4111-8111-111111111111";

function uuidOf(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** 轮转五种 target，贴近真实分布（A/B 批次还会多两条臂摘要） */
function targetOf(i: number): OperationTarget {
  switch (i % 5) {
    case 0:
      return { kind: "modelAb", parentRunId: `run_parent_${i}`, armCount: 2 };
    case 1:
      return {
        kind: "result",
        mode: "plain",
        parentRunId: `run_parent_${i}`,
        atSpanId: `s_${i}`,
        editField: "result",
      };
    case 2:
      return { kind: "prompt", parentRunId: `run_parent_${i}`, editField: "system_prompt" };
    case 3:
      return { kind: "proxy", parentRunId: `run_parent_${i}`, atSpanId: `s_${i}` };
    default:
      return { kind: "create", mode: "isolated" };
  }
}

interface Sample {
  readonly count: number;
  readonly settled: number;
  readonly banned: number;
  readonly snapshotMs: number;
  readonly bytes: number;
  readonly parseMs: number;
  readonly runs: { snapshot: number[]; parse: number[] };
}

/** 建一个有 `settled + banned` 条登记的 registry：顺序 await（单槽 ⇒ 并发只会造 busy 拒） */
async function buildRegistry(settled: number, banned: number): Promise<OperationRegistry> {
  const registry = new OperationRegistry({
    newEpoch: () => EPOCH,
    now: () => Date.parse("2026-09-26T00:00:00.000Z"),
  });
  for (let i = 0; i < settled; i += 1) {
    await registry.submitExecution({
      operationId: uuidOf(i + 1),
      target: targetOf(i),
      fingerprint: `fp-${i}`,
      execute: async (ctx) => {
        ctx.attachRunId(`run_${i}`);
        return { outcome: "returned" as const, data: { id: `run_${i}` } };
      },
    });
  }
  // reconcile 先到的封禁：target/时间为 null，但同样进快照、同样要序列化与校验
  for (let i = 0; i < banned; i += 1) {
    registry.reconcile(uuidOf(900_000 + i));
  }
  return registry;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function measure(settled: number, banned: number): Promise<Sample> {
  const registry = await buildRegistry(settled, banned);
  registry.snapshot(); // 预热：首进程的 JIT/内联缓存成本不计入中位数
  const snapshot: number[] = [];
  const parse: number[] = [];
  let payload = "";
  for (let round = 0; round < 5; round += 1) {
    const started = performance.now();
    const result = registry.snapshot();
    snapshot.push(performance.now() - started);
    payload = JSON.stringify(result);
    const t2 = performance.now();
    const parsed = OperationStatusResultSchema.safeParse(JSON.parse(payload));
    parse.push(performance.now() - t2);
    expect(parsed.success).toBe(true);
  }
  const records = registry.snapshot().operations;
  expect(records).toHaveLength(settled + banned);
  return {
    count: records.length,
    settled: records.filter((one) => one.state === "settled").length,
    banned: records.filter((one) => one.state === "notAccepted").length,
    snapshotMs: median(snapshot),
    bytes: Buffer.byteLength(payload, "utf8"),
    parseMs: median(parse),
    runs: { snapshot, parse },
  };
}

const ENV = [
  `node=${process.version}`,
  `platform=${process.platform}`,
  `arch=${process.arch}`,
  `cpu=${cpus()[0]?.model ?? "unknown"}`,
  `cores=${cpus().length}`,
  `mem=${(totalmem() / 1024 ** 3).toFixed(1)}GB`,
].join("  ");

describe("4.5 受限操作快照的成本实测（含 1000 条高负载）", () => {
  it("1000 条（settled + 封禁）的构造 + 校验远小于 1 秒轮询间隔 ⇒ 1 秒初值成立", async () => {
    const light = await measure(98, 2);
    const heavy = await measure(980, 20);
    for (const sample of [light, heavy]) {
      const perRecord = sample.bytes / sample.count;
      console.log(
        `[4.5] ${sample.count} 条（settled=${sample.settled} 封禁=${sample.banned}）：` +
          `main 构造 ${sample.snapshotMs.toFixed(2)} ms｜payload ${(sample.bytes / 1024).toFixed(1)} KiB` +
          `（${(perRecord / 1024).toFixed(2)} KiB/条）｜renderer 校验 ${sample.parseMs.toFixed(2)} ms`,
      );
    }
    console.log(`[4.5] 环境：${ENV}`);
    writeFileSync(
      resolve(import.meta.dirname, "../../../.workbuddy/u4-45-measurements.json"),
      `${JSON.stringify({ env: ENV, samples: [light, heavy] }, null, 2)}\n`,
    );

    // 判据 1：1000 条的"构造 + 校验"合计远小于 1 秒 ⇒ 每 1 秒轮询不会自我堆积
    expect(heavy.snapshotMs + heavy.parseMs).toBeLessThan(1000);
    // 判据 2：终态与封禁一条都不被裁剪（成本压力不构成裁剪理由）
    expect(heavy.settled).toBe(980);
    expect(heavy.banned).toBe(20);
    // 判据 3：受限元数据的单条成本有界（远超 2 KiB 就说明有正文混进来了）
    expect(heavy.bytes / heavy.count).toBeLessThan(2048);
    // 判据 4：字节数与条数近似线性（不是隐藏的平方成本）
    const linear = heavy.bytes / light.bytes;
    expect(linear).toBeGreaterThan(8);
    expect(linear).toBeLessThan(12);
  }, 120_000);
});
