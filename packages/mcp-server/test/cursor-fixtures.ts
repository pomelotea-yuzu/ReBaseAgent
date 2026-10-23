import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { entry, publishBlob } from "./checkpoint-fixtures.js";

/**
 * MCP0 5.2 的续读夹具（每个测试一份，允许修改来源后重查）。
 *
 * 一个数据根里备齐：
 * - **列表序列**：7 条成功 run + 2 条失败文件（损坏 / 身份错配）⇒ 分页与失败项不重复；
 * - **索引序列**：一条 9 个 span 的 run（step + 8 tools）⇒ get_run 分页；
 * - **长正文**：一条 tool 结果 1,200 码点的 run ⇒ get_step 正文续读；
 * - **v2 工作区**：6 个文件，`long.txt` 初始 1,200「甲」/轮末 1,300「乙」⇒
 *   inspect/read/compare 清单与两侧正文续读；
 * - **可改来源**：新增 run 文件、改写 trace task、改写附件 blob —— 用来钉 STALE_CURSOR。
 */

const T0 = "2026-10-21T00:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

export const CURSOR_LONG_BODY = `${"正文🙂".repeat(300)}尾巴`;
export const CURSOR_LIST_RUNS = 7;
export const CURSOR_SPANS = 8;

export interface CursorFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly blobsDir: string;
  readonly runIds: readonly string[];
  readonly corruptFile: string;
  readonly identityFile: string;
  readonly bodyRunId: string;
  readonly bodySpanId: string;
  readonly spansRunId: string;
  readonly workspaceRunId: string;
  readonly workspaceStepSpanId: string;
  readonly longPath: string;
  readonly longLeftChars: number;
  readonly longRightChars: number;
  readonly longLeftSha: string;
  readonly longRightSha: string;
  readonly attachmentHashes: readonly string[];
}

const roots: string[] = [];

export function buildCursorFixture(): CursorFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp0-cursor-"));
  roots.push(dataDir);
  const tracesDir = join(dataDir, "traces");
  const blobsDir = join(dataDir, "workspace-blobs", "sha256");
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });

  const runIds: string[] = [];
  for (let index = 0; index < CURSOR_LIST_RUNS; index += 1) {
    const id = `mcp0-cur-${String(index).padStart(2, "0")}`;
    runIds.push(id);
    writeRun(tracesDir, id, at(100 - index), `列表夹具 ${index}`, "ok", 1);
  }

  const body = writeRun(tracesDir, "mcp0-cur-body", at(50), "长正文夹具", CURSOR_LONG_BODY, 1);
  const spans = writeRun(tracesDir, "mcp0-cur-spans", at(40), "索引夹具", "ok", CURSOR_SPANS);

  // 两个失败文件：损坏 + 身份错配（列表序列末尾，分页时各出现一次）
  writeFileSync(
    join(tracesDir, "mcp0-cur-corrupt.jsonl"),
    `${JSON.stringify({
      type: "run.meta",
      id: "mcp0-cur-corrupt",
      format_version: 1,
      task: "损坏夹具",
      model: "controlled-model",
      created_at: at(20),
      parent: null,
      fork: null,
    })}\n{"type":"span","id":\n`,
  );
  writeFileSync(
    join(tracesDir, "mcp0-cur-identity.jsonl"),
    `${JSON.stringify({
      type: "run.meta",
      id: "mcp0-cur-other",
      format_version: 1,
      task: "身份错配夹具",
      model: "controlled-model",
      created_at: at(10),
      parent: null,
      fork: null,
    })}\n${JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" })}\n`,
  );

  // ---------------- v2 工作区 ----------------
  const longLeft = "甲".repeat(1_200);
  const longRight = "乙".repeat(1_300);
  const shortTexts = {
    "a.txt": "A\n",
    "b.txt": "B\n",
    "c.txt": "C\n",
    "d.txt": "D\n",
    "e.txt": "E\n",
  };
  const blobOf = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    return { sha256: publishBlob(blobsDir, bytes), bytes: bytes.byteLength };
  };
  const longLeftBlob = blobOf(longLeft);
  const longRightBlob = blobOf(longRight);
  const shortEntries = Object.entries(shortTexts).map(([path, text]) => {
    const blob = blobOf(text);
    return entry(path, blob.sha256, blob.bytes);
  });

  const initialSnapshot = createWorkspaceSnapshot([
    ...shortEntries,
    entry("long.txt", longLeftBlob.sha256, longLeftBlob.bytes),
  ]);
  const finalSnapshot = createWorkspaceSnapshot([
    ...shortEntries,
    entry("long.txt", longRightBlob.sha256, longRightBlob.bytes),
  ]);

  const workspaceRunId = "mcp0-cur-ws";
  const tracer = new JsonlTracer(join(tracesDir, `${workspaceRunId}.jsonl`));
  tracer.startRun({
    id: workspaceRunId,
    format_version: 2,
    task: "续读夹具：v2 工作区",
    model: "controlled-model",
    created_at: at(200),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: workspaceRunId,
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
      messages: [{ role: "user", content: "续读夹具" }],
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
    args: { path: "long.txt" },
  });
  tracer.endSpan(tool, { result: "ok", dur_ms: 1, error: null });
  tracer.endSpan(step, { workspace_snapshot: finalSnapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  return {
    dataDir,
    tracesDir,
    blobsDir,
    runIds,
    corruptFile: "mcp0-cur-corrupt.jsonl",
    identityFile: "mcp0-cur-identity.jsonl",
    bodyRunId: "mcp0-cur-body",
    bodySpanId: body.tool,
    spansRunId: "mcp0-cur-spans",
    workspaceRunId,
    workspaceStepSpanId: step,
    longPath: "long.txt",
    longLeftChars: [...longLeft].length,
    longRightChars: [...longRight].length,
    longLeftSha: longLeftBlob.sha256,
    longRightSha: longRightBlob.sha256,
    attachmentHashes: [
      ...shortEntries.map((item) => item.sha256),
      longLeftBlob.sha256,
      longRightBlob.sha256,
    ],
  };
}

export function cleanupCursorFixtures(): void {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRun(
  tracesDir: string,
  id: string,
  createdAt: string,
  task: string,
  toolResult: unknown,
  toolSpans: number,
): { readonly step: string; readonly llm: string; readonly tool: string } {
  const tracer = new JsonlTracer(join(tracesDir, `${id}.jsonl`));
  tracer.startRun({
    id,
    format_version: 1,
    task,
    model: "controlled-model",
    created_at: createdAt,
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
      messages: [{ role: "user", content: "续读夹具" }],
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
  let firstTool = "";
  for (let index = 0; index < toolSpans; index += 1) {
    const tool = tracer.startSpan({
      kind: "tool.invoke",
      parent: step,
      tool: `read_${index}`,
      args: { path: `f-${index}.txt` },
    });
    if (index === 0) firstTool = tool;
    tracer.endSpan(tool, {
      result: index === 0 ? toolResult : `ok-${index}`,
      dur_ms: 1,
      error: null,
    });
  }
  tracer.endSpan(step);
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
  return { step, llm, tool: firstTool };
}

/** 改写 run.meta 的 task（保持其余行原文）：只用于来源变化测试 */
export function rewriteRunTask(file: string, task: string): void {
  const lines = readFileSync(file, "utf8").split("\n");
  const meta = JSON.parse(lines[0]) as Record<string, unknown>;
  meta.task = task;
  lines[0] = JSON.stringify(meta);
  writeFileSync(file, lines.join("\n"));
}

/** 新增一条最小合法 run 文件：只用于列表来源变化测试 */
export function addNewRun(tracesDir: string, id: string): void {
  writeRun(tracesDir, id, at(999), "新增 run", "ok", 1);
}
