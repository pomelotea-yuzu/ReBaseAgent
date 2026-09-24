import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { deriveCacheCoverage, deriveOwnConsumption } from "@shared/overview";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// OverviewPanel 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import（同 overview-result.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { ConsumptionSectionView, SourceSectionView, CacheCoverageView } = await import(
  "../src/renderer/src/components/OverviewPanel"
);
const { presentCacheCoverage, presentConsumption, presentSource } = await import(
  "../src/renderer/src/lib/overview-view"
);

/**
 * U1（refactor-run-workspace）任务 5.3：概览本次指标、缓存覆盖与父本来源。
 *
 * 判据来源：desktop-ui delta「运行概览呈现自有结果与消耗」的两条场景：
 *   - 「本次指标不累计共享前缀」：只派生自有消耗、说明已记录范围、缺失不补零、
 *     失败占位零不被解释为实际零消费。
 *   - 「来源和隔离边界保持真实」：真实直接父 ID 与字段、可返回父记录、
 *     独立执行不冒充共享前缀、隔离保留原始来源、tool_result 修改不声称改了文件。
 * 以及 design D5（指标沿用自有口径，来源不伪装执行前缀）。
 *
 * ⚠️ 本包无 jsdom，且 zustand v5 在 `renderToStaticMarkup` 下走 `getServerSnapshot`
 *    ⇒ 分两层：① `presentConsumption` / `presentCacheCoverage` / `presentSource`
 *    纯判据直喂；② 三个分区组件用 `renderToStaticMarkup` 做静态结构断言。
 *    真实点击「返回父记录」后的加载归 7.x 的 Electron/CDP。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/u1-fixtures");
const LINEAGE_DIR = resolve(import.meta.dirname, "fixtures/u1-lineage");
const TRACES = resolve(LINEAGE_DIR, "traces");
const ISO = resolve(LINEAGE_DIR, "isolated-traces");

const has = (name: string): boolean => existsSync(resolve(FIXTURE_DIR, `${name}.jsonl`));
const hasTrace = (name: string): boolean => existsSync(resolve(TRACES, `${name}.jsonl`));
const hasIso = (id: string): boolean => existsSync(resolve(ISO, `${id}.jsonl`));

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

const consume = (name: string) => {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  return deriveOwnConsumption({
    spans: record.spans,
    leafSpanIds: record.spans.map((s) => s.id),
  });
};

/** 造一个 llm.call（自有段） */
function llm(
  id: string,
  stepId: string,
  usage: { in: number; out: number; cache_hit?: number },
  timing?: { started_at: string; ended_at: string },
): SpanLine {
  return {
    type: "span",
    kind: "llm.call",
    id,
    parent: stepId,
    request: { model: "m", messages: [] },
    response: {
      content: "x",
      reasoning_content: null,
      tool_calls: [],
      usage,
      ttft_ms: 1,
    },
    ...(timing === undefined ? {} : { timing }),
  } as SpanLine;
}

// ---------------------------------------------------------------------------
// presentConsumption：本次指标不累计共享前缀
// ---------------------------------------------------------------------------

describe("presentConsumption：本次消耗的口径与未知", () => {
  it("scopeNote 恒定说明「只算自有、缺失不补零」（判据不是装饰，回归会被抓）", () => {
    if (!has("u1-ok")) return;
    const section = presentConsumption(consume("u1-ok"));
    expect(section.scopeNote).toContain("自有");
    expect(section.scopeNote).toContain("不补零");
    expect(section.scopeNote).toContain("共享前缀");
  });

  it("u1-cache-partial：与上游派生逐字段一致（展示层不重算）", () => {
    if (!has("u1-cache-partial")) return;
    const consumption = consume("u1-cache-partial");
    const section = presentConsumption(consumption);
    expect(section.tokensIn).toBe(consumption.tokensIn);
    expect(section.tokensOut).toBe(consumption.tokensOut);
    expect(section.durationMs).toBe(consumption.durationMs);
    expect(section.toolCalls).toBe(consumption.toolCalls);
  });

  it("自有 span 无 timing ⇒ durationMs 为 null 保留为未知（不当成 0）", () => {
    const step = { type: "span", kind: "agent.step", id: "s", parent: null, n: 1 } as SpanLine;
    const noTiming = llm("s1", "s", { in: 5, out: 1 });
    const section = presentConsumption(
      deriveOwnConsumption({ spans: [step, noTiming], leafSpanIds: ["s", "s1"] }),
    );
    expect(section.durationMs).toBeNull();
  });

  it("自有 token 全为 0 ⇒ 给占位零说明，不声称实际零消费", () => {
    const step = { type: "span", kind: "agent.step", id: "s", parent: null, n: 1 } as SpanLine;
    const zero = llm("s1", "s", { in: 0, out: 0 });
    const section = presentConsumption(
      deriveOwnConsumption({ spans: [step, zero], leafSpanIds: ["s", "s1"] }),
    );
    expect(section.zeroUsageNote).toContain("占位");
    expect(section.zeroUsageNote).toContain("不据此断言实际零消费");
  });

  it("自有 token 非零 ⇒ 无占位零说明（不误报）", () => {
    if (!has("u1-ok")) return;
    expect(presentConsumption(consume("u1-ok")).zeroUsageNote).toBeNull();
  });

  it("祖先共享前缀的 token 不进本次消耗（展示层继承 2.3 的自有过滤）", () => {
    const ancestorStep = {
      type: "span",
      kind: "agent.step",
      id: "s_as",
      parent: null,
      n: 1,
    } as SpanLine;
    const ancestor = llm("s_a", "s_as", { in: 9999, out: 999 });
    const step = { type: "span", kind: "agent.step", id: "s", parent: null, n: 2 } as SpanLine;
    const own = llm("s1", "s", { in: 100, out: 10 });
    const section = presentConsumption(
      deriveOwnConsumption({
        spans: [ancestorStep, ancestor, step, own],
        leafSpanIds: ["s", "s1"], // 祖先不在自有段
      }),
    );
    expect(section.tokensIn).toBe(100);
    expect(section.tokensOut).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// presentCacheCoverage：0 是记录、缺失是未知
// ---------------------------------------------------------------------------

describe("presentCacheCoverage：缓存覆盖只说已记录范围", () => {
  it("无自有调用 ⇒ note 说明没有调用、hitTotal 为 null", () => {
    const section = presentCacheCoverage({ recorded: 0, total: 0, hitTotal: null });
    expect(section.hitTotal).toBeNull();
    expect(section.note).toContain("没有自有模型调用");
  });

  it("有调用但全无 cache_hit 字段 ⇒ hitTotal 保持 null（未知 ≠ 0）", () => {
    const step = { type: "span", kind: "agent.step", id: "s", parent: null, n: 1 } as SpanLine;
    const cov = deriveCacheCoverage({
      spans: [step, llm("s1", "s", { in: 5, out: 1 })],
      leafSpanIds: ["s", "s1"],
    });
    const section = presentCacheCoverage(cov);
    expect(section.hitTotal).toBeNull();
    expect(section.hitTotal).not.toBe(0);
    expect(section.note).toContain("未记录");
  });

  it("cache_hit: 0 算已记录 ⇒ hitTotal 为 0（有值，不是 null）", () => {
    const step = { type: "span", kind: "agent.step", id: "s", parent: null, n: 1 } as SpanLine;
    const cov = deriveCacheCoverage({
      spans: [step, llm("s1", "s", { in: 5, out: 1, cache_hit: 0 })],
      leafSpanIds: ["s", "s1"],
    });
    const section = presentCacheCoverage(cov);
    expect(section.hitTotal).toBe(0);
    expect(section.recorded).toBe(1);
  });

  it("部分记录 ⇒ 说明「部分记录不构成整次命中率」（概览不生成整次命中率）", () => {
    if (!has("u1-cache-partial")) return;
    const section = presentCacheCoverage(consume("u1-cache-partial").cache);
    expect(section.note).toContain("不构成整次命中率");
    expect(section.recorded).toBeGreaterThan(0);
    expect(section.recorded).toBeLessThan(section.total);
  });
});

// ---------------------------------------------------------------------------
// presentSource：来源和隔离边界保持真实
// ---------------------------------------------------------------------------

const metaOf = (dir: string, name: string) => readRun(resolve(dir, `${name}.jsonl`)).meta;

describe("presentSource：真实父本与执行语义分流", () => {
  it("根 run ⇒ 无父、relation=root、无返回父入口", () => {
    if (!hasTrace("u1r_parent")) return;
    const meta = metaOf(TRACES, "u1r_parent");
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.parentId).toBeNull();
    expect(section.relation).toBe("root");
    expect(section.canOpenParent).toBe(false);
    expect(section.isolationNote).toBeNull();
  });

  it("result 分叉 ⇒ relation=shared-prefix，父 ID 与 fork 字段为真实值", () => {
    if (!hasTrace("u1r_child")) return;
    const meta = metaOf(TRACES, "u1r_child");
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.parentId).toBe("u1r_parent");
    expect(section.editField).toBe("result");
    expect(section.editLabel).toBe("改 tool_result");
    expect(section.relation).toBe("shared-prefix");
    expect(section.relationNote).toContain("共享前缀");
    expect(section.canOpenParent).toBe(true);
  });

  it("prompt fork ⇒ relation=independent，**禁止**说「共享前缀」（判据有牙）", () => {
    if (!hasTrace("u1p_child")) return;
    const meta = metaOf(TRACES, "u1p_child");
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.relation).toBe("independent");
    expect(section.relationNote).toContain("独立执行");
    // 关键反例纪律：独立执行绝不能说成共享执行前缀
    expect(section.relationNote).not.toContain("共享前缀");
    expect(section.parentId).toBe("u1p_parent");
  });

  it("model_params 臂 ⇒ relation=independent，同样不冒充共享前缀", () => {
    if (!hasTrace("u1m_arm_a")) return;
    const meta = metaOf(TRACES, "u1m_arm_a");
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.relation).toBe("independent");
    expect(section.relationNote).not.toContain("共享前缀");
    expect(section.parentId).toBe("u1m_parent");
  });

  it("代理分叉 ⇒ relation=proxy，不套用共享前缀语义", () => {
    if (!hasTrace("run_zz02")) return;
    const meta = metaOf(TRACES, "run_zz02");
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.relation).toBe("proxy");
    expect(section.relationNote).not.toContain("共享前缀");
  });

  it("隔离续跑 ⇒ isolationNote 指向真实 origin.run_id 与轮末检查点，不声称改了文件", () => {
    const fork1 = "run_mub3nk3x_jt3h";
    if (!hasIso(fork1)) return;
    const meta = metaOf(ISO, fork1);
    const section = presentSource({ meta, chain: [{ meta }] });
    // 真实直接父（不是链首、不是 workspace.world_id）
    expect(section.parentId).toBe("run_mub3nk1j_5koo53");
    expect(section.isolationNote).not.toBeNull();
    expect(section.isolationNote).toContain("轮末检查点");
    expect(section.isolationNote).toContain("独立世界");
    // 隔离边界绝不能说成"改了文件"
    expect(section.isolationNote).not.toContain("修改了源文件");
    expect(section.isolationNote).not.toContain("已恢复历史磁盘状态");
  });

  it("二次隔离分叉 ⇒ 父是直接父（fork1），不冒充链首；origin.run_id 亦为 fork1", () => {
    const fork2 = "run_mub3nk4f_p4vj";
    const fork1 = "run_mub3nk3x_jt3h";
    if (!hasIso(fork2)) return;
    const meta = metaOf(ISO, fork2);
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.parentId).toBe(fork1);
    expect(section.isolationNote).toContain(fork1);
  });

  it("隔离根 run（import 来源）⇒ relation=root，隔离说明不套用共享前缀", () => {
    const root = "run_mub3nk1j_5koo53";
    if (!hasIso(root)) return;
    const meta = metaOf(ISO, root);
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.parentId).toBeNull();
    expect(section.relation).toBe("root");
    expect(section.relationNote).toContain("源目录");
    expect(section.relationNote).not.toContain("共享前缀");
    expect(section.canOpenParent).toBe(false);
  });

  it("未知 fork 字段 ⇒ 兜底 shared-prefix（不猜成独立执行）", () => {
    const meta = {
      id: "x",
      parent: "p",
      fork: { at_span: "s_01", edit: { field: "unknown_field" } },
    };
    const section = presentSource({ meta, chain: [{ meta }] });
    expect(section.relation).toBe("shared-prefix");
    expect(section.canOpenParent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 组件静态渲染：未知与零分开、口径说明可见、独立执行不冒充共享前缀
// ---------------------------------------------------------------------------

describe("ConsumptionSectionView：静态结构", () => {
  it("未记录时间 ⇒ 显示「未记录时间跨度」，不显示 0 / —（未知 ≠ 零）", () => {
    const section = presentConsumption({
      tokensIn: 5,
      tokensOut: 1,
      durationMs: null,
      toolCalls: 0,
      toolErrors: 0,
      cache: { recorded: 0, total: 1, hitTotal: null },
    });
    const markup = html(createElement(ConsumptionSectionView, { section }));
    expect(markup).toContain("未记录时间跨度");
    expect(markup).toContain("未记录命中量");
    expect(markup).not.toContain("0ms");
  });

  it("口径说明与占位零说明都渲染出来", () => {
    const section = presentConsumption({
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 100,
      toolCalls: 0,
      toolErrors: 0,
      cache: { recorded: 1, total: 1, hitTotal: 0 },
    });
    const markup = html(createElement(ConsumptionSectionView, { section }));
    expect(markup).toContain("仅本次运行自有调用");
    expect(markup).toContain("占位");
  });

  it("总计说明「（本 run 自有）」框定范围", () => {
    if (!has("u1-ok")) return;
    const markup = html(
      createElement(ConsumptionSectionView, { section: presentConsumption(consume("u1-ok")) }),
    );
    expect(markup).toContain("本 run 自有");
  });

  it("CacheCoverageView：hitTotal=0 显示 0，hitTotal=null 显示「未记录命中量」", () => {
    const zero = html(
      createElement(CacheCoverageView, {
        section: presentCacheCoverage({ recorded: 1, total: 2, hitTotal: 0 }),
      }),
    );
    expect(zero).toContain("缓存命中");
    expect(zero).not.toContain("未记录命中量");

    const unknown = html(
      createElement(CacheCoverageView, {
        section: presentCacheCoverage({ recorded: 0, total: 2, hitTotal: null }),
      }),
    );
    expect(unknown).toContain("未记录命中量");
  });
});

describe("SourceSectionView：静态结构", () => {
  it("有父 ⇒ 显示直接父 ID 与「返回父记录」入口", () => {
    if (!hasTrace("u1r_child")) return;
    const meta = metaOf(TRACES, "u1r_child");
    const markup = html(
      createElement(SourceSectionView, {
        section: presentSource({ meta, chain: [{ meta }] }),
        onOpenParent: () => {},
      }),
    );
    expect(markup).toContain("u1r_parent");
    expect(markup).toContain("返回父记录");
    expect(markup).toContain("共享前缀");
    expect(markup).toContain("result");
  });

  it("prompt fork ⇒ 渲染「独立执行」，且**不**渲染「共享前缀」字样", () => {
    if (!hasTrace("u1p_child")) return;
    const meta = metaOf(TRACES, "u1p_child");
    const markup = html(
      createElement(SourceSectionView, {
        section: presentSource({ meta, chain: [{ meta }] }),
        onOpenParent: () => {},
      }),
    );
    expect(markup).toContain("独立执行");
    expect(markup).not.toContain("共享前缀");
  });

  it("根 run ⇒ 不渲染「返回父记录」按钮（不摆点不动的入口）", () => {
    if (!hasTrace("u1r_parent")) return;
    const meta = metaOf(TRACES, "u1r_parent");
    const markup = html(
      createElement(SourceSectionView, {
        section: presentSource({ meta, chain: [{ meta }] }),
        onOpenParent: () => {},
      }),
    );
    expect(markup).not.toContain("返回父记录");
    expect(markup).toContain("根运行");
  });

  it("隔离续跑 ⇒ 渲染隔离边界说明且不含「修改了源文件」措辞", () => {
    const fork1 = "run_mub3nk3x_jt3h";
    if (!hasIso(fork1)) return;
    const meta = metaOf(ISO, fork1);
    const markup = html(
      createElement(SourceSectionView, {
        section: presentSource({ meta, chain: [{ meta }] }),
        onOpenParent: () => {},
      }),
    );
    expect(markup).toContain("轮末检查点");
    expect(markup).not.toContain("修改了源文件");
  });
});

// ---------------------------------------------------------------------------
// 接线契约：概览把 6 个分区都接上（源码级，组件测试打不到外壳层）
// ---------------------------------------------------------------------------

describe("概览接线：6 个分区组件都在 OverviewResultView 里（源码级）", () => {
  const PANEL = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/OverviewPanel.tsx"),
    "utf8",
  );

  it("结果区、结局区、错误区、工具错误区、消耗区、来源区全部被渲染", () => {
    for (const tag of [
      "OutcomeSectionView",
      "LlmErrorSectionView",
      "ToolErrorsSectionView",
      "ConsumptionSectionView",
      "SourceSectionView",
    ]) {
      expect(PANEL, `缺分区组件：${tag}`).toContain(`<${tag}`);
    }
  });

  it("消耗与缓存的判据来自上游派生（不为概览再写一份聚合）", () => {
    expect(PANEL).toContain("deriveOwnConsumption");
    expect(PANEL).toContain("presentConsumption");
    expect(PANEL).toContain("presentSource");
  });

  it("「返回父记录」接的是 store 的 selectRun（不自己拼部分状态）", () => {
    expect(PANEL).toMatch(/onOpenParent=\{\(runId\)[\s\S]{0,200}selectRun\(runId\)/);
  });
});
