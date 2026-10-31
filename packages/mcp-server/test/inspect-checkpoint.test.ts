import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { getRunTool } from "../src/query/get-run.js";
import { inspectCheckpointTool } from "../src/query/inspect-checkpoint.js";
import type { InspectCheckpointData } from "../src/query/inspect-checkpoint.js";
import { toolCodeOfLocateFailure } from "../src/query/projection.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  BINARY_BYTES,
  type CheckpointFixture,
  FILE_TEXTS,
  buildCheckpointFixture,
  bytesSha,
  cleanupCheckpointFixtures,
  contentSha,
  dirFingerprintRecursive,
} from "./checkpoint-fixtures.js";
import { LONG_BODY } from "./query-fixtures.js";
import { ZH } from "./test-locale.js";
import { collectKeys } from "./whitelist-assertions.js";

/**
 * MCP0 4.6（Q13 + S03 检查点半边）：`inspect_checkpoint` 的 selector 语义、
 * 清单分页与附件可用性。
 *
 * 判据按「不许猜 + 状态可分辨」逐条钉：
 * - **缺省 = 本 run 初始快照**，绝不换成「最近自有完成步骤」（那是 renderer 的默认，
 *   写进共享层或本层都会让桌面与 MCP 读到两份不同清单）；
 * - 显式 step 只认**本 run 自有**的完成 `agent.step`：祖先步骤、非 step 的 span、
 *   未知 id 一律 `STEP_NOT_FOUND`，不退回初始、不代填；
 * - 附件的 ok / missing / corrupt 三态与 `change` 四态各自可分辨，损坏不渲染成空文件；
 * - 清单**不出正文**：只有路径/字节/哈希/状态，带 `BODY_NOT_EXPOSED` 指路；
 * - 页宽生效并签发认证游标（5.2）；无法验证/参数不符的 `cursor` 稳定拒；
 * - 真实 I/O 故障是 `STORAGE_IO`（可重试），不伪装成某个文件的状态。
 */

let fx: CheckpointFixture;
let root: DataRoot;

beforeAll(() => {
  fx = buildCheckpointFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterAll(() => {
  cleanupCheckpointFixtures();
});

async function callInspect(runId: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return inspectCheckpointTool.execute({ runId, ...args }, root, ZH);
}

interface OkInspect {
  readonly data: InspectCheckpointData;
  readonly envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
  readonly result: ToolResult;
}

async function okInspect(runId: string, args: Record<string, unknown> = {}): Promise<OkInspect> {
  const result = await callInspect(runId, args);
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as InspectCheckpointData, envelope, result };
}

async function failureOf(runId: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await callInspect(runId, args);
  expect(result.isError).toBe(true);
  return result;
}

function errorOf(result: ToolResult): {
  code: string;
  message: string;
  ref?: string;
  retryable: boolean;
} {
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

function fileAt(data: InspectCheckpointData, path: string) {
  const item = data.files.find((entry) => entry.path === path);
  if (item === undefined) {
    throw new Error(`本页清单里没有 ${path}`);
  }
  return item;
}

describe("inspect_checkpoint：缺省 selector = 本 run 初始快照（Q13）", () => {
  it("省略 stepSpanId 给的是初始快照，而不是最近步骤的清单", async () => {
    const { data } = await okInspect(fx.ids.root, { limit: 100 });
    expect(data.checkpoint.stepSpanId).toBeNull();
    expect(data.checkpoint.localIteration).toBeNull();
    expect(data.checkpoint.snapshotId).toBe(fx.rootInitialSnapshotId);
    expect(data.checkpoint.initialSnapshotId).toBe(fx.rootInitialSnapshotId);
    // 这一条就是「不换最近步骤」的正面判据：给出的清单必须是初始那一份
    expect(data.checkpoint.snapshotId).not.toBe(fx.rootFinalSnapshotId);
    expect(data.checkpoint.runId).toBe(fx.ids.root);
    expect(data.checkpoint.ownerRunId).toBe(fx.ids.root);
    expect(data.checkpoint.profile).toBe("file-tools-v1");
    expect(data.checkpoint.worldId).toBe(fx.ids.root);
    expect(data.checkpoint.worldOrigin).toEqual({ kind: "import" });
    // 初始快照本身没有「相对初始」可谈
    expect(new Set(data.files.map((item) => item.change))).toEqual(new Set(["initial"]));
  });

  it("显式自有完成步骤：给该步轮末清单，轮号取本 run 自己的 n", async () => {
    const { data } = await okInspect(fx.ids.root, {
      stepSpanId: fx.rootStepSpanId,
      limit: 100,
    });
    expect(data.checkpoint.stepSpanId).toBe(fx.rootStepSpanId);
    expect(data.checkpoint.localIteration).toBe(1);
    expect(data.checkpoint.snapshotId).toBe(fx.rootFinalSnapshotId);
    // 「相对初始」仍相对**本 run 的**初始快照判，不是相对父 run
    expect(data.checkpoint.initialSnapshotId).toBe(fx.rootInitialSnapshotId);
    expect(data.files.map((item) => [item.path, item.change]).sort()).toEqual([
      ["added.txt", "added"],
      ["long.txt", "unchanged"],
      ["noeol.txt", "modified"],
      ["notes/crlf.txt", "unchanged"],
      ["same.txt", "unchanged"],
    ]);
  });

  it("分支 run 的「相对初始」是它自己的初始快照（= 父的轮末清单）", async () => {
    const { data } = await okInspect(fx.ids.child, { limit: 100 });
    expect(data.checkpoint.snapshotId).toBe(fx.rootFinalSnapshotId);
    expect(data.checkpoint.initialSnapshotId).toBe(fx.rootFinalSnapshotId);
    expect(data.checkpoint.worldOrigin).toEqual({
      kind: "checkpoint",
      runId: fx.ids.root,
      stepSpanId: fx.rootStepSpanId,
    });
    expect(new Set(data.files.map((item) => item.change))).toEqual(new Set(["initial"]));
    // 子 run 自己的轮末清单相对它自己的初始判 added
    const own = await okInspect(fx.ids.child, { stepSpanId: fx.childStepSpanId, limit: 100 });
    expect(own.data.checkpoint.snapshotId).toBe(fx.childFinalSnapshotId);
    expect(own.data.files.map((item) => [item.path, item.change]).sort()).toEqual([
      ["added.txt", "unchanged"],
      ["child-only.txt", "added"],
    ]);
  });

  it("指定祖先步骤 ⇒ STEP_NOT_FOUND：不退回初始、也不代填最近步骤", async () => {
    const error = errorOf(
      await failureOf(fx.ids.child, { stepSpanId: fx.rootStepSpanId, limit: 100 }),
    );
    expect(error.code).toBe("STEP_NOT_FOUND");
    expect(error.ref).toContain(`step:${fx.rootStepSpanId}`);
    expect(error.retryable).toBe(false);
  });

  it("指定非 step 的 span 与未知 id 同样 STEP_NOT_FOUND（只有自有完成 step 才有检查点）", async () => {
    const toolSpan = errorOf(await failureOf(fx.ids.root, { stepSpanId: fx.rootToolSpanId }));
    expect(toolSpan.code).toBe("STEP_NOT_FOUND");
    expect(toolSpan.ref).toContain(`step:${fx.rootToolSpanId}`);

    const unknown = errorOf(await failureOf(fx.ids.root, { stepSpanId: "s_99" }));
    expect(unknown.code).toBe("STEP_NOT_FOUND");
  });

  it("v1 非隔离 run ⇒ NO_WORKSPACE；缺失 run ⇒ RUN_NOT_FOUND", async () => {
    const plain = errorOf(await failureOf(fx.ids.plain));
    expect(plain.code).toBe("NO_WORKSPACE");
    expect(plain.message).toBe("该 run 不是隔离运行，没有文件检查点");

    const missing = errorOf(await failureOf(fx.ids.never));
    expect(missing.code).toBe("RUN_NOT_FOUND");
  });

  it("损坏记录与身份错配文件都按校验失败收口，且不借别的 run 替换结果", async () => {
    const corrupt = errorOf(await failureOf(fx.ids.corrupt));
    expect(corrupt.code).toBe("RUN_INVALID");

    const mismatch = errorOf(await failureOf(fx.ids.mismatch));
    expect(mismatch.code).toBe("RUN_INVALID");
    expect(JSON.stringify(mismatch)).not.toContain(fx.ids.mismatchRecordedId);
  });

  it("同一条件下与 get_run 给同一个码（两个工具不各判一套）", async () => {
    const inspectFailure = errorOf(await failureOf(fx.ids.mismatch));
    const runResult = await getRunTool.execute({ runId: fx.ids.mismatch }, root, ZH);
    expect(runResult.isError).toBe(true);
    expect(errorOf(runResult).code).toBe(inspectFailure.code);
  });
});

describe("inspect_checkpoint：清单、附件状态与正文边界", () => {
  it("附件三态可分辨：ok / missing / corrupt 各按磁盘事实给出，汇总数一致", async () => {
    const { data } = await okInspect(fx.ids.root, { limit: 100 });
    expect(data.checkpoint.fileCount).toBe(fx.initialFileCount);
    expect(data.checkpoint.unavailableCount).toBe(3);
    expect(fileAt(data, "empty.txt")).toMatchObject({
      availability: "ok",
      unavailableReason: null,
      bytes: 0,
      sha256: contentSha(""),
    });
    expect(fileAt(data, "gone.txt").availability).toBe("missing");
    expect(fileAt(data, "tampered-hash.txt").availability).toBe("corrupt");
    expect(fileAt(data, "tampered-len.txt").availability).toBe("corrupt");
    // 不可用必须带一句原因，但 ok 的那条恒为 null（不能把「没原因」写成空串）
    expect(fileAt(data, "gone.txt").unavailableReason).not.toBeNull();
  });

  it("「当前目录里有同名新文件」不参与历史清单：gone.txt 仍是 missing", async () => {
    const { data } = await okInspect(fx.ids.root, { limit: 100 });
    expect(fileAt(data, "gone.txt").availability).toBe("missing");
    expect(JSON.stringify(data)).not.toContain("今天的版本");
  });

  it("清单不出正文：无 text/content/base64/data 键，夹具 canary 一个不外发", async () => {
    const { data, envelope } = await okInspect(fx.ids.root, { limit: 100 });
    const keys = collectKeys(data);
    const leakedKeys = ["text", "content", "base64", "data", "dataDir", "tracesDir"].filter(
      (forbidden) => keys.has(forbidden),
    );
    expect(leakedKeys).toEqual([]);
    const serialized = JSON.stringify({ data, envelope });
    expect(["SENTINEL-", FILE_TEXTS.crlf].filter((needle) => serialized.includes(needle))).toEqual(
      [],
    );
    expect(
      envelope.limitations.some(
        (item) => item.code === "BODY_NOT_EXPOSED" && item.ref?.startsWith("snapshot:"),
      ),
    ).toBe(true);
  });

  it("空文件与二进制只给大小与哈希（清单层本就是内容寻址引用）", async () => {
    const { data } = await okInspect(fx.ids.root, { limit: 100 });
    expect(fileAt(data, "picture.bin")).toMatchObject({
      bytes: BINARY_BYTES.byteLength,
      sha256: bytesSha(BINARY_BYTES),
      availability: "ok",
    });
    expect(fileAt(data, "empty.txt").bytes).toBe(0);
    expect(fileAt(data, "empty.txt").sha256).toBe(contentSha(""));
  });

  it("默认页宽 20 生效并如实标 truncated，并签发续读游标（5.2）", async () => {
    const { data, envelope } = await okInspect(fx.ids.root);
    expect(data.files).toHaveLength(20);
    expect(data.totals).toEqual({
      files: fx.initialFileCount,
      listed: 20,
      remaining: fx.initialFileCount - 20,
      limit: 20,
    });
    expect(envelope.truncation.truncated).toBe(true);
    expect(envelope.truncation.nextCursor).toBeDefined();
    expect(envelope.page?.nextCursor).toBe(envelope.truncation.nextCursor);
  });

  it("limit=1 只给一条，其余如实报剩余；无法验证的 cursor 被拒", async () => {
    const { data } = await okInspect(fx.ids.root, { limit: 1 });
    expect(data.files).toHaveLength(1);
    expect(data.totals.remaining).toBe(fx.initialFileCount - 1);

    const error = errorOf(await failureOf(fx.ids.root, { cursor: "opaque-from-a-previous-run" }));
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.ref).toBe("cursor");
    expect(JSON.stringify(error)).not.toContain("opaque-from-a-previous-run");
  });

  it("入参形状在任何读取前拒：契约层拦超长，本层指出是哪个字段", async () => {
    // 超出上限的长度由 strict schema 直接拒（形状问题，给不了字段级 ref），且不回显取值
    const overLongRunId = `mcp0-cp-${"x".repeat(200)}`;
    const overLongStep = "s".repeat(129);
    for (const value of [overLongRunId, overLongStep]) {
      const args = value === overLongRunId ? { runId: value } : { stepSpanId: value };
      const shape = errorOf(await failureOf(fx.ids.root, args));
      expect(shape.code).toBe("INVALID_ARGUMENT");
      expect(JSON.stringify(shape)).not.toContain(value);
    }

    /**
     * schema 放行、语义非法的那些才由本层逐字段拒：`../`、盘符绝对路径、NUL 都是长度合法的
     * 字符串，但绝不能拿去拼文件名（design D3 + Q05）。
     */
    for (const [args, ref] of [
      [{ runId: "../outside" }, "runId"],
      [{ runId: "C:/Windows/system32" }, "runId"],
      [{ runId: "a\u0000b" }, "runId"],
      [{ stepSpanId: "s_01\u0000" }, "stepSpanId"],
    ] as const) {
      const error = errorOf(await failureOf(fx.ids.root, args));
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(error.ref).toBe(ref);
    }
  });

  it("未封存 run：TERMINATION_NOT_RECORDED 在场、已落盘清单照常可读", async () => {
    const { data, envelope } = await okInspect(fx.ids.open, { limit: 100 });
    expect(data.checkpoint.fileCount).toBe(fx.initialFileCount);
    expect(envelope.limitations.some((item) => item.code === "TERMINATION_NOT_RECORDED")).toBe(
      true,
    );
    expect(JSON.stringify(data)).not.toContain("仍在运行");
  });

  it("附件位置被目录顶替 ⇒ STORAGE_IO 且 retryable，不伪装成文件状态", async () => {
    const error = errorOf(await failureOf(fx.ids.ioRun, { limit: 100 }));
    expect(error.code).toBe("STORAGE_IO");
    expect(error.retryable).toBe(true);
    expect(JSON.stringify(error)).not.toContain(fx.dataDir);
  });
});

describe("inspect_checkpoint：定位失败码到稳定码的映射（design D4 码表封闭）", () => {
  /**
   * 五种定位码各有归属，映射表逐行钉住——两种载体（`inspectWorkspace` 的
   * `WORKSPACE_<大写码>` 与 `readWorkspaceFileForView` 的裸码）必须收敛到同一个码，
   * 否则同一个事实在两个工具里会是两个码。表里没写的码落 `RUN_INVALID`（不自行造码）。
   */
  it("五种定位码在两种载体下都映射到同一稳定码，未知码不造新码", () => {
    const table: readonly [string, string][] = [
      ["invalid_request", "INVALID_ARGUMENT"],
      ["run_not_found", "RUN_NOT_FOUND"],
      ["trace_invalid", "RUN_INVALID"],
      ["no_workspace", "NO_WORKSPACE"],
      ["step_not_found", "STEP_NOT_FOUND"],
    ];
    for (const [bare, stable] of table) {
      expect(toolCodeOfLocateFailure(bare)).toBe(stable);
      expect(toolCodeOfLocateFailure(`WORKSPACE_${bare.toUpperCase()}`)).toBe(stable);
    }
    expect(toolCodeOfLocateFailure("checkpoint_became_something_else")).toBe("RUN_INVALID");
  });
});

describe("inspect_checkpoint：来源、稳定映射与零写入", () => {
  it("来源段逐物理 run 给身份，refs 只指向本次给出的检查点（父链仅溯源）", async () => {
    const { envelope } = await okInspect(fx.ids.child, { stepSpanId: fx.childStepSpanId });
    // 父链为读详情而解析：两跳各给身份，而 lineage/spanScope 只对**本次读过轨迹的叶子**成立
    expect(envelope.provenance.runs).toEqual([
      { runId: fx.ids.root, formatVersion: 2, sealed: true },
      {
        runId: fx.ids.child,
        formatVersion: 2,
        sealed: true,
        lineage: "complete",
        spanScope: "resolved",
      },
    ]);
    expect(envelope.provenance.refs).toEqual([
      { runId: fx.ids.child, stepSpanId: fx.childStepSpanId, snapshotId: fx.childFinalSnapshotId },
    ]);
    expect(envelope.readVersion).toMatch(/^rv2:/);
  });

  it("refs 里的 snapshotId 与 get_run 检查点段同一条逐项相同（三处说法一致）", async () => {
    const inspect = await okInspect(fx.ids.root, { stepSpanId: fx.rootStepSpanId });
    const runResult = await getRunTool.execute({ runId: fx.ids.root, limit: 100 }, root, ZH);
    const runEnvelope = SuccessEnvelopeSchema.parse(runResult.structuredContent);
    const runData = runEnvelope.data as {
      index: {
        items: {
          kind: string;
          stepSpanId?: string | null;
          snapshotId?: string;
          fileCount?: number;
          totalBytes?: number;
        }[];
      };
    };
    const listed = runData.index.items.filter(
      (item) => item.kind === "checkpoint" && item.stepSpanId === fx.rootStepSpanId,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.snapshotId).toBe(inspect.data.checkpoint.snapshotId);
    expect(listed[0]?.fileCount).toBe(inspect.data.checkpoint.fileCount);
    expect(listed[0]?.totalBytes).toBe(inspect.data.checkpoint.totalBytes);
  });

  it("同参结果逐字相同（observedAt 除外），换 limit 即换 readVersion", async () => {
    const first = await okInspect(fx.ids.root, { limit: 5 });
    const second = await okInspect(fx.ids.root, { limit: 5 });
    const strip = (envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>) =>
      JSON.stringify({ ...envelope, observedAt: "fixed" });
    expect(strip(second.envelope)).toBe(strip(first.envelope));
    const third = await okInspect(fx.ids.root, { limit: 6 });
    expect(third.envelope.readVersion).not.toBe(first.envelope.readVersion);
  });

  it("五次查询前后数据目录递归指纹不变（traces 与附件都不写）", async () => {
    const before = dirFingerprintRecursive(fx.dataDir);
    await okInspect(fx.ids.root, { limit: 100 });
    await okInspect(fx.ids.root, { stepSpanId: fx.rootStepSpanId, limit: 100 });
    await failureOf(fx.ids.child, { stepSpanId: fx.rootStepSpanId });
    await failureOf(fx.ids.ioRun, { limit: 100 });
    await okInspect(fx.ids.open, { limit: 3 });
    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);
  });

  it("结果里没有宿主路径与内部目录名", async () => {
    const { data, envelope } = await okInspect(fx.ids.root, { limit: 100 });
    const serialized = JSON.stringify({ data, envelope });
    const leaked = [fx.dataDir, fx.blobsDir, "workspace-blobs", "traces/", ".jsonl"].filter(
      (needle) => serialized.includes(needle),
    );
    expect(leaked).toEqual([]);
  });

  it("长文本条目只给引用：正文长度与内容都不在清单里", async () => {
    const { data } = await okInspect(fx.ids.root, { limit: 100 });
    const long = fileAt(data, "long.txt");
    expect(long.bytes).toBe(Buffer.byteLength(LONG_BODY, "utf8"));
    const serialized = JSON.stringify(data);
    expect(["SENTINEL-long-body-", "甲甲甲", "🙂"].filter((n) => serialized.includes(n))).toEqual(
      [],
    );
  });
});
