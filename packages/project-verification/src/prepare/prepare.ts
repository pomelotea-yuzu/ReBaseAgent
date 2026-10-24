import { randomBytes } from "node:crypto";
import { preparationRecordPath } from "../records/layout.js";
import { PreparationRecordWriter } from "../records/writer.js";
import {
  ImageDigestSchema,
  NODE_TS_V1_PROFILE,
  VerificationPrepareInputSchema,
} from "../schema.js";
import {
  NODE_TS_V1_BUILD_ASSETS,
  NODE_TS_V1_RECIPE_DIGEST,
  verifyNodeTsV1Assets,
} from "../trusted-env/node-ts-v1.js";
import type { PreparationBackend, TrustedEnvironmentBuildOutcome } from "./backend.js";
import { buildPreparePlan, preparePlanDigest, preparePlanToken } from "./plan.js";

/**
 * 受限准备执行编排（R3 tasks 3.1；验收 P03/P04/P07/P08）。
 *
 * 门序固定（同一输入在任何机器上报同一条原因；门内零副作用）：
 * 1. **当前授权门**（P04）：`allowPrepare` 非显式 `true` ⇒ 拒绝——schema literal 是
 *    第一道，这里给结构化错误码；授权与测试授权（`allowExecution`）相互独立。
 * 2. **请求形状门**：`VerificationPrepareInputSchema` 全 strict——多余键/错误枚举在
 *    此拒绝（P08 的 schema 面：物理路径/env/镜像无处可传）。
 * 3. **计划漂移门**（P07）：`planToken` ≠ 当前（manifest × 策略 × 配方）token ⇒
 *    `plan_stale`——要求重新核对，**零记录、零下载、零容器**（未接受 ⇒ 零副作用，
 *    design D3）。
 * 4. 开**独立准备记录**（meta 首行落盘，先于任何构建动作；进程崩溃 ⇒ 未封存现场，
 *    读取侧如实呈现不完整）。
 * 5. **资产完整性门**（P08）：构建资产逐项对回冻结 manifest；不一致 ⇒ failed 记录
 *    + `trusted_environment_drift`（已接受后失败 ⇒ 保留真实诊断，不静默）。
 * 6. 调后端端口构建（依赖构建发生在**后端内**，包层不做宿主 npm）；失败 ⇒ failed
 *    记录 + `prepare_failed`——**准备失败不是测试失败**（P04：不进验证结局域）。
 * 7. 成功 ⇒ `prepared` 事件（镜像摘要/实测工具链/网络/下载字节）+ 封存。
 */

export type PrepareFailureCode =
  | "invalid_input"
  | "prepare_not_allowed"
  | "plan_stale"
  | "trusted_environment_drift"
  | "prepare_failed"
  | "record_io_failed";

export interface PreparationExecutionSuccess {
  readonly ok: true;
  readonly preparationId: string;
  readonly imageDigest: string;
  readonly toolchain: { readonly node: string; readonly typescript: string };
  readonly recordPath: string;
}

export interface PreparationExecutionFailure {
  readonly ok: false;
  readonly failure: { readonly code: PrepareFailureCode; readonly reason: string };
  /** 已开出准备记录则带出（审计/恢复入口）；门内拒绝（零副作用）为 null。 */
  readonly preparationId: string | null;
  readonly recordPath: string | null;
}

export type PreparationExecutionResult = PreparationExecutionSuccess | PreparationExecutionFailure;

export interface ExecutePreparationParams {
  /** 验证数据根（记录层布局根）。 */
  readonly dataRoot: string;
  readonly backend: PreparationBackend;
  /** 操作登记身份（U4；main 在 4.2 接入真实 epoch/operationId，包层只透传入记录）。 */
  readonly epoch: string;
  readonly operationId: string;
  /** 未信输入：包层先过授权/形状门，不经信调用方已 parse。 */
  readonly input: unknown;
  /** 构建资产；缺省为产品内嵌资产。测试注入篡改样本以验证完整性门（P08）。 */
  readonly assets?: Readonly<Record<string, string>>;
  readonly now?: () => Date;
  readonly mintPreparationId?: () => string;
}

function failure(code: PrepareFailureCode, reason: string): PreparationExecutionFailure {
  return { ok: false, failure: { code, reason }, preparationId: null, recordPath: null };
}

function defaultMintPreparationId(): string {
  return `prep-${randomBytes(8).toString("hex")}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidImageDigest(value: string): boolean {
  return ImageDigestSchema.safeParse(value).success;
}

function isValidDownloadedBytes(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

export async function executePreparation(
  params: ExecutePreparationParams,
): Promise<PreparationExecutionResult> {
  const now = params.now ?? (() => new Date());
  const at = () => now().toISOString();
  const mint = params.mintPreparationId ?? defaultMintPreparationId;
  const assets = params.assets ?? NODE_TS_V1_BUILD_ASSETS;

  // 门 1：当前授权（P04）。schema 的 z.literal(true) 是同义第二道；先判给结构化码。
  const allowPrepare = (params.input as { allowPrepare?: unknown } | null)?.allowPrepare;
  if (allowPrepare !== true) {
    return failure(
      "prepare_not_allowed",
      "缺少当前显式授权 allowPrepare:true：环境准备必须经用户对当前计划的确认（P04）",
    );
  }
  // 门 2：请求形状（全 strict；多余键/错误枚举在此拒绝）。
  const parsed = VerificationPrepareInputSchema.safeParse(params.input);
  if (!parsed.success) {
    return failure(
      "invalid_input",
      `准备请求不符合 schema：${parsed.error.issues[0]?.message ?? ""}`,
    );
  }
  // 门 3：计划漂移（P07）——比对当前 token，零副作用。
  const plan = buildPreparePlan();
  const currentToken = preparePlanToken(plan, NODE_TS_V1_RECIPE_DIGEST);
  if (parsed.data.planToken !== currentToken) {
    return failure(
      "plan_stale",
      "计划已变化（manifest/策略/配方任一漂移）：旧 token 不被接受，请重新核对当前计划（P07）",
    );
  }

  // 门 4：开独立准备记录（先于构建；崩溃 ⇒ 未封存现场）。
  const preparationId = mint();
  let writer: PreparationRecordWriter;
  try {
    writer = PreparationRecordWriter.open(params.dataRoot, {
      preparationId,
      epoch: params.epoch,
      operationId: params.operationId,
      profileId: NODE_TS_V1_PROFILE.profileId,
      manifestVersion: NODE_TS_V1_PROFILE.manifestVersion,
      planDigest: preparePlanDigest(plan),
      createdAt: at(),
    });
  } catch (error) {
    return failure("record_io_failed", `准备记录无法创建：${describe(error)}`);
  }
  const recordPath = preparationRecordPath(params.dataRoot, preparationId);

  // 已接受后的失败都落 failed 记录再返回（保留真实诊断；写入再失败则留未封存现场）。
  const sealFailed = (code: PrepareFailureCode, reason: string): PreparationExecutionFailure => {
    try {
      writer.append({ type: "failed", reason, at: at() });
      writer.terminate({ outcome: "failed", at: at() });
    } catch (writeError) {
      writer.abortClose();
      return {
        ok: false,
        failure: {
          code,
          reason: `${reason}；另：失败记录写入未完成（${describe(writeError)}）`,
        },
        preparationId,
        recordPath,
      };
    }
    return { ok: false, failure: { code, reason }, preparationId, recordPath };
  };

  // 门 5：资产完整性（P08）。
  const integrity = verifyNodeTsV1Assets(assets);
  if (!integrity.ok) {
    return sealFailed("trusted_environment_drift", integrity.reason);
  }

  // 门 6：后端内构建（依赖构建不在宿主）。
  let outcome: TrustedEnvironmentBuildOutcome;
  try {
    outcome = await params.backend.buildTrustedEnvironment({
      profile: NODE_TS_V1_PROFILE,
      assets,
    });
  } catch (error) {
    return sealFailed("prepare_failed", `受信环境构建失败：${describe(error)}`);
  }
  if (!isValidImageDigest(outcome.imageDigest)) {
    return sealFailed(
      "prepare_failed",
      `后端返回的镜像摘要不合法：${outcome.imageDigest}（应为 sha256:<64 位十六进制>）`,
    );
  }
  if (outcome.toolchain.node.length === 0 || outcome.toolchain.typescript.length === 0) {
    return sealFailed("prepare_failed", "后端返回的实测工具链版本缺失（node/typescript 不得为空）");
  }
  if (!isValidDownloadedBytes(outcome.downloadedBytes)) {
    return sealFailed(
      "prepare_failed",
      `后端返回的下载字节数不合法：${String(outcome.downloadedBytes)}（应为非负整数或 null）`,
    );
  }

  // 门 7：成功收尾——prepared 事件 + 封存。
  try {
    writer.append({
      type: "prepared",
      imageDigest: outcome.imageDigest,
      toolchain: { node: outcome.toolchain.node, typescript: outcome.toolchain.typescript },
      networkUsed: outcome.networkUsed,
      downloadedBytes: outcome.downloadedBytes,
      at: at(),
    });
    writer.terminate({ outcome: "prepared", at: at() });
  } catch (error) {
    writer.abortClose();
    return failure("record_io_failed", `准备记录收尾失败：${describe(error)}`);
  }
  return {
    ok: true,
    preparationId,
    imageDigest: outcome.imageDigest,
    toolchain: outcome.toolchain,
    recordPath,
  };
}
