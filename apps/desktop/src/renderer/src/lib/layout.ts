/**
 * U1 任务 4.3 · 外壳布局判据（design D2）。
 *
 * 全部是**纯函数**：输入「应用内容视口 CSS 宽度 + 用户偏好」，输出「该显示什么」。
 * 组件只消费结论，不自己算——宽度规则散在 JSX 里正是 D2 要避免的形态。
 *
 * 三条纪律（都在 D2 原文里）：
 *   1. **断点用整个应用内容视口的 CSS 宽度**（`document.documentElement.clientWidth`），
 *      不是含边框的原生窗口宽度，也不是扣除运行导航后的主工作区宽度。换算口径错一位，
 *      四档行为全错。
 *   2. **自动折叠与用户偏好是两码事**：屏幕不够宽时临时收起，宽度恢复后要**还原用户
 *      自己拖的宽度**。自动折叠**不写入**偏好，否则用户回宽窗口会发现宽度被改掉了。
 *   3. **正文至少 480px 是硬约束**：步骤目录出现时必须保证详情列 ≥480px，否则收起步骤目录。
 *      「步骤目录出现时正文最小 528px」是这条约束在原型实测下的结果，不是另立的阈值。
 */

/** 应用内容视口宽度 → 四档断点（与原型 `bpOf` 同口径） */
export const BREAKPOINTS = [1280, 960, 720] as const;
export type Breakpoint = "wide" | "medium" | "narrow" | "single";

export function breakpointOf(contentWidth: number): Breakpoint {
  if (contentWidth >= 1280) return "wide";
  if (contentWidth >= 960) return "medium";
  if (contentWidth >= 720) return "narrow";
  return "single";
}

/** 运行导航宽度范围与默认值（D2） */
export const NAV_MIN = 220;
export const NAV_MAX = 360;
export const NAV_DEFAULT = 264;

/** 步骤目录宽度范围与默认值（D2） */
export const STEPS_MIN = 200;
export const STEPS_MAX = 320;
export const STEPS_DEFAULT = 232;

/** 详情正文的硬下限（D2：不可协商的最小宽度） */
export const DETAIL_MIN_WIDTH = 480;

/**
 * 把任意宽度夹到 [min, max]。
 *
 * `NaN` / 非有限值一律回默认值——不用"夹到 min"冒充用户意图（那会静默把宽度改小）。
 */
export function clampWidth(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function clampNavWidth(value: number): number {
  return clampWidth(value, NAV_MIN, NAV_MAX, NAV_DEFAULT);
}

export function clampStepsWidth(value: number): number {
  return clampWidth(value, STEPS_MIN, STEPS_MAX, STEPS_DEFAULT);
}

/**
 * 键盘调整一步。
 *
 * `ArrowRight/ArrowLeft` 按 16px 步进，`Home/End` 直接到边界（原型同口径）。
 * 返回 `null` = 该键不调整宽度，调用方**不要** `preventDefault`（否则会吞掉别的快捷键）。
 */
export function stepWidth(current: number, key: string, min: number, max: number): number | null {
  const cur = clampWidth(current, min, max, min);
  switch (key) {
    case "ArrowRight":
      return clampWidth(cur + 16, min, max, min);
    case "ArrowLeft":
      return clampWidth(cur - 16, min, max, min);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

/** 用户偏好（本会话内有效，不持久化） */
export interface LayoutPrefs {
  /** 用户拖/键设的导航宽度（永远在合法范围内） */
  navWidth: number;
  /** 用户拖/键设的步骤目录宽度 */
  stepsWidth: number;
  /** 用户**显式**收起导航（与"屏幕不够宽"不同） */
  navUserCollapsed: boolean;
  /** 用户**显式**收起步骤目录 */
  stepsUserCollapsed: boolean;
}

export const initialLayoutPrefs: LayoutPrefs = {
  navWidth: NAV_DEFAULT,
  stepsWidth: STEPS_DEFAULT,
  navUserCollapsed: false,
  stepsUserCollapsed: false,
};

/**
 * 当前该不该显示运行导航。
 *
 * ⚠️ **自动折叠不写回 `LayoutPrefs`**：这里的 `visible` 只是"这一刻显示不显示"，
 *    用户偏好原封不动。宽度回到 ≥960 时自动恢复——因为偏好从没被改过。
 *
 * 四档（D2 表）：
 *   - wide(≥1280)：用户没收起就常驻
 *   - medium(960–1279)：概览保留导航；**进入文件页或现有编辑态暂时收起**
 *   - narrow(720–959)：按需打开（默认收起，由 `navOpened` 临时打开）
 *   - single(<720)：单工作区，辅助列表**替换**正文（由 `auxPane` 决定看哪边）
 */
export function decideNavVisible(input: {
  breakpoint: Breakpoint;
  prefs: LayoutPrefs;
  tab: "overview" | "steps" | "files";
  editing: boolean;
  /** narrow/single 档下用户是否临时打开了导航 */
  navOpened: boolean;
}): boolean {
  const { breakpoint, prefs, tab, editing, navOpened } = input;
  if (prefs.navUserCollapsed) {
    // 用户显式收起：即使宽窗口也不显示，只有临时打开能盖过去
    return navOpened;
  }
  switch (breakpoint) {
    case "wide":
      return true;
    case "medium":
      // 文件页或编辑态抢占宽度 ⇒ 暂时收起导航（用户偏好不变）
      if (tab === "files" || editing) return navOpened;
      return true;
    case "narrow":
    case "single":
      return navOpened;
  }
}

/**
 * 当前该不该显示步骤目录。
 *
 * 二次约束（D2）：**步骤目录出现时必须保证详情列 ≥ `DETAIL_MIN_WIDTH`**。
 * 因此这里要把「视口宽 − 导航实际占宽 − 步骤目录宽」与 480 比较：
 * 不够就**自动收起步骤目录**（不写用户偏好）。
 *
 * ⚠️ `availableWidth` 应由调用方给**应用内容视口宽**（`documentElement.clientWidth`），
 *    `navVisible` 与 `navWidth` 决定导航实占多少。三者缺一都会算错。
 */
export function decideStepsVisible(input: {
  breakpoint: Breakpoint;
  prefs: LayoutPrefs;
  navVisible: boolean;
  navWidth: number;
  contentWidth: number;
  /** narrow/single 档下用户是否临时打开了步骤目录 */
  stepsOpened: boolean;
}): boolean {
  const { breakpoint, prefs, navVisible, navWidth, contentWidth, stepsOpened } = input;
  if (stepsOpened) return true;
  if (prefs.stepsUserCollapsed) return stepsOpened;
  if (breakpoint === "narrow" || breakpoint === "single") return stepsOpened;

  // wide / medium：常驻，但要过 480px 二次约束
  const navTaken = navVisible ? navWidth : 0;
  const detailAfterSteps = contentWidth - navTaken - prefs.stepsWidth;
  return detailAfterSteps >= DETAIL_MIN_WIDTH;
}

/** Explicitly opened directories replace the workspace when a sidebar would squeeze the text. */
export function stepsUseFullWorkspace(input: {
  contentWidth: number;
  navVisible: boolean;
  navWidth: number;
  stepsWidth: number;
}): boolean {
  return (
    input.contentWidth < 720 ||
    input.contentWidth - (input.navVisible ? input.navWidth : 0) - input.stepsWidth <
      DETAIL_MIN_WIDTH
  );
}

/** <720 档：辅助列表替换正文时看哪一边 */
export type AuxPane = "main" | "aux";

/**
 * 自动折叠只影响**显示**，绝不回写偏好。
 *
 * 这个函数存在的意义是给上面两个 `decide*` 提供一个"明确的断言点"：
 * 任何"把当前可见性存回 prefs"的写法都是错的。返回原对象即不改动。
 */
export function preservePrefs(prefs: LayoutPrefs): LayoutPrefs {
  return prefs;
}

/**
 * 应用内容视口宽度读取（D2：**必须**是 `document.documentElement.clientWidth`）。
 *
 * ⚠️ 不用 `window.innerWidth`——那含边框与滚动条，换算到断点会整体偏大；
 *    也不用「主工作区宽度」——D2 明确不是那个口径。
 *    本函数只读一次，订阅交给 `useLayoutWidth`（React 层）。
 */
export function readContentWidth(): number {
  if (typeof document === "undefined") return 1280;
  return document.documentElement.clientWidth;
}

// ---------------------------------------------------------------------------
// 专注模式（UI 密度 change 任务 2.4 · design D3）
// ---------------------------------------------------------------------------

/**
 * 专注模式的临时显示覆盖（**仅会话有效**，不持久化、不写偏好）。
 *
 * `mode` 区分编辑/差异；`workspaceKey` 是目标身份——由 App 按当前
 * view/tab/run/span 派生（`workspaceKeyOf`），**目标变化即失效**（身份比对立即
 * 判定，不等迟到 effect）。草稿/阅读状态/许可继续由既有目标机制持有，本状态
 * 只描述"此刻该不该收起辅助区"。
 */
export interface WorkspaceFocus {
  mode: "edit" | "diff";
  workspaceKey: string;
}

/** 当前工作区身份（focus 生效判定的"现在"侧）。trace 视图细化到 run/span。 */
export function workspaceKeyOf(input: {
  view: string;
  tab?: string;
  runId?: string | null;
  spanId?: string | null;
}): string {
  if (input.view === "trace") {
    return `trace:${input.tab ?? ""}:${input.runId ?? ""}:${input.spanId ?? ""}`;
  }
  return input.view;
}

/** focus 是否对当前目标生效：**身份比对**，目标一变立即 false（不靠 effect 解除）。 */
export function focusActiveFor(focus: WorkspaceFocus | null, workspaceKey: string | null): boolean {
  return focus !== null && workspaceKey !== null && focus.workspaceKey === workspaceKey;
}

/**
 * 专注下的有效布局（design D3：从现有 prefs/阅读状态**派生**，不复制不写回）。
 *
 * 生效时导航与步骤目录按**显示层**收起——`LayoutPrefs` 原封不动，宽度回到窗口
 * 后自动还原；退出（或目标变化失效）即移除覆盖，按当前容器恢复有效偏好。
 * 仅窗口尺寸变化不改 `workspaceKey` ⇒ focus 保持（spec 明文）。
 */
export function decideFocusLayout(input: {
  focus: WorkspaceFocus | null;
  workspaceKey: string | null;
  navVisible: boolean;
  stepsVisible: boolean;
}): { active: boolean; navVisible: boolean; stepsVisible: boolean } {
  const active = focusActiveFor(input.focus, input.workspaceKey);
  return {
    active,
    navVisible: active ? false : input.navVisible,
    stepsVisible: active ? false : input.stepsVisible,
  };
}
