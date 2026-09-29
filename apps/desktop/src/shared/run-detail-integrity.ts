import type { Fork } from "@rebaseagent/trace-sdk/schema";

/**
 * U6（add-partial-run-reading）design D1：`RunDetail` 完整性字段的**载荷内一致性**校验。
 *
 * 分工边界：本模块只判「载荷自身可证明」的错配（组合、chain 结构、集合关系）；
 * 「leafSpanIds 是否真对应当前 run 的自有记录」「chain 是否真的连续可读」是文件事实，
 * 由 main（`readRunLineage` / `RunRepository.getRun`）对照原始记录保证，renderer 不猜。
 * 三处消费（main 自检、renderer 选中详情、U5 后台核实）共用同一份判据。
 */

/** 完整性校验的最小输入形状（RunDetail 与测试构造的纯对象都满足） */
export interface RunDetailIntegrityInput {
  meta: { id: string };
  spans: Array<{ id: string }>;
  chain: Array<{ meta: { id: string; parent: string | null }; fork: Fork | null }>;
  leafSpanIds: string[];
  completeness: string;
  spanScope: string;
  lineage: { status: string; reason?: string; missingRunId?: string };
}

/**
 * 返回错配原因（中文，可直接进 zod issue / 失败信封）；自洽返回 `null`。
 *
 * 判据（对应 delta「详情完整性字段拒绝错配」「根 run 以自有轨迹返回」）：
 * - chain 非空、hop id 唯一、末跳身份等于当前 meta、相邻 parent 连续；
 * - complete：首项 parent=null，lineage.status=complete 且不携带缺失字段；
 * - ownOnly：lineage=incomplete/ANCESTOR_NOT_FOUND，首项 parent=missingRunId
 *   且该 id 不在 chain 内（断点在链外）；
 * - ownOnly 只允许 spanScope=own（own 不是 resolved 的降级态）；
 * - spanScope=own ⇒ leafSpanIds 与 spans 的 id 集合精确相等；resolved ⇒ 无重复且是子集。
 */
export function findRunDetailIntegrityViolation(detail: RunDetailIntegrityInput): string | null {
  const { chain, leafSpanIds, completeness, spanScope, lineage } = detail;

  if (chain.length === 0) {
    return "chain 不能为空";
  }
  const chainIds = new Set<string>();
  for (const hop of chain) {
    if (chainIds.has(hop.meta.id)) {
      return `chain 存在重复 hop：${hop.meta.id}`;
    }
    chainIds.add(hop.meta.id);
  }
  const lastHop = chain[chain.length - 1];
  if (lastHop === undefined || lastHop.meta.id !== detail.meta.id) {
    return `chain 末跳身份（${String(lastHop?.meta.id)}）与当前 run（${detail.meta.id}）不符`;
  }
  for (let i = 0; i < chain.length - 1; i++) {
    const parent = chain[i];
    const child = chain[i + 1];
    if (parent !== undefined && child !== undefined && child.meta.parent !== parent.meta.id) {
      return `chain 不连续：${child.meta.id} 声明的 parent（${String(child.meta.parent)}）不是相邻前一项 ${parent.meta.id}`;
    }
  }

  if (completeness === "complete") {
    if (lineage.status !== "complete") {
      return "completeness=complete 时 lineage.status 必须是 complete";
    }
    if ("reason" in lineage || "missingRunId" in lineage) {
      return "完整 lineage 不允许携带缺失字段（reason/missingRunId）";
    }
    const first = chain[0];
    if (first === undefined || first.meta.parent !== null) {
      return "completeness=complete 时 chain 首项必须是根 run（parent=null）";
    }
  } else if (completeness === "ownOnly") {
    if (lineage.status !== "incomplete" || lineage.reason !== "ANCESTOR_NOT_FOUND") {
      return "completeness=ownOnly 时 lineage 必须是 incomplete/ANCESTOR_NOT_FOUND";
    }
    const missingRunId = lineage.missingRunId;
    if (typeof missingRunId !== "string" || missingRunId.length === 0) {
      return "ownOnly 必须携带非空 missingRunId";
    }
    if (chainIds.has(missingRunId)) {
      return `missingRunId ${missingRunId} 不允许出现在 chain 内（缺失点必须在链外）`;
    }
    const first = chain[0];
    if (first === undefined || first.meta.parent !== missingRunId) {
      return `ownOnly 首项的 parent 必须等于 missingRunId ${missingRunId}`;
    }
    if (spanScope !== "own") {
      return "completeness=ownOnly 只允许 spanScope=own";
    }
  } else {
    return `未知 completeness：${completeness}`;
  }

  const spanIds = new Set<string>();
  for (const span of detail.spans) {
    if (spanIds.has(span.id)) {
      return `spans 存在重复 id：${span.id}`;
    }
    spanIds.add(span.id);
  }
  const leafSeen = new Set<string>();
  for (const leafId of leafSpanIds) {
    if (leafSeen.has(leafId)) {
      return `leafSpanIds 存在重复：${leafId}`;
    }
    if (!spanIds.has(leafId)) {
      return `leafSpanIds 引用了 spans 之外的 id：${leafId}`;
    }
    leafSeen.add(leafId);
  }
  if (spanScope === "own") {
    for (const spanId of spanIds) {
      if (!leafSeen.has(spanId)) {
        return `spanScope=own 要求 leafSpanIds 精确覆盖全部 spans，缺少：${spanId}`;
      }
    }
  }
  return null;
}
