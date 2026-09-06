/**
 * prompt fork 编辑器的客户端校验（纯函数，可单测）。
 *
 * 只做"提交前本地拦截"：未配置、缺字符串 system 消息、空 fork 等
 * 在不发 IPC 请求前就给出原因；服务端仍有同语义校验兜底（双保险）。
 */

export type PromptForkField = "system_prompt" | "user_message";

export interface PromptForkGuardInput {
  /** 要编辑的字段 */
  field: PromptForkField;
  /** 首次 llm.call 是否含字符串 system 消息（两种编辑共同的前置条件） */
  hasSystem: boolean;
  /** 首次 llm.call 是否含字符串 user 消息（仅 user_message 编辑需要） */
  hasUser: boolean;
  /** 运行配置是否已就绪（settings.configured） */
  settingsConfigured: boolean;
  /** 编辑值是否与原值相同（空 fork） */
  unchanged: boolean;
}

export interface PromptForkGuardResult {
  canSubmit: boolean;
  /** canSubmit = false 时的阻止原因（可直接展示） */
  reason: string | null;
}

export function promptForkGuard(input: PromptForkGuardInput): PromptForkGuardResult {
  if (!input.settingsConfigured) {
    return {
      canSubmit: false,
      reason: "尚未配置运行参数（baseURL / apiKey / model），请先点击右上角“运行配置”",
    };
  }
  if (!input.hasSystem) {
    return {
      canSubmit: false,
      reason:
        "首次 llm.call 不含字符串形式的 system 消息，无法重建 RunConfig.systemPrompt，prompt fork 不可用",
    };
  }
  if (input.field === "user_message" && !input.hasUser) {
    return {
      canSubmit: false,
      reason: "首次 llm.call 不含字符串形式的 user 消息，无法编辑初始用户指令",
    };
  }
  if (input.unchanged) {
    return { canSubmit: false, reason: "编辑值与原值相同（空 fork 被拒绝），请修改后再提交" };
  }
  return { canSubmit: true, reason: null };
}
