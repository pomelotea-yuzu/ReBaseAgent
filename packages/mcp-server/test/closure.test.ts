import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * MCP0 5.4 的结构半边：本包**已构建工件**的依赖闭包与调用面（Q15 的"计数为零"）。
 *
 * 为什么单独成文件：端到端指纹证明"这次查询没写盘"，而这条证明"这个服务**没有**写盘/执行/
 * 出网的调用面"——两者互为补充，缺一个就是半证。数字来自实测
 * （`.workbuddy/mcp0-54/probe-closure.cjs`），新增外部依赖或写盘调用会直接翻红。
 *
 * 边界如实声明：本扫描覆盖 `packages/mcp-server` 自身的 src/dist 与其直接 import 的说明符；
 * **不**递归进 `@modelcontextprotocol/sdk` 与 `@rebaseagent/*` 的内部实现（那是各自包的职责，
 * run-query 用同形状的用例守自己那份）。
 */

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const DIST_DIR = fileURLToPath(new URL("../dist", import.meta.url));

/** 实测到的外部依赖封闭集（相对/内部模块另计） */
const EXPECTED_EXTERNAL = [
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js",
  "@modelcontextprotocol/sdk/types.js",
  "@rebaseagent/run-query",
  "node:crypto",
  "node:fs",
  "node:path",
  "zod",
].sort();

/** 写盘 API：只读服务里一个都不该出现（stderr 的 `process.stderr.write` 不在此列） */
const WRITE_APIS = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "mkdtempSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "createWriteStream",
  "copyFileSync",
  "renameSync",
  "chmodSync",
  "utimesSync",
  "writeSync",
];

/** 执行/出网能力：MCP0 只读诊断不该有以任何一种（D3/D8） */
const EXEC_NET = [
  "node:child_process",
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
  "node:tls",
  "node:worker_threads",
  "node:vm",
  "node:cluster",
  "fetch(",
  "spawn(",
  "execFile(",
];

/** 写能力导出名：出现在本包调用面里就意味着"能改历史" */
const WRITE_CAPABLE_EXPORTS = [
  "JsonlTracer",
  "publishBlob",
  "import-source",
  "createWorkspaceSnapshot",
  "startRun",
  "endRun",
  "startSpan",
  "endSpan",
];

function filesWith(dir: string, extension: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(
      `${dir} 读不到：本用例扫的是已构建工件，跑测试前必须先 tsc -p tsconfig.json 产出 dist`,
    );
  }
  const out: string[] = [];
  for (const name of entries) {
    const absolute = `${dir}/${name}`.replace(/\/+/g, "/");
    const stat = statSync(absolute);
    if (stat.isDirectory()) out.push(...filesWith(absolute, extension));
    else if (name.endsWith(extension)) out.push(absolute);
  }
  return out;
}

/** 只认规范 emit 形态的 import/export 语句，避免把正文里的 `from` 读成说明符 */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fromClause = line.match(/^(?:import|export)\b.*\bfrom\s+["']([^"']+)["'];?\s*$/);
    if (fromClause?.[1] !== undefined) {
      out.push(fromClause[1]);
      continue;
    }
    const bare = line.match(/^import\s+["']([^"']+)["'];?\s*$/);
    if (bare?.[1] !== undefined) out.push(bare[1]);
    const dynamic = line.match(/\bimport\(\s*["']([^"']+)["']\s*\)/);
    if (dynamic?.[1] !== undefined) out.push(dynamic[1]);
  }
  return out;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("依赖闭包与调用面（Q15 结构半边）", () => {
  it("dist 的外部依赖恰好是实测那九个说明符（多一个就翻红）", () => {
    const js = filesWith(DIST_DIR, ".js");
    expect(js.length).toBeGreaterThan(20);
    const external = new Set<string>();
    for (const file of js) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual(EXPECTED_EXTERNAL);
  });

  it("src 与 dist 都没有任何写盘 API 调用点", () => {
    const corpus = [...filesWith(DIST_DIR, ".js"), ...filesWith(SRC_DIR, ".ts")].map((file) =>
      readFileSync(file, "utf8"),
    );
    for (const api of WRITE_APIS) {
      const hits = corpus.reduce((total, text) => total + occurrences(text, api), 0);
      expect(`${api} 调用点=${String(hits)}`).toBe(`${api} 调用点=0`);
    }
  });

  it("src 与 dist 都不碰执行/出网能力，也不引用任何写能力导出", () => {
    const corpus = [...filesWith(DIST_DIR, ".js"), ...filesWith(SRC_DIR, ".ts")].map((file) =>
      readFileSync(file, "utf8"),
    );
    for (const banned of [...EXEC_NET, ...WRITE_CAPABLE_EXPORTS]) {
      const hits = corpus.reduce((total, text) => total + occurrences(text, banned), 0);
      expect(`「${banned}」出现次数=${String(hits)}`).toBe(`「${banned}」出现次数=0`);
    }
  });

  it("本包唯一的共享读取依赖是 run-query，不直连 replay/trace-sdk/desktop/Electron", () => {
    const js = filesWith(DIST_DIR, ".js");
    const external = new Set<string>();
    for (const file of js) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (!specifier.startsWith(".")) external.add(specifier);
      }
    }
    const rebaseagent = [...external].filter((item) => item.startsWith("@rebaseagent/"));
    expect(rebaseagent).toEqual(["@rebaseagent/run-query"]);
    expect([...external].some((item) => /electron|apps\/desktop/.test(item))).toBe(false);
  });
});
