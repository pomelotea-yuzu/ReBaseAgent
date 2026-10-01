import type { SettingsState } from "@shared/ipc";

/**
 * U5（unify-run-execution-workflow）任务 5.4：设置表单的**会话内判据**（纯函数）。
 *
 * delta 口径（「设置往返保留编辑并真实反馈配置结果」）：
 * - 「未保存设置关闭可继续或放弃」⇒ 关闭/Esc 前判"有没有未保存修改"，
 *   模型字段与密钥输入都算（密钥只要打过字就算——单向存储，打字本身就是未保存的
 *   凭据输入）。⚠️ U8（任务 2.10）起设置**不再维护代理未应用字段**——代理配置在独立
 *   录制工作区有自己的草稿与退出保护（`lib/recording-draft.ts`），这里只剩模型三件。
 * - 「保存失败和保存后回读失败区分」⇒ `saveSettings` 的三态结局
 *   （`saved / save-failed / reread-failed`）由 store 判定，界面按态分支；
 * - 「单向密钥与保存反馈不冒充连通」⇒ 回读形状**结构上没有** apiKey 字段
 *   （`SettingsStateSchema` 的键集是判据，测试直接数），保存成功的措辞只称"已保存/已配置"。
 */

/** store `saveSettings` 的三态结局（"true/false" 会把"已保存但没核实"糊进失败里） */
export type SettingsSaveOutcome = "saved" | "save-failed" | "reread-failed";

export interface SettingsDraft {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey: string;
}

/**
 * 是否有未保存修改。与"已保存事实"逐项比（trim 后同值 = 没改）。
 * U8 2.10 起 `ProxyDraft` 参数删除（设置不再维护代理字段，避免两份配置真相）。
 */
export function settingsDraftDirty(input: {
  draft: SettingsDraft;
  saved: SettingsState | null;
}): boolean {
  if (input.draft.apiKey !== "") return true;
  if (input.draft.baseURL.trim() !== (input.saved?.baseURL ?? "")) return true;
  if (input.draft.model.trim() !== (input.saved?.model ?? "")) return true;
  return false;
}
