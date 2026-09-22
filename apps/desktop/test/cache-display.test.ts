import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// DetailPanel 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import（同 call-detail-view.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { presentCacheHit, presentCacheMiss, CACHE_EFFECTIVE_PERCENT } = await import(
  "../src/renderer/src/lib/cache-view"
);
const { forkCacheHint } = await import("../src/renderer/src/lib/fork-cache-hint");
const { CacheHitRow, ForkCacheHintView, LlmCallDetailView } = await import(
  "../src/renderer/src/components/DetailPanel"
);

/**
 * U1（refactor-run-workspace）任务 5.7：接回完整缓存展示与原模型变化提示。
 *
 * 判据来源：desktop-ui delta「缓存命中可视化」（spec.md :160–:210），逐场景对齐：
 *   1. llm.call 详情展示缓存命中（800/1000 ⇒ 80%，强调命中为主）
 *   2. 零命中仍展示为全量计费（0 是有值，不得因假值省略）
 *   3. 少量命中不得被称为全量计费（128/323 ⇒ 40% + miss 195，措辞「部分命中」）
 *   4. 无缓存字段的调用降级（不展示、不报错、不显示 0）
 *   5. tool_result 分叉的模型不一致提示（信息性，不拦截）
 *   6. 其它分叉形态不加缓存提示（prompt fork / 代理 messages）
 *   7. 输入为零与全未知缓存（in=0 只给绝对 tokens；全无字段不明说虚构零命中）
 * 另对齐 :164（run 级累计现算、列表限定措辞）与 :251（概览不把工具返回修改称为文件修改）。
 *
 * ⚠️ 本包无 jsdom ⇒ 分两层：① `presentCacheHit` / `forkCacheHint` 纯判据直喂；
 *    ② `CacheHitRow` / `LlmCallDetailView` 用 `renderToStaticMarkup` 做静态结构断言。
 *    真实点击后的 DOM 变化、剪贴板、`data-cache-tone` 的实际样式渲染归 7.x CDP。
 */

const noop = (): void => {};
const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

/** 造一个 llm.call，usage 可带 cache_hit / cache_miss */
function llm(
  usage: { in: number; out?: number; cache_hit?: number; cache_miss?: number },
  extra: Partial<{ content: string | null; reasoning: string | null }> = {},
): Extract<SpanLine, { kind: "llm.call" }> {
  const span: Record<string, unknown> = {
    type: "span",
    kind: "llm.call",
    id: "l1",
    parent: "s1",
    request: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    response: {
      content: extra.content === undefined ? "ok" : extra.content,
      reasoning_content: extra.reasoning ?? null,
      tool_calls: [],
      usage: {
        in: usage.in,
        out: usage.out ?? 5,
        ...("cache_hit" in usage ? { cache_hit: usage.cache_hit } : {}),
        ...("cache_miss" in usage ? { cache_miss: usage.cache_miss } : {}),
      },
      ttft_ms: 42,
    },
  };
  return span as unknown as Extract<SpanLine, { kind: "llm.call" }>;
}

// ---------------------------------------------------------------------------
// 1/2/3/7：纯判据 presentCacheHit
// ---------------------------------------------------------------------------

describe("presentCacheHit：存在性而非 truthiness，且按命中量分档措辞", () => {
  it("场景① 命中为主：800 / 1000 ⇒ 80%，tone=effective、措辞「前缀缓存生效」", () => {
    const view = presentCacheHit({ in: 1000, cache_hit: 800 });
    expect(view).not.toBeNull();
    expect(view?.shownHit).toBe(800);
    expect(view?.input).toBe(1000);
    expect(view?.percent).toBe(80);
    expect(view?.tone).toBe("effective");
    expect(view?.verdict).toContain("前缀缓存生效");
  });

  it("场景② 零命中：cache_hit: 0 ⇒ 照常展示、tone=full、措辞「全量计费」（不得因假值省略）", () => {
    const view = presentCacheHit({ in: 1000, cache_hit: 0 });
    expect(view).not.toBeNull();
    expect(view?.hit).toBe(0);
    expect(view?.shownHit).toBe(0);
    expect(view?.percent).toBe(0);
    expect(view?.tone).toBe("full");
    expect(view?.verdict).toContain("全量计费");
  });

  it("场景③ 少量命中：128 / 323 ⇒ 40%，tone=partial，措辞「部分命中」且**不得**出现「全量计费」", () => {
    const view = presentCacheHit({ in: 323, cache_hit: 128 });
    expect(view?.percent).toBe(40);
    expect(view?.tone).toBe("partial");
    expect(view?.verdict).toContain("部分命中");
    expect(view?.verdict).not.toContain("全量计费");
  });

  it("场景④ 无 cache_hit 字段 ⇒ null（降级省略，不报错、不显示 0）", () => {
    expect(presentCacheHit({ in: 1000 })).toBeNull();
  });

  it("场景⑦ in=0 且有记录 ⇒ percent 为 null（不做除法），但命中仍算已记录", () => {
    const view = presentCacheHit({ in: 0, cache_hit: 0 });
    expect(view).not.toBeNull();
    expect(view?.percent).toBeNull();
    expect(view?.shownHit).toBe(0);
    expect(view?.tone).toBe("full");
  });

  it("门槛为 50%：49% 属 partial、50% 属 effective（边界不含糊）", () => {
    expect(CACHE_EFFECTIVE_PERCENT).toBe(50);
    expect(presentCacheHit({ in: 100, cache_hit: 49 })?.tone).toBe("partial");
    expect(presentCacheHit({ in: 100, cache_hit: 50 })?.tone).toBe("effective");
  });

  it("异常口径 cache_hit > in ⇒ 按输入总量截断并显式标注，不显示 >100%", () => {
    const view = presentCacheHit({ in: 100, cache_hit: 300 });
    expect(view?.shownHit).toBe(100);
    expect(view?.percent).toBe(100);
    expect(view?.abnormalNote).not.toBeNull();
  });

  it("cache_miss：缺失 ⇒ null（未知 ≠ 0），有值 ⇒ 原样", () => {
    expect(presentCacheMiss({})).toBeNull();
    expect(presentCacheMiss({ cache_miss: 0 })).toBe(0);
    expect(presentCacheMiss({ cache_miss: 195 })).toBe(195);
  });
});

// ---------------------------------------------------------------------------
// CacheHitRow 静态渲染（组件层）
// ---------------------------------------------------------------------------

describe("CacheHitRow：usage 区缓存命中行静态渲染", () => {
  it("场景① 800/1000 ⇒ 展示命中 tokens、占比 80%，并带命中为主的 tone", () => {
    const markup = html(
      createElement(CacheHitRow, { usage: llm({ in: 1000, cache_hit: 800 }).response.usage }),
    );
    expect(markup).toContain("缓存命中");
    expect(markup).toContain("800");
    expect(markup).toContain("1000");
    expect(markup).toContain("80%");
    expect(markup).toContain('data-cache-tone="effective"');
    expect(markup).toContain("前缀缓存生效");
  });

  it("场景② cache_hit: 0 ⇒ 展示 0 与「全量计费」，不省略（0 不是假值）", () => {
    const markup = html(
      createElement(CacheHitRow, { usage: llm({ in: 1000, cache_hit: 0 }).response.usage }),
    );
    expect(markup).toContain("缓存命中");
    expect(markup).toContain('data-cache-tone="full"');
    expect(markup).toContain("全量计费");
  });

  it("场景③ 128/323 ⇒ 40% 与 miss 195，措辞「部分命中」，不含「全量计费」", () => {
    const markup = html(
      createElement(CacheHitRow, {
        usage: llm({ in: 323, cache_hit: 128, cache_miss: 195 }).response.usage,
      }),
    );
    expect(markup).toContain("128");
    expect(markup).toContain("323");
    expect(markup).toContain("40%");
    expect(markup).toContain("195");
    expect(markup).toContain("部分命中");
    expect(markup).not.toContain("全量计费");
  });

  it("场景④ 无 cache_hit 字段 ⇒ 整行不渲染（不报错、不显示 0）", () => {
    const markup = html(createElement(CacheHitRow, { usage: llm({ in: 1000 }).response.usage }));
    expect(markup).toBe("");
    expect(markup).not.toContain("缓存命中");
  });

  it("场景⑦ in=0 且有记录 ⇒ 只给绝对 tokens，不出现任何百分比", () => {
    const markup = html(
      createElement(CacheHitRow, { usage: llm({ in: 0, cache_hit: 0 }).response.usage }),
    );
    expect(markup).toContain("缓存命中");
    expect(markup).not.toContain("%");
  });

  it("异常数据 ⇒ 显式标注截断，不显示负值或超 100%", () => {
    const markup = html(
      createElement(CacheHitRow, { usage: llm({ in: 100, cache_hit: 300 }).response.usage }),
    );
    expect(markup).toContain("100%");
    expect(markup).toContain("已按输入总量截断");
  });
});

// ---------------------------------------------------------------------------
// 详情壳接线（源码级契约）：LlmCallDetailView 必须挂 CacheHitRow
// ---------------------------------------------------------------------------

describe("接线契约：llm.call 详情确实挂上缓存命中行", () => {
  const SOURCE = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
    "utf8",
  );

  it("LlmCallDetailView 内出现 <CacheHitRow …>，且传的是 response.usage", () => {
    // 组件级测试打不到"它被挂在哪"（4.5/5.1 两次复发）⇒ 单列源码级接线契约。
    expect(SOURCE).toContain("<CacheHitRow usage={response.usage} />");
  });

  it("缓存命中行只由纯判据驱动：必须调用 presentCacheHit（不得在 JSX 里另写一套判定）", () => {
    expect(SOURCE).toContain("presentCacheHit(usage)");
    // 组件内不得再出现裸 truthiness 判定（`if (hit)` 会把 0 吞掉）
    expect(SOURCE).not.toContain("if (hit)");
  });
});

// ---------------------------------------------------------------------------
// 5/6：分叉形态 → 缓存提示（纯判据）
// ---------------------------------------------------------------------------

describe("forkCacheHint：仅 tool_result 分叉在模型不一致时提示，且不拦截门禁", () => {
  it("场景⑤ tool_result 分叉 + 模型不一致 ⇒ 给出信息性提示，点名两侧模型", () => {
    const hint = forkCacheHint({
      kind: "tool-result",
      parentModel: "deepseek-chat",
      configModel: "deepseek-reasoner",
    });
    expect(hint).not.toBeNull();
    expect(hint?.text).toContain("deepseek-chat");
    expect(hint?.text).toContain("deepseek-reasoner");
    expect(hint?.text).toContain("缓存可能不命中");
    // 信息性——不改变 fork 门禁（spec 明写不得拦截）
    expect(hint?.informational).toBe(true);
    expect(hint?.text).toContain("不阻止重跑");
  });

  it("tool_result 分叉但模型一致 ⇒ 不提示", () => {
    expect(forkCacheHint({ kind: "tool-result", parentModel: "m", configModel: "m" })).toBeNull();
  });

  it("场景⑥ prompt fork ⇒ 不加缓存提示（无论模型是否一致）", () => {
    expect(forkCacheHint({ kind: "prompt", parentModel: "a", configModel: "b" })).toBeNull();
  });

  it("场景⑥ 代理 messages 分叉 ⇒ 不加缓存提示", () => {
    expect(
      forkCacheHint({ kind: "proxy-messages", parentModel: "a", configModel: "b" }),
    ).toBeNull();
  });

  it("未知 ≠ 不一致：任一模型为 null ⇒ 不提示", () => {
    expect(forkCacheHint({ kind: "tool-result", parentModel: null, configModel: "m" })).toBeNull();
    expect(forkCacheHint({ kind: "tool-result", parentModel: "m", configModel: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ForkCacheHintView 静态渲染（能力断言，不是文案断言）
// ---------------------------------------------------------------------------

describe("ForkCacheHintView：提示块真的渲染出来", () => {
  it("给了 hint ⇒ 渲染提示文本，并带 tool-result 锚点", () => {
    const hint = forkCacheHint({
      kind: "tool-result",
      parentModel: "deepseek-chat",
      configModel: "deepseek-reasoner",
    });
    const markup = html(createElement(ForkCacheHintView, { hint }));
    expect(markup).toContain('data-fork-cache-hint="tool-result"');
    expect(markup).toContain("deepseek-chat");
    expect(markup).toContain("deepseek-reasoner");
    expect(markup).toContain("缓存可能不命中");
  });

  it("hint 为 null ⇒ 不渲染任何东西", () => {
    expect(html(createElement(ForkCacheHintView, { hint: null }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 接线契约：分叉编辑器确实用纯判据决定提示
// ---------------------------------------------------------------------------

describe("接线契约：tool_result 分叉编辑器的提示来自 forkCacheHint", () => {
  const SOURCE = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
    "utf8",
  );

  it("ForkEditor 调用 forkCacheHint 且 kind 固定为 tool-result", () => {
    expect(SOURCE).toContain('forkCacheHint({ kind: "tool-result"');
  });

  it("ForkEditor 把判据结果交给 ForkCacheHintView 渲染（不是自己另写一块）", () => {
    expect(SOURCE).toContain("<ForkCacheHintView hint={cacheHint} />");
  });
});
