import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { deriveCacheCoverage, deriveOwnConsumption } from "@shared/overview";
import { describe, expect, it } from "vitest";

/**
 * U1（refactor-run-workspace）任务 2.3：自有消耗派生与缓存覆盖范围。
 *
 * 判据来源：
 *   - desktop-ui delta「run 列表从 traces 目录扫描派生」/「缓存命中可视化」：
 *     本次指标不累计共享前缀、run 级累计现算、fork run 累计不含祖先前缀、
 *     输入为零与全未知缓存。
 *   - 「运行概览呈现自有结果与消耗」的「本次指标不累计共享前缀」场景：
 *     缺失 timing 不补零、cache_hit=0 算记录、失败占位零不被解释为实际零消费。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const has = (name: string): boolean => existsSync(resolve(FIXTURE_DIR, `${name}.jsonl`));

function ownDetail(name: string) {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  return { spans: record.spans, leafSpanIds: record.spans.map((s) => s.id) };
}

/** 造一个 llm.call（自有段；父指向 step） */
function llm(
  id: string,
  stepId: string,
  usage: { in: number; out: number; cache_hit?: number },
  timing?: { started_at: string; ended_at: string },
): SpanLine {
  return {
    type: "span",
    kind: "llm.call",
    id,
    parent: stepId,
    request: { model: "m", messages: [] },
    response: {
      content: "x",
      reasoning_content: null,
      tool_calls: [],
      usage,
      ttft_ms: 1,
    },
    ...(timing === undefined ? {} : { timing }),
  } as SpanLine;
}

describe("deriveOwnConsumption：本次消耗只算自有段", () => {
  it("u1-ok：token / 工具计数与 fixture 直读一致，耗时为已记录区间", () => {
    if (!has("u1-ok")) return;
    const record = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
    const consumption = deriveOwnConsumption(ownDetail("u1-ok"));

    const tokensIn = record.spans
      .filter((s) => s.kind === "llm.call")
      .reduce((sum, s) => sum + (s.kind === "llm.call" ? s.response.usage.in : 0), 0);
    const tokensOut = record.spans
      .filter((s) => s.kind === "llm.call")
      .reduce((sum, s) => sum + (s.kind === "llm.call" ? s.response.usage.out : 0), 0);
    expect(consumption.tokensIn).toBe(tokensIn);
    expect(consumption.tokensOut).toBe(tokensOut);
    expect(consumption.durationMs).not.toBeNull();
  });

  it("祖先共享前缀的 token 不计入本次消耗（判据有牙）", () => {
    const ancestorLlm = llm("s_ancestor_llm", "s_ancestor_step", { in: 9999, out: 999 });
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s_own_step",
      parent: null,
      n: 1,
    } as SpanLine;
    const ownLlm = llm("s_own_llm", "s_own_step", { in: 100, out: 10 });

    const withAncestor = deriveOwnConsumption({
      spans: [ancestorLlm, step, ownLlm],
      leafSpanIds: ["s_own_step", "s_own_llm"], // 祖先不在自有段
    });
    expect(withAncestor.tokensIn).toBe(100);
    expect(withAncestor.tokensOut).toBe(10);

    // 对照：把祖先也列入自有段则应累加（证明过滤真的在起作用，而不是恒丢弃）
    const all = deriveOwnConsumption({
      spans: [ancestorLlm, step, ownLlm],
      leafSpanIds: ["s_ancestor_llm", "s_own_step", "s_own_llm"],
    });
    expect(all.tokensIn).toBe(10099);
  });

  it("自有 span 无 timing ⇒ durationMs 为 null（未知不补零）", () => {
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s_step",
      parent: null,
      n: 1,
    } as SpanLine;
    const noTiming = llm("s_llm", "s_step", { in: 5, out: 1 });
    const consumption = deriveOwnConsumption({
      spans: [step, noTiming],
      leafSpanIds: ["s_step", "s_llm"],
    });
    expect(consumption.durationMs).toBeNull();
    expect(consumption.tokensIn).toBe(5);
  });

  it("嵌套的 cache 覆盖同源于自有段（消费口径与缓存口径一致，不能各过滤一套）", () => {
    const ancestor = llm("s_a", "s_as", { in: 500, out: 5, cache_hit: 400 });
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s",
      parent: null,
      n: 1,
    } as SpanLine;
    const own = llm("s1", "s", { in: 100, out: 10, cache_hit: 60 });
    const consumption = deriveOwnConsumption({
      spans: [ancestor, step, own],
      leafSpanIds: ["s", "s1"],
    });
    // 自有段只有 s1 ⇒ 覆盖 1/1，命中 60；祖先的 400 不得漏进本次缓存
    expect(consumption.cache).toEqual({ recorded: 1, total: 1, hitTotal: 60 });
  });

  it("工具错误单独计数，不影响 token", () => {
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s_step",
      parent: null,
      n: 1,
    } as SpanLine;
    const toolError: SpanLine = {
      type: "span",
      kind: "tool.invoke",
      id: "s_tool",
      parent: "s_step",
      tool: "read_file",
      args: {},
      result: null,
      dur_ms: 3,
      error: "读失败",
    } as SpanLine;
    const consumption = deriveOwnConsumption({
      spans: [step, toolError],
      leafSpanIds: ["s_step", "s_tool"],
    });
    expect(consumption.toolCalls).toBe(1);
    expect(consumption.toolErrors).toBe(1);
    expect(consumption.tokensIn).toBe(0);
  });
});

describe("deriveCacheCoverage：缓存覆盖范围（0 是记录、缺失是未知）", () => {
  it("3 次自有调用中 2 次带 cache_hit ⇒ recorded=2, total=3, 合计为两者之和", () => {
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s",
      parent: null,
      n: 1,
    } as SpanLine;
    const spans = [
      step,
      llm("s1", "s", { in: 1000, out: 10, cache_hit: 800 }),
      llm("s2", "s", { in: 1000, out: 10 }), // 无字段
      llm("s3", "s", { in: 1000, out: 10, cache_hit: 0 }), // 0 是记录
    ];
    const cov = deriveCacheCoverage({ spans, leafSpanIds: ["s", "s1", "s2", "s3"] });
    expect(cov).toEqual({ recorded: 2, total: 3, hitTotal: 800 });
  });

  it("只有 cache_hit: 0 ⇒ recorded=1 且 hitTotal=0（不是 null）", () => {
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s",
      parent: null,
      n: 1,
    } as SpanLine;
    const cov = deriveCacheCoverage({
      spans: [step, llm("s1", "s", { in: 5, out: 1, cache_hit: 0 })],
      leafSpanIds: ["s", "s1"],
    });
    expect(cov).toEqual({ recorded: 1, total: 1, hitTotal: 0 });
  });

  it("全部无字段 ⇒ recorded=0 且 hitTotal=null（不显示虚构零命中）", () => {
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s",
      parent: null,
      n: 1,
    } as SpanLine;
    const cov = deriveCacheCoverage({
      spans: [step, llm("s1", "s", { in: 5, out: 1 })],
      leafSpanIds: ["s", "s1"],
    });
    expect(cov).toEqual({ recorded: 0, total: 1, hitTotal: null });
    expect(cov.hitTotal).not.toBe(0); // 未知 ≠ 0
  });

  it("祖先带 cache_hit、自有段无字段 ⇒ 不计入覆盖（判据有牙）", () => {
    const ancestor = llm("s_a", "s_as", { in: 500, out: 5, cache_hit: 400 });
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s",
      parent: null,
      n: 1,
    } as SpanLine;
    const own = llm("s1", "s", { in: 5, out: 1 });
    const cov = deriveCacheCoverage({
      spans: [ancestor, step, own],
      leafSpanIds: ["s", "s1"],
    });
    expect(cov).toEqual({ recorded: 0, total: 1, hitTotal: null });
  });

  it("u1-cache-partial：与 fixture 直读的记录数一致", () => {
    if (!has("u1-cache-partial")) return;
    const record = readRun(resolve(FIXTURE_DIR, "u1-cache-partial.jsonl"));
    const own = record.spans.filter((s) => s.kind === "llm.call");
    const recorded = own.filter(
      (s) => s.kind === "llm.call" && s.response.usage.cache_hit !== undefined,
    ).length;
    const cov = deriveCacheCoverage(ownDetail("u1-cache-partial"));
    expect(cov.recorded).toBe(recorded);
    expect(cov.total).toBe(own.length);
    expect(cov.hitTotal).not.toBeNull(); // 该 fixture 含 0 命中，属已记录
  });

  it("输入为零且 cache_hit=0 ⇒ 只给绝对命中，覆盖仍算已记录", () => {
    const step: SpanLine = {
      type: "span",
      kind: "agent.step",
      id: "s",
      parent: null,
      n: 1,
    } as SpanLine;
    const cov = deriveCacheCoverage({
      spans: [step, llm("s1", "s", { in: 0, out: 0, cache_hit: 0 })],
      leafSpanIds: ["s", "s1"],
    });
    expect(cov.recorded).toBe(1);
    expect(cov.hitTotal).toBe(0);
  });
});

describe("与 EXPECTED-OUTCOMES.json 的缓存覆盖交叉核对", () => {
  it("每份 fixture 的 (recorded, total) 与预期表一致", () => {
    const expected = JSON.parse(
      readFileSync(resolve(FIXTURE_DIR, "EXPECTED-OUTCOMES.json"), "utf8"),
    ) as Record<string, { cacheCoverage: [number, number] }>;
    for (const [name, exp] of Object.entries(expected)) {
      if (!has(name)) continue;
      const cov = deriveCacheCoverage(ownDetail(name));
      expect([cov.recorded, cov.total], name).toEqual(exp.cacheCoverage);
    }
  });
});
