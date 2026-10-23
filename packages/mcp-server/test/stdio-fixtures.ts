import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { entry, publishBlob } from "./checkpoint-fixtures.js";

/**
 * MCP0 5.3 的真实 stdio 夹具（**独立数据根**，不与 4.x/5.1/5.2 共用）。
 *
 * 批次规则：历史批次的字面判据（页宽、失败项数、并集条数）不能被新夹具牵着漂，
 * 所以这里单独建根。里面的形状只服务 5.3 要证的三件事：
 * - **翻页要真有下一页**：24 条成功 run > 默认页宽 20 ⇒ `list_runs` 必发 `nextCursor`，
 *   真实重启后这条游标必须落 `STALE_CURSOR`（S13）；
 * - **正文要真读得动**：一条 9,000 码点（含代理对）的 tool 结果 ⇒ 单段读不完、
 *   EOF 与取消都发生在"有内容可断"的请求上（S13/S14）；
 * - **七个工具都要能在无桌面的子进程里调通**：v2 工作区 run + 附件 blob ⇒
 *   inspect / read / compare 走真实文件（S01）。
 *
 * 另备**第二个数据根**（一条可辨认 id 的 run）：只用来证"服务只访问启动时那一个根"。
 */

const T0 = "2026-10-22T00:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

/** 列表夹具条数：> 默认页宽 20，且 5.3 期间恒定 */
export const STDIO_LIST_RUNS = 24;
/** 大正文夹具：码点数（含 emoji 代理对），单段 maxChars 读不完 */
export const STDIO_LONG_BODY = `${"结果🙂".repeat(3_000)}收尾`;
export const STDIO_BODY_CHARS = [...STDIO_LONG_BODY].length;
/** 数据根之外的对照 run 标识（出现在第二个根里，主根查询不得见到它） */
export const STDIO_OTHER_RUN_ID = "mcp0-std-other-00";
export const STDIO_LATE_RUN_ID = "mcp0-std-late";

export interface StdioFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly blobsDir: string;
  /** 24 条列表夹具 id（created_at 互不相同，倒序可判） */
  readonly listRunIds: readonly string[];
  readonly bodyRunId: string;
  readonly bodySpanId: string;
  readonly workspaceRunId: string;
  readonly workspaceStepSpanId: string;
  readonly unsealedRunId: string;
  readonly filePath: string;
  /** 主根里的 run 文件总数（含未封存那条，不含后面新增的 late） */
  readonly runFileCount: number;
}

const roots: string[] = [];

function makeRoot(): { dataDir: string; tracesDir: string; blobsDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp0-stdio-"));
  roots.push(dataDir);
  const tracesDir = join(dataDir, "traces");
  const blobsDir = join(dataDir, "workspace-blobs", "sha256");
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });
  return { dataDir, tracesDir, blobsDir };
}

export function buildStdioFixture(): StdioFixture {
  const { dataDir, tracesDir, blobsDir } = makeRoot();

  const listRunIds: string[] = [];
  for (let index = 0; index < STDIO_LIST_RUNS; index += 1) {
    const id = `mcp0-std-${String(index).padStart(2, "0")}`;
    listRunIds.push(id);
    writeRun(tracesDir, id, at(1_000 - index * 10), `协议夹具 ${index}`, "ok", 1);
  }

  const body = writeRun(tracesDir, "mcp0-std-body", at(500), "大正文夹具", STDIO_LONG_BODY, 1);
  writeRun(tracesDir, "mcp0-std-ws-plain", at(450), "对照短夹具", "ok", 1);

  // 未封存：只写到 span 落盘，不调 endRun ⇒ 读得到已落盘记录，但 sealed=false
  const unsealedRunId = "mcp0-std-unsealed";
  const unsealed = new JsonlTracer(join(tracesDir, `${unsealedRunId}.jsonl`));
  unsealed.startRun({
    id: unsealedRunId,
    format_version: 1,
    task: "未封存夹具",
    model: "controlled-model",
    created_at: at(300),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
  });
  const unsealedStep = unsealed.startSpan({ kind: "agent.step", n: 1 });
  unsealed.endSpan(unsealedStep);

  // v2 工作区：初始 / 轮末两份清单 + 内容寻址附件，供 inspect / read / compare 走真实文件
  const shortTexts: Record<string, string> = {
    "a.txt": "A\n",
    "b.txt": "B\n",
    "c.txt": "C\n",
  };
  const shortEntries = Object.entries(shortTexts).map(([path, text]) => {
    const bytes = Buffer.from(text, "utf8");
    return entry(path, publishBlob(blobsDir, bytes), bytes.byteLength);
  });
  const initialBody = "初版甲".repeat(1_200);
  const finalBody = "末版乙".repeat(1_300);
  const bytesOf = (text: string) => Buffer.from(text, "utf8");
  const initialBlob = bytesOf(initialBody);
  const finalBlob = bytesOf(finalBody);
  const initialSnapshot = createWorkspaceSnapshot([
    ...shortEntries,
    entry("long.txt", publishBlob(blobsDir, initialBlob), initialBlob.byteLength),
  ]);
  const finalSnapshot = createWorkspaceSnapshot([
    ...shortEntries,
    entry("long.txt", publishBlob(blobsDir, finalBlob), finalBlob.byteLength),
  ]);

  const workspaceRunId = "mcp0-std-ws";
  const tracer = new JsonlTracer(join(tracesDir, `${workspaceRunId}.jsonl`));
  tracer.startRun({
    id: workspaceRunId,
    format_version: 2,
    task: "stdio 夹具：v2 工作区",
    model: "controlled-model",
    created_at: at(400),
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
      messages: [{ role: "user", content: "stdio 夹具" }],
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
    listRunIds,
    bodyRunId: "mcp0-std-body",
    bodySpanId: body.tool,
    workspaceRunId,
    workspaceStepSpanId: step,
    unsealedRunId,
    filePath: "long.txt",
    runFileCount: STDIO_LIST_RUNS + 4,
  };
}

/** 第二个数据根：合法但属于"别处"，主根查询绝不能看见里面的 run */
export function buildOtherRoot(): string {
  const { dataDir, tracesDir } = makeRoot();
  writeRun(tracesDir, STDIO_OTHER_RUN_ID, at(900), "另一个数据根的 run", "ok", 1);
  return dataDir;
}

/** 空 traces 的合法根（S01 的"空列表"半边，与 4.1 各自独立建根）：**只有 traces/，不建附件目录** */
export function buildEmptyRoot(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp0-stdio-"));
  roots.push(dataDir);
  mkdirSync(join(dataDir, "traces"), { recursive: true });
  return dataDir;
}

/** 重启后新增的 run：created_at 最新 ⇒ 新会话首页第一条就是它（证"重新读盘"） */
export function addLateRun(tracesDir: string): string {
  writeRun(tracesDir, STDIO_LATE_RUN_ID, at(9_999), "重启后新增的 run", "ok", 1);
  return STDIO_LATE_RUN_ID;
}

export function cleanupStdioFixtures(): void {
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
      messages: [{ role: "user", content: "stdio 夹具" }],
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
