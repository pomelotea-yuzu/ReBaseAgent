import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { JsonlTracer } from "@rebaseagent/trace-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkspaceBlobStore,
  hashWorkspaceContent,
  locateWorkspaceSnapshot,
  readWorkspaceFile,
  workspaceTraceFile,
} from "../src/index";
import type { WrittenRun } from "./workspace-helpers";
import { makeDataDir, round, writeIsolatedRun } from "./workspace-helpers";

/** 非 UTF-8 字节（0xFF 在任何位置都非法）——用来验证"二进制保持原字节" */
const BINARY = Uint8Array.from([0xff, 0xfe, 0x00, 0x41]);

const ROOT_RUN = "run_root";
const CHILD_RUN = "run_child";

let dataDir: string;
let cleanupDir: () => void;
let parent: WrittenRun;
let child: WrittenRun;

beforeAll(async () => {
  const temp = makeDataDir();
  dataDir = temp.dataDir;
  cleanupDir = temp.cleanup;

  // 三轮：初始 / 第 1 轮新增 out/1.txt / 第 2 轮改写 a.txt
  parent = await writeIsolatedRun({
    dataDir,
    runId: ROOT_RUN,
    rounds: [
      round([
        ["a.txt", "before"],
        ["bin.dat", BINARY],
        ["empty.txt", ""],
      ]),
      round([
        ["a.txt", "before"],
        ["bin.dat", BINARY],
        ["empty.txt", ""],
        ["out/1.txt", "written in round 1"],
      ]),
      round([
        ["a.txt", "after"],
        ["bin.dat", BINARY],
        ["empty.txt", ""],
        ["out/1.txt", "written in round 1"],
      ]),
    ],
  });

  // 从第 1 轮分叉的子分支（只带初始快照，够验 origin 与"祖先步骤"拒绝）
  child = await writeIsolatedRun({
    dataDir,
    runId: CHILD_RUN,
    parent: { runId: ROOT_RUN, stepSpanId: parent.stepSpanIds[0] },
    rounds: [round([["a.txt", "before"]])],
  });

  // 一个普通 v1 run（无 workspace）：验证"非隔离 run 不提供文件接口"
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
});

afterAll(() => {
  cleanupDir();
});

/** 目录树指纹（相对路径 + 大小 + mtime），用于断言读接口没有写任何东西 */
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

describe("包只读接口：清单定位", () => {
  it("初始快照：origin=import，清单含全部文件", () => {
    const located = locateWorkspaceSnapshot({ dataDir, runId: ROOT_RUN });
    expect(located.ok).toBe(true);
    if (!located.ok) return;
    expect(located.value.stepSpanId).toBeNull();
    expect(located.value.origin).toEqual({ kind: "import" });
    expect(located.value.snapshot.files.map((file) => file.path)).toEqual([
      "a.txt",
      "bin.dat",
      "empty.txt",
    ]);
  });

  it("指定自有完成步骤：拿到该步的检查点（同路径内容随轮次变化）", () => {
    const step1 = locateWorkspaceSnapshot({
      dataDir,
      runId: ROOT_RUN,
      stepSpanId: parent.stepSpanIds[0],
    });
    const step2 = locateWorkspaceSnapshot({
      dataDir,
      runId: ROOT_RUN,
      stepSpanId: parent.stepSpanIds[1],
    });
    expect(step1.ok && step1.value.stepSpanId).toBe(parent.stepSpanIds[0]);
    expect(step1.ok && step1.value.snapshot.files.map((f) => f.path)).toContain("out/1.txt");
    expect(step2.ok && step2.value.snapshot.files.map((f) => f.path)).toContain("out/1.txt");
  });

  it("分支 run 的 origin 指向直接父的续跑边界", () => {
    const located = locateWorkspaceSnapshot({ dataDir, runId: CHILD_RUN });
    expect(located.ok).toBe(true);
    if (!located.ok) return;
    expect(located.value.origin).toEqual({
      kind: "checkpoint",
      run_id: ROOT_RUN,
      step_span: parent.stepSpanIds[0],
    });
  });
});

describe("包只读接口：读取文件内容", () => {
  it("文本按 UTF-8 严格解码，元数据与清单一致", async () => {
    const result = await readWorkspaceFile({ dataDir, runId: ROOT_RUN, path: "a.txt" });
    expect(result.status).toBe("text");
    if (result.status !== "text") return;
    expect(result.text).toBe("before");
    expect(result.file).toEqual(parent.roundFiles[0].find((f) => f.path === "a.txt"));
  });

  it("零字节文件是合法的文本（空串）", async () => {
    const result = await readWorkspaceFile({ dataDir, runId: ROOT_RUN, path: "empty.txt" });
    expect(result.status).toBe("text");
    expect(result.status === "text" ? result.text : null).toBe("");
  });

  it("非 UTF-8 内容返回二进制原字节，不用替换字符冒充", async () => {
    const result = await readWorkspaceFile({ dataDir, runId: ROOT_RUN, path: "bin.dat" });
    expect(result.status).toBe("binary");
    if (result.status !== "binary") return;
    expect(Array.from(result.data)).toEqual(Array.from(BINARY));
    expect(result.file.bytes).toBe(BINARY.byteLength);
    expect(result.file.sha256).toBe(hashWorkspaceContent(BINARY));
  });

  it("初始快照里没有的文件：指定第 1 轮能读到、不指定则 not_found", async () => {
    const inRound1 = await readWorkspaceFile({
      dataDir,
      runId: ROOT_RUN,
      stepSpanId: parent.stepSpanIds[0],
      path: "out/1.txt",
    });
    expect(inRound1.status).toBe("text");
    expect(inRound1.status === "text" ? inRound1.text : "").toBe("written in round 1");

    const initial = await readWorkspaceFile({ dataDir, runId: ROOT_RUN, path: "out/1.txt" });
    expect(initial.status).toBe("not_found");
  });

  it("同一条路径按轮次取到各自的内容（第 2 轮是改写后的值）", async () => {
    const result = await readWorkspaceFile({
      dataDir,
      runId: ROOT_RUN,
      stepSpanId: parent.stepSpanIds[1],
      path: "a.txt",
    });
    expect(result.status).toBe("text");
    expect(result.status === "text" ? result.text : "").toBe("after");
  });
});

describe("包只读接口：非法请求与越界路径", () => {
  it("清单外路径、非法契约路径、形似物理附件的路径都只回 not_found", async () => {
    const cases: [string, string][] = [
      ["nope.txt", "清单内没有"],
      ["../a.txt", "不符合契约"],
      ["D:/a.txt", "不符合契约"],
      ["a.txt:ads", "不符合契约"],
      [`sha256/${parent.roundFiles[0][0].sha256}`, "清单内没有"],
    ];
    for (const [path, hint] of cases) {
      const result = await readWorkspaceFile({ dataDir, runId: ROOT_RUN, path });
      expect(result.status, path).toBe("not_found");
      expect(result.status === "not_found" ? result.reason : "", path).toContain(hint);
    }
  });

  it("run 不存在 / runId 非法 / 非隔离 run 都是可辨认的拒绝", async () => {
    const missingRun = await readWorkspaceFile({
      dataDir,
      runId: "run_missing",
      path: "a.txt",
    });
    expect(missingRun).toMatchObject({ status: "rejected", failure: { code: "run_not_found" } });

    const badRunId = await readWorkspaceFile({ dataDir, runId: "../evil", path: "a.txt" });
    expect(badRunId).toMatchObject({ status: "rejected", failure: { code: "invalid_request" } });

    const plain = await readWorkspaceFile({ dataDir, runId: "run_plain", path: "a.txt" });
    expect(plain).toMatchObject({ status: "rejected", failure: { code: "no_workspace" } });
  });

  it("祖先步骤与工具 span 都不能用来定位本 run 的文件", async () => {
    const ancestorStep = await readWorkspaceFile({
      dataDir,
      runId: CHILD_RUN,
      stepSpanId: parent.stepSpanIds[0],
      path: "out/1.txt",
    });
    expect(ancestorStep.status).toBe("rejected");
    expect(ancestorStep.status === "rejected" ? ancestorStep.failure.code : "").toBe(
      "step_not_found",
    );
    expect(ancestorStep.status === "rejected" ? ancestorStep.failure.reason : "").toContain("祖先");

    const toolSpan = await readWorkspaceFile({
      dataDir,
      runId: ROOT_RUN,
      stepSpanId: parent.toolSpanIds[0],
      path: "a.txt",
    });
    expect(toolSpan).toMatchObject({ status: "rejected", failure: { code: "step_not_found" } });
  });

  it("清单 id 与规范哈希不符（被篡改）时拒绝，不读附件", async () => {
    const temp = makeDataDir();
    try {
      const run = await writeIsolatedRun({
        dataDir: temp.dataDir,
        runId: "run_tampered",
        rounds: [round([["a.txt", "before"]])],
      });

      const text = readFileSync(run.traceFile, "utf8");
      const bogus = "0".repeat(64);
      const tampered = text.replace(
        /"initial_snapshot":\{"id":"[0-9a-f]{64}"/,
        `"initial_snapshot":{"id":"${bogus}"`,
      );
      expect(tampered).not.toBe(text);
      writeFileSync(run.traceFile, tampered, "utf8");

      // 重算清单 id 由 reader 完成（1.2 接在 readRun 里），本层把它的失败映射成可辨认的拒绝
      const result = await readWorkspaceFile({
        dataDir: temp.dataDir,
        runId: "run_tampered",
        path: "a.txt",
      });
      expect(result).toMatchObject({
        status: "rejected",
        failure: { code: "trace_invalid" },
      });
      expect(result.status === "rejected" ? result.failure.reason : "").toContain(
        "初始快照校验失败",
      );
    } finally {
      temp.cleanup();
    }
  });
});

describe("包只读接口：附件缺失、损坏与只读性", () => {
  it("附件被删除 → missing（与损坏可区分）", async () => {
    const temp = makeDataDir();
    try {
      await writeIsolatedRun({
        dataDir: temp.dataDir,
        runId: "run_lost",
        rounds: [round([["gone.txt", "内容"]])],
      });
      const store = createWorkspaceBlobStore(temp.dataDir);
      rmSync(store.blobPath(hashWorkspaceContent(new TextEncoder().encode("内容"))));

      const result = await readWorkspaceFile({
        dataDir: temp.dataDir,
        runId: "run_lost",
        path: "gone.txt",
      });
      expect(result.status).toBe("missing");
      expect(result.status === "missing" ? result.reason : "").toContain("不存在");
    } finally {
      temp.cleanup();
    }
  });

  it("附件被改成等长的别的内容 → corrupt，且不补写", async () => {
    const temp = makeDataDir();
    try {
      await writeIsolatedRun({
        dataDir: temp.dataDir,
        runId: "run_broken",
        rounds: [round([["a.txt", "before"]])],
      });
      const store = createWorkspaceBlobStore(temp.dataDir);
      const blobPath = store.blobPath(hashWorkspaceContent(new TextEncoder().encode("before")));
      writeFileSync(blobPath, "AFTER!"); // 长度相同（6 字节），内容不同

      const result = await readWorkspaceFile({
        dataDir: temp.dataDir,
        runId: "run_broken",
        path: "a.txt",
      });
      expect(result.status).toBe("corrupt");
      expect(result.status === "corrupt" ? result.reason : "").toContain("哈希不符");
      expect(readFileSync(blobPath, "utf8")).toBe("AFTER!"); // 不回写源目录、不修附件
    } finally {
      temp.cleanup();
    }
  });

  it("读取不改动数据目录里的任何文件（不写 trace/blob）", async () => {
    const before = treeFingerprint(dataDir);

    await readWorkspaceFile({ dataDir, runId: ROOT_RUN, path: "a.txt" });
    await readWorkspaceFile({
      dataDir,
      runId: ROOT_RUN,
      stepSpanId: parent.stepSpanIds[1],
      path: "bin.dat",
    });
    await readWorkspaceFile({ dataDir, runId: ROOT_RUN, path: "nope.txt" });
    locateWorkspaceSnapshot({ dataDir, runId: CHILD_RUN });

    expect(treeFingerprint(dataDir)).toEqual(before);
    // 入口文件也仍在原处（`workspaceTraceFile` 的布局约定）
    expect(workspaceTraceFile(dataDir, ROOT_RUN)).toBe(
      join(dataDir, "traces", `${ROOT_RUN}.jsonl`),
    );
  });
});
