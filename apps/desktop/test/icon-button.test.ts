import { RefreshCw, Settings, X } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconButton, TextIconButton } from "../src/renderer/src/components/IconButton";
import {
  actionTitle,
  auditAccessibleAction,
  looksLikeIdentifier,
} from "../src/renderer/src/lib/a11y-action";

/**
 * U1（refactor-run-workspace）任务 4.1：图标按钮的名称/焦点契约与阅读字号令牌。
 *
 * 判据来源：desktop-ui delta 场景「键盘导航及工具名称」——
 *   「操作有可见焦点和可访问名称，关闭返回合理焦点，不触发取消执行；
 *     图标悬停可辨用途，长内容和状态无需仅靠颜色理解」
 * 以及 design D2 的字号表（正文 14 / 代码 13 / 辅助 12 / 标题 18，字距 0）。
 *
 * ⚠️ 本包无 jsdom：组件层只能做 `renderToStaticMarkup` 的静态断言，
 *    **真实 Tab 顺序、焦点环渲染、hover tooltip 弹出均未在此覆盖**（归 7.3 键盘实测）。
 *    这里钉的是"属性契约"——名称存在、状态不只靠颜色、禁用带原因。
 */

describe("图标按钮的可访问名称（名称是内容，不是样式）", () => {
  it("纯图标按钮渲染出 aria-label 与 title，且图标对读屏隐藏", () => {
    const html = renderToStaticMarkup(
      createElement(IconButton, { icon: RefreshCw, label: "刷新运行列表", onClick: () => {} }),
    );
    expect(html).toContain('aria-label="刷新运行列表"');
    expect(html).toContain('title="刷新运行列表"');
    // 图标本身不该被读成内容（名称已经在按钮上）
    expect(html).toContain('aria-hidden="true"');
  });

  it("图标声明为「装饰」：不由本组件纳入可访问树，也不进 Tab 序列", () => {
    const html = renderToStaticMarkup(
      createElement(IconButton, { icon: Settings, label: "打开运行配置", onClick: () => {} }),
    );
    // ⚠️ lucide **自己**就会输出 aria-hidden="true"（实测），所以只断言它等于测库不测自己。
    //    这里断言本组件显式负责的两项：focusable（不进 Tab 序列）与 role=presentation。
    expect(html).toMatch(/<svg[^>]*focusable="false"/);
    expect(html).toMatch(/<svg[^>]*role="presentation"/);
    // 名称在按钮上：读屏念"打开运行配置，按钮"，不会再多念一个图形
    expect(html).toContain('aria-label="打开运行配置"');
  });

  it("装饰性图标属性常量被真正应用到两个按钮上（防「定义了没用」）", () => {
    const iconHtml = renderToStaticMarkup(
      createElement(IconButton, { icon: X, label: "关闭", onClick: () => {} }),
    );
    const textHtml = renderToStaticMarkup(
      createElement(TextIconButton, { icon: X, onClick: () => {} }, "关闭"),
    );
    for (const html of [iconHtml, textHtml]) {
      expect(html).toContain('focusable="false"');
      expect(html).toContain('role="presentation"');
    }
  });

  it("带 hint 时 title 拼出原因（悬停可辨），aria-label 仍只有名称", () => {
    const html = renderToStaticMarkup(
      createElement(IconButton, {
        icon: RefreshCw,
        label: "刷新运行列表",
        hint: "源记录不可用",
        onClick: () => {},
      }),
    );
    expect(html).toContain('title="刷新运行列表（源记录不可用）"');
    // aria-label 保持纯名称（提示语不该混进可访问名称）
    expect(html).toContain('aria-label="刷新运行列表"');
    expect(html).not.toContain('aria-label="刷新运行列表（源记录不可用）"');
  });

  it("激活态走 aria-pressed，不只靠颜色", () => {
    const off = renderToStaticMarkup(
      createElement(IconButton, { icon: RefreshCw, label: "只看代理录制", onClick: () => {} }),
    );
    const on = renderToStaticMarkup(
      createElement(IconButton, {
        icon: RefreshCw,
        label: "只看代理录制",
        active: true,
        hint: "已启用",
        onClick: () => {},
      }),
    );
    expect(off).not.toContain("aria-pressed");
    expect(on).toContain('aria-pressed="true"');
  });

  it("禁用态是 DOM 级 disabled（不是只调透明度骗人）", () => {
    const html = renderToStaticMarkup(
      createElement(IconButton, {
        icon: RefreshCw,
        label: "刷新运行列表",
        disabled: true,
        hint: "正在刷新",
        onClick: () => {},
      }),
    );
    expect(html).toContain("disabled");
  });

  it("焦点样式类存在（focus-visible 环，不是 focus）", () => {
    const html = renderToStaticMarkup(
      createElement(IconButton, { icon: X, label: "关闭", onClick: () => {} }),
    );
    // 用 focus-visible 而非 focus：鼠标点击不该留焦点环
    expect(html).toContain("focus-visible:ring-2");
    expect(html).not.toMatch(/[^:-]focus:ring/);
  });

  it("图标 + 文字按钮：名称即可见文字，title 带可见名，不重复声明 aria-label", () => {
    const html = renderToStaticMarkup(
      createElement(TextIconButton, { icon: RefreshCw, onClick: () => {} }, "刷新"),
    );
    expect(html).toContain("刷新");
    expect(html).toContain('title="刷新"');
    // 有可见文字时不再加 aria-label（否则读屏会把名称读两遍）
    expect(html).not.toContain("aria-label");
  });
});

describe("可访问性判据（纯函数，供后续 4.x 接线复用）", () => {
  it("空名称 ⇒ missing-name（纯图标无名称是硬错误）", () => {
    const issues = auditAccessibleAction({ label: "  " });
    expect(issues.map((i) => i.kind)).toContain("missing-name");
  });

  it("标识符式名称 ⇒ identifier-leak（RefreshCw 不是给人读的）", () => {
    expect(looksLikeIdentifier("RefreshCw")).toBe(true);
    expect(looksLikeIdentifier("refresh-cw")).toBe(true);
    expect(looksLikeIdentifier("list_reload")).toBe(true);

    expect(auditAccessibleAction({ label: "RefreshCw" }).map((i) => i.kind)).toContain(
      "identifier-leak",
    );
  });

  it("自然语言名称通过（中文、含空格的英文、单个中文词）", () => {
    expect(looksLikeIdentifier("刷新")).toBe(false);
    expect(looksLikeIdentifier("Refresh runs")).toBe(false);
    expect(looksLikeIdentifier("刷新运行列表")).toBe(false);
    for (const label of ["刷新", "Refresh runs", "刷新运行列表"]) {
      expect(auditAccessibleAction({ label })).toEqual([]);
    }
  });

  it("禁用但没说原因 ⇒ disabled-without-reason（用户会反复点灰按钮）", () => {
    const issues = auditAccessibleAction({ label: "重新读取", disabled: true });
    expect(issues.map((i) => i.kind)).toEqual(["disabled-without-reason"]);
    // 给了原因就合格
    expect(auditAccessibleAction({ label: "重新读取", disabled: true, hint: "正在刷新" })).toEqual(
      [],
    );
  });

  it("激活态没有任何文字/title 载体 ⇒ color-only-state（不得只靠颜色理解状态）", () => {
    const issues = auditAccessibleAction({ label: "只看代理录制", active: true });
    expect(issues.map((i) => i.kind)).toEqual(["color-only-state"]);
    // 有 hint 或可见文字即可
    expect(auditAccessibleAction({ label: "只看代理录制", active: true, hint: "已启用" })).toEqual(
      [],
    );
    expect(
      auditAccessibleAction({ label: "只看代理录制", active: true, hasVisibleText: true }),
    ).toEqual([]);
  });

  it("多个问题一次报全（不是遇到第一个就返回）", () => {
    const issues = auditAccessibleAction({ label: "RefreshCw", disabled: true });
    expect(issues.map((i) => i.kind).sort()).toEqual([
      "disabled-without-reason",
      "identifier-leak",
    ]);
  });

  it("空名称时也报全其余问题（早退会让调试者一次只修一个）", () => {
    // label 为空同时 disabled 无原因 ⇒ 两条都要报出来。
    // （只测"非空 label"的多问题用例会让"空名称就早退"这一变异漏网——已实测）
    const issues = auditAccessibleAction({ label: "", disabled: true });
    expect(issues.map((i) => i.kind).sort()).toEqual(["disabled-without-reason", "missing-name"]);
    // 空名称 + 激活态也要一起报（不只报 missing-name）
    const issues2 = auditAccessibleAction({ label: "  ", active: true });
    expect(issues2.map((i) => i.kind).sort()).toEqual(["color-only-state", "missing-name"]);
  });

  it("title 组装：空 hint 不产生空括号", () => {
    expect(actionTitle("刷新", undefined)).toBe("刷新");
    expect(actionTitle("刷新", "")).toBe("刷新");
    expect(actionTitle("刷新", "   ")).toBe("刷新");
    expect(actionTitle("刷新", "正在刷新")).toBe("刷新（正在刷新）");
  });
});
