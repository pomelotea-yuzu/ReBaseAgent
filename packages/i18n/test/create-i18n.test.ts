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
    expect(en.has("run.missingKey" as MessageKey)).toBe(false);
  });
});
