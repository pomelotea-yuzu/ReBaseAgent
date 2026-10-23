import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import {
  BINARY_BYTES,
  contentBytes,
  contentSha,
  entry,
  publishBlob,
} from "./checkpoint-fixtures.js";

/**
 * MCP0 4.7 的比较夹具（`compare_checkpoint_files` 专用，独立数据目录）。
 *
 * 与 4.6 同理：**各批的事实由各批的夹具钉**——4.6 的 inspect/read 判据里有逐条字面数
 * （不可用附件数、页宽剩余数），往那个目录再加文件会让历史批次随批次漂。
 *
 * 两侧清单刻意做成这样的（每一条都对应一句判据，不是"顺便"）：
 *
 * | 路径 | 初始侧 | 轮末侧 | 要钉的东西 |
 * |---|---|---|---|
 * | `shared.txt` | 同哈希 | 同哈希 | 清单 `same` + 内容结论 `same`（且 `same` 只是引用） |
 * | `late-diff.txt` | 5000 个「甲」+ 左尾 | 5000 个「甲」+ 右尾 | **首 4096 码点完全一样，结论仍须 different**（不凭片段判） |
 * | `left-only.txt` | 有 | 无 | `left_only` + 右侧 `not_found`（不是空文件） |
 * | `right-only.txt` | 无 | 有 | `right_only` |
 * | `picture.bin` | 同一份二进制 | 同一份二进制 | 两侧都 `binary`、无 `text` 键、`textDiffEligible:false` |
 * | `gone.txt` | 清单引用、附件没发布 | 同 | 两侧 `missing` ⇒ 结论 `unavailable`，不伪装成 same |
 * | `tampered.txt` | 哈希不符（等长篡改） | 同 | 两侧 `corrupt`，两句原因可分辨 |
 * | `huge.txt` | 清单声明 8 MiB+1 | 同 | `too_large`（不真占磁盘；共享层在读字节前先挡） |
 * | `dir-blocked.txt` | 附件名下是目录 | 同 | 逐侧 I/O 故障 ⇒ `unavailable` + `STORAGE_IO`，另一侧照常 |
 * | `secret.txt` | 有 canary 正文 | 有 | 清单模式一条正文都不带 |
 * | `filler/*.txt` ×20 | 有 | 无 | 并集条数超默认页宽 20 |
 *
 * 另备四条坏侧靶子：`mcp0-cf-plain`（v1 非隔离）、`mcp0-cf-mismatch`（文件名 ≠ `meta.id`
 * ⇒ 比较层的 `identity_mismatch`，4.7 新增的那行映射就靠它咬）、`mcp0-cf-never`（缺 run）、
 * `mcp0-cf-child`（跨运行比较的另一侧）。
 */

const T0 = "2026-10-21T12:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

/** 超过共享层单文件查看上限（8 MiB）一个字节：清单敢声明，读取前就被挡，不需要真空占磁盘 */
export const TOO_LARGE_BYTES = 8 * 1024 * 1024 + 1;

export const CF_TEXTS = {
  shared: "两侧同内容\n",
  /** 前 5000 码点完全相同，只差在尾部 ⇒ 首段切片看起来一样而结论必须 different */
  leftLate: `${"甲".repeat(5000)}左尾`,
  rightLate: `${"甲".repeat(5000)}右尾`,
  leftOnly: "只在初始清单里的文件\n",
  rightOnly: "只在轮末清单里的文件\n",
  gone: "清单引用了它，但附件从未发布",
  tamperedExpected: "AAAAAAAA",
  tamperedActual: "BBBBBBBB",
  dirBlocked: "附件名下放的是目录",
  secretBody: "SENTINEL-cf-file-body",
  childOnly: "子 run 自己的文件\n",
} as const;

export interface CompareFixtureIds {
  readonly root: string;
  readonly child: string;
  /** v2 未封存（不写终止事件）：该侧仍可读，但要带 TERMINATION_NOT_RECORDED */
  readonly open: string;
  readonly plain: string;
  readonly mismatch: string;
  readonly mismatchRecordedId: string;
  readonly never: string;
}

export interface CompareFixture {
  readonly dataDir: string;
  readonly tracesDir: string;
  readonly blobsDir: string;
  readonly ids: CompareFixtureIds;
  readonly rootInitialSnapshotId: string;
  readonly rootFinalSnapshotId: string;
  readonly childFinalSnapshotId: string;
  readonly rootStepSpanId: string;
  readonly rootToolSpanId: string;
  readonly childStepSpanId: string;
  /** 两侧清单的并集条数（用于分页与 `totals.paths` 判据） */
  readonly unionPathCount: number;
}

const roots: string[] = [];

export function buildCompareFixture(): CompareFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "mcp0-cf-"));
  roots.push(dataDir);
  const tracesDir = join(dataDir, "traces");
  const blobsDir = join(dataDir, "workspace-blobs", "sha256");
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });

  const initial = buildInitial(blobsDir);
  const final = buildFinal(blobsDir);
  const childFinal = buildChildFinal(blobsDir);

  const ids: CompareFixtureIds = {
    root: "mcp0-cf-root",
    child: "mcp0-cf-child",
    open: "mcp0-cf-open",
    plain: "mcp0-cf-plain",
    mismatch: "mcp0-cf-mismatch",
    mismatchRecordedId: "mcp0-cf-other",
    never: "mcp0-cf-never",
  };

  // ---------- v2 根：初始 + 一轮轮末 ----------
  const rootTracer = new JsonlTracer(join(tracesDir, `${ids.root}.jsonl`));
  rootTracer.startRun({
    id: ids.root,
    format_version: 2,
    task: "MCP0 4.7 比较夹具：v2 根",
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
  const rootSpans = writeStep(rootTracer, final, "SENTINEL-cf-tool-result");
  rootTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---------- v2 结果分叉子（跨运行比较的另一侧）----------
  const childTracer = new JsonlTracer(join(tracesDir, `${ids.child}.jsonl`), {
    spanSeqStart: 20,
  });
  childTracer.startRun({
    id: ids.child,
    format_version: 2,
    task: "MCP0 4.7 比较夹具：v2 分叉子",
    model: "controlled-model",
    created_at: at(50),
    parent: ids.root,
    fork: {
      at_span: rootSpans.toolSpanId,
      edit: { field: "result", value: "SENTINEL-cf-fork-edit-value" },
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
      messages: [{ role: "user", content: "SENTINEL-cf-user" }],
    },
  });
  childTracer.endSpan(childLlm, {
    response: {
      content: "SENTINEL-cf-response",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 20, out: 3 },
      ttft_ms: 1,
    },
  });
  childTracer.endSpan(childStep, { workspace_snapshot: childFinal });
  childTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---------- v2 未封存（只关句柄、不补终止事件）：已落盘检查点仍是事故现场 ----------
  const openTracer = new JsonlTracer(join(tracesDir, `${ids.open}.jsonl`));
  openTracer.startRun({
    id: ids.open,
    format_version: 2,
    task: "MCP0 4.7 比较夹具：v2 未封存",
    model: "controlled-model",
    created_at: at(45),
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
  writeStep(openTracer, final, "SENTINEL-cf-open-result");
  openTracer.dispose();

  // ---------- v1 非隔离（坏侧靶子）----------
  const plainTracer = new JsonlTracer(join(tracesDir, `${ids.plain}.jsonl`));
  plainTracer.startRun({
    id: ids.plain,
    format_version: 1,
    task: "MCP0 4.7 比较夹具：v1 非隔离",
    model: "controlled-model",
    created_at: at(40),
    parent: null,
    fork: null,
    config_hash: "sha256:controlled-config",
  });
  const plainStep = plainTracer.startSpan({ kind: "agent.step", n: 1 });
  plainTracer.endSpan(plainStep);
  plainTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // ---------- 身份错配（比较层的 identity_mismatch 靶子）----------
  const mismatchTracer = new JsonlTracer(join(tracesDir, `${ids.mismatch}.jsonl`));
  mismatchTracer.startRun({
    id: ids.mismatchRecordedId,
    format_version: 2,
    task: "MCP0 4.7 比较夹具：身份错配",
    model: "controlled-model",
    created_at: at(30),
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
  writeStep(mismatchTracer, final, "SENTINEL-cf-mismatch-result");
  mismatchTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  const unionPathCount = new Set([...initial.files, ...final.files].map((file) => file.path)).size;

  return {
    dataDir,
    tracesDir,
    blobsDir,
    ids,
    rootInitialSnapshotId: initial.id,
    rootFinalSnapshotId: final.id,
    childFinalSnapshotId: childFinal.id,
    rootStepSpanId: rootSpans.stepSpanId,
    rootToolSpanId: rootSpans.toolSpanId,
    childStepSpanId: childStep,
    unionPathCount,
  };
}

export function cleanupCompareFixtures(): void {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 初始清单：9 条具名靶子 + 20 条 filler（把并集抬过默认页宽 20） */
function buildInitial(blobsDir: string) {
  const sharedSha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.shared, "utf8"));
  const leftLateSha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.leftLate, "utf8"));
  const leftOnlySha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.leftOnly, "utf8"));
  const binarySha = publishBlob(blobsDir, BINARY_BYTES);
  const secretSha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.secretBody, "utf8"));
  const goneSha = contentSha(CF_TEXTS.gone);
  const tamperedSha = contentSha(CF_TEXTS.tamperedExpected);
  const hugeSha = contentSha("超限文件从不发布");
  // 篡改附件：名字必须是清单里那条哈希，内容才是等长的另一份
  writeFileSync(join(blobsDir, tamperedSha), Buffer.from(CF_TEXTS.tamperedActual, "utf8"));
  // 「附件名下是目录」：名字仍是清单里那条哈希，位置上放的却是目录
  const blockedSha = contentSha(CF_TEXTS.dirBlocked);
  mkdirSync(join(blobsDir, blockedSha), { recursive: true });
  writeFileSync(join(blobsDir, blockedSha, "inner.txt"), "目录里的东西不是附件\n", "utf8");

  const files = [
    entry("dir-blocked.txt", blockedSha, contentBytes(CF_TEXTS.dirBlocked)),
    entry("gone.txt", goneSha, contentBytes(CF_TEXTS.gone)),
    entry("huge.txt", hugeSha, TOO_LARGE_BYTES),
    entry("late-diff.txt", leftLateSha, contentBytes(CF_TEXTS.leftLate)),
    entry("left-only.txt", leftOnlySha, contentBytes(CF_TEXTS.leftOnly)),
    entry("picture.bin", binarySha, BINARY_BYTES.byteLength),
    entry("secret.txt", secretSha, contentBytes(CF_TEXTS.secretBody)),
    entry("shared.txt", sharedSha, contentBytes(CF_TEXTS.shared)),
    entry("tampered.txt", tamperedSha, contentBytes(CF_TEXTS.tamperedExpected)),
  ];
  for (let index = 1; index <= 20; index += 1) {
    const text = `填充文件 ${index}\n`;
    files.push(
      entry(`filler/f${String(index).padStart(2, "0")}.txt`, contentSha(text), contentBytes(text)),
    );
    writeFileSync(join(blobsDir, contentSha(text)), Buffer.from(text, "utf8"));
  }
  return createWorkspaceSnapshot(files);
}

/** 轮末清单：与初始同哈希的三条 + 首段相同尾段不同 + 只在本侧存在的两条 + 同样的坏侧靶子 */
function buildFinal(blobsDir: string) {
  const sharedSha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.shared, "utf8"));
  const rightLateSha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.rightLate, "utf8"));
  const rightOnlySha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.rightOnly, "utf8"));
  const binarySha = publishBlob(blobsDir, BINARY_BYTES);
  const goneSha = contentSha(CF_TEXTS.gone);
  const tamperedSha = contentSha(CF_TEXTS.tamperedExpected);
  const hugeSha = contentSha("超限文件从不发布");
  const blockedSha = contentSha(CF_TEXTS.dirBlocked);
  const secretSha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.secretBody, "utf8"));
  return createWorkspaceSnapshot([
    entry("dir-blocked.txt", blockedSha, contentBytes(CF_TEXTS.dirBlocked)),
    entry("gone.txt", goneSha, contentBytes(CF_TEXTS.gone)),
    entry("huge.txt", hugeSha, TOO_LARGE_BYTES),
    entry("late-diff.txt", rightLateSha, contentBytes(CF_TEXTS.rightLate)),
    entry("picture.bin", binarySha, BINARY_BYTES.byteLength),
    entry("right-only.txt", rightOnlySha, contentBytes(CF_TEXTS.rightOnly)),
    entry("secret.txt", secretSha, contentBytes(CF_TEXTS.secretBody)),
    entry("shared.txt", sharedSha, contentBytes(CF_TEXTS.shared)),
    entry("tampered.txt", tamperedSha, contentBytes(CF_TEXTS.tamperedExpected)),
  ]);
}

/** 子 run 的轮末清单（跨运行比较用） */
function buildChildFinal(blobsDir: string) {
  const sharedSha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.shared, "utf8"));
  const onlySha = publishBlob(blobsDir, Buffer.from(CF_TEXTS.childOnly, "utf8"));
  return createWorkspaceSnapshot([
    entry("child-only.txt", onlySha, contentBytes(CF_TEXTS.childOnly)),
    entry("shared.txt", sharedSha, contentBytes(CF_TEXTS.shared)),
  ]);
}

function writeStep(
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
      messages: [{ role: "user", content: "SENTINEL-cf-body" }],
    },
  });
  tracer.endSpan(llm, {
    response: {
      content: "SENTINEL-cf-response",
      reasoning_content: null,
      tool_calls: [],
      usage: { in: 40, out: 4 },
      ttft_ms: 1,
    },
  });
  const tool = tracer.startSpan({
    kind: "tool.invoke",
    parent: step,
    tool: "write_file",
    args: { path: "shared.txt", content: "SENTINEL-cf-args" },
  });
  tracer.endSpan(tool, { result: toolResult, dur_ms: 1, error: null });
  tracer.endSpan(step, { workspace_snapshot: snapshot });
  return { stepSpanId: step, toolSpanId: tool };
}
