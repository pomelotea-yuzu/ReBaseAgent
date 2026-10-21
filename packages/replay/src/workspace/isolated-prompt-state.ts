import { createHash } from "node:crypto";
import { configHash, isReservedBodyKey } from "@rebaseagent/agent-loop";
import type { Message, Scalar, ToolDef } from "@rebaseagent/agent-loop";
import type { LlmCallSpan, RunRecord, WorkspaceSnapshot } from "@rebaseagent/trace-sdk";
import { FILE_TOOLS_V1_DEFINITIONS } from "./file-tools.js";

/**
 * 隔离 prompt 实验的**纯派生内核**（R2.2 design D2）。
 *
 * 只做内存判定与派生，不碰文件系统、不发请求、不建任何身份：
 * - 首版启动消息严格形状（仅 system/user、字符串 content、可选字符串 name，至少各一条）；
 * - 单项编辑只替换**首条**对应 role 的字符串 content，其余消息逐字段保留；
 * - 空编辑按原始字符串相等拒绝（不 trim、不补默认值；改成空串/尾随空白是真实变化）；
 * - 模型固定为根首次请求的 model；params 无损恢复为 JSON 标量表（缺省 vs 显式 `{}` 区分）；
 * - 新 config_hash 只用**有效 system + 固定工具表**，不把 params/端点/预算混进去。
 *
 * 普通 `derivePromptForkState` 保持既有行为（缺 user 仍可改 system）；本模块是新增隔离路径的
 * 独立校验，不复用、也不反向收紧普通入口。
 */

export type IsolatedPromptField = "system_prompt" | "user_message";

export interface IsolatedPromptEdit {
  readonly field: IsolatedPromptField;
  readonly value: string;
}

export type IsolatedPromptDeriveFailureCode =
  | "startup_unavailable"
  | "invalid_edit"
  | "empty_edit"
  | "config_unreconstructable";

export interface IsolatedPromptDeriveFailure {
  readonly code: IsolatedPromptDeriveFailureCode;
  readonly reason: string;
}

export interface DerivedIsolatedPromptState {
  /** 父根自有首次 llm.call（= v3 fork.at_span / baseline_llm_span_id） */
  readonly baselineLlmSpanId: string;
  /** 基线原始字符串（system 或首条 user 的 content） */
  readonly originalValue: string;
  /** 未编辑的 system 字符串（config_hash 原值核对用） */
  readonly originalSystemPrompt: string;
  /** 编辑后的完整启动消息（深拷贝；非目标消息逐字段保留） */
  readonly messages: Message[];
  /** 有效 system prompt（system 编辑=新值；user 编辑=原 system） */
  readonly systemPrompt: string;
  /** 固定为根首次请求的 model */
  readonly model: string;
  /** 无损恢复的标量采样参数；缺省与显式空对象保持区别 */
  readonly params: Record<string, Scalar> | undefined;
  /** 只由有效 system + 固定工具表计算的 config_hash */
  readonly configHash: string;
  /** 父根基线初始快照（v3 子运行的起点） */
  readonly initialSnapshot: WorkspaceSnapshot;
}

export type IsolatedPromptDeriveResult =
  | { readonly ok: true; readonly value: DerivedIsolatedPromptState }
  | { readonly ok: false; readonly failure: IsolatedPromptDeriveFailure };

function deriveFail(
  code: IsolatedPromptDeriveFailureCode,
  reason: string,
): { ok: false; failure: IsolatedPromptDeriveFailure } {
  return { ok: false, failure: { code, reason } };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 启动消息允许的字段集：role / content / 可选 name；其他键一律拒绝（不静默 strip） */
const STARTUP_MESSAGE_KEYS = new Set(["role", "content", "name"]);

/**
 * 首版启动消息的严格形状校验；合法返回 `null`。
 *
 * 只接受 role=system/user、字符串 content、可选字符串 name，且 system/user **各至少一条**。
 * 历史 assistant/tool、tool_calls/tool_call_id、多模态对象或其他未知字段都是"不可无损还原的
 * 启动上下文"，明确拒绝而不是丢弃字段后照跑。
 */
export function findStartupMessagesViolation(
  messages: readonly Record<string, unknown>[],
): string | null {
  let systemCount = 0;
  let userCount = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) {
      return `启动消息第 ${i + 1} 条为空`;
    }
    const role = message.role;
    if (role !== "system" && role !== "user") {
      return `启动消息第 ${i + 1} 条的 role 为 ${JSON.stringify(role)}，首版只接受 system/user（历史 assistant/tool 消息不可复用）`;
    }
    for (const key of Object.keys(message)) {
      if (!STARTUP_MESSAGE_KEYS.has(key)) {
        return `启动消息第 ${i + 1} 条含不支持的字段 ${JSON.stringify(key)}（只看 role/content/name；不静默丢弃）`;
      }
    }
    if (typeof message.content !== "string") {
      return `启动消息第 ${i + 1} 条的 content 不是字符串（多模态或结构化内容不在首版支持范围）`;
    }
    if (hasOwn(message, "name") && typeof message.name !== "string") {
      return `启动消息第 ${i + 1} 条的 name 不是字符串`;
    }
    if (role === "system") systemCount += 1;
    else userCount += 1;
  }
  if (systemCount === 0 || userCount === 0) {
    return `启动消息必须至少有各一条字符串 system 与 user（实际 system=${systemCount}、user=${userCount}）`;
  }
  return null;
}

/**
 * 编辑请求的严格形状校验（不碰文件）：只允许 `{field,value}` 两个键、field 为两个 prompt 字段、
 * value 为字符串。额外键（例如同时携带另一条消息的新值）直接拒绝。
 */
export function validateIsolatedPromptEdit(
  edit: unknown,
):
  | { readonly ok: true; readonly value: IsolatedPromptEdit }
  | { readonly ok: false; readonly failure: IsolatedPromptDeriveFailure } {
  const record = asRecord(edit);
  if (record === null) {
    return deriveFail("invalid_edit", "编辑值必须是对象 {field,value}");
  }
  for (const key of Object.keys(record)) {
    if (key !== "field" && key !== "value") {
      return deriveFail(
        "invalid_edit",
        `编辑对象含不支持字段 ${JSON.stringify(key)}：一次只允许修改一个 prompt 字段（field/value）`,
      );
    }
  }
  if (record.field !== "system_prompt" && record.field !== "user_message") {
    return deriveFail(
      "invalid_edit",
      `隔离 prompt 实验只允许编辑 system_prompt 或 user_message（收到 ${JSON.stringify(record.field)}）`,
    );
  }
  if (typeof record.value !== "string") {
    return deriveFail("invalid_edit", "编辑值 value 必须是字符串（不序列化结构化内容）");
  }
  return { ok: true, value: { field: record.field, value: record.value } };
}

/**
 * 无损恢复录制的采样参数为 JSON 标量表。
 *
 * - `undefined`（字段缺失）→ `undefined`；显式 `{}` → `{}`——两者不能互相冒充；
 * - 只接受 string / 有限 number / boolean；嵌套对象、数组、null、NaN/Infinity 一律拒绝；
 * - 请求体保留键拒绝（params 平铺进请求体顶层，保留键冲突等于注入）；
 * - **不用** `scalarParams`：静默丢项会让实验条件与记录不一致。
 */
export function restorePromptParams(
  raw: unknown,
):
  | { readonly ok: true; readonly params: Record<string, Scalar> | undefined }
  | { readonly ok: false; readonly reason: string } {
  if (raw === undefined) {
    return { ok: true, params: undefined };
  }
  const record = asRecord(raw);
  if (record === null) {
    return { ok: false, reason: "params 必须是普通对象（数组/null 不是合法采样参数表）" };
  }
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isReservedBodyKey(key)) {
      return { ok: false, reason: `采样参数使用了请求体保留键 ${JSON.stringify(key)}` };
    }
    if (typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return { ok: false, reason: `采样参数 ${JSON.stringify(key)} 不是有限数值` };
      }
      out[key] = value;
      continue;
    }
    return {
      ok: false,
      reason: `采样参数 ${JSON.stringify(key)} 不是 JSON 标量（对象/数组/null 无法无损恢复）`,
    };
  }
  return { ok: true, params: out };
}

/** 首次 llm.call 必须在父根自有第 1 步（返回 step 或失败原因） */
function locateBaselineCall(
  record: RunRecord,
):
  | { readonly ok: true; readonly llm: LlmCallSpan; readonly stepId: string }
  | { readonly ok: false; readonly reason: string } {
  const llm = record.spans.find((span) => span.kind === "llm.call");
  if (llm === undefined || llm.kind !== "llm.call") {
    return {
      ok: false,
      reason: `根 run ${record.meta.id} 没有自有 llm.call 录制，无法还原启动上下文`,
    };
  }
  if (llm.parent === null) {
    return { ok: false, reason: `根 run ${record.meta.id} 的首次 llm.call 缺少父 step` };
  }
  const step = record.spans.find((span) => span.id === llm.parent);
  if (step === undefined || step.kind !== "agent.step") {
    return {
      ok: false,
      reason: `根 run ${record.meta.id} 的首次 llm.call 父 span ${llm.parent} 不是 agent.step`,
    };
  }
  if (step.n !== 1) {
    return {
      ok: false,
      reason: `根 run ${record.meta.id} 的首次 llm.call 位于第 ${step.n} 步，首版只接受自有第 1 步的启动请求`,
    };
  }
  return { ok: true, llm, stepId: step.id };
}

/**
 * 派生隔离 prompt 实验的起点状态（纯内存）。
 *
 * 失败码归到四类：`startup_unavailable`（首次请求/消息不可还原）、`invalid_edit`（形状/字段）、
 * `empty_edit`（编辑前后逐字相同）、`config_unreconstructable`（model/params/初始快照不可还原）。
 */
export function deriveIsolatedPromptState(input: {
  readonly record: RunRecord;
  readonly edit: unknown;
}): IsolatedPromptDeriveResult {
  const { record } = input;
  const editCheck = validateIsolatedPromptEdit(input.edit);
  if (!editCheck.ok) return editCheck;
  const edit = editCheck.value;

  const located = locateBaselineCall(record);
  if (!located.ok) {
    return deriveFail("startup_unavailable", located.reason);
  }
  const llm = located.llm;

  const startupViolation = findStartupMessagesViolation(
    llm.request.messages as unknown as Record<string, unknown>[],
  );
  if (startupViolation !== null) {
    return deriveFail(
      "startup_unavailable",
      `根 run ${record.meta.id} 的启动消息不可还原：${startupViolation}`,
    );
  }

  const systemIndex = llm.request.messages.findIndex(
    (message) => message.role === "system" && typeof message.content === "string",
  );
  const userIndex = llm.request.messages.findIndex(
    (message) => message.role === "user" && typeof message.content === "string",
  );
  const originalSystemPrompt = llm.request.messages[systemIndex]?.content as string;
  const targetIndex = edit.field === "system_prompt" ? systemIndex : userIndex;
  const originalValue = llm.request.messages[targetIndex]?.content as string;

  if (edit.value === originalValue) {
    return deriveFail(
      "empty_edit",
      `空编辑被拒绝：${edit.field === "system_prompt" ? "system prompt" : "首条 user message"}编辑前后逐字相同，模型上下文无变化`,
    );
  }

  const messages = structuredClone(llm.request.messages) as unknown as Message[];
  messages[targetIndex] = { ...messages[targetIndex], content: edit.value } as Message;
  const systemPrompt = edit.field === "system_prompt" ? edit.value : originalSystemPrompt;

  const restored = restorePromptParams(llm.request.params);
  if (!restored.ok) {
    return deriveFail(
      "config_unreconstructable",
      `根 run ${record.meta.id} 的采样参数无法无损恢复：${restored.reason}（不接受静默过滤后的实验）`,
    );
  }

  const initialSnapshot = record.meta.workspace?.initial_snapshot;
  if (initialSnapshot === undefined) {
    return deriveFail(
      "config_unreconstructable",
      `根 run ${record.meta.id} 没有隔离初始快照，无法建立实验起点`,
    );
  }

  return {
    ok: true,
    value: {
      baselineLlmSpanId: llm.id,
      originalValue,
      originalSystemPrompt,
      messages,
      systemPrompt,
      model: llm.request.model,
      params: restored.params,
      configHash: configHash(systemPrompt, [...FILE_TOOLS_V1_DEFINITIONS] as ToolDef[]),
      initialSnapshot,
    },
  };
}

/**
 * 端点规范化：只保留去除 userinfo/query/fragment 的 `origin + pathname`。
 *
 * URL 里的额外凭据（`https://user:pass@host/...`）不得进入计划/指纹/trace；
 * 非 http(s) 端点明确拒绝，不猜兼容协议。
 */
export function sanitizeProviderEndpoint(
  baseURL: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return { ok: false, reason: `当前端点不是合法 URL：${JSON.stringify(baseURL)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `当前端点协议 ${url.protocol} 不受支持（只接受 http/https）` };
  }
  return { ok: true, value: `${url.origin}${url.pathname}` };
}

/**
 * 规范化 JSON：递归对象键按 UTF-16 代码单元序排序、数组保持原序；
 * `JSON.stringify` 自带"对象里的 undefined 键省略、显式空对象保留"。
 *
 * 与 agent-loop 的 config_hash 同一种规范形式，但本函数用于**计划指纹**（覆盖消息/端点/限制）。
 */
export function canonicalJsonForFingerprint(value: unknown): string {
  return JSON.stringify(sortKeysForFingerprint(value));
}

function sortKeysForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysForFingerprint);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      out[key] = sortKeysForFingerprint(val);
    }
    return out;
  }
  return value;
}

/** 计划指纹：规范 JSON 的 SHA-256（`sha256:<hex>`） */
export function computePlanFingerprint(payload: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJsonForFingerprint(payload), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
