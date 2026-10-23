import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createDiagnosticLog } from "../src/diagnostics.js";
import { ErrorEnvelopeSchema, SuccessEnvelopeSchema } from "../src/envelope.js";
import { TOOL_ERROR_MESSAGES } from "../src/error-projection.js";
import { createQueryServer } from "../src/server.js";
import type { ToolDefinition } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import { contractOf } from "../src/tool-contracts.js";
import { ToolFailure, defineTool } from "../src/tool-definition.js";

/**
 * MCP0 4.2（S04/S06）：协议面行为——用官方 SDK 客户端与真 Server 实例对跑。
 *
 * 只读服务的"没有旁路"必须是被**问出来**的，不是被声明出来的：
 * - 未知字段 / 未知工具名都得到拒绝，且拒绝里不带被拒的取值；
 * - 没有 resources / prompts 通道（`tools` 是唯一能力）；
 * - 业务失败走统一错误信封；程序缺陷只回一句受控文案，堆栈与原始异常文本不过层。
 */

const ROOT: DataRoot = { dataDir: "/probe/root", tracesDir: "/probe/root/traces" };

interface Harness {
  readonly client: Client;
  readonly stderr: string[];
  close: () => Promise<void>;
}

const open: Harness[] = [];

async function harness(tools: readonly ToolDefinition[]): Promise<Harness> {
  const stderr: string[] = [];
  const log = createDiagnosticLog((line) => {
    stderr.push(line);
  });
  const handle = createQueryServer(ROOT, tools, log);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "mcp0-42-probe", version: "0.0.1" });
  await client.connect(clientTransport);
  const entry: Harness = {
    client,
    stderr,
    async close(): Promise<void> {
      await client.close();
      await handle.close();
    },
  };
  open.push(entry);
  return entry;
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.close();
  }
});

/** 桩工具：只借用契约与信封装配，不触碰文件系统 */
function stubTool(
  name: "get_run",
  behaviour: "ok" | "business-failure" | "bug" | "leaky-failure",
): ToolDefinition {
  const contract = contractOf(name);
  if (contract === undefined) {
    throw new Error(`契约缺失：${name}`);
  }
  return defineTool(contract, async (args) => {
    if (behaviour === "business-failure") {
      throw new ToolFailure("RUN_NOT_FOUND", `run:${String((args as { runId: string }).runId)}`);
    }
    if (behaviour === "bug") {
      throw new Error("内部缺陷：无法读取 D:\\secret\\traces\\run-1.jsonl");
    }
    if (behaviour === "leaky-failure") {
      throw new RangeError("C:\\Users\\someone 的原始异常文本");
    }
    return {
      readVersion: "rv:stub",
      data: { runId: (args as { runId: string }).runId, steps: null },
      runs: [
        {
          runId: (args as { runId: string }).runId,
          formatVersion: 2,
          sealed: true,
          lineage: "complete",
          spanScope: "own",
        },
      ],
      limitations: [{ code: "BODY_NOT_EXPOSED", message: "正文需显式请求" }],
      headline: "get_run ok",
    };
  });
}

describe("协议面：能力与旁路", () => {
  it("唯一能力是 tools；resources/prompts 一类旁路被协议拒绝", async () => {
    const h = await harness([stubTool("get_run", "ok")]);
    expect(h.client.getServerCapabilities()).toEqual({ tools: {} });

    await expect(h.client.listResources()).rejects.toBeInstanceOf(McpError);
    await expect(h.client.listPrompts()).rejects.toBeInstanceOf(McpError);
  });

  it("tools/list 发布的就是契约派生的那份声明", async () => {
    const h = await harness([stubTool("get_run", "ok")]);
    const listed = await h.client.listTools();
    expect(listed.tools).toHaveLength(1);
    const tool = listed.tools[0];
    expect(tool?.name).toBe("get_run");
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["runId"],
      additionalProperties: false,
    });
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe("协议面：拒绝与错误信封", () => {
  it("未知字段 ⇒ INVALID_ARGUMENT，被拒的取值不回显", async () => {
    const h = await harness([stubTool("get_run", "ok")]);
    const result = (await h.client.callTool({
      name: "get_run",
      arguments: { runId: "run-1", dataDir: "D:/secret-root" },
    })) as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).toBe(true);
    const parsed = ErrorEnvelopeSchema.safeParse(result.structuredContent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(result)).not.toContain("D:/secret-root");
    expect(JSON.stringify(result)).not.toContain("dataDir");
  });

  it("未知工具名 ⇒ 拒绝且不改服务边界", async () => {
    const h = await harness([stubTool("get_run", "ok")]);
    const result = (await h.client.callTool({
      name: "rerun_and_write",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("未知工具");
    expect(h.stderr.join("")).toContain("tool_unknown");
  });

  it("业务失败 ⇒ 稳定码信封 + 受控文案 + ref", async () => {
    const h = await harness([stubTool("get_run", "business-failure")]);
    const result = (await h.client.callTool({
      name: "get_run",
      arguments: { runId: "run-9" },
    })) as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).toBe(true);
    const parsed = ErrorEnvelopeSchema.safeParse(result.structuredContent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error).toEqual({
      code: "RUN_NOT_FOUND",
      message: TOOL_ERROR_MESSAGES.RUN_NOT_FOUND,
      ref: "run:run-9",
      retryable: false,
    });
  });

  it("未知工具名的回显有界（客户端不能拿方法名换回一段正文）", async () => {
    const h = await harness([stubTool("get_run", "ok")]);
    // 该桩不存在：走未知工具出口，验证服务层的名字回显同样有界
    const long = "a".repeat(200);
    const result = (await h.client.callTool({
      name: long,
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect((result.content?.[0]?.text ?? "").length).toBeLessThanOrEqual(200);
  });

  it("程序缺陷只回一句受控文案：不透传堆栈也不伪装成业务码", async () => {
    const h = await harness([stubTool("get_run", "bug")]);
    const result = (await h.client.callTool({
      name: "get_run",
      arguments: { runId: "run-1" },
    })) as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("工具 get_run 本次未完成");
    expect(result.structuredContent).toBeUndefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("at ");
    expect(h.stderr.join("")).toContain("tool_internal_error");
    expect(h.stderr.join("")).not.toContain("secret");
  });

  it("非受控异常（未归入业务码）同样被服务层兜住", async () => {
    const h = await harness([stubTool("get_run", "leaky-failure")]);
    const result = (await h.client.callTool({
      name: "get_run",
      arguments: { runId: "run-1" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Users");
  });
});

describe("协议面：成功结果", () => {
  it("structuredContent 是自检通过的成功信封；content = headline + data 投影（6.2 自足口径）", async () => {
    const h = await harness([stubTool("get_run", "ok")]);
    const result = (await h.client.callTool({
      name: "get_run",
      arguments: { runId: "run-7" },
    })) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
    /**
     * 6.2 改判（原判据「content 只一句状态」）：真实客户端 WorkBuddy 5.9.0 实测
     * 不把 structuredContent 交给模型 ⇒ headline 之外必须把 data 事实投影进 content，
     * 否则「引用可回查」在真实链路上落空（MCP0.md 第 13 条）。
     */
    expect(result.content?.[0]?.text).toBe('get_run ok\nrunId: "run-7"\nsteps: null');
    const parsed = SuccessEnvelopeSchema.safeParse(result.structuredContent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.provenance.runs).toEqual([
      {
        runId: "run-7",
        formatVersion: 2,
        sealed: true,
        lineage: "complete",
        spanScope: "own",
      },
    ]);
    expect(parsed.data.limitations).toEqual([
      { code: "BODY_NOT_EXPOSED", message: "正文需显式请求" },
    ]);
    expect(parsed.data.truncation).toEqual({ truncated: false });
  });
});
