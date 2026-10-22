import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { LONG_BODY } from "./query-fixtures.js";

/**
 * MCP0 4.6 的检查点夹具（`inspect_checkpoint` / `read_checkpoint_file` 专用，独立数据目录）。
 *
 * 为什么单开一个目录：4.3–4.5 的列表/详情判据钉的是**那个目录里的条目数与页宽**，
 * 往共用夹具里加 run 会让历史批次的断言随批次漂（4.5 就为改夹具改判过 4.3 一条）。
 * 各批的事实由各批的夹具钉，历史回查脚本才不会变成假红源。
 *
 * 全部走 `JsonlTracer` 真写 + `createWorkspaceSnapshot` 真算快照 id + **真发布附件**
 * （`workspace-blobs/sha256/<hash>`）：附件的 ok/missing/corrupt 只有磁盘上真的有、
 * 没有、或与哈希不符时才存在，手写 JSON 行造不出这几种状态。
 *
 * 覆盖矩阵：
 * - `mcp0-cp-root`：v2 隔离根（import 世界），30 条文件的初始清单（超默认页宽 20）
 *   + 第一轮轮末检查点；初始清单逐条备齐**文本（CRLF / 空串 / 无尾换行 / 长文本）、
 *   二进制、附件缺失、长度不符、哈希不符**；
 * - `mcp0-cp-child`：以根的轮末检查点为起点的 v2 结果分叉子（「相对初始」= 子自己的初始）；
 * - `mcp0-cp-open`：v2 未封存（不写终止事件）——已落盘检查点仍可读；
 * - `mcp0-cp-plain`：v1 非隔离 run ⇒ 没有文件检查点；
 * - `mcp0-cp-io`：附件名下放的是**目录** ⇒ 真实 I/O 故障，不是文件的一种状态；
 * - `mcp0-cp-mismatch`：文件名与 `meta.id` 不一致 ⇒ 身份错配；
 * - `mcp0-cp-corrupt`：第二行不是合法记录 ⇒ 解析失败；
 * - `<dataDir>/current-source/gone.txt`：**当前目录里的同名新文件**，用来钉「不读别处补齐」。
 */

const T0 = "2026-10-21T00:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

/** 文本的内容哈希（测试据此核对「完整历史文件的哈希」而不是片段的） */
export function contentSha(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 字节的内容哈希：二进制条目按原始字节算，不经任何字符串往返 */
export function bytesSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function contentBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 严格 UTF-8 解不出来的字节：PNG 魔数 + NUL + 非法起始字节（二进制判据的靶子） */
export const BINARY_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x41, 0x42,
]);

/** 各形态的文件内容常量：测试逐条按常量核对，不靠「看起来差不多」 */
export const FILE_TEXTS = {
  /** CRLF + 尾随换行：换行不得被规范化 */
  crlf: "第一行\r\n第二行\r\n",
  /** 空文件：外发必须是空串，既不是「未找到」也不是 null */
  empty: "",
  /** 无尾换行：与 crlf 相对照 */
  noeol: "末尾没有换行",
  same: "两侧相同的内容\n",
  /** 只在轮末清单出现 ⇒ 相对初始是 added */
  added: "本轮新增的一行\n",
  /** noeol.txt 在轮末被改写 ⇒ 相对初始是 modified */
  modified: "末尾没有换行→这一轮改过并补了换行\n",
  childOnly: "只有子 run 才有的文件\n",
  /** 清单引用了它，但附件从未发布 ⇒ missing */
  gone: "清单引用了它，但附件从未发布",
  /** 哈希不符、长度相同 ⇒ corrupt */
  tamperedHashExpected: "AAAAAAAA",
  tamperedHashActual: "BBBBBBBB",
  /** 长度不符 ⇒ corrupt */
  tamperedLenExpected: "期望的内容",
  tamperedLenActual: "附件名下实际是更长的内容",
  ioProbe: "附件位置被目录顶替",
  /** 只在**未请求**的清单条目里出现的 canary：任何结果都不该带出它的正文 */
  fileBodyCanary: "SENTINEL-cp-file-body",
} as const;

export interface CheckpointFixtureIds {
  readonly root: string;
  readonly child: string;
  readonly open: string;
  readonly plain: string;
  readonly ioRun: string;
  readonly mismatch: string;
  readonly mismatchRecordedId: string;
  readonly corrupt: string;
  readonly never: string;
}

export interface CheckpointFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly blobsDir: string;
  readonly ids: CheckpointFixtureIds;
  readonly rootInitialSnapshotId: string;
  readonly rootFinalSnapshotId: string;
  readonly childFinalSnapshotId: string;
  readonly ioSnapshotId: string;
  /** 根 run 自有的完成 step 与其内部工具 span（子 run 的分叉点） */
  readonly rootStepSpanId: string;
  readonly rootToolSpanId: string;
  readonly childStepSpanId: string;
  /** 初始清单条数（20 条 filler 把它抬过默认页宽） */
  readonly initialFileCount: number;
}

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp0-cp-"));
  roots.push(dir);
  return dir;
}

export function cleanupCheckpointFixtures(): void {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 目录**递归**逐文件指纹（相对名 + 内容哈希 + 目录标记）。
 * 只读查询跑完再取一次，两边必须逐字相同——「没写盘」是被比较出来的，不是声明的。
 */
export function dirFingerprintRecursive(dir: string): string {
  const base = resolve(dir);
  const lines: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const absolute = join(current, entry.name);
      const relative = absolute.slice(base.length + 1).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        lines.push(`${relative}:dir`);
        walk(absolute);
        continue;
      }
      lines.push(`${relative}:${contentSha(readFileSync(absolute).toString("utf8"))}`);
    }
  };
  walk(base);
  return lines.join("\n");
}

function publish(blobsDir: string, bytes: Uint8Array): string {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(blobsDir, sha256), bytes);
  return sha256;
}

function entry(path: string, sha256: string, bytes: number) {
  return { path, sha256, bytes };
}

/** 初始清单：文本 / 二进制 / 缺失 / 长度不符 / 哈希不符 + 20 条 filler（把总数抬过默认页宽） */
function buildInitialSnapshot(blobsDir: string): ReturnType<typeof createWorkspaceSnapshot> {
  const files = [
    entry("empty.txt", publish(blobsDir, Buffer.alloc(0)), 0),
    // 只写清单、不发布附件 ⇒ missing
    entry("gone.txt", contentSha(FILE_TEXTS.gone), contentBytes(FILE_TEXTS.gone)),
    entry("long.txt", publish(blobsDir, Buffer.from(LONG_BODY, "utf8")), contentBytes(LONG_BODY)),
    entry(
      "noeol.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.noeol, "utf8")),
      contentBytes(FILE_TEXTS.noeol),
    ),
    entry(
      "notes/crlf.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.crlf, "utf8")),
      contentBytes(FILE_TEXTS.crlf),
    ),
    entry("picture.bin", publish(blobsDir, BINARY_BYTES), BINARY_BYTES.byteLength),
    entry(
      "same.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.same, "utf8")),
      contentBytes(FILE_TEXTS.same),
    ),
    // 清单记的哈希属于 AAAAAAAA，附件名下放的是等长的 BBBBBBBB ⇒ 长度对、哈希不符
    entry(
      "tampered-hash.txt",
      contentSha(FILE_TEXTS.tamperedHashExpected),
      contentBytes(FILE_TEXTS.tamperedHashExpected),
    ),
    // 清单记的长度属于「期望的内容」，附件名下是更长的另一份 ⇒ 长度不符
    entry(
      "tampered-len.txt",
      contentSha(FILE_TEXTS.tamperedLenExpected),
      contentBytes(FILE_TEXTS.tamperedLenExpected),
    ),
    // 正文 canary 文件：只在显式请求时才允许出门
    entry(
      "secret.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.fileBodyCanary, "utf8")),
      contentBytes(FILE_TEXTS.fileBodyCanary),
    ),
  ];
  for (let index = 1; index <= 20; index += 1) {
    const text = `填充文件 ${index}\n`;
    files.push(
      entry(`filler/f${String(index).padStart(2, "0")}.txt`, contentSha(text), contentBytes(text)),
    );
    writeFileSync(join(blobsDir, contentSha(text)), Buffer.from(text, "utf8"));
  }
  // 两条篡改附件：名字必须是**清单里记的那个哈希**，内容才是别的东西
  writeFileSync(
    join(blobsDir, contentSha(FILE_TEXTS.tamperedHashExpected)),
    Buffer.from(FILE_TEXTS.tamperedHashActual, "utf8"),
  );
  writeFileSync(
    join(blobsDir, contentSha(FILE_TEXTS.tamperedLenExpected)),
    Buffer.from(FILE_TEXTS.tamperedLenActual, "utf8"),
  );
  return createWorkspaceSnapshot(files);
}

/** 轮末清单：unchanged / added / modified 三态齐备，初始里的其余文件本轮不存在 */
function buildFinalSnapshot(blobsDir: string): ReturnType<typeof createWorkspaceSnapshot> {
  return createWorkspaceSnapshot([
    entry(
      "added.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.added, "utf8")),
      contentBytes(FILE_TEXTS.added),
    ),
    entry("long.txt", publish(blobsDir, Buffer.from(LONG_BODY, "utf8")), contentBytes(LONG_BODY)),
    entry(
      "notes/crlf.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.crlf, "utf8")),
      contentBytes(FILE_TEXTS.crlf),
    ),
    entry(
      "noeol.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.modified, "utf8")),
      contentBytes(FILE_TEXTS.modified),
    ),
    entry(
      "same.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.same, "utf8")),
      contentBytes(FILE_TEXTS.same),
    ),
  ]);
}

/** 子 run 的轮末清单：相对**子自己的初始**（= 根的轮末）判 added / unchanged */
function buildChildFinalSnapshot(
  blobsDir: string,
  final: ReturnType<typeof createWorkspaceSnapshot>,
): ReturnType<typeof createWorkspaceSnapshot> {
  const unchanged = final.files.find((file) => file.path === "added.txt");
  if (unchanged === undefined) {
    throw new Error("夹具异常：轮末清单里没有 added.txt");
  }
  return createWorkspaceSnapshot([
    entry("added.txt", unchanged.sha256, unchanged.bytes),
    entry(
      "child-only.txt",
      publish(blobsDir, Buffer.from(FILE_TEXTS.childOnly, "utf8")),
      contentBytes(FILE_TEXTS.childOnly),
    ),
  ]);
}

/** 附件名下放目录（不是文件）的清单：边界拒绝 ⇒ 真实 I/O 故障 */
function buildIoSnapshot(blobsDir: string): ReturnType<typeof createWorkspaceSnapshot> {
  const bytes = Buffer.from(FILE_TEXTS.ioProbe, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(blobsDir, sha256), { recursive: true });
  writeFileSync(join(blobsDir, sha256, "inner.txt"), "目录里的内容不该被当成附件\n", "utf8");
  return createWorkspaceSnapshot([entry("weird.txt", sha256, bytes.byteLength)]);
}

/** 写一步 v2 隔离执行：一次 llm.call + 一次 write_file，轮末落 `snapshot` */
function writeIsolatedStep(
  tracer: JsonlTracer,
  snapshot: ReturnType<typeof createWorkspaceSnapshot>,
  toolResult: string,
): { readonly stepSpanId: string; readonly toolSpanId: string } {
  const step = tracer.startSpan({ kind: "agent.step", n: 1 });
  const llm = tracer.startSpan({
    kind: "llm.call",
    parent: step,
    request: {
      model: "controlled-model",
      messages: [
        { role: "system", content: "SENTINEL-cp-system-body" },
        { role: "user", content: "SENTINEL-cp-user-body" },
      ],
    },
  });
  tracer.endSpan(llm, {
    response: {
      content: "SENTINEL-cp-response-content",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 60, out: 6 },
      ttft_ms: 2,
    },
  });
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "write_file",
    args: { path: "notes/crlf.txt", content: "SENTINEL-cp-tool-args" },
  });
  tracer.endSpan(tool, { result: toolResult, dur_ms: 1, error: null });
  tracer.endSpan(step, { workspace_snapshot: snapshot });
  return { stepSpanId: step, toolSpanId: tool };
}

export function buildCheckpointFixture(): CheckpointFixture {
  const dataDir = tempDir();
  const tracesDir = join(dataDir, "traces");
  const blobsDir = join(dataDir, "workspace-blobs", "sha256");
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });

  const initial = buildInitialSnapshot(blobsDir);
  const final = buildFinalSnapshot(blobsDir);
  const childFinal = buildChildFinalSnapshot(blobsDir, final);
  const ioSnapshot = buildIoSnapshot(blobsDir);

  const ids: CheckpointFixtureIds = {
    root: "mcp0-cp-root",
    child: "mcp0-cp-child",
    open: "mcp0-cp-open",
    plain: "mcp0-cp-plain",
    ioRun: "mcp0-cp-io",
    mismatch: "mcp0-cp-mismatch",
    mismatchRecordedId: "mcp0-cp-other",
    corrupt: "mcp0-cp-corrupt",
    never: "mcp0-cp-never",
  };

  // ---------- v2 隔离根 ----------
  const rootTracer = new JsonlTracer(join(tracesDir, `${ids.root}.jsonl`));
  rootTracer.startRun({
    id: ids.root,
    format_version: 2,
    task: "MCP0 4.6 检查点夹具：v2 隔离根",
    model: "controlled-model",
    created_at: at(60),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: ids.root,
      write_authorized: true,
      initial_snapshot: initial,
      origin: { kind: "import" },
    },
  });
  const rootSpans = writeIsolatedStep(rootTracer, final, "SENTINEL-cp-tool-result");
  rootTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---------- v2 结果分叉子：起点 = 根的轮末检查点 ----------
  const childTracer = new JsonlTracer(join(tracesDir, `${ids.child}.jsonl`), {
    spanSeqStart: 20,
  });
  childTracer.startRun({
    id: ids.child,
    format_version: 2,
    task: "MCP0 4.6 检查点夹具：v2 结果分叉子",
    model: "controlled-model",
    created_at: at(50),
    parent: ids.root,
    fork: {
      at_span: rootSpans.toolSpanId,
      edit: { field: "result", value: "SENTINEL-cp-fork-edit-value" },
      resume_after_step: rootSpans.stepSpanId,
    },
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: ids.child,
      write_authorized: true,
      initial_snapshot: final,
      origin: { kind: "checkpoint", run_id: ids.root, step_span: rootSpans.stepSpanId },
    },
  });
  const childStep = childTracer.startSpan({ kind: "agent.step", n: 1 });
  const childLlm = childTracer.startSpan({
    kind: "llm.call",
    parent: childStep,
    request: {
      model: "controlled-model",
      messages: [{ role: "user", content: "SENTINEL-cp-child-user" }],
    },
  });
  childTracer.endSpan(childLlm, {
    response: {
      content: "SENTINEL-cp-child-response",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 20, out: 3 },
      ttft_ms: 1,
    },
  });
  childTracer.endSpan(childStep, { workspace_snapshot: childFinal });
  childTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  const openTracer = new JsonlTracer(join(tracesDir, `${ids.open}.jsonl`));
  openTracer.startRun({
    id: ids.open,
    format_version: 2,
    task: "MCP0 4.6 检查点夹具：v2 未封存",
    model: "controlled-model",
    created_at: at(40),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: ids.open,
      write_authorized: true,
      initial_snapshot: initial,
      origin: { kind: "import" },
    },
  });
  writeIsolatedStep(openTracer, final, "SENTINEL-cp-open-result");
  openTracer.dispose();

  // ---------- v1 非隔离 run ----------
  const plainTracer = new JsonlTracer(join(tracesDir, `${ids.plain}.jsonl`));
  plainTracer.startRun({
    id: ids.plain,
    format_version: 1,
    task: "MCP0 4.6 检查点夹具：v1 非隔离",
    model: "controlled-model",
    created_at: at(30),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
  });
  const plainStep = plainTracer.startSpan({ kind: "agent.step", n: 1 });
  plainTracer.endSpan(plainStep);
  plainTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---------- 附件名下是目录（真实 I/O 故障）----------
  const ioTracer = new JsonlTracer(join(tracesDir, `${ids.ioRun}.jsonl`));
  ioTracer.startRun({
    id: ids.ioRun,
    format_version: 2,
    task: "MCP0 4.6 检查点夹具：附件位置被目录顶替",
    model: "controlled-model",
    created_at: at(20),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: ids.ioRun,
      write_authorized: true,
      initial_snapshot: ioSnapshot,
      origin: { kind: "import" },
    },
  });
  writeIsolatedStep(ioTracer, ioSnapshot, "SENTINEL-cp-io-result");
  ioTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---------- 身份错配（文件名 ≠ meta.id）----------
  const mismatchTracer = new JsonlTracer(join(tracesDir, `${ids.mismatch}.jsonl`));
  mismatchTracer.startRun({
    id: ids.mismatchRecordedId,
    format_version: 2,
    task: "MCP0 4.6 检查点夹具：身份错配",
    model: "controlled-model",
    created_at: at(10),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
    workspace: {
      profile: "file-tools-v1",
      world_id: ids.mismatchRecordedId,
      write_authorized: true,
      initial_snapshot: final,
      origin: { kind: "import" },
    },
  });
  writeIsolatedStep(mismatchTracer, final, "SENTINEL-cp-mismatch-result");
  mismatchTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---------- 解析失败 ----------
  writeFileSync(
    join(tracesDir, `${ids.corrupt}.jsonl`),
    `{"type":"run.meta","id":"${ids.corrupt}","format_version":2,"task":"损坏","model":"controlled-model","created_at":"${at(5)}","parent":null,"fork":null}
{"type":"span","id":
`,
  );

  // ---------- 「当前目录里有同名新文件」：读取一律不看这里 ----------
  mkdirSync(join(dataDir, "current-source"), { recursive: true });
  writeFileSync(
    join(dataDir, "current-source", "gone.txt"),
    "今天的版本，与历史清单无关\n",
    "utf8",
  );

  return {
    dataDir,
    tracesDir,
    blobsDir,
    ids,
    rootInitialSnapshotId: initial.id,
    rootFinalSnapshotId: final.id,
    childFinalSnapshotId: childFinal.id,
    ioSnapshotId: ioSnapshot.id,
    rootStepSpanId: rootSpans.stepSpanId,
    rootToolSpanId: rootSpans.toolSpanId,
    childStepSpanId: childStep,
    initialFileCount: initial.files.length,
  };
}
