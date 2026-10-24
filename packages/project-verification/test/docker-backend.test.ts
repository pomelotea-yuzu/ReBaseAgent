import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CliRunResult,
  type CliRunner,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_BYTES,
  controlledCliEnv,
  defaultCliRunner,
  defaultDockerCliCandidates,
  dockerVersionArgv,
  pinnedGlobalArgs,
  resolveDockerCli,
} from "../src/docker/cli.js";
import { containerRunFlags } from "../src/docker/container-flags.js";
import {
  DockerPreparationBackend,
  PreparationBackendError,
  extractSemanticVersion,
  writeBuildContext,
} from "../src/docker/docker-backend.js";
import {
  classifyDockerConnectionError,
  parseDockerVersionJson,
  preflightLocalBackend,
} from "../src/docker/preflight.js";
import type { TrustedEnvironmentBuildRequest } from "../src/prepare/backend.js";
import { NODE_TS_V1_PROFILE } from "../src/schema.js";
import { NODE_TS_V1_BUILD_ASSETS, verifyNodeTsV1Assets } from "../src/trusted-env/node-ts-v1.js";

const tempRoots: string[] = [];

function newTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "r3-pv-docker-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  // 临时目录交由系统清理
});

const ENDPOINT = "npipe:////./pipe/dockerDesktopLinuxEngine" as const;

describe("受控 CLI 原语（3.2，P01/P02/P09 静态面）", () => {
  it("resolveDockerCli 只认候选绝对路径，全不在场返回 null（不扫 PATH）", () => {
    const missing = resolveDockerCli(["Z:\\不存在\\docker.exe"]);
    expect(missing).toBeNull();
    expect(defaultDockerCliCandidates().length).toBeGreaterThanOrEqual(2);
    for (const candidate of defaultDockerCliCandidates()) {
      // 候选必须是绝对路径（不依赖 PATH 解析）
      expect(candidate).toMatch(/^[A-Za-z]:\\/);
      expect(candidate.endsWith("docker.exe")).toBe(true);
    }
  });

  it("受控 env 完全替换：敌意宿主变量（DOCKER_HOST/代理/密钥）不可达 CLI（P02）", () => {
    const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };
    const hostileEnv: NodeJS.ProcessEnv = {
      DOCKER_HOST: "tcp://127.0.0.1:2375",
      HTTP_PROXY: "http://evil.example:8080",
      SECRET_API_KEY: "leak-me",
      SystemRoot: "C:\\WINDOWS",
      USERPROFILE: "C:\\Users\\tester",
    };
    const env = controlledCliEnv(installation, hostileEnv);
    expect(env).toEqual({
      PATH: "C:\\x\\bin",
      SystemRoot: "C:\\WINDOWS",
      USERPROFILE: "C:\\Users\\tester",
    });
  });

  it("endpoint 钉死进 argv（--host），不依赖 env/context 解析顺序", () => {
    expect(pinnedGlobalArgs(ENDPOINT)).toEqual(["--host", ENDPOINT]);
    expect(dockerVersionArgv(ENDPOINT)).toEqual([
      "--host",
      ENDPOINT,
      "version",
      "--format",
      "{{json .}}",
    ]);
  });
});

describe("CLI 运行器默认实现（字节上限 + 超时）", () => {
  it("超长输出按字节截断且内存有界", async () => {
    const result = await defaultCliRunner(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100))"],
      {
        env: {},
        timeoutMs: 30_000,
        stdoutMaxBytes: 10,
        stderrMaxBytes: 10,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(10);
    expect(result.stdoutTruncated).toBe(true);
  });

  it("spawn 失败（不存在的可执行文件）进 spawnError 而非抛异常", async () => {
    const result = await defaultCliRunner("Z:\\nope\\missing.exe", ["version"], {
      env: {},
      timeoutMs: 30_000,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    });
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).not.toBeNull();
  });
});

describe("后端预检（3.2，P01/P02）", () => {
  const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };

  function cannedRunner(
    script: Array<(exePath: string, args: string[]) => CliRunResult>,
  ): CliRunner & {
    calls: Array<{ exePath: string; args: string[]; env: Record<string, string> }>;
  } {
    const runner = Object.assign(
      async (exePath: string, args: string[]) => {
        const step = script[runner.calls.length];
        runner.calls.push({ exePath, args, env: {} });
        if (step === undefined) throw new Error("unexpected extra CLI call");
        return step(exePath, args);
      },
      { calls: [] as Array<{ exePath: string; args: string[]; env: Record<string, string> }> },
    );
    return runner;
  }

  const GOOD_VERSION = JSON.stringify({
    Client: { Version: "29.9.2", Os: "windows", Arch: "amd64" },
    Server: { Version: "29.9.2", Os: "linux", Arch: "amd64", ApiVersion: "1.52" },
  });

  it("endpoint 不在枚举内：不发起调用即拒绝（P02）", async () => {
    const runner = cannedRunner([]);
    const result = await preflightLocalBackend({
      installation,
      endpoint: "tcp://127.0.0.1:2375" as never,
      runner,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BACKEND_REMOTE_REFUSED");
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("spawn ENOENT ⇒ BACKEND_MISSING（不隐式安装，P01）", async () => {
    const runner = cannedRunner([
      () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        stdoutBytes: new TextEncoder().encode(""),
        stderrBytes: new TextEncoder().encode(""),
        stdoutTotalBytes: 0,
        stderrTotalBytes: 0,
        outputLimitHit: false,
        spawnError: { code: "ENOENT", message: "spawn ENOENT" },
      }),
    ]);
    const result = await preflightLocalBackend({ installation, endpoint: ENDPOINT, runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BACKEND_MISSING");
      expect(result.reason).toContain("无法启动");
    }
  });

  it("管道连接失败形态 ⇒ BACKEND_MISSING（reason 注明不可达）", async () => {
    const runner = cannedRunner([
      () => ({
        exitCode: 1,
        stdout: "",
        stderr:
          "error during connect: in the default daemon configuration on Windows, the docker client must be run with elevated privileges to connect: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        stdoutBytes: new TextEncoder().encode(""),
        stderrBytes: new TextEncoder().encode(""),
        stdoutTotalBytes: 0,
        stderrTotalBytes: 0,
        outputLimitHit: false,
        spawnError: null,
      }),
    ]);
    const result = await preflightLocalBackend({ installation, endpoint: ENDPOINT, runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BACKEND_MISSING");
      expect(result.reason).toContain("不可达");
    }
  });

  it("服务端平台漂移（windows 容器模式）⇒ BACKEND_DRIFT（P02）", async () => {
    const runner = cannedRunner([
      () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          Client: { Version: "29.9.2", Os: "windows", Arch: "amd64" },
          Server: { Version: "29.9.2", Os: "windows", Arch: "amd64", ApiVersion: "1.52" },
        }),
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
      }),
    ]);
    const result = await preflightLocalBackend({ installation, endpoint: ENDPOINT, runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BACKEND_DRIFT");
      expect(result.reason).toContain("windows/amd64");
    }
  });

  it("预检通过返回事实（linux/amd64 + 版本），且走受控 env 与钉死 endpoint", async () => {
    const runner = cannedRunner([
      (exePath, args) => {
        expect(exePath).toBe(installation.exePath);
        expect(args).toEqual(dockerVersionArgv(ENDPOINT));
        return {
          exitCode: 0,
          stdout: GOOD_VERSION,
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
      },
    ]);
    const result = await preflightLocalBackend({ installation, endpoint: ENDPOINT, runner });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts.serverVersion).toBe("29.9.2");
      expect(result.facts.osType).toBe("linux");
      expect(result.facts.arch).toBe("amd64");
    }
  });

  it("连接错误形态分类：已知形态可识别，垃圾文本不可识别", () => {
    expect(
      classifyDockerConnectionError(
        "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified",
      ),
    ).toBe("unreachable");
    expect(classifyDockerConnectionError("some unrelated failure")).toBeNull();
  });

  it("version JSON 解析：正常 / Server 缺失 / 垃圾输出", () => {
    const good = parseDockerVersionJson(GOOD_VERSION);
    expect(good.clientVersion).toBe("29.9.2");
    expect(good.server?.osType).toBe("linux");
    expect(parseDockerVersionJson("{}").server).toBeNull();
    expect(parseDockerVersionJson("not json").clientVersion).toBeNull();
  });
});

describe("manifest → 容器旗标映射（3.2，P10 静态面）", () => {
  it("冻结 manifest 产生确定的旗标序列（安全/限额/无 swap/tmpfs/禁重启/禁日志持久化）", () => {
    const flags = containerRunFlags(NODE_TS_V1_PROFILE);
    expect(flags).toEqual([
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--memory",
      "536870912",
      "--memory-swap",
      "536870912",
      "--pids-limit",
      "64",
      "--cpus",
      "1",
      "--tmpfs",
      "/work:size=167772160,mode=1777",
      "--tmpfs",
      "/tmp:size=33554432,mode=1777",
      "--restart",
      "no",
      "--log-driver",
      "none",
    ]);
  });

  it("旗标值只来自 manifest 字段（memory-swap==memory 即无 swap；tmpfs 字节数精确）", () => {
    const flags = containerRunFlags(NODE_TS_V1_PROFILE);
    const memoryIndex = flags.indexOf("--memory");
    const swapIndex = flags.indexOf("--memory-swap");
    expect(flags[swapIndex + 1]).toBe(flags[memoryIndex + 1]);
    expect(flags).toContain(
      `/work:size=${String(NODE_TS_V1_PROFILE.limits.workTmpfsBytes)},mode=1777`,
    );
    expect(flags).toContain(
      `/tmp:size=${String(NODE_TS_V1_PROFILE.limits.tmpTmpfsBytes)},mode=1777`,
    );
    expect(flags).not.toContain("--init");
  });
});

describe("DockerPreparationBackend（3.2，注入 runner 的编排测试）", () => {
  const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };
  const GOOD_VERSION_OUTPUT = JSON.stringify({
    Client: { Version: "29.9.2", Os: "windows", Arch: "amd64" },
    Server: { Version: "29.9.2", Os: "linux", Arch: "amd64", ApiVersion: "1.52" },
  });

  function okResult(stdout = ""): CliRunResult {
    return {
      exitCode: 0,
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

  function scriptedRunner(script: Array<(args: string[]) => CliRunResult>): CliRunner {
    return async (_exePath, args) => {
      const step = script.shift();
      if (step === undefined) throw new Error(`unexpected CLI call: ${args.join(" ")}`);
      return step(args);
    };
  }

  function request(): TrustedEnvironmentBuildRequest {
    return { profile: NODE_TS_V1_PROFILE, assets: NODE_TS_V1_BUILD_ASSETS };
  }

  function happyScript(): Array<(args: string[]) => CliRunResult> {
    return [
      (args) => {
        expect(args).toEqual(dockerVersionArgv(ENDPOINT)); // 预检：钉死 endpoint
        return okResult(GOOD_VERSION_OUTPUT);
      },
      (args) => {
        // 构建：全局旗标在前、--platform/--tag 在场、末位是上下文目录
        expect(args.slice(0, 2)).toEqual(pinnedGlobalArgs(ENDPOINT));
        expect(args).toContain("build");
        expect(args).toContain("--platform");
        expect(args).toContain("linux/amd64");
        expect(args.filter((a) => a === "--tag").length).toBe(1);
        return okResult("# build done");
      },
      (args) => {
        // inspect：Id|Os|Arch
        expect(args.slice(-1)[0]).toContain("{{.Id}}");
        return okResult(`sha256:${"b".repeat(64)}|linux|amd64`);
      },
      () => okResult("v22.23.4\n"), // node --version
      () => okResult("Version 5.9.3\n"), // tsc --version
    ];
  }

  it("构建成功：返回实测工具链与镜像摘要；networkUsed=true、downloadedBytes=null（测不得≠0）", async () => {
    const tempRoot = newTempRoot();
    const backend = new DockerPreparationBackend({
      installation,
      endpoint: ENDPOINT,
      tempRoot,
      runner: scriptedRunner(happyScript()),
    });
    const outcome = await backend.buildTrustedEnvironment(request());
    expect(outcome.imageDigest).toBe(`sha256:${"b".repeat(64)}`);
    expect(outcome.toolchain).toEqual({ node: "22.23.4", typescript: "5.9.3" });
    expect(outcome.networkUsed).toBe(true);
    expect(outcome.downloadedBytes).toBeNull();
  });

  it("构建产物平台漂移（windows 容器模式镜像）⇒ BACKEND_DRIFT 拒绝（P02）", async () => {
    const tempRoot = newTempRoot();
    const backend = new DockerPreparationBackend({
      installation,
      endpoint: ENDPOINT,
      tempRoot,
      runner: scriptedRunner([
        () => okResult(GOOD_VERSION_OUTPUT),
        () => okResult("# build done"),
        () => okResult(`sha256:${"b".repeat(64)}|windows|amd64`),
      ]),
    });
    await expect(backend.buildTrustedEnvironment(request())).rejects.toMatchObject({
      code: "BACKEND_DRIFT",
    });
  });

  it("工具链实测 ≠ manifest 冻结值 ⇒ BACKEND_DRIFT（实测收紧为一致才放行）", async () => {
    const tempRoot = newTempRoot();
    const backend = new DockerPreparationBackend({
      installation,
      endpoint: ENDPOINT,
      tempRoot,
      runner: scriptedRunner([
        () => okResult(GOOD_VERSION_OUTPUT),
        () => okResult("# build done"),
        () => okResult(`sha256:${"b".repeat(64)}|linux|amd64`),
        () => okResult("v24.0.0\n"), // node 漂移
        () => okResult("Version 5.9.3\n"),
      ]),
    });
    await expect(backend.buildTrustedEnvironment(request())).rejects.toMatchObject({
      code: "BACKEND_DRIFT",
    });
  });

  it("构建非零退出 ⇒ BUILD_FAILED 且诊断含 stderr 尾部", async () => {
    const tempRoot = newTempRoot();
    const backend = new DockerPreparationBackend({
      installation,
      endpoint: ENDPOINT,
      tempRoot,
      runner: scriptedRunner([
        () => okResult(GOOD_VERSION_OUTPUT),
        () => ({
          ...okResult(),
          exitCode: 1,
          stderr: "failed to solve: npm ci integrity mismatch for typescript@5.9.3",
        }),
      ]),
    });
    const error = (await backend.buildTrustedEnvironment(request()).then(
      () => null,
      (e: unknown) => e,
    )) as PreparationBackendError;
    expect(error).toBeInstanceOf(PreparationBackendError);
    expect(error.code).toBe("BUILD_FAILED");
    expect(error.message).toContain("integrity mismatch");
  });

  it("资产被篡改 ⇒ 端口内完整性门拒绝（纵深，未发起任何 CLI 调用）", async () => {
    const tempRoot = newTempRoot();
    let calls = 0;
    const backend = new DockerPreparationBackend({
      installation,
      endpoint: ENDPOINT,
      tempRoot,
      runner: async () => {
        calls += 1;
        throw new Error("不应发起 CLI 调用");
      },
    });
    await expect(
      backend.buildTrustedEnvironment({
        profile: NODE_TS_V1_PROFILE,
        assets: { ...NODE_TS_V1_BUILD_ASSETS, "runner.mjs": "// tampered\n" },
      }),
    ).rejects.toMatchObject({ code: "TRUSTED_ENVIRONMENT_DRIFT" });
    expect(calls).toBe(0);
    expect(
      verifyNodeTsV1Assets({ ...NODE_TS_V1_BUILD_ASSETS, "runner.mjs": "// tampered\n" }).ok,
    ).toBe(false);
  });

  it("预检不可达 ⇒ 不写上下文、不构建，直接 BACKEND_MISSING（P01）", async () => {
    const tempRoot = newTempRoot();
    const backend = new DockerPreparationBackend({
      installation,
      endpoint: ENDPOINT,
      tempRoot,
      runner: scriptedRunner([
        () => ({
          ...okResult(),
          exitCode: 1,
          stderr:
            "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
        }),
      ]),
    });
    await expect(backend.buildTrustedEnvironment(request())).rejects.toMatchObject({
      code: "BACKEND_MISSING",
    });
    // 临时目录根没有残留构建上下文
    expect(readdirSync(tempRoot)).toHaveLength(0);
  });

  it("构建后上下文临时目录被清理（finally）", async () => {
    const tempRoot = newTempRoot();
    const backend = new DockerPreparationBackend({
      installation,
      endpoint: ENDPOINT,
      tempRoot,
      runner: scriptedRunner(happyScript()),
    });
    await backend.buildTrustedEnvironment(request());
    expect(readdirSync(tempRoot)).toHaveLength(0);
  });

  it("writeBuildContext：资产字节精确落盘、目录结构还原", () => {
    const tempRoot = newTempRoot();
    const contextDir = writeBuildContext(
      { Dockerfile: "FROM x\n", "tests/smoke.test.mjs": "ok\n" },
      tempRoot,
    );
    try {
      expect(readFileSync(join(contextDir, "Dockerfile"), "utf8")).toBe("FROM x\n");
      expect(readFileSync(join(contextDir, "tests/smoke.test.mjs"), "utf8")).toBe("ok\n");
      expect(existsSync(join(contextDir, "package.json"))).toBe(false);
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  it("extractSemanticVersion 归一 v 前缀与 Version 前缀", () => {
    expect(extractSemanticVersion("v22.23.4\n")).toBe("22.23.4");
    expect(extractSemanticVersion("Version 5.9.3")).toBe("5.9.3");
    expect(extractSemanticVersion("garbage")).toBeNull();
  });

  it("默认超时与流上限为有界常数", () => {
    expect(DEFAULT_CLI_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_STREAM_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
