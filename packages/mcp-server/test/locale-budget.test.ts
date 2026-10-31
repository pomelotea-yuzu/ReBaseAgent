import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SuccessEnvelopeSchema } from "../src/envelope.js";
import { RESPONSE_BUDGET_BYTES } from "../src/limits.js";
import {
  type BudgetChainFixture,
  type BudgetPageFixture,
  type BudgetWorkspaceFixture,
  buildBudgetChainFixture,
  buildBudgetPageFixture,
  buildBudgetWorkspaceFixture,
  cleanupBudgetFixtures,
} from "./budget-fixtures.js";
import { contentBodyTexts } from "./content-bodies.js";
import { StdioSession, callFrame, initFrame, resultOf } from "./stdio-harness.js";
import {
  type VerificationFixture,
  buildVerificationFixture,
  cleanupVerificationFixtures,
  VERIFICATION_FIXTURE_IDS as vIds,
} from "./verification-fixtures.js";

/**
 * i18n 5.4（M25/M26/G02）：真实 stdio 子进程上两语言跑全部十三工具。
 *
 * - 一个合并数据根（运行/工作区/长链/验证四组夹具）挂在一个 server 上；
 * - zh-CN 与 en-US 各自启动一个真实子进程，逐个调用十三工具（含分页/续读与
 *   单项超限的受控失败），量客户端实收结果的完整 UTF-8 字节；
 * - 重启换语言后提交上一进程的游标 ⇒ STALE_CURSOR，且新进程首页的分页意义
 *   （range/正文原文）与上一进程一致。
 *
 * 量法与预算门禁无关：这里独立 JSON.stringify(result) 计字节，不复用服务端实现。
 */

const LOCALES = ["zh-CN", "en-US"] as const;
type Locale = (typeof LOCALES)[number];

let pageFx: BudgetPageFixture;
let wsFx: BudgetWorkspaceFixture;
let chainFx: BudgetChainFixture;
let verFx: VerificationFixture;
let combinedRoot: string;
let currentLocale: Locale = "zh-CN";
const measurements: Array<{
  locale: Locale;
  tool: string;
  bytes: number;
  isError: boolean;
}> = [];

const sessions: StdioSession[] = [];

beforeAll(() => {
  pageFx = buildBudgetPageFixture();
  wsFx = buildBudgetWorkspaceFixture();
  chainFx = buildBudgetChainFixture();
  verFx = buildVerificationFixture();
  combinedRoot = mergeFixtureRoots([pageFx.dataDir, wsFx.dataDir, chainFx.dataDir, verFx.dataRoot]);
}, 300_000);

afterAll(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  cleanupBudgetFixtures();
  cleanupVerificationFixtures();
  if (combinedRoot !== undefined) rmSync(combinedRoot, { recursive: true, force: true });
});

/** 把多组夹具的 traces / 附件 / 验证记录合并到一个真实数据根；同名 trace 视为夹具冲突 */
function mergeFixtureRoots(sources: readonly string[]): string {
  const dest = mkdtempSync(join(tmpdir(), "mcp-i18n-54-"));
  mkdirSync(join(dest, "traces"), { recursive: true });
  const seen = new Set<string>();
  for (const source of sources) {
    const traces = join(source, "traces");
    if (existsSync(traces)) {
      for (const file of readdirSync(traces)) {
        if (seen.has(file)) throw new Error(`夹具 trace 冲突：${file}`);
        seen.add(file);
        cpSync(join(traces, file), join(dest, "traces", file));
      }
    }
    for (const dir of ["workspace-blobs", "verification-assets", "verifications"]) {
      if (existsSync(join(source, dir))) {
        cpSync(join(source, dir), join(dest, dir), { recursive: true });
      }
    }
  }
  return dest;
}

interface WireResult {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

interface Session {
  readonly session: StdioSession;
  nextId: number;
}

async function openSession(locale: Locale): Promise<Session> {
  const session = await StdioSession.start(combinedRoot, ["--locale", locale]);
  sessions.push(session);
  session.writeFrame(initFrame(1));
  await session.waitForFrame(1);
  return { session, nextId: 2 };
}

async function call(
  open: Session,
  name: string,
  args: Record<string, unknown>,
): Promise<WireResult> {
  const id = open.nextId;
  open.nextId += 1;
  open.session.writeFrame(callFrame(id, name, args));
  return resultOf(await open.session.waitForFrame(id)) as WireResult;
}

function bytesOf(result: WireResult): number {
  // 与服务端预算同形：isError 缺省按 false 计，保守多算而不是少算
  return Buffer.byteLength(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    }),
    "utf8",
  );
}

function envelopeOf(result: WireResult) {
  expect(result.isError).not.toBe(true);
  return SuccessEnvelopeSchema.parse(result.structuredContent);
}

function nextCursorOf(result: WireResult): string | undefined {
  return envelopeOf(result).truncation.nextCursor;
}

function contentTextOf(result: WireResult): string {
  const block = (result.content as Array<{ type: string; text?: string }> | undefined)?.[0];
  return block?.text ?? "";
}

function assertBudget(result: WireResult, tool: string): void {
  const bytes = bytesOf(result);
  measurements.push({ locale: currentLocale, tool, bytes, isError: result.isError === true });
  expect(bytes, `${tool} 结果超过 64 KiB`).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
}

describe("M25 两语言十三工具：真实 stdio 子进程预算、分页与续读", () => {
  it("zh-CN 与 en-US 各自跑满十三工具，结果不超 64 KiB，身份/范围可用", async () => {
    const called = new Set<string>();

    for (const locale of LOCALES) {
      currentLocale = locale;
      const open = await openSession(locale);
      const zh = locale === "zh-CN";

      // 1) list_runs
      {
        const result = await call(open, "list_runs", { limit: 5 });
        assertBudget(result, "list_runs");
        const env = envelopeOf(result);
        const data = env.data as { items: unknown[] };
        expect(data.items).toHaveLength(5);
        expect(contentTextOf(result)).toContain(zh ? "命中" : "matching summaries");
        called.add("list_runs");
      }

      // 2) get_run：长跨度索引按预算收窄，跟一页游标
      {
        const first = await call(open, "get_run", { runId: pageFx.ids.manySpans, limit: 5 });
        assertBudget(first, "get_run");
        const env = envelopeOf(first);
        const data = env.data as {
          run: { runId: string };
          index: { items: Array<{ kind: string; spanId?: string }>; totals: { remaining: number } };
        };
        expect(data.run.runId).toBe(pageFx.ids.manySpans);
        const cursor = env.truncation.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) throw new Error("get_run 应有下一页");
        const second = await call(open, "get_run", {
          runId: pageFx.ids.manySpans,
          limit: 5,
          cursor,
        });
        assertBudget(second, "get_run#2");
        const secondItems = (
          envelopeOf(second).data as { index: { items: Array<{ kind: string; spanId?: string }> } }
        ).index.items;
        const firstKeys = new Set(
          data.index.items.map((item) => `${item.kind}:${item.spanId ?? ""}`),
        );
        for (const item of secondItems) {
          expect(firstKeys.has(`${item.kind}:${item.spanId ?? ""}`)).toBe(false);
        }
        expect(data.index.totals.remaining).toBeGreaterThan(0);
        called.add("get_run");
      }

      // 3) get_step：Unicode 正文档位，正文续读起点相接
      {
        const args = {
          runId: chainFx.leafRunId,
          spanId: chainFx.leafToolSpanId,
          section: "output",
          maxChars: 8192,
        };
        const first = await call(open, "get_step", args);
        assertBudget(first, "get_step");
        const env = envelopeOf(first);
        const data = env.data as {
          span: { ownerRunId?: string; id?: string };
          body: { recorded: boolean; range?: { start: number; end: number } };
        };
        expect(JSON.stringify(data)).toContain(chainFx.leafRunId);
        expect(data.body.recorded).toBe(true);
        const range = data.body.range;
        if (range === undefined) throw new Error("get_step 应有正文范围");
        const bodyFirst = contentBodyTexts(first)[0] ?? "";
        expect([...bodyFirst].length).toBe(range.end - range.start);
        const cursor = env.truncation.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) throw new Error("get_step 应有续读游标");
        const second = await call(open, "get_step", { ...args, cursor });
        assertBudget(second, "get_step#2");
        const secondRange = (envelopeOf(second).data as { body: { range: { start: number } } }).body
          .range;
        expect(secondRange.start).toBe(range.end);
        const secondBody = contentBodyTexts(second)[0] ?? "";
        // 正文按码点切片：第二页不得重发第一页
        expect(secondBody.startsWith(bodyFirst)).toBe(false);
        called.add("get_step");
      }

      // 4) compare_runs
      {
        const result = await call(open, "compare_runs", {
          left: { runId: pageFx.ids.pages[0] },
          right: { runId: pageFx.ids.pages[1] },
        });
        assertBudget(result, "compare_runs");
        const data = envelopeOf(result).data as { sides: Array<{ status: string }> };
        expect(data.sides.map((side) => side.status)).toEqual(["ready", "ready"]);
        called.add("compare_runs");
      }

      // 5) inspect_checkpoint：长路径清单页收窄，跟一页游标
      {
        const first = await call(open, "inspect_checkpoint", {
          runId: wsFx.runId,
          limit: 20,
        });
        assertBudget(first, "inspect_checkpoint");
        const env = envelopeOf(first);
        const data = env.data as {
          checkpoint: { snapshotId: string; fileCount: number };
          files: Array<{ path: string }>;
          totals: { remaining: number };
        };
        expect(data.checkpoint.snapshotId).toMatch(/^[0-9a-f]{64}$/);
        expect(data.checkpoint.fileCount).toBe(wsFx.initialFileCount);
        const cursor = env.truncation.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) throw new Error("inspect_checkpoint 应有下一页");
        const second = await call(open, "inspect_checkpoint", {
          runId: wsFx.runId,
          limit: 20,
          cursor,
        });
        assertBudget(second, "inspect_checkpoint#2");
        const secondPaths = new Set(
          (envelopeOf(second).data as { files: Array<{ path: string }> }).files.map(
            (file) => file.path,
          ),
        );
        for (const file of data.files) expect(secondPaths.has(file.path)).toBe(false);
        expect(data.totals.remaining).toBeGreaterThan(0);
        called.add("inspect_checkpoint");
      }

      // 6) read_checkpoint_file：长正文按码点续读
      {
        const first = await call(open, "read_checkpoint_file", {
          runId: wsFx.runId,
          path: "huge.txt",
          maxChars: 1024,
        });
        assertBudget(first, "read_checkpoint_file");
        const env = envelopeOf(first);
        const data = env.data as {
          selector: { path: string; snapshotId: string };
          file: { status: string; range: { start: number; end: number; total: number } };
        };
        expect(data.selector.path).toBe("huge.txt");
        expect(data.selector.snapshotId).toMatch(/^[0-9a-f]{64}$/);
        expect(data.file.range.total).toBe(wsFx.hugeLeftChars);
        const cursor = env.truncation.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) throw new Error("read_checkpoint_file 应有续读游标");
        const second = await call(open, "read_checkpoint_file", {
          runId: wsFx.runId,
          path: "huge.txt",
          maxChars: 1024,
          cursor,
        });
        assertBudget(second, "read_checkpoint_file#2");
        const secondRange = (
          envelopeOf(second).data as { file: { range: { start: number; end: number } } }
        ).file.range;
        expect(secondRange.start).toBe(data.file.range.end);
        expect(secondRange.end).toBeGreaterThan(secondRange.start);
        called.add("read_checkpoint_file");
      }

      // 7) compare_checkpoint_files：清单模式跟一页
      {
        const first = await call(open, "compare_checkpoint_files", {
          left: { runId: wsFx.runId },
          right: { runId: wsFx.runId, stepSpanId: wsFx.stepSpanId },
          limit: 20,
        });
        assertBudget(first, "compare_checkpoint_files");
        const env = envelopeOf(first);
        const data = env.data as { mode: string; entries: Array<{ path: string }> };
        expect(data.mode).toBe("manifest");
        const cursor = env.truncation.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) throw new Error("compare_checkpoint_files 应有下一页");
        const second = await call(open, "compare_checkpoint_files", {
          left: { runId: wsFx.runId },
          right: { runId: wsFx.runId, stepSpanId: wsFx.stepSpanId },
          limit: 20,
          cursor,
        });
        assertBudget(second, "compare_checkpoint_files#2");
        const secondPaths = new Set(
          (envelopeOf(second).data as { entries: Array<{ path: string }> }).entries.map(
            (entry) => entry.path,
          ),
        );
        for (const entry of data.entries) expect(secondPaths.has(entry.path)).toBe(false);
        called.add("compare_checkpoint_files");
      }

      // 8) list_verifications
      {
        const result = await call(open, "list_verifications", { limit: 10 });
        assertBudget(result, "list_verifications");
        const data = envelopeOf(result).data as { items: unknown[] };
        expect(data.items.length).toBeGreaterThan(0);
        called.add("list_verifications");
      }

      // 9) get_verification
      {
        const result = await call(open, "get_verification", { verificationId: vIds.pass });
        assertBudget(result, "get_verification");
        const data = envelopeOf(result).data as { verificationId: string; status: string };
        expect(data.verificationId).toBe(vIds.pass);
        expect(data.status).toBe("sealed");
        called.add("get_verification");
      }

      // 10) read_verification_log：长日志按码点续读
      {
        const args = {
          verificationId: vIds.fail,
          commandId: "test",
          stream: "stdout",
          maxChars: 1024,
        };
        const first = await call(open, "read_verification_log", args);
        assertBudget(first, "read_verification_log");
        const env = envelopeOf(first);
        const range = (
          env.data as { body: { range: { start: number; end: number; total: number } } }
        ).body.range;
        const cursor = env.truncation.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) throw new Error("read_verification_log 应有续读游标");
        const second = await call(open, "read_verification_log", { ...args, cursor });
        assertBudget(second, "read_verification_log#2");
        const secondRange = (
          envelopeOf(second).data as { body: { range: { start: number; end: number } } }
        ).body.range;
        expect(secondRange.start).toBe(range.end);
        expect(secondRange.end).toBeGreaterThan(secondRange.start);
        called.add("read_verification_log");
      }

      // 11) inspect_verification_artifacts
      {
        const result = await call(open, "inspect_verification_artifacts", {
          verificationId: vIds.pass,
        });
        assertBudget(result, "inspect_verification_artifacts");
        expect(JSON.stringify(envelopeOf(result).data)).toContain(vIds.pass);
        called.add("inspect_verification_artifacts");
      }

      // 12) read_verification_artifact：文本正文与路径身份
      {
        const result = await call(open, "read_verification_artifact", {
          verificationId: vIds.pass,
          path: "report.json",
          maxChars: 1024,
        });
        assertBudget(result, "read_verification_artifact");
        const data = envelopeOf(result).data as {
          selector: { verificationId: string; path: string };
        };
        expect(data.selector).toMatchObject({
          verificationId: vIds.pass,
          path: "report.json",
        });
        called.add("read_verification_artifact");
      }

      // 13) compare_verifications
      {
        const result = await call(open, "compare_verifications", {
          left: { verificationId: vIds.fail },
          right: { verificationId: vIds.pass },
        });
        assertBudget(result, "compare_verifications");
        const serialized = JSON.stringify(envelopeOf(result).data);
        expect(serialized).toContain(vIds.fail);
        expect(serialized).toContain(vIds.pass);
        called.add("compare_verifications");
      }

      // 单项超限：受控 RESPONSE_LIMIT，码与 ref 稳定、说明本地化、结果仍有界
      {
        const result = await call(open, "get_run", { runId: pageFx.ids.oversized });
        assertBudget(result, "get_run:oversized");
        expect(result.isError).toBe(true);
        const error = (
          result.structuredContent as {
            error: { code: string; ref?: string; message: string };
          }
        ).error;
        expect(error.code).toBe("RESPONSE_LIMIT");
        expect(error.ref).toBe(`run:${pageFx.ids.oversized}`);
        expect(error.message).toBe(
          zh
            ? "单项结果无法容纳在响应预算内"
            : "A single result cannot fit within the response budget",
        );
      }

      await open.session.end();
      expect(called.size).toBe(13);
    }

    const reportPath = process.env.MCP_I18N_REPORT;
    if (reportPath !== undefined && reportPath !== "") {
      const maxBytes = Math.max(...measurements.map((item) => item.bytes));
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            realStdio: true,
            locales: [...LOCALES],
            budgetBytes: RESPONSE_BUDGET_BYTES,
            maxBytes,
            measurements,
          },
          null,
          2,
        )}
`,
        "utf8",
      );
    }
  }, 300_000);
});

describe("M26 重启换语言：旧游标失效，分页意义不变", () => {
  it("zh-CN 发出的正文游标在 en-US 新进程里 STALE_CURSOR；新进程首页范围/原文相同", async () => {
    const zhSession = await openSession("zh-CN");
    const args = { runId: wsFx.runId, path: "huge.txt", maxChars: 1024 };
    const zhFirst = await call(zhSession, "read_checkpoint_file", args);
    const zhEnv = envelopeOf(zhFirst);
    const zhRange = (zhEnv.data as { file: { range: { start: number; end: number } } }).file.range;
    const zhBody = contentBodyTexts(zhFirst)[0] ?? "";
    const cursor = zhEnv.truncation.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) throw new Error("应有续读游标");
    await zhSession.session.end();

    const enSession = await openSession("en-US");
    const stale = await call(enSession, "read_checkpoint_file", { ...args, cursor });
    expect(stale.isError).toBe(true);
    const error = (
      stale.structuredContent as { error: { code: string; message: string; ref?: string } }
    ).error;
    expect(error.code).toBe("STALE_CURSOR");
    expect(error.ref).toBe("cursor");
    expect(error.message).toBe(
      "The continuation cursor is stale; restart the query from the first page",
    );
    // 不混接旧正文：错误结果没有正文块
    expect(contentBodyTexts(stale)).toEqual([]);

    const enFresh = await call(enSession, "read_checkpoint_file", args);
    const enEnv = envelopeOf(enFresh);
    const enRange = (enEnv.data as { file: { range: { start: number; end: number } } }).file.range;
    expect(enRange).toEqual(zhRange);
    expect(contentBodyTexts(enFresh)[0]).toBe(zhBody);
    await enSession.session.end();
  }, 300_000);
});
