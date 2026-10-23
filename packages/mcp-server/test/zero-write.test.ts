import { readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { TOOL_ERROR_MESSAGES } from "../src/error-projection.js";
import type { CompareCheckpointFilesData } from "../src/query/compare-checkpoint-files.js";
import type { GetStepData } from "../src/query/get-step.js";
import type { ListRunsData } from "../src/query/list-runs.js";
import type { ReadCheckpointFileData } from "../src/query/read-checkpoint-file.js";
import { dirFingerprintRecursive } from "./checkpoint-fixtures.js";
import {
  INITIALIZED_FRAME,
  StdioSession,
  callFrame,
  cancelFrame,
  envelopeOf,
  errorOf,
  frameBodyTexts,
  initFrame,
  okData,
  resultOf,
  treeListing,
} from "./stdio-harness.js";
import { assertNoSentinels } from "./whitelist-assertions.js";
import {
  ZW_LONG_PATH,
  ZW_MISSING_PATH,
  ZW_SENTINEL_TEXT,
  type ZeroWriteFixture,
  buildZeroWriteFixture,
  cleanupZeroWriteFixtures,
  injectBlobSubstitute,
} from "./zero-write-fixtures.js";

/**
 * MCP0 5.4（Q15/Q16 + S14 另一半）：真实 stdio 子进程的零写入 / 零执行端到端复核。
 *
 * 判据是**比出来的**，不是声明出来的：
 * - 整根递归指纹（相对路径 + 内容 SHA-256 + 目录标记）在完整查询链、逐页到底、正文读到末尾、
 *   故障路径、取消、两次重启会话前后必须**逐字相同**；
 * - 数据根的文件集合是**封闭白名单**（只有 traces/*.jsonl、workspace-blobs/sha256/<64hex>、
 *   current-source/gone.txt）⇒ 任何 index/lock/session/log/journal 之类新产物都会落进 extras 判红，
 *   "无新运行、不登记 operation、不占执行槽"因此在工件层面可核对，而不只靠 annotations；
 * - Q16：清单登记的 `gone.txt` 只登记不发布附件，同一根里放着**同名新文件**的当前源版本
 *   （内容是 `SENTINEL-` canary）⇒ 必须回 `missing`，既不拿当前源补齐，也不修写旧快照。
 *
 * "模型/工具/导出计数为零"的**结构半边**在 `closure.test.ts`（扫 dist 的 import 白名单与
 * 写盘/执行 API 调用点），本文件只做端到端行为半边；两者分开留证，不互相顶替。
 */

const sessions: StdioSession[] = [];
let fx: ZeroWriteFixture;

async function openSession(dataDir: string): Promise<StdioSession> {
  const session = await StdioSession.start(dataDir);
  sessions.push(session);
  return session;
}

/** 数据根的相对路径集合（去掉前导斜杠），用于封闭白名单判定 */
function relPaths(dir: string): string[] {
  return treeListing(dir)
    .map((entry) => entry.replace(/^\//, ""))
    .sort();
}

/** 白名单：这三类之外的一切新条目都算"查询留下了产物" */
function unexpectedEntries(paths: string[]): string[] {
  const allowed = [
    /^traces$/,
    /^traces\/mcp0-zw-[a-z]+\.jsonl$/,
    /^workspace-blobs$/,
    /^workspace-blobs\/sha256$/,
    /^workspace-blobs\/sha256\/[0-9a-f]{64}$/,
    /^current-source$/,
    /^current-source\/gone\.txt$/,
  ];
  return paths.filter((path) => !allowed.some((pattern) => pattern.test(path)));
}

/** 完整只读链：六个工具 + 内容模式比较，一次会话里全部跑通 */
function fullChain(fixture: ZeroWriteFixture): Array<[string, Record<string, unknown>]> {
  return [
    ["list_runs", { limit: 100 }],
    ["get_run", { runId: fixture.runAId }],
    ["get_step", { runId: fixture.runAId, spanId: fixture.toolSpanId, section: "output" }],
    ["compare_runs", { left: { runId: fixture.runAId }, right: { runId: fixture.runBId } }],
    ["inspect_checkpoint", { runId: fixture.workspaceRunId }],
    ["read_checkpoint_file", { runId: fixture.workspaceRunId, path: ZW_LONG_PATH }],
    [
      "compare_checkpoint_files",
      {
        left: { runId: fixture.workspaceRunId },
        right: { runId: fixture.workspaceRunId, stepSpanId: fixture.workspaceStepSpanId },
      },
    ],
    [
      "compare_checkpoint_files",
      {
        left: { runId: fixture.workspaceRunId },
        right: { runId: fixture.workspaceRunId, stepSpanId: fixture.workspaceStepSpanId },
        path: ZW_LONG_PATH,
      },
    ],
  ];
}

async function runChain(
  session: StdioSession,
  fixture: ZeroWriteFixture,
  baseId: number,
): Promise<string> {
  const chain = fullChain(fixture);
  session.writeFrames([
    ...chain.map(([name, args], index) => callFrame(baseId + index, name, args)),
  ]);
  const collected: string[] = [];
  for (let index = 0; index < chain.length; index += 1) {
    const frame = await session.waitForFrame(baseId + index);
    const envelope = envelopeOf(frame);
    collected.push(JSON.stringify(envelope.data));
  }
  return collected.join("|");
}

beforeAll(() => {
  // 夹具自证：missing 的附件确实没发布（否则 Q16 判据是空的）
  fx = buildZeroWriteFixture();
  expect(readdirSync(fx.blobsDir)).not.toContain(fx.missingSha);
  cleanupZeroWriteFixtures();
}, 120_000);

beforeEach(() => {
  fx = buildZeroWriteFixture();
}, 180_000);

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.dispose();
  }
  cleanupZeroWriteFixtures();
});

describe("Q15 查询全链零写入", () => {
  it("六个工具全部跑通之后，整根指纹与文件集合逐字不变", async () => {
    const before = dirFingerprintRecursive(fx.dataDir);
    const beforeTree = relPaths(fx.dataDir);
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), INITIALIZED_FRAME]);
    await session.waitForFrame(1);
    const results = await runChain(session, fx, 2);

    // 链真的读到了东西（不是七条空壳）：正文、清单、逐侧状态都在结果里
    expect(results).toContain(ZW_LONG_PATH);
    expect(results.length).toBeGreaterThan(10_000);
    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);
    expect(relPaths(fx.dataDir)).toEqual(beforeTree);
    await session.end();
  }, 240_000);

  it("逐页翻到底 + 正文续读到末尾同样零写入（分页与续读不留下任何游标状态）", async () => {
    const before = dirFingerprintRecursive(fx.dataDir);
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), INITIALIZED_FRAME]);
    await session.waitForFrame(1);

    let cursor: string | undefined;
    let id = 2;
    let pages = 0;
    const seen: string[] = [];
    for (;;) {
      session.writeFrame(
        callFrame(id, "list_runs", { limit: 2, ...(cursor === undefined ? {} : { cursor }) }),
      );
      const { data, envelope } = okData<ListRunsData>(await session.waitForFrame(id));
      for (const item of data.items) {
        seen.push(item.kind === "run" ? `run:${item.runId}` : `file:${item.file}`);
      }
      cursor = envelope.truncation.nextCursor;
      pages += 1;
      id += 1;
      if (cursor === undefined) break;
      expect(pages).toBeLessThan(20);
    }
    expect(new Set(seen).size).toBe(seen.length);

    // 正文读到末尾：每段都换新游标，直到 truncated:false
    let bodyCursor: string | undefined;
    let text = "";
    for (;;) {
      session.writeFrame(
        callFrame(id, "get_step", {
          runId: fx.runAId,
          spanId: fx.toolSpanId,
          section: "output",
          maxChars: 8,
          ...(bodyCursor === undefined ? {} : { cursor: bodyCursor }),
        }),
      );
      const frame = await session.waitForFrame(id);
      const { data, envelope } = okData<GetStepData>(frame);
      const body = data.body;
      if (body === null || body.recorded !== true) throw new Error("正文应已记录");
      // 6.2 改判：正文本体只在 content 投影（data 内对应位是 bodyIn 指针）
      text += frameBodyTexts(frame)[0] ?? "";
      bodyCursor = envelope.truncation.nextCursor;
      id += 1;
      if (bodyCursor === undefined) break;
    }
    expect(text.length).toBeGreaterThan(8);
    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);
    await session.end();
  }, 300_000);

  it("数据根文件集合是封闭白名单：没有任何索引/锁/session/日志类新产物", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), INITIALIZED_FRAME]);
    await session.waitForFrame(1);
    await runChain(session, fx, 2);
    await session.end();
    expect(unexpectedEntries(relPaths(fx.dataDir))).toEqual([]);
    // traces/ 里仍然只有夹具那四个文件 ⇒ 没有新运行落盘
    expect(readdirSync(fx.tracesDir).sort()).toEqual([
      "mcp0-zw-a.jsonl",
      "mcp0-zw-b.jsonl",
      "mcp0-zw-corrupt.jsonl",
      "mcp0-zw-ws.jsonl",
    ]);
  }, 240_000);
});

describe("Q16 源目录变化不能补历史附件", () => {
  it("附件缺失 + 当前源目录有同名新文件 ⇒ 回 missing，不读当前源、不修写快照", async () => {
    const before = dirFingerprintRecursive(fx.dataDir);
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "read_checkpoint_file", { runId: fx.workspaceRunId, path: ZW_MISSING_PATH }),
      callFrame(3, "inspect_checkpoint", { runId: fx.workspaceRunId, limit: 100 }),
      callFrame(4, "compare_checkpoint_files", {
        left: { runId: fx.workspaceRunId },
        right: { runId: fx.workspaceRunId, stepSpanId: fx.workspaceStepSpanId },
        path: ZW_MISSING_PATH,
      }),
    ]);
    const read = okData<ReadCheckpointFileData>(await session.waitForFrame(2));
    expect(read.data.file.status).toBe("missing");
    // 缺失仍然带着清单记录的哈希与字节（fullFile 描述完整历史文件），但不给正文
    const fileRecord = read.data.file as unknown as {
      fullFile?: { sha256: string; bytes: number };
      reason?: string;
      text?: string;
    };
    expect(fileRecord.fullFile?.sha256).toBe(fx.missingSha);
    expect(fileRecord.fullFile?.bytes).toBe(fx.missingBytes);
    expect(fileRecord.text).toBeUndefined();
    expect(fileRecord.reason).toBeDefined();

    const inspect = envelopeOf(await session.waitForFrame(3));
    expect(JSON.stringify(inspect.data)).toContain(ZW_MISSING_PATH);

    const compared = okData<CompareCheckpointFilesData>(await session.waitForFrame(4));
    const files = (
      compared.data as { files?: { left?: { status?: string }; right?: { status?: string } } }
    ).files;
    expect(files?.left?.status).toBe("missing");
    expect(files?.right?.status).toBe("missing");

    // 当前源目录那份新版本既没被读出来，也没被补成附件；它自己的字节也没变（指纹含它）
    const stdout = session.stdoutText();
    assertNoSentinels(stdout);
    expect(stdout).not.toContain(ZW_SENTINEL_TEXT);
    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);
    await session.end();
  }, 240_000);
});

describe("故障与生命周期路径同样零写入", () => {
  it("坏尾行 / 缺 run / 附件目录替身三类故障各给稳定码，且触发前后指纹不变", async () => {
    const session0 = await openSession(fx.dataDir);
    session0.writeFrames([initFrame(1), INITIALIZED_FRAME]);
    await session0.waitForFrame(1);
    // 附件目录替身：已发布的 blob 换成目录 ⇒ 真实 I/O 故障，不伪装成文件状态
    injectBlobSubstitute(fx, fx.longSha);
    const before = dirFingerprintRecursive(fx.dataDir);
    // 基线树在注入**之后**取：目录替身是夹具的一部分，不是查询留下的产物
    const beforeTree = relPaths(fx.dataDir);
    await session0.end();

    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "get_run", { runId: "mcp0-zw-corrupt" }),
      callFrame(3, "get_run", { runId: "mcp0-zw-does-not-exist" }),
      callFrame(4, "read_checkpoint_file", { runId: fx.workspaceRunId, path: ZW_LONG_PATH }),
      callFrame(5, "inspect_checkpoint", { runId: fx.runAId }),
    ]);
    // 坏尾行的定位就是请求里那个 runId：不拼物理路径，也不给半个文件位置（4.x 同口径）
    expect(errorOf(await session.waitForFrame(2))).toEqual({
      code: "RUN_INVALID",
      message: TOOL_ERROR_MESSAGES.RUN_INVALID,
      retryable: false,
    });
    expect(errorOf(await session.waitForFrame(3))).toEqual({
      code: "RUN_NOT_FOUND",
      message: TOOL_ERROR_MESSAGES.RUN_NOT_FOUND,
      retryable: false,
    });
    const io = errorOf(await session.waitForFrame(4));
    expect(io.code).toBe("STORAGE_IO");
    expect(io.retryable).toBe(true);
    expect(ErrorEnvelopeSchema.parse(resultOf(session.frameFor(4)).structuredContent).ok).toBe(
      false,
    );
    // NO_WORKSPACE：甲是 v1 run，本来就没有检查点 ⇒ 也是稳定码，不是异常文本
    expect(errorOf(await session.waitForFrame(5)).code).toBe("NO_WORKSPACE");

    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);
    expect(relPaths(fx.dataDir)).toEqual(beforeTree);
    await session.end();
  }, 300_000);

  it("取消在途查询之后：既有文件哈希不变、零新运行（S14 的行为半边）", async () => {
    const before = dirFingerprintRecursive(fx.dataDir);
    const beforeTree = relPaths(fx.dataDir);
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      INITIALIZED_FRAME,
      callFrame(2, "list_runs", { limit: 100 }),
      cancelFrame(2),
      callFrame(3, "read_checkpoint_file", { runId: fx.workspaceRunId, path: ZW_LONG_PATH }),
    ]);
    await session.waitForFrame(3);
    expect(session.framesFor(2)).toHaveLength(0);
    expect(session.stderrFor("tool_cancelled")).toHaveLength(1);
    expect(dirFingerprintRecursive(fx.dataDir)).toBe(before);
    expect(relPaths(fx.dataDir)).toEqual(beforeTree);
    await session.end();
  }, 240_000);

  it("两次重启会话各跑一遍全链：三次指纹逐字相同，结果事实也逐字相同", async () => {
    const baseline = dirFingerprintRecursive(fx.dataDir);
    const outcomes: string[] = [];
    for (const _round of [1, 2, 3]) {
      const session = await openSession(fx.dataDir);
      session.writeFrames([initFrame(1), INITIALIZED_FRAME]);
      await session.waitForFrame(1);
      outcomes.push(await runChain(session, fx, 2));
      await session.end();
      expect(dirFingerprintRecursive(fx.dataDir)).toBe(baseline);
    }
    // 同一份数据反复读，去掉 observedAt/readVersion 这类时点后，事实必须逐字一致
    expect(new Set(outcomes).size).toBe(1);
    expect(unexpectedEntries(relPaths(fx.dataDir))).toEqual([]);
  }, 420_000);

  it("结果里不出现数据根/当前源目录的物理位置，只给逻辑路径与哈希", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), INITIALIZED_FRAME]);
    await session.waitForFrame(1);
    await runChain(session, fx, 2);
    await session.end();
    const stdout = session.stdoutText();
    expect(stdout).not.toContain(fx.dataDir);
    expect(stdout).not.toContain(fx.tracesDir);
    expect(stdout).not.toContain(fx.currentSourceDir);
    expect(stdout).not.toContain("workspace-blobs");
    expect(stdout).not.toContain("tmp");
    expect(
      SuccessEnvelopeSchema.parse(resultOf(session.frameFor(2)).structuredContent).apiVersion,
    ).toBe("rebaseagent.query.v1");
  }, 240_000);
});
