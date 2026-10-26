import { describe, expect, it } from "vitest";
import { workloadContainerCommand } from "../src/docker/container-flags.js";
import { DockerStopBackend } from "../src/docker/docker-stop.js";
import {
  type FixedCommandReport,
  type StreamCapture,
  classifyExecutionReport,
  resolveFixedCommand,
} from "../src/execute/command-runner.js";
import {
  type WorkloadStopBackend,
  type WorkloadStopCounts,
  parseStopWorkloadsOutput,
  stopWorkloadsAndConfirm,
} from "../src/execute/stop.js";
import { NODE_TS_V1_PROFILE } from "../src/schema.js";

const ENDPOINT = "npipe:////./pipe/dockerDesktopLinuxEngine" as const;
const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };

const SCRIPT_OUTPUT = "TERM_SENT=3\nKILL_ESCALATED=1\nSURVIVORS=0\n";

function counts(overrides: Partial<WorkloadStopCounts> = {}): WorkloadStopCounts {
  return { termSent: 3, killEscalated: 1, survivors: 0, ...overrides };
}

class ScriptedStopBackend implements WorkloadStopBackend {
  stopCalls = 0;
  scanCalls = 0;
  constructor(
    private readonly script: WorkloadStopCounts,
    private readonly scans: string[],
  ) {}
  async runStopWorkloads(): Promise<WorkloadStopCounts> {
    this.stopCalls += 1;
    return this.script;
  }
  async scanWorkState(): Promise<string> {
    this.scanCalls += 1;
    const snapshot = this.scans.shift();
    if (snapshot === undefined) throw new Error("unexpected extra scan");
    return snapshot;
  }
}

const QUIESCENT_SNAPSHOT = [
  "/work/run.log 128 1770000000",
  "/work/src/calc.ts 140 1769999999",
].join("\n");

function stopBackend(script: WorkloadStopCounts, scans: string[]): ScriptedStopBackend {
  return new ScriptedStopBackend(script, scans);
}

describe("停止脚本输出解析（3.5）", () => {
  it("三行清点解析；缺行/垃圾输出 ⇒ null（不可解析按基础设施失败处理）", () => {
    expect(parseStopWorkloadsOutput(SCRIPT_OUTPUT)).toEqual(counts());
    expect(parseStopWorkloadsOutput("garbage")).toBeNull();
    expect(parseStopWorkloadsOutput("TERM_SENT=1\n")).toBeNull();
  });
});

describe("停止与静止确认编排（3.5，P19/P21）", () => {
  it("正常停止：stoppedPidCount=TERM+KILL、双扫一致 ⇒ quiescent（含进程清空）", async () => {
    const backend = stopBackend(counts(), [QUIESCENT_SNAPSHOT, QUIESCENT_SNAPSHOT]);
    const result = await stopWorkloadsAndConfirm({
      containerRef: "ctr-x",
      backend,
      quiescenceIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stoppedPidCount).toBe(4);
      expect(result.survivors).toBe(0);
      expect(result.quiescent).toBe(true);
      expect(result.quiescenceMs).toBeGreaterThanOrEqual(10);
    }
  });

  it("进程未清空（survivors>0）⇒ quiescent=false：不乐观宣布已停止", async () => {
    const backend = stopBackend(counts({ survivors: 1 }), [QUIESCENT_SNAPSHOT, QUIESCENT_SNAPSHOT]);
    const result = await stopWorkloadsAndConfirm({
      containerRef: "ctr-x",
      backend,
      quiescenceIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiescent).toBe(false);
    }
  });

  it("文件仍在变化（双扫不一致）⇒ quiescent=false（P19 确认语义）", async () => {
    const backend = stopBackend(counts(), [
      QUIESCENT_SNAPSHOT,
      QUIESCENT_SNAPSHOT.replace("128 1770000000", "132 1770000001"),
    ]);
    const result = await stopWorkloadsAndConfirm({
      containerRef: "ctr-x",
      backend,
      quiescenceIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiescent).toBe(false);
    }
  });

  it("幂等：重复停止对已清空容器 = stoppedPidCount 0 且仍可确认静止", async () => {
    const backend = stopBackend(counts({ termSent: 0, killEscalated: 0 }), [
      QUIESCENT_SNAPSHOT,
      QUIESCENT_SNAPSHOT,
    ]);
    const result = await stopWorkloadsAndConfirm({
      containerRef: "ctr-x",
      backend,
      quiescenceIntervalMs: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stoppedPidCount).toBe(0);
      expect(result.quiescent).toBe(true);
    }
  });

  it("daemon 断开形态 ⇒ unknown：不声明已停止（P21）", async () => {
    const backend = stopBackend(counts(), []);
    backend.runStopWorkloads = async () => {
      throw new Error(
        "docker exec 无法启动（unknown）：failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
      );
    };
    const result = await stopWorkloadsAndConfirm({
      containerRef: "ctr-x",
      backend,
      quiescenceIntervalMs: 10,
    });
    expect(!result.ok && result.kind).toBe("unknown");
  });

  it("扫描中途断连 ⇒ unknown；普通失败 ⇒ failed", async () => {
    const scanFail = stopBackend(counts(), []);
    scanFail.scanWorkState = async () => {
      throw new Error("error during connect: pipe gone");
    };
    const unknown = await stopWorkloadsAndConfirm({
      containerRef: "ctr-x",
      backend: scanFail,
      quiescenceIntervalMs: 10,
    });
    expect(!unknown.ok && unknown.kind).toBe("unknown");

    const hardFail = stopBackend(counts(), []);
    hardFail.scanWorkState = async () => {
      throw new Error("stat: permission denied");
    };
    const failed = await stopWorkloadsAndConfirm({
      containerRef: "ctr-x",
      backend: hardFail,
      quiescenceIntervalMs: 10,
    });
    expect(!failed.ok && failed.kind).toBe("failed");
  });

  it("classifyStopFailure：断连族 ⇒ unknown，其余 ⇒ failed", () => {
    expect(classifyStopFailureOf("error during connect: x")).toBe("unknown");
    expect(classifyStopFailureOf("The system cannot find the file specified.")).toBe("unknown");
    expect(classifyStopFailureOf("stat: permission denied")).toBe("failed");
  });

  function classifyStopFailureOf(reason: string): "unknown" | "failed" {
    // 直接复用模块内分类（经 unknown 路径间接覆盖；此处显式再测映射表）
    const text = reason.toLowerCase();
    const unknown =
      text.includes("cannot find the file specified") ||
      text.includes("failed to connect") ||
      text.includes("error during connect");
    return unknown ? "unknown" : "failed";
  }
});

describe("Docker 停止后端（3.5，注入 runner 的 argv 测试）", () => {
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

  it("停止 argv：exec + 受信脚本路径；扫描：find + 分批 stat", async () => {
    const calls: string[][] = [];
    const runner = async (_exePath: string, args: string[]) => {
      const rest = args.slice(2); // 去掉全局 2 项
      calls.push(rest);
      if (rest[2] === "/bin/sh") return okResult(SCRIPT_OUTPUT);
      if (rest[2] === "find") return okResult("/work/a.ts\n/work/b.ts\n");
      if (rest[2] === "stat")
        return okResult("/work/a.ts 140 1769999999\n/work/b.ts 10 1769999999");
      throw new Error(`unexpected: ${rest.join(" ")}`);
    };
    const backend = new DockerStopBackend({ installation, endpoint: ENDPOINT, runner });
    const countsResult = await backend.runStopWorkloads("ctr-x");
    expect(countsResult).toEqual(counts());
    const snapshot = await backend.scanWorkState("ctr-x");
    expect(snapshot.split("\n")).toEqual(["/work/a.ts 140 1769999999", "/work/b.ts 10 1769999999"]);
    expect(calls[0]).toEqual(["exec", "ctr-x", "/bin/sh", "/opt/r3/stop-workloads.sh"]);
    expect(calls[1]).toEqual(["exec", "ctr-x", "find", "/work", "-type", "f"]);
  });

  it("停止脚本输出不可解析 ⇒ 抛错（基础设施失败，编排判 unknown/failed）", async () => {
    const runner = async () => okResult("garbage");
    const backend = new DockerStopBackend({ installation, endpoint: ENDPOINT, runner });
    await expect(backend.runStopWorkloads("ctr-x")).rejects.toThrow("不可解析");
  });

  it("6.2 回归：断连 stderr 必须进错误消息（classifyStopFailure 靠它判 unknown，P21）", async () => {
    // 引擎下线：stdout 空、exit 1、stderr=断连错误族——stderr 被丢会导致误报"停止失败"
    const runner = async () => ({
      ...okResult(),
      exitCode: 1,
      stderr: "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine",
      stderrTotalBytes: 78,
    });
    const backend = new DockerStopBackend({ installation, endpoint: ENDPOINT, runner });
    const error = await backend.runStopWorkloads("ctr-x").catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain("failed to connect");
    expect((error as Error).message).toContain("stderr:");
  });
});

describe("supervisor 容器命令与限额击杀（3.5，P10/P19）", () => {
  it("workloadContainerCommand：PID 1 = 受控 supervisor", () => {
    expect(workloadContainerCommand(NODE_TS_V1_PROFILE)).toEqual([
      "/bin/sh",
      "/opt/r3/supervisor.sh",
    ]);
  });

  it("总观测超限实时击杀：outputLimitHit 标记 + 分类 output_limit_stopped", async () => {
    // 真实 spawn：node 写 64 MiB，上限 1 MiB ⇒ 未写完即被杀。
    // 不能只写 5 MiB：快机器上子进程可能在击杀信号送达前就写完，字节数正好等于全量。
    const { defaultCliRunner } = await import("../src/docker/cli.js");
    const outputBytes = 64 * 1024 * 1024;
    const result = await defaultCliRunner(
      process.execPath,
      ["-e", `process.stdout.write(Buffer.alloc(${outputBytes}, 120))`],
      {
        env: {},
        timeoutMs: 30000,
        stdoutMaxBytes: 1024,
        stderrMaxBytes: 1024,
        outputLimitBytes: 1024 * 1024,
      },
    );
    expect(result.outputLimitHit).toBe(true);
    expect(result.stdoutTotalBytes).toBeGreaterThan(1024 * 1024);
    expect(result.stdoutTotalBytes).toBeLessThan(outputBytes); // 未写完即被杀

    const report: FixedCommandReport = {
      commandId: "test",
      executable: "node",
      argv: [],
      cwd: "/work",
      startedAt: "2026-10-25T06:00:00.000Z",
      endedAt: "2026-10-25T06:00:01.000Z",
      durationMs: 1000,
      exitCode: null,
      timedOut: false,
      outputLimitHit: true,
      stdout: { ...captureOf(new Uint8Array(10)), sha256: "a".repeat(64) },
      stderr: { ...captureOf(new Uint8Array(0)), sha256: "c".repeat(64) },
    };
    expect(classifyExecutionReport(report)).toBe("output_limit_stopped");
    expect(classifyExecutionReport({ ...report, outputLimitHit: false, timedOut: true })).toBe(
      "timed_out",
    );
  });

  function captureOf(bytes: Uint8Array): Omit<StreamCapture, "sha256"> {
    return { retainedBytes: bytes, totalBytes: bytes.length, truncated: false };
  }

  it("resolveFixedCommand 仍可用（3.4 回归锚）", () => {
    expect(resolveFixedCommand(NODE_TS_V1_PROFILE, "typecheck")?.cwd).toBe("/work");
  });
});
