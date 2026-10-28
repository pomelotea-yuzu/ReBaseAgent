import { describe, expect, it } from "vitest";
import {
  type MessageValue,
  NAMESPACES,
  enUS,
  flattenCatalog,
  resources,
  zhCN,
} from "../src/index.js";

describe("resources：双语键契约", () => {
  it("两种语言的 namespace 与基础键完全一致", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
    for (const namespace of NAMESPACES) {
      expect(Object.keys(enUS[namespace]).sort()).toEqual(Object.keys(zhCN[namespace]).sort());
    }
  });

  it("键为语义化 ASCII，值非空；复数分支按语言完整", () => {
    const zhTable = zhCN as Record<string, Record<string, MessageValue>>;
    const enTable = enUS as Record<string, Record<string, MessageValue>>;
    // 只有占位符与分隔符的值没有可翻译文本（如 "{{target}} · {{command}}"），
    // 两种语言相同时不算"未翻译"；含实际文案的值仍必须不同。
    const hasTranslatableText = (value: string): boolean =>
      /[A-Za-z\u4e00-\u9fff]/.test(value.replace(/\{\{[^}]*\}\}/g, ""));
    for (const namespace of NAMESPACES) {
      for (const [key, zh] of Object.entries(zhTable[namespace] ?? {})) {
        const en = enTable[namespace]?.[key];
        expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
        if (typeof zh === "string") {
          expect(zh.trim()).not.toBe("");
          expect(typeof en).toBe("string");
          expect((en as string).trim()).not.toBe("");
          if (key !== "appName" && hasTranslatableText(zh)) expect(en).not.toBe(zh);
        } else {
          expect(zh.other.trim()).not.toBe("");
          expect(en).toMatchObject({ other: expect.any(String), one: expect.any(String) });
          const plural = en as { one: string; other: string };
          expect(plural.one.trim()).not.toBe("");
          expect(plural.one).not.toBe(plural.other);
        }
      }
    }
  });

  it("展开后生成 i18next 的复数键，中文不伪造 one 分支", () => {
    const zhFlat = flattenCatalog(zhCN);
    const enFlat = flattenCatalog(enUS);
    expect(zhFlat.common?.stepCount_other).toBe("{{count}} 步");
    expect(zhFlat.common?.stepCount_one).toBeUndefined();
    expect(enFlat.common?.stepCount_one).toBe("{{count}} step");
    expect(enFlat.common?.stepCount_other).toBe("{{count}} steps");
  });

  it("资源对象被冻结，实例不能篡改共享资源", () => {
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(zhCN.common)).toBe(true);
    expect(Object.isFrozen(enUS.common)).toBe(true);
  });
});
