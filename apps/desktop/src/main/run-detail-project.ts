import { resolveWholeRound } from "@rebaseagent/trace-sdk";
import type { RunRecord } from "@rebaseagent/trace-sdk";
import { FORMAT_VERSION } from "@rebaseagent/trace-sdk/schema";
import type { SpanLine } from "@rebaseagent/trace-sdk/schema";

/**
 * U6（add-partial-run-reading）design D3：混合来源链的**只读轨迹投影**。
 *
 * 纯 result 链仍走 trace-sdk `resolveBranch`（行为不变）；混合链——链上除了 result
 * 还夹着独立执行边界（prompt / 代理 messages / model_params）——不能交给只会逐级
 * 拼接的 resolver，否则会把独立边界另一侧的轨迹拼进同一条时间线。
 *
 * 投影规则（root..leaf 逐 hop）：
 * - result hop：按对应版本语义把「父前缀截至分叉点」与本次自有 spans 相接
 *   （v1 按 at_span 单 span 截断；v2 走 `resolveWholeRound` 整轮截断——与执行路径
 *   共用同一函数，判据不漂移）；
 * - 独立边界 hop（system_prompt / user_message / messages / model_params）：
 *   轨迹**重置**为该 hop 自有 spans（chain 仍携带更早来源，溯源不切断）；
 * - 未知 edit.field：明确拒绝，不默认按 result 处理。
 *
 * 定位校验的分工：可证明的约束（分叉点必须落在投影前缀内）在这里拒绝；
 * 依赖领域编排的定位语义（prompt 的 at_span = 父本首次 llm.call 等）由写入端
 * 与执行门禁保证，只读投影不重复实现。
 */

/** 独立执行边界：这些字段意味着「从头重跑的独立新轨迹」，投影在此重置 */
const INDEPENDENT_FIELDS = new Set(["system_prompt", "user_message", "messages", "model_params"]);

export type ChainProjection =
  | { readonly ok: true; readonly spans: SpanLine[] }
  | { readonly ok: false; readonly message: string };

/**
 * 投影混合链的完整轨迹。`records` 必须是 root..leaf 的连续已校验记录
 * （`readRunLineage` 的 complete 形态）；结构校验（fork/parent 自洽、成环、封存）
 * 已由读取上下文完成，这里只做轨迹拼装与「可证明」的定位检查。
 */
export function projectMixedChainSpans(records: readonly RunRecord[]): ChainProjection {
  const root = records[0];
  if (root === undefined) {
    return { ok: false, message: "投影输入为空：缺少根记录" };
  }

  let spans: SpanLine[] = root.spans.slice();
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) {
      return { ok: false, message: "投影输入中断：记录序列不完整" };
    }
    const fork = record.meta.fork;
    if (fork === null) {
      return { ok: false, message: `run ${record.meta.id} 缺少 fork 元数据（parent 已声明）` };
    }
    const field = fork.edit.field;
    const parentId = record.meta.parent ?? "未知父";

    if (field === "result") {
      if (record.meta.format_version === FORMAT_VERSION) {
        const parentRecord = records[i - 1];
        if (parentRecord === undefined) {
          return { ok: false, message: `隔离分支 ${record.meta.id} 缺少可用的直接父记录` };
        }
        // v2 整轮截断：与执行路径共用同一实现（含边界归属校验），拒绝而不猜
        spans = resolveWholeRound(spans, parentRecord, fork, record);
        continue;
      }
      // v1：在已投影的父前缀中定位分叉点，截断其后，接上本次自有 spans（与 resolveBranch 一致）
      const idx = spans.findIndex((span) => span.id === fork.at_span);
      if (idx === -1) {
        return {
          ok: false,
          message: `fork 点 ${fork.at_span} 不存在于 ${parentId} 的轨迹前缀中`,
        };
      }
      spans = [...spans.slice(0, idx + 1), ...record.spans];
      continue;
    }

    if (INDEPENDENT_FIELDS.has(field)) {
      // 独立执行边界：重置为该 hop 自有轨迹（不拼接边界另一侧）
      spans = record.spans.slice();
      continue;
    }

    return {
      ok: false,
      message: `run ${record.meta.id} 的分支字段「${field}」不受支持（不默认按 result 拼接）`,
    };
  }
  return { ok: true, spans };
}

/** 纯 result 链判定：root..leaf 除根外全部是 result 分叉（纯链继续走 resolveBranch） */
export function isPlainResultChain(records: readonly RunRecord[]): boolean {
  return records.every((record, i) => i === 0 || record.meta.fork?.edit.field === "result");
}
