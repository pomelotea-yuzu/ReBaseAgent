import { createTranslator } from "@rebaseagent/i18n";
import { describe, expect, it } from "vitest";
import { applyHtmlLang } from "../src/renderer/src/lib/html-lang";
import {
  clearedStoreError,
  describeStoreError,
  storeError,
} from "../src/renderer/src/lib/store-error";

describe("store 错误描述派生", () => {
  it("保存 code 与旧文案，展示时按当前语言派生", () => {
    const patch = storeError("UI_RUN_LIST_REFRESH_FAILED", "读取 run 列表失败：目录不可读");
    expect(patch.error).toContain("目录不可读");
    expect(patch.errorDescriptor).toEqual({ code: "UI_RUN_LIST_REFRESH_FAILED" });
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    const zhText = describeStoreError(patch.errorDescriptor, zh);
    const enText = describeStoreError(patch.errorDescriptor, en);
    expect(zhText).toContain("操作未完成");
    expect(enText).toContain("did not complete");
    expect(enText).not.toBe(zhText);
  });

  it("受控 presentation 优先，非法描述降级为稳定 code 的通用解释", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const unsupported = storeError("UI_RUN_DETAIL_VERSION_UNSUPPORTED", "版本不支持", {
      id: "errors.unsupported",
    });
    expect(describeStoreError(unsupported.errorDescriptor, zh)).toContain("不支持");

    const invalid = storeError("UI_X", "x", { id: "errors.evil" } as never);
    expect(describeStoreError(invalid.errorDescriptor, zh)).toContain("操作未完成");
  });

  it("清除补丁同时清空旧文案与描述", () => {
    expect(clearedStoreError()).toEqual({ error: null, errorDescriptor: null });
  });
});

describe("HTML lang 跟随语言", () => {
  it("只改 documentElement.lang，不触发其他属性", () => {
    const element = { lang: "zh-CN", dir: "ltr" };
    applyHtmlLang(element, "en-US");
    expect(element).toEqual({ lang: "en-US", dir: "ltr" });
    applyHtmlLang(element, "zh-CN");
    expect(element.lang).toBe("zh-CN");
  });
});
