import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPreparePlanToken } from "@rebaseagent/project-verification";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecEndpointDeps } from "../src/main/exec-endpoints";
import type { TrustedSender } from "../src/main/operation-endpoints";
import { OperationRegistry } from "../src/main/operation-registry";
import { RequestFingerprinter } from "../src/main/operation-request";
import {
  VerificationInFlightRegistry,
  execVerificationPrepare,
  execVerificationRun,
  execVerificationStop,
} from "../src/main/verification-endpoints";
import { CHANNELS } from "../src/shared/channels";
import type { Envelope } from "../src/shared/ipc";

/**
 * R3 定向停止端点用例（4.4；验收 D05/D06/P19/P21 切片）：
 * 校验序（sender → epoch → 登记存在 → target 类别 → 领域 ID 归属）全部在副作用前；
 * 幂等重复安全；迟到请求不停止新 owner；旧模型操作拒绝停止。
 */

const EPOCH = "11111111-1111-4111-8111-111111111111";
const MAIN_FRAME: TrustedSender = { webContentsId: 7, frameRoutingId: 70 };

/** 轮询到条件成立；慢 CI（2 CPU）上固定 sleep 会早于端点线程推进。 */
async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Fixture {
  dataDir: string;
  dataRoot: string;
  runId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  const source = mkdtempSync(join(tmpdir(), "r3-stop-src-"));
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "calc.ts"), "export const one = 1;\n");
  const dataDir = join(mkdtempSync(join(tmpdir(), "r3-stop-data-")), "data");
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
    userMessage: "R3 停止夹具",
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
  fixture = { dataDir, dataRoot: mkdtempSync(join(tmpdir(), "r3-stop-root-")), runId: created.id };
});

function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** 构造在飞验证：exec 段被门闩挂起，stop 请求置位后由门闩放行 */
function makeHarness() {
  const dataRoot = fixture.dataRoot;
  const inFlight = new VerificationInFlightRegistry();
  let releaseExec: (() => void) | null = null;
  const execGate = new Promise<void>((resolve) => {
    releaseExec = resolve;
  });
  let execEntered = false;
  const deps = {
    registry: new OperationRegistry({ newEpoch: () => EPOCH }),
    fingerprinter: new RequestFingerprinter(),
    isTrustedSender: () => true,
    repository: {} as never,
    settings: { load: () => null },
    execCwd: dataRoot,
    dataDir: fixture.dataDir,
    proxy: {} as never,
    sourceTokens: { consume: () => ({ ok: false, reason: "expired" as const }) },
    configState: { refresh: (() => undefined) as never },
    verification: {
      dataRoot,
      inFlight,
      backends: {
        preparation: {
          async buildTrustedEnvironment() {
            return {
              imageDigest: `sha256:${"d".repeat(64)}`,
              toolchain: { node: "22.23.4", typescript: "5.9.3" },
              networkUsed: true,
              downloadedBytes: null,
            };
          },
        },
        run: {
          lifecycle: {
            async listOwnedContainers() {
              return [];
            },
            async stopContainer() {},
            async confirmStopped() {},
            async removeContainer() {},
            async startContainer() {},
            async createContainer() {
              return { containerId: "a".repeat(64) };
            },
            async resolveContainerByName() {
              return null;
            },
          },
          materialize: {
            async mkdirAll() {},
            async writeFile() {},
            async sha256OfFiles(_ref: string, paths: readonly string[]) {
              const map = new Map<string, string>();
              const hash = createHash("sha256").update("export const one = 1;\n").digest("hex");
              for (const p of paths) map.set(p, hash);
              return map;
            },
          },
          command: {
            async runCommand() {
              execEntered = true;
              await execGate;
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
        },
      },
    },
  } as unknown as ExecEndpointDeps;
  return {
    deps,
    inFlight,
    releaseExec: releaseExec as unknown as () => void,
    execEnteredRef: () => execEntered,
  };
}

describe("verification:stop（D05：合法停止与幂等）", () => {
  it("在飞验证：stop 置位信号 ⇒ 编排边界收割 cancelled；重复 stop 幂等安全", async () => {
    const h = makeHarness();
    // 先落一份已准备环境
    const prepared = (await execVerificationPrepare(h.deps, MAIN_FRAME, {
      operation: { epoch: EPOCH, operationId: opId(9) },
      request: {
        target: { runId: fixture.runId, checkpoint: { kind: "initial" } },
        profileId: "node-ts-v1",
        planToken: currentPreparePlanToken(),
        allowPrepare: true,
      },
    })) as { ok: boolean };
    expect(prepared.ok).toBe(true);
    // 启动在飞 run
    const runPromise = execVerificationRun(h.deps, MAIN_FRAME, {
      operation: { epoch: EPOCH, operationId: opId(1) },
      request: {
        target: { runId: fixture.runId, checkpoint: { kind: "initial" } },
        profileId: "node-ts-v1",
        commandId: "test",
        planToken: currentPreparePlanToken(),
        allowExecution: true,
      },
    }) as Promise<Envelope<{ verificationId: string; outcome: string }>>;
    // 等 exec 段进入（在飞条目已登记）
    await waitFor(() => h.execEnteredRef(), "进入 exec 段");
    await waitFor(() => h.inFlight.lookup(opId(1)) !== null, "在飞登记已建立");
    expect(h.execEnteredRef()).toBe(true);
    // 第一次 stop：查在飞 verificationId（在飞登记可信）
    const inFlight = h.inFlight.lookup(opId(1));
    expect(inFlight).not.toBeNull();
    const first = execVerificationStop(h.deps, MAIN_FRAME, {
      epoch: EPOCH,
      operationId: opId(1),
      domainId: inFlight?.verificationId ?? "",
    }) as Envelope<{ stopping: boolean; alreadySettled: boolean }>;
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.stopping).toBe(true);
    // 重复 stop：幂等（仍是 stopping:true，不抛不重复副作用）
    const second = execVerificationStop(h.deps, MAIN_FRAME, {
      epoch: EPOCH,
      operationId: opId(1),
      domainId: inFlight?.verificationId ?? "",
    }) as Envelope<{ stopping: boolean }>;
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.stopping).toBe(true);
    // 放行 exec ⇒ 编排在停止边界收割 cancelled
    h.releaseExec();
    const run = await runPromise;
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.data.outcome).toBe("cancelled");
  });

  it("已收尾操作的 stop ⇒ 幂等 no-op（stopping:false + alreadySettled）", async () => {
    const h = makeHarness();
    const prepared = (await execVerificationPrepare(h.deps, MAIN_FRAME, {
      operation: { epoch: EPOCH, operationId: opId(9) },
      request: {
        target: { runId: fixture.runId, checkpoint: { kind: "initial" } },
        profileId: "node-ts-v1",
        planToken: currentPreparePlanToken(),
        allowPrepare: true,
      },
    })) as { ok: boolean; data?: { preparationId: string } };
    expect(prepared.ok).toBe(true);
    const stop = execVerificationStop(h.deps, MAIN_FRAME, {
      epoch: EPOCH,
      operationId: opId(9),
      domainId: prepared.data?.preparationId ?? "",
    }) as Envelope<{ stopping: boolean; alreadySettled: boolean; reason: string | null }>;
    expect(stop.ok).toBe(true);
    if (stop.ok) {
      expect(stop.data.stopping).toBe(false);
      expect(stop.data.alreadySettled).toBe(true);
    }
  });
});

describe("verification:stop（D06：非法目标副作用前拒绝）", () => {
  it("旧模型操作的 operationId ⇒ R3_STOP_NOT_VERIFICATION（保持原无取消契约）", async () => {
    const h = makeHarness();
    // 登记一条 create 操作（非 R3）
    h.deps.registry.registerRunning({
      operationId: opId(3),
      fingerprint: "f".repeat(64),
      target: { kind: "create", mode: "plain" },
    });
    const stop = execVerificationStop(h.deps, MAIN_FRAME, {
      epoch: EPOCH,
      operationId: opId(3),
      domainId: "whatever",
    }) as { ok: boolean; error?: { code: string } };
    expect(stop.ok).toBe(false);
    expect(stop.error?.code).toBe("R3_STOP_NOT_VERIFICATION");
  });

  it("领域 ID 与登记身份不符 ⇒ R3_STOP_IDENTITY_MISMATCH（不停止任意资源）", async () => {
    const h = makeHarness();
    h.deps.registry.registerRunning({
      operationId: opId(4),
      fingerprint: "f".repeat(64),
      target: {
        kind: "verification",
        runId: fixture.runId,
        checkpointKind: "initial",
        stepSpanId: null,
        commandId: "test",
      },
    });
    const stop = execVerificationStop(h.deps, MAIN_FRAME, {
      epoch: EPOCH,
      operationId: opId(4),
      domainId: "ver-not-registered",
    }) as { ok: boolean; error?: { code: string } };
    expect(stop.ok).toBe(false);
    expect(stop.error?.code).toBe("R3_STOP_IDENTITY_MISMATCH");
  });

  it("未登记 operationId ⇒ R3_STOP_UNKNOWN_TARGET（先核对，不猜测）", async () => {
    const h = makeHarness();
    const stop = execVerificationStop(h.deps, MAIN_FRAME, {
      epoch: EPOCH,
      operationId: opId(5),
      domainId: "ver-x",
    }) as { ok: boolean; error?: { code: string } };
    expect(stop.ok).toBe(false);
    expect(stop.error?.code).toBe("R3_STOP_UNKNOWN_TARGET");
  });

  it("旧 epoch ⇒ R3_STOP_STALE_EPOCH 零副作用", async () => {
    const h = makeHarness();
    const stop = execVerificationStop(h.deps, MAIN_FRAME, {
      epoch: "22222222-2222-4222-8222-222222222222",
      operationId: opId(1),
      domainId: "ver-x",
    }) as { ok: boolean; error?: { code: string } };
    expect(stop.ok).toBe(false);
    expect(stop.error?.code).toBe("R3_STOP_STALE_EPOCH");
  });

  it("迟到请求不停止新 owner：旧操作在飞条目已注销 ⇒ no-op", async () => {
    const h = makeHarness();
    // 模拟：旧操作曾在飞（登记后注销），新任务已占槽
    h.inFlight.register(opId(6), "ver-old");
    h.inFlight.unregister(opId(6));
    h.deps.registry.registerRunning({
      operationId: opId(7),
      fingerprint: "f".repeat(64),
      target: {
        kind: "verification",
        runId: fixture.runId,
        checkpointKind: "initial",
        stepSpanId: null,
        commandId: "test",
      },
    });
    // 旧操作的记录从未登记 verificationIds（身份检查先挡）——直接验证 lookup 语义：
    expect(h.inFlight.lookup(opId(6))).toBeNull();
    // 新 owner 的在飞条目不受影响（登记/注销互不串扰）
    const handle = h.inFlight.register(opId(7), "ver-new");
    expect(handle.isRequested()).toBe(false);
    handle.request();
    expect(handle.isRequested()).toBe(true);
  });
});

describe("verification:stop（通道面）", () => {
  it("通道名注册且是唯一 stop 通道", () => {
    expect(CHANNELS.verificationStop).toBe("verification:stop");
    const stopChannels = Object.values(CHANNELS).filter((v) => String(v).includes("stop"));
    expect(stopChannels).toEqual(["verification:stop"]);
  });
});
