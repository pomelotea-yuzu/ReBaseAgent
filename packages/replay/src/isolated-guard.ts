import type { RunRecord } from "@rebaseagent/trace-sdk";

/**
 * 跨入口的**隔离父本拒绝规则**（A design §6，tasks 4.5）。
 *
 * 普通执行路径（`replayRun`、prompt fork、模型 A/B）都在**真实文件系统**上重跑：工具是调用方传入的
 * handler、落点是 `exec.cwd`。隔离 run 的文件状态却活在副本世界与内容附件里——把隔离父本交给这些入口，
 * 等于把"文件状态可回退"的假设悄悄换成"磁盘上的现值"，而 trace 里仍写着隔离元数据。
 *
 * 因此规则只有一条：**带 `workspace` 元数据的父本，一律不得进入普通执行路径**。
 *
 * ## 为什么必须只有这一份判定
 *
 * 同一个门禁在多个入口各写一遍，早晚会有一个漏（本仓既有教训：注释声称"双保险"的两道校验语义并不相
 * 同）。所以两个入口都调 `assertNotIsolatedParent`：
 * - `replayRun`（普通 result 重跑）
 * - `loadForkParent`（**prompt fork 与模型 A/B 共用**，见 `fork-parent.ts`）
 *
 * ## 逃生通道是关闭的
 *
 * 模型 A/B 的 `dryRun` 与 `allowSideEffects` **不能**绕过这条规则：父本门禁在 `modelReplayRunMany`
 * 的第 3 步，而 dry-run 分支在第 8 步、工具策略裁决在第 6 步——顺序即保证。用例把这两种参数都钉住了。
 *
 * Trace-as-Test（卡带）不走这条路径：它消费录制结果与桩工具、不加载文件世界（design §6），
 * 因此无需也没有"隔离父本"概念。
 */

/** 判定父本是否为隔离 run；返回拒绝原因（不含"该怎么改"的建议），`null` = 不是隔离 run */
export function findIsolatedParentViolation(record: RunRecord): string | null {
  const workspace = record.meta.workspace;
  if (workspace === undefined) {
    return null;
  }
  return `父 run ${record.meta.id} 是隔离 run（带 workspace 元数据，格式版本 ${record.meta.format_version}）：它的文件状态位于副本世界与内容附件中，而普通执行路径使用调用方传入的工具实现与 exec.cwd 指向的真实文件系统，会绕过副本映射、直接改写真实文件`;
}

/**
 * 断言父本不是隔离 run；是则抛错。
 *
 * 只读 `meta`、不碰文件系统，调用方可以放心把它放在任何副作用之前。
 * `remedy` 由调用方补：不同入口能给的替代出路不同（普通重跑指向隔离续跑；prompt fork / 模型 A/B
 * 指向"改选非隔离父本或改用隔离 result 分叉"）。调用方按需把这里的领域错误包成自己的错误码。
 */
export function assertNotIsolatedParent(record: RunRecord, remedy: string): void {
  const violation = findIsolatedParentViolation(record);
  if (violation !== null) {
    throw new Error(`${violation}。${remedy}`);
  }
}
