import type { BudgetSeries } from "@shared/derive";
import { deriveBudgetSeries } from "@shared/derive";
import type { RunDetail } from "@shared/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  budgetDetailLabel,
  budgetExceeded,
  budgetSummaryLabel,
  buildBudgetMapOption,
} from "../lib/budget";
import { useAppStore } from "../store";

const CHART_HEIGHT = 160;

/** ECharts 实例的最小接口（dynamic import 后获得，避免依赖具体类型） */
type ChartLike = {
  setOption(option: unknown, notMerge?: boolean): void;
  dispose(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

/** 上下文预算地图：run 级折叠区块，展开才懒加载 echarts */
export function BudgetMap({ detail }: { detail: RunDetail }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [chart, setChart] = useState<ChartLike | null>(null);
  const [open, setOpen] = useState(false);
  const selectSpan = useAppStore((s) => s.selectSpan);

  const series = useMemo<BudgetSeries>(() => deriveBudgetSeries(detail.spans), [detail]);
  const maxTotal = detail.meta.budget?.max_total_tokens ?? null;
  const lastEvent = detail.events[detail.events.length - 1];
  // 判据抽到 `lib/budget.ts`（纯函数，可断言）：见 `budgetExceeded` 的两条合取说明
  const exceeded = budgetExceeded({
    status: detail.status,
    lastEventReason: lastEvent?.reason ?? null,
  });

  // 展开时动态加载 echarts 并初始化；关闭/卸载时销毁
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let instance: ChartLike | null = null;
    void (async () => {
      const { init, use } = await import("echarts/core");
      const { LineChart } = await import("echarts/charts");
      const { GridComponent, TooltipComponent, DataZoomComponent } = await import(
        "echarts/components"
      );
      const { CanvasRenderer } = await import("echarts/renderers");
      use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);
      if (disposed || containerRef.current === null) return;
      instance = init(containerRef.current) as unknown as ChartLike;
      instance.on("click", (params) => {
        const data = params as { data?: { spanId?: string } };
        const spanId = data.data?.spanId;
        if (spanId !== undefined) selectSpan(spanId);
      });
      setChart(instance);
    })();
    return () => {
      disposed = true;
      instance?.dispose();
      setChart(null);
    };
  }, [open, selectSpan]);

  // 数据/上限/终止状态变化时刷新 option
  useEffect(() => {
    if (chart === null) return;
    chart.setOption(buildBudgetMapOption(series, maxTotal, exceeded), true);
  }, [chart, series, maxTotal, exceeded]);

  return (
    <details
      open={open}
      onToggle={(e) => {
        const el = e.currentTarget as HTMLDetailsElement;
        setOpen(el.open);
      }}
      className="border-b border-gray-200 px-4 py-2"
    >
      <summary className="cursor-pointer select-none text-[11px] font-semibold tracking-wide text-gray-500 hover:text-gray-700">
        {budgetSummaryLabel({ maxTotal, exceeded })}
      </summary>
      {open ? (
        <>
          <div ref={containerRef} className="mt-2 w-full" style={{ height: CHART_HEIGHT }} />
          <div className="mt-1 text-[10px] leading-4 text-gray-400">
            {budgetDetailLabel({ series, maxTotal })}
          </div>
        </>
      ) : null}
    </details>
  );
}
