/**
 * U2 任务 4.1 / 4.2 / 4.3 · 文件视图的**容器布局判据**（纯逻辑层，design D4）。
 *
 * 与 U1 `lib/layout.ts` 同一套纪律，但**输入是文件容器实测宽度**（不是窗口断点）：
 *   1. **容器宽度决定一切**——「同视口下响应容器变化」明写"不用窗口断点判断足够宽"。
 *      调运行导航或文件目录宽度都会改变可用空间，判据必须吃实测容器宽。
 *   2. **先保正文，再决定目录常驻**——正文（inline 文字区）至少 480px 是硬约束；
 *      扣掉目录、间距、内边距后不够 480 就**收起目录**，而不是把正文挤成窄条。
 *   3. **并排是第二条独立判据**——目录决策之后，Monaco 两侧实际文字区**各自** ≥320px
 *      才能并排；否则 inline。目录常驻与并排互不蕴含（800px 下可能"目录常驻 + inline"）。
 *   4. **自动降级绝不写回用户偏好**——用户选的目录宽度 / diff 模式原封不动，
 *      空间恢复后还原（`preserveFilePrefs`，与 U1 `preservePrefs` 同法）。
 *
 * ⚠️ 文字区**不是**宿主盒子的一半：计算要扣掉行号、glyph margin、滚动条与内边距
 *    （`DIFF_CHROME_PER_SIDE` / `INLINE_CHROME`）。最终以实机测量为准（归 5.1/5.2），
 *    这里给的是**可证伪的估算公式**，不是拍脑袋的常数。
 */

/** 文件目录宽度范围与默认值（design D4：232px，可拖 200–320） */
export const FILE_DIR_MIN = 200;
export const FILE_DIR_MAX = 320;
export const FILE_DIR_DEFAULT = 232;

/** inline（单栏）文字区硬下限（design D4：实际文字区至少 480 CSS px） */
export const INLINE_MIN_TEXT = 480;

/** 并排时**每一侧**文字区下限（design D4 / delta：每侧至少 320px） */
export const SIDE_BY_SIDE_MIN_TEXT = 320;

/** 代码正文最小字号（design D4：至少 13px，不靠缩字号达标） */
export const MIN_CODE_FONT_SIZE = 13;

/**
 * 编辑器 chrome 的**经验扣除量**（px）——文字区 = 容器内部宽 − 这些。
 *
 * ⚠️ 这些值必须由 5.1/5.2 实机测量校准；此处给保守初值，宁小勿大地估文字区，
 *    以免"以为够宽"却实际不达标。行号槽 + glyph margin 约 60，滚动条约 14。
 */
export const INLINE_CHROME = 74;
/** 并排时**每一侧**各自的 chrome（行号 + glyph margin + 滚动条 + 中缝分摊） */
export const DIFF_CHROME_PER_SIDE = 88;

/** 目录与正文之间的间距 + 内边距（design D4 提到的"间距、内边距"） */
export const GUTTER = 12;

/**
 * 把任意宽度夹到 [min, max]。非有限值回默认（不用"夹到 min"冒充用户意图）。
 * 与 U1 `clampWidth` 同口径，但独立常量域（文件目录，不是导航/步骤）。
 */
export function clampFileDirWidth(value: number): number {
  if (!Number.isFinite(value)) return FILE_DIR_DEFAULT;
  return Math.min(Math.max(value, FILE_DIR_MIN), FILE_DIR_MAX);
}

/**
 * 键盘调整目录宽度一步（与 U1 `stepWidth` 同口径：16px 步进，Home/End 到边界）。
 * 返回 `null` = 该键不消费。
 */
export function stepFileDirWidth(current: number, key: string): number | null {
  const cur = clampFileDirWidth(current);
  switch (key) {
    case "ArrowRight":
      return clampFileDirWidth(cur + 16);
    case "ArrowLeft":
      return clampFileDirWidth(cur - 16);
    case "Home":
      return FILE_DIR_MIN;
    case "End":
      return FILE_DIR_MAX;
    default:
      return null;
  }
}

/** diff 模式偏好：auto（默认，按空间）、inline（用户选）、sideBySide（用户选） */
export type DiffModePreference = "auto" | "inline" | "sideBySide";
/** 实际落地模式（无 auto） */
export type DiffMode = "inline" | "sideBySide";

/** 文件视图布局偏好（本会话内有效，不持久化跨进程） */
export interface FileLayoutPrefs {
  /** 用户拖/键设的目录宽度（永远在合法范围内） */
  readonly dirWidth: number;
  /** 用户**显式**收起目录（与"空间不够自动收起"不同） */
  readonly dirUserCollapsed: boolean;
  /** diff 模式偏好 */
  readonly diffPreference: DiffModePreference;
  /** Monaco 换行开关（默认开启） */
  readonly wordWrap: boolean;
}

export const initialFileLayoutPrefs: FileLayoutPrefs = {
  dirWidth: FILE_DIR_DEFAULT,
  dirUserCollapsed: false,
  diffPreference: "auto",
  wordWrap: true,
};

/**
 * 该不该**常驻**目录。
 *
 * 判据（顺序即优先级）：用户显式收起 > 空间不够（扣目录后 inline 文字区 < 480）> 常驻。
 *
 * ⚠️ `containerWidth` 是**文件容器**实测宽（不是窗口宽、不是主工作区宽）。
 *    返回 `false` 不代表"不能看目录"——极窄档下目录与内容**占同一主区**，由切换入口
 *    二选一显示（见 `resolveFilePaneVisibility`）。
 */
export function decideDirResident(input: {
  prefs: FileLayoutPrefs;
  containerWidth: number;
}): boolean {
  const { prefs, containerWidth } = input;
  if (prefs.dirUserCollapsed) return false;
  // 常驻目录后，正文可用宽 = 容器 − 目录 − 间距；其文字区须仍 ≥ 480
  const textArea = containerWidth - prefs.dirWidth - GUTTER - INLINE_CHROME;
  return textArea >= INLINE_MIN_TEXT;
}

/**
 * 该不该并排。
 *
 * 判据：用户偏好优先（inline 恒 inline，sideBySide 空间够就并排），
 * `auto` 则两侧文字区**各自** ≥320 才并排，否则 inline。
 *
 * ⚠️ 与目录决策**独立**：并排判断吃的是**正文区**当前宽度（目录决策之后的结果），
 *    不是容器总宽——目录常驻与否会改变正文区宽，进而改变并排结论（D4 明写两条独立条件）。
 */
export function decideDiffMode(input: {
  prefs: FileLayoutPrefs;
  /** 正文区（编辑器所在列）实测宽 */
  contentAreaWidth: number;
}): { mode: DiffMode; downgraded: boolean; reason: string | null } {
  const { prefs, contentAreaWidth } = input;
  if (prefs.diffPreference === "inline") {
    return { mode: "inline", downgraded: false, reason: null };
  }
  const perSide = (contentAreaWidth - DIFF_CHROME_PER_SIDE) / 2;
  const fits = perSide >= SIDE_BY_SIDE_MIN_TEXT;
  if (prefs.diffPreference === "sideBySide") {
    if (fits) return { mode: "sideBySide", downgraded: false, reason: null };
    // 用户选了并排但空间不足 ⇒ 自动 inline，且**说明空间不足**（delta 明文）
    return {
      mode: "inline",
      downgraded: true,
      reason: `可用宽度不足：并排每侧需 ≥${SIDE_BY_SIDE_MIN_TEXT}px，当前约 ${Math.max(0, Math.round(perSide))}px。`,
    };
  }
  // auto
  return fits
    ? { mode: "sideBySide", downgraded: false, reason: null }
    : { mode: "inline", downgraded: false, reason: null };
}

/** 该不该显示**目录列**（极窄档下目录与内容占同一主区，按 pane 二选一） */
export type FilePane = "list" | "content";

export function resolveFilePaneVisibility(input: {
  dirResident: boolean;
  pane: FilePane;
}): { showList: boolean; showContent: boolean } {
  if (input.dirResident) return { showList: true, showContent: true };
  return { showList: input.pane === "list", showContent: input.pane === "content" };
}

/**
 * 自动降级绝不回写偏好（与 U1 `preservePrefs` 同法：返回原对象即不改动）。
 * 存在意义是给调用方一个明确的"断言点"。
 */
export function preserveFilePrefs(prefs: FileLayoutPrefs): FileLayoutPrefs {
  return prefs;
}

/** 目录宽度按 4.3 的"位置夹取"要求夹回合法范围（延迟挂载/布局变化后调用） */
export function clampRestoredDirWidth(value: number): number {
  return clampFileDirWidth(value);
}
