import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { runModelAb, runPromptFork } from "../src/main/fork-runner";
import { CREATE_RUN_ERROR_CODES, CreateRunError, runCreate } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";

/**
 * runs:create 编排测试：真实 runLoop + MockLlmClient（仓库既有约定：不 mock runLoop，
 * 否则测不到 meta 落盘、config_hash 现算与临时文件改名）。
 */

const SYSTEM = "你是一个简洁的问答助手，用两三句话回答。";
const TASK = "用一句话解释什么是时间旅行调试。";

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

/** 一轮即完成的纯对话剧本（无工具调用 ⇒ completed） */
function oneTurn(content: string): MockLlmClient {
  return new MockLlmClient([{ content, usage: { in: 10, out: 5 } }]);
}

function tempRepo(): { traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "run-create-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 临时文件（不带 .jsonl 后缀）不应出现在 traces 目录 */
function tmpFiles(traces: string): string[] {
  return readdirSync(traces).filter((name) => name.endsWith(".tmp"));
}

describe("runCreate：成功路径", () => {
  it("落盘为 ${meta.id}.jsonl，且是根 run（parent/fork 为 null、无 source）", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const { id } = await runCreate(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: oneTurn("时间旅行调试是…") },
        { systemPrompt: SYSTEM, userMessage: TASK },
      );

      // 文件名必须等于 meta.id：仓库按 `${id}.jsonl` 取文件（run-repository.ts:119）
      expect(id).toMatch(/^run_/);
      expect(existsSync(join(traces, `${id}.jsonl`))).toBe(true);

      const record = repo.loadRunRecord(id);
      expect(record.status).toBe("completed");
      expect(record.meta.id).toBe(id);
      expect(record.meta.parent).toBeNull();
      expect(record.meta.fork).toBeNull();
      // 与 SDK 直录同形：不写 source（列表归入"本地直录"）
      expect(record.meta.source).toBeUndefined();
      // meta.task 由 runLoop 从首条 user 消息派生（runLoop 无 task 入参）
      expect(record.meta.task).toBe(TASK);
      expect(record.meta.model).toBe(SETTINGS.model);
      // config_hash 由 runLoop 现算：configHash(systemPrompt, 空工具表)
      expect(record.meta.config_hash).toBe(configHash(SYSTEM, []));
      // 与既有 fork 一致的硬编码预算被如实录制
      expect(record.meta.budget).toEqual({ max_total_tokens: 100_000 });

      // 列表可见并归入本地直录
      const list = repo.listRuns();
      expect(list.failed).toEqual([]);
      expect(list.runs.map((r) => r.id)).toContain(id);
      expect(list.runs[0]?.source).toBeNull();

      expect(tmpFiles(traces)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('空 systemPrompt 允许：config_hash = configHash("", [])', async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const { id } = await runCreate(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: oneTurn("好的") },
        { systemPrompt: "", userMessage: TASK },
      );

      const record = repo.loadRunRecord(id);
      expect(record.status).toBe("completed");
      expect(record.meta.config_hash).toBe(configHash("", []));
      // 空 system 也必须留下字符串 system 消息，否则无法作 prompt fork 父本
      const first = record.spans.find((span) => span.kind === "llm.call");
      expect(first?.request.messages[0]).toEqual({ role: "system", content: "" });
      expect(tmpFiles(traces)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("runCreate：失败路径", () => {
  it("模型调用失败 → 抛 CREATE_RUN_FAILED，且 error run 仍按 meta.id 归位", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      // 空剧本 ⇒ MockLlmClient.complete 抛错 ⇒ runLoop 记 errored 并正常返回
      const failure = runCreate(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: new MockLlmClient([]) },
        { systemPrompt: SYSTEM, userMessage: TASK },
      );

      await expect(failure).rejects.toBeInstanceOf(CreateRunError);
      await failure.catch((e: unknown) => {
        expect((e as CreateRunError).code).toBe(CREATE_RUN_ERROR_CODES.RUN_FAILED);
      });

      // 文件归位：只有一个 .jsonl，且没有残留临时文件
      expect(tmpFiles(traces)).toEqual([]);
      const files = readdirSync(traces).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);

      const id = files[0]?.replace(/\.jsonl$/, "") ?? "";
      const record = repo.loadRunRecord(id);
      // status 只表示"是否有终止事件"，errored 也有终止事件 ⇒ completed；
      // 失败语义由终止原因表达（列表徽标显示"出错终止"）
      expect(record.status).toBe("completed");
      const summary = repo.listRuns().runs[0];
      expect(summary?.id).toBe(id);
      expect(summary?.reason).toBe("error");
      expect(record.meta.parent).toBeNull();

      // 失败原因已随失败 span 落盘（add-llm-error-detail）：点开 run 即可诊断，
      // 不必再翻主进程日志。无 HTTP 状态码的失败不写 status。
      const llmSpan = record.spans.find((span) => span.kind === "llm.call");
      const error = llmSpan?.kind === "llm.call" ? llmSpan.error : undefined;
      expect(error?.message).toContain("剧本耗尽");
      expect(error !== undefined && "status" in error).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("A1 验收：新建 run 可作为父本", () => {
  it("prompt fork：子 run 的 parent 指向新建 run", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parent = await runCreate(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: oneTurn("原始回答") },
        { systemPrompt: SYSTEM, userMessage: TASK },
      );

      const child = await runPromptFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: oneTurn("改过 prompt 的回答"),
        },
        { parentRunId: parent.id, edit: { field: "system_prompt", value: "你是严谨的助手。" } },
      );

      const childRecord = repo.loadRunRecord(child.id);
      expect(childRecord.status).toBe("completed");
      expect(childRecord.meta.parent).toBe(parent.id);
      expect(childRecord.meta.fork?.edit.field).toBe("system_prompt");
      // 新建 run 自身未被触碰
      expect(repo.loadRunRecord(parent.id).status).toBe("completed");
    } finally {
      cleanup();
    }
  });

  it("模型 A/B：两臂各自落盘，parent 与 config_hash 均指向新建 run", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parent = await runCreate(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: oneTurn("原始回答") },
        { systemPrompt: SYSTEM, userMessage: TASK },
      );

      // 两臂共用一份剧本：每臂一轮，顺序消费
      const arms = new MockLlmClient([{ content: "臂一" }, { content: "臂二" }]);
      const result = await runModelAb(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: arms },
        {
          parentRunId: parent.id,
          arms: [{ model: "m-a", params: { temperature: 0.2 } }, { model: "m-b" }],
        },
      );

      expect(result.ok).toBe(true);
      expect(result.ids).toHaveLength(2);
      const parentHash = repo.loadRunRecord(parent.id).meta.config_hash;
      for (const armId of result.ids) {
        const arm = repo.loadRunRecord(armId);
        expect(arm.meta.parent).toBe(parent.id);
        expect(arm.meta.fork?.edit.field).toBe("model_params");
        // 换 model/params 不改变 config_hash（只覆盖 systemPrompt + 工具表）
        expect(arm.meta.config_hash).toBe(parentHash);
      }
    } finally {
      cleanup();
    }
  });
});
