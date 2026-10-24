import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ArtifactCollectionBackend,
  artifactGlobViolation,
  artifactsRecordEvent,
  collectArtifacts,
  matchesArtifactGlob,
} from "../src/collect/collect.js";
import { DockerCollectBackend, parseStatSizeLines } from "../src/docker/docker-collect.js";
import { assetPath } from "../src/records/layout.js";
import { NODE_TS_V1_PROFILE } from "../src/schema.js";

const tempRoots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "r3-pv-coll-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  // 临时目录交由系统清理
});

const ENDPOINT = "npipe:////./pipe/dockerDesktopLinuxEngine" as const;
const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function shaOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface FakeFile {
  path: string; // /work 相对路径
  bytes: Uint8Array;
  nonRegular?: boolean;
}

/**
 * 内存容器：每次扫描 = 「清单 + 哈希」两次调用；注入 mutateForSecondScan 时，
 * 第二次扫描起返回变异文件集（模拟仍在写）。
 */
class FakeCollectBackend implements ArtifactCollectionBackend {
  private callCount = 0;

  constructor(
    private readonly files: FakeFile[],
    private readonly mutateForSecondScan?: (files: FakeFile[]) => FakeFile[],
    private readonly corruptReadPath?: string,
  ) {}

  private active(): FakeFile[] {
    this.callCount += 1;
    if (this.mutateForSecondScan !== undefined && this.callCount > 2) {
      return this.mutateForSecondScan(this.files);
    }
    return this.files;
  }

  async listNonRegularObjects(): Promise<string[]> {
    return this.files
      .filter((file) => file.nonRegular === true)
      .map((file) => `/work/${file.path}`);
  }

  async listWorkFilesWithSizes(): Promise<Array<{ path: string; size: number }>> {
    return this.active()
      .filter((file) => file.nonRegular !== true)
      .map((file) => ({ path: file.path, size: file.bytes.length }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async sha256OfFiles(
    _containerRef: string,
    paths: readonly string[],
  ): Promise<Map<string, string>> {
    const round = this.active();
    const map = new Map<string, string>();
    for (const file of round) {
      map.set(`/work/${file.path}`, shaOf(file.bytes));
    }
    void paths;
    return map;
  }

  async readFile(_containerRef: string, path: string): Promise<Uint8Array> {
    const relative = path.slice("/work/".length);
    if (this.corruptReadPath === relative) {
      return utf8("tampered-in-transit");
    }
    const file = this.files.find((candidate) => candidate.path === relative);
    if (file === undefined) throw new Error(`missing ${path}`);
    return file.bytes;
  }
}

const CALC = utf8("export function add(a: number, b: number): number {\n  return a + b;\n}\n");
const COMPILED = utf8(
  "'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\n",
);
const TEMPLATE_TS = utf8("{}");

function baseFiles(): FakeFile[] {
  return [
    { path: "src/calc.ts", bytes: CALC },
    { path: "tsconfig.json", bytes: TEMPLATE_TS },
    { path: "package.json", bytes: utf8('{"name":"x"}') },
    { path: ".build/src/calc.js", bytes: COMPILED },
  ];
}

function inputManifest() {
  return [
    { path: "src/calc.ts", sha256: shaOf(CALC) },
    { path: "tsconfig.json", sha256: shaOf(TEMPLATE_TS) },
    { path: "package.json", sha256: shaOf(utf8('{"name":"x"}')) },
  ];
}

function collect(backend: ArtifactCollectionBackend, dataRoot = newRoot()) {
  return collectArtifacts({
    containerRef: "ctr-x",
    backend,
    dataRoot,
    profile: NODE_TS_V1_PROFILE,
    inputManifest: inputManifest(),
    stabilityIntervalMs: 10,
  });
}

describe("产物 glob 匹配（3.6）", () => {
  it("目录前缀任意深度命中；后缀形态命中；精确路径命中", () => {
    expect(matchesArtifactGlob(".build/src/calc.js", ".build/**")).toBe(true);
    expect(matchesArtifactGlob(".build/a/b/c.js", ".build/**")).toBe(true);
    expect(matchesArtifactGlob("build/src/calc.js", ".build/**")).toBe(false);
    expect(matchesArtifactGlob("cache.tmp", "**/*.tmp")).toBe(true);
    expect(matchesArtifactGlob("a/b/cache.tmp", "**/*.tmp")).toBe(true);
    expect(matchesArtifactGlob("a/b/cache.txt", "**/*.tmp")).toBe(false);
    expect(matchesArtifactGlob("out.txt", "out.txt")).toBe(true);
  });

  it("未知 glob 形态在清单校验时拒绝", () => {
    expect(artifactGlobViolation(".build/**")).toBeNull();
    expect(artifactGlobViolation("**/*.tmp")).toBeNull();
    expect(artifactGlobViolation("out.txt")).toBeNull();
    expect(artifactGlobViolation("a/*b/**")).not.toBeNull();
    expect(artifactGlobViolation("**/a/*/c")).not.toBeNull();
  });
});

describe("静止采集（3.6，P17/P18/W01）", () => {
  it("成功：输入不变 + .build 产物发布 + stray 如实计数（不发布）", async () => {
    const dataRoot = newRoot();
    const backend = new FakeCollectBackend([
      ...baseFiles(),
      { path: "stray-note.txt", bytes: utf8("workload 留下的杂散对象") },
    ]);
    const result = await collect(backend, dataRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entries.map((entry) => entry.path)).toEqual([".build/src/calc.js"]);
    expect(result.entries[0]?.sha256).toBe(shaOf(COMPILED));
    expect(result.totalBytes).toBe(COMPILED.length);
    expect(result.uniqueContentBytes).toBe(COMPILED.length);
    expect(result.strayCount).toBe(1);
    // 内容寻址发布落盘
    const publishedPath = assetPath(dataRoot, shaOf(COMPILED));
    expect(existsSync(publishedPath)).toBe(true);
    expect(new Uint8Array(readFileSync(publishedPath))).toEqual(COMPILED);
    // 事件构造过 schema（excludedPatterns = manifest 规则本身）
    const event = artifactsRecordEvent(result, NODE_TS_V1_PROFILE);
    expect(event.type).toBe("artifacts");
    if (event.type === "artifacts") {
      expect(event.entries).toHaveLength(1);
      expect(event.excludedPatterns).toEqual(["node_modules/**", "**/*.tmp"]);
    }
  });

  it("输入被 workload 修改 ⇒ input_drifted（改代码冒充修复，P18/W01）", async () => {
    const tampered = utf8(
      "export function add(a: number, b: number): number {\n  return 42; // 改源码\n}\n",
    );
    const backend = new FakeCollectBackend([
      ...baseFiles().map((file) =>
        file.path === "src/calc.ts" ? { ...file, bytes: tampered } : file,
      ),
    ]);
    const result = await collect(backend);
    expect(!result.ok && result.failure.code).toBe("input_drifted");
    if (!result.ok) {
      expect(result.failure.reason).toContain("src/calc.ts");
    }
  });

  it("存在链接/特殊对象 ⇒ artifact_invalid（不静默跟随）", async () => {
    const backend = new FakeCollectBackend([
      ...baseFiles(),
      { path: "evil-link", bytes: utf8(""), nonRegular: true },
    ]);
    const result = await collect(backend);
    expect(!result.ok && result.failure.code).toBe("artifact_invalid");
    if (!result.ok) {
      expect(result.failure.reason).toContain("链接或特殊对象");
    }
  });

  it("两次扫描不一致（仍在写）⇒ artifact_invalid（P17/P18）", async () => {
    const backend = new FakeCollectBackend(baseFiles(), (files) =>
      files.map((file) =>
        file.path === ".build/src/calc.js" ? { ...file, bytes: utf8("growing...") } : file,
      ),
    );
    const result = await collect(backend);
    expect(!result.ok && result.failure.code).toBe("artifact_invalid");
    if (!result.ok) {
      expect(result.failure.reason).toContain("两次采集不一致");
    }
  });

  it("宿主重读与容器扫描不一致 ⇒ content_corrupt，拒绝发布", async () => {
    const backend = new FakeCollectBackend(baseFiles(), undefined, ".build/src/calc.js");
    const result = await collect(backend);
    expect(!result.ok && result.failure.code).toBe("content_corrupt");
  });

  it("产物唯一内容超 128 MiB 预算 ⇒ quota_exceeded", async () => {
    const big = new Uint8Array(NODE_TS_V1_PROFILE.limits.artifactUniqueContentBudgetBytes + 1);
    const backend = new FakeCollectBackend([{ path: ".build/big.js", bytes: big }]);
    const result = await collect(backend);
    expect(!result.ok && result.failure.code).toBe("quota_exceeded");
  });

  it("include 之外的对象不发布（stray 计数）；exclude 命中的 include 对象被排除", async () => {
    const dataRoot = newRoot();
    const backend = new FakeCollectBackend([
      { path: ".build/x.js", bytes: utf8("ok") },
      { path: ".build/tmp-cache.tmp", bytes: utf8("excluded") },
      { path: "loose.txt", bytes: utf8("stray") },
    ]);
    const result = await collect(backend, dataRoot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((entry) => entry.path)).toEqual([".build/x.js"]);
      expect(result.excludedCount).toBe(1);
      expect(result.strayCount).toBe(1);
    }
  });
});

describe("Docker 采集后端（3.6，注入 runner 的 argv 测试）", () => {
  function okResult(stdout = "") {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      spawnError: null,
      stdoutBytes: new TextEncoder().encode(stdout),
      stderrBytes: new Uint8Array(),
      stdoutTotalBytes: stdout.length,
      stderrTotalBytes: 0,
      outputLimitHit: false,
    };
  }

  it("find 双形态 + stat 批量 + sha256sum 解析", async () => {
    const calls: string[][] = [];
    const runner = async (_exePath: string, args: string[]) => {
      const rest = args.slice(2);
      calls.push(rest);
      if (rest[2] === "find" && rest.includes("!")) {
        return okResult("");
      }
      if (rest[2] === "find") {
        return okResult("/work/.build/src/calc.js\n");
      }
      if (rest[2] === "stat") {
        return okResult("/work/.build/src/calc.js 128");
      }
      if (rest[2] === "sha256sum") {
        return okResult(`${"b".repeat(64)}  /work/.build/src/calc.js\n`);
      }
      if (rest[2] === "cat") {
        return okResult("COMPILED-BYTES");
      }
      throw new Error(`unexpected: ${rest.join(" ")}`);
    };
    const backend = new DockerCollectBackend({ installation, endpoint: ENDPOINT, runner });
    expect(await backend.listNonRegularObjects("ctr-x")).toEqual([]);
    const files = await backend.listWorkFilesWithSizes("ctr-x");
    expect(files).toEqual([{ path: ".build/src/calc.js", size: 128 }]);
    const hashes = await backend.sha256OfFiles("ctr-x", ["/work/.build/src/calc.js"]);
    expect(hashes.get("/work/.build/src/calc.js")).toBe("b".repeat(64));
    const bytes = await backend.readFile("ctr-x", "/work/.build/src/calc.js");
    expect(new TextDecoder().decode(bytes)).toBe("COMPILED-BYTES");
    // 命令形态：argv 直传（不经 Shell）
    expect(calls[1]).toEqual(["exec", "ctr-x", "find", "/work", "-type", "f"]);
    expect(calls[2]).toEqual(["exec", "ctr-x", "stat", "-c", "%n %s", "/work/.build/src/calc.js"]);
    expect(calls[3]).toEqual(["exec", "ctr-x", "sha256sum", "/work/.build/src/calc.js"]);
    expect(calls[4]).toEqual(["exec", "ctr-x", "cat", "/work/.build/src/calc.js"]);
  });

  it("parseStatSizeLines：容忍 \\r/空行，跳过坏行", () => {
    const map = parseStatSizeLines("/work/a.ts 140\r\n\nbadline\n/work/b.ts 10\n");
    expect(map.get("/work/a.ts")).toBe(140);
    expect(map.get("/work/b.ts")).toBe(10);
    expect(map.size).toBe(2);
  });

  it("cat 截断（超单文件上限）⇒ 抛错", async () => {
    const runner = async () => {
      const big = "x".repeat(16);
      return {
        ...okResult(big),
        stdoutTruncated: true,
        stdoutBytes: new TextEncoder().encode(big.slice(0, 8)),
        stdoutTotalBytes: 16,
      };
    };
    const backend = new DockerCollectBackend({
      installation,
      endpoint: ENDPOINT,
      runner,
      readFileMaxBytes: 8,
    });
    await expect(backend.readFile("ctr-x", "/work/big.js")).rejects.toThrow("单文件读取上限");
  });
});
