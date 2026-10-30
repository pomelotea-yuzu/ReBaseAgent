import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src/renderer/src");

function read(path: string): string {
  return readFileSync(resolve(SRC, path), "utf8");
}

describe("语言变化的本地确认清理接线", () => {
  it("有效语言变化统一清空中心执行确认并推进 epoch", () => {
    const slice = read("store/slices/ui-preferences.ts");
    expect(slice).toContain("get().clearExecutionConfirmations()");
    // 验证准备/测试许可是中心态的未提交确认，同样随有效语言变化清零（D16）
    expect(slice).toContain("get().revokeVerificationConfirmations()");
    expect(slice).toContain("languageEpoch: get().languageEpoch + 1");
    expect(slice).toContain("next.effectiveLocale !== get().effectiveLocale");
  });

  it("费用/副本写入/副作用勾选都订阅语言 epoch，首次挂载不误清", () => {
    for (const file of [
      "components/CreateRunWorkspace.tsx",
      "components/detail/ResultForkEditor.tsx",
      "components/detail/PromptForkEditor.tsx",
      "components/ModelAbEditor.tsx",
    ]) {
      expect(read(file), file).toContain("useResetOnLanguageChange");
    }
    const hook = read("lib/use-reset-on-language-change.ts");
    expect(hook).toContain("if (epoch === lastEpoch.current) return");
    expect(hook).toContain("lastEpoch.current = epoch");
  });

  it("语言不进入 Provider key（不重建编辑器/工作区/焦点）", () => {
    const main = read("main.tsx");
    expect(main).toContain("<I18nProvider locale={locale}>");
    expect(main).not.toContain("key={locale}");
  });
});
