import { type ChainHop, assertForkable } from "./guards.js";
import type { RunRecord } from "./reader.js";
import type { RunEventLine, RunMetaLine, SpanLine } from "./schema.js";

/** 按 run id 加载一个 run 的完整记录（文件、内存索引等来源由调用方决定） */
export type RunLoader = (runId: string) => RunRecord;

/** 分支解析结果：拼接后的完整轨迹 + 暴露的 fork 元数据 */
export interface ResolvedRun {
  /** 叶子 run（被解析的 run 本身）的 meta */
  meta: RunMetaLine;
  /** 完整轨迹 = 各祖先的共享前缀（截至各 fork 点，含 fork 点 span）+ 本 run 新增 span */
  spans: SpanLine[];
  /** 祖先链（从根到直接父），暴露 fork 元数据；编辑语义由 replay 层应用 */
  chain: ChainHop[];
  /** 叶子 run 自身的事件（其结局） */
  events: RunEventLine[];
}

/**
 * 沿 parent 链拼接完整轨迹（copy-on-write：前缀经祖先共享）。
 *
 * - 每个 fork.at_span 定位其父轨迹中的分叉点，取"该 span 及之前"为前缀，
 *   后接本 run 新增的 span（fork 点 span 的编辑由 replay spec 应用，此处仅暴露元数据）
 * - 环检测：parent 链出现重复 id 即报错
 * - 父文件缺失：报错指明缺失的 run id
 * - 祖先必须已封存（assertForkable）
 */
export function resolveBranch(runId: string, load: RunLoader): ResolvedRun {
  const visited = new Set<string>();
  const chain: RunRecord[] = [];

  let currentId: string | null = runId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error(`检测到 parent 链成环：${currentId}`);
    }
    visited.add(currentId);

    let record: RunRecord;
    try {
      record = load(currentId);
    } catch (e) {
      throw new Error(`父 run 文件缺失或无法读取：${currentId}（${(e as Error).message}）`, {
        cause: e,
      });
    }
    chain.unshift(record); // 从根到叶排列

    const { parent } = record.meta;
    if (parent !== null && record.meta.fork === null) {
      // 分支 run 必须携带 fork 元数据，否则无法定位分叉点
      throw new Error(`分支 run ${record.meta.id} 缺少 fork 元数据（parent 已指向 ${parent}）`);
    }
    currentId = parent;
  }

  // 链上每个非根 run 都是从前一个 run 分叉出来的 → 被分叉者必须已封存
  for (let i = 1; i < chain.length; i++) {
    assertForkable(chain[i - 1]);
  }

  // 从根开始逐级拼接
  let spans: SpanLine[] = [];
  for (const record of chain) {
    const fork = record.meta.fork;
    if (fork === null) {
      // 根 run：整条轨迹都是自己的
      spans = record.spans.slice();
      continue;
    }
    // 分支 run：在已拼接的父轨迹中定位分叉点，截断其后，接上新增 span
    const idx = spans.findIndex((s) => s.id === fork.at_span);
    if (idx === -1) {
      throw new Error(`fork 点 ${fork.at_span} 不存在于 ${record.meta.parent} 的轨迹中`);
    }
    spans = [...spans.slice(0, idx + 1), ...record.spans];
  }

  const leaf = chain[chain.length - 1];
  return {
    meta: leaf.meta,
    spans,
    chain: chain.map((r) => ({ meta: r.meta, fork: r.meta.fork })),
    events: leaf.events,
  };
}
