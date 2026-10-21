import { configHash } from "@rebaseagent/agent-loop";
import type { ToolDef } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import type { ChatMessage, LlmCallSpan, RunRecord } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_TOOLS_V1_DEFINITIONS } from "../src/workspace/file-tools";
import {
  deriveIsolatedPromptState,
  findStartupMessagesViolation,
  restorePromptParams,
  sanitizeProviderEndpoint,
  validateIsolatedPromptEdit,
} from "../src/workspace/isolated-prompt-state";
import {
  BASELINE_CONFIG_HASH,
  BASELINE_MODEL,
  BASELINE_PARAMS,
  NEW_SYSTEM_PROMPT,
  NEW_USER_INSTRUCTION,
  ORIGINAL_SYSTEM_PROMPT,
  ORIGINAL_USER_INSTRUCTION,
  buildIsolatedPromptBaselineCase,
} from "./isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir } from "./workspace-helpers";

/**
 * R2.2 任务 3.2 纯派生：单项编辑、启动消息形状、params 无损恢复、config_hash、
 * 端点规范化。零 fs 副作用（fixture 只用来拿一份真实 v2 根记录）。
 */

afterEach(() => {
  cleanupTempDirs();
});

const FIXED_TOOLS = [...FILE_TOOLS_V1_DEFINITIONS] as ToolDef[];

async function fixtureRoot(): Promise<RunRecord> {
  const tmp = makeDataDir();
  const fixture = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
  return readRun(fixture.root.traceFile);
}

function firstLlm(record: RunRecord): LlmCallSpan {
  const llm = record.spans.find((span): span is LlmCallSpan => span.kind === "llm.call");
  if (llm === undefined) throw new Error("fixture 缺少 llm.call");
  return llm;
}

function withMessages(record: RunRecord, messages: unknown[]): RunRecord {
  const clone = structuredClone(record);
  firstLlm(clone).request.messages = messages as ChatMessage[];
  return clone;
}

function withParams(record: RunRecord, params: unknown): RunRecord {
  const clone = structuredClone(record);
  (firstLlm(clone).request as { params?: unknown }).params = params;
  return clone;
}

describe("deriveIsolatedPromptState：单项编辑与有效请求", () => {
  it("system 编辑：只改首条 system，user 原样；systemPrompt/config_hash 同步新值", async () => {
    const record = await fixtureRoot();
    const result = deriveIsolatedPromptState({
      record,
      edit: { field: "system_prompt", value: NEW_SYSTEM_PROMPT },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value;

    expect(state.baselineLlmSpanId).toBe(firstLlm(record).id);
    expect(state.originalValue).toBe(ORIGINAL_SYSTEM_PROMPT);
    expect(state.originalSystemPrompt).toBe(ORIGINAL_SYSTEM_PROMPT);
    expect(state.systemPrompt).toBe(NEW_SYSTEM_PROMPT);
    expect(state.model).toBe(BASELINE_MODEL);
    expect(state.params).toEqual(BASELINE_PARAMS);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual({ role: "system", content: NEW_SYSTEM_PROMPT });
    expect(state.messages[1]).toEqual({ role: "user", content: ORIGINAL_USER_INSTRUCTION });
    expect(state.configHash).toBe(configHash(NEW_SYSTEM_PROMPT, FIXED_TOOLS));
    expect(state.initialSnapshot.id).toBe(record.meta.workspace?.initial_snapshot.id);
  });

  it("user 编辑：只改首条 user，system 与 config_hash（system+工具）不变", async () => {
    const record = await fixtureRoot();
    const result = deriveIsolatedPromptState({
      record,
      edit: { field: "user_message", value: NEW_USER_INSTRUCTION },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value;

    expect(state.originalValue).toBe(ORIGINAL_USER_INSTRUCTION);
    expect(state.systemPrompt).toBe(ORIGINAL_SYSTEM_PROMPT);
    expect(state.messages[0]).toEqual({ role: "system", content: ORIGINAL_SYSTEM_PROMPT });
    expect(state.messages[1]).toEqual({ role: "user", content: NEW_USER_INSTRUCTION });
    expect(state.configHash).toBe(BASELINE_CONFIG_HASH);
  });

  it("多条非目标消息逐字段保留（含可选 name），只替换首条命中 role", async () => {
    const record = withMessages(await fixtureRoot(), [
      { role: "system", content: "第一 system", name: "primary" },
      { role: "user", content: "第一 user" },
      { role: "system", content: "第二 system", name: "secondary" },
      { role: "user", content: "第二 user", name: "followup" },
    ]);
    const result = deriveIsolatedPromptState({
      record,
      edit: { field: "system_prompt", value: "改后的第一 system" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages).toEqual([
      { role: "system", content: "改后的第一 system", name: "primary" },
      { role: "user", content: "第一 user" },
      { role: "system", content: "第二 system", name: "secondary" },
      { role: "user", content: "第二 user", name: "followup" },
    ]);
    // 原记录不被修改
    expect(firstLlm(record).request.messages[0]?.content).toBe("第一 system");
  });

  it("空串/纯空白是真实变化；逐字相同才拒绝（empty_edit）", async () => {
    const record = await fixtureRoot();
    for (const value of ["", " ", `${ORIGINAL_USER_INSTRUCTION} `]) {
      const result = deriveIsolatedPromptState({
        record,
        edit: { field: "user_message", value },
      });
      expect(result.ok).toBe(true);
    }
    const same = deriveIsolatedPromptState({
      record,
      edit: { field: "user_message", value: ORIGINAL_USER_INSTRUCTION },
    });
    expect(same.ok).toBe(false);
    if (same.ok) return;
    expect(same.failure.code).toBe("empty_edit");
  });

  it.each([
    ["额外字段", { field: "system_prompt", value: "x", userValue: "y" }],
    ["model_params", { field: "model_params", value: { model: "m" } }],
    ["非字符串值", { field: "system_prompt", value: 1 }],
    ["null", null],
    ["数组", []],
  ])("非法编辑形状（%s）⇒ invalid_edit", async (_label, edit) => {
    const record = await fixtureRoot();
    const result = deriveIsolatedPromptState({ record, edit });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_edit");
  });
});

describe("deriveIsolatedPromptState：启动消息严格形状", () => {
  it.each([
    [
      "含 assistant 历史",
      [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ],
    ],
    [
      "含 tool 历史",
      [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "tool", content: "r", tool_call_id: "c1" },
      ],
    ],
    [
      "user 带 tool_calls",
      [
        { role: "system", content: "s" },
        { role: "user", content: "u", tool_calls: [] },
      ],
    ],
    [
      "多模态 content",
      [
        { role: "system", content: "s" },
        { role: "user", content: [{ type: "text", text: "u" }] },
      ],
    ],
    [
      "未知字段",
      [
        { role: "system", content: "s" },
        { role: "user", content: "u", extra: true },
      ],
    ],
    [
      "name 非字符串",
      [
        { role: "system", content: "s", name: 1 },
        { role: "user", content: "u" },
      ],
    ],
    ["缺 user", [{ role: "system", content: "s" }]],
    ["缺 system", [{ role: "user", content: "u" }]],
    ["缺 content", [{ role: "system" }, { role: "user", content: "u" }]],
  ])("%s ⇒ startup_unavailable", async (_label, messages) => {
    const record = withMessages(await fixtureRoot(), messages);
    const result = deriveIsolatedPromptState({
      record,
      edit: { field: "system_prompt", value: "新值" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("startup_unavailable");
  });

  it("首次 llm.call 不在自有第 1 步 ⇒ startup_unavailable", async () => {
    const clone = structuredClone(await fixtureRoot());
    const llm = firstLlm(clone);
    const step = clone.spans.find((span) => span.id === llm.parent);
    if (step === undefined || step.kind !== "agent.step") throw new Error("fixture 缺少 step");
    step.n = 2;
    const result = deriveIsolatedPromptState({
      record: clone,
      edit: { field: "system_prompt", value: "新值" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("startup_unavailable");
    expect(result.failure.reason).toContain("第 1 步");
  });

  it("findStartupMessagesViolation：合法多 system/user 返回 null", () => {
    expect(
      findStartupMessagesViolation([
        { role: "system", content: "a", name: "n1" },
        { role: "user", content: "b" },
        { role: "system", content: "c" },
        { role: "user", content: "d", name: "n2" },
      ]),
    ).toBeNull();
  });
});

describe("restorePromptParams：无损恢复（缺省 vs 空对象、标量、拒绝静默过滤）", () => {
  it("缺省 → undefined；显式 {} → {}", () => {
    expect(restorePromptParams(undefined)).toEqual({ ok: true, params: undefined });
    expect(restorePromptParams({})).toEqual({ ok: true, params: {} });
  });

  it("字符串/有限数值/布尔值原样保留（含 0 与空串）", () => {
    expect(restorePromptParams({ temperature: 0, effort: "none", think: false, note: "" })).toEqual(
      {
        ok: true,
        params: { temperature: 0, effort: "none", think: false, note: "" },
      },
    );
  });

  it.each([
    ["嵌套对象", { nested: { a: 1 } }],
    ["数组", { list: [1] }],
    ["null", { nothing: null }],
    ["NaN", { n: Number.NaN }],
    ["Infinity", { n: Number.POSITIVE_INFINITY }],
    ["保留键 model", { model: "x" }],
    ["保留键 messages", { messages: [] }],
    ["非对象", "temperature=0.2"],
  ])("%s ⇒ 拒绝（不静默过滤）", (_label, raw) => {
    const result = restorePromptParams(raw);
    expect(result.ok).toBe(false);
  });

  it("derive：嵌套 params ⇒ config_unreconstructable", async () => {
    const record = withParams(await fixtureRoot(), { nested: { a: 1 } });
    const result = deriveIsolatedPromptState({
      record,
      edit: { field: "system_prompt", value: "新值" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("config_unreconstructable");
  });
});

describe("sanitizeProviderEndpoint：去 userinfo/query/fragment", () => {
  it("保留 origin+pathname，丢弃凭据/查询/片段", () => {
    const result = sanitizeProviderEndpoint(
      "https://sekret-user:sekret-pass@api.example.com:8443/v1/chat?sekret-query=1#sekret-frag",
    );
    expect(result).toEqual({ ok: true, value: "https://api.example.com:8443/v1/chat" });
  });

  it("非 http(s) 或非法 URL 拒绝", () => {
    expect(sanitizeProviderEndpoint("file:///tmp/x").ok).toBe(false);
    expect(sanitizeProviderEndpoint("not a url").ok).toBe(false);
  });
});

describe("validateIsolatedPromptEdit：严格两键", () => {
  it("合法两键通过；缺值/多键/未知字段拒绝", () => {
    expect(validateIsolatedPromptEdit({ field: "system_prompt", value: "x" })).toMatchObject({
      ok: true,
    });
    for (const bad of [
      { field: "system_prompt" },
      { field: "system_prompt", value: "x", extra: 1 },
      { field: "result", value: "x" },
      null,
    ]) {
      expect(validateIsolatedPromptEdit(bad).ok).toBe(false);
    }
  });
});
