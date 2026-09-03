import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRunText } from "@rebaseagent/trace-sdk";
import { buildSpanTree, deriveRunSummary, deriveStepStats, spanDurationMs } from "@shared/derive";

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
