import type { RunSummary } from "@shared/ipc";
import { matchesSearch } from "@shared/nav";

/**
 * U7（improve-branch-comparison）任务 3.1–3.3：分支视图的**范围 / 搜索 / 视口**判据
 * （branch-tree ADDED「分支视口可定位当前运行并恢复阅读」+ design D2）。
 *
 * 三条纪律：
 * 1. **逻辑布局与视口分离**：布局是 `layoutRunTree` 的确定性纯计算，坐标永不因窗口
 *    或缩放重排；视口（缩放档 + 滚动位置）是会话内的观察参数——返回树恢复视口，
 *    **显式定位才再次居中**（不重复强制居中）。
 * 2. **首次进入聚焦当前分支**：有选中运行 ⇒ 默认「当前树」范围且当前节点可见；
 *    无选中 ⇒ 全部关系。该决策只在没有会话范围的第一次进入生效（幂等边界在 store）。
 * 3. **搜索匹配完整原值**：复用 `matchesSearch`（完整 ID/任务，大小写不敏感）——
 *    展示截断不参与匹配；每个命中带其所属已知树的根（范围外命中可定位其树）。
 */

/** 树范围：当前选中运行所属的已知树 / 全部关系 */
export type TreeScope = "current" | "all";

/** 缩放档位（组件渲染层的档位常量在这里钉住，供适应画布取值） */
export const TREE_ZOOM_LEVELS = [50, 75, 100, 150] as const;
export type TreeZoom = (typeof TREE_ZOOM_LEVELS)[number];

/** 会话内视口（观察参数，不落盘）：缩放档 + 滚动位置 */
export interface TreeViewport {
  readonly zoom: TreeZoom;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

export function initialTreeViewport(zoom: TreeZoom = 100): TreeViewport {
  return { zoom, scrollLeft: 0, scrollTop: 0 };
}

/**
 * run 所属**已知树**的根：沿 parent 链上溯到尽头。
 * 链断在已知记录之外（父缺失）或成环 ⇒ 该 run 自身的树根就是它自己
 * （buildRunForest 把它提为根——这里与森林判据同口径）。
 */
export function treeRootOf(byId: ReadonlyMap<string, RunSummary>, runId: string): string {
  const seen = new Set<string>([runId]);
  let cursor = byId.get(runId);
  if (cursor === undefined) return runId;
  let root = cursor.id;
  while (cursor.parent !== null) {
    // 成环：链上没有真根——该 run 自身即根（提根口径与 buildRunForest 一致）
    if (seen.has(cursor.parent)) return runId;
    const next = byId.get(cursor.parent);
    // 父缺失：链断在已知记录之外——最后一条已知记录就是树根
    if (next === undefined) break;
    seen.add(cursor.parent);
    root = next.id;
    cursor = next;
  }
  return root;
}

/** 首次进入的初始范围与焦点（3.1） */
export type TreeInitialFocus =
  | { readonly scope: "current"; readonly focusRunId: string }
  | { readonly scope: "all"; readonly focusRunId: null };

/** 首次进入决策：有选中运行 ⇒ 当前树 + 焦点该节点；无 ⇒ 全部（scenario 原文） */
export function decideTreeInitialFocus(selectedRunId: string | null): TreeInitialFocus {
  if (selectedRunId !== null) return { scope: "current", focusRunId: selectedRunId };
  return { scope: "all", focusRunId: null };
}

/**
 * 「当前树」范围的可见集合：选中运行所属树的全部成员（含根与各层后代）。
 * `treeRootId` 为该树的根；成员由 parent 关系闭包现算（列表是唯一事实源）。
 */
export function visibleRunIdsForScope(
  runs: readonly RunSummary[],
  scope: TreeScope,
  selectedRunId: string | null,
): ReadonlySet<string> | null {
  if (scope === "all") return null; // null = 不过滤（全部）
  if (selectedRunId === null) return null; // 无选中却要当前树 ⇒ 退化为全部（决策层的兜底）
  const byId = new Map(runs.map((run) => [run.id, run]));
  const rootId = treeRootOf(byId, selectedRunId);
  const children = new Map<string, string[]>();
  for (const run of runs) {
    const key = run.parent === null ? run.id : run.parent;
    const bucket = children.get(key);
    if (bucket === undefined) children.set(key, [run.id]);
    else bucket.push(run.id);
  }
  const visible = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    // 成环/父缺失被提为根的 run：parent 不在树内但它在 children 索引里以自己为键
    for (const child of children.get(current) ?? []) {
      if (!visible.has(child)) {
        visible.add(child);
        queue.push(child);
      }
    }
  }
  return visible;
}

/** 一条搜索命中：唯一身份 + 其所属已知树的根（3.2） */
export interface TreeSearchHit {
  readonly runId: string;
  readonly treeRootId: string;
}

/**
 * 树内搜索（3.2）：完整 ID/任务匹配（复用 `matchesSearch`，匹配**完整原值**）。
 * 查询为空白 ⇒ null（未搜索，UI 不显示空结果提示）；无命中 ⇒ 空数组（明确提示，
 * 不丢原选择）。
 */
export function searchTreeNodes(
  runs: readonly RunSummary[],
  query: string,
): TreeSearchHit[] | null {
  if (query.trim() === "") return null;
  const byId = new Map(runs.map((run) => [run.id, run]));
  const hits: TreeSearchHit[] = [];
  for (const run of runs) {
    if (matchesSearch(run, query)) {
      hits.push({ runId: run.id, treeRootId: treeRootOf(byId, run.id) });
    }
  }
  return hits;
}

/**
 * 适应画布（3.3）：在离散缩放档里取「两维都装得下的最大档」；全都装不下取最小档。
 * 布局尺寸与容器尺寸由组件现测，这里只做纯取档。
 */
export function fitZoomLevel(
  layoutWidth: number,
  layoutHeight: number,
  containerWidth: number,
  containerHeight: number,
): TreeZoom {
  const fits = (zoom: number): boolean =>
    (layoutWidth * zoom) / 100 <= containerWidth && (layoutHeight * zoom) / 100 <= containerHeight;
  // 档位升序：取「两维都装得下的最大档」；全都装不下取最小档
  let best: TreeZoom | null = null;
  for (const level of TREE_ZOOM_LEVELS) {
    if (fits(level)) best = level;
  }
  return best ?? TREE_ZOOM_LEVELS[0];
}
