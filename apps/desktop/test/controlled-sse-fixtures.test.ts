import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CreateRunError, runCreate } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import type { RunDetail } from "../src/shared/ipc";
import { type MockLlmHandle, type MockScript, withMockLlm } from "./helpers/mock-llm-harness";

/**
 * U5（unify-run-execution-workflow）任务 6.1：受控 SSE 剧本目录的**可用性自检**。
 *
 * 判据来源：tasks.md 6.1——「准备受控 SSE 成功/503/延迟/限制 fixture 与调用计数…；
 * fixture 不访问付费 provider」。design §Validation Strategy「受控 Electron 验收覆盖七入口
 * 成功与失败、503、限制、不可读结果…；不调用付费 provider」。
 *
 * 这一支为什么不能省：6.2–6.8 每个实机 tag 都要拿剧本的 `expectedCalls` /
 * `expectedEvent` / `expectedReason` 当**期望值**。期望值本身没被真跑过 ⇒ 判红时分不清
 * 是产品错了还是剧本错了（U4 6.1/6.4 两轮首版断言判红都属后者）。所以剧本目录先在
 * 本机受控服务上真跑一遍：次数数出来、自有终止事件从落盘文件读出来。
 *
 * ⚠️ 一律走**真实** `runCreate` + 真实 `OpenAiCompatClient`（入口自行 new，不注入 llm）：
 *   注入桩只能证明编排逻辑，证明不了"这条剧本确实打出这些请求、落出这个终止事件"。
 */

const require = createRequire(import.meta.url);

interface Fixture {
  id: string;
  用途: string;
  scenarios: string[];
  script: MockScript;
  expectedCalls: number;
  expectedEvent: string | null;
  expectedReason: string | null;
  expectedErrorStatus?: number;
  notes: string;
}
interface FixtureModule {
  FIXTURE_IDS: string[];
  fixtureOf: (id: string) => Fixture;
  MAX_ITERATIONS: number;
  MAX_TOTAL_TOKENS: number;
}
const catalog = require("../scripts/lib/u5-sse-fixtures.cjs") as FixtureModule;

/** delta 场景标题的权威出处（引用逐字对账用）。
 * U5 已于 2026-09-29 归档（`29d84b2`）⇒ 权威位置随迁 archive，不再指活动 change 路径。 */
const DELTA_SPEC = resolve(
  import.meta.dirname,
  "../../../openspec/changes/archive/2026-09-29-unify-run-execution-workflow/specs/desktop-ui/spec.md",
);

const SYSTEM = "你是简洁的问答助手。";
const TASK = "用一句话解释什么是时间旅行调试。";
const SETTINGS: RunSettings = {
  baseURL: "https://api.invalid.example/v1",
  apiKey: "sk-controlled-only",
  model: "controlled-model",
  encrypted: true,
};

function tempRepo(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "u5-sse-fixture-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 末条自有终止事件（`status=completed` 只代表已封存，不代表正常结束） */
function lastEvent(record: RunDetail | null): { event: string; reason: string } | null {
  if (record === null) return null;
  const line = record.events[record.events.length - 1];
  if (line === undefined) return null;
  return { event: line.event, reason: line.reason };
}

/** 首次失败 llm.call 的 status（成功调用省略该字段） */
function llmErrorStatus(record: RunDetail | null): number | null {
  if (record === null) return null;
  for (const span of record.spans) {
    if (span.kind === "llm.call" && span.error !== undefined) return span.error.status ?? null;
  }
  return null;
}

interface Driven {
  served: number;
  paths: string[];
  runId: string | null;
  thrown: CreateRunError | null;
  elapsedMs: number;
  terminal: { event: string; reason: string } | null;
  errorStatus: number | null;
  stepCount: number;
  tmpLeftBehind: string[];
  totalTokens: number;
}

/** 在受控服务上真跑一条剧本（不注入 llm），把"次数 + 自有终止事实 + 本机性"一次收齐 */
async function drive(id: string): Promise<Driven> {
  const fixture = catalog.fixtureOf(id);
  const { traces, repo, cleanup } = tempRepo();
  try {
    return await withMockLlm(fixture.script, async (handle: MockLlmHandle) => {
      const startedAt = Date.now();
      let runId: string | null = null;
      let thrown: CreateRunError | null = null;
      try {
        runId = (
          await runCreate(
            {
              repository: repo,
              settings: { ...SETTINGS, baseURL: handle.baseURL },
              execCwd: traces,
            },
            { systemPrompt: SYSTEM, userMessage: TASK },
          )
        ).id;
      } catch (e) {
        thrown = e instanceof CreateRunError ? e : null;
        if (thrown === null) throw e;
        runId = thrown.runId ?? null;
      }
      const elapsedMs = Date.now() - startedAt;
      const record = runId === null ? null : repo.getRun(runId);
      expect(handle.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:/);
      return {
        served: handle.served(),
        paths: handle.entries().map((e) => e.path),
        runId,
        thrown,
        elapsedMs,
        terminal: lastEvent(record),
        errorStatus: llmErrorStatus(record),
        stepCount: record === null ? 0 : record.spans.filter((s) => s.kind === "agent.step").length,
        tmpLeftBehind: readdirSync(traces).filter((name) => name.endsWith(".tmp")),
        totalTokens:
          record === null
            ? 0
            : record.spans.reduce(
                (sum, s) =>
                  s.kind === "llm.call" ? sum + s.response.usage.in + s.response.usage.out : sum,
                0,
              ),
      };
    });
  } finally {
    cleanup();
  }
}

/**
 * 同一剧本只真跑一次（结果纯数据、服务已关停 ⇒ 跨用例复用安全）。
 * 延迟剧本单条就要 6 s，逐用例各跑一遍会把这一支变成计时练习。
 */
const drivenOnce = new Map<string, Promise<Driven>>();
function driveOnce(id: string): Promise<Driven> {
  const existing = drivenOnce.get(id);
  if (existing !== undefined) return existing;
  const next = drive(id);
  drivenOnce.set(id, next);
  return next;
}

describe("U5 6.1 受控剧本目录：结构与被引用的 delta 场景", () => {
  it("每条剧本都给出期望调用数与期望自有终止事实，且 id 与键名一致", () => {
    for (const id of catalog.FIXTURE_IDS) {
      const f = catalog.fixtureOf(id);
      expect(f.id).toBe(id);
      expect(Number.isInteger(f.expectedCalls)).toBe(true);
      expect(f.用途.length).toBeGreaterThan(0);
      expect(f.notes.length).toBeGreaterThan(0);
      // 期望终止事实成对出现：null/null = 「不该被执行」，其余必须是 event+reason 两值
      if (f.expectedEvent === null) expect(f.expectedReason).toBeNull();
      else expect(typeof f.expectedReason).toBe("string");
    }
    expect(catalog.FIXTURE_IDS).toContain("notConsumed");
  });

  it("剧本点名的场景标题逐字存在于 desktop-ui delta", () => {
    const spec = readFileSync(DELTA_SPEC, "utf8");
    const titles = new Set(
      [...spec.matchAll(/#### Scenario: (.+)/g)].map((m) => (m[1] ?? "").trim()),
    );
    expect(titles.size).toBeGreaterThan(0);
    for (const id of catalog.FIXTURE_IDS) {
      for (const cited of catalog.fixtureOf(id).scenarios) {
        expect(titles.has(cited), `${id} 引用了不存在的场景标题：${cited}`).toBe(true);
      }
    }
  });

  it("剧本额度常量与 main 硬编码同值（常量漂移时剧本会失效，先判红）", () => {
    const create = readFileSync(resolve(import.meta.dirname, "../src/main/run-create.ts"), "utf8");
    expect(create.includes(`const MAX_ITERATIONS = ${catalog.MAX_ITERATIONS};`)).toBe(true);
    expect(
      create.includes(
        `const MAX_TOTAL_TOKENS = ${catalog.MAX_TOTAL_TOKENS.toLocaleString("en-US").replace(/,/g, "_")};`,
      ),
    ).toBe(true);
  });

  it("未知剧本 id 直接抛，不静默退回默认剧本", () => {
    expect(() => catalog.fixtureOf("no-such-fixture")).toThrow(/未知受控剧本/);
  });
});

describe("U5 6.1 受控剧本目录：真跑一遍把期望值钉住", () => {
  /**
   * 目录 ⇄ 真实行为一体校验：实机 tag 引用的就是 `expectedCalls` / `expectedEvent` /
   * `expectedReason` 这三格，所以必须**由目录读出期望值再比对真实跑出来的事实**。
   * 只在用例里手写一遍字面量（`toBe(10)`）的话，目录写错照样绿 ⇒ 6.x 判红时分不清锅在谁。
   */
  it("目录里每条剧本的期望调用数与期望自有终止事实都被真实行为对上", async () => {
    for (const id of catalog.FIXTURE_IDS) {
      const f = catalog.fixtureOf(id);
      if (f.expectedCalls === 0) {
        // 零消费剧本不在此执行（它由下面那条「被消费就留痕」的用例立证）
        expect(f.expectedEvent, `${id} 的期望事件应为 null`).toBeNull();
        continue;
      }
      const r = await driveOnce(id);
      expect(r.served, `${id} 的实际调用数与目录期望不符`).toBe(f.expectedCalls);
      expect(r.terminal, `${id} 的自有终止事件与目录期望不符`).toEqual({
        event: f.expectedEvent,
        reason: f.expectedReason,
      });
    }
  }, 60_000);

  it("successPlain：恰一次 SSE 调用，自有终止是 stopped/completed，临时文件不留存", async () => {
    const r = await driveOnce("successPlain");
    expect(r.served).toBe(1);
    expect(r.paths).toEqual(["/v1/chat/completions"]);
    expect(r.thrown).toBeNull();
    expect(r.runId).not.toBeNull();
    expect(r.terminal).toEqual({ event: "stopped", reason: "completed" });
    expect(r.errorStatus).toBeNull();
    expect(r.tmpLeftBehind).toEqual([]);
  });

  it("fail503：失败不重试（一次调用），自有终止是 errored/error 且失败详情带 503", async () => {
    const r = await driveOnce("fail503");
    expect(r.served).toBe(1);
    expect(r.thrown).not.toBeNull();
    expect(r.runId).not.toBeNull();
    // 文件照样归位（不产生半成品）：status 只表示已封存
    expect(r.terminal).toEqual({ event: "errored", reason: "error" });
    expect(r.errorStatus).toBe(catalog.fixtureOf("fail503").expectedErrorStatus);
    expect(r.tmpLeftBehind).toEqual([]);
  });

  it("delayedInFlight：延迟在响应头之前生效 ⇒ 在飞窗口是真的（6.x 探针靠它）", async () => {
    const r = await driveOnce("delayedInFlight");
    expect(r.served).toBe(1);
    expect(r.terminal).toEqual({ event: "stopped", reason: "completed" });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(5_000);
  }, 30_000);

  it("budgetExceeded：单轮用量超预算 ⇒ stopped/budget_exceeded 且只发一次", async () => {
    const r = await driveOnce("budgetExceeded");
    expect(r.served).toBe(1);
    expect(r.totalTokens).toBeGreaterThan(catalog.MAX_TOTAL_TOKENS);
    expect(r.terminal).toEqual({ event: "stopped", reason: "budget_exceeded" });
    // 上限类结局不是正常结束：清理判据据此不放行
    expect(r.terminal?.reason).not.toBe("completed");
  });

  it("maxIterations：fallback 每轮都回 tool_calls ⇒ 十次调用后 stopped/max_iterations", async () => {
    const r = await driveOnce("maxIterations");
    expect(r.served).toBe(catalog.MAX_ITERATIONS);
    expect(r.stepCount).toBe(catalog.MAX_ITERATIONS);
    expect(r.terminal).toEqual({ event: "stopped", reason: "max_iterations" });
  });

  it("notConsumed：一旦被消费就同时留下计数增量与 418 两处可区痕迹", async () => {
    const fixture = catalog.fixtureOf("notConsumed");
    await withMockLlm(fixture.script, async (handle) => {
      expect(handle.served()).toBe(0);
      const res = await fetch(`${handle.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "controlled-model",
          messages: [{ role: "user", content: "x" }],
        }),
      });
      expect(res.status).toBe(418);
      expect(handle.served()).toBe(1);
      expect(fixture.expectedCalls).toBe(0);
    });
  });
});
