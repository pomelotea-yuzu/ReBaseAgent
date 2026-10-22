import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, QUERY_API_VERSION } from "../src/server.js";
import { DATA_DIR_FLAG } from "../src/startup.js";
import { READONLY_TOOLS } from "../src/tools.js";

/**
 * MCP0 4.1（S01/S02）：真实 stdio 子进程的启动、通道与生命周期。
 *
 * 这一层只能用真子进程证：`--data-dir` 的核验发生在协议动作之前，退出码、
 * **stdout 是否只有协议帧**、EOF 后是否释放都得看进程实际行为。
 * （完整协商/取消/重连归 5.3；这里钉 4.1 的四条：坏根非零退出、stdout 纯净、
 * 合法空 traces 能初始化并完成工具发现、EOF 后落定退出。）
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const NODE = process.execPath;

const roots: string[] = [];

function tempRoot(withTraces: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp0-lifecycle-"));
  roots.push(dir);
  if (withTraces) mkdirSync(join(dir, "traces"), { recursive: true });
  return dir;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 起一个真实子进程：写完 stdin 就断开（模拟客户端 EOF） */
function runCli(args: readonly string[], stdinLines: readonly string[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    for (const line of stdinLines) {
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

let emptyRoot: string;

beforeAll(() => {
  emptyRoot = tempRoot(true);
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("S02 无效数据根：启动即失败", () => {
  it("缺 --data-dir：非零退出、stderr 给固定码、stdout 一个字节都没有", async () => {
    const run = await runCli([]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("DATA_DIR_INVALID");
    expect(run.stderr).not.toContain("jsonrpc");
  }, 30_000);

  it("目录不存在同样失败，且不因为失败而创建任何东西", async () => {
    const missing = join(tempRoot(false), "not-created");
    const run = await runCli([DATA_DIR_FLAG, missing]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("DATA_DIR_INVALID");
    expect(run.stderr).not.toContain(missing);
  }, 30_000);

  it("有目录但没有 traces/ ⇒ 同样拒绝（不 mkdir 兜底）", async () => {
    const noTraces = tempRoot(false);
    const run = await runCli([DATA_DIR_FLAG, noTraces]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("traces");
    expect(readdirLength(noTraces)).toBe(0);
  }, 30_000);
});

describe("S01 合法数据根：无桌面也能初始化", () => {
  it("空 traces 也能完成协议初始化与工具发现；tools/list 发布的就是注册表那份", async () => {
    const transport = new StdioClientTransport({
      command: NODE,
      args: [CLI, DATA_DIR_FLAG, emptyRoot],
      stderr: "pipe",
    });
    const stderrLines: string[] = [];
    transport.stderr?.on("data", (chunk) => {
      stderrLines.push(chunk.toString("utf8"));
    });
    const client = new Client({ name: "mcp0-41-probe", version: "0.0.1" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toEqual({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      });
      expect(client.getServerCapabilities()).toEqual({ tools: {} });

      /**
       * 4.1 当年钉的是「清单为空」，4.3 起登记了实现，判据改成**跟着注册表走**：
       * - 子进程发出去的名称必须与注册表逐字一致（顺序也是发布顺序，D5）——
       *   这条同时能咬住「dist 没重建就跑测试」（注册表读的是 src，工具来自 dist）；
       * - 4.4–4.7 逐项登记时下面那行名称清单会随之变红，那是提醒改动者更新账本，
       *   不是产品故障。
       */
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        READONLY_TOOLS.map((tool) => tool.name),
      );
      expect(listed.tools.map((tool) => tool.name)).toEqual(["list_runs", "get_run"]);

      // 未注册的名字必须拒（S04 的前半段），且不因拒绝而改变服务边界。
      // 用「重跑并写入」这种**永远不会注册**的名字：拿 4.4 待实现的名字测，
      // 等它登记完这条判据就悄悄失效了。
      const call = (await client.callTool({ name: "rerun_and_write", arguments: {} })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      expect(call.isError).toBe(true);
      expect(call.content?.[0]?.text).toContain("未知工具");
    } finally {
      await client.close();
    }
    const combined = stderrLines.join("");
    expect(combined).toContain("initialized");
    expect(combined).not.toContain("jsonrpc");
  }, 60_000);

  it("apiVersion 常量与信封口径一致（4.2 的承载前提）", () => {
    expect(QUERY_API_VERSION).toBe("rebaseagent.query.v1");
  });
});

describe("stdout/stderr 纪律", () => {
  it("stdout 逐行只可能是 JSON-RPC 帧；诊断只在 stderr", async () => {
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw-probe", version: "0.0.1" },
      },
    });
    const run = await runCli([DATA_DIR_FLAG, emptyRoot], [initialize]);
    expect(run.code).toBe(0);

    const frames = run.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const parsed = JSON.parse(frame) as { jsonrpc?: string; id?: number; result?: unknown };
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe(1);
      expect(parsed.result).toBeTruthy();
    }

    const logLines = run.stderr.split("\n").filter((line) => line.trim().length > 0);
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toContain("jsonrpc");
      // 一行一个事件：时间戳 + 事件名 + 受控 JSON
      expect(line).toMatch(/^\S+ [a-z_]+ \{.*\}$/);
    }
  }, 30_000);

  it("客户端 EOF 后服务落定退出，不挂住也不后台续发", async () => {
    const run = await runCli([DATA_DIR_FLAG, emptyRoot]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("server_ready");
  }, 30_000);
});

function readdirLength(dir: string): number {
  return readdirSync(dir).length;
}
