import { describe, expect, it } from "vitest";
import { NAMESPACES, enUS, resources, zhCN } from "../src/index.js";

describe("resources：双语键契约", () => {
  it("两种语言的 namespace 与键完全一致", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
    for (const namespace of NAMESPACES) {
      expect(Object.keys(enUS[namespace]).sort()).toEqual(Object.keys(zhCN[namespace]).sort());
    }
  });

  it("键为语义化 ASCII，值非空，中文与英文不逐字相同", () => {
    const zhTable = zhCN as Record<string, Record<string, string>>;
    const enTable = enUS as Record<string, Record<string, string>>;
    for (const namespace of NAMESPACES) {
      for (const [key, zh] of Object.entries(zhTable[namespace] ?? {})) {
        const en = enTable[namespace]?.[key] ?? "";
        expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(zh.trim()).not.toBe("");
        expect(en.trim()).not.toBe("");
        if (key !== "appName") expect(en).not.toBe(zh);
      }
    }
  });

  it("资源对象被冻结，实例不能篡改共享资源", () => {
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(zhCN.common)).toBe(true);
    expect(Object.isFrozen(enUS.common)).toBe(true);
  });
});
