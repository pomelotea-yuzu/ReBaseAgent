import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stepsUseFullWorkspace } from "../src/renderer/src/lib/layout";
import {
  BREAKPOINTS,
  DETAIL_MIN_WIDTH,
  type LayoutPrefs,
  NAV_DEFAULT,
  NAV_MAX,
  NAV_MIN,
  STEPS_DEFAULT,
  STEPS_MAX,
  STEPS_MIN,
  breakpointOf,
  clampNavWidth,
  clampStepsWidth,
  clampWidth,
  decideNavVisible,
  decideStepsVisible,
  initialLayoutPrefs,
  preservePrefs,
  stepWidth,
} from "../src/renderer/src/lib/layout";

/**
 * U1 任务 4.3：外壳布局判据（design D2）。
 *
 * 判据来源：desktop-ui delta 场景
 *   - 「自动折叠后恢复用户布局」：屏幕不够宽时自动收起，宽度恢复后**还原用户偏好**。
 *   - 「多尺寸与放大下关键阅读可达」：正文至少 480px 的硬约束。
 *   - 「键盘导航及工具名称」：键盘调整宽度并夹到合法范围。
 *
 * ⚠️ 本文件只测**纯判据**。真实的 `document.documentElement.clientWidth` 换算、
 *    拖拽事件、CSS 生效、Electron 200% 缩放均**未实测**（归 7.1/7.2）。
 */

const prefs = (over: Partial<LayoutPrefs> = {}): LayoutPrefs => ({
  ...initialLayoutPrefs,
  ...over,
});

describe("断点换算：用应用内容视口 CSS 宽度（不是原生窗口宽）", () => {
  it("四档边界各就位（1280 / 960 / 720）", () => {
    expect(breakpointOf(1440)).toBe("wide");
    expect(breakpointOf(1280)).toBe("wide");
    expect(breakpointOf(1279)).toBe("medium");
    expect(breakpointOf(960)).toBe("medium");
    expect(breakpointOf(959)).toBe("narrow");
    expect(breakpointOf(720)).toBe("narrow");
    expect(breakpointOf(719)).toBe("single");
    expect(breakpointOf(640)).toBe("single");
  });

  it("断点阈值常量与 design D2 表一致", () => {
    expect(BREAKPOINTS).toEqual([1280, 960, 720]);
  });
});

describe("宽度夹取：夹到合法范围，非法值回默认（不用 min 冒充）", () => {
  it("导航 220–360，默认 264", () => {
    expect(NAV_MIN).toBe(220);
    expect(NAV_MAX).toBe(360);
    expect(NAV_DEFAULT).toBe(264);
    expect(clampNavWidth(180)).toBe(220);
    expect(clampNavWidth(400)).toBe(360);
    expect(clampNavWidth(300)).toBe(300);
  });

  it("步骤目录 200–320，默认 232", () => {
    expect(STEPS_MIN).toBe(200);
    expect(STEPS_MAX).toBe(320);
    expect(STEPS_DEFAULT).toBe(232);
    expect(clampStepsWidth(100)).toBe(200);
    expect(clampStepsWidth(999)).toBe(320);
  });

  it("NaN / Infinity 回默认值，而不是静默夹到 min（那会把宽度改小）", () => {
    expect(clampNavWidth(Number.NaN)).toBe(NAV_DEFAULT);
    expect(clampNavWidth(Number.POSITIVE_INFINITY)).toBe(NAV_DEFAULT);
    expect(clampNavWidth(Number.NEGATIVE_INFINITY)).toBe(NAV_DEFAULT);
    expect(clampWidth(Number.NaN, 10, 20, 15)).toBe(15);
  });
});

describe("键盘调整：步进与边界", () => {
  it("方向键 ±16px 并夹到范围", () => {
    expect(stepWidth(264, "ArrowRight", NAV_MIN, NAV_MAX)).toBe(280);
    expect(stepWidth(264, "ArrowLeft", NAV_MIN, NAV_MAX)).toBe(248);
    expect(stepWidth(355, "ArrowRight", NAV_MIN, NAV_MAX)).toBe(360);
    expect(stepWidth(225, "ArrowLeft", NAV_MIN, NAV_MAX)).toBe(220);
  });

  it("Home / End 直达边界", () => {
    expect(stepWidth(300, "Home", NAV_MIN, NAV_MAX)).toBe(220);
    expect(stepWidth(300, "End", NAV_MIN, NAV_MAX)).toBe(360);
  });

  it("无关按键返回 null（调用方不得 preventDefault，否则吞掉别的快捷键）", () => {
    expect(stepWidth(264, "ArrowUp", NAV_MIN, NAV_MAX)).toBe(null);
    expect(stepWidth(264, "a", NAV_MIN, NAV_MAX)).toBe(null);
    expect(stepWidth(264, "Enter", NAV_MIN, NAV_MAX)).toBe(null);
  });
});

describe("导航可见性：四档 + 用户偏好优先", () => {
  it("≥1280 常驻", () => {
    expect(
      decideNavVisible({
        breakpoint: "wide",
        prefs: prefs(),
        tab: "overview",
        editing: false,
        navOpened: false,
      }),
    ).toBe(true);
  });

  it("960–1279 概览保留导航", () => {
    expect(
      decideNavVisible({
        breakpoint: "medium",
        prefs: prefs(),
        tab: "overview",
        editing: false,
        navOpened: false,
      }),
    ).toBe(true);
  });

  it("960–1279 进入文件页暂时收起导航（用户偏好不变）", () => {
    expect(
      decideNavVisible({
        breakpoint: "medium",
        prefs: prefs(),
        tab: "files",
        editing: false,
        navOpened: false,
      }),
    ).toBe(false);
  });

  it("960–1279 编辑态暂时收起导航", () => {
    expect(
      decideNavVisible({
        breakpoint: "medium",
        prefs: prefs(),
        tab: "overview",
        editing: true,
        navOpened: false,
      }),
    ).toBe(false);
  });

  it("720–959 默认收起，临时打开才显示", () => {
    expect(
      decideNavVisible({
        breakpoint: "narrow",
        prefs: prefs(),
        tab: "overview",
        editing: false,
        navOpened: false,
      }),
    ).toBe(false);
    expect(
      decideNavVisible({
        breakpoint: "narrow",
        prefs: prefs(),
        tab: "overview",
        editing: false,
        navOpened: true,
      }),
    ).toBe(true);
  });

  it("<720 单工作区，默认不显示导航", () => {
    expect(
      decideNavVisible({
        breakpoint: "single",
        prefs: prefs(),
        tab: "overview",
        editing: false,
        navOpened: false,
      }),
    ).toBe(false);
  });

  it("用户显式收起后，即使 ≥1280 也不显示（只有临时打开能盖过去）", () => {
    const collapsed = prefs({ navUserCollapsed: true });
    expect(
      decideNavVisible({
        breakpoint: "wide",
        prefs: collapsed,
        tab: "overview",
        editing: false,
        navOpened: false,
      }),
    ).toBe(false);
    expect(
      decideNavVisible({
        breakpoint: "wide",
        prefs: collapsed,
        tab: "overview",
        editing: false,
        navOpened: true,
      }),
    ).toBe(true);
  });

  it("**自动折叠不写回偏好**：同一次调用不改动 prefs（宽度恢复后即还原）", () => {
    const p = prefs({ navWidth: 340 });
    const snapshot = { ...p };
    // 窄窗口下自动收起
    decideNavVisible({
      breakpoint: "narrow",
      prefs: p,
      tab: "overview",
      editing: false,
      navOpened: false,
    });
    expect(p).toEqual(snapshot);
    // 回宽窗口：用户 340px 偏好原样生效
    expect(p.navWidth).toBe(340);
    expect(
      decideNavVisible({
        breakpoint: "wide",
        prefs: p,
        tab: "overview",
        editing: false,
        navOpened: false,
      }),
    ).toBe(true);
  });
});

describe("步骤目录可见性：480px 二次约束是硬约束", () => {
  const base = {
    breakpoint: "wide" as const,
    prefs: prefs(),
    navVisible: true,
    navWidth: NAV_DEFAULT,
    contentWidth: 1440,
    stepsOpened: false,
  };

  it("1440 宽、导航 264、目录 232 ⇒ 详情 944 ≥ 480，目录显示", () => {
    expect(decideStepsVisible(base)).toBe(true);
  });

  it("1024 宽、导航 264、目录 232 ⇒ 详情 528 ≥ 480，目录显示", () => {
    expect(decideStepsVisible({ ...base, contentWidth: 1024 })).toBe(true);
  });

  it("宽度不够（详情会跌破 480）⇒ **自动收起步骤目录**", () => {
    // 264 + 232 = 496；contentWidth 960 ⇒ 详情 464 < 480 ⇒ 收起
    expect(decideStepsVisible({ ...base, breakpoint: "medium", contentWidth: 960 })).toBe(false);
  });

  it("恰好 480 时保留（边界含等号）", () => {
    // 480 + 264 + 232 = 976
    expect(decideStepsVisible({ ...base, breakpoint: "medium", contentWidth: 976 })).toBe(true);
    // 975 ⇒ 479 < 480 ⇒ 收起
    expect(decideStepsVisible({ ...base, breakpoint: "medium", contentWidth: 975 })).toBe(false);
  });

  it("导航已自动收起时，节省出的宽度可以留住步骤目录", () => {
    // 导航收起 ⇒ 只扣 232；contentWidth 960 ⇒ 详情 728 ≥ 480
    expect(
      decideStepsVisible({ ...base, breakpoint: "medium", navVisible: false, contentWidth: 960 }),
    ).toBe(true);
  });

  it("用户把步骤目录拖宽后，同宽度下可能被 480 约束收起（约束优先于偏好）", () => {
    const wide = prefs({ stepsWidth: STEPS_MAX });
    // 320 + 264 = 584；contentWidth 1024 ⇒ 440 < 480 ⇒ 收起
    expect(
      decideStepsVisible({ ...base, breakpoint: "medium", prefs: wide, contentWidth: 1024 }),
    ).toBe(false);
    expect(
      decideStepsVisible({
        ...base,
        breakpoint: "medium",
        prefs: wide,
        contentWidth: 1024,
        stepsOpened: true,
      }),
    ).toBe(true);
    expect(
      stepsUseFullWorkspace({
        contentWidth: 1024,
        navVisible: true,
        navWidth: 264,
        stepsWidth: 320,
      }),
    ).toBe(true);
  });

  it("临时目录不足 480px 正文时替换工作区，足够时并排", () => {
    expect(
      stepsUseFullWorkspace({
        contentWidth: 720,
        navVisible: false,
        navWidth: 264,
        stepsWidth: 320,
      }),
    ).toBe(true);
    expect(
      stepsUseFullWorkspace({
        contentWidth: 800,
        navVisible: false,
        navWidth: 264,
        stepsWidth: 320,
      }),
    ).toBe(false);
    expect(
      stepsUseFullWorkspace({
        contentWidth: 640,
        navVisible: false,
        navWidth: 264,
        stepsWidth: 200,
      }),
    ).toBe(true);
  });

  it("720–959 按需打开", () => {
    expect(decideStepsVisible({ ...base, breakpoint: "narrow", stepsOpened: false })).toBe(false);
    expect(decideStepsVisible({ ...base, breakpoint: "narrow", stepsOpened: true })).toBe(true);
  });

  it("自动收起不改动用户偏好（同上次宽度即还原）", () => {
    const p = prefs({ stepsWidth: 300 });
    const snapshot = { ...p };
    decideStepsVisible({ ...base, breakpoint: "medium", prefs: p, contentWidth: 960 });
    expect(p).toEqual(snapshot);
    expect(p.stepsWidth).toBe(300);
  });

  it("DETAIL_MIN_WIDTH 常量是 480（不是软性建议）", () => {
    expect(DETAIL_MIN_WIDTH).toBe(480);
  });
});

describe("preservePrefs：任何「把当前可见性存回偏好」都是错的", () => {
  it("原样返回（自动折叠只影响显示）", () => {
    const p = prefs({ navWidth: 300, navUserCollapsed: true });
    expect(preservePrefs(p)).toBe(p);
  });

  it("用户显式收起 ≠ 自动折叠：后者不该写进 navUserCollapsed", () => {
    const p = prefs();
    decideNavVisible({
      breakpoint: "narrow",
      prefs: p,
      tab: "overview",
      editing: false,
      navOpened: false,
    });
    // 自动折叠走完了，但用户偏好里"我主动收起了吗"仍然是 false
    expect(p.navUserCollapsed).toBe(false);
  });
});

/**
 * 接线契约（任务 4.3）：宽度判据必须在**外壳**统一算，不能散进各面板。
 *
 * ⚠️ 本包无 jsdom ⇒ 拖拽与真实 CSS 生效打不到。这里用源码级断言钉住三件事：
 *    ① 导航/步骤目录的宽度与夹取都来自外壳传入（组件不自己算 220–360）；
 *    ② 外壳用 `useLayoutState` 消费判据，而不是自己写断点 if；
 *    ③ 断点口径是 `document.documentElement.clientWidth`（不是 innerWidth）。
 *    真实的 1440/1360/1024/800/640 几何与 Electron 200% 缩放归 7.1/7.2。
 */
describe("接线契约：宽度由外壳统一判（源码）", () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, "..", rel), "utf8");

  it("RunList / SpanTree 的宽度来自 props，不自己写死 w-80 / w-96", () => {
    for (const f of [
      "src/renderer/src/components/RunList.tsx",
      "src/renderer/src/components/SpanTree.tsx",
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/className="[^"]*\bw-80\b/);
      expect(src).not.toMatch(/className="[^"]*\bw-96\b/);
      expect(src).toContain('{ width: "100%", minWidth: 0 } : { width, minWidth: width }');
      expect(src).toContain("<ResizeGrip");
    }
  });

  it("两个面板都从 layout.ts 取范围常量（不在组件里另抄一遍 220/360）", () => {
    expect(read("src/renderer/src/components/RunList.tsx")).toContain('from "../lib/layout"');
    expect(read("src/renderer/src/components/SpanTree.tsx")).toContain('from "../lib/layout"');
    expect(read("src/renderer/src/components/SpanTree.tsx")).toContain("STEPS_MIN");
    expect(read("src/renderer/src/components/SpanTree.tsx")).toContain("STEPS_MAX");
  });

  it("App 用 useLayoutState 消费判据（不自写断点 if）", () => {
    const src = read("src/renderer/src/App.tsx");
    expect(src).toContain("useLayoutState");
    expect(src).toContain("layout.navVisible");
    expect(src).toContain("layout.stepsVisible");
    // 判据只在 lib 里，App 不得出现裸断点数字
    expect(src).not.toMatch(/1280|960|720/);
  });

  it("内容宽度口径是 documentElement.clientWidth（D2 明确不是 innerWidth）", () => {
    const src = read("src/renderer/src/lib/layout.ts");
    expect(src).toContain("document.documentElement.clientWidth");
    // ⚠️ 只查**代码行**，不查注释——源码注释里正解释"为什么不用 innerWidth"
    const codeLines = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(codeLines.join("\n")).not.toContain("innerWidth");
  });
});
