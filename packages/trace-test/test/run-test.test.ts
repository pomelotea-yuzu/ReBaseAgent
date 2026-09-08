import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceTestConfigError } from "../src/errors.js";
import {
  type TestResult,
  exitCodeFor,
  loadTrace,
  runTraceTest,
  writeTraceBaseline,
} from "../src/index.js";
import type { TraceTestDefinition } from "../src/index.js";
import { cannedResponse, fakeConfig, fakeTools, recordRun, toolCall } from "./helpers.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-test-run-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 场景剧本：读 a.json → 收尾（两轮，completed） */
const normalScript = [
  cannedResponse({ toolCalls: [toolCall("c1", "read_file", { path: "a.json" })] }),
  cannedResponse({ content: "完成" }),
];

/** 在临时目录落一份定义 + 基线 trace，返回定义文件路径 */
async function writeFixture(
  definition: Omit<TraceTestDefinition, "format_version"> & { format_version?: number },
  record: Awaited<ReturnType<typeof recordRun>>,
  dir = makeTempDir(),
): Promise<string> {
  writeTraceBaseline(join(dir, "trace.jsonl"), record);
  const def = { format_version: 1, ...definition };
  const file = join(dir, "case.json");
  writeFileSync(file, JSON.stringify(def, null, 2), "utf8");
  return file;
}

describe("runTraceTest（runner API 端到端）", () => {
  it("卡带模式：全部断言通过 → passed / mode=cassette / 零漂移", async () => {
    const record = await recordRun(normalScript);
    const file = await writeFixture(
      {
        name: "readme-agent",
        trace: "trace.jsonl",
        assertions: [
          { type: "run.outcome", equals: "completed" },
          { type: "span.exists", selector: { kind: "tool.invoke", tool: "read_file" } },
          { type: "span.count", selector: { kind: "tool.invoke" }, equals: 1 },
          { type: "trace.shape" },
        ],
      },
      record,
    );
    const result = await runTraceTest(file, { config: fakeConfig(), tools: fakeTools() });
    expect(result.mode).toBe("cassette");
    expect(result.status).toBe("passed");
    expect(result.configDrift).toBeNull();
    expect(result.runId).not.toBe(record.meta.id);
    expect(result.assertions.every((a) => a.passed)).toBe(true);
  });

  it("断言失败 → status=failed（失败是数据不是异常）", async () => {
    const record = await recordRun(normalScript);
    const file = await writeFixture(
      {
        name: "expect-error",
        trace: "trace.jsonl",
        assertions: [{ type: "run.outcome", equals: "error" }],
      },
      record,
    );
    const result: TestResult = await runTraceTest(file, {
      config: fakeConfig(),
      tools: fakeTools(),
    });
    expect(result.status).toBe("failed");
    expect(result.assertions[0].passed).toBe(false);
  });

  it("max_iterations 基线：卡带恰好消费完，outcome=max_iterations 对齐", async () => {
    // 每轮都发起工具调用、maxIterations=2 → 两轮后按 max_iterations 终止
    const loopScript = [
      cannedResponse({ toolCalls: [toolCall("c1", "read_file", { path: "a.json" })] }),
      cannedResponse({ toolCalls: [toolCall("c2", "write_file", { path: "b.json" })] }),
    ];
    const record = await recordRun(loopScript, { config: { maxIterations: 2 } });
    expect(record.events[0].reason).toBe("max_iterations");

    const file = await writeFixture(
      {
        name: "loop-guard",
        trace: "trace.jsonl",
        assertions: [{ type: "run.outcome", equals: "max_iterations" }],
      },
      record,
    );
    const result = await runTraceTest(file, {
      config: fakeConfig({ maxIterations: 2 }),
      tools: fakeTools(),
    });
    expect(result.status).toBe("passed");
    expect(result.alignment?.aligned).toBe(true);
  });

  it("代理录制 run → 自动降级静态断言路径（mode=static）", async () => {
    const record = await recordRun(normalScript);
    record.meta.source = { kind: "proxy", base_url: "http://127.0.0.1:18787" };
    const file = await writeFixture(
      {
        name: "proxy-static",
        trace: "trace.jsonl",
        assertions: [
          { type: "run.outcome", equals: "completed" },
          { type: "span.exists", selector: { kind: "tool.invoke", tool: "read_file" } },
        ],
      },
      record,
    );
    const result = await runTraceTest(file, { config: fakeConfig(), tools: fakeTools() });
    expect(result.mode).toBe("static");
    expect(result.status).toBe("passed");
    expect(result.runId).toBe(record.meta.id); // 静态模式 run id = 录制 run
    expect(result.newRecord).toBeNull();
  });

  it("静态模式里声明 trace.shape → 配置错误（无重跑轨迹谈不上对齐）", async () => {
    const record = await recordRun(normalScript);
    record.meta.source = { kind: "proxy", base_url: "http://127.0.0.1:18787" };
    const file = await writeFixture(
      {
        name: "proxy-shape",
        trace: "trace.jsonl",
        assertions: [{ type: "trace.shape" }],
      },
      record,
    );
    await expect(runTraceTest(file, { config: fakeConfig(), tools: fakeTools() })).rejects.toThrow(
      TraceTestConfigError,
    );
  });

  it("未知 format_version 的定义 → 配置错误，不执行重跑", async () => {
    const record = await recordRun(normalScript);
    const file = await writeFixture(
      { format_version: 2, name: "v2", trace: "trace.jsonl" } as Omit<
        TraceTestDefinition,
        "format_version"
      > & { format_version?: number },
      record,
    );
    await expect(runTraceTest(file, { config: fakeConfig(), tools: fakeTools() })).rejects.toThrow(
      TraceTestConfigError,
    );
  });

  it("redact：失败摘要中的敏感字段值被掩码", async () => {
    const record = await recordRun(normalScript);
    const file = await writeFixture(
      {
        name: "redacted",
        trace: "trace.jsonl",
        redact: ["path"],
        assertions: [
          {
            type: "span.field",
            selector: { tool: "read_file" },
            field: "args.path",
            equals: "不存在的路径",
          },
        ],
      },
      record,
    );
    const result = await runTraceTest(file, { config: fakeConfig(), tools: fakeTools() });
    expect(result.status).toBe("failed");
    const detail = result.assertions[0].detail;
    expect(detail).toContain("***");
    expect(detail).not.toContain("a.json");
  });

  it("基线更新（3.3）：writeTraceBaseline 覆盖后基线变为新轨迹，且可复跑", async () => {
    const record = await recordRun(normalScript);
    const dir = makeTempDir();
    const file = await writeFixture(
      { name: "update-baseline", trace: "trace.jsonl", assertions: [] },
      record,
      dir,
    );
    const first = await runTraceTest(file, { config: fakeConfig(), tools: fakeTools() });
    expect(first.newRecord).not.toBeNull();

    const tracePath = join(dir, "trace.jsonl");
    writeTraceBaseline(tracePath, first.newRecord as NonNullable<TestResult["newRecord"]>);
    const updated = loadTrace(tracePath);
    expect(updated.meta.id).toBe(first.runId);
    expect(updated.status).toBe("completed");
    // 更新后的基线再跑一次仍然通过（重录语义自洽）
    const second = await runTraceTest(file, { config: fakeConfig(), tools: fakeTools() });
    expect(second.status).toBe("passed");
  });

  it("loadTrace 对损坏 trace → 配置错误", () => {
    const dir = makeTempDir();
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, "not json\n", "utf8");
    const file = join(dir, "case.json");
    writeFileSync(
      file,
      JSON.stringify({ format_version: 1, name: "x", trace: "bad.jsonl" }),
      "utf8",
    );
    expect(() => loadTrace(bad)).toThrow(TraceTestConfigError);
    void readFileSync; // keep import used
  });
});

describe("exitCodeFor", () => {
  const passed: TestResult = {
    name: "a",
    definitionPath: "a.json",
    tracePath: "t.jsonl",
    mode: "cassette",
    status: "passed",
    runId: "r",
    rerun: null,
    configDrift: null,
    requestDrift: [],
    argsDrift: [],
    alignment: null,
    assertions: [],
    redact: [],
    newRecord: null,
  };

  it("0=全过 / 1=有断言失败 / 2=有配置错误", () => {
    expect(exitCodeFor([passed], 0)).toBe(0);
    expect(exitCodeFor([passed, { ...passed, status: "failed" }], 0)).toBe(1);
    expect(exitCodeFor([], 1)).toBe(2);
    // 配置错误优先于断言失败
    expect(exitCodeFor([{ ...passed, status: "failed" }], 1)).toBe(2);
  });
});
