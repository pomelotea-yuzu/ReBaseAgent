import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTraceBaseline } from "../src/run-test.js";
import { cannedResponse, recordRun, toolCall } from "./helpers.js";

/**
 * i18n 5.6（C03/C04/G02）：真实 dist CLI 的 JSON 契约。
 *
 * - 字段集合、原值与原始 detail 保持不变；脱敏仍生效；
 * - 人类显示描述（display/本地化标签/汇总句子）不进入 JSON；
 * - 两语言报告除既有非确定字段外深度相等；
 * - 没有 `--update-baseline` 时 trace 不被改写；显式更新两语言写入的语义内容相同，
 *   文本反馈只在 stderr；
 * - 子进程不依赖模型密钥/网络（cassette 路径）。
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "trace-test-json-contract-"));
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
    redact: ["path"],
    assertions: [
      { type: "run.outcome", equals: "completed" },
      {
        type: "span.field",
        selector: { kind: "tool.invoke", tool: "read_file" },
        field: "args.path",
        equals: "other.json",
      },
    ],
  });
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key !== "REBASEAGENT_LOCALE" &&
      !/(OPENAI|DEEPSEEK|ANTHROPIC|REBASEAGENT_API_KEY|API_KEY|ACCESS_TOKEN)/i.test(key)
    ) {
      env[key] = value;
    }
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

interface JsonReport {
  summary: Record<string, number>;
  results: Array<Record<string, unknown>>;
}

function parseReport(text: string): JsonReport {
  return JSON.parse(text) as JsonReport;
}

function normalized(report: JsonReport): JsonReport {
  return {
    ...report,
    results: report.results.map((result) => ({ ...result, run_id: "<run-id>" })),
  };
}

/** 去掉新 run 的时间戳与随机标识后比较 baseline 的语义内容 */
function normalizeTrace(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "run.meta") {
        return { ...value, id: "<run-id>", created_at: "<ts>" };
      }
      const timing = value.timing as { started_at?: string; ended_at?: string } | undefined;
      if (timing !== undefined) {
        timing.started_at = "<ts>";
        timing.ended_at = "<ts>";
      }
      // 桩工具的真实耗时是物理时长（0/1ms 抖动），不属于语言或写入语义
      if (typeof value.dur_ms === "number") value.dur_ms = "<dur>";
      return value;
    });
}

describe("C03 JSON 字段/原值/脱敏与语言无关", () => {
  it("字段集合固定、原始 detail 保留、脱敏生效、无人类显示字段", () => {
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
    expect(zh.stdout).not.toContain("[baseline]");
    const zhReport = parseReport(zh.stdout);
    const enReport = parseReport(en.stdout);

    expect(Object.keys(zhReport).sort()).toEqual(["results", "summary"]);
    expect(Object.keys(zhReport.summary).sort()).toEqual([
      "configErrors",
      "exitCode",
      "failed",
      "passed",
      "total",
    ]);
    const result = zhReport.results[0] as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "alignment",
      "args_drift",
      "assertions",
      "config_drift",
      "definition",
      "mode",
      "name",
      "request_drift",
      "run_id",
      "status",
      "trace",
    ]);
    expect(Object.keys(result.alignment as Record<string, unknown>).sort()).toEqual([
      "aligned",
      "comparedSpanCount",
      "mismatch",
    ]);
    const assertions = result.assertions as Array<Record<string, unknown>>;
    for (const assertion of assertions) {
      expect(Object.keys(assertion).sort()).toEqual(["detail", "passed", "type"]);
    }
    const field = assertions.find((assertion) => assertion.type === "span.field");
    expect(field?.detail).toContain('"***"');
    expect(field?.detail).not.toContain("a.json");
    expect(field?.detail).not.toContain("other.json");
    // 机器报告的既有原文保持（不是当前语言的句子）
    expect(field?.detail).toContain('字段 "args.path" 不相等');

    expect(normalized(enReport)).toEqual(normalized(zhReport));
    for (const label of ["配置漂移", "请求漂移", "参数漂移", "合计", "display"]) {
      expect(zh.stdout).not.toContain(label);
      expect(en.stdout).not.toContain(label);
    }
  });

  it("配置漂移只给 recorded/current 原值，不带本地化标签", () => {
    const zh = run([
      passingDefinition,
      "--config",
      driftConfigPath,
      "--report",
      "json",
      "--locale",
      "zh-CN",
    ]);
    const en = run([
      passingDefinition,
      "--config",
      driftConfigPath,
      "--report",
      "json",
      "--locale",
      "en-US",
    ]);
    expect(zh.status).toBe(0);
    const zhReport = parseReport(zh.stdout);
    const enReport = parseReport(en.stdout);
    const drift = zhReport.results[0]?.config_drift as Record<string, string>;
    expect(Object.keys(drift).sort()).toEqual(["current", "recorded"]);
    expect(drift.recorded).toMatch(/^sha256:/);
    expect(drift.current).toMatch(/^sha256:/);
    expect(normalized(enReport)).toEqual(normalized(zhReport));
    expect(zh.stdout).not.toContain("配置漂移");
    expect(en.stdout).not.toContain("config drift");
  });

  it("无密钥、无网络也能跑：cassette 子进程退出码与报告完整", () => {
    const result = run([
      passingDefinition,
      "--config",
      configPath,
      "--report",
      "json",
      "--locale",
      "en-US",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(parseReport(result.stdout).summary.exitCode).toBe(0);
    expect(result.stderr).not.toContain("ECONN");
  });
});

describe("C04 baseline：保护条件与写入内容不随语言变化", () => {
  it("未显式 --update-baseline 时两语言都不改写 trace", () => {
    const before = readFileSync(join(dir, "trace.jsonl"), "utf8");
    for (const locale of ["zh-CN", "en-US"]) {
      const result = run([
        failingDefinition,
        "--config",
        configPath,
        "--report",
        "json",
        "--locale",
        locale,
      ]);
      expect(result.status).toBe(1);
      expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toBe(before);
    }
  });

  it("显式更新：反馈只在 stderr，两语言写入的语义内容一致", () => {
    const zhDir = mkdtempSync(join(tmpdir(), "trace-test-json-baseline-zh-"));
    const enDir = mkdtempSync(join(tmpdir(), "trace-test-json-baseline-en-"));
    try {
      for (const [locale, target] of [
        ["zh-CN", zhDir],
        ["en-US", enDir],
      ] as const) {
        copyFileSync(join(dir, "trace.jsonl"), join(target, "trace.jsonl"));
        writeJson(join(target, "case.json"), {
          format_version: 1,
          name: "baseline-case",
          trace: "trace.jsonl",
          assertions: [{ type: "run.outcome", equals: "completed" }],
        });
        const result = run(
          [
            join(target, "case.json"),
            "--config",
            configPath,
            "--update-baseline",
            "--report",
            "json",
            "--locale",
            locale,
          ],
          cleanEnv(),
        );
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain("[baseline]");
        expect(result.stderr).toContain(
          locale === "zh-CN" ? "[baseline] 已更新基线：" : "[baseline] Baseline updated:",
        );
        expect(() => parseReport(result.stdout)).not.toThrow();
      }
      expect(normalizeTrace(join(enDir, "trace.jsonl"))).toEqual(
        normalizeTrace(join(zhDir, "trace.jsonl")),
      );
    } finally {
      rmSync(zhDir, { recursive: true, force: true });
      rmSync(enDir, { recursive: true, force: true });
    }
  });
});
