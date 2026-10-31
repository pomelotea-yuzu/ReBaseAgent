import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContentText } from "../src/content-text.js";
import { SuccessEnvelopeSchema } from "../src/envelope.js";
import { compareCheckpointFilesTool } from "../src/query/compare-checkpoint-files.js";
import { getStepTool } from "../src/query/get-step.js";
import { readCheckpointFileTool } from "../src/query/read-checkpoint-file.js";
import type { ToolResult } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import {
  type CheckpointFixture,
  FILE_TEXTS,
  buildCheckpointFixture,
  cleanupCheckpointFixtures,
} from "./checkpoint-fixtures.js";
import {
  CF_TEXTS,
  type CompareFixture,
  buildCompareFixture,
  cleanupCompareFixtures,
} from "./compare-file-fixtures.js";
import { contentBodyTexts, contentText } from "./content-bodies.js";
import {
  type QueryFixture,
  SENTINELS,
  buildQueryFixture,
  cleanupQueryFixtures,
} from "./query-fixtures.js";
import { ZH } from "./test-locale.js";

/**
 * MCP0 6.2（投影修订，owner 2026-10-23 定稿）的正面判据：
 * **content 承载 headline + data 紧凑投影，且「正文只承载一次」**。
 *
 * 起因是第一轮真实客户端实跑（WorkBuddy 5.9.0 / Step-5-Preview）：12 次工具调用
 * 只拿到一行 headline——该客户端不把 `structuredContent` 交给模型，S15 的
 * 「引用可回查」在真实链路上落空（`.workbuddy/memory/MCP0.md` 契约口径第 13 条）。
 *
 * 本文件钉三件事（夹具只读复用 4.3/4.6/4.7 的既有目录，不新增内容 ⇒ 历史批次字面数不漂）：
 * - **正文只承载一次**：structuredContent 序列化后不含正文本体（canary 逐字缺席），
 *   data 内对应位是 `bodyIn:"content"` 指针；
 * - **content 投影自足**：小事实（标识/哈希/结论/range 数字）能从 content 文本逐个读回
 *   ——这是「真实客户端模型能引用」的包层等价判据；
 * - **渲染器纪律**：超长自由文本叶子截断并标注总量（全文仍在 structuredContent）、
 *   正文位不截、同输入同输出。
 */

let qfx: QueryFixture;
let qRoot: DataRoot;
let cfx: CheckpointFixture;
let cRoot: DataRoot;
let cmpFx: CompareFixture;
let cmpRoot: DataRoot;

beforeAll(() => {
  qfx = buildQueryFixture();
  qRoot = { dataDir: qfx.dataDir, tracesDir: qfx.tracesDir };
  cfx = buildCheckpointFixture();
  cRoot = { dataDir: cfx.dataDir, tracesDir: cfx.tracesDir };
  cmpFx = buildCompareFixture();
  cmpRoot = { dataDir: cmpFx.dataDir, tracesDir: cmpFx.tracesDir };
}, 180_000);

afterAll(() => {
  cleanupQueryFixtures();
  cleanupCheckpointFixtures();
  cleanupCompareFixtures();
});

function okEnvelope(result: ToolResult): ReturnType<typeof SuccessEnvelopeSchema.parse> {
  expect(result.isError).not.toBe(true);
  return SuccessEnvelopeSchema.parse(result.structuredContent);
}

describe("正文只承载一次（三个正文位工具）", () => {
  it("get_step：正文本体只在 content；structuredContent 里是指针且 canary 逐字缺席", async () => {
    const result = await getStepTool.execute(
      { runId: qfx.ids.alpha, spanId: "s_02", section: "input" },
      qRoot,
      ZH,
    );
    const envelope = okEnvelope(result);
    const data = envelope.data as { body: { recorded: boolean; bodyIn?: string } };
    expect(data.body?.bodyIn).toBe("content");
    // 正文 canary 只出现在 content 投影，绝不进 structuredContent（正文只承载一次）
    expect(contentText(result)).toContain(JSON.stringify(SENTINELS.messageBody).slice(1, -1));
    expect(JSON.stringify(envelope)).not.toContain(SENTINELS.messageBody);
  });

  it("read_checkpoint_file：正文本体只在 content；fullFile 小事实两处都在", async () => {
    const result = await readCheckpointFileTool.execute(
      { runId: cfx.ids.root, path: "notes/crlf.txt" },
      cRoot,
      ZH,
    );
    const envelope = okEnvelope(result);
    const data = envelope.data as {
      file: { status: string; bodyIn?: string; fullFile: { sha256: string } };
    };
    expect(data.file.status).toBe("text");
    expect(data.file.bodyIn).toBe("content");
    const bodies = contentBodyTexts(result);
    expect(bodies).toEqual([FILE_TEXTS.crlf]);
    // 小事实两处都在：完整历史文件的哈希在 content 投影里可逐字引用
    expect(contentText(result)).toContain(data.file.fullFile.sha256);
    expect(JSON.stringify(envelope)).not.toContain(FILE_TEXTS.crlf.slice(0, 3));
  });

  it("compare_checkpoint_files 内容模式：两侧正文各只在 content 一次；结论可从 content 读回", async () => {
    const left = { runId: cmpFx.ids.root };
    const right = { runId: cmpFx.ids.root, stepSpanId: cmpFx.rootStepSpanId };
    const result = await compareCheckpointFilesTool.execute(
      { left, right, path: "shared.txt" },
      cmpRoot,
      ZH,
    );
    const envelope = okEnvelope(result);
    const data = envelope.data as {
      mode: string;
      conclusion: string;
      files: { left: { status: string }; right: { status: string } };
    };
    expect(data.mode).toBe("content");
    const bodies = contentBodyTexts(result);
    expect(bodies).toEqual([CF_TEXTS.shared, CF_TEXTS.shared]);
    // 结论与判别小事实能从 content 读回（真实客户端模型的「引用可回查」）
    expect(contentText(result)).toContain("same");
    expect(JSON.stringify(envelope)).not.toContain(CF_TEXTS.shared.slice(0, 3));
  });
});

describe("content 投影自足（小事实逐个可读回）", () => {
  it("get_step 投影含归属与范围数字：owner/spanId/码点范围都在 content 文本里", async () => {
    const result = await getStepTool.execute(
      { runId: qfx.ids.alpha, spanId: "s_02", section: "input" },
      qRoot,
      ZH,
    );
    okEnvelope(result);
    const text = contentText(result);
    expect(text.startsWith("get_step：")).toBe(true);
    expect(text).toContain(qfx.ids.alpha);
    expect(text).toContain('spanId: "s_02"');
    expect(text).toContain('unit: "unicode-code-point"');
    expect(text).toContain("start: 0");
  });

  it("渲染器：超长自由文本叶子截断并标注总量，正文位不受叶子上限影响", () => {
    const longText = "长".repeat(4_000);
    const body = "正".repeat(8_192);
    const data = {
      task: longText,
      body: {
        recorded: true,
        encoding: "utf8-text",
        bodyIn: "content",
        range: { start: 0, end: 8_192, total: 8_192, unit: "unicode-code-point" },
      },
    };
    const text = buildContentText("headline", data, [{ at: "body", text: body }], ZH);
    // 超长叶子被截：不是全文复制，且标注总码点（全文仍在 structuredContent）
    expect(text).not.toContain("长".repeat(3_001));
    expect(text).toContain("[投影截断：共 4000 码点，全文见结构化数据]");
    // 正文位不截：8,192 码点全文在 content（叶子上限只管普通叶子）
    expect(text).toContain(JSON.stringify(body));
    expect(text).not.toContain('bodyIn: "content"');
  });

  it("渲染器：同输入同输出（确定）；bodyIn 位缺本体时给可见防御标记", () => {
    const data = {
      file: { status: "text", encoding: "utf8-text", bodyIn: "content" },
    };
    const first = buildContentText("h", data, [{ at: "file", text: "甲\n乙" }], ZH);
    const second = buildContentText("h", data, [{ at: "file", text: "甲\n乙" }], ZH);
    expect(second).toBe(first);
    // 换行/引号转义：正文是单行 JSON 字符串，不破坏投影结构
    expect(first).toContain('text: "甲\\n乙"');
    // 缺本体（结构上不可达，防御必须显眼而不是静默丢字段）
    const missing = buildContentText("h", data, [], ZH);
    expect(missing).toContain("[投影缺正文：bodyIn=content 但本体未随结果提供]");
  });
});
