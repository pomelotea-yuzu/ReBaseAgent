/**
 * U1 任务 4.3 · 布局判据的 React 接线。
 *
 * 这里只做两件事：
 *   1. 订阅应用内容视口宽度（`documentElement.clientWidth`，D2 口径）；
 *   2. 把宽度 + 用户偏好 + 当前页签喂给 `lib/layout.ts` 的纯判据，返回结论。
 *
 * ⚠️ **自动折叠不写回偏好**：`navVisible` / `stepsVisible` 是"这一刻显示不显示"，
 *    与 `LayoutPrefs` 完全分开。宽度回来就自动恢复——因为偏好从没被改过。
 *    这不是"顺手也能存一下"的实现细节，是 D2 明写的纪律（见 `preservePrefs`）。
 */

import { useCallback, useEffect, useState } from "react";
import {
  type AuxPane,
  type Breakpoint,
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
  decideNavVisible,
  decideStepsVisible,
  initialLayoutPrefs,
  readContentWidth,
  stepWidth,
  stepsUseFullWorkspace,
} from "./layout";

/** 订阅应用内容视口宽度（resize 时重读） */
export function useContentWidth(): number {
  const [width, setWidth] = useState(() => readContentWidth());

  useEffect(() => {
    const onResize = (): void => setWidth(readContentWidth());
    window.addEventListener("resize", onResize);
    // 首次挂载重读一次：SSR/静态渲染下取到的可能是占位值
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return width;
}

export interface LayoutState {
  breakpoint: Breakpoint;
  prefs: LayoutPrefs;
  navVisible: boolean;
  stepsVisible: boolean;
  stepsFullWidth: boolean;
  /** <720 档：正文 / 辅助列表二选一 */
  auxPane: AuxPane;
  /** 临时打开导航（narrow/single 档） */
  navOpened: boolean;
  setNavOpened: (open: boolean) => void;
  stepsOpened: boolean;
  setStepsOpened: (open: boolean) => void;
  setAuxPane: (pane: AuxPane) => void;
  /** 拖拽/键盘设置导航宽度（夹到 220–360） */
  setNavWidth: (width: number) => void;
  /** 拖拽/键盘设置步骤目录宽度（夹到 200–320） */
  setStepsWidth: (width: number) => void;
  /** 用户显式收起/展开（**只有这个**会写偏好） */
  toggleNavCollapsed: () => void;
  openNav: () => void;
  closeNav: () => void;
  toggleStepsCollapsed: () => void;
  /** 键盘调整：返回是否已消费该键（false ⇒ 调用方不要 preventDefault） */
  handleNavKey: (key: string) => boolean;
  handleStepsKey: (key: string) => boolean;
  navWidth: number;
  stepsWidth: number;
}

/**
 * 外壳布局状态。
 *
 * `tab` 与 `editing` 是**输入**（由调用方从 store 取），因为"进文件页要收导航"
 * 这一条只在 960–1279 生效，判据需要它们。
 */
export function useLayoutState(input: {
  tab: "overview" | "steps" | "files";
  editing: boolean;
}): LayoutState {
  const contentWidth = useContentWidth();
  const [prefs, setPrefs] = useState<LayoutPrefs>(initialLayoutPrefs);
  const [navOpened, setNavOpened] = useState(false);
  const [stepsOpened, setStepsOpened] = useState(false);
  const [auxPane, setAuxPane] = useState<AuxPane>("main");

  const breakpoint = breakpointOf(contentWidth);

  // ⚠️ 断点变化时清掉临时打开：720–959 打开的导航在回到 ≥1280 后没有意义，
  //    留着会让"临时"变成"常驻"（偏好没变但看着像变了）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在断点**跨越**时复位临时打开，两个 setter 是稳定引用
  useEffect(() => {
    setNavOpened(false);
    setStepsOpened(false);
  }, [breakpoint]);

  const navVisible = decideNavVisible({
    breakpoint,
    prefs,
    tab: input.tab,
    editing: input.editing,
    navOpened,
  });

  const stepsVisible = decideStepsVisible({
    breakpoint,
    prefs,
    navVisible,
    navWidth: prefs.navWidth,
    contentWidth,
    stepsOpened,
  });

  const setNavWidth = useCallback((width: number) => {
    setPrefs((prev) => ({ ...prev, navWidth: clampNavWidth(width) }));
  }, []);

  const setStepsWidth = useCallback((width: number) => {
    setPrefs((prev) => ({ ...prev, stepsWidth: clampStepsWidth(width) }));
  }, []);

  const toggleNavCollapsed = useCallback(() => {
    setNavOpened(false);
    setPrefs((prev) => ({ ...prev, navUserCollapsed: !prev.navUserCollapsed }));
  }, []);

  const openNav = useCallback(() => {
    setStepsOpened(false);
    if (
      breakpoint === "wide" ||
      (breakpoint === "medium" && input.tab !== "files" && !input.editing)
    ) {
      setPrefs((prev) => ({ ...prev, navUserCollapsed: false }));
    } else {
      setNavOpened(true);
    }
  }, [breakpoint, input.tab, input.editing]);

  const closeNav = useCallback(() => {
    setNavOpened(false);
    if (!navOpened) setPrefs((prev) => ({ ...prev, navUserCollapsed: true }));
  }, [navOpened]);

  const toggleStepsCollapsed = useCallback(() => {
    if (stepsOpened) {
      setStepsOpened(false);
      return;
    }
    setPrefs((prev) => ({ ...prev, stepsUserCollapsed: !prev.stepsUserCollapsed }));
  }, [stepsOpened]);

  const handleNavKey = useCallback((key: string): boolean => {
    if (stepWidth(NAV_MIN, key, NAV_MIN, NAV_MAX) === null) return false;
    setPrefs((prev) => ({
      ...prev,
      navWidth: stepWidth(prev.navWidth, key, NAV_MIN, NAV_MAX) ?? prev.navWidth,
    }));
    return true;
  }, []);

  const handleStepsKey = useCallback((key: string): boolean => {
    if (stepWidth(STEPS_MIN, key, STEPS_MIN, STEPS_MAX) === null) return false;
    setPrefs((prev) => ({
      ...prev,
      stepsWidth: stepWidth(prev.stepsWidth, key, STEPS_MIN, STEPS_MAX) ?? prev.stepsWidth,
    }));
    return true;
  }, []);

  return {
    breakpoint,
    prefs,
    navVisible,
    stepsVisible,
    stepsFullWidth: stepsUseFullWorkspace({
      contentWidth,
      navVisible,
      navWidth: prefs.navWidth,
      stepsWidth: prefs.stepsWidth,
    }),
    auxPane,
    navOpened,
    setNavOpened,
    stepsOpened,
    setStepsOpened,
    setAuxPane,
    setNavWidth,
    setStepsWidth,
    toggleNavCollapsed,
    openNav,
    closeNav,
    toggleStepsCollapsed,
    handleNavKey,
    handleStepsKey,
    navWidth: prefs.navWidth,
    stepsWidth: prefs.stepsWidth,
  };
}

export { NAV_DEFAULT, STEPS_DEFAULT };
