import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_MAX_LENGTH,
  GENERIC_LLM_FAILURE,
  REDACTION_PLACEHOLDER,
  TRUNCATION_MARKER,
  buildRedactionSecrets,
  limitDiagnosticText,
  normalizeFailureText,
  redactDiagnosticText,
  sanitizeDiagnosticText,
} from "../src/index";

describe("normalizeFailureText：有效文本判据", () => {
  it("Error 取 message；字符串原样", () => {
    expect(normalizeFailureText(new Error("端点 401"))).toBe("端点 401");
    expect(normalizeFailureText("网络断开")).toBe("网络断开");
  });

  it("非空但无诊断价值的 String() 产物一律兜底", () => {
    // 这些值 String() 之后"非空"，但按字面实现会把垃圾文本当详情落盘
    expect(normalizeFailureText({})).toBe(GENERIC_LLM_FAILURE);
    expect(normalizeFailureText(undefined)).toBe(GENERIC_LLM_FAILURE);
    expect(normalizeFailureText(null)).toBe(GENERIC_LLM_FAILURE);
    expect(normalizeFailureText("")).toBe(GENERIC_LLM_FAILURE);
    expect(normalizeFailureText("   \n")).toBe(GENERIC_LLM_FAILURE);
    expect(normalizeFailureText(new Error(""))).toBe(GENERIC_LLM_FAILURE);
  });

  it("String() 转换抛错也不炸（归一化失败会丢掉整条终止记录）", () => {
    const hostile = {
      toString() {
        throw new Error("boom");
      },
    };
    expect(() => normalizeFailureText(hostile)).not.toThrow();
    expect(normalizeFailureText(hostile)).toBe(GENERIC_LLM_FAILURE);
  });

  it("有诊断价值的非 Error 值保留文本（数字、带 toString 的对象）", () => {
    expect(normalizeFailureText(429)).toBe("429");
    expect(normalizeFailureText({ toString: () => "自定义失败原因" })).toBe("自定义失败原因");
  });
});

describe("buildRedactionSecrets：secrets 来源", () => {
  it("取非空 apiKey 与 baseURL 的 userinfo 凭据，并去重", () => {
    expect(buildRedactionSecrets({ apiKey: "sk-live-abc" })).toEqual(["sk-live-abc"]);
    expect(buildRedactionSecrets({ baseURL: "https://user:pass@host/v1" }).sort()).toStrictEqual([
      "pass",
      "user",
    ]);
    // 空 apiKey / 无 userinfo / 非法 URL 都不产生 secret
    expect(buildRedactionSecrets({ apiKey: "  " })).toEqual([]);
    expect(buildRedactionSecrets({ baseURL: "https://api.deepseek.com/v1" })).toEqual([]);
    expect(buildRedactionSecrets({ baseURL: "not a url" })).toEqual([]);
    expect(buildRedactionSecrets({ apiKey: "same", baseURL: "https://same:same@host/v1" })).toEqual(
      ["same"],
    );
  });
});

describe("redactDiagnosticText：脱敏规则", () => {
  it("已知 secret 的字面量出现被替换（含正则元字符）", () => {
    const text = '响应体：{"key":"sk.a+b(c)"}';
    const out = redactDiagnosticText(text, ["sk.a+b(c)"]);
    expect(out).not.toContain("sk.a+b(c)");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("Bearer / Authorization / URL 内嵌凭据被替换，键名与结构保留", () => {
    expect(redactDiagnosticText("Authorization: Bearer sk-live-xyz", [])).toBe(
      `Authorization: Bearer ${REDACTION_PLACEHOLDER}`,
    );
    expect(redactDiagnosticText("authorization=abc123", [])).toBe(
      `authorization=${REDACTION_PLACEHOLDER}`,
    );
    expect(redactDiagnosticText("回显 https://user:pw@host/v1 失败", [])).toBe(
      `回显 https://${REDACTION_PLACEHOLDER}@host/v1 失败`,
    );
  });

  it("无凭据文本保持原样", () => {
    const text = "LLM 端点返回 HTTP 500：internal error";
    expect(redactDiagnosticText(text, ["sk-live-abc"])).toBe(text);
  });
});

describe("limitDiagnosticText / sanitizeDiagnosticText：长度口径", () => {
  it("超长截断并带标记，标记计入上限", () => {
    const long = "x".repeat(DIAGNOSTIC_MAX_LENGTH + 500);
    const out = limitDiagnosticText(long);
    expect(out.length).toBe(DIAGNOSTIC_MAX_LENGTH);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("未超长逐字节不变；限长幂等（客户端处理 + loop 兜底不会二次变形）", () => {
    const text = "x".repeat(DIAGNOSTIC_MAX_LENGTH);
    expect(limitDiagnosticText(text)).toBe(text);
    const once = sanitizeDiagnosticText("x".repeat(2000), ["sk-live-abc"]);
    expect(sanitizeDiagnosticText(once, ["sk-live-abc"])).toBe(once);
  });

  it("先脱敏后截断：位于上限之外的凭据仍被完整替换（顺序铁律）", () => {
    const secret = "sk-live-abcdefghijklmnop";
    // 凭据落在 200 字符之后、上限之内 ⇒ 提前切片会漏掉它
    const text = `${"a".repeat(300)}${secret}${"b".repeat(100)}`;
    const out = sanitizeDiagnosticText(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(secret.slice(0, 12)); // 不残留可识别前缀
    expect(out).toContain(REDACTION_PLACEHOLDER);
    expect(out.length).toBeLessThanOrEqual(DIAGNOSTIC_MAX_LENGTH);

    const beyond = `${"a".repeat(DIAGNOSTIC_MAX_LENGTH)}${secret}`;
    const truncated = sanitizeDiagnosticText(beyond, [secret]);
    expect(truncated).not.toContain(secret.slice(0, 8));
    expect(truncated.length).toBe(DIAGNOSTIC_MAX_LENGTH);
  });
});
