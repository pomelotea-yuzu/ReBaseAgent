import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { TOOL_ERROR_MESSAGES } from "../src/error-projection.js";
import type { CompareCheckpointFilesData } from "../src/query/compare-checkpoint-files.js";
import { compareCheckpointFilesTool } from "../src/query/compare-checkpoint-files.js";
import type { CompareRunsData } from "../src/query/compare-runs.js";
import { compareRunsTool } from "../src/query/compare-runs.js";
import { getRunTool } from "../src/query/get-run.js";
import { getStepTool } from "../src/query/get-step.js";
import { inspectCheckpointTool } from "../src/query/inspect-checkpoint.js";
import { listRunsTool } from "../src/query/list-runs.js";
import { readCheckpointFileTool } from "../src/query/read-checkpoint-file.js";
import type { ToolDefinition, ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  type CheckpointFixture,
  buildCheckpointFixture,
  cleanupCheckpointFixtures,
} from "./checkpoint-fixtures.js";

/**
 * MCP0 4.8（S06）：业务错误不泄露内部载荷。
 *
 * 逐工具按**结构**触发三类失败（design D4 的 WHEN）：
 * - 非法标识 ⇒ `INVALID_ARGUMENT`，ref 只说字段名，不回显被拒取值；
 * - 不支持的 trace 版本 ⇒ `RUN_INVALID`（读取器尚未提供结构化版本码，D4 明言
 *   「无法可靠细分时用 RUN_INVALID」，不按错误文字猜 `UNSUPPORTED_TRACE_VERSION`）；
 * - 真实存储 I/O 故障（附件位置被目录顶替）⇒ `STORAGE_IO` + `retryable:true`，
 *   errno/物理路径一个字节都不外发。
 *
 * 两个夹具目录刻意分开：本批只往「安全错误目录」加 v9 / 存储目录两个靶子，
 * 不去碰 4.6 检查点夹具里那些逐条字面数。
 */

let safeDir: string;
let safeTraces: string;
let root: DataRoot;
let checkpoint: CheckpointFixture;

const SAFE_RUN = "mcp0-safe";
const V9_RUN = "mcp0-v9";
const MISSING_RUN = "mcp0-never-written";

beforeAll(() => {
  safeDir = mkdtempSync(join(tmpdir(), "mcp0-safe-errors-"));
  safeTraces = join(safeDir, "traces");
  mkdirSync(safeTraces, { recursive: true });

  const tracer = new JsonlTracer(join(safeTraces, `${SAFE_RUN}.jsonl`));
  tracer.startRun({
    id: SAFE_RUN,
    format_version: 1,
    task: "MCP0 4.8 安全错误夹具",
    model: "controlled-model",
    created_at: "2026-10-20T00:00:00.000Z",
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm = tracer.startSpan({
    kind: "llm.call",
    parent: step,
    request: {
      model: "controlled-model",
      messages: [{ role: "user", content: "安全错误夹具" }],
    },
  });
  tracer.endSpan(llm, {
    response: {
      content: "ok",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 1, out: 1 },
      ttft_ms: 1,
    },
  });
  tracer.endSpan(step);
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  writeFileSync(
    join(safeTraces, `${V9_RUN}.jsonl`),
    `${JSON.stringify({
      type: "run.meta",
      id: V9_RUN,
      format_version: 9,
      task: "不支持的版本",
      model: "controlled-model",
      created_at: "2026-10-20T00:00:01.000Z",
      parent: null,
      fork: null,
    })}\n`,
  );

  root = { dataDir: safeDir, tracesDir: safeTraces };
  checkpoint = buildCheckpointFixture();
}, 120_000);

afterAll(() => {
  cleanupCheckpointFixtures();
  rmSync(safeDir, { recursive: true, force: true });
});

async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute(args, root);
}

interface Failure {
  readonly code: string;
  readonly message: string;
  readonly ref?: string;
  readonly retryable: boolean;
  readonly serialized: string;
}

async function failureOf(tool: ToolDefinition, args: Record<string, unknown>): Promise<Failure> {
  const result = await call(tool, args);
  expect(result.isError).toBe(true);
  const envelope = ErrorEnvelopeSchema.parse(result.structuredContent);
  return { ...envelope.error, serialized: JSON.stringify(envelope) };
}

describe("非法标识：稳定码 + 字段定位，不回显取值", () => {
  it("六个带标识的工具各自在任何读取之前拒绝", async () => {
    const cases: Array<{
      readonly tool: ToolDefinition;
      readonly args: Record<string, unknown>;
      readonly ref: string;
      readonly raw: string;
    }> = [
      { tool: getRunTool, args: { runId: "../outside" }, ref: "runId", raw: "outside" },
      {
        tool: getStepTool,
        // span 只作查询键：合法的 zod 形状里唯一会被本层拒绝的是 NUL
        args: { runId: SAFE_RUN, spanId: "s\u0000SENTINEL-span" },
        ref: "spanId",
        raw: "SENTINEL-span",
      },
      {
        tool: compareRunsTool,
        args: { left: { runId: "../outside" }, right: { runId: SAFE_RUN } },
        ref: "left",
        raw: "outside",
      },
      {
        tool: inspectCheckpointTool,
        args: { runId: "../outside" },
        ref: "runId",
        raw: "outside",
      },
      {
        tool: readCheckpointFileTool,
        args: { runId: SAFE_RUN, path: "../outside" },
        ref: "path",
        raw: "outside",
      },
      {
        tool: compareCheckpointFilesTool,
        args: {
          left: { runId: "../outside" },
          right: { runId: SAFE_RUN },
          path: "a.txt",
        },
        ref: "left.runId",
        raw: "outside",
      },
      {
        tool: listRunsTool,
        args: { cursor: "secret-cursor" },
        ref: "cursor",
        raw: "secret-cursor",
      },
    ];
    for (const item of cases) {
      const failure = await failureOf(item.tool, item.args);
      expect(failure.code).toBe("INVALID_ARGUMENT");
      expect(failure.ref).toBe(item.ref);
      expect(failure.retryable).toBe(false);
      expect(failure.message).toBe(TOOL_ERROR_MESSAGES.INVALID_ARGUMENT);
      expect(failure.serialized).not.toContain(item.raw);
    }
  });

  it("未知字段只报规则名，不回显 dataDir 取值", async () => {
    const failure = await failureOf(getRunTool, {
      runId: SAFE_RUN,
      dataDir: "D:/secret-root",
    });
    expect(failure.code).toBe("INVALID_ARGUMENT");
    expect(failure.serialized).not.toContain("D:/secret-root");
    expect(failure.serialized).not.toContain("dataDir");
  });
});

describe("不支持的 trace 版本：稳定码，不按文字猜专用码", () => {
  it("get_run 给 RUN_INVALID 与码表文案，不透传读取器的版本原文", async () => {
    const failure = await failureOf(getRunTool, { runId: V9_RUN });
    expect(failure.code).toBe("RUN_INVALID");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toBe(TOOL_ERROR_MESSAGES.RUN_INVALID);
    expect(failure.serialized).not.toContain("不支持的格式版本");
    expect(failure.serialized).not.toContain(safeTraces);
  });

  it("list_runs 把 v9 文件如实列为失败项，文案仍取自码表", async () => {
    const result = await call(listRunsTool, { limit: 100 });
    expect(result.isError).not.toBe(true);
    const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
    const data = envelope.data as {
      items: Array<{ kind: string; file?: string; code?: string; message?: string }>;
    };
    const failed = data.items.find(
      (item) => item.kind === "unreadable_file" && item.file === `${V9_RUN}.jsonl`,
    );
    expect(failed?.code).toBe("RUN_INVALID");
    expect(failed?.message).toBe(TOOL_ERROR_MESSAGES.RUN_INVALID);
    expect(JSON.stringify(data)).not.toContain("不支持的格式版本");
  });
});

describe("缺失 run：逐工具稳定失败或逐侧不可用", () => {
  it("单 run 工具一律 RUN_NOT_FOUND，retryable=false，不含宿主路径", async () => {
    for (const [tool, args] of [
      [getRunTool, { runId: MISSING_RUN }],
      [getStepTool, { runId: MISSING_RUN, spanId: "s_01" }],
      [inspectCheckpointTool, { runId: MISSING_RUN }],
      [readCheckpointFileTool, { runId: MISSING_RUN, path: "a.txt" }],
    ] as const) {
      const failure = await failureOf(tool, args);
      expect(failure.code).toBe("RUN_NOT_FOUND");
      expect(failure.retryable).toBe(false);
      expect(failure.message).toBe(TOOL_ERROR_MESSAGES.RUN_NOT_FOUND);
      expect(failure.serialized).not.toContain(safeTraces);
    }
  });

  it("compare_runs 把缺侧如实标 unavailable；内容模式比较缺侧则整条失败", async () => {
    const compared = await call(compareRunsTool, {
      left: { runId: MISSING_RUN },
      right: { runId: SAFE_RUN },
    });
    expect(compared.isError).not.toBe(true);
    const data = SuccessEnvelopeSchema.parse(compared.structuredContent).data as CompareRunsData;
    expect(data.sides[0]).toMatchObject({
      side: "left",
      status: "unavailable",
      runId: MISSING_RUN,
      code: "RUN_NOT_FOUND",
      retryable: false,
    });
    expect(data.sides[1]?.status).toBe("ready");

    const manifest = await call(compareCheckpointFilesTool, {
      left: { runId: MISSING_RUN },
      right: { runId: SAFE_RUN },
    });
    expect(manifest.isError).not.toBe(true);
    const manifestData = SuccessEnvelopeSchema.parse(manifest.structuredContent)
      .data as CompareCheckpointFilesData;
    expect(manifestData.mode).toBe("manifest");
    if (manifestData.mode !== "manifest") throw new Error("应是清单模式");
    expect(manifestData.sides[0]).toMatchObject({
      side: "left",
      status: "unavailable",
      code: "RUN_NOT_FOUND",
    });
    expect(manifestData.unionComplete).toBe(false);

    const content = await failureOf(compareCheckpointFilesTool, {
      left: { runId: MISSING_RUN },
      right: { runId: SAFE_RUN },
      path: "a.txt",
    });
    expect(content.code).toBe("RUN_NOT_FOUND");
    expect(content.retryable).toBe(false);
  });
});

describe("真实存储 I/O 故障：STORAGE_IO，可重试且不透传 errno", () => {
  it("附件位置被目录顶替 ⇒ STORAGE_IO，物理路径不外发", async () => {
    const result = await inspectCheckpointTool.execute(
      { runId: checkpoint.ids.ioRun, limit: 100 },
      { dataDir: checkpoint.dataDir, tracesDir: checkpoint.tracesDir },
    );
    expect(result.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(result.structuredContent);
    expect(envelope.error.code).toBe("STORAGE_IO");
    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.message).toBe(TOOL_ERROR_MESSAGES.STORAGE_IO);
    const serialized = JSON.stringify(envelope);
    for (const needle of [
      checkpoint.dataDir,
      checkpoint.blobsDir,
      "workspace-blobs",
      "I/O 故障",
      "ENOENT",
      "EPERM",
    ]) {
      expect(serialized).not.toContain(needle);
    }
  });
});
