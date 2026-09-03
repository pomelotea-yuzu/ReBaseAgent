import type { RunRecord } from "./reader.js";
import type { Fork, RunMetaLine } from "./schema.js";

/**
 * 分支保护：只允许从已封存（有终止事件）的 run 创建分支。
 * 未封存 = 可能仍在写入 = 前缀不稳定，禁止分叉。
 */
export function assertForkable(parent: RunRecord): void {
  if (parent.status === "crashed") {
    throw new Error(`只能从已完成的 run 分支：${parent.meta.id} 缺失终止事件（crashed）`);
  }
}

/**
 * 删除保护：存在子分支（有 run 的 parent 指向它）的 run 不可直接删除。
 * @param targetId 拟删除的 run id
 * @param metas    当前可见的全部 run.meta（通常来自目录扫描）
 */
export function assertDeletable(targetId: string, metas: RunMetaLine[]): void {
  const children = metas.filter((m) => m.parent === targetId);
  if (children.length > 0) {
    throw new Error(`有 ${children.length} 个分支引用此 run（如 ${children[0].id}），不可删除`);
  }
}

/** fork 元数据在解析链路上的暴露形式 */
export interface ChainHop {
  /** 链上每个 run 的 meta */
  meta: RunMetaLine;
  /** 该 run 相对其父的 fork 描述（根 run 为 null） */
  fork: Fork | null;
}
