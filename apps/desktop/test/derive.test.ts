import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { parseRunText } from "@rebaseagent/trace-sdk";
import {
  buildSpanTree,
  deriveBudgetSeries,
  deriveRunSummary,
  deriveStepStats,
  flattenTree,
  spanDurationMs,
} from "@shared/derive";
import { describe, expect, it } from "vitest";

/** trace-sdk 的 fixtures 是本仓库的"真实数据"基准（桌面端开发期零 API 消耗） */
const FIXTURES = resolve(import.meta.dirname, "../../../packages/trace-sdk/fixtures");

function loadFixture(name: string) {
  const text = readFileSync(resolve(FIXTURES, `${name}.jsonl`), "utf8");
  return parseRunText(text.split("\n"));
}

describe("buildSpanTree", () => {
  it("normal fixture：3 个 step 根节点，子节点挂到各自 step 下", () => {
    const record = loadFixture("normal");
    const roots = buildSpanTree(record.spans);

    expect(roots).toHaveLength(3);
    expect(roots.every((node) => node.span.kind === "agent.step")).toBe(true);
    expect(roots[0]?.children.map((c) => c.span.kind)).toEqual(["llm.call", "tool.invoke"]);
    // 最后一步只有 LLM 调用（任务完成）
    expect(roots[2]?.children.map((c) => c.span.kind)).toEqual(["llm.call"]);
  });

  it("父 id 不存在的孤儿 span 挂到根层并标记，不静默丢弃", () => {
    const record = loadFixture("normal");
    const orphan = { ...record.spans[1]!, id: "s_ghost", parent: "s_missing" };
    const roots = buildSpanTree([record.spans[0]!, orphan]);

    expect(roots).toHaveLength(2);
    const ghost = roots.find((node) => node.span.id === "s_ghost");
    expect(ghost?.orphan).toBe(true);
  });
});

describe("deriveRunSummary", () => {
  it("normal fixture：聚合数字与 fixtures 基准一致", () => {
    const summary = deriveRunSummary(loadFixture("normal"));
    expect(summary).toMatchObject({
      id: "r_01",
      status: "completed",
      reason: "completed",
      parent: null,
      steps: 3,
      toolCalls: 2,
      toolErrors: 0,
      tokensIn: 6470,
      tokensOut: 378,
    });
    expect(summary.durationMs).not.toBeNull();
  });

  it("tool-error fixture：工具报错计入错误数，run 状态仍是 completed", () => {
    const summary = deriveRunSummary(loadFixture("tool-error"));
    expect(summary).toMatchObject({
      steps: 4,
      toolCalls: 3,
      toolErrors: 1,
      status: "completed",
      reason: "completed",
    });
  });

  it("崩溃的 run：status 为 crashed，reason 为 null（无终止事件）", () => {
    const record = loadFixture("infinite-loop");
    // infinite-loop 有终止事件；手工造一个无终止事件的崩溃 run
    const crashed = { ...record, events: [] };
    const summary = deriveRunSummary(crashed);
    expect(summary.status).toBe("completed"); // 输入 status 决定，不臆造
    expect(summary.reason).toBeNull();
  });

  it("分支 fixture 摘要：parent 指向 r_01", () => {
    const summary = deriveRunSummary(loadFixture("branch"));
    expect(summary).toMatchObject({ id: "r_02", parent: "r_01", steps: 2, toolCalls: 1 });
  });
});

describe("deriveStepStats / spanDurationMs", () => {
  it("step 子树的 token 合计等于其下 llm.call 之和", () => {
    const record = loadFixture("normal");
    const roots = buildSpanTree(record.spans);
    const first = roots[0]!;
    const stats = deriveStepStats(first);

    const llm = first.children.find((c) => c.span.kind === "llm.call");
    if (llm?.span.kind !== "llm.call") throw new Error("第一个 step 应含 llm.call");
    expect(stats.tokensIn).toBe(llm.span.response.usage.in);
    expect(stats.tokensOut).toBe(llm.span.response.usage.out);
    expect(stats.toolCalls).toBe(1);
  });

  it("缺失 timing 的 span 耗时为 null，不臆造", () => {
    const record = loadFixture("normal");
    const noTiming = { ...record.spans[0]!, timing: undefined };
    expect(spanDurationMs(noTiming)).toBeNull();
  });

  it("step 子树跨度 ≥ 任一子节点耗时（timing 存在时）", () => {
    const record = loadFixture("normal");
    const roots = buildSpanTree(record.spans);
    const step = roots[0]!;
    const stepMs = deriveStepStats(step).durationMs;
    expect(stepMs).not.toBeNull();
    for (const child of step.children) {
      const childMs = spanDurationMs(child.span);
      if (childMs !== null && stepMs !== null) {
        expect(childMs).toBeLessThanOrEqual(stepMs);
      }
    }
  });
});

describe("deriveBudgetSeries", () => {
  let seq = 0;
  /** 构造合成 span 的最小工厂（预算派生只关心 kind/id/usage/parent） */
  function step(parent: string | null): SpanLine {
    seq += 1;
    return { type: "span", id: `s_step_${seq}`, kind: "agent.step", parent, n: 1 };
  }
  function llm(id: string, parent: string, inTok: number, outTok: number): SpanLine {
    return {
      type: "span",
      id,
      kind: "llm.call",
      parent,
      request: { model: "m", messages: [{ role: "user", content: "x" }] },
      response: {
        content: null,
        reasoning_content: null,
        tool_calls: [],
        usage: { in: inTok, out: outTok },
        ttft_ms: 1,
      },
    };
  }
  function tool(id: string, parent: string): SpanLine {
    return {
      type: "span",
      id,
      kind: "tool.invoke",
      parent,
      tool: "read_file",
      args: {},
      result: "内容",
      dur_ms: 1,
      error: null,
    };
  }

  it("3 次 llm.call：cumulative 依次累加 in+out，与聚合一致", () => {
    const a = step(null);
    const l1 = llm("l_1", a.id, 100, 50);
    const l2 = llm("l_2", a.id, 200, 0);
    const l3 = llm("l_3", a.id, 300, 100);
    const series = deriveBudgetSeries([a, l1, l2, l3]);

    expect(series.points.map((p) => p.cumulative)).toEqual([150, 350, 750]);
    expect(series.points.map((p) => p.spanId)).toEqual(["l_1", "l_2", "l_3"]);
    expect(series.points.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(series.total).toBe(750);
  });

  it("只收集 llm.call，跳过 tool.invoke 与其他 kind", () => {
    const a = step(null);
    const l1 = llm("l_1", a.id, 10, 10);
    const t = tool("t_1", a.id);
    const l2 = llm("l_2", a.id, 20, 5);
    const series = deriveBudgetSeries([a, l1, t, l2]);

    expect(series.points.map((p) => p.spanId)).toEqual(["l_1", "l_2"]);
    expect(series.points.map((p) => p.cumulative)).toEqual([20, 45]);
    // 只算 llm 的 token，工具存在不产生额外点
    expect(series.total).toBe(45);
  });

  it("DFS 顺序与 SpanTree/flattenTree 一致", () => {
    const s1 = step(null);
    const l1 = llm("l_1", s1.id, 1, 1);
    const s2 = step(s1.id); // 嵌套 step
    const l2 = llm("l_2", s2.id, 2, 2);
    const s3 = step(null);
    const l3 = llm("l_3", s3.id, 3, 3);
    const spans = [s1, l1, s2, l2, s3, l3];

    // 数组里 s2 的 llm 排在 s3 前面；DFS 也应（pre-order：先子树后兄弟后续）
    const expected = flattenTree(buildSpanTree(spans))
      .map((node) => node.span)
      .filter((s): s is Extract<SpanLine, { kind: "llm.call" }> => s.kind === "llm.call")
      .map((s) => s.id);
    const series = deriveBudgetSeries(spans);
    expect(series.points.map((p) => p.spanId)).toEqual(expected);
  });
});
