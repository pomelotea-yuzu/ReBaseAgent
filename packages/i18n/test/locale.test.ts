import { describe, expect, it } from "vitest";
import {
  isLocale,
  parseExplicitLocale,
  resolveDesktopLocale,
  resolveSystemLocale,
} from "../src/index.js";

describe("locale：显式值与系统回退", () => {
  it("显式语言只接受两个规范值", () => {
    expect(parseExplicitLocale("zh-CN")).toBe("zh-CN");
    expect(parseExplicitLocale("en-US")).toBe("en-US");
    for (const value of ["zh", "zh-CN ", "zh-cn", "en", "en_US", "fr-FR", "", null, 1]) {
      expect(parseExplicitLocale(value)).toBeNull();
    }
    expect(isLocale("zh-CN")).toBe(true);
    expect(isLocale("zh-TW")).toBe(false);
  });

  it("系统 zh 变体归 zh-CN，其余及失败归 en-US", () => {
    for (const value of ["zh", "zh-CN", "zh_TW.UTF-8", "zh-Hans-CN", "ZH-hant"]) {
      expect(resolveSystemLocale(value)).toBe("zh-CN");
    }
    for (const value of ["en", "en-GB", "fr-FR", "C", "POSIX", "", null, undefined]) {
      expect(resolveSystemLocale(value)).toBe("en-US");
    }
  });

  it("桌面偏好 system 时按系统语言解析，显式偏好优先", () => {
    expect(resolveDesktopLocale("system", "zh-TW")).toBe("zh-CN");
    expect(resolveDesktopLocale("system", "fr-FR")).toBe("en-US");
    expect(resolveDesktopLocale("system", null)).toBe("en-US");
    expect(resolveDesktopLocale("en-US", "zh-CN")).toBe("en-US");
    expect(resolveDesktopLocale("zh-CN", "en-US")).toBe("zh-CN");
  });
});
