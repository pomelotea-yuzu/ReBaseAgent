import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTranslator } from "@rebaseagent/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { buildCloseConfirmText } from "../src/main/draft-close-flow";
import {
  closeConfirmLabels,
  dataDirDialogOptions,
  directoryDialogOptions,
  translatorForSystemLocale,
  translatorForUiLanguage,
} from "../src/main/native-dialogs";
import { UI_PREFERENCES_FILE_NAME, UiPreferencesStore } from "../src/main/ui-preferences";

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "native-dialogs-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mainSource(file: string): string {
  return readFileSync(resolve(import.meta.dirname, "../src/main", file), "utf8");
}

describe("原生对话框文案：打开时按当前语言", () => {
  it("系统语言 zh 变体取 zh-CN，其他取 en-US", () => {
    expect(translatorForSystemLocale("zh-TW").locale).toBe("zh-CN");
    expect(translatorForSystemLocale("C").locale).toBe("en-US");
  });

  it("已保存偏好优先于系统语言；损坏偏好回退系统", () => {
    const dir = makeDir();
    const store = new UiPreferencesStore({ dataDir: dir });
    store.save("en-US");
    expect(translatorForUiLanguage({ store, systemLocale: () => "zh-CN" }).locale).toBe("en-US");

    const corrupt = makeDir();
    writeFileSync(join(corrupt, UI_PREFERENCES_FILE_NAME), "{broken", "utf8");
    expect(
      translatorForUiLanguage({
        store: new UiPreferencesStore({ dataDir: corrupt }),
        systemLocale: () => "zh-CN",
      }).locale,
    ).toBe("zh-CN");
  });

  it("关闭确认的英文标签不含中文，事实仍完整", () => {
    const en = createTranslator({ locale: "en-US" });
    const labels = closeConfirmLabels(en);
    const text = buildCloseConfirmText(
      { draft: "dirty", activeOperation: true, configurationBusy: false },
      false,
      labels,
    );
    expect(text.title).toBe("Quit ReBaseAgent");
    expect(text.quitLabel).toBe("Quit and discard drafts");
    expect(text.message).toBe("There are unsaved debugging drafts and an operation is in flight");
    expect(text.detail).toContain("does not cancel upstream requests");
    expect(`${text.title}${text.message}${text.detail}${text.quitLabel}`).not.toMatch(
      /[\u4e00-\u9fff]/,
    );
  });

  it("数据目录/目录选择的应用文案随语言变化，按钮保持 Select/选择", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    expect(dataDirDialogOptions(zh).title).toContain("数据目录");
    expect(dataDirDialogOptions(en).title).toBe("Choose a ReBaseAgent data directory");
    expect(dataDirDialogOptions(en).buttonLabel).toBe("Select");
    expect(directoryDialogOptions(zh).buttonLabel).toBe("选择");
    expect(directoryDialogOptions(en).title).toBe("Choose a directory");
  });

  it("三处对话框都在打开时取语言；取消路径保持不执行/不写业务数据", () => {
    const index = mainSource("index.ts");
    expect(index).toContain(
      "dataDirDialogOptions(translatorForSystemLocale(currentSystemLocale()))",
    );
    expect(index).toContain("if (picked.canceled || picked.filePaths.length === 0)");
    expect(index).toContain("app.quit()");
    expect(index).toContain("attachDraftCloseGuard(win, operations, r3InFlight, dialogLabels)");

    const ipc = mainSource("ipc.ts");
    expect(ipc).toContain("directoryDialogOptions(dialogTranslator())");
    expect(ipc).toContain("if (result.canceled || result.filePaths.length === 0) return null;");

    const attach = mainSource("draft-close-attach.ts");
    expect(attach).toContain(
      "showConfirm: (facts) => showMergedConfirm(win, guard, facts, labelsOf())",
    );
    expect(attach).toContain("cancelId: 0");
  });
});
