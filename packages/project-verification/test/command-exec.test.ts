import { describe, expect, it } from "vitest";
import { DockerCommandBackend } from "../src/docker/docker-exec-command.js";
import {
  type ContainerCommandBackend,
  type ContainerCommandRun,
  type FixedCommandReport,
  type StreamCapture,
  classifyExecutionReport,
  commandEndEvent,
  commandStartEvent,
  deriveSignalName,
  exceedsTotalOutputLimit,
  executeFixedCommand,
  resolveFixedCommand,
  totalObservedBytes,
  validateTestReport,
} from "../src/execute/command-runner.js";
import { NODE_TS_V1_PROFILE } from "../src/schema.js";

const ENDPOINT = "npipe:////./pipe/dockerDesktopLinuxEngine" as const;
const installation = { exePath: "C:\\x\\bin\\docker.exe", binDir: "C:\\x\\bin" };

function capture(bytes: Uint8Array, totalBytes?: number): Omit<StreamCapture, "sha256"> {
  return {
    retainedBytes: bytes,
    totalBytes: totalBytes ?? bytes.length,
    truncated: (totalBytes ?? bytes.length) > bytes.length,
  };
}

const TAP_OK = [
  "TAP version 13",
  "ok 1 - add(2,3)=5",
  "ok 2 - mul(2,3)=6",
  "1..2",
  "# tests 2",
  "# pass 2",
  "# fail 0",
].join("\n");

describe("固定命令解析（3.4，P08 执行侧）", () => {
  it("枚举命令查表：executable/argv/cwd 全部来自 manifest", () => {
    const typecheck = resolveFixedCommand(NODE_TS_V1_PROFILE, "typecheck");
    const test = resolveFixedCommand(NODE_TS_V1_PROFILE, "test");
    expect(typecheck).toEqual({
      commandId: "typecheck",
      executable: "/usr/local/bin/node",
      argv: ["/opt/r3/runner.mjs", "typecheck"],
      cwd: "/work",
    });
    expect(test?.argv).toEqual(["/opt/r3/runner.mjs", "test"]);
  });
});

describe("阶段分类与信号推导（3.4，P20）", () => {
  function report(overrides: Partial<FixedCommandReport>): FixedCommandReport {
    return {
      commandId: "test",
      executable: "/usr/local/bin/node",
      argv: ["/opt/r3/runner.mjs", "test"],
      cwd: "/work",
      startedAt: "2026-10-25T04:00:00.000Z",
      endedAt: "2026-10-25T04:00:05.000Z",
      durationMs: 5000,
      exitCode: 0,
      timedOut: false,
      stdout: { ...capture(new TextEncoder().encode(TAP_OK)), sha256: "a".repeat(64) },
      stderr: { ...capture(new TextEncoder().encode("")), sha256: "c".repeat(64) },
      ...overrides,
    };
  }

  it("exit 0/1 → completed（检查成败归编排层，不是执行失败）", () => {
    expect(classifyExecutionReport(report({ exitCode: 0 }))).toBe("completed");
    expect(classifyExecutionReport(report({ exitCode: 1 }))).toBe("completed");
  });

  it("126/127 → start_failed；≥128 → process_failed；timedOut → timed_out", () => {
    expect(classifyExecutionReport(report({ exitCode: 127 }))).toBe("start_failed");
    expect(classifyExecutionReport(report({ exitCode: 126 }))).toBe("start_failed");
    expect(classifyExecutionReport(report({ exitCode: 137 }))).toBe("process_failed");
    expect(classifyExecutionReport(report({ exitCode: 143 }))).toBe("process_failed");
    expect(classifyExecutionReport(report({ exitCode: null }))).toBe("process_failed");
    expect(classifyExecutionReport(report({ exitCode: 0, timedOut: true }))).toBe("timed_out");
  });

  it("信号名推导按 128+N 约定（137→SIGKILL、143→SIGTERM；普通退出 null）", () => {
    expect(deriveSignalName(137)).toBe("SIGKILL");
    expect(deriveSignalName(143)).toBe("SIGTERM");
    expect(deriveSignalName(130)).toBe("SIGINT");
    expect(deriveSignalName(0)).toBeNull();
    expect(deriveSignalName(1)).toBeNull();
    expect(deriveSignalName(null)).toBeNull();
  });
});

describe("TAP 精确门（3.4，P12）", () => {
  it("精确匹配通过；零测试/超计数/垃圾输出/缺 pass 行拒绝", () => {
    expect(validateTestReport(TAP_OK, 2)).toEqual({ ok: true });
    const zero = TAP_OK.replace("# tests 2", "# tests 1").replace("# pass 2", "# pass 1");
    expect(validateTestReport(zero, 2).ok).toBe(false);
    expect(validateTestReport("# tests 3\n# pass 3\n", 2).ok).toBe(false);
    expect(validateTestReport("garbage-no-summary", 2).ok).toBe(false);
    expect(validateTestReport("# tests 2\n", 2).ok).toBe(false);
  });

  it("多段 TAP 取最后一个摘要", () => {
    const twoSuites = "# tests 1\n# pass 1\nTAP2\n# tests 2\n# pass 2\n";
    expect(validateTestReport(twoSuites, 2)).toEqual({ ok: true });
  });
});

describe("执行编排（3.4，P11/P13/P20）", () => {
  const limits = NODE_TS_V1_PROFILE.limits;

  function fakeBackend(run: ContainerCommandRun): ContainerCommandBackend & { calls: number } {
    return Object.assign(
      { calls: 0 },
      {
        async runCommand(request: Parameters<ContainerCommandBackend["runCommand"]>[0]) {
          (run as { received?: unknown }).received = request;
          return run;
        },
      },
    );
  }

  function backendThrow(message: string): ContainerCommandBackend {
    return {
      async runCommand() {
        throw new Error(message);
      },
    };
  }

  const GOOD_RUN: ContainerCommandRun = {
    exitCode: 0,
    timedOut: false,
    stdout: capture(new TextEncoder().encode(TAP_OK)),
    stderr: capture(new TextEncoder().encode("")),
  };

  it("成功报告：UTC 起止 + 单调耗时 + 退出事实 + 双流哈希；请求参数来自 manifest/limits", async () => {
    let tick = 0;
    const backend = fakeBackend(GOOD_RUN);
    const result = await executeFixedCommand({
      containerRef: "ctr-x",
      command: resolveFixedCommand(NODE_TS_V1_PROFILE, "test")!,
      limits,
      backend,
      now: () => new Date(Date.UTC(2026, 9, 25, 4, 0, tick++)),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const report = result.report;
    expect(report.startedAt).toBe("2026-10-25T04:00:00.000Z");
    expect(report.endedAt).toBe("2026-10-25T04:00:01.000Z");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.exitCode).toBe(0);
    expect(report.stdout.totalBytes).toBe(new TextEncoder().encode(TAP_OK).length);
    expect(report.stdout.truncated).toBe(false);
    expect(report.stderr.totalBytes).toBe(0);
    const received = (
      GOOD_RUN as {
        received?: {
          stdoutRetainBytes?: number;
          timeoutMs?: number;
          cwd?: string;
          argv?: string[];
        };
      }
    ).received;
    expect(received?.stdoutRetainBytes).toBe(limits.stdoutBudgetBytes);
    expect(received?.timeoutMs).toBe(limits.commandTimeoutMs);
    expect(received?.cwd).toBe("/work");
    expect(received?.argv).toEqual(["/opt/r3/runner.mjs", "test"]);
  });

  it("基础设施失败（容器不可达）⇒ environment_failed，不是检查失败（P20）", async () => {
    const result = await executeFixedCommand({
      containerRef: "ctr-x",
      command: resolveFixedCommand(NODE_TS_V1_PROFILE, "test")!,
      limits,
      backend: backendThrow("container not running"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("environment_failed");
      expect(result.failure.reason).toContain("container not running");
    }
  });

  it("记录事件构造：command_start/command_end 经 schema 校验，双口径在场", async () => {
    let tick = 0;
    const result = await executeFixedCommand({
      containerRef: "ctr-x",
      command: resolveFixedCommand(NODE_TS_V1_PROFILE, "test")!,
      limits,
      backend: fakeBackend(GOOD_RUN),
      now: () => new Date(Date.UTC(2026, 9, 25, 4, 0, tick++)),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const start = commandStartEvent(result.report);
    expect(start.type).toBe("command_start");
    expect(start.argv).toEqual(["/opt/r3/runner.mjs", "test"]);
    const end = commandEndEvent(result.report);
    expect(end.type).toBe("command_end");
    expect(end.signal).toBeNull();
    expect(end.stdout.byteLength).toBe(new TextEncoder().encode(TAP_OK).length);
    expect(end.stdout.totalBytes).toBe(end.stdout.byteLength);
    expect(end.stdout.truncated).toBe(false);
  });

  it("被杀形态（exit 137）：signal 推导 SIGKILL 进 command_end", async () => {
    const result = await executeFixedCommand({
      containerRef: "ctr-x",
      command: resolveFixedCommand(NODE_TS_V1_PROFILE, "typecheck")!,
      limits,
      backend: fakeBackend({ ...GOOD_RUN, exitCode: 137 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const end = commandEndEvent(result.report);
    expect(end.exitCode).toBe(137);
    expect(end.signal).toBe("SIGKILL");
  });

  it("输出阈值：全观测（含丢弃）参与 output_limit 判定（P13）", () => {
    const retained = new Uint8Array(1024);
    const report: FixedCommandReport = {
      commandId: "test",
      executable: "node",
      argv: [],
      cwd: "/work",
      startedAt: "2026-10-25T04:00:00.000Z",
      endedAt: "2026-10-25T04:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      timedOut: false,
      stdout: { ...capture(retained, 17 * 1024 * 1024), sha256: "a".repeat(64) },
      stderr: { ...capture(new Uint8Array(0), 0), sha256: "c".repeat(64) },
    };
    expect(totalObservedBytes(report)).toBe(17 * 1024 * 1024);
    expect(exceedsTotalOutputLimit(report, limits)).toBe(true);
    const small = { ...report, stdout: { ...capture(retained, 1024), sha256: "a".repeat(64) } };
    expect(exceedsTotalOutputLimit(small, limits)).toBe(false);
  });
});

describe("Docker 命令后端（3.4，注入 runner 的 argv 测试）", () => {
  it("argv 形态：--workdir + executable + argv，保留上限传给捕获", async () => {
    let capturedArgs: string[] = [];
    let capturedOptions: { stdoutMaxBytes?: number; timeoutMs?: number } = {};
    const runner = async (
      _exePath: string,
      args: string[],
      options: { stdoutMaxBytes: number; timeoutMs: number },
    ) => {
      capturedArgs = args.slice(2); // 去掉全局 2 项
      capturedOptions = options;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        spawnError: null,
        stdoutBytes: new TextEncoder().encode("TAP"),
        stderrBytes: new Uint8Array(),
        stdoutTotalBytes: 3,
        stderrTotalBytes: 0,
      };
    };
    const backend = new DockerCommandBackend({ installation, endpoint: ENDPOINT, runner });
    const run = await backend.runCommand({
      containerRef: "ctr-x",
      executable: "/usr/local/bin/node",
      argv: ["/opt/r3/runner.mjs", "test"],
      cwd: "/work",
      stdoutRetainBytes: 1048576,
      stderrRetainBytes: 1048576,
      timeoutMs: 120000,
    });
    expect(capturedArgs).toEqual([
      "exec",
      "--workdir",
      "/work",
      "ctr-x",
      "/usr/local/bin/node",
      "/opt/r3/runner.mjs",
      "test",
    ]);
    expect(capturedOptions.stdoutMaxBytes).toBe(1048576);
    expect(capturedOptions.timeoutMs).toBe(130000); // 命令超时 + 余量
    expect(run.exitCode).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(new TextDecoder().decode(run.stdout.retainedBytes)).toBe("TAP");
    expect(run.stdout.totalBytes).toBe(3);
  });
});
