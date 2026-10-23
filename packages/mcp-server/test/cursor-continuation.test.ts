import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { canonicalJson } from "../src/query/canonical-json.js";
import type { CompareCheckpointFilesData } from "../src/query/compare-checkpoint-files.js";
import { compareCheckpointFilesTool } from "../src/query/compare-checkpoint-files.js";
import type { GetRunData } from "../src/query/get-run.js";
import { getRunTool } from "../src/query/get-run.js";
import type { GetStepData } from "../src/query/get-step.js";
import { getStepTool } from "../src/query/get-step.js";
import type { InspectCheckpointData } from "../src/query/inspect-checkpoint.js";
import { inspectCheckpointTool } from "../src/query/inspect-checkpoint.js";
import type { ListRunItem, ListRunsData } from "../src/query/list-runs.js";
import { listRunsTool } from "../src/query/list-runs.js";
import type { ReadCheckpointFileData } from "../src/query/read-checkpoint-file.js";
import { readCheckpointFileTool } from "../src/query/read-checkpoint-file.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  CURSOR_LONG_BODY,
  type CursorFixture,
  addNewRun,
  buildCursorFixture,
  cleanupCursorFixtures,
  rewriteRunTask,
} from "./cursor-fixtures.js";

/**
 * MCP0 5.2（S07/S08/S09/S10）：认证游标的续读、参数/来源绑定与失败项顺序。
 *
 * 每个用例一份新夹具（来源可变）：页/正文按游标推进，**无重漏**；参数变化或篡改给
 * INVALID_ARGUMENT，trace/附件变化给 STALE_CURSOR；新请求重新读盘（Q02）。
 * 预算截断的页用 `nextCursor` 推进，本文件不假设页宽等于实际条数。
 */

let fx: CursorFixture;
let root: DataRoot;

beforeEach(() => {
  fx = buildCursorFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterEach(() => {
  cleanupCursorFixtures();
});

function ok<T>(result: ToolResult): {
  data: T;
  envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
} {
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as T, envelope };
}

function failure(result: ToolResult): ReturnType<typeof ErrorEnvelopeSchema.parse>["error"] {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

function requireCursor(envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>): string {
  const cursor = envelope.truncation.nextCursor;
  if (cursor === undefined) throw new Error("本页应当有续读游标");
  expect(envelope.page?.nextCursor).toBe(cursor);
  return cursor;
}

function itemKey(item: ListRunItem): string {
  return item.kind === "run" ? `run:${item.runId}` : `file:${item.file}`;
}

function indexKey(item: GetRunData["index"]["items"][number]): string {
  return item.kind === "span" ? `span:${item.spanId}` : `checkpoint:${item.snapshotId}`;
}

const wsSelectors = () => ({
  left: { runId: fx.workspaceRunId },
  right: { runId: fx.workspaceRunId, stepSpanId: fx.workspaceStepSpanId },
});

describe("列表分页：无重漏、失败项只出现一次（S07）", () => {
  it("逐页推进后与完整列表逐项相同；最后不重复失败段", async () => {
    const full = ok<ListRunsData>(await listRunsTool.execute({ limit: 100 }, root));
    const expected = full.data.items.map(itemKey);
    expect(expected.length).toBeGreaterThan(9);

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = ok<ListRunsData>(
        await listRunsTool.execute({ limit: 3, ...(cursor === undefined ? {} : { cursor }) }, root),
      );
      collected.push(...page.data.items.map(itemKey));
      expect(page.data.totals.matchedRuns).toBe(full.data.totals.matchedRuns);
      pages += 1;
      cursor = page.envelope.truncation.nextCursor;
    } while (cursor !== undefined);

    expect(pages).toBeGreaterThan(3);
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(collected.length);
  });
});

describe("get_run 索引分页与正文续读（S07/S09）", () => {
  it("索引按游标推进后与完整索引逐项相同", async () => {
    const full = ok<GetRunData>(
      await getRunTool.execute({ runId: fx.spansRunId, limit: 100 }, root),
    );
    const expected = full.data.index.items.map(indexKey);

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = ok<GetRunData>(
        await getRunTool.execute(
          { runId: fx.spansRunId, limit: 2, ...(cursor === undefined ? {} : { cursor }) },
          root,
        ),
      );
      collected.push(...page.data.index.items.map(indexKey));
      cursor = page.envelope.truncation.nextCursor;
    } while (cursor !== undefined);
    expect(collected).toEqual(expected);
  });

  it("get_step 正文按码点续读：拼接等于完整规范 JSON，范围连续", async () => {
    const full = canonicalJson(CURSOR_LONG_BODY);
    const total = [...full].length;
    let collected = "";
    let expectedStart = 0;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = ok<GetStepData>(
        await getStepTool.execute(
          {
            runId: fx.bodyRunId,
            spanId: fx.bodySpanId,
            section: "output",
            maxChars: 100,
            ...(cursor === undefined ? {} : { cursor }),
          },
          root,
        ),
      );
      if (page.data.body === null || page.data.body.recorded !== true) {
        throw new Error("正文应当在场");
      }
      expect(page.data.body.range.start).toBe(expectedStart);
      expect(page.data.body.range.total).toBe(total);
      collected += page.data.body.text;
      expectedStart = page.data.body.range.end;
      pages += 1;
      cursor = page.envelope.truncation.nextCursor;
    } while (cursor !== undefined);

    expect(pages).toBeGreaterThan(5);
    expect(collected).toBe(full);
    expect(expectedStart).toBe(total);
  });

  it("read_checkpoint_file 正文按码点续读：拼接等于完整文件文本", async () => {
    const full = "甲".repeat(fx.longLeftChars);
    let collected = "";
    let expectedStart = 0;
    let cursor: string | undefined;
    do {
      const page = ok<ReadCheckpointFileData>(
        await readCheckpointFileTool.execute(
          {
            runId: fx.workspaceRunId,
            path: fx.longPath,
            maxChars: 100,
            ...(cursor === undefined ? {} : { cursor }),
          },
          root,
        ),
      );
      if (page.data.file.status !== "text") throw new Error("应当是文本");
      expect(page.data.file.range.start).toBe(expectedStart);
      expect(page.data.file.range.total).toBe(fx.longLeftChars);
      collected += page.data.file.text;
      expectedStart = page.data.file.range.end;
      cursor = page.envelope.truncation.nextCursor;
    } while (cursor !== undefined);
    expect(collected).toBe(full);
    expect(expectedStart).toBe(fx.longLeftChars);
  });
});

describe("检查点清单与比较正文续读（S07/S10）", () => {
  it("inspect_checkpoint 清单逐页推进后与完整清单相同", async () => {
    const full = ok<InspectCheckpointData>(
      await inspectCheckpointTool.execute({ runId: fx.workspaceRunId, limit: 100 }, root),
    );
    const expected = full.data.files.map((file) => file.path);
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = ok<InspectCheckpointData>(
        await inspectCheckpointTool.execute(
          {
            runId: fx.workspaceRunId,
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          },
          root,
        ),
      );
      collected.push(...page.data.files.map((file) => file.path));
      cursor = page.envelope.truncation.nextCursor;
    } while (cursor !== undefined);
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(expected.length);
  });

  it("compare_checkpoint_files 清单逐页推进后覆盖完整并集", async () => {
    const full = ok<CompareCheckpointFilesData>(
      await compareCheckpointFilesTool.execute({ ...wsSelectors(), limit: 100 }, root),
    );
    if (full.data.mode !== "manifest") throw new Error("应是清单模式");
    const expected = full.data.entries.map((entry) => entry.path);
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = ok<CompareCheckpointFilesData>(
        await compareCheckpointFilesTool.execute(
          {
            ...wsSelectors(),
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          },
          root,
        ),
      );
      if (page.data.mode !== "manifest") throw new Error("应是清单模式");
      collected.push(...page.data.entries.map((entry) => entry.path));
      cursor = page.envelope.truncation.nextCursor;
    } while (cursor !== undefined);
    expect(collected).toEqual(expected);
  });

  it("内容比较两侧独立续读：短侧结束不补，长侧继续到全量", async () => {
    const leftExpected = "甲".repeat(fx.longLeftChars);
    const rightExpected = "乙".repeat(fx.longRightChars);
    let leftText = "";
    let rightText = "";
    let leftStart = 0;
    let rightStart = 0;
    let cursor: string | undefined;
    let sawLeftEndedFirst = false;
    do {
      const page = ok<CompareCheckpointFilesData>(
        await compareCheckpointFilesTool.execute(
          {
            ...wsSelectors(),
            path: fx.longPath,
            maxChars: 100,
            ...(cursor === undefined ? {} : { cursor }),
          },
          root,
        ),
      );
      if (page.data.mode !== "content") throw new Error("应是内容模式");
      expect(page.data.conclusion).toBe("different");
      if (page.data.files.left.status !== "text" || page.data.files.right.status !== "text") {
        throw new Error("两侧都应是文本");
      }
      const left = page.data.files.left;
      const right = page.data.files.right;
      expect(left.range.start).toBe(leftStart);
      expect(right.range.start).toBe(rightStart);
      if (left.range.end === left.range.total && right.range.end < right.range.total) {
        sawLeftEndedFirst = true;
      }
      leftText += left.text;
      rightText += right.text;
      leftStart = left.range.end;
      rightStart = right.range.end;
      cursor = page.envelope.truncation.nextCursor;
    } while (cursor !== undefined);

    expect(sawLeftEndedFirst).toBe(true);
    expect(leftText).toBe(leftExpected);
    expect(rightText).toBe(rightExpected);
    expect(leftStart).toBe(fx.longLeftChars);
    expect(rightStart).toBe(fx.longRightChars);
  });
});

describe("游标篡改与参数变化（S08）", () => {
  it("篡改 / 参数变化 / 换工具都判 INVALID_ARGUMENT，且不回显游标", async () => {
    const page = ok<ListRunsData>(await listRunsTool.execute({ limit: 2 }, root));
    const cursor = requireCursor(page.envelope);

    const [tag, keyId, payload, mac] = cursor.split(".");
    if (tag === undefined || keyId === undefined || payload === undefined || mac === undefined) {
      throw new Error("游标结构异常");
    }
    const payloadJson = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    // 改成**合法**位置 0：若 MAC 被跳过，会成功重放首页，而不是靠越界碰巧被拒
    payloadJson.o = [0];
    const tamperedPayload = Buffer.from(JSON.stringify(payloadJson), "utf8").toString("base64url");
    const tampered = [tag, keyId, tamperedPayload, mac].join(".");

    const tamperedError = failure(await listRunsTool.execute({ limit: 2, cursor: tampered }, root));
    expect(tamperedError.code).toBe("INVALID_ARGUMENT");
    expect(tamperedError.ref).toBe("cursor");
    expect(JSON.stringify(tamperedError)).not.toContain(tampered);

    const changedParam = failure(await listRunsTool.execute({ limit: 3, cursor }, root));
    expect(changedParam.code).toBe("INVALID_ARGUMENT");
    expect(changedParam.ref).toBe("cursor");

    const wrongTool = failure(await getRunTool.execute({ runId: fx.bodyRunId, cursor }, root));
    expect(wrongTool.code).toBe("INVALID_ARGUMENT");
    expect(wrongTool.ref).toBe("cursor");

    // 正文续读的 maxChars 也必须与签发时一致
    const bodyPage = ok<GetStepData>(
      await getStepTool.execute(
        { runId: fx.bodyRunId, spanId: fx.bodySpanId, section: "output", maxChars: 50 },
        root,
      ),
    );
    const bodyCursor = requireCursor(bodyPage.envelope);
    const changedChars = failure(
      await getStepTool.execute(
        {
          runId: fx.bodyRunId,
          spanId: fx.bodySpanId,
          section: "output",
          maxChars: 60,
          cursor: bodyCursor,
        },
        root,
      ),
    );
    expect(changedChars.code).toBe("INVALID_ARGUMENT");
    expect(changedChars.ref).toBe("cursor");
  });
});

describe("来源变化：STALE_CURSOR，不拼接新旧结果（S08）", () => {
  it("列表翻页前新增 run 文件 ⇒ 旧游标过期", async () => {
    const first = ok<ListRunsData>(await listRunsTool.execute({ limit: 2 }, root));
    const cursor = requireCursor(first.envelope);
    addNewRun(fx.tracesDir, "mcp0-cur-new");

    const error = failure(await listRunsTool.execute({ limit: 2, cursor }, root));
    expect(error.code).toBe("STALE_CURSOR");
    expect(error.ref).toBe("cursor");
    expect(error.message).toBe("续读游标已过期，请从首页重新查询");
    expect(JSON.stringify(error)).not.toContain("mcp0-cur-new");
  });

  it("get_run 索引翻页前改写 trace ⇒ 旧游标过期", async () => {
    const first = ok<GetRunData>(
      await getRunTool.execute({ runId: fx.spansRunId, limit: 2 }, root),
    );
    const cursor = requireCursor(first.envelope);
    rewriteRunTask(join(fx.tracesDir, `${fx.spansRunId}.jsonl`), "改写后的 task");

    const error = failure(
      await getRunTool.execute({ runId: fx.spansRunId, limit: 2, cursor }, root),
    );
    expect(error.code).toBe("STALE_CURSOR");
  });

  it("get_step 正文翻页前改写 trace ⇒ 旧游标过期", async () => {
    const first = ok<GetStepData>(
      await getStepTool.execute(
        { runId: fx.bodyRunId, spanId: fx.bodySpanId, section: "output", maxChars: 50 },
        root,
      ),
    );
    const cursor = requireCursor(first.envelope);
    rewriteRunTask(join(fx.tracesDir, `${fx.bodyRunId}.jsonl`), "改写后的正文 task");

    const error = failure(
      await getStepTool.execute(
        {
          runId: fx.bodyRunId,
          spanId: fx.bodySpanId,
          section: "output",
          maxChars: 50,
          cursor,
        },
        root,
      ),
    );
    expect(error.code).toBe("STALE_CURSOR");
  });

  it("inspect_checkpoint 翻页前附件被改写 ⇒ 旧游标过期", async () => {
    const first = ok<InspectCheckpointData>(
      await inspectCheckpointTool.execute({ runId: fx.workspaceRunId, limit: 2 }, root),
    );
    const cursor = requireCursor(first.envelope);
    writeFileSync(join(fx.blobsDir, fx.longLeftSha), Buffer.from("附件已被改写"));

    const error = failure(
      await inspectCheckpointTool.execute({ runId: fx.workspaceRunId, limit: 2, cursor }, root),
    );
    expect(error.code).toBe("STALE_CURSOR");
  });

  it("read_checkpoint_file 翻页前附件被改写 ⇒ 旧游标过期", async () => {
    const first = ok<ReadCheckpointFileData>(
      await readCheckpointFileTool.execute(
        { runId: fx.workspaceRunId, path: fx.longPath, maxChars: 50 },
        root,
      ),
    );
    const cursor = requireCursor(first.envelope);
    writeFileSync(join(fx.blobsDir, fx.longLeftSha), Buffer.from("附件已被改写"));

    const error = failure(
      await readCheckpointFileTool.execute(
        { runId: fx.workspaceRunId, path: fx.longPath, maxChars: 50, cursor },
        root,
      ),
    );
    expect(error.code).toBe("STALE_CURSOR");
  });

  it("compare 清单翻页前附件被改写 ⇒ 旧游标过期", async () => {
    const first = ok<CompareCheckpointFilesData>(
      await compareCheckpointFilesTool.execute({ ...wsSelectors(), limit: 2 }, root),
    );
    const cursor = requireCursor(first.envelope);
    const [hash] = fx.attachmentHashes;
    if (hash === undefined) throw new Error("夹具缺少附件哈希");
    writeFileSync(join(fx.blobsDir, hash), Buffer.from("changed"));

    const error = failure(
      await compareCheckpointFilesTool.execute({ ...wsSelectors(), limit: 2, cursor }, root),
    );
    expect(error.code).toBe("STALE_CURSOR");
  });

  it("compare 内容翻页前附件被改写 ⇒ 旧游标过期", async () => {
    const first = ok<CompareCheckpointFilesData>(
      await compareCheckpointFilesTool.execute(
        { ...wsSelectors(), path: fx.longPath, maxChars: 50 },
        root,
      ),
    );
    const cursor = requireCursor(first.envelope);
    writeFileSync(join(fx.blobsDir, fx.longLeftSha), Buffer.from("附件已被改写"));

    const error = failure(
      await compareCheckpointFilesTool.execute(
        { ...wsSelectors(), path: fx.longPath, maxChars: 50, cursor },
        root,
      ),
    );
    expect(error.code).toBe("STALE_CURSOR");
  });
});

describe("新请求重新读盘（Q02）", () => {
  it("新增 run 后首页重新扫描可见，不复用上一请求的列表", async () => {
    const before = ok<ListRunsData>(await listRunsTool.execute({ limit: 100 }, root));
    addNewRun(fx.tracesDir, "mcp0-cur-fresh");
    const after = ok<ListRunsData>(await listRunsTool.execute({ limit: 100 }, root));
    expect(after.data.totals.matchedRuns).toBe(before.data.totals.matchedRuns + 1);
    expect(after.data.items.map(itemKey)).toContain("run:mcp0-cur-fresh");
  });

  it("改写 run 后 get_run 重新读盘，返回新 task", async () => {
    const before = ok<GetRunData>(await getRunTool.execute({ runId: fx.bodyRunId }, root));
    expect(before.data.run.task).toBe("长正文夹具");
    rewriteRunTask(join(fx.tracesDir, `${fx.bodyRunId}.jsonl`), "新的 task 文本");
    const after = ok<GetRunData>(await getRunTool.execute({ runId: fx.bodyRunId }, root));
    expect(after.data.run.task).toBe("新的 task 文本");
    expect(after.envelope.readVersion).not.toBe(before.envelope.readVersion);
  });
});
