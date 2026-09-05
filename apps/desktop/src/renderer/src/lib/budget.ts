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
