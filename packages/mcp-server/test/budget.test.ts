import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fitWithinBudget, toolResultBytes } from "../src/budget.js";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { RESPONSE_BUDGET_BYTES } from "../src/limits.js";
import { canonicalJson } from "../src/query/canonical-json.js";
import type { CompareCheckpointFilesData } from "../src/query/compare-checkpoint-files.js";
import { compareCheckpointFilesTool } from "../src/query/compare-checkpoint-files.js";
import type { CompareRunsData } from "../src/query/compare-runs.js";
import { compareRunsTool } from "../src/query/compare-runs.js";
import type { GetRunData } from "../src/query/get-run.js";
import { getRunTool } from "../src/query/get-run.js";
import type { GetStepData } from "../src/query/get-step.js";
import { getStepTool } from "../src/query/get-step.js";
import type { InspectCheckpointData } from "../src/query/inspect-checkpoint.js";
import { inspectCheckpointTool } from "../src/query/inspect-checkpoint.js";
import type { ListRunsData } from "../src/query/list-runs.js";
import { listRunsTool } from "../src/query/list-runs.js";
import type { ReadCheckpointFileData } from "../src/query/read-checkpoint-file.js";
import { readCheckpointFileTool } from "../src/query/read-checkpoint-file.js";
import type { ToolDefinition, ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import type { ToolPayload } from "../src/tool-definition.js";
import {
  type BudgetChainFixture,
  type BudgetPageFixture,
  type BudgetWorkspaceFixture,
  CHAIN_BODY_EMOJI,
  MANY_SPANS,
  OVERSIZE_TASK_CHARS,
  PAGE_TASK_CHARS,
  buildBudgetChainFixture,
  buildBudgetPageFixture,
  buildBudgetWorkspaceFixture,
  cleanupBudgetFixtures,
} from "./budget-fixtures.js";
import { contentBodyTexts } from "./content-bodies.js";
import { ZH, errorMessageOf } from "./test-locale.js";

/**
 * MCP0 5.1（S07/S09/S10）：完整 tool result 的 64 KiB 预算。
 *
 * 判据三条：
 * - **量完整结果**：`content + structuredContent + isError` 的 UTF-8 JSON，不只看 data；
 * - **预算不足提前结束页/正文**：条数或码点按二分收窄，`truncated`/`remaining`/`range`
 *   随实际外发量重算，顺序不重不漏（页是前缀）；
 * - **单项装不下就 RESPONSE_LIMIT**：不删身份、不截断任务正文冒充完整。
 *
 * 5.1 负责预算收窄；5.2 起预算截断页/正文会签发认证游标（本文件只断言截断边界与
 * `nextCursor` 在场，续读成功/来源变化由 cursor 测试覆盖）。
 */

let pageFx: BudgetPageFixture;
let wsFx: BudgetWorkspaceFixture;
let chainFx: BudgetChainFixture;
let pageRoot: DataRoot;
let wsRoot: DataRoot;
let chainRoot: DataRoot;

beforeAll(() => {
  pageFx = buildBudgetPageFixture();
  wsFx = buildBudgetWorkspaceFixture();
  chainFx = buildBudgetChainFixture();
  pageRoot = { dataDir: pageFx.dataDir, tracesDir: pageFx.tracesDir };
  wsRoot = { dataDir: wsFx.dataDir, tracesDir: wsFx.tracesDir };
  chainRoot = { dataDir: chainFx.dataDir, tracesDir: chainFx.tracesDir };
}, 300_000);

afterAll(() => {
  cleanupBudgetFixtures();
});

/** 测试侧独立量完整结果（**不复用实现里的 toolResultBytes**，否则同错同绿） */
function completeResultBytes(result: ToolResult): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    }),
    "utf8",
  );
}

function assertBudget(result: ToolResult): void {
  expect(completeResultBytes(result)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
}

function okData<T>(result: ToolResult): {
  data: T;
  envelope: ReturnType<typeof SuccessEnvelopeSchema.parse>;
} {
  expect(result.isError).not.toBe(true);
  const envelope = SuccessEnvelopeSchema.parse(result.structuredContent);
  return { data: envelope.data as T, envelope };
}

function failureOf(result: ToolResult): ReturnType<typeof ErrorEnvelopeSchema.parse>["error"] {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent).error;
}

function hasLoneSurrogate(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

describe("预算搜索：完整结果字节与单旋钮二分", () => {
  function textPayload(text: string): ToolPayload {
    return {
      readVersion: "rv:budget-unit",
      data: { text },
      runs: [],
      headline: "预算单元",
    };
  }

  it("测量包含 content 与 structuredContent；未超预算原样返回", () => {
    const payload = textPayload("short");
    const toResult = (candidate: ToolPayload): ToolResult => ({
      content: [{ type: "text", text: candidate.headline }],
      structuredContent: { data: candidate.data },
    });
    const fitted = fitWithinBudget(payload, toResult, "tool:unit");
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(completeResultBytes(fitted.result)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect((fitted.result.structuredContent as { data: { text: string } }).data.text).toBe("short");

    // 实现侧的量法与测试侧独立量法一致；content 里的长文案也算进去
    const probe: ToolResult = {
      content: [{ type: "text", text: "HEAD".repeat(1_000) }],
      structuredContent: { data: { text: "short" } },
    };
    expect(toolResultBytes(probe)).toBe(completeResultBytes(probe));
    expect(toolResultBytes(probe)).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify({ data: { text: "short" } }), "utf8"),
    );
  });

  it("超预算时按 chars 二分收窄，结果为前缀且满足预算", () => {
    const full = "甲".repeat(90_000);
    const build = (chars: number): ToolPayload => textPayload([...full].slice(0, chars).join(""));
    const initial = { ...build(full.length), budget: undefined };
    const payload: ToolPayload = {
      ...initial,
      budget: {
        kind: "chars",
        value: [...full].length,
        minimum: 0,
        fit: (chars) => build(Math.min(chars, [...full].length)),
        limitRef: "span:unit",
      },
    };
    const toResult = (candidate: ToolPayload): ToolResult => ({
      content: [{ type: "text", text: candidate.headline }],
      structuredContent: { data: candidate.data },
    });
    const fitted = fitWithinBudget(payload, toResult, "tool:unit");
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    assertBudget(fitted.result);
    const text = (fitted.result.structuredContent as { data: { text: string } }).data.text;
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan([...full].length);
    expect(full.startsWith(text)).toBe(true);
  });

  it("返回满足预算的最大规模，而不是最小可行", () => {
    const full = "甲".repeat(40_000);
    const build = (chars: number): ToolPayload => textPayload([...full].slice(0, chars).join(""));
    const toResult = (candidate: ToolPayload): ToolResult => ({
      content: [{ type: "text", text: candidate.headline }],
      structuredContent: { data: candidate.data },
    });
    const payload: ToolPayload = {
      ...build([...full].length),
      budget: {
        kind: "chars",
        value: [...full].length,
        minimum: 0,
        fit: (chars) => build(Math.min(chars, [...full].length)),
        limitRef: "span:unit",
      },
    };
    // 测试侧独立二分：满足预算的最大码点数
    let low = 0;
    let high = [...full].length;
    let expected = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (completeResultBytes(toResult(build(mid))) <= RESPONSE_BUDGET_BYTES) {
        expected = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const fitted = fitWithinBudget(payload, toResult, "tool:unit");
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    const text = (fitted.result.structuredContent as { data: { text: string } }).data.text;
    expect(text.length).toBe(expected);
    expect(text.length).toBeGreaterThan(0);
  });

  it("最小规模仍装不下 ⇒ RESPONSE_LIMIT 定位（不删身份）", () => {
    const payload: ToolPayload = {
      readVersion: "rv:budget-unit",
      data: { text: "甲".repeat(90_000) },
      runs: [],
      headline: "预算单元",
      budget: {
        kind: "chars",
        value: 1,
        minimum: 0,
        fit: () => payload,
        limitRef: "run:mcp0-too-big",
      },
    };
    const toResult = (candidate: ToolPayload): ToolResult => ({
      content: [{ type: "text", text: candidate.headline }],
      structuredContent: { data: candidate.data },
    });
    expect(fitWithinBudget(payload, toResult, "tool:unit")).toEqual({
      ok: false,
      ref: "run:mcp0-too-big",
    });
  });
});

describe("list_runs：长 task 页按预算收窄（S07/S09）", () => {
  it("默认页宽装不下时提前结束页，remaining/truncated 按实际外发量重算", async () => {
    const result = await listRunsTool.execute({ limit: 20 }, pageRoot, ZH);
    assertBudget(result);
    const { data, envelope } = okData<ListRunsData>(result);
    const totalRuns = pageFx.ids.pages.length + 2;
    expect(data.totals.matchedRuns).toBe(totalRuns);
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.length).toBeLessThan(totalRuns);
    expect(data.items.length).toBeLessThan(20);
    expect(data.totals.listed).toBe(data.items.length);
    expect(data.totals.remaining).toBe(totalRuns - data.items.length);
    expect(data.totals.limit).toBe(20);
    expect(envelope.truncation.truncated).toBe(true);
    // 5.2 起预算截断页签发认证游标；5.1 的「nextCursor 缺席」判据在此合法改判
    expect(envelope.truncation.nextCursor).toBeDefined();
    expect(envelope.page?.nextCursor).toBe(envelope.truncation.nextCursor);
    // 页是固定序列的前缀：每条 task 都是长任务，且顺序仍按 created_at 倒序
    for (const item of data.items) {
      if (item.kind !== "run") throw new Error("本夹具不应有失败项");
      expect(item.task.length).toBeGreaterThan(PAGE_TASK_CHARS);
    }
  });

  it("单项 task 超过预算 ⇒ RESPONSE_LIMIT，不删身份/不截断正文冒充完整", async () => {
    const result = await listRunsTool.execute({ query: "OVERSIZE-MARKER" }, pageRoot, ZH);
    const error = failureOf(result);
    expect(error.code).toBe("RESPONSE_LIMIT");
    expect(error.ref).toBe(`run:${pageFx.ids.oversized}`);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(errorMessageOf("RESPONSE_LIMIT"));
    expect(JSON.stringify(error)).not.toContain("\u5DE8".repeat(100));
  });
});

describe("get_run：index 页预算与单项超限", () => {
  it("60 个长工具名 span 的 index 提前结束页，总数仍报全量", async () => {
    const result = await getRunTool.execute(
      { runId: pageFx.ids.manySpans, limit: 100 },
      pageRoot,
      ZH,
    );
    assertBudget(result);
    const { data, envelope } = okData<GetRunData>(result);
    const spans = MANY_SPANS + 1;
    expect(data.index.totals.spans).toBe(spans);
    expect(data.index.totals.listed).toBe(data.index.items.length);
    expect(data.index.items.length).toBeLessThan(spans);
    expect(data.index.totals.remaining).toBe(spans - data.index.items.length);
    expect(data.index.totals.limit).toBe(100);
    expect(envelope.truncation.truncated).toBe(true);
    expect(envelope.truncation.nextCursor).toBeDefined();
  });

  it("单项摘要超预算 ⇒ RESPONSE_LIMIT", async () => {
    const result = await getRunTool.execute({ runId: pageFx.ids.oversized }, pageRoot, ZH);
    const error = failureOf(result);
    expect(error.code).toBe("RESPONSE_LIMIT");
    expect(error.ref).toBe(`run:${pageFx.ids.oversized}`);
    expect(JSON.stringify(error)).not.toContain("\u5DE8".repeat(100));
  });

  it("没有可缩旋钮的 compare_runs 在超预算时也只回 RESPONSE_LIMIT", async () => {
    const result = await compareRunsTool.execute(
      { left: { runId: pageFx.ids.oversized }, right: { runId: pageFx.ids.pages[0] } },
      pageRoot,
      ZH,
    );
    const error = failureOf(result);
    expect(error.code).toBe("RESPONSE_LIMIT");
    expect(error.ref).toBe("tool:compare_runs");
    expect(JSON.stringify(error)).not.toContain("\u5DE8".repeat(100));
  });

  it("未超预算的 compare_runs 仍正常给两侧事实（预算不是收紧所有输出）", async () => {
    const result = await compareRunsTool.execute(
      { left: { runId: pageFx.ids.pages[0] }, right: { runId: pageFx.ids.pages[1] } },
      pageRoot,
      ZH,
    );
    assertBudget(result);
    const { data } = okData<CompareRunsData>(result);
    expect(data.sides[0]?.status).toBe("ready");
    expect(data.sides[1]?.status).toBe("ready");
  });
});

describe("inspect/compare 清单：100 条长路径页按预算收窄（S07/S09）", () => {
  it("inspect_checkpoint 的 files 页提前结束，files 总数不受影响", async () => {
    const result = await inspectCheckpointTool.execute(
      { runId: wsFx.runId, limit: 100 },
      wsRoot,
      ZH,
    );
    assertBudget(result);
    const { data, envelope } = okData<InspectCheckpointData>(result);
    const total = wsFx.initialFileCount;
    expect(data.checkpoint.fileCount).toBe(total);
    expect(data.totals.files).toBe(total);
    expect(data.totals.listed).toBe(data.files.length);
    expect(data.files.length).toBeLessThan(100);
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.totals.remaining).toBe(total - data.files.length);
    expect(data.totals.limit).toBe(100);
    expect(envelope.truncation.truncated).toBe(true);
  });

  it("compare_checkpoint_files 清单页提前结束，并集总数与顺序仍如实", async () => {
    const result = await compareCheckpointFilesTool.execute(
      {
        left: { runId: wsFx.runId },
        right: { runId: wsFx.runId, stepSpanId: wsFx.stepSpanId },
        limit: 100,
      },
      wsRoot,
      ZH,
    );
    assertBudget(result);
    const { data } = okData<CompareCheckpointFilesData>(result);
    expect(data.mode).toBe("manifest");
    if (data.mode !== "manifest") return;
    const total = wsFx.initialFileCount;
    expect(data.totals.paths).toBe(total);
    expect(data.totals.listed).toBe(data.entries.length);
    expect(data.entries.length).toBeLessThan(100);
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.totals.remaining).toBe(total - data.entries.length);
    expect(data.totals.limit).toBe(100);
  });
});

describe("文件正文：码点范围与两侧独立预算（S09/S10）", () => {
  it("单文件长正文按码点切：total 是全量、range 是外发片段、预算不越界", async () => {
    const result = await readCheckpointFileTool.execute(
      { runId: wsFx.runId, path: "huge.txt", maxChars: 8192 },
      wsRoot,
      ZH,
    );
    assertBudget(result);
    const { data } = okData<ReadCheckpointFileData>(result);
    expect(data.file.status).toBe("text");
    if (data.file.status !== "text") return;
    expect(data.file.range.total).toBe(wsFx.hugeLeftChars);
    expect(data.file.range.end).toBe(8192);
    expect(data.file.remaining).toBe(wsFx.hugeLeftChars - 8192);
    expect(data.file.truncated).toBe(true);
    expect(data.file.fullFile.bytes).toBe(wsFx.hugeLeftChars);
    expect(contentBodyTexts(result)[0]?.length).toBe(8192);
  });

  it("两侧都是大正文：预算收窄两侧码点上限，结论仍取完整附件核验", async () => {
    const result = await compareCheckpointFilesTool.execute(
      {
        left: { runId: wsFx.runId },
        right: { runId: wsFx.runId, stepSpanId: wsFx.stepSpanId },
        path: "huge.txt",
        maxChars: 8192,
      },
      wsRoot,
      ZH,
    );
    assertBudget(result);
    const { data } = okData<CompareCheckpointFilesData>(result);
    expect(data.mode).toBe("content");
    if (data.mode !== "content") return;
    expect(data.conclusion).toBe("different");
    expect(data.textDiffEligible).toBe(true);
    expect(data.files.left.status).toBe("text");
    expect(data.files.right.status).toBe("text");
    if (data.files.left.status !== "text" || data.files.right.status !== "text") return;
    expect(data.files.left.range.total).toBe(wsFx.hugeLeftChars);
    expect(data.files.right.range.total).toBe(wsFx.hugeRightChars);
    expect(data.files.left.range.end).toBeLessThan(8192);
    expect(data.files.right.range.end).toBeLessThan(8192);
    expect(data.files.left.truncated).toBe(true);
    expect(data.files.right.truncated).toBe(true);
    expect(data.files.left.remaining).toBe(wsFx.hugeLeftChars - data.files.left.range.end);
    expect(data.files.right.remaining).toBe(wsFx.hugeRightChars - data.files.right.range.end);
    expect(data.files.left.fullFile.bytes).toBe(wsFx.hugeLeftChars);
    expect(data.files.right.fullFile.bytes).toBe(wsFx.hugeRightChars);
    const texts = contentBodyTexts(result);
    expect(texts[0]?.length).toBe(data.files.left.range.end);
    expect(texts[1]?.length).toBe(data.files.right.range.end);
  });

  it("两侧长度不同：短的一侧自然结束，不为长的一侧补空/补字符", async () => {
    const result = await compareCheckpointFilesTool.execute(
      {
        left: { runId: wsFx.runId },
        right: { runId: wsFx.runId, stepSpanId: wsFx.stepSpanId },
        path: "short.txt",
        maxChars: 8192,
      },
      wsRoot,
      ZH,
    );
    assertBudget(result);
    const { data } = okData<CompareCheckpointFilesData>(result);
    if (data.mode !== "content") throw new Error("应是内容模式");
    expect(data.conclusion).toBe("different");
    if (data.files.left.status !== "text" || data.files.right.status !== "text") {
      throw new Error("两侧都应是 text");
    }
    expect(data.files.left.range.total).toBe(wsFx.shortLeftChars);
    expect(data.files.left.range.end).toBe(wsFx.shortLeftChars);
    expect(data.files.left.truncated).toBe(false);
    expect(data.files.left.remaining).toBe(0);
    expect(contentBodyTexts(result)[0]?.length).toBe(wsFx.shortLeftChars);
    expect(data.files.right.range.total).toBe(wsFx.shortRightChars);
    expect(data.files.right.range.end).toBeGreaterThan(0);
    expect(data.files.right.range.end).toBeLessThan(wsFx.shortRightChars);
    expect(data.files.right.truncated).toBe(true);
    expect(data.files.right.remaining).toBe(wsFx.shortRightChars - data.files.right.range.end);
  });
});

describe("get_step：长来源链挤占预算时正文按码点收窄（S09）", () => {
  it("8,192 个 emoji + 161 跳来源 ⇒ 正文提前结束，range/remaining 与前缀准确", async () => {
    const result = await getStepTool.execute(
      {
        runId: chainFx.leafRunId,
        spanId: chainFx.leafToolSpanId,
        section: "output",
        maxChars: 8192,
      },
      chainRoot,
      ZH,
    );
    assertBudget(result);
    const { data, envelope } = okData<GetStepData>(result);
    expect(data.body?.recorded).toBe(true);
    if (data.body === null || data.body.recorded !== true) return;
    const full = canonicalJson("🙂".repeat(CHAIN_BODY_EMOJI));
    const total = [...full].length;
    expect(data.body.range.total).toBe(total);
    expect(data.body.range.end).toBeGreaterThan(0);
    expect(data.body.range.end).toBeLessThan(8192);
    expect(data.body.truncated).toBe(true);
    expect(data.body.remaining).toBe(total - data.body.range.end);
    const bodyText = contentBodyTexts(result)[0] ?? "";
    expect(bodyText).toBe([...full].slice(0, data.body.range.end).join(""));
    expect(hasLoneSurrogate(bodyText)).toBe(false);
    expect(envelope.provenance.runs).toHaveLength(chainFx.chainLength);
    expect(envelope.truncation.truncated).toBe(true);
    expect(envelope.truncation.nextCursor).toBeDefined();
  });

  it("预算收窄后的正文可用游标续读到完整文本（S09）", async () => {
    const full = canonicalJson("🙂".repeat(CHAIN_BODY_EMOJI));
    let collected = "";
    let expectedStart = 0;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await getStepTool.execute(
        {
          runId: chainFx.leafRunId,
          spanId: chainFx.leafToolSpanId,
          section: "output",
          maxChars: 8192,
          ...(cursor === undefined ? {} : { cursor }),
        },
        chainRoot,
        ZH,
      );
      assertBudget(result);
      const { data, envelope } = okData<GetStepData>(result);
      if (data.body === null || data.body.recorded !== true) throw new Error("正文应当在场");
      expect(data.body.range.start).toBe(expectedStart);
      collected += contentBodyTexts(result)[0] ?? "";
      expectedStart = data.body.range.end;
      pages += 1;
      cursor = envelope.truncation.nextCursor;
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(expectedStart).toBe([...full].length);
    expect(collected).toBe(full);
  });
});

describe("夹具自检：超限靶子确实超过 64 KiB（不是空跑）", () => {
  it("单条超限 task 与长链都显著大于预算", () => {
    expect(Buffer.byteLength("\u5DE8".repeat(OVERSIZE_TASK_CHARS), "utf8")).toBeGreaterThan(
      RESPONSE_BUDGET_BYTES,
    );
    expect(chainFx.chainLength).toBe(161);
    expect(chainFx.bodyCodePoints).toBe(8_192);
  });
});
