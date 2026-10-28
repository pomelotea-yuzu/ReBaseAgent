import { describe, expect, it } from "vitest";
import { type MessageKey, type MissingKeyEvent, createTranslator } from "../src/index.js";

describe("createTranslator：同步初始化与回退", () => {
  it("首次调用无需等待即可取到对应语言文案", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    expect(zh.t("common.unknown")).toBe("未知");
    expect(en.t("common.unknown")).toBe("Unknown");
    expect(zh.t("common.messageUnavailable")).toBe("此消息暂不可用");
    expect(en.t("common.messageUnavailable")).toBe("This message is unavailable");
  });

  it("英文缺键回退中文同键", () => {
    const en = createTranslator({ locale: "en-US" });
    en.instance.removeResourceBundle("en-US", "common");
    expect(en.t("common.unknown")).toBe("未知");
  });

  it("两语言都缺键时返回本地化通用提示并只上报 locale/namespace/key", () => {
    const events: MissingKeyEvent[] = [];
    const en = createTranslator({
      locale: "en-US",
      onMissingKey: (event) => events.push(event),
    });
    const missing = "run.missingKey" as MessageKey;
    expect(en.t(missing, { secret: "do-not-log" })).toBe("This message is unavailable");
    expect(events).toEqual([{ locale: "en-US", namespace: "run", key: "missingKey" }]);
    expect(JSON.stringify(events)).not.toContain("do-not-log");
  });

  it("has 只判断当前实例语言，不把通用提示当命中", () => {
    const en = createTranslator({ locale: "en-US" });
    expect(en.has("common.unknown")).toBe(true);
    expect(en.has("common.stepCount")).toBe(true);
    expect(en.has("run.missingKey" as MessageKey)).toBe(false);
  });

  it("整数与复数按语言规则输出，中文量词自然", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    for (const count of [0, 1, 2, 100]) {
      expect(zh.t("common.stepCount", { count })).toBe(`${count} 步`);
    }
    expect(en.t("common.stepCount", { count: 0 })).toBe("0 steps");
    expect(en.t("common.stepCount", { count: 1 })).toBe("1 step");
    expect(en.t("common.stepCount", { count: 2 })).toBe("2 steps");
    expect(en.t("common.stepCount", { count: 100 })).toBe("100 steps");
  });

  it("参数保持原值，语序可按语言变化", () => {
    const params = { runId: "r_01", stepCount: 3, duration: "1.2s" };
    const zh = createTranslator({ locale: "zh-CN" }).t("common.runSummary", params);
    const en = createTranslator({ locale: "en-US" }).t("common.runSummary", params);
    expect(zh).toBe("运行 r_01：3 步 · 1.2s");
    expect(en).toBe("1.2s · 3 steps · r_01");
    for (const value of ["r_01", "3", "1.2s"]) {
      expect(zh).toContain(value);
      expect(en).toContain(value);
    }
  });

  it("参数不解析为 HTML", () => {
    const text = createTranslator({ locale: "en-US" }).t("common.deleteRunConfirm", {
      name: '<img src=x onerror="alert(1)">',
    });
    expect(text).toContain('<img src=x onerror="alert(1)">');
    expect(text.startsWith("Delete ")).toBe(true);
  });
});
