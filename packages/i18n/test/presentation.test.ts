import { describe, expect, it } from "vitest";
import {
  PRESENTATION_IDS,
  attachPresentation,
  createTranslator,
  degradeUnknownError,
  explainError,
  legacyPresentationId,
  parsePresentation,
  renderPresentation,
  validatePresentation,
} from "../src/index.js";

describe("presentation：领域事实与产品解释分离（S05/S06）", () => {
  it("S05：同一粗 code 用描述区分原因并翻译，code 不变", () => {
    const en = createTranslator({ locale: "en-US" });
    const notFound = explainError(
      {
        code: "RUN_LOOKUP_FAILED",
        presentation: { id: "errors.notFound", params: { kind: "run", id: "r_01" } },
      },
      en,
    );
    const invalid = explainError(
      {
        code: "RUN_LOOKUP_FAILED",
        presentation: { id: "errors.invalidArgument", params: { field: "runId" } },
      },
      en,
    );
    expect(notFound.code).toBe("RUN_LOOKUP_FAILED");
    expect(invalid.code).toBe("RUN_LOOKUP_FAILED");
    expect(notFound.text).toBe("The requested resource was not found.");
    expect(invalid.text).toBe("The request parameters are invalid.");
    expect(notFound.source).toBe("presentation");
    expect(notFound.degraded).toBe(false);
  });

  it("S05：旧 code 无描述时映射可读，未知异常只给通用摘要", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const legacy = explainError({ code: "RUN_NOT_FOUND" }, zh);
    expect(legacy.source).toBe("legacy");
    expect(legacy.presentation.id).toBe("errors.notFound");
    expect(legacy.text).toBe("未找到请求的资源。");

    const prep = explainError({ code: "R3_PREPARE_MISSING" }, zh);
    expect(prep.presentation.id).toBe("errors.preparationRequired");

    const degraded = degradeUnknownError(new Error("secret token in message"));
    expect(degraded.code).toBe("UNKNOWN_ERROR");
    expect(degraded.presentation.id).toBe("errors.generic");
    expect(JSON.stringify(degraded)).not.toContain("secret token");
    expect(JSON.stringify(degraded)).not.toContain("stack");
  });

  it("S05：非法描述降级为旧码映射/通用解释，不扩大输出", () => {
    const en = createTranslator({ locale: "en-US" });
    const longId = "x".repeat(500);
    const explained = explainError(
      {
        code: "RUN_NOT_FOUND",
        presentation: { id: "errors.notFound", params: { kind: "run", id: longId } },
      },
      en,
    );
    expect(explained.source).toBe("fallback");
    expect(explained.degraded).toBe(true);
    expect(explained.text).toBe("The requested resource was not found.");
    expect(JSON.stringify(explained)).not.toContain(longId);
  });

  it("S06：未知 id、超限/对象/敏感参数与非法容器全部拒绝", () => {
    expect(validatePresentation({ id: "errors.evil" })).toEqual({
      ok: false,
      reason: "UNKNOWN_ID",
    });
    expect(validatePresentation({ id: 1 })).toEqual({ ok: false, reason: "UNKNOWN_ID" });
    expect(validatePresentation("errors.generic")).toEqual({
      ok: false,
      reason: "NOT_OBJECT",
    });
    expect(validatePresentation({ id: "errors.generic", params: [] })).toEqual({
      ok: false,
      reason: "BAD_PARAMS",
    });
    expect(
      validatePresentation({ id: "errors.notFound", params: { id: "x".repeat(201) } }),
    ).toEqual({ ok: false, reason: "BAD_PARAM:id" });
    expect(
      validatePresentation({ id: "errors.notFound", params: { kind: { nested: true } } }),
    ).toEqual({ ok: false, reason: "BAD_PARAM:kind" });
    expect(
      validatePresentation({ id: "errors.notFound", params: { kind: "run", stack: "secret" } }),
    ).toEqual({ ok: false, reason: "UNKNOWN_PARAM:stack" });
    expect(
      validatePresentation({
        id: "errors.invalidArgument",
        params: { fields: ["a", "b", "c", "d", "e"] },
      }),
    ).toEqual({ ok: false, reason: "BAD_PARAM:fields" });
    expect(
      validatePresentation({
        id: "errors.invalidArgument",
        params: { limit: Number.POSITIVE_INFINITY },
      }),
    ).toEqual({ ok: false, reason: "BAD_PARAM:limit" });
    const protoParams = JSON.parse('{"__proto__":"x"}');
    expect(validatePresentation({ id: "errors.invalidArgument", params: protoParams })).toEqual({
      ok: false,
      reason: "UNKNOWN_PARAM:__proto__",
    });
    expect(parsePresentation({ id: "errors.generic" })).toEqual({ id: "errors.generic" });
    expect(parsePresentation({ id: "errors.evil" })).toBeNull();
  });

  it("S06：Envelope 兼容扩展只追加通过校验的描述", () => {
    const base = { code: "RUN_NOT_FOUND", message: "原始 detail 保持" };
    const attached = attachPresentation(base, {
      id: "errors.notFound",
      params: { kind: "run", id: "r_01" },
    });
    expect(attached.code).toBe("RUN_NOT_FOUND");
    expect(attached.message).toBe("原始 detail 保持");
    expect(attached.presentation?.id).toBe("errors.notFound");

    const rejected = attachPresentation(base, { id: "errors.evil" });
    expect(rejected).toEqual(base);
    expect("presentation" in rejected).toBe(false);
  });

  it("全部内置 id 在两种语言都有译文，旧码映射覆盖常见类别", () => {
    const zh = createTranslator({ locale: "zh-CN" });
    const en = createTranslator({ locale: "en-US" });
    for (const id of PRESENTATION_IDS) {
      const zhText = renderPresentation(zh, { id });
      const enText = renderPresentation(en, { id });
      expect(zhText.trim()).not.toBe("");
      expect(enText.trim()).not.toBe("");
      expect(enText).not.toBe(zhText);
    }
    expect(legacyPresentationId("STALE_CURSOR")).toBe("errors.staleCursor");
    expect(legacyPresentationId("OPERATION_DUPLICATED")).toBe("errors.conflict");
    expect(legacyPresentationId("UNSUPPORTED_TRACE_VERSION")).toBe("errors.unsupported");
    expect(legacyPresentationId("RUN_INVALID")).toBe("errors.invalidArgument");
    expect(legacyPresentationId("OPERATION_UNKNOWN")).toBe("errors.unknownOperation");
    expect(legacyPresentationId("TOTALLY_NEW_CODE")).toBe("errors.generic");
  });
});
