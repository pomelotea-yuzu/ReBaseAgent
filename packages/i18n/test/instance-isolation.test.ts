import { describe, expect, it } from "vitest";
import { createTranslator } from "../src/index.js";

describe("Translator 实例隔离", () => {
  it("交错调用不同语言实例互不污染", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    for (const key of ["common.unknown", "common.notRecorded", "common.back"] as const) {
      expect(zh.t(key)).not.toBe(en.t(key));
    }
    expect(zh.locale).toBe("zh-CN");
    expect(en.locale).toBe("en-US");
  });

  it("在一个实例上改语言或加资源不影响另一个实例", async () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });

    en.instance.addResourceBundle("en-US", "common", { unknown: "EN-ONLY" }, true, true);
    expect(en.t("common.unknown")).toBe("EN-ONLY");
    expect(zh.t("common.unknown")).toBe("未知");

    await en.instance.changeLanguage("zh-CN");
    expect(en.t("common.unknown")).toBe("未知");
    expect(zh.locale).toBe("zh-CN");
  });
});
