import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * UI 密度 2.4（improve-workspace-reading-and-editing）：**专注模式**（design D3）。
 *
 * 专注 = 会话级**临时显示覆盖**：收起导航/步骤目录/草稿列表/消耗图，不写 `LayoutPrefs`、
 * 不写阅读状态；目标（run/span/tab/view）一变立即失效；主动调整布局先退出专注再写偏好。
 *
 * 三层断言（本包无 jsdom，`renderToStaticMarkup` 不跑 effect）：
 *   1. 纯 lib 判据（workspaceKeyOf / focusActiveFor / decideFocusLayout）——直接跑真函数；
 *   2. 源码接线契约（use-layout 状态机 + App 装配）——剥注释后按函数体/分支钉住；
 *   3. 组件静态渲染——专注栏与进入/退出入口的 DOM 证据。
 */

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, `../src/renderer/src/${rel}`), "utf8");

/** 剥块注释 + 行注释（源码契约断言连注释都咬会假红：注释字面量不是接线） */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

/** 取 `marker` 起到下一个空行为止的切片（useLayoutState 里各 useCallback 块间都有空行） */
const fnSlice = (src: string, marker: string): string => {
  const i = src.indexOf(marker);
  if (i < 0) return "";
  const end = src.indexOf("\n\n", i);
  return end < 0 ? src.slice(i) : src.slice(i, end);
};

// ---------------------------------------------------------------------------
// ① 纯 lib 判据
// ---------------------------------------------------------------------------

const { decideFocusLayout, focusActiveFor, workspaceKeyOf } = await import(
  "../src/renderer/src/lib/layout"
);

describe("2.4 专注判据：workspaceKeyOf（工作区身份）", () => {
  it("trace 视图细化到 tab/run/span，各段缺省落空串（不 undefined）", () => {
    expect(workspaceKeyOf({ view: "trace", tab: "steps", runId: "r1", spanId: "s9" })).toBe(
      "trace:steps:r1:s9",
    );
    expect(workspaceKeyOf({ view: "trace" })).toBe("trace:::");
    expect(workspaceKeyOf({ view: "trace", tab: "steps", runId: null, spanId: null })).toBe(
      "trace:steps::",
    );
  });

  it("非 trace 视图 = view 本身（创建/比较等无 run 概念的页面）", () => {
    expect(workspaceKeyOf({ view: "create" })).toBe("create");
    expect(workspaceKeyOf({ view: "compare" })).toBe("compare");
  });

  it("身份段变化 ⇒ key 变化（spec：目标一变立即失效）", () => {
    const base = workspaceKeyOf({ view: "trace", tab: "steps", runId: "r1", spanId: "s1" });
    expect(workspaceKeyOf({ view: "trace", tab: "steps", runId: "r1", spanId: "s2" })).not.toBe(
      base,
    );
    expect(workspaceKeyOf({ view: "trace", tab: "files", runId: "r1", spanId: "s1" })).not.toBe(
      base,
    );
    expect(workspaceKeyOf({ view: "trace", tab: "steps", runId: "r2", spanId: "s1" })).not.toBe(
      base,
    );
  });
});

describe("2.4 专注判据：focusActiveFor（身份比对，不靠 effect）", () => {
  const focus = { mode: "diff" as const, workspaceKey: "trace:steps:r1:s1" };

  it("同 key ⇒ 生效；key 异（含 null）⇒ 不生效", () => {
    expect(focusActiveFor(focus, "trace:steps:r1:s1")).toBe(true);
    expect(focusActiveFor(focus, "trace:steps:r1:s2")).toBe(false);
    expect(focusActiveFor(focus, null)).toBe(false);
  });

  it("无 focus ⇒ 不生效（退出后的常态）", () => {
    expect(focusActiveFor(null, "trace:steps:r1:s1")).toBe(false);
  });
});

describe("2.4 专注判据：decideFocusLayout（派生显示布局，不写偏好）", () => {
  it("生效 ⇒ 导航与步骤目录按显示层收起", () => {
    const out = decideFocusLayout({
      focus: { mode: "edit", workspaceKey: "k" },
      workspaceKey: "k",
      navVisible: true,
      stepsVisible: true,
    });
    expect(out).toEqual({ active: true, navVisible: false, stepsVisible: false });
  });

  it("不生效 ⇒ 原样透传（当前有效偏好/派生决定）", () => {
    const out = decideFocusLayout({
      focus: { mode: "edit", workspaceKey: "k" },
      workspaceKey: "other",
      navVisible: true,
      stepsVisible: true,
    });
    expect(out).toEqual({ active: false, navVisible: true, stepsVisible: true });
  });
});

// ---------------------------------------------------------------------------
// ② 源码接线契约：use-layout 状态机（2.4b：写偏好入口先退出专注）
// ---------------------------------------------------------------------------

describe("2.4b use-layout：focus 状态机与「主动调整先退出」", () => {
  const SRC = stripComments(read("lib/use-layout.ts"));

  it("focus 是会话级 useState（不进 LayoutPrefs、无持久化）", () => {
    expect(SRC).toContain("const [focus, setFocus] = useState<WorkspaceFocus | null>(null);");
    expect(SRC).toContain("const enterFocus = useCallback(");
    expect(SRC).toContain("setFocus({ mode, workspaceKey });");
    expect(fnSlice(SRC, "const enterFocus = useCallback(")).not.toContain("setPrefs");
    expect(fnSlice(SRC, "const exitFocus = useCallback(")).toContain("setFocus(null);");
  });

  it("8 个写偏好入口全部先 setFocus(null)：调整成为新偏好，退出不回滚", () => {
    for (const name of [
      "setNavWidth",
      "setStepsWidth",
      "toggleNavCollapsed",
      "openNav",
      "closeNav",
      "toggleStepsCollapsed",
      "handleNavKey",
      "handleStepsKey",
    ]) {
      const slice = fnSlice(SRC, `const ${name} = useCallback(`);
      expect(slice, `${name} 缺 setFocus(null)`).toContain("setFocus(null);");
    }
  });

  it("返回值把 focus/enterFocus/exitFocus 交给调用方（App 才能接线）", () => {
    expect(SRC).toMatch(/return\s*\{[\s\S]*?\bfocus,\s*\n\s*enterFocus,\s*\n\s*exitFocus,/);
  });
});

// ---------------------------------------------------------------------------
// ② 源码接线契约：App.tsx 装配
// ---------------------------------------------------------------------------

describe("2.4 App 装配：身份 key、effect 清空、显示层收起", () => {
  const APP = stripComments(read("App.tsx"));

  it("workspaceKey/focusActive 来自共享判据（App 不自抄身份规则）", () => {
    expect(APP).toContain('import { focusActiveFor, workspaceKeyOf } from "./lib/layout";');
    expect(APP).toMatch(/const focusActive = focusActiveFor\(layout\.focus, workspaceKey\);/);
  });

  it("目标变化即清空 focus（不只是判定失效——防返回同目标自动重入）", () => {
    expect(APP).toContain(
      "if (layout.focus !== null && layout.focus.workspaceKey !== workspaceKey) {",
    );
    expect(
      fnSlice(APP, "if (layout.focus !== null && layout.focus.workspaceKey !== workspaceKey)"),
    ).toContain("layout.exitFocus();");
  });

  it("专注下步骤目录不占满工作区、导航与 SpanTree 按显示层收起", () => {
    expect(fnSlice(APP, "const stepsReplaceWorkspace =")).toContain("!focusActive");
    expect(APP).toMatch(/const navShowing = focusActive\s*\?\s*false/);
    expect(APP).toContain('tab === "steps" && layout.stepsVisible && !focusActive');
  });

  it("WorkspaceShell 接收专注态与进入/退出动作（enterFocus 带当前 workspaceKey）", () => {
    expect(APP).toContain("onEnterFocus={(mode) => layout.enterFocus(mode, workspaceKey)}");
    expect(APP).toContain("onExitFocus={layout.exitFocus}");
    expect(APP).toContain("focusActive={focusActive}");
  });

  it("WorkspaceShell 把专注 props 下传给文件页与步骤页两条承载", () => {
    // WorkspaceShell 是 App.tsx 最后一个组件；函数体跨多个空行块 ⇒ 切到文件尾
    const slice = APP.slice(APP.indexOf("function WorkspaceShell("));
    expect(slice).toContain("focusActive={focusActive}");
    expect(slice).toContain("onEnterFocus={onEnterFocus}");
    expect(slice).toContain("onExitFocus={onExitFocus}");
    expect(slice).toContain("<WorkspaceFilesPanel");
    expect(slice).toContain("<DetailPanel");
  });
});

// ---------------------------------------------------------------------------
// ③ 组件静态渲染：专注栏与入口（DOM 证据）
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = { api: {} };

const { WorkspaceFilesPanelView } = await import(
  "../src/renderer/src/components/WorkspaceFilesPanel"
);
const { DetailPanel } = await import("../src/renderer/src/components/DetailPanel");

describe("2.4 WorkspaceFilesPanelView：专注差异栏（静态渲染）", () => {
  it("focusActive ⇒ 顶部专注栏 + 退出入口（spec：专注中目标和恢复操作可见）", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceFilesPanelView, {
        detail: null,
        loadingDetail: false,
        focusActive: true,
        onExitFocus: () => {},
      }),
    );
    expect(html).toContain('data-focus-bar="files-diff"');
    expect(html).toContain('data-exit-focus="true"');
    expect(html).toContain("退出专注");
    expect(html).not.toContain("专注差异</button>");
  });

  it("未专注 + 有 onEnterFocus ⇒ 渲染「专注差异」入口（不渲染专注栏）", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceFilesPanelView, {
        detail: null,
        loadingDetail: false,
        onEnterFocus: () => {},
      }),
    );
    expect(html).toContain('data-enter-focus="diff"');
    expect(html).not.toContain("data-focus-bar");
  });

  it("没有任何专注 props ⇒ 两样都不渲染（默认形态零噪音）", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceFilesPanelView, { detail: null, loadingDetail: false }),
    );
    expect(html).not.toContain("data-focus-bar");
    expect(html).not.toContain("data-enter-focus");
  });
});

describe("2.4 DetailPanel：专注编辑栏（静态渲染 + 源码契约）", () => {
  it("focusActive ⇒ 顶部专注栏 + 退出入口", () => {
    const html = renderToStaticMarkup(
      createElement(DetailPanel, { focusActive: true, onExitFocus: () => {} }),
    );
    expect(html).toContain('data-focus-bar="edit"');
    expect(html).toContain('data-exit-focus="true"');
  });

  it("未专注 + 有 onEnterFocus ⇒ 渲染「专注编辑」入口", () => {
    const html = renderToStaticMarkup(createElement(DetailPanel, { onEnterFocus: () => {} }));
    expect(html).toContain('data-enter-focus="edit"');
    expect(html).not.toContain("data-focus-bar");
  });

  it("源码契约：草稿列表与消耗图仅在未专注时渲染；DetailNotices 无条件保留", () => {
    const SRC = stripComments(read("components/DetailPanel.tsx"));
    expect(SRC).toContain("{!focusActive && selectedRunId !== null ? (");
    expect(SRC).toContain("{!focusActive && detail !== null ? (");
    expect(SRC).toContain("<DetailNotices />");
  });
});
