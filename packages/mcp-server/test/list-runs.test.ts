import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { TOOL_ERROR_MESSAGES } from "../src/error-projection.js";
import { listRunsTool } from "../src/query/list-runs.js";
import type { ListRunItem, ListRunsData } from "../src/query/list-runs.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  type QueryFixture,
  buildQueryFixture,
  cleanupQueryFixtures,
  dirFingerprint,
} from "./query-fixtures.js";
import { FORBIDDEN_KEYS, assertNoSentinels, collectKeys } from "./whitelist-assertions.js";

/**
 * MCP0 4.3（S03 摘要半边 + Q03/Q04 外部面）：`list_runs` 的筛选、排序、失败项与分页。
 *
 * 这一层要证的是「外部拿到的是白名单摘要，而且坏文件不会因为筛选就蒸发」：
 * - 摘要条目只有字段集里的键，正文类字段一个都不出门（用 SENTINEL 标记逐个搜）；
 * - 失败项构成序列末尾的固定段：**筛选只作用成功摘要**；
 * - 排序是 `created_at` 倒序 + 同刻 run 标识 UTF-16 代码单元升序（与区域排序可分辨）；
 * - 页宽生效但**不发假游标**：截断页如实 `truncated:true` 且没有 `nextCursor`，
 *   带游标的请求在 5.2 之前必须被显式拒绝，不能被当首页重放。
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

async function callListRuns(args: Record<string, unknown>): Promise<ToolResult> {
  return listRunsTool.execute(args, root);
}

interface OkResult {
  readonly data: ListRunsData;
  readonly envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
}

async function okData(args: Record<string, unknown> = {}): Promise<OkResult> {
  const result = await callListRuns(args);
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as ListRunsData, envelope };
}

interface ProjectedError {
  readonly code: string;
  readonly message: string;
  readonly ref?: string;
  readonly retryable: boolean;
}

async function failureOf(args: Record<string, unknown>): Promise<ProjectedError> {
  const result = await callListRuns(args);
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

function firstText(result: ToolResult): string {
  const [block] = result.content ?? [];
  return block?.type === "text" ? (block.text ?? "") : "";
}

function runItems(data: ListRunsData): Extract<ListRunItem, { kind: "run" }>[] {
  return data.items.filter(
    (item): item is Extract<ListRunItem, { kind: "run" }> => item.kind === "run",
  );
}

function failedItems(data: ListRunsData): Extract<ListRunItem, { kind: "unreadable_file" }>[] {
  return data.items.filter(
    (item): item is Extract<ListRunItem, { kind: "unreadable_file" }> =>
      item.kind === "unreadable_file",
  );
}

/** 夹具里的三件失败文件（损坏 / 身份错配 / 超长标识） */
const FAILURE_COUNT = 3;

describe("list_runs：序列与排序", () => {
  it("摘要按 created_at 倒序在前，失败文件段排在末尾", async () => {
    const { data } = await okData({ limit: 100 });
    expect(
      runItems(data)
        .slice(0, 5)
        .map((item) => item.runId),
    ).toEqual([fx.ids.experiment, fx.ids.workspaceRoot, fx.ids.alpha, fx.ids.beta, fx.ids.gamma]);
    const firstFailureIndex = data.items.findIndex((item) => item.kind === "unreadable_file");
    const lastRunIndex = data.items.reduce(
      (acc, item, index) => (item.kind === "run" ? index : acc),
      -1,
    );
    // 两段共用一个位置序列：失败段整体在成功段之后，而不是每页都重传一遍
    expect(firstFailureIndex).toBe(lastRunIndex + 1);
  });

  it("同一时刻按 run 标识的 UTF-16 代码单元升序，而不是区域排序", async () => {
    const { data } = await okData({ query: "mcp0-tie" });
    expect(runItems(data).map((item) => item.runId)).toEqual([fx.ids.tieUpper, fx.ids.tieLower]);
    // 反证：区域排序给出的正是相反顺序 ⇒ 这条判据不是「碰巧一样」
    expect(fx.ids.tieLower.localeCompare(fx.ids.tieUpper)).toBeLessThan(0);
  });

  it("同一时刻的批量条目按标识升序，整页顺序稳定可重放", async () => {
    const { data } = await okData({ query: "mcp0-bulk", limit: 100 });
    const ids = runItems(data).map((item) => item.runId);
    expect(ids).toHaveLength(fx.ids.bulkCount);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("list_runs：结局筛选（Q04 的类别口径）", () => {
  it("每一类只命中该类的代表 run，未记录终止与出错终止不互相冒充", async () => {
    const all = [fx.ids.alpha, fx.ids.beta, fx.ids.gamma, fx.ids.delta, fx.ids.epsilon] as const;
    const expected: Array<[string, string[]]> = [
      ["errored", [fx.ids.gamma]],
      ["ended_without_error", [fx.ids.alpha, fx.ids.child]],
      ["limited", [fx.ids.beta]],
      ["aborted", [fx.ids.delta]],
      ["termination_not_recorded", [fx.ids.epsilon]],
    ];
    for (const [status, shouldContain] of expected) {
      const { data } = await okData({ status, limit: 100 });
      const ids = runItems(data).map((item) => item.runId);
      expect(data.filter.status).toBe(status);
      for (const id of shouldContain) expect(ids).toContain(id);
      // 本类别之外的代表 run 必须都不在场（互斥；ended_without_error 里 child 也算正常结束）
      for (const id of all) {
        if (shouldContain.includes(id)) continue;
        expect(ids).not.toContain(id);
      }
    }
  });

  it("未封存条目标 sealed=false，不用文案暗示它仍在运行", async () => {
    const { data } = await okData({ status: "termination_not_recorded" });
    expect(runItems(data)[0]?.outcome).toEqual({
      kind: "interrupted",
      reason: null,
      sealed: false,
    });
  });

  it("缺 cache_hit 的记录保持未知（null），不补 0", async () => {
    const { data } = await okData({ query: "锃亮" });
    const item = runItems(data)[0];
    expect(item?.runId).toBe(fx.ids.zeta);
    expect(item?.tokens.cacheHit).toBeNull();
    expect(item?.tokens.in).toBe(0);
    // query 命中的是完整 task 文本里的非 ASCII 关键词，而不是 ID
    expect(item?.task).toContain("锃亮");
  });
});

describe("list_runs：失败文件不因筛选消失（Q03）", () => {
  it("损坏文件与身份错配文件各带稳定码，筛选与搜索后仍在场", async () => {
    const all = await okData({ limit: 100 });
    const byFile = new Map(failedItems(all.data).map((item) => [item.file, item.code]));
    expect(byFile.get(`${fx.ids.corrupt}.jsonl`)).toBe("RUN_INVALID");
    expect(byFile.get(`${fx.ids.identityFile}.jsonl`)).toBe("IDENTITY_MISMATCH");

    // 只筛「出错终止」也照样带着失败段——不伪造为空列表（Q03 的判据）
    const filtered = await okData({ status: "errored" });
    expect(failedItems(filtered.data)).toHaveLength(FAILURE_COUNT);
    expect(runItems(filtered.data).map((item) => item.runId)).toEqual([fx.ids.gamma]);
    expect(filtered.data.totals.unreadableFiles).toBe(FAILURE_COUNT);

    // query 同样不影响失败段
    const queried = await okData({ query: "锃亮" });
    expect(failedItems(queried.data)).toHaveLength(FAILURE_COUNT);
  });

  it("身份错配文件不把记录里的另一个 id 冒充成可请求的摘要", async () => {
    const { data } = await okData({ limit: 100 });
    expect(JSON.stringify(data)).not.toContain(fx.ids.identityRecordedId);
    expect(runItems(data).map((item) => item.runId)).not.toContain(fx.ids.identityRecordedId);
  });

  it("身份超出外部标识上限的记录以失败项在场，文件名按上限截断", async () => {
    const { data } = await okData({ query: "超长标识" });
    const overlong = failedItems(data).find((item) => item.file.startsWith("mcp0-long-"));
    expect(overlong?.code).toBe("RUN_INVALID");
    expect(overlong?.message).toBe(TOOL_ERROR_MESSAGES.RUN_INVALID);
    expect([...(overlong?.file ?? "")].length).toBeLessThanOrEqual(200);
    // 它没有被当成一条请求得到的摘要
    expect(runItems(data)).toHaveLength(0);
    expect(data.totals.unreadableFiles).toBe(FAILURE_COUNT);
  });

  it("失败项按安全文件标识升序，且不携带物理路径", async () => {
    const { data } = await okData({ limit: 100 });
    const files = failedItems(data).map((item) => item.file);
    expect(files).toEqual([...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(fx.tracesDir);
    expect(serialized).not.toContain(fx.dataDir);
  });
});

/**
 * 禁用字段按**键**判：`editField: "result"` 的值天然含 "result"，
 * 子串搜会把它读成泄漏（也会把真泄漏读成巧合）⇒ 递归收键名再比。
 */
describe("list_runs：白名单与正文边界（S03/S06）", () => {
  it("摘要不含任何正文：请求消息、模型回复、工具结果与分叉编辑值都不出门", async () => {
    const { data, envelope } = await okData({ limit: 100 });
    const serialized = JSON.stringify({ data, envelope });
    assertNoSentinels(serialized);
    const keys = collectKeys({ data, envelope });
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
    // 正面：task 与 model 逐字在场（白名单不是「什么都删」）
    const alpha = runItems(data).find((item) => item.runId === fx.ids.alpha);
    expect(alpha?.task).toBe(`MCP0 4.3 投影夹具 ${fx.ids.alpha}`);
    expect(alpha?.model).toBe("controlled-model");
  });

  it("分叉条目只给分叉点与字段名，实验组标签按摘要口径在场", async () => {
    const { data } = await okData({ query: "mcp0-child" });
    const child = runItems(data)[0];
    expect(child?.fork).toEqual({ atSpan: "s_03", editField: "result", experimentId: null });
    expect(child?.parentRunId).toBe(fx.ids.alpha);
  });

  it("来源段带真实身份与封存与否；列表没读过父链 ⇒ 完整性如实留空", async () => {
    const { envelope } = await okData({ status: "aborted" });
    expect(envelope.provenance.runs).toEqual([
      { runId: fx.ids.delta, formatVersion: 1, sealed: true },
    ]);
    expect(envelope.provenance.refs).toEqual([]);
    expect(envelope.limitations).toEqual([]);
  });

  it("信封带观测时点与读取版本，content 只一句状态不含正文", async () => {
    const result = await callListRuns({ limit: 3 });
    const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
    expect(envelope.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(envelope.readVersion).toMatch(/^rv1:[0-9a-f]{64}$/);
    const text = firstText(result);
    expect(text.startsWith("list_runs：命中 ")).toBe(true);
    expect(text).not.toContain("SENTINEL");
  });
});

describe("list_runs：分页窗口（页宽生效，游标归 5.2）", () => {
  it("默认页宽 20：超出部分如实标注 truncated，且不发假游标", async () => {
    const { data, envelope } = await okData();
    expect(envelope.page).toBeUndefined();
    expect(envelope.truncation).toEqual({ truncated: true });
    expect(data.items).toHaveLength(20);
    expect(data.totals).toMatchObject({ listed: 20, limit: 20 });
    expect(data.totals.remaining).toBe(
      data.totals.matchedRuns + data.totals.unreadableFiles - data.items.length,
    );
  });

  it("limit 生效并把失败项一并计入页额度", async () => {
    const small = await okData({ limit: 2 });
    expect(small.data.items).toHaveLength(2);
    expect(small.envelope.truncation.truncated).toBe(true);
    const full = await okData({ limit: 100 });
    expect(small.data.items).toEqual(full.data.items.slice(0, 2));
  });

  it("装得下时不标截断，也不带游标", async () => {
    const { data, envelope } = await okData({ status: "errored" });
    expect(envelope.truncation).toEqual({ truncated: false });
    expect(envelope.page).toBeUndefined();
    expect(data.totals.remaining).toBe(0);
  });

  it("带游标的请求被显式拒绝：不回显取值，也不静默重放首页", async () => {
    const error = await failureOf({ cursor: "c-secret-token", limit: 2 });
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.ref).toBe("cursor");
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("c-secret-token");
  });

  it("limit 越界、未知字段与错类别名都在读取前拒绝", async () => {
    expect((await failureOf({ limit: 101 })).code).toBe("INVALID_ARGUMENT");
    expect((await failureOf({ limit: 0 })).code).toBe("INVALID_ARGUMENT");
    expect((await failureOf({ status: "completed" })).code).toBe("INVALID_ARGUMENT");
    expect((await failureOf({ status: "succeeded" })).code).toBe("INVALID_ARGUMENT");
    const error = await failureOf({ dataDir: "D:/secret-root" });
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(error)).not.toContain("D:/secret-root");
    expect(JSON.stringify(error)).not.toContain("dataDir");
  });
});

describe("list_runs：空数据根与零写入", () => {
  it("空 traces 给合法空列表（不是错误）", async () => {
    const emptyDir = mktempEmptyRoot();
    try {
      const emptyRoot: DataRoot = {
        dataDir: emptyDir,
        tracesDir: join(emptyDir, "traces"),
      };
      const result = await listRunsTool.execute({}, emptyRoot);
      expect(result.isError).not.toBe(true);
      const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
      expect((envelope.data as ListRunsData).items).toEqual([]);
      expect(envelope.provenance.runs).toEqual([]);
      expect(envelope.truncation).toEqual({ truncated: false });
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("查询前后 traces 目录逐文件指纹不变", async () => {
    const before = dirFingerprint(fx.tracesDir);
    await okData({ limit: 100 });
    await okData({ status: "errored" });
    expect(dirFingerprint(fx.tracesDir)).toBe(before);
  });

  it("readVersion 对同一份数据稳定；候选集合变化后随之改变（5.2 续读的依据）", async () => {
    const appended = join(fx.tracesDir, "mcp0-appended.jsonl");
    const before = (await okData()).envelope.readVersion;
    expect((await okData()).envelope.readVersion).toBe(before);
    /**
     * 参数本身进摘要（design D4）：换筛选条件就是换一次查询，readVersion 必然不同——
     * 5.2 的游标正是靠「参数 + 版本」双绑定才判得出「这一页续不下去」。
     */
    expect((await okData({ status: "errored" })).envelope.readVersion).not.toBe(before);

    writeFileSync(
      appended,
      `${JSON.stringify({
        type: "run.meta",
        id: "mcp0-appended",
        format_version: 1,
        task: "查询之间新增的 run",
        model: "controlled-model",
        created_at: "2026-10-20T00:05:00.000Z",
        parent: null,
        fork: null,
      })}\n${JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" })}\n`,
    );
    try {
      // 同一参数、列表里多了一个 run：续读不能沿用旧版本（否则会把两个来源拼成一页）
      expect((await okData()).envelope.readVersion).not.toBe(before);
    } finally {
      rmSync(appended, { force: true });
    }
  });
});

function mktempEmptyRoot(): string {
  const dir = join(fx.dataDir, "..", `mcp0-empty-${Date.now()}`);
  mkdirSync(join(dir, "traces"), { recursive: true });
  return dir;
}
