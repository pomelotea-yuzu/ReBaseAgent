import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { parseRunText } from "@rebaseagent/trace-sdk";
import {
  buildRunForest,
  buildSpanTree,
  deriveBudgetSeries,
  deriveCacheHitTotal,
  deriveChainTotals,
  deriveComparison,
  deriveRunSummary,
  deriveStepStats,
  findCommonAncestor,
  findStepLlm,
  flattenTree,
  forkEditLabel,
  indexRunsById,
  layoutRunTree,
  spanDurationMs,
} from "@shared/derive";
import type { RunSummary } from "@shared/ipc";
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

  it("分叉摘要只带 at_span、edit_field 与实验组标签，不带 value", () => {
    const summary = deriveRunSummary(loadFixture("branch"));
    expect(summary.fork).toEqual({
      at_span: "s_03",
      edit_field: "result",
      experiment_id: null,
    });
  });

  it("根 run 的分叉摘要为 null，不臆造", () => {
    expect(deriveRunSummary(loadFixture("normal")).fork).toBeNull();
  });

  it("model_params 分叉提取实验组标签；其它字段与缺标签恒为 null（add-model-ab-experiments）", () => {
    const record = loadFixture("branch");
    const withAb = {
      ...record,
      meta: {
        ...record.meta,
        fork: {
          at_span: "s_01",
          edit: {
            field: "model_params",
            value: { model: "m2", params: { temperature: 0.7 }, experimentId: "exp_9" },
          },
        },
      },
    };
    expect(deriveRunSummary(withAb).fork?.experiment_id).toBe("exp_9");

    const noTag = {
      ...withAb,
      meta: {
        ...withAb.meta,
        fork: { at_span: "s_01", edit: { field: "model_params", value: { model: "m2" } } },
      },
    };
    expect(deriveRunSummary(noTag).fork?.experiment_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 分支树派生：以下用例全部用内存构造的 RunSummary（零 API、零文件）
// ---------------------------------------------------------------------------

let seq = 0;

/** 构造一条 run 列表项的最小工厂（分支树只关心 parent / fork / 聚合数字） */
function makeRun(
  id: string,
  parent: string | null,
  overrides: Partial<RunSummary> = {},
): RunSummary {
  seq += 1;
  return {
    id,
    task: "读 README 写摘要",
    model: "deepseek-chat",
    created_at: `2026-09-05T21:00:${String(seq).padStart(2, "0")}.000Z`,
    status: "completed",
    parent,
    fork: null,
    reason: "completed",
    steps: 1,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 1000,
    tokensOut: 100,
    durationMs: 1000,
    source: null,
    ...overrides,
  };
}

function asFork(
  atSpan: string,
  field = "result",
  experimentId: string | null = null,
): RunSummary["fork"] {
  return { at_span: atSpan, edit_field: field, experiment_id: experimentId };
}

describe("buildRunForest", () => {
  it("三层分支链：单一根，深度依次递增", () => {
    const runs = [makeRun("A", null), makeRun("B", "A"), makeRun("C", "B")];
    const forest = buildRunForest(runs);

    expect(forest).toHaveLength(1);
    expect(forest[0]?.run.id).toBe("A");
    expect(forest[0]?.depth).toBe(0);
    expect(forest[0]?.children[0]?.run.id).toBe("B");
    expect(forest[0]?.children[0]?.children[0]?.run.id).toBe("C");
    expect(forest[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it("父 run 不在列表中：提为根并标 missing-parent，其余结构不受影响", () => {
    const runs = [makeRun("A", null), makeRun("X", "r_missing")];
    const forest = buildRunForest(runs);

    expect(forest).toHaveLength(2);
    const orphan = forest.find((node) => node.run.id === "X");
    expect(orphan?.orphanReason).toBe("missing-parent");
    expect(orphan?.children).toHaveLength(0);
  });

  it("parent 链成环：环上的 run 提为根并标 cycle，不死循环", () => {
    const runs = [makeRun("P", "Q"), makeRun("Q", "P")];
    const forest = buildRunForest(runs);

    expect(forest).toHaveLength(2);
    expect(forest.every((node) => node.orphanReason === "cycle")).toBe(true);
    // 被提为根后不再互挂为子节点，否则渲染会无限递归
    expect(forest.every((node) => node.children.length === 0)).toBe(true);
  });

  it("环外的子节点仍挂在环上节点下（只断环，不多砍）", () => {
    const runs = [makeRun("B", "C"), makeRun("C", "B"), makeRun("D", "C")];
    const forest = buildRunForest(runs);

    const c = forest.find((node) => node.run.id === "C");
    expect(c?.orphanReason).toBe("cycle");
    expect(c?.children.map((child) => child.run.id)).toEqual(["D"]);
  });

  it("空列表返回空森林，不报错", () => {
    expect(buildRunForest([])).toEqual([]);
  });

  it("兄弟顺序确定：按创建时间升序，同刻按 id 升序", () => {
    const runs = [
      makeRun("c", "A", { created_at: "2026-09-05T21:00:03.000Z" }),
      makeRun("a", "A", { created_at: "2026-09-05T21:00:01.000Z" }),
      makeRun("b", "A", { created_at: "2026-09-05T21:00:01.000Z" }),
      makeRun("A", null),
    ];
    const forest = buildRunForest(runs);
    expect(forest[0]?.children.map((child) => child.run.id)).toEqual(["a", "b", "c"]);
  });
});

describe("deriveChainTotals", () => {
  it("正常链：逐段求和（含自身）", () => {
    const runs = [
      makeRun("A", null, { steps: 3, tokensIn: 5000, tokensOut: 200 }),
      makeRun("B", "A", { steps: 2, tokensIn: 3000, tokensOut: 100 }),
    ];
    const totals = deriveChainTotals(indexRunsById(runs), "B");

    expect(totals).toMatchObject({ steps: 5, tokensIn: 8000, tokensOut: 300, tokens: 8300 });
    expect(totals?.durationMs).toBe(2000);
  });

  it("父 run 不在列表：整条累计不可得（null，不补 0）", () => {
    const runs = [makeRun("X", "r_missing")];
    expect(deriveChainTotals(indexRunsById(runs), "X")).toBeNull();
  });

  it("链成环：累计不可得", () => {
    const runs = [makeRun("P", "Q"), makeRun("Q", "P")];
    expect(deriveChainTotals(indexRunsById(runs), "P")).toBeNull();
  });

  it("任一段耗时未知 → 耗时合计为 null，其余照常", () => {
    const runs = [
      makeRun("A", null, { durationMs: null }),
      makeRun("B", "A", { durationMs: 1500 }),
    ];
    const totals = deriveChainTotals(indexRunsById(runs), "B");
    expect(totals?.durationMs).toBeNull();
    expect(totals?.steps).toBe(2);
  });

  it("单根 run：累计等于自身增量", () => {
    const runs = [makeRun("A", null, { steps: 3 })];
    expect(deriveChainTotals(indexRunsById(runs), "A")?.steps).toBe(3);
  });

  it("prompt fork 链：本 run 增量只算新 run，累计沿链代数求和（含多次独立完整运行）", () => {
    // A 正常跑 5k tokens；prompt fork B 从头独立跑 6k tokens（不共享前缀）
    const runs = [
      makeRun("A", null, { tokensIn: 4800, tokensOut: 200 }),
      makeRun("B", "A", {
        fork: asFork("s_02", "system_prompt"),
        tokensIn: 5700,
        tokensOut: 300,
      }),
    ];
    const byId = indexRunsById(runs);

    // B 的「本 run 增量」= 自身完整执行（6k），不受父 run 影响
    expect(deriveChainTotals(byId, "B")).toMatchObject({
      tokensIn: 10500, // 4800 + 5700（沿链代数求和）
      tokensOut: 500,
      tokens: 11000,
    });
    // A 的累计 = 自身
    expect(deriveChainTotals(byId, "A")?.tokens).toBe(5000);
  });
});

describe("findCommonAncestor", () => {
  it("兄弟分支：共同祖先是父 run，链完整", () => {
    const runs = [makeRun("A", null), makeRun("B1", "A"), makeRun("B2", "A")];
    expect(findCommonAncestor(indexRunsById(runs), ["B1", "B2"])).toEqual({
      id: "A",
      incomplete: false,
    });
  });

  it("其中一条是另一条的祖先：共同祖先取那条祖先", () => {
    const runs = [makeRun("A", null), makeRun("B", "A")];
    expect(findCommonAncestor(indexRunsById(runs), ["A", "B"])).toEqual({
      id: "A",
      incomplete: false,
    });
  });

  it("分属不同根且两条链都完整：无共同祖先且 incomplete 为 false", () => {
    const runs = [makeRun("A1", null), makeRun("A2", null)];
    expect(findCommonAncestor(indexRunsById(runs), ["A1", "A2"])).toEqual({
      id: null,
      incomplete: false,
    });
  });

  it("父缺失：判定不完整，即便可见范围内有公共祖先也不下结论", () => {
    const runs = [makeRun("X", "r_missing_root"), makeRun("B1", "X"), makeRun("B2", "X")];
    expect(findCommonAncestor(indexRunsById(runs), ["B1", "B2"])).toEqual({
      id: "X",
      incomplete: true,
    });
  });

  it("被对照的 run 不在列表中：判定不完整", () => {
    const runs = [makeRun("A", null)];
    expect(findCommonAncestor(indexRunsById(runs), ["A", "r_ghost"]).incomplete).toBe(true);
  });
});

describe("deriveComparison", () => {
  it("兄弟分支：给出相对共同祖先的增量差", () => {
    const runs = [
      makeRun("A", null, { tokensIn: 5000, tokensOut: 200, durationMs: 3000 }),
      makeRun("B1", "A", { tokensIn: 2000, tokensOut: 100, durationMs: 1200 }),
      makeRun("B2", "A", { tokensIn: 900, tokensOut: 100, durationMs: 900 }),
    ];
    const comparison = deriveComparison(runs, ["B1", "B2"]);

    expect(comparison.commonAncestor).toEqual({ id: "A", incomplete: false });
    expect(comparison.entries).toHaveLength(2);
    expect(comparison.entries[0]?.deltaFromAncestor?.tokens).toBe(2100);
    expect(comparison.entries[1]?.deltaFromAncestor?.tokens).toBe(1000);
    expect(comparison.entries[0]?.deltaFromAncestor?.durationMs).toBe(1200);
  });

  it("判定不完整时增量差为 null（无可比基线，不硬凑差值）", () => {
    const runs = [makeRun("X", "r_missing"), makeRun("B1", "X"), makeRun("B2", "X")];
    const comparison = deriveComparison(runs, ["B1", "B2"]);

    expect(comparison.commonAncestor.incomplete).toBe(true);
    expect(comparison.entries.every((entry) => entry.deltaFromAncestor === null)).toBe(true);
    // 累计增量本身也不可得
    expect(comparison.entries.every((entry) => entry.totals === null)).toBe(true);
  });

  it("分属不同根：不计算增量差，但各自指标照常呈现", () => {
    const runs = [makeRun("A1", null), makeRun("A2", null)];
    const comparison = deriveComparison(runs, ["A1", "A2"]);

    expect(comparison.commonAncestor.id).toBeNull();
    expect(comparison.entries).toHaveLength(2);
    expect(comparison.entries[0]?.run.id).toBe("A1");
    expect(comparison.entries.every((entry) => entry.deltaFromAncestor === null)).toBe(true);
  });

  it("耗时任一段未知 → 耗时差为 null，tokens 差照常", () => {
    const runs = [
      makeRun("A", null, { durationMs: null }),
      makeRun("B1", "A", { durationMs: 1200 }),
      makeRun("B2", "A", { durationMs: 900 }),
    ];
    const comparison = deriveComparison(runs, ["B1", "B2"]);

    expect(comparison.entries[0]?.deltaFromAncestor).toEqual({ tokens: 1100, durationMs: null });
  });
});

describe("layoutRunTree", () => {
  const treeRuns = [
    makeRun("A", null),
    makeRun("B1", "A", { fork: asFork("s_03") }),
    makeRun("B2", "A", { fork: asFork("s_03") }),
    makeRun("B3", "A", { fork: asFork("s_05", "messages") }),
    makeRun("C1", "B3", { fork: asFork("s_07") }),
  ];

  it("布局可复现：同输入两次输出逐字段一致", () => {
    const forest = buildRunForest(treeRuns);
    const first = layoutRunTree(forest);
    const second = layoutRunTree(buildRunForest(treeRuns));

    expect(first).toEqual(second);
    expect(first.edges.map((edge) => edge.path)).toEqual(second.edges.map((e) => e.path));
  });

  it("兄弟分支不重叠：所有节点包围盒两两不相交", () => {
    const { nodes } = layoutRunTree(buildRunForest(treeRuns));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap, `${a.id} 与 ${b.id} 重叠`).toBe(false);
      }
    }
  });

  it("父节点居中于首末子节点之间（tidy-tree 居中）", () => {
    const { nodes } = layoutRunTree(buildRunForest(treeRuns));
    const centerOf = (id: string): number => {
      const node = nodes.find((item) => item.id === id);
      if (node === undefined) throw new Error(`节点缺失：${id}`);
      return node.y + node.height / 2;
    };
    const b3 = centerOf("B3");
    expect(centerOf("A")).toBeCloseTo((centerOf("B1") + b3) / 2, 6);
    expect(centerOf("B3")).toBeCloseTo(centerOf("C1"), 6);
  });

  it("同层间距一致、层间 x 递增", () => {
    const { nodes } = layoutRunTree(buildRunForest(treeRuns));
    const siblings = nodes
      .filter((node) => node.depth === 1)
      .sort((a, b) => a.y - b.y)
      .map((node) => node.y);
    const gaps = siblings.slice(1).map((y, i) => y - (siblings[i] ?? 0));
    expect(new Set(gaps).size).toBe(1);

    const root = nodes.find((node) => node.id === "A");
    const child = nodes.find((node) => node.id === "B1");
    expect(child?.x).toBeGreaterThan(root?.x ?? 0);
  });

  it("边标签由 edit_field 映射，根节点的边为 null", () => {
    const { edges } = layoutRunTree(buildRunForest(treeRuns));
    const labelOf = (to: string): string | null =>
      edges.find((edge) => edge.to === to)?.label ?? null;

    expect(labelOf("B1")).toBe("改 tool_result");
    expect(labelOf("B3")).toBe("改 messages");
    expect(forkEditLabel("system_prompt")).toBe("改 system prompt");
    expect(forkEditLabel("user_message")).toBe("改 user message");
  });

  it("prompt fork 的边标注「从头重跑」，不把 at_span 呈现为普通分叉点（add-prompt-replay）", () => {
    const runs = [
      makeRun("A", null),
      makeRun("P1", "A", { fork: asFork("s_02", "system_prompt") }),
      makeRun("P2", "A", { fork: asFork("s_02", "user_message") }),
      makeRun("B1", "A", { fork: asFork("s_03", "result") }),
    ];
    const { edges } = layoutRunTree(buildRunForest(runs));
    const labelOf = (to: string): string | null =>
      edges.find((edge) => edge.to === to)?.label ?? null;

    expect(labelOf("P1")).toBe("改 system prompt · 从头重跑");
    expect(labelOf("P2")).toBe("改 user message · 从头重跑");
    // 既有 result 边标签保持不变
    expect(labelOf("B1")).toBe("改 tool_result");
  });

  it("模型 A/B 臂：边标签为「换 model/params（A/B）」，同批臂共享 experimentId（add-model-ab-experiments）", () => {
    const runs = [
      makeRun("A", null),
      makeRun("AB1", "A", { fork: asFork("s_01", "model_params", "exp_x") }),
      makeRun("AB2", "A", { fork: asFork("s_01", "model_params", "exp_x") }),
      makeRun("OTHER", "A", { fork: asFork("s_01", "model_params", "exp_y") }),
    ];
    const { edges } = layoutRunTree(buildRunForest(runs));
    const labelOf = (to: string): string | null =>
      edges.find((edge) => edge.to === to)?.label ?? null;

    expect(labelOf("AB1")).toBe("换 model/params（A/B）");
    expect(labelOf("AB2")).toBe("换 model/params（A/B）");
    expect(labelOf("OTHER")).toBe("换 model/params（A/B）");

    // 同批臂在摘要层共享同一 experiment_id，供对照面板分组；不同批互异
    const byId = indexRunsById(runs);
    expect(byId.get("AB1")?.fork?.experiment_id).toBe("exp_x");
    expect(byId.get("AB2")?.fork?.experiment_id).toBe("exp_x");
    expect(byId.get("OTHER")?.fork?.experiment_id).toBe("exp_y");
    expect(forkEditLabel("model_params")).toBe("换 model/params（A/B）");
  });

  it("单节点退化：无连线，尺寸仍为正", () => {
    const layout = layoutRunTree(buildRunForest([makeRun("A", null)]));
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("空森林：零节点零边，宽高为 0", () => {
    const layout = layoutRunTree([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(0);
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

// ---------------------------------------------------------------------------
// A2 记账：run 级缓存命中派生与 main/renderer 共用查表
// ---------------------------------------------------------------------------

/** 最小 llm.call span（只填派生关心的字段——本组测的是派生逻辑，不是 schema） */
function llmSpan(
  id: string,
  parent: string | null,
  usage: { in: number; out: number; cache_hit?: number; cache_miss?: number },
): SpanLine {
  return {
    type: "span",
    id,
    parent,
    kind: "llm.call",
    request: { model: "deepseek-chat", messages: [] },
    response: { content: null, reasoning_content: null, tool_calls: [], usage, ttft_ms: 10 },
  } as unknown as SpanLine;
}

function stepSpan(id: string, n: number): SpanLine {
  return { type: "span", id, parent: null, kind: "agent.step", n } as unknown as SpanLine;
}

describe("deriveCacheHitTotal", () => {
  it("累加本文件 llm.call 的命中（0 参与累加——0 是有值）", () => {
    const spans = [
      llmSpan("s_02", "s_01", { in: 1000, out: 40, cache_hit: 800 }),
      llmSpan("s_04", "s_03", { in: 1000, out: 40, cache_hit: 0 }),
      llmSpan("s_06", "s_05", { in: 1000, out: 40 }), // 无字段：跳过（未知不参与）
    ];
    expect(deriveCacheHitTotal(spans)).toBe(800);
  });

  it("全部无 cache_hit 字段 ⇒ null（未知 ≠ 0）", () => {
    expect(deriveCacheHitTotal([llmSpan("s_02", "s_01", { in: 1, out: 1 })])).toBeNull();
  });

  it("只有 0 命中 ⇒ 0（不是 null）", () => {
    expect(deriveCacheHitTotal([llmSpan("s_02", "s_01", { in: 5, out: 1, cache_hit: 0 })])).toBe(0);
  });

  it("非 llm.call 的 span 不参与", () => {
    expect(deriveCacheHitTotal([stepSpan("s_01", 1)])).toBeNull();
  });

  it("老 fixture（无缓存字段）派生为 null，不影响既有聚合", () => {
    const summary = deriveRunSummary(loadFixture("normal"));
    expect(summary.cacheHit).toBeNull();
    expect(summary.tokensIn).toBeGreaterThan(0);
  });

  it("deriveRunSummary.cacheHit 与 spans 同源现算", () => {
    const run = {
      meta: {
        id: "r_x",
        task: "t",
        model: "m",
        created_at: "2026-01-01T00:00:00.000Z",
        parent: null,
        fork: null,
      },
      spans: [stepSpan("s_01", 1), llmSpan("s_02", "s_01", { in: 1000, out: 40, cache_hit: 700 })],
      events: [{ type: "run.event", event: "stopped", reason: "completed", at: 1 }],
      status: "completed",
    } as unknown as Parameters<typeof deriveRunSummary>[0];
    expect(deriveRunSummary(run).cacheHit).toBe(700);
  });
});

describe("findStepLlm（main 侧 fork 编排与 renderer 提示共用的查表）", () => {
  const spans = [
    stepSpan("s_01", 1),
    llmSpan("s_02", "s_01", { in: 10, out: 2 }),
    {
      type: "span",
      id: "s_03",
      parent: "s_01",
      kind: "tool.invoke",
      tool: "read_file",
      args: {},
      result: "x",
      dur_ms: 1,
      error: null,
    } as unknown as SpanLine,
  ];

  it("命中：tool.invoke → 同 step 的 llm.call", () => {
    expect(findStepLlm(spans, "s_03")?.id).toBe("s_02");
  });

  it("span 不存在 ⇒ null", () => {
    expect(findStepLlm(spans, "s_missing")).toBeNull();
  });

  it("span 无父 ⇒ null", () => {
    const orphan = [llmSpan("s_09", null, { in: 1, out: 1 })];
    expect(findStepLlm(orphan, "s_09")).toBeNull();
  });

  it("父不是 agent.step ⇒ null", () => {
    const inner = [
      llmSpan("s_01", null, { in: 1, out: 1 }),
      llmSpan("s_02", "s_01", { in: 1, out: 1 }),
    ];
    expect(findStepLlm(inner, "s_02")).toBeNull();
  });

  it("同 step 无 llm.call ⇒ null；空数组 ⇒ null", () => {
    const toolOnly = [
      stepSpan("s_01", 1),
      {
        type: "span",
        id: "s_03",
        parent: "s_01",
        kind: "tool.invoke",
        tool: "read_file",
        args: {},
        result: "x",
        dur_ms: 1,
        error: null,
      } as unknown as SpanLine,
    ];
    expect(findStepLlm(toolOnly, "s_03")).toBeNull();
    expect(findStepLlm([], "s_01")).toBeNull();
  });
});
