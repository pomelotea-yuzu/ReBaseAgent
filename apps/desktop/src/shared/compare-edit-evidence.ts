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
  | "START_CONTEXT_UNRECORDED"
  /** 链上相邻 parent 不连续：逐跳核对直接父失败（4.2） */
  | "CHAIN_BREAK"
  /** 分叉点 / 来源轨迹不在该侧当前投影视图内（ownOnly、独立边界截断；4.2） */
  | "SPAN_NOT_IN_VIEW";

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
    return projectContextFork(identity, fork, variantOf(target.detail), source.detail);
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
 * system/user prompt 与 messages 编辑（tasks 4.11/4.2）：原值取自来源 run
 * **自有**首次 llm.call 的实际请求——prompt 取对应启动消息 content，
 * messages 取整份请求 messages（代理单请求语义）。
 *
 * 消息缺证判据与既有提取器同源（`role` 匹配且 `content` 为字符串才算已记录；
 * draft-source.ts / fork-runner.ts 同款），找不到如实 unavailable，不补空串。
 * `sourceDetail === null` 表示来源 run 轨迹不在当前投影视图内（4.2 的
 * ownOnly / 独立边界截断情形），原值无从核对但不猜。
 */
function projectContextFork(
  identity: EditEvidenceIdentity,
  fork: NonNullable<RunDetail["meta"]["fork"]>,
  variant: EditEvidenceVariant,
  sourceDetail: RunDetail | null,
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
  if (sourceDetail === null) {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "SPAN_NOT_IN_VIEW",
      reason: `来源 run ${identity.sourceRunId} 的轨迹不在该侧当前投影视图内：启动上下文原值无从核对`,
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
      variant,
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
    variant,
    semantics: "from-scratch",
    tool: null,
    original: { kind: "value", value: message.content },
    updated,
    resumeAfterStep: null,
    boundaryStep: null,
  };
}

/**
 * result 编辑的视图级投影核心：在给定轨迹视图（直接父的自有详情，或某侧的
 * 投影 spans——4.2 逐跳）中定位分叉点取原值。v2 同源取值并携带整轮边界。
 */
function projectResultFork(
  sourceDetail: RunDetail,
  targetDetail: RunDetail,
  identity: EditEvidenceIdentity,
  fork: NonNullable<RunDetail["meta"]["fork"]>,
): DirectEditEvidence {
  return projectResultForkInView(
    identity,
    fork,
    variantOf(targetDetail),
    sourceDetail.spans,
    sourceDetail.meta.id,
  );
}

function variantOf(detail: RunDetail): EditEvidenceVariant {
  return detail.meta.format_version === FORMAT_VERSION ? "isolated-v2" : "plain-v1";
}

function projectResultForkInView(
  identity: EditEvidenceIdentity,
  fork: NonNullable<RunDetail["meta"]["fork"]>,
  variant: EditEvidenceVariant,
  viewSpans: readonly SpanLine[],
  sourceRunId: string,
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

  const atSpan = viewSpans.find((span) => span.id === fork.at_span);
  if (atSpan === undefined) {
    return {
      ...identity,
      status: "unavailable",
      reasonCode: "FORK_SPAN_NOT_FOUND",
      reason: `分叉点 ${fork.at_span} 未出现在来源 run ${sourceRunId} 的轨迹中：原值无法核对`,
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

  // v2 边界：resume_after_step（schema 保证 v2 fork 必带）；在同一视图定位该 step
  const resumeAfterStep = variant === "isolated-v2" ? (fork.resume_after_step ?? null) : null;
  const boundaryStep =
    resumeAfterStep !== null ? locateBoundaryStep(viewSpans, resumeAfterStep) : null;

  return {
    ...identity,
    status: "verified",
    variant,
    semantics: "shared-prefix",
    tool: atSpan.tool,
    original: { kind: "value", value: atSpan.result },
    updated,
    resumeAfterStep,
    boundaryStep,
  };
}

// ---------------------------------------------------------------------------
// tasks 4.2：多跳 / 兄弟的逐跳编辑证据链
//
// design D4：「多跳和兄弟比较逐跳列出从已确认共同祖先到两侧的来源路径，每跳
// 核对其直接父；不把整条链压缩成一次编辑。」
// ---------------------------------------------------------------------------

/** 逐跳投影的来源详情提供方：直接父子对中另一侧的 ready 详情（可能没有） */
export type SourceDetailProvider = (runId: string) => RunDetail | null;

/** 单侧的逐跳编辑证据链：从共同祖先（不含）到该侧叶，按链序排列 */
export interface SideHopChain {
  /** 该侧叶子 run id */
  readonly runId: string;
  /** 逐跳证据（链序）；共同祖先未确认时为空 */
  readonly hops: readonly DirectEditEvidence[];
}

/**
 * 从已确认的共同祖先到各 ready 侧逐跳投影编辑证据。
 *
 * - `ancestorId === null`（不同根 / 链不完整）：共同祖先未确认 ⇒ 不产出逐跳链
 *   （不按可见链首项推断根，不压缩、不猜测）；
 * - 每跳先核对直接父（hop.meta.parent 必须等于前一跳 id；不符 ⇒ CHAIN_BREAK）；
 * - 值级证据尽力投影：result 跳在**该侧**投影 spans 中定位分叉点（resolved 视图
 *   含全链前缀；ownOnly / 独立边界截断时如实 SPAN_NOT_IN_VIEW）；context 跳在
 *   来源 run 详情在比较对内时取其实际请求，否则 SPAN_NOT_IN_VIEW。
 */
export function deriveHopChains(
  items: readonly CompareRunItem[],
  ancestorId: string | null,
): readonly SideHopChain[] {
  if (ancestorId === null) {
    return [];
  }
  return items
    .filter((item): item is Extract<CompareRunItem, { status: "ready" }> => item.status === "ready")
    .map((side) => ({
      runId: side.runId,
      hops: deriveSideHops(side, ancestorId, (runId) => {
        const hit = items.find((item) => item.status === "ready" && item.runId === runId);
        return hit !== undefined && hit.status === "ready" ? hit.detail : null;
      }),
    }));
}

/** 单侧逐跳：从 chain 中祖先之后的位置起投影；祖先不在该侧链内 ⇒ 空链（不猜） */
function deriveSideHops(
  side: Extract<CompareRunItem, { status: "ready" }>,
  ancestorId: string,
  provideSource: SourceDetailProvider,
): readonly DirectEditEvidence[] {
  const chain = side.detail.chain;
  const ancestorIndex = chain.findIndex((hop) => hop.meta.id === ancestorId);
  if (ancestorIndex === -1) {
    return [];
  }

  const hops: DirectEditEvidence[] = [];
  for (let i = ancestorIndex + 1; i < chain.length; i++) {
    const hop = chain[i];
    const prev = chain[i - 1];
    if (hop === undefined || prev === undefined) {
      break; // 按不变量不可达（chain 连续）
    }
    const identity: EditEvidenceIdentity = {
      sourceRunId: prev.meta.id,
      targetRunId: hop.meta.id,
      field: hop.fork?.edit.field ?? "unknown",
      atSpanId: hop.fork?.at_span ?? "unknown",
    };

    // 每跳核对其直接父：链上 parent 声明必须与相邻前一项一致
    if (hop.meta.parent !== prev.meta.id) {
      hops.push({
        ...identity,
        status: "unavailable",
        reasonCode: "CHAIN_BREAK",
        reason: `链不连续：${hop.meta.id} 声明的父（${String(hop.meta.parent)}）不是前一跳 ${prev.meta.id}`,
        original: { kind: "unrecorded" },
        updated: presenceOf(hop.fork?.edit.value),
      });
      continue;
    }
    const fork = hop.fork;
    if (fork === null) {
      // 按读取层不变量不应出现（parent 已声明的 run 必有 fork）；防御性不猜
      hops.push({
        ...identity,
        status: "unavailable",
        reasonCode: "EDIT_VALUE_UNRECORDED",
        reason: `跳 ${hop.meta.id} 未记录 fork 元数据：无编辑事实可核对`,
        original: { kind: "unrecorded" },
        updated: { kind: "unrecorded" },
      });
      continue;
    }

    hops.push(projectHopFork(side.detail, hop, identity, fork, provideSource));
  }
  return hops;
}

/** 单跳的值级投影：result 跳在该侧视图定位；context 跳找来源 run 详情 */
function projectHopFork(
  sideDetail: RunDetail,
  hop: RunDetail["chain"][number],
  identity: EditEvidenceIdentity,
  fork: NonNullable<RunDetail["meta"]["fork"]>,
  provideSource: SourceDetailProvider,
): DirectEditEvidence {
  if (fork.edit.field === "result") {
    return projectResultForkInView(
      identity,
      fork,
      variantOfHop(hop),
      sideDetail.spans,
      identity.sourceRunId,
    );
  }
  if (
    fork.edit.field === "system_prompt" ||
    fork.edit.field === "user_message" ||
    fork.edit.field === "messages"
  ) {
    return projectContextFork(
      identity,
      fork,
      variantOfHop(hop),
      provideSource(identity.sourceRunId),
    );
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

function variantOfHop(hop: RunDetail["chain"][number]): EditEvidenceVariant {
  return hop.meta.format_version === FORMAT_VERSION ? "isolated-v2" : "plain-v1";
}

// ---------------------------------------------------------------------------
// tasks 4.3：不同根只核对实际输入配置
//
// design D4：「不同根不制造编辑关系，只列两侧真实启动输入/记录模型参数的
// 可核对差异，config_hash 不可反推完整配置。」
// ---------------------------------------------------------------------------

/** 单侧已记录的启动输入事实（全部取自该侧**自有**首次 llm.call 的实际请求） */
export interface SideInputFacts {
  readonly runId: string;
  /** 实际记录的模型（请求原值）；该侧无自有 llm.call 时 unrecorded */
  readonly model: EditValuePresence;
  /** 实际记录的 system 消息 content；未记录如实 unrecorded，不补空串 */
  readonly systemPrompt: EditValuePresence;
  /** 实际记录的首条 user 消息 content；同上 */
  readonly userMessage: EditValuePresence;
  /** 实际记录的采样参数（整份原样）；请求未带 params 时 unrecorded */
  readonly params: EditValuePresence;
}

export type DifferentRootComparison =
  | {
      readonly status: "facts";
      /** 与输入同序（左/右对应调用方视角），逐侧只列已记录事实 */
      readonly sides: readonly [SideInputFacts, SideInputFacts];
    }
  | { readonly status: "notApplicable"; readonly reason: string };

/**
 * 不同根（relation = unrelated）时列出两侧的实际启动输入事实。
 *
 * - 仅当两侧链完整且确无共同祖先时适用；否则 notApplicable（共同祖先未确认的
 *   链不得按「不同根」呈现，那是 incomplete 的口径）；
 * - 每侧事实来自该侧自有首次 llm.call（ownFirstLlmCall），role+字符串 content
 *   判据与 4.11 同源；无自有调用 ⇒ 各项 unrecorded，不猜、不补空；
 * - SHALL NOT 触碰 config_hash（不可反推完整 RunConfig），不生成编辑关系。
 */
export function deriveDifferentRootFacts(
  left: CompareRunItem,
  right: CompareRunItem,
  relation: { readonly kind: "common" | "unrelated" | "incomplete" },
): DifferentRootComparison {
  if (relation.kind !== "unrelated") {
    return {
      status: "notApplicable",
      reason:
        relation.kind === "common"
          ? "两侧有共同祖先：按逐跳编辑证据呈现，不按不同根核对"
          : "共同祖先未确认（链不完整）：不得按不同根呈现",
    };
  }
  if (left.status !== "ready" || right.status !== "ready") {
    return {
      status: "notApplicable",
      reason: "不同根判定要求两侧均可读：存在不可读侧时不构成完整对照",
    };
  }
  return {
    status: "facts",
    sides: [sideInputFactsOf(left.detail), sideInputFactsOf(right.detail)],
  };
}

function sideInputFactsOf(detail: RunDetail): SideInputFacts {
  const firstCall = ownFirstLlmCall(detail);
  if (firstCall === null) {
    const unrecorded: EditValuePresence = { kind: "unrecorded" };
    return {
      runId: detail.meta.id,
      model: unrecorded,
      systemPrompt: unrecorded,
      userMessage: unrecorded,
      params: unrecorded,
    };
  }
  return {
    runId: detail.meta.id,
    model: { kind: "value", value: firstCall.request.model },
    systemPrompt: recordedContentOf(firstCall, "system"),
    userMessage: recordedContentOf(firstCall, "user"),
    params: presenceOf(firstCall.request.params),
  };
}

function recordedContentOf(
  call: Extract<SpanLine, { kind: "llm.call" }>,
  role: "system" | "user",
): EditValuePresence {
  const message = call.request.messages.find(
    (m) => m.role === role && typeof m.content === "string",
  );
  return message === undefined ? { kind: "unrecorded" } : { kind: "value", value: message.content };
}
