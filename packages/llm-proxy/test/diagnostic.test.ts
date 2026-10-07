import { describe, expect, it } from "vitest";
import {
  GENERIC_PROXY_FAILURE,
  PROXY_DIAGNOSTIC_MAX_LENGTH,
  REDACTION_PLACEHOLDER,
  TRUNCATION_MARKER,
  credentialLiteralsOf,
  extractUpstreamErrorMessage,
  limitProxyDiagnosticText,
  normalizeProxyFailureText,
  redactProxyDiagnosticText,
  sanitizeProxyDiagnosticText,
} from "../src/index";

/**
 * 代理诊断加工（脱敏 → 限长）的纯函数契约（tasks 3.1a）。
 *
 * 三条判据来自 llm-proxy delta「每个请求录制为一个 run」：
 * 1. **先脱敏后限长**（顺序反了会让密钥只剩前缀、无法按完整值替换）；
 * 2.覆盖**已知凭据**（本请求 / 最近捕获的 key 的字面量）与**通用凭据形式**
 *    （Authorization / Bearer / URL userinfo）；
 * 3. 摘要必须**非空**——抽不出时落受控兜底，绝不空串、绝不把完整响应体塞进 trace。
 */

describe("诊断上限常量", () => {
  it("为 1024（与 agent-loop 的 DIAGNOSTIC_MAX_LENGTH 等值，由 desktop 集成测试交叉锁定）", () => {
    expect(PROXY_DIAGNOSTIC_MAX_LENGTH).toBe(1024);
  });
});

describe("credentialLiteralsOf：从 Authorization 头取凭据字面量", () => {
  it("Bearer 头 ⇒ 同时给出整条头值与裸token", () => {
    const literals = credentialLiteralsOf("Bearer sk-abc123456789");
    expect(literals).toContain("Bearer sk-abc123456789");
    expect(literals).toContain("sk-abc123456789");
  });

  it("无 Bearer 前缀的非空头值 ⇒ 自身入列（长值）", () => {
    expect(credentialLiteralsOf("sk-abc123456789")).toEqual(["sk-abc123456789"]);
  });

  it("过短的裸值不入列（否则会命中正文里任意同字符片段，把诊断糊成占位）", () => {
    expect(credentialLiteralsOf("Bearer abc")).toEqual(["Bearer abc"]);
  });

  it("undefined / 空白 ⇒ 空列表（不是把空白当凭据）", () => {
    expect(credentialLiteralsOf(undefined)).toEqual([]);
    expect(credentialLiteralsOf("   ")).toEqual([]);
  });
});

describe("redactProxyDiagnosticText：已知 secret + 通用凭据形式", () => {
  it("已知 secret 字面量被整体替换", () => {
    const out = redactProxyDiagnosticText("bad key sk-live-9999999 here", ["sk-live-9999999"]);
    expect(out).toBe(`bad key ${REDACTION_PLACEHOLDER} here`);
  });

  it("Authorization 头形式：保留键名与 Bearer 前缀，只换值", () => {
    const out = redactProxyDiagnosticText("Authorization: Bearer sk-live-9999999", []);
    expect(out).toBe(`Authorization: Bearer ${REDACTION_PLACEHOLDER}`);
  });

  it("裸Bearer 形式（无头名）", () => {
    const out = redactProxyDiagnosticText("sent Bearer sk-live-9999999 upstream", []);
    expect(out).toBe(`sent Bearer ${REDACTION_PLACEHOLDER} upstream`);
  });

  it("URL 内嵌 userinfo：保留协议与 @", () => {
    const out = redactProxyDiagnosticText("connect https://user:pw@api.example.com/v1", []);
    expect(out).toBe(`connect https://${REDACTION_PLACEHOLDER}@api.example.com/v1`);
  });

  it("含正则元字符的 secret 也按字面量替换（split/join 而非正则）", () => {
    const secret = "sk+a.b*c(d)";
    const out = redactProxyDiagnosticText(`token=${secret} end`, [secret]);
    expect(out).toBe(`token=${REDACTION_PLACEHOLDER} end`);
  });
});

describe("limitProxyDiagnosticText：截断标记计入上限", () => {
  it("不超上限逐字节不变", () => {
    const text = "x".repeat(PROXY_DIAGNOSTIC_MAX_LENGTH);
    expect(limitProxyDiagnosticText(text)).toBe(text);
  });

  it("超上限 ⇒ 截到上限且以标记结尾（总长恰为上限）", () => {
    const out = limitProxyDiagnosticText("x".repeat(PROXY_DIAGNOSTIC_MAX_LENGTH + 500));
    expect(out.length).toBe(PROXY_DIAGNOSTIC_MAX_LENGTH);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("幂等：已截断的文本再调用不变", () => {
    const once = limitProxyDiagnosticText("x".repeat(PROXY_DIAGNOSTIC_MAX_LENGTH + 500));
    expect(limitProxyDiagnosticText(once)).toBe(once);
  });
});

describe("normalizeProxyFailureText：非空兜底", () => {
  it("Error ⇒message", () => {
    expect(normalizeProxyFailureText(new Error("boom"))).toBe("boom");
  });

  it("空串 / undefined / null / [object Object] ⇒ 固定兜底（非空）", () => {
    for (const input of ["", "   ", undefined, null, {}, { a: 1 }]) {
      const out = normalizeProxyFailureText(input);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toBe(GENERIC_PROXY_FAILURE);
    }
  });

  it("转换会抛的值（toString 抛异常）⇒ 兜底而非抛出", () => {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(normalizeProxyFailureText(hostile)).toBe(GENERIC_PROXY_FAILURE);
  });

  it("Symbol ⇒ String() 可转，非空即可（不为难它造兜底）", () => {
    const out = normalizeProxyFailureText(Symbol("s"));
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe(GENERIC_PROXY_FAILURE);
  });
});

describe("extractUpstreamErrorMessage：JSON / 非 JSON / 空体", () => {
  it("标准形状 error.message", () => {
    expect(extractUpstreamErrorMessage('{"error":{"message":"Invalid API key"}}')).toBe(
      "Invalid API key",
    );
  });

  it("error 为字符串", () => {
    expect(extractUpstreamErrorMessage('{"error":"quota exceeded"}')).toBe("quota exceeded");
  });

  it("顶层 message 字段", () => {
    expect(extractUpstreamErrorMessage('{"message":"rate limited"}')).toBe("rate limited");
  });

  it("非 JSON 文本 ⇒ 有限文本摘要（不是全文）", () => {
    const out = extractUpstreamErrorMessage("<html>502 Bad Gateway</html>");
    expect(out).toContain("502 Bad Gateway");
    expect(out?.length).toBeLessThanOrEqual(512);
  });

  it("空体 ⇒ null（由调用方落兜底，不编造）", () => {
    expect(extractUpstreamErrorMessage("")).toBeNull();
    expect(extractUpstreamErrorMessage("   \n ")).toBeNull();
  });

  it("JSON 但无可读文本（{} / 只有 code）⇒ null", () => {
    expect(extractUpstreamErrorMessage("{}")).toBeNull();
    expect(extractUpstreamErrorMessage('{"code":500}')).toBeNull();
  });

  it("JSON 数组 / 标量 ⇒ null（结构不对，不硬解）", () => {
    expect(extractUpstreamErrorMessage("[1,2,3]")).toBeNull();
    expect(extractUpstreamErrorMessage("42")).toBeNull();
  });
});

describe("sanitizeProxyDiagnosticText：组合入口 = 脱敏 → 限长", () => {
  it("🔴 顺序判据：先脱敏后限长，密钥不会只剩可识别前缀", () => {
    const secret = "sk-live-9999999";
    const visible = 8; // 残留前缀要长到能当"可识别片段"判罚
    // filler 长度让 secret 的**前 visible 个字符**恰好落在截断线内：
    // 正确实现（先脱敏）会把整段换成占位；反过来（先截断）会留下这8 个字符。
    const filler = "a".repeat(PROXY_DIAGNOSTIC_MAX_LENGTH - TRUNCATION_MARKER.length - visible - 1);
    const out = sanitizeProxyDiagnosticText(`${filler} ${secret} tail`, [secret]);
    expect(out).not.toContain(secret.slice(0, visible));
    expect(out.length).toBeLessThanOrEqual(PROXY_DIAGNOSTIC_MAX_LENGTH);
  });

  it("幂等：处理两次结果不变（允许包层 + main 写入兜底叠加）", () => {
    const once = sanitizeProxyDiagnosticText("Authorization: Bearer sk-live-9999999", []);
    expect(sanitizeProxyDiagnosticText(once)).toBe(once);
  });

  it("超长且含凭据 ⇒ 同时满足非空、不泄凭据、不超上限", () => {
    const out = sanitizeProxyDiagnosticText(`Bearer sk-live-9999999 ${"x".repeat(4000)}`, [
      "sk-live-9999999",
    ]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(PROXY_DIAGNOSTIC_MAX_LENGTH);
    expect(out).not.toContain("sk-live-9999999");
  });
});
