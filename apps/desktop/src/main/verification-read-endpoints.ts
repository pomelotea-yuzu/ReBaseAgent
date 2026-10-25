import { join } from "node:path";
import {
  type CliRunner,
  type DockerCliInstallation,
  type LocalBackendEndpoint,
  NODE_TS_V1_PROFILE,
  type ProfileManifest,
  RecordReadError,
  assertEngineHealthArgv,
  buildPreparePlan,
  controlledCliEnv,
  currentPreparePlanToken,
  defaultCliRunner,
  dockerVersionArgv,
  getVerification,
  listVerifications,
  precheckVerificationSource,
  preflightLocalBackend,
  preparePlanDigest,
  readLatestPreparedPreparation,
  readLog,
} from "@rebaseagent/project-verification";
import { WORKSPACE_TRACES_DIR_NAME } from "@rebaseagent/replay";
import { CHANNELS } from "../shared/channels";
import type {
  VerificationCapabilityRequest,
  VerificationCapabilityResult,
  VerificationGetRequest,
  VerificationGetResult,
  VerificationListRequest,
  VerificationListResult,
  VerificationPreparePlanRequest,
  VerificationPreparePlanResult,
  VerificationReadLogRequest,
  VerificationReadLogResult,
} from "../shared/ipc";
import {
  VerificationCapabilityResultSchema,
  VerificationGetResultSchema,
  VerificationListResultSchema,
  VerificationPreparePlanResultSchema,
  VerificationReadLogResultSchema,
} from "../shared/ipc";
import { type Envelope, fail, ok } from "../shared/ipc";
import type { TrustedSender } from "./operation-endpoints";

/**
 * R3 只读端点（R3 tasks 4.3）：capability / preparePlan / list / get / readLog。
 *
 * 共同纪律（design D3）：
 * - **只读**：不下载、不建容器、不写记录/附件、不占槽、不登记 operation、不调模型、
 *   不执行/清理——读记录本身绝不触发核查写盘（D6）；
 * - **sender 校验**：与全部通道同一可信判据（主 frame）；
 * - **引擎健康白名单**（D3）：capability 的引擎探测仅允许枚举的只读 docker 子命令
 *   （version/info 类），argv 过 `assertEngineHealthArgv` 断言（包层实现+单测钉死），
 *   不透传任意参数；
 * - **有界**：日志 32 KiB 默认/64 KiB 上限切片（P13/P16/D09）；坏尾/未知版本/未封存
 *   结构化降级不抛穿（P15）；来源缺失只标注不猜同名（P16）。
 */

export interface VerificationReadonlyDeps {
  /** 验证数据根（与执行端点同一根）。 */
  readonly dataRoot: string;
  /** trace 数据目录（capability 来源预检真读用）。 */
  readonly dataDir: string;
  /** Docker CLI 可信位置；缺席 ⇒ 引擎健康 available:false（P01：不隐式安装） */
  readonly docker: {
    readonly installation: DockerCliInstallation;
    readonly endpoint: LocalBackendEndpoint;
  } | null;
  readonly isTrustedSender: (sender: TrustedSender) => boolean;
  /** CLI 运行器注入（测试 fake；缺省真实 spawn） */
  readonly cliRunner?: CliRunner;
  readonly profile?: ProfileManifest;
}

function untrusted(): Envelope<never> {
  return fail("UNTRUSTED_SENDER", new Error("只读通道只接受本应用窗口主 frame 的调用"));
}

/**
 * 冻结 manifest 的展示投影（5.1/D01）：限额与隔离基线进 capability 结果，renderer
 * 不在本地另存第二份 profile 数字（与「数字全部来自 main 的只读 IPC」同一纪律）。
 */
function verificationProfileSummary(profile: ProfileManifest) {
  return {
    profileId: profile.profileId,
    manifestVersion: profile.manifestVersion,
    platform: profile.platform,
    toolchain: profile.toolchain,
    sourceIncludeGlob: profile.sourceIncludeGlob,
    limits: profile.limits,
    security: profile.security,
  };
}

// ---------------------------------------------------------------------------
// verification:capability —— 计划预览与不可用原因（D01/P03）
// ---------------------------------------------------------------------------

export async function verificationCapability(
  deps: VerificationReadonlyDeps,
  sender: TrustedSender,
  request: VerificationCapabilityRequest,
): Promise<Envelope<VerificationCapabilityResult>> {
  if (!deps.isTrustedSender(sender)) return untrusted();
  const profile = deps.profile ?? NODE_TS_V1_PROFILE;
  if (request.profileId !== profile.profileId) {
    return fail(
      "R3_PROFILE_MISMATCH",
      new Error(`profile ${request.profileId} 不受当前 manifest 支持`),
    );
  }

  // 引擎健康（只读 version 探测；argv 过白名单断言——D3 硬规则）
  let engine: VerificationCapabilityResult["engine"];
  if (deps.docker === null) {
    engine = {
      available: false,
      engineVersion: null,
      reason: "未发现可信 Docker Desktop CLI（P01：不隐式安装、不回退宿主 Shell）",
    };
  } else {
    const argv = dockerVersionArgv(deps.docker.endpoint);
    try {
      // 纵深断言：探测 argv 必须属于只读白名单（不透传任意参数）
      assertEngineHealthArgv(argv.slice(2));
      const result = await (deps.cliRunner ?? defaultCliRunner)(
        deps.docker.installation.exePath,
        argv,
        {
          env: controlledCliEnv(deps.docker.installation),
          timeoutMs: 10_000,
          stdoutMaxBytes: 65536,
          stderrMaxBytes: 65536,
        },
      );
      if (result.exitCode === 0 && result.spawnError === null) {
        let version: string | null = null;
        try {
          const parsed = JSON.parse(result.stdout) as { Server?: { Version?: string } };
          version = parsed.Server?.Version ?? null;
        } catch {
          version = null;
        }
        engine = { available: true, engineVersion: version, reason: null };
      } else {
        engine = {
          available: false,
          engineVersion: null,
          reason: result.timedOut
            ? "引擎探测超时（未就绪或不可达）"
            : `引擎不可达（exit ${String(result.exitCode)}）`,
        };
      }
    } catch (error) {
      engine = {
        available: false,
        engineVersion: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // 已准备环境（最新 sealed+prepared；缺席 ⇒ null——须先 prepare）
  const preparedRecord = readLatestPreparedPreparation(deps.dataRoot);
  const prepared =
    preparedRecord === null
      ? null
      : {
          preparationId: preparedRecord.preparationId,
          imageDigest: preparedRecord.imageDigest,
          toolchain: { node: profile.toolchain.node, typescript: profile.toolchain.typescript },
        };

  // 来源预检（2.4 真读；拒绝/异常都结构化标注，不让 capability 变成执行）
  let source: VerificationCapabilityResult["source"] = null;
  let sourceFailure: VerificationCapabilityResult["sourceFailure"] = null;
  try {
    const precheck = await precheckVerificationSource({
      dataDir: deps.dataDir,
      runId: request.runId,
      checkpoint: request.checkpoint,
    });
    if (precheck.ok) {
      source = {
        snapshotId: precheck.value.snapshotId,
        fileCount: precheck.value.fileCount,
        totalBytes: precheck.value.totalBytes,
        stepSpanId: precheck.value.stepSpanId,
      };
    } else {
      sourceFailure = { code: precheck.failure.code, reason: precheck.failure.reason };
    }
  } catch (error) {
    sourceFailure = {
      code: "precheck_error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const data = VerificationCapabilityResultSchema.parse({
    planToken: currentPreparePlanToken(),
    prepared,
    engine,
    source,
    sourceFailure,
    profileSummary: verificationProfileSummary(profile),
  });
  return ok(data);
}

// ---------------------------------------------------------------------------
// verification:preparePlan —— 固定计划预览（D01/P03：预览零下载零容器零模型）
// ---------------------------------------------------------------------------

export function verificationPreparePlan(
  deps: VerificationReadonlyDeps,
  sender: TrustedSender,
  _request: VerificationPreparePlanRequest,
): Envelope<VerificationPreparePlanResult> {
  if (!deps.isTrustedSender(sender)) return untrusted();
  const profile = deps.profile ?? NODE_TS_V1_PROFILE;
  const plan = buildPreparePlan(profile);
  const data = VerificationPreparePlanResultSchema.parse({
    planDigest: preparePlanDigest(plan),
    planToken: currentPreparePlanToken(),
    plan,
  });
  return ok(data);
}

// ---------------------------------------------------------------------------
// verification:list / get —— 只读记录面（P15：坏尾/未知版本结构化降级）
// ---------------------------------------------------------------------------

export function verificationList(
  deps: VerificationReadonlyDeps,
  sender: TrustedSender,
  _request: VerificationListRequest,
): Envelope<VerificationListResult> {
  if (!deps.isTrustedSender(sender)) return untrusted();
  const summaries = listVerifications(deps.dataRoot).map((one) => ({
    verificationId: one.verificationId,
    status: one.status,
    outcome: one.outcome ?? null,
    runId: one.runId ?? null,
    commandId: one.commandId ?? null,
    createdAt: one.createdAt ?? null,
  }));
  return ok(VerificationListResultSchema.parse({ verifications: summaries }));
}

export function verificationGet(
  deps: VerificationReadonlyDeps,
  sender: TrustedSender,
  request: VerificationGetRequest,
): Envelope<VerificationGetResult> {
  if (!deps.isTrustedSender(sender)) return untrusted();
  try {
    // 5.4/D07：来源在场以 trace 实际文件为准（P16 缺失明确标注，不猜同名）
    const record = getVerification(deps.dataRoot, request.verificationId, {
      tracesRoot: join(deps.dataDir, WORKSPACE_TRACES_DIR_NAME),
    });
    const meta = record.meta;
    const terminated = record.terminated;
    const data = VerificationGetResultSchema.parse({
      verificationId: record.verificationId,
      status: record.status,
      events: record.events,
      error: record.error ?? null,
      meta:
        meta === undefined
          ? null
          : {
              runId: meta.target.runId,
              checkpoint: meta.target.checkpoint,
              snapshotId: meta.target.snapshotId,
              profileId: meta.profileId,
              manifestVersion: meta.manifestVersion,
              commandId: meta.commandId,
              planBindingDigest: meta.planBindingDigest,
              createdAt: meta.createdAt,
              environment: meta.environment ?? null,
            },
      terminated:
        terminated === undefined
          ? null
          : {
              outcome: terminated.outcome,
              detail: terminated.detail,
              evidenceComplete: terminated.evidenceComplete,
              at: terminated.at,
            },
      sourceStatus: record.sourceStatus,
    });
    return ok(data);
  } catch (error) {
    if (error instanceof RecordReadError && error.code === "RECORD_NOT_FOUND") {
      return fail("R3_VERIFICATION_NOT_FOUND", error);
    }
    return fail("R3_VERIFICATION_READ_FAILED", error);
  }
}

// ---------------------------------------------------------------------------
// verification:readLog —— 有界日志读取（P16/D09）
// ---------------------------------------------------------------------------

export function verificationReadLog(
  deps: VerificationReadonlyDeps,
  sender: TrustedSender,
  request: VerificationReadLogRequest,
): Envelope<VerificationReadLogResult> {
  if (!deps.isTrustedSender(sender)) return untrusted();
  // 附件哈希由 main 从记录内 command_end 事件解析（renderer 不传哈希，防指错附件）
  let record: ReturnType<typeof getVerification>;
  try {
    record = getVerification(deps.dataRoot, request.verificationId);
  } catch (error) {
    if (error instanceof RecordReadError && error.code === "RECORD_NOT_FOUND") {
      return fail("R3_VERIFICATION_NOT_FOUND", error);
    }
    return fail("R3_VERIFICATION_READ_FAILED", error);
  }
  const commandEnd = record.events.find(
    (event) => event.type === "command_end" && event.commandId === request.commandId,
  ) as { type: "command_end"; stdout: { sha256: string }; stderr: { sha256: string } } | undefined;
  if (commandEnd === undefined) {
    return fail(
      "R3_LOG_NOT_AVAILABLE",
      new Error(`记录 ${request.verificationId} 没有命令 ${request.commandId} 的执行事实`),
    );
  }
  const sha256 = request.stream === "stdout" ? commandEnd.stdout.sha256 : commandEnd.stderr.sha256;
  try {
    const slice = readLog(deps.dataRoot, sha256, {
      offset: request.offset,
      maxLength: request.maxLength,
    });
    return ok(VerificationReadLogResultSchema.parse(slice));
  } catch (error) {
    if (error instanceof RecordReadError) {
      return fail(`R3_LOG_${error.code}`, error);
    }
    return fail("R3_LOG_READ_FAILED", error);
  }
}

/** 通道名 → 只读端点的装配映射（ipc.ts 薄适配用；防通道/端点错配） */
export const VERIFICATION_READONLY_ENDPOINTS = {
  capability: CHANNELS.verificationCapability,
  preparePlan: CHANNELS.verificationPreparePlan,
  list: CHANNELS.verificationList,
  get: CHANNELS.verificationGet,
  readLog: CHANNELS.verificationReadLog,
} as const;
