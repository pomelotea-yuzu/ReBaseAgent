import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliRunResult,
  type VerificationContainerLifecycle,
  type VerificationRunPorts,
  assertEngineHealthArgv,
  executePreparation,
  executeVerificationRun,
  publishAsset,
} from "@rebaseagent/project-verification";
import { currentPreparePlanToken } from "@rebaseagent/project-verification";
import { FILE_TOOLS_V1_DEFINITIONS, createIsolatedRun } from "@rebaseagent/replay";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecEndpointDeps } from "../src/main/exec-endpoints";
import type { TrustedSender } from "../src/main/operation-endpoints";
import { OperationRegistry } from "../src/main/operation-registry";
import { RequestFingerprinter } from "../src/main/operation-request";
import { execVerificationPrepare, execVerificationRun } from "../src/main/verification-endpoints";
import {
  type VerificationReadonlyDeps,
  verificationCapability,
  verificationGet,
  verificationList,
  verificationPreparePlan,
  verificationReadLog,
} from "../src/main/verification-read-endpoints";
import type { Envelope } from "../src/shared/ipc";

/**
 * R3 只读端点用例（4.3）：capability 计划预览与不可用原因（D01/P03）、list/get
 * 结构化降级（P15）、readLog 有界切片与截断事实（P16/D09）、引擎健康只读白名单
 * （D3：仅 version/info 类子命令）。
 */

const MAIN_FRAME: TrustedSender = { webContentsId: 7, frameRoutingId: 70 };
const LOG_TEXT = "a".repeat(40_000) + "TAIL";
const LOG_SHA = createHash("sha256").update(LOG_TEXT).digest("hex");

interface Fixture {
  dataDir: string;
  dataRoot: string;
  runId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  const source = mkdtempSync(join(tmpdir(), "r3-ro-src-"));
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src", "calc.ts"), "export const one = 1;\n");
  const dataDir = join(mkdtempSync(join(tmpdir(), "r3-ro-data-")), "data");
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
    userMessage: "R3 只读夹具",
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
  fixture = { dataDir, dataRoot: mkdtempSync(join(tmpdir(), "r3-ro-root-")), runId: created.id };
});

function makeDeps(overrides: Partial<VerificationReadonlyDeps> = {}): VerificationReadonlyDeps {
  return {
    dataRoot: fixture.dataRoot,
    dataDir: fixture.dataDir,
    docker: null,
    isTrustedSender: () => true,
    ...overrides,
  };
}

describe("引擎健康只读白名单（D3：不透传任意参数）", () => {
  it("version/info + {{json .}} 放行；exec/任意格式串/重复参数拒绝", () => {
    expect(() => assertEngineHealthArgv(["version", "--format", "{{json .}}"])).not.toThrow();
    expect(() => assertEngineHealthArgv(["info"])).not.toThrow();
    expect(() => assertEngineHealthArgv(["exec", "ctr", "sh"])).toThrow(/白名单拒绝/);
    expect(() => assertEngineHealthArgv(["push", "image"])).toThrow(/白名单拒绝/);
    expect(() =>
      assertEngineHealthArgv(["version", "--format", "raw {{.Server.Version}}"]),
    ).toThrow(/--format/);
    expect(() =>
      assertEngineHealthArgv(["version", "--format", "{{json .}}", "--format", "{{json .}}"]),
    ).toThrow(/重复参数/);
  });
});

describe("verification:capability（D01：预览与不可用原因）", () => {
  it("CLI 缺席 ⇒ 引擎 available:false + 可行动原因；计划 token 与来源事实照常聚合", async () => {
    const response = (await verificationCapability(makeDeps({ docker: null }), MAIN_FRAME, {
      runId: fixture.runId,
      checkpoint: { kind: "initial" },
      profileId: "node-ts-v1",
      commandId: "test",
    })) as Envelope<{
      engine: { available: boolean; reason: string | null };
      planToken: string;
      source: { snapshotId: string; fileCount: number } | null;
      prepared: unknown;
    }>;
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.engine.available).toBe(false);
    expect(response.data.engine.reason).toContain("不隐式安装");
    expect(response.data.planToken).toBe(currentPreparePlanToken());
    // 来源预检真读：初始快照 1 文件
    expect(response.data.source?.fileCount).toBe(1);
    expect(response.data.prepared).toBeNull();
  });

  it("有 CLI（fake runner）⇒ available + 引擎版本；argv 全程 version 探测（只读）", async () => {
    const seenArgv: string[][] = [];
    const fakeRunner: CliRunner = async (_exePath, args) =>
      ({
        exitCode: 0,
        stdout: JSON.stringify({ Server: { Version: "29.9.2" } }),
        stderr: "",
        spawnError: null,
        timedOut: false,
      }) as unknown as CliRunResult;
    void seenArgv;
    const deps = makeDeps({
      docker: {
        installation: { exePath: "C:\\x\\docker.exe", binDir: "C:\\x" },
        endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine" as const,
      },
      cliRunner: async (exePath, args, options) => {
        void exePath;
        void options;
        seenArgv.push(args);
        return fakeRunner("", args, {} as never);
      },
    });
    const response = (await verificationCapability(deps, MAIN_FRAME, {
      runId: fixture.runId,
      checkpoint: { kind: "initial" },
      profileId: "node-ts-v1",
      commandId: "test",
    })) as Envelope<{ engine: { available: boolean; engineVersion: string | null } }>;
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.engine.available).toBe(true);
    expect(response.data.engine.engineVersion).toBe("29.9.2");
    // 只读探测：唯一 docker 调用的子命令是 version（D3 白名单）
    for (const argv of seenArgv) {
      expect(argv.slice(2).filter((a) => !a.startsWith("--"))[0]).toBe("version");
    }
  });

  it("来源不可用（未知 runId）⇒ sourceFailure 结构化标注（不抛穿、可行动）", async () => {
    const response = (await verificationCapability(makeDeps(), MAIN_FRAME, {
      runId: "run_missing_src",
      checkpoint: { kind: "initial" },
      profileId: "node-ts-v1",
      commandId: "test",
    })) as Envelope<{ source: unknown; sourceFailure: { code: string } | null }>;
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.source).toBeNull();
    expect(response.data.sourceFailure?.code).toBe("run_not_found");
  });
});

describe("verification:preparePlan（P03：预览零副作用）", () => {
  it("返回固定计划+digest+token；数据根零写盘", async () => {
    const fingerprint = dirFingerprint(fixture.dataRoot);
    const response = verificationPreparePlan(makeDeps(), MAIN_FRAME, {
      profileId: "node-ts-v1",
    }) as Envelope<{
      planToken: string;
      plan: { downloads: unknown[]; networkScopeNote: string };
    }>;
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.planToken).toBe(currentPreparePlanToken());
    expect(Array.isArray(response.data.plan.downloads)).toBe(true);
    expect(response.data.plan.networkScopeNote).toContain("断网");
    expect(dirFingerprint(fixture.dataRoot)).toEqual(fingerprint);
  });
});

describe("verification:list / get（P15：坏尾/未知版本结构化降级）", () => {
  function seedRecord(id: string, seal: boolean): void {
    const dir = join(fixture.dataRoot, "verifications");
    mkdirSync(dir, { recursive: true });
    const meta = {
      type: "meta",
      schemaVersion: 1,
      verificationId: id,
      epoch: "11111111-1111-4111-8111-111111111111",
      operationId: "22222222-2222-4222-8222-222222222222",
      target: { runId: "run_x", checkpoint: { kind: "initial" }, snapshotId: "s" },
      profileId: "node-ts-v1",
      manifestVersion: 3,
      commandId: "test",
      planBindingDigest: "a".repeat(64),
      createdAt: "2026-10-25T00:00:00.000Z",
    };
    const lines = [JSON.stringify(meta)];
    if (seal) {
      lines.push(
        JSON.stringify({
          type: "terminated",
          outcome: "passed",
          detail: "ok",
          evidenceComplete: true,
          at: "2026-10-25T00:00:01.000Z",
        }),
      );
    }
    writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  }

  it("list 只扫 verifications/；sealed 呈现 outcome", () => {
    seedRecord("ver_list_a", true);
    const response = verificationList(makeDeps(), MAIN_FRAME, {}) as Envelope<{
      verifications: Array<{ verificationId: string; status: string; outcome: string | null }>;
    }>;
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const found = response.data.verifications.find((v) => v.verificationId === "ver_list_a");
    expect(found?.status).toBe("sealed");
    expect(found?.outcome).toBe("passed");
  });

  it("get：未封存 = unterminated；坏尾 = corrupt + 行号；缺失 = 信封失败", () => {
    seedRecord("ver_get_b", false);
    const okResponse = verificationGet(makeDeps(), MAIN_FRAME, {
      verificationId: "ver_get_b",
    }) as Envelope<{
      status: string;
      events: unknown[];
      meta: { runId: string; environment: unknown } | null;
      terminated: unknown;
      sourceStatus: string;
    }>;
    expect(okResponse.ok).toBe(true);
    if (okResponse.ok) {
      expect(okResponse.data.status).toBe("unterminated");
      // 5.4：记录头与来源状态随 get 返回；未封存 ⇒ terminated 为 null（不呈现结局）
      expect(okResponse.data.meta?.runId).toBe("run_x");
      expect(okResponse.data.meta?.environment).toBeNull();
      expect(okResponse.data.terminated).toBeNull();
      expect(okResponse.data.sourceStatus).toBe("missing");
    }

    const file = join(fixture.dataRoot, "verifications", "ver_get_b.jsonl");
    // 坏尾 = 崩溃半行（reader 语义：完整行缺终止=unterminated；半行=corrupt）
    writeFileSync(file, `${readFileSync(file, "utf8")}${'{"type":"stag'}`);
    const corrupt = verificationGet(makeDeps(), MAIN_FRAME, {
      verificationId: "ver_get_b",
    }) as Envelope<{ status: string; error: { reason: string } | null }>;
    expect(corrupt.ok).toBe(true);
    if (corrupt.ok) {
      expect(corrupt.data.status).toBe("corrupt");
      expect(corrupt.data.error?.reason).toContain("坏尾");
    }

    const missing = verificationGet(makeDeps(), MAIN_FRAME, {
      verificationId: "ver_none_z",
    }) as { ok: boolean; error?: { code: string } };
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("R3_VERIFICATION_NOT_FOUND");
  });

  it("真实执行记录 ⇒ get 带环境身份/终止事实/来源在场（5.4 比较条件）", async () => {
    const { verificationId } = await seedRunWithLog();
    const response = verificationGet(makeDeps(), MAIN_FRAME, { verificationId }) as Envelope<{
      status: string;
      meta: {
        runId: string;
        snapshotId: string;
        profileId: string;
        manifestVersion: number;
        commandId: string;
        planBindingDigest: string;
        environment: {
          preparationId: string;
          imageDigest: string;
          platform: string;
          toolchain: { node: string; typescript: string };
          limits: { cpus: number };
          security: { networkMode: string };
        } | null;
      } | null;
      terminated: { outcome: string; evidenceComplete: boolean } | null;
      sourceStatus: string;
    }>;
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.status).toBe("sealed");
    expect(response.data.meta?.runId).toBe(fixture.runId);
    expect(response.data.meta?.commandId).toBe("test");
    expect(response.data.meta?.environment).toMatchObject({
      preparationId: expect.stringMatching(/^prep-/),
      imageDigest: IMAGE,
      platform: "linux/amd64",
      toolchain: { node: "22.23.4", typescript: "5.9.3" },
      limits: { cpus: 1 },
      security: { networkMode: "none" },
    });
    expect(response.data.terminated).toMatchObject({ evidenceComplete: true });
    // 来源 run 的 trace 文件确实在场（P16 精确文件判定）
    expect(response.data.sourceStatus).toBe("present");
  });
});

describe("verification:readLog（P16/D09：有界切片与截断事实）", () => {
  it("默认 32 KiB 切片 + nextOffset 续读 + remaining/truncated（P16）", async () => {
    // 构造带 command_end 的记录 + 发布日志附件
    const { verificationId } = await seedRunWithLog();
    const first = verificationReadLog(makeDeps(), MAIN_FRAME, {
      verificationId,
      commandId: "test",
      stream: "stdout",
      offset: 0,
    }) as Envelope<{
      text: string;
      nextOffset: number;
      remaining: number;
      truncated: boolean;
      totalBytes: number;
    }>;
    if (!first.ok) console.log("READLOG FAIL:", JSON.stringify(first.error));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.totalBytes).toBe(LOG_TEXT.length);
    expect(first.data.truncated).toBe(true);
    expect(first.data.text.length).toBe(32_768);
    const second = verificationReadLog(makeDeps(), MAIN_FRAME, {
      verificationId,
      commandId: "test",
      stream: "stdout",
      offset: first.data.nextOffset,
    }) as Envelope<{ text: string; truncated: boolean; remaining: number }>;
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.truncated).toBe(false);
    expect(second.data.remaining).toBe(0);
    expect(second.data.text.endsWith("TAIL")).toBe(true);
  });

  it("无命令事实 ⇒ R3_LOG_NOT_AVAILABLE；上限 64 KiB 钳制", async () => {
    const dir = join(fixture.dataRoot, "verifications");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ver_nolog.jsonl"),
      `${JSON.stringify({
        type: "meta",
        schemaVersion: 1,
        verificationId: "ver_nolog",
        epoch: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        target: { runId: "run_x", checkpoint: { kind: "initial" }, snapshotId: "s" },
        profileId: "node-ts-v1",
        manifestVersion: 3,
        commandId: "test",
        planBindingDigest: "a".repeat(64),
        createdAt: "2026-10-25T00:00:00.000Z",
      })}\n`,
    );
    const missing = verificationReadLog(makeDeps(), MAIN_FRAME, {
      verificationId: "ver_nolog",
      commandId: "test",
      stream: "stdout",
      offset: 0,
    }) as { ok: boolean; error?: { code: string } };
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("R3_LOG_NOT_AVAILABLE");
  });
});

// ── 夹具 ─────────────────────────────────────────────────────────────────

async function seedRunWithLog(): Promise<{ verificationId: string }> {
  // 用执行链路造一条真记录（prepare + run，fake 后端；命令 stdout = 大日志）——
  // 编排层把双流保留字节发布为内容寻址附件，readLog 直接按记录内 command_end 回读
  const harness = makeExecHarness();
  const prepared = (await execVerificationPrepare(harness.deps, MAIN_FRAME, envelope(1))) as {
    ok: boolean;
  };
  expect(prepared.ok).toBe(true);
  const run = (await execVerificationRun(harness.deps, MAIN_FRAME, envelope(2))) as {
    ok: boolean;
    data?: { verificationId: string; recordPath: string };
  };
  expect(run.ok).toBe(true);
  return { verificationId: run.data?.verificationId ?? "" };
}

const EPOCH = "11111111-1111-4111-8111-111111111111";
const IMAGE = `sha256:${"d".repeat(64)}`;

function opId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function envelope(n: number): unknown {
  return {
    operation: { epoch: EPOCH, operationId: opId(n) },
    request:
      n === 1
        ? {
            target: { runId: fixture.runId, checkpoint: { kind: "initial" } },
            profileId: "node-ts-v1",
            planToken: currentPreparePlanToken(),
            allowPrepare: true,
          }
        : {
            target: { runId: fixture.runId, checkpoint: { kind: "initial" } },
            profileId: "node-ts-v1",
            commandId: "test",
            planToken: currentPreparePlanToken(),
            allowExecution: true,
          },
  };
}

function makeExecHarness(): { deps: ExecEndpointDeps } {
  const CONTAINER = "a".repeat(64);
  const lifecycle: VerificationContainerLifecycle = {
    async listOwnedContainers() {
      return [];
    },
    async stopContainer() {},
    async confirmStopped() {},
    async removeContainer() {},
    async startContainer() {},
    async createContainer() {
      return { containerId: CONTAINER };
    },
    async resolveContainerByName() {
      return null;
    },
  };
  const runPorts: VerificationRunPorts = {
    lifecycle,
    materialize: {
      async mkdirAll() {},
      async writeFile() {},
      async sha256OfFiles(_ref, paths) {
        const map = new Map<string, string>();
        const hash = createHash("sha256").update("export const one = 1;\n").digest("hex");
        for (const p of paths) map.set(p, hash);
        return map;
      },
    },
    command: {
      async runCommand() {
        return {
          exitCode: 0,
          timedOut: false,
          outputLimitHit: false,
          stdout: {
            retainedBytes: Buffer.from(LOG_TEXT),
            totalBytes: LOG_TEXT.length,
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
  const deps = {
    registry: new OperationRegistry({ newEpoch: () => EPOCH }),
    fingerprinter: new RequestFingerprinter() as never,
    isTrustedSender: () => true,
    repository: {} as never,
    settings: { load: () => null },
    execCwd: fixture.dataRoot,
    dataDir: fixture.dataDir,
    proxy: {} as never,
    sourceTokens: { consume: () => ({ ok: false, reason: "expired" as const }) },
    configState: { refresh: (() => undefined) as never },
    verification: {
      dataRoot: fixture.dataRoot,
      backends: {
        preparation: {
          async buildTrustedEnvironment() {
            return {
              imageDigest: IMAGE,
              toolchain: { node: "22.23.4", typescript: "5.9.3" },
              networkUsed: true,
              downloadedBytes: null,
            };
          },
        },
        run: runPorts,
      },
    },
  } as unknown as ExecEndpointDeps;
  return { deps };
}

function dirFingerprint(root: string): string[] {
  if (!readdirSyncSafe(root)) return [];
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

function readdirSyncSafe(root: string): boolean {
  try {
    readdirSync(root);
    return true;
  } catch {
    return false;
  }
}
