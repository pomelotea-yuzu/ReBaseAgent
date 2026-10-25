import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactCollectionBackend } from "../src/collect/collect.js";
import type { ContainerCommandBackend } from "../src/execute/command-runner.js";
import type { WorkloadStopBackend } from "../src/execute/stop.js";
import type { ContainerWriteBackend } from "../src/materialize/materialize.js";
import {
  type VerificationContainerLifecycle,
  type VerificationRunPorts,
  executeVerificationRun,
} from "../src/orchestrate/run.js";
import { currentPreparePlanToken } from "../src/prepare/plan.js";
import { RuntimeCreateUnknownError } from "../src/runtime/create.js";
import { NODE_TS_V1_PROFILE } from "../src/schema.js";

/**
 * 验证运行编排单测（4.2 包层底座）：来源用真实 createIsolatedRun 夹具（预检真读），
 * 其余阶段全部 fake 端口——判据是编排层自己的门序、记录事件序列、结局映射与收尾。
 */

const CALC_TS = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const INPUT_HASH = createHash("sha256").update(CALC_TS).digest("hex");
const PLAN_TOKEN = currentPreparePlanToken();
const CONTAINER_ID = "a".repeat(64);

interface Fixture {
  dataDir: string;
  dataRoot: string;
  runId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  const source = mkdtempSync(join(tmpdir(), "r3-orch-src-"));
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "calc.ts"), CALC_TS);
  const dataDir = join(mkdtempSync(join(tmpdir(), "r3-orch-data-")), "data");
  const created = await createIsolatedRun({
    dataDir,
    source,
    config: {
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
      systemPrompt: "你是文件助手。",
      tools: [...FILE_TOOLS_V1_DEFINITIONS],
      params: undefined,
      exec: { cwd: "D:/nope-not-a-real-dir", signal: null },
      maxIterations: 10,
      budget: { maxTotalTokens: 100000 },
    },
    userMessage: "R3 编排夹具",
    authority: { allowFileWrites: true },
    llm: {
      complete: async () => ({
        response: {
          content: "done",
          reasoningContent: null,
          toolCalls: [],
          usage: { in: 1, out: 1 },
          ttftMs: 1,
        },
        requestBody: {},
      }),
    } as unknown as Parameters<typeof createIsolatedRun>[0]["llm"],
  });
  if (!created.ok) throw new Error(`夹具创建失败：${created.failure.code}`);
  fixture = {
    dataDir,
    dataRoot: mkdtempSync(join(tmpdir(), "r3-orch-root-")),
    runId: created.id,
  };
});

afterAll(() => {
  /* 夹具目录留给系统临时目录清理 */
});

function tapStdout(tests = 2, pass = 2): Uint8Array {
  return Buffer.from(`# tests ${tests}\n# pass ${pass}\n`);
}

interface ScriptedPorts {
  ports: VerificationRunPorts;
  calls: {
    created: string[];
    started: string[];
    removed: string[];
  };
  setCommandResult(result: {
    exitCode: number | null;
    timedOut?: boolean;
    outputLimitHit?: boolean;
    stdout?: Uint8Array;
    stdoutTruncated?: boolean;
  }): void;
  setStopUnknown(reason: string): void;
  setStopNotQuiescent(): void;
  setCollectInputDrifted(): void;
  setCollectInvalidObjects(): void;
  setCreateUnknown(): void;
}

function makePorts(): ScriptedPorts {
  const calls = {
    created: [] as string[],
    started: [] as string[],
    removed: [] as string[],
  };
  let commandResult: {
    exitCode: number | null;
    timedOut: boolean;
    outputLimitHit: boolean;
    stdout: Uint8Array;
    stdoutTruncated: boolean;
  } = {
    exitCode: 0,
    timedOut: false,
    outputLimitHit: false,
    stdout: tapStdout(),
    stdoutTruncated: false,
  };
  let stopUnknown: string | null = null;
  let stopNotQuiescent = false;
  let inputDrifted = false;
  let collectInvalidObjects = false;
  let createUnknown = false;
  let stopScanRound = 0;

  const lifecycle: VerificationContainerLifecycle = {
    async listOwnedContainers() {
      return [];
    },
    async stopContainer() {},
    async confirmStopped() {},
    async removeContainer(id) {
      calls.removed.push(id);
    },
    async startContainer(id) {
      calls.started.push(id);
    },
    async createContainer() {
      if (createUnknown) {
        throw new RuntimeCreateUnknownError("create 超时（请求可能已被引擎处理）");
      }
      calls.created.push(CONTAINER_ID);
      return { containerId: CONTAINER_ID };
    },
    async resolveContainerByName() {
      if (createUnknown) {
        throw new Error("按名探查超时（引擎不可达）");
      }
      return null;
    },
  };
  const materialize: ContainerWriteBackend = {
    async mkdirAll() {},
    async writeFile() {},
    async sha256OfFiles(_ref, paths) {
      const map = new Map<string, string>();
      for (const p of paths) map.set(p, INPUT_HASH);
      return map;
    },
  };
  const command: ContainerCommandBackend = {
    async runCommand() {
      return {
        exitCode: commandResult.exitCode,
        timedOut: commandResult.timedOut,
        outputLimitHit: commandResult.outputLimitHit,
        stdout: {
          retainedBytes: commandResult.stdout,
          totalBytes: commandResult.stdout.length,
          truncated: commandResult.stdoutTruncated,
        },
        stderr: {
          retainedBytes: Buffer.from(""),
          totalBytes: 0,
          truncated: false,
        },
      };
    },
  };
  const workloadStop: WorkloadStopBackend = {
    async runStopWorkloads() {
      if (stopUnknown !== null) {
        throw new Error(stopUnknown);
      }
      return { termSent: 0, killEscalated: 0, survivors: 0 };
    },
    async scanWorkState() {
      // 静止模拟：两次扫描返回不同快照 = /work 仍在变化（P19 反例）
      stopScanRound += 1;
      return stopNotQuiescent ? `snapshot-${String(stopScanRound)}` : "";
    },
  };
  const collect: ArtifactCollectionBackend = {
    async listNonRegularObjects() {
      return collectInvalidObjects ? ["evil-link"] : [];
    },
    async listWorkFilesWithSizes() {
      return [{ path: "src/calc.ts", size: Buffer.byteLength(CALC_TS) }];
    },
    async sha256OfFiles(_ref, paths) {
      const map = new Map<string, string>();
      for (const p of paths) map.set(p, inputDrifted ? "0".repeat(64) : INPUT_HASH);
      return map;
    },
    async readFile() {
      return Buffer.from(CALC_TS);
    },
  };
  return {
    calls,
    ports: {
      lifecycle,
      materialize,
      command,
      workloadStop,
      collect,
      quiescenceIntervalMs: 10,
      stabilityIntervalMs: 10,
    },
    setCommandResult(next) {
      commandResult = { ...commandResult, ...next };
    },
    setStopUnknown(reason) {
      stopUnknown = reason;
    },
    setStopNotQuiescent() {
      stopNotQuiescent = true;
    },
    setCollectInputDrifted() {
      inputDrifted = true;
    },
    setCollectInvalidObjects() {
      collectInvalidObjects = true;
    },
    setCreateUnknown() {
      createUnknown = true;
    },
  };
}

function runInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    target: { runId: fixture.runId, checkpoint: { kind: "initial" } },
    profileId: "node-ts-v1",
    commandId: "test",
    planToken: PLAN_TOKEN,
    allowExecution: true,
    ...overrides,
  };
}

function params(ports: VerificationRunPorts, inputOverrides: Record<string, unknown> = {}) {
  return {
    dataRoot: fixture.dataRoot,
    dataDir: fixture.dataDir,
    ports,
    epoch: "11111111-1111-4111-8111-111111111111",
    operationId: "22222222-2222-4222-8222-222222222222",
    preparation: { preparationId: "prep-1", imageDigest: `sha256:${"d".repeat(64)}` },
    input: runInput(inputOverrides),
  };
}

function readEvents(recordPath: string): Array<Record<string, unknown>> {
  return readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 最新一条登记的 phase（按 mtime；夹具 dataRoot 跨用例共享 ⇒ 只看新条目）。 */
function latestRegistrationPhase(): string | null {
  const dir = join(fixture.dataRoot, "verification-runtime");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const first = files[0];
  return first === undefined
    ? null
    : (JSON.parse(readFileSync(first, "utf8")) as { phase: string }).phase;
}

function dirFingerprint(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${rel}/`);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

describe("门内零副作用（P07：授权/形状/计划漂移先于一切写盘）", () => {
  it("缺 allowExecution:true ⇒ run_not_allowed，零记录零登记零容器调用", async () => {
    const script = makePorts();
    const before = dirFingerprint(fixture.dataRoot);
    const result = await executeVerificationRun(
      params(script.ports, { allowExecution: undefined }),
    );
    expect(result).toMatchObject({ ok: false, failure: { code: "run_not_allowed" } });
    expect(result.verificationId).toBeNull();
    expect(dirFingerprint(fixture.dataRoot)).toEqual(before);
    expect(script.calls.created).toEqual([]);
  });

  it("形状非法（多余键）⇒ invalid_input，零副作用", async () => {
    const script = makePorts();
    const before = dirFingerprint(fixture.dataRoot);
    const result = await executeVerificationRun(params(script.ports, { evil: 1 }));
    expect(result).toMatchObject({ ok: false, failure: { code: "invalid_input" } });
    expect(dirFingerprint(fixture.dataRoot)).toEqual(before);
    expect(script.calls.created).toEqual([]);
  });

  it("planToken 漂移 ⇒ plan_stale（P07），零副作用", async () => {
    const script = makePorts();
    const before = dirFingerprint(fixture.dataRoot);
    const result = await executeVerificationRun(params(script.ports, { planToken: "stale-token" }));
    expect(result).toMatchObject({ ok: false, failure: { code: "plan_stale" } });
    expect(dirFingerprint(fixture.dataRoot)).toEqual(before);
    expect(script.calls.created).toEqual([]);
  });
});

describe("passed 主路径：记录事件序列与收尾", () => {
  it("exit 0 + TAP 匹配 ⇒ passed；事件序列完整；容器移除 + 登记收尾 removed", async () => {
    const script = makePorts();
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({ ok: true, outcome: "passed", evidenceComplete: true });
    if (!result.ok) return;
    const events = readEvents(result.recordPath);
    expect(events.map((e) => e.type)).toEqual([
      "meta",
      "stage",
      "stage",
      "command_start",
      "command_end",
      "stage",
      "stop_confirmed",
      "stage",
      "artifacts",
      "terminated",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "terminated", outcome: "passed" });
    // 5.4/P24/P25：meta 落实际环境身份（比较条件不靠摘要推断）
    expect(events[0]).toMatchObject({
      type: "meta",
      environment: {
        preparationId: "prep-1",
        imageDigest: `sha256:${"d".repeat(64)}`,
        platform: "linux/amd64",
        toolchain: { node: "22.23.4", npm: "10.9.9", typescript: "5.9.3" },
        limits: { cpus: 1, memoryBytes: 536870912, pidsLimit: 64 },
        security: { networkMode: "none", readOnlyRootfs: true, supervisorPid1: true },
      },
    });
    const stages = events
      .filter((e) => e.type === "stage")
      .map((e) => (e as { phase: string }).phase);
    expect(stages).toEqual(["materializing", "executing", "stopping", "collecting"]);
    expect(script.calls.created).toEqual([CONTAINER_ID]);
    expect(script.calls.started).toEqual([CONTAINER_ID]);
    expect(script.calls.removed).toEqual([CONTAINER_ID]);
    expect(latestRegistrationPhase()).toBe("removed");
  });

  it("typecheck 命令 exit 0（无 TAP）⇒ passed", async () => {
    const script = makePorts();
    script.setCommandResult({ exitCode: 0, stdout: Buffer.from("tsc ok\n") });
    const result = await executeVerificationRun(params(script.ports, { commandId: "typecheck" }));
    expect(result).toMatchObject({ ok: true, outcome: "passed" });
  });
});

describe("记录创建回调（onRecordCreated：在飞领域身份挂登记的时机，D05/D06）", () => {
  it("记录创建成功即回调一次（先于容器创建），回调时记录文件已存在且 ID=mint 值", async () => {
    const script = makePorts();
    const seen: Array<{ verificationId: string; recordExists: boolean; afterCreate: boolean }> = [];
    const result = await executeVerificationRun({
      ...params(script.ports),
      onRecordCreated: (verificationId, recordPath) => {
        seen.push({
          verificationId,
          recordExists: existsSync(recordPath),
          afterCreate: script.calls.created.length > 0,
        });
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      verificationId: result.verificationId,
      recordExists: true,
      afterCreate: false,
    });
  });

  it("门内拒绝（plan_stale，记录创建前）不回调——无记录即无领域身份", async () => {
    const script = makePorts();
    const seen: string[] = [];
    const result = await executeVerificationRun({
      ...params(script.ports, { planToken: "stale-token" }),
      onRecordCreated: (id) => seen.push(id),
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "plan_stale" } });
    expect(seen).toEqual([]);
  });
});

describe("结局映射（D6 九行表）", () => {
  it("test 命令 exit 0 但 TAP 不匹配 ⇒ check_failed（P12 精确门）", async () => {
    const script = makePorts();
    script.setCommandResult({ exitCode: 0, stdout: tapStdout(5, 4) });
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({ ok: true, outcome: "check_failed" });
  });

  it("typecheck exit 1 ⇒ check_failed（completed 分类下按退出码判，保留真实 exit）", async () => {
    const script = makePorts();
    script.setCommandResult({ exitCode: 1, stdout: Buffer.from("error TS\n") });
    const result = await executeVerificationRun(params(script.ports, { commandId: "typecheck" }));
    expect(result).toMatchObject({ ok: true, outcome: "check_failed" });
    if (result.ok) expect(result.detail).toContain("exit 1");
  });

  it("exit 127 ⇒ start_failed；exit 137 ⇒ process_failed", async () => {
    const script = makePorts();
    script.setCommandResult({ exitCode: 127, stdout: Buffer.from("") });
    expect(await executeVerificationRun(params(script.ports))).toMatchObject({
      ok: true,
      outcome: "start_failed",
    });
    const script2 = makePorts();
    script2.setCommandResult({ exitCode: 137, stdout: Buffer.from("") });
    expect(await executeVerificationRun(params(script2.ports))).toMatchObject({
      ok: true,
      outcome: "process_failed",
    });
  });

  it("timedOut ⇒ timed_out；outputLimitHit ⇒ output_limit", async () => {
    const script = makePorts();
    script.setCommandResult({ exitCode: null, timedOut: true, stdout: Buffer.from("") });
    expect(await executeVerificationRun(params(script.ports))).toMatchObject({
      ok: true,
      outcome: "timed_out",
    });
    const script2 = makePorts();
    script2.setCommandResult({ exitCode: null, outputLimitHit: true, stdout: Buffer.from("") });
    expect(await executeVerificationRun(params(script2.ports))).toMatchObject({
      ok: true,
      outcome: "output_limit",
    });
  });

  it("流截断 ⇒ evidence_incomplete（evidenceComplete=false，保留真实 exit）", async () => {
    const script = makePorts();
    script.setCommandResult({ exitCode: 0, stdoutTruncated: true });
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({
      ok: true,
      outcome: "evidence_incomplete",
      evidenceComplete: false,
    });
  });

  it("6.2 回归：截断且保留日志里看不到 TAP 摘要 ⇒ evidence_incomplete，不误报断言失败", async () => {
    const script = makePorts();
    script.setCommandResult({
      exitCode: 0,
      stdoutTruncated: true,
      stdout: Buffer.from("x".repeat(4096)),
    });
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({
      ok: true,
      outcome: "evidence_incomplete",
      evidenceComplete: false,
    });
    if (result.ok) expect(result.detail).toContain("输出被截断");
  });

  it("停止结果未知 ⇒ unknown；容器不移除、登记保持 created（P21/P23）", async () => {
    const script = makePorts();
    script.setStopUnknown("failed to connect to the docker API");
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({ ok: true, outcome: "unknown", evidenceComplete: false });
    expect(script.calls.removed).toEqual([]);
    expect(latestRegistrationPhase()).toBe("created");
  });

  it("静止确认失败（/work 仍在变）⇒ unknown，不发布结论（P19）", async () => {
    const script = makePorts();
    script.setStopNotQuiescent();
    expect(await executeVerificationRun(params(script.ports))).toMatchObject({
      ok: true,
      outcome: "unknown",
    });
  });

  it("6.2 回归：停止失败且容器移除未确认 ⇒ 结局保留+登记保持 created（不伪造清理，P21/P23）", async () => {
    const script = makePorts();
    // 非断连词族的停止失败（daemon 在场但脚本坏了）⇒ failed 分支
    script.setStopUnknown("停止脚本段缺失（夹具注入）");
    // 移除也被拒（如 daemon 恰好下线）⇒ 移除未确认
    script.ports.lifecycle.removeContainer = async () => {
      throw new Error("docker rm 被拒绝（夹具注入）");
    };
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({
      ok: true,
      outcome: "environment_failed",
      evidenceComplete: false,
    });
    if (result.ok) expect(result.detail).toContain("容器收尾未确认");
    expect(latestRegistrationPhase()).not.toBe("removed");
  });

  it("6.2 回归：passed 但收尾未确认 ⇒ 结局保留 passed，登记保持 created（交启动核查）", async () => {
    const script = makePorts();
    script.ports.lifecycle.removeContainer = async () => {
      throw new Error("docker rm 被拒绝（夹具注入）");
    };
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({ ok: true, outcome: "passed" });
    if (result.ok) expect(result.detail).toContain("容器收尾未确认");
    expect(latestRegistrationPhase()).not.toBe("removed");
  });

  it("6.2 回归：cancelled 但收尾未确认 ⇒ unknown（不声明已取消，P21）", async () => {
    const script = makePorts();
    // 移除被拒 ⇒ 收尾未确认
    script.ports.lifecycle.removeContainer = async () => {
      throw new Error("docker rm 被拒绝（夹具注入）");
    };
    // 用户停止信号：工作负载已确认停止但容器收不了 ⇒ unknown
    let commandRan = false;
    const originalRunCommand = script.ports.command.runCommand;
    Object.assign(script.ports, {
      command: {
        async runCommand(request: unknown) {
          const result = await originalRunCommand(request as never);
          commandRan = true;
          return result;
        },
      },
    });
    const result = await executeVerificationRun({
      ...params(script.ports),
      stopSignal: { isRequested: () => commandRan },
    });
    expect(result).toMatchObject({ ok: true, outcome: "unknown" });
    if (result.ok) expect(result.detail).toContain("收尾未确认");
    expect(latestRegistrationPhase()).not.toBe("removed");
  });

  it("容器已不存在（No such）⇒ 视作已收尾，结局照常", async () => {
    const script = makePorts();
    script.ports.lifecycle.removeContainer = async () => {
      throw new Error("Error: No such container: deadbeef");
    };
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({ ok: true, outcome: "passed" });
    if (result.ok) expect(result.detail).not.toContain("收尾未确认");
    expect(latestRegistrationPhase()).toBe("removed");
  });

  it("输入被改（采集 input_drifted）⇒ artifact_invalid（W01：改代码不是修复）", async () => {
    const script = makePorts();
    script.setCollectInputDrifted();
    expect(await executeVerificationRun(params(script.ports))).toMatchObject({
      ok: true,
      outcome: "artifact_invalid",
    });
  });

  it("采集发现非普通对象 ⇒ artifact_invalid（不静默跟随）", async () => {
    const script = makePorts();
    script.setCollectInvalidObjects();
    expect(await executeVerificationRun(params(script.ports))).toMatchObject({
      ok: true,
      outcome: "artifact_invalid",
    });
  });
});

describe("容器创建响应丢失窗口（P22 编排侧）", () => {
  it("create unknown 不可消解 ⇒ environment_failed + 登记保持 registered 等核查", async () => {
    const script = makePorts();
    script.setCreateUnknown();
    const result = await executeVerificationRun(params(script.ports));
    expect(result).toMatchObject({ ok: true, outcome: "environment_failed" });
    expect(latestRegistrationPhase()).toBe("registered");
  });
});

describe("用户停止信号（4.4：阶段边界观察，D6/P19/P21）", () => {
  it("执行前请求停止 ⇒ 停止确认后 cancelled；不采集不发布；容器移除+登记收尾", async () => {
    const script = makePorts();
    const signal = { isRequested: () => true };
    const result = await executeVerificationRun({
      ...params(script.ports),
      stopSignal: signal,
    });
    expect(result).toMatchObject({ ok: true, outcome: "cancelled", evidenceComplete: true });
    if (!result.ok) return;
    const events = readEvents(result.recordPath);
    expect(events.map((e) => e.type)).toEqual([
      "meta",
      "stage",
      "stage", // stopping（无 executing/command_*：停止发生在物化之前）
      "stop_confirmed",
      "terminated",
    ]);
    expect(script.calls.removed).toEqual([CONTAINER_ID]);
    expect(latestRegistrationPhase()).toBe("removed");
  });

  it("命令 exit 0 后请求停止 ⇒ cancelled 覆盖 passed（exit 0 不能洗掉停止事实）", async () => {
    const script = makePorts();
    // 信号在命令真正跑过之后才置真（阶段边界观察的语义：执行中不中断，边界收割）
    let commandRan = false;
    script.setCommandResult({ exitCode: 0 });
    const signal = { isRequested: () => commandRan };
    const originalRunCommand = script.ports.command.runCommand;
    script.ports.command = {
      async runCommand(request) {
        const result = await originalRunCommand(request);
        commandRan = true;
        return result;
      },
    };
    const result = await executeVerificationRun({
      ...params(script.ports),
      stopSignal: signal,
    });
    expect(result).toMatchObject({ ok: true, outcome: "cancelled" });
    if (!result.ok) return;
    const events = readEvents(result.recordPath);
    // 完整执行事实保留（command_start/end），但终局是 cancelled
    expect(events.map((e) => e.type)).toEqual([
      "meta",
      "stage",
      "stage",
      "command_start",
      "command_end",
      "stage",
      "stop_confirmed",
      "terminated",
    ]);
    expect(script.calls.removed).toEqual([CONTAINER_ID]);
  });

  it("未请求停止 ⇒ 行为不变（回归：passed 主路径不受影响）", async () => {
    const script = makePorts();
    const result = await executeVerificationRun({
      ...params(script.ports),
      stopSignal: { isRequested: () => false },
    });
    expect(result).toMatchObject({ ok: true, outcome: "passed" });
  });

  it("停止请求 + 静止失败 ⇒ unknown（不乐观宣布 cancelled，P19）", async () => {
    const script = makePorts();
    script.setStopNotQuiescent();
    const result = await executeVerificationRun({
      ...params(script.ports),
      stopSignal: { isRequested: () => true },
    });
    expect(result).toMatchObject({ ok: true, outcome: "unknown" });
  });
});
