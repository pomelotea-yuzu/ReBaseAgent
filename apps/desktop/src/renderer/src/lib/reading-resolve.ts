/**
 * 阅读位置的解析优先级与安全回退（U1 共用派生 · 任务 3.2）。
 *
 * 纯函数：输入「显式目标 / 历史状态 / 当前详情」，输出「应当选中什么、在哪一页签」。
 * 不读 store、不发 IPC——store 与组件只负责把结果落到状态。
 *
 * 优先级（对应 desktop-ui delta「会话内按运行恢复阅读位置」）：
 *   1. **显式目标**（如从概览点「打开失败调用」）——盖过一切历史位置；
 *   2. **有效历史选择**——切回来时恢复上次读到哪；
 *   3. **默认位置**——首次进入：首个自有模型/工具调用，没有则首个可读 span；空轨迹 ⇒ 空态。
 *
 * 安全回退：任何一层引用失效（span 不在详情里 / 文件页签不适用）都**清理并降级**，
 * 不抛异常、不选择别的 run 的同 ID span。
 */

import type { SpanLine } from "@rebaseagent/trace-sdk";

/** 显式阅读目标（来自用户明确动作，如错误定位入口） */
export interface ReadingTarget {
  /** 目标页签（不传则沿用当前逻辑） */
  tab?: "overview" | "steps" | "files";
  /** 目标 span id */
  spanId?: string;
  /** 目标所属 step（需要展开时用） */
  expandStepId?: string;
}

/** 解析结果：应当落到状态的阅读位置 */
export interface ResolvedReading {
  tab: "overview" | "steps" | "files";
  spanId: string | null;
  /** 需要额外展开的 step（显式目标携带） */
  expandStepId: string | null;
  /** 解析依据，供测试与排查（也是「可解释性」） */
  source: "explicit" | "history" | "default" | "empty";
  /** 是否发生了失效回退（供界面提示「原位置不可用」） */
  invalidated: boolean;
}

/** 详情的最小形状 */
export interface ReadingDetail {
  spans: readonly SpanLine[];
  /** 本 run 自有 span id（区分继承前缀与自有） */
  leafSpanIds: readonly string[];
  /** 是否具备文件页 */
  hasFiles: boolean;
}

/**
 * 默认位置：首个**自有**模型/工具调用；没有自有调用则首个可读 span（任意 kind）；
 * 空轨迹 ⇒ spanId 为 null（空态）。
 *
 * 优先自有（delta「首次步骤选择与空轨迹」）：分支 run 打开时不应停在祖先的调用上。
 */
function defaultSpanId(detail: ReadingDetail): string | null {
  const own = new Set(detail.leafSpanIds);
  const ownCalls = detail.spans.filter(
    (span) => own.has(span.id) && (span.kind === "llm.call" || span.kind === "tool.invoke"),
  );
  if (ownCalls.length > 0) return ownCalls[0]?.id ?? null;
  return detail.spans[0]?.id ?? null;
}

/**
 * 解析当前应当落到的阅读位置。
 *
 * @param input.detail  当前详情（含 spans/leafSpanIds/hasFiles）
 * @param input.history 该 run 已记录的阅读状态（可为 null = 首次）
 * @param input.target  显式目标（可为 null）
 * @param input.currentTab 当前页签（无历史也无目标时沿用；默认概览）
 */
export function resolveReading(input: {
  detail: ReadingDetail;
  history: { tab: "overview" | "steps" | "files"; spanId: string | null } | null;
  target: ReadingTarget | null;
  currentTab?: "overview" | "steps" | "files";
}): ResolvedReading {
  const ids = new Set(input.detail.spans.map((span) => span.id));
  let invalidated = false;

  /** 校验页签在该详情下是否可用（文件页对非隔离 run 不可用） */
  const validTab = (tab: "overview" | "steps" | "files"): "overview" | "steps" | "files" => {
    if (tab === "files" && !input.detail.hasFiles) {
      invalidated = true;
      return "overview";
    }
    return tab;
  };

  // 1. 显式目标优先：即便历史停在别处，也按目标走
  if (input.target !== null) {
    const targetTab = validTab(input.target.tab ?? "steps");
    let spanId: string | null = null;
    if (input.target.spanId !== undefined && ids.has(input.target.spanId)) {
      spanId = input.target.spanId;
    } else if (input.target.spanId !== undefined) {
      // 显式指定的 span 不在详情里 ⇒ 失效，降级到默认位置（不抛、不猜另一个）
      invalidated = true;
      spanId = defaultSpanId(input.detail);
    }
    return {
      tab: targetTab,
      spanId,
      expandStepId: input.target.expandStepId ?? null,
      source: "explicit",
      invalidated,
    };
  }

  // 2. 有效历史选择
  if (input.history !== null) {
    const tab = validTab(input.history.tab);
    let spanId = input.history.spanId;
    if (spanId !== null && !ids.has(spanId)) {
      // 历史引用失效：清理并回默认
      spanId = defaultSpanId(input.detail);
      invalidated = true;
    }
    // 空轨迹：历史也没有可落的位置
    if (spanId === null && input.detail.spans.length > 0) {
      spanId = defaultSpanId(input.detail);
    }
    return { tab, spanId, expandStepId: null, source: "history", invalidated };
  }

  // 3. 默认位置
  const tab = validTab(input.currentTab ?? "overview");
  if (input.detail.spans.length === 0) {
    // 空轨迹：明确空态，不伪造步骤
    return { tab, spanId: null, expandStepId: null, source: "empty", invalidated };
  }
  return {
    tab,
    spanId: defaultSpanId(input.detail),
    expandStepId: null,
    source: "default",
    invalidated,
  };
}
