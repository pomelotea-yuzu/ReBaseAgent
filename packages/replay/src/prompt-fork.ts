import type { Message } from "@rebaseagent/agent-loop";
import type { Fork, LlmCallSpan, RunRecord } from "@rebaseagent/trace-sdk";

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
export type PromptForkField = "system_prompt" | "user_message";

/** prompt fork 编辑描述：单项字段 + 字符串新值 */
export interface PromptForkEdit {
  field: PromptForkField;
  value: string;
}

export interface DerivePromptForkStateInput {
  /** 直接父 run 的解析记录（只读；derive 内部深拷贝，不改父数据） */
  record: RunRecord;
  edit: PromptForkEdit;
}

export interface DerivedPromptForkState {
  /** 编辑后的启动 messages（深拷贝，可直接作为 runLoop 初始输入） */
  messages: Message[];
  /**
   * 本次 RunConfig.systemPrompt 应使用的值：
   * system_prompt 编辑 = 编辑后的新值；user_message 编辑 = 父 run 原值。
   * 编排层必须以此覆写 config.systemPrompt，保证 config_hash 与实际请求一致。
   */
  systemPrompt: string;
  /** fork 元数据：at_span 固定为父 run 首次 llm.call 的 span id */
  fork: Fork;
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

/** 非法编辑目标的统一拒绝（运行时防线；类型层面已收窄） */
function assertLegalEdit(edit: PromptForkEdit): void {
  if (edit.field !== "system_prompt" && edit.field !== "user_message") {
    throw new Error(
      `非法的 prompt fork 编辑目标：${String(edit.field)}（只允许 system_prompt 或 user_message，一次只修改一个变量）`,
    );
  }
  if (typeof edit.value !== "string") {
    throw new Error("prompt fork 的编辑值必须是字符串（不支持多模态对象或结构化内容）");
  }
}

/**
 * 派生 prompt fork 的起点状态：编辑后的启动 messages + 本次 systemPrompt + fork 元数据。
 *
 * 拒绝（均发生在创建文件与调用模型之前，由编排层先调本函数保证）：
 * - 父 run 无首次 llm.call 录制
 * - 缺少字符串 system 消息（两种编辑都依赖它重建 RunConfig.systemPrompt；
 *   config_hash 不可逆，系统不反推、不猜、不假定空字符串）
 * - user_message 编辑但无首条字符串 user 消息
 * - 空 fork（编辑前后相同）
 * - 非法字段 / 非字符串编辑值
 */
export function derivePromptForkState(input: DerivePromptForkStateInput): DerivedPromptForkState {
  const { record, edit } = input;
  assertLegalEdit(edit);

  const llmSpan = firstLlmCall(record);
  const { system, user } = locateStartupContext(llmSpan.request.messages);

  // 字符串 system 消息是整个 prompt fork 的前置条件（两种编辑均依赖）
  if (system === null) {
    throw new Error(
      `父 run ${record.meta.id} 的首次 llm.call 不含字符串形式的 system 消息，无法重建 RunConfig.systemPrompt，prompt fork 不可用（系统不从 config_hash 反推）`,
    );
  }
  if (edit.field === "user_message" && user === null) {
    throw new Error(
      `父 run ${record.meta.id} 的首次 llm.call 不含字符串形式的 user 消息，无法编辑初始用户指令`,
    );
  }

  // 深拷贝后只改目标消息；父记录零改动（trace-sdk 的 ChatMessage 为宽松透传类型，
  // 录制自 loop 的请求本就是 Message 形状——与 derive.ts 同一中转）
  const messages = structuredClone(llmSpan.request.messages) as unknown as Message[];
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
  };
}
