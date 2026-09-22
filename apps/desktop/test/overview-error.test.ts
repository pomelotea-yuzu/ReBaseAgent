import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunEventLine, SpanLine } from "@rebaseagent/trace-sdk";
import { deriveErrorTarget, deriveOwnOutput, deriveOwnToolErrors } from "@shared/overview";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// OverviewPanel 的 store 薄壳在 import 时就会触到 `window.api`（../lib/api.ts）
// ⇒ 桩必须先就位；ESM 静态 import 会被提升，故用动态 import（同 5.1 的 test 文件）。
(globalThis as Record<string, unknown>).window = { api: {} };

const { LlmErrorSectionView, OutcomeSectionView, ToolErrorsSectionView } = await import(
  "../src/renderer/src/components/OverviewPanel"
);
const { presentLlmError, presentOutcome, presentToolErrors } = await import(
  "../src/renderer/src/lib/overview-view"
);
const { auditSafeTextRendering } = await import("../src/renderer/src/lib/overview-view");

/**
 * U1（refactor-run-workspace）任务 5.2：概览错误/限制/中断区及真实调用定位。
 *
 * 判据来源：desktop-ui delta「运行概览呈现自有结果与消耗」四场景：
 *   - 失败概览定位真实自有调用
 *   - 旧失败记录没有错误详情
 *   - 限制中止与中断如实展示
 *   - 显式错误定位优先于恢复（本任务只保证「显式定位入口存在且指向真实调用」，
 *     优先级排序属 3.2 的 `resolveReading`，已在 reading-resolve.test.ts 覆盖）
 * 以及 design D4（错误与结局一律由自有记录派生；工具错误不断言为终止根因）。
 *
 * ⚠️ 本包无 jsdom（zustand v5 + renderToStaticMarkup 喂不进 store 状态）⇒ 分两层：
 *    ① 纯判据（`presentOutcome` / `presentLlmError` / `presentToolErrors`）；
 *    ② 纯展示组件用 `renderToStaticMarkup` 做静态结构断言。
 *    真实点击定位后的滚动/聚焦归 7.1/7.3 的 Electron/CDP。
 */

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../.rebaseagent/u1-fixtures");
const PANEL_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../src/renderer/src/components/OverviewPanel.tsx"),
  "utf8",
);

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);
const noop = (): void => {};

function detailOf(name: string): {
  spans: SpanLine[];
  leafSpanIds: string[];
  status: "completed" | "crashed";
  events: RunEventLine[];
} {
  const record = readRun(resolve(FIXTURE_DIR, `${name}.jsonl`));
  return {
    spans: record.spans,
    leafSpanIds: record.spans.map((span) => span.id),
    status: record.status,
    events: record.events,
  };
}

const has = (name: string): boolean => existsSync(resolve(FIXTURE_DIR, `${name}.jsonl`));

/** 从 fixture 现算自有终止原因（与组件内同源，不自己造结论） */
function ownReasonOf(detail: ReturnType<typeof detailOf>): string | null {
  const events = detail.events.filter((event) => event.type === "run.event");
  const last = events[events.length - 1];
  const reason = last === undefined || last.type !== "run.event" ? null : last.reason;
  return detail.status === "crashed" ? null : reason;
}

function errorSectionOf(name: string) {
  const detail = detailOf(name);
  const reason = ownReasonOf(detail);
  return presentLlmError(
    deriveErrorTarget({ spans: detail.spans, leafSpanIds: detail.leafSpanIds, reason }),
  );
}

// ---------------------------------------------------------------------------
// 结局区：限制中止与中断如实展示
// ---------------------------------------------------------------------------

describe("presentOutcome：限制中止与中断如实展示", () => {
  it("u1-crashed：无终止事件 ⇒ 运行中断，不标为正常成功或仍在执行", () => {
    if (!has("u1-crashed")) return;
    const detail = detailOf("u1-crashed");
    const section = presentOutcome({
      kind: "interrupted",
      label: "运行中断",
      tone: "neutral",
      normalEnd: false,
      reason: null,
    });

    expect(detail.status).toBe("crashed");
    expect(section.kind).toBe("interrupted");
    expect(section.tone).toBe("neutral");
    expect(section.note).toContain("不代表仍在执行");
  });

  it("u1-aborted：中止 ⇒ 明说「不是正常结束」，且已记录内容保留", () => {
    if (!has("u1-aborted")) return;
    const section = presentOutcome({
      kind: "aborted",
      label: "已中止",
      tone: "neutral",
      normalEnd: false,
      reason: "aborted",
    });

    expect(section.label).toBe("已中止");
    expect(section.note).toContain("不是正常结束");
    expect(section.note).toContain("保留");
  });

  it("max_iterations / budget_exceeded：各自的限制说明互不冒充", () => {
    const maxIter = presentOutcome({
      kind: "max_iterations",
      label: "达到迭代上限",
      tone: "warn",
      normalEnd: false,
      reason: "max_iterations",
    });
    const budget = presentOutcome({
      kind: "budget_exceeded",
      label: "超出预算",
      tone: "warn",
      normalEnd: false,
      reason: "budget_exceeded",
    });

    expect(maxIter.note).toContain("迭代上限");
    expect(maxIter.note).not.toContain("预算");
    expect(budget.note).toContain("预算");
    expect(budget.note).not.toContain("迭代上限");
  });

  it("completed / error：无额外补充说明（结局标签已足够，不堆无信息量的句子）", () => {
    for (const kind of ["completed", "error"] as const) {
      const section = presentOutcome({
        kind,
        label: kind === "completed" ? "已结束" : "出错终止",
        tone: kind === "completed" ? "success" : "danger",
        normalEnd: kind === "completed",
        reason: kind,
      });
      expect(section.note).toBeNull();
    }
  });

  it("文案不声称测试通过 / 修复成功（delta 明文要求）", () => {
    const kinds = [
      "completed",
      "error",
      "max_iterations",
      "budget_exceeded",
      "aborted",
      "interrupted",
      "unknown",
    ] as const;
    for (const kind of kinds) {
      const section = presentOutcome({
        kind,
        label: "x",
        tone: "neutral",
        normalEnd: false,
        reason: null,
      });
      const text = section.note ?? "";
      expect(text).not.toContain("测试通过");
      expect(text).not.toContain("修复成功");
    }
  });
});

describe("OutcomeSectionView：结局区静态结构", () => {
  it("u1-crashed：显示「运行中断」，且带文字标签（不只靠颜色）", () => {
    if (!has("u1-crashed")) return;
    const markup = html(createElement(OutcomeSectionView, { status: "crashed", reason: null }));

    expect(markup).toContain("运行中断");
    expect(markup).not.toContain("进行中");
    expect(markup).not.toContain("测试通过");
  });

  it("u1-aborted：显示「已中止」", () => {
    if (!has("u1-aborted")) return;
    const markup = html(
      createElement(OutcomeSectionView, { status: "completed", reason: "aborted" }),
    );
    expect(markup).toContain("已中止");
  });
});

// ---------------------------------------------------------------------------
// 错误区：失败概览定位真实自有调用 / 旧失败记录没有错误详情
// ---------------------------------------------------------------------------

describe("presentLlmError：失败概览定位真实自有调用", () => {
  it("u1-error-detail：有带 error 的自有 llm.call ⇒ 给可定位目标与错误正文", () => {
    if (!has("u1-error-detail")) return;
    const section = errorSectionOf("u1-error-detail");

    expect(section.form).toBe("located");
    if (section.form !== "located") return;
    expect(section.target.spanId.length).toBeGreaterThan(0);
    // 「可直接打开该调用、展开所属 step」——所属 step 必须解析出来
    expect(section.target.stepSpanId).not.toBeNull();
    expect(section.message.length).toBeGreaterThan(0);
  });

  it("u1-error-legacy：error 终止但自有 LLM 无错误详情 ⇒ missing，绝不虚构入口", () => {
    if (!has("u1-error-legacy")) return;
    const section = errorSectionOf("u1-error-legacy");

    expect(section.form).toBe("missing");
    if (section.form !== "missing") return;
    expect(section.note).toContain("没有 LLM 错误详情");
    // 不反推原因、不借用祖先
    expect(section.note).toContain("不反推");
    expect(section.note).toContain("祖先");
  });

  it("u1-ok：非 error 终止 ⇒ 本区不出现（不是渲染一个空错误框）", () => {
    if (!has("u1-ok")) return;
    expect(errorSectionOf("u1-ok").form).toBe("none");
  });

  it("u1-aborted / u1-crashed：限制与中断也不渲染错误区（缺失提示只对 error 有意义）", () => {
    for (const name of ["u1-aborted", "u1-crashed"]) {
      if (!has(name)) continue;
      expect(errorSectionOf(name).form).toBe("none");
    }
  });

  it("定位入口指向的是**自有**失败调用，不是祖先的（反例纪律）", async () => {
    if (!has("u1-error-detail")) return;
    const detail = detailOf("u1-error-detail");
    const section = errorSectionOf("u1-error-detail");
    if (section.form !== "located") throw new Error("expected located");

    // 定位的 span 必须确实带有 error（不能指向一个无辜的调用）
    const target = detail.spans.find((span) => span.id === section.target.spanId);
    expect(target?.kind).toBe("llm.call");
    expect(target !== undefined && target.kind === "llm.call" && target.error !== undefined).toBe(
      true,
    );
    // 且它属于自有段
    expect(detail.leafSpanIds).toContain(section.target.spanId);
  });
});

describe("LlmErrorSectionView：错误区静态结构", () => {
  it("located：显示错误正文、span id 与「打开该调用并展开所属 step」入口", () => {
    if (!has("u1-error-detail")) return;
    const section = errorSectionOf("u1-error-detail");
    if (section.form !== "located") throw new Error("expected located");

    const markup = html(createElement(LlmErrorSectionView, { section, onOpenCall: noop }));
    expect(markup).toContain("本次失败原因");
    expect(markup).toContain(section.target.spanId);
    expect(markup).toContain("打开该调用并展开所属 step");
  });

  it("missing：只给说明，**没有**定位按钮（给一个指向不了的按钮比不给更糟）", () => {
    if (!has("u1-error-legacy")) return;
    const section = errorSectionOf("u1-error-legacy");
    const markup = html(createElement(LlmErrorSectionView, { section, onOpenCall: noop }));

    expect(markup).toContain("没有 LLM 错误详情");
    expect(markup).not.toContain("打开该调用并展开所属 step");
    // 也不伪造一个 span id 展示
    expect(markup).not.toMatch(/font-code[^>]*>[^<]*s_/);
  });

  it("none：整区不渲染（空字符串），不留空标题", () => {
    const markup = html(
      createElement(LlmErrorSectionView, { section: { form: "none" }, onOpenCall: noop }),
    );
    expect(markup).toBe("");
  });

  it("缺 HTTP 状态码时显示「未记录」而不是像数据的占位（未知 ≠ 0）", () => {
    const markup = html(
      createElement(LlmErrorSectionView, {
        section: {
          form: "located",
          target: { spanId: "s_02", stepSpanId: "s_01" },
          message: "connection reset",
          status: null,
        },
        onOpenCall: noop,
      }),
    );
    expect(markup).toContain("未记录 HTTP 状态");
    expect(markup).not.toContain("HTTP 0");
    expect(markup).not.toContain("HTTP —");
  });
});

// ---------------------------------------------------------------------------
// 工具错误区：独立列出，不断言为终止根因
// ---------------------------------------------------------------------------

describe("presentToolErrors / ToolErrorsSectionView：工具错误不被断言为终止根因", () => {
  it("u1-error-legacy：有工具错误时仍保留 LLM 缺失说明（两者互不影响）", () => {
    if (!has("u1-error-legacy")) return;
    const detail = detailOf("u1-error-legacy");
    const rows = presentToolErrors(
      deriveOwnToolErrors({ spans: detail.spans, leafSpanIds: detail.leafSpanIds }),
    );

    // 该 fixture 的错误来自工具 ⇒ 工具错误区有内容……
    expect(rows.length).toBeGreaterThan(0);
    // ……而 LLM 错误区仍是 missing（**没有**因为有工具错误就把 LLM 那格说成"有原因"）
    expect(errorSectionOf("u1-error-legacy").form).toBe("missing");
  });

  it("无工具错误时不渲染工具错误区（不摆空标题）", () => {
    if (!has("u1-ok")) return;
    const detail = detailOf("u1-ok");
    const rows = presentToolErrors(
      deriveOwnToolErrors({ spans: detail.spans, leafSpanIds: detail.leafSpanIds }),
    );
    expect(rows).toEqual([]);
    expect(html(createElement(ToolErrorsSectionView, { rows, onOpenCall: noop }))).toBe("");
  });

  it("有工具错误时明确标注「不构成终止原因」（防误归因）", () => {
    if (!has("u1-error-legacy")) return;
    const detail = detailOf("u1-error-legacy");
    const rows = presentToolErrors(
      deriveOwnToolErrors({ spans: detail.spans, leafSpanIds: detail.leafSpanIds }),
    );
    const markup = html(createElement(ToolErrorsSectionView, { rows, onOpenCall: noop }));

    expect(markup).toContain("工具错误");
    expect(markup).toContain("不构成终止原因");
    expect(markup).toContain("定位");
  });

  it("工具错误的行不透传额外字段（只给定位与核对所需的四项）", () => {
    if (!has("u1-error-legacy")) return;
    const detail = detailOf("u1-error-legacy");
    const rows = presentToolErrors(
      deriveOwnToolErrors({ spans: detail.spans, leafSpanIds: detail.leafSpanIds }),
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["message", "spanId", "stepSpanId", "tool"]);
    }
  });
});

// ---------------------------------------------------------------------------
// 接线契约（源码级）：概览页确实挂上三个新分区、定位动作走既有通道
// ---------------------------------------------------------------------------

describe("接线契约：概览页挂上结局/错误/工具错误三区", () => {
  it("OverviewResultView 渲染三个分区组件", () => {
    expect(PANEL_SOURCE).toContain("<OutcomeSectionView");
    expect(PANEL_SOURCE).toContain("<LlmErrorSectionView");
    expect(PANEL_SOURCE).toContain("<ToolErrorsSectionView");
  });

  it("错误与结局走上游派生（不自己重写判据）", () => {
    expect(PANEL_SOURCE).toContain("deriveErrorTarget");
    expect(PANEL_SOURCE).toContain("deriveOwnToolErrors");
    expect(PANEL_SOURCE).toContain("classifyOutcome");
    expect(PANEL_SOURCE).toContain("presentOutcome");
  });

  it("定位动作复用同一个 onOpenCall（错误区与结果区不各开通道）", () => {
    // 三处入口都走 props 里的 onOpenCall，而不是各自 import store
    const matches = PANEL_SOURCE.match(/onOpenCall=/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("概览薄壳的定位动作 = 选中 span + 展开 step + 切步骤页（既有 store 方法）", () => {
    expect(PANEL_SOURCE).toContain("selectSpan");
    expect(PANEL_SOURCE).toContain("toggleStep");
    expect(PANEL_SOURCE).toContain("setReadingTab");
    // 展开 step 用"只在未展开时打开"的判据，避免切进去反而收起用户已展开的
    expect(PANEL_SOURCE).toContain("expandedSteps");
  });

  it("结局区不读 meta.status 冒充结论（status 只作 crashed 判定，reason 取最后一条 event）", () => {
    // 关键：`reason` 必须来自 events 里最后一条 run.event，而不是自行编造
    expect(PANEL_SOURCE).toContain('event.type === "run.event"');
    expect(PANEL_SOURCE).toContain('last.type !== "run.event"');
  });
});

// ---------------------------------------------------------------------------
// 5.1 的结果区在 5.2 引入三区后仍不回退
// ---------------------------------------------------------------------------

describe("回归：5.1 的结果区契约在三区加入后仍成立", () => {
  it("概览根容器仍带「运行概览」标签，结果区仍带「运行结果」", () => {
    expect(PANEL_SOURCE).toContain('aria-label="运行概览"');
    expect(PANEL_SOURCE).toContain('aria-label="运行结果"');
  });

  it("正文仍走 LongText（未被三区改造顺手换成 Markdown 渲染）", () => {
    expect(PANEL_SOURCE).toContain("<LongText");
    // ⚠️ 不能直接对源码 `expect(PANEL_SOURCE).not.toContain("dangerouslySetInnerHTML")`——
    // 本文件的文档注释里**点名**了这个禁用写法（正在解释为什么禁用），会假红。
    // 复用 5.1 的审计函数（它已按纪律先剥注释再扫）。
    expect(auditSafeTextRendering(PANEL_SOURCE)).toEqual([]);
  });
});
