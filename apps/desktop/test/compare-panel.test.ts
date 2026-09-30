import type { RunSummary } from "@shared/ipc";
import { computeShortIds } from "@shared/nav";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// ComparePanel 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import（同 branch-tree.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { ComparePanelView, CommonAncestorRow, DeltaRow } = await import(
  "../src/renderer/src/components/ComparePanel"
);

/**
 * U1（refactor-run-workspace）任务 6.3：既有四条指标对照与实验限制的回归。
 *
 * 判据来源（两份 spec 交叉）：
 *   - branch-tree 主 spec「多分支对照到 run 级指标与共同祖先」：上限 4 条（超出拒绝 + 提示）、
 *     并排展示「状态与终止原因」、步数、工具数与出错数、tokens、耗时、分叉点、创建时间；
 *     给出共同祖先与**各自**相对它的增量差；共同祖先三态不得混说；判定不完整时不算增量差。
 *   - model-experiments 主 spec「比较沿用共同祖先和现有派生口径」：
 *     **只展示各臂相对父 run 的累计增量**，SHALL NOT 产出**臂间差值**、胜出臂或最佳模型结论；
 *     沿链数字沿用既有措辞纪律，**禁用「总耗时 / 总成本」**。
 *   - desktop-ui delta 场景「既有四条指标对照仍可使用」：**不新增**臂间差值、胜出结论或
 *     未实现的输出比较入口。
 *
 * ⚠️ 本组件 6.3 之前**没有组件级测试**（只有纯派生 `deriveComparison` 被覆盖），
 *    本包无 jsdom ⇒ 断言打在纯展示层 `ComparePanelView` 上（直接喂 runs / compareIds）。
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
    toolCalls: 3,
    toolErrors: 1,
    tokensIn: 100,
    tokensOut: 20,
    cacheHit: null,
    durationMs: 1000,
    created_at: "2026-09-21T00:00:00.000Z",
    ...over,
  } as RunSummary;
}

const fork = (at: string, field = "result") => ({
  at_span: at,
  edit_field: field,
  experiment_id: null,
});

function render(
  runs: RunSummary[],
  compareIds: string[],
  over: Partial<{ compareNotice: string | null; maxCompare: number }> = {},
): string {
  return renderToStaticMarkup(
    createElement(ComparePanelView, {
      runs,
      compareIds,
      compareNotice: over.compareNotice ?? null,
      // U7 5.1：身份列吃会话短 ID（测试里按同一算法现算）
      shortIds: computeShortIds(runs.map((run) => run.id)),
      onToggleCompare: noop,
      onClear: noop,
      maxCompare: over.maxCompare ?? 4,
    }),
  );
}

/** 一棵两兄弟的分支家庭：根 A，子分支 B1 / B2 */
function family(): RunSummary[] {
  return [
    run({ id: "A", steps: 3, tokensIn: 500, tokensOut: 40, durationMs: 5000 }),
    run({
      id: "B1",
      parent: "A",
      fork: fork("s_7"),
      steps: 2,
      tokensIn: 100,
      tokensOut: 20,
      durationMs: 1000,
    }),
    run({
      id: "B2",
      parent: "A",
      fork: fork("s_9"),
      steps: 4,
      tokensIn: 200,
      tokensOut: 30,
      durationMs: 2000,
    }),
  ];
}

// ---------------------------------------------------------------------------
// 场景：既有四条指标对照仍可使用
// ---------------------------------------------------------------------------

describe("场景：既有四条指标对照仍可使用", () => {
  it("四条指标（状态/工具/tokens/耗时）并排在场，且带分叉点与创建时间", () => {
    const markup = render(family(), ["B1", "B2"]);
    expect(markup).toContain("状态");
    expect(markup).toContain("工具 / 出错");
    expect(markup).toContain("本 run tokens");
    expect(markup).toContain("本 run 耗时");
    expect(markup).toContain("分叉点");
    expect(markup).toContain("创建时间");
  });

  it("本 run / 沿链累计 / 相对祖先增量三口径**并列且各自带口径名**（不混为一谈）", () => {
    const markup = render(family(), ["B1", "B2"]);
    expect(markup).toContain("本 run 步数");
    expect(markup).toContain("本 run tokens");
    expect(markup).toContain("累计增量（步数）");
    expect(markup).toContain("累计增量（tokens）");
    expect(markup).toContain("累计增量（耗时）");
    expect(markup).toContain("相对共同祖先的增量差");
  });

  it("共同祖先显示为父 run，并给出各自相对它的增量（B1/B2 两条都在）", () => {
    const markup = render(family(), ["B1", "B2"]);
    expect(markup).toContain("共同祖先");
    // 祖先 id 出现在共同祖先区块里
    expect(markup).toContain("A");
    // 每条臂各有一行增量
    expect(markup.match(/\+/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("上限提示在场（已选 N / M），且 maxCompare 由入参决定而非写死", () => {
    expect(render(family(), ["B1", "B2"])).toContain("已选 2 / 4");
    expect(render(family(), ["B1", "B2"], { maxCompare: 3 })).toContain("已选 2 / 3");
  });

  it("超出上限的提示如实展示（由 store 拒绝加入时写下 notice）", () => {
    const markup = render(family(), ["A", "B1", "B2"], {
      compareNotice: "最多同时对照 4 条运行",
    });
    expect(markup).toContain("最多同时对照 4 条运行");
  });

  it("未选 / 只选一条时给出可操作说明，不渲染空表", () => {
    expect(render(family(), [])).toContain("勾选分支树上的节点即可加入对照");
    expect(render(family(), ["B1"])).toContain("再选一条即可对照");
  });
});

// ---------------------------------------------------------------------------
// 状态口径：与列表 / 概览 / 树同源（6.3 修）
// ---------------------------------------------------------------------------

describe("状态列与终止原因列：同源判据 + 原值可查看", () => {
  it("completed ⇒ 「已结束」（不是「已完成」），与列表/概览/树一致", () => {
    const markup = render([run({ id: "r1" }), run({ id: "r2" })], ["r1", "r2"]);
    expect(markup).toContain("已结束");
    expect(markup).not.toContain("已完成");
  });

  it("五种 reason 的结局文字与统一判据一致（error 红 / 限制琥珀 / 中断中性）", () => {
    const cases: Array<[string, string, string]> = [
      ["error", "出错终止", "text-red-700"],
      ["max_iterations", "达到迭代上限", "text-amber-700"],
      ["budget_exceeded", "超出预算", "text-amber-700"],
      ["aborted", "已中止", "text-gray-600"],
      ["completed", "已结束", "text-emerald-700"],
    ];
    for (const [reason, label, toneClass] of cases) {
      const markup = render(
        [run({ id: "x", reason }), run({ id: "y", reason: "completed" })],
        ["x", "y"],
      );
      expect(markup, reason).toContain(label);
      expect(markup, reason).toContain(toneClass);
    }
  });

  it("crashed ⇒ 「运行中断」+ 中性色，不当作执行中", () => {
    const markup = render(
      [run({ id: "c", status: "crashed", reason: null }), run({ id: "d" })],
      ["c", "d"],
    );
    expect(markup).toContain("运行中断");
    expect(markup).toContain("text-gray-600");
    expect(markup).not.toContain("执行中");
  });

  it("未知 reason ⇒ 状态列说未知、终止原因列仍给出**原值**（不丢、不猜）", () => {
    const markup = render(
      [run({ id: "u", reason: "some_new_reason" }), run({ id: "v" })],
      ["u", "v"],
    );
    expect(markup).toContain("结束原因未知");
    expect(markup).toContain("some_new_reason");
  });

  it("工具错误不当作终止失败（toolErrors>0 仍「已结束」）", () => {
    const markup = render(
      [run({ id: "t", reason: "completed", toolErrors: 3 }), run({ id: "s" })],
      ["t", "s"],
    );
    expect(markup).toContain("已结束");
    expect(markup).not.toContain("出错终止");
  });
});

// ---------------------------------------------------------------------------
// 不可比限制：三态 + 不硬凑差值
// ---------------------------------------------------------------------------

describe("不可比限制：三态不混说、判定不完整时不给差值", () => {
  it("两条链完整但无公共祖先 ⇒ 「无（分属不同根）」+ 说明没有可比基线", () => {
    const markup = render([run({ id: "R1" }), run({ id: "R2" })], ["R1", "R2"]);
    expect(markup).toContain("无（分属不同根）");
    expect(markup).toContain("没有可比基线");
  });

  it("父缺失 ⇒ 「判定不完整」，并明确**不是**「本来就不同源」", () => {
    // B 的 parent 不在列表里 ⇒ 判定不完整
    const markup = render(
      [
        run({ id: "B", parent: "ghost", fork: fork("s_1") }),
        run({ id: "C", parent: "ghost", fork: fork("s_2") }),
      ],
      ["B", "C"],
    );
    expect(markup).toContain("判定不完整");
    expect(markup).toContain("不是");
    // 不得把不完整说成"分属不同根"
    expect(markup).not.toContain("无（分属不同根）");
  });

  it("判定不完整 ⇒ 增量差**明说不可得**，不给数字、不补 0", () => {
    const markup = render(
      [
        run({ id: "B", parent: "ghost", fork: fork("s_1") }),
        run({ id: "C", parent: "ghost", fork: fork("s_2") }),
      ],
      ["B", "C"],
    );
    expect(markup).toContain("相对共同祖先的增量差");
    expect(markup).toContain("不可得");
    // 差值行不出现「+0」（补零冒充"差为零"）
    expect(markup).not.toContain("+0");
  });

  it("无共同祖先 ⇒ 增量差同样明说不可得（不硬凑）", () => {
    const markup = render([run({ id: "R1" }), run({ id: "R2" })], ["R1", "R2"]);
    expect(markup).toContain("不可得");
  });
});

// ---------------------------------------------------------------------------
// 负向：不产出臂间差值 / 胜出结论 / 未实现入口
// ---------------------------------------------------------------------------

describe("负向义务：不产出臂间差值、胜出结论或未实现的输出比较入口", () => {
  const markup = (): string => render(family(), ["B1", "B2"]);

  it("不出现胜出 / 最佳 / 推荐 / 结论类措辞", () => {
    const html = markup();
    for (const banned of ["胜出", "最佳", "最优", "推荐", "结论", "更好", "winner"]) {
      expect(html, banned).not.toContain(banned);
    }
  });

  it("不出现跨臂聚合差值（原先有一行 `tokens 差 <max-min>`，主 spec 明令不得产出臂间差值）", () => {
    const html = markup();
    // 逐条臂的「相对共同祖先的增量差」保留（spec 授权），但**跨臂 max−min 不得出现**：
    // 它会与 spec 里同名的「各自相对祖先的 tokens 差」撞名，且属"臂间差值"。
    expect(html).toContain("相对共同祖先的增量差");
    expect(html).not.toMatch(/tokens\s*差\s*\d/);
  });

  it("沿链数字不禁忌措辞：不出现「总耗时 / 总成本」", () => {
    const html = markup();
    expect(html).not.toContain("总耗时");
    expect(html).not.toContain("总成本");
  });

  it("没有未实现的输出比较入口（如并排 diff / 输出对比按钮）", () => {
    const html = markup();
    for (const banned of ["对比输出", "输出对照", "并排输出"]) {
      expect(html, banned).not.toContain(banned);
    }
  });

  it("不引入基线臂概念（无「以…为基准」这类需要用户挑基线的措辞）", () => {
    expect(markup()).not.toContain("为基准");
  });
});

// ---------------------------------------------------------------------------
// U7 5.1：对照身份 = 会话稳定短 ID + 完整 ID 可复制
// ---------------------------------------------------------------------------

describe("5.1 对照身份列", () => {
  it("run id 行显示传入的会话短 ID，复制按钮可访问名称携带完整 ID", () => {
    const longRuns = [run({ id: "aaaaaaaa-first-0001" }), run({ id: "aaaaaaaa-second-0002" })];
    const markup = render(longRuns, ["aaaaaaaa-first-0001", "aaaaaaaa-second-0002"]);
    // 短 ID（末 8 位，算法不碰撞）在场；碰撞/延长语义由 nav.ts 的用例承载
    expect(markup).toContain("rst-0001");
    expect(markup).toContain("nd-0002");
    expect(markup).toContain('aria-label="复制完整 ID aaaaaaaa-first-0001"');
    expect(markup).toContain('aria-label="复制完整 ID aaaaaaaa-second-0002"');
  });
});

// ---------------------------------------------------------------------------
// 纯展示子组件：三态与不可得（直接喂数据）
// ---------------------------------------------------------------------------

describe("CommonAncestorRow / DeltaRow 直接渲染", () => {
  it("CommonAncestorRow 有祖先 ⇒ 显示 id，不带「判定不完整」字样", () => {
    const html = renderToStaticMarkup(
      createElement(CommonAncestorRow, { id: "A", incomplete: false }),
    );
    expect(html).toContain("A");
    expect(html).not.toContain("判定不完整");
  });

  it("DeltaRow 不足两条臂 ⇒ 整块不渲染（单条无可比之「差」）", () => {
    const html = renderToStaticMarkup(createElement(DeltaRow, { entries: [] }));
    expect(html).toBe("");
  });
});
