import type { BudgetSeries } from "@shared/derive";

/**
 * 预算地图的 ECharts option 装配（纯函数，零 react / echarts 运行时依赖，可单测）。
 * - 曲线：累计 token（in+out）沿 llm.call 次序
 * - 参考线：markLine 于预算上限（无预算则省略）
 * - 超限终止且累计已超预算时，末点标红放大
 * - 每个数据点携带 spanId，供点击联动
 */
export type ChartableData = Array<{
  value: number;
  spanId: string;
  itemStyle?: { color: string; symbol: string; symbolSize: number };
}>;

export interface BudgetMapOption {
  grid: { left: number; right: number; top: number; bottom: number };
  tooltip: { trigger: string };
  dataZoom: Array<{ type: string; height?: number }>;
  xAxis: { type: string; data: string[]; name: string };
  yAxis: { type: string; name: string };
  series: Array<{
    type: string;
    data: ChartableData;
    markLine?: {
      silent: boolean;
      symbol: string;
      label: { formatter: string; color: string; position: string };
      lineStyle: { color: string; type: string };
      data: Array<{ yAxis: number }>;
    };
  }>;
}

export function buildBudgetMapOption(
  series: BudgetSeries,
  maxTotal: number | null,
  exceeded: boolean,
): BudgetMapOption {
  const xs = series.points.map((p) => `#${p.index}`);
  const overdue = exceeded && maxTotal !== null && series.total > maxTotal;
  const data: ChartableData = series.points.map((p, i) => ({
    value: p.cumulative,
    spanId: p.spanId,
    ...(overdue && i === series.points.length - 1
      ? { itemStyle: { color: "#dc2626", symbol: "circle", symbolSize: 8 } }
      : {}),
  }));

  return {
    grid: { left: 48, right: 16, top: 24, bottom: 44 },
    tooltip: { trigger: "axis" },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 14 }],
    xAxis: { type: "category", data: xs, name: "LLM 调用次序" },
    yAxis: { type: "value", name: "累计 token" },
    series: [
      {
        type: "line",
        data,
        markLine:
          maxTotal === null
            ? undefined
            : {
                silent: true,
                symbol: "none",
                label: { formatter: `预算 ${maxTotal}`, color: "#dc2626", position: "end" },
                lineStyle: { color: "#dc2626", type: "dashed" },
                data: [{ yAxis: maxTotal }],
              },
      },
    ],
  };
}

/** 预算地图的起止点（供 summary 文案） */
export function budgetExtent(series: BudgetSeries): { min: number; max: number } | null {
  const first = series.points[0];
  if (first === undefined) return null;
  return { min: first.cumulative, max: series.total };
}

// ---------------------------------------------------------------------------
// 预算地图的显示判据（U1 任务 5.6：把组件里的判定抽出来，使其可断言）
// ---------------------------------------------------------------------------

/** run 是否会以 `budget_exceeded` 终止的最低事实（只要这几个字段，便于纯测） */
export interface BudgetTerminationFacts {
  status: string;
  /** 最后一个 run 事件（`events` 空则为 undefined） */
  lastEventReason: string | null | undefined;
}

/**
 * 该 run 是否**以超预算终止**（spec 场景「超限终止被标注」）。
 *
 * 判据是**两个条件的合取**，缺一不可：
 *   1. `status === "completed"`——只有正常走完并**主动**因预算停下才算"终止于超限"；
 *      running（还在跑）或 crashed（异常中断）即使累计已超也不是这个结局。
 *   2. 最后一个 run 事件的 reason 是 `budget_exceeded`——这是终止原因的记录源，不靠猜。
 *
 * ⚠️ 这是"**是否因超限终止**"，不是"累计是否超了参考线"——后者是纯数值比较，在
 *    `buildBudgetMapOption` 的 `overdue` 里另判（两者都真才标红，见该函数的注释）。
 */
export function budgetExceeded(facts: BudgetTerminationFacts): boolean {
  return facts.status === "completed" && facts.lastEventReason === "budget_exceeded";
}

/** 折叠摘要行：一眼看清"有没有预算 / 是否超限终止"，不臆造数值 */
export function budgetSummaryLabel(input: {
  maxTotal: number | null;
  exceeded: boolean;
}): string {
  const budget = input.maxTotal === null ? "无预算信息" : `预算 ${input.maxTotal}`;
  return `上下文预算地图 · ${budget}${input.exceeded ? " · 已超预算终止" : ""}`;
}

/** 展开后的说明行：区分"无调用可绘"与"有调用但无预算"（后者不画参考线而非臆造） */
export function budgetDetailLabel(input: {
  series: BudgetSeries;
  maxTotal: number | null;
}): string {
  const extent = budgetExtent(input.series);
  if (extent === null) return "该 run 不含任何 LLM 调用，无曲线可绘。";
  const base = `累计消耗 ${extent.max} token（in+out），共 ${input.series.points.length} 次 LLM 调用。`;
  return input.maxTotal === null ? `${base}该 run 未记录预算上限，故不画参考线。` : base;
}
