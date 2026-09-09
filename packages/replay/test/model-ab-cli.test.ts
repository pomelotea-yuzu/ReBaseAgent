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
});
