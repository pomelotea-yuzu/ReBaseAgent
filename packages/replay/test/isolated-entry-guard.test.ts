import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunConfig } from "@rebaseagent/agent-loop";
import { readRun } from "@rebaseagent/trace-sdk";
import type { RunLoader } from "@rebaseagent/trace-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelAbError,
  findIsolatedParentViolation,
  loadForkParent,
  modelReplayRunMany,
  promptReplayRun,
  replayRun,
} from "../src/index";
import { makeConfig } from "./isolated-helpers";
import { round, writeIsolatedRun } from "./workspace-helpers";

/**
 * 4.5：普通执行入口的**隔离父本拒绝规则**（`isolated-guard.ts`）。
 *
 * 验证点（tasks.md 4.5）：`replay/普通入口不可降级隔离父本`、
 * `prompt-replay/隔离父本不能转普通 prompt fork`、`model-experiments/隔离实验无降级逃生通道`
 * （含 dry-run 与 allowSideEffects）。
 *
 * ## 为什么要有一份"对照组"
 *
 * 门禁最容易出的错不是"漏判"而是"误伤"——把普通 run 也拒了。所以每个拒绝用例旁边都有对照：
 * 非隔离 v1 父本走到的是**别的**错误（缺 config_hash），错误文本里不该出现"隔离"。
 *
 * ## 拒不了才是问题：零副作用也要断言
 *
 * 三个入口都在"创建 trace / 发起 LLM"之前判，因此每条拒绝用例都断言 `outDir` 里**没有多出文件**。
 */

const tempDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 一个 v2 隔离父本（真发布附件、真清单，含两轮检查点） */
async function makeIsolatedParent(): Promise<{
  readonly dataDir: string;
  readonly outDir: string;
  readonly runId: string;
  readonly atSpanId: string;
  readonly load: RunLoader;
}> {
  const dataDir = makeDir("guard-data-");
  const outDir = makeDir("guard-out-");
  const written = await writeIsolatedRun({
    dataDir,
    runId: "run_isolated_parent",
    rounds: [round([["a.txt", "middle"]]), round([["a.txt", "after"]])],
  });
  return {
    dataDir,
    outDir,
    runId: written.runId,
    atSpanId: written.toolSpanIds[0] ?? "",
    load: (id) => readRun(join(dataDir, "traces", `${id}.jsonl`)),
  };
}

/** 手写一个 v1 普通 run（无 workspace），用于"门禁不误伤"的对照 */
function writeV1Run(dir: string, runId: string, withToolSpan: boolean): void {
  const file = join(dir, `${runId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const lines: Array<Record<string, unknown>> = [
    {
      type: "run.meta",
      id: runId,
      format_version: 1,
      task: "普通 run",
      model: "deepseek-chat",
      created_at: "2026-09-19T00:00:00.000Z",
      parent: null,
      fork: null,
    },
    { type: "span", id: "s_01", parent: null, kind: "agent.step", n: 1 },
  ];
  if (withToolSpan) {
    lines.push({
      type: "span",
      id: "s_02",
      parent: "s_01",
      kind: "tool.invoke",
      tool: "read_file",
      args: { path: "a.txt" },
      result: "x",
      dur_ms: 1,
      error: null,
    });
  }
  lines.push({ type: "run.event", event: "stopped", reason: "completed", at: 0 });
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** 空工具表配置（隔离门禁发生在工具/配置校验之前，工具表用什么不影响本用例） */
function emptyToolConfig(): RunConfig {
  return { ...makeConfig(), tools: [] };
}

function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("4.5：隔离父本不得进入普通执行路径", () => {
  it("判定规则只看 meta：隔离 run 命中，普通 run 不命中", async () => {
    const isolated = await makeIsolatedParent();
    const isolatedRecord = readRun(join(isolated.dataDir, "traces", `${isolated.runId}.jsonl`));
    expect(findIsolatedParentViolation(isolatedRecord)).toContain("隔离 run");

    const plainDir = makeDir("guard-plain-");
    writeV1Run(plainDir, "run_v1_plain", false);
    expect(findIsolatedParentViolation(readRun(join(plainDir, "run_v1_plain.jsonl")))).toBeNull();
  });

  it("replayRun 拒绝隔离父本：零子 trace，且提示改用隔离续跑", async () => {
    const isolated = await makeIsolatedParent();

    const error = await replayRun({
      parentId: isolated.runId,
      atSpanId: isolated.atSpanId,
      edit: { field: "result", value: "改了" },
      config: emptyToolConfig(),
      tools: [],
      load: isolated.load,
      outDir: isolated.outDir,
    }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : null),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("隔离 run");
    expect(error?.message).toContain("replayIsolatedRun");
    // 明确禁止"删除 workspace 字段"这条降级路
    expect(error?.message).toContain("workspace");
    expect(filesIn(isolated.outDir)).toEqual([]);
  });

  it("普通 replayRun 不误伤非隔离父本：走到的是别的门禁（缺 config_hash）", async () => {
    const dir = makeDir("guard-plain-");
    const outDir = makeDir("guard-out-");
    writeV1Run(dir, "run_v1_plain", true);

    const error = await replayRun({
      parentId: "run_v1_plain",
      atSpanId: "s_02",
      edit: { field: "result", value: "改了" },
      config: emptyToolConfig(),
      tools: [],
      load: (id) => readRun(join(dir, `${id}.jsonl`)),
      outDir,
    }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : null),
    );

    expect(error).not.toBeNull();
    expect(error?.message).not.toContain("隔离 run");
    expect(error?.message).toContain("config_hash");
    expect(filesIn(outDir)).toEqual([]);
  });

  it("loadForkParent 拒绝隔离父本：提示本期不支持隔离 A/B", async () => {
    const isolated = await makeIsolatedParent();

    let message = "";
    try {
      loadForkParent(isolated.runId, isolated.load);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    expect(message).toContain("隔离 run");
    expect(message).toContain("A/B");
    expect(message).toContain("allowSideEffects");
  });

  it("promptReplayRun 拒绝隔离父本：不创建子 run、不发 LLM", async () => {
    const isolated = await makeIsolatedParent();
    const outDir = makeDir("guard-out-");

    const error = await promptReplayRun({
      parentId: isolated.runId,
      edit: { field: "user_message", value: "换个问题" },
      config: emptyToolConfig(),
      tools: [],
      load: isolated.load,
      outDir,
    }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : null),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("隔离 run");
    expect(filesIn(outDir)).toEqual([]);
  });
});

describe("4.5：模型 A/B 没有降级逃生通道", () => {
  const arms = [{ model: "deepseek-chat" }, { model: "deepseek-reasoner" }];

  it("整批拒绝：ModelAbError(PARENT_NOT_FORKABLE)，零运行文件", async () => {
    const isolated = await makeIsolatedParent();

    let caught: unknown = null;
    try {
      await modelReplayRunMany({
        parentId: isolated.runId,
        arms,
        config: emptyToolConfig(),
        tools: [],
        load: isolated.load,
        outDir: isolated.outDir,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ModelAbError);
    expect((caught as ModelAbError).code).toBe("PARENT_NOT_FORKABLE");
    expect((caught as ModelAbError).message).toContain("隔离 run");
    expect(filesIn(isolated.outDir)).toEqual([]);
  });

  it("dry-run 也照样拒绝（不构成逃生通道）", async () => {
    const isolated = await makeIsolatedParent();

    let caught: unknown = null;
    try {
      await modelReplayRunMany({
        parentId: isolated.runId,
        arms,
        config: emptyToolConfig(),
        tools: [],
        load: isolated.load,
        outDir: isolated.outDir,
        dryRun: true,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ModelAbError);
    expect((caught as ModelAbError).code).toBe("PARENT_NOT_FORKABLE");
    expect((caught as ModelAbError).message).toContain("隔离 run");
    expect(filesIn(isolated.outDir)).toEqual([]);
  });

  it("全部 arm 声明 allowSideEffects 也照样拒绝", async () => {
    const isolated = await makeIsolatedParent();

    let caught: unknown = null;
    try {
      await modelReplayRunMany({
        parentId: isolated.runId,
        arms: arms.map((arm) => ({ ...arm, allowSideEffects: true })),
        config: emptyToolConfig(),
        tools: [],
        load: isolated.load,
        outDir: isolated.outDir,
        confirmCost: true,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ModelAbError);
    expect((caught as ModelAbError).code).toBe("PARENT_NOT_FORKABLE");
    expect((caught as ModelAbError).message).toContain("隔离 A/B");
    expect(filesIn(isolated.outDir)).toEqual([]);
  });
});
