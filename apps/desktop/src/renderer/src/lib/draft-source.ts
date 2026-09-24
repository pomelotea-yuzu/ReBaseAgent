import type { SpanLine } from "@rebaseagent/trace-sdk";
import type { RunDetail } from "@shared/ipc";
import type { CallDraftField, CallDraftSource } from "./debugging-drafts";
import { prettyJson } from "./format";
import { scalarRequestParams } from "./model-ab";

/**
 * U3（preserve-debugging-drafts）任务 1.4：草稿「源基线」的捕获与恢复重验。
 *
 * 设计依据 design.md D2：
 * - 捕获（`captureCallDraftSource`）：编辑器打开时从**已校验详情**记录编辑目标所依赖的
 *   源身份与内容事实（run 级资格事实 + 目标 span 内容事实），随条目落库（见
 *   debugging-drafts 的 `CallDraftEntry.source` / `ModelAbDraftEntry.source`）。
 * - 重验（`revalidateCallDraftSource` / `revalidateModelAbDraftSource`）：恢复草稿时与
 *   当前详情逐项比较——详情缺失/读取失败、目标 span 消失 ⇒ source_missing；运行状态、
 *   自有叶子、配置指纹、隔离/代理来源等**既有入口条件**不再成立 ⇒ capability_invalid；
 *   prompt / A/B 还要**重推首次 llm.call 身份**（`detail.spans` 里第一个 llm.call 必须
 *   仍是草稿目标 span——不得跳过首次调用改用后续调用，也不仅凭 span ID 相同放行，
 *   资格事实变化同样拦截）；编辑所依赖的源内容改变 ⇒ source_changed。
 * - 三类拦截都**保留草稿**，只收回执行资格；恢复原来源并重新验证通过后才解禁。
 *   「恢复草稿」本身不等于授权或可执行（既有字段校验、预检、授权流程照旧叠加）。
 * - 不新增算法版本签名或跨重载迁移：草稿不跨 renderer 会话，重验只比较事实源与
 *   当前门禁；无源基线的旧条目按「无法核对来源」保守拒绝。
 *
 * 与编辑器既有门禁的关系：本模块只核对「来源还认不认这张草稿」；未配置、空 fork、
 * 非法 params 等字段级校验仍由 promptForkGuard / modelAbGuard / 各字段契约负责，
 * 预检与授权仍走 loadForkCapability / 本次显式授权（D4）。2.x 接线时两者叠加。
 */

/** 重验结论：eligible = 来源与既有资格均通过；blocked = 保留草稿但禁止执行 */
export type DraftSourceVerdict =
  | { readonly kind: "eligible" }
  | {
      readonly kind: "blocked";
      /** source_missing = 详情缺失/读取失败/run 或 span 消失；source_changed = 编辑所依赖的源内容已改变；capability_invalid = 既有入口条件不再成立 */
      readonly cause: "source_missing" | "source_changed" | "capability_invalid";
      /** 可直接展示的原因 */
      readonly reason: string;
    };

function eligible(): DraftSourceVerdict {
  return { kind: "eligible" };
}

function blocked(
  cause: Extract<DraftSourceVerdict, { kind: "blocked" }>["cause"],
  reason: string,
): DraftSourceVerdict {
  return { kind: "blocked", cause, reason };
}

/** 稳定内容签名：同源 JSON 数据的紧凑序列化（比较用，不落盘、不参与算法版本化） */
function signature(value: unknown): string {
  return JSON.stringify(value);
}

/** 从请求消息中取首条字符串 system / user 消息内容（与 replay 层定位规则同源） */
export function startupContents(messages: ReadonlyArray<{ role: unknown; content?: unknown }>): {
  system: string | null;
  user: string | null;
} {
  let system: string | null = null;
  let user: string | null = null;
  for (const message of messages) {
    if (system === null && message.role === "system" && typeof message.content === "string") {
      system = message.content;
    }
    if (user === null && message.role === "user" && typeof message.content === "string") {
      user = message.content;
    }
    if (system !== null && user !== null) break;
  }
  return { system, user };
}

/**
 * 工具结果的展示文本（与 DetailPanel.toolMessageText 同语义；任务 2.1 接线后
 * 编辑器共用本实现，比较基准与展示文本不再可能漂移）。
 */
export function toolResultText(span: Extract<SpanLine, { kind: "tool.invoke" }>): string {
  if (span.error !== null) return `工具执行失败：${span.error}`;
  const result = span.result;
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  return prettyJson(result);
}

/** 当前详情的 run 级资格事实（捕获与重验共用同一派生，避免两侧口径漂移） */
function runFactsOf(run: RunDetail): {
  status: RunDetail["status"];
  leafSpanIds: readonly string[];
  configHash: string | undefined;
  proxy: boolean;
  isolated: boolean;
} {
  return {
    status: run.status,
    leafSpanIds: run.leafSpanIds,
    configHash: run.meta.config_hash,
    proxy: run.meta.source?.kind === "proxy",
    isolated: run.meta.workspace !== undefined,
  };
}

/**
 * 从已校验详情捕获编辑目标的源基线（编辑器打开时调用，随 ensure 落库）。
 * 只读取事实，不校验格式——格式校验由详情读取层（RunDetailSchema）负责。
 */
export function captureCallDraftSource(
  run: RunDetail,
  span: Extract<SpanLine, { kind: "llm.call" | "tool.invoke" }>,
): CallDraftSource {
  const facts = runFactsOf(run);
  if (span.kind === "tool.invoke") {
    return {
      runStatus: facts.status,
      leafSpanIds: [...facts.leafSpanIds],
      configHash: facts.configHash,
      proxy: facts.proxy,
      isolated: facts.isolated,
      target: { kind: "tool.invoke" },
    };
  }
  const startup = startupContents(span.request.messages);
  return {
    runStatus: facts.status,
    leafSpanIds: [...facts.leafSpanIds],
    configHash: facts.configHash,
    proxy: facts.proxy,
    isolated: facts.isolated,
    target: {
      kind: "llm.call",
      startupSystem: startup.system,
      startupUser: startup.user,
      model: span.request.model,
      paramsSignature: signature(scalarRequestParams(span.request.params)),
      toolsSignature: signature(span.request.tools ?? null),
      messagesSignature: signature(span.request.messages),
    },
  };
}

// ---------------------------------------------------------------------------
// 重验：恢复草稿时核对来源与既有资格
// ---------------------------------------------------------------------------

/** 调用类草稿（result / system_prompt / user_message / messages）的重验输入 */
export interface CallDraftSourceCheckInput {
  readonly runId: string;
  readonly spanId: string;
  readonly field: CallDraftField;
  /** 草稿基线（result 字段的源内容比较基准：登记时刻的工具结果文本） */
  readonly baseline: string;
  /** 登记时刻的源基线；undefined = 旧条目无源基线（保守拒绝） */
  readonly source: CallDraftSource | undefined;
  /** 当前已校验详情；null = 详情缺失或读取失败 */
  readonly detail: RunDetail | null;
}

/** A/B 批次草稿的重验输入 */
export interface ModelAbSourceCheckInput {
  readonly runId: string;
  readonly spanId: string;
  readonly source: CallDraftSource | undefined;
  readonly detail: RunDetail | null;
}

/**
 * 恢复调用类草稿前的来源重验（纯函数，不改动仓库）。
 * 判定顺序：来源存在性 → run 级资格事实 → 字段相关入口条件（首次调用身份 / 代理来源）
 * → 编辑所依赖的源内容。任何拦截都保留草稿，只收回执行资格。
 */
export function revalidateCallDraftSource(input: CallDraftSourceCheckInput): DraftSourceVerdict {
  return revalidateSource(
    input.runId,
    input.spanId,
    input.field,
    input.baseline,
    input.source,
    input.detail,
  );
}

/** 恢复 A/B 批次草稿前的来源重验（与 prompt 字段同判据：首次 llm.call + 入口条件 + 源内容） */
export function revalidateModelAbDraftSource(input: ModelAbSourceCheckInput): DraftSourceVerdict {
  return revalidateSource(input.runId, input.spanId, "model_ab", null, input.source, input.detail);
}

function revalidateSource(
  runId: string,
  spanId: string,
  field: CallDraftField | "model_ab",
  baseline: string | null,
  source: CallDraftSource | undefined,
  detail: RunDetail | null,
): DraftSourceVerdict {
  if (source === undefined) {
    return blocked(
      "source_missing",
      "草稿缺少源基线，无法核对来源：为避免以错误来源执行，已禁止提交（可复制内容或明确放弃）",
    );
  }
  if (detail === null) {
    return blocked(
      "source_missing",
      "详情缺失或读取失败：草稿已保留，重新读取并通过校验后才能执行；也可从会话草稿入口复制内容",
    );
  }
  if (detail.meta.id !== runId) {
    return blocked("source_missing", "当前详情不是草稿所属的运行，无法核对来源");
  }
  const span = detail.spans.find((s) => s.id === spanId);
  if (span === undefined) {
    return blocked(
      "source_missing",
      "目标调用已不在当前详情中（源记录缺失或被改动）：草稿保留供复制/放弃，不换用其他调用冒充恢复",
    );
  }

  // —— run 级资格事实：登记时刻 vs 当前详情（既有入口条件的事实输入）——
  const facts = runFactsOf(detail);
  if (facts.status !== source.runStatus) {
    return blocked(
      "capability_invalid",
      `运行状态已改变（编辑时 ${source.runStatus}，当前 ${facts.status}），执行资格须重新核对`,
    );
  }
  const leafNow = facts.leafSpanIds.includes(spanId);
  const leafThen = source.leafSpanIds.includes(spanId);
  if (leafNow !== leafThen) {
    return blocked(
      "capability_invalid",
      leafNow
        ? "目标调用已成为本运行自有叶子（编辑时不是），执行资格须重新核对"
        : "目标调用不再属于本运行的自有叶子 span，执行资格失效",
    );
  }
  if (facts.isolated !== source.isolated) {
    return blocked(
      "capability_invalid",
      "运行的隔离文件元数据已改变（隔离父本不支持 prompt fork / 模型 A/B），执行资格须重新核对",
    );
  }
  if (facts.configHash !== source.configHash) {
    return blocked(
      "capability_invalid",
      "源配置指纹（config_hash）已改变：草稿保留供复制/放弃，须重新核对来源后才能执行",
    );
  }

  // —— 目标 span 的类型与字段匹配 ——
  if (source.target.kind === "tool.invoke") {
    if (span.kind !== "tool.invoke") {
      return blocked("source_changed", "目标调用的类型已改变，原草稿无法对应到当前源记录");
    }
    if (field !== "result") {
      return blocked("capability_invalid", "草稿字段与目标调用的类型不匹配");
    }
    if (baseline !== null && toolResultText(span) !== baseline) {
      return blocked(
        "source_changed",
        "源工具结果内容已改变：草稿保留供复制/放弃；如需采用新内容，请先明确放弃旧草稿再重新编辑",
      );
    }
    return eligible();
  }

  if (span.kind !== "llm.call") {
    return blocked("source_changed", "目标调用的类型已改变，原草稿无法对应到当前源记录");
  }
  if (field === "result") {
    return blocked("capability_invalid", "草稿字段与目标调用的类型不匹配");
  }

  // —— 字段相关入口条件 ——
  if (field === "messages") {
    // 代理 messages 重发的资格事实：录制来源必须仍是代理（与 canResend 判据同源）
    if (facts.proxy !== source.proxy) {
      return blocked(
        "capability_invalid",
        "运行录制来源（代理/引擎）已改变，messages 重发资格须重新核对",
      );
    }
  } else {
    // prompt fork / A/B：隔离父本排除 + **重推**首次 llm.call 身份（不只看 span ID 是否存在）
    const firstLlmId = detail.spans.find((s) => s.kind === "llm.call")?.id;
    if (firstLlmId !== spanId) {
      return blocked(
        "capability_invalid",
        `当前详情的首次 llm.call（${firstLlmId ?? "无"}）与草稿目标（${spanId}）不一致：不得跳过首次调用改用后续调用，草稿保留供复制/放弃`,
      );
    }
  }

  // —— 编辑所依赖的源内容：启动上下文 / 模型 / 参数 / 工具表 ——
  const target = source.target; // llm.call
  const startup = startupContents(span.request.messages);
  if (
    startup.system !== target.startupSystem ||
    startup.user !== target.startupUser ||
    span.request.model !== target.model ||
    signature(scalarRequestParams(span.request.params)) !== target.paramsSignature ||
    signature(span.request.tools ?? null) !== target.toolsSignature
  ) {
    return blocked(
      "source_changed",
      "编辑所依赖的源内容已改变（启动上下文/模型/参数/工具表）：草稿保留供复制/放弃，不静默采用新基线",
    );
  }
  if (field === "messages" && signature(span.request.messages) !== target.messagesSignature) {
    return blocked(
      "source_changed",
      "源请求消息已改变：草稿保留供复制/放弃；如需采用新消息，请先明确放弃旧草稿再重新编辑",
    );
  }
  return eligible();
}
