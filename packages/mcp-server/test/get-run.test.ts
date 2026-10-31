import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, LimitationSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { getRunTool } from "../src/query/get-run.js";
import type { GetRunData } from "../src/query/get-run.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  type QueryFixture,
  buildQueryFixture,
  cleanupQueryFixtures,
  dirFingerprint,
} from "./query-fixtures.js";
import { ZH } from "./test-locale.js";
import { FORBIDDEN_KEYS, assertNoSentinels, collectKeys } from "./whitelist-assertions.js";

/**
 * MCP0 4.3（S03 摘要半边 + Q04）：`get_run` 的白名单、来源链、索引与未知语义。
 *
 * 判据按「四段各有边界」逐个钉：
 * - `run` 与列表同一份字段集（`run.tokens` 必须等于 `consumption.own`，两处「自有」不能漂）；
 * - 缺父只走 `ownOnly + ANCESTOR_NOT_FOUND`，坏身份只走受控失败，不借别的 run 替换结果；
 * - 未封存 ⇒ `TERMINATION_NOT_RECORDED`，不暗示「仍在运行」；没录 usage ⇒ null 不是 0；
 * - 索引里继承项带**真实 owner**（按投影位置，不按 id 猜），重名标 `ambiguousOwner`；
 * - 检查点段 = 初始快照 + 本 run 自有完成步骤，快照 id 与清单逐项对得上；
 * - 分叉编辑值 / 实验原值 / 假设 / 判据 / 端点 一律不出门，只以 `BODY_NOT_EXPOSED` 指路。
 */

let fx: QueryFixture;
let root: DataRoot;

beforeAll(() => {
  fx = buildQueryFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterAll(() => {
  cleanupQueryFixtures();
});

async function callGetRun(runId: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return getRunTool.execute({ runId, ...args }, root, ZH);
}

interface OkRun {
  readonly data: GetRunData;
  readonly envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
  readonly result: ToolResult;
}

async function okRun(runId: string, args: Record<string, unknown> = {}): Promise<OkRun> {
  const result = await callGetRun(runId, args);
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as GetRunData, envelope, result };
}

async function failureOf(runId: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await callGetRun(runId, args);
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

/** 索引里的 span 项（按 spanId 取第一条） */
function spanItem(data: GetRunData, spanId: string) {
  const item = data.index.items.find((entry) => entry.kind === "span" && entry.spanId === spanId);
  if (item === undefined || item.kind !== "span") {
    throw new Error(`索引里没有 span ${spanId}`);
  }
  return item;
}

function checkpointItems(data: GetRunData) {
  return data.index.items.filter((entry) => entry.kind === "checkpoint");
}

describe("get_run：白名单摘要与来源段", () => {
  it("根 run：自有消耗等于摘要数字，预算与配置指纹按记录在场", async () => {
    const { data } = await okRun(fx.ids.alpha);
    expect(data.run.runId).toBe(fx.ids.alpha);
    expect(data.run.formatVersion).toBe(1);
    expect(data.run.outcome).toEqual({ kind: "completed", reason: "completed", sealed: true });
    expect(data.run.parentRunId).toBeNull();
    expect(data.run.fork).toBeNull();
    expect(data.record).toEqual({
      completeness: "complete",
      spanScope: "own",
      budgetMaxTotalTokens: 100_000,
      configHash: "sha256:controlled-config",
      configHashReason: null,
    });
    // 同一份「自有」事实不能两处漂
    expect(data.consumption.own.tokensIn).toBe(data.run.tokens.in);
    expect(data.consumption.own.tokensOut).toBe(data.run.tokens.out);
    // 根 run 的沿链累计 == 自有（没有上游可加）
    expect(data.consumption.alongChain?.tokens).toBe(data.run.tokens.in + data.run.tokens.out);
    expect(data.chain).toHaveLength(1);
    expect(data.chain[0]).toMatchObject({ runId: fx.ids.alpha, isSelf: true, fork: null });
    expect(data.intervention.fork).toBeNull();
    expect(data.intervention.experiment).toBeNull();
  });

  it("result 分叉子：父链两跳、继承项标注真实 owner、累计增量沿链求和", async () => {
    const { data } = await okRun(fx.ids.child);
    expect(data.record.spanScope).toBe("resolved");
    expect(data.chain.map((hop) => hop.runId)).toEqual([fx.ids.alpha, fx.ids.child]);
    expect(data.chain.map((hop) => hop.isSelf)).toEqual([false, true]);
    expect(data.chain[1]?.fork).toEqual({
      atSpan: "s_03",
      editField: "result",
      resumeAfterStep: null,
    });

    expect(data.index.totals.spans).toBe(6);
    const inherited = spanItem(data, "s_02");
    expect(inherited).toMatchObject({ ownerRunId: fx.ids.alpha, own: false, spanKind: "llm.call" });
    const own = spanItem(data, "s_22");
    expect(own).toMatchObject({ ownerRunId: fx.ids.child, own: true });

    // 自有 = 子自己那一步（默认 10/4），沿链累计 = 父 120 + 子 14
    expect(data.consumption.own.tokensIn).toBe(10);
    expect(data.consumption.own.tokensOut).toBe(4);
    expect(data.consumption.alongChain?.tokens).toBe(134);
    expect(data.consumption.alongChain?.steps).toBe(2);
    // 分叉子没有预算/配置指纹字段也不冒充：预算是父录的，子没带就是 null
    expect(data.record.budgetMaxTotalTokens).toBeNull();
  });

  it("缺父的 prompt 分叉走 ownOnly：来源不完整给 limitation，累计增量为 null 不补零", async () => {
    const { data, envelope } = await okRun(fx.ids.orphan);
    expect(data.record.completeness).toBe("ownOnly");
    expect(data.lineage).toEqual({ status: "incomplete", missingRunId: "mcp0-gone" });
    expect(data.consumption.alongChain).toBeNull();
    expect(data.run.parentRunId).toBe("mcp0-gone");
    const codes = envelope.limitations.map((item) => item.code);
    expect(codes).toContain("ANCESTOR_NOT_FOUND");
    const ancestor = envelope.limitations.find((item) => item.code === "ANCESTOR_NOT_FOUND");
    expect(ancestor?.ref).toBe("run:mcp0-gone");
    // 链在缺失点截断：只剩自己一跳
    expect(data.chain.map((hop) => hop.runId)).toEqual([fx.ids.orphan]);
  });

  it("未封存：sealed=false + TERMINATION_NOT_RECORDED，已落盘记录照常返回", async () => {
    const { data, envelope } = await okRun(fx.ids.epsilon);
    expect(data.run.outcome).toEqual({ kind: "interrupted", reason: null, sealed: false });
    const limitation = envelope.limitations.find(
      (item) => item.code === "TERMINATION_NOT_RECORDED",
    );
    expect(LimitationSchema.parse(limitation).ref).toBe(`run:${fx.ids.epsilon}`);
    // 已落盘的 step 仍在索引里（事故现场可读，这是只读诊断的意义）
    expect(data.index.totals.spans).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain("仍在运行");
  });

  it("没录 usage 的 run：缓存命中与本次缓存合计都保持未知，不补 0", async () => {
    const { data } = await okRun(fx.ids.zeta);
    expect(data.run.tokens.cacheHit).toBeNull();
    expect(data.consumption.own.cache).toEqual({ recorded: 0, total: 0, hitTotal: null });
    expect(data.consumption.own.tokensIn).toBe(0);
  });

  it("实测零命中与未记录可分辨：cache_hit=0 是有值", async () => {
    const { data } = await okRun(fx.ids.experiment);
    expect(data.run.tokens.cacheHit).toBe(0);
    expect(data.consumption.own.cache).toEqual({ recorded: 1, total: 1, hitTotal: 0 });
  });
});

describe("get_run：索引与检查点（S03 的可回查半边）", () => {
  it("重名 span 标注 ambiguousOwner，归属按投影位置而不是取首项", async () => {
    const { data } = await okRun(fx.ids.ambiguousChild);
    const item = spanItem(data, "s_02");
    expect(item.ambiguousOwner).toBe(true);
    // 独立执行边界：投影只剩自有轨迹，位置归属就是本 run
    expect(item.ownerRunId).toBe(fx.ids.ambiguousChild);
    expect(item.own).toBe(true);
    const notAmbiguous = spanItem(data, "s_03");
    expect(notAmbiguous.ambiguousOwner).toBe(false);
  });

  it("v2 隔离根：检查点段 = 初始快照 + 本 run 完成步骤，清单与快照 id 逐项对得上", async () => {
    const { data, envelope } = await okRun(fx.ids.workspaceRoot);
    const checkpoints = checkpointItems(data);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({
      stepSpanId: null,
      iteration: null,
      snapshotId: fx.initialSnapshotId,
      fileCount: 2,
      totalBytes: 22,
      worldOrigin: { kind: "import" },
    });
    expect(checkpoints[1]).toMatchObject({
      stepSpanId: "s_01",
      iteration: 1,
      snapshotId: fx.finalSnapshotId,
      fileCount: 2,
      totalBytes: 33,
      worldOrigin: null,
    });
    // 引用可回桌面：run + step + 快照 id，物理位置一个都不带
    expect(envelope.provenance.refs).toEqual([
      { runId: fx.ids.workspaceRoot, snapshotId: fx.initialSnapshotId },
      { runId: fx.ids.workspaceRoot, stepSpanId: "s_01", snapshotId: fx.finalSnapshotId },
    ]);
    expect(spanItem(data, "s_01")).toMatchObject({ hasWorkspaceSnapshot: true, iteration: 1 });
  });

  it("来源段逐物理 run 给身份与封存；轨迹范围只对被读的叶子成立", async () => {
    const { envelope } = await okRun(fx.ids.child);
    expect(envelope.provenance.runs).toEqual([
      { runId: fx.ids.alpha, formatVersion: 1, sealed: true },
      {
        runId: fx.ids.child,
        formatVersion: 1,
        sealed: true,
        lineage: "complete",
        spanScope: "resolved",
      },
    ]);
  });

  it("limit 只作用于索引，totals 仍报全量并签发续读游标", async () => {
    const { data, envelope } = await okRun(fx.ids.child, { limit: 2 });
    expect(data.index.items).toHaveLength(2);
    expect(data.index.totals).toMatchObject({ spans: 6, checkpoints: 0, listed: 2, limit: 2 });
    expect(data.index.totals.remaining).toBe(4);
    expect(envelope.page?.nextCursor).toBeDefined();
    expect(envelope.truncation).toMatchObject({ truncated: true });
    expect(envelope.truncation.nextCursor).toBe(envelope.page?.nextCursor);
  });
});

describe("get_run：分叉与 v3 实验只给身份（D5/D7）", () => {
  it("v3 实验：基线身份与执行条件在场，原值/假设/判据/端点不出门", async () => {
    const { data, envelope, result } = await okRun(fx.ids.experiment);
    expect(data.intervention.experiment).toEqual({
      baselineRunId: fx.ids.workspaceRoot,
      baselineLlmSpanId: fx.workspaceRootFirstLlmSpanId,
      initialSnapshotId: fx.initialSnapshotId,
      execution: {
        model: "controlled-model",
        maxIterations: 8,
        maxTotalTokens: 100_000,
        configFingerprint: "fp-controlled-1",
        paramsRecorded: true,
      },
    });
    expect(data.intervention.fork).toEqual({
      atSpan: fx.workspaceRootFirstLlmSpanId,
      editField: "user_message",
      resumeAfterStep: null,
      experimentId: null,
    });
    expect(data.record.spanScope).toBe("own");
    const codes = envelope.limitations.map((item) => item.code);
    expect(codes).toContain("BODY_NOT_EXPOSED");
    expect(result.isError).not.toBe(true);

    const serialized = JSON.stringify({ data, envelope });
    assertNoSentinels(serialized);
    expect(serialized).not.toContain("example.invalid");
    const keys = collectKeys({ data, envelope });
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("检查点索引带初始快照与本轮快照，实验起点是父根初始快照", async () => {
    const { data } = await okRun(fx.ids.experiment);
    const checkpoints = checkpointItems(data);
    expect(checkpoints[0]).toMatchObject({
      stepSpanId: null,
      snapshotId: fx.initialSnapshotId,
      worldOrigin: {
        kind: "initial",
        runId: fx.ids.workspaceRoot,
        snapshotId: fx.initialSnapshotId,
      },
    });
    expect(checkpoints[1]).toMatchObject({ stepSpanId: "s_61", snapshotId: fx.finalSnapshotId });
  });

  it("祖先的检查点不会被算成本 run 自有：初始优先、不换最近步骤", async () => {
    const { data } = await okRun(fx.ids.child);
    expect(data.index.totals.checkpoints).toBe(0);
    expect(checkpointItems(data)).toEqual([]);
  });
});

describe("get_run：错误面不泄露内部载荷（S06）", () => {
  it("不存在的 run ⇒ RUN_NOT_FOUND，文案不含路径", async () => {
    const result = await failureOf(fx.ids.missing);
    const error = errorOf(result);
    expect(error.code).toBe("RUN_NOT_FOUND");
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain(fx.tracesDir);
  });

  it("穿越与超长标识在任何读取前按参数问题拒绝，且不回显取值", async () => {
    const traversal = errorOf(await failureOf("../outside"));
    expect(traversal.code).toBe("INVALID_ARGUMENT");
    expect(traversal.ref).toBe("runId");
    expect(JSON.stringify(traversal)).not.toContain("outside");

    const tooLong = errorOf(await failureOf(`r-${"y".repeat(210)}`));
    expect(tooLong.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(tooLong)).not.toContain("yyy");
  });

  it("文件名与记录身份不符 ⇒ 受控失败，不借另一条记录替换结果", async () => {
    const error = errorOf(await failureOf(fx.ids.identityFile));
    expect(error.code).toBe("RUN_INVALID");
    expect(JSON.stringify(error)).not.toContain(fx.ids.identityRecordedId);
    expect(JSON.stringify(error)).not.toContain(fx.tracesDir);
  });

  it("无法验证的游标被显式拒绝（不回显取值）", async () => {
    const error = errorOf(await failureOf(fx.ids.alpha, { cursor: "c-again" }));
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.ref).toBe("cursor");
    expect(JSON.stringify(error)).not.toContain("c-again");
  });

  it("损坏文件作为详情读取失败，原因只有码表文案", async () => {
    const error = errorOf(await failureOf(fx.ids.corrupt));
    expect(error.code).toBe("RUN_INVALID");
    expect(error.message.length).toBeLessThanOrEqual(512);
  });
});

describe("get_run：零写入与稳定序列化", () => {
  it("跨多份详情读取后 traces 目录逐文件指纹不变", async () => {
    const before = dirFingerprint(fx.tracesDir);
    for (const id of [
      fx.ids.alpha,
      fx.ids.child,
      fx.ids.orphan,
      fx.ids.workspaceRoot,
      fx.ids.experiment,
    ]) {
      await okRun(id);
    }
    expect(dirFingerprint(fx.tracesDir)).toBe(before);
  });

  it("同一 run 两次读取的 data 逐字相同（不引入时间戳抖动）", async () => {
    const first = await okRun(fx.ids.workspaceRoot);
    const second = await okRun(fx.ids.workspaceRoot);
    expect(second.data).toStrictEqual(first.data);
    expect(second.envelope.readVersion).toBe(first.envelope.readVersion);
  });

  it("content 只一句状态，不复制正文也不带物理路径", async () => {
    const { result } = await okRun(fx.ids.child);
    const [block] = result.content ?? [];
    const text = block?.type === "text" ? (block.text ?? "") : "";
    expect(text.startsWith("get_run：")).toBe(true);
    expect(text).toContain("已封存");
    expect(text).not.toContain(fx.tracesDir);
    expect(text).not.toContain("SENTINEL");
  });
});
