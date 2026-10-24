import { createHash } from "node:crypto";
import {
  createWorkspaceBlobStore,
  findFileSetQuotaViolation,
  locateSnapshotInRun,
  readWorkspaceRun,
} from "@rebaseagent/replay";
import { type CheckpointSelector, NODE_TS_V1_PROFILE } from "../schema.js";

/**
 * 验证来源预检（design D5 前两条；tasks 2.4，验收 P05/P06/P07/W01/W02）。
 *
 * 全程**零副作用**：只读 `<dataDir>` 下的 trace 与 blob，**绝不回读宿主源目录**
 * （W01：宿主同名文件变化不影响预检——输入字节只来自历史清单与附件）；不写任何
 * 记录、不创建容器、不执行项目。前置拒绝 ⇒ 零验证记录、零容器、零执行（P06）。
 *
 * 检查链（顺序固定，保证同一输入在任何机器上报同一条原因）：
 * 1. 读取与定位：`readWorkspaceRun` + `locateSnapshotInRun`（replay 的一套两级校验：
 *    清单规范哈希由 reader 重算，篡改过的清单在解析阶段即拒）；
 * 2. **已封存**：`record.status === "completed"`（有终止事件；崩溃 run 是事故现场，
 *    不可作为验证来源——P06「run 未封存」）；
 * 3. 自有初始/完成步骤：selector 显式二选一，无默认步骤（P05；祖先/非 step/缺检查点
 *    由 locate 拒绝）；
 * 4. **模板相容**：清单内每个文件都必须落在 manifest 冻结的受支持源码面（`src`
 *    下任意深度的 `.ts`，W02：额外入口/自定义配置/依赖目录一律明确拒绝，不放宽、
 *    不声称 R1 能恢复未录制状态）；
 * 5. **R1 配额复核**：`findFileSetQuotaViolation`（与导入/写入共用 replay 同一函数与
 *    数字，边界用例归 replay 包测试；历史超限不从源目录补齐，直接拒绝）；
 * 6. **附件逐字节复核**：`blobStore.readVerified` 全量读验（P06：附件缺失/损坏在
 *    副作用前暴露）。
 *
 * 产出：`snapshotId`（= reader 已复核的清单规范哈希）与 `attachmentsManifestDigest`
 * （逐字节复核后的 `[[path, sha256, bytes], …]` 规范序列化摘要）——二者进入
 * `PlanBinding`，供提交时**漂移重核**（P07：digest 变化 ⇒ PLAN_STALE，重新核对，
 * 不复用历史授权）。
 */

export type PrecheckFailureCode =
  | "invalid_request"
  | "run_not_found"
  | "trace_invalid"
  | "no_workspace"
  | "source_not_sealed"
  | "step_not_found"
  | "template_incompatible"
  | "quota_exceeded"
  | "attachment_missing"
  | "attachment_corrupt";

export interface VerificationSourcePrecheckInput {
  readonly dataDir: string;
  readonly runId: string;
  readonly checkpoint: CheckpointSelector;
}

export interface VerificationSourceFacts {
  readonly runId: string;
  readonly stepSpanId: string | null;
  readonly snapshotId: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly attachmentsManifestDigest: string;
  readonly files: ReadonlyArray<{ path: string; bytes: number; sha256: string }>;
}

export type PrecheckResult =
  | { readonly ok: true; readonly value: VerificationSourceFacts }
  | {
      readonly ok: false;
      readonly failure: { readonly code: PrecheckFailureCode; readonly reason: string };
    };

function fail(code: PrecheckFailureCode, reason: string): PrecheckResult {
  return { ok: false, failure: { code, reason } };
}

/**
 * manifest 冻结的受支持源码面（`src` 下任意深度的 `.ts`）的精确判定（首版唯一形态；
 * 扩展 = manifest 版本化变更，不做通用 glob 引擎、不引入新依赖）。
 *
 * 除 `src/` 前缀与 `.ts` 后缀外，还拒绝：`node_modules` 段（design D2「依赖目录
 * 拒绝」——依赖由固定环境提供，不从受测输入带入）、以 `.` 开头的段（隐藏文件/
 * 目录属「额外入口」）。路径本身的长度/深度/穿越规则由 trace-sdk 清单 schema
 * 在读取期强制，此处不重判。
 */
export function matchesNodeTsV1SourceGlob(path: string): boolean {
  if (!path.startsWith("src/") || !path.endsWith(".ts")) {
    return false;
  }
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (segment.length === 0 || segment === "." || segment === "..") {
      return false;
    }
    if (segment.startsWith(".") || segment === "node_modules") {
      return false;
    }
  }
  return true;
}

/** 附件清单摘要：`[[path, sha256, bytes], …]`（清单本身已是规范序）的 UTF-8 SHA-256。 */
export function canonicalAttachmentsDigest(
  files: ReadonlyArray<{ path: string; sha256: string; bytes: number }>,
): string {
  const canonical = files.map((f) => [f.path, f.sha256, f.bytes]);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export async function precheckVerificationSource(
  input: VerificationSourcePrecheckInput,
): Promise<PrecheckResult> {
  const run = readWorkspaceRun(input.dataDir, input.runId);
  if (!run.ok) {
    return { ok: false, failure: run.failure };
  }
  if (run.value.record.status !== "completed") {
    return fail(
      "source_not_sealed",
      `来源 run 未封存（status=${run.value.record.status}）：只接受已终止落盘的隔离 run`,
    );
  }
  const stepSpanId = input.checkpoint.kind === "step" ? input.checkpoint.stepSpanId : undefined;
  const located = locateSnapshotInRun(
    input.runId,
    run.value.workspace,
    run.value.record,
    stepSpanId,
  );
  if (!located.ok) {
    return { ok: false, failure: located.failure };
  }
  const snapshot = located.value.snapshot;

  if (snapshot.files.length === 0) {
    return fail("template_incompatible", "清单为空：没有可验证的受支持源码");
  }
  for (const file of snapshot.files) {
    if (!matchesNodeTsV1SourceGlob(file.path)) {
      return fail(
        "template_incompatible",
        `文件不在受支持源码面 src/**/*.ts 内：${file.path}（模板明确不支持，不放宽）`,
      );
    }
  }

  const quotaViolation = findFileSetQuotaViolation(snapshot.files);
  if (quotaViolation !== null) {
    return fail("quota_exceeded", quotaViolation);
  }

  const store = createWorkspaceBlobStore(input.dataDir);
  for (const file of snapshot.files) {
    const blob = await store.readVerified(file);
    if (blob.state === "missing") {
      return fail("attachment_missing", `${file.path}：${blob.reason}`);
    }
    if (blob.state === "corrupt") {
      return fail("attachment_corrupt", `${file.path}：${blob.reason}`);
    }
  }

  let totalBytes = 0;
  for (const file of snapshot.files) {
    totalBytes += file.bytes;
  }
  return {
    ok: true,
    value: {
      runId: input.runId,
      stepSpanId: located.value.stepSpanId,
      snapshotId: snapshot.id,
      fileCount: snapshot.files.length,
      totalBytes,
      attachmentsManifestDigest: canonicalAttachmentsDigest(snapshot.files),
      files: snapshot.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    },
  };
}

/**
 * 漂移重核（P07）：提交前对同一 selector 重跑预检，比对两条摘要。
 * 任一不一致 ⇒ 计划失效（PLAN_STALE），要求重新核对；**不**复用历史授权。
 */
export function sourceFactsMatch(
  expected: { snapshotId: string; attachmentsManifestDigest: string },
  actual: { snapshotId: string; attachmentsManifestDigest: string },
): boolean {
  return (
    expected.snapshotId === actual.snapshotId &&
    expected.attachmentsManifestDigest === actual.attachmentsManifestDigest
  );
}
