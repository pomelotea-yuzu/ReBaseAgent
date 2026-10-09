import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DRAFT_EDITOR_HEIGHT,
  DRAFT_PER_SIDE_MIN,
  EXPANDED_DRAFT_EDITOR_HEIGHT,
  ORIGINAL_EDITOR_HEIGHT,
  ORIGINAL_HEIGHT_MAX,
  ORIGINAL_HEIGHT_MIN,
  clampOriginalHeight,
  decideDraftCompareLayout,
  stepOriginalHeight,
} from "../src/renderer/src/lib/editor-space";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
const { DraftCompareGrid } = await import("../src/renderer/src/components/DraftCompareGrid");

/**
 * UI 密度 change（improve-workspace-reading-and-editing）任务 2.2/2.3：
 * 原值/草稿对照区的空间策略（design D3）。
 *
 * 断言三层（本包无 jsdom 的既有纪律）：
 *   ① **纯判据**：并排/上下按实测容器宽（每侧 ≥320），不吃窗口断点；原值高度键盘
 *      步进与 clamp 边界；高度常量是视口相对 clamp（不再固定 200/140px）。
 *   ② **能力断言**（静态渲染）：并排形态下 DOM 有 data-draft-layout、原值收起按钮
 *      （aria-expanded）、草稿恢复入口的源；收起态恢复入口常驻由源码契约钉住。
 *   ③ **接线契约**（source 级，剥注释）：四处调用点共用 DraftCompareGrid、
 *      编辑器 height="100%"、固定 200/140px 与 xl 断点在对照区退场。
 */

const rendererSrc = (file: string): string =>
  readFileSync(resolve(import.meta.dirname, "../src/renderer/src", file), "utf8");

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

describe("空间判据（lib/editor-space，任务 2.2）", () => {
  it("并排/上下按容器实测宽决策：每侧 ≥320 才并排，非法输入回上下", () => {
    // 320*2 + 8(gap) = 648 是并排下限
    expect(decideDraftCompareLayout(DRAFT_PER_SIDE_MIN * 2 + 8)).toBe("side-by-side");
    expect(decideDraftCompareLayout(DRAFT_PER_SIDE_MIN * 2 + 7)).toBe("stacked");
    expect(decideDraftCompareLayout(0)).toBe("stacked");
    expect(decideDraftCompareLayout(Number.NaN)).toBe("stacked");
  });

  it("高度常量是视口相对 clamp，不再固定 200/140px", () => {
    expect(ORIGINAL_EDITOR_HEIGHT).toBe("clamp(160px, 32vh, 480px)");
    expect(DRAFT_EDITOR_HEIGHT).toBe("clamp(240px, 44vh, 640px)");
    expect(EXPANDED_DRAFT_EDITOR_HEIGHT).toBe("clamp(320px, 64vh, 800px)");
  });

  it("原值区键盘步进：±24、Home/End 到边界、无关键不消费；非法值夹回下限", () => {
    expect(stepOriginalHeight(320, "ArrowUp")).toBe(344);
    expect(stepOriginalHeight(320, "ArrowDown")).toBe(296);
    expect(stepOriginalHeight(ORIGINAL_HEIGHT_MAX - 10, "ArrowUp")).toBe(ORIGINAL_HEIGHT_MAX);
    expect(stepOriginalHeight(ORIGINAL_HEIGHT_MIN + 10, "ArrowDown")).toBe(ORIGINAL_HEIGHT_MIN);
    expect(stepOriginalHeight(320, "Home")).toBe(ORIGINAL_HEIGHT_MIN);
    expect(stepOriginalHeight(320, "End")).toBe(ORIGINAL_HEIGHT_MAX);
    expect(stepOriginalHeight(320, "ArrowLeft")).toBeNull();
    expect(clampOriginalHeight(Number.NaN)).toBe(ORIGINAL_HEIGHT_MIN);
    expect(clampOriginalHeight(9999)).toBe(ORIGINAL_HEIGHT_MAX);
  });
});

describe("DraftCompareGrid 布局层（能力断言）", () => {
  it("默认（宽容器）并排：data-draft-layout、原值收起按钮带 aria-expanded/aria-controls", () => {
    const out = html(
      createElement(DraftCompareGrid, {
        compareKey: "messages",
        draftTone: "sky",
        original: createElement("div", { "data-x": "original" }),
        draft: createElement("div", { "data-x": "draft" }),
      }),
    );
    expect(out).toContain('data-draft-compare="messages"');
    expect(out).toContain('data-draft-layout="side-by-side"');
    expect(out).toContain("grid-cols-2");
    expect(out).toContain("原值（只读）");
    expect(out).toContain("草稿（可编辑）");
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain("收起原值");
    expect(out).toContain('data-x="original"');
    expect(out).toContain('data-x="draft"');
  });

  it("源码契约：收起态恢复入口常驻（显示原值按钮），A/B 不套高度包裹、无比例手柄", () => {
    const src = rendererSrc("components/DraftCompareGrid.tsx");
    // 收起态 = 草稿独占单列 + 「显示原值」恢复入口（aria-expanded 翻转为 false）
    expect(src).toContain('data-original-collapsed="true"');
    expect(src).toContain("显示原值");
    expect(src).toContain('aria-expanded="false"');
    // 收起后草稿用加大的展开高度（spec「草稿加大且可输入」）
    expect(src).toContain("EXPANDED_DRAFT_EDITOR_HEIGHT");
    // 高度手柄可聚焦可键盘调（role=separator + aria-value* + stepOriginalHeight）
    expect(src).toContain('role="separator"');
    expect(src).toContain("aria-valuemin={ORIGINAL_HEIGHT_MIN}");
    expect(src).toContain("stepOriginalHeight(separatorValue, event.key)");
  });
});

describe("四处调用点共用同一布局层（接线契约，任务 2.2/2.3）", () => {
  it("messages / prompt / tool-result / model-ab 都走 DraftCompareGrid，编辑器 height=100%", () => {
    const cases: Array<[string, string]> = [
      ["components/MessagesForkEditor.tsx", 'compareKey="messages"'],
      ["components/DetailPanel.tsx", 'compareKey="prompt"'],
      ["components/DetailPanel.tsx", 'compareKey="tool-result"'],
      ["components/ModelAbEditor.tsx", 'compareKey="model-ab"'],
    ];
    for (const [file, anchor] of cases) {
      expect(rendererSrc(file)).toContain(anchor);
      expect(rendererSrc(file)).toContain("DraftCompareGrid");
    }
  });

  it("固定 200/140px 编辑器高度与 xl 窗口断点在对照区退场（剥注释后扫）", () => {
    for (const file of [
      "components/MessagesForkEditor.tsx",
      "components/DetailPanel.tsx",
      "components/ModelAbEditor.tsx",
    ]) {
      expect(auditForbiddenTokens(rendererSrc(file), ['height="200px"', 'height="140px"'])).toEqual(
        [],
      );
    }
    // 最后一处 xl:grid-cols-2 是 tool.invoke 的只读 args/result 长文本展示（非编辑器），
    // 不在本任务范围；编辑器对照区不得再有窗口断点
    const detail = rendererSrc("components/DetailPanel.tsx");
    expect(detail.split("xl:grid-cols-2").length - 1).toBe(1);
  });

  it("A/B 对照卡：fixedHeight=false + resizable=false（自适应文本，不套高度包裹）", () => {
    const src = rendererSrc("components/ModelAbEditor.tsx");
    expect(src).toContain("fixedHeight={false}");
    expect(src).toContain("resizable={false}");
    expect(src).toContain('originalLabel="原值（父本基线臂 · 只读）"');
  });
});
