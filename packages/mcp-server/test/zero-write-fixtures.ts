import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { entry, publishBlob } from "./checkpoint-fixtures.js";

/**
 * MCP0 5.4 的零写入夹具（**第 8 个独立数据根**，不与 4.x/5.1/5.2/5.3 共用）。
 *
 * 独立建根是批次规则：往共享夹具里加 run/文件会让历史批次的字面数（页宽、缺失项、
 * 并集条数）漂。这里的形状只服务两条场景：
 * - **Q15 零执行零写入**：一个数据根里能跑完列表/详情/步骤/运行比较/检查点/文件比较，
 *   外加逐页翻到底、正文续读到末尾、故障与取消——跑完再取整根递归指纹，必须逐字相同；
 * - **Q16 源目录不兜底**：清单里的 `gone.txt` **只登记不发布附件**，同时把一份**同名新文件**
 *   放进数据根内的 `current-source/`（内容带 `SENTINEL-` canary）。读取面既没有源目录通道，
 *   也不得把那份新版本外发或拿去补历史。
 *
 * 三条故障面各自独立可注入（注入之后才取基线指纹，避免把"注入本身改了目录"算成查询的写入）：
 * 坏尾行 run、附件目录替身（`STORAGE_IO`）、缺 run/缺 step（稳定码）。
 */

const T0 = "2026-10-23T00:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

/** 当前源目录里那份"同名新文件"的内容：正文 canary，任何查询结果都不该出现它 */
export const ZW_SENTINEL_TEXT = "SENTINEL-当前源目录的新版本-与历史清单无关";
export const ZW_MISSING_PATH = "gone.txt";
export const ZW_BINARY_PATH = "binary.bin";
export const ZW_TEXT_PATH = "notes.txt";
export const ZW_LONG_PATH = "long.txt";
/** 正文续读要真读得动：单段 4,096 码点读不完 */
export const ZW_LONG_TEXT = "零写入正文🙂".repeat(600);

export interface ZeroWriteFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly blobsDir: string;
  readonly currentSourceDir: string;
  readonly runAId: string;
  readonly runBId: string;
  readonly workspaceRunId: string;
  readonly workspaceStepSpanId: string;
  readonly toolSpanId: string;
  readonly longSha: string;
  readonly longBytes: number;
  readonly missingSha: string;
  readonly missingBytes: number;
  readonly blobHashes: readonly string[];
  readonly corruptFileName: string;
}

const roots: string[] = [];

export function buildZeroWriteFixture(): ZeroWriteFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp0-zw-"));
  roots.push(dataDir);
  const tracesDir = join(dataDir, "traces");
  const blobsDir = join(dataDir, "workspace-blobs", "sha256");
  const currentSourceDir = join(dataDir, "current-source");
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });
  mkdirSync(currentSourceDir, { recursive: true });

  const runAId = "mcp0-zw-a";
  const runBId = "mcp0-zw-b";
  const a = writeRun(tracesDir, runAId, at(1_000), "零写入夹具甲", "甲的工具结果正文", 2);
  writeRun(tracesDir, runBId, at(900), "零写入夹具乙", "乙的工具结果正文", 1);

  // 坏尾行：整份记录无法通过校验（RUN_INVALID 故障面）
  const corruptFileName = "mcp0-zw-corrupt.jsonl";
  writeFileSync(
    join(tracesDir, corruptFileName),
    `${JSON.stringify({
      type: "run.meta",
      id: "mcp0-zw-corrupt",
      format_version: 1,
      task: "坏尾行夹具",
      model: "controlled-model",
      created_at: at(800),
      parent: null,
      fork: null,
    })}\n{"type":"span","id":\n`,
  );

  // ---------------- v2 工作区 ----------------
  const blobs: string[] = [];
  const publish = (text: string | Uint8Array) => {
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
    const sha256 = publishBlob(blobsDir, bytes);
    blobs.push(sha256);
    return { sha256, bytes: bytes.byteLength };
  };
  const notes = publish("零写入 notes\n第二行\n");
  const notesFinal = publish("零写入 notes\n第二行（末版改过）\n");
  const binary = publish(Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x41]));
  const long = publish(ZW_LONG_TEXT);
  // 只登记、不发布 ⇒ missing：哈希按内容算出来，但那份字节永远不进附件目录
  const missingBytes = Buffer.from(ZW_SENTINEL_TEXT, "utf8").byteLength;
  const missingSha = createHash("sha256")
    .update(Buffer.from(ZW_SENTINEL_TEXT, "utf8"))
    .digest("hex");

  const initialManifest = [
    entry(ZW_TEXT_PATH, notes.sha256, notes.bytes),
    entry(ZW_BINARY_PATH, binary.sha256, binary.bytes),
    entry(ZW_LONG_PATH, long.sha256, long.bytes),
    entry(ZW_MISSING_PATH, missingSha, missingBytes),
  ];
  // 末版只换 notes.txt 的引用 ⇒ 两侧比较既有 same 也有 different，还有恒定的 missing
  const finalManifest = initialManifest.map((item) =>
    item.path === ZW_TEXT_PATH ? entry(ZW_TEXT_PATH, notesFinal.sha256, notesFinal.bytes) : item,
  );
  const workspaceRunId = "mcp0-zw-ws";
  const initialSnapshot = createWorkspaceSnapshot(initialManifest);
  const finalSnapshot = createWorkspaceSnapshot(finalManifest);

  const tracer = new JsonlTracer(join(tracesDir, `${workspaceRunId}.jsonl`));
  tracer.startRun({
    id: workspaceRunId,
    format_version: 2,
    task: "零写入夹具：v2 工作区",
    model: "controlled-model",
    created_at: at(2_000),
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
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "read_file",
    args: { path: ZW_LONG_PATH },
  });
  tracer.endSpan(tool, { result: "工作区工具结果", dur_ms: 1, error: null });
  tracer.endSpan(step, { workspace_snapshot: finalSnapshot });
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // "当前源目录里的同名新文件"就在同一个数据根里：它不是历史附件，谁也读不到它
  writeFileSync(join(currentSourceDir, ZW_MISSING_PATH), `${ZW_SENTINEL_TEXT}\n`, "utf8");

  return {
    dataDir,
    tracesDir,
    blobsDir,
    currentSourceDir,
    runAId,
    runBId,
    workspaceRunId,
    workspaceStepSpanId: step,
    toolSpanId: a.tool,
    longSha: long.sha256,
    longBytes: long.bytes,
    missingSha,
    missingBytes,
    blobHashes: blobs,
    corruptFileName,
  };
}

/** 附件目录替身：把已发布的 blob 换成同名目录 ⇒ 读取面走 STORAGE_IO，而不是文件状态 */
export function injectBlobSubstitute(fx: ZeroWriteFixture, sha256: string): void {
  const target = join(fx.blobsDir, sha256);
  rmSync(target, { force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "inner.txt"), "目录替身内部文件\n", "utf8");
}

export function cleanupZeroWriteFixtures(): void {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRun(
  tracesDir: string,
  id: string,
  createdAt: string,
  task: string,
  toolResult: string,
  toolSpans: number,
): { readonly step: string; readonly tool: string } {
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
      messages: [{ role: "user", content: `${task} 的初始消息` }],
    },
  });
  tracer.endSpan(llm, {
    response: {
      content: "模型回复正文",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 10, out: 2 },
      ttft_ms: 1,
    },
  });
  let firstTool = "";
  for (let index = 0; index < toolSpans; index += 1) {
    const tool = tracer.startSpan({
      kind: "tool.invoke",
      parent: step,
      tool: `read_${String(index)}`,
      args: { path: `f-${String(index)}.txt` },
    });
    if (index === 0) firstTool = tool;
    tracer.endSpan(tool, {
      result: index === 0 ? toolResult : `工具结果-${String(index)}`,
      dur_ms: 1,
      error: null,
    });
  }
  tracer.endSpan(step);
  tracer.endRun({ event: "stopped", reason: "completed", at: 1 });
  return { step, tool: firstTool };
}
