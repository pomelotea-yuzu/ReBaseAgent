import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { JsonlTracer, readRun } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBlobError, WorkspaceBlobStore } from "../src/workspace/blob-store";
import { compareWorkspaceSnapshots, readComparedWorkspaceFile } from "../src/workspace/compare-api";
import type {
  CompareWorkspaceSnapshotsResult,
  ExpectedSnapshotIds,
} from "../src/workspace/compare-api";
import { buildIsolatedPromptBaselineCase } from "./isolated-prompt-baseline-fixture";
import { cleanupTempDirs, makeDataDir, round, writeIsolatedRun } from "./workspace-helpers";

/**
 * R2.2 任务 4.1–4.3：跨运行检查点比较（包层）。
 *
 * 判据来源：
 * - workspace「两个自有检查点独立选择与路径并集」「未核验引用不冒充字节相同」
 *   「文本新增删除与原换行可核对」「二进制和读取错误保留逐侧状态」
 *   「选择快照变化不能拼出混合差异」；
 * - design D6：清单引用与内容核验分层；缺省 stepSpanId=初始；同 run 单读；
 *   比较全程只读、不登记 operation/不调模型工具。
 *
 * 证据层：确定性 fixture（真实附件字节/真实 JSONL），不含真实模型与 Electron UI。
 */

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const CRLF_TEXT = '{\r\n  "a": 1\r\n}\r\n';
const LF_TEXT = '{\n  "a": 1\n}\n';
const BIN_A = new Uint8Array([0xff, 0xfe, 0x00]);
const BIN_B = new Uint8Array([0xfe, 0xff]);

function leftRound(): Map<string, string | Uint8Array> {
  return round([
    ["shared.txt", "same"],
    ["left-only.txt", "L"],
    ["config.json", CRLF_TEXT],
    ["empty.txt", ""],
    ["same.txt", "same"],
    ["bin.dat", BIN_A],
    ["bin-diff.dat", BIN_A],
  ]);
}

function leftStepRound(): Map<string, string | Uint8Array> {
  return round([
    ["shared.txt", "same"],
    ["left-only.txt", "L"],
    ["config.json", "step-1-content"],
    ["empty.txt", ""],
    ["same.txt", "same"],
    ["bin.dat", BIN_A],
    ["bin-diff.dat", BIN_A],
    ["step-only.txt", "S"],
  ]);
}

function rightRound(): Map<string, string | Uint8Array> {
  return round([
    ["shared.txt", "same"],
    ["right-only.txt", "R"],
    ["config.json", LF_TEXT],
    ["same.txt", "same"],
    ["bin.dat", BIN_A],
    ["bin-diff.dat", BIN_B],
  ]);
}

async function makePair() {
  const tmp = makeDataDir();
  const left = await writeIsolatedRun({
    dataDir: tmp.dataDir,
    runId: "run_cmp_left",
    rounds: [leftRound(), leftStepRound()],
    spanSeqStart: 0,
  });
  const right = await writeIsolatedRun({
    dataDir: tmp.dataDir,
    runId: "run_cmp_right",
    rounds: [rightRound(), rightRound()],
    spanSeqStart: 100,
  });
  return { tmp, left, right };
}

function comparePair(
  dataDir: string,
  leftRunId: string,
  rightRunId: string,
  over: {
    leftStep?: string;
    rightStep?: string;
    readRecord?: (file: string) => ReturnType<typeof readRun>;
  } = {},
): CompareWorkspaceSnapshotsResult {
  return compareWorkspaceSnapshots({
    dataDir,
    left:
      over.leftStep === undefined
        ? { runId: leftRunId }
        : { runId: leftRunId, stepSpanId: over.leftStep },
    right:
      over.rightStep === undefined
        ? { runId: rightRunId }
        : { runId: rightRunId, stepSpanId: over.rightStep },
    ...(over.readRecord === undefined ? {} : { readRecord: over.readRecord }),
  });
}

function expectedOf(result: CompareWorkspaceSnapshotsResult): ExpectedSnapshotIds {
  if (result.left.status !== "ok" || result.right.status !== "ok") {
    throw new Error("测试前提：两侧清单必须都可用");
  }
  return {
    left: result.left.selected.snapshotId,
    right: result.right.selected.snapshotId,
  };
}

function treeFingerprint(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((relative) => {
      const full = join(root, relative);
      try {
        const stat = statSync(full);
        return `${relative}:${stat.isDirectory() ? "dir" : `${stat.size}:${stat.mtimeMs}`}`;
      } catch {
        return `${relative}:missing`;
      }
    });
}

function blobPath(dataDir: string, sha256: string): string {
  return join(dataDir, "workspace-blobs", "sha256", sha256);
}

function writeRootWithSnapshot(
  dataDir: string,
  runId: string,
  files: Array<{ path: string; sha256: string; bytes: number }>,
): void {
  mkdirSync(join(dataDir, "traces"), { recursive: true });
  const snapshot = createWorkspaceSnapshot(files);
  const tracer = new JsonlTracer(join(dataDir, "traces", `${runId}.jsonl`));
  tracer.startRun({
    id: runId,
    format_version: 2,
    task: "比较用根",
    model: "deepseek-chat",
    created_at: "2026-10-21T00:00:00.000Z",
    parent: null,
    fork: null,
    workspace: {
      profile: "file-tools-v1",
      world_id: runId,
      write_authorized: true,
      initial_snapshot: snapshot,
      origin: { kind: "import" },
    },
  });
  tracer.endRun({ event: "stopped", reason: "completed", at: 0 });
}

describe("compareWorkspaceSnapshots：双 selector、路径并集与引用状态", () => {
  it("两侧初始快照：路径并集按 UTF-16 排序，仅左/仅右/双方 + 引用相同/不同", async () => {
    const { tmp, left, right } = await makePair();
    const result = comparePair(tmp.dataDir, left.runId, right.runId);

    expect(result.unionComplete).toBe(true);
    expect(result.left.status).toBe("ok");
    expect(result.right.status).toBe("ok");
    if (result.left.status !== "ok" || result.right.status !== "ok") return;
    expect(result.left.selected.stepSpanId).toBeNull();
    expect(result.right.selected.stepSpanId).toBeNull();
    expect(result.left.selected.snapshotId).toBe(
      createWorkspaceSnapshot(left.roundFiles[0] ?? []).id,
    );
    expect(result.left.selected.initialSnapshotId).toBe(result.left.selected.snapshotId);
    expect(result.right.selected.initialSnapshotId).toBe(result.right.selected.snapshotId);

    const paths = result.entries.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
    const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get("left-only.txt")).toMatchObject({
      presence: "left_only",
      left: { path: "left-only.txt", bytes: 1 },
      right: null,
      reference: null,
    });
    expect(byPath.get("right-only.txt")).toMatchObject({
      presence: "right_only",
      left: null,
      right: { path: "right-only.txt", bytes: 1 },
      reference: null,
    });
    expect(byPath.get("shared.txt")).toMatchObject({
      presence: "both",
      reference: "same",
    });
    expect(byPath.get("config.json")).toMatchObject({
      presence: "both",
      reference: "different",
    });
    expect(byPath.get("bin.dat")?.reference).toBe("same");
  });

  it("同 run 两个 selector：只读一次记录，初始与完成步骤各自冻结", async () => {
    const { tmp, left } = await makePair();
    let reads = 0;
    const result = comparePair(tmp.dataDir, left.runId, left.runId, {
      rightStep: left.stepSpanIds[0],
      readRecord: (file) => {
        reads += 1;
        return readRun(file);
      },
    });

    expect(reads).toBe(1);
    expect(result.unionComplete).toBe(true);
    if (result.left.status !== "ok" || result.right.status !== "ok") return;
    expect(result.left.selected.stepSpanId).toBeNull();
    expect(result.right.selected.stepSpanId).toBe(left.stepSpanIds[0]);
    expect(result.left.selected.snapshotId).toBe(result.right.selected.initialSnapshotId);
    expect(result.right.selected.snapshotId).not.toBe(result.left.selected.snapshotId);
    expect(result.left.requestedStepSpanId).toBeNull();
    expect(result.right.requestedStepSpanId).toBe(left.stepSpanIds[0]);
  });

  it("共同祖先不冒充相同初始状态：同根的根与 result 分支各自冻结不同 initialSnapshotId", async () => {
    const tmp = makeDataDir();
    const fixture = await buildIsolatedPromptBaselineCase({ dataDir: tmp.dataDir });
    const result = comparePair(tmp.dataDir, fixture.root.runId, fixture.sibling!.runId);
    expect(result.unionComplete).toBe(true);
    if (result.left.status !== "ok" || result.right.status !== "ok") return;

    // 两侧共享同一个根，但选择的起点分别是根初始 A 与父轮末 B
    expect(result.left.selected.initialSnapshotId).toBe(fixture.root.initialSnapshotId);
    expect(result.right.selected.initialSnapshotId).toBe(fixture.sibling!.initialSnapshotId);
    expect(result.left.selected.initialSnapshotId).not.toBe(
      result.right.selected.initialSnapshotId,
    );
    expect(result.left.selected.snapshotId).not.toBe(result.right.selected.snapshotId);
    expect(result.entries.find((entry) => entry.path === "config.json")?.reference).toBe(
      "different",
    );
  });

  it("请求 id 与 meta.id 不符：该侧身份错误，不标为选中的 run，并集不完整", async () => {
    const { tmp, left, right } = await makePair();
    const fake = join(tmp.dataDir, "traces", "run_fake_identity.jsonl");
    copyFileSync(left.traceFile, fake);

    const result = comparePair(tmp.dataDir, "run_fake_identity", right.runId);
    expect(result.left.status).toBe("unavailable");
    if (result.left.status === "unavailable") {
      expect(result.left.failure.code).toBe("identity_mismatch");
    }
    expect(result.right.status).toBe("ok");
    expect(result.unionComplete).toBe(false);
    expect(result.entries).toEqual([]);
  });

  it("单侧不可用 / 步骤不属于本 run：保留逐侧原因，并集不完整", async () => {
    const { tmp, left, right } = await makePair();

    const ancestorStep = comparePair(tmp.dataDir, left.runId, right.runId, {
      leftStep: right.stepSpanIds[0],
    });
    expect(ancestorStep.left.status).toBe("unavailable");
    if (ancestorStep.left.status === "unavailable") {
      expect(ancestorStep.left.failure.code).toBe("step_not_found");
    }
    expect(ancestorStep.unionComplete).toBe(false);
    expect(ancestorStep.entries).toEqual([]);

    // v1 普通 run 没有 workspace：不能把"没有清单"当成空清单
    const v1File = join(tmp.dataDir, "traces", "run_v1_plain.jsonl");
    writeFileSync(
      v1File,
      `${JSON.stringify({
        type: "run.meta",
        id: "run_v1_plain",
        format_version: 1,
        task: "普通",
        model: "m",
        created_at: "2026-10-21T00:00:00.000Z",
        parent: null,
        fork: null,
      })}\n${JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" })}\n`,
    );
    const plain = comparePair(tmp.dataDir, left.runId, "run_v1_plain");
    expect(plain.right.status).toBe("unavailable");
    if (plain.right.status === "unavailable") {
      expect(plain.right.failure.code).toBe("no_workspace");
    }
    expect(plain.unionComplete).toBe(false);
    expect(plain.entries).toEqual([]);
  });
});

describe("readComparedWorkspaceFile：延迟核验、文本换行与新增删除", () => {
  it("text/text 保留 CRLF/LF/空串；相同/修改/仅左/仅右/两侧不存在各自结论", async () => {
    const { tmp, left, right } = await makePair();
    const listed = comparePair(tmp.dataDir, left.runId, right.runId);
    const expected = expectedOf(listed);

    const config = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "config.json",
      expectedSnapshotIds: expected,
    });
    expect(config.left.status).toBe("text");
    expect(config.right.status).toBe("text");
    if (config.left.status === "text") expect(config.left.text).toBe(CRLF_TEXT);
    if (config.right.status === "text") expect(config.right.text).toBe(LF_TEXT);
    expect(config.conclusion).toBe("different");
    expect(config.textDiffEligible).toBe(true);

    const empty = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "empty.txt",
      expectedSnapshotIds: expected,
    });
    expect(empty.left.status).toBe("text");
    if (empty.left.status === "text") expect(empty.left.text).toBe("");
    expect(empty.right.status).toBe("not_found");
    expect(empty.conclusion).toBe("left_only");
    expect(empty.textDiffEligible).toBe(true);

    const added = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "right-only.txt",
      expectedSnapshotIds: expected,
    });
    expect(added.left.status).toBe("not_found");
    expect(added.right.status).toBe("text");
    expect(added.conclusion).toBe("right_only");

    const same = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "same.txt",
      expectedSnapshotIds: expected,
    });
    expect(same.conclusion).toBe("same");
    expect(same.textDiffEligible).toBe(true);

    const absent = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "not-in-either.txt",
      expectedSnapshotIds: expected,
    });
    expect(absent.left.status).toBe("not_found");
    expect(absent.right.status).toBe("not_found");
    expect(absent.conclusion).toBe("not_found");
    expect(absent.textDiffEligible).toBe(false);
  });

  it("同 run 两个 selector 的正文读取也只读一次记录", async () => {
    const { tmp, left } = await makePair();
    const listed = comparePair(tmp.dataDir, left.runId, left.runId, {
      rightStep: left.stepSpanIds[0],
    });
    expect(listed.left.status).toBe("ok");
    expect(listed.right.status).toBe("ok");
    if (listed.left.status !== "ok" || listed.right.status !== "ok") return;

    let reads = 0;
    const read = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: left.runId, stepSpanId: left.stepSpanIds[0] },
      path: "config.json",
      expectedSnapshotIds: {
        left: listed.left.selected.snapshotId,
        right: listed.right.selected.snapshotId,
      },
      readRecord: (file) => {
        reads += 1;
        return readRun(file);
      },
    });
    expect(reads).toBe(1);
    expect(read.left.status).toBe("text");
    expect(read.right.status).toBe("text");
    if (read.left.status === "text") expect(read.left.text).toBe(CRLF_TEXT);
    if (read.right.status === "text") expect(read.right.text).toBe("step-1-content");
    expect(read.conclusion).toBe("different");
  });

  it("一侧 selector 不可用：另一侧仍可阅读，整体结论 unavailable", async () => {
    const { tmp, left, right } = await makePair();
    const listed = comparePair(tmp.dataDir, left.runId, right.runId);
    const expected = expectedOf(listed);
    const read = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId, stepSpanId: right.stepSpanIds[0] },
      right: { runId: right.runId },
      path: "config.json",
      expectedSnapshotIds: { left: expected.left, right: expected.right },
    });
    expect(read.left.status).toBe("unavailable");
    if (read.left.status === "unavailable") {
      expect(read.left.failure.code).toBe("step_not_found");
    }
    expect(read.right.status).toBe("text");
    expect(read.conclusion).toBe("unavailable");
    expect(read.textDiffEligible).toBe(false);
  });

  it("二进制：返回原始字节、只给相同/不同，不进文本 diff", async () => {
    const { tmp, left, right } = await makePair();
    const expected = expectedOf(comparePair(tmp.dataDir, left.runId, right.runId));

    const same = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "bin.dat",
      expectedSnapshotIds: expected,
    });
    expect(same.left.status).toBe("binary");
    expect(same.right.status).toBe("binary");
    if (same.left.status === "binary")
      expect(Array.from(same.left.data)).toEqual(Array.from(BIN_A));
    if (same.right.status === "binary")
      expect(Array.from(same.right.data)).toEqual(Array.from(BIN_A));
    expect(same.conclusion).toBe("same");
    expect(same.textDiffEligible).toBe(false);

    const different = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "bin-diff.dat",
      expectedSnapshotIds: expected,
    });
    expect(different.conclusion).toBe("different");
    expect(different.textDiffEligible).toBe(false);
  });

  it("清单引用相同 ≠ 内容已核验：附件删除后读取逐侧 missing，结论不可用", async () => {
    const { tmp, left, right } = await makePair();
    const listed = comparePair(tmp.dataDir, left.runId, right.runId);
    const expected = expectedOf(listed);
    const shared = listed.entries.find((entry) => entry.path === "shared.txt");
    expect(shared?.reference).toBe("same");

    unlinkSync(blobPath(tmp.dataDir, shared?.left?.sha256 ?? ""));
    const read = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "shared.txt",
      expectedSnapshotIds: expected,
    });
    expect(read.left.status).toBe("missing");
    expect(read.right.status).toBe("missing");
    expect(read.conclusion).toBe("unavailable");
    expect(read.textDiffEligible).toBe(false);
  });

  it("附件损坏 + I/O 故障：逐侧状态保留，另一侧仍可读", async () => {
    const { tmp, left, right } = await makePair();
    const expected = expectedOf(comparePair(tmp.dataDir, left.runId, right.runId));

    const corruptTarget = left.roundFiles[0]?.find((file) => file.path === "config.json");
    if (corruptTarget === undefined) throw new Error("fixture 缺少 config.json");
    writeFileSync(
      blobPath(tmp.dataDir, corruptTarget.sha256),
      new Uint8Array(corruptTarget.bytes).fill(120),
    );
    const corrupt = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "config.json",
      expectedSnapshotIds: expected,
    });
    expect(corrupt.left.status).toBe("corrupt");
    expect(corrupt.right.status).toBe("text");
    expect(corrupt.conclusion).toBe("unavailable");

    vi.spyOn(WorkspaceBlobStore.prototype, "readVerified").mockRejectedValueOnce(
      new WorkspaceBlobError("io", "注入的附件读取故障"),
    );
    const io = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "same.txt",
      expectedSnapshotIds: expected,
    });
    expect(io.left.status).toBe("io");
    expect(io.right.status).toBe("text");
    expect(io.conclusion).toBe("unavailable");
  });

  it("超限文件：不读附件即返回 too_large，另一侧 not_found", async () => {
    const { tmp, right } = await makePair();
    writeRootWithSnapshot(tmp.dataDir, "run_cmp_huge", [
      { path: "huge.bin", sha256: "a".repeat(64), bytes: 8 * 1024 * 1024 + 1 },
    ]);
    const listed = comparePair(tmp.dataDir, "run_cmp_huge", right.runId);
    const expected = expectedOf(listed);
    const huge = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: "run_cmp_huge" },
      right: { runId: right.runId },
      path: "huge.bin",
      expectedSnapshotIds: expected,
    });
    expect(huge.left.status).toBe("too_large");
    expect(huge.right.status).toBe("not_found");
    expect(huge.conclusion).toBe("unavailable");
    expect(huge.textDiffEligible).toBe(false);
  });

  it("选择快照变化：该侧 selection_changed 且不读正文，另一侧仍可读", async () => {
    const { tmp, left, right } = await makePair();
    const listed = comparePair(tmp.dataDir, left.runId, right.runId);
    const expected = expectedOf(listed);

    // 替换同 id run 的记录：初始清单变为另一份（附件另行发布）
    rmSync(left.traceFile);
    await writeIsolatedRun({
      dataDir: tmp.dataDir,
      runId: left.runId,
      rounds: [
        round([["config.json", "changed-after-list"]]),
        round([["config.json", "changed-after-list"]]),
      ],
      spanSeqStart: 0,
    });

    const read = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "config.json",
      expectedSnapshotIds: expected,
    });
    expect(read.left.status).toBe("selection_changed");
    if (read.left.status === "selection_changed") {
      expect(read.left.expectedSnapshotId).toBe(expected.left);
      expect(read.left.actualSnapshotId).not.toBe(expected.left);
    }
    expect(read.right.status).toBe("text");
    expect(read.conclusion).toBe("unavailable");
    expect(read.textDiffEligible).toBe(false);
  });

  it("expectedSnapshotIds 非法：两侧拒绝为 invalid_request，不读正文", async () => {
    const { tmp, left, right } = await makePair();
    const result = await readComparedWorkspaceFile({
      dataDir: tmp.dataDir,
      left: { runId: left.runId },
      right: { runId: right.runId },
      path: "config.json",
      expectedSnapshotIds: { left: "", right: "" },
    });
    expect(result.left.status).toBe("unavailable");
    expect(result.right.status).toBe("unavailable");
    if (result.left.status === "unavailable") {
      expect(result.left.failure.code).toBe("invalid_request");
    }
    expect(result.conclusion).toBe("unavailable");
  });
});

describe("比较 API 只读不变量", () => {
  it("清单/正文读取前后 dataDir 文件与 mtime 不变（不写 trace/blob、不建目录）", async () => {
    const { tmp, left, right } = await makePair();
    const before = treeFingerprint(tmp.dataDir);

    const listed = comparePair(tmp.dataDir, left.runId, right.runId);
    const expected = expectedOf(listed);
    for (const path of ["config.json", "same.txt", "bin.dat", "missing.txt"]) {
      await readComparedWorkspaceFile({
        dataDir: tmp.dataDir,
        left: { runId: left.runId },
        right: { runId: right.runId },
        path,
        expectedSnapshotIds: expected,
      });
    }

    expect(treeFingerprint(tmp.dataDir)).toEqual(before);
  });
});
