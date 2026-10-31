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

import type { Translator } from "@rebaseagent/i18n";

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

export type ArmParamsErrorCode =
  | "INVALID_JSON"
  | "NOT_OBJECT"
  | "RESERVED_KEY"
  | "NON_SCALAR"
  | "NON_FINITE";

/** params 解析失败：稳定码 + 可选键名（展示层按 code 取文案，locale 不进判据） */
export type ArmParamsError = {
  readonly ok: false;
  readonly code: ArmParamsErrorCode;
  readonly key: string | null;
};

/** params JSON 文本 → 标量参数对象；空串视为沿用父值（undefined） */
export function parseArmParams(
  text: string,
): { ok: true; params: Record<string, Scalar> | undefined } | ArmParamsError {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, params: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: "INVALID_JSON", key: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "NOT_OBJECT", key: null };
  }
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (RESERVED_BODY_KEYS.includes(key)) {
      return { ok: false, code: "RESERVED_KEY", key };
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, code: "NON_SCALAR", key };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { ok: false, code: "NON_FINITE", key };
    }
    out[key] = value;
  }
  return { ok: true, params: Object.keys(out).length > 0 ? out : undefined };
}

/** params 解析失败的本地化说明（键名/保留键集为原值，不翻译） */
export function armParamsErrorText(error: ArmParamsError, translator: Translator): string {
  switch (error.code) {
    case "INVALID_JSON":
      return translator.t("experiment.armParamsInvalidJson");
    case "NOT_OBJECT":
      return translator.t("experiment.armParamsNotObject");
    case "RESERVED_KEY":
      return translator.t("experiment.armParamsReservedKey", {
        key: error.key ?? "",
        keys: RESERVED_BODY_KEYS.join(" / "),
      });
    case "NON_SCALAR":
      return translator.t("experiment.armParamsNonScalar", { key: error.key ?? "" });
    case "NON_FINITE":
      return translator.t("experiment.armParamsNonFinite", { key: error.key ?? "" });
  }
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
   * UI 整理 4.2（design D5）：逐项原因与就近归属——批次级（配置/臂数/副作用声明）
   * 与臂级（model 空 / params 非法 / 与父相同，按臂下标归属）。`reason` 仍是全部
   * 项按顺序以"；"连接的拼接串（与既有展示逐字一致），组件要做就近呈现时以
   * `items` 为准，不得自己拆 `reason`。
   */
  items: ReadonlyArray<ModelAbGuardItem>;
  /**
   * canSubmit = true 时给出去重后的 arms。批次级的副作用确认在此**已展开为每臂**
   * `allowSideEffects: true`——内核只认每臂自己的声明，批次复选框只是渲染层的 UI 糖。
   */
  arms: ParsedArm[];
}

export type ModelAbGuardItemScope = { kind: "batch" } | { kind: "arm"; index: number };

/** 稳定原因码：测试与组件按码判定，文案由 translator 派生（locale 不进判据） */
export type ModelAbGuardCode =
  | "SETTINGS_NOT_CONFIGURED"
  | "MIN_ARMS"
  | "SIDE_EFFECTS_UNCONFIRMED"
  | "ARM_MODEL_EMPTY"
  | "ARM_PARAMS_INVALID"
  | "ARM_SAME_AS_PARENT";

export interface ModelAbGuardItem {
  scope: ModelAbGuardItemScope;
  code: ModelAbGuardCode;
  /** 完整行（臂级带「臂 N：」前缀，可直接展示） */
  reason: string;
  /** 臂级原因的主体词（不带前缀，供臂卡就近呈现）；批次级为 null */
  detail: string | null;
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

export function modelAbGuard(input: ModelAbGuardInput, translator: Translator): ModelAbGuardResult {
  const items: ModelAbGuardItem[] = [];
  const armItem = (index: number, code: ModelAbGuardCode, detail: string): void => {
    const arm = translator.t("experiment.armLabel", { index: index + 1 });
    items.push({
      scope: { kind: "arm", index },
      code,
      detail,
      reason: translator.t("experiment.armReasonLine", { arm, detail }),
    });
  };

  if (!input.settingsConfigured) {
    items.push({
      scope: { kind: "batch" },
      code: "SETTINGS_NOT_CONFIGURED",
      detail: null,
      reason: translator.t("experiment.guardSettings"),
    });
  }
  if (input.arms.length < 2) {
    items.push({
      scope: { kind: "batch" },
      code: "MIN_ARMS",
      detail: null,
      reason: translator.t("experiment.guardMinArms"),
    });
  }
  if (input.riskyTools.length > 0 && !input.allowSideEffects) {
    items.push({
      scope: { kind: "batch" },
      code: "SIDE_EFFECTS_UNCONFIRMED",
      detail: null,
      reason: translator.t("experiment.guardSideEffects", {
        tools: input.riskyTools.join(translator.t("experiment.listSeparator")),
      }),
    });
  }

  const arms: ParsedArm[] = [];
  input.arms.forEach((draft, index) => {
    if (draft.model.trim().length === 0) {
      armItem(index, "ARM_MODEL_EMPTY", translator.t("experiment.guardArmModelEmpty"));
      return;
    }
    const parsedParams = parseArmParams(draft.paramsText);
    if (!parsedParams.ok) {
      armItem(index, "ARM_PARAMS_INVALID", armParamsErrorText(parsedParams, translator));
      return;
    }
    const arm: ParsedArm = { model: draft.model.trim() };
    if (parsedParams.params !== undefined) arm.params = parsedParams.params;

    // 空 fork 是**逐臂**判据：内核对每个 arm 单独 derive，任一臂与父完全相同 = 整批
    // INVALID_ARM（零文件、零调用）。本层曾按"全部臂都相同"才拦，于是"臂 1 改、臂 2 沿用父"
    // 会被界面放行、提交才整批被拒。粒度必须与内核一致。
    if (sameAsParent(arm, input.parentModel, input.parentParams)) {
      armItem(index, "ARM_SAME_AS_PARENT", translator.t("experiment.guardArmSameAsParent"));
      return;
    }

    // 批次级确认展开到每臂：内核判据是 arms.every(allowSideEffects === true)，
    // 只勾复选框而不下发声明，逃生舱等于形同虚设（勾了也必被 TOOL_POLICY 拒）。
    if (input.riskyTools.length > 0 && input.allowSideEffects) arm.allowSideEffects = true;
    arms.push(arm);
  });

  if (items.length > 0) {
    const reason = items.map((item) => item.reason).join(translator.t("common.liveSeparator"));
    return { canSubmit: false, reason, items, arms: [] };
  }
  return { canSubmit: true, reason: null, items, arms };
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
