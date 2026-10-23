import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * MCP0 5.4 的结构半边（共享读取层）：`packages/run-query` 的已构建工件没有写盘/执行调用面。
 *
 * Q15 写在 run-query 规格里，所以这条判据也必须在 run-query 自己家守：
 * MCP 侧的同形状用例见 `packages/mcp-server/test/closure.test.ts`，两边合起来才是
 * "模型/工具/导出/operation 计数为零"的工件证据（端到端指纹是另一半，见 zero-write.test.ts）。
 *
 * 边界如实声明：扫的是本包 dist/src 的 import 说明符与调用点，**不**递归进
 * `@rebaseagent/replay` / `@rebaseagent/trace-sdk` 的内部实现（它们各自有写能力模块，
 * 但本包不引用那些导出名 —— 下面第三条用例钉的就是这件事）。
 */

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const DIST_DIR = fileURLToPath(new URL("../dist", import.meta.url));

/** 实测到的外部依赖封闭集（`.workbuddy/mcp0-54/probe-closure.cjs`） */
const EXPECTED_EXTERNAL = [
  "@rebaseagent/replay",
  "@rebaseagent/trace-sdk",
  "@rebaseagent/trace-sdk/fs-boundary",
  "@rebaseagent/trace-sdk/schema",
  "node:fs",
  "node:path",
  "zod",
].sort();

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

/** 写能力导出名：出现即意味着"这条读取链有能力改历史" */
const WRITE_CAPABLE = [
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
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(
      `${dir} 读不到：本用例扫的是已构建工件，跑测试前必须先 tsc -p tsconfig.json 产出 dist`,
    );
  }
  const out: string[] = [];
  for (const name of names) {
    const absolute = `${dir}/${name}`.replace(/\/+/g, "/");
    if (statSync(absolute).isDirectory()) out.push(...filesWith(absolute, extension));
    else if (name.endsWith(extension)) out.push(absolute);
  }
  return out;
}

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

function externalOf(files: string[]): string[] {
  const set = new Set<string>();
  for (const file of files) {
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) set.add(specifier);
    }
  }
  return [...set].sort();
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("run-query 依赖闭包与调用面（Q15 结构半边）", () => {
  it("dist 的外部依赖恰好是实测那七个说明符", () => {
    const js = filesWith(DIST_DIR, ".js");
    expect(js.length).toBeGreaterThan(15);
    expect(externalOf(js)).toEqual(EXPECTED_EXTERNAL);
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
    for (const banned of [...EXEC_NET, ...WRITE_CAPABLE]) {
      const hits = corpus.reduce((total, text) => total + occurrences(text, banned), 0);
      expect(`「${banned}」出现次数=${String(hits)}`).toBe(`「${banned}」出现次数=0`);
    }
  });

  it("本包不反向依赖 desktop / Electron / MCP（D2 的依赖方向）", () => {
    const external = externalOf(filesWith(DIST_DIR, ".js"));
    expect(external.some((item) => /electron|desktop|mcp-server/.test(item))).toBe(false);
  });
});
