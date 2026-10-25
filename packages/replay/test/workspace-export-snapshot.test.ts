import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportWorkspaceSnapshot } from "../src/index";
import type { TempDataDir } from "./workspace-helpers";
import { makeDataDir, round, writeIsolatedRun } from "./workspace-helpers";
import type { WrittenRun } from "./workspace-helpers";

const BINARY1 = Uint8Array.from([0x01, 0xff, 0x00, 0x41]);
const BINARY2 = Uint8Array.from([0x02, 0xff, 0x00, 0x42]);

const ROOT_RUN = "run_export_root";
const EMPTY_RUN = "run_export_empty";
const META_RUN = "run_export_meta";

let dataDir: string;
let handle: TempDataDir;
let root: WrittenRun;

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

  await writeIsolatedRun({
    dataDir,
    runId: EMPTY_RUN,
    rounds: [round([])],
  });

  await writeIsolatedRun({
    dataDir,
    runId: META_RUN,
    spanSeqStart: 5,
    rounds: [
      round([
        ["rebaseagent-export.json", '{"project": true}'],
        ["changes.patch", "diff --git a/x b/x\n"],
        ["files/inner.txt", "项目自己的 files 目录"],
      ]),
    ],
  });
});

afterAll(() => {
  handle.cleanup();
});

function newTarget(name: string): string {
  const dir = join(dataDir, "..", `export-e2e-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  // 目标建在 dataDir 之外（同盘临时区），用完由用例自清
  return dir;
}

/** 目录树指纹（相对路径 + 大小 + mtimeMs），断言导出没改 dataDir */
function treeFingerprint(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const stats = statSync(full);
        entries.push(`${relative(root, full)}:${stats.size}:${stats.mtimeMs}`);
      }
    }
  };
  walk(root);
  return entries.sort();
}

describe("exportWorkspaceSnapshot 端到端（任务 3.X 收口）", () => {
  it("导出根初始检查点：无变化 → no_text_changes，清单/文件树逐项正确", async () => {
    const target = newTarget("initial");
    try {
      const result = await exportWorkspaceSnapshot(
        {
          dataDir,
          runId: ROOT_RUN,
          targetDir: target,
        },
        { now: () => "2026-10-11T00:00:00.000Z" },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.fileCount).toBe(3);
      expect(result.value.patch.status).toBe("no_text_changes");
      expect(result.value.patch.file).toBeNull();
      expect(result.value.filesRoot).toBe("files");

      // 布局：根部只有 files/ 与清单，无 changes.patch
      expect(readdirSync(target).sort()).toEqual(["files", "rebaseagent-export.json"]);
      expect(readFileSync(join(target, "files", "a.txt"), "utf8")).toBe("before");
      expect(Array.from(readFileSync(join(target, "files", "bin.dat")))).toEqual(
        Array.from(BINARY1),
      );
      expect(readFileSync(join(target, "files", "gone.txt"), "utf8")).toBe("bye");

      const manifest = JSON.parse(
        readFileSync(join(target, "rebaseagent-export.json"), "utf8"),
      ) as {
        source: { snapshot_id: string; step_span_id: string | null; run_id: string };
        files: Array<{ path: string; status: string; kind: string }>;
        patch: { status: string };
      };
      expect(manifest.source.run_id).toBe(ROOT_RUN);
      expect(manifest.source.step_span_id).toBeNull();
      expect(manifest.source.snapshot_id).toBe(result.value.snapshotId);
      expect(manifest.files.map((file) => [file.path, file.status])).toEqual([
        ["a.txt", "exported"],
        ["bin.dat", "exported"],
        ["gone.txt", "exported"],
      ]);
      expect(manifest.files.find((file) => file.path === "bin.dat")?.kind).toBe("binary");
      expect(manifest.patch.status).toBe("no_text_changes");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("导出自有 step：文本修改+新增进补丁，二进制/删除逐路径排除，清单记录 step 来源", async () => {
    const target = newTarget("step");
    try {
      const result = await exportWorkspaceSnapshot(
        {
          dataDir,
          runId: ROOT_RUN,
          stepSpanId: root.stepSpanIds[0],
          targetDir: target,
        },
        { now: () => "2026-10-11T00:00:00.000Z" },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stepSpanId).toBe(root.stepSpanIds[0]);
      expect(result.value.patch.status).toBe("written");
      expect(result.value.patch.file).toBe("changes.patch");
      expect(result.value.patch.covered).toEqual(["a.txt", "added.txt"]);
      expect(result.value.patch.excluded).toEqual([
        { path: "bin.dat", reason: "binary" },
        { path: "gone.txt", reason: "deletion" },
      ]);

      // files/ 是选定 step 的完整状态
      expect(readFileSync(join(target, "files", "a.txt"), "utf8")).toBe("after");
      expect(readFileSync(join(target, "files", "added.txt"), "utf8")).toBe("new");
      expect(existsSync(join(target, "files", "gone.txt"))).toBe(false);

      // 补丁文件字节与清单记录一致
      const patchBytes = readFileSync(join(target, "changes.patch"));
      expect(result.value.patch.bytes).toBe(patchBytes.byteLength);
      const manifest = JSON.parse(
        readFileSync(join(target, "rebaseagent-export.json"), "utf8"),
      ) as {
        source: { step_span_id: string | null; snapshot_id: string; initial_snapshot_id: string };
        patch: { status: string; file: string; bytes: number; covered: string[] };
      };
      expect(manifest.source.step_span_id).toBe(root.stepSpanIds[0]);
      expect(manifest.source.snapshot_id).not.toBe(manifest.source.initial_snapshot_id);
      expect(manifest.patch).toMatchObject({
        status: "written",
        file: "changes.patch",
        bytes: patchBytes.byteLength,
        covered: ["a.txt", "added.txt"],
      });
      expect(readFileSync(join(target, "changes.patch"), "utf8")).toContain(
        "-before\n\\ No newline at end of file\n+after",
      );
      expect(readFileSync(join(target, "changes.patch"), "utf8")).toContain(
        "--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1,1 @@\n+new",
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("空快照导出：空 files/、空 files 数组、no_text_changes，不因零文件拒绝", async () => {
    const target = newTarget("empty");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: EMPTY_RUN,
        targetDir: target,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.fileCount).toBe(0);
      expect(result.value.totalFileBytes).toBe(0);
      expect(readdirSync(target).sort()).toEqual(["files", "rebaseagent-export.json"]);
      expect(readdirSync(join(target, "files"))).toEqual([]);
      const manifest = JSON.parse(
        readFileSync(join(target, "rebaseagent-export.json"), "utf8"),
      ) as {
        files: unknown[];
        patch: { status: string };
      };
      expect(manifest.files).toEqual([]);
      expect(manifest.patch.status).toBe("no_text_changes");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("项目同名元信息文件进 files/，与根部清单/补丁命名空间分离", async () => {
    const target = newTarget("meta");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: META_RUN,
        targetDir: target,
      });
      expect(result.ok).toBe(true);
      expect(readdirSync(target).sort()).toEqual(["files", "rebaseagent-export.json"]);
      // 项目自己的同名文件字节原样保存在 files/ 内
      expect(readFileSync(join(target, "files", "rebaseagent-export.json"), "utf8")).toBe(
        '{"project": true}',
      );
      expect(readFileSync(join(target, "files", "changes.patch"), "utf8")).toBe(
        "diff --git a/x b/x\n",
      );
      expect(readFileSync(join(target, "files", "files", "inner.txt"), "utf8")).toBe(
        "项目自己的 files 目录",
      );
      const manifest = JSON.parse(
        readFileSync(join(target, "rebaseagent-export.json"), "utf8"),
      ) as {
        files: Array<{ path: string }>;
      };
      expect(manifest.files.map((file) => file.path)).toEqual([
        "changes.patch",
        "files/inner.txt",
        "rebaseagent-export.json",
      ]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("基线附件缺失：文件导出完整成功，补丁 not_available 且不写 changes.patch", async () => {
    const entry = root.roundFiles[0].find((file) => file.path === "a.txt");
    if (entry === undefined) throw new Error("fixture 损坏");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", entry.sha256);
    unlinkSync(blobPath);
    const target = newTarget("baseline-missing");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        stepSpanId: root.stepSpanIds[0],
        targetDir: target,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.patch.status).toBe("not_available");
      expect(result.value.patch.reason).toContain("基线附件不可用");
      expect(result.value.patch.excluded).toContainEqual({
        path: "a.txt",
        reason: "baseline_missing",
      });
      expect(result.value.fileCount).toBe(3);
      expect(readFileSync(join(target, "files", "a.txt"), "utf8")).toBe("after");
      expect(existsSync(join(target, "changes.patch"))).toBe(false);
    } finally {
      writeFileSync(blobPath, new TextEncoder().encode("before"));
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("工作量超限：整份补丁 not_available（说明超限），文件树与哈希完整", async () => {
    const target = newTarget("cap");
    try {
      const result = await exportWorkspaceSnapshot(
        {
          dataDir,
          runId: ROOT_RUN,
          stepSpanId: root.stepSpanIds[0],
          targetDir: target,
          // a.txt 修改的 diff 需 (1+1)×(1+1)=4 格，上限 2 即超限
        },
        { maxDiffCells: 2 },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.patch.status).toBe("not_available");
      expect(result.value.patch.reason).toContain("超限");
      expect(result.value.patch.file).toBeNull();
      expect(result.value.fileCount).toBe(3);
      expect(existsSync(join(target, "changes.patch"))).toBe(false);
      expect(readFileSync(join(target, "files", "added.txt"), "utf8")).toBe("new");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("非空目标：target_invalid 且零写入（既有内容逐字节不变）", async () => {
    const target = newTarget("nonempty");
    try {
      const existing = join(target, "existing.txt");
      writeFileSync(existing, "既有内容");
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        targetDir: target,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("target_invalid");
      expect(result.cleanup.complete).toBe(true);
      expect(readFileSync(existing, "utf8")).toBe("既有内容");
      expect(existsSync(join(target, "files"))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("选定附件缺失：整次导出失败（attachment_unavailable），目标零残留", async () => {
    const stepEntry = root.roundFiles[1].find((file) => file.path === "a.txt");
    if (stepEntry === undefined) throw new Error("fixture 损坏");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", stepEntry.sha256);
    unlinkSync(blobPath);
    const target = newTarget("attach-fail");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        stepSpanId: root.stepSpanIds[0],
        targetDir: target,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("attachment_unavailable");
      expect(result.failure.path).toBe("a.txt");
      expect(existsSync(target)).toBe(true);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      writeFileSync(blobPath, new TextEncoder().encode("after"));
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("成功导出不改 dataDir：traces/blob 指纹逐项一致", async () => {
    const target = newTarget("fingerprint");
    try {
      const before = treeFingerprint(dataDir);
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        stepSpanId: root.stepSpanIds[0],
        targetDir: target,
      });
      expect(result.ok).toBe(true);
      expect(treeFingerprint(dataDir)).toEqual(before);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("祖先步骤拒绝经编排层透传：step_not_found 且零写入", async () => {
    const target = newTarget("ancestor");
    try {
      // 根 run 的步骤对"缺父 ghost run"不可见——用另一 run 的 step id 请求
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: META_RUN,
        stepSpanId: root.stepSpanIds[0],
        targetDir: target,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("step_not_found");
      expect(existsSync(join(target, "files"))).toBe(false);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("R3 5.5：绑定精确输入快照（W03/W04）", () => {
  it("expectedSnapshotId 一致 ⇒ 正常导出，结果快照等于绑定值", async () => {
    const initialId = createWorkspaceSnapshot(root.roundFiles[0] ?? []).id;
    const target = newTarget("binding-ok");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        targetDir: target,
        expectedSnapshotId: initialId,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.snapshotId).toBe(initialId);
        const manifest = JSON.parse(
          readFileSync(join(target, "rebaseagent-export.json"), "utf8"),
        ) as { source: { snapshot_id: string } };
        expect(manifest.source.snapshot_id).toBe(initialId);
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("expectedSnapshotId 不一致 ⇒ snapshot_mismatch 且零写入（不导出其他点）", async () => {
    const target = newTarget("binding-mismatch");
    const before = readdirSync(target);
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        targetDir: target,
        expectedSnapshotId: "0".repeat(64),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("snapshot_mismatch");
        expect(result.failure.reason).toContain("已阻断导出");
        expect(result.cleanup.retained).toEqual([]);
      }
      expect(readdirSync(target)).toEqual(before);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
