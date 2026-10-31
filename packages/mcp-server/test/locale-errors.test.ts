import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTranslator } from "@rebaseagent/i18n";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDiagnosticLog } from "../src/diagnostics.js";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { getRunTool } from "../src/query/get-run.js";
import { listRunsTool } from "../src/query/list-runs.js";
import { createQueryServer } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import { READONLY_TOOLS } from "../src/tools.js";
import { contentBodyTexts, contentText } from "./content-bodies.js";
import {
  EXPOSURE_SENTINELS,
  type ExposureFixture,
  buildExposureFixture,
  cleanupExposureFixtures,
} from "./exposure-fixtures.js";
import { type QueryFixture, buildQueryFixture, cleanupQueryFixtures } from "./query-fixtures.js";
import { EN, ZH } from "./test-locale.js";

/**
 * i18n 5.3（M23/M24）：同一对象事实与原文不随语言变化，只有受控解释变化。
 *
 * 判据：
 * - 相同查询的 data/provenance/truncation/稳定码逐字相同；headline、
 *   limitation message、错误 message 与 content 外围按实例语言投影；
 * - 正文（历史 prompt/文件/工具结果）逐字原样，注入文本不改变实例语言、
 *   工具清单或只读边界；
 * - 启动错误同样按语言给受控说明，稳定码与退出码不变。
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let fx: QueryFixture;
let root: DataRoot;
let exposure: ExposureFixture;

const opens: Array<{ client: Client; close: () => Promise<void> }> = [];

beforeAll(() => {
  fx = buildQueryFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
  exposure = buildExposureFixture();
}, 180_000);

afterAll(() => {
  for (const entry of opens.splice(0)) void entry.close();
  cleanupQueryFixtures();
  cleanupExposureFixtures();
});

function successOf(result: { isError?: boolean; structuredContent?: unknown }) {
  expect(result.isError).not.toBe(true);
  return SuccessEnvelopeSchema.parse(result.structuredContent);
}

function failureOf(result: { isError?: boolean; structuredContent?: unknown }) {
  expect(result.isError).toBe(true);
  return ErrorEnvelopeSchema.parse(result.structuredContent);
}

async function openServer(locale: "zh-CN" | "en-US", dataRoot: DataRoot) {
  const handle = createQueryServer(
    dataRoot,
    READONLY_TOOLS,
    createDiagnosticLog(() => {}),
    createTranslator({ locale }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "i18n-5-3-probe", version: "0.0.1" });
  await client.connect(clientTransport);
  const entry = {
    client,
    async close() {
      await client.close();
      await handle.close();
    },
  };
  opens.push(entry);
  return entry;
}

describe("M23 相同事实与原文：只有受控解释随语言变化", () => {
  it("get_run：data/provenance/稳定码相同，limitation message 与 headline 本地化", async () => {
    const zh = await getRunTool.execute({ runId: fx.ids.epsilon }, root, ZH);
    const en = await getRunTool.execute({ runId: fx.ids.epsilon }, root, EN);
    const zhEnvelope = successOf(zh);
    const enEnvelope = successOf(en);

    expect(zhEnvelope.data).toEqual(enEnvelope.data);
    expect(zhEnvelope.provenance).toEqual(enEnvelope.provenance);
    expect(zhEnvelope.truncation).toEqual(enEnvelope.truncation);
    expect(zhEnvelope.limitations.map((item) => ({ code: item.code, ref: item.ref }))).toEqual(
      enEnvelope.limitations.map((item) => ({ code: item.code, ref: item.ref })),
    );
    expect(zhEnvelope.limitations[0]?.code).toBe("TERMINATION_NOT_RECORDED");
    expect(zhEnvelope.limitations[0]?.message).toBe(
      "没有终止事件：以上只到已落盘的记录为止，不能据此判断该运行仍在进行",
    );
    expect(enEnvelope.limitations[0]?.message).toBe(
      "No termination event: results stop at records already on disk and cannot establish that the run is still in progress",
    );

    const zhLines = contentText(zh).split("\n");
    const enLines = contentText(en).split("\n");
    // data 投影（headline 之后）逐字相同；headline 用各自语言
    expect(zhLines.slice(1)).toEqual(enLines.slice(1));
    expect(zhLines[0]).toContain("get_run：");
    expect(enLines[0]).toContain("get_run:");
  });

  it("list_runs：筛选/计数/run 项相同，不可读项只翻受控说明", async () => {
    const zh = await listRunsTool.execute({ limit: 100 }, root, ZH);
    const en = await listRunsTool.execute({ limit: 100 }, root, EN);
    const zhData = successOf(zh).data as {
      filter: unknown;
      totals: unknown;
      items: Array<Record<string, unknown>>;
    };
    const enData = successOf(en).data as typeof zhData;

    expect(zhData.filter).toEqual(enData.filter);
    expect(zhData.totals).toEqual(enData.totals);
    const runsOf = (items: Array<Record<string, unknown>>) =>
      items.filter((item) => item.kind === "run");
    expect(runsOf(zhData.items)).toEqual(runsOf(enData.items));

    const unreadableOf = (items: Array<Record<string, unknown>>) =>
      items.filter((item) => item.kind === "unreadable_file") as Array<{
        file: string;
        code: string;
        message: string;
      }>;
    const zhUnreadable = unreadableOf(zhData.items);
    const enUnreadable = unreadableOf(enData.items);
    expect(zhUnreadable.map((item) => ({ file: item.file, code: item.code }))).toEqual(
      enUnreadable.map((item) => ({ file: item.file, code: item.code })),
    );
    const zhIdentity = zhUnreadable.find((item) => item.code === "IDENTITY_MISMATCH");
    const enIdentity = enUnreadable.find((item) => item.code === "IDENTITY_MISMATCH");
    expect(zhIdentity?.message).toBe("文件名与记录内的 run 标识不一致");
    expect(enIdentity?.message).toBe(
      "The filename and the run identifier inside the record do not match",
    );

    expect(contentText(zh).split("\n")[0]).toContain("命中");
    expect(contentText(en).split("\n")[0]).toContain("matching summaries");
  });

  it("业务失败：code/ref/retryable 相同，message 与 content 外围本地化", async () => {
    const zh = await getRunTool.execute({ runId: "mcp0-never-written" }, root, ZH);
    const en = await getRunTool.execute({ runId: "mcp0-never-written" }, root, EN);
    const zhError = failureOf(zh);
    const enError = failureOf(en);

    expect(zhError.error.code).toBe("RUN_NOT_FOUND");
    expect(zhError.error.ref).toBe(enError.error.ref);
    expect(zhError.error.retryable).toBe(enError.error.retryable);
    expect(zhError.error.message).toBe("指定 run 不存在");
    expect(enError.error.message).toBe("The specified run does not exist");
    expect(contentText(zh)).toBe("RUN_NOT_FOUND（本次查询未完成）");
    expect(contentText(en)).toBe("RUN_NOT_FOUND (this query did not complete)");
  });
});

describe("M24 不可信正文不改变语言与能力", () => {
  it("同一进程两实例读取注入正文后仍各自使用启动语言与十三只读工具", async () => {
    const dataRoot = { dataDir: exposure.dataDir, tracesDir: exposure.tracesDir };
    const zh = await openServer("zh-CN", dataRoot);
    const en = await openServer("en-US", dataRoot);

    const call = {
      name: "get_step",
      arguments: {
        runId: exposure.runId,
        spanId: exposure.llmSpanId,
        section: "input",
      },
    };
    const zhRead = await zh.client.callTool(call);
    const enRead = await en.client.callTool(call);
    expect(zhRead.isError).not.toBe(true);
    expect(enRead.isError).not.toBe(true);

    const zhBodies = contentBodyTexts(zhRead);
    const enBodies = contentBodyTexts(enRead);
    expect(zhBodies).toHaveLength(1);
    const parsedBody = JSON.parse(zhBodies[0] as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsedBody.messages[0]?.content).toBe(EXPOSURE_SENTINELS.injection);
    // 正文是原文：不随语言重写
    expect(enBodies[0]).toBe(zhBodies[0]);

    const zhList = await zh.client.listTools();
    const enList = await en.client.listTools();
    expect(zhList.tools[0]?.description).toContain("只读");
    expect(enList.tools[0]?.description).toContain("Read-only");
    expect(zhList.tools.map((tool) => tool.name)).toEqual(READONLY_TOOLS.map((tool) => tool.name));
    expect(zhList.tools).toHaveLength(13);
    expect(zhList.tools.some((tool) => tool.name === "write_file")).toBe(false);
    expect(zh.client.getInstructions()).toContain("只读诊断");
    expect(en.client.getInstructions()).toContain("read-only diagnostics");

    const zhUnknown = (await zh.client.callTool({
      name: "write_file",
      arguments: {},
    })) as { content?: Array<{ text?: string }> };
    const enUnknown = (await en.client.callTool({
      name: "write_file",
      arguments: {},
    })) as { content?: Array<{ text?: string }> };
    expect(zhUnknown.content?.[0]?.text).toContain("未知工具");
    expect(enUnknown.content?.[0]?.text).toContain("Unknown tool");
  });
});

describe("启动错误：稳定码与退出码不变，说明按语言", () => {
  it("坏数据根在两种语言下都给 DATA_DIR_INVALID + 本地化说明", () => {
    const baseEnv: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== "REBASEAGENT_LOCALE") baseEnv[key] = value;
    }
    const missing = join(fx.dataDir, "definitely-missing");
    const zh = spawnSync(process.execPath, [CLI, "--locale", "zh-CN", "--data-dir", missing], {
      encoding: "utf8",
      timeout: 30_000,
      env: baseEnv,
    });
    const en = spawnSync(process.execPath, [CLI, "--locale", "en-US", "--data-dir", missing], {
      encoding: "utf8",
      timeout: 30_000,
      env: baseEnv,
    });
    for (const result of [zh, en]) {
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("DATA_DIR_INVALID");
      expect(result.stderr).toContain("DATA_DIR_MISSING");
    }
    expect(zh.stderr).toContain("数据根不存在或不可访问");
    expect(en.stderr).toContain("The data root does not exist or is not accessible");
  });
});
