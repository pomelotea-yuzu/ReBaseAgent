import { FORMAT_VERSION } from "@rebaseagent/trace-sdk/schema";
import type { SpanLine } from "@rebaseagent/trace-sdk/schema";
import type { CompareRunItem } from "./ipc";
import type { RunDetail } from "./ipc";

/**
 * U7（improve-branch-comparison）tasks 4.1/4.10/4.11：**直接父子**的编辑证据投影。
 *
 * design D4 判据：
 * - 修改投影三态 `verified / unavailable / notApplicable`，每项带源 run、目标
 *   run、字段和可验证定位（分叉点 span id）；
 * - 新值来自子 `meta.fork.edit.value`（写入时逐字节原样），原值按字段从**已校验**
 *   父轨迹/请求提取：result 定位 `at_span` 指向的 `tool.invoke.result`；
 *   prompt 取**自有**首次 llm.call 的实际启动消息；messages 取该请求的整份
 *   messages（代理单请求语义）；verified 项以 `semantics` 分型
 *   （shared-prefix / from-scratch / single-request），语义可辨；
 * - 未知字段不猜：原样保留字段名与已记录新值 + 不可核对原因，不补空串；
 * - **真实空值与未记录严格分开**：`""` / `null` 是已记录的真实值（`kind:"value"`），
 *   只有字面缺失（`undefined`）才是 `kind:"unrecorded"`——不生成伪空 diff；
 * - 隔离（v2）与普通（v1）分同型：v2 额外携带 `resume_after_step` 整轮续跑边界
 *   （在来源轨迹中定位该 agent.step；找不到如实标未定位，不影响前后值本身）；
 * - **措辞纪律**：verified 的 result 项携带 `tool`（编辑目标工具名）——工具结果
 *   改动 SHALL NOT 描述成文件修改（措辞归 4.12 视图层）。
 *
 * 输入直接复用 `runs:compare` 响应项（CompareRunItem）：main 已完成读取与 schema
 * 校验，本模块不再重复 parse——纯函数，零 Electron / 零 Node。
 */

/** 单个值的在场形态：真实值（含空串/null/对象）与未记录严格分开 */
export type EditValuePresence =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "unrecorded" };

/** 分叉版本分型：runLoop 直录恒 v1；仅隔离 CheckpointTracer 覆写 v2 */
export type EditEvidenceVariant = "plain-v1" | "isolated-v2";

/** 不可核对的稳定码（受控，供视图分层措辞与实机断言） */
export type EditUnavailableCode =
  /** 来源侧（父）不可读：子侧新值仍可见 */
  | "PARENT_UNREADABLE"
  /** fork.edit.field 不属于已知字段集：原样保留字段与值，不猜语义 */
  | "UNKNOWN_EDIT_FIELD"
  /** 已知字段但本投影未覆盖（model_params 归 §5 实验门禁） */
  | "FIELD_NOT_PROJECTED"
  /** 分叉点 span 未出现在来源轨迹中 */
  | "FORK_SPAN_NOT_FOUND"
  /** 分叉点存在但不是 tool.invoke：result 原值无从谈起 */
  | "FORK_SPAN_NOT_TOOL"
  /** fork.edit.value 字面缺失（未记录 ≠ 空串） */
  | "EDIT_VALUE_UNRECORDED"
  /** 来源 run 未记录可核对的首次 llm.call / 启动消息（prompt/messages 原值缺证） */
  | "START_CONTEXT_UNRECORDED";

/** 编辑语义分型（场景「直接父子展示真实编辑前后值」：从头重跑、单请求语义可辨） */
export type EditSemantics =
  /** result 编辑：共享父前缀 + 单点编辑（v2 整轮边界见 resumeAfterStep） */
  | "shared-prefix"
  /** system_prompt / user_message：从头重跑的独立执行，不共享前缀 */
  | "from-scratch"
  /** messages（代理分叉）：单请求级重发，只影响该次请求 */
  | "single-request";

/** 编辑证据的身份四元组（direct 证据恒可给出；notApplicable 可能给不全） */
export interface EditEvidenceIdentity {
  /** 编辑来源（直接父 run） */
  readonly sourceRunId: string;
  /** 编辑目标（子 fork run） */
  readonly targetRunId: string;
  /** fork.edit.field 原样（未知字段不翻译） */
  readonly field: string;
  /** 分叉点 span id（ForkSchema.at_span，恒非空） */
  readonly atSpanId: string;
}

export type DirectEditEvidence =
  | (EditEvidenceIdentity & {
      readonly status: "verified";
      readonly variant: EditEvidenceVariant;
      /** 编辑语义分型（result=shared-prefix；prompt=from-scratch；messages=single-request） */
      readonly semantics: EditSemantics;
      /** 编辑目标工具名（result 编辑来自父轨迹 tool.invoke；prompt/messages 编辑无工具为 null） */
      readonly tool: string | null;
      /** 原值（已校验父轨迹/请求中的真实值，含 null/空串） */
      readonly original: { readonly kind: "value"; readonly value: unknown };
      /** 新值（子 fork.edit.value 原样，含真实空串） */
      readonly updated: { readonly kind: "value"; readonly value: unknown };
      /**
       * v2 整轮续跑边界（fork.resume_after_step 原样）；v1 与 prompt/messages 恒 null。
       * 定位结果见 `boundaryStep`。
       */
      readonly resumeAfterStep: string | null;
      /** v2 边界在来源轨迹中定位到的 agent.step（id 与轮号）；未定位为 null */
      readonly boundaryStep: { readonly spanId: string; readonly n: number } | null;
    })
  | (EditEvidenceIdentity & {
      readonly status: "unavailable";
      readonly reasonCode: EditUnavailableCode;
      /** 受控中文原因（不含路径/errno/堆栈） */
      readonly reason: string;
      /** 原值：尽力保留已得一侧；缺证为 unrecorded，不造空值 */
      readonly original: EditValuePresence;
      /** 新值：同上（来自子 fork 的真实记录） */
      readonly updated: EditValuePresence;
    })
  | {
      readonly status: "notApplicable";
      /** 不适用的受控原因：非直接父子对 / 子不是分叉 / 两侧均不可读 */
      readonly reason: string;
    };

/** 值在场形态：字面缺失（undefined）才算未记录——`""`/`null` 是真实值 */
function presenceOf(value: unknown): EditValuePresence {
  return value === undefined ? { kind: "unrecorded" } : { kind: "value", value };
}

/** 来源轨迹中定位 v2 整轮边界 step；找不到不猜轮号 */
function locateBoundaryStep(
  spans: readonly SpanLine[],
  resumeAfterStep: string,
): { spanId: string; n: number } | null {
  const step = spans.find((span) => span.id === resumeAfterStep && span.kind === "agent.step");
  return step === undefined || step.kind !== "agent.step" ? null : { spanId: step.id, n: step.n };
}

/** 判定一对 ready 侧的方向：返回 [source(父), target(子)]；非直接父子返回 null */
function orientPair(
  left: Extract<CompareRunItem, { status: "ready" }>,
  right: Extract<CompareRunItem, { status: "ready" }>,
):
  | [Extract<CompareRunItem, { status: "ready" }>, Extract<CompareRunItem, { status: "ready" }>]
  | null {
  if (left.detail.meta.parent === right.runId) return [right, left];
  if (right.detail.meta.parent === left.runId) return [left, right];
  return null;
}

/**
 * 投影一对比较对象的**直接父子编辑证据**。
 *
 * - 两侧均 ready：按 `meta.parent` 判定方向；互不为父 ⇒ notApplicable（多跳/兄弟/
 *   不同根的呈现归 4.2/4.3，本函数不越界）；
 * - 一侧 ready：仅当 ready 侧是 fork 且其 parent 指向不可读侧时才建立方向
 *   （PARENT_UNREADABLE，子新值仍可见）；否则不猜方向 ⇒ notApplicable；
 * - 两侧均不可读：无核对前提 ⇒ notApplicable。
 */
export function deriveDirectEditEvidence(
  left: CompareRunItem,
  right: CompareRunItem,
): DirectEditEvidence {
  if (left.status === "unavailable" && right.status === "unavailable") {
    return { status: "notApplicable", reason: "两侧均不可读，不构成父子编辑核对前提" };
  }
  if (left.status === "ready") {
    if (right.status === "ready") {
      const oriented = orientPair(left, right);
      if (oriented === null) {
        return { status: "notApplicable", reason: "两侧互不为直接父本，不构成直接父子编辑" };
      }
      return projectChildFork(oriented[0], oriented[1]);
    }
    // 恰左侧 ready：只有「ready 是 fork 且 parent 指向不可读侧」才建立方向
    return projectSingleReadySide(left, right);
  }
  if (right.status === "ready") {
    return projectSingleReadySide(right, left);
  }
  return { status: "notApplicable", reason: "两侧均不可读，不构成父子编辑核对前提" };
}

/**
 * 恰一侧 ready 的方向判定：ready 侧是 fork 且其 parent 指向不可读侧时建立方向
 * （PARENT_UNREADABLE，子新值仍可见）；否则不猜方向 ⇒ notApplicable。
 */
function projectSingleReadySide(
  readySide: Extract<CompareRunItem, { status: "ready" }>,
  unreadable: Extract<CompareRunItem, { status: "unavailable" }>,
): DirectEditEvidence {
  const fork = readySide.detail.meta.fork;
  if (fork === null || readySide.detail.meta.parent !== unreadable.runId) {
    return {
      status: "notApplicable",
      reason: "不可读侧身份无法参与父子判定，不猜方向",
    };
  }
  return {
    status: "unavailable",
    reasonCode: "PARENT_UNREADABLE",
    reason: `来源 run ${unreadable.runId} 不可读（${unreadable.code}）：${unreadable.reason}`,
    sourceRunId: unreadable.runId,
    targetRunId: readySide.runId,
    field: fork.edit.field,
    atSpanId: fork.at_span,
    original: { kind: "unrecorded" },
    updated: presenceOf(fork.edit.value),
  };
}

/** 从已建立的（父 source, 子 target）投影子 fork 的编辑证据 */
function projectChildFork(
  source: Extract<CompareRunItem, { status: "ready" }>,
  target: Extract<CompareRunItem, { status: "ready" }>,
): DirectEditEvidence {
  const fork = target.detail.meta.fork;
  if (fork === null) {
    return {
      status: "notApplicable",
      reason: `目标 run ${target.runId} 不是分叉（无 fork 元数据）`,
    };
  }
  const identity: EditEvidenceIdentity = {
    sourceRunId: source.runId,
    targetRunId: target.runId,
    field: fork.edit.field,
    atSpanId: fork.at_span,
  };

  if (fork.edit.field === "result") {
    return projectResultFork(source.detail, target.detail, identity, fork);
  }
  if (
    fork.edit.field === "system_prompt" ||
    fork.edit.field === "user_message" ||
    fork.edit.field === "messages"
  ) {
    return projectContextFork(source.detail, target.detail, identity, fork);
  }
  if (fork.edit.field === "model_params") {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "FIELD_NOT_PROJECTED",
      reason: "model_params 编辑属于模型实验比较（另有资格门禁），普通比较不投影前后值",
      original: { kind: "unrecorded" },
      updated: presenceOf(fork.edit.value),
    };
  }
  return {
    ...identity,
    status: "unavailable",
    reasonCode: "UNKNOWN_EDIT_FIELD",
    reason: `未知编辑字段「${fork.edit.field}」：原值无法核对，仅展示已记录新值`,
    original: { kind: "unrecorded" },
    updated: presenceOf(fork.edit.value),
  };
}

/**
 * 来源 run 的**自有**首次 llm.call（leafSpanIds 界定自有段）。
 *
 * ⚠️ 反例纪律：result 链的父 run 详情是合并视图（spanScope=resolved），其前缀里
 * 含祖先的 llm.call——「实际启动上下文」必须取父本**自有**的首次调用，
 * 不能按合并轨迹第一个 llm.call 取（那是祖先的请求）。
 */
function ownFirstLlmCall(sourceDetail: RunDetail): Extract<SpanLine, { kind: "llm.call" }> | null {
  const own = new Set(sourceDetail.leafSpanIds);
  const call = sourceDetail.spans.find((span) => span.kind === "llm.call" && own.has(span.id));
  return call === undefined || call.kind !== "llm.call" ? null : call;
}

/**
 * system/user prompt 与 messages 编辑（tasks 4.11）：原值取自来源 run
 * **自有**首次 llm.call 的实际请求——prompt 取对应启动消息 content，
 * messages 取整份请求 messages（代理单请求语义）。
 *
 * 消息缺证判据与既有提取器同源（`role` 匹配且 `content` 为字符串才算已记录；
 * draft-source.ts / fork-runner.ts 同款），找不到如实 unavailable，不补空串。
 */
function projectContextFork(
  sourceDetail: RunDetail,
  targetDetail: RunDetail,
  identity: EditEvidenceIdentity,
  fork: NonNullable<RunDetail["meta"]["fork"]>,
): DirectEditEvidence {
  const updated = presenceOf(fork.edit.value);
  if (updated.kind === "unrecorded") {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "EDIT_VALUE_UNRECORDED",
      reason: "编辑新值未记录：无法核对前后值",
      original: { kind: "unrecorded" },
      updated,
    };
  }

  const firstCall = ownFirstLlmCall(sourceDetail);
  if (firstCall === null) {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "START_CONTEXT_UNRECORDED",
      reason: `来源 run ${sourceDetail.meta.id} 未记录自有 llm.call：实际启动上下文无从核对`,
      original: { kind: "unrecorded" },
      updated,
    };
  }

  if (fork.edit.field === "messages") {
    // 代理分叉：原值 = 首次请求的整份 messages（单请求级重发语义）
    return {
      ...identity,
      status: "verified",
      variant: "plain-v1",
      semantics: "single-request",
      tool: null,
      original: { kind: "value", value: firstCall.request.messages },
      updated,
      resumeAfterStep: null,
      boundaryStep: null,
    };
  }

  // system_prompt / user_message：原值 = 首次请求中对应启动消息的 content
  const role = fork.edit.field === "system_prompt" ? "system" : "user";
  const label = fork.edit.field === "system_prompt" ? "system 消息" : "首条 user 消息";
  const message = firstCall.request.messages.find(
    (m) => m.role === role && typeof m.content === "string",
  );
  if (message === undefined) {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "START_CONTEXT_UNRECORDED",
      reason: `来源 run ${sourceDetail.meta.id} 的首次请求没有可核对的${label}：原值无从核对`,
      original: { kind: "unrecorded" },
      updated,
    };
  }
  return {
    ...identity,
    status: "verified",
    variant: "plain-v1",
    semantics: "from-scratch",
    tool: null,
    original: { kind: "value", value: message.content },
    updated,
    resumeAfterStep: null,
    boundaryStep: null,
  };
}

/** result 编辑：v1 按 at_span 定位父 tool.invoke；v2 同源取值并携带整轮边界 */
function projectResultFork(
  sourceDetail: RunDetail,
  targetDetail: RunDetail,
  identity: EditEvidenceIdentity,
  fork: NonNullable<RunDetail["meta"]["fork"]>,
): DirectEditEvidence {
  const updated = presenceOf(fork.edit.value);
  if (updated.kind === "unrecorded") {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "EDIT_VALUE_UNRECORDED",
      reason: "编辑新值未记录：无法核对前后值",
      original: { kind: "unrecorded" },
      updated,
    };
  }

  const isV2 = targetDetail.meta.format_version === FORMAT_VERSION;
  const atSpan = sourceDetail.spans.find((span) => span.id === fork.at_span);
  if (atSpan === undefined) {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "FORK_SPAN_NOT_FOUND",
      reason: `分叉点 ${fork.at_span} 未出现在来源 run ${sourceDetail.meta.id} 的轨迹中：原值无法核对`,
      original: { kind: "unrecorded" },
      updated,
    };
  }
  if (atSpan.kind !== "tool.invoke") {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "FORK_SPAN_NOT_TOOL",
      reason: `分叉点 ${fork.at_span} 是 ${atSpan.kind} 而非 tool.invoke：result 原值无从核对`,
      original: { kind: "unrecorded" },
      updated,
    };
  }

  // v2 边界：resume_after_step（schema 保证 v2 fork 必带）；在来源轨迹定位该 step
  const resumeAfterStep = isV2 ? (fork.resume_after_step ?? null) : null;
  const boundaryStep =
    resumeAfterStep !== null ? locateBoundaryStep(sourceDetail.spans, resumeAfterStep) : null;

  return {
    ...identity,
    status: "verified",
    variant: isV2 ? "isolated-v2" : "plain-v1",
    semantics: "shared-prefix",
    tool: atSpan.tool,
    original: { kind: "value", value: atSpan.result },
    updated,
    resumeAfterStep,
    boundaryStep,
  };
}
