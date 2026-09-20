import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunConfig } from "@rebaseagent/agent-loop";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { MockLlmClient } from "../../../packages/agent-loop/test/helpers";
import { runFork, runModelAb, runPromptFork } from "../src/main/fork-runner";
import { RunRepository } from "../src/main/run-repository";
import type { RunSettings } from "../src/main/settings";

/**
 * B 任务 1.2：隔离父本不得进入桌面的**普通**执行路径。
 *
 * A 段在包层只留了两处判定（`replayRun` 与 `loadForkParent`，后者是 prompt fork 与
 * 模型 A/B 的共用入口）；桌面三个编排器（runFork / runPromptFork / runModelAb）最终
 * 都汇入这两处。本文件用**真跑出来的**隔离父本（`createIsolatedRun`，非手搭 JSONL 桩）
 * 从桌面编排层逐个撞门禁，并钉住"dry-run / allowSideEffects 不是逃生通道"——
 * 这两条依赖 modelReplayRunMany 内部的步骤顺序（父本门禁第 3 步 < 工具策略第 6 步 <
 * dry-run 第 8 步），将来挪动顺序时这里必须先红。
 *
 * 隔离分叉的**正路**（execution 模式 → replayIsolatedRun）由任务 1.4 接入，不在本文件。
 */

const SETTINGS: RunSettings = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  encrypted: true,
};

function isolatedConfig(): RunConfig {
  return {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-chat",
    systemPrompt: "你是文件助手。",
    tools: [...FILE_TOOLS_V1_DEFINITIONS],
    params: undefined,
    exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
    maxIterations: 10,
    budget: { maxTotalTokens: 100000 },
  };
}

async function tempWithIsolatedParent(): Promise<{
  root: string;
  dataDir: string;
  parentId: string;
  writeSpanId: string;
  cleanup: () => void;
}> {
  const outer = mkdtempSync(join(tmpdir(), "isolated-parent-rejection-"));
  // 源目录与数据目录必须互为兄弟（A 的 validateSourceRoot 拒绝嵌套）
  const dataDir = join(outer, "data");
  const source = join(outer, "source");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "a.txt"), "alpha 内容");
  writeFileSync(join(source, "keep.txt"), "keep");

  const result = await createIsolatedRun({
    dataDir,
    source,
    config: isolatedConfig(),
    userMessage: "读取 a.txt 并把要点写入 b.txt",
    authority: { allowFileWrites: true },
    llm: new MockLlmClient([
      { toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }] },
      { toolCalls: [{ id: "c2", name: "write_file", args: '{"path":"b.txt","content":"beta"}' }] },
      { content: "任务完成。" },
    ]),
  });
  if (!result.ok) {
    rmSync(outer, { recursive: true, force: true });
    throw new Error(`createIsolatedRun 失败：${result.failure.code} ${result.failure.reason}`);
  }

  const record = readRun(join(dataDir, "traces", `${result.id}.jsonl`));
  const writeSpan = record.spans.find((s) => s.kind === "tool.invoke" && s.tool === "write_file");
  if (writeSpan?.kind !== "tool.invoke") {
    rmSync(outer, { recursive: true, force: true });
    throw new Error("隔离父本缺少 write_file span（fixture 剧本坏了）");
  }
  return {
    root: dataDir,
    dataDir,
    parentId: result.id,
    writeSpanId: writeSpan.id,
    cleanup: () => rmSync(outer, { recursive: true, force: true }),
  };
}

describe("隔离父本与桌面普通执行路径（B 1.2）", () => {
  it("隔离父本出现在桌面 run 列表（v2 根 run 可被 RunRepository 正常扫描）", async () => {
    const { root, parentId, cleanup } = await tempWithIsolatedParent();
    try {
      const repo = new RunRepository(join(root, "traces"));
      const { runs, failed } = repo.listRuns();
      expect(failed).toEqual([]);
      expect(runs.map((r) => r.id)).toContain(parentId);
    } finally {
      cleanup();
    }
  });

  it("runFork（普通 result 分叉）→ 拒绝，不落盘、零 LLM 调用", async () => {
    const { root, parentId, writeSpanId, cleanup } = await tempWithIsolatedParent();
    try {
      const repo = new RunRepository(join(root, "traces"));
      const before = readdirSnapshot(join(root, "traces"));
      const mock = new MockLlmClient([]);
      await expect(
        runFork(
          { repository: repo, settings: SETTINGS, execCwd: root, llm: mock },
          { parentRunId: parentId, atSpanId: writeSpanId, edit: { field: "result", value: "改" } },
        ),
      ).rejects.toThrow(/隔离/);
      expect(mock.requests).toHaveLength(0);
      expect(readdirSnapshot(join(root, "traces"))).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("runPromptFork（system prompt 编辑）→ 拒绝（与 prompt fork 共用 loadForkParent 门禁）", async () => {
    const { root, parentId, cleanup } = await tempWithIsolatedParent();
    try {
      const repo = new RunRepository(join(root, "traces"));
      const mock = new MockLlmClient([]);
      await expect(
        runPromptFork(
          { repository: repo, settings: SETTINGS, execCwd: root, llm: mock },
          {
            parentRunId: parentId,
            edit: { field: "system_prompt", value: "换一个 system prompt" },
          },
        ),
      ).rejects.toThrow(/隔离/);
      expect(mock.requests).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("runModelAb dry-run（每臂 allowSideEffects:true）→ PARENT_NOT_FORKABLE（dry-run 不是逃生通道）", async () => {
    const { root, parentId, cleanup } = await tempWithIsolatedParent();
    try {
      const repo = new RunRepository(join(root, "traces"));
      await expect(
        runModelAb(
          { repository: repo, settings: SETTINGS },
          {
            parentRunId: parentId,
            arms: [
              { model: "m-a", allowSideEffects: true },
              { model: "m-b", allowSideEffects: true },
            ],
            dryRun: true,
          },
        ),
      ).rejects.toMatchObject({ code: "PARENT_NOT_FORKABLE" });
    } finally {
      cleanup();
    }
  });

  it("runModelAb 真实执行（confirmCost + allowSideEffects）→ 同样拒绝（授权不越隔离门禁）", async () => {
    const { root, parentId, cleanup } = await tempWithIsolatedParent();
    try {
      const repo = new RunRepository(join(root, "traces"));
      await expect(
        runModelAb(
          { repository: repo, settings: SETTINGS },
          {
            parentRunId: parentId,
            arms: [
              { model: "m-a", allowSideEffects: true },
              { model: "m-b", allowSideEffects: true },
            ],
            dryRun: false,
            confirmCost: true,
          },
        ),
      ).rejects.toMatchObject({ code: "PARENT_NOT_FORKABLE" });
    } finally {
      cleanup();
    }
  });
});

/** traces 目录的文件名清单（判"拒绝路径零落盘"用） */
function readdirSnapshot(dir: string): string[] {
  return readdirSync(dir).sort();
}
