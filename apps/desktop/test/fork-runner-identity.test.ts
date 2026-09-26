import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import {
  MockLlmClient,
  initialMessages,
  sampleConfig,
  sampleTools,
} from "../../../packages/agent-loop/test/helpers";
import { runFork, runForkIsolated, runModelAb, runPromptFork } from "../src/main/fork-runner";
import { runCreateIsolated } from "../src/main/run-create";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";

/**
 * U4 任务 2.8：fork-runner 把包层身份回调传到 main，并给 A/B 补齐完整臂事实。
 *
 * 判据来源：tasks.md 2.8 + design D5；delta spec `desktop-ui` / `model-experiments`。
 * 验收场景（delta 逐字标题）：
 * - 「分叉在已知身份后异常仍可关联」——普通 result / 隔离 result / prompt 三条路径
 *   都恰好收到一次**实际落盘记录**的 id（等于 meta.id；隔离路径还要等于 world_id），
 *   且发生在该次执行的首个模型调用之前；
 * - 「A-B 部分失败保留各臂事实」——`armFacts` 覆盖每一条臂（含失败臂的真实 id 与结局），
 *   而旧 `ids` 仍只数成功臂：失败臂有落盘记录也不被混报成成功。
 *
 * 真跑 runLoop + MockLlmClient（仓库约定），零真实 API。
 */

const TASK = "读取 README.md 并把要点写入 summary.md";
const CONFIG = sampleConfig();
const TOOLS: Tool[] = sampleTools();
const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};
const PARENT_SCRIPT = [
  { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"README.md"}' }] },
  { content: "任务完成：要点已写入 summary.md。" },
];
const ONE_TURN = [{ content: "一步答完。" }];

/** 全 pure 工具表：模型 A/B 的默认工具策略只允许这种形状（与 fork-runner 既有夹具同口径） */
const PURE_TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => `内容(${(args as { path: string }).path})`,
  },
];

function tempRoot(): { root: string; traces: string; repo: RunRepository; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "fork-identity-"));
  const traces = join(root, "traces");
  mkdirSync(traces);
  return {
    root,
    traces,
    repo: new RunRepository(traces),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 现造一个 completed 父 run（read_file → 收尾），返回 id 与其 tool.invoke span id */
async function createParent(traces: string): Promise<{ parentId: string; atSpanId: string }> {
  const tmpFile = join(traces, "tmp-parent.jsonl");
  await runLoop(
    CONFIG,
    initialMessages(TASK),
    new JsonlTracer(tmpFile),
    TOOLS,
    new MockLlmClient(PARENT_SCRIPT),
  );
  const record = readRun(tmpFile);
  const toolSpan = record.spans.find((span) => span.kind === "tool.invoke");
  if (toolSpan === undefined) throw new Error("unreachable：父剧本必有 tool.invoke");
  renameSync(tmpFile, join(traces, `${record.meta.id}.jsonl`));
  return { parentId: record.meta.id, atSpanId: toolSpan.id };
}

function jsonlIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

/** 模型 A/B 的父 run：纯工具表 + 带 params 的首次请求（策略与 discarded 都有来源） */
async function createPureParent(traces: string): Promise<string> {
  const pureConfig: typeof CONFIG = {
    ...CONFIG,
    tools: PURE_TOOLS.map(({ handler: _handler, ...definition }) => definition),
    params: { temperature: 0.5, num_predict: 768 },
  };
  const tmpFile = join(traces, "tmp-pure-parent.jsonl");
  await runLoop(
    pureConfig,
    initialMessages(TASK),
    new JsonlTracer(tmpFile),
    PURE_TOOLS,
    new MockLlmClient([{ content: "父 run 完成。" }]),
  );
  const parentId = readRun(tmpFile).meta.id;
  renameSync(tmpFile, join(traces, `${parentId}.jsonl`));
  return parentId;
}

describe("U4 2.8 分叉路径的身份传递", () => {
  it("普通 result 分叉：回调恰一次 = 落盘 meta.id，且先于子首个模型调用", async () => {
    const { traces, repo, cleanup } = tempRoot();
    try {
      const parent = await createParent(traces);
      const llm = new MockLlmClient(ONE_TURN);
      const seen: { id: string; calls: number }[] = [];
      const result = await runFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm,
          onRunIdentified: (id) => {
            seen.push({ id, calls: llm.requests.length });
          },
        },
        {
          parentRunId: parent.parentId,
          atSpanId: parent.atSpanId,
          edit: { field: "result", value: "# 编辑后的历史" },
        },
      );
      expect(seen).toEqual([{ id: result.id, calls: 0 }]);
      expect(repo.loadRunRecord(result.id).meta.id).toBe(result.id);
      expect(jsonlIn(traces)).toEqual([`${parent.parentId}.jsonl`, `${result.id}.jsonl`]);
    } finally {
      cleanup();
    }
  });

  it("prompt 分叉：回调恰一次 = 新记录 meta.id（独立轨迹，不复用父 id）", async () => {
    const { traces, repo, cleanup } = tempRoot();
    try {
      const parent = await createParent(traces);
      const seen: string[] = [];
      const result = await runPromptFork(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(ONE_TURN),
          onRunIdentified: (id) => {
            seen.push(id);
          },
        },
        {
          parentRunId: parent.parentId,
          edit: { field: "user_message", value: "换个问法重跑一次" },
        },
      );
      expect(seen).toEqual([result.id]);
      const record = repo.loadRunRecord(result.id);
      expect(record.meta.id).toBe(result.id);
      expect(record.meta.parent).toBe(parent.parentId);
      // 从头执行 ⇒ 独立轨迹：首 span 从 s_01 起，不继承父序号
      expect(record.spans[0]?.id).toBe("s_01");
    } finally {
      cleanup();
    }
  });

  it("隔离 result 续跑：回调给的是最终世界身份（meta.id == world_id，且不等于父 id）", async () => {
    const { root, cleanup } = tempRoot();
    const dataDir = join(root, "data");
    const source = join(root, "source");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "a.txt"), "alpha");
    const tracesDir = join(dataDir, "traces");
    const repo = new RunRepository(tracesDir);
    try {
      const created = await runCreateIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: dataDir,
          dataDir,
          sourcePath: source,
          llm: new MockLlmClient([
            { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }] },
            { content: "父完成。" },
          ]),
        },
        {
          systemPrompt: "",
          userMessage: "读一下 a.txt",
          workspace: { mode: "isolated_files", sourceToken: "t", allowFileWrites: true },
        },
      );
      const parentRecord = readRun(join(tracesDir, `${created.id}.jsonl`));
      const parentTool = parentRecord.spans.find((span) => span.kind === "tool.invoke");
      if (parentTool === undefined) throw new Error("unreachable：隔离父本必有 tool.invoke");

      const seen: string[] = [];
      const result = await runForkIsolated(
        {
          repository: repo,
          settings: SETTINGS,
          dataDir,
          llm: new MockLlmClient([{ content: "续跑一步完成。" }]),
          onRunIdentified: (id) => {
            seen.push(id);
          },
        },
        {
          parentRunId: created.id,
          atSpanId: parentTool.id,
          edit: { field: "result", value: "编辑后的读取结果" },
          execution: { mode: "isolated_files", allowFileWrites: true },
        },
      );
      expect(seen).toEqual([result.id]);
      const child = readRun(join(tracesDir, `${result.id}.jsonl`));
      expect(child.meta.id).toBe(result.id);
      expect(child.meta.workspace?.world_id).toBe(result.id);
      expect(result.id).not.toBe(created.id);
      // 父世界与源都不动：traces 目录只剩父 + 子两条记录
      expect(jsonlIn(tracesDir).sort()).toEqual(
        [`${created.id}.jsonl`, `${result.id}.jsonl`].sort(),
      );
    } finally {
      cleanup();
    }
  });
});

describe("U4 2.8 A/B 的按臂事实", () => {
  it("部分失败：armFacts 覆盖每一臂（失败臂保留真实 id），ids 仍只数成功臂", async () => {
    const { traces, repo, cleanup } = tempRoot();
    try {
      const parentId = await createPureParent(traces);

      const notes: { experimentId: string; index: number; id: string }[] = [];
      // 共享一个只有一轮剧本的客户端：臂 0 正常，臂 1 起剧本耗尽 ⇒ 该臂 errored 但仍落盘
      const result = await runModelAb(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient([{ content: "臂 0 完成。" }]),
          onArmRunIdentified: (info) => {
            notes.push({ experimentId: info.experimentId, index: info.index, id: info.id });
          },
        },
        { parentRunId: parentId, arms: [{ model: "m-a" }, { model: "m-b" }, { model: "m-c" }] },
      );

      expect(result.ok).toBe(false);
      expect(result.armFacts.map((fact) => fact.index)).toEqual([0, 1, 2]);
      expect(result.armFacts[0]?.outcome).toBe("returned");
      expect(result.armFacts[1]?.outcome).toBe("failed");
      expect(result.armFacts[2]?.outcome).toBe("failed");
      // 失败臂的身份不被抹掉——记录确实落盘了
      for (const fact of result.armFacts) {
        expect(fact.id, String(fact.index)).toMatch(/^run_/);
        if (fact.id !== null) expect(jsonlIn(traces)).toContain(`${fact.id}.jsonl`);
      }
      // 旧口径保持不变：只含成功臂
      expect(result.ids).toEqual([result.armFacts[0]?.id]);
      expect(notes.map((note) => note.index)).toEqual([0, 1, 2]);
      expect(notes.map((note) => note.id)).toEqual(result.armFacts.map((fact) => fact.id));
      expect(new Set(notes.map((note) => note.experimentId)).size).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("dry-run：零臂身份通知、零新文件、armFacts 为空", async () => {
    const { traces, repo, cleanup } = tempRoot();
    try {
      const parentId = await createPureParent(traces);
      let notes = 0;
      const before = jsonlIn(traces);
      const result = await runModelAb(
        {
          repository: repo,
          settings: SETTINGS,
          execCwd: traces,
          llm: new MockLlmClient(ONE_TURN),
          onArmRunIdentified: () => {
            notes += 1;
          },
        },
        { parentRunId: parentId, arms: [{ model: "m-a" }, { model: "m-b" }], dryRun: true },
      );
      expect(result.ok).toBe(true);
      expect(result.ids).toEqual([]);
      expect(result.armFacts).toEqual([]);
      expect(result.plan).toHaveLength(2);
      expect(notes).toBe(0);
      expect(jsonlIn(traces)).toEqual(before);
    } finally {
      cleanup();
    }
  });
});
