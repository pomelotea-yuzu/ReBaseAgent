import type { SpanLine } from "@rebaseagent/trace-sdk/schema";
import type { RunDetail } from "./ipc";

/**
 * U7（improve-branch-comparison）tasks 5.14/5.16：**历史模型实验比较**的
 * 逐记录只读资格判据（参数/首请求/config_hash 一致性 + 工具表/副作用声明）。
 *
 * design D5：「历史比较不重跑当前配置的 dry-run，也不要求当前 API key。main
 * 从已校验记录核对父与臂 config_hash 同源、首请求及 fork.edit model/params 自洽、
 * 记录工具表一致、父本类型与已记录副作用声明……不能从 hash 反推未录完整
 * RunConfig，不能把正常封存当作前置校验通过；记录不足以证明某项时资格为
 * **不可验证**并说明原因。只提取读判据，执行仍沿用原有完整配置、handler、
 * 费用确认、权限检查。」
 *
 * 三态语义（与 spec「不完整未封存与前置缺证明确拒绝」对应）：
 * - `eligible`：记录足以证明该项自洽；
 * - `ineligible`：记录证明该项**不自洽**（如工具表不同源、声明与工具表矛盾）——
 *   明确拒绝，不放宽；
 * - `unverifiable`：记录不足以证明（如老文件无 config_hash）——资格不可验证，
 *   说明原因；**不冒充通过**。
 *
 * 判据与执行路径（model-replay-run 的既有门禁）的对应关系（等价回归的锚点）：
 * - sideEffect 标记判据同款：**缺失按有副作用处理**（模型实验首期只支持无副作用
 *   工具表，write_file 常常连标记都没有——执行门禁原文语义）；
 * - 工具表一致性含 **sideEffect 字段的有无**（补齐缺失标记会改写指纹并被执行
 *   门禁拒绝——这里同样把「补标记」判为不同源）；
 * - config_hash 只做**已记录值的相等比较**，绝不重算、绝不反推 RunConfig。
 */

export type RecordCheckStatus = "eligible" | "ineligible" | "unverifiable";

export interface RecordCheckResult {
  readonly status: RecordCheckStatus;
  /** 稳定码（ineligible/unverifiable 时携带，供视图分层措辞） */
  readonly code: string;
  /** 受控中文原因 */
  readonly reason: string;
}

const eligible: RecordCheckResult = { status: "eligible", code: "OK", reason: "" };

/** 该 run **自有**首次 llm.call（leafSpanIds 界定自有段；合并视图不取祖先调用） */
function ownFirstLlmCall(detail: RunDetail): Extract<SpanLine, { kind: "llm.call" }> | null {
  const own = new Set(detail.leafSpanIds);
  const call = detail.spans.find((span) => span.kind === "llm.call" && own.has(span.id));
  return call === undefined || call.kind !== "llm.call" ? null : call;
}

/** 键排序的稳定 JSON（工具表/参数逐字段比较用；字段有无即文本差异） */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 标量参数（非标量项按执行路径同款丢弃后比较） */
function scalarParamsOf(raw: unknown): Record<string, string | number | boolean> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** model_params 编辑值的最小形状核验（执行写入端保证；此处防御性确认） */
function modelParamsValueOf(fork: NonNullable<RunDetail["meta"]["fork"]>): {
  model: string;
  params: Record<string, string | number | boolean> | undefined;
  allowSideEffects: boolean | undefined;
} | null {
  const value = fork.edit.value;
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== "string" || raw.model.length === 0) return null;
  if (
    raw.params !== undefined &&
    (typeof raw.params !== "object" || raw.params === null || Array.isArray(raw.params))
  ) {
    return null;
  }
  if (raw.allowSideEffects !== undefined && typeof raw.allowSideEffects !== "boolean") return null;
  return {
    model: raw.model,
    params:
      raw.params !== undefined
        ? (raw.params as Record<string, string | number | boolean>)
        : undefined,
    allowSideEffects: raw.allowSideEffects,
  };
}

/**
 * 5.14：参数、首请求与 config_hash 记录一致性。
 *
 * 逐项（任一不自洽即 ineligible；记录不足即 unverifiable）：
 * 1. 臂的 fork 必须是 model_params 编辑（调用方契约的防御性确认）；
 * 2. 编辑值形状（model/params/allowSideEffects）——形状不符判 ineligible（写入端
 *    保证形状，不符说明记录被外部改写）；
 * 3. **config_hash 同源**：臂与父的**已记录** config_hash 必须相等——臂缺
 *    config_hash（老文件）⇒ unverifiable（不可反推），不等 ⇒ ineligible；
 * 4. **首请求自洽**：臂自有首次 llm.call 的 request.model 必须等于编辑值 model；
 *    params 按整体覆盖语义核对（编辑给了 params ⇒ 与臂请求一致；未给 ⇒ 沿用父值）。
 */
export function findModelParamsRecordViolation(
  arm: RunDetail,
  parent: RunDetail,
): RecordCheckResult {
  const fork = arm.meta.fork;
  if (fork === null || fork.edit.field !== "model_params") {
    return {
      status: "ineligible",
      code: "NOT_MODEL_ARM",
      reason: `run ${arm.meta.id} 不是 model_params 编辑臂：不进实验比较`,
    };
  }
  const value = modelParamsValueOf(fork);
  if (value === null) {
    return {
      status: "ineligible",
      code: "EDIT_VALUE_MALFORMED",
      reason: `run ${arm.meta.id} 的 model_params 编辑值形状不符（缺 model 或类型错误）`,
    };
  }

  // 3. config_hash 同源（只比已记录值；绝不重算/反推）
  const armHash = arm.meta.config_hash;
  const parentHash = parent.meta.config_hash;
  if (armHash === undefined) {
    return {
      status: "unverifiable",
      code: "CONFIG_HASH_UNRECORDED",
      reason: `run ${arm.meta.id} 未记录 config_hash（老文件）：无法证明与父本同源，资格不可验证`,
    };
  }
  if (parentHash === undefined) {
    return {
      status: "unverifiable",
      code: "CONFIG_HASH_UNRECORDED",
      reason: `父本 ${parent.meta.id} 未记录 config_hash（老文件）：无法证明同源，资格不可验证`,
    };
  }
  if (armHash !== parentHash) {
    return {
      status: "ineligible",
      code: "CONFIG_HASH_MISMATCH",
      reason: `run ${arm.meta.id} 与父本 ${parent.meta.id} 的 config_hash 不同源：model_params 编辑只允许换 model/params，system prompt 与工具表必须逐字段一致`,
    };
  }

  // 4. 首请求自洽
  const firstCall = ownFirstLlmCall(arm);
  if (firstCall === null) {
    return {
      status: "unverifiable",
      code: "START_REQUEST_UNRECORDED",
      reason: `run ${arm.meta.id} 未记录自有 llm.call：无法核对首请求与编辑值自洽`,
    };
  }
  if (firstCall.request.model !== value.model) {
    return {
      status: "ineligible",
      code: "REQUEST_MODEL_MISMATCH",
      reason: `run ${arm.meta.id} 首请求模型（${firstCall.request.model}）与编辑值（${value.model}）不一致`,
    };
  }
  const recordedParams = scalarParamsOf(firstCall.request.params);
  const expectedParams =
    value.params !== undefined
      ? scalarParamsOf(value.params)
      : scalarParamsOf(ownFirstLlmCall(parent)?.request.params);
  if (stableJson(recordedParams) !== stableJson(expectedParams)) {
    return {
      status: "ineligible",
      code: "REQUEST_PARAMS_MISMATCH",
      reason: `run ${arm.meta.id} 首请求采样参数与编辑值（整体覆盖语义）不一致`,
    };
  }
  return eligible;
}

/** 录制工具表的风险名单：sideEffect 标记缺失按有副作用处理（执行门禁同款判据） */
export function riskyToolNames(tools: readonly Record<string, unknown>[] | undefined): string[] {
  if (tools === undefined) return [];
  return tools
    .map((raw) => {
      const wrapped = raw.function;
      const inner =
        typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
          ? (wrapped as Record<string, unknown>)
          : raw;
      return {
        name: typeof inner.name === "string" ? inner.name : "<未命名工具>",
        sideEffect: typeof inner.sideEffect === "boolean" ? inner.sideEffect : undefined,
      };
    })
    .filter((flag) => flag.sideEffect !== false)
    .map((flag) => flag.name);
}

/**
 * 5.16：记录工具表一致性与副作用声明。
 *
 * 1. **工具表逐字段一致**（臂 vs 父的首请求录制；含 sideEffect 字段的有无——
 *    给缺失标记"补齐"即不同源，与执行门禁的指纹语义一致）；
 * 2. **副作用声明自洽**：风险工具（sideEffect !== false）在场 ⇒ 臂编辑值必须
 *    显式 `allowSideEffects: true`（留痕）；显式 false 与风险工具并存 ⇒ 声明与
 *    记录矛盾。无风险工具 ⇒ 声明可有可无（合法）。
 */
export function findToolRecordViolation(arm: RunDetail, parent: RunDetail): RecordCheckResult {
  const armCall = ownFirstLlmCall(arm);
  const parentCall = ownFirstLlmCall(parent);
  if (armCall === null || parentCall === null) {
    return {
      status: "unverifiable",
      code: "START_REQUEST_UNRECORDED",
      reason: "臂或父本未记录自有 llm.call：无法核对工具表一致性",
    };
  }

  // 1. 工具表逐字段一致（键排序稳定 JSON；字段有无即差异）
  const armTools = stableJson(armCall.request.tools ?? null);
  const parentTools = stableJson(parentCall.request.tools ?? null);
  if (armTools !== parentTools) {
    return {
      status: "ineligible",
      code: "TOOLS_MISMATCH",
      reason: `run ${arm.meta.id} 与父本 ${parent.meta.id} 录制的工具表不一致（含 sideEffect 字段的有无）：实验比较只允许同源工具表`,
    };
  }

  // 2. 副作用声明自洽
  const risky = riskyToolNames(armCall.request.tools);
  if (risky.length === 0) return eligible;
  const fork = arm.meta.fork;
  const declared =
    fork !== null && fork.edit.field === "model_params"
      ? modelParamsValueOf(fork)?.allowSideEffects
      : undefined;
  if (declared === true) return eligible;
  if (declared === false) {
    return {
      status: "ineligible",
      code: "SIDE_EFFECT_CONTRADICTION",
      reason: `run ${arm.meta.id} 声明 allowSideEffects: false，但其工具表含未标记无副作用的工具（${risky.join("、")}）：声明与记录矛盾`,
    };
  }
  return {
    status: "ineligible",
    code: "SIDE_EFFECT_UNDECLARED",
    reason: `run ${arm.meta.id} 的工具表含未标记无副作用的工具（${risky.join("、")}）且未显式声明 allowSideEffects: true：多臂顺序执行会互相污染外部状态，历史比较如实拒绝`,
  };
}
