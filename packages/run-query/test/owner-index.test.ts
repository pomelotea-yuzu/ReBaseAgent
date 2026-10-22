import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveSpanOwner } from "../src/read/owner-index";
import { RunReadContext } from "../src/read/read-context";

const T0 = "2026-10-22T00:00:00.000Z";
let root = "";
let traces = "";

beforeEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "run-query-owner-"));
  traces = join(root, "traces");
  mkdirSync(traces);
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

function metaLine(id: string, opts: { parent?: string | null; fork?: unknown } = {}): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: 1,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    parent: opts.parent ?? null,
    fork: opts.fork ?? null,
  });
}

function stepLine(id: string): string {
  return JSON.stringify({ type: "span", id, parent: null, kind: "agent.step", n: 1 });
}

const STOP = JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" });

function forkOf(field: string, atSpan: string): unknown {
  return { at_span: atSpan, edit: { field, value: `${field} 编辑值` } };
}

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("投影 span→owner 索引", () => {
  it("result 链返回真实 owner；被截断祖先不可读", () => {
    writeRun("r_root", [
      metaLine("r_root"),
      stepLine("s_1"),
      stepLine("s_2"),
      stepLine("s_3"),
      STOP,
    ]);
    writeRun("r_child", [
      metaLine("r_child", { parent: "r_root", fork: forkOf("result", "s_2") }),
      stepLine("s_4"),
      STOP,
    ]);

    const { detail, ownerIndex } = new RunReadContext(traces).readWithOwners("r_child");
    expect(detail.spans.map((span) => span.id)).toEqual(["s_1", "s_2", "s_4"]);
    expect(ownerIndex.status).toBe("ok");
    expect(resolveSpanOwner(ownerIndex, "s_1")).toEqual({ status: "ok", ownerRunId: "r_root" });
    expect(resolveSpanOwner(ownerIndex, "s_2")).toEqual({ status: "ok", ownerRunId: "r_root" });
    expect(resolveSpanOwner(ownerIndex, "s_4")).toEqual({ status: "ok", ownerRunId: "r_child" });
    expect(resolveSpanOwner(ownerIndex, "s_3")).toEqual({
      status: "truncated",
      ownerRunId: "r_root",
    });
    expect(resolveSpanOwner(ownerIndex, "s_2", "r_root")).toEqual({
      status: "ok",
      ownerRunId: "r_root",
    });
    expect(resolveSpanOwner(ownerIndex, "s_2", "r_child")).toEqual({ status: "not_found" });
    expect(resolveSpanOwner(ownerIndex, "s_missing")).toEqual({ status: "not_found" });
  });

  it("重名 span 要求显式 owner；显式截断祖先仍拒绝", () => {
    writeRun("r_root", [metaLine("r_root"), stepLine("s_1"), stepLine("s_2"), STOP]);
    writeRun("r_child", [
      metaLine("r_child", { parent: "r_root", fork: forkOf("system_prompt", "s_1") }),
      stepLine("s_2"),
      STOP,
    ]);

    const { detail, ownerIndex } = new RunReadContext(traces).readWithOwners("r_child");
    expect(detail.spans.map((span) => span.id)).toEqual(["s_2"]);
    expect(ownerIndex.status).toBe("ok");
    expect(resolveSpanOwner(ownerIndex, "s_2")).toEqual({
      status: "ambiguous",
      owners: ["r_root", "r_child"],
    });
    expect(resolveSpanOwner(ownerIndex, "s_2", "r_child")).toEqual({
      status: "ok",
      ownerRunId: "r_child",
    });
    expect(resolveSpanOwner(ownerIndex, "s_2", "r_root")).toEqual({
      status: "truncated",
      ownerRunId: "r_root",
    });
  });

  it("readOf 保持旧返回形状，不额外计算 owner 索引", () => {
    writeRun("r_root", [metaLine("r_root"), stepLine("s_1"), STOP]);
    const result = new RunReadContext(traces).readOf("r_root");
    expect(Object.keys(result).sort()).toEqual(["chainSummaries", "detail"]);
  });
});
