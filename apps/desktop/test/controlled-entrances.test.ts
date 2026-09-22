import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiCompatClient, runLoop } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../../packages/agent-loop/test/helpers";
import { runFork, runPromptFork } from "../src/main/fork-runner";
import { runCreate } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import { withMockLlm } from "./helpers/mock-llm-harness";

/**
 * U1（refactor-run-workspace）任务 6.4：在受控模型服务上回归普通创建 / result fork / prompt fork。
 *
 * 判据来源：tasks.md 6.4——「在受控模型服务上回归普通创建/result/prompt 入口；验证『旧创建设置及
 * 执行入口保持可达』，分别记录一次明确提交、原配置/费用门禁、结果进入概览和父记录未改写，不把
 * 既有执行行为算为 U5 验收」；design §Risks「各主动执行入口至少验证可达、原门禁和一次受控提交」。
 *
 * 与 6.0 的差别：6.0 备齐"执行前提"，本任务用**真实编排入口**驱动受控服务（`runCreate` /
 * `runFork` / `runPromptFork` **不注入 llm**，让入口自行 new 真实 `OpenAiCompatClient`，baseURL
 * 指到受控服务），用受控服务的请求日志（`h.entries()`）逐入口钉住「请求格式/次数/顺序」，并验证
 * 产物落盘进概览、父记录逐字节未改写、预算与原配置门禁保留。
 *
 * ⚠️ 刻意不复用 MockLlmClient：那只能证明编排逻辑，证明不了"入口真的连到配置的服务并恰提交一次"。
 */

const SYSTEM = "你是一个简洁的问答助手，用两三句话回答。";
const TASK = "用一句话解释什么是时间旅行调试。";

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

/** 预算/费用门禁的既有硬编码值（与各编排入口一致，握在手防静默漂移） */
const BUDGET = { max_total_tokens: 100_000 };

/** 父 run 剧本：一步工具（read_file）后收尾 ⇒ completed 且含 tool.invoke，可作 result fork 分叉点 */
const PARENT_TURNS = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { content: "父 run 完成。" },
];

const NEW_README = "# ReBaseAgent（编辑后的历史）\n\n不止回放，还能改变。";
const SYS_EDIT = { field: "system_prompt" as const, value: "你是只许一次说清的助手。" };

function tempRepo(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "controlled-entrances-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 临时文件（不带 .jsonl 后缀）不应留在 traces 目录 */
function tmpFiles(traces: string): string[] {
  return readdirSync(traces).filter((name) => name.endsWith(".tmp"));
}

/** 用真实 runLoop + 真实 OpenAiCompatClient 经受控服务现造 completed 父 run（含 tool.invoke） */
async function createParentViaService(traces: string, baseURL: string): Promise<string> {
  const config = sampleConfig({ baseURL, apiKey: "test-key" });
  const tmpFile = join(traces, "tmp-parent.jsonl");
  await runLoop(
    config,
    initialMessages(TASK),
    new JsonlTracer(tmpFile),
    sampleTools(),
    new OpenAiCompatClient(config),
  );
  const record = readRun(tmpFile);
  expect(record.status).toBe("completed");
  const id = record.meta.id;
  renameSync(tmpFile, join(traces, `${id}.jsonl`));
  return id;
}

/** 取 run 首次 llm.call span（返回 null 使断言明确失败，而不是吞掉类型） */
function firstLlm(spans: readonly unknown[]): {
  request: { messages: Array<{ role: string; content: unknown }> };
  response: { content: string | null };
} | null {
  for (const s of spans) {
    const span = s as {
      kind?: string;
      request?: { messages?: unknown[] };
      response?: { content?: string | null };
    };
    if (span.kind === "llm.call" && span.request?.messages && span.response) {
      return {
        request: { messages: span.request.messages as Array<{ role: string; content: unknown }> },
        response: { content: span.response.content ?? null },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. 普通创建（runs:create）
// ---------------------------------------------------------------------------

describe("6.4 受控服务回归：普通创建（runCreate）", () => {
  it("连到配置的 baseURL：恰一次 SSE 提交（空工具表），结果落盘进概览、预算门禁保留", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      await withMockLlm(
        { turns: [{ content: "时间旅行调试是…", usage: { in: 10, out: 5 } }] },
        async (h) => {
          // ⚠️ 不注入 llm：让 runCreate 自行 new 真实 OpenAiCompatClient，baseURL 指到受控服务
          const { id } = await runCreate(
            { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, execCwd: traces },
            { systemPrompt: SYSTEM, userMessage: TASK },
          );

          // 一次受控提交：恰好一条请求，格式正确
          const entries = h.entries();
          expect(h.served()).toBe(1);
          expect(entries).toHaveLength(1);
          const e = entries[0];
          expect(e?.path).toBe("/v1/chat/completions");
          expect(e?.stream).toBe(true); // 普通创建硬编码 stream:true（SSE）
          expect(e?.mode).toBe("sse");
          expect(e?.tools).toEqual([]); // 首期空工具表
          expect(e?.messages.map((m) => m.role)).toEqual(["system", "user"]);

          // 结果进入概览：落盘、completed、正文为受控响应、列表可见
          const record = repo.loadRunRecord(id);
          expect(record.meta.id).toBe(id);
          expect(record.status).toBe("completed");
          const llm = firstLlm(record.spans);
          expect(llm?.response.content).toBe("时间旅行调试是…");
          expect(repo.listRuns().runs.map((r) => r.id)).toContain(id);

          // 原配置/费用门禁：预算硬编码 100k 如实录制（费用门禁不因切受控服务被绕过）
          expect(record.meta.budget).toEqual(BUDGET);
          expect(tmpFiles(traces)).toEqual([]);
        },
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. result fork（runs:fork）
// ---------------------------------------------------------------------------

describe("6.4 受控服务回归：result fork（runFork）", () => {
  it("编辑 read_file result 重跑：恰一次提交，config_hash 一致、父文件逐字节不变、子 run 进概览", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const combined = [
        ...PARENT_TURNS, // 父 run 消耗 2 次
        { content: "基于编辑后的 result 完成。" }, // fork 消耗 1 次
      ];
      await withMockLlm({ turns: combined }, async (h) => {
        const parentId = await createParentViaService(traces, h.baseURL);
        const parentFile = join(traces, `${parentId}.jsonl`);
        const parentBefore = readFileSync(parentFile, "utf8");
        expect(h.served()).toBe(2); // 父 run 恰好两轮

        const parentRecord = repo.loadRunRecord(parentId);
        const toolSpan = parentRecord.spans.find((s) => s.kind === "tool.invoke");
        expect(toolSpan?.kind).toBe("tool.invoke");
        if (toolSpan?.kind !== "tool.invoke") return;
        const atSpanId = toolSpan.id;

        const { id } = await runFork(
          { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, execCwd: traces },
          { parentRunId: parentId, atSpanId, edit: { field: "result", value: NEW_README } },
        );

        // 一次受控提交：父之后恰好再多 1 条请求
        expect(h.served()).toBe(3);
        const forkEntry = h.entries()[2];
        expect(forkEntry?.path).toBe("/v1/chat/completions");
        expect(forkEntry?.stream).toBe(true);
        expect(forkEntry?.mode).toBe("sse");
        // 工具表从父 run 录制重建：read_file/write_file 都在请求里（原配置门禁）
        expect(forkEntry?.tools).toEqual(["read_file", "write_file"]);

        // 原配置门禁：config_hash 与父完全一致（重建自录制 ⇒ 不漂移）
        const forkRecord = repo.loadRunRecord(id);
        expect(forkRecord.meta.parent).toBe(parentId);
        expect(forkRecord.meta.config_hash).toBe(parentRecord.meta.config_hash);
        expect(forkRecord.meta.budget).toEqual(BUDGET);
        expect(forkRecord.status).toBe("completed");

        // 编辑后的 tool 消息带着新值进入模型上下文（本次 fork 的首次 llm.call 里）
        const forkLlm = firstLlm(forkRecord.spans);
        const editedTool = forkLlm?.request.messages.find((m) => m.role === "tool");
        expect(editedTool?.content).toBe(NEW_README);

        // 结果进入概览：子 run 被列表收录
        expect(repo.listRuns().runs.map((r) => r.id)).toContain(id);

        // 父记录未改写：逐字节不变
        expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
        expect(tmpFiles(traces)).toEqual([]);
      });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. prompt fork（runs:promptFork）
// ---------------------------------------------------------------------------

describe("6.4 受控服务回归：prompt fork（runPromptFork）", () => {
  it("编辑 system_prompt 从头重跑：恰一次提交，编辑值进入上下文、父文件不变、子 run 进概览", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const combined = [
        ...PARENT_TURNS, // 父 run 消耗 2 次
        { content: "遵守新约束：直接给出要点。" }, // prompt fork 消耗 1 次
      ];
      await withMockLlm({ turns: combined }, async (h) => {
        const parentId = await createParentViaService(traces, h.baseURL);
        const parentFile = join(traces, `${parentId}.jsonl`);
        const parentBefore = readFileSync(parentFile, "utf8");
        expect(h.served()).toBe(2);

        const { id } = await runPromptFork(
          { repository: repo, settings: { ...SETTINGS, baseURL: h.baseURL }, execCwd: traces },
          { parentRunId: parentId, edit: SYS_EDIT },
        );

        // 一次受控提交：父之后恰好再多 1 条请求
        expect(h.served()).toBe(3);
        const forkEntry = h.entries()[2];
        expect(forkEntry?.path).toBe("/v1/chat/completions");
        expect(forkEntry?.stream).toBe(true);
        expect(forkEntry?.mode).toBe("sse");
        // 工具表照抄父 run 首次 llm.call 录制
        expect(forkEntry?.tools).toEqual(["read_file", "write_file"]);
        // 编辑后的 system prompt 进入首条消息（角色序列 system+user）
        expect(forkEntry?.messages[0]?.role).toBe("system");

        const forkRecord = repo.loadRunRecord(id);
        expect(forkRecord.meta.parent).toBe(parentId);
        expect(forkRecord.meta.fork?.edit).toEqual(SYS_EDIT);
        expect(forkRecord.meta.budget).toEqual(BUDGET);
        expect(forkRecord.status).toBe("completed");

        // 启动上下文重建：首次 llm.call 的消息起点是"编辑后的 system"
        const forkLlm = firstLlm(forkRecord.spans);
        expect(forkLlm?.request.messages[0]?.content).toBe(SYS_EDIT.value);

        // 结果进入概览
        expect(repo.listRuns().runs.map((r) => r.id)).toContain(id);

        // 父记录未改写
        expect(readFileSync(parentFile, "utf8")).toBe(parentBefore);
        expect(tmpFiles(traces)).toEqual([]);
      });
    } finally {
      cleanup();
    }
  });
});
