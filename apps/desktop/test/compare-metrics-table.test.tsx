import type { Fork, SpanLine } from "@rebaseagent/trace-sdk/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { deriveCompareMetricsTable } from "../src/renderer/src/lib/compare-metrics";
import type { CompareRunItem, RunDetail, RunSummary } from "../src/shared/ipc";
import { computeShortIds } from "../src/shared/nav";

// CompareSelectionBar 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import（同 branch-tree.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { CompareMetricsTable } = await import("../src/renderer/src/components/CompareMetricsTable");
const { CompareSelectionBarView } = await import(
  "../src/renderer/src/components/CompareSelectionBar"
);

/**
 * U7（improve-branch-comparison）任务 5.2：宽幅指标表与选择栏的**静态断言**。
 *
 * 本包无 jsdom：组件只吃 props，判据由 `lib/compare-metrics.ts` 派生。
 * 钉住（branch-tree delta「四条指标名称始终可见」/ desktop-ui delta
 * 「界面提供分支树与轨迹两种视图」）：
 * - 名称列 sticky 在场；运行列横滚容器（overflow-auto）只包表格；
 * - 请求级拒绝 ⇒ 受控码 + 重试入口；读取中 ⇒ 加载说明，不伪结论；
 * - 选择栏：已选 chips + 移出/清空/进入按钮、上限提示、零态引导。
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

function readyItem(
  runId: string,
  chain: RunSummary[],
): Extract<CompareRunItem, { status: "ready" }> {
  const meta: RunDetail["meta"] = {
    type: "run.meta",
    id: runId,
    format_version: 1,
    task: `任务 ${runId}`,
    model: "controlled-model",
    created_at: T0,
    parent: chain.length > 1 ? (chain[chain.length - 2]?.id ?? null) : null,
    fork: { at_span: "s_1", edit: { field: "result", value: "编辑值" } } as Fork,
  };
  const detail: RunDetail = {
    meta,
    spans: [{ type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 }] as SpanLine[],
    events: [{ type: "run.event", event: "stopped", reason: "completed" }],
    status: "completed",
    // 链 hop 的 fork 形状与本测试无关（lib 只读 chainSummaries），统一 null
    chain: chain.map((entry) => ({ meta: { ...meta, id: entry.id }, fork: null })),
    leafSpanIds: ["s_01"],
    completeness: "complete",
    spanScope: "own",
    lineage: { status: "complete" },
  };
  return { status: "ready", runId, detail, chainSummaries: chain };
}

function tableFor(
  ids: string[],
  extra?: { loading?: boolean; rejected?: { code: string; reason: string } | null },
) {
  const shorts = computeShortIds(ids);
  const items = ids.map((id) => readyItem(id, [summary({ id })]));
  const model = deriveCompareMetricsTable({ items, shortIds: shorts });
  return renderToStaticMarkup(
    <CompareMetricsTable
      model={model}
      loading={extra?.loading ?? false}
      rejected={extra?.rejected ?? null}
      onRetry={vi.fn()}
    />,
  );
}

describe("CompareMetricsTable：宽幅表结构", () => {
  it("名称列 sticky（th sticky left-0）；横滚容器只包表格；运行列有最小宽度", () => {
    const html = tableFor(["r_a", "r_b", "r_c", "r_d"]);
    expect(html).toContain("sticky left-0");
    expect(html).toContain('aria-label="指标对照"');
    expect(html).toContain("min-w-[220px]");
    expect(html).toContain("指标对照（4 条）");
  });

  it("运行标题：任务摘要、短 ID、复制完整 ID、模型、状态齐备", () => {
    const html = tableFor(["r_a"], {});
    expect(html).toContain("任务 r_a");
    expect(html).toContain('aria-label="复制完整 ID r_a"');
    expect(html).toContain("deepseek-chat");
    expect(html).toContain("已结束");
  });

  it("读取中显示加载说明；不渲染已撤销的结论（loading 不伪数据由容器保证）", () => {
    const html = tableFor(["r_a"], { loading: true });
    expect(html).toContain("正在读取比较对象…");
  });

  it("请求级拒绝 ⇒ 稳定码 + 受控原因 + 重试按钮（可访问名称明确）", () => {
    const shorts = computeShortIds(["r_a"]);
    const model = deriveCompareMetricsTable({ items: null, shortIds: shorts });
    const html = renderToStaticMarkup(
      <CompareMetricsTable
        model={model}
        loading={false}
        rejected={{ code: "RUN_NOT_FOUND", reason: "运行不存在" }}
        onRetry={vi.fn()}
      />,
    );
    expect(html).toContain("RUN_NOT_FOUND");
    expect(html).toContain("运行不存在");
    expect(html).toContain('aria-label="重试比较读取"');
  });

  it("单条提示与三态关系说明在场（关系 note 随模型传入）", () => {
    const html = tableFor(["r_a"], {});
    expect(html).toContain("再选一条即可对照");
  });

  it("空集 ⇒ 引导文案（不渲染空表）", () => {
    const shorts = computeShortIds([]);
    const model = deriveCompareMetricsTable({ items: null, shortIds: shorts });
    const html = renderToStaticMarkup(
      <CompareMetricsTable model={model} loading={false} rejected={null} onRetry={vi.fn()} />,
    );
    expect(html).toContain("在分支树勾选节点");
  });
});

describe("5.3 指标表显式选两条（挑选条与列头动作）", () => {
  const shorts = computeShortIds(["r_a", "r_b", "r_c"]);

  function model3() {
    const items = ["r_a", "r_b", "r_c"].map((id) => readyItem(id, [summary({ id })]));
    return deriveCompareMetricsTable({ items, shortIds: shorts });
  }

  function renderWithPick(pick: { left: string | null; right: string | null }) {
    return renderToStaticMarkup(
      <CompareMetricsTable
        model={model3()}
        loading={false}
        rejected={null}
        onRetry={vi.fn()}
        pick={pick}
        pickError={null}
        onPickSide={vi.fn()}
        onOpenPair={vi.fn()}
        onClearPick={vi.fn()}
      />,
    );
  }

  it("列头提供「设为左列/右列」动作（aria-pressed 标注当前挑选）", () => {
    const html = renderWithPick({ left: "r_a", right: null });
    expect(html).toContain('aria-label="设为左列 r_a"');
    expect(html).toContain('aria-label="设为右列 r_c"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("挑选条：两侧齐备才可打开详细比较（否则 disabled），未选侧显示（未选）", () => {
    const pending = renderWithPick({ left: "r_a", right: null });
    expect(pending).toContain("左 r_a · 右 （未选）");
    expect(pending).toContain('aria-label="打开所选两条的详细比较"');
    expect(pending).toContain('disabled=""');

    const ready = renderWithPick({ left: "r_a", right: "r_c" });
    expect(ready).not.toContain('disabled=""');
    expect(ready).toContain('aria-label="清除挑选"');
  });
});

describe("CompareSelectionBarView：选择栏", () => {
  const runs = [summary({ id: "r_a" }), summary({ id: "r_b" })];
  const shorts = computeShortIds(["r_a", "r_b"]);
  const noop = (): void => {};

  function bar(over: { compareIds?: string[]; compareNotice?: string | null } = {}): string {
    return renderToStaticMarkup(
      <CompareSelectionBarView
        runs={runs}
        compareIds={over.compareIds ?? ["r_a", "r_b"]}
        compareNotice={over.compareNotice ?? null}
        shortIds={shorts}
        maxCompare={4}
        onToggleCompare={noop}
        onClear={noop}
        onEnter={noop}
      />,
    );
  }

  it("两条 ⇒ chips（短 ID + 复制完整 ID + 任务摘要）+ 移出按钮 + 「进入详细比较」", () => {
    const html = bar();
    expect(html).toContain("已选 2 / 4");
    expect(html).toContain('aria-label="复制完整 ID r_a"');
    expect(html).toContain('aria-label="移出对照 r_b"');
    expect(html).toContain("进入详细比较");
    expect(html).toContain("任务 r_a");
  });

  it("三条进入按钮文案变为「进入指标对照」（显式选两条的入口在工作区内）", () => {
    const html = bar({ compareIds: ["r_a", "r_b", "r_c"] });
    expect(html).toContain("进入指标对照");
  });

  it("上限提示如实呈现（store 写下的 compareNotice）", () => {
    const html = bar({ compareNotice: "最多同时对照 4 条运行" });
    expect(html).toContain("最多同时对照 4 条运行");
  });

  it("零条 ⇒ 引导文案，不渲染 chips 与进入按钮", () => {
    const html = bar({ compareIds: [] });
    expect(html).toContain("勾选分支树节点即可加入对照");
    expect(html).not.toContain("进入详细比较");
    expect(html).not.toContain("进入指标对照");
  });
});
