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
