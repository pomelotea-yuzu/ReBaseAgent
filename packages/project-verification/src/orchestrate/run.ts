import { randomBytes } from "node:crypto";
import {
  type ArtifactCollectionBackend,
  artifactsRecordEvent,
  collectArtifacts,
} from "../collect/collect.js";
import { containerRunFlags } from "../docker/container-flags.js";
import {
  type ContainerCommandBackend,
  classifyExecutionReport,
  commandEndEvent,
  commandStartEvent,
  executeFixedCommand,
  resolveFixedCommand,
  validateTestReport,
} from "../execute/command-runner.js";
import { type WorkloadStopBackend, stopWorkloadsAndConfirm } from "../execute/stop.js";
import {
  type ContainerWriteBackend,
  type VerifiedByteReader,
  createSnapshotByteReader,
  materializeVerificationSnapshot,
} from "../materialize/materialize.js";
import { currentPreparePlanToken } from "../prepare/plan.js";
import { publishAsset } from "../records/assets.js";
import { verificationRecordPath } from "../records/layout.js";
import { VerificationRecordWriter } from "../records/writer.js";
import { type RuntimeContainerCreatePort, createRegisteredContainer } from "../runtime/create.js";
import type { RuntimeResourcePort, reconcileStartupLeftovers } from "../runtime/reconcile.js";
import { type RegistrationRequest, markResourceRemoved } from "../runtime/registration.js";
import {
  NODE_TS_V1_PROFILE,
  type ProfileManifest,
  type VerificationOutcome,
  VerificationRunInputSchema,
} from "../schema.js";
import { precheckVerificationSource } from "../source/precheck.js";

/**
 * 验证运行编排（R3 tasks 4.2 的包层底座）：把 3.x 各阶段模块组合为**一次**验证——
 * 门序 → 开验证记录 → 登记+建容器 → 物化 → 固定命令执行 → 停止确认 → 采集 → 终局。
 *
 * 纪律（design D5/D6 + 各阶段实测）：
 * - **门内零副作用**：授权（`allowExecution` 显式 true）、形状（全 strict）、计划漂移
 *   （planToken ≠ 当前 ⇒ plan_stale，P07）都先于开记录/建容器；
 * - **记录先于资源**：meta 首行落盘后才登记/建容器——崩溃现场由 3.7 启动核查收尾；
 * - **镜像不来自调用方**：`preparation.imageDigest` 由 main 从准备记录解析（P08——
 *   renderer/输入无镜像字段）；编排只消费；
 * - **结局按 D6 九行表映射**：基础设施故障 ≠ 项目断言失败；停止未确认 ⇒ unknown，
 *   槽语义归操作登记层；evidence_incomplete 保留真实 exit（截断不能绿色通过）；
 * - **幂等收尾**：明确未创建/正常终局 ⇒ 登记收尾 removed；unknown/断连 ⇒ 登记保持
 *   registered/created，由启动核查收尾（复跑不重复建资源、不乐观宣布）。
 */

/** 容器生命周期端口 = 核查端口 + 启动（物化/exec 要求容器 running）。 */
export interface VerificationContainerLifecycle
  extends RuntimeResourcePort,
    RuntimeContainerCreatePort {
  startContainer(containerId: string): Promise<void>;
}

export interface VerificationRunPorts {
  readonly lifecycle: VerificationContainerLifecycle;
  readonly materialize: ContainerWriteBackend;
  readonly command: ContainerCommandBackend;
  readonly workloadStop: WorkloadStopBackend;
  readonly collect: ArtifactCollectionBackend;
  /** 源快照字节读取（trace 工作区 blob readVerified 包装）；缺省 createSnapshotByteReader。 */
  readonly readBytes?: VerifiedByteReader;
  /** 创建端口（缺省 = lifecycle 同时实现创建面的那部分）。 */
  readonly create?: RuntimeContainerCreatePort;
  /** 停止静止双扫间隔（透传 3.5；缺省 2000ms）。 */
  readonly quiescenceIntervalMs?: number;
  /** 采集稳定双扫间隔（透传 3.6；缺省 2000ms）。 */
  readonly stabilityIntervalMs?: number;
}

export type VerificationRunFailureCode =
  | "invalid_input"
  | "run_not_allowed"
  | "plan_stale"
  | "profile_mismatch"
  | "source_rejected"
  | "record_io_failed";

export interface VerificationRunSuccess {
  readonly ok: true;
  readonly verificationId: string;
  readonly outcome: VerificationOutcome;
  readonly detail: string;
  readonly evidenceComplete: boolean;
  readonly recordPath: string;
}

export interface VerificationRunFailure {
  readonly ok: false;
  readonly failure: { readonly code: VerificationRunFailureCode; readonly reason: string };
  /** 已开出验证记录则带出（审计/恢复入口）；门内拒绝（零副作用）为 null。 */
  readonly verificationId: string | null;
  readonly recordPath: string | null;
}

export type VerificationRunResult = VerificationRunSuccess | VerificationRunFailure;

/**
 * 用户停止信号（4.4 / design D6）：main 的 stop 端点置位，编排只在**阶段边界**
 * 观察（不打断容器内 exec——工作负载的定向停止确认仍走 3.5 脚本）。请求只表示
 * stopping：确认全部停止（quiescent）才落 `cancelled`；此前任何终局都不会把
 * 更早的停止事实洗成通过（P19/P21）。
 */
export interface VerificationStopSignal {
  isRequested(): boolean;
}

export interface ExecuteVerificationRunParams {
  /** 验证数据根（verifications/ + verification-assets/ + verification-runtime/）。 */
  readonly dataRoot: string;
  /** trace 数据目录（工作区 blob 来源；与 dataRoot 是两个根）。 */
  readonly dataDir: string;
  readonly ports: VerificationRunPorts;
  readonly epoch: string;
  readonly operationId: string;
  /** 未信输入：包层先过授权/形状/计划漂移门。 */
  readonly input: unknown;
  /** main 侧从准备记录解析的准备事实（P08：镜像与准备身份不来自 renderer 输入）。 */
  readonly preparation: { readonly preparationId: string; readonly imageDigest: string };
  /** 用户停止信号（可选；阶段边界观察，D6/P19/P21） */
  readonly stopSignal?: VerificationStopSignal;
  readonly profile?: ProfileManifest;
  readonly now?: () => Date;
  readonly mintVerificationId?: () => string;
}

function failure(
  code: VerificationRunFailureCode,
  reason: string,
  verificationId: string | null = null,
  recordPath: string | null = null,
): VerificationRunFailure {
  return { ok: false, failure: { code, reason }, verificationId, recordPath };
}

function defaultMintVerificationId(): string {
  return `ver-${randomBytes(8).toString("hex")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 尽力收尾：移除容器（失败留给启动核查，不抛错不掩盖主因）。 */
async function removeContainerQuietly(
  lifecycle: VerificationContainerLifecycle,
  containerId: string | null,
): Promise<void> {
  if (containerId === null) return;
  try {
    await lifecycle.removeContainer(containerId);
  } catch {
    /* 启动核查按登记收尾 */
  }
}

function markRegistrationRemovedQuietly(dataRoot: string, resourceOwnerId: string | null): void {
  if (resourceOwnerId === null) return;
  try {
    markResourceRemoved(dataRoot, resourceOwnerId);
  } catch {
    /* 启动核查可重入收尾 */
  }
}

export async function executeVerificationRun(
  params: ExecuteVerificationRunParams,
): Promise<VerificationRunResult> {
  const now = params.now ?? (() => new Date());
  const at = () => now().toISOString();
  const mint = params.mintVerificationId ?? defaultMintVerificationId;
  const profile = params.profile ?? NODE_TS_V1_PROFILE;

  // ── 门 1：当前授权（P07：与准备授权分开，缺显式 true 即拒）──────────────────
  const allowExecution = (params.input as { allowExecution?: unknown } | null)?.allowExecution;
  if (allowExecution !== true) {
    return failure(
      "run_not_allowed",
      "缺少当前显式授权 allowExecution:true：项目验证必须经用户对当前计划的确认（P07）",
    );
  }
  // ── 门 2：请求形状（全 strict；selector/命令枚举在此拒绝）───────────────────
  const parsed = VerificationRunInputSchema.safeParse(params.input);
  if (!parsed.success) {
    return failure(
      "invalid_input",
      `验证请求不符合 schema：${parsed.error.issues[0]?.message ?? ""}`,
    );
  }
  const input = parsed.data;
  // ── 门 3：profile 一致（schema 钉 literal，这里复核 manifest 本体）───────────
  if (input.profileId !== profile.profileId) {
    return failure(
      "profile_mismatch",
      `请求 profile ${input.profileId} 与当前 manifest ${profile.profileId} 不一致：拒绝执行`,
    );
  }
  // ── 门 4：计划漂移（P07）：token ≠ 当前（计划×策略×配方）⇒ 零副作用拒绝 ─────
  if (input.planToken !== currentPreparePlanToken()) {
    return failure(
      "plan_stale",
      "计划已变化（manifest×策略×配方 token 不匹配）：旧确认失效，须重新核对当前计划（P07）",
    );
  }

  // ── 门 5：来源预检（2.4：显式检查点/来源完整性/配额）——先于任何写盘 ─────────
  const precheck = await precheckVerificationSource({
    dataDir: params.dataDir,
    runId: input.target.runId,
    checkpoint: input.target.checkpoint,
  });
  if (!precheck.ok) {
    return failure(
      "source_rejected",
      `来源预检未通过（${precheck.failure.code}）：${precheck.failure.reason}`,
    );
  }
  const facts = precheck.value;
  const command = resolveFixedCommand(profile, input.commandId);
  if (command === null) {
    return failure(
      "invalid_input",
      `命令 ${input.commandId} 不在 manifest 冻结命令表（P08 执行侧）`,
    );
  }

  // ── 记录先于资源：开验证记录（meta 首行）──────────────────────────────────
  const verificationId = mint();
  let writer: VerificationRecordWriter;
  let recordPath: string;
  try {
    writer = VerificationRecordWriter.open(params.dataRoot, {
      verificationId,
      epoch: params.epoch,
      operationId: params.operationId,
      target: {
        runId: input.target.runId,
        checkpoint: input.target.checkpoint,
        snapshotId: facts.snapshotId,
      },
      profileId: profile.profileId,
      manifestVersion: profile.manifestVersion,
      commandId: input.commandId,
      planBindingDigest: input.planToken,
      createdAt: at(),
      // 5.4/P24/P25：实际环境身份随记录落盘（比较条件不能只靠摘要推断）
      environment: {
        preparationId: params.preparation.preparationId,
        imageDigest: params.preparation.imageDigest,
        platform: profile.platform,
        toolchain: profile.toolchain,
        limits: profile.limits,
        security: profile.security,
      },
    });
    recordPath = verificationRecordPath(params.dataRoot, verificationId);
  } catch (error) {
    return failure("record_io_failed", `验证记录创建失败：${describe(error)}`);
  }

  const terminate = (
    outcome: VerificationOutcome,
    detail: string,
    evidenceComplete: boolean,
  ): VerificationRunResult => {
    try {
      writer.terminate({ outcome, detail, evidenceComplete, at: at() });
    } catch (error) {
      writer.abortClose();
      return failure(
        "record_io_failed",
        `验证记录终止失败：${describe(error)}`,
        verificationId,
        recordPath,
      );
    }
    return { ok: true, verificationId, outcome, detail, evidenceComplete, recordPath };
  };

  try {
    writer.append({ type: "stage", phase: "materializing", at: at() });

    // ── 登记 + 建容器（3.7：登记先于创建；镜像 = 已准备环境，P08）──────────────
    const registrationRequest: RegistrationRequest = {
      kind: "verification",
      epoch: params.epoch,
      dataRoot: params.dataRoot,
      verificationId,
    };
    const created = await createRegisteredContainer({
      root: params.dataRoot,
      port: params.ports.create ?? params.ports.lifecycle,
      request: registrationRequest,
      imageRef: params.preparation.imageDigest,
      runFlags: containerRunFlags(profile),
      command: ["/bin/sh", profile.trustedEnvironment.supervisor.path],
    });
    if (!created.ok) {
      if (created.kind === "unknown") {
        // 响应丢失窗口不可消解：登记保持 registered ⇒ 启动核查收尾（P22）
        return terminate("environment_failed", `受控容器创建结果未知：${created.reason}`, false);
      }
      // failed / stale-name：明确未创建容器；本登记收尾（无资源可清理）
      markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
      return terminate(
        "environment_failed",
        `受控容器创建未成功（${created.kind}）：${created.reason}`,
        false,
      );
    }
    const containerId = created.containerId;

    // 启动（物化/exec 要求 running）
    try {
      await params.ports.lifecycle.startContainer(containerId);
    } catch (error) {
      await removeContainerQuietly(params.ports.lifecycle, containerId);
      markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
      return terminate("environment_failed", `容器启动失败：${describe(error)}`, false);
    }

    // ── 停止序列（局部复用）：定向停止 → 双扫确认 → stop_confirmed 事件 ─────────
    const runStopPhase = async (): Promise<
      | { kind: "confirmed" }
      | { kind: "unknown"; reason: string }
      | { kind: "failed"; reason: string }
    > => {
      writer.append({ type: "stage", phase: "stopping", at: at() });
      const stopped = await stopWorkloadsAndConfirm({
        containerRef: containerId,
        backend: params.ports.workloadStop,
        quiescenceIntervalMs: params.ports.quiescenceIntervalMs,
      });
      if (!stopped.ok) {
        return stopped.kind === "unknown"
          ? { kind: "unknown", reason: stopped.reason }
          : { kind: "failed", reason: stopped.reason };
      }
      if (!stopped.quiescent) {
        return {
          kind: "unknown",
          reason: "工作负载未全部停止或 /work 仍在变化：不发布任何结论（P19）",
        };
      }
      writer.append({
        type: "stop_confirmed",
        stoppedPidCount: stopped.stoppedPidCount,
        quiescenceMs: stopped.quiescenceMs,
        at: at(),
      });
      return { kind: "confirmed" };
    };
    /** 用户取消终局（已确认全部停止后）：先真清理后写事实。 */
    const finishCancelled = async (): Promise<VerificationRunResult> => {
      await removeContainerQuietly(params.ports.lifecycle, containerId);
      markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
      return terminate("cancelled", "用户停止：全部工作负载已确认停止并收尾", true);
    };

    // 阶段边界观察停止信号（D6：请求只表示 stopping；确认全部停止才 cancelled）
    if (params.stopSignal?.isRequested() === true) {
      const stopPhase = await runStopPhase();
      if (stopPhase.kind === "unknown") {
        return terminate("unknown", `停止结果未知：${stopPhase.reason}`, false);
      }
      if (stopPhase.kind === "failed") {
        await removeContainerQuietly(params.ports.lifecycle, containerId);
        markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
        return terminate("environment_failed", `停止失败：${stopPhase.reason}`, false);
      }
      return finishCancelled();
    }

    // ── 物化（3.3：清单校验先于写入；字节经 readVerified 重读核验）──────────────
    const materialized = await materializeVerificationSnapshot({
      containerRef: containerId,
      backend: params.ports.materialize,
      files: facts.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      readBytes: params.ports.readBytes ?? createSnapshotByteReader(params.dataDir),
    });
    if (!materialized.ok) {
      await removeContainerQuietly(params.ports.lifecycle, containerId);
      markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
      return terminate(
        "environment_failed",
        `物化未完成（${materialized.failure.code}）：${materialized.failure.reason}`,
        false,
      );
    }

    // ── 执行（3.4：命令仅 manifest 查表；双时钟报告）──────────────────────────
    writer.append({ type: "stage", phase: "executing", at: at() });
    const execution = await executeFixedCommand({
      containerRef: containerId,
      command,
      limits: profile.limits,
      backend: params.ports.command,
    });
    if (!execution.ok) {
      await removeContainerQuietly(params.ports.lifecycle, containerId);
      markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
      return terminate("environment_failed", execution.failure.reason, false);
    }
    const report = execution.report;
    writer.append(commandStartEvent(report));
    writer.append(commandEndEvent(report));
    // 日志持久化（D4「日志内容寻址」）：双流保留字节发布为内容寻址附件——记录里的
    // sha256 由此可回读（readLog 先整体验哈希再切片，P16）。发布失败不掩盖执行事实：
    // 记录仍持有哈希，读取侧如实呈现 ASSET_MISSING（P16「附件缺失有明确状态」）。
    try {
      publishAsset(params.dataRoot, report.stdout.retainedBytes);
      publishAsset(params.dataRoot, report.stderr.retainedBytes);
    } catch {
      /* 日志附件发布失败不改变结局；读取侧按缺附件状态呈现 */
    }
    const classified = classifyExecutionReport(report);

    // ── 停止（3.5：owner 定向 + 双扫静止确认；不乐观宣布）────────────────────
    const stopPhase = await runStopPhase();
    if (stopPhase.kind === "unknown") {
      // daemon 不可达/停止响应丢失：不声明已停止、不采集、不移除容器；
      // 登记保持 created ⇒ 启动核查收尾（P21/P23）；结局 unknown（D6 行）
      return terminate("unknown", `停止结果未知：${stopPhase.reason}`, false);
    }
    if (stopPhase.kind === "failed") {
      await removeContainerQuietly(params.ports.lifecycle, containerId);
      markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
      return terminate("environment_failed", `停止失败：${stopPhase.reason}`, false);
    }

    // 用户停止（exit 0 不能覆盖更早的停止事实，D6）：确认全部停止 ⇒ cancelled，
    // 不采集不发布（P19：停止未确认不得发布；已确认 ⇒ 用户意图优先于检查结果）
    if (params.stopSignal?.isRequested() === true) {
      return finishCancelled();
    }

    // ── 采集（3.6：内容级双扫 + 输入锚定 + 配额 + 发布）───────────────────────
    writer.append({ type: "stage", phase: "collecting", at: at() });
    const collected = await collectArtifacts({
      containerRef: containerId,
      backend: params.ports.collect,
      dataRoot: params.dataRoot,
      profile,
      inputManifest: facts.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      stabilityIntervalMs: params.ports.stabilityIntervalMs,
    });
    if (!collected.ok) {
      await removeContainerQuietly(params.ports.lifecycle, containerId);
      markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
      return terminate(
        "artifact_invalid",
        `采集拒绝（${collected.failure.code}）：${collected.failure.reason}`,
        false,
      );
    }
    writer.append(artifactsRecordEvent(collected, profile));

    // ── 终局分类（D6 九行表；evidence_incomplete 保留真实 exit）───────────────
    const streamsTruncated = report.stdout.truncated || report.stderr.truncated;
    let outcome: VerificationOutcome;
    let detail: string;
    if (classified === "completed") {
      if (report.exitCode !== 0) {
        // completed 分类覆盖 0–125；非零即检查失败（真实 exit 保留在 detail，P20）
        outcome = "check_failed";
        detail = `检查失败（exit ${String(report.exitCode)}）：可信断言未通过`;
      } else if (streamsTruncated) {
        // 6.2 实机发现：保留日志被截断时 TAP 摘要可能落在丢弃区——先判证据不完整，
        // 不能把"看不到摘要"误报成断言失败，也不能当作通过（P13）。
        outcome = "evidence_incomplete";
        detail = "命令 exit 0 但输出被截断：不能当作完整证据（保留真实 exit）";
      } else if (input.commandId === "test") {
        const tap = validateTestReport(
          Buffer.from(report.stdout.retainedBytes).toString("utf8"),
          profile.trustedEnvironment.expectedTestCount,
        );
        if (!tap.ok) {
          outcome = "check_failed";
          detail = `可信测试断言失败：${tap.reason}`;
        } else {
          outcome = "passed";
          detail = `命令完成（exit 0，${report.durationMs}ms），检查通过`;
        }
      } else {
        outcome = "passed";
        detail = `命令完成（exit 0，${report.durationMs}ms），检查通过`;
      }
    } else if (classified === "start_failed") {
      outcome = "start_failed";
      detail = `命令启动失败（exit ${String(report.exitCode)}）`;
    } else if (classified === "timed_out") {
      outcome = "timed_out";
      detail = `命令超时被击杀（${report.durationMs}ms）`;
    } else if (classified === "output_limit_stopped") {
      outcome = "output_limit";
      detail = "总观测输出超限被实时击杀（P13）";
    } else {
      outcome = "process_failed";
      detail = `进程异常终止（exit ${String(report.exitCode)}；signal 为退出码推导）`;
    }
    const evidenceComplete = !streamsTruncated;

    // 收尾：先真清理后写事实（移除容器 + 登记收尾 + 终止记录）
    await removeContainerQuietly(params.ports.lifecycle, containerId);
    markRegistrationRemovedQuietly(params.dataRoot, created.registration.resourceOwnerId);
    return terminate(outcome, detail, evidenceComplete);
  } catch (error) {
    writer.abortClose();
    return failure(
      "record_io_failed",
      `验证编排异常终止：${describe(error)}`,
      verificationId,
      recordPath,
    );
  }
}

// reconcileStartupLeftovers 在此模块不被调用（启动核查由 main 启动互斥区触发，4.5）；
// 显式再导出保持端口类型来源单一。
export type { RuntimeResourcePort, reconcileStartupLeftovers };
