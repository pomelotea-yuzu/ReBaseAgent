import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SuccessEnvelope } from "../src/envelope.js";
import { TOOL_ERROR_MESSAGES } from "../src/error-projection.js";
import type { GetStepData } from "../src/query/get-step.js";
import type { ListRunItem, ListRunsData } from "../src/query/list-runs.js";
import {
  STDIO_BODY_CHARS,
  STDIO_LATE_RUN_ID,
  STDIO_LIST_RUNS,
  type StdioFixture,
  addLateRun,
  buildStdioFixture,
  cleanupStdioFixtures,
} from "./stdio-fixtures.js";
import {
  INITIALIZED_FRAME,
  StdioSession,
  callFrame,
  cancelFrame,
  errorOf,
  initFrame,
  okData,
  treeListing,
} from "./stdio-harness.js";

/**
 * MCP0 5.3（S13/S14）：真实 stdio 子进程的取消、EOF 与重连。
 *
 * 时序口径**全部来自实测**（`.workbuddy/mcp0-53/probe-cancel2.cjs` 三个场景 ×6 轮稳定），
 * 不是对 SDK 的推断：
 * - 同批到达的 `notifications/cancelled` 排在**本请求 handler 之前**一个微任务
 *   （请求侧多一层 `.then`）⇒ 被取消的查询**不起跑**，stdout 里那个 id 一帧都没有；
 * - 响应已外发之后的迟到取消 ⇒ SDK 的控制器已注销 ⇒ 不追加帧、不报错、不重发；
 * - 本包读取全同步 ⇒ 不存在"读到一半被中断"的第三态，这条如实写进限制，不假装覆盖。
 *
 * 每个用例一份独立数据根：S13 的"来源变化"要往根里新增 run，不能牵着别的用例漂。
 * 完整的前后 SHA-256 字节指纹与零执行计数归 **5.4**，这里只钉"没多出文件"。
 */

const PAGES_LIMIT = 5;
/** 夹具里成功 run 的总数（24 列表 + 大正文 + v2 工作区 + 对照短 + 未封存） */
const EXPECTED_RUNS = STDIO_LIST_RUNS + 4;

let fx: StdioFixture;
const sessions: StdioSession[] = [];

async function openSession(dataDir: string): Promise<StdioSession> {
  const session = await StdioSession.start(dataDir);
  sessions.push(session);
  return session;
}

function itemKey(item: ListRunItem): string {
  return item.kind === "run" ? `run:${item.runId}` : `file:${item.file}`;
}

function cursorOf(envelope: SuccessEnvelope): string {
  const cursor = envelope.truncation.nextCursor;
  if (cursor === undefined) throw new Error("应当签发续读游标");
  expect(envelope.page?.nextCursor).toBe(cursor);
  expect(cursor.startsWith("mcpc1.")).toBe(true);
  return cursor;
}

/** `body` 是 `recorded` 判别式联合：先窄化再取 text/range，不靠 `?.` 蒙过去 */
function bodyOf(data: GetStepData): {
  text: string;
  range: { start: number; end: number; total: number };
  truncated: boolean;
} {
  if (data.body === null || data.body.recorded !== true) {
    throw new Error("该 span 的 section 正文应已记录");
  }
  return data.body;
}

/** 逐页翻到底：每页都要等新响应，所以按 id 递增串行发 */
async function paginateListRuns(
  session: StdioSession,
  startId: number,
  limit: number,
): Promise<{ keys: string[]; pages: number }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let id = startId;
  let pages = 0;
  for (;;) {
    session.writeFrame(
      callFrame(id, "list_runs", { limit, ...(cursor === undefined ? {} : { cursor }) }),
    );
    const { data, envelope } = okData<ListRunsData>(await session.waitForFrame(id));
    keys.push(...data.items.map(itemKey));
    cursor = envelope.truncation.nextCursor;
    pages += 1;
    id += 1;
    if (cursor === undefined) return { keys, pages };
    if (pages > 40) throw new Error("翻页未收敛（游标可能原地打转）");
  }
}

beforeAll(() => {
  expect(STDIO_BODY_CHARS).toBeGreaterThan(8_192);
}, 60_000);

beforeEach(() => {
  fx = buildStdioFixture();
}, 180_000);

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.dispose();
  }
  cleanupStdioFixtures();
});

describe("S14 取消只终止该查询本身", () => {
  it("同批到达的取消：被取消的 id 一帧都不回、读取不起跑，同批其它查询照常", async () => {
    const before = treeListing(fx.dataDir);
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "list_runs", { limit: PAGES_LIMIT }),
      cancelFrame(2),
      callFrame(3, "list_runs", { limit: 3 }),
      callFrame(4, "list_runs", { limit: 1 }),
    ]);
    await session.waitForFrame(4);

    // 被取消的那一条：stdout 里连半个字节都没有（不是"回了个取消结果"）
    expect(session.framesFor(2)).toHaveLength(0);
    expect(session.frames.map((frame) => frame.id)).toEqual([1, 3, 4]);
    expect(session.stdoutText()).not.toContain("已取消");
    // 审计与"不起跑"是一对：有 tool_cancelled，就没有对应的第三次 tool_call
    expect(session.stderrFor("tool_call")).toHaveLength(2);
    const cancelled = session.stderrFor("tool_cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toContain("list_runs");
    // 同批的其它查询不受牵连，照常出门并签发续读游标
    const { data, envelope } = okData<ListRunsData>(session.frameFor(3));
    expect(data.items).toHaveLength(3);
    expect(cursorOf(envelope).length).toBeGreaterThan(0);
    // 取消不产生任何写入/执行痕迹（数据根文件集合逐字不变）
    expect(treeListing(fx.dataDir)).toEqual(before);
    expect(session.stderrFor("protocol_error")).toHaveLength(0);
    await session.end();
  }, 180_000);

  it("响应已外发后的迟到取消：不追加帧、不报错，会话继续", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), INITIALIZED_FRAME, callFrame(2, "list_runs", { limit: 2 })]);
    await session.waitForFrame(2);
    const framesAfterResponse = session.frames.length;

    // 取消已经结束的请求：控制器早已注销 ⇒ 没有 tool_cancelled，也不会重发那一帧
    session.writeFrames([cancelFrame(2), callFrame(3, "list_runs", { limit: 1 })]);
    await session.waitForFrame(3);
    expect(session.framesFor(2)).toHaveLength(1);
    expect(session.frames.length).toBe(framesAfterResponse + 1);
    expect(session.stderrFor("tool_cancelled")).toHaveLength(0);
    expect(session.stderrFor("protocol_error")).toHaveLength(0);
    expect(session.unparsedStdout()).toEqual([]);
    await session.end();
  }, 120_000);

  it("对不存在与重复的 requestId 发取消：容忍，不影响后续查询", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "list_runs", { limit: 2 }),
      cancelFrame(2),
      cancelFrame(2),
      cancelFrame(999),
      callFrame(3, "list_runs", { limit: 1 }),
    ]);
    await session.waitForFrame(3);
    expect(session.frames.map((frame) => frame.id)).toEqual([1, 3]);
    // 重复取消只审计一次；未知 id 的取消连审计都不该有
    expect(session.stderrFor("tool_cancelled")).toHaveLength(1);
    expect(session.stderrFor("tool_call")).toHaveLength(1);
    expect(session.stderrFor("protocol_error")).toHaveLength(0);
    expect(session.unparsedStdout()).toEqual([]);
    await session.end();
  }, 120_000);
});

describe("S13 EOF 释放资源", () => {
  it("大正文请求写出后立刻 EOF：进程落定退出，stdout 每帧完整、不追加半帧", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "get_step", {
        runId: fx.bodyRunId,
        spanId: fx.bodySpanId,
        section: "output",
        maxChars: 8_192,
      }),
    ]);
    const exit = await session.end();
    expect(exit.code).toBe(0);
    // 单段最多 8,192 码点：这一帧确实是"大结果"，但仍然是完整一行
    expect(session.unparsedStdout()).toEqual([]);
    expect(session.frames.map((frame) => frame.id)).toEqual([1, 2]);
    expect(Buffer.byteLength(session.stdoutText(), "utf8")).toBeGreaterThan(10_000);
    const { data } = okData<GetStepData>(session.frameFor(2));
    const body = bodyOf(data);
    // 结构正文是 canonical-json：字符串正文带首尾引号 ⇒ 外发总码点 = 原文码点 + 2
    expect(body.range.total).toBe(STDIO_BODY_CHARS + 2);
    expect([...body.text].length).toBe(8_192);
    // EOF 之后不再有任何外发：帧数固定为 2，也不会有后台续发的第三条
    expect(session.frames.length).toBe(2);
    expect(exit.stdout.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(2);
    expect(exit.stderr).toContain("server_ready");
  }, 180_000);

  it("半帧之后 EOF：残段不被当成畸形输入刷屏，进程照样落定", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), INITIALIZED_FRAME]);
    await session.waitForFrame(1);
    session.writeRaw('{"jsonrpc":"2.0","id":2,"method":"tools/list"');
    const exit = await session.end();
    expect(exit.code).toBe(0);
    expect(session.frames.map((frame) => frame.id)).toEqual([1]);
    expect(session.unparsedStdout()).toEqual([]);
    // 未凑满一行的输入在传输层就没人认领：不报协议错，也不回 id=2
    expect(exit.stderr.split("protocol_error").length - 1).toBe(0);
  }, 120_000);
});

describe("S13 重连只是重新查询", () => {
  it("真实重启后旧列表游标落 STALE_CURSOR，新会话同参数重新读到同一页事实", async () => {
    const session1 = await openSession(fx.dataDir);
    session1.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "list_runs", { limit: PAGES_LIMIT }),
    ]);
    const first = okData<ListRunsData>(await session1.waitForFrame(2));
    const cursor = cursorOf(first.envelope);
    expect(first.data.items).toHaveLength(PAGES_LIMIT);
    const exit1 = await session1.end();
    expect(exit1.code).toBe(0);

    // 数据一个字节没动 ⇒ STALE 只能来自"这是另一个进程的密钥"（真实服务重启）
    const session2 = await openSession(fx.dataDir);
    session2.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "list_runs", { limit: PAGES_LIMIT, cursor }),
      callFrame(3, "list_runs", { limit: PAGES_LIMIT }),
    ]);
    expect(errorOf(await session2.waitForFrame(2))).toEqual({
      code: "STALE_CURSOR",
      message: TOOL_ERROR_MESSAGES.STALE_CURSOR,
      ref: "cursor",
      retryable: true,
    });
    const again = okData<ListRunsData>(await session2.waitForFrame(3));
    expect(again.data.items.map(itemKey)).toEqual(first.data.items.map(itemKey));
    expect(again.envelope.readVersion).toBe(first.envelope.readVersion);
    await session2.end();
  }, 180_000);

  it("真实重启后旧正文游标同样 STALE，新会话重新读到同一段正文", async () => {
    const args = {
      runId: fx.bodyRunId,
      spanId: fx.bodySpanId,
      section: "output" as const,
      maxChars: 64,
    };
    const session1 = await openSession(fx.dataDir);
    session1.writeFrames([initFrame(1), INITIALIZED_FRAME, callFrame(2, "get_step", args)]);
    const first = okData<GetStepData>(await session1.waitForFrame(2));
    const cursor = cursorOf(first.envelope);
    expect([...bodyOf(first.data).text].length).toBe(64);
    await session1.end();

    const session2 = await openSession(fx.dataDir);
    session2.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "get_step", { ...args, cursor }),
      callFrame(3, "get_step", args),
    ]);
    expect(errorOf(await session2.waitForFrame(2)).code).toBe("STALE_CURSOR");
    const again = okData<GetStepData>(await session2.waitForFrame(3));
    // 重连不拼旧内容：正文与范围逐字重建，游标是这一进程新签的
    expect(again.data).toEqual(first.data);
    expect(cursorOf(again.envelope)).not.toBe(cursor);
    await session2.end();
  }, 180_000);

  it("会话内来源变化：旧游标 STALE，随后首页第一条就是新增那条（每请求重读盘）", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "list_runs", { limit: PAGES_LIMIT }),
    ]);
    const first = okData<ListRunsData>(await session.waitForFrame(2));
    const cursor = cursorOf(first.envelope);
    expect(first.data.totals.matchedRuns).toBe(EXPECTED_RUNS);

    addLateRun(fx.tracesDir);

    session.writeFrames([
      callFrame(3, "list_runs", { limit: PAGES_LIMIT, cursor }),
      callFrame(4, "list_runs", { limit: PAGES_LIMIT }),
    ]);
    expect(errorOf(await session.waitForFrame(3)).code).toBe("STALE_CURSOR");
    const fresh = okData<ListRunsData>(await session.waitForFrame(4));
    expect(fresh.data.totals.matchedRuns).toBe(EXPECTED_RUNS + 1);
    const head = fresh.data.items[0];
    expect(head?.kind === "run" ? head.runId : undefined).toBe(STDIO_LATE_RUN_ID);

    // 重启后同样看得见：新进程重新读盘，没有任何跨会话缓存
    await session.end();
    const reopened = await openSession(fx.dataDir);
    const { keys, pages } = await paginateListRuns(reopened, 2, PAGES_LIMIT);
    expect(pages).toBeGreaterThan(PAGES_LIMIT);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`run:${STDIO_LATE_RUN_ID}`);
    expect(keys).toHaveLength(EXPECTED_RUNS + 1);
    await reopened.end();
  }, 300_000);

  it("重启后的新会话逐页翻完 = 单页 limit=100 的完整集合（无重不漏，来源一致）", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrame(initFrame(1));
    await session.waitForFrame(1);
    session.writeFrame(callFrame(2, "list_runs", { limit: 100 }));
    const full = okData<ListRunsData>(await session.waitForFrame(2));
    expect(full.data.totals.matchedRuns).toBe(EXPECTED_RUNS);
    const expected = full.data.items.map(itemKey);
    expect(expected).toHaveLength(EXPECTED_RUNS);

    const { keys, pages } = await paginateListRuns(session, 3, PAGES_LIMIT);
    expect(keys).toEqual(expected);
    expect(pages).toBe(Math.ceil(EXPECTED_RUNS / PAGES_LIMIT));
    await session.end();

    // 换一个进程再翻一遍：同一份事实，不掺上一次会话的任何残留
    const reopened = await openSession(fx.dataDir);
    reopened.writeFrame(initFrame(1));
    await reopened.waitForFrame(1);
    const again = await paginateListRuns(reopened, 2, PAGES_LIMIT);
    expect(again.keys).toEqual(expected);
    await reopened.end();
  }, 300_000);
});
