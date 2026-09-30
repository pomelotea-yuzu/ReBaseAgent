import type { RunSummary } from "@shared/ipc";

/**
 * U7（improve-branch-comparison）任务 3.6/3.7：关系列表与占位/分组判据
 * （branch-tree ADDED「分支节点与关系列表提供明确可访问动作」）。
 *
 * 三条不许含糊（spec scenario「父缺失与实验分组不造记录」原文）：
 * 1. **缺父占位只表示真实引用 ID 和不可用原因**——不能成为可执行或可比较的
 *    虚构记录（没有选中/打开/加入对比动作）；原 run 保留且照常可用。
 * 2. **成环终止并标记**——环上的 run 各自带「父链成环」标记（与森林提根口径一致），
 *    不伪造一条假根。
 * 3. **实验分组只依据记录 experimentId**——同组臂给真实组标签，跨批同 parent
 *    不伪造同组；无 experimentId 的 run 不进任何组。
 */

/** 关系列表条目：run 条目或缺父占位（与图共享同一顺序） */
export type RelationEntry =
  | {
      readonly kind: "run";
      readonly run: RunSummary;
      /** 记录的实验组标签；无则 null（不造组） */
      readonly experimentId: string | null;
      /** 孤儿标注（提为根但如实说明）；正常为 null */
      readonly orphan: "missing-parent" | "cycle" | null;
    }
  | {
      readonly kind: "missing-parent";
      /** 被引用但不存在的父 run id（真实引用，不虚构） */
      readonly referencedId: string;
      /** 指向它的子 run（占位因它而存在） */
      readonly childId: string;
      /** 固定不可用原因（唯一文案来源） */
      readonly reason: string;
    };

/** 缺父占位的固定不可用原因 */
export const MISSING_PARENT_REASON = "该父运行不在数据目录中，无法打开或加入比较";

/**
 * 由 run 顺序（= 图的确定性布局顺序）派生关系列表条目。
 *
 * `order` 必须与 BranchTree 的 `layout.nodes` 同源（场景「键盘关系列表与图同步」：
 * 与图共享身份、顺序、选中和对比状态）。某 run 的 parent 引用不在数据目录且
 * 未被入图（父缺失提根）⇒ 在该 run 之前插一条缺父占位；成环 run 只带标记——
 * 环两端都在图里，不另造占位。
 */
export function deriveRelationEntries(
  runs: readonly RunSummary[],
  order: readonly string[],
): RelationEntry[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const entries: RelationEntry[] = [];
  for (const id of order) {
    const run = byId.get(id);
    if (run === undefined) continue;
    if (run.parent !== null && !byId.has(run.parent)) {
      entries.push({
        kind: "missing-parent",
        referencedId: run.parent,
        childId: run.id,
        reason: MISSING_PARENT_REASON,
      });
    }
    entries.push({
      kind: "run",
      run,
      experimentId: run.fork?.experiment_id ?? null,
      orphan: run.parent !== null && !byId.has(run.parent) ? "missing-parent" : null,
    });
  }
  return entries;
}

/**
 * 实验分组（3.7）：只按**记录 experimentId** 归组（键 = 真实标签）。
 * 无标签的 run 不进组；跨批同 parent 不因此同组——判据里根本没有 parent。
 */
export function experimentGroupsOf(
  entries: readonly RelationEntry[],
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind !== "run" || entry.experimentId === null) continue;
    const bucket = groups.get(entry.experimentId);
    if (bucket === undefined) groups.set(entry.experimentId, [entry.run.id]);
    else bucket.push(entry.run.id);
  }
  return groups;
}
