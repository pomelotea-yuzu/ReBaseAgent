import { type Locale, resolveSystemLocale } from "@rebaseagent/i18n";
import type { UiLanguagePreference, UiPreferencesState } from "@shared/ipc";
import { UiPreferencesStateSchema } from "@shared/ipc";
import { api } from "../../lib/api";
import type { SliceContext } from "../types";

/**
 * 展示语言偏好（renderer 侧）：
 * - 首次业务视图挂载前由 main.tsx 读取，避免先渲染错误语言再闪换。
 * - 保存入口独立于 settings：只调 uiPreferences:set，不提交未保存的模型/代理输入。
 * - 每次 get/set 递增本 store 的请求代次；只有最新代次且 revision 不回退的响应才采纳
 *   ⇒ 旧的 get 回声不会覆盖刚保存的新偏好。
 */
export interface UiPreferencesSlice {
  uiPreferences: UiPreferencesState | null;
  effectiveLocale: Locale;
  uiPreferencesLoaded: boolean;
  uiPreferencesSaving: boolean;
  uiPreferencesSaveFailed: boolean;
  /** 仅作响应排序，不参与渲染；值本身无业务含义。 */
  uiPreferencesRequestSeq: number;

  loadUiPreferences: () => Promise<boolean>;
  saveUiLanguage: (preference: UiLanguagePreference) => Promise<"saved" | "failed" | "stale">;
}

function fallbackLocale(): Locale {
  const language =
    typeof navigator === "undefined" ? undefined : (navigator.language as string | undefined);
  return resolveSystemLocale(language);
}

function accepted(current: UiPreferencesState | null, next: UiPreferencesState): boolean {
  return current === null || next.revision >= current.revision;
}

export function createUiPreferencesSlice({ set, get }: SliceContext): UiPreferencesSlice {
  return {
    uiPreferences: null,
    effectiveLocale: fallbackLocale(),
    uiPreferencesLoaded: false,
    uiPreferencesSaving: false,
    uiPreferencesSaveFailed: false,
    uiPreferencesRequestSeq: 0,

    async loadUiPreferences() {
      const seq = get().uiPreferencesRequestSeq + 1;
      set({ uiPreferencesRequestSeq: seq });
      try {
        const envelope = await api.getUiPreferences();
        if (get().uiPreferencesRequestSeq !== seq) return false;
        if (!envelope.ok) {
          set({ uiPreferencesLoaded: true });
          return false;
        }
        const parsed = UiPreferencesStateSchema.safeParse(envelope.data);
        if (!parsed.success) {
          set({ uiPreferencesLoaded: true });
          return false;
        }
        if (!accepted(get().uiPreferences, parsed.data)) return false;
        set({
          uiPreferences: parsed.data,
          effectiveLocale: parsed.data.effectiveLocale,
          uiPreferencesLoaded: true,
          uiPreferencesSaveFailed: false,
        });
        return true;
      } catch {
        if (get().uiPreferencesRequestSeq === seq) set({ uiPreferencesLoaded: true });
        return false;
      }
    },

    async saveUiLanguage(preference) {
      const seq = get().uiPreferencesRequestSeq + 1;
      set({
        uiPreferencesRequestSeq: seq,
        uiPreferencesSaving: true,
        uiPreferencesSaveFailed: false,
      });
      try {
        const envelope = await api.setUiPreferences({ preference });
        if (get().uiPreferencesRequestSeq !== seq) return "stale";
        if (!envelope.ok) {
          set({ uiPreferencesSaving: false, uiPreferencesSaveFailed: true });
          return "failed";
        }
        const parsed = UiPreferencesStateSchema.safeParse(envelope.data);
        if (!parsed.success) {
          set({ uiPreferencesSaving: false, uiPreferencesSaveFailed: true });
          return "failed";
        }
        if (!accepted(get().uiPreferences, parsed.data)) {
          set({ uiPreferencesSaving: false, uiPreferencesSaveFailed: true });
          return "failed";
        }
        set({
          uiPreferences: parsed.data,
          effectiveLocale: parsed.data.effectiveLocale,
          uiPreferencesLoaded: true,
          uiPreferencesSaving: false,
          uiPreferencesSaveFailed: false,
        });
        return "saved";
      } catch {
        if (get().uiPreferencesRequestSeq === seq) {
          set({ uiPreferencesSaving: false, uiPreferencesSaveFailed: true });
        }
        return "failed";
      }
    },
  };
}
