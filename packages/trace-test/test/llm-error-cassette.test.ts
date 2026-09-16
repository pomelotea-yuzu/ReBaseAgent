import { LlmRequestError } from "@rebaseagent/agent-loop";
import type { LlmCallSpan, SpanLine } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { CassetteLlmClient } from "../src/cassette-llm-client.js";
import { TraceTestConfigError } from "../src/errors.js";
import { rerunWithCassette } from "../src/rerun.js";
import { fakeConfig, fakeTools, initialMessages, recordOfSpans, stepSpan } from "./helpers.js";

const MESSAGES = [
  { role: "system", content: "你是文件助手。" },
  { role: "user", content: "读一下 a.json" },
];

/** 录制到失败的调用：response 是空占位，失败原因在顶层 error */
function failedLlmSpan(
  id: string,
  error: { message: string; status?: number },
  parent = "s_01",
): LlmCallSpan {
  return {
    type: "span",
    id,
    kind: "llm.call",
    parent,
    request: { model: "deepseek-chat", messages: MESSAGES.map((m) => ({ ...m })) },
    response: {
      content: null,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 0, out: 0 },
      ttft_ms: 0,
    },
    error,
  };
}

function okLlmSpan(id: string, content: string, parent = "s_01"): LlmCallSpan {
  return {
    type: "span",
    id,
    kind: "llm.call",
    parent,
    request: { model: "deepseek-chat", messages: MESSAGES.map((m) => ({ ...m })) },
    response: {
      content,
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 10, out: 5 },
      ttft_ms: 1,
    },
  };
}

describe("CassetteLlmClient：重现录制的失败调用", () => {
  it("带 status 的录制失败 → 抛 LlmRequestError，message 与 status 一并保留", async () => {
    const client = new CassetteLlmClient(
      [failedLlmSpan("s_02", { message: "LLM 端点返回 HTTP 500：boom", status: 500 })],
      fakeConfig(),
    );

    const err = await client.complete(initialMessages("t1"), null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).message).toBe("LLM 端点返回 HTTP 500：boom");
    expect((err as LlmRequestError).status).toBe(500);
    // 恰好消费一次；不置 exhausted（那不是耗尽，是录制里的真实失败）
    expect(client.consumed).toBe(1);
    expect(client.remaining).toBe(0);
    expect(client.exhausted).toBe(false);
  });

  it("缺失 status 不补造任何默认值", async () => {
    const client = new CassetteLlmClient(
      [failedLlmSpan("s_02", { message: "SSE 流中断：read ECONNRESET" })],
      fakeConfig(),
    );

    const err = await client.complete(initialMessages("t1"), null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRequestError);
    expect((err as LlmRequestError).status).toBeUndefined();
  });

  it("失败后游标不回退：下一条调用照常消费，且不重复消费失败条", async () => {
    const client = new CassetteLlmClient(
      [
        failedLlmSpan("s_02", { message: "LLM 端点返回 HTTP 429：rate limited", status: 429 }),
        okLlmSpan("s_03", "第二轮的正文"),
      ],
      fakeConfig(),
    );

    await client.complete(initialMessages("t1"), null).catch(() => undefined);
    expect(client.consumed).toBe(1);

    const second = await client.complete(initialMessages("t2"), null);
    expect(second.response.content).toBe("第二轮的正文");
    expect(client.consumed).toBe(2);
    expect(client.remaining).toBe(0);
  });
});

describe("rerunWithCassette：录制失败重现为 error outcome", () => {
  /** 录制：第 1 轮 LLM 调用就失败（无工具、无后续 span） */
  const failedRecord = (spans: SpanLine[]) =>
    recordOfSpans(spans, { type: "run.event", event: "errored", reason: "error", at: 1 });

  it("重跑得到 error outcome，新 span 保留 message 与已录制的 status", async () => {
    const record = failedRecord([
      stepSpan("s_01", 1),
      failedLlmSpan("s_02", { message: "LLM 端点返回 HTTP 500：boom", status: 500 }),
    ]);

    const result = await rerunWithCassette({
      record,
      config: fakeConfig(),
      tools: fakeTools(),
    });

    expect(result.run.event).toEqual({ event: "errored", reason: "error", at: 1 });
    const newLlm = result.record.spans.find((s) => s.kind === "llm.call");
    expect(newLlm?.kind === "llm.call" ? newLlm.error : undefined).toEqual({
      message: "LLM 端点返回 HTTP 500：boom",
      status: 500,
    });
    // 失败不被当成"成功的空回答"：没有 assistant 消息追加
    expect(result.run.messages).toHaveLength(2);
  });

  it("录制缺失 status → 新 span 也不写该键", async () => {
    const record = failedRecord([
      stepSpan("s_01", 1),
      failedLlmSpan("s_02", { message: "SSE 流中断：read ECONNRESET" }),
    ]);

    const result = await rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() });
    const newLlm = result.record.spans.find((s) => s.kind === "llm.call");
    const error = newLlm?.kind === "llm.call" ? newLlm.error : undefined;
    expect(error?.message).toBe("SSE 流中断：read ECONNRESET");
    expect(error !== undefined && "status" in error).toBe(false);
  });

  it("录制失败后仍有未消费调用 → 仍按既有规则判为配置错误", async () => {
    const record = failedRecord([
      stepSpan("s_01", 1),
      failedLlmSpan("s_02", { message: "LLM 端点返回 HTTP 500：boom", status: 500 }),
      okLlmSpan("s_03", "录制里本不会到达的第二轮"),
    ]);

    await expect(
      rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() }),
    ).rejects.toBeInstanceOf(TraceTestConfigError);
  });

  it("既有成功卡带不回归：无 error 字段的录制照旧对齐", async () => {
    const record = recordOfSpans([stepSpan("s_01", 1), okLlmSpan("s_02", "完成")], {
      type: "run.event",
      event: "stopped",
      reason: "completed",
      at: 1,
    });
    const result = await rerunWithCassette({ record, config: fakeConfig(), tools: fakeTools() });
    expect(result.run.event.reason).toBe("completed");
    expect(result.alignment.aligned).toBe(true);
  });
});
