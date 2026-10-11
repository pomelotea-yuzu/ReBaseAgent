import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UNPRESERVED_STATUSES,
  buildExportManifestJson,
  computeExportPatch,
  resolveExportSnapshots,
  verifyExportAttachments,
} from "../src/index";
import type { ExportManifestFile } from "../src/index";
import { hashWorkspaceContent } from "../src/workspace/blob-store";
import type { TempDataDir } from "./workspace-helpers";
import { makeDataDir, round, writeIsolatedRun } from "./workspace-helpers";
import type { WrittenRun } from "./workspace-helpers";

/** 非 UTF-8 字节；BINARY2 与 BINARY1 长度相同、内容不同 */
const BINARY1 = Uint8Array.from([0x01, 0xff, 0x00, 0x41]);
const BINARY2 = Uint8Array.from([0x02, 0xff, 0x00, 0x42]);

const ROOT_RUN = "run_patch";

let dataDir: string;
let handle: TempDataDir;
let root: WrittenRun;
let initialSnapshotId: string;

beforeAll(async () => {
  handle = makeDataDir();
  dataDir = handle.dataDir;
  root = await writeIsolatedRun({
    dataDir,
    runId: ROOT_RUN,
    rounds: [
      round([
        ["a.txt", "before"],
        ["bin.dat", BINARY1],
        ["gone.txt", "bye"],
      ]),
      round([
        ["a.txt", "after"],
        ["bin.dat", BINARY2],
        ["added.txt", "new"],
      ]),
    ],
  });
  const located = resolveExportSnapshots(dataDir, ROOT_RUN);
  if (!located.ok) throw new Error("fixture 损坏");
  initialSnapshotId = located.value.initialSnapshot.id;
});

afterAll(() => {
  handle.cleanup();
});

/** 初始快照里某路径的清单条目 */
function initialEntry(path: string) {
  const entry = root.roundFiles[0].find((file) => file.path === path);
  if (entry === undefined) throw new Error(`fixture 缺 ${path}`);
  return entry;
}

describe("补丁资格（任务 3.2）", () => {
  it("文本修改+清单证实新增进入补丁；二进制变化与删除逐路径排除", async () => {
    const located = resolveExportSnapshots(dataDir, ROOT_RUN, root.stepSpanIds[0]);
    if (!located.ok) throw new Error("fixture 损坏");
    const selected = await verifyExportAttachments(dataDir, located.value.selected.snapshot);
    if (!selected.ok) throw new Error("fixture 附件损坏");

    const plan = await computeExportPatch({
      dataDir,
      initial: located.value.initialSnapshot,
      selected: selected.value,
    });

    expect(plan.status).toBe("written");
    // covered 整体按 UTF-16 码元序
    expect(plan.covered).toEqual(["a.txt", "added.txt"]);
    expect(plan.excluded).toEqual([
      { path: "bin.dat", reason: "binary" },
      { path: "gone.txt", reason: "deletion" },
    ]);
    expect(plan.diffText).toContain("--- a/a.txt\n+++ b/a.txt");
    expect(plan.diffText).toContain("-before");
    expect(plan.diffText).toContain("+after");
    expect(plan.diffText).toContain("--- /dev/null\n+++ b/added.txt");
    expect(plan.reason).toBeNull();
    const bytes = new TextEncoder().encode(plan.diffText ?? "");
    expect(plan.bytesAndHash).toEqual({
      bytes: bytes.byteLength,
      sha256: hashWorkspaceContent(bytes),
    });
  });

  it("基线附件缺失：整份补丁撤销（not_available），列明路径与原因", async () => {
    const entry = initialEntry("a.txt");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", entry.sha256);
    unlinkSync(blobPath);
    try {
      const located = resolveExportSnapshots(dataDir, ROOT_RUN, root.stepSpanIds[0]);
      if (!located.ok) throw new Error("fixture 损坏");
      const selected = await verifyExportAttachments(dataDir, located.value.selected.snapshot);
      if (!selected.ok) throw new Error("fixture 附件损坏");

      const plan = await computeExportPatch({
        dataDir,
        initial: located.value.initialSnapshot,
        selected: selected.value,
      });

      expect(plan.status).toBe("not_available");
      expect(plan.covered).toEqual([]);
      expect(plan.diffText).toBeNull();
      expect(plan.excluded).toContainEqual({ path: "a.txt", reason: "baseline_missing" });
      expect(plan.reason).toContain("基线附件不可用");
    } finally {
      writeFileSync(blobPath, new TextEncoder().encode("before"));
    }
  });

  it("基线附件损坏（长度同内容异）：baseline_corrupt，文件导出资格不受影响", async () => {
    const entry = initialEntry("a.txt");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", entry.sha256);
    const original = new TextEncoder().encode("before");
    writeFileSync(blobPath, Uint8Array.from(original.map((byte) => byte ^ 0xff)));
    try {
      const located = resolveExportSnapshots(dataDir, ROOT_RUN, root.stepSpanIds[0]);
      if (!located.ok) throw new Error("fixture 损坏");
      const selected = await verifyExportAttachments(dataDir, located.value.selected.snapshot);
      if (!selected.ok) throw new Error("fixture 附件损坏");

      const plan = await computeExportPatch({
        dataDir,
        initial: located.value.initialSnapshot,
        selected: selected.value,
      });
      expect(plan.status).toBe("not_available");
      expect(plan.excluded).toContainEqual({ path: "a.txt", reason: "baseline_corrupt" });
    } finally {
      writeFileSync(blobPath, original);
    }
  });

  it("选定快照与初始完全相同：no_text_changes（连基线都不必读）", async () => {
    const located = resolveExportSnapshots(dataDir, ROOT_RUN);
    if (!located.ok) throw new Error("fixture 损坏");
    const selected = await verifyExportAttachments(dataDir, located.value.selected.snapshot);
    if (!selected.ok) throw new Error("fixture 附件损坏");

    const plan = await computeExportPatch({
      dataDir,
      initial: located.value.initialSnapshot,
      selected: selected.value,
    });
    expect(plan.status).toBe("no_text_changes");
    expect(plan.covered).toEqual([]);
    expect(plan.excluded).toEqual([]);
  });

  it("只有二进制变化和删除（无文本变化）：not_available 且逐路径说明", async () => {
    // 追加一个只有二进制变化+删除的 run
    const run = await writeIsolatedRun({
      dataDir,
      runId: "run_patch_binonly",
      spanSeqStart: 10,
      rounds: [
        round([
          ["a.txt", "same"],
          ["bin.dat", BINARY1],
          ["gone.txt", "bye"],
        ]),
        round([
          ["a.txt", "same"],
          ["bin.dat", BINARY2],
        ]),
      ],
    });
    const located = resolveExportSnapshots(dataDir, run.runId, run.stepSpanIds[0]);
    if (!located.ok) throw new Error("fixture 损坏");
    const selected = await verifyExportAttachments(dataDir, located.value.selected.snapshot);
    if (!selected.ok) throw new Error("fixture 附件损坏");

    const plan = await computeExportPatch({
      dataDir,
      initial: located.value.initialSnapshot,
      selected: selected.value,
    });
    expect(plan.status).toBe("not_available");
    expect(plan.excluded).toEqual([
      { path: "bin.dat", reason: "binary" },
      { path: "gone.txt", reason: "deletion" },
    ]);
    expect(plan.reason).toBeNull();
  });
});

describe("导出清单（任务 3.1/3.4）", () => {
  const files: readonly ExportManifestFile[] = [
    { path: "b.txt", bytes: 3, sha256: "aa".repeat(32), kind: "text" },
    { path: "a/deep.bin", bytes: 4, sha256: "bb".repeat(32), kind: "binary" },
  ];
  const writtenPatch = {
    status: "written" as const,
    diffText: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n",
    covered: ["a.txt"],
    excluded: [{ path: "bin.dat", reason: "binary" as const }],
    reason: null,
    bytesAndHash: { bytes: 42, sha256: "cc".repeat(32) },
  };

  it("固定结构：format_version/source/files_root/排序 files/六类未保留/patch/created_at", () => {
    const json = buildExportManifestJson({
      runId: "run_x",
      stepSpanId: null,
      snapshotId: "dd".repeat(32),
      initialSnapshotId: initialSnapshotId,
      files,
      patch: writtenPatch,
      createdAt: "2026-10-11T00:00:00.000Z",
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.format_version).toBe(1);
    expect(parsed.source).toEqual({
      run_id: "run_x",
      step_span_id: null,
      snapshot_id: "dd".repeat(32),
      initial_snapshot_id: initialSnapshotId,
    });
    expect(parsed.files_root).toBe("files");
    // UTF-16 码元序："a/deep.bin" < "b.txt"
    expect(parsed.files).toEqual([
      { path: "a/deep.bin", bytes: 4, sha256: "bb".repeat(32), kind: "binary", status: "exported" },
      { path: "b.txt", bytes: 3, sha256: "aa".repeat(32), kind: "text", status: "exported" },
    ]);
    expect(parsed.patch).toEqual({
      status: "written",
      file: "changes.patch",
      bytes: 42,
      sha256: "cc".repeat(32),
      covered: ["a.txt"],
      excluded: [{ path: "bin.dat", reason: "binary" }],
    });
    expect(parsed.created_at).toBe("2026-10-11T00:00:00.000Z");

    // 六类未保留：固定键序 + 固定文案
    const unpreserved = parsed.unpreserved as Record<string, string>;
    expect(Object.keys(unpreserved)).toEqual(Object.keys(UNPRESERVED_STATUSES));
    expect(Object.values(unpreserved)).toEqual(
      Object.keys(UNPRESERVED_STATUSES).map(() => "未保留（原状态未知）"),
    );
    expect(Object.keys(unpreserved)).toEqual([
      "permissions",
      "executable_bit",
      "timestamps",
      "links",
      "empty_directories",
      "external_services",
    ]);
  });

  it("确定性：同输入逐字节一致；不同动作时间仅 created_at 不同", () => {
    const build = (createdAt: string): string =>
      buildExportManifestJson({
        runId: "run_x",
        stepSpanId: "sp_1",
        snapshotId: "dd".repeat(32),
        initialSnapshotId: initialSnapshotId,
        files,
        patch: writtenPatch,
        createdAt,
      });
    expect(build("2026-10-11T00:00:00.000Z")).toBe(build("2026-10-11T00:00:00.000Z"));

    const early = build("2026-10-11T00:00:00.000Z");
    const late = build("2026-10-11T09:30:00.000Z");
    const strip = (text: string): string =>
      text.replace(/"created_at": "[^"]+"/, '"created_at": "-"');
    expect(strip(early)).toBe(strip(late));
  });

  it("no_text_changes：无 file/bytes/sha256 字段；not_available 带逐路径排除与可选 reason", () => {
    const noChanges = buildExportManifestJson({
      runId: "run_x",
      stepSpanId: null,
      snapshotId: "dd".repeat(32),
      initialSnapshotId: initialSnapshotId,
      files: [],
      patch: {
        status: "no_text_changes",
        diffText: null,
        covered: [],
        excluded: [],
        reason: null,
        bytesAndHash: null,
      },
      createdAt: "2026-10-11T00:00:00.000Z",
    });
    const parsedNo = JSON.parse(noChanges) as { patch: Record<string, unknown>; files: unknown[] };
    expect(parsedNo.patch).toEqual({ status: "no_text_changes", covered: [], excluded: [] });
    expect(parsedNo.files).toEqual([]);

    const unavailable = buildExportManifestJson({
      runId: "run_x",
      stepSpanId: null,
      snapshotId: "dd".repeat(32),
      initialSnapshotId: initialSnapshotId,
      files: [],
      patch: {
        status: "not_available",
        diffText: null,
        covered: [],
        excluded: [{ path: "bin.dat", reason: "binary" }],
        reason: "补丁生成工作量超限",
        bytesAndHash: null,
      },
      createdAt: "2026-10-11T00:00:00.000Z",
    });
    const parsedUn = JSON.parse(unavailable) as { patch: Record<string, unknown> };
    expect(parsedUn.patch).toEqual({
      status: "not_available",
      covered: [],
      excluded: [{ path: "bin.dat", reason: "binary" }],
      reason: "补丁生成工作量超限",
    });
  });

  it("清单不写源目录路径/凭据/消息等未记录字段", () => {
    const json = buildExportManifestJson({
      runId: "run_x",
      stepSpanId: null,
      snapshotId: "dd".repeat(32),
      initialSnapshotId: initialSnapshotId,
      files,
      patch: writtenPatch,
      createdAt: "2026-10-11T00:00:00.000Z",
    });
    expect(json).not.toContain(dataDir);
    expect(json).not.toContain("workspace-blobs");
    expect(json).not.toContain("messages");
  });
});
