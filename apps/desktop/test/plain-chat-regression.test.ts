import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { configHash } from "@rebaseagent/agent-loop";
import { runTraceTest } from "@rebaseagent/trace-test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { runModelAb, runPromptFork } from "../src/main/fork-runner";
import { runCreate } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";
import {
  COLLAPSE_THRESHOLD,
  LongText,
  collapsedLabel,
  shouldCollapse,
} from "../src/renderer/src/components/LongText";

/**
 * B 任务 3.1：桌面**纯对话**能力回归（新建 run 及其后续操作）。
 *
 * 覆盖场景（change add-sandboxed-rerun-desktop，specs/desktop-ui）：
 * - `新建 run 作为父本进行 prompt fork`（子 parent 指向它，既有 prompt fork 行为不变）
 * - `新建 run 作为父本进行模型 A/B`（各臂 parent 指向它、config_hash 与父一致）
 * - `新建 run 作为父本进行 trace-test`（**跨包**：桌面产出的 trace 直接当卡带，零网络零落盘）
 * - `超长消息`（默认折叠、展开为完整原文、录制侧不截断）
 *
 * 回归的判据是"**行为不变 + 产物形态不变**"：纯对话 run 必须仍是 v1、空工具表、无隔离
 * 元数据（A 段新增的能力不得渗进原形态）。隔离 run 作为卡带的形态由 trace-test 包自己的
 * `isolated-cassette.test.ts` 覆盖，不在此重复。
 *
 * ⚠️ 本文件通过 `@rebaseagent/trace-test`（devDependency，指向 packages/trace-test/dist）
 * 做跨包回归 ⇒ **必须先 build 再跑测试**（与 check:ci 的顺序一致；单独跑本文件前若没 build，
 * 会报模块解析失败，那不是用例失败）。
 */

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

const SYSTEM = "你是一个简洁的问答助手，用两三句话回答。";
const TASK = "用一句话解释什么是时间旅行调试。";

function oneTurn(content: string): MockLlmClient {
  return new MockLlmClient([{ content, usage: { in: 10, out: 5 } }]);
}

/** 纯对话 run 的配置（trace-test 的 config 必须与录制的 config_hash 同源） */
function chatConfig(systemPrompt: string, cwd: string) {
  return {
    baseURL: SETTINGS.baseURL,
    apiKey: SETTINGS.apiKey,
    model: SETTINGS.model,
    systemPrompt,
    tools: [],
    exec: { cwd, signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100_000 },
  };
}

function tempRepo(): { root: string; traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "plain-chat-regression-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    root,
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 目录全树指纹（相对路径 + 内容哈希）：判"零落盘/字节不变" */
function treeFingerprint(dir: string): string {
  const acc: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(dir, full).replace(/\\/g, "/");
      acc.push(`${rel} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir);
  return acc.join("\n");
}

async function createChatRun(
  traces: string,
  repo: RunRepository,
  llm: MockLlmClient,
): Promise<string> {
  const { id } = await runCreate(
    { repository: repo, settings: SETTINGS, execCwd: traces, llm },
    { systemPrompt: SYSTEM, userMessage: TASK },
  );
  return id;
}

describe("3.1 纯对话 run 的形态不变（A 段能力不渗入原形态）", () => {
  it("v1 + 空工具表 + 无隔离元数据；列表可见且归入本地直录", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const id = await createChatRun(traces, repo, oneTurn("时间旅行调试是…"));
      const record = repo.loadRunRecord(id);

      expect(record.meta.format_version).toBe(1);
      expect(record.meta.workspace).toBeUndefined();
      expect(record.meta.parent).toBeNull();
      expect(record.meta.fork).toBeNull();
      expect(record.meta.config_hash).toBe(configHash(SYSTEM, []));
      // 空工具表：录制的请求里没有工具表（或为空），prompt fork 仍可重建 RunConfig
      const first = record.spans.find((s) => s.kind === "llm.call");
      if (first?.kind !== "llm.call") throw new Error("缺少 llm.call");
      expect(first.request.tools ?? []).toHaveLength(0);
      expect(record.meta.task).toBe(TASK);

      const list = repo.listRuns();
      expect(list.failed).toEqual([]);
      expect(list.runs.map((r) => r.id)).toContain(id);
      expect(list.runs[0]?.source).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("3.1 新建 run 作为父本（prompt fork / 模型 A/B）", () => {
  it("prompt fork：子 parent 指向新建 run，父文件逐字节不变", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createChatRun(traces, repo, oneTurn("原始回答"));
      const before = treeFingerprint(traces);

      const child = await runPromptFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: oneTurn("改过 prompt 的回答"),
        },
        { parentRunId: parentId, edit: { field: "system_prompt", value: "你是严谨的助手。" } },
      );

      const childRecord = repo.loadRunRecord(child.id);
      expect(childRecord.status).toBe("completed");
      expect(childRecord.meta.parent).toBe(parentId);
      expect(childRecord.meta.fork?.edit.field).toBe("system_prompt");
      // 父 run 自身形态不变（v1、无隔离元数据、无 fork 字段）
      const parentRecord = repo.loadRunRecord(parentId);
      expect(parentRecord.meta.fork).toBeNull();
      expect(parentRecord.meta.workspace).toBeUndefined();
      // 只有父文件与新增子文件；父文件哈希不变
      expect(treeFingerprint(traces)).toContain(before);
    } finally {
      cleanup();
    }
  });

  it("模型 A/B：两臂各自落盘，parent 与 config_hash 均指向新建 run", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createChatRun(traces, repo, oneTurn("原始回答"));
      const parentHash = repo.loadRunRecord(parentId).meta.config_hash;

      const arms = new MockLlmClient([{ content: "臂一" }, { content: "臂二" }]);
      const result = await runModelAb(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: arms },
        {
          parentRunId: parentId,
          arms: [{ model: "m-a", params: { temperature: 0.2 } }, { model: "m-b" }],
        },
      );

      expect(result.ok).toBe(true);
      expect(result.ids).toHaveLength(2);
      for (const armId of result.ids) {
        const arm = repo.loadRunRecord(armId);
        expect(arm.meta.parent).toBe(parentId);
        expect(arm.meta.fork?.edit.field).toBe("model_params");
        // 换 model/params 不改变 config_hash（只覆盖 systemPrompt + 工具表）
        expect(arm.meta.config_hash).toBe(parentHash);
        expect(arm.meta.workspace).toBeUndefined();
      }
    } finally {
      cleanup();
    }
  });
});

describe("3.1 新建 run 作为父本做 trace-test（跨包卡带回归）", () => {
  it("桌面产出的 trace 直接当卡带：passed / cassette / 配置无漂移，且零落盘", async () => {
    const { root, traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createChatRun(traces, repo, oneTurn("时间旅行调试是…"));
      // 定义文件放在 traces 之外：断言"零落盘"时 traces 目录必须一个字节都没多
      const definitionPath = join(root, "chat.json");
      writeFileSync(
        definitionPath,
        JSON.stringify(
          {
            format_version: 1,
            name: "纯对话基线",
            trace: join(traces, `${parentId}.jsonl`),
            assertions: [
              { type: "run.outcome", equals: "completed" },
              { type: "span.exists", selector: { kind: "llm.call" } },
              { type: "span.count", selector: { kind: "tool.invoke" }, equals: 0 },
            ],
          },
          null,
          2,
        ),
      );

      const before = treeFingerprint(root);
      const result = await runTraceTest(definitionPath, {
        config: chatConfig(SYSTEM, traces),
        tools: [],
      });

      expect(result.mode).toBe("cassette");
      expect(result.status).toBe("passed");
      expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
      // 配置与录制同源（空工具表 + 同一 system prompt ⇒ 同一 config_hash）
      expect(result.configDrift).toBeNull();
      expect(result.alignment?.aligned).toBe(true);
      // 卡带重跑产生的是**内存里的新 run**，不覆盖基线
      expect(result.runId).not.toBe(parentId);
      expect(existsSync(join(traces, `${parentId}.jsonl`))).toBe(true);
      // 零落盘：整棵临时目录（含 traces 与定义文件）逐字节不变
      expect(treeFingerprint(root)).toBe(before);
    } finally {
      cleanup();
    }
  });

  it("对照：工具声明与基线不匹配时 trace-test 会报配置漂移（不是永远通过）", async () => {
    const { root, traces, repo, cleanup } = tempRepo();
    try {
      const parentId = await createChatRun(traces, repo, oneTurn("回答"));
      const definitionPath = join(root, "drift.json");
      writeFileSync(
        definitionPath,
        JSON.stringify({
          format_version: 1,
          name: "漂移对照",
          trace: join(traces, `${parentId}.jsonl`),
          assertions: [{ type: "run.outcome", equals: "completed" }],
        }),
      );

      const result = await runTraceTest(definitionPath, {
        // 换 system prompt ⇒ config_hash 不同 ⇒ 必须报漂移（卡带重跑仍会跑，但漂移可见）
        config: chatConfig("换了一个 system prompt。", traces),
        tools: [],
      });

      expect(result.configDrift).not.toBeNull();
      expect(result.configDrift?.recorded).toBe(configHash(SYSTEM, []));
      expect(result.configDrift?.current).toBe(configHash("换了一个 system prompt。", []));
    } finally {
      cleanup();
    }
  });
});

describe("3.1 超长消息（折叠判据 + 展开为完整原文 + 录制不截断）", () => {
  it("折叠判据与摘要文案：严格大于阈值才折叠，摘要带真实字符数", () => {
    expect(shouldCollapse("a".repeat(COLLAPSE_THRESHOLD))).toBe(false);
    expect(shouldCollapse("a".repeat(COLLAPSE_THRESHOLD + 1))).toBe(true);
    expect(collapsedLabel("a".repeat(COLLAPSE_THRESHOLD + 1), "正文")).toBe(
      `正文（${COLLAPSE_THRESHOLD + 1} 字符，点击展开完整内容）`,
    );
  });

  it("渲染：短文本直接呈现；超长文本折叠但**完整原文就在 DOM 里**（展开即可见，无截断）", () => {
    const short = "短短一行。";
    const shortMarkup = renderToStaticMarkup(
      createElement(LongText, { text: short, label: "正文" }),
    );
    expect(shortMarkup).toContain(short);
    expect(shortMarkup).not.toContain("<details");

    const head = "【开头】";
    const tail = "【结尾·最后一段必须原样保留】";
    const long = head + "长".repeat(900) + tail;
    const longMarkup = renderToStaticMarkup(createElement(LongText, { text: long, label: "正文" }));
    expect(longMarkup).toContain("<details");
    expect(longMarkup).toContain(`正文（${long.length} 字符，点击展开完整内容）`);
    // 展开后是完整原文：开头、结尾与全文字符数都在标记里（没有被 slice/省略号取代）
    expect(longMarkup).toContain(head);
    expect(longMarkup).toContain(tail);
    expect(longMarkup.match(/长/g)).toHaveLength(900);
  });

  it("数据层不截断：超长 user message 原样落盘（task 与首条 user 消息逐字符相同）", async () => {
    const { traces, repo, cleanup } = tempRepo();
    try {
      const longTask = `【长任务开头】${"请逐步分析并给出结论。".repeat(80)}【长任务结尾】`;
      expect(longTask.length).toBeGreaterThan(COLLAPSE_THRESHOLD);

      const { id } = await runCreate(
        { repository: repo, settings: SETTINGS, execCwd: traces, llm: oneTurn("好") },
        { systemPrompt: "", userMessage: longTask },
      );
      const record = repo.loadRunRecord(id);
      // 列表标题就是这段文字：不得被截断成半句
      expect(record.meta.task).toBe(longTask);
      const first = record.spans.find((s) => s.kind === "llm.call");
      if (first?.kind !== "llm.call") throw new Error("缺少 llm.call");
      expect(first.request.messages[1]).toEqual({ role: "user", content: longTask });
      expect(repo.listRuns().runs[0]?.task).toBe(longTask);
    } finally {
      cleanup();
    }
  });
});
