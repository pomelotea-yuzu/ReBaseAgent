import { describe, expect, it } from "vitest";
import type { CliRunResult, CliRunner } from "../src/docker/cli.js";
import {
  DockerMaterializationBackend,
  parseSha256SumLines,
} from "../src/docker/docker-materialize.js";
import {
  type ContainerWriteBackend,
  MATERIALIZATION_WORK_DIR,
  type MaterializationFileEntry,
  type VerifiedByteReader,
  manifestParentDirs,
  materializeVerificationSnapshot,
  sha256Bytes,
} from "../src/materialize/materialize.js";

const MIB = 1024 * 1024;

function entry(path: string, bytes: number, sha256?: string): MaterializationFileEntry {
  return { path, sha256: sha256 ?? sha256Bytes(new TextEncoder().encode(path)), bytes };
}

/** 内存容器：记录调用并按可注入缺陷模拟（仅覆盖编排，不代替真实门槛）。 */
class MemoryContainer implements ContainerWriteBackend {
  files = new Map<string, Uint8Array>();
  mkdirCalls: string[][] = [];
  writeCalls: Array<{ path: string; byteLength: number }> = [];
  shaCalls = 0;
  corruptWrittenPath: string | null = null;
  omitHashPaths = new Set<string>();
  failMkdir = false;
  failShaProbe = false;

  async mkdirAll(_containerRef: string, dirs: readonly string[]): Promise<void> {
    if (this.failMkdir) throw new Error("容器不可用（注入）");
    this.mkdirCalls.push([...dirs]);
  }

  async writeFile(_containerRef: string, containerPath: string, bytes: Uint8Array): Promise<void> {
    this.writeCalls.push({ path: containerPath, byteLength: bytes.length });
    this.files.set(
      containerPath,
      this.corruptWrittenPath === containerPath ? new TextEncoder().encode("corrupted!") : bytes,
    );
  }

  async sha256OfFiles(
    _containerRef: string,
    containerPaths: readonly string[],
  ): Promise<Map<string, string>> {
    this.shaCalls += 1;
    if (this.failShaProbe) throw new Error("sha256sum 无法执行（注入）");
    const map = new Map<string, string>();
    for (const path of containerPaths) {
      if (this.omitHashPaths.has(path)) continue;
      const stored = this.files.get(path);
      if (stored === undefined) continue;
      map.set(path, sha256Bytes(stored));
    }
    return map;
  }
}

function byteReader(
  contents: ReadonlyMap<string, Uint8Array>,
  failOn?: { path: string; code: "attachment_missing" | "attachment_corrupt" },
): VerifiedByteReader & { seen: string[] } {
  const reader = Object.assign(
    async (entry: MaterializationFileEntry) => {
      reader.seen.push(entry.path);
      if (failOn !== undefined && failOn.path === entry.path) {
        return { ok: false as const, code: failOn.code, reason: "注入失败" };
      }
      const bytes = contents.get(entry.path);
      if (bytes === undefined) {
        return { ok: false as const, code: "attachment_missing" as const, reason: "无内容" };
      }
      return { ok: true as const, bytes };
    },
    { seen: [] as string[] },
  );
  return reader;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("物化清单静态校验（3.3，P06/P09/W02 物化侧：验证先于一切写入）", () => {
  const cases: Array<[string, MaterializationFileEntry[]]> = [
    ["穿越路径（..）", [entry("../escape.ts", 1)]],
    ["嵌套穿越（src/../../x.ts）", [entry("src/../../x.ts", 1)]],
    ["点段（a/./b.ts）", [entry("a/./b.ts", 1)]],
    ["绝对路径（/abs.ts）", [entry("/abs.ts", 1)]],
    ["UNC/设备路径（//x/y）", [entry("//x/y", 1)]],
    ["反斜杠分隔符", [entry("src\\x.ts", 1)]],
    ["尾随斜杠", [entry("src/", 1)]],
    ["空段（连续斜杠）", [entry("src//x.ts", 1)]],
    ["冒号段（盘符/ADS 形态）", [entry("a:b.ts", 1)]],
    ["NUL 字符", [{ path: "a\0.ts", sha256: "a".repeat(64), bytes: 1 }]],
    ["精确重复路径", [entry("a.ts", 1), entry("a.ts", 2)]],
    ["NFC/大小写等价碰撞", [entry("A.ts", 1), entry("a.ts", 2)]],
  ];

  for (const [label, files] of cases) {
    it(`拒绝：${label}`, async () => {
      const backend = new MemoryContainer();
      const result = await materializeVerificationSnapshot({
        containerRef: "ctr",
        backend,
        files,
        readBytes: byteReader(new Map()),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["path_invalid", "path_collision"]).toContain(result.failure.code);
      }
      // 验证先于写入：零 exec、零写入
      expect(backend.writeCalls).toHaveLength(0);
      expect(backend.mkdirCalls).toHaveLength(0);
      expect(backend.shaCalls).toBe(0);
    });
  }

  it("拒绝：空清单 / 配额（文件数、单文件、合计）", async () => {
    const backend = new MemoryContainer();
    const empty = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: [],
      readBytes: byteReader(new Map()),
    });
    expect(!empty.ok && empty.failure.code).toBe("empty_manifest");

    const tooMany = Array.from({ length: 2001 }, (_, i) => entry(`src/f${String(i)}.ts`, 1));
    const count = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: tooMany,
      readBytes: byteReader(new Map()),
    });
    expect(!count.ok && count.failure.code).toBe("quota_exceeded");

    const bigFile = [entry("src/big.ts", 8 * MIB + 1)];
    const perFile = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: bigFile,
      readBytes: byteReader(new Map()),
    });
    expect(!perFile.ok && perFile.failure.code).toBe("quota_exceeded");

    const totalOver = Array.from({ length: 9 }, (_, i) =>
      entry(`src/t${String(i)}.ts`, 8 * MIB - 1024),
    );
    const total = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: totalOver,
      readBytes: byteReader(new Map()),
    });
    expect(!total.ok && total.failure.code).toBe("quota_exceeded");
    expect(backend.writeCalls).toHaveLength(0);
  });
});

describe("物化编排（3.3，P05/W01：字节逐项与清单一致）", () => {
  const calcBytes = utf8(
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  );
  const calcSha = sha256Bytes(calcBytes);
  const MANIFEST: MaterializationFileEntry[] = [
    { path: "src/calc.ts", sha256: calcSha, bytes: calcBytes.length },
    { path: "src/deep/extra.ts", sha256: calcSha, bytes: calcBytes.length },
  ];
  const CONTENT = new Map([
    ["src/calc.ts", calcBytes],
    ["src/deep/extra.ts", calcBytes],
  ]);

  it("成功：/work 下逐文件字节一致、目录先建、复核通过", async () => {
    const backend = new MemoryContainer();
    const result = await materializeVerificationSnapshot({
      containerRef: "ctr-x",
      backend,
      files: MANIFEST,
      readBytes: byteReader(CONTENT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileCount).toBe(2);
      expect(result.totalBytes).toBe(calcBytes.length * 2);
    }
    expect(backend.mkdirCalls).toEqual([["/work/src", "/work/src/deep"]]);
    expect(backend.writeCalls.map((call) => call.path)).toEqual([
      "/work/src/calc.ts",
      "/work/src/deep/extra.ts",
    ]);
    expect(backend.files.get("/work/src/calc.ts")).toEqual(calcBytes);
    expect(backend.files.get("/work/src/deep/extra.ts")).toEqual(calcBytes);
  });

  it("字节来源按清单序逐文件调用", async () => {
    const backend = new MemoryContainer();
    const reader = byteReader(CONTENT);
    await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: MANIFEST,
      readBytes: reader,
    });
    expect(reader.seen).toEqual(["src/calc.ts", "src/deep/extra.ts"]);
  });

  it("中途附件缺失：即停并指名文件（已写部分留在容器、不发布）", async () => {
    const backend = new MemoryContainer();
    const result = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: MANIFEST,
      readBytes: byteReader(CONTENT, { path: "src/deep/extra.ts", code: "attachment_missing" }),
    });
    expect(!result.ok && result.failure.code).toBe("attachment_missing");
    expect(backend.writeCalls).toHaveLength(1);
    expect(backend.shaCalls).toBe(0);
  });

  it("重读哈希不符（漂移）⇒ attachment_corrupt，零写入", async () => {
    const backend = new MemoryContainer();
    const wrongBytes = utf8("different content entirely");
    const result = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: [{ path: "src/calc.ts", sha256: calcSha, bytes: wrongBytes.length }],
      readBytes: byteReader(new Map([["src/calc.ts", wrongBytes]])),
    });
    expect(!result.ok && result.failure.code).toBe("attachment_corrupt");
    expect(backend.writeCalls).toHaveLength(0);
  });

  it("容器内哈希不符（写入损坏注入）⇒ materialization_mismatch 指名路径", async () => {
    const backend = new MemoryContainer();
    backend.corruptWrittenPath = "/work/src/calc.ts";
    const result = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: MANIFEST,
      readBytes: byteReader(CONTENT),
    });
    expect(!result.ok && result.failure.code).toBe("materialization_mismatch");
    if (!result.ok) {
      expect(result.failure.reason).toContain("src/calc.ts");
    }
  });

  it("复核哈希缺席（文件未出现在容器）⇒ materialization_mismatch", async () => {
    const backend = new MemoryContainer();
    backend.omitHashPaths.add("/work/src/deep/extra.ts");
    const result = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend,
      files: MANIFEST,
      readBytes: byteReader(CONTENT),
    });
    expect(!result.ok && result.failure.code).toBe("materialization_mismatch");
    if (!result.ok) {
      expect(result.failure.reason).toContain("extra.ts");
    }
  });

  it("基础设施失败：建目录失败 ⇒ write_failed；哈希探针失败 ⇒ hash_probe_failed", async () => {
    const failedMkdir = new MemoryContainer();
    failedMkdir.failMkdir = true;
    const mkdirResult = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend: failedMkdir,
      files: MANIFEST,
      readBytes: byteReader(CONTENT),
    });
    expect(!mkdirResult.ok && mkdirResult.failure.code).toBe("write_failed");

    const failedSha = new MemoryContainer();
    failedSha.failShaProbe = true;
    const shaResult = await materializeVerificationSnapshot({
      containerRef: "ctr",
      backend: failedSha,
      files: MANIFEST,
      readBytes: byteReader(CONTENT),
    });
    expect(!shaResult.ok && shaResult.failure.code).toBe("hash_probe_failed");
  });

  it("manifestParentDirs：根文件无父目录，嵌套路径去重保序", () => {
    expect(
      manifestParentDirs([
        entry("a.ts", 1),
        entry("src/x.ts", 1),
        entry("src/deep/y.ts", 1),
        entry("src/z.ts", 1),
      ]),
    ).toEqual(["src", "src/deep"]);
  });
});

describe("Docker 物化后端（3.3，注入 runner 的 argv/解析测试）", () => {
  const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };
  const ENDPOINT = "npipe:////./pipe/dockerDesktopLinuxEngine" as const;

  function okResult(stdout = "", exitCode = 0): CliRunResult {
    return {
      exitCode,
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      stdoutBytes: new TextEncoder().encode(""),
      stderrBytes: new TextEncoder().encode(""),
      stdoutTotalBytes: 0,
      stderrTotalBytes: 0,
      outputLimitHit: false,
      spawnError: null,
    };
  }

  function scriptedRunner(
    script: Array<(args: string[], stdin?: Uint8Array) => CliRunResult>,
  ): CliRunner {
    return async (_exePath, args, options) => {
      const step = script.shift();
      if (step === undefined) throw new Error(`unexpected CLI call: ${args.join(" ")}`);
      return step(args.slice(4), options.stdinBytes); // 去掉 --host npipe… 前缀再断言
    };
  }

  it("writeFile：exec -i tee + stdin 字节，路径为 argv（不经 Shell）", async () => {
    const calls: Array<{ args: string[]; stdin?: Uint8Array }> = [];
    const runner: CliRunner = async (_exePath, args, options) => {
      calls.push({ args: args.slice(4), stdin: options.stdinBytes }); // 去掉全局 2 项 + exec/-i
      return okResult("bytes-echo");
    };
    const backend = new DockerMaterializationBackend({ installation, endpoint: ENDPOINT, runner });
    await backend.writeFile("ctr-x", "/work/src/calc.ts", utf8("hello"));
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["ctr-x", "tee", "/work/src/calc.ts"]);
    expect(new TextDecoder().decode(calls[0].stdin)).toBe("hello");
  });

  it("mkdirAll：单批 argv 形态；sha256OfFiles：解析两空格行", async () => {
    const backend = new DockerMaterializationBackend({
      installation,
      endpoint: ENDPOINT,
      runner: scriptedRunner([
        (args) => {
          // scriptedRunner 已去掉全局 2 项 + exec + 容器名（共 4 项）
          expect(args).toEqual(["mkdir", "-p", "/work/src", "/work/src/deep"]);
          return okResult();
        },
        (args) => {
          expect(args[0]).toBe("sha256sum");
          return okResult(
            `d4cd6a706e1f5a13bd4caa0eb8fedbc7b7dfa1a4d2e1b1a0e2a04a9ac69f4b91  /work/src/calc.ts\n` +
              `0aa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1  /work/src/deep/extra.ts\n`,
          );
        },
      ]),
    });
    await backend.mkdirAll("ctr-x", ["/work/src", "/work/src/deep"]);
    const hashes = await backend.sha256OfFiles("ctr-x", [
      "/work/src/calc.ts",
      "/work/src/deep/extra.ts",
    ]);
    expect(hashes.get("/work/src/calc.ts")).toBe(
      "d4cd6a706e1f5a13bd4caa0eb8fedbc7b7dfa1a4d2e1b1a0e2a04a9ac69f4b91",
    );
    expect(hashes.get("/work/src/deep/extra.ts")).toBe(
      "0aa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
    );
  });

  it("sha256sum 个别文件缺失（exit 1 有部分输出）：保留部分结果，缺席由编排判", async () => {
    const backend = new DockerMaterializationBackend({
      installation,
      endpoint: ENDPOINT,
      runner: scriptedRunner([
        () =>
          okResult(
            `d4cd6a706e1f5a13bd4caa0eb8fedbc7b7dfa1a4d2e1b1a0e2a04a9ac69f4b91  /work/src/calc.ts\n`,
            1,
          ),
      ]),
    });
    const hashes = await backend.sha256OfFiles("ctr-x", ["/work/src/calc.ts", "/work/missing.ts"]);
    expect(hashes.size).toBe(1);
  });

  it("sha256sum 非零且无可解析输出 ⇒ 抛错（基础设施失败）", async () => {
    const backend = new DockerMaterializationBackend({
      installation,
      endpoint: ENDPOINT,
      runner: scriptedRunner([() => ({ ...okResult(), exitCode: 1, stderr: "container dead" })]),
    });
    await expect(backend.sha256OfFiles("ctr-x", ["/work/a.ts"])).rejects.toThrow("container dead");
  });

  it("argv 分批：超过 200 条按条数上限分批（Windows 命令行预算）", async () => {
    const batches: string[][] = [];
    const runner: CliRunner = async (_exePath, args) => {
      const rest = args.slice(4); // 去掉全局 2 项 + exec + 容器名
      if (rest[0] === "sha256sum") {
        batches.push(rest.slice(1));
      }
      return okResult("");
    };
    const backend = new DockerMaterializationBackend({ installation, endpoint: ENDPOINT, runner });
    const paths = Array.from({ length: 250 }, (_, i) => `/work/src/f${String(i)}.ts`);
    await backend.sha256OfFiles("ctr-x", paths);
    expect(batches).toHaveLength(2);
    expect(batches[0].length).toBe(200);
    expect(batches[1].length).toBe(50);
  });

  it("parseSha256SumLines：容忍 \\r 与空行，非哈希行忽略", () => {
    const hashA = "a".repeat(64);
    const hashB = "d".repeat(64);
    const map = parseSha256SumLines(
      `${hashA}  /work/a.ts\r\n\nxyz-not-hash\nabc  /work/bad.ts\n${hashB}  /work/b.ts\n`,
    );
    expect(map.size).toBe(2);
    expect(map.get("/work/a.ts")).toBe(hashA);
    expect(map.get("/work/b.ts")).toBe(hashB);
  });

  it("物化目标目录常量钉死 /work（design D5 布局）", () => {
    expect(MATERIALIZATION_WORK_DIR).toBe("/work");
  });
});
