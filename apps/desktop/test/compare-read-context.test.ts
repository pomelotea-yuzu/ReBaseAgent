import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { RunReadContext } from "../src/main/run-read-context";
import { RunRepository } from "../src/main/run-repository";

/**
 * U7（improve-branch-comparison）tasks 1.2：按 run ID 缓存的单次读取上下文。
 *
 * 提取只改变复用方式，不改变 U6 语义：ownOnly 结构化降级、损坏/版本/权限等
 * 严格失败、getRun 与上下文逐字同源（对应场景「列表完整但比较读取缺祖先」的
 * 读取半边——比较层消费在 1.3/1.6/1.7 接线）。缓存含失败：同一上下文内每个
 * 物理 run 最多解析一次，共享祖先跨比较对象只读一份。
 */

const T0 = "2026-01-15T10:00:00.000Z";

let root: string;
let traces: string;

function freshTraces(): string {
  root = mkdtempSync(join(tmpdir(), "u7-read-context-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  return traces;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function metaLine(id: string, opts: { parent?: string | null; fork?: unknown } = {}): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: "u7 读取上下文夹具",
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
  });
}

function stepLine(id: string, opts: { parent?: string | null; n?: number } = {}): string {
  return JSON.stringify({
    type: "span",
    id,
    parent: opts.parent ?? null,
    kind: "agent.step",
    n: opts.n ?? 1,
  });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

function forkOf(field: string, atSpan: string): unknown {
  return { at_span: atSpan, edit: { field, value: `${field} 编辑值` } };
}

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

/** 带 per-file 计数的读取探针（包住真 readRun，只计数不改变行为） */
function countingReader(): {
  read: (file: string) => ReturnType<typeof readRun>;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  return {
    counts,
    read: (file: string) => {
      counts.set(file, (counts.get(file) ?? 0) + 1);
      return readRun(file);
    },
  };
}

function fileOf(id: string): string {
  return join(traces, `${id}.jsonl`);
}

describe("U7 1.2 单次读取上下文：物理 run 只解析一次", () => {
  it("两个子 run 共享同一祖先时，祖先文件在本次上下文内只读取一份", () => {
    freshTraces();
    writeRun("r_a", [metaLine("r_a"), stepLine("a_s1"), STOP]);
    writeRun("r_b1", [
      metaLine("r_b1", { parent: "r_a", fork: forkOf("result", "a_s1") }),
      stepLine("b1_s1"),
      STOP,
    ]);
    writeRun("r_b2", [
      metaLine("r_b2", { parent: "r_a", fork: forkOf("result", "a_s1") }),
      stepLine("b2_s1"),
      STOP,
    ]);
    const probe = countingReader();
    const context = new RunReadContext(traces, probe.read);

    const b1 = context.detailOf("r_b1");
    const b2 = context.detailOf("r_b2");

    expect(probe.counts.get(fileOf("r_a"))).toBe(1);
    expect(probe.counts.get(fileOf("r_b1"))).toBe(1);
    expect(probe.counts.get(fileOf("r_b2"))).toBe(1);
    // 两个详情都是完整 resolved 链（U6 语义不变）
    expect(b1.completeness).toBe("complete");
    expect(b1.spanScope).toBe("resolved");
    expect(b1.chain.map((hop) => hop.meta.id)).toEqual(["r_a", "r_b1"]);
    expect(b2.chain.map((hop) => hop.meta.id)).toEqual(["r_a", "r_b2"]);
    // 共享祖先的记录是同一份对象（同一次解析的复用，不是两份拷贝）；
    // chain 包装对象按次新建，共享的判据落在 meta 引用上
    expect(b1.chain[0]?.meta).toBe(b2.chain[0]?.meta);
  });

  it("同一请求 id 的 lineage 结论记忆复用，重复调用不再触发物理读取", () => {
    freshTraces();
    writeRun("r_a", [metaLine("r_a"), STOP]);
    const probe = countingReader();
    const context = new RunReadContext(traces, probe.read);

    context.detailOf("r_a");
    context.detailOf("r_a");

    expect(probe.counts.get(fileOf("r_a"))).toBe(1);
  });

  it("失败同样缓存：坏祖先文件在两个子 run 的读取中只解析一次", () => {
    freshTraces();
    writeRun("r_bad", ['{"type":"run.meta","id":"r_bad"', STOP]);
    writeRun("r_c1", [metaLine("r_c1", { parent: "r_bad", fork: forkOf("result", "s_01") }), STOP]);
    writeRun("r_c2", [metaLine("r_c2", { parent: "r_bad", fork: forkOf("result", "s_01") }), STOP]);
    const probe = countingReader();
    const context = new RunReadContext(traces, probe.read);

    expect(() => context.detailOf("r_c1")).toThrow(/r_bad/);
    expect(() => context.detailOf("r_c2")).toThrow(/r_bad/);

    expect(probe.counts.get(fileOf("r_bad"))).toBe(1);
  });
});

describe("U7 1.2 提取不改 U6 语义：ownOnly 与严格失败", () => {
  it("祖先 ENOENT 走结构化 ownOnly，detailOf 不抛；getRun 与上下文逐字同源", () => {
    freshTraces();
    writeRun("r_own", [
      metaLine("r_own", { parent: "r_missing", fork: forkOf("result", "s_01") }),
      stepLine("own_s1"),
      STOP,
    ]);
    const repository = new RunRepository(traces);
    const context = new RunReadContext(traces);

    const viaContext = context.detailOf("r_own");
    const viaRepository = repository.getRun("r_own");

    expect(viaContext.completeness).toBe("ownOnly");
    expect(viaContext.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_missing",
    });
    expect(viaContext.chain.map((hop) => hop.meta.id)).toEqual(["r_own"]);
    expect(viaRepository).toEqual(viaContext);
  });

  it("损坏祖先是严格失败（非 ownOnly），当前 run 损坏同样是严格失败", () => {
    freshTraces();
    writeRun("r_bad_anc", ['{"type":"run.meta","id":"r_bad_anc"']);
    writeRun("r_child", [
      metaLine("r_child", { parent: "r_bad_anc", fork: forkOf("result", "s_01") }),
      STOP,
    ]);
    writeRun("r_broken", ["这不是 JSON"]);
    const context = new RunReadContext(traces);

    expect(() => context.detailOf("r_child")).toThrow(/祖先 run r_bad_anc 校验失败/);
    expect(() => context.detailOf("r_broken")).toThrow(/run r_broken 校验失败/);
  });

  it("完整纯 result 链的 getRun 输出与上下文一致（含 resolveBranch 拼接轨迹）", () => {
    freshTraces();
    writeRun("r_root", [metaLine("r_root"), stepLine("root_s1"), STOP]);
    writeRun("r_mid", [
      metaLine("r_mid", { parent: "r_root", fork: forkOf("result", "root_s1") }),
      stepLine("mid_s1"),
      STOP,
    ]);
    writeRun("r_leaf", [
      metaLine("r_leaf", { parent: "r_mid", fork: forkOf("result", "mid_s1") }),
      stepLine("leaf_s1"),
      STOP,
    ]);
    const repository = new RunRepository(traces);
    const context = new RunReadContext(traces);

    const viaContext = context.detailOf("r_leaf");
    const viaRepository = repository.getRun("r_leaf");
    expect(viaRepository).toEqual(viaContext);
    expect(viaContext.spans.map((span) => span.id)).toEqual(["root_s1", "mid_s1", "leaf_s1"]);
  });
});
