import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { createWorkspaceSnapshot } from "@rebaseagent/trace-sdk/workspace-hash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportWorkspaceSnapshot, quoteDiffPath } from "../src/index";
import type { TempDataDir, WrittenRun } from "./workspace-helpers";
import {
  cleanupTempDirs,
  makeDataDir,
  makeTempDir,
  round,
  writeIsolatedRun,
} from "./workspace-helpers";

/**
 * R2.1 任务 4.1/4.2/4.3a/4.3b/4.4a：包层编排器（exportWorkspaceSnapshot）的
 * 集成测试与不变量。前置阶段（目标校验/快照定位/附件复核）的单元级拒绝已在
 * workspace-export-api.test.ts 覆盖；本文件全部走**编排层入口**，验证：
 *
 * - 4.1：分支/失败 run 的自有 step 导出、files/ 逐字节核对、固定时钟完整清单
 *   逐字节比较、不同动作时间仅排除 created_at 后一致；
 * - 4.2：普通无 workspace、非法 runId、不存在 run、损坏 trace、祖先 step 都在
 *   编排层拒绝且零写入；缺父（ghost）但自有快照可从包层端到端导出；
 * - 4.3a：选定附件损坏整次失败零残留；导出只来自已校验附件（外部 decoy 不可达），
 *   父 run/兄弟 trace/blob 指纹不变；
 * - 4.3b：CRLF/末尾无换行/路径引用的补丁内容、deletion-only 与基线附件损坏/I/O
 *   都 not_available 且文件导出完整；
 * - 4.4a：dataDir 关系经编排层拒绝零写入；同目标并发恰一个成功、败者不清理胜者产物。
 */

const BINARY1 = Uint8Array.from([0x01, 0xff, 0x00, 0x41]);
const BINARY2 = Uint8Array.from([0x02, 0xff, 0x00, 0x42]);

const ROOT_RUN = "run_int_root";
const BRANCH_RUN = "run_int_branch";
const GHOST_RUN = "run_int_ghost";
const FAILED_RUN = "run_int_failed";
const DELETION_RUN = "run_int_deletion";
const PLAIN_RUN = "run_int_plain";

let handle: TempDataDir;
let dataDir: string;
let root: WrittenRun;
let branch: WrittenRun;
let ghost: WrittenRun;
let failed: WrittenRun;
let deletion: WrittenRun;

beforeAll(async () => {
  handle = makeDataDir();
  dataDir = handle.dataDir;

  // 根 run：初始含 CRLF/末尾无换行/二进制/将删除文件；step 里改写全部并新增带空格路径
  root = await writeIsolatedRun({
    dataDir,
    runId: ROOT_RUN,
    rounds: [
      round([
        ["bin.dat", BINARY1],
        ["crlf.txt", "l1\r\nl2\r\n"],
        ["gone.txt", "bye"],
        ["tail.txt", "old"],
      ]),
      round([
        ["bin.dat", BINARY2],
        ["crlf.txt", "l1\r\nl2 changed\r\n"],
        ["tail.txt", "new"],
        ["spaced path.txt", "added\n"],
      ]),
    ],
  });

  // 真实父链的分支 run（父 = ROOT_RUN 的自有 step）；span 序号错开避免跨 run 撞号
  branch = await writeIsolatedRun({
    dataDir,
    runId: BRANCH_RUN,
    parent: { runId: ROOT_RUN, stepSpanId: root.stepSpanIds[0] },
    spanSeqStart: 4,
    rounds: [
      round([["n.txt", "v1"]]),
      round([
        ["n.txt", "v2"],
        ["m.txt", "新增中文\n"],
      ]),
    ],
  });

  // ghost 分支：父 run 文件不存在——缺父不否定包层自有快照
  ghost = await writeIsolatedRun({
    dataDir,
    runId: GHOST_RUN,
    parent: { runId: "run_int_missing_parent", stepSpanId: "span_missing" },
    spanSeqStart: 4,
    rounds: [round([["g.txt", "ghost1"]]), round([["g.txt", "ghost2"]])],
  });

  // 失败 run：结局 errored/error，但自有 step 已落盘检查点
  failed = await writeIsolatedRun({
    dataDir,
    runId: FAILED_RUN,
    outcome: { event: "errored", reason: "error", at: 1 },
    rounds: [round([["f.txt", "v1"]]), round([["f.txt", "v2"]])],
  });

  // deletion-only：step 只删除 drop.txt，keep.txt 原样
  deletion = await writeIsolatedRun({
    dataDir,
    runId: DELETION_RUN,
    rounds: [
      round([
        ["keep.txt", "k"],
        ["drop.txt", "d"],
      ]),
      round([["keep.txt", "k"]]),
    ],
  });

  // 普通 v1 run（无 workspace）
  mkdirSync(join(dataDir, "traces"), { recursive: true });
  const plain = new JsonlTracer(join(dataDir, "traces", `${PLAIN_RUN}.jsonl`));
  plain.startRun({
    id: PLAIN_RUN,
    format_version: 1,
    task: "普通运行",
    model: "deepseek-chat",
    created_at: "2026-09-18T00:00:00.000Z",
    parent: null,
    fork: null,
  });
  plain.endRun({ event: "stopped", reason: "completed", at: 0 });

  // 损坏 trace
  writeFileSync(join(dataDir, "traces", "run_int_bad.jsonl"), "这不是 JSONL\n");
});

afterAll(() => {
  handle.cleanup();
});

afterEach(() => {
  cleanupTempDirs();
});

/** 空目标目录（makeTempDir 登记统一清理） */
function newTarget(name: string): string {
  return makeTempDir(`export-int-${name}-`);
}

function entryOf(run: WrittenRun, roundIndex: number, path: string) {
  const entry = run.roundFiles[roundIndex]?.find((file) => file.path === path);
  if (entry === undefined) throw new Error(`fixture 缺 round${roundIndex}/${path}`);
  return entry;
}

/** 目录树指纹（相对路径+大小+mtime）：断言导出没碰既有数据 */
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

/** 清单文本去掉 created_at 的值（保留键与结构），供"仅排除 created_at"比较 */
function stripCreatedAt(manifestText: string): string {
  const marker = '"created_at": "';
  const start = manifestText.indexOf(marker);
  if (start < 0) throw new Error("清单缺 created_at");
  const valueStart = start + marker.length;
  const end = manifestText.indexOf('"', valueStart);
  return manifestText.slice(0, valueStart) + manifestText.slice(end);
}

describe("任务 4.1：分支/失败 run 自有 step 与清单可核验性", () => {
  it("真实父链分支 run 的自有 step：files/ 逐字节核对，清单 source 四元组正确", async () => {
    const target = newTarget("branch-step");
    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: BRANCH_RUN,
      stepSpanId: branch.stepSpanIds[0],
      targetDir: target,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // files/ 逐字节 = 选定 step 的完整状态（不是父的，也不是初始的）
    expect(readFileSync(join(target, "files", "n.txt"), "utf8")).toBe("v2");
    expect(readFileSync(join(target, "files", "m.txt"), "utf8")).toBe("新增中文\n");

    const n1 = entryOf(branch, 1, "n.txt");
    const m1 = entryOf(branch, 1, "m.txt");
    expect(result.value.fileCount).toBe(2);
    expect(result.value.totalFileBytes).toBe(n1.bytes + m1.bytes);

    const manifest = JSON.parse(readFileSync(join(target, "rebaseagent-export.json"), "utf8")) as {
      source: {
        run_id: string;
        step_span_id: string | null;
        snapshot_id: string;
        initial_snapshot_id: string;
      };
      files: Array<{ path: string; bytes: number; sha256: string; kind: string; status: string }>;
      patch: { status: string; covered: string[] };
    };
    const initialSnapshotId = createWorkspaceSnapshot(branch.roundFiles[0]).id;
    expect(manifest.source).toEqual({
      run_id: BRANCH_RUN,
      step_span_id: branch.stepSpanIds[0],
      snapshot_id: result.value.snapshotId,
      initial_snapshot_id: initialSnapshotId,
    });
    // 初始基线是本 run 的初始清单（不是父 run 的任何检查点）
    expect(manifest.source.initial_snapshot_id).not.toBe(
      createWorkspaceSnapshot(root.roundFiles[0]).id,
    );
    expect(manifest.files).toEqual([
      { path: "m.txt", bytes: m1.bytes, sha256: m1.sha256, kind: "text", status: "exported" },
      { path: "n.txt", bytes: n1.bytes, sha256: n1.sha256, kind: "text", status: "exported" },
    ]);
    expect(manifest.patch.status).toBe("written");
    expect(manifest.patch.covered).toEqual(["m.txt", "n.txt"]);
  });

  it("失败 run（errored/error）已落盘的自有 step 可导出", async () => {
    const target = newTarget("failed-run");
    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: FAILED_RUN,
      stepSpanId: failed.stepSpanIds[0],
      targetDir: target,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(target, "files", "f.txt"), "utf8")).toBe("v2");
    expect(result.value.stepSpanId).toBe(failed.stepSpanIds[0]);
    const manifest = JSON.parse(readFileSync(join(target, "rebaseagent-export.json"), "utf8")) as {
      source: { run_id: string };
    };
    expect(manifest.source.run_id).toBe(FAILED_RUN);
  });

  it("固定时钟：初始导出清单完整文本逐字节可复算（键序/缩进/末尾换行钉死）", async () => {
    const target = newTarget("manifest-full");
    const result = await exportWorkspaceSnapshot(
      { dataDir, runId: ROOT_RUN, targetDir: target },
      { now: () => "2026-10-12T00:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshotId = result.value.snapshotId;
    const bin = entryOf(root, 0, "bin.dat");
    const crlf = entryOf(root, 0, "crlf.txt");
    const gone = entryOf(root, 0, "gone.txt");
    const tail = entryOf(root, 0, "tail.txt");
    // 与 buildExportManifestJson 的固定键序一致，但这里是测试侧独立复算，不由实现拼装
    const expected = `{
  "format_version": 1,
  "source": {
    "run_id": "${ROOT_RUN}",
    "step_span_id": null,
    "snapshot_id": "${snapshotId}",
    "initial_snapshot_id": "${snapshotId}"
  },
  "files_root": "files",
  "files": [
    {
      "path": "bin.dat",
      "bytes": ${bin.bytes},
      "sha256": "${bin.sha256}",
      "kind": "binary",
      "status": "exported"
    },
    {
      "path": "crlf.txt",
      "bytes": ${crlf.bytes},
      "sha256": "${crlf.sha256}",
      "kind": "text",
      "status": "exported"
    },
    {
      "path": "gone.txt",
      "bytes": ${gone.bytes},
      "sha256": "${gone.sha256}",
      "kind": "text",
      "status": "exported"
    },
    {
      "path": "tail.txt",
      "bytes": ${tail.bytes},
      "sha256": "${tail.sha256}",
      "kind": "text",
      "status": "exported"
    }
  ],
  "unpreserved": {
    "permissions": "未保留（原状态未知）",
    "executable_bit": "未保留（原状态未知）",
    "timestamps": "未保留（原状态未知）",
    "links": "未保留（原状态未知）",
    "empty_directories": "未保留（原状态未知）",
    "external_services": "未保留（原状态未知）"
  },
  "patch": {
    "status": "no_text_changes",
    "covered": [],
    "excluded": []
  },
  "created_at": "2026-10-12T00:00:00.000Z"
}
`;
    expect(readFileSync(join(target, "rebaseagent-export.json"), "utf8")).toBe(expected);
  });

  it("不同动作时间的两次导出：仅排除 created_at 后逐字节一致", async () => {
    const targetA = newTarget("time-a");
    const targetB = newTarget("time-b");
    const first = await exportWorkspaceSnapshot(
      { dataDir, runId: ROOT_RUN, targetDir: targetA },
      { now: () => "2026-10-12T08:00:00.000Z" },
    );
    const second = await exportWorkspaceSnapshot(
      { dataDir, runId: ROOT_RUN, targetDir: targetB },
      { now: () => "2026-10-12T16:30:00.000Z" },
    );
    expect(first.ok && second.ok).toBe(true);
    const textA = readFileSync(join(targetA, "rebaseagent-export.json"), "utf8");
    const textB = readFileSync(join(targetB, "rebaseagent-export.json"), "utf8");
    expect(textA).not.toBe(textB); // created_at 确实不同
    expect(stripCreatedAt(textA)).toBe(stripCreatedAt(textB));
  });
});

describe("任务 4.2：编排层拒绝当前记录与缺父自有快照", () => {
  it.each([
    ["普通 v1 run（no_workspace）", PLAIN_RUN, undefined, "no_workspace"],
    ["非法 runId（invalid_request）", "..\\evil", undefined, "invalid_request"],
    ["不存在的 run（run_not_found）", "run_int_no_such", undefined, "run_not_found"],
    ["损坏 trace（trace_invalid）", "run_int_bad", undefined, "trace_invalid"],
  ] as const)("编排层拒绝：%s", async (_label, runId, stepSpanId, code) => {
    const target = newTarget(`reject-${code}`);
    const result = await exportWorkspaceSnapshot({ dataDir, runId, stepSpanId, targetDir: target });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe(code);
    // 前置阶段失败 = 零写入 + 空清理报告
    expect(result.cleanup).toEqual({ removed: [], retained: [], complete: true });
    expect(readdirSync(target)).toEqual([]);
  });

  it("祖先 step（真实父链存在）在编排层拒绝：step_not_found 且零写入", async () => {
    const target = newTarget("ancestor-real");
    // branch 的父是 root：用 root 的 step id 请求 branch —— 跨 run 的 span 不在自有记录里
    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: BRANCH_RUN,
      stepSpanId: root.stepSpanIds[0],
      targetDir: target,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("step_not_found");
    expect(result.cleanup).toEqual({ removed: [], retained: [], complete: true });
    expect(readdirSync(target)).toEqual([]);
  });

  it("缺父（ghost）分支 run 的自有 step 从包层端到端导出成功", async () => {
    const target = newTarget("ghost-e2e");
    const result = await exportWorkspaceSnapshot({
      dataDir,
      runId: GHOST_RUN,
      stepSpanId: ghost.stepSpanIds[0],
      targetDir: target,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(target, "files", "g.txt"), "utf8")).toBe("ghost2");
    expect(result.value.patch.covered).toEqual(["g.txt"]);
  });

  it("包层请求契约不接受额外物理字段（编译期钉死；运行时严格 schema 归任务 5.1 IPC）", async () => {
    const target = newTarget("extra-keys");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        targetDir: target,
        // @ts-expect-error 物理 blob 路径不属于包层请求契约——TS 必须在此拒绝
        blobRoot: join(dataDir, "workspace-blobs"),
      });
      // 运行时多出的键被忽略：导出按无额外字段的契约照常成功
      expect(result.ok).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("任务 4.3a：附件失败与来源/数据不变量", () => {
  it("选定附件损坏（长度同内容异）：整次导出失败、目标零残留", async () => {
    const stepBin = entryOf(root, 1, "bin.dat");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", stepBin.sha256);
    const original = readFileSync(blobPath);
    writeFileSync(blobPath, Uint8Array.from(original.map((byte) => byte ^ 0xff)));
    const target = newTarget("attach-corrupt");
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
      expect(result.failure.path).toBe("bin.dat");
      expect(readdirSync(target)).toEqual([]);
    } finally {
      writeFileSync(blobPath, original);
    }
  });

  it("导出字节只来自已校验附件：外部 decoy 同名文件不可达，父/兄弟/trace/blob 指纹不变", async () => {
    // dataDir 之外的 decoy 目录：同名文件、不同内容——包层从未被告知该路径，也读不到它
    const decoy = newTarget("decoy-source");
    mkdirSync(join(decoy, "files"), { recursive: true });
    writeFileSync(join(decoy, "files", "n.txt"), "DECOY 不是导出来源");

    const before = treeFingerprint(dataDir);
    const target = newTarget("invariants");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: BRANCH_RUN,
        stepSpanId: branch.stepSpanIds[0],
        targetDir: target,
      });
      expect(result.ok).toBe(true);
      // 字节 = blob 校验内容，不是 decoy
      expect(readFileSync(join(target, "files", "n.txt"), "utf8")).toBe("v2");
      // 父 run/兄弟 run/trace/blob 全域指纹逐项一致
      expect(treeFingerprint(dataDir)).toEqual(before);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("任务 4.3b：补丁三状态端到端 fixture", () => {
  it("修改（CRLF/末尾无换行）+ 新增（路径引用）+ 二进制/删除排除：written 补丁内容逐段核对", async () => {
    const target = newTarget("patch-mixed");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: ROOT_RUN,
        stepSpanId: root.stepSpanIds[0],
        targetDir: target,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.patch.status).toBe("written");
      expect(result.value.patch.covered).toEqual(["crlf.txt", "spaced path.txt", "tail.txt"]);
      expect(result.value.patch.excluded).toEqual([
        { path: "bin.dat", reason: "binary" },
        { path: "gone.txt", reason: "deletion" },
      ]);

      const patchText = readFileSync(join(target, "changes.patch"), "utf8");
      // CRLF 修改：内容行逐字保留 \r\n，不被规范化
      expect(patchText).toContain(" l1\r\n-l2\r\n+l2 changed\r\n");
      // 末尾无换行：del 与 add 行后各跟标准标记
      expect(patchText).toContain("-old\n\\ No newline at end of file\n");
      expect(patchText).toContain("+new\n\\ No newline at end of file\n");
      // 带空格路径新增：旧头 /dev/null，新头 git 风格引用
      expect(patchText).toContain(
        `--- /dev/null\n+++ ${quoteDiffPath("b/spaced path.txt")}\n@@ -0,0 +1,1 @@\n+added\n`,
      );
      // 文件导出完整：全部 4 条附件字节都在 files/
      expect(result.value.fileCount).toBe(4);
      expect(Array.from(readFileSync(join(target, "files", "bin.dat")))).toEqual(
        Array.from(BINARY2),
      );
      expect(readFileSync(join(target, "files", "crlf.txt"), "utf8")).toBe("l1\r\nl2 changed\r\n");
      expect(existsSync(join(target, "files", "gone.txt"))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("deletion-only：补丁 not_available（deletion 逐路径列明），文件导出完整", async () => {
    const target = newTarget("patch-deletion");
    try {
      const result = await exportWorkspaceSnapshot({
        dataDir,
        runId: DELETION_RUN,
        stepSpanId: deletion.stepSpanIds[0],
        targetDir: target,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.patch.status).toBe("not_available");
      expect(result.value.patch.file).toBeNull();
      expect(result.value.patch.excluded).toEqual([{ path: "drop.txt", reason: "deletion" }]);
      expect(existsSync(join(target, "changes.patch"))).toBe(false);
      expect(result.value.fileCount).toBe(1);
      expect(readFileSync(join(target, "files", "keep.txt"), "utf8")).toBe("k");
      const manifest = JSON.parse(
        readFileSync(join(target, "rebaseagent-export.json"), "utf8"),
      ) as { patch: { status: string; excluded: unknown[] } };
      expect(manifest.patch.status).toBe("not_available");
      expect(manifest.patch.excluded).toEqual([{ path: "drop.txt", reason: "deletion" }]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("基线附件损坏：补丁整份 not_available（baseline_corrupt），文件导出不受影响", async () => {
    const baselineCrlf = entryOf(root, 0, "crlf.txt");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", baselineCrlf.sha256);
    const original = readFileSync(blobPath);
    writeFileSync(blobPath, Uint8Array.from(original.map((byte) => byte ^ 0xff)));
    const target = newTarget("baseline-corrupt");
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
        path: "crlf.txt",
        reason: "baseline_corrupt",
      });
      // 文件导出仍然完整（基线只服务补丁）
      expect(result.value.fileCount).toBe(4);
      expect(readFileSync(join(target, "files", "crlf.txt"), "utf8")).toBe("l1\r\nl2 changed\r\n");
      expect(existsSync(join(target, "changes.patch"))).toBe(false);
    } finally {
      writeFileSync(blobPath, original);
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("基线附件真实 I/O 故障（blob 位被换成目录）：baseline_io，文件导出完整", async () => {
    const baselineCrlf = entryOf(root, 0, "crlf.txt");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", baselineCrlf.sha256);
    const original = readFileSync(blobPath);
    rmSync(blobPath);
    mkdirSync(blobPath);
    const target = newTarget("baseline-io");
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
      expect(result.value.patch.excluded).toContainEqual({
        path: "crlf.txt",
        reason: "baseline_io",
      });
      expect(result.value.fileCount).toBe(4);
    } finally {
      rmSync(blobPath, { recursive: true });
      writeFileSync(blobPath, original);
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("任务 4.4a：目标不变量与同目标竞争", () => {
  it("目标与 dataDir 相同/在 dataDir 内部：编排层 target_conflicts_data_dir 零写入", async () => {
    const same = await exportWorkspaceSnapshot({
      dataDir,
      runId: ROOT_RUN,
      targetDir: dataDir,
    });
    expect(same.ok).toBe(false);
    if (!same.ok) {
      expect(same.failure.code).toBe("target_conflicts_data_dir");
      expect(same.cleanup).toEqual({ removed: [], retained: [], complete: true });
    }

    const inner = join(dataDir, "inner-target");
    mkdirSync(inner, { recursive: true });
    const inside = await exportWorkspaceSnapshot({
      dataDir,
      runId: ROOT_RUN,
      targetDir: inner,
    });
    expect(inside.ok).toBe(false);
    if (!inside.ok) {
      expect(inside.failure.code).toBe("target_conflicts_data_dir");
      expect(existsSync(join(inner, "files"))).toBe(false);
    }
  });

  it("同目标并发两次导出：恰一个成功，败者不清理胜者产物，终态 = 完整导出", async () => {
    const target = newTarget("concurrent");
    const request = {
      dataDir,
      runId: ROOT_RUN,
      stepSpanId: root.stepSpanIds[0],
      targetDir: target,
    } as const;
    const results = await Promise.all([
      exportWorkspaceSnapshot(request),
      exportWorkspaceSnapshot(request),
    ]);
    const winner = results.find((item) => item.ok);
    const loser = results.find((item) => !item.ok);
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    if (winner === undefined || loser === undefined || !winner.ok || loser.ok) return;

    // 败者可辨认地失败且零清理（排他创建撞上胜者，或串行完成时按非空拒绝）
    expect(["target_race", "target_invalid"]).toContain(loser.failure.code);
    if (loser.failure.code === "target_race") {
      expect(loser.cleanup.complete).toBe(true);
      expect(loser.cleanup.removed).toEqual([]);
    }

    // 胜者产物完整：三件套齐全且字节核对通过（编排器内部 verifyAll 已复核）
    expect(readdirSync(target).sort()).toEqual([
      "changes.patch",
      "files",
      "rebaseagent-export.json",
    ]);
    const manifest = JSON.parse(readFileSync(join(target, "rebaseagent-export.json"), "utf8")) as {
      source: { run_id: string };
      files: unknown[];
    };
    expect(manifest.source.run_id).toBe(ROOT_RUN);
    expect(manifest.files).toHaveLength(4);
    expect(readFileSync(join(target, "files", "crlf.txt"), "utf8")).toBe("l1\r\nl2 changed\r\n");
  });
});
