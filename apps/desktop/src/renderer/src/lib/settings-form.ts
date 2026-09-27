import type { ProxyState, SettingsState } from "@shared/ipc";

/**
 * U5（unify-run-execution-workflow）任务 5.4：设置表单的**会话内判据**（纯函数）。
 *
 * 三条 delta 口径（「设置往返保留编辑并真实反馈配置结果」）：
 * - 「未保存设置关闭可继续或放弃」⇒ 关闭/Esc 前判"有没有未保存修改"，
 *   **模型字段、密钥输入、未应用的代理字段**都算（密钥只要打过字就算——单向存储，
 *   打字本身就是未保存的凭据输入）；
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

export interface ProxyDraft {
  readonly enabled: boolean;
  readonly portText: string;
  readonly upstream: string;
}

/**
 * 是否有未保存修改。与"已保存事实"逐项比（trim 后同值 = 没改）；
 * 代理状态还没读到（null）时**不**把代理字段算作修改——没有可比的"当前应用值"，
 * 拿默认值冒充基线会把没碰过代理的人钉成脏。
 */
export function settingsDraftDirty(input: {
  draft: SettingsDraft;
  proxyDraft: ProxyDraft;
  saved: SettingsState | null;
  proxy: ProxyState | null;
}): boolean {
  if (input.draft.apiKey !== "") return true;
  if (input.draft.baseURL.trim() !== (input.saved?.baseURL ?? "")) return true;
  if (input.draft.model.trim() !== (input.saved?.model ?? "")) return true;
  const proxy = input.proxy;
  if (proxy === null) return false;
  if (input.proxyDraft.enabled !== proxy.enabled) return true;
  if (input.proxyDraft.portText !== String(proxy.port)) return true;
  if (input.proxyDraft.upstream.trim() !== proxy.upstreamBaseUrl) return true;
  return false;
}
