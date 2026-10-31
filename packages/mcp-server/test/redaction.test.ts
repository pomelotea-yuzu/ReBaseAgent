import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SuccessEnvelopeSchema } from "../src/envelope.js";
import type { GetStepData } from "../src/query/get-step.js";
import { getStepTool } from "../src/query/get-step.js";
import { REDACTED_MARKER, redactStructuredValue } from "../src/query/redaction.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import { contentBodyTexts } from "./content-bodies.js";
import {
  EXPOSURE_SENTINELS,
  type ExposureFixture,
  buildExposureFixture,
  cleanupExposureFixtures,
} from "./exposure-fixtures.js";
import { ZH } from "./test-locale.js";

/**
 * MCP0 4.8（S11）：结构正文的已知凭据过滤。
 *
 * 判据分两层：
 * - **纯函数**：归一后的字段名命中封闭清单才替换；URL userinfo 只换凭据；自由文本、
 *   JSON 字符串与普通值原样保留；不修改入参。
 * - **协议面**：`get_step(section=...)` 的正文里凭据 canary 一个不剩、非凭据键不被误伤，
 *   并带一条 `REDACTED` limitation（ref 指向 span + section）；范围/总码点按**过滤后**
 *   文本计算（design D6），原文件/原文哈希不冒充片段校验值。
 */

let fx: ExposureFixture;
let root: DataRoot;

beforeAll(() => {
  fx = buildExposureFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterAll(() => {
  cleanupExposureFixtures();
});

async function bodyOf(
  spanId: string,
  section: "input" | "output" | "error",
  extra: Record<string, unknown> = {},
): Promise<{ data: GetStepData; limitations: string[]; envelope: unknown; result: ToolResult }> {
  const result = await getStepTool.execute(
    { runId: fx.runId, spanId, section, ...extra },
    root,
    ZH,
  );
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return {
    data: envelope.data as GetStepData,
    limitations: envelope.limitations.map((item) => item.code),
    envelope,
    result,
  };
}

/** 6.2 改判：正文本体只在 content 投影（data 内对应位是 bodyIn 指针） */
function textOf(data: GetStepData, result: ToolResult): string {
  if (data.body === null || data.body.recorded === false) throw new Error("本次结果没有正文");
  return contentBodyTexts(result)[0] ?? "";
}

function parsedBody(data: GetStepData, result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(data, result)) as Record<string, unknown>;
}

const CREDENTIAL_SENTINELS = [
  EXPOSURE_SENTINELS.authHeader,
  EXPOSURE_SENTINELS.xApiKey,
  EXPOSURE_SENTINELS.messageApiKey,
  EXPOSURE_SENTINELS.paramsApiKey,
  EXPOSURE_SENTINELS.paramsAccessToken,
  EXPOSURE_SENTINELS.endpointUserinfo,
  EXPOSURE_SENTINELS.password,
  EXPOSURE_SENTINELS.resultAccessToken,
];

function leakedCredentials(serialized: string): string[] {
  return CREDENTIAL_SENTINELS.filter((needle) => serialized.includes(needle));
}

describe("redactStructuredValue：字段名归一与封闭清单", () => {
  it("Authorization / api-key / token 的常见写法都命中，值整段替换", () => {
    for (const key of [
      "Authorization",
      "api_key",
      "api-key",
      "apiKey",
      "APIKEY",
      "x-api-key",
      "access_token",
      "refreshToken",
      "id_token",
      "password",
      "client_secret",
      "token",
      "private_key",
    ]) {
      const result = redactStructuredValue({ [key]: "secret-value", keep: "visible" });
      expect(result.redactedFields).toBe(1);
      expect(result.value).toEqual({ [key]: REDACTED_MARKER, keep: "visible" });
    }
  });

  it("非凭据字段不被误伤：token 计数、作者、普通键都原样保留", () => {
    const input = {
      max_tokens: 16,
      tokens: 42,
      token_count: 3,
      author: "SENTINEL-author",
      key: "not-a-credential",
      monkey: "banana",
    };
    const result = redactStructuredValue(input);
    expect(result.redactedFields).toBe(0);
    expect(result.value).toBe(input);
  });

  it("嵌套对象与数组逐层处理，凭据字段整值替换（对象也不保留内部结构）", () => {
    const input = {
      headers: { Authorization: "Bearer x", Accept: "application/json" },
      list: [{ api_key: "a" }, { note: "visible" }],
      nested: { credentials: { user: "u", password: "p" } },
    };
    const result = redactStructuredValue(input);
    expect(result.redactedFields).toBe(3);
    expect(result.value).toEqual({
      headers: { Authorization: REDACTED_MARKER, Accept: "application/json" },
      list: [{ api_key: REDACTED_MARKER }, { note: "visible" }],
      nested: { credentials: REDACTED_MARKER },
    });
  });

  it("不修改入参：过滤后的对象是浅层重建，原对象仍保留原文", () => {
    const input = { api_key: "secret", note: "visible" };
    const before = JSON.stringify(input);
    redactStructuredValue(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("绝对 URL 只替换 userinfo，保留端点 host/path；非 URL 文本不动", () => {
    const result = redactStructuredValue({
      endpoint: "https://user:pass@example.test/v1/chat",
      plain: "https://example.test/v1/chat",
      text: "端点见 https://user:pass@example.test/v1",
      note: "not a url",
    });
    expect(result.redactedFields).toBe(1);
    expect(result.value).toEqual({
      endpoint: `https://${REDACTED_MARKER}@example.test/v1/chat`,
      plain: "https://example.test/v1/chat",
      text: "端点见 https://user:pass@example.test/v1",
      note: "not a url",
    });
  });

  it("`__proto__` 作为普通键时不会污染原型", () => {
    const input = JSON.parse('{"__proto__":{"api_key":"secret"},"ok":1}') as Record<
      string,
      unknown
    >;
    const result = redactStructuredValue(input);
    expect(({} as Record<string, unknown>).api_key).toBeUndefined();
    expect(result.redactedFields).toBe(1);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
  });

  it("自由文本里的 Authorization 与 JSON 字符串里的字段都不解析（D7 边界）", () => {
    const result = redactStructuredValue({
      content: `Authorization: Bearer ${EXPOSURE_SENTINELS.freeTextCredential}`,
      arguments: JSON.stringify({ api_key: EXPOSURE_SENTINELS.jsonStringCredential }),
    });
    expect(result.redactedFields).toBe(0);
    expect(JSON.stringify(result.value)).toContain(EXPOSURE_SENTINELS.freeTextCredential);
    expect(JSON.stringify(result.value)).toContain(EXPOSURE_SENTINELS.jsonStringCredential);
  });
});

describe("get_step：请求正文的凭据过滤（S11）", () => {
  it("消息附加字段、params 与嵌套对象逐项替换，非凭据键保持原值", async () => {
    const { data, limitations, result } = await bodyOf(fx.llmSpanId, "input");
    const parsed = parsedBody(data, result) as {
      messages: Array<Record<string, unknown>>;
      params: Record<string, unknown>;
      model: string;
    };
    expect(parsed.messages[1]?.api_key).toBe(REDACTED_MARKER);
    expect(parsed.params.api_key).toBe(REDACTED_MARKER);
    expect((parsed.params.nested as Record<string, unknown>).access_token).toBe(REDACTED_MARKER);
    expect(parsed.params.max_tokens).toBe(16);
    expect(parsed.messages[0]?.content).toBe(EXPOSURE_SENTINELS.injection);
    expect(parsed.messages[1]?.content).toBe(EXPOSURE_SENTINELS.visibleMessage);
    expect(limitations).toContain("REDACTED");
    expect(leakedCredentials(textOf(data, result))).toEqual([]);
    expect(textOf(data, result)).toContain(`"api_key":"${REDACTED_MARKER}"`);
  });

  it("REDACTED 限制项带 span/section 定位，并写明自由文本边界", async () => {
    const { envelope } = await bodyOf(fx.llmSpanId, "input");
    const typed = SuccessEnvelopeSchema.parse(envelope);
    const limitation = typed.limitations.find((item) => item.code === "REDACTED");
    if (limitation === undefined) throw new Error("缺少 REDACTED 限制项");
    expect(limitation.ref).toBe(`span:${fx.runId}:${fx.llmSpanId}/section:input`);
    expect(limitation.message).toContain("3");
    expect(limitation.message).toContain("自由文本");
    expect(limitation.message).toContain("检查点文件");
  });

  it("范围与总码点描述过滤后的外发文本，不冒充原文校验值", async () => {
    const { data, result } = await bodyOf(fx.llmSpanId, "input");
    if (data.body?.recorded !== true) throw new Error("正文应当在场");
    const chars = [...textOf(data, result)];
    expect(data.body.range).toEqual({
      start: 0,
      end: chars.length,
      total: chars.length,
      unit: "unicode-code-point",
    });
    expect(data.body.truncated).toBe(false);
    const keys = JSON.stringify(data);
    expect(keys).not.toContain("sha256");
    expect(keys).not.toContain("fullFile");
  });
});

describe("get_step：工具 args/result 的凭据过滤", () => {
  it("Authorization / X-Api-Key / password / 端点 userinfo 全部替换，普通参数保留", async () => {
    const { data, limitations, result } = await bodyOf(fx.toolSpanId, "input");
    const parsed = parsedBody(data, result) as {
      headers: Record<string, string>;
      endpoint: string;
      nested: Array<Record<string, string>>;
      note: string;
      max_tokens: number;
    };
    expect(parsed.headers.Authorization).toBe(REDACTED_MARKER);
    expect(parsed.headers["X-Api-Key"]).toBe(REDACTED_MARKER);
    expect(parsed.endpoint).toBe(`https://${REDACTED_MARKER}@example.test/v1`);
    expect(parsed.nested[0]?.password).toBe(REDACTED_MARKER);
    expect(parsed.note).toBe(EXPOSURE_SENTINELS.visibleArgs);
    expect(parsed.max_tokens).toBe(32);
    expect(limitations).toContain("REDACTED");
    expect(leakedCredentials(textOf(data, result))).toEqual([]);
  });

  it("工具 result 的 access_token 被替换，同对象的可见字段不受影响", async () => {
    const { data, limitations, result } = await bodyOf(fx.toolSpanId, "output");
    const parsed = parsedBody(data, result) as Record<string, unknown>;
    expect(parsed.access_token).toBe(REDACTED_MARKER);
    expect(parsed.note).toBe(EXPOSURE_SENTINELS.visibleResult);
    expect(parsed.max_tokens).toBe(64);
    expect(limitations).toContain("REDACTED");
    expect(leakedCredentials(textOf(data, result))).toEqual([]);
  });

  it("自由文本与 JSON 字符串不解析：回复正文与 function.arguments 原样保留", async () => {
    const { data, limitations, result } = await bodyOf(fx.llmSpanId, "output");
    const text = textOf(data, result);
    expect(text).toContain(EXPOSURE_SENTINELS.freeTextCredential);
    expect(text).toContain(EXPOSURE_SENTINELS.jsonStringCredential);
    expect(limitations).not.toContain("REDACTED");
  });

  it("不给 section 就不取正文，也不会凭空发 REDACTED；错误段未记录仍然可分辨", async () => {
    const noSection = await getStepTool.execute(
      { runId: fx.runId, spanId: fx.llmSpanId },
      root,
      ZH,
    );
    expect(noSection.isError).not.toBe(true);
    const envelope = SuccessEnvelopeSchema.parse(noSection.structuredContent);
    expect(envelope.limitations.map((item) => item.code)).not.toContain("REDACTED");

    const missingError = await bodyOf(fx.toolSpanId, "error");
    expect(missingError.data.body).toEqual({ recorded: false });
    expect(missingError.limitations).not.toContain("REDACTED");
  });
});
