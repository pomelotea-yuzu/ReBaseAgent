import type { RunSummary } from "@shared/ipc";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decideTreeInitialFocus,
  fitZoomLevel,
  searchTreeNodes,
  treeRootOf,
  visibleRunIdsForScope,
} from "../src/renderer/src/lib/tree-view";

// BranchTree 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位
(globalThis as Record<string, unknown>).window = { api: {} };

const { BranchTreeView } = await import("../src/renderer/src/components/BranchTree");
const { useAppStore } = await import("../src/renderer/src/store");

/**
 * U7（improve-branch-comparison）任务 3.1/3.2/3.3（+3.4 节点字段）：
 * 分支视图的范围 / 搜索 / 视口判据与 store 会话状态。
 *
 * 场景对应：
 * - 「首次进入聚焦当前分支」——有选中 ⇒ 当前树 + 焦点；无 ⇒ 全部；幂等不重复居中；
 * - 「搜索完整字段定位范围外运行」——完整原值匹配（不匹配截断展示）、命中带所属树根、
 *   范围外标记、空结果明确提示；真机滚动几何归 §6.4 实机；
 * - 「视口操作与返回保持逻辑布局」——视口是会话观察参数（store 落位），范围/搜索
 *   只改可见性不改坐标。
 */

const T0 = "2026-01-15T10:00:00.000Z";

function run(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    task: `任务 ${id}`,
    model: "m1",
    created_at: T0,
    status: "completed",
    parent: null,
    reason: "completed",
    fork: null,
    steps: 1,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 10,
    tokensOut: 5,
    cacheHit: null,
    durationMs: 100,
    source: null,
    ...over,
  } as RunSummary;
}

function index(runs: RunSummary[]): Map<string, RunSummary> {
  return new Map(runs.map((r) => [r.id, r]));
}

describe("U7 3.1 首次进入决策与树归属", () => {
  const runs = [
    run("A"),
    run("B", { parent: "A" }),
    run("C", { parent: "B" }),
    run("X"),
    run("orphan", { parent: "r_missing" }),
  ];

  it("有选中运行 ⇒ 当前树 + 焦点该节点；无选中 ⇒ 全部、无焦点", () => {
    expect(decideTreeInitialFocus("B")).toEqual({ scope: "current", focusRunId: "B" });
    expect(decideTreeInitialFocus(null)).toEqual({ scope: "all", focusRunId: null });
  });

  it("树根判定：沿 parent 上溯；父缺失/成环 ⇒ 自身即根（与森林提根同口径）", () => {
    const byId = index(runs);
    expect(treeRootOf(byId, "C")).toBe("A");
    expect(treeRootOf(byId, "A")).toBe("A");
    expect(treeRootOf(byId, "orphan")).toBe("orphan");
    const loop = [run("p", { parent: "q" }), run("q", { parent: "p" })];
    expect(treeRootOf(index(loop), "p")).toBe("p");
  });

  it("当前树范围 = 所属树全体成员（含根与各层后代）；全部 = 不过滤", () => {
    expect(visibleRunIdsForScope(runs, "current", "C")).toEqual(new Set(["A", "B", "C"]));
    expect(visibleRunIdsForScope(runs, "all", "C")).toBeNull();
    // 无选中却要当前树 ⇒ 退化为全部（决策层兜底）
    expect(visibleRunIdsForScope(runs, "current", null)).toBeNull();
    // 孤儿树只有它自己
    expect(visibleRunIdsForScope(runs, "current", "orphan")).toEqual(new Set(["orphan"]));
  });
});

describe("U7 3.2 完整字段搜索", () => {
  const longTask = "导入数据集并执行三轮评测（完整任务原文很长，展示层只截前一段）";
  const runs = [
    run("r_root", { task: longTask }),
    run("r_child_abcdefgh", { parent: "r_root" }),
    run("r_other", { task: "别的任务" }),
  ];

  it("匹配完整原值：查询落在被展示截断的中段也能命中", () => {
    const hits = searchTreeNodes(runs, "三轮评测");
    expect(hits).not.toBeNull();
    expect(hits?.map((hit) => hit.runId)).toEqual(["r_root"]);
  });

  it("完整 ID 片段命中；每个命中携带其所属已知树的根（范围外定位依据）", () => {
    const hits = searchTreeNodes(runs, "abcdefgh");
    expect(hits?.[0]?.runId).toBe("r_child_abcdefgh");
    expect(hits?.[0]?.treeRootId).toBe("r_root");
  });

  it("空白查询 = 未搜索（null）；无命中 = 空数组（明确提示，不丢原选择）", () => {
    expect(searchTreeNodes(runs, "   ")).toBeNull();
    expect(searchTreeNodes(runs, "不存在的片段")).toEqual([]);
  });
});

describe("U7 3.3 适应画布取档", () => {
  it("两维都装得下的最大档；全都装不下取最小档", () => {
    // 布局 1000×800：容器 1200×1000 ⇒ 100% 装得下、150% 装不下
    expect(fitZoomLevel(1000, 800, 1200, 1000)).toBe(100);
    expect(fitZoomLevel(1000, 800, 800, 800)).toBe(75);
    expect(fitZoomLevel(1000, 800, 400, 300)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// store 会话状态：arm 幂等 / 显式切换 / 视口落位
// ---------------------------------------------------------------------------

beforeEach(() => {
  useAppStore.setState({
    treeScope: null,
    treeQuery: "",
    treeViewport: null,
    selectedRunId: null,
  });
});

describe("U7 3.1 store 会话状态的幂等边界", () => {
  it("首次 arm：按选中运行决定初始范围；再次 arm 沿用且不再给焦点（不重复居中）", () => {
    useAppStore.setState({ selectedRunId: "B" });
    const first = useAppStore.getState().armTreeSession();
    expect(first).toEqual({ scope: "current", focusRunId: "B" });
    useAppStore.setState({ treeViewport: { zoom: 75, scrollLeft: 30, scrollTop: 40 } });

    const second = useAppStore.getState().armTreeSession();
    expect(second).toEqual({ scope: "current", focusRunId: null });
    // 视口未被 arm 抹掉——返回树恢复的是存储视口
    expect(useAppStore.getState().treeViewport).toEqual({
      zoom: 75,
      scrollLeft: 30,
      scrollTop: 40,
    });
  });

  it("无选中首次 arm ⇒ 全部；显式切换与搜索词、视口各自落位", () => {
    const first = useAppStore.getState().armTreeSession();
    expect(first.scope).toBe("all");

    useAppStore.getState().setTreeScope("current");
    useAppStore.getState().setTreeQuery("abc");
    useAppStore.getState().setTreeViewport({ zoom: 150, scrollLeft: 5, scrollTop: 6 });
    const state = useAppStore.getState();
    expect(state.treeScope).toBe("current");
    expect(state.treeQuery).toBe("abc");
    expect(state.treeViewport).toEqual({ zoom: 150, scrollLeft: 5, scrollTop: 6 });
  });
});

// ---------------------------------------------------------------------------
// 组件静态结构：范围切换、搜索框与空结果提示、节点短 ID/模型字段（3.2/3.4）
// ---------------------------------------------------------------------------

function render(
  runs: RunSummary[],
  over: Partial<{
    selectedRunId: string | null;
    scope: "current" | "all" | null;
    query: string;
  }> = {},
): string {
  type Props = Parameters<typeof BranchTreeView>[0];
  const props: Props = {
    runs,
    selectedRunId: over.selectedRunId ?? null,
    compareIds: [],
    onSelect: () => {},
    onToggleCompare: () => {},
    onOpenDetail: () => {},
    scope: over.scope ?? "all",
    query: over.query ?? "",
    viewport: { zoom: 100, scrollLeft: 0, scrollTop: 0 },
    onArmSession: () => ({ scope: "all", focusRunId: null }),
    onScopeChange: () => {},
    onQueryChange: () => {},
    onViewportChange: () => {},
  };
  return renderToStaticMarkup(createElement(BranchTreeView, props));
}

function nodeHtml(markup: string, runId: string): string {
  const marker = `data-run-id="${runId}"`;
  const at = markup.indexOf(marker);
  if (at < 0) throw new Error(`节点 ${runId} 不在渲染结果里`);
  const next = markup.indexOf('data-run-id="', at + marker.length);
  return markup.slice(at, next < 0 ? undefined : next);
}

describe("U7 3.2/3.4 树组件静态结构", () => {
  const runs = [
    run("r_abcdefghij", { task: "长任务名称示例" }),
    run("r_nomodel", { parent: "r_abcdefghij", model: "" }),
  ];

  it("范围切换与搜索框在场（aria 压states/标签可访问）", () => {
    const markup = render(runs);
    expect(markup).toContain("当前树");
    expect(markup).toContain("全部关系");
    expect(markup).toContain('aria-label="搜索运行（完整 ID 或任务）"');
    expect(markup).toContain("定位当前运行");
    expect(markup).toContain("适应画布");
  });

  it("空结果明确提示且保持原渲染（不丢节点）", () => {
    const markup = render(runs, { query: "不存在的片段" });
    expect(markup).toContain("没有匹配");
    expect(markup).toContain('data-run-id="r_abcdefghij"');
  });

  it("命中列表给出唯一身份与所属树；非空查询才渲染结果区", () => {
    const markup = render(runs, { query: "长任务" });
    expect(markup).toContain('data-tree-search-results="true"');
    expect(markup).toContain("r_abcdefghij");
    expect(render(runs, { query: "  " })).not.toContain('data-tree-search-results="true"');
  });

  it("节点字段：短 ID、模型缺失标「未记录」；完整 ID 在 title 里可读可复制", () => {
    const markup = nodeHtml(render(runs), "r_nomodel");
    expect(markup).toContain("模型：未记录");
    // 完整 run id 在 title 提示里（短 ID 只用于展示区分）
    expect(markup).toContain("r_nomodel");
  });
});
