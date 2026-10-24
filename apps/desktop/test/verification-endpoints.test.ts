import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PreparationBackend,
  currentPreparePlanToken,
  executePreparation,
} from "@rebaseagent/project-verification";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecEndpointDeps } from "../src/main/exec-endpoints";
import type { TrustedSender } from "../src/main/operation-endpoints";
import { OperationRegistry } from "../src/main/operation-registry";
import type { RequestFingerprinter } from "../src/main/operation-request";
import { RequestFingerprinter as Fingerprinter } from "../src/main/operation-request";
import { execVerificationPrepare, execVerificationRun } from "../src/main/verification-endpoints";
import { CHANNELS } from "../src/shared/channels";

/**
 * R3 两条主动执行端点的端点级用例（4.2）：与七主动入口同一接受序列下的
 * R3 特有语义——计划绑定当前值（P07/D02）、领域身份回调（D03/M01）、
 * 请求收尾与测试结局分层（D04）、并发/响应丢失/旧 epoch（既有占槽语义复用）。
 * 后端注入 fake——端点语义不依赖真实引擎。
 */

const EPOCH = "11111111-1111-4111-8111-111111111111";
const MAIN_FRAME: TrustedSender = { webContentsId: 7, frameRoutingId: 70 };
const PLAN_TOKEN = currentPreparePlanToken();

interface RunFixture {
  dataDir: string;
  runId: string;
}

let runFixture: RunFixture;

beforeAll(async () => {
  const source = mkdtempSync(join(tmpdir(), "r3-ep-src-"));
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "calc.ts"), "export const one = 1;\n");
  const dataDir = join(mkdtempSync(join(tmpdir(), "r3-ep-data-")), "data");
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
      exec: { cwd: "D:/nope", signal: null },
      maxIterations: 10,
      budget: { maxTotalTokens: 100000 },
    },
    userMessage: "R3 端点夹具",
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
  if (!created.ok) throw new Error(`夹具 run 创建失败：${created.failure.code}`);
  runFixture = { dataDir, runId: created.id };
});

function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function envelope(n: number, request: unknown, epoch = EPOCH): unknown {
  return { operation: { epoch, operationId: opId(n) }, request };
}

function prepareRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    target: { runId: "run_src_1", checkpoint: { kind: "initial" } },
    profileId: "node-ts-v1",
    planToken: PLAN_TOKEN,
    allowPrepare: true,
    ...overrides,
  };
}

function runRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    target: { runId: runFixture.runId, checkpoint: { kind: "initial" } },
    profileId: "node-ts-v1",
    commandId: "test",
    planToken: PLAN_TOKEN,
    allowExecution: true,
    ...overrides,
  };
}

const IMAGE = `sha256:${"d".repeat(64)}`;

function fakePreparationBackend(calls: string[]): PreparationBackend {
  return {
    async buildTrustedEnvironment() {
      calls.push("build");
      return {
        imageDigest: IMAGE,
        toolchain: { node: "22.23.4", typescript: "5.9.3" },
        networkUsed: true,
        downloadedBytes: null,
      };
    },
  };
}

function fakeRunPorts(calls: string[]) {
  const CONTAINER = "a".repeat(64);
  return {
    lifecycle: {
      async listOwnedContainers() {
        return [];
      },
      async stopContainer() {},
      async confirmStopped() {},
      async removeContainer() {
        calls.push("remove");
      },
      async startContainer() {
        calls.push("start");
      },
      async createContainer() {
        calls.push("create");
        return { containerId: CONTAINER };
      },
      async resolveContainerByName() {
        return null;
      },
    },
    materialize: {
      async mkdirAll() {},
      async writeFile() {},
      async sha256OfFiles(_ref: string, paths: readonly string[]) {
        // 物化复核：返回真实文件哈希（与导入清单一致）
        const hash = createHash("sha256").update("export const one = 1;\n").digest("hex");
        const map = new Map<string, string>();
        for (const p of paths) map.set(p, hash);
        return map;
      },
    },
    command: {
      async runCommand() {
        calls.push("exec");
        return {
          exitCode: 0,
          timedOut: false,
          outputLimitHit: false,
          stdout: {
            retainedBytes: Buffer.from("# tests 2\n# pass 2\n"),
            totalBytes: 17,
            truncated: false,
          },
          stderr: { retainedBytes: Buffer.from(""), totalBytes: 0, truncated: false },
        };
      },
    },
    workloadStop: {
      async runStopWorkloads() {
        return { termSent: 0, killEscalated: 0, survivors: 0 };
      },
      async scanWorkState() {
        return "";
      },
    },
    collect: {
      async listNonRegularObjects() {
        return [];
      },
      async listWorkFilesWithSizes() {
        return [];
      },
      async sha256OfFiles() {
        return new Map<string, string>();
      },
      async readFile() {
        return Buffer.from("");
      },
    },
    quiescenceIntervalMs: 10,
    stabilityIntervalMs: 10,
  };
}

interface Harness {
  deps: ExecEndpointDeps;
  dataRoot: string;
  backendCalls: string[];
}

function makeHarness(options: { epoch?: string } = {}): Harness {
  const dataRoot = mkdtempSync(join(tmpdir(), "r3-ep-root-"));
  const backendCalls: string[] = [];
  const registry = new OperationRegistry({
    newEpoch: () => options.epoch ?? EPOCH,
    now: () => Date.now(),
  });
  const deps = {
    registry,
    fingerprinter: new Fingerprinter() as RequestFingerprinter,
    isTrustedSender: () => true,
    repository: {} as never,
    settings: { load: () => null },
    execCwd: dataRoot,
    dataDir: runFixture.dataDir,
    proxy: {} as never,
    sourceTokens: { consume: () => ({ ok: false, reason: "expired" as const }) },
    configState: { refresh: (() => undefined) as never },
    verification: {
      dataRoot,
      backends: {
        preparation: fakePreparationBackend(backendCalls),
        run: fakeRunPorts(backendCalls),
      },
    },
  } as unknown as ExecEndpointDeps;
  return { deps, dataRoot, backendCalls };
}

describe("verification:prepare（4.2 端点）", () => {
  it("成功：settled/returned + 真实 preparationId 关联（M01：runIds 恒空）", async () => {
    const h = makeHarness();
    const response = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(1, prepareRequest()),
    )) as { ok: boolean; data?: { preparationId: string }; operation?: { state: string } };
    expect(response.ok).toBe(true);
    expect(response.data?.preparationId).toMatch(/^prep-/);
    expect(response.operation?.state).toBe("settled");
    const record = h.deps.registry.recordOf(opId(1));
    expect(record?.requestOutcome).toBe("returned");
    expect(record?.preparationIds).toEqual([response.data?.preparationId]);
    expect(record?.runIds).toEqual([]);
  });

  it("计划漂移（P07/D02）⇒ rejected R3_PREPARE_PLAN_STALE；零副作用（无准备记录）", async () => {
    const h = makeHarness();
    const response = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(1, prepareRequest({ planToken: "stale" })),
    )) as { ok: boolean; error?: { code: string }; operation?: { state: string } };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("R3_PREPARE_PLAN_STALE");
    expect(response.operation?.state).toBe("settled");
    const record = h.deps.registry.recordOf(opId(1));
    expect(record?.preparationIds).toEqual([]);
    // 零副作用：verification-environments 目录不存在（门内拒绝不落盘）
    expect(() => readdirSync(join(h.dataRoot, "verification-environments"))).toThrow();
    expect(h.backendCalls).not.toContain("build");
  });

  it("allowPrepare:false ⇒ 形状门 INVALID_ARGUMENT（schema literal 是 P04 第一道）", async () => {
    const h = makeHarness();
    const response = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(1, prepareRequest({ allowPrepare: false })),
    )) as { ok: boolean; error?: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("INVALID_ARGUMENT");
    expect(h.backendCalls).toEqual([]);
  });

  it("构建失败（接受后失败）⇒ rejected + 已开准备记录身份保留（D03）", async () => {
    const h = makeHarness();
    // 让真实后端端口构建失败：swap preparation backend 为抛错实现
    h.deps.verification.backends.preparation = {
      async buildTrustedEnvironment() {
        h.backendCalls.push("build");
        throw new Error("[BUILD_FAILED] 模拟构建失败");
      },
    } as PreparationBackend;
    const response = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(1, prepareRequest()),
    )) as { ok: boolean; error?: { code: string }; operation?: { state: string } };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("R3_PREPARE_PREPARE_FAILED");
    const record = h.deps.registry.recordOf(opId(1));
    // D03：已接受后失败保留已知验证身份（失败记录也是真实创建的记录）
    expect(record?.preparationIds).toHaveLength(1);
    expect(record?.requestOutcome).toBe("rejected");
  });

  it("同 ID 重复提交（响应丢失后重发）⇒ duplicate 不二次执行（backend 调一次）", async () => {
    const h = makeHarness();
    const first = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(1, prepareRequest()),
    )) as { ok: boolean };
    expect(first.ok).toBe(true);
    const second = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(1, prepareRequest()),
    )) as { ok: boolean; error?: { code: string } };
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("OPERATION_DUPLICATED");
    expect(h.backendCalls.filter((c) => c === "build")).toHaveLength(1);
  });

  it("并发：同轮两个不同 ID 提交，只有一个被接受（既有占槽语义）", async () => {
    const h = makeHarness();
    // 让构建挂起，制造可竞争的执行窗口
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.deps.verification.backends.preparation = {
      async buildTrustedEnvironment() {
        h.backendCalls.push("build");
        await gate;
        return {
          imageDigest: IMAGE,
          toolchain: { node: "22.23.4", typescript: "5.9.3" },
          networkUsed: true,
          downloadedBytes: null,
        };
      },
    } as PreparationBackend;
    const first = execVerificationPrepare(h.deps, MAIN_FRAME, envelope(1, prepareRequest()));
    const second = execVerificationPrepare(h.deps, MAIN_FRAME, envelope(2, prepareRequest()));
    const secondResult = (await second) as { ok: boolean; error?: { code: string } };
    expect(secondResult.ok).toBe(false);
    expect(secondResult.error?.code).toBe("OPERATION_NOT_ACCEPTED");
    release?.();
    const firstResult = (await first) as { ok: boolean };
    expect(firstResult.ok).toBe(true);
  });

  it("旧 epoch ⇒ staleEpoch 零副作用（无登记、无执行）", async () => {
    const h = makeHarness();
    const response = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(1, prepareRequest(), "22222222-2222-4222-8222-222222222222"),
    )) as { ok: boolean; error?: { code: string }; operation: unknown };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("OPERATION_STALE_EPOCH");
    expect(response.operation).toBeNull();
    expect(h.deps.registry.size).toBe(0);
    expect(h.backendCalls).toEqual([]);
  });
});

describe("verification:run（4.2 端点）", () => {
  async function seedPrepared(h: Harness): Promise<void> {
    const result = await executePreparation({
      dataRoot: h.dataRoot,
      backend: fakePreparationBackend([]),
      epoch: EPOCH,
      operationId: opId(9),
      input: { profileId: "node-ts-v1", planToken: PLAN_TOKEN, allowPrepare: true },
    });
    if (!result.ok) throw new Error(`夹具准备失败：${result.failure.code}`);
  }

  it("无已准备环境 ⇒ rejected R3_PREPARE_MISSING（准备与测试分开确认，D02）", async () => {
    const h = makeHarness();
    const response = (await execVerificationRun(h.deps, MAIN_FRAME, envelope(1, runRequest()))) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("R3_PREPARE_MISSING");
    expect(h.deps.registry.recordOf(opId(1))?.state).toBe("settled");
  });

  it("成功路径：returned + 领域结局数据（D04 分层）+ verificationId 关联 + runIds 恒空", async () => {
    const h = makeHarness();
    await seedPrepared(h);
    const response = (await execVerificationRun(h.deps, MAIN_FRAME, envelope(1, runRequest()))) as {
      ok: boolean;
      data?: { verificationId: string; outcome: string };
      operation?: { state: string };
    };
    expect(response.ok).toBe(true);
    expect(response.data?.outcome).toBe("passed");
    expect(response.operation?.state).toBe("settled");
    const record = h.deps.registry.recordOf(opId(1));
    expect(record?.verificationIds).toEqual([response.data?.verificationId]);
    expect(record?.runIds).toEqual([]);
    expect(h.backendCalls).toEqual(["create", "start", "exec", "remove"]);
  });

  it("测试断言失败是领域结局不是请求失败：returned + outcome=check_failed（D04）", async () => {
    const h = makeHarness();
    await seedPrepared(h);
    // 让命令 exit 1 ⇒ check_failed
    h.deps.verification.backends.run.command = {
      async runCommand() {
        return {
          exitCode: 1,
          timedOut: false,
          outputLimitHit: false,
          stdout: { retainedBytes: Buffer.from("error TS"), totalBytes: 8, truncated: false },
          stderr: { retainedBytes: Buffer.from(""), totalBytes: 0, truncated: false },
        };
      },
    };
    const response = (await execVerificationRun(h.deps, MAIN_FRAME, envelope(1, runRequest()))) as {
      ok: boolean;
      data?: { outcome: string };
      operation?: { state: string };
    };
    expect(response.ok).toBe(true);
    expect(response.data?.outcome).toBe("check_failed");
    expect(response.operation?.state).toBe("settled");
  });

  it("计划漂移 ⇒ rejected R3_RUN_PLAN_STALE（包层门，零容器调用）", async () => {
    const h = makeHarness();
    await seedPrepared(h);
    const response = (await execVerificationRun(
      h.deps,
      MAIN_FRAME,
      envelope(1, runRequest({ planToken: "stale" })),
    )) as { ok: boolean; error?: { code: string } };
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("R3_RUN_PLAN_STALE");
    expect(h.backendCalls).toEqual([]);
  });

  it("R3 运行中占槽：另一主动请求 notAccepted busy（M02）", async () => {
    const h = makeHarness();
    await seedPrepared(h);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.deps.verification.backends.run.command = {
      async runCommand() {
        h.backendCalls.push("exec");
        await gate;
        return {
          exitCode: 0,
          timedOut: false,
          outputLimitHit: false,
          stdout: {
            retainedBytes: Buffer.from("# tests 2\n# pass 2\n"),
            totalBytes: 17,
            truncated: false,
          },
          stderr: { retainedBytes: Buffer.from(""), totalBytes: 0, truncated: false },
        };
      },
    };
    const running = execVerificationRun(h.deps, MAIN_FRAME, envelope(1, runRequest()));
    // 等进入执行段（prepare 命中记录 + exec 挂起）
    await new Promise((resolve) => setTimeout(resolve, 50));
    const other = (await execVerificationPrepare(
      h.deps,
      MAIN_FRAME,
      envelope(2, prepareRequest()),
    )) as { ok: boolean; error?: { code: string } };
    expect(other.ok).toBe(false);
    expect(other.error?.code).toBe("OPERATION_NOT_ACCEPTED");
    release?.();
    const done = (await running) as { ok: boolean };
    expect(done.ok).toBe(true);
  });

  it("R3 通道桥接面在 preload 白名单内且经执行信封（通道名核对）", () => {
    expect(CHANNELS.verificationPrepare).toBe("verification:prepare");
    expect(CHANNELS.verificationRun).toBe("verification:run");
  });

  it("夹具自检：seedPrepared 落真实准备记录（sealed/prepared）", async () => {
    const h = makeHarness();
    await seedPrepared(h);
    const files = readdirSync(join(h.dataRoot, "verification-environments"));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(h.dataRoot, "verification-environments", files[0]), "utf8");
    expect(text).toContain('"outcome":"prepared"');
  });
});
