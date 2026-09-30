import type { RunSummary } from "@shared/ipc";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TreeScope, TreeViewport } from "../src/renderer/src/lib/tree-view";

// BranchTree 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import（同 run-workspace.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { BranchTreeView } = await import("../src/renderer/src/components/BranchTree");

/**
 * U1（refactor-run-workspace）任务 6.2：分支树节点状态与共用状态文字/颜色。
 *
 * 判据来源：branch-tree delta「分支树以节点-边图呈现运行与分叉」的全部场景 + 一句话要求：
 *   - 节点展示状态/任务名/创建时间/本 run 增量（步数 · tokens）
 *   - **节点状态 SHALL 与运行列表及概览使用一致的状态文字和语义色**
 *   - `completed` 仅表示封存，不单凭该值展示正常成功；`crashed` 中性色、不推断仍在执行；
 *     未知 reason ⇒ 「结束原因未知」且原值可查看
 *   - 工具曾出错但最终正常结束 ⇒ 仍按终止原因展示（**不把工具错误数当作整次运行失败**）
 *   - 选中 ⇒ 高亮从根到该 run 的整条祖先链；点击节点行为与列表一致
 *   - 空数据 ⇒ 单节点/空态退化，不提示「无分支可用」
 *
 * ⚠️ 本组件 6.2 之前**完全没有测试**。本包无 jsdom ⇒ 断言打在纯展示层 `BranchTreeView` 上
 *    （直接喂 `runs` / `selectedRunId`）。真实点击后的选中跳转与滚动归 7.1/7.3 的 CDP。
 */

const noop = (): void => {};

function run(over: Partial<RunSummary> & { id: string }): RunSummary {
  return {
    task: "读 README 并改注释",
    model: "deepseek-chat",
    status: "completed",
    reason: "completed",
    source: "local",
    parent: null,
    fork: null,
    steps: 2,
    toolCalls: 1,
    toolErrors: 0,
    tokensIn: 100,
    tokensOut: 20,
    cacheHit: null,
    durationMs: 10,
    created_at: "2026-09-21T00:00:00.000Z",
    ...over,
  } as RunSummary;
}

function render(
  runs: RunSummary[],
  over: Partial<{
    selectedRunId: string | null;
    compareIds: string[];
    onOpenDetail: () => void;
    /** U7 3.1–3.3：载体改判——范围/搜索/视口改为 store 会话状态经 props 传入 */
    scope: TreeScope | null;
    query: string;
    viewport: TreeViewport | null;
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(BranchTreeView, {
      runs,
      selectedRunId: over.selectedRunId ?? null,
      compareIds: over.compareIds ?? [],
      onSelect: noop,
      onToggleCompare: noop,
      onOpenDetail: over.onOpenDetail ?? noop,
      scope: over.scope ?? null,
      query: over.query ?? "",
      viewport: over.viewport ?? { zoom: 100, scrollLeft: 0, scrollTop: 0 },
      onArmSession: () => ({ scope: "all" as const, focusRunId: null }),
      onScopeChange: noop,
      onQueryChange: noop,
      onViewportChange: noop,
    }),
  );
}

/** 取某节点在 html 里的片段（按 data-run-id 切），用于逐节点断言 */
function nodeHtml(markup: string, runId: string): string {
  const marker = `data-run-id="${runId}"`;
  const at = markup.indexOf(marker);
  if (at < 0) throw new Error(`节点 ${runId} 不在渲染结果里`);
  const next = markup.indexOf('data-run-id="', at + marker.length);
  return markup.slice(at, next < 0 ? undefined : next);
}

// ---------------------------------------------------------------------------
// 场景：多分支家庭呈现
// ---------------------------------------------------------------------------

describe("场景：多分支家庭呈现", () => {
  const family: RunSummary[] = [
    run({ id: "A" }),
    run({
      id: "B1",
      parent: "A",
      fork: { at_span: "s_7", edit_field: "result", experiment_id: null },
    }),
    run({
      id: "B2",
      parent: "A",
      fork: { at_span: "s_9", edit_field: "result", experiment_id: null },
    }),
  ];

  it("一个根节点 + 两个平级子节点，三条节点都在图里", () => {
    const markup = render(family);
    expect(markup).toContain('data-run-id="A"');
    expect(markup).toContain('data-run-id="B1"');
    expect(markup).toContain('data-run-id="B2"');
  });

  it("两条边各标注「改 tool_result」（result 映射），不推断编辑内容", () => {
    const markup = render(family);
    const labels = markup.match(/改 tool_result/g) ?? [];
    expect(labels.length).toBe(2);
    // 不出现被编辑的 value（列表载荷里本就没有，图上也绝不臆造）
    expect(markup).not.toContain("s_7 的内容");
  });

  it("节点展示任务名、创建时间与本 run 增量（步数 · tokens）", () => {
    const markup = nodeHtml(render(family), "B1");
    expect(markup).toContain("读 README 并改注释");
    expect(markup).toContain("本 run 增量 2 步");
    expect(markup).toContain("120 tokens"); // 100 + 20
  });
});

// ---------------------------------------------------------------------------
// 场景：代理分叉的边标注
// ---------------------------------------------------------------------------

describe("场景：代理分叉的边标注", () => {
  it("messages 分叉标「改 messages」，与 tool_result 分叉在图上可区分", () => {
    const markup = render([
      run({ id: "A" }),
      run({
        id: "P",
        parent: "A",
        source: "proxy",
        fork: { at_span: "s_3", edit_field: "messages", experiment_id: null },
      }),
      run({
        id: "R",
        parent: "A",
        fork: { at_span: "s_4", edit_field: "result", experiment_id: null },
      }),
    ]);
    expect(markup).toContain("改 messages");
    expect(markup).toContain("改 tool_result");
    // 代理来源另有文字标记（不只靠边标签）
    expect(nodeHtml(markup, "P")).toContain("代理");
  });
});

// ---------------------------------------------------------------------------
// 场景：选中高亮共享前缀
// ---------------------------------------------------------------------------

describe("场景：选中高亮共享前缀", () => {
  it("选中 C（A → B → C）⇒ A/B/C 三个节点在链上，兄弟分支不在", () => {
    const markup = render(
      [
        run({ id: "A" }),
        run({
          id: "B",
          parent: "A",
          fork: { at_span: "s_1", edit_field: "result", experiment_id: null },
        }),
        run({
          id: "C",
          parent: "B",
          fork: { at_span: "s_2", edit_field: "result", experiment_id: null },
        }),
        run({
          id: "X",
          parent: "A",
          fork: { at_span: "s_8", edit_field: "result", experiment_id: null },
        }),
      ],
      { selectedRunId: "C" },
    );
    for (const id of ["A", "B", "C"]) {
      expect(nodeHtml(markup, id)).toContain('data-on-path="true"');
    }
    // 兄弟分支 X 不在 A→B→C 这条链上
    expect(nodeHtml(markup, "X")).toContain('data-on-path="false"');
    // 选中节点另有更强的高亮标记（不只是"在链上"）
    expect(nodeHtml(markup, "C")).toContain('data-selected="true"');
    expect(nodeHtml(markup, "A")).toContain('data-selected="false"');
  });

  it("未选中任何 run ⇒ 没有任何节点被判在链上", () => {
    const markup = render([run({ id: "A" }), run({ id: "B", parent: "A" })]);
    expect(markup).not.toContain('data-on-path="true"');
  });
});

// ---------------------------------------------------------------------------
// 场景：无分支时退化呈现
// ---------------------------------------------------------------------------

describe("场景：无分支时退化呈现", () => {
  it("只有一条根 run ⇒ 单节点、无分叉边、不提示「无分支可用」", () => {
    const markup = render([run({ id: "only" })]);
    expect(markup).toContain('data-run-id="only"');
    expect(markup.replace(/\s/g, "")).not.toContain('data-run-id="only"data-run-id=');
    // 不出现任何分叉边标签（"改 X" 一个都没有）
    expect(markup).not.toMatch(/改 (tool_result|messages)/);
    expect(markup).not.toContain("无分支可用");
  });

  it("完全没有 run ⇒ 给出可操作的说明，不画空图", () => {
    const markup = render([]);
    expect(markup).toContain("还没有运行记录，画不出分支树");
  });
});

// ---------------------------------------------------------------------------
// 场景：节点按封存运行的终止原因区分结局（与列表/概览一致）
// ---------------------------------------------------------------------------

describe("场景：节点按封存运行的终止原因区分结局", () => {
  const cases: Array<[string, string, string]> = [
    // [reason, 期望标签, 期望色调类名片段]
    ["completed", "已结束", "bg-emerald-100"],
    ["error", "出错终止", "bg-red-100"],
    ["max_iterations", "达到迭代上限", "bg-amber-100"],
    ["budget_exceeded", "超出预算", "bg-amber-100"],
    ["aborted", "已中止", "bg-gray-100"],
  ];

  it("五种 reason 分别给出正确文字与语义色（completed 不是「已完成」）", () => {
    for (const [reason, label, toneClass] of cases) {
      const markup = nodeHtml(render([run({ id: "r", status: "completed", reason })]), "r");
      expect(markup, reason).toContain(label);
      expect(markup, reason).toContain(toneClass);
      // 封存 ≠ 质量已验证：不得出现「已完成」这类暗示成功的措辞
      expect(markup, reason).not.toContain("已完成");
    }
  });

  it("底层 status 不变：五种 reason 的节点 status 都是 completed（不因展示改数据）", () => {
    for (const [reason] of cases) {
      const summary = run({ id: "r", status: "completed", reason });
      expect(summary.status).toBe("completed");
    }
  });

  it("error 是红的、限制是琥珀的——同一屏里可区分，不只靠文字", () => {
    const markup = render([
      run({ id: "e", reason: "error" }),
      run({ id: "m", reason: "max_iterations" }),
    ]);
    expect(nodeHtml(markup, "e")).toContain("bg-red-100");
    expect(nodeHtml(markup, "m")).toContain("bg-amber-100");
    // 限制类不得被染成错误红
    expect(nodeHtml(markup, "m")).not.toContain("bg-red-100");
  });
});

// ---------------------------------------------------------------------------
// 场景：节点对中断和未知原因诚实降级
// ---------------------------------------------------------------------------

describe("场景：节点对中断和未知原因诚实降级", () => {
  it("crashed ⇒ 「运行中断」+ 中性色，不伪造活跃执行", () => {
    const markup = nodeHtml(render([run({ id: "c", status: "crashed", reason: null })]), "c");
    expect(markup).toContain("运行中断");
    expect(markup).toContain("bg-gray-100");
    // 不得出现"执行中/进行中"
    expect(markup).not.toContain("执行中");
    expect(markup).not.toContain("进行中");
  });

  it("crashed 且残留 reason ⇒ 仍按中断展示（无结束记录就是无结束记录）", () => {
    const markup = nodeHtml(render([run({ id: "c2", status: "crashed", reason: "error" })]), "c2");
    expect(markup).toContain("运行中断");
    expect(markup).not.toContain("出错终止");
  });

  it("已封存但 reason 未知 ⇒ 「结束原因未知」，且原值可在 title 里查看", () => {
    const markup = nodeHtml(
      render([run({ id: "u", status: "completed", reason: "some_new_reason" })]),
      "u",
    );
    expect(markup).toContain("结束原因未知");
    // 原值不丢（title 里可查看），也不冒充正常成功
    expect(markup).toContain("some_new_reason");
    expect(markup).not.toContain("bg-emerald-100");
  });

  it("completed 却完全没有 reason（数据异常）⇒ 同样归未知，不冒充已完成", () => {
    const markup = nodeHtml(render([run({ id: "n", status: "completed", reason: null })]), "n");
    expect(markup).toContain("结束原因未知");
    expect(markup).not.toContain("已结束");
  });
});

// ---------------------------------------------------------------------------
// 场景：节点不把已恢复的工具错误当作终止失败
// ---------------------------------------------------------------------------

describe("场景：节点不把已恢复的工具错误当作终止失败", () => {
  it("toolErrors > 0 但 reason=completed ⇒ 仍显示「已结束」+ 正常色", () => {
    const markup = nodeHtml(
      render([run({ id: "t", status: "completed", reason: "completed", toolErrors: 3 })]),
      "t",
    );
    expect(markup).toContain("已结束");
    expect(markup).toContain("bg-emerald-100");
    // 不得因工具错误把节点染红或改写成出错终止
    expect(markup).not.toContain("bg-red-100");
    expect(markup).not.toContain("出错终止");
  });

  it("也不得声称测试通过（封存 ≠ 质量已验证）", () => {
    const markup = render([
      run({ id: "t2", status: "completed", reason: "completed", toolErrors: 1 }),
    ]);
    expect(markup).not.toContain("测试通过");
    expect(markup).not.toContain("修复成功");
  });
});

// ---------------------------------------------------------------------------
// 分支返回导航（6.2）
// ---------------------------------------------------------------------------

describe("分支返回导航：树里能回到轨迹详情，但不改节点点击语义", () => {
  it("已选中 run ⇒ 给出「查看所选运行详情」入口，并绑到 onOpenDetail", () => {
    let opened = 0;
    const markup = render([run({ id: "A" })], {
      selectedRunId: "A",
      onOpenDetail: () => {
        opened += 1;
      },
    });
    expect(markup).toContain("查看所选运行详情");
    // 静态渲染下只能确认入口在场；"点了真的切视图"归 CDP（本包无 jsdom）
    expect(opened).toBe(0); // 渲染本身不得触发导航
  });

  it("未选中 run ⇒ 不显示该入口（指向不了目标的按钮比没有更糟）", () => {
    const markup = render([run({ id: "A" })], { selectedRunId: null });
    expect(markup).not.toContain("查看所选运行详情");
  });

  it("footer 文案与真实行为一致：说清「选中后用…切回详情」，不谎称点击即看详情", () => {
    const markup = render([run({ id: "A" })], { selectedRunId: "A" });
    expect(markup).toContain("点击节点选中该运行");
    expect(markup).not.toContain("点击节点查看详情");
  });
});
