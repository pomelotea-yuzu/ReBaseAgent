import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { deriveBudgetSeries } from "@shared/derive";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// BudgetMap / DetailPanel 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import。
(globalThis as Record<string, unknown>).window = { api: {} };

const {
  budgetExceeded,
  budgetSummaryLabel,
  budgetDetailLabel,
  budgetExtent,
  buildBudgetMapOption,
} = await import("../src/renderer/src/lib/budget");
const { MonacoFallback } = await import("../src/renderer/src/components/MonacoEditor");

/**
 * U1（refactor-run-workspace）任务 5.6：接回预算地图、失败解释及已有编辑器。
 *
 * 判据来源：
 * - delta 场景「预算和错误能力迁移后可达」（spec.md :126）——从步骤页打开预算地图、点击调用点
 *   或查看失败 LLM；地图按既有完整轨迹口径计算并定位真实调用；错误正文 / HTTP 状态 / 占位零值
 *   与空响应解释保持可读；编辑仍使用原有懒加载编辑器和执行门禁。
 * - 主 spec「上下文预算地图从 spans 现算并联动选择」5 场景：与聚合一致 / 选中数据点联动详情 /
 *   超限终止被标注 / 无预算信息的老文件 / 编辑态才加载编辑器。
 *
 * ⚠️ 本包无 jsdom，且 zustand v5 在 `renderToStaticMarkup` 下走 `getServerSnapshot`
 *    ⇒ 分三层：① 纯判据（`budgetExceeded` / `budgetSummaryLabel` / `budgetDetailLabel` /
 *    `buildBudgetMapOption` / `deriveBudgetSeries`）直喂；② 无状态展示件（`MonacoFallback`）
 *    静态渲染；③ **源码级接线契约**钉住"点击 → selectSpan""预算地图挂在步骤页""编辑器懒加载"
 *    （真实点击后的滚动/加载时机归 7.x CDP）。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../.rebaseagent/u1-fixtures");
const has = (name: string): boolean => existsSync(resolve(FIXTURE_DIR, `${name}.jsonl`));

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

// ---------------------------------------------------------------------------
// 造数据
// ---------------------------------------------------------------------------

/** 造一个 llm.call */
function llm(id: string, parent: string | null, inTok: number, outTok: number): SpanLine {
  return {
    type: "span",
    kind: "llm.call",
    id,
    parent,
    request: { model: "m", messages: [] },
    response: {
      content: "x",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: inTok, out: outTok },
      ttft_ms: 1,
    },
  } as SpanLine;
}

function step(id: string, n: number): SpanLine {
  return { type: "span", kind: "agent.step", id, parent: null, n } as SpanLine;
}

// ---------------------------------------------------------------------------
// 预算地图与聚合一致（纯派生）
// ---------------------------------------------------------------------------

describe("预算地图：累计趋势与聚合一致（主 spec「预算地图与聚合一致」）", () => {
  it("3 次调用每次合计 1000 ⇒ 累计 1000/2000/3000，参考线于 3000", () => {
    const spans = [
      step("s1", 1),
      llm("l1", "s1", 600, 400),
      llm("l2", "s1", 700, 300),
      llm("l3", "s1", 500, 500),
    ];
    const series = deriveBudgetSeries(spans);
    expect(series.points.map((p) => p.cumulative)).toEqual([1000, 2000, 3000]);
    expect(series.total).toBe(3000);

    const option = buildBudgetMapOption(series, 3000, false);
    expect(option.series[0]!.markLine?.data).toEqual([{ yAxis: 3000 }]);
    expect(option.series[0]!.data.map((d) => d.spanId)).toEqual(["l1", "l2", "l3"]);
    // 数据点携带 spanId 是"点击联动真实调用"的前提（点数 = 调用数，不是估算）
    expect(option.series[0]!.data).toHaveLength(3);
  });

  it("非 llm 的 span（step / tool）不进曲线（口径 = 仅 llm.call 的 in+out）", () => {
    const spans = [
      step("s1", 1),
      llm("l1", "s1", 10, 5),
      {
        type: "span",
        kind: "tool.invoke",
        id: "t1",
        parent: "s1",
        tool: "grep",
        args: {},
        result: "x",
        dur_ms: 1,
        error: null,
      } as SpanLine,
    ];
    const series = deriveBudgetSeries(spans);
    expect(series.points.map((p) => p.spanId)).toEqual(["l1"]);
    expect(series.total).toBe(15);
  });

  it("曲线数据全部现算、不读磁盘以外的来源（同一 spans 两次派生逐字节相同）", () => {
    const spans = [step("s1", 1), llm("l1", "s1", 3, 4)];
    expect(deriveBudgetSeries(spans)).toEqual(deriveBudgetSeries(spans));
  });

  it("优先用真实 fixture（若存在）：点数与派生序列一致", () => {
    if (!has("u1-ok")) return;
    const record = readRun(resolve(FIXTURE_DIR, "u1-ok.jsonl"));
    const series = deriveBudgetSeries(record.spans);
    expect(series.points).toHaveLength(series.points.length);
    expect(series.total).toBe(series.points[series.points.length - 1]?.cumulative ?? 0);
  });
});

// ---------------------------------------------------------------------------
// 选中数据点联动详情（主 spec「选中数据点联动详情」）
// ---------------------------------------------------------------------------

describe("预算地图：数据点到 spanId 的定位链完整", () => {
  it("每个数据点的 spanId 就是对应 llm.call 的 id（点第 2 个 ⇒ 第 2 次调用的 spanId）", () => {
    const spans = [step("s1", 1), llm("l1", "s1", 1, 1), llm("l2", "s1", 2, 2)];
    const series = deriveBudgetSeries(spans);
    const data = buildBudgetMapOption(series, null, false).series[0]!.data;
    expect(data[1]!.spanId).toBe("l2");
    // 该 spanId 确实存在于轨迹里（不是凭空造的 key）
    expect(spans.some((s) => s.id === data[1]!.spanId)).toBe(true);
  });

  it("源码级契约：地图点击用同一调用定位动作（selectSpan），不自造第二套选中逻辑", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/BudgetMap.tsx"),
      "utf8",
    );
    // 点击回调取 data.spanId，且调用 store 的 selectSpan（与目录/详情同一动作）
    expect(source).toContain('instance.on("click"');
    expect(source).toContain("data.data?.spanId");
    expect(source).toContain("selectSpan(spanId)");
    // 不得自己写第二个"选中"状态（那会让详情与地图分叉）
    expect(source).not.toContain("setSelectedSpanId");
  });
});

// ---------------------------------------------------------------------------
// 超限终止被标注（主 spec「超限终止被标注」）
// ---------------------------------------------------------------------------

describe("budgetExceeded：超限终止的两条合取判据", () => {
  it("completed + 最后事件 reason=budget_exceeded ⇒ true", () => {
    expect(budgetExceeded({ status: "completed", lastEventReason: "budget_exceeded" })).toBe(true);
  });

  it("running ⇒ false（还在跑，不是「终止于超限」）", () => {
    expect(budgetExceeded({ status: "running", lastEventReason: "budget_exceeded" })).toBe(false);
  });

  it("crashed ⇒ false（异常中断不冒充预算结局）", () => {
    expect(budgetExceeded({ status: "crashed", lastEventReason: "budget_exceeded" })).toBe(false);
  });

  it("completed 但最后事件 reason 非 budget_exceeded ⇒ false", () => {
    expect(budgetExceeded({ status: "completed", lastEventReason: "finished" })).toBe(false);
    expect(budgetExceeded({ status: "completed", lastEventReason: null })).toBe(false);
    expect(budgetExceeded({ status: "completed", lastEventReason: undefined })).toBe(false);
  });

  it("摘要标「已超预算终止」仅在 exceeded 时出现", () => {
    expect(budgetSummaryLabel({ maxTotal: 100, exceeded: true })).toContain("已超预算终止");
    expect(budgetSummaryLabel({ maxTotal: 100, exceeded: false })).not.toContain("已超预算终止");
  });

  it("超限终止 + 累计超参考线 ⇒ 末点标红；未超参考线 ⇒ 不标（两者都真才标）", () => {
    const over = deriveBudgetSeries([step("s", 1), llm("l1", "s", 200, 200)]);
    const optOver = buildBudgetMapOption(over, 100, true);
    expect(optOver.series[0]!.data[0]!.itemStyle).toEqual({
      color: "#dc2626",
      symbol: "circle",
      symbolSize: 8,
    });

    const under = deriveBudgetSeries([step("s", 1), llm("l1", "s", 10, 10)]);
    expect(buildBudgetMapOption(under, 100, true).series[0]!.data[0]!.itemStyle).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 无预算信息的老文件（主 spec「无预算信息的老文件」）
// ---------------------------------------------------------------------------

describe("无预算信息的老文件：照常画、不画参考线、不臆造", () => {
  it("maxTotal 为 null ⇒ 无 markLine，但数据点照旧", () => {
    const series = deriveBudgetSeries([step("s", 1), llm("l1", "s", 5, 5)]);
    const option = buildBudgetMapOption(series, null, false);
    expect(option.series[0]!.markLine).toBeUndefined();
    expect(option.series[0]!.data).toHaveLength(1);
  });

  it("摘要与说明如实说「无预算信息 / 未记录预算上限」，不提任何数值", () => {
    const series = deriveBudgetSeries([step("s", 1), llm("l1", "s", 5, 5)]);
    const summary = budgetSummaryLabel({ maxTotal: null, exceeded: false });
    expect(summary).toContain("无预算信息");
    expect(summary).not.toMatch(/预算 \d/);
    const detail = budgetDetailLabel({ series, maxTotal: null });
    expect(detail).toContain("未记录预算上限");
    expect(detail).toContain("不画参考线");
  });

  it("有预算时说明不提「未记录」，只报累计与次数", () => {
    const series = deriveBudgetSeries([step("s", 1), llm("l1", "s", 5, 5)]);
    const detail = budgetDetailLabel({ series, maxTotal: 1000 });
    expect(detail).not.toContain("未记录");
    expect(detail).toContain("累计消耗 10 token");
    expect(detail).toContain("1 次 LLM 调用");
  });

  it("空轨迹 ⇒ 明确「无曲线可绘」，不是空白的图", () => {
    expect(budgetDetailLabel({ series: { points: [], total: 0 }, maxTotal: null })).toContain(
      "无曲线可绘",
    );
    expect(budgetExtent({ points: [], total: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 失败解释可达（delta 场景「预算和错误能力迁移后可达」的错误侧）
// ---------------------------------------------------------------------------

describe("失败解释在步骤页可达（错误正文 / HTTP 状态 / 占位零值）", () => {
  const panelSource = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
    "utf8",
  );

  it("预算地图与调用详情同处步骤页正文（同一滚动容器，不藏在别的页签）", () => {
    // BudgetMap 与 LlmCallDetail/ToolInvokeDetail/StepDetailView 在同一个 return 的滚动区内
    expect(panelSource).toContain("<BudgetMap");
    expect(panelSource).toContain("<LlmCallDetail");
    expect(panelSource).toContain("<ToolInvokeDetail");
    expect(panelSource).toContain("<StepDetailView");
  });

  it("预算地图随 run 身份重建（key=run id），切 run 不残留旧曲线", () => {
    expect(panelSource).toContain("<BudgetMap key={detail.meta.id} detail={detail} />");
  });

  it("失败 LLM 的错误区渲染 HTTP 状态、错误详情与占位零值解释（静态可断言）", () => {
    // 5.5 已在 LlmCallDetailView 落这三样；此处确认它们在位（防被后续任务删掉）
    expect(panelSource).toContain("HTTP {error.status}");
    expect(panelSource).toContain("失败占位零值");
    expect(panelSource).toContain("这是记录于本次调用的失败原因");
  });
});

// ---------------------------------------------------------------------------
// 编辑态才加载编辑器（主 spec「编辑态才加载编辑器」）
// ---------------------------------------------------------------------------

describe("编辑器懒加载：纯浏览路径不加载编辑器资源", () => {
  const root = resolve(import.meta.dirname, "../src/renderer/src");
  const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

  it("main.tsx 不再静态装配 Monaco（否则 ~8MB 进主 bundle）", () => {
    const main = read("main.tsx");
    // 只允许出现在注释里说明"为何不装配"，不得是可执行的 import 语句
    expect(main).not.toMatch(/^\s*import .*monaco-bootstrap/m);
  });

  it("monaco-bootstrap 只在函数体内动态 import monaco（模块本身无静态 monaco 依赖）", () => {
    const bootstrap = read("monaco-bootstrap.ts");
    // 不得有顶层静态 import（全部落在 ensureMonaco 的函数体内）
    expect(bootstrap).not.toMatch(/^import .*monaco-editor/m);
    expect(bootstrap).toContain('await import("monaco-editor/editor/editor.api")');
    // monaco 与 react 适配器并行装配，二者都在函数体内动态 import
    expect(bootstrap).toContain('import("@monaco-editor/react")');
    // 幂等：共享同一个进行中的 Promise（重复渲染不重复装配）
    expect(bootstrap).toContain("if (pending !== null) return pending;");
  });

  it("懒边界组件用 React.lazy + 动态 import('./MonacoEditors')", () => {
    const wrapper = read("components/MonacoEditor.tsx");
    expect(wrapper).toContain("lazy(");
    expect(wrapper).toContain('import("./MonacoEditors")');
    // ⚠️ 不得用 Suspense 包住懒组件：renderToStaticMarkup 不支持挂起 ⇒ 代码里不能
    // 出现 Suspense（只在注释里说明原因）；改用"未加载先渲染占位"的显式门。
    expect(wrapper).not.toMatch(/<Suspense[\s>]/);
    expect(wrapper).toMatch(/import \{[^}]*\} from "react";/);
    const reactImports = wrapper.match(/import \{[^}]*\} from "react";/g) ?? [];
    expect(reactImports.join("\n")).not.toContain("Suspense");
    expect(wrapper).toContain("MonacoFallback");
    // 懒包装层必须把 data-* 落到 DOM（@monaco-editor/react 不透传 data-*）
    expect(wrapper).toContain("editorAttrs(");
  });

  it("懒包装层把 `onMount` 外抛（U2 4.5 先决条件：否则差异导航无法接线）", () => {
    const wrapper = read("components/MonacoEditor.tsx");
    // onMount 不是 data-*/aria-*，editorAttrs 会过滤掉它 ⇒ 必须单独转发
    expect(wrapper).toContain("behaviorProps(");
    expect(wrapper).toContain('"onMount"');
    // 两个包装组件（Editor/DiffEditor）都必须带 behaviorProps（只改一个 = 另一条路径断）
    const uses = wrapper.match(/\.\.\.behaviorProps\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("MonacoEditors.tsx 是唯一的 monaco 渲染实体，且先 ensureMonaco 再渲染", () => {
    const editors = read("components/MonacoEditors.tsx");
    expect(editors).toContain('from "@monaco-editor/react"');
    expect(editors).toContain("ensureMonaco()");
  });

  it("业务组件不再静态 import @monaco-editor/react（只经懒包装引用）", () => {
    for (const file of [
      "components/DetailPanel.tsx",
      "components/WorkspaceFileView.tsx",
      "components/MonacoEditor.tsx",
    ]) {
      const src = read(file);
      expect(src).not.toMatch(/^import .*@monaco-editor\/react/m);
    }
  });

  it("DetailPanel / WorkspaceFileView 的编辑器走懒包装组件", () => {
    expect(read("components/DetailPanel.tsx")).toContain("MonacoCodeEditor");
    expect(read("components/WorkspaceFileView.tsx")).toContain("MonacoDiffEditor");
  });

  it("MonacoFallback 渲染加载占位，且自身不含任何 monaco 依赖（静态可渲染）", () => {
    const markup = html(createElement(MonacoFallback, { height: 140 }));
    expect(markup).toContain("正在加载编辑器");
    expect(markup).not.toContain("monaco");
  });
});
