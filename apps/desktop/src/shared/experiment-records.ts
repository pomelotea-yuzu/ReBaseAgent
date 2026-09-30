import type { SpanLine } from "@rebaseagent/trace-sdk/schema";
import type { CompareRunItem, RunDetail } from "./ipc";

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
  /** 直接父的 meta（臂 chain 父跳即可；null = 父 meta 不可得，同源不可验证） */
  parentMeta: RunDetail["meta"] | null,
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
  const parentHash = parentMeta?.config_hash;
  if (armHash === undefined) {
    return {
      status: "unverifiable",
      code: "CONFIG_HASH_UNRECORDED",
      reason: `run ${arm.meta.id} 未记录 config_hash（老文件）：无法证明与父本同源，资格不可验证`,
    };
  }
  if (parentMeta === null) {
    return {
      status: "unverifiable",
      code: "PARENT_META_UNAVAILABLE",
      reason: `直接父本的 meta 不在本次已校验读取内：config_hash 同源无法核对，资格不可验证`,
    };
  }
  if (parentHash === undefined) {
    return {
      status: "unverifiable",
      code: "CONFIG_HASH_UNRECORDED",
      reason: `父本 ${parentMeta.id} 未记录 config_hash（老文件）：无法证明同源，资格不可验证`,
    };
  }
  if (armHash !== parentHash) {
    return {
      status: "ineligible",
      code: "CONFIG_HASH_MISMATCH",
      reason: `run ${arm.meta.id} 与父本 ${String(parentMeta?.id)} 的 config_hash 不同源：model_params 编辑只允许换 model/params，system prompt 与工具表必须逐字段一致`,
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
  // 整体覆盖语义：编辑给了 params ⇒ 臂请求必须等于编辑值；未给 ⇒ 沿用父值——
  // 父请求 params 在选择集内不可得（父 spans 不在响应），此时与
  // config_hash 同源（已由上一步证明）共同承担「沿用父值」的自洽证据，
  // 本核对只覆盖「编辑显式给了 params」的半边，不猜缺省半边的具体值。
  const expectedParams = value.params !== undefined ? scalarParamsOf(value.params) : null;
  if (expectedParams !== null && stableJson(recordedParams) !== stableJson(expectedParams)) {
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
export function findToolRecordViolation(
  arm: RunDetail,
  /** 直接父的 meta（臂 chain 父跳即可；null = 父 meta 不可得，同源不可验证） */
  parentMeta: RunDetail["meta"] | null,
): RecordCheckResult {
  const armCall = ownFirstLlmCall(arm);
  if (armCall === null) {
    return {
      status: "unverifiable",
      code: "START_REQUEST_UNRECORDED",
      reason: `run ${arm.meta.id} 未记录自有 llm.call：无法核对工具表与副作用声明`,
    };
  }

  // 1. 工具表一致性由 **config_hash 同源**承担（指纹的输入含 system prompt + 工具表
  //    逐字段——含 sideEffect 字段的有无；相等 ⇒ 逐字段一致，不重算、不反推）。
  //    父 spans 不在比较响应内，逐字段比对不可得 ⇒ 缺 hash 时如实 unverifiable。
  const armHash = arm.meta.config_hash;
  const parentHash = parentMeta?.config_hash;
  if (parentMeta === null || armHash === undefined || parentHash === undefined) {
    return {
      status: "unverifiable",
      code: parentMeta === null ? "PARENT_META_UNAVAILABLE" : "CONFIG_HASH_UNRECORDED",
      reason:
        parentMeta === null
          ? "直接父本的 meta 不在本次已校验读取内：工具表同源无法核对，资格不可验证"
          : `臂或父本 ${parentMeta.id} 未记录 config_hash（老文件）：工具表同源无法由指纹证明，资格不可验证`,
    };
  }
  if (armHash !== parentHash) {
    return {
      status: "ineligible",
      code: "TOOLS_MISMATCH",
      reason: `run ${arm.meta.id} 与父本 ${parentMeta.id} 的 config_hash 不同源（工具表/system prompt 逐字段一致被破坏，含 sideEffect 字段的有无）`,
    };
  }

  // 2. 副作用声明自洽（判据 = 臂自身首请求录制的工具表）
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

// ---------------------------------------------------------------------------
// tasks 5.11–5.13：选择集级实验门禁与批次身份
//
// design D5 / model-experiments delta：
// - 含 model_params 的选择集**必须**走实验门禁：全部对象为 model_params 臂、
//   直接 parent 相同、父链完整、记录校验通过才可实验比较；混入普通 run 或
//   父本不能退回普通比较绕过（scenario「异父混选与相同实验标签不能绕过」）；
// - experimentId 只用于真实分组：相同标签不能豁免父本/完整性校验，不同标签
//   的合法同父臂可比较但**保留真实批次身份**（不伪造同批）；
// - 已封存 ≠ 正常结束：合法失败臂（error/上限结局）不因结局自动拒绝——
//   判据不读结局（outcome 与资格正交）；
// - 任一臂 ownOnly（父链断裂）⇒ ineligible；读取失败 ⇒ unverifiable；
//   config_hash/首请求/工具表/声明不自洽 ⇒ ineligible；证据缺失 ⇒ unverifiable
//   （scenario「不完整未封存与前置缺证明确拒绝」）。
// ---------------------------------------------------------------------------

export type ExperimentGateStatus = "notExperiment" | "eligible" | "ineligible" | "unverifiable";

/** 选择集级实验门禁结论 */
export interface ExperimentGate {
  readonly status: ExperimentGateStatus;
  readonly code: string;
  readonly reason: string;
  /**
   * eligible 时的批次身份：共同直接父 run id + 各臂**已记录** experimentId
   * （原样保留，缺省为 null——不伪造同批、不合并不同标签）。
   */
  readonly batch: {
    readonly parentRunId: string;
    readonly experimentIds: readonly (string | null)[];
  } | null;
}

/** 单个 ready 项是否 model_params 编辑臂 */
function isModelParamsArm(detail: RunDetail): boolean {
  return detail.meta.fork?.edit.field === "model_params";
}

/** 臂的直接父 meta：从 chain 倒数第二跳取（complete 链倒数第二跳即直接父） */
function parentMetaOf(detail: RunDetail): RunDetail["meta"] | null {
  if (detail.chain.length < 2) return null;
  return detail.chain[detail.chain.length - 2]?.meta ?? null;
}

/**
 * 选择集级实验门禁（输入 = 比较响应的全部 items，顺序即请求序）。
 * 纯函数、恒可用；notExperiment 表示选择集不含 model_params 臂——
 * 实验门禁不适用，调用方走普通比较呈现。
 */
export function deriveExperimentGate(items: readonly CompareRunItem[]): ExperimentGate {
  const notExperiment: ExperimentGate = {
    status: "notExperiment",
    code: "NOT_EXPERIMENT",
    reason: "选择集不含 model_params 编辑臂：按普通比较呈现",
    batch: null,
  };

  const readyItems = items.filter(
    (item): item is Extract<CompareRunItem, { status: "ready" }> => item.status === "ready",
  );
  if (readyItems.length === 0) return notExperiment;
  const anyArm = readyItems.some((item) => isModelParamsArm(item.detail));
  if (!anyArm) return notExperiment;

  // 读取失败的侧：历史比较无从核对 ⇒ unverifiable（重试仅重新验证记录）
  const unavailable = items.find((item) => item.status === "unavailable");
  if (unavailable !== undefined) {
    return {
      status: "unverifiable",
      code: "RUN_UNREADABLE",
      reason:
        unavailable.status === "unavailable"
          ? `run ${unavailable.runId} 不可读（${unavailable.code}）：${unavailable.reason}——实验比较资格不可验证`
          : "存在不可读侧",
      batch: null,
    };
  }

  // 混选：全部对象都必须是 model_params 臂（experimentId 恰相同不能豁免）
  const mixed = readyItems.filter((item) => !isModelParamsArm(item.detail));
  if (mixed.length > 0) {
    return {
      status: "ineligible",
      code: "MIXED_SELECTION",
      reason: `选择集混入非实验臂（${mixed
        .map((item) => item.runId)
        .join(
          "、",
        )}）：普通 run/父本与 model_params 臂不能同批比较，也不能退回普通比较绕过实验资格；各记录可单独打开`,
      batch: null,
    };
  }

  // 父链完整（ownOnly = 祖先缺失 ⇒ 链结论与祖先增量不可信）。⚠️ 先于「同父」
  // 核对：ownOnly 臂的 parent 声明本身已不可信，不能拿它做异父判定。
  const ownOnly = readyItems.filter((item) => item.detail.completeness === "ownOnly");
  if (ownOnly.length > 0) {
    return {
      status: "ineligible",
      code: "CHAIN_INCOMPLETE",
      reason: `臂 ${ownOnly.map((item) => item.runId).join("、")} 父链不完整（ownOnly）：祖先增量与共同基线不可信，不生成实验比较`,
      batch: null,
    };
  }

  // 直接 parent 相同（experimentId 相同不能豁免本条）
  const parentId = readyItems[0]?.detail.meta.parent ?? null;
  const differing = readyItems.filter((item) => item.detail.meta.parent !== parentId);
  if (parentId === null || differing.length > 0) {
    return {
      status: "ineligible",
      code: "PARENT_DIFFERS",
      reason:
        parentId === null
          ? "实验臂缺少直接父本（根 run 不是实验臂）：不构成同父实验比较"
          : `臂的直接父本不一致（${differing
              .map((item) => `${item.runId}→${String(item.detail.meta.parent)}`)
              .join("、")}）：异父臂不可比，experimentId 标签相同也不能豁免`,
      batch: null,
    };
  }

  // 逐臂记录判据（5.14/5.16）：父 meta 取自臂 chain 父跳（比较响应内已校验事实）
  const firstViolation = (() => {
    for (const item of readyItems) {
      const parentMeta = parentMetaOf(item.detail);
      const modelCheck = findModelParamsRecordViolation(item.detail, parentMeta);
      if (modelCheck.status !== "eligible") return modelCheck;
      const toolCheck = findToolRecordViolation(item.detail, parentMeta);
      if (toolCheck.status !== "eligible") return toolCheck;
    }
    return null;
  })();
  if (firstViolation !== null) {
    return {
      status: firstViolation.status,
      code: firstViolation.code,
      reason: firstViolation.reason,
      batch: null,
    };
  }

  // 批次身份：各臂已记录 experimentId 原样保留（缺省 null——不伪造同批）
  const experimentIds = readyItems.map((item) => {
    const fork = item.detail.meta.fork;
    if (fork === null || fork.edit.field !== "model_params") return null;
    const value = fork.edit.value as { experimentId?: unknown } | undefined;
    const id = value?.experimentId;
    return typeof id === "string" ? id : null;
  });
  return {
    status: "eligible",
    code: "OK",
    reason: "全部对象为同父、父链完整且记录校验通过的 model_params 臂",
    batch: { parentRunId: parentId ?? "", experimentIds },
  };
}
