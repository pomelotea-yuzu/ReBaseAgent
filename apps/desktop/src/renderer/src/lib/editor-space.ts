/**
 * UI 密度 change（improve-workspace-reading-and-editing）任务 2.2/2.3 · design D3：
 * 原值/草稿对照区的**空间判据**（纯函数与口径常量，组件只消费结论）。
 *
 * 两条 spec 纪律的落点：
 *   1. 「按实际每侧文字区域宽度决定并排/上下……不能只追随 xl 窗口断点」——
 *      `decideDraftCompareLayout` 吃**实测容器宽**（ResizeObserver），不吃窗口断点；
 *   2. 「默认高度不再固定为 200px」——编辑器高度改为**视口相对**的 CSS clamp
 *      表达式（低窗给下限、高窗封顶），由 `DRAFT_EDITOR_HEIGHT` 等常量承载；
 *      字符串交给 CSS 计算，静态渲染/测试无需知道真实视口高。
 */

/** 并排时每侧的最小可读宽度（spec：每侧约 320px 可读空间） */
export const DRAFT_PER_SIDE_MIN = 320;

/** 并排布局的列间距（与组件 gap-2 对齐） */
export const DRAFT_COMPARE_GAP = 8;

/**
 * 并排/上下决策：按**实测容器内容宽**。
 * 并排时每侧分得 `(width - gap) / 2`，两侧都 ≥ 每侧下限才并排；否则上下、各自滚动。
 */
export function decideDraftCompareLayout(containerWidth: number): "side-by-side" | "stacked" {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return "stacked";
  return (containerWidth - DRAFT_COMPARE_GAP) / 2 >= DRAFT_PER_SIDE_MIN
    ? "side-by-side"
    : "stacked";
}

/** 原值（只读）编辑器的默认高度：下限保可用、上限防高窗失控 */
export const ORIGINAL_EDITOR_HEIGHT = "clamp(160px, 32vh, 480px)";

/** 草稿（可编辑）编辑器的默认高度：主要编辑区优先（比原值高） */
export const DRAFT_EDITOR_HEIGHT = "clamp(240px, 44vh, 640px)";

/** 原值收起后草稿独占对照区时的高度（spec「草稿加大且可输入」） */
export const EXPANDED_DRAFT_EDITOR_HEIGHT = "clamp(320px, 64vh, 800px)";

/** 上下排列时原值区可调高度的范围（拖拽/键盘调整的 clamp 边界） */
export const ORIGINAL_HEIGHT_MIN = 120;
export const ORIGINAL_HEIGHT_MAX = 640;
/** 键盘调整一步与拖拽最小步进 */
export const ORIGINAL_HEIGHT_STEP = 24;

/**
 * 键盘调整原值区高度（与 `layout.stepWidth` 同口径）。
 * `ArrowUp/ArrowDown` 步进，`Home/End` 到边界；返回 `null` = 不消费该键。
 */
export function stepOriginalHeight(current: number, key: string): number | null {
  const base = clampOriginalHeight(current);
  switch (key) {
    case "ArrowUp":
      return clampOriginalHeight(base + ORIGINAL_HEIGHT_STEP);
    case "ArrowDown":
      return clampOriginalHeight(base - ORIGINAL_HEIGHT_STEP);
    case "Home":
      return ORIGINAL_HEIGHT_MIN;
    case "End":
      return ORIGINAL_HEIGHT_MAX;
    default:
      return null;
  }
}

/** 任意值夹到可调范围（非法值回默认下限——不静默放大用户输入） */
export function clampOriginalHeight(value: number): number {
  if (!Number.isFinite(value)) return ORIGINAL_HEIGHT_MIN;
  return Math.min(Math.max(value, ORIGINAL_HEIGHT_MIN), ORIGINAL_HEIGHT_MAX);
}
