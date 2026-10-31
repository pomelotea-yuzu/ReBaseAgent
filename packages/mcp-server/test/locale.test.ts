import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Locale, createTranslator } from "@rebaseagent/i18n";
import { afterAll, describe, expect, it } from "vitest";
import { createDiagnosticLog } from "../src/diagnostics.js";
import { createQueryServer } from "../src/server.js";
import type { DataRoot } from "../src/startup.js";
import { trustInstructions } from "../src/tool-metadata.js";
import { READONLY_TOOLS } from "../src/tools.js";
import { StdioSession, initFrame, requestFrame, resultOf } from "./stdio-harness.js";

/**
 * i18n 5.2（M21/M22）：MCP 启动语言与每实例十三工具元信息。
 *
 * - 语言按共享 CLI 规则解析，非法值在协议初始化与数据根动作之前失败（退出 2）；
 * - tools/list 的 description/schema 说明与 initialize 信任声明随实例语言变化，
 *   name/字段/枚举/annotations/只读范围不变；
 * - 两个实例交错查询互不污染（没有共享可变当前语言）。
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ROOT: DataRoot = { dataDir: "/probe/root", tracesDir: "/probe/root/traces" };
const sessions: StdioSession[] = [];
const roots: string[] = [];

const baseEnv: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key !== "REBASEAGENT_LOCALE") baseEnv[key] = value;
}

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-locale-"));
  mkdirSync(join(dir, "traces"));
  roots.push(dir);
  return dir;
}

function runCli(args: readonly string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...baseEnv, ...env },
  });
}

function treeOf(dir: string): string[] {
  return readdirSync(dir).sort();
}

/** 只去掉语言说明；结构必须逐字相同 */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripDescriptions(item));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description") continue;
    out[key] = stripDescriptions(child);
  }
  return out;
}

interface PublishedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

function propertyOf(tool: PublishedTool, path: readonly string[]): Record<string, unknown> {
  let node: Record<string, unknown> = tool.inputSchema;
  for (const key of path) {
    const properties = node.properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      throw new Error(`缺少 properties：${path.join(".")}`);
    }
    const next = (properties as Record<string, unknown>)[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`缺少属性：${path.join(".")}`);
    }
    node = next as Record<string, unknown>;
  }
  return node;
}

function expectEveryPropertyDescribed(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) expectEveryPropertyDescribed(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "properties" && child !== null && typeof child === "object") {
      for (const [name, property] of Object.entries(child as Record<string, unknown>)) {
        if (property === null || typeof property !== "object") continue;
        const description = (property as Record<string, unknown>).description;
        expect(typeof description, `属性 ${name} 缺少 schema 说明`).toBe("string");
        expect((description as string).length).toBeGreaterThan(0);
        expectEveryPropertyDescribed(property);
      }
    } else {
      expectEveryPropertyDescribed(child);
    }
  }
}

async function listToolsViaStdio(locale: Locale) {
  const session = await StdioSession.start(makeRoot(), ["--locale", locale]);
  sessions.push(session);
  session.writeFrames([initFrame(1), requestFrame(2, "tools/list")]);
  const initialized = resultOf(await session.waitForFrame(1)) as { instructions: string };
  const listed = resultOf(await session.waitForFrame(2)) as { tools: PublishedTool[] };
  await session.end();
  return { instructions: initialized.instructions, tools: listed.tools };
}

async function openInMemory(locale: Locale) {
  const handle = createQueryServer(
    ROOT,
    READONLY_TOOLS,
    createDiagnosticLog(() => {}),
    createTranslator({ locale }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "mcp-locale-probe", version: "0.0.1" });
  await client.connect(clientTransport);
  return { client, handle };
}

afterAll(() => {
  for (const session of sessions.splice(0)) session.kill();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M21 两语言分别启动：十三工具与信任声明", () => {
  it("description/schema 说明/信任声明随语言变化，名称与结构不变", async () => {
    const zh = await listToolsViaStdio("zh-CN");
    const en = await listToolsViaStdio("en-US");

    expect(zh.instructions).toBe(trustInstructions(createTranslator({ locale: "zh-CN" })));
    expect(en.instructions).toBe(trustInstructions(createTranslator({ locale: "en-US" })));
    expect(zh.instructions).toContain("只读诊断");
    expect(en.instructions).toContain("read-only diagnostics");
    expect(zh.instructions).not.toBe(en.instructions);
    expect(zh.instructions.split("\n")).toHaveLength(4);
    expect(en.instructions.split("\n")).toHaveLength(4);

    expect(zh.tools).toHaveLength(13);
    expect(en.tools).toHaveLength(13);
    expect(zh.tools.map((tool) => tool.name)).toEqual(en.tools.map((tool) => tool.name));
    expect(zh.tools.map((tool) => tool.name)).toEqual(READONLY_TOOLS.map((tool) => tool.name));

    for (let index = 0; index < zh.tools.length; index += 1) {
      const zhTool = zh.tools[index] as PublishedTool;
      const enTool = en.tools[index] as PublishedTool;
      expect(zhTool.description).not.toBe(enTool.description);
      expect(zhTool.description).toContain("只读");
      expect(enTool.description).toContain("Read-only");
      expect(zhTool.annotations).toEqual(enTool.annotations);
      expect(stripDescriptions(zhTool.inputSchema)).toEqual(stripDescriptions(enTool.inputSchema));
      expectEveryPropertyDescribed(zhTool.inputSchema);
      expectEveryPropertyDescribed(enTool.inputSchema);
    }

    const zhListRuns = zh.tools.find((tool) => tool.name === "list_runs") as PublishedTool;
    const enListRuns = en.tools.find((tool) => tool.name === "list_runs") as PublishedTool;
    expect(propertyOf(zhListRuns, ["status"]).description).toBe(
      "按运行结局类别筛选；不改写记录本身的结局",
    );
    expect(propertyOf(enListRuns, ["status"]).description).toBe(
      "Filter by run outcome class; does not rewrite the recorded outcome",
    );

    const zhGetRun = zh.tools.find((tool) => tool.name === "get_run") as PublishedTool;
    const enGetRun = en.tools.find((tool) => tool.name === "get_run") as PublishedTool;
    expect(propertyOf(zhGetRun, ["runId"]).description).toBe("运行标识");
    expect(propertyOf(enGetRun, ["runId"]).description).toBe("Run identifier");

    const zhCompare = zh.tools.find((tool) => tool.name === "compare_runs") as PublishedTool;
    const enCompare = en.tools.find((tool) => tool.name === "compare_runs") as PublishedTool;
    expect(propertyOf(zhCompare, ["left", "runId"]).description).toBe("运行标识");
    expect(propertyOf(enCompare, ["left"]).description).toBe(
      "Left-side object (run or verification)",
    );
  }, 180_000);

  it("同一进程内两个实例交错查询互不污染", async () => {
    const zh = await openInMemory("zh-CN");
    const en = await openInMemory("en-US");
    try {
      const zhFirst = await zh.client.listTools();
      const enFirst = await en.client.listTools();
      const zhSecond = await zh.client.listTools();
      expect(zhFirst.tools[0]?.description).toContain("只读");
      expect(enFirst.tools[0]?.description).toContain("Read-only");
      expect(zhSecond).toEqual(zhFirst);
      expect(zh.client.getInstructions()).toContain("只读诊断");
      expect(en.client.getInstructions()).toContain("read-only diagnostics");
    } finally {
      await zh.client.close();
      await en.client.close();
      await zh.handle.close();
      await en.handle.close();
    }
  });
});

describe("M22 非法语言在初始化与数据根动作之前失败", () => {
  it("不支持/重复/缺值都以 INVALID_LOCALE 退出 2，stdout 无协议帧", () => {
    const root = makeRoot();
    const before = treeOf(root);
    const cases: ReadonlyArray<{ args: string[]; reason: string }> = [
      { args: ["--locale", "fr-FR", "--data-dir", root], reason: "unsupported-value" },
      {
        args: ["--locale", "zh-CN", "--locale", "en-US", "--data-dir", root],
        reason: "duplicate-flag",
      },
      { args: ["--locale"], reason: "missing-value" },
    ];
    for (const item of cases) {
      const result = runCli(item.args);
      expect(result.status, item.reason).toBe(2);
      expect(result.stdout, item.reason).toBe("");
      expect(result.stderr, item.reason).toContain("INVALID_LOCALE");
      expect(result.stderr, item.reason).toContain(item.reason);
      // 受控说明不回显原始参数
      expect(result.stderr, item.reason).not.toContain("fr-FR");
    }
    expect(treeOf(root)).toEqual(before);
  });

  it("生效的 REBASEAGENT_LOCALE 非法同样退出 2，且不回显取值", () => {
    const root = makeRoot();
    const result = runCli(["--data-dir", root], { REBASEAGENT_LOCALE: "xx-YY" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_LOCALE");
    expect(result.stderr).toContain("invalid-env-value");
    expect(result.stderr).not.toContain("xx-YY");
  });

  it("语言错误先于数据根核验：坏数据根 + 非法语言仍报 INVALID_LOCALE", () => {
    const root = makeRoot();
    const result = runCli(["--locale", "fr-FR", "--data-dir", join(root, "missing")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INVALID_LOCALE");
    expect(result.stderr).not.toContain("DATA_DIR_INVALID");
    expect(treeOf(root)).toEqual(["traces"]);
  });
});
