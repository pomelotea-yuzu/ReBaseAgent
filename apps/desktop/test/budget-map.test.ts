import type { BudgetSeries } from "@shared/derive";
import { describe, expect, it } from "vitest";
import { buildBudgetMapOption, budgetExtent } from "../src/renderer/src/lib/budget";

/** 用派生的合成数据喂 option 装配纯函数（不触发任何 echarts/react 运行时） */
function series(pairs: Array<[inTok: number, outTok?: number]>): BudgetSeries {
  const points = pairs.reduce<BudgetSeries["points"]>((acc, [inTok, outTok = 0], i) => {
    const cumulative = (acc[i - 1]?.cumulative ?? 0) + inTok + outTok;
    acc.push({ index: i + 1, spanId: `l_${i + 1}`, tokensIn: inTok, tokensOut: outTok, cumulative });
    return acc;
  }, []);
  return { points, total: points[points.length - 1]?.cumulative ?? 0 };
}

describe("buildBudgetMapOption", () => {
  it("无预算时省略 markLine（老 run 诚实不画参考线）", () => {
    const option = buildBudgetMapOption(series([[100, 50], [200, 50]]), null, false);
    expect(option.series[0]!.markLine).toBeUndefined();
    expect(option.xAxis.data).toEqual(["#1", "#2"]);
  });

  it("有预算时 markLine 落于上限，且数据点带 spanId 供联动", () => {
    const option = buildBudgetMapOption(series([[100, 50], [200, 50]]), 500, false);
    const mark = option.series[0]!.markLine;
    expect(mark).toBeDefined();
    expect(mark!.data).toEqual([{ yAxis: 500 }]);
    expect(option.series[0]!.data.map((d) => d.spanId)).toEqual(["l_1", "l_2"]);
    expect(option.series[0]!.data.map((d) => d.value)).toEqual([150, 400]);
  });

  it("超限终止且累计超过预算：末点标记红色高亮", () => {
    const option = buildBudgetMapOption(series([[100, 40], [300, 100]]), 300, true);
    const data = option.series[0]!.data;
    expect(data[1]!.itemStyle).toEqual({ color: "#dc2626", symbol: "circle", symbolSize: 8 });
    expect(data[0]!.itemStyle).toBeUndefined();
  });

  it("超限终止但累计未超预算：不加红色高亮", () => {
    const option = buildBudgetMapOption(series([[100, 40], [100, 40]]), 300, true);
    expect(option.series[0]!.data[1]!.itemStyle).toBeUndefined();
  });
});

describe("budgetExtent", () => {
  it("空序列返回 null", () => {
    expect(budgetExtent({ points: [], total: 0 })).toBeNull();
  });

  it("返回首点与末累计", () => {
    expect(budgetExtent(series([[10, 0], [20, 5]]))).toEqual({ min: 10, max: 35 });
  });
});