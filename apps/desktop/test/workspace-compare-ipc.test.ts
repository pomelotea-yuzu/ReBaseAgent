import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  makeDataDir,
  round,
  writeIsolatedRun,
} from "../../../packages/replay/test/workspace-helpers";
import {
  compareWorkspaceSnapshotsEndpoint,
  readComparedWorkspaceFileEndpoint,
} from "../src/main/workspace-compare-endpoint";
import {
  CompareWorkspaceFileRequestSchema,
  CompareWorkspaceSnapshotsRequestSchema,
} from "../src/shared/ipc";
import type {
  CompareWorkspaceSnapshotsResult,
  ComparedWorkspaceFileResult,
} from "../src/shared/ipc";

/**
 * R2.2 5.1：跨运行比较 IPC 端点。
 *
 * 包层语义已由 replay 的 `workspace-compare-api.test.ts` 覆盖；这里钉 main 侧：
 * - 请求 schema 严格（额外配置/物理字段拒绝）；
 * - 单侧失败是数据状态而非信封失败；
 * - 二进制正文不跨进程（只回哈希/大小）；
 * - selection_changed 逐侧透传。
 */

afterEach(() => {
  cleanupTempDirs();
});

const BIN = new Uint8Array([0xff, 0xfe, 0x00]);

async function pair() {
  const tmp = makeDataDir();
  const left = await writeIsolatedRun({
    dataDir: tmp.dataDir,
    runId: "run_ipc_left",
    rounds: [
      round([
        ["config.json", '{ "a": 1 }\r\n'],
        ["bin.dat", BIN],
      ]),
      round([
        ["config.json", '{ "a": 1 }\r\n'],
        ["bin.dat", BIN],
      ]),
    ],
  });
  const right = await writeIsolatedRun({
    dataDir: tmp.dataDir,
    runId: "run_ipc_right",
    rounds: [
      round([
        ["config.json", '{ "a": 1 }\n'],
        ["bin.dat", BIN],
      ]),
      round([
        ["config.json", '{ "a": 1 }\n'],
        ["bin.dat", BIN],
      ]),
    ],
    spanSeqStart: 100,
  });
  return { tmp, left, right };
}

function requestOf(leftId: string, rightId: string) {
  return { left: { runId: leftId }, right: { runId: rightId } };
}

function expectOk<T>(envelope: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!envelope.ok) throw new Error(`期望 ok 信封，实际 ${JSON.stringify(envelope.error)}`);
  return envelope.data;
}

describe("workspaces:compareSnapshots / compareFile IPC", () => {
  it("清单端点：路径并集与引用状态；单侧失败保留逐侧原因", async () => {
    const { tmp, left, right } = await pair();
    const data = expectOk(
      compareWorkspaceSnapshotsEndpoint(
        { dataDir: tmp.dataDir },
        requestOf(left.runId, right.runId),
      ),
    ) as CompareWorkspaceSnapshotsResult;
    expect(data.unionComplete).toBe(true);
    expect(data.left.status).toBe("ok");
    expect(data.right.status).toBe("ok");
    const config = data.entries.find((entry) => entry.path === "config.json");
    expect(config?.presence).toBe("both");
    expect(config?.reference).toBe("different");

    const missing = expectOk(
      compareWorkspaceSnapshotsEndpoint(
        { dataDir: tmp.dataDir },
        requestOf("run_missing", right.runId),
      ),
    ) as CompareWorkspaceSnapshotsResult;
    expect(missing.unionComplete).toBe(false);
    expect(missing.entries).toEqual([]);
    expect(missing.left.status).toBe("unavailable");
  });

  it("正文端点：文本原文透传；二进制只回哈希/大小（不含字节）", async () => {
    const { tmp, left, right } = await pair();
    const listed = expectOk(
      compareWorkspaceSnapshotsEndpoint(
        { dataDir: tmp.dataDir },
        requestOf(left.runId, right.runId),
      ),
    ) as CompareWorkspaceSnapshotsResult;
    if (listed.left.status !== "ok" || listed.right.status !== "ok") {
      throw new Error("测试前提：两侧清单必须可用");
    }

    const text = expectOk(
      await readComparedWorkspaceFileEndpoint(
        { dataDir: tmp.dataDir },
        {
          ...requestOf(left.runId, right.runId),
          path: "config.json",
          expectedSnapshotIds: {
            left: listed.left.selected.snapshotId,
            right: listed.right.selected.snapshotId,
          },
        },
      ),
    ) as ComparedWorkspaceFileResult;
    expect(text.left.status).toBe("text");
    expect(text.right.status).toBe("text");
    if (text.left.status === "text") expect(text.left.text).toBe('{ "a": 1 }\r\n');
    if (text.right.status === "text") expect(text.right.text).toBe('{ "a": 1 }\n');
    expect(text.conclusion).toBe("different");
    expect(text.textDiffEligible).toBe(true);

    const binary = expectOk(
      await readComparedWorkspaceFileEndpoint(
        { dataDir: tmp.dataDir },
        {
          ...requestOf(left.runId, right.runId),
          path: "bin.dat",
          expectedSnapshotIds: {
            left: listed.left.selected.snapshotId,
            right: listed.right.selected.snapshotId,
          },
        },
      ),
    ) as ComparedWorkspaceFileResult;
    expect(binary.left.status).toBe("binary");
    expect(binary.right.status).toBe("binary");
    expect(binary.left).not.toHaveProperty("data");
    expect(binary.conclusion).toBe("same");
    expect(binary.textDiffEligible).toBe(false);
  });

  it("expectedSnapshotIds 不符：逐侧 selection_changed，不返回正文", async () => {
    const { tmp, left, right } = await pair();
    const data = expectOk(
      await readComparedWorkspaceFileEndpoint(
        { dataDir: tmp.dataDir },
        {
          ...requestOf(left.runId, right.runId),
          path: "config.json",
          expectedSnapshotIds: {
            left: "a".repeat(64),
            right: "b".repeat(64),
          },
        },
      ),
    ) as ComparedWorkspaceFileResult;
    expect(data.left.status).toBe("selection_changed");
    expect(data.right.status).toBe("selection_changed");
    expect(data.conclusion).toBe("unavailable");
    expect(data.textDiffEligible).toBe(false);
  });

  it("strict：额外配置/物理字段在请求 schema 处拒绝", async () => {
    expect(
      CompareWorkspaceSnapshotsRequestSchema.safeParse({
        left: { runId: "a" },
        right: { runId: "b" },
        dataDir: "C:/physical",
      }).success,
    ).toBe(false);
    expect(
      CompareWorkspaceSnapshotsRequestSchema.safeParse({
        left: { runId: "a", stepSpanId: "s_01", physicalPath: "C:/x" },
        right: { runId: "b" },
      }).success,
    ).toBe(false);
    expect(
      CompareWorkspaceFileRequestSchema.safeParse({
        left: { runId: "a" },
        right: { runId: "b" },
        path: "a.txt",
        expectedSnapshotIds: { left: "a".repeat(64), right: "b".repeat(64) },
        config: { maxIterations: 1 },
      }).success,
    ).toBe(false);

    const bad = compareWorkspaceSnapshotsEndpoint(
      { dataDir: "C:/unused" },
      { left: { runId: "a" }, right: { runId: "b" }, extra: true },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_ARGUMENT");
  });
});
