import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { getRunTool } from "../src/query/get-run.js";
import type { GetRunData } from "../src/query/get-run.js";
import { getStepTool } from "../src/query/get-step.js";
import type { GetStepData } from "../src/query/get-step.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  LONG_BODY,
  LONG_BODY_EMOJI_START,
  type QueryFixture,
  SENTINELS,
  buildQueryFixture,
  cleanupQueryFixtures,
  dirFingerprint,
} from "./query-fixtures.js";
import { assertNoSentinels, collectKeys } from "./whitelist-assertions.js";

/**
 * MCP0 4.4（S03 正文半边 + Q09/Q10）：`get_step` 的 section 索引、正文与归属消歧。
 *
 * 判据分组：
 * - **不给 section 就没有正文**：只回元数据 + 三段「录没录到」索引，并带 `BODY_NOT_EXPOSED`；
 * - **归属只认当前投影**：重名 ⇒ `SPAN_AMBIGUOUS` + owner 候选；截断祖先 ⇒ `STEP_NOT_FOUND`，
 *   显式 owner 也不能偷读（Q10 的两个形态）；
 * - **空串 / null / 未记录三者可分辨**：`error:null` 与 llm 无 error 都是未记录，
 *   录了空串就发空串，`result:null` 是录到了 null（`recorded:true`）而字段缺失不是；
 * - **规范 JSON + 码点范围**：键序稳定、切片不拆代理对；
 * - 元数据与 get_run 索引**同一份形状**（两处不漂）。
 */

let fx: QueryFixture;
let root: DataRoot;

beforeAll(() => {
  fx = buildQueryFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterAll(() => {
  cleanupQueryFixtures();
});

interface OkStep {
  readonly data: GetStepData;
  readonly envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
  readonly result: ToolResult;
}

async function okStep(
  runId: string,
  spanId: string,
  args: Record<string, unknown> = {},
): Promise<OkStep> {
  const result = await getStepTool.execute({ runId, spanId, ...args }, root);
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as GetStepData, envelope, result };
}

async function failureOf(
  runId: string,
  spanId: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; message: string; ref?: string; retryable: boolean }> {
  const result = await getStepTool.execute({ runId, spanId, ...args }, root);
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

function sectionFlags(data: GetStepData): Record<string, boolean> {
  return Object.fromEntries(data.sections.map((item) => [item.name, item.recorded]));
}

function bodyText(data: GetStepData): string {
  if (data.body === null || data.body.recorded === false) {
    throw new Error("本次结果没有正文");
  }
  return data.body.text;
}

/** 逐码点检查有没有孤立代理项（切坏半个字符的唯一直接证据） */
function hasLoneSurrogate(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

describe("get_step：不给 section 就只有索引（S03「先摘要后正文」）", () => {
  it("llm.call 的 input/output 标记为已录，error 未记录，且一个正文字段都不带", async () => {
    const { data, envelope } = await okStep(fx.ids.alpha, "s_02");
    expect(data.requestedSection).toBeNull();
    expect(data.body).toBeNull();
    expect(sectionFlags(data)).toEqual({ input: true, output: true, error: false });
    expect(data.span).toMatchObject({
      spanId: "s_02",
      spanKind: "llm.call",
      ownerRunId: fx.ids.alpha,
      own: true,
    });
    assertNoSentinels(JSON.stringify({ data, envelope }));
    expect(envelope.limitations.map((item) => item.code)).toContain("BODY_NOT_EXPOSED");
    expect(envelope.provenance.refs).toEqual([{ runId: fx.ids.alpha, spanId: "s_02" }]);
  });

  it("agent.step 是容器：三段全部未记录，不假装它有正文", async () => {
    const { data } = await okStep(fx.ids.alpha, "s_01");
    expect(sectionFlags(data)).toEqual({ input: false, output: false, error: false });
    expect(data.span).toMatchObject({ spanKind: "agent.step", iteration: 1 });
  });

  it("工具错误 null 是「未记录」，与运行出错是两件事", async () => {
    const { data } = await okStep(fx.ids.alpha, "s_03");
    expect(sectionFlags(data)).toEqual({ input: true, output: true, error: false });
    expect(data.span).toMatchObject({ spanKind: "tool.invoke", errorRecorded: false });
  });
});

describe("get_step：显式 section 才取正文", () => {
  it("section=input 给出请求正文（这是被显式要走的正文，canary 应当在场）", async () => {
    const { data } = await okStep(fx.ids.alpha, "s_02", { section: "input" });
    const text = bodyText(data);
    expect(text).toContain(SENTINELS.messageBody);
    expect(data.body?.recorded).toBe(true);
    if (data.body?.recorded !== true) return;
    expect(data.body.encoding).toBe("canonical-json");
    expect(data.body.truncated).toBe(false);
    expect(data.body.range.end - data.body.range.start).toBe([...text].length);
    expect(data.body.range.total).toBe([...text].length);
  });

  it("结构正文先规范 JSON：对象键按升序重排，续读才拼得回同一份原文", async () => {
    const { data } = await okStep(fx.ids.alpha, "s_03", { section: "input" });
    expect(bodyText(data)).toBe(
      `{"alpha":{"path":"a.txt"},"note":"${SENTINELS.toolArgs}","zeta":1}`,
    );
  });

  it("工具 result 录成 null 与字段缺失可分辨：前者 recorded:true 发 null，后者未记录", async () => {
    const recordedNull = await okStep(fx.ids.bodies, "s_03", { section: "output" });
    expect(recordedNull.data.body?.recorded).toBe(true);
    expect(bodyText(recordedNull.data)).toBe("null");

    const missing = await okStep(fx.ids.sparse, "s_03", { section: "output" });
    expect(missing.data.body).toEqual({ recorded: false });
    expect(sectionFlags(missing.data).output).toBe(false);
  });

  it("错误正文三态：录有内容 / 录成空串 / 未记录", async () => {
    const recorded = await okStep(fx.ids.bodies, "s_03", { section: "error" });
    expect(bodyText(recorded.data)).toBe(`"${SENTINELS.toolErrorBody}"`);

    const empty = await okStep(fx.ids.emptyError, "s_03", { section: "error" });
    expect(empty.data.body?.recorded).toBe(true);
    expect(bodyText(empty.data)).toBe('""');

    const none = await okStep(fx.ids.alpha, "s_03", { section: "error" });
    expect(none.data.body).toEqual({ recorded: false });
    expect(none.data.sections.find((item) => item.name === "error")?.recorded).toBe(false);
  });

  it("llm 失败详情带 HTTP 状态时如实给出，未记录时不编造", async () => {
    const { data } = await okStep(fx.ids.bodies, "s_02", { section: "error" });
    expect(JSON.parse(bodyText(data))).toEqual({
      message: SENTINELS.llmErrorBody,
      status: 503,
    });
    const absent = await okStep(fx.ids.alpha, "s_02", { section: "error" });
    expect(absent.data.body).toEqual({ recorded: false });
  });
});

describe("get_step：码点范围与代理对（design D6）", () => {
  it("默认 4096 码点截断长正文，且标注 remaining 与 truncated", async () => {
    const { data, envelope } = await okStep(fx.ids.bigBody, "s_03", { section: "output" });
    if (data.body?.recorded !== true) throw new Error("正文应当在场");
    const total = [...LONG_BODY].length + 2; // 规范 JSON 的两个引号
    expect(data.body.range).toEqual({
      start: 0,
      end: 4096,
      total,
      unit: "unicode-code-point",
    });
    expect(data.body.truncated).toBe(true);
    expect(data.body.remaining).toBe(total - 4096);
    expect(envelope.truncation).toEqual({ truncated: true });
    expect([...data.body.text].length).toBe(4096);
    expect(hasLoneSurrogate(data.body.text)).toBe(false);
  });

  it("切在代理对边界上也只按码点切：UTF-16 长度可比码点多，半个字符绝不发出去", async () => {
    const { data } = await okStep(fx.ids.bigBody, "s_03", {
      section: "output",
      // 规范 JSON 前置一个引号 ⇒ 上限取「代理对起始码点 + 2」正好把第一个 emoji 整个吃下
      maxChars: LONG_BODY_EMOJI_START + 2,
    });
    if (data.body?.recorded !== true) throw new Error("正文应当在场");
    expect(data.body.range.end).toBe(LONG_BODY_EMOJI_START + 2);
    expect([...data.body.text].length).toBe(LONG_BODY_EMOJI_START + 2);
    expect(data.body.text.length).toBeGreaterThan([...data.body.text].length);
    expect(hasLoneSurrogate(data.body.text)).toBe(false);
    expect(data.body.text).toContain("🙂");
  });

  it("maxChars 越界（>8192）与 cursor 续读都在读取前拒绝", async () => {
    expect((await failureOf(fx.ids.bigBody, "s_03", { maxChars: 8193 })).code).toBe(
      "INVALID_ARGUMENT",
    );
    const cursor = await failureOf(fx.ids.alpha, "s_02", {
      section: "input",
      cursor: "c-token",
    });
    expect(cursor.code).toBe("INVALID_ARGUMENT");
    expect(cursor.ref).toBe("cursor");
    expect(JSON.stringify(cursor)).not.toContain("c-token");
  });
});

describe("get_step：重名消歧与截断祖先（Q09/Q10）", () => {
  it("重名 span 不取首项，SPAN_AMBIGUOUS 给出 owner 候选", async () => {
    const error = await failureOf(fx.ids.ambiguousChild, "s_02");
    expect(error.code).toBe("SPAN_AMBIGUOUS");
    expect(error.retryable).toBe(false);
    expect(error.ref).toBe(`owners:${fx.ids.ambiguousParent},${fx.ids.ambiguousChild}`);
    expect(JSON.stringify(error)).not.toContain(fx.tracesDir);
  });

  it("指定合法 owner 后返回真实归属与对应事实", async () => {
    // 重名的 s_02 在子里是 agent.step（容器，三段都没有正文）：先证归属
    const owned = await okStep(fx.ids.ambiguousChild, "s_02", {
      ownerRunId: fx.ids.ambiguousChild,
    });
    expect(owned.data.span).toMatchObject({
      ownerRunId: fx.ids.ambiguousChild,
      own: true,
      ambiguousOwner: true,
      spanKind: "agent.step",
      iteration: 1,
    });
    expect(owned.data.body).toBeNull();
    expect(owned.data.sections.every((item) => !item.recorded)).toBe(true);

    // 同一条链上不重名的 s_03 才是子的 llm.call：正文按显式 owner 取回
    const body = await okStep(fx.ids.ambiguousChild, "s_03", {
      ownerRunId: fx.ids.ambiguousChild,
      section: "output",
    });
    expect(bodyText(body.data)).toContain(SENTINELS.responseContent);
  });

  it("把 owner 指向被投影重置掉的祖先同样拒绝（owner 不是通行证）", async () => {
    const error = await failureOf(fx.ids.ambiguousChild, "s_02", {
      ownerRunId: fx.ids.ambiguousParent,
    });
    expect(error.code).toBe("STEP_NOT_FOUND");
    expect(error.ref).toBe(`span:s_02@owner:${fx.ids.ambiguousParent}`);
  });

  it("被截断的祖先 span 不给 owner 也不可读", async () => {
    const error = await failureOf(fx.ids.cutChild, "s_03");
    expect(error.code).toBe("STEP_NOT_FOUND");
    expect(error.ref).toBe("span:s_03@owner:mcp0-cut-parent");
    const explicit = await failureOf(fx.ids.cutChild, "s_03", {
      ownerRunId: fx.ids.cutParent,
    });
    expect(explicit.code).toBe("STEP_NOT_FOUND");
  });

  it("继承项仍可读，并标出真实归属（own=false）", async () => {
    const { data } = await okStep(fx.ids.cutChild, "s_02", { section: "input" });
    expect(data.span).toMatchObject({ ownerRunId: fx.ids.cutParent, own: false });
    expect(bodyText(data)).toContain(SENTINELS.messageBody);
    expect(data.requestedSection).toBe("input");
  });

  it("投影里根本没有的 span 与非法标识各归其码，不回显取值", async () => {
    expect((await failureOf(fx.ids.alpha, "s_99")).code).toBe("STEP_NOT_FOUND");
    const badRun = await failureOf("../outside", "s_01");
    expect(badRun.code).toBe("INVALID_ARGUMENT");
    expect(badRun.ref).toBe("runId");
    expect(JSON.stringify(badRun)).not.toContain("outside");
    const badOwner = await failureOf(fx.ids.alpha, "s_01", { ownerRunId: "a/b" });
    expect(badOwner.ref).toBe("ownerRunId");
    expect((await failureOf(fx.ids.missing, "s_01")).code).toBe("RUN_NOT_FOUND");
  });
});

describe("get_step：与 get_run 同源、零写入", () => {
  it("span 元数据与 get_run 索引里的同一条逐项相同（一处形状）", async () => {
    const step = await okStep(fx.ids.cutChild, "s_02");
    const run = await getRunTool.execute({ runId: fx.ids.cutChild }, root);
    const envelope = SuccessEnvelopeSchema.parse(run.structuredContent);
    const data = envelope.data as GetRunData;
    const indexed = data.index.items.find((item) => item.kind === "span" && item.spanId === "s_02");
    expect(indexed).toEqual(step.data.span);
  });

  it("来源段带参与读取的全部物理 run，父链完整性只标在叶子上", async () => {
    const { envelope } = await okStep(fx.ids.cutChild, "s_02");
    expect(envelope.provenance.runs).toEqual([
      { runId: fx.ids.cutParent, formatVersion: 1, sealed: true },
      {
        runId: fx.ids.cutChild,
        formatVersion: 1,
        sealed: true,
        lineage: "complete",
        spanScope: "resolved",
      },
    ]);
  });

  it("多次正文读取后 traces 目录逐文件指纹不变", async () => {
    const before = dirFingerprint(fx.tracesDir);
    for (const [runId, spanId, section] of [
      [fx.ids.alpha, "s_02", "input"],
      [fx.ids.bigBody, "s_03", "output"],
      [fx.ids.bodies, "s_03", "error"],
      [fx.ids.cutChild, "s_02", "output"],
    ] as const) {
      await okStep(runId, spanId, { section });
    }
    expect(dirFingerprint(fx.tracesDir)).toBe(before);
  });

  it("结果里不出现宿主路径与未请求的字段（键名递归核对）", async () => {
    const { data, envelope } = await okStep(fx.ids.bodies, "s_03", { section: "output" });
    const serialized = JSON.stringify({ data, envelope });
    expect(serialized).not.toContain(fx.tracesDir);
    expect(serialized).not.toContain(fx.dataDir);
    const keys = collectKeys({ data, envelope });
    for (const forbidden of ["dataDir", "tracesDir", "path", "sha256", "file"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(keys.has("text")).toBe(true);
  });
});
