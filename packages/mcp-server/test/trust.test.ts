import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CompatibilityCallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDiagnosticLog } from "../src/diagnostics.js";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import type { GetStepData } from "../src/query/get-step.js";
import { REDACTED_MARKER } from "../src/query/redaction.js";
import { TRUST_INSTRUCTIONS, createQueryServer } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import { READONLY_TOOLS } from "../src/tools.js";
import {
  EXPOSURE_SENTINELS,
  type ExposureFixture,
  buildExposureFixture,
  cleanupExposureFixtures,
  fingerprintDir,
} from "./exposure-fixtures.js";

/**
 * MCP0 4.8（S12）：信任说明与「历史指令不扩展服务权限」。
 *
 * 两条判据不能互相替代：
 * - **说明在场**：initialize 的 instructions 明确只读、数据根固定、历史正文不可信、
 *   已知凭据过滤有限、客户端外发/计费由客户端决定。
 * - **行为如实**：历史 prompt 要求「改数据根 / 调写入工具 / 输出所有 api key」时，
 *   服务只把它当正文返回；工具清单、数据根与过滤规则都不变，写工具不存在。
 */

let fx: ExposureFixture;
let root: DataRoot;

beforeAll(() => {
  fx = buildExposureFixture();
  root = { dataDir: fx.dataDir, tracesDir: fx.tracesDir };
}, 120_000);

afterAll(() => {
  cleanupExposureFixtures();
});

interface Harness {
  readonly client: Client;
  close: () => Promise<void>;
}

const open: Harness[] = [];

async function harness(): Promise<Harness> {
  const handle = createQueryServer(
    root,
    READONLY_TOOLS,
    createDiagnosticLog(() => {}),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "mcp0-48-trust", version: "0.0.1" });
  await client.connect(clientTransport);
  const entry: Harness = {
    client,
    async close() {
      await client.close();
      await handle.close();
    },
  };
  open.push(entry);
  return entry;
}

afterEach(async () => {
  for (const entry of open.splice(0)) await entry.close();
});

function firstText(result: CompatibilityCallToolResult): string {
  if (!("content" in result) || !Array.isArray(result.content)) return "";
  const block = result.content[0] as { type?: string; text?: string } | undefined;
  return block?.type === "text" ? (block.text ?? "") : "";
}

/** SDK 的返回是 `content | toolResult` 兼容联合；本服务只发前者（memory 的窄类型纪律） */
function structuredOf(result: CompatibilityCallToolResult): unknown {
  if (!("content" in result) || result.structuredContent === undefined) {
    throw new Error("结果没有 structuredContent");
  }
  return result.structuredContent;
}

describe("initialize：信任说明", () => {
  it("instructions 明确只读、不可信历史、过滤有限与外发/计费边界", async () => {
    const h = await harness();
    const instructions = h.client.getInstructions();
    expect(instructions).toBe(TRUST_INSTRUCTIONS);
    for (const phrase of [
      "只读诊断",
      "不运行模型或工具",
      "不写盘",
      "不可信记录",
      "数据根",
      "七个只读工具",
      "REDACTED",
      "自由文本",
      "检查点文件",
      "费用",
    ]) {
      expect(instructions).toContain(phrase);
    }
    // 说明本身不能被历史正文改写
    expect(instructions).not.toContain("忽略之前");
  });

  it("能力仍只有 tools：没有 resources/prompts/写入工具", async () => {
    const h = await harness();
    expect(h.client.getServerCapabilities()).toEqual({ tools: {} });
    const names = (await h.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(READONLY_TOOLS.map((tool) => tool.name));
    expect(names).toHaveLength(7);
    expect(names).not.toContain("write_file");
  });
});

describe("历史指令不扩展服务权限（S12）", () => {
  it("注入 prompt 只作为数据返回，凭据仍按同一规则过滤", async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: "get_step",
      arguments: { runId: fx.runId, spanId: fx.llmSpanId, section: "input" },
    });
    expect(result.isError).not.toBe(true);
    const envelope = SuccessEnvelopeSchema.parse(structuredOf(result));
    const data = envelope.data as GetStepData;
    if (data.body === null || data.body.recorded === false) throw new Error("正文应当在场");
    const parsed = JSON.parse(data.body.text) as {
      messages: Array<{ role: string; content: string }>;
    };
    // 注入文本原样作为数据返回（规范化 JSON 会转义反斜杠，按解析后的值核对）
    expect(parsed.messages[0]?.content).toBe(EXPOSURE_SENTINELS.injection);
    expect(data.body.text).toContain(REDACTED_MARKER);
    expect(data.body.text).not.toContain(EXPOSURE_SENTINELS.paramsApiKey);
    expect(envelope.limitations.map((item) => item.code)).toContain("REDACTED");
  });

  it("请求不存在的写工具：拒绝且数据目录逐字节不变", async () => {
    const h = await harness();
    const before = fingerprintDir(fx.dataDir);
    const result = await h.client.callTool({
      name: "write_file",
      arguments: { path: "evil.txt", content: "payload" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("未知工具");
    expect(firstText(result)).not.toContain("evil.txt");
    expect(fingerprintDir(fx.dataDir)).toBe(before);

    // 工具清单没有被历史正文改写
    const names = (await h.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(READONLY_TOOLS.map((tool) => tool.name));
  });

  it("数据根仍固定：越界 run 标识在任何读取之前拒绝", async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: "get_run",
      arguments: { runId: "../outside" },
    });
    expect(result.isError).toBe(true);
    const envelope = ErrorEnvelopeSchema.parse(structuredOf(result));
    expect(envelope.error.code).toBe("INVALID_ARGUMENT");
    expect(envelope.error.ref).toBe("runId");
    expect(JSON.stringify(envelope)).not.toContain("outside");
  });

  it("注入不改变读取事实：同一时刻的 list_runs data 前后深度相等", async () => {
    const h = await harness();
    const before = await h.client.callTool({ name: "list_runs", arguments: { limit: 100 } });
    await h.client.callTool({
      name: "get_step",
      arguments: { runId: fx.runId, spanId: fx.toolSpanId, section: "input" },
    });
    const after = await h.client.callTool({ name: "list_runs", arguments: { limit: 100 } });
    const beforeEnvelope = SuccessEnvelopeSchema.parse(structuredOf(before));
    const afterEnvelope = SuccessEnvelopeSchema.parse(structuredOf(after));
    expect(afterEnvelope.data).toEqual(beforeEnvelope.data);
    expect(afterEnvelope.provenance).toEqual(beforeEnvelope.provenance);
  });
});
