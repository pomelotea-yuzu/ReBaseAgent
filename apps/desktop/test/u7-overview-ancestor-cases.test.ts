import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveChainTotals, indexRunsById } from "@shared/derive";
import { RunDetailSchema } from "@shared/ipc";
import { deriveOwnConsumption, deriveOwnOutput } from "@shared/overview";
import { deriveOwnTerminalFacts } from "@shared/terminal-facts";
import { afterAll, describe, expect, it } from "vitest";
import { RunDetailReadError, RunReadContext } from "../src/main/run-read-context";
import {
  LINEAGE_INCOMPLETE_TEXT,
  LINEAGE_METRICS_UNKNOWN_TEXT,
  lineageIncompleteViewOf,
} from "../src/renderer/src/lib/detail-completeness";
import { presentConsumption } from "../src/renderer/src/lib/overview-view";

/**
 * U7（improve-branch-comparison）任务 1.8：锁定**修订后**的概览缺祖先判据
 * （desktop-ui MODIFIED「运行概览呈现自有结果与消耗」的两个场景）。
 *
 * - 「缺祖先概览沿用已校验自有事实」（正对照）：ownOnly 详情进概览派生 ⇒
 *   固定提示 + 缺失 ID、自有结局/输出判据/消耗全部可读，沿链结论未知；
 * - 「非法详情不被概览绕过」（反对照）：损坏/版本/成环等严格错误在读取层
 *   就是失败——概览拿不到未校验载荷，不存在"通用降级为 ownOnly"的路径
 *   （U6 的 ownOnly 唯一入口 = 结构化 ENOENT，见 compare-read-context 回归）。
 *
 * 「原位详情错误与只读重试」的展示与重试时序由 U1 detail-request / U6
 * detail-refresh-guard 承载；「不恢复执行资格」由 U6 run-source-gate 承载
 * （RUN_LINEAGE_INCOMPLETE 拒绝执行续跑）——本文件只锁概览半边。
 */

const T0 = "2026-01-15T10:00:00.000Z";

let root: string;
let traces: string;

function freshTraces(): string {
  root = mkdtempSync(join(tmpdir(), "u7-overview-ancestor-"));
  traces = join(root, "traces");
  mkdirSync(traces);
  return traces;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function metaLine(
  id: string,
  opts: { parent?: string | null; fork?: unknown; version?: number } = {},
): string {
  return JSON.stringify({
    type: "run.meta",
    id,
    format_version: opts.version ?? 1,
    task: "u7 概览缺祖先夹具",
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

function writeRun(id: string, lines: string[]): void {
  writeFileSync(join(traces, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

/** ownOnly 正对照的已校验读取（真实文件：父缺失 ⇒ main 结构化降级） */
function readOwnOnly(): ReturnType<RunReadContext["readOf"]> {
  freshTraces();
  writeRun("r_own", [
    metaLine("r_own", {
      parent: "r_missing",
      fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
    }),
    stepLine("own_s1"),
    STOP,
  ]);
  return new RunReadContext(traces).readOf("r_own");
}

describe("U7 1.8 正对照：缺祖先概览沿用已校验自有事实", () => {
  it("ownOnly 详情通过自家 schema——概览只吃受校验载荷，无第三种入口", () => {
    const { detail } = readOwnOnly();
    expect(RunDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.completeness).toBe("ownOnly");
  });

  it("固定提示 + 缺失 ID：措辞唯一来源不改写，缺失祖先可点认", () => {
    const { detail } = readOwnOnly();
    const view = lineageIncompleteViewOf(detail);
    expect(view).not.toBeNull();
    expect(view?.text).toBe("仅显示本运行记录，父链不完整");
    expect(view?.text).toBe(LINEAGE_INCOMPLETE_TEXT);
    expect(view?.missingRunId).toBe("r_missing");
    expect(view?.missingNote).toContain("r_missing");
    expect(view?.chainTruncated).toBe(true);
  });

  it("自有结局可读：stopped/completed 正常结束（不因祖先缺失变 unknown）", () => {
    const { detail } = readOwnOnly();
    const facts = deriveOwnTerminalFacts(detail);
    expect(facts.event).toEqual({ event: "stopped", reason: "completed" });
    expect(facts.normalEnd).toBe(true);
    expect(facts.outcome.kind).toBe("completed");
  });

  it("输出判据诚实：无自有 llm.call ⇒ 未记录最终输出，不借祖先正文补齐", () => {
    const { detail } = readOwnOnly();
    const own = deriveOwnOutput({
      spans: detail.spans,
      leafSpanIds: detail.leafSpanIds,
      reason: "completed",
    });
    expect(own.finalOutput).toBeNull();
    expect(own.missingReason).toBe("no-llm-call");
    expect(own.latestIntermediate).toBeNull();
  });

  it("自有消耗可读且口径说明在场：沿链祖先指标未知，不补零、不推算", () => {
    const { detail } = readOwnOnly();
    const consumption = deriveOwnConsumption({
      spans: detail.spans,
      leafSpanIds: detail.leafSpanIds,
    });
    // ownOnly ⇒ 追加固定口径说明（唯一来源 detail-completeness）；complete ⇒ 不追加
    const ownOnlySection = presentConsumption(consumption, { lineageIncomplete: true });
    expect(ownOnlySection.scopeNote).toContain(LINEAGE_METRICS_UNKNOWN_TEXT);
    const completeSection = presentConsumption(consumption);
    expect(completeSection.scopeNote).not.toContain(LINEAGE_METRICS_UNKNOWN_TEXT);
    // 消耗只来自自有 spans：夹具无 llm.call/tool.invoke ⇒ 全零且不冒充实际零消费
    expect(ownOnlySection.tokensIn).toBe(0);
    expect(ownOnlySection.zeroUsageNote).not.toBeNull();
  });

  it("沿链结论未知：截断链摘要让累计派生为 null（与 1.7 同一口径）", () => {
    const { chainSummaries } = readOwnOnly();
    expect(chainSummaries.map((summary) => summary.id)).toEqual(["r_own"]);
    expect(deriveChainTotals(indexRunsById(chainSummaries), "r_own")).toBeNull();
  });
});

describe("U7 1.8 反对照：非法详情不被概览绕过", () => {
  it("损坏 JSON：严格失败（非 ownOnly），不产出任何可渲染载荷", () => {
    freshTraces();
    writeRun("r_broken", ["这不是 JSON"]);
    let thrown: unknown;
    try {
      new RunReadContext(traces).readOf("r_broken");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RunDetailReadError);
    const error = thrown as RunDetailReadError;
    expect(error.message).toContain("校验失败");
    expect(error.message).not.toContain(traces);
  });

  it("未来版本：读取层拒绝，不降级 ownOnly", () => {
    freshTraces();
    writeRun("r_future", [metaLine("r_future", { version: 99 }), STOP]);
    expect(() => new RunReadContext(traces).readOf("r_future")).toThrow(/校验失败/);
  });

  it("成环：LINEAGE_CYCLE 诊断，绝无部分概览载荷", () => {
    freshTraces();
    writeRun("r_loop_a", [
      metaLine("r_loop_a", {
        parent: "r_loop_b",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
      STOP,
    ]);
    writeRun("r_loop_b", [
      metaLine("r_loop_b", {
        parent: "r_loop_a",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
      STOP,
    ]);
    let thrown: unknown;
    try {
      new RunReadContext(traces).readOf("r_loop_a");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RunDetailReadError);
    expect((thrown as RunDetailReadError).diagnostic).toBe("LINEAGE_CYCLE");
  });

  it("结构化缺失是 ownOnly 的唯一入口：非 ENOENT 失败一律不走 ownOnly 形态", () => {
    // 同目录下：缺失祖先（合法 ownOnly）与损坏祖先（严格失败）并存，
    // 两形态必须可分辨——概览据此分别呈现「可读自有事实」与「原位错误」
    freshTraces();
    writeRun("r_ok_parent", [metaLine("r_ok_parent"), STOP]);
    writeRun("r_on_missing", [
      metaLine("r_on_missing", {
        parent: "r_gone",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
      STOP,
    ]);
    writeRun("r_bad", ['{"type":"run.meta","id":"r_bad"']);
    writeRun("r_on_bad", [
      metaLine("r_on_bad", {
        parent: "r_bad",
        fork: { at_span: "s_01", edit: { field: "result", value: "x" } },
      }),
      STOP,
    ]);
    const context = new RunReadContext(traces);

    const ownOnly = context.readOf("r_on_missing").detail;
    expect(ownOnly.completeness).toBe("ownOnly");

    let thrown: unknown;
    try {
      context.readOf("r_on_bad");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RunDetailReadError);
    expect((thrown as RunDetailReadError).diagnostic).toBe("ANCESTOR_INVALID");
    expect((thrown as RunDetailReadError).message).not.toContain(LINEAGE_INCOMPLETE_TEXT);
  });
});
