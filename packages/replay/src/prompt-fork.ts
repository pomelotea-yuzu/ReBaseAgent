import type { Message } from "@rebaseagent/agent-loop";
import type { Fork, LlmCallSpan, RunRecord } from "@rebaseagent/trace-sdk";
import { z } from "zod";

/**
 * prompt fork 的纯函数内核（零 fs、零网络、零 LLM）。
 *
 * 语义边界（与 deriveReplayState 的"共享前缀截断拼接"完全不同）：
 * - prompt fork 改变启动上下文，父轨迹中没有任何 span 可复用——
 *   启动上下文唯一来源是直接父 run 自身首次 llm.call 的录制 request.messages
 * - 深拷贝后替换目标消息，父记录只读
 * - system_prompt 编辑同步返回新的 RunConfig.systemPrompt 值：
 *   config_hash 的输入与首次真实请求里的 system 消息必须是同一个编辑值（双真相源）
 */

/** prompt fork 允许编辑的启动上下文字段（一次只允许其一） */
export type PromptForkField = "system_prompt" | "user_message" | "model_params";

/**
 * 模型 / 采样参数编辑值。
 *
 * 字段白名单刻意很窄：baseURL、apiKey、cwd、工具表与 budget 都不得由此注入——
 * 那不是"换模型对比"，而是换成另一个实验（工具表/源码变化会改写 config_hash）。
 * experimentId 与 allowSideEffects 是元信息，原样落进 fork.edit 供 UI 分组与事后审计。
 */
export const ModelParamsValueSchema = z
  .object({
    /** 目标模型名（非空） */
    model: z.string().min(1, "model 不能为空"),
    /** 数值采样参数；整体覆盖父 run 录制值，缺省沿用父值 */
    params: z.record(z.string(), z.number().finite("采样参数必须是有限数值")).optional(),
    /** 同一批实验的分组标签（可选）：仅供 UI 分组与默认配对，不参与校验与 hash */
    experimentId: z.string().min(1).optional(),
    /** 显式确认允许带副作用的工具（可选）：见 model-replay-run 的副作用门禁 */
    allowSideEffects: z.boolean().optional(),
  })
  .strict(
    "model_params 的 value 只允许 model / params / experimentId / allowSideEffects 四个字段" +
      "（baseURL、apiKey、cwd、工具表与预算不得由此注入）",
  );
export type ModelParamsValue = z.infer<typeof ModelParamsValueSchema>;

/** prompt fork 编辑描述：启动上下文（字符串）或模型配置（结构化） */
export type PromptForkEdit =
  | { field: "system_prompt" | "user_message"; value: string }
  | { field: "model_params"; value: ModelParamsValue };

/** 模型配置编辑（field 固定为 model_params，供多臂实验使用） */
export type ModelParamsEdit = { field: "model_params"; value: ModelParamsValue };

export interface DerivePromptForkStateInput {
  /** 直接父 run 的解析记录（只读；derive 内部深拷贝，不改父数据） */
  record: RunRecord;
  edit: PromptForkEdit;
}

/** 模型实验派生的覆盖项（只有 model_params 编辑会产生） */
export interface ModelOverride {
  model: string;
  /** 整体覆盖后的采样参数；父 run 未录制时为 undefined */
  params: Record<string, number> | undefined;
}

export interface DerivedPromptForkState {
  /** 编辑后的启动 messages（深拷贝，可直接作为 runLoop 初始输入） */
  messages: Message[];
  /**
   * 本次 RunConfig.systemPrompt 应使用的值：
   * system_prompt 编辑 = 编辑后的新值；其余编辑 = 父 run 原值。
   * 编排层必须先校验 config.systemPrompt 等于父原值，再以此覆写（双真相源守护）。
   */
  systemPrompt: string;
  /** fork 元数据：at_span 固定为父 run 首次 llm.call 的 span id */
  fork: Fork;
  /** model_params 编辑产生的模型/参数覆盖；其余编辑为 null */
  modelOverride: ModelOverride | null;
}

/** 启动上下文定位结果：两个目标各自独立报告（缺失与否由调用方按字段裁决） */
export interface StartupContext {
  /** 首条 role=system 且 content 为字符串的消息；缺失为 null */
  system: { index: number; content: string } | null;
  /** 首条 role=user 且 content 为字符串的消息；缺失为 null */
  user: { index: number; content: string } | null;
}

/** run 中首次 llm.call 的 span（文件序 = 执行序）；缺失抛明确错误 */
export function firstLlmCall(record: RunRecord): LlmCallSpan {
  const span = record.spans.find((s) => s.kind === "llm.call");
  if (span === undefined || span.kind !== "llm.call") {
    throw new Error(`run ${record.meta.id} 的轨迹中没有 llm.call 录制，无法定位启动上下文`);
  }
  return span;
}

/**
 * 从首次 llm.call 的请求消息定位可编辑启动上下文：
 * - system prompt = 第一条 role=system 且 content 为字符串的消息
 * - 初始 user message = 第一条 role=user 且 content 为字符串的消息
 * 多模态对象、非字符串 content 一律不算命中（不做隐式序列化）。
 * 参数取结构化最小形状：trace-sdk 的宽松 ChatMessage 与 agent-loop 的 Message 都满足。
 */
export function locateStartupContext(
  messages: ReadonlyArray<{ role: unknown; content?: unknown }>,
): StartupContext {
  let system: StartupContext["system"] = null;
  let user: StartupContext["user"] = null;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined) continue;
    if (system === null && message.role === "system" && typeof message.content === "string") {
      system = { index: i, content: message.content };
    }
    if (user === null && message.role === "user" && typeof message.content === "string") {
      user = { index: i, content: message.content };
    }
    if (system !== null && user !== null) break;
  }
  return { system, user };
}

/**
 * 把录制 params（trace 侧为 Record<string, unknown>）规整为数值采样参数。
 * 非数值项一律丢弃——首期只支持数值采样参数（temperature / top_p 等），
 * 结构化参数（response_format、stop 数组）不在本 change 范围内。
 */
export function numericParams(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/** 两个数值参数表是否逐键相等（父缺省视为空对象） */
export function sameParams(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** model_params 编辑值校验：非法形状在此统一转成中文错误（编排层的唯一入口） */
export function parseModelParamsValue(value: unknown): ModelParamsValue {
  const parsed = ModelParamsValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `非法的 model_params 编辑值：${parsed.error.issues[0]?.message ?? "字段校验失败"}`,
    );
  }
  return parsed.data;
}

/**
 * 派生 prompt fork 的起点状态：编辑后的启动 messages + 本次 systemPrompt + fork 元数据。
 *
 * 拒绝（均发生在创建文件与调用模型之前，由编排层先调本函数保证）：
 * - 父 run 无首次 llm.call 录制
 * - 缺少字符串 system 消息（所有编辑都依赖它重建 RunConfig.systemPrompt；
 *   config_hash 不可逆，系统不反推、不猜、不假定空字符串）
 * - user_message 编辑但无首条字符串 user 消息
 * - 空 fork（编辑前后相同）
 * - 非法字段 / 非字符串编辑值 / 非法 model_params 值
 */
export function derivePromptForkState(input: DerivePromptForkStateInput): DerivedPromptForkState {
  const { record, edit } = input;

  const llmSpan = firstLlmCall(record);
  const { system, user } = locateStartupContext(llmSpan.request.messages);

  // 字符串 system 消息是整个 prompt fork 的前置条件（所有编辑均依赖）
  if (system === null) {
    throw new Error(
      `父 run ${record.meta.id} 的首次 llm.call 不含字符串形式的 system 消息，无法重建 RunConfig.systemPrompt，prompt fork 不可用（系统不从 config_hash 反推）`,
    );
  }

  // 深拷贝后只改目标消息；父记录零改动（trace-sdk 的 ChatMessage 为宽松透传类型，
  // 录制自 loop 的请求本就是 Message 形状——与 derive.ts 同一中转）
  const messages = structuredClone(llmSpan.request.messages) as unknown as Message[];

  if (edit.field === "model_params") {
    return deriveModelParamsState({ record, llmSpan, messages, system, edit });
  }

  if (edit.field !== "system_prompt" && edit.field !== "user_message") {
    throw new Error(
      `非法的 prompt fork 编辑目标：${String(edit.field)}（只允许 system_prompt、user_message 或 model_params，一次只修改一个变量）`,
    );
  }
  if (typeof edit.value !== "string") {
    throw new Error("prompt fork 的编辑值必须是字符串（不支持多模态对象或结构化内容）");
  }
  if (edit.field === "user_message" && user === null) {
    throw new Error(
      `父 run ${record.meta.id} 的首次 llm.call 不含字符串形式的 user 消息，无法编辑初始用户指令`,
    );
  }

  const systemPrompt = edit.field === "system_prompt" ? edit.value : (system.content ?? "");

  if (edit.field === "system_prompt") {
    messages[system.index] = { ...messages[system.index], content: edit.value };
  } else if (user !== null) {
    messages[user.index] = { ...messages[user.index], content: edit.value };
  }

  // 空 fork：模型看到的启动上下文没有变化（无意义的从头重跑，白白计费）
  if (edit.value === (edit.field === "system_prompt" ? system.content : user?.content)) {
    throw new Error(
      `空 fork 被拒绝：${edit.field === "system_prompt" ? "system prompt" : "首条 user message"}编辑前后相同，模型上下文无变化`,
    );
  }

  return {
    messages,
    systemPrompt,
    fork: { at_span: llmSpan.id, edit: { field: edit.field, value: edit.value } },
    modelOverride: null,
  };
}

/**
 * model_params 派生：只换模型与数值采样参数，启动 messages 与 system prompt 原样保留。
 *
 * - 父 run 首次请求未录制 params 时按空对象判定：arm 提供任何参数都算"实际改变"
 * - model 与 params 都未变 = 空实验（等价重跑同一件事，白白计费）→ 拒绝
 * - config_hash 不受影响：它只吃 systemPrompt 与工具表，换 model/params 是同源实验
 */
function deriveModelParamsState(input: {
  record: RunRecord;
  llmSpan: LlmCallSpan;
  messages: Message[];
  system: { index: number; content: string };
  edit: ModelParamsEdit;
}): DerivedPromptForkState {
  const { record, llmSpan, messages, system, edit } = input;
  const value = parseModelParamsValue(edit.value);

  const parentParams = numericParams(llmSpan.request.params);
  const params = value.params ?? parentParams;
  if (value.model === llmSpan.request.model && sameParams(params, parentParams)) {
    throw new Error(
      `空 fork 被拒绝：model 与采样参数都与父 run ${record.meta.id} 相同（${value.model}），模型配置无变化`,
    );
  }

  return {
    messages,
    systemPrompt: system.content,
    fork: { at_span: llmSpan.id, edit: { field: "model_params", value } },
    modelOverride: {
      model: value.model,
      params: Object.keys(params).length > 0 ? params : undefined,
    },
  };
}
