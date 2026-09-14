/**
 * 模型 A/B 编辑器的客户端校验（纯函数，可单测）。
 *
 * 只做"提交前本地拦截"：未配置、臂数不足、模型为空、params 非法、
 * 与父 run 完全相同（空 fork）、副作用工具未确认——不发 IPC 就给出原因；
 * main 与 replay 内核仍有同语义校验兜底（双保险）。
 */

/** 采样参数值：JSON 标量（与 agent-loop 的 SampleParams 一致） */
export type Scalar = string | number | boolean;

/** 编辑器里一个臂的草稿（params 以 JSON 文本编辑，提交前解析） */
export interface ArmDraft {
  model: string;
  /** 空串 = 沿用父 run 的 params；否则为 JSON 对象文本（值为 JSON 标量） */
  paramsText: string;
}

/** 解析后的单臂参数（shared ModelAbArm 形状的渲染层草稿） */
export interface ParsedArm {
  model: string;
  params?: Record<string, Scalar>;
  allowSideEffects?: boolean;
}

/** 请求体保留键（与 agent-loop 的 RESERVED_BODY_KEYS 同一键集） */
const RESERVED_BODY_KEYS = ["model", "messages", "tools", "stream", "stream_options"];

/** params JSON 文本 → 标量参数对象；空串视为沿用父值（undefined） */
export function parseArmParams(
  text: string,
): { ok: true; params: Record<string, Scalar> | undefined } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, params: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'params 不是合法 JSON（示例：{"temperature": 0.7}）' };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "params 必须是 JSON 对象（键 → 标量）" };
  }
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (RESERVED_BODY_KEYS.includes(key)) {
      return {
        ok: false,
        reason: `params.${key} 是请求体保留键（${RESERVED_BODY_KEYS.join(" / ")}），不得用作采样参数`,
      };
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return {
        ok: false,
        reason: `params.${key} 必须是 string / number / boolean 标量（不支持嵌套对象、数组、null）`,
      };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { ok: false, reason: `params.${key} 必须是有限数字` };
    }
    out[key] = value;
  }
  return { ok: true, params: Object.keys(out).length > 0 ? out : undefined };
}

export interface ModelAbGuardInput {
  /** 运行配置是否已就绪（settings.configured） */
  settingsConfigured: boolean;
  /** 父 run 的模型名（空 fork 判据之一） */
  parentModel: string;
  /** 父 run 的采样参数（空 fork 判据之二） */
  parentParams: Record<string, Scalar>;
  /** 首次 llm.call 录制的工具表中"未显式标记 sideEffect: false"的工具名 */
  riskyTools: string[];
  /** 是否已勾选副作用确认（riskyTools 非空时必须为 true） */
  allowSideEffects: boolean;
  arms: ArmDraft[];
}

export interface ModelAbGuardResult {
  canSubmit: boolean;
  /** canSubmit = false 时的阻止原因（可直接展示；多项以"；"连接） */
  reason: string | null;
  /** canSubmit = true 时给出去重后的 arms（不含 allowSideEffects——那是批次级确认） */
  arms: ParsedArm[];
}

/** 与父 run 完全相同 → 该臂是空 fork（与 replay 内核 derive 同判据：缺 params = 继承父值） */
function sameAsParent(
  arm: ParsedArm,
  parentModel: string,
  parentParams: Record<string, Scalar>,
): boolean {
  if (arm.model !== parentModel) return false;
  // 内核口径：value.params 缺省 = 沿用父 params，因此缺省臂在该键集上恒等
  const params = arm.params ?? parentParams;
  const keys = new Set([...Object.keys(parentParams), ...Object.keys(params)]);
  for (const key of keys) {
    if (parentParams[key] !== params[key]) return false;
  }
  return true;
}

export function modelAbGuard(input: ModelAbGuardInput): ModelAbGuardResult {
  const reasons: string[] = [];

  if (!input.settingsConfigured) {
    reasons.push("尚未配置运行参数（baseURL / apiKey / model），请先点击右上角“运行配置”");
  }
  if (input.arms.length < 2) {
    reasons.push("模型实验至少需要 2 个 arm；单臂请用 prompt fork");
  }
  if (input.riskyTools.length > 0 && !input.allowSideEffects) {
    reasons.push(
      `工具 ${input.riskyTools.join("、")} 未标记 sideEffect: false，多臂顺序执行时前一臂的外部副作用会污染后一臂起点；确认接受请勾选副作用声明`,
    );
  }

  const arms: ParsedArm[] = [];
  input.arms.forEach((draft, index) => {
    const label = `第 ${index + 1} 臂`;
    if (draft.model.trim().length === 0) {
      reasons.push(`${label}：model 不能为空`);
      return;
    }
    const parsedParams = parseArmParams(draft.paramsText);
    if (!parsedParams.ok) {
      reasons.push(`${label}：${parsedParams.reason}`);
      return;
    }
    const arm: ParsedArm = { model: draft.model.trim() };
    if (parsedParams.params !== undefined) arm.params = parsedParams.params;
    arms.push(arm);
  });

  // 空 fork：全部臂都与父完全相同 → 什么都不改，不是实验
  if (
    reasons.length === 0 &&
    arms.length >= 2 &&
    arms.every((arm) => sameAsParent(arm, input.parentModel, input.parentParams))
  ) {
    reasons.push("所有臂都与父 run 完全相同（空实验被拒绝），请修改 model 或 params");
  }

  if (reasons.length > 0) {
    return { canSubmit: false, reason: reasons.join("；"), arms: [] };
  }
  return { canSubmit: true, reason: null, arms };
}

/** 从首次 llm.call 录制的工具表提取"未显式标记 sideEffect: false"的工具名（与编排层判据同源） */
export function riskyToolNames(
  tools: ReadonlyArray<Record<string, unknown>> | undefined,
): string[] {
  if (tools === undefined) return [];
  const risky: string[] = [];
  for (const raw of tools) {
    const wrapped = raw.function;
    const inner =
      typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)
        ? (wrapped as Record<string, unknown>)
        : raw;
    if (inner.sideEffect !== false && typeof inner.name === "string") {
      risky.push(inner.name);
    }
  }
  return risky;
}
