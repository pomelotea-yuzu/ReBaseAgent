import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  COLLAPSE_THRESHOLD,
  collapsedLabel,
  shouldCollapse,
} from "../src/renderer/src/components/LongText";
import { auditForbiddenTokens } from "../src/renderer/src/lib/overview-view";
const { LongText } = await import("../src/renderer/src/components/LongText");

/**
 * UI 密度 change（improve-workspace-reading-and-editing）任务 1.1/1.2/1.5：
 * 列表 / 步骤目录 / 文件目录 / 长文本折叠控制接线的断言。
 *
 * RunList / SpanTree / WorkspaceFileView 都读 store（renderToStaticMarkup 拿不到
 * 状态，且目录/列表在静态渲染下走早退分支）⇒ 外壳接线用**源码契约**钉住（本包
 * 既有纪律：组件测试抓不到"它被挂在哪/接了哪个回调"）。禁用型断言走
 * `auditForbiddenTokens`（剥注释后扫），不用裸 not.toContain。
 */

const rendererSrc = (file: string): string =>
  readFileSync(resolve(import.meta.dirname, "../src/renderer/src", file), "utf8");

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

describe("运行列表 / 步骤目录：标题行折叠开关（任务 1.1）", () => {
  it("RunList：用共享 DisclosureButton 接 onToggleCollapsed，aria-controls 指向 run-navigation", () => {
    const src = rendererSrc("components/RunList.tsx");
    expect(src).toContain("DisclosureButton");
    expect(src).toContain('controls="run-navigation"');
    expect(src).toContain("onToggle={onToggleCollapsed}");
    // 收起/展开含义可见（不是只靠 aria-label 或箭头）；fullWidth 时动作是「返回」
    expect(src).toContain("收起运行列表");
    expect(src).toContain("返回当前运行");
    expect(src).toContain('{fullWidth ? "返回" : "收起"}');
  });

  it("SpanTree：同一套开关，aria-controls 指向 steps-navigation，写偏好路径不变", () => {
    const src = rendererSrc("components/SpanTree.tsx");
    expect(src).toContain("DisclosureButton");
    expect(src).toContain('controls="steps-navigation"');
    expect(src).toContain("onToggle={onToggleCollapsed}");
    expect(src).toContain("收起步骤目录");
  });

  it("浅色 16px 裸箭头不再是入口（剥注释后扫，两个面板都不得残留 ‹ 字符）", () => {
    // 禁用型断言走审计函数（纪律：裸 not.toContain 连注释都咬）
    expect(auditForbiddenTokens(rendererSrc("components/RunList.tsx"), ["‹"])).toEqual([]);
    expect(auditForbiddenTokens(rendererSrc("components/SpanTree.tsx"), ["‹"])).toEqual([]);
  });
});

describe("文件目录开关就近（任务 1.2）", () => {
  it("收起入口在目录列标题行内（sticky 容器），不在页头检查点行", () => {
    const src = rendererSrc("components/WorkspaceFileView.tsx");
    // 目录列标题行的 sticky 容器里有「目录」标题 + 收起按钮
    expect(src).toContain("目录</span>");
    // 常驻收起按钮带 aria-expanded="false"（点击后进入收起态；正则容忍缩进/换行）
    expect(src).toMatch(/aria-expanded="false"\s*\n\s*aria-label="收起文件目录（可随时重新展开）"/);
    // 非常驻时 pane 切换条按钮显示相反动作并带 aria-expanded
    expect(src).toContain('dirCollapsed ? "展开目录" : "收起目录"');
    expect(src).toContain('aria-expanded={dirCollapsed ? "false" : "true"}');
  });
});

describe("LongText：与页面折叠控制同一交互语义（任务 1.2）", () => {
  it("判据函数边界不变：> 阈值才折叠、摘要带字段/字数/动作", () => {
    expect(COLLAPSE_THRESHOLD).toBe(600);
    expect(shouldCollapse("a".repeat(600))).toBe(false);
    expect(shouldCollapse("a".repeat(601))).toBe(true);
    expect(collapsedLabel("abcd", "正文")).toBe("正文（4 字符，点击展开完整内容）");
  });

  it("折叠态：summary 带 ≥28px 命中区类与收起方向箭头；展开态箭头转正", () => {
    const collapsed = html(createElement(LongText, { text: "x".repeat(601), label: "正文" }));
    expect(collapsed).toContain("<details");
    expect(collapsed).toContain("min-h-[28px]");
    expect(collapsed).toContain("-rotate-90");
    expect(collapsed).toContain("（601 字符，点击展开完整内容）");

    const expanded = html(
      createElement(LongText, {
        text: "x".repeat(601),
        label: "正文",
        expanded: true,
        onToggle: () => {},
      }),
    );
    expect(expanded).not.toContain("-rotate-90");
    // 展开后完整原文在场（无截断）
    expect(expanded).toContain("x".repeat(601));
  });

  it("短文本不折叠、不出 summary（既有行为不变）", () => {
    const out = html(createElement(LongText, { text: "短文本", label: "正文" }));
    expect(out).not.toContain("<details");
    expect(out).toContain("短文本");
  });
});
