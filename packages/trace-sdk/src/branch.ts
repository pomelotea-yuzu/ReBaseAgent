import { type ChainHop, assertForkable } from "./guards.js";
import type { RunRecord } from "./reader.js";
import { FORMAT_VERSION } from "./schema.js";
import type { Fork, RunEventLine, RunMetaLine, SpanLine } from "./schema.js";

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
  for (let i = 0; i < chain.length; i++) {
    const record = chain[i];
    const fork = record.meta.fork;
    if (fork === null) {
      // 根 run：整条轨迹都是自己的
      spans = record.spans.slice();
      continue;
    }
    if (record.meta.parent === null) {
      throw new Error(`根 run ${record.meta.id} 不应携带 fork 元数据（没有可续跑的父）`);
    }
    // 直接用**直接父的自有记录**（而不是拼接后的前缀）做隔离校验：
    // 边界 step 必须来自直接父自己，不能从祖先猜。见 resolveWholeRound。
    const parentRecord = chain[i - 1];
    if (record.meta.format_version === FORMAT_VERSION) {
      spans = resolveWholeRound(spans, parentRecord, fork, record);
      continue;
    }
    // v1：在已拼接的父轨迹中定位分叉点，截断其后，接上新增 span（行为不变）
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

/**
 * v2 整轮截断：前缀保留到 `resume_after_step` 所指**整轮末尾**（该 step 及其全部后代）为止。
 *
 * 为什么 v1 的 `at_span` 截断在隔离分叉上不成立：`at_span` 指向**被编辑的那个工具调用**，
 * 同轮排在它**之后**的兄弟工具会被一起截掉——而 `deriveReplayState` 已经把这些兄弟工具的结果
 * 算进了续跑消息，于是前缀变成"消息里说执行过 T2、痕迹里没有 T2"。v2 因此把恢复点记为整轮末尾，
 * 并要求编辑点落在该轮之内。
 *
 * 校验一律"拒绝而不猜"：
 * - 边界必须是**直接父自有记录**里的 span（只在祖先里的 step 会让文件起点与消息前缀错配）；
 * - 它必须是 `agent.step`，且不能与 `at_span` 同为一条（编辑点是轮内的工具调用，不是轮次容器）；
 * - `at_span` 必须**属于**该 step（沿 parent 链上溯可达）。
 *
 * 本函数只拼接记录：不加载附件、不应用 result 编辑、不读源目录。
 */
function resolveWholeRound(
  prefix: SpanLine[],
  parentRecord: RunRecord,
  fork: Fork,
  child: RunRecord,
): SpanLine[] {
  const childId = child.meta.id;
  const stepId = fork.resume_after_step;
  if (stepId === undefined) {
    throw new Error(
      `v2 隔离分支 ${childId} 缺少 fork.resume_after_step（整轮续跑边界），不得按 v1 的 at_span 截断兜底`,
    );
  }

  // ① 边界必须是直接父自有记录里的 agent.step
  const owned = new Map(parentRecord.spans.map((span) => [span.id, span]));
  const step = owned.get(stepId);
  if (step === undefined) {
    throw new Error(
      `resume_after_step ${stepId} 不在直接父 run ${parentRecord.meta.id} 的自有记录中（不接受来自祖先的 step：文件起点会与消息前缀错配）`,
    );
  }
  if (step.kind !== "agent.step") {
    throw new Error(`resume_after_step ${stepId} 必须是 agent.step（实际 kind=${step.kind}）`);
  }

  // ② 编辑点必须落在该轮之内
  const edited = owned.get(fork.at_span);
  if (edited === undefined) {
    throw new Error(
      `fork.at_span ${fork.at_span} 不在直接父 run ${parentRecord.meta.id} 的自有记录中`,
    );
  }
  if (edited.id === stepId) {
    throw new Error(
      `fork.at_span 不能等于 resume_after_step（${stepId}）：编辑点是该轮内的工具调用，不是轮次容器`,
    );
  }
  let ancestor: string | null = edited.parent;
  let belongs = false;
  while (ancestor !== null) {
    if (ancestor === stepId) {
      belongs = true;
      break;
    }
    ancestor = owned.get(ancestor)?.parent ?? null;
  }
  if (!belongs) {
    throw new Error(`fork.at_span ${fork.at_span} 不属于 resume_after_step ${stepId} 所指的那一轮`);
  }

  // ③ 在已拼接的前缀里保留该 step **及其全部后代**（语义序保证父先于子，一遍扫描即可）
  const stepIdx = prefix.findIndex((span) => span.id === stepId);
  if (stepIdx === -1) {
    throw new Error(`resume_after_step ${stepId} 不在已拼接的前缀轨迹中`);
  }
  const subtree = new Set<string>([stepId]);
  for (const span of prefix) {
    if (span.parent !== null && subtree.has(span.parent)) {
      subtree.add(span.id);
    }
  }
  return [
    ...prefix.filter((span, index) => index <= stepIdx || subtree.has(span.id)),
    ...child.spans,
  ];
}
