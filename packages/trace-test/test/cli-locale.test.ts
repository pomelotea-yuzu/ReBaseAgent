import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTraceBaseline } from "../src/run-test.js";
import { cannedResponse, fakeConfig, fakeTools, recordRun, toolCall } from "./helpers.js";

/**
 * i18n 5.5（C01/C02/C04）：真实 dist CLI 的两语言人类报告与稳定 JSON。
 *
 * - 人类模式：帮助、隐私、状态、断言差异、漂移与汇总按 --locale 投影；
 * - JSON 模式：stdout 只有一份报告，两语言解析后深度相等；断言 detail 保持
 *   既有原文（机器契约），不携带人类显示字段；
 * - 非法 locale 在加载用户模块/写 baseline 之前失败；baseline 文本反馈走 stderr。
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NODE = process.execPath;

const normalScript = [
  cannedResponse({ toolCalls: [toolCall("c1", "read_file", { path: "a.json" })] }),
  cannedResponse({ content: "完成" }),
];

const CONFIG_MODULE = `
export const tools = [
  {
    name: "read_file",
    description: "读取指定路径的文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sideEffect: false,
    handler: (args) => \`内容(\${args.path})\`,
  },
  {
    name: "write_file",
    description: "把内容写入指定路径",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    handler: (args) => \`已写入 \${args.path}\`,
  },
];
export const config = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-chat",
  systemPrompt: "你是文件助手。",
  tools: tools.map(({ handler, ...def }) => def),
  params: undefined,
  exec: { cwd: "D:/tmp/sandbox", signal: null },
  maxIterations: 10,
  budget: { maxTotalTokens: 100000 },
};
`;

const DRIFT_CONFIG_MODULE = CONFIG_MODULE.replace(
  'systemPrompt: "你是文件助手。"',
  'systemPrompt: "这是改过的系统提示。"',
);

let dir: string;
let configPath: string;
let driftConfigPath: string;
let failingDefinition: string;
let passingDefinition: string;
let badDefinition: string;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "trace-test-cli-locale-"));
  const record = await recordRun(normalScript);
  writeTraceBaseline(join(dir, "trace.jsonl"), record);

  configPath = join(dir, "config.mjs");
  driftConfigPath = join(dir, "config-drift.mjs");
  writeFileSync(configPath, CONFIG_MODULE, "utf8");
  writeFileSync(driftConfigPath, DRIFT_CONFIG_MODULE, "utf8");

  passingDefinition = join(dir, "passing.json");
  writeJson(passingDefinition, {
    format_version: 1,
    name: "passing-case",
    trace: "trace.jsonl",
    assertions: [{ type: "run.outcome", equals: "completed" }],
  });

  failingDefinition = join(dir, "failing.json");
  writeJson(failingDefinition, {
    format_version: 1,
    name: "failing-case",
    trace: "trace.jsonl",
    assertions: [
      { type: "run.outcome", equals: "completed" },
      {
        type: "span.field",
        selector: { kind: "tool.invoke", tool: "read_file" },
        field: "tool",
        equals: "write_file",
      },
    ],
  });

  badDefinition = join(dir, "bad.json");
  writeJson(badDefinition, {
    format_version: 9,
    name: "bad-case",
    trace: "trace.jsonl",
    assertions: [],
  });
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "REBASEAGENT_LOCALE") env[key] = value;
  }
  return env;
}

function run(args: readonly string[], env: NodeJS.ProcessEnv = cleanEnv()) {
  return spawnSync(NODE, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: dir,
    env,
  });
}

describe("C01 人类报告两语言", () => {
  it("帮助/隐私/状态/断言差异/汇总按 --locale 输出", () => {
    const zh = run([failingDefinition, "--config", configPath, "--locale", "zh-CN"]);
    expect(zh.status).toBe(1);
    expect(zh.stdout).toContain("失败  failing-case (cassette)");
    expect(zh.stdout).toContain('字段 "tool" 不相等');
    expect(zh.stdout).toContain("合计 1：0 通过 / 1 失败 / 0 配置错误");
    expect(zh.stderr).toContain("trace 可能包含完整 prompt");

    const en = run([failingDefinition, "--config", configPath, "--locale", "en-US"]);
    expect(en.status).toBe(1);
    expect(en.stdout).toContain("FAIL  failing-case (cassette)");
    expect(en.stdout).toContain('field "tool" differs');
    expect(en.stdout).toContain("Total 1: 0 passed / 1 failed / 0 configuration errors");
    expect(en.stderr).toContain("traces may contain full prompts");

    const zhHelp = run(["--help", "--locale", "zh-CN"]);
    expect(zhHelp.status).toBe(0);
    expect(zhHelp.stdout).toContain("用法：rebaseagent-trace-test");
    const enHelp = run(["--help", "--locale", "en-US"]);
    expect(enHelp.status).toBe(0);
    expect(enHelp.stdout).toContain("Usage: rebaseagent-trace-test");
  });

  it("配置漂移在两种语言下都有本地化说明", () => {
    const zh = run([passingDefinition, "--config", driftConfigPath, "--locale", "zh-CN"]);
    expect(zh.status).toBe(0);
    expect(zh.stdout).toContain("配置漂移");
    const en = run([passingDefinition, "--config", driftConfigPath, "--locale", "en-US"]);
    expect(en.status).toBe(0);
    expect(en.stdout).toContain("config drift");
  });

  it("配置错误按语言给受控说明，退出码 2", () => {
    const zh = run([badDefinition, "--config", configPath, "--locale", "zh-CN"]);
    expect(zh.status).toBe(2);
    expect(zh.stderr).toContain("配置错误：测试定义 bad.json 结构非法");
    const en = run([badDefinition, "--config", configPath, "--locale", "en-US"]);
    expect(en.status).toBe(2);
    expect(en.stderr).toContain(
      "Configuration error: Test definition bad.json is structurally invalid",
    );
  });
});

describe("C03 JSON 报告与语言无关", () => {
  it("两语言解析后深度相等；assertion detail 保持既有原文且无 display 字段", () => {
    const zh = run([
      failingDefinition,
      "--config",
      configPath,
      "--report",
      "json",
      "--locale",
      "zh-CN",
    ]);
    const en = run([
      failingDefinition,
      "--config",
      configPath,
      "--report",
      "json",
      "--locale",
      "en-US",
    ]);
    expect(zh.status).toBe(1);
    expect(en.status).toBe(1);
    const zhJson = JSON.parse(zh.stdout) as {
      summary: { exitCode: number; failed: number };
      results: Array<{ assertions: Array<{ type: string; detail: string }> }>;
    };
    const enJson = JSON.parse(en.stdout) as typeof zhJson;
    // run_id 是既有的非确定字段（新 run），按同一规则归一后再比较
    const normalize = (report: typeof zhJson) => ({
      ...report,
      results: report.results.map((result) => ({ ...result, run_id: "<run-id>" })),
    });
    expect(normalize(enJson)).toEqual(normalize(zhJson));
    expect(zhJson.summary).toMatchObject({ failed: 1, exitCode: 1 });
    const field = zhJson.results[0]?.assertions.find(
      (assertion) => assertion.type === "span.field",
    );
    expect(field?.detail).toContain('字段 "tool" 不相等');
    expect(zh.stdout).not.toContain('"display"');
    expect(en.stdout).not.toContain('"display"');
  });
});

describe("C02/C04 语言失败先于执行，baseline 反馈走 stderr", () => {
  it("非法 locale 在加载配置/写 baseline 之前失败，trace 逐字节不变", () => {
    const before = readFileSync(join(dir, "trace.jsonl"), "utf8");
    const result = run([
      passingDefinition,
      "--config",
      join(dir, "config-must-not-load.mjs"),
      "--update-baseline",
      "--locale",
      "fr-FR",
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_LOCALE");
    // 非法语言先于用户模块加载：不能出现配置模块加载错误
    expect(result.stderr).not.toContain("无法加载配置模块");
    expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toBe(before);

    const help = run(["--help", "--update-baseline", "--locale", "zh-CN"]);
    expect(help.status).toBe(0);
    expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toBe(before);
  });

  it("显式 --update-baseline + --report json：stdout 单份 JSON，反馈在 stderr", () => {
    const baselineDir = mkdtempSync(join(tmpdir(), "trace-test-cli-baseline-"));
    try {
      // 直接复制一份可写的 trace，避免影响其它用例
      writeFileSync(
        join(baselineDir, "trace.jsonl"),
        readFileSync(join(dir, "trace.jsonl"), "utf8"),
        "utf8",
      );
      const definition = join(baselineDir, "case.json");
      writeJson(definition, {
        format_version: 1,
        name: "baseline-case",
        trace: "trace.jsonl",
        assertions: [{ type: "run.outcome", equals: "completed" }],
      });
      const result = run(
        [
          definition,
          "--config",
          configPath,
          "--update-baseline",
          "--report",
          "json",
          "--locale",
          "en-US",
        ],
        cleanEnv(),
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("[baseline] Baseline updated:");
      expect(result.stdout.trimStart().startsWith("{")).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stdout).not.toContain("[baseline]");
    } finally {
      rmSync(baselineDir, { recursive: true, force: true });
    }
  });
});
