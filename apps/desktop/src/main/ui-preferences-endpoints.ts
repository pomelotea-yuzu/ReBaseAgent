import { type Locale, resolveSystemLocale } from "@rebaseagent/i18n";
import type { Envelope, UiLanguagePreference, UiPreferencesState } from "../shared/ipc";
import { UiPreferencesSetInputSchema, fail, ok } from "../shared/ipc";
import { OPERATION_ERROR } from "../shared/operations";
import type { TrustedSender } from "./operation-endpoints";
import type { UiPreferencesSnapshot, UiPreferencesStore } from "./ui-preferences";

/**
 * 语言偏好端点：纯逻辑、零 Electron 依赖，便于直测 sender/阀门/恢复原因。
 *
 * 与配置写通道刻意不同：语言只影响展示，**不判配置锁、不轮换配置修订、
 * 不触碰 settings/密钥**。system 偏好由 main 按当前系统语言解析；显式偏好
 * 永远优先。response.revision 供 renderer 丢弃乱序回声。
 */
export interface UiPreferencesEndpointDeps {
  readonly store: UiPreferencesStore;
  /** main 当前系统语言（Electron app.getSystemLocale / getLocale） */
  readonly systemLocale: () => string | null | undefined;
  readonly isTrustedSender: (sender: TrustedSender) => boolean;
}

function effectiveLocale(
  preference: UiLanguagePreference,
  systemLocale: string | null | undefined,
): Locale {
  if (preference === "zh-CN" || preference === "en-US") return preference;
  return resolveSystemLocale(systemLocale);
}

function stateOf(
  snapshot: UiPreferencesSnapshot,
  systemLocale: string | null | undefined,
): UiPreferencesState {
  return {
    preference: snapshot.preferences.language,
    effectiveLocale: effectiveLocale(snapshot.preferences.language, systemLocale),
    source: snapshot.source,
    issue: snapshot.issue,
    revision: snapshot.revision,
  };
}

export function readUiPreferences(deps: UiPreferencesEndpointDeps): Envelope<UiPreferencesState> {
  try {
    return ok(stateOf(deps.store.load(), deps.systemLocale()));
  } catch (error) {
    return fail("UI_PREFERENCES_READ_FAILED", error);
  }
}

export function setUiPreference(
  deps: UiPreferencesEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Envelope<UiPreferencesState> {
  if (!deps.isTrustedSender(sender)) {
    return fail(
      OPERATION_ERROR.untrustedSender,
      new Error("语言偏好通道只接受本应用窗口主 frame 的调用"),
    );
  }
  const parsed = UiPreferencesSetInputSchema.safeParse(payload);
  if (!parsed.success) return fail("INVALID_ARGUMENT", parsed.error);
  try {
    return ok(stateOf(deps.store.save(parsed.data.preference), deps.systemLocale()));
  } catch (error) {
    return fail("UI_PREFERENCES_SAVE_FAILED", error);
  }
}
