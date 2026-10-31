import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LanguageSettings } from "../src/renderer/src/components/LanguageSettings";
import { renderWithLocale } from "./i18n/render-with-locale";

/**
 * 4.3：**界面语言入口**（D14/D15）。
 *
 * - 三个偏好（跟随系统 / 简体中文 / English）按当前语言命名，选中态来自已保存偏好；
 * - 保存中禁用三个单选，保存失败给本地化提示（store 只在成功后更新有效语言）；
 * - 偏好文件损坏/版本未知给可关闭提示，不自动覆盖；
 * - 纯视图不接触 store/写通道——切语言不会提交模型配置。
 */

const base = {
  saving: false,
  saveFailed: false,
  issue: null,
} as const;

describe("界面语言入口：两语言文案与状态", () => {
  it("zh-CN：跟随系统/简体中文/英语，选中态来自偏好，帮助说明即时生效", () => {
    const html = renderWithLocale(
      "zh-CN",
      <LanguageSettings {...base} preference="system" onChange={() => {}} />,
    );
    expect(html).toContain("界面语言");
    expect(html).toContain("跟随系统");
    expect(html).toContain("简体中文");
    expect(html).toContain("英语（English）");
    expect(html).toContain("立即生效");
    expect(html).toMatch(/data-language-option="system"[^>]*checked=""/);
    expect(html).toContain('role="radiogroup"');
  });

  it("en-US：英文标签、选中项与保存失败提示独立书写", () => {
    const html = renderWithLocale(
      "en-US",
      <LanguageSettings {...base} preference="en-US" saveFailed onChange={() => {}} />,
    );
    expect(html).toContain("Interface language");
    expect(html).toContain("Follow the system");
    expect(html).toContain("Simplified Chinese");
    expect(html).toContain("without a restart");
    expect(html).toMatch(/data-language-option="en-US"[^>]*checked=""/);
    expect(html).toContain("was not saved");
    expect(html).toContain('role="alert"');
  });

  it("保存中三个单选都禁用（防重复提交）；保存完成前不冒充成功", () => {
    const html = renderWithLocale(
      "zh-CN",
      <LanguageSettings {...base} preference="zh-CN" saving onChange={() => {}} />,
    );
    expect(html.match(/data-language-option="[^"]+"[^>]*disabled=""/g)?.length).toBe(3);
    expect(html).toContain("正在保存语言偏好");
  });

  it("偏好文件损坏/版本未知：就近提示 + 可关闭，不自动覆盖原文件", () => {
    const corrupt = renderWithLocale(
      "zh-CN",
      <LanguageSettings {...base} preference="system" issue="corrupt" onChange={() => {}} />,
    );
    expect(corrupt).toContain('data-language-issue="corrupt"');
    expect(corrupt).toContain("未自动覆盖原文件");
    expect(corrupt).toContain("关闭提示");

    const unknown = renderWithLocale(
      "en-US",
      <LanguageSettings
        {...base}
        preference="system"
        issue="unknown_version"
        onChange={() => {}}
      />,
    );
    expect(unknown).toContain('data-language-issue="unknown_version"');
    expect(unknown).toContain("unknown version");
  });
});

describe("4.3 接线契约：语言偏好独立保存", () => {
  const read = (rel: string): string => readFileSync(resolve(import.meta.dirname, rel), "utf8");

  it("设置对话框挂载 LanguageSettings，变更只走 saveUiLanguage", () => {
    const dialog = read("../src/renderer/src/components/SettingsDialog.tsx");
    expect(dialog).toContain("<LanguageSettings");
    expect(dialog).toContain("saveUiLanguage(preference)");
    // 语言区块不碰模型保存/清除入口（独立写通道）
    const at = dialog.indexOf("<LanguageSettings");
    const block = dialog.slice(at, dialog.indexOf("/>", at));
    for (const forbidden of ["saveSettings(", "clearSettings(", "api."]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
  });

  it("语言组件是纯视图：不 import store/api/保存通道", () => {
    const src = read("../src/renderer/src/components/LanguageSettings.tsx");
    const imports = src
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n");
    for (const forbidden of ["../store", "lib/api", "saveSettings", "ui-preferences"]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
  });
});
