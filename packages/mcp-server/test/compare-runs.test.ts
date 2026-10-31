import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { compareRunsTool } from "../src/query/compare-runs.js";
import type { CompareRunsData } from "../src/query/compare-runs.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  type QueryFixture,
  SENTINELS,
  buildQueryFixture,
  cleanupQueryFixtures,
  dirFingerprint,
} from "./query-fixtures.js";
import { ZH, errorMessageOf } from "./test-locale.js";
import { FORBIDDEN_KEYS, assertNoSentinels, collectKeys } from "./whitelist-assertions.js";

/**
 * MCP0 4.5（Q11/Q12 + S05 比较面）：`compare_runs` 的逐侧结论、关系判定与引用。
 *
 * 判据咬的是"不猜"这三件事：
 * - 坏侧保留身份 + 稳定码，好侧照常（不是空运行、也不是整批失败）；
 * - 只有一侧读到时**不判定关系**——单条链求"共同祖先"会得出它自己的根；
 * - `incomplete` 不升格成 `unrelated`，祖先差因此为 null 而不是猜一个数；
 *   结果里没有任何"谁更好/第 N 步对第 N 步"的字段。
 *
 * 正文边界用 canary 反查：比较只给输出 span 的引用与码点长度，
 * 那段正文只有走 `get_step(section=...)` 才会出门。
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

interface OkCompare {
  readonly data: CompareRunsData;
  readonly envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
}

async function okCompare(left: string, right: string): Promise<OkCompare> {
  const result = await compareRunsTool.execute(
    { left: { runId: left }, right: { runId: right } },
    root,
    ZH,
  );
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as CompareRunsData, envelope };
}

async function failureOf(left: unknown, right: unknown): Promise<ToolResult> {
  const result = await compareRunsTool.execute(
    { left: { runId: left }, right: { runId: right } },
    root,
    ZH,
  );
  expect(result.isError).toBe(true);
  return result;
}

function errorOf(result: ToolResult): { code: string; message: string; ref?: string } {
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

function sideOf(data: CompareRunsData, side: "left" | "right") {
  const item = data.sides.find((entry) => entry.side === side);
  if (item === undefined) throw new Error(`结果里缺少 ${side} 侧`);
  return item;
}

describe("compare_runs：逐侧结论（Q11）", () => {
  it("左侧损坏时保留其身份与稳定码，右侧事实照常，两格同序都在", async () => {
    const { data } = await okCompare(fx.ids.corrupt, fx.ids.alpha);
    expect(data.sides.map((item) => item.side)).toEqual(["left", "right"]);

    const bad = sideOf(data, "left");
    expect(bad.status).toBe("unavailable");
    if (bad.status !== "unavailable") return;
    expect(bad.runId).toBe(fx.ids.corrupt);
    expect(bad.code).toBe("RUN_INVALID");
    expect(bad.message).toBe(errorMessageOf("RUN_INVALID"));

    const good = sideOf(data, "right");
    expect(good.status).toBe("ready");
    if (good.status !== "ready") return;
    expect(good.run.runId).toBe(fx.ids.alpha);
    expect(good.consumption.alongChain?.tokens).toBe(120);
    // 坏侧不参与关系判定：不拿单条链的根冒充"共同祖先"
    expect(data.comparison.comparable).toBe(false);
    expect(data.comparison.relation).toEqual({ kind: "not-determinable", ancestorRunId: null });
    expect(good.consumption.deltaFromAncestor).toBeNull();
    expect(data.comparison.ancestor).toBeNull();
  });

  it("两侧都不可读时也是两格失败，不合并成一条也不冒充空运行", async () => {
    const { data } = await okCompare(fx.ids.corrupt, fx.ids.identityFile);
    expect(data.sides.map((item) => item.status)).toEqual(["unavailable", "unavailable"]);
    expect(sideOf(data, "right")).toMatchObject({
      runId: fx.ids.identityFile,
      code: "RUN_INVALID",
    });
    expect(data.comparison.comparable).toBe(false);
  });
});

describe("compare_runs：关系与累计（Q12）", () => {
  it("父子对照：共同祖先是父本体，祖先差 = 子的自有增量", async () => {
    const { data } = await okCompare(fx.ids.alpha, fx.ids.child);
    expect(data.comparison.comparable).toBe(true);
    expect(data.comparison.relation).toEqual({ kind: "common", ancestorRunId: fx.ids.alpha });
    expect(data.comparison.ancestor?.runId).toBe(fx.ids.alpha);

    const child = sideOf(data, "right");
    if (child.status !== "ready") throw new Error("右侧应当可读");
    expect(child.consumption.alongChain?.tokens).toBe(134);
    // 祖先差 = 子累计 − 父累计 = 子那一步的自有增量；耗时按同路口径同样是数（不是 null）
    expect(child.consumption.deltaFromAncestor?.tokens).toBe(14);
    expect(typeof child.consumption.deltaFromAncestor?.durationMs).toBe("number");
    // 左侧就是祖先本身：它的祖先差相对自己为 0
    const ancestorSide = sideOf(data, "left");
    if (ancestorSide.status !== "ready") throw new Error("左侧应当可读");
    expect(ancestorSide.consumption.deltaFromAncestor?.tokens).toBe(0);
  });

  it("两个不同根：如实 unrelated，两侧祖先差都是 null（不猜基线）", async () => {
    const { data } = await okCompare(fx.ids.alpha, fx.ids.beta);
    expect(data.comparison.relation).toEqual({ kind: "unrelated", ancestorRunId: null });
    expect(data.comparison.ancestor).toBeNull();
    for (const item of data.sides) {
      if (item.status === "ready") expect(item.consumption.deltaFromAncestor).toBeNull();
    }
  });

  it("一侧 ownOnly：关系判 incomplete，不升格成「不同根」，该侧带缺父 limitation", async () => {
    const { data, envelope } = await okCompare(fx.ids.alpha, fx.ids.orphan);
    expect(data.comparison.comparable).toBe(true);
    expect(data.comparison.relation).toEqual({ kind: "incomplete", ancestorRunId: null });
    const orphan = sideOf(data, "right");
    if (orphan.status !== "ready") throw new Error("orphan 侧应可读（ownOnly）");
    expect(orphan.lineage).toEqual({ status: "incomplete", missingRunId: "mcp0-gone" });
    expect(orphan.consumption.alongChain).toBeNull();
    expect(orphan.consumption.deltaFromAncestor).toBeNull();
    // 另一侧照常：坏链不污染好链的自有事实
    const alpha = sideOf(data, "left");
    if (alpha.status !== "ready") throw new Error("alpha 侧应可读");
    expect(alpha.consumption.alongChain?.tokens).toBe(120);
    const codes = envelope.limitations.map((item) => item.code);
    expect(codes).toContain("ANCESTOR_NOT_FOUND");
  });

  it("结果里没有「谁更好/修复成功/步骤对齐」这类结论字段", async () => {
    const { data } = await okCompare(fx.ids.alpha, fx.ids.child);
    const keys = collectKeys(data);
    for (const invented of [
      "winner",
      "better",
      "recommendation",
      "fixed",
      "passed",
      "testPassed",
      "alignedSteps",
      "stepPairs",
      "diff",
    ]) {
      expect(keys.has(invented)).toBe(false);
    }
  });
});

describe("compare_runs：输出只给引用（S05）", () => {
  it("最终输出给 span 引用与码点长度，正文本身不在比较结果里", async () => {
    const { data, envelope } = await okCompare(fx.ids.alpha, fx.ids.beta);
    const alpha = sideOf(data, "left");
    if (alpha.status !== "ready") throw new Error("alpha 侧应可读");
    expect(alpha.output.final).toEqual({
      spanId: "s_02",
      stepSpanId: "s_01",
      model: "controlled-model",
      textCodePoints: [...SENTINELS.responseContent].length,
    });
    expect(envelope.provenance.refs).toContainEqual({ runId: fx.ids.alpha, spanId: "s_02" });

    const serialized = JSON.stringify({ data, envelope });
    assertNoSentinels(serialized);
    const keys = collectKeys({ data, envelope });
    for (const forbidden of [...FORBIDDEN_KEYS, "content", "leftText", "rightText"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(envelope.limitations.map((item) => item.code)).toContain("BODY_NOT_EXPOSED");
  });

  it("未记录最终输出的那一侧如实分型，不拿中间正文或空串冒充", async () => {
    const { data } = await okCompare(fx.ids.alpha, fx.ids.zeta);
    const zeta = sideOf(data, "right");
    if (zeta.status !== "ready") throw new Error("zeta 侧应可读");
    expect(zeta.output.final).toBeNull();
    expect(zeta.output.missingReason).toBe("no-llm-call");
    expect(zeta.output.lastOutputKind).toBeNull();
    expect(zeta.output.intermediate).toBeNull();
  });

  it("error 终止的一侧给失败定位，但不带错误正文", async () => {
    const { data, envelope } = await okCompare(fx.ids.alpha, fx.ids.bodies);
    const bodies = sideOf(data, "right");
    if (bodies.status !== "ready") throw new Error("bodies 侧应可读");
    // bodies 的最后自有调用带 error ⇒ 最终输出未记录、错误详情可定位
    expect(bodies.output.final).toBeNull();
    expect(bodies.output.missingReason).toBe("has-error");
    expect(bodies.failure).toEqual({
      llmCallSpanId: "s_02",
      stepSpanId: "s_01",
      messageRecorded: true,
      status: 503,
      missingDetail: false,
    });
    expect(envelope.provenance.refs).toContainEqual({ runId: fx.ids.bodies, spanId: "s_02" });
    assertNoSentinels(JSON.stringify({ data, envelope }));
  });

  it("来源段合并两侧参与读取的物理 run，共享祖先只出现一次", async () => {
    const { envelope } = await okCompare(fx.ids.alpha, fx.ids.child);
    expect(envelope.provenance.runs).toEqual([
      {
        runId: fx.ids.alpha,
        formatVersion: 1,
        sealed: true,
        lineage: "complete",
        spanScope: "own",
      },
      {
        runId: fx.ids.child,
        formatVersion: 1,
        sealed: true,
        lineage: "complete",
        spanScope: "resolved",
      },
    ]);
  });
});

describe("compare_runs：入参边界与零写入", () => {
  it("同一条 run 自比、非法标识与数组形状都在读取前拒绝", async () => {
    const same = errorOf(await failureOf(fx.ids.alpha, fx.ids.alpha));
    expect(same.code).toBe("INVALID_ARGUMENT");
    expect(same.ref).toBe("left/right");

    const traversal = errorOf(await failureOf("../outside", fx.ids.alpha));
    expect(traversal.ref).toBe("left");
    expect(JSON.stringify(traversal)).not.toContain("outside");

    // 超长标识由入参 zod 先拦（上限 200，`ref` 里没有字段名——它给的是 `right.runId:too_big`）；
    // 形状违规（分隔符/穿越）才是实现层显式检查的活，两者都给 INVALID_ARGUMENT
    const badRight = errorOf(await failureOf(fx.ids.alpha, `r-${"z".repeat(210)}`));
    expect(badRight.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(badRight)).not.toContain("zzz");

    // 两侧对象而不是数组（D5 的统一参数风格）：数组直接被 strict schema 拒
    const arrayish = await compareRunsTool.execute(
      { left: fx.ids.alpha, right: fx.ids.child } as unknown as Record<string, unknown>,
      root,
      ZH,
    );
    expect(arrayish.isError).toBe(true);
    expect(errorOf(arrayish).code).toBe("INVALID_ARGUMENT");
  });

  it("四次比较后 traces 目录逐文件指纹不变", async () => {
    const before = dirFingerprint(fx.tracesDir);
    await okCompare(fx.ids.alpha, fx.ids.child);
    await okCompare(fx.ids.alpha, fx.ids.beta);
    await okCompare(fx.ids.corrupt, fx.ids.alpha);
    await okCompare(fx.ids.alpha, fx.ids.orphan);
    expect(dirFingerprint(fx.tracesDir)).toBe(before);
  });

  it("同一对两侧重复比较结果逐字相同（无时间抖动），readVersion 稳定", async () => {
    const first = await okCompare(fx.ids.alpha, fx.ids.child);
    const second = await okCompare(fx.ids.alpha, fx.ids.child);
    expect(second.data).toStrictEqual(first.data);
    expect(second.envelope.readVersion).toBe(first.envelope.readVersion);
  });

  it("一侧未封存时给 TERMINATION_NOT_RECORDED，不说它仍在运行", async () => {
    const { data, envelope } = await okCompare(fx.ids.alpha, fx.ids.epsilon);
    const epsilon = sideOf(data, "right");
    if (epsilon.status !== "ready") throw new Error("epsilon 侧应可读");
    expect(epsilon.run.outcome.sealed).toBe(false);
    const limitation = envelope.limitations.find(
      (item) => item.code === "TERMINATION_NOT_RECORDED",
    );
    expect(limitation?.ref).toBe(`run:${fx.ids.epsilon}`);
    expect(JSON.stringify(envelope.limitations)).not.toContain("仍在运行");
  });
});
