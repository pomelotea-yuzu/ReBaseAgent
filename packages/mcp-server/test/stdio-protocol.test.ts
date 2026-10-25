import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ListRunsData } from "../src/query/list-runs.js";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  QUERY_API_VERSION,
  TRUST_INSTRUCTIONS,
} from "../src/server.js";
import { DATA_DIR_FLAG } from "../src/startup.js";
import { READ_ONLY_ANNOTATIONS, TOOL_CONTRACTS, contractOf } from "../src/tool-contracts.js";
import {
  VERIFICATION_TOOL_CONTRACTS,
  verificationContractOf,
} from "../src/verification-contracts.js";
import {
  STDIO_OTHER_RUN_ID,
  type StdioFixture,
  buildEmptyRoot,
  buildOtherRoot,
  buildStdioFixture,
  cleanupStdioFixtures,
} from "./stdio-fixtures.js";
import {
  StdioSession,
  callFrame,
  envelopeOf,
  errorOf,
  initFrame,
  okData,
  requestFrame,
  resultOf,
  treeListing,
} from "./stdio-harness.js";

/**
 * MCP0 5.3（S01/S03/S04/S06 的线务面）：真实 stdio 子进程的协商、tools/schema 与协议拒绝。
 *
 * 4.2 用 InMemoryTransport 证过同一套服务层判据；这一批换成**真子进程 + 真通道**，
 * 把"没有桌面也能初始化"（S01）从包层断言升级为进程事实：
 * - 协商结果、能力集、instructions 必须由对端**收到**，不是我们内部常量自证；
 * - `tools/list` 发出的入参声明必须与契约逐字相同（少一个 `additionalProperties:false`
 *   就等于给客户端留了未知字段通道）；
 * - 旁路方法在真实通道上得 `-32601`，畸形帧不污染 stdout，也不让会话卡死。
 *
 * 下面的 SDK 行为常量取自 `@modelcontextprotocol/sdk@1.32.1`，且先经
 * `.workbuddy/mcp0-53/probe-frames.cjs` 实跑核对；升级 SDK 会让这些行翻红，那是提醒复审。
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NODE = process.execPath;

/** SDK 1.32.1 的 LATEST_PROTOCOL_VERSION：客户端版本不受支持时服务端回这个 */
const SDK_LATEST_PROTOCOL_VERSION = "2025-11-25";
/** 本服务只声明 tools 能力 ⇒ 这些标准方法没有 handler（D7 的"无旁路"） */
const BYPASS_METHODS = [
  "prompts/list",
  "resources/list",
  "completion/complete",
  "logging/setLevel",
];
/** 请求重跑/写入一类的工具名：永远不会注册，用来钉"不因拒绝而扩大服务范围" */
const WRITEISH_TOOLS = ["rerun_and_write", "export_run", "delete_run", "fork_rerun_and_write"];
const METHOD_NOT_FOUND = -32601;
/** 结构性违规的请求（缺 params.name）由 SDK 兜成 InternalError，不进我们的错误信封 */
const INTERNAL_ERROR = -32603;

let fx: StdioFixture;
let otherRoot: string;
let emptyRoot: string;
let knownRunIds: string[];

const sessions: StdioSession[] = [];

async function openSession(dataDir: string): Promise<StdioSession> {
  const session = await StdioSession.start(dataDir);
  sessions.push(session);
  return session;
}

/** JSON Schema 是嵌套对象：按路径取容器，缺字段就炸出来，不用 `any` 蒙过去 */
function nodeAt(
  schema: Record<string, unknown> | undefined,
  path: string[],
): Record<string, unknown> {
  let current = schema;
  for (const key of path) {
    if (current === undefined) break;
    const next = current[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new Error(`发布形状缺容器：${path.join(".")}`);
    }
    current = next as Record<string, unknown>;
  }
  if (current === undefined) throw new Error(`发布形状缺容器：${path.join(".")}`);
  return current;
}

function valueAt(schema: Record<string, unknown> | undefined, path: string[]): unknown {
  const parent = nodeAt(schema, path.slice(0, -1));
  return parent[path[path.length - 1] as string];
}

beforeAll(async () => {
  fx = buildStdioFixture();
  otherRoot = buildOtherRoot();
  emptyRoot = buildEmptyRoot();
  knownRunIds = [
    ...fx.listRunIds,
    fx.bodyRunId,
    fx.workspaceRunId,
    fx.unsealedRunId,
    "mcp0-std-ws-plain",
  ];
}, 180_000);

afterAll(() => {
  for (const session of sessions.splice(0)) {
    session.kill();
  }
  cleanupStdioFixtures();
});

describe("S01 真实 stdio 协商：版本、能力与信任说明", () => {
  it("客户端支持的协议版本逐个原样回显", async () => {
    for (const version of ["2024-11-05", "2025-03-26", "2025-06-18"]) {
      const session = await openSession(fx.dataDir);
      session.writeFrame(initFrame(1, version));
      const frame = await session.waitForFrame(1);
      expect((frame.result as { protocolVersion: string }).protocolVersion).toBe(version);
      await session.end();
    }
  }, 180_000);

  it("不支持的版本落 SDK 现行版本；能力恰为 tools；身份与信任说明原样到达对端", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1, "2099-01-01"), requestFrame(2, "tools/list")]);
    const result = resultOf(await session.waitForFrame(1));
    expect(result.protocolVersion).toBe(SDK_LATEST_PROTOCOL_VERSION);
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    expect(result.instructions).toBe(TRUST_INSTRUCTIONS);
    await session.waitForFrame(2);
    await session.end();
  }, 120_000);

  it("空 traces 的合法数据根也能初始化，list_runs 出门就是空列表", async () => {
    const session = await openSession(emptyRoot);
    session.writeFrames([
      initFrame(1),
      requestFrame(2, "tools/list"),
      callFrame(3, "list_runs", {}),
    ]);
    const listed = resultOf(await session.waitForFrame(2)) as { tools: unknown[] };
    expect(listed.tools).toHaveLength(TOOL_CONTRACTS.length + VERIFICATION_TOOL_CONTRACTS.length);
    const { data, envelope } = okData<ListRunsData>(await session.waitForFrame(3));
    expect(data.items).toEqual([]);
    expect(data.totals).toMatchObject({ matchedRuns: 0, listed: 0 });
    expect(envelope.provenance.runs).toEqual([]);
    expect(envelope.truncation.truncated).toBe(false);
    // 空根同样不建目录：数据根下仍然只有 traces/
    expect(treeListing(emptyRoot)).toEqual(["/traces"]);
    await session.end();
  }, 120_000);

  it("真实客户端（官方 SDK Client + StdioClientTransport）在只有数据根时完成握手", async () => {
    const transport = new StdioClientTransport({
      command: NODE,
      args: [CLI, DATA_DIR_FLAG, fx.dataDir],
      stderr: "pipe",
    });
    const client = new Client({ name: "mcp0-53-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toEqual({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      });
      expect(client.getServerCapabilities()).toEqual({ tools: {} });
      expect(client.getInstructions()).toBe(TRUST_INSTRUCTIONS);
    } finally {
      await client.close();
    }
  }, 120_000);
});

describe("S03 线务面：tools/list 发布的就是契约派生的声明", () => {
  it("十三个工具的 name/description/inputSchema/annotations 与契约逐字相同", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), requestFrame(2, "tools/list")]);
    await session.waitForFrame(1);
    const tools = (
      resultOf(await session.waitForFrame(2)) as {
        tools: Array<Record<string, unknown>>;
      }
    ).tools;
    const allContracts = [...TOOL_CONTRACTS, ...VERIFICATION_TOOL_CONTRACTS];
    expect(tools.map((tool) => tool.name)).toEqual(allContracts.map((item) => item.name));
    for (const tool of tools) {
      const contract = contractOf(String(tool.name)) ?? verificationContractOf(String(tool.name));
      if (contract === undefined) throw new Error(`契约缺失：${String(tool.name)}`);
      expect(tool.inputSchema).toEqual(contract.inputSchema);
      expect(tool.annotations).toEqual(READ_ONLY_ANNOTATIONS);
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).length).toBeGreaterThan(0);
    }
    await session.end();
  }, 120_000);

  it("发布的形状带着上限与 strict（客户端不能靠多带一个键换到旁路）", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1), requestFrame(2, "tools/list")]);
    const tools = (
      resultOf(await session.waitForFrame(2)) as {
        tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
      }
    ).tools;
    const schemaOf = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
    expect(valueAt(schemaOf("list_runs"), ["additionalProperties"])).toBe(false);
    expect(valueAt(schemaOf("list_runs"), ["properties", "limit", "maximum"])).toBe(100);
    expect(valueAt(schemaOf("get_step"), ["properties", "maxChars", "maximum"])).toBe(8192);
    expect(valueAt(schemaOf("get_step"), ["properties", "runId", "maxLength"])).toBe(200);
    expect(valueAt(schemaOf("get_step"), ["properties", "spanId", "maxLength"])).toBe(128);
    expect(valueAt(schemaOf("get_step"), ["properties", "cursor", "maxLength"])).toBe(512);
    expect(valueAt(schemaOf("read_checkpoint_file"), ["required"])).toEqual(["runId", "path"]);
    expect(valueAt(schemaOf("compare_runs"), ["required"])).toEqual(["left", "right"]);
    expect(valueAt(schemaOf("compare_runs"), ["properties", "left", "additionalProperties"])).toBe(
      false,
    );
    // 每字段独立实例：出现 $ref 就说明发布形状要靠解引用才读得懂
    expect(JSON.stringify(tools)).not.toContain("$ref");
    await session.end();
  }, 120_000);
});

describe("S01 七个工具在无桌面的子进程里全部调通", () => {
  it("列表→详情→正文→比较→检查点→文件→两侧文件，来源只指向本根的 run", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_runs", { limit: 5 }],
      ["get_run", { runId: fx.workspaceRunId }],
      ["get_step", { runId: fx.bodyRunId, spanId: fx.bodySpanId, section: "output", maxChars: 64 }],
      ["compare_runs", { left: { runId: fx.listRunIds[0] }, right: { runId: fx.listRunIds[1] } }],
      ["inspect_checkpoint", { runId: fx.workspaceRunId }],
      ["read_checkpoint_file", { runId: fx.workspaceRunId, path: fx.filePath, maxChars: 64 }],
      [
        "compare_checkpoint_files",
        {
          left: { runId: fx.workspaceRunId },
          right: { runId: fx.workspaceRunId, stepSpanId: fx.workspaceStepSpanId },
          path: fx.filePath,
          maxChars: 64,
        },
      ],
    ];
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      ...calls.map(([name, args], index) => callFrame(2 + index, name, args)),
    ]);

    const observedRunIds = new Set<string>();
    for (let index = 0; index < calls.length; index += 1) {
      const [name] = calls[index];
      const envelope = envelopeOf(await session.waitForFrame(2 + index));
      expect(envelope.ok).toBe(true);
      for (const run of envelope.provenance.runs) {
        observedRunIds.add(run.runId);
        expect(knownRunIds, `工具 ${name} 读到了本根之外的 run`).toContain(run.runId);
      }
    }
    // 七条都真读到了东西（不是同一份空壳复用）
    expect(observedRunIds.size).toBeGreaterThan(1);
    const stdout = session.stdoutText();
    expect(stdout).not.toContain(STDIO_OTHER_RUN_ID);
    expect(stdout).not.toContain(fx.dataDir);
    expect(session.unparsedStdout()).toEqual([]);
    await session.end();
  }, 180_000);
});

describe("S04 未知字段与执行请求在线务面上被拒", () => {
  it("带 dataDir / handler 的未知字段 ⇒ INVALID_ARGUMENT，字段名与取值都不回显", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      callFrame(2, "list_runs", { dataDir: otherRoot, limit: 2 }),
      callFrame(3, "get_run", { runId: fx.listRunIds[0], handler: "rerun-and-write" }),
    ]);
    expect(errorOf(await session.waitForFrame(2))).toEqual({
      code: "INVALID_ARGUMENT",
      message: "参数不符合本工具的约束（(root):unrecognized_keys）",
      retryable: false,
    });
    expect(errorOf(await session.waitForFrame(3)).code).toBe("INVALID_ARGUMENT");

    const stdout = session.stdoutText();
    expect(stdout).not.toContain("dataDir");
    expect(stdout).not.toContain("handler");
    expect(stdout).not.toContain(otherRoot);
    expect(stdout).not.toContain("rerun-and-write");
    // 被拒的两次不改服务范围：同一通道上正常调用仍只读到本根
    session.writeFrame(callFrame(4, "list_runs", { limit: 2 }));
    const { data } = okData<ListRunsData>(await session.waitForFrame(4));
    expect(data.items).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain(STDIO_OTHER_RUN_ID);
    await session.end();
  }, 120_000);

  it("超限参数（limit=0/101、maxChars=8193、runId 201 字符）在读取之前就被拒", async () => {
    const session = await openSession(fx.dataDir);
    const before = treeListing(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      callFrame(2, "list_runs", { limit: 0 }),
      callFrame(3, "list_runs", { limit: 101 }),
      callFrame(4, "get_step", {
        runId: fx.bodyRunId,
        spanId: fx.bodySpanId,
        section: "output",
        maxChars: 8193,
      }),
      callFrame(5, "get_run", { runId: "r".repeat(201) }),
    ]);
    const cases: Array<[number, string]> = [
      [2, "limit:too_small"],
      [3, "limit:too_big"],
      [4, "maxChars:too_big"],
      [5, "runId:too_big"],
    ];
    for (const [id, needle] of cases) {
      const error = errorOf(await session.waitForFrame(id));
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(error.message.startsWith("参数不符合本工具的约束（")).toBe(true);
      expect(error.message).toContain(needle);
    }
    expect(treeListing(fx.dataDir)).toEqual(before);
    await session.end();
  }, 120_000);

  it("重跑/写入类工具名一律未知工具拒绝；旁路方法得 -32601；ping 有应答", async () => {
    const session = await openSession(fx.dataDir);
    const before = treeListing(fx.dataDir);
    session.writeFrames([
      initFrame(1),
      ...WRITEISH_TOOLS.map((name, index) => callFrame(2 + index, name, {})),
      ...BYPASS_METHODS.map((method, index) => requestFrame(10 + index, method, {})),
      requestFrame(20, "ping", {}),
    ]);

    for (let index = 0; index < WRITEISH_TOOLS.length; index += 1) {
      const result = resultOf(await session.waitForFrame(2 + index));
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toContain("未知工具");
      expect(result.structuredContent).toBeUndefined();
    }
    for (let index = 0; index < BYPASS_METHODS.length; index += 1) {
      const frame = await session.waitForFrame(10 + index);
      expect(frame.error?.code).toBe(METHOD_NOT_FOUND);
      expect(JSON.stringify(frame)).not.toContain(QUERY_API_VERSION);
    }
    expect((await session.waitForFrame(20)).result).toEqual({});
    // 一整串拒绝之后：数据根没多出任何东西，也没被换过地方
    expect(treeListing(fx.dataDir)).toEqual(before);
    expect(session.stderrFor("tool_unknown")).toHaveLength(WRITEISH_TOOLS.length);
    await session.end();
  }, 120_000);
});

describe("S06 协议面不受污染", () => {
  it("非 JSON 行与缺 method 的帧：不回累及 id 的帧，诊断进 stderr，会话继续", async () => {
    const session = await openSession(fx.dataDir);
    session.writeFrames([initFrame(1)]);
    await session.waitForFrame(1);
    // 非 JSON 文本 + 缺 method 的 JSON：两处都在传输层反序列化失败 ⇒ 连 id 都不成立
    session.writeFrames([{ jsonrpc: "2.0", id: 2 }]);
    session.writeRaw("this is not json\n");
    // 结构性违规（缺 params.name）由 SDK 兜成 InternalError：有帧，但绝不进我们的信封
    session.writeFrame(callFrame(3, "list_runs", {}));
    session.writeFrames([{ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} }]);
    session.writeFrame(callFrame(5, "list_runs", { limit: 1 }));

    const structural = await session.waitForFrame(4);
    expect(structural.error?.code).toBe(INTERNAL_ERROR);
    expect(JSON.stringify(structural)).not.toContain(QUERY_API_VERSION);
    expect(session.framesFor(2)).toHaveLength(0);
    const named = await session.waitForFrame(3);
    expect(envelopeOf(named).ok).toBe(true);
    expect(envelopeOf(await session.waitForFrame(5)).ok).toBe(true);
    expect(session.unparsedStdout()).toEqual([]);
    expect(session.stderrText()).toContain("protocol_error");
    // 恰好两条：非 JSON 行一条、缺 method 一条；其余违规都走正规错误帧
    expect(session.stderrText().split("protocol_error").length - 1).toBe(2);
    await session.end();
  }, 120_000);
});
