import type { MessageKey } from "@rebaseagent/i18n";
import type { UiLanguagePreference } from "@shared/ipc";
import { type ReactNode, useState } from "react";
import { useTranslator } from "../i18n";

/**
 * 界面语言入口（任务 4.3）：只吃 props 的纯视图，偏好读写与确认清理留在 store。
 *
 * 边界（对应 D14/D15）：
 * - 三个偏好（跟随系统 / 简体中文 / English）即时保存，不重启、不提交上面的模型输入；
 * - 保存失败时保持原语言并如实提示（store 只在成功响应后更新有效语言）；
 * - 偏好文件损坏/版本未知时给可关闭的本地化提示，不自动覆盖原文件。
 */

const OPTIONS = [
  ["system", "settings.languageSystem"],
  ["zh-CN", "settings.languageChinese"],
  ["en-US", "settings.languageEnglish"],
] as const satisfies ReadonlyArray<readonly [UiLanguagePreference, MessageKey]>;

export function LanguageSettings({
  preference,
  saving,
  saveFailed,
  issue,
  onChange,
}: {
  readonly preference: UiLanguagePreference;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly issue: "corrupt" | "unknown_version" | null;
  readonly onChange: (preference: UiLanguagePreference) => void;
}): ReactNode {
  const translator = useTranslator();
  const [dismissed, setDismissed] = useState(false);
  return (
    <section
      data-settings-language
      aria-label={translator.t("settings.languageSectionAria")}
      className="mt-4 border-t border-gray-200 pt-3"
    >
      <div className="mb-1 text-sm font-semibold text-gray-800">
        {translator.t("settings.languageHeading")}
      </div>
      {issue !== null && !dismissed ? (
        <output
          data-language-issue={issue}
          className="mb-2 flex items-start gap-2 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-800"
        >
          <span className="min-w-0 flex-1">
            {translator.t(
              issue === "corrupt"
                ? "settings.languageIssueCorrupt"
                : "settings.languageIssueUnknownVersion",
            )}
          </span>
          <button
            type="button"
            aria-label={translator.t("settings.dismissNotice")}
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded px-1 text-amber-700 hover:bg-amber-100"
          >
            ×
          </button>
        </output>
      ) : null}
      <div
        role="radiogroup"
        aria-label={translator.t("settings.languageGroupAria")}
        className="flex flex-wrap gap-3 text-[11px] text-gray-700"
      >
        {OPTIONS.map(([value, key]) => (
          <label key={value} className="flex items-center gap-1">
            <input
              type="radio"
              name="ui-language"
              value={value}
              data-language-option={value}
              checked={preference === value}
              disabled={saving}
              onChange={() => onChange(value)}
            />
            {translator.t(key)}
          </label>
        ))}
      </div>
      <div className="mt-1 text-[11px] leading-4 text-gray-500">
        {translator.t("settings.languageHelp")}
      </div>
      {saving ? (
        <output className="mt-1 block text-[11px] text-sky-700">
          {translator.t("settings.languageSaving")}
        </output>
      ) : null}
      {saveFailed ? (
        <div role="alert" className="mt-1 text-[11px] text-red-700">
          {translator.t("settings.languageSaveFailed")}
        </div>
      ) : null}
    </section>
  );
}
