import type { RunLoader, RunRecord } from "@rebaseagent/trace-sdk";

/**
 * 无语义的父链加载 helper（replayRun 与 promptReplayRun 共用）。
 * 根→叶排列；成环 / 文件缺失报错措辞与既有编排层逐字一致。
 */
export function loadParentChain(parentId: string, load: RunLoader): RunRecord[] {
  const records: RunRecord[] = [];
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(`parent 链成环：${current}`);
    }
    seen.add(current);
    let record: RunRecord;
    try {
      record = load(current);
    } catch (e) {
      throw new Error(`父 run 文件缺失或无法读取：${current}（${(e as Error).message}）`, {
        cause: e,
      });
    }
    records.unshift(record);
    current = record.meta.parent;
  }
  return records;
}

/**
 * 父链最大 span 序号：fork run 的 span 从其后延续编号。
 *
 * `resolveBranch` 扁平拼接父前缀 + 本 run 新增 span，若 fork run 从 `s_01` 重计，
 * 展开轨迹会出现重复 id；再分叉时"叶优先按 id 查找"会命中祖先同名 span。
 * 真实 runLoop 产出的 span id 恒为 `s_NN`，故取数字后缀最大值即可。
 *
 * ⚠️ 这个数字也是"前缀零调用"的**可观测证据**之一：若续跑把前缀的工具/LLM 重放了一遍，
 * 首个新 span 的序号就不会紧接父链最大值。
 */
export function maxSpanSeq(records: readonly RunRecord[]): number {
  let max = 0;
  for (const record of records) {
    for (const span of record.spans) {
      const m = /^s_(\d+)$/.exec(span.id);
      if (m !== null) {
        max = Math.max(max, Number(m[1]));
      }
    }
  }
  return max;
}
