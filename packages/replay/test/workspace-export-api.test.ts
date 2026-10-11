import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findExportMaterializationViolation,
  resolveExportSnapshots,
  validateExportTargetDir,
  verifyExportAttachments,
} from "../src/index";
import type { TempDataDir } from "./workspace-helpers";
import { makeDataDir, makeTempDir, round, writeIsolatedRun } from "./workspace-helpers";
import type { WrittenRun } from "./workspace-helpers";

/** 非 UTF-8 字节（0xFF 在任何位置都非法）——二进制附件的 fixture */
const BINARY = Uint8Array.from([0xff, 0xfe, 0x00, 0x41]);

const ROOT_RUN = "run_root";
const GHOST_CHILD_RUN = "run_ghost_child";

let dataDir: string;
let dataDirHandle: TempDataDir;
let scratch: string;
let root: WrittenRun;
let ghostChild: WrittenRun;

beforeAll(async () => {
  dataDirHandle = makeDataDir();
  dataDir = dataDirHandle.dataDir;
  scratch = mkdtempSync(join(tmpdir(), "replay-export-target-"));

  // 根 run：初始 [a.txt, bin.dat]，第 1 轮改写 a.txt
  root = await writeIsolatedRun({
    dataDir,
    runId: ROOT_RUN,
    rounds: [
      round([
        ["a.txt", "before"],
        ["bin.dat", BINARY],
      ]),
      round([
        ["a.txt", "after"],
        ["bin.dat", BINARY],
      ]),
    ],
  });

  // 分支 run：父 run 文件**不存在**（ghost）——验证"缺父不否定包层自有快照"。
  // 真实 fork 语义：span 序号续接父链（root 两轮 → s_01..s_03），自有 step 从 s_04 起号，
  // 因此 root 的 step id 是"祖先步骤"且绝不会与本 run 自有记录撞号。
  ghostChild = await writeIsolatedRun({
    dataDir,
    runId: GHOST_CHILD_RUN,
    parent: { runId: "run_ghost", stepSpanId: "span_ghost" },
    spanSeqStart: 3,
    rounds: [round([["c.txt", "child"]]), round([["c.txt", "child2"]])],
  });

  // 普通 v1 run（无 workspace）
  const plainTracer = new JsonlTracer(join(dataDir, "traces", "run_plain.jsonl"));
  plainTracer.startRun({
    id: "run_plain",
    format_version: 1,
    task: "普通运行",
    model: "deepseek-chat",
    created_at: "2026-09-18T00:00:00.000Z",
    parent: null,
    fork: null,
  });
  const plainStep = plainTracer.startSpan({ kind: "agent.step", n: 1 });
  plainTracer.endSpan(plainStep);
  plainTracer.endRun({ event: "stopped", reason: "completed", at: 1 });

  // 损坏的 trace：解析期就该失败
  writeFileSync(join(dataDir, "traces", "run_bad.jsonl"), "这不是 JSONL\n");
});

afterAll(() => {
  dataDirHandle.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

/** 在 scratch 下建一个空目录，返回其路径 */
function makeEmptyDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("导出目标目录校验（任务 1.2）", () => {
  it("存在、普通、为空的目标通过", async () => {
    const result = await validateExportTargetDir(dataDir, makeEmptyDir("empty-ok"));
    expect(result.ok).toBe(true);
  });

  it("不存在的目标被拒绝（target_invalid）", async () => {
    const result = await validateExportTargetDir(dataDir, join(scratch, "no-such-dir"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_invalid");
    expect(result.failure.reason).toContain("不存在");
  });

  it("目标是普通文件被拒绝", async () => {
    const file = join(scratch, "a-file.txt");
    writeFileSync(file, "x");
    const result = await validateExportTargetDir(dataDir, file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_invalid");
    expect(result.failure.reason).toContain("不是目录");
  });

  it("目标是符号链接/junction 被拒绝（即便指向空目录）", async () => {
    const real = makeEmptyDir("link-real");
    const link = join(scratch, "link");
    // Windows 无特权建不了目录 symlink，junction 等价且 lstat 同样报 isSymbolicLink
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const result = await validateExportTargetDir(dataDir, link);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_invalid");
    expect(result.failure.reason).toContain("符号链接");
  });

  it("非空目标被拒绝，理由可辨认", async () => {
    const dir = makeEmptyDir("non-empty");
    writeFileSync(join(dir, "existing.txt"), "既有内容");
    const result = await validateExportTargetDir(dataDir, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_invalid");
    expect(result.failure.reason).toContain("非空");
  });

  it("目标与 dataDir 相同被拒绝（target_conflicts_data_dir）", async () => {
    const result = await validateExportTargetDir(dataDir, dataDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_conflicts_data_dir");
    expect(result.failure.reason).toContain("相同");
  });

  it("目标在 dataDir 内部被拒绝", async () => {
    const inner = join(dataDir, "inner-target");
    mkdirSync(inner, { recursive: true });
    const innerResult = await validateExportTargetDir(dataDir, inner);
    expect(innerResult.ok).toBe(false);
    if (innerResult.ok) return;
    expect(innerResult.failure.code).toBe("target_conflicts_data_dir");
    expect(innerResult.failure.reason).toContain("内部");
  });

  it("目标是 dataDir 的祖先被拒绝", async () => {
    const result = await validateExportTargetDir(dataDir, dirname(dataDir));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("target_conflicts_data_dir");
    expect(result.failure.reason).toContain("祖先");
  });

  it("物化路径预检：超限明确拒绝，不静默改名", () => {
    const target = makeEmptyDir("precheck");
    // join(target, "files", "a.ts") 在 Windows/Linux 下都是 3 段；钉死边界：等于上限通过、超过拒绝
    const physical = join(target, "files", "a.ts");
    expect(findExportMaterializationViolation(target, ["a.ts"], physical.length)).toBeNull();
    const violation = findExportMaterializationViolation(target, ["a.ts"], physical.length - 1);
    expect(violation).not.toBeNull();
    expect(violation).toContain("a.ts");
    expect(violation).toContain("拒绝");
  });

  it("物化路径预检：常规路径与宿主默认上限下无违规", () => {
    expect(
      findExportMaterializationViolation(makeEmptyDir("precheck2"), [
        "src/deep/nested/file.txt",
        "bin.dat",
      ]),
    ).toBeNull();
  });
});

describe("导出快照定位（任务 1.3）", () => {
  it("缺省步骤 → 初始快照，initialSnapshot 与 selected 同源", () => {
    const result = resolveExportSnapshots(dataDir, ROOT_RUN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selected.stepSpanId).toBeNull();
    expect(result.value.selected.snapshot.files.map((file) => file.path)).toEqual([
      "a.txt",
      "bin.dat",
    ]);
    expect(result.value.initialSnapshot).toEqual(result.value.selected.snapshot);
  });

  it("自有完成步骤 → 该步检查点，initialSnapshot 仍是初始清单", () => {
    const result = resolveExportSnapshots(dataDir, ROOT_RUN, root.stepSpanIds[0]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selected.stepSpanId).toBe(root.stepSpanIds[0]);
    expect(result.value.selected.snapshot.files.map((file) => file.path)).toEqual([
      "a.txt",
      "bin.dat",
    ]);
    expect(result.value.selected.snapshot.files[0]?.sha256).not.toBe(
      result.value.initialSnapshot.files[0]?.sha256,
    );
  });

  it("父 run 的步骤（祖先 step）被拒绝（step_not_found）", () => {
    const child = resolveExportSnapshots(dataDir, GHOST_CHILD_RUN, root.stepSpanIds[0]);
    expect(child.ok).toBe(false);
    if (child.ok) return;
    expect(child.failure.code).toBe("step_not_found");
  });

  it("父 trace 文件缺失不否定包层自有快照（ghost 父链）", () => {
    const located = resolveExportSnapshots(dataDir, GHOST_CHILD_RUN, ghostChild.stepSpanIds[0]);
    expect(located.ok).toBe(true);
    if (!located.ok) return;
    expect(located.value.selected.snapshot.files.map((file) => file.path)).toEqual(["c.txt"]);
    expect(located.value.initialSnapshot.files.map((file) => file.path)).toEqual(["c.txt"]);
  });

  it("普通 v1 run（无 workspace）被拒绝（no_workspace）", () => {
    const result = resolveExportSnapshots(dataDir, "run_plain");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("no_workspace");
  });

  it("非法 runId（路径穿越）被拒绝（invalid_request）", () => {
    const result = resolveExportSnapshots(dataDir, "..\\evil");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_request");
  });

  it("不存在的 run 被拒绝（run_not_found）", () => {
    const result = resolveExportSnapshots(dataDir, "run_missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("run_not_found");
  });

  it("损坏的 trace 被拒绝（trace_invalid）", () => {
    const result = resolveExportSnapshots(dataDir, "run_bad");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("trace_invalid");
  });
});

describe("导出附件复核（任务 1.4）", () => {
  /** 取初始快照里某条路径的清单条目 */
  function entry(path: string) {
    const snapshot = resolveExportSnapshots(dataDir, ROOT_RUN);
    if (!snapshot.ok) throw new Error("fixture 损坏");
    const file = snapshot.value.initialSnapshot.files.find((item) => item.path === path);
    if (file === undefined) throw new Error(`fixture 缺 ${path}`);
    return file;
  }

  it("全部附件通过：返回字节与发布内容一致，顺序与清单一致", async () => {
    const located = resolveExportSnapshots(dataDir, ROOT_RUN);
    if (!located.ok) throw new Error("fixture 损坏");
    const result = await verifyExportAttachments(dataDir, located.value.initialSnapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((item) => item.file.path)).toEqual(["a.txt", "bin.dat"]);
    expect(new TextDecoder().decode(result.value[0]?.data)).toBe("before");
    expect(Array.from(result.value[1]?.data ?? [])).toEqual(Array.from(BINARY));
  });

  it("附件缺失 → attachment_unavailable 且指向对应路径", async () => {
    const file = entry("a.txt");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", file.sha256);
    unlinkSync(blobPath);
    try {
      const located = resolveExportSnapshots(dataDir, ROOT_RUN);
      if (!located.ok) throw new Error("fixture 损坏");
      const result = await verifyExportAttachments(dataDir, located.value.initialSnapshot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("attachment_unavailable");
      expect(result.failure.path).toBe("a.txt");
      expect(result.failure.reason).toContain("不存在");
    } finally {
      // 还原 fixture：删除的只是 "a.txt" 初始内容（"before"）的 blob，按名义重建
      writeFileSync(blobPath, new TextEncoder().encode("before"));
    }
  });

  it("附件损坏（长度同、内容异）→ attachment_unavailable", async () => {
    const file = entry("bin.dat");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", file.sha256);
    const original = readFileSync(blobPath);
    writeFileSync(blobPath, Uint8Array.from(original.map((byte) => byte ^ 0xff)));
    try {
      const located = resolveExportSnapshots(dataDir, ROOT_RUN);
      if (!located.ok) throw new Error("fixture 损坏");
      const result = await verifyExportAttachments(dataDir, located.value.initialSnapshot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("attachment_unavailable");
      expect(result.failure.path).toBe("bin.dat");
      expect(result.failure.reason).toContain("哈希不符");
    } finally {
      writeFileSync(blobPath, original);
    }
  });

  it("真实 I/O 故障（blob 位置被换成目录）→ io，不冒充数据状态", async () => {
    const file = entry("a.txt");
    const blobPath = join(dataDir, "workspace-blobs", "sha256", file.sha256);
    const original = readFileSync(blobPath);
    rmSync(blobPath);
    mkdirSync(blobPath);
    try {
      const located = resolveExportSnapshots(dataDir, ROOT_RUN);
      if (!located.ok) throw new Error("fixture 损坏");
      const result = await verifyExportAttachments(dataDir, located.value.initialSnapshot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("io");
      expect(result.failure.path).toBe("a.txt");
    } finally {
      rmSync(blobPath, { recursive: true });
      writeFileSync(blobPath, original);
    }
  });

  it("多条附件失败时按清单顺序报告第一条", async () => {
    const a = entry("a.txt");
    const bin = entry("bin.dat");
    const blobA = join(dataDir, "workspace-blobs", "sha256", a.sha256);
    const blobBin = join(dataDir, "workspace-blobs", "sha256", bin.sha256);
    const originalA = readFileSync(blobA);
    const originalBin = readFileSync(blobBin);
    unlinkSync(blobA);
    unlinkSync(blobBin);
    try {
      const located = resolveExportSnapshots(dataDir, ROOT_RUN);
      if (!located.ok) throw new Error("fixture 损坏");
      const result = await verifyExportAttachments(dataDir, located.value.initialSnapshot);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.path).toBe("a.txt");
    } finally {
      writeFileSync(blobA, originalA);
      writeFileSync(blobBin, originalBin);
    }
  });
});
