import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { entry, publishBlob } from "./checkpoint-fixtures.js";

/**
 * MCP0 5.1 的预算夹具（独立数据目录，各批事实各批钉）。
 *
 * 三组靶子分别对应 S07/S09/S10：
 * - **长任务页**：12 条 6,000 字 task（单条约 18 KB）⇒ 默认 20 条页装不下，
 *   预算必须提前结束页；另有一条 80,000 字 task 的单项超限靶子（只能 RESPONSE_LIMIT）。
 * - **长跨度索引**：60 个 4,000 字工具名的 span ⇒ get_run 的 index 页必须提前结束。
 * - **长路径工作区**：102 个文件（100 条约 507 字逻辑路径）⇒ inspect 清单 /
 *   compare 清单的 100 条页装不下；另备 3,000 / 12,000 / 12,001 码点的 NUL 文本，
 *   用于比较正文的预算收窄与两侧独立范围。
 * - **长链**：160 层 prompt fork，每层 run id 约 185 字；叶子正文 8,192 个 emoji。
 *   来源段本身就超过 32 KB，正文再大就必然触发 get_step 的 chars 收窄。
 */

const T0 = "2026-10-21T12:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export function cleanupBudgetFixtures(): void {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface V1SpanIds {
  readonly step: string;
  readonly llm: string;
  readonly tool: string;
}

function writeRootRun(
  tracesDir: string,
  id: string,
  input: { createdAt: string; task: string; toolResult?: unknown },
): V1SpanIds {
  const tracer = new JsonlTracer(join(tracesDir, `${id}.jsonl`));
  tracer.startRun({
    id,
    format_version: 1,
    task: input.task,
    model: "controlled-model",
    created_at: input.createdAt,
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
      messages: [{ role: "user", content: "预算夹具" }],
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
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "read_file",
    args: { path: "a.txt" },
  });
  tracer.endSpan(tool, { result: input.toolResult ?? "ok", dur_ms: 1, error: null });
  tracer.endSpan(step);
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
  return { step, llm, tool };
}

// ---------------------------------------------------------------------------
// 1) 页预算：长 task / 单项超限 / 长工具名 index
// ---------------------------------------------------------------------------

export interface BudgetPageFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly ids: {
    readonly pages: readonly string[];
    readonly oversized: string;
    readonly manySpans: string;
  };
}

export const PAGE_TASK_CHARS = 6_000;
export const OVERSIZE_TASK_CHARS = 80_000;
export const MANY_SPANS = 60;
export const LONG_TOOL_NAME_CHARS = 4_000;

export function buildBudgetPageFixture(): BudgetPageFixture {
  const dataDir = tempDir("mcp0-budget-page-");
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  const pages: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const id = `mcp0-page-${String(index).padStart(2, "0")}`;
    pages.push(id);
    writeRootRun(tracesDir, id, {
      createdAt: at(100 - index),
      task: `PAGE-${String(index).padStart(2, "0")} ${"\u80A9".repeat(PAGE_TASK_CHARS)}`,
    });
  }

  const oversized = "mcp0-oversized";
  writeRootRun(tracesDir, oversized, {
    createdAt: at(0),
    task: `OVERSIZE-MARKER ${"\u5DE8".repeat(OVERSIZE_TASK_CHARS)}`,
  });

  const manySpans = "mcp0-many-spans";
  const tracer = new JsonlTracer(join(tracesDir, `${manySpans}.jsonl`));
  tracer.startRun({
    id: manySpans,
    format_version: 1,
    task: "长工具名 index 夹具",
    model: "controlled-model",
    created_at: at(-10),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const toolName = `tool-${"y".repeat(LONG_TOOL_NAME_CHARS)}`;
  for (let index = 0; index < MANY_SPANS; index += 1) {
    const span = tracer.startSpan({
      kind: "tool.invoke",
      parent: step,
      tool: `${toolName}-${index}`,
      args: {},
    });
    tracer.endSpan(span, { result: "ok", dur_ms: 1, error: null });
  }
  tracer.endSpan(step);
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  return { dataDir, tracesDir, ids: { pages, oversized, manySpans } };
}

// ---------------------------------------------------------------------------
// 2) 长路径工作区 + 大正文比较
// ---------------------------------------------------------------------------

export interface BudgetWorkspaceFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly blobsDir: string;
  readonly runId: string;
  readonly stepSpanId: string;
  readonly initialFileCount: number;
  readonly hugeLeftChars: number;
  readonly hugeRightChars: number;
  readonly shortLeftChars: number;
  readonly shortRightChars: number;
}

export const LONG_PATH_FILES = 100;
export const HUGE_LEFT_CHARS = 12_000;
export const HUGE_RIGHT_CHARS = 12_001;
export const SHORT_LEFT_CHARS = 3_000;
export const SHORT_RIGHT_CHARS = 12_000;

/** 15 层、每段 32 字，总长约 507 字：合法逻辑路径且单条足够撑大清单 */
function longLogicalPath(index: number): string {
  const directories = Array.from(
    { length: 15 },
    (_, depth) => `dir-${String(depth).padStart(2, "0")}-${"x".repeat(25)}`,
  ).join("/");
  return `${directories}/file-${String(index).padStart(7, "0")}.txt`;
}

export function buildBudgetWorkspaceFixture(): BudgetWorkspaceFixture {
  const dataDir = tempDir("mcp0-budget-ws-");
  const tracesDir = join(dataDir, "traces");
  const blobsDir = join(dataDir, "workspace-blobs", "sha256");
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });

  const longFileBytes = Buffer.from("long-path-file\n", "utf8");
  const longFileSha = publishBlob(blobsDir, longFileBytes);
  const longFiles = Array.from({ length: LONG_PATH_FILES }, (_, index) =>
    entry(longLogicalPath(index), longFileSha, longFileBytes.byteLength),
  );

  const hugeLeft = "\u0000".repeat(HUGE_LEFT_CHARS);
  const hugeRight = `${"\u0000".repeat(HUGE_LEFT_CHARS)}B`;
  const shortLeft = "\u0000".repeat(SHORT_LEFT_CHARS);
  const shortRight = "\u0000".repeat(SHORT_RIGHT_CHARS);

  const blobOf = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    return { sha256: publishBlob(blobsDir, bytes), bytes: bytes.byteLength };
  };
  const hugeLeftBlob = blobOf(hugeLeft);
  const hugeRightBlob = blobOf(hugeRight);
  const shortLeftBlob = blobOf(shortLeft);
  const shortRightBlob = blobOf(shortRight);

  const initialSnapshot = createWorkspaceSnapshot([
    ...longFiles,
    entry("huge.txt", hugeLeftBlob.sha256, hugeLeftBlob.bytes),
    entry("short.txt", shortLeftBlob.sha256, shortLeftBlob.bytes),
  ]);
  const finalSnapshot = createWorkspaceSnapshot([
    ...longFiles,
    entry("huge.txt", hugeRightBlob.sha256, hugeRightBlob.bytes),
    entry("short.txt", shortRightBlob.sha256, shortRightBlob.bytes),
  ]);

  const runId = "mcp0-budget-ws";
  const tracer = new JsonlTracer(join(tracesDir, `${runId}.jsonl`));
  tracer.startRun({
    id: runId,
    format_version: 2,
    task: "预算夹具：长路径工作区",
    model: "controlled-model",
    created_at: at(200),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: runId,
      write_authorized: true,
      initial_snapshot: initialSnapshot,
      origin: { kind: "import" },
    },
  });
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm = tracer.startSpan({
    kind: "llm.call",
    parent: step,
    request: {
      model: "controlled-model",
      messages: [{ role: "user", content: "预算夹具" }],
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
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "read_file",
    args: { path: "huge.txt" },
  });
  tracer.endSpan(tool, { result: "ok", dur_ms: 1, error: null });
  tracer.endSpan(step, { workspace_snapshot: finalSnapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  return {
    dataDir,
    tracesDir,
    blobsDir,
    runId,
    stepSpanId: step,
    initialFileCount: initialSnapshot.files.length,
    hugeLeftChars: HUGE_LEFT_CHARS,
    hugeRightChars: HUGE_RIGHT_CHARS,
    shortLeftChars: SHORT_LEFT_CHARS,
    shortRightChars: SHORT_RIGHT_CHARS,
  };
}

// ---------------------------------------------------------------------------
// 3) 长链：get_step 的正文预算
// ---------------------------------------------------------------------------

export interface BudgetChainFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly leafRunId: string;
  readonly leafToolSpanId: string;
  readonly chainLength: number;
  readonly bodyCodePoints: number;
}

export const CHAIN_CHILDREN = 160;
export const CHAIN_ID_PADDING = 170;
export const CHAIN_BODY_EMOJI = 8_192;

export function buildBudgetChainFixture(): BudgetChainFixture {
  const dataDir = tempDir("mcp0-budget-chain-");
  const tracesDir = join(dataDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  let parentRunId: string | null = null;
  let parentLlmSpanId: string | null = null;
  let leafRunId = "mcp0-chain-root";
  let leafToolSpanId = "";

  for (let index = 0; index <= CHAIN_CHILDREN; index += 1) {
    const isRoot = index === 0;
    const id = isRoot
      ? "mcp0-chain-root"
      : `mcp0-chain-${String(index).padStart(3, "0")}-${"x".repeat(CHAIN_ID_PADDING)}`;
    const isLeaf = index === CHAIN_CHILDREN;
    const tracer = new JsonlTracer(join(tracesDir, `${id}.jsonl`), {
      ...(isRoot ? {} : { spanSeqStart: index * 10 }),
    });
    tracer.startRun({
      id,
      format_version: 1,
      task: isRoot ? "预算夹具：长链根" : `预算夹具：第 ${index} 层`,
      model: "controlled-model",
      created_at: at(300 + index),
      parent: isRoot ? null : parentRunId,
      fork: isRoot
        ? null
        : {
            at_span: parentLlmSpanId ?? "s_02",
            edit: { field: "system_prompt", value: `fork-${index}` },
          },
      ...(isRoot ? { config_hash: "sha256:controlled-config" } : {}),
    });
    const step = tracer.startSpan({ kind: "agent.step", n: 1 });
    const llm = tracer.startSpan({
      kind: "llm.call",
      parent: step,
      request: {
        model: "controlled-model",
        messages: [{ role: "user", content: `chain-${index}` }],
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
    const tool = tracer.startSpan({
      kind: "tool.invoke",
      parent: step,
      tool: "read_file",
      args: { path: "a.txt" },
    });
    tracer.endSpan(tool, {
      result: isLeaf ? "🙂".repeat(CHAIN_BODY_EMOJI) : "ok",
      dur_ms: 1,
      error: null,
    });
    tracer.endSpan(step);
    tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

    parentRunId = id;
    parentLlmSpanId = llm;
    leafRunId = id;
    leafToolSpanId = tool;
  }

  return {
    dataDir,
    tracesDir,
    leafRunId,
    leafToolSpanId,
    chainLength: CHAIN_CHILDREN + 1,
    bodyCodePoints: CHAIN_BODY_EMOJI,
  };
}
