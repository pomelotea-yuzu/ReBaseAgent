import {
  type Translator,
  createTranslator,
  resolveDesktopLocale,
  resolveSystemLocale,
} from "@rebaseagent/i18n";
import type { CloseConfirmLabels } from "./draft-close-flow";
import type { UiPreferencesStore } from "./ui-preferences";

/**
 * 原生对话框的应用文案：每处都在**打开时**用当前语言构造 translator。
 * 已打开的系统模态不重建；OS 自带按钮/菜单不在本项目控制范围。
 */
export interface UiLanguageSource {
  readonly store: UiPreferencesStore;
  readonly systemLocale: () => string | null | undefined;
}

export function translatorForSystemLocale(systemLocale: string | null | undefined): Translator {
  return createTranslator({ locale: resolveSystemLocale(systemLocale) });
}

export function translatorForUiLanguage(source: UiLanguageSource): Translator {
  let preference: "system" | "zh-CN" | "en-US" = "system";
  try {
    preference = source.store.load().preferences.language;
  } catch {
    // 偏好读取异常不能阻断原生提示：退回系统语言
    preference = "system";
  }
  return createTranslator({
    locale: resolveDesktopLocale(preference, source.systemLocale()),
  });
}

export function closeConfirmLabels(translator: Translator): CloseConfirmLabels {
  return {
    backLabel: translator.t("common.back"),
    quitLabel: translator.t("common.quit"),
    quitAndDiscardLabel: translator.t("common.quitAndDiscardDraft"),
    title: translator.t("common.draftCloseTitle"),
    messageDirty: translator.t("common.draftCloseMessageDirty"),
    messageDirtyWithOperation: translator.t("common.draftCloseMessageDirtyWithOperation"),
    messageUnknown: translator.t("common.draftCloseMessageUnknown"),
    messageUnknownWithOperation: translator.t("common.draftCloseMessageUnknownWithOperation"),
    messageConfigurationBusy: translator.t("common.draftCloseMessageConfigurationBusy"),
    messageActiveOperation: translator.t("common.draftCloseMessageActiveOperation"),
    noteDraftLost: translator.t("common.draftCloseNoteDraftLost"),
    noteDraftUnknown: translator.t("common.draftCloseNoteDraftUnknown"),
    noteActiveOperation: translator.t("common.draftCloseNoteActiveOperation"),
    noteConfigurationBusy: translator.t("common.draftCloseNoteConfigurationBusy"),
    notePendingLoss: translator.t("common.draftCloseNotePendingLoss"),
    noteContinue: translator.t("common.draftCloseNoteContinue"),
  };
}

export interface DataDirDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly buttonLabel: string;
}

export function dataDirDialogOptions(translator: Translator): DataDirDialogOptions {
  return {
    title: translator.t("common.chooseDataDirTitle"),
    message: translator.t("common.chooseDataDirMessage"),
    buttonLabel: translator.t("common.select"),
  };
}

export interface DirectoryDialogOptions {
  readonly title: string;
  readonly buttonLabel: string;
}

export function directoryDialogOptions(translator: Translator): DirectoryDialogOptions {
  return {
    title: translator.t("common.chooseDirectoryTitle"),
    buttonLabel: translator.t("common.select"),
  };
}
