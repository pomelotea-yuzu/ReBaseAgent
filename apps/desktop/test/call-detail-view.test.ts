import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SpanLine } from "@rebaseagent/trace-sdk";
import { buildSpanTree } from "@shared/derive";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// DetailPanel / LongText 的 store 薄壳在 import 时就会触到 `window.api` ⇒ 桩必须先就位；
// ESM 静态 import 会被提升，故用动态 import（同 overview-consumption-source.test.ts）。
(globalThis as Record<string, unknown>).window = { api: {} };

const {
  LLM_CALL_FIELDS,
  TOOL_INVOKE_FIELDS,
  STEP_FIELDS,
  OPTIONAL_LLM_FIELDS,
  IO_SECTIONS,
  defaultIoView,
  resolveIoView,
  optionalSectionVisible,
  ioCoversAllFields,
  presentStepDetail,
  findInText,
  stepFind,
  splitByMatches,
  messageContentText,
} = await import("../src/renderer/src/lib/call-detail-view");
const { LlmCallDetailView, ToolInvokeDetailView, StepDetailView } = await import(
  "../src/renderer/src/components/DetailPanel"
);
const { LongText, copyFeedbackText, findCountLabel, copyPayload } = await import(
  "../src/renderer/src/components/LongText"
);

/**
 * U1（refactor-run-workspace）任务 5.5：整理调用详情的输入/输出、原始字段与就近查找/复制。
 *
 * 判据来源：desktop-ui delta「详情面板完整展示一步的原始请求与响应」——
 *   - 一句话要求（spec.md :105/:107）：llm.call 逐字段展示、tool.invoke 逐字段展示、
 *     step 展示"已记录调用/错误/派生消耗"；长文本可查找/展开/复制（复制原文）；
 *     **args/result 在同一详情中便于核对**。
 *   - 场景「推理模型的思维链」：思维链以区别于正文的样式单独分区，两者内容均完整。
 *   - 场景「工具调用详情」：工具名/入参/结果/耗时；`error` 非空显式呈现。
 *   - 场景「长请求和原始字段完整可读」：输入输出切换不丢字段，step 摘要仍可进入每个原始调用。
 *
 * ⚠️ 本包无 jsdom，且 zustand v5 在 `renderToStaticMarkup` 下走 `getServerSnapshot`
 *    （恒初始值）⇒ 分两层：① 纯判据（字段清单 / io 切换 / findInText / presentStepDetail）
 *    直喂；② 三个纯展示组件 + `LongText` 用 `renderToStaticMarkup` 做静态结构断言。
 *    真实点击后的 store 写入与滚动归 7.x 的 Electron/CDP。
 */

// ---------------------------------------------------------------------------
// 造数据
// ---------------------------------------------------------------------------

/** 造一个 llm.call */
function llm(
  id: string,
  parent: string,
  extra: Partial<{
    tools: Array<Record<string, unknown>>;
    params: Record<string, unknown>;
    content: string | null;
    reasoning: string | null;
    toolCalls: Array<Record<string, unknown>>;
    error: { message: string; status?: number };
    in: number;
    out: number;
    ttft: number;
    timing: { started_at: string; ended_at: string };
  }> = {},
): SpanLine {
  const request: Record<string, unknown> = {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
  };
  if (extra.tools !== undefined) request.tools = extra.tools;
  if (extra.params !== undefined) request.params = extra.params;

  const span: Record<string, unknown> = {
    type: "span",
    kind: "llm.call",
    id,
    parent,
    request,
    response: {
      content: extra.content === undefined ? "ok" : extra.content,
      reasoning_content: extra.reasoning ?? null,
      tool_calls: extra.toolCalls ?? [],
      usage: { in: extra.in ?? 10, out: extra.out ?? 5 },
      ttft_ms: extra.ttft ?? 42,
    },
  };
  if (extra.error !== undefined) span.error = extra.error;
  if (extra.timing !== undefined) span.timing = extra.timing;
  return span as SpanLine;
}

/** 造一个 tool.invoke */
function tool(
  id: string,
  parent: string,
  extra: Partial<{
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
    error: string | null;
    durMs: number;
    timing: { started_at: string; ended_at: string };
  }> = {},
): SpanLine {
  const span: Record<string, unknown> = {
    type: "span",
    kind: "tool.invoke",
    id,
    parent,
    tool: extra.tool ?? "read_file",
    args: extra.args ?? { path: "a.txt" },
    result: extra.result ?? "content",
    dur_ms: extra.durMs ?? 12,
    error: extra.error ?? null,
  };
  if (extra.timing !== undefined) span.timing = extra.timing;
  return span as SpanLine;
}

function step(id: string, n: number, extra: Partial<{ timing: object }> = {}): SpanLine {
  return {
    type: "span",
    kind: "agent.step",
    id,
    parent: null,
    n,
    ...(extra.timing === undefined ? {} : { timing: extra.timing }),
  } as SpanLine;
}

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

/** 恒真的 noop 回调（渲染层不关心它做什么） */
const noop = (): void => undefined;

// ---------------------------------------------------------------------------
// 字段清单：spec 逐字段点名，一条都不能少
// ---------------------------------------------------------------------------

describe("字段清单契约", () => {
  it("LLM_CALL_FIELDS 逐条覆盖 spec 点名的字段（加一处即须加此处）", () => {
    // spec.md :105/:107 逐字点名的 llm.call 字段
    for (const field of [
      "request.messages",
      "request.tools",
      "request.params",
      "response.content",
      "response.reasoning_content",
      "response.tool_calls",
      "response.usage.in",
      "response.usage.out",
      "response.ttft_ms",
      "duration",
    ]) {
      expect(LLM_CALL_FIELDS).toContain(field);
    }
  });

  it("TOOL_INVOKE_FIELDS 逐条覆盖 spec 点名的字段", () => {
    for (const field of ["tool", "args", "result", "error", "dur_ms", "duration"]) {
      expect(TOOL_INVOKE_FIELDS).toContain(field);
    }
  });

  it("STEP_FIELDS = 已记录调用 / 错误 / 派生消耗 三块", () => {
    expect([...STEP_FIELDS]).toEqual(["calls", "errors", "consumption"]);
  });

  it("ioCoversAllFields 为空 ⇒ 输入输出两半合起来不漏任何原始字段（除恒显 duration）", () => {
    // 这条是"切换不丢字段"的可执行判据：并集必须等于全部字段去掉 duration
    expect(ioCoversAllFields()).toEqual([]);
  });

  it("IO_SECTIONS 的两半互斥且都在 LLM_CALL_FIELDS 里（防手滑写错字段名）", () => {
    const input = new Set(IO_SECTIONS.input);
    for (const section of IO_SECTIONS.output) {
      expect(input.has(section)).toBe(false);
      expect([...LLM_CALL_FIELDS]).toContain(section);
    }
    for (const section of IO_SECTIONS.input) {
      expect([...LLM_CALL_FIELDS]).toContain(section);
    }
  });
});

// ---------------------------------------------------------------------------
// 输入 / 输出切换判据
// ---------------------------------------------------------------------------

describe("resolveIoView：切换是阅读位置，不是数据搬动", () => {
  it("没切过 + 成功调用 ⇒ 默认输入（请求内容最能解释这次做了什么）", () => {
    expect(defaultIoView(llm("a", "s"))).toBe("input");
    expect(resolveIoView(llm("a", "s"), undefined)).toBe("input");
  });

  it("没切过 + 失败调用 ⇒ 默认输出（失败原因在输出侧）", () => {
    const failed = llm("a", "s", { error: { message: "boom" } });
    expect(defaultIoView(failed)).toBe("output");
    expect(resolveIoView(failed, undefined)).toBe("output");
  });

  it("切过 ⇒ 以记忆为准（成功调用也可停在输出，失败调用也可回输入）", () => {
    expect(resolveIoView(llm("a", "s"), "output")).toBe("output");
    expect(resolveIoView(llm("a", "s", { error: { message: "x" } }), "input")).toBe("input");
  });
});

describe("optionalSectionVisible：可选栏目按「记录里有没有」决定，不当成漏渲染", () => {
  it("无 request.tools ⇒ tools 栏目不渲染", () => {
    const span = llm("a", "s") as Extract<SpanLine, { kind: "llm.call" }>;
    expect(optionalSectionVisible(span, "request.tools")).toBe(false);
  });

  it("有 request.tools（哪怕空数组）⇒ tools 栏目渲染", () => {
    const span = llm("a", "s", { tools: [] }) as Extract<SpanLine, { kind: "llm.call" }>;
    expect(optionalSectionVisible(span, "request.tools")).toBe(true);
  });

  it("有 request.params ⇒ params 栏目渲染", () => {
    const span = llm("a", "s", { params: { temperature: 0 } }) as Extract<
      SpanLine,
      { kind: "llm.call" }
    >;
    expect(optionalSectionVisible(span, "request.params")).toBe(true);
  });

  it("OPTIONAL_LLM_FIELDS 恰为两个可选字段（与界面判据同源）", () => {
    expect([...OPTIONAL_LLM_FIELDS]).toEqual(["request.tools", "request.params"]);
  });
});

// ---------------------------------------------------------------------------
// findInText / splitByMatches：在完整原文上查找
// ---------------------------------------------------------------------------

describe("findInText：大小写不敏感、空查询无命中、不重叠、可回绕", () => {
  it("找得到所有出现，按位置升序", () => {
    const result = findInText("abcABCabc", "abc");
    expect(result.matches).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 },
    ]);
  });

  it("大小写不敏感（原文大小写不影响命中）", () => {
    expect(findInText("HELLO", "hello").matches).toEqual([{ start: 0, end: 5 }]);
  });

  it("空查询 ⇒ 无命中（不把空串当成命中全部位置；且不得空转挂死）", () => {
    const result = findInText("abc", "");
    expect(result.matches).toEqual([]);
    expect(result.index).toBe(-1);
    // 长文本同样：空查询必须**立即**返回（去守卫会因 indexOf('',n)=n 且步进 0 而空转）
    expect(findInText("x".repeat(5000), "").matches).toEqual([]);
  });

  it("无命中 ⇒ index 为 -1", () => {
    expect(findInText("abc", "zzz").index).toBe(-1);
  });

  it("不重叠推进（aaaa 里找 aa ⇒ 2 个，不是 3 个）", () => {
    const result = findInText("aaaa", "aa");
    expect(result.matches).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("from 越界自动回绕到区间内（不返回越界 index）", () => {
    const text = "x x x";
    expect(findInText(text, "x", 2).index).toBe(2);
    expect(findInText(text, "x", 3).index).toBe(0);
    expect(findInText(text, "x", -1).index).toBe(2);
  });

  it("stepFind 下一个：依次前进并回绕（0→1→2→0）", () => {
    const text = "x x x";
    let result = findInText(text, "x", 0);
    result = stepFind(result, 1);
    expect(result.index).toBe(1);
    result = stepFind(result, 1);
    expect(result.index).toBe(2);
    result = stepFind(result, 1);
    expect(result.index).toBe(0);
  });

  it("stepFind 上一个：从 0 往回绕到最后一个", () => {
    expect(stepFind(findInText("x x x", "x", 0), -1).index).toBe(2);
  });

  it("stepFind 无命中（空 matches）⇒ 原样返回（没有命中就没有'下一个'）", () => {
    const none = findInText("abc", "zzz");
    expect(none.matches).toEqual([]);
    expect(stepFind(none, 1).index).toBe(-1);
    expect(stepFind(none, -1).index).toBe(-1);
  });
});

describe("splitByMatches：切片可拼回原文，且命中段标 hit", () => {
  it("无命中 ⇒ 整段非命中", () => {
    expect(splitByMatches("abc", findInText("abc", "z"))).toEqual([{ text: "abc", hit: false }]);
  });

  it("命中切片拼回来等于原文（不丢字、不多字）", () => {
    const text = "hello world hello";
    const result = findInText(text, "hello");
    const parts = splitByMatches(text, result);
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });

  it("命中段落标记 hit=true，恰为命中个数", () => {
    const result = findInText("aXbXc", "X");
    const parts = splitByMatches("aXbXc", result);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["X", "X"]);
  });
});

// ---------------------------------------------------------------------------
// presentStepDetail：已记录调用、错误与派生消耗
// ---------------------------------------------------------------------------

describe("presentStepDetail：三块都要在，消耗取既有口径", () => {
  const spans: SpanLine[] = [
    step("s1", 2),
    llm("l1", "s1", {
      in: 100,
      out: 20,
      timing: { started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z" },
    }),
    tool("t1", "s1", {
      timing: { started_at: "2026-01-01T00:00:01Z", ended_at: "2026-01-01T00:00:02Z" },
    }),
  ];

  const node = buildSpanTree(spans).find((n) => n.span.id === "s1");

  it("迭代序号取 step 自身 n（不从数组下标推）", () => {
    expect(presentStepDetail(node as never).iteration).toBe(2);
  });

  it("列出直接子调用（llm 用模型名、tool 用工具名），顺序与轨迹一致", () => {
    const view = presentStepDetail(node as never);
    expect(view.calls.map((c) => c.kind)).toEqual(["llm.call", "tool.invoke"]);
    expect(view.calls[0].label).toBe("test-model");
    expect(view.calls[1].label).toBe("read_file");
  });

  it("错误计数：llm.error !== undefined 与 tool.error !== null 各自判定", () => {
    const withErrors = buildSpanTree([
      step("s2", 1),
      llm("l2", "s2", { error: { message: "llm boom" } }),
      tool("t2", "s2", { error: "tool boom" }),
    ]).find((n) => n.span.id === "s2");
    const view = presentStepDetail(withErrors as never);
    expect(view.errorCount).toBe(2);
    expect(view.calls.every((c) => c.errored)).toBe(true);
  });

  it("tool.error === null（成功）不算错误；llm 无 error 字段也不算", () => {
    const ok = buildSpanTree([step("s3", 1), llm("l3", "s3"), tool("t3", "s3")]).find(
      (n) => n.span.id === "s3",
    );
    expect(presentStepDetail(ok as never).errorCount).toBe(0);
  });

  it("消耗来自 deriveStepStats（与树同一口径），token 与工具数逐字段一致", () => {
    const view = presentStepDetail(node as never);
    expect(view.tokensIn).toBe(100);
    expect(view.tokensOut).toBe(20);
    expect(view.toolCalls).toBe(1);
  });

  it("子树无 timing ⇒ durationMs 为 null（未知不伪装成 0）", () => {
    const noTiming = buildSpanTree([step("s4", 1), llm("l4", "s4")]).find(
      (n) => n.span.id === "s4",
    );
    expect(presentStepDetail(noTiming as never).durationMs).toBeNull();
  });

  it("空 step ⇒ 空的 calls 与零消耗（不抛、不留半成品）", () => {
    const empty = buildSpanTree([step("s5", 1)]).find((n) => n.span.id === "s5");
    const view = presentStepDetail(empty as never);
    expect(view.calls).toEqual([]);
    expect(view.errorCount).toBe(0);
    expect(view.toolCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LlmCallDetailView 静态渲染：思维链与正文分区、输入输出切换、字段完整
// ---------------------------------------------------------------------------

describe("LlmCallDetailView：场景「推理模型的思维链」与字段完整", () => {
  const longTextProps = () => ({ expanded: false, onToggle: noop });

  it("reasoning_content 存在 ⇒ 思维链单独分区，与响应正文是两个 Section", () => {
    const span = llm("l1", "s1", {
      reasoning: "让我想想……",
      content: "答案",
    }) as Extract<SpanLine, { kind: "llm.call" }>;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "output",
        onIo: noop,
        emptyContentHint: "",
        longTextProps,
      }),
    );
    expect(markup).toContain("思维链（reasoning_content）");
    expect(markup).toContain("响应正文");
    // 思维链有区别于正文的样式（琥珀底）
    expect(markup).toContain("bg-amber-50");
    expect(markup).toContain("让我想想……");
    expect(markup).toContain("答案");
  });

  it("reasoning_content 为 null ⇒ 不渲染思维链分区（有/无分得开）", () => {
    const span = llm("l1", "s1", { reasoning: null }) as Extract<SpanLine, { kind: "llm.call" }>;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "output",
        onIo: noop,
        emptyContentHint: "",
        longTextProps,
      }),
    );
    expect(markup).not.toContain("思维链");
  });

  it("输入/输出切换条恒在，且当前半 aria-pressed=true（可切是硬要求）", () => {
    const span = llm("l1", "s1") as Extract<SpanLine, { kind: "llm.call" }>;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "input",
        onIo: noop,
        emptyContentHint: "",
        longTextProps,
      }),
    );
    expect(markup).toContain("输入");
    expect(markup).toContain("输出");
    // 恰好一个 aria-pressed=true（当前选中半）
    expect(markup.match(/aria-pressed="true"/g)?.length).toBe(1);
  });

  it("io=input ⇒ 渲染请求消息，不渲染响应正文（切换真的换半）", () => {
    const span = llm("l1", "s1", { content: "RESPONSE_TEXT" }) as Extract<
      SpanLine,
      { kind: "llm.call" }
    >;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "input",
        onIo: noop,
        emptyContentHint: "",
        longTextProps,
      }),
    );
    expect(markup).toContain("请求消息");
    expect(markup).not.toContain("RESPONSE_TEXT");
  });

  it("io=output ⇒ 渲染响应正文，不渲染请求消息列表", () => {
    const span = llm("l1", "s1", { content: "RESPONSE_TEXT" }) as Extract<
      SpanLine,
      { kind: "llm.call" }
    >;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "output",
        onIo: noop,
        emptyContentHint: "",
        longTextProps,
      }),
    );
    expect(markup).toContain("RESPONSE_TEXT");
    expect(markup).not.toContain("请求消息");
  });

  it("概要含模型 / 输入输出 tokens / 首 token 延迟 / 耗时（原始字段在概要可见）", () => {
    const span = llm("l1", "s1", { in: 123, out: 45, ttft: 67 }) as Extract<
      SpanLine,
      { kind: "llm.call" }
    >;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "input",
        onIo: noop,
        emptyContentHint: "",
        longTextProps,
      }),
    );
    expect(markup).toContain("test-model");
    expect(markup).toContain("123");
    expect(markup).toContain("45");
    expect(markup).toContain("67ms");
  });

  it("request.tools 存在 ⇒ 输入半渲染工具表；缺失 ⇒ 不渲染", () => {
    const withTools = llm("l1", "s1", { tools: [{ name: "read_file" }] }) as Extract<
      SpanLine,
      { kind: "llm.call" }
    >;
    const noTools = llm("l2", "s1") as Extract<SpanLine, { kind: "llm.call" }>;
    const props = { io: "input" as const, onIo: noop, emptyContentHint: "", longTextProps };
    expect(html(createElement(LlmCallDetailView, { span: withTools, ...props }))).toContain(
      "工具表",
    );
    expect(html(createElement(LlmCallDetailView, { span: noTools, ...props }))).not.toContain(
      "工具表",
    );
  });

  it("失败调用 ⇒ 错误分区显式呈现，且说明 tokens 是失败占位零值", () => {
    const span = llm("l1", "s1", { error: { message: "boom", status: 429 } }) as Extract<
      SpanLine,
      { kind: "llm.call" }
    >;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "output",
        onIo: noop,
        emptyContentHint: "",
        longTextProps,
      }),
    );
    expect(markup).toContain("调用失败");
    expect(markup).toContain("HTTP 429");
    expect(markup).toContain("失败占位零值");
  });

  it("响应正文为空 ⇒ 显示传入的空正文分型提示（不冒充有正文）", () => {
    const span = llm("l1", "s1", { content: "" }) as Extract<SpanLine, { kind: "llm.call" }>;
    const markup = html(
      createElement(LlmCallDetailView, {
        span,
        io: "output",
        onIo: noop,
        emptyContentHint: "（无正文，仅有工具调用）",
        longTextProps,
      }),
    );
    expect(markup).toContain("（无正文，仅有工具调用）");
  });
});

// ---------------------------------------------------------------------------
// ToolInvokeDetailView 静态渲染：args/result 就近核对 + error 显式
// ---------------------------------------------------------------------------

describe("ToolInvokeDetailView：场景「工具调用详情」", () => {
  const longTextProps = () => ({ expanded: false, onToggle: noop });

  it("工具名 / 入参 / 结果 / 两个耗时口径都在", () => {
    const span = tool("t1", "s1", {
      tool: "grep",
      args: { pattern: "needle" },
      result: "found it",
      durMs: 33,
    }) as Extract<SpanLine, { kind: "tool.invoke" }>;
    const markup = html(createElement(ToolInvokeDetailView, { span, longTextProps }));
    expect(markup).toContain("grep");
    expect(markup).toContain("needle");
    expect(markup).toContain("found it");
    expect(markup).toContain("33ms");
    expect(markup).toContain("墙上耗时");
  });

  it("args 与 result 在同一个 Section（就近核对，不被其它栏目冲散）", () => {
    const span = tool("t1", "s1") as Extract<SpanLine, { kind: "tool.invoke" }>;
    const markup = html(createElement(ToolInvokeDetailView, { span, longTextProps }));
    // 两块同处「入参与结果」分区
    expect(markup).toContain("入参与结果");
    expect(markup).toContain("入参");
    expect(markup).toContain("结果");
    // 且是并排栅格（宽屏两列）
    expect(markup).toContain("xl:grid-cols-2");
  });

  it("error 非空 ⇒ 错误信息显式呈现", () => {
    const span = tool("t1", "s1", { error: "command not found" }) as Extract<
      SpanLine,
      { kind: "tool.invoke" }
    >;
    const markup = html(createElement(ToolInvokeDetailView, { span, longTextProps }));
    expect(markup).toContain("错误");
    expect(markup).toContain("command not found");
  });

  it("error === null（成功）⇒ 不渲染错误分区（null 是成功不是「没字段」）", () => {
    const span = tool("t1", "s1", { error: null }) as Extract<SpanLine, { kind: "tool.invoke" }>;
    const markup = html(createElement(ToolInvokeDetailView, { span, longTextProps }));
    expect(markup).not.toContain("错误（错误是数据不是异常）");
  });

  it("children（fork 编辑器）由壳注入，纯展示部分原样透传", () => {
    const span = tool("t1", "s1") as Extract<SpanLine, { kind: "tool.invoke" }>;
    const markup = html(
      createElement(
        ToolInvokeDetailView,
        { span, longTextProps },
        createElement("div", { "data-testid": "fork-slot" }, "FORK_EDITOR"),
      ),
    );
    expect(markup).toContain("FORK_EDITOR");
  });
});

// ---------------------------------------------------------------------------
// StepDetailView 静态渲染：三块都在 + 可下钻
// ---------------------------------------------------------------------------

describe("StepDetailView：场景「长请求和原始字段完整可读」的 step 摘要", () => {
  const spans: SpanLine[] = [
    step("s1", 3),
    llm("l1", "s1", { in: 10, out: 2 }),
    tool("t1", "s1", { error: "boom" }),
  ];
  const node = buildSpanTree(spans).find((n) => n.span.id === "s1");

  it("概要含迭代序号 / 已记录调用 / 错误数 / tokens / 工具调用（三块都在）", () => {
    const markup = html(
      createElement(StepDetailView, {
        view: presentStepDetail(node as never),
        onOpenCall: noop,
      }),
    );
    expect(markup).toContain("迭代序号");
    expect(markup).toContain("已记录调用");
    expect(markup).toContain("其中错误");
    expect(markup).toContain("输入 tokens");
    expect(markup).toContain("输出 tokens");
    expect(markup).toContain("工具调用");
  });

  it("每条已记录调用是一个按钮（可下钻到原始调用）", () => {
    const markup = html(
      createElement(StepDetailView, {
        view: presentStepDetail(node as never),
        onOpenCall: noop,
      }),
    );
    // 2 条调用 ⇒ 2 个 <button>
    expect(markup.match(/<button/g)?.length).toBe(2);
    expect(markup).toContain("test-model");
    expect(markup).toContain("read_file");
  });

  it("出错调用带「错误」标记（一眼看这步有没有出错）", () => {
    const markup = html(
      createElement(StepDetailView, {
        view: presentStepDetail(node as never),
        onOpenCall: noop,
      }),
    );
    expect(markup).toContain("错误");
  });

  it("无直接调用 ⇒ 明确说明「没有」，不渲染空列表", () => {
    const emptyNode = buildSpanTree([step("s9", 1)]).find((n) => n.span.id === "s9");
    const markup = html(
      createElement(StepDetailView, {
        view: presentStepDetail(emptyNode as never),
        onOpenCall: noop,
      }),
    );
    expect(markup).toContain("没有直接记录的");
    expect(markup.match(/<button/g)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LongText：查找 / 复制 / 展开（静态可断言部分）
// ---------------------------------------------------------------------------

describe("LongText：长文本可查找、展开和复制", () => {
  const LONG = "x".repeat(700);

  it("折叠摘要带真实字符数（用户能判断要展开多大一块）", () => {
    const markup = html(createElement(LongText, { text: LONG, label: "args" }));
    expect(markup).toContain("700 字符");
  });

  it("展开后给出查找输入框与复制按钮（折叠时连原文都看不到，工具条无处可用）", () => {
    const expanded = html(
      createElement(LongText, { text: LONG, label: "args", expanded: true, onToggle: noop }),
    );
    expect(expanded).toContain("在原文中查找");
    expect(expanded).toContain("复制原文");
    // 折叠态不显示工具条
    const collapsed = html(createElement(LongText, { text: LONG, label: "args" }));
    expect(collapsed).not.toContain("在原文中查找");
  });

  it("短文本不折叠 ⇒ 不显示查找/复制工具条（无处可用）", () => {
    const markup = html(createElement(LongText, { text: "short", label: "args" }));
    expect(markup).not.toContain("复制原文");
  });

  it("受控 expanded=true ⇒ details 打开（恢复出用户看的那一块）", () => {
    const markup = html(
      createElement(LongText, { text: LONG, label: "args", expanded: true, onToggle: noop }),
    );
    expect(markup).toContain("open");
  });

  it("findCountLabel：无命中明说「无命中」，有命中给「第 n / m 个」", () => {
    expect(findCountLabel({ matches: [], index: -1 })).toBe("无命中");
    expect(findCountLabel({ matches: [{}, {}], index: 0 })).toBe("第 1 / 2 个");
  });

  it("copyFeedbackText：成功与不可用如实分开（不谎报已复制）", () => {
    expect(copyFeedbackText("copied")).toContain("已复制");
    expect(copyFeedbackText("unavailable")).toContain("不支持");
  });

  it("copyPayload 恒为完整原文（spec：复制对应原始文本而非省略后的展示）", () => {
    const full = "x".repeat(5000);
    expect(copyPayload(full)).toBe(full);
    expect(copyPayload(full).length).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 源码级接线契约：外壳层（哪个 span 挂哪个详情）组件测试打不到
// ---------------------------------------------------------------------------

describe("源码级接线契约：DetailPanel 的外壳接线", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
    "utf8",
  );

  it("step 分支接线 presentStepDetail + onOpenCall → selectSpan（不能只显示静态概要）", () => {
    expect(source).toContain("presentStepDetail(stepNode)");
    expect(source).toContain("onOpenCall={(id) => selectSpan(id)}");
  });

  it("step 节点从 span 树取（stepNode 走 buildSpanTree，不是直接拿 SpanLine）", () => {
    expect(source).toContain("buildSpanTree(detail.spans)");
    expect(source).toContain("stepNode");
  });

  it("LlmCallDetailView 收到 resolveIoView 的结果与写入 io 的回调", () => {
    expect(source).toContain("resolveIoView(span, ioState)");
    expect(source).toContain("setCallReading(runId, span.id, { io: next })");
  });

  it("LongText 的复制调用点写的是 copyPayload(text)（不是摘要/截断串）", () => {
    const longSource = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/LongText.tsx"),
      "utf8",
    );
    expect(longSource).toContain("writeText(copyPayload(text))");
  });
});

/**
 * 2026-09-24 U2 验收阶段实测到的**真实缺陷**回归（整页空白）。
 *
 * 触发链：`request.messages` 里允许有**不带 `content` 键**的消息（仅含 `tool_calls` 的 assistant
 * 消息、空 system 提示都合法，`readRun` 不拒）⇒ 旧内联写法把它交给 `prettyJson`，
 * 而 `prettyJson(undefined)` 当时返回 **`undefined`**（`JSON.stringify(undefined)` 的返回值），
 * 与它 `: string` 的签名相反 ⇒ `LongText` 里 `shouldCollapse(undefined)` 读 `.length` 抛错
 * ⇒ 渲染层无 error boundary，**整个步骤页空白**。
 *
 * 两层修复各钉一条：判据层（本组）**返回值永远是字符串**；格式化层（`prettyJson`）保证 totality。
 */
describe("消息内容永远是字符串（防整页空白回归）", () => {
  it("字符串原样返回", () => {
    expect(messageContentText({ content: "正文" })).toBe("正文");
    expect(messageContentText({ content: "" })).toBe("");
  });

  it("**缺 content 键**（合法消息形态）⇒ 返回字符串而不是 undefined", () => {
    const text = messageContentText({});
    expect(typeof text).toBe("string");
    expect(text).toBe("undefined");
  });

  it("content 为 null / 数字 / 对象 ⇒ 都转成字符串（JSON 分支）", () => {
    for (const content of [null, 0, false, { a: 1 }, [1, 2]]) {
      const text = messageContentText({ content });
      expect(typeof text).toBe("string");
    }
    expect(messageContentText({ content: null })).toBe("null");
    expect(messageContentText({ content: { a: 1 } })).toBe('{\n  "a": 1\n}');
  });

  it("`prettyJson` 对 stringify 会吃掉的值（undefined / 函数 / Symbol）也返回字符串", () => {
    // JSON.stringify 对这三类**返回 undefined**（不是字符串）——这正是旧缺陷的根
    for (const value of [undefined, () => 1, Symbol("s")]) {
      const text = messageContentText({ content: value });
      expect(typeof text).toBe("string");
    }
  });

  it("接线：DetailPanel 的消息渲染走该函数（不再内联 prettyJson）", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/renderer/src/components/DetailPanel.tsx"),
      "utf8",
    );
    expect(source).toContain("text={messageContentText(message)}");
  });
});
