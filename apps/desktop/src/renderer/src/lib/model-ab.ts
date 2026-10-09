/**
 * 模型 A/B 编辑器的客户端校验（纯函数，可单测）。
 *
 * 定位是**提交前的早拦层，不是权威判据**。本层只覆盖"不读文件就能判定"的条件：
 * 运行配置是否就绪、臂数、每臂编辑值是否合法（model 非空 / params 为 JSON 标量 /
 * 不占用请求体保留键）、**逐臂**是否为空 fork、批次级副作用确认是否勾选。
 *
 * ⚠️ 父 run 相关的门禁**刻意不在本层重复**：父链完整、已封存、有 config_hash、
 * 非隔离父本、首次请求含字符串 system 消息、工具表与父逐字段一致——这些由 main +
 * replay 内核在落盘与发请求之前裁决（`loadForkParent` / `assertToolPolicy` / `configHash` 比对）。
 * 所以本层的 `canSubmit === true` **只表示"本层没有理由拦你"，不表示内核必然接受**。
 * 早拦层与内核的关系是「判据镜像 + 一致性测试锁定」，不是"双保险"——本仓有过反例：
 * 空 fork 判据曾在这里按"整批"、在内核按"逐臂"，于是界面放行、提交整批被拒
 * （2026-09-17 K0 验收暴露）。同源性由 `test/model-ab-guard-parity.test.ts` 钉住。
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
  /**
   * 副作用声明。内核的判据是**逐臂**（`assertToolPolicy` 里的 `arms.every(...)`），
   * 所以渲染层的批次级复选框在放行时展开到每一臂（见 `modelAbGuard`）。
   */
  allowSideEffects?: boolean;
}

/**
 * 父 run 录制 params 中的标量子集——A/B 的"沿用父值"与空 fork 判据的父值来源。
 *
 * 与 replay 内核的 `scalarParams` 同语义：非标量项（嵌套对象 / 数组 / null）静默丢弃。
 * 唯一写法差异是本函数额外要求数字有限，而 JSONL 录制不可能出现非有限数
 * （JSON 没有 `Infinity`/`NaN` 字面量），故真实数据上两者取值必定相同；
 * 该等价性由 `test/model-ab-guard-parity.test.ts` 与内核逐项对照。
 */
export function scalarRequestParams(raw: unknown): Record<string, Scalar> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
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
  /** 是否已勾选副作用确认（渲染层的批次级开关；放行时展开到每一臂） */
  allowSideEffects: boolean;
  arms: ArmDraft[];
}

export interface ModelAbGuardResult {
  canSubmit: boolean;
  /** canSubmit = false 时的阻止原因（可直接展示；多项以"；"连接） */
  reason: string | null;
  /**
   * canSubmit = true 时给出去重后的 arms。批次级的副作用确认在此**已展开为每臂**
   * `allowSideEffects: true`——内核只认每臂自己的声明，批次复选框只是渲染层的 UI 糖。
   */
  arms: ParsedArm[];
}

/**
 * 与父 run 完全相同 → 该臂是空 fork。
 * 与 replay 内核 `deriveModelParamsState` 同判据：缺 params = 继承父 params，
 * 因此缺省臂在父 params 的键集上恒等。
 */
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

    // 空 fork 是**逐臂**判据：内核对每个 arm 单独 derive，任一臂与父完全相同 = 整批
    // INVALID_ARM（零文件、零调用）。本层曾按"全部臂都相同"才拦，于是"臂 1 改、臂 2 沿用父"
    // 会被界面放行、提交才整批被拒。粒度必须与内核一致。
    if (sameAsParent(arm, input.parentModel, input.parentParams)) {
      reasons.push(
        `${label}：与父 run 完全相同（model 与采样参数都未变）——与父完全相同的臂会让整批被拒，请修改该臂的 model 或 params`,
      );
      return;
    }

    // 批次级确认展开到每臂：内核判据是 arms.every(allowSideEffects === true)，
    // 只勾复选框而不下发声明，逃生舱等于形同虚设（勾了也必被 TOOL_POLICY 拒）。
    if (input.riskyTools.length > 0 && input.allowSideEffects) arm.allowSideEffects = true;
    arms.push(arm);
  });

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
