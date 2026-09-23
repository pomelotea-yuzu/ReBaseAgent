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

/**
 * 显式阅读目标（来自用户明确动作，如错误定位入口）。
 *
 * ⚠️ **调用定位与文件定位是互斥的两种目标**（U2 审阅 P2）：`spanId` / `expandStepId` 指调用
 *    span，`file.stepSpanId` 指 agent.step。两者混传会让"到底定位到哪个对象"变得不可判定，
 *    故用**判别式字段**区分——传了 `file` 就**不允许**再传 `spanId` / `expandStepId`
 *    （类型上可选、运行期由 `parseReadingTarget` 拒绝，见该函数）。
 */
export interface ReadingTarget {
  /** 目标页签（不传则沿用当前逻辑） */
  tab?: "overview" | "steps" | "files";
  /** 目标 span id（**调用**定位） */
  spanId?: string;
  /** 目标所属 step（需要展开时用） */
  expandStepId?: string;
  /**
   * U2 文件定位分支：`stepSpanId` 只指**自有 agent.step**，`null` 明确指初始状态；
   * `path` 省略 = 显示列表（不指定文件）。
   */
  file?: { stepSpanId: string | null; path?: string };
}

/** 解析结果：应当落到状态的阅读位置 */
export interface ResolvedReading {
  tab: "overview" | "steps" | "files";
  spanId: string | null;
  /** 需要额外展开的 step（显式目标携带） */
  expandStepId: string | null;
  /**
   * U2：显式文件定位（只有 `target.file` 给出时非 null）。
   * `null` 表示**本次导航没有指定文件目标**——普通返回/历史恢复都不是文件定位。
   */
  fileTarget: { stepSpanId: string | null; path?: string } | null;
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
    // U2 文件定位分支：`file` 存在即**明确文件目标**（不是普通返回），页签强制 files
    if (input.target.file !== undefined) {
      const fileTab = validTab("files");
      if (fileTab !== "files") {
        // 该 run 没有文件页 ⇒ 文件目标不可达，降级为显式调用目标（不抛、不臆造页签）
        return {
          tab: "overview",
          spanId: null,
          expandStepId: null,
          fileTarget: null,
          source: "explicit",
          invalidated: true,
        };
      }
      return {
        tab: "files",
        spanId: null,
        expandStepId: null,
        fileTarget: input.target.file,
        source: "explicit",
        invalidated,
      };
    }
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
      fileTarget: null,
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
    // 普通返回**不消费显式文件目标**（delta「普通文件页签返回 SHALL NOT 被当作覆盖历史的定位请求」）
    return { tab, spanId, expandStepId: null, fileTarget: null, source: "history", invalidated };
  }

  // 3. 默认位置
  const tab = validTab(input.currentTab ?? "overview");
  if (input.detail.spans.length === 0) {
    // 空轨迹：明确空态，不伪造步骤
    return {
      tab,
      spanId: null,
      expandStepId: null,
      fileTarget: null,
      source: "empty",
      invalidated,
    };
  }
  return {
    tab,
    spanId: defaultSpanId(input.detail),
    expandStepId: null,
    fileTarget: null,
    source: "default",
    invalidated,
  };
}

/**
 * U2 任务 2.3：解析来自 store 的原始目标，**拒绝调用字段与文件字段混传**。
 *
 * 为什么单独一层：`ReadingTarget` 是可选字段拼起来的宽接口，调用方（概览入口、文件入口）
 * 各自只填一部分；把"哪些组合合法"集中在一处判断，才能在类型之外也拦住错组合。
 *
 * @returns 合法目标，或 `null`（拒收：混传 / file 结构不合法）
 */
export function parseReadingTarget(raw: ReadingTarget | null): ReadingTarget | null {
  if (raw === null) return null;
  const hasFile = raw.file !== undefined;
  const hasCall = raw.spanId !== undefined || raw.expandStepId !== undefined;
  if (hasFile && hasCall) return null; // 混传：定位对象不可判定
  if (hasFile) {
    const file = raw.file as { stepSpanId?: unknown; path?: unknown };
    if (typeof file.stepSpanId !== "string" && file.stepSpanId !== null) return null;
    if (file.path !== undefined && typeof file.path !== "string") return null;
    return {
      tab: "files",
      file: {
        stepSpanId: file.stepSpanId,
        ...(typeof file.path === "string" ? { path: file.path } : {}),
      },
    };
  }
  return raw;
}
