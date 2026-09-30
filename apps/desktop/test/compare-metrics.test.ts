import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { describe, expect, it } from "vitest";
import { deriveCompareMetricsTable } from "../src/renderer/src/lib/compare-metrics";
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

function readyItem(
  runId: string,
  chain: RunSummary[],
): Extract<CompareRunItem, { status: "ready" }> {
  const detail: RunDetail = {
    meta: meta(runId, chain.length > 1 ? (chain[chain.length - 2]?.id ?? null) : null, null),
    spans: [{ type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 }] as SpanLine[],
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    // 链 hop 的 fork 形状与本测试无关（lib 只读 chainSummaries），统一 null
    chain: chain.map((entry) => ({ meta: meta(entry.id, entry.parent, null), fork: null })),
    leafSpanIds: ["s_01"],
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
    expect(model.scopeNote).not.toContain("总耗时");
    expect(model.scopeNote).not.toContain("总成本");
  });
});
