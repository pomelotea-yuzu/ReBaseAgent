import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/facts.js";
import { getVerification, listVerifications } from "../src/read.js";
import { VerificationRecordWriter } from "../src/records/writer.js";

/**
 * V01 只读入口闭包（MCP2 tasks 1.1）：read/facts 子入口的静态导入图不得触达
 * 执行/写入模块（design D1），且在无 Electron/Docker 的纯 Node 进程可读历史记录。
 */

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** design D1 禁止出现在 read/facts 闭包内的模块（相对 src/ 的路径）。 */
const FORBIDDEN = [
  "records/writer.ts",
  "records/append.ts",
  "records/assets.ts",
  "source/",
  "trusted-env/",
  "prepare/",
  "materialize/",
  "execute/",
  "collect/",
  "runtime/",
  "orchestrate/",
  "docker/",
];

// import ... from "..." / export ... from "..." / side-effect import "..."
const IMPORT_RES = [
  /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
];

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const re of IMPORT_RES) {
    for (const match of text.matchAll(re)) {
      specs.push(match[1] ?? "");
    }
  }
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // node:*/zod 等外部依赖不入图
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ".ts"));
  const candidates = spec.endsWith(".js")
    ? [base]
    : [`${base}.ts`, join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error(`read/facts 闭包内有未解析的相对导入：${spec}（来自 ${fromFile}）`);
}

function closureOf(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const local = resolveLocal(file, spec);
      if (local !== null) queue.push(local);
    }
  }
  return [...seen];
}

function assertNoForbidden(entry: string) {
  const graph = closureOf(entry);
  const violations = graph.flatMap((file) => {
    const rel = file.slice(srcDir.length + 1).replaceAll("\\", "/");
    return FORBIDDEN.filter((bad) => rel.startsWith(bad)).map((bad) => rel);
  });
  expect(violations, `${entry} 闭包触达禁止模块：${violations.join(", ")}`).toEqual([]);
  expect(graph.length).toBeGreaterThan(1);
}

describe("read/facts 闭包（V01/design D1）", () => {
  it("read 子入口导入图不含 writer/append/assets 发布/prepare/execute/runtime/docker 等", () => {
    assertNoForbidden(join(srcDir, "read.ts"));
  });

  it("facts 子入口导入图不含任何执行/写入模块", () => {
    assertNoForbidden(join(srcDir, "facts.ts"));
  });
});

describe("read 子入口在纯 Node 进程读历史记录（V01）", () => {
  function newRoot(): string {
    return mkdtempSync(join(tmpdir(), "mcp2-read-"));
  }

  it("密封记录可经 read 入口完整读取", () => {
    const root = newRoot();
    const writer = VerificationRecordWriter.open(root, {
      verificationId: "ver_mcp2r1",
      epoch: "ep_1",
      operationId: "op_1",
      target: { runId: "run_mcp2r1", checkpoint: { kind: "initial" }, snapshotId: "snap_1" },
      profileId: "node-ts-v1",
      manifestVersion: 1,
      commandId: "test",
      planBindingDigest: "a".repeat(64),
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    writer.terminate({
      outcome: "passed",
      detail: "tests 1 pass 1",
      evidenceComplete: true,
      at: "2026-10-25T00:00:01.000Z",
    });

    const record = getVerification(root, "ver_mcp2r1");
    expect(record.status).toBe("sealed");
    expect(record.terminated?.outcome).toBe("passed");
    expect(listVerifications(root)).toHaveLength(1);
  });

  it("facts 入口给出纯数据规范化与摘要", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
