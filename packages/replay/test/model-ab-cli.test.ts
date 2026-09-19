import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLoop } from "@rebaseagent/agent-loop";
import type { RunConfig, Tool } from "@rebaseagent/agent-loop";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { describe, expect, it } from "vitest";
import { MockLlmClient, initialMessages, sampleConfig } from "../../agent-loop/test/helpers";
import { round, writeIsolatedRun } from "./workspace-helpers";

/**
 * CLI 冒烟测试（4.3）：真实 spawn 子进程跑 dist 产物，退出码契约 0/1/2。
 * 前置：packages/replay 与其 workspace 依赖已构建（tsc -p tsconfig.json）。
 * dist 缺失时整组跳过（测试不负责构建产物）。
 */
const CLI_PATH = resolve(import.meta.dirname, "../dist/model-ab-cli.js");
const skip = !existsSync(CLI_PATH);

const TASK = "读取 README.md 并把要点写入 summary.md";

/** 空工具表配置：CLI 首期只支持纯对话任务 */
function emptyToolConfig(): RunConfig {
  return sampleConfig({ tools: [] });
}

/** 带工具的配置：CLI 应拒绝并提示改用桌面端 */
function toolConfig(): { config: RunConfig; tools: Tool[] } {
  const tools: Tool[] = [
    {
      name: "read_file",
      description: "读取指定路径的文件",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      sideEffect: false,
      handler: (args) => `内容(${(args as { path: string }).path})`,
    },
  ];
  return { config: sampleConfig({ tools: tools.map(({ handler: _h, ...def }) => def) }), tools };
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "model-ab-cli-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 用真实 runLoop 生成 completed 父 run（mock LLM，零 API） */
async function createParent(dir: string, config: RunConfig, tools: Tool[]): Promise<string> {
  const tmp = join(dir, "tmp-parent.jsonl");
  await runLoop(
    config,
    initialMessages(TASK),
    new JsonlTracer(tmp),
    tools,
    new MockLlmClient([{ content: "父 run 完成。" }]),
  );
  const record = readRun(tmp);
  expect(record.status).toBe("completed");
  renameSync(tmp, join(dir, `${record.meta.id}.jsonl`));
  return record.meta.id;
}

function runCli(args: string[], env = process.env) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
  });
}

describe.skipIf(skip)("rebaseagent-model-ab CLI（dist 冒烟）", () => {
  it("dry-run：不需要密钥、不联网、不写文件，退出 0 且 JSON 报告含两臂计划", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir, emptyToolConfig(), []);
      const before = readdirSync(dir).sort();

      const proc = runCli([
        "--parent",
        parentId,
        "--dir",
        dir,
        "--arm",
        "model-a",
        "--arm",
        "model-b;temperature=0.2",
        "--dry-run",
        "--report",
        "json",
      ]);
      expect(proc.status).toBe(0);
      const report = JSON.parse(proc.stdout) as {
        dry_run: boolean;
        ok: boolean;
        experiment_id: string;
        plan: Array<{ model: string; changed: string[] }>;
        arms: unknown[];
      };
      expect(report.dry_run).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.experiment_id).toMatch(/^exp_/);
      expect(report.plan).toHaveLength(2);
      expect(report.plan[0]?.model).toBe("model-a");
      expect(report.plan[1]?.changed).toContain("params.temperature");
      expect(report.arms).toEqual([]);
      // 零文件：目录内容不变
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("父 run 带工具 → require_empty 拒绝（提示改用桌面端），退出 2、零调用", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { config, tools } = toolConfig();
      const parentId = await createParent(dir, config, tools);
      const before = readdirSync(dir).sort();

      const proc = runCli([
        "--parent",
        parentId,
        "--dir",
        dir,
        "--arm",
        "model-a",
        "--arm",
        "model-b",
        "--dry-run",
      ]);
      expect(proc.status).toBe(2);
      expect(proc.stderr).toContain("桌面端");
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("隔离父本 → 明确拒绝本期不支持隔离 A/B，退出 2、零文件", async () => {
    const { dir, cleanup } = tempDir();
    try {
      // CLI 的 --dir 就是 traces 目录：隔离 fixture 写在 <dataDir>/traces 下
      const dataDir = join(dir, "data");
      const written = await writeIsolatedRun({
        dataDir,
        runId: "run_isolated_parent",
        rounds: [round([["a.txt", "middle"]]), round([["a.txt", "after"]])],
      });
      const tracesDir = join(dataDir, "traces");
      const before = readdirSync(tracesDir).sort();

      const proc = runCli([
        "--parent",
        written.runId,
        "--dir",
        tracesDir,
        "--arm",
        "model-a",
        "--arm",
        "model-b",
        "--dry-run",
      ]);

      expect(proc.status).toBe(2);
      expect(proc.stderr).toContain("隔离 run");
      expect(proc.stderr).toContain("隔离 A/B");
      expect(readdirSync(tracesDir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("真实执行缺 REBASEAGENT_API_KEY → 退出 2（--dry-run 才豁免密钥）", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir, emptyToolConfig(), []);
      const env = { ...process.env };
      env.REBASEAGENT_API_KEY = undefined;

      const proc = runCli(
        [
          "--parent",
          parentId,
          "--dir",
          dir,
          "--arm",
          "model-a",
          "--arm",
          "model-b",
          "--base-url",
          "http://127.0.0.1:9/v1",
          "--confirm-cost",
        ],
        env,
      );
      expect(proc.status).toBe(2);
      expect(proc.stderr).toContain("REBASEAGENT_API_KEY");
    } finally {
      cleanup();
    }
  });

  it("单臂 / 缺必填参数 → 退出 2；--help 退出 0", () => {
    const tooFew = runCli(["--parent", "x", "--dir", "y", "--arm", "m1"]);
    expect(tooFew.status).toBe(2);

    const missing = runCli(["--arm", "m1", "--arm", "m2"]);
    expect(missing.status).toBe(2);

    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("rebaseagent-model-ab");
  });

  it("标量 arm 语法：布尔 / 引号强制字符串 / 原字符串均被接受并进入计划", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir, emptyToolConfig(), []);
      const proc = runCli([
        "--parent",
        parentId,
        "--dir",
        dir,
        "--arm",
        "m-a;reasoning_effort=none;think=false",
        "--arm",
        'm-b;level=high;k="123"',
        "--dry-run",
        "--report",
        "json",
      ]);
      expect(proc.status).toBe(0);
      const report = JSON.parse(proc.stdout) as {
        plan: Array<{ params: Record<string, unknown> }>;
      };
      // 规则 3 原字符串 + 规则 1 布尔
      expect(report.plan[0]?.params).toEqual({ reasoning_effort: "none", think: false });
      // 规则 4 引号强制字符串（"123" 不被吃成 number）；规则 3 原字符串
      expect(report.plan[1]?.params).toEqual({ level: "high", k: "123" });
    } finally {
      cleanup();
    }
  });

  it("文本输出含三段格式（生效 params / 丢弃父录值 / 告警）", async () => {
    const { dir, cleanup } = tempDir();
    try {
      // 父 run 录制 num_predict=768 与 num_ctx，某臂只给 temperature
      const config = emptyToolConfig();
      const tmp = join(dir, "tmp-parent.jsonl");
      await runLoop(
        config,
        initialMessages(TASK),
        new JsonlTracer(tmp),
        [],
        new MockLlmClient([{ content: "父 run 完成。" }]),
      );
      // 手工给父 run 补 params（runLoop 的 config.params 决定请求体）
      const record = readRun(tmp);
      renameSync(tmp, join(dir, `${record.meta.id}.jsonl`));

      const proc = runCli([
        "--parent",
        record.meta.id,
        "--dir",
        dir,
        "--arm",
        "m-a;temperature=0.7",
        "--arm",
        'm-b;num_ctx=8192;k="123"',
        "--dry-run",
        "--base-url",
        "http://127.0.0.1:11434/v1",
      ]);
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("生效 params");
      expect(proc.stdout).toContain("arm 1");
      expect(proc.stdout).toContain("arm 2");
      // 引号强制字符串在文本输出中也带引号（与数字可区分）
      expect(proc.stdout).toContain('k="123"');
    } finally {
      cleanup();
    }
  });

  it("非法转义与未闭合引号 → 退出 2 并给出中文错误", () => {
    const badEscape = runCli([
      "--parent",
      "x",
      "--dir",
      "y",
      "--arm",
      'm1;k="a\\nb"',
      "--arm",
      "m2",
      "--dry-run",
    ]);
    expect(badEscape.status).toBe(2);
    expect(badEscape.stderr).toContain("不支持的转义");

    const unclosed = runCli([
      "--parent",
      "x",
      "--dir",
      "y",
      "--arm",
      'm1;k="a"b"',
      "--arm",
      "m2",
      "--dry-run",
    ]);
    expect(unclosed.status).toBe(2);
    expect(unclosed.stderr).toMatch(/引号|裸引号/);
  });

  it("既有数值 arm 语法回归：temperature=0.2 仍解析为 number", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const parentId = await createParent(dir, emptyToolConfig(), []);
      const proc = runCli([
        "--parent",
        parentId,
        "--dir",
        dir,
        "--arm",
        "m-a;temperature=0.2;top_p=0.9",
        "--arm",
        "m-b",
        "--dry-run",
        "--report",
        "json",
      ]);
      expect(proc.status).toBe(0);
      const report = JSON.parse(proc.stdout) as {
        plan: Array<{ params: Record<string, unknown> }>;
      };
      expect(report.plan[0]?.params).toEqual({ temperature: 0.2, top_p: 0.9 });
    } finally {
      cleanup();
    }
  });
});
