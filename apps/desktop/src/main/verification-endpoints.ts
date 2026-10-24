import {
  type PreparationBackend,
  type VerificationRunPorts,
  executePreparation,
  executeVerificationRun,
  readLatestPreparedPreparation,
} from "@rebaseagent/project-verification";
import { CHANNELS } from "../shared/channels";
import type {
  VerificationPrepareRequest,
  VerificationPrepareResult,
  VerificationRunRequest,
  VerificationRunResult,
} from "../shared/ipc";
import {
  VerificationPrepareRequestSchema,
  VerificationPrepareResultSchema,
  VerificationRunRequestSchema,
  VerificationRunResultSchema,
} from "../shared/ipc";
import { type ActiveChannel, type ExecEndpointDeps, submitActive } from "./exec-endpoints";
import type { TrustedSender } from "./operation-endpoints";
import type { OperationContext } from "./operation-registry";
import { VerificationEndpointError } from "./verification-errors";

/**
 * verification:prepare / verification:run —— R3 两条主动执行端点（R3 tasks 4.2）。
 *
 * 与七主动入口同一套接受序列（sender → 信封 → epoch → 一次 parse → 判重/占槽 →
 * 编排 → 登记回执，见 exec-endpoints 的固定顺序）。R3 特有纪律：
 * - **目标摘要**：`verificationPrepare`（runId+checkpoint）/`verification`（另带
 *   commandId）——target run 只进 target，runIds 恒空（M01，registry 精炼把关）；
 * - **领域身份回调**：编排真实创建记录后 `attachPreparationId`/`attachVerificationId`
 *   ——身份登记后不因失败撤销（D03「已接受后失败保留已知验证身份」）；
 * - **计划绑定当前值**：planToken 由包层与当前（计划×策略×配方）比对，漂移即
 *   plan_stale 零副作用拒绝（P07/D02：旧确认失效，重新核对当前计划）；
 * - **镜像不来自 renderer**：run 的镜像 = main 从准备记录解析的最新已准备环境
 *   （readLatestPreparedPreparation，P08）；没有已准备环境 ⇒ R3_PREPARE_MISSING；
 * - **请求收尾与测试结局分层**（D04）：领域结局（D6 九行表）以 returned + 结局数据
 *   返回，不是请求层失败；门内拒绝/记录 I/O 失败才是 rejected（稳定码）。
 *
 * 后端注入：`deps.verification.backends` 由装配层给真实 Docker 实现（ipc.ts），
 * 测试注入 fake——端点语义（判重/占槽/响应丢失/接受后失败）不依赖真实引擎。
 */

/** R3 端点的结构依赖（真实实现见 ipc.ts 装配；测试注入 fake） */
export interface VerificationEndpointDeps {
  /** 验证数据根（verifications/ + verification-environments/ + verification-runtime/）。 */
  readonly dataRoot: string;
  readonly backends: {
    readonly preparation: PreparationBackend;
    readonly run: VerificationRunPorts;
  };
}

/** R3 端点的稳定业务错误码 */
export const VERIFICATION_ERROR = {
  /** main 未装配 R3 依赖（数据根/后端缺失） */
  notConfigured: "R3_NOT_CONFIGURED",
  /** 没有已准备环境（须先 verification:prepare） */
  prepareMissing: "R3_PREPARE_MISSING",
} as const;

/** 检查点 → 4.1 目标摘要的扁平定位（step 必带 stepSpanId，schema 已保证） */
function checkpointSummary(checkpoint: {
  kind: string;
  stepSpanId?: string;
}): { checkpointKind: "initial" | "step"; stepSpanId: string | null } {
  return checkpoint.kind === "step"
    ? { checkpointKind: "step", stepSpanId: checkpoint.stepSpanId ?? null }
    : { checkpointKind: "initial", stepSpanId: null };
}

// ---------------------------------------------------------------------------
// verification:prepare —— 环境准备（独立主动操作；与测试授权分开）
// ---------------------------------------------------------------------------

const prepareChannel: ActiveChannel<VerificationPrepareRequest, VerificationPrepareResult> = {
  channel: CHANNELS.verificationPrepare,
  schema: VerificationPrepareRequestSchema,
  targetOf: (business) => ({
    kind: "verificationPrepare",
    runId: business.target.runId,
    ...checkpointSummary(business.target.checkpoint),
  }),
  async run(deps, business, ctx) {
    const verification = deps.verification;
    if (verification === undefined) {
      throw new VerificationEndpointError(
        VERIFICATION_ERROR.notConfigured,
        "R3 依赖未装配（数据根/后端缺失），环境准备不可用",
      );
    }
    // 包层门序：授权门 → 形状门 → 计划漂移门（plan_stale 零副作用）→ 记录 → 构建
    const result = await executePreparation({
      dataRoot: verification.dataRoot,
      backend: verification.backends.preparation,
      epoch: deps.registry.epoch,
      operationId: ctx.operationId,
      input: {
        profileId: business.profileId,
        planToken: business.planToken,
        allowPrepare: business.allowPrepare,
      },
    });
    if (!result.ok) {
      // 已接受后失败：准备记录若已开出则保留真实身份（D03）
      if (result.preparationId !== null) {
        ctx.attachPreparationId(result.preparationId);
      }
      throw new VerificationEndpointError(
        `R3_PREPARE_${result.failure.code.toUpperCase()}`,
        result.failure.reason,
      );
    }
    ctx.attachPreparationId(result.preparationId);
    return VerificationPrepareResultSchema.parse({
      preparationId: result.preparationId,
      imageDigest: result.imageDigest,
      toolchain: result.toolchain,
      recordPath: result.recordPath,
    });
  },
};

// ---------------------------------------------------------------------------
// verification:run —— 项目验证执行（一次确认执行一次；不自动重试）
// ---------------------------------------------------------------------------

const runChannel: ActiveChannel<VerificationRunRequest, VerificationRunResult> = {
  channel: CHANNELS.verificationRun,
  schema: VerificationRunRequestSchema,
  targetOf: (business) => ({
    kind: "verification",
    runId: business.target.runId,
    ...checkpointSummary(business.target.checkpoint),
    commandId: business.commandId,
  }),
  async run(deps, business, ctx) {
    const verification = deps.verification;
    if (verification === undefined) {
      throw new VerificationEndpointError(
        VERIFICATION_ERROR.notConfigured,
        "R3 依赖未装配（数据根/后端缺失），项目验证不可用",
      );
    }
    const prepared = readLatestPreparedPreparation(verification.dataRoot);
    if (prepared === null) {
      throw new VerificationEndpointError(
        VERIFICATION_ERROR.prepareMissing,
        "没有已准备环境：先完成 verification:prepare（准备与测试分开确认，D02）",
      );
    }
    // 包层编排：门序（授权/形状/计划漂移/预检）→ 记录 → 容器 → 物化 → 执行 →
    // 停止 → 采集 → 终局。领域结局不是请求层失败：returned + 结局数据（D04）。
    const result = await executeVerificationRun({
      dataRoot: verification.dataRoot,
      dataDir: deps.dataDir,
      ports: verification.backends.run,
      epoch: deps.registry.epoch,
      operationId: ctx.operationId,
      input: business,
      preparation: prepared,
    });
    if (!result.ok) {
      // 门内拒绝（零副作用）或记录 I/O 失败：请求层失败，保留诊断
      throw new VerificationEndpointError(
        `R3_RUN_${result.failure.code.toUpperCase()}`,
        result.failure.reason,
      );
    }
    // 真实验证记录已创建（无论结局）⇒ 关联领域身份；runIds 恒空（M01）
    ctx.attachVerificationId(result.verificationId);
    return VerificationRunResultSchema.parse({
      verificationId: result.verificationId,
      outcome: result.outcome,
      detail: result.detail,
      evidenceComplete: result.evidenceComplete,
      recordPath: result.recordPath,
    });
  },
};

// ---------------------------------------------------------------------------
// 入口（与 exec-endpoints 的七主动入口同一公共段；sender/信封/判重/占槽全复用）
// ---------------------------------------------------------------------------

export async function execVerificationPrepare(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<unknown> {
  return submitActive(deps, sender, prepareChannel, payload);
}

export async function execVerificationRun(
  deps: ExecEndpointDeps,
  sender: TrustedSender,
  payload: unknown,
): Promise<unknown> {
  return submitActive(deps, sender, runChannel, payload);
}
