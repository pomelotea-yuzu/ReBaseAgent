import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { findIllegalRunIdViolation } from "../src/read/lineage";
import { RunDetailReadError, RunReadContext } from "../src/read/read-context";

const T0 = "2026-10-22T00:00:00.000Z";
let root = "";
let traces = "";

beforeEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "run-query-read-"));
  traces = join(root, "traces");
  mkdirSync(traces);
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

function metaLine(
  id: string,
  opts: { parent?: string | null; fork?: unknown; source?: unknown } = {},
): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
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

describe("run-query 单次读取上下文", () => {
  it("同一上下文内同一物理 run 只解析一次，新上下文重新读盘", () => {
    writeRun("r_root", [metaLine("r_root"), stepLine("root_s1"), STOP]);
    const probe = countingReader();
    const context = new RunReadContext(traces, probe.read);

    context.readOf("r_root");
    context.readOf("r_root");
    context.detailOf("r_root");
    const rootFile = join(traces, "r_root.jsonl");
    expect(probe.counts.get(rootFile)).toBe(1);

    const nextRequest = new RunReadContext(traces, probe.read);
    nextRequest.readOf("r_root");
    expect(probe.counts.get(rootFile)).toBe(2);
  });

  it("提示父本缺失的 prompt 分支返回结构化 ownOnly", () => {
    writeRun("r_child", [
      metaLine("r_child", { parent: "r_missing", fork: forkOf("system_prompt", "child_s1") }),
      stepLine("child_s1"),
      STOP,
    ]);
    const detail = new RunReadContext(traces).detailOf("r_child");
    expect(detail.completeness).toBe("ownOnly");
    expect(detail.spanScope).toBe("own");
    expect(detail.lineage).toEqual({
      status: "incomplete",
      reason: "ANCESTOR_NOT_FOUND",
      missingRunId: "r_missing",
    });
    expect(detail.chain.map((hop) => hop.meta.id)).toEqual(["r_child"]);
    expect(detail.spans.map((span) => span.id)).toEqual(["child_s1"]);
  });

  it("祖先损坏是结构化失败，不降级成缺父", () => {
    writeRun("r_child", [
      metaLine("r_child", { parent: "r_bad", fork: forkOf("system_prompt", "child_s1") }),
      stepLine("child_s1"),
      STOP,
    ]);
    writeFileSync(join(traces, "r_bad.jsonl"), `${metaLine("r_bad")}\n{"id":\n`);
    let caught: unknown;
    try {
      new RunReadContext(traces).detailOf("r_child");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunDetailReadError);
    expect((caught as RunDetailReadError).diagnostic).toBe("ANCESTOR_INVALID");
    expect((caught as Error).message).toContain("祖先 run r_bad");
  });

  it("非法 run 标识在读取前拒绝，不触碰文件系统", () => {
    expect(findIllegalRunIdViolation("../escape")).not.toBeNull();
    const probe = countingReader();
    const context = new RunReadContext(traces, probe.read);
    expect(() => context.detailOf("../escape")).toThrow("run 标识非法");
    expect(probe.counts.size).toBe(0);
  });

  it("混合链在 prompt 独立边界重置，不拼旧轨迹", () => {
    writeRun("r_root", [metaLine("r_root"), stepLine("root_s1"), STOP]);
    writeRun("r_prompt", [
      metaLine("r_prompt", { parent: "r_root", fork: forkOf("system_prompt", "root_s1") }),
      stepLine("prompt_s1"),
      STOP,
    ]);
    writeRun("r_result", [
      metaLine("r_result", { parent: "r_prompt", fork: forkOf("result", "prompt_s1") }),
      stepLine("result_s1"),
      STOP,
    ]);
    const detail = new RunReadContext(traces).detailOf("r_result");
    expect(detail.completeness).toBe("complete");
    expect(detail.spanScope).toBe("resolved");
    expect(detail.chain.map((hop) => hop.meta.id)).toEqual(["r_root", "r_prompt", "r_result"]);
    expect(detail.spans.map((span) => span.id)).toEqual(["prompt_s1", "result_s1"]);
  });
});
