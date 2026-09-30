import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import { deriveCompareMetricsTable } from "../src/renderer/src/lib/compare-metrics";
import { formatDuration, formatTokens } from "../src/renderer/src/lib/format";
import type { CompareRunItem, RunDetail, RunSummary } from "../src/shared/ipc";
import { computeShortIds } from "../src/shared/nav";

/**
 * U7（improve-branch-comparison）任务 5.2：宽幅指标表**纯派生**的判据锁定。
 *
 * 判据来源（branch-tree delta MODIFIED「多分支对照到 run 级指标与共同祖先」+
 * 「对照身份与四列指标保持可辨」）：
 * - 共同祖先与累计结论来自**当前已校验比较读取**（chainSummaries），不回退列表缓存；
 * - 共同祖先三态不混说；判定不完整不算增量差；单条不判定祖先；
 * - 不可读列如实呈现受控原因；提示按实际对象数量表述；
 * - 对照不产出运行之间的互差、胜出或最佳结论（scopeNote 恒定在场）。
 */

const T0 = "2026-09-30T10:00:00.000Z";

function summary(over: Partial<RunSummary> & { id: string }): RunSummary {
  return {
    task: `任务 ${over.id}`,
    model: "deepseek-chat",
    status: "completed",
    reason: "completed",
    source: "local",
    parent: null,
    fork: null,
    steps: 2,
    toolCalls: 3,
    toolErrors: 1,
    tokensIn: 100,
    tokensOut: 20,
    cacheHit: null,
    durationMs: 1000,
    created_at: T0,
    ...over,
  } as RunSummary;
}

function meta(id: string, parent: string | null, fork: Fork | null): RunDetail["meta"] {
  return {
    type: "run.meta",
    id,
    format_version: 1,
    task: `任务 ${id}`,
    model: "controlled-model",
    created_at: T0,
    parent,
    fork,
  };
}

function llmOwnSpan(
  id: string,
  usage: { in: number; out: number },
  opts: { timing?: { started_at: string; ended_at: string } } = {},
): SpanLine {
  return {
    type: "span",
    id,
    parent: "s_01",
    kind: "llm.call",
    request: { model: "controlled-model", messages: [] },
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: usage.in, out: usage.out, cache_hit: 0 },
      ttft_ms: 0,
    },
    ...(opts.timing !== undefined ? { timing: opts.timing } : {}),
  } as SpanLine;
}

function readyItem(
  runId: string,
  chain: RunSummary[],
  opts: {
    /** 默认一个 agent.step（自有）；自定义时须连 leafSpanIds 一起给 */
    spans?: SpanLine[];
    leafSpanIds?: string[];
  } = {},
): Extract<CompareRunItem, { status: "ready" }> {
  const spans = (opts.spans ?? [
    { type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 },
  ]) as SpanLine[];
  const detail: RunDetail = {
    meta: meta(runId, chain.length > 1 ? (chain[chain.length - 2]?.id ?? null) : null, null),
    spans,
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    // 链 hop 的 fork 形状与本测试无关（lib 只读 chainSummaries），统一 null
    chain: chain.map((entry) => ({ meta: meta(entry.id, entry.parent, null), fork: null })),
    leafSpanIds: opts.leafSpanIds ?? ["s_01"],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
  return { status: "ready", runId, detail, chainSummaries: chain };
}

function unavailableItem(runId: string): Extract<CompareRunItem, { status: "unavailable" }> {
  return {
    status: "unavailable",
    runId,
    code: "RUN_UNREADABLE",
    reason: "运行记录读取失败",
  };
}

const shorts = computeShortIds(["r_a", "r_b", "r_ghost"]);

// ---------------------------------------------------------------------------
// 形态与引导
// ---------------------------------------------------------------------------

describe("deriveCompareMetricsTable：形态与数量提示", () => {
  it("无结论 ⇒ empty + 空集引导", () => {
    const model = deriveCompareMetricsTable({ items: null, shortIds: shorts });
    expect(model.kind).toBe("empty");
    expect(model.hint).toContain("在分支树勾选节点");
  });

  it("单条 ⇒ 表 + 「再选一条即可对照」，不判定共同祖先", () => {
    const model = deriveCompareMetricsTable({
      items: [readyItem("r_a", [summary({ id: "r_a" })])],
      shortIds: shorts,
    });
    expect(model.kind).toBe("table");
    expect(model.columns).toHaveLength(1);
    expect(model.hint).toContain("再选一条即可对照");
    expect(model.relation).toBeNull();
  });

  it("三条 ⇒ 提示显式选两条；四条同口径（列数与集合一致）", () => {
    const items = [
      readyItem("r_a", [summary({ id: "r_a" })]),
      readyItem("r_b", [summary({ id: "r_b" })]),
      readyItem("r_c", [summary({ id: "r_c" })]),
    ];
    const shorts3 = computeShortIds(["r_a", "r_b", "r_c"]);
    const model = deriveCompareMetricsTable({ items, shortIds: shorts3 });
    expect(model.columns).toHaveLength(3);
    expect(model.hint).toContain("显式选择两条");
  });
});

// ---------------------------------------------------------------------------
// 共同祖先三态（结论来自已校验 chainSummaries）
// ---------------------------------------------------------------------------

describe("deriveCompareMetricsTable：共同祖先三态", () => {
  it("两条兄弟 ⇒ 共同祖先 = 父", () => {
    const items = [
      readyItem("r_b1", [summary({ id: "r_a" }), summary({ id: "r_b1", parent: "r_a" })]),
      readyItem("r_b2", [summary({ id: "r_a" }), summary({ id: "r_b2", parent: "r_a" })]),
    ];
    const model = deriveCompareMetricsTable({ items, shortIds: shorts });
    expect(model.relation).not.toBeNull();
    expect(model.relation?.ancestorId).toBe("r_a");
    expect(model.relation?.incomplete).toBe(false);
    expect(model.relation?.note).toContain("共同祖先：r_a");
  });

  it("链完整但无公共祖先 ⇒ 无（分属不同根），不冒充共同祖先", () => {
    const items = [
      readyItem("r_x", [summary({ id: "r_x" })]),
      readyItem("r_y", [summary({ id: "r_y" })]),
    ];
    const model = deriveCompareMetricsTable({ items, shortIds: computeShortIds(["r_x", "r_y"]) });
    expect(model.relation?.ancestorId).toBeNull();
    expect(model.relation?.note).toContain("无（分属不同根）");
  });

  it("父缺失 ⇒ 判定不完整（说明不是本来就不同源），不呈现为不同根", () => {
    const items = [
      readyItem("r_c1", [summary({ id: "r_c1", parent: "r_ghost" })]),
      readyItem("r_c2", [summary({ id: "r_c2", parent: "r_ghost" })]),
    ];
    const model = deriveCompareMetricsTable({ items, shortIds: shorts });
    expect(model.relation?.incomplete).toBe(true);
    expect(model.relation?.note).toContain("判定不完整");
    expect(model.relation?.note).toContain("不是「本来就不同源」");
    expect(model.relation?.note).not.toContain("分属不同根");
  });
});

// ---------------------------------------------------------------------------
// 列标题与行
// ---------------------------------------------------------------------------

describe("deriveCompareMetricsTable：列标题与指标行", () => {
  const familyShorts = computeShortIds(["r_a", "r_b1", "r_b2"]);

  function familyItems() {
    return [
      readyItem("r_b1", [
        summary({ id: "r_a", steps: 3, toolCalls: 2, toolErrors: 0 }),
        summary({
          id: "r_b1",
          parent: "r_a",
          reason: "error",
          steps: 5,
          toolCalls: 4,
          toolErrors: 2,
          fork: { at_span: "s_7", edit_field: "result", experiment_id: "exp_1" },
        }),
      ]),
      readyItem("r_b2", [
        summary({ id: "r_a" }),
        summary({
          id: "r_b2",
          parent: "r_a",
          status: "crashed",
          reason: null,
          fork: { at_span: "s_9", edit_field: "result", experiment_id: null },
        }),
      ]),
    ];
  }

  it("标题事实来自已校验链摘要的自身项（任务/模型/状态），短 ID 从映射取", () => {
    const model = deriveCompareMetricsTable({ items: familyItems(), shortIds: familyShorts });
    const b1 = model.columns.find((column) => column.runId === "r_b1");
    const b2 = model.columns.find((column) => column.runId === "r_b2");
    expect(b1?.task).toContain("任务 r_b1");
    expect(b1?.model).toBe("deepseek-chat");
    expect(b1?.statusLabel).toBe("出错终止");
    // crashed ⇒ 运行中断（与列表/概览/树同一判据 classifyOutcome），不当作执行中
    expect(b2?.statusLabel).toBe("运行中断");
    expect(b1?.shortId).toBe(familyShorts.get("r_b1"));
  });

  it("状态/终止原因/创建时间/分叉点/实验组/步数/工具出错 各行与列对齐", () => {
    const model = deriveCompareMetricsTable({ items: familyItems(), shortIds: familyShorts });
    const rowOf = (label: string) => model.rows.find((row) => row.label === label);
    expect(rowOf("终止原因")?.values).toEqual(["error", "—"]);
    expect(rowOf("创建时间")?.values).toEqual([T0, T0]);
    expect(rowOf("分叉点")?.values).toEqual(["s_7", "s_9"]);
    expect(rowOf("实验组")?.values).toEqual(["exp_1", null]);
    expect(rowOf("本 run 步数")?.values).toEqual(["5", "2"]);
    expect(rowOf("工具 / 出错")?.values).toEqual(["4 / 2", "3 / 1"]);
    // 状态行值来自 classifyOutcome
    expect(rowOf("状态")?.values).toEqual(["出错终止", "运行中断"]);
  });

  it("不可读列：标题只给身份与受控原因，行值显示 —（不借列表补齐、不补 0）", () => {
    const model = deriveCompareMetricsTable({
      items: [readyItem("r_a", [summary({ id: "r_a" })]), unavailableItem("r_ghost")],
      shortIds: shorts,
    });
    const ghost = model.columns.find((column) => column.runId === "r_ghost");
    expect(ghost?.task).toBeNull();
    expect(ghost?.statusLabel).toBeNull();
    expect(ghost?.unavailableReason).toContain("RUN_UNREADABLE");
    for (const row of model.rows) {
      expect(row.values[1]).toBeNull();
    }
  });

  it("scopeNote 恒定在场：只呈现事实与相对祖先增量，无互差/胜出/最佳结论", () => {
    const model = deriveCompareMetricsTable({
      items: familyItems(),
      shortIds: familyShorts,
    });
    expect(model.scopeNote).toContain("本次已校验比较读取");
    expect(model.scopeNote).toContain("不产出运行之间的互差、胜出或最佳结论");
    // 行标签不出现「总耗时 / 总成本」这类被禁口径名（scopeNote 里的引用性提及除外）
    const labels = model.rows.map((row) => row.label);
    expect(labels).not.toContain("总耗时");
    expect(labels).not.toContain("总成本");
  });
});

// ---------------------------------------------------------------------------
// U7 5.4：自有 / 沿链 / 相对祖先增量三口径（「自有指标不重复计算继承前缀」）
// ---------------------------------------------------------------------------

describe("5.4 指标派生口径", () => {
  const shorts2 = computeShortIds(["r_a", "r_b"]);

  /** 父 r_a（祖先，自有 500/40，耗时 5000）→ 子 r_b（自有 100/20，耗时未记录） */
  function lineage() {
    const ancestor = readyItem(
      "r_a",
      [summary({ id: "r_a", tokensIn: 500, tokensOut: 40, durationMs: 5000, steps: 3 })],
      {
        spans: [
          { type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 },
          llmOwnSpan("c_a", { in: 500, out: 40 }, {
            timing: { started_at: "2026-09-30T09:00:00Z", ended_at: "2026-09-30T09:00:05Z" },
          }),
        ],
        leafSpanIds: ["s_01", "c_a"],
      },
    );
    const child = readyItem("r_b", [
      summary({ id: "r_a", tokensIn: 500, tokensOut: 40, durationMs: 5000, steps: 3 }),
      summary({
        id: "r_b",
        parent: "r_a",
        tokensIn: 100,
        tokensOut: 20,
        durationMs: null,
        steps: 5,
      }),
    ], {
      spans: [
        { type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 },
        // 继承前缀的祖先调用（在合并轨迹里，但不属于本 run 自有）
        llmOwnSpan("c_prefix", { in: 500, out: 40 }, {
          timing: { started_at: "2026-09-30T10:00:00Z", ended_at: "2026-09-30T10:00:05Z" },
        }),
        // 本 run 自有调用：无 timing ⇒ 时间未知
        llmOwnSpan("c_own", { in: 100, out: 20 }),
      ],
      leafSpanIds: ["s_01", "c_own"],
    });
    return [ancestor, child];
  }

  it("自有 tokens 只统计 leaf spans：继承前缀的调用不重复计入", () => {
    const model = deriveCompareMetricsTable({ items: lineage(), shortIds: shorts2 });
    const rowOf = (label: string) => model.rows.find((row) => row.label === label);
    // 子的自有合计 = 100 + 20 = 120（不是 120 + 前缀 540）
    expect(rowOf("自有 tokens（合计）")?.values[1]).toBe(formatTokens(120));
    // 祖先自身自有合计 = 540
    expect(rowOf("自有 tokens（合计）")?.values[0]).toBe(formatTokens(540));
  });

  it("沿链累计 = 各代自有值沿链求和（含 prompt/messages/model_params 独立执行段）", () => {
    const model = deriveCompareMetricsTable({ items: lineage(), shortIds: shorts2 });
    const rowOf = (label: string) => model.rows.find((row) => row.label === label);
    // 子链累计 = 500+40（父代）+ 100+20（子代）= 660
    expect(rowOf("累计增量（tokens）")?.values[1]).toBe(formatTokens(660));
    expect(rowOf("累计增量（步数）")?.values[1]).toBe("8");
    // 口径说明在场：独立执行段照各代自有值计入、禁称总耗时/总成本
    const tokensRow = rowOf("累计增量（tokens）");
    expect(tokensRow?.titles?.[1]).toContain("沿 parent 链");
    expect(model.scopeNote).toContain("独立执行");
  });

  it("相对祖先增量 = 该侧累计 − 祖先累计（同口径相减，不是左右臂相减）", () => {
    const model = deriveCompareMetricsTable({ items: lineage(), shortIds: shorts2 });
    const rowOf = (label: string) => model.rows.find((row) => row.label === label);
    // 子：660 − 540 = 120；祖先：540 − 540 = 0
    expect(rowOf("相对祖先增量（tokens）")?.values[1]).toBe(formatTokens(120));
    expect(rowOf("相对祖先增量（tokens）")?.values[0]).toBe(formatTokens(0));
    expect(rowOf("相对祖先增量（tokens）")?.titles?.[1]).toContain("不是左右两侧互差");
  });

  it("未知耗时保持未知：自有无 timing ⇒ 自有耗时 null；链上任一段未知 ⇒ 累计与祖先耗时增量 null", () => {
    const model = deriveCompareMetricsTable({ items: lineage(), shortIds: shorts2 });
    const rowOf = (label: string) => model.rows.find((row) => row.label === label);
    // 子自有 spans 无 timing ⇒ 自有耗时未知（不补 0）
    expect(rowOf("自有已记录耗时")?.values[1]).toBeNull();
    expect(rowOf("自有已记录耗时")?.titles?.[1]).toContain("保持未知");
    // 子代 durationMs = null ⇒ 沿链累计耗时整体未知；祖先增量耗时同样未知
    expect(rowOf("累计增量（耗时）")?.values[1]).toBeNull();
    expect(rowOf("相对祖先增量（耗时）")?.values[1]).toBeNull();
    // 祖先自有耗时正常可读
    expect(rowOf("自有已记录耗时")?.values[0]).toBe(formatDuration(5000));
  });

  it("祖先增量不可得时逐列说明（判定不完整 / 无共同祖先 / 单条），不补 0", () => {
    // 判定不完整
    const incomplete = deriveCompareMetricsTable({
      items: [
        readyItem("r_c1", [summary({ id: "r_c1", parent: "r_ghost" })]),
        readyItem("r_c2", [summary({ id: "r_c2", parent: "r_ghost" })]),
      ],
      shortIds: shorts,
    });
    const row = incomplete.rows.find((r) => r.label === "相对祖先增量（tokens）");
    expect(row?.values.every((value) => value === null)).toBe(true);
    expect(row?.titles?.[0]).toContain("判定不完整");

    // 单条：不判定祖先，不计算增量
    const single = deriveCompareMetricsTable({
      items: [readyItem("r_a", [summary({ id: "r_a" })])],
      shortIds: shorts,
    });
    const singleRow = single.rows.find((r) => r.label === "相对祖先增量（tokens）");
    expect(singleRow?.values[0]).toBeNull();
    expect(singleRow?.titles?.[0]).toContain("不足两条");
  });
});
