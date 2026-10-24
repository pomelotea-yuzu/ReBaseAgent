import { createHash } from "node:crypto";
import { createWorkspaceBlobStore, findFileSetQuotaViolation } from "@rebaseagent/replay";
import {
  findLogicalPathCollisionViolation,
  findLogicalPathViolation,
} from "@rebaseagent/trace-sdk";

/**
 * 受控物化（R3 tasks 3.3；验收 P05/P06/P09/W01/W02 的物化切片）。
 *
 * 把 2.4 预检产出的**已校验清单**（path/sha256/bytes）逐文件写入新容器 `/work`——
 * 字节流模型（`docker exec -i … tee`，阶段 1 §1.5 实测），**不挂载宿主目录、不解析
 * 任何 archive**（design D5.3：拒绝额外条目/链接/特殊对象/穿越/名称碰撞）。
 *
 * 纪律：
 * - **验证先于一切写入**：清单校验（路径安全/碰撞/配额）全部是纯函数，任一不成立
 *   ⇒ 零 exec、零写入（P06 副作用前拒绝的物化侧）；
 * - **复用既有权威**：路径规则/碰撞键/配额数字来自 trace-sdk `findLogicalPathViolation`、
   `findLogicalPathCollisionViolation` 与 replay `findFileSetQuotaViolation`——与 Agent
 *   文件世界同一套边界，不另造标准（W02）；
 * - **链接/特殊对象结构性排除**：快照清单 schema（WorkspaceFile = path/sha256/bytes）
 *   无法表达符号链接或特殊对象，物化只经 tee 创建普通文件——容器内核验无链接归实机探针；
 * - **字节来源逐文件复核**：写入前经注入的 `VerifiedByteReader` 重读并核哈希
 *   （replay `readVerified` 为默认实现）——预检之后、物化之前的漂移在此暴露，
 *   中途失败即停（已写入部分留在容器内，随编排收尾销毁，不发布）；
 * - **容器内核验**：全部写完后在容器内 `sha256sum` 逐路径比对清单（P05「物化字节
 *   逐项与其清单一致」的落实）。
 */

/** 物化目标目录（design D5 冻结布局：/work 为 tmpfs 可写区，/opt/r3 只读受信区）。 */
export const MATERIALIZATION_WORK_DIR = "/work";

/** 物化清单条目（= 2.4 预检产出的 VerificationSourceFacts.files 投影）。 */
export interface MaterializationFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * 容器写入端口：物化的容器侧操作（3.4 起由编排层持有容器；物化模块只拿 ref）。
 * 实现契约：容器路径是**已验证相对路径**拼接到 `MATERIALIZATION_WORK_DIR` 的绝对路径，
 * 不得再解释；全部操作以容器配置用户（uid 1000）执行。
 */
export interface ContainerWriteBackend {
  /** 建全部父目录（实现可分批；`mkdir -p` 语义，已存在不报错）。 */
  mkdirAll(containerRef: string, dirs: readonly string[]): Promise<void>;
  /** 按字节流写入一个文件（覆盖语义由调用序保证：每路径恰写一次）。 */
  writeFile(containerRef: string, containerPath: string, bytes: Uint8Array): Promise<void>;
  /**
   * 容器内对给定路径逐一 sha256。返回「路径 → 哈希」；**个别路径缺失不抛**（缺席
   * 由编排侧判 mismatch 并指名）；基础设施性失败（容器不可用/无输出可解析）抛错。
   */
  sha256OfFiles(
    containerRef: string,
    containerPaths: readonly string[],
  ): Promise<Map<string, string>>;
}

/** 字节来源：逐文件重读并核验（默认实现 = replay blobStore.readVerified）。 */
export type VerifiedByteReader = (entry: MaterializationFileEntry) => Promise<VerifiedBytes>;

export type VerifiedBytes =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly code: "attachment_missing" | "attachment_corrupt";
      readonly reason: string;
    };

export type MaterializationFailureCode =
  | "empty_manifest"
  | "path_invalid"
  | "path_collision"
  | "quota_exceeded"
  | "attachment_missing"
  | "attachment_corrupt"
  | "write_failed"
  | "materialization_mismatch"
  | "hash_probe_failed";

export interface MaterializationSuccess {
  readonly ok: true;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface MaterializationFailure {
  readonly ok: false;
  readonly failure: { readonly code: MaterializationFailureCode; readonly reason: string };
}

export type MaterializationResult = MaterializationSuccess | MaterializationFailure;

function fail(code: MaterializationFailureCode, reason: string): MaterializationFailure {
  return { ok: false, failure: { code, reason } };
}

/** 单条路径安全判定（trace-sdk 权威规则的薄包装，原因原样透出）。 */
export function materializationPathViolation(path: string): string | null {
  return findLogicalPathViolation(path);
}

/** 一组路径的碰撞判定（NFC + 大小写折叠，trace-sdk 权威语义）。 */
export function materializationCollisionViolation(paths: readonly string[]): string | null {
  return findLogicalPathCollisionViolation(paths);
}

/**
 * 清单静态校验（纯函数，零副作用）：空清单 → 逐条路径 → 碰撞 → R1 配额。
 * 顺序固定，同一份输入在任何机器上报同一条原因。
 */
export function validateMaterializationManifest(
  files: readonly MaterializationFileEntry[],
): MaterializationFailure | null {
  if (files.length === 0) {
    return fail("empty_manifest", "物化清单为空：没有可物化的受支持源码");
  }
  for (const entry of files) {
    const violation = materializationPathViolation(entry.path);
    if (violation !== null) {
      return fail("path_invalid", `物化清单路径不安全：${violation}`);
    }
  }
  const collision = materializationCollisionViolation(files.map((entry) => entry.path));
  if (collision !== null) {
    return fail("path_collision", `物化清单存在路径碰撞：${collision}`);
  }
  const quota = findFileSetQuotaViolation(files);
  if (quota !== null) {
    return fail("quota_exceeded", `物化清单超出 R1 配额：${quota}`);
  }
  return null;
}

/** 清单全部父目录（容器内相对 /work；去重保序）。 */
export function manifestParentDirs(files: readonly MaterializationFileEntry[]): string[] {
  const dirs: string[] = [];
  for (const entry of files) {
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    if (parent.length > 0 && !dirs.includes(parent)) {
      dirs.push(parent);
    }
  }
  return dirs;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface MaterializeInput {
  /** 目标容器（运行中；生命周期归编排层/3.5，物化不启停容器）。 */
  readonly containerRef: string;
  readonly backend: ContainerWriteBackend;
  readonly files: readonly MaterializationFileEntry[];
  readonly readBytes: VerifiedByteReader;
}

/**
 * 物化编排：校验 → 建目录 → 逐文件（重读核验 → 字节流写入）→ 容器内逐路径哈希复核。
 * 任何失败即停；已写入部分留在容器内（未发布状态），收尾销毁归编排层。
 */
export async function materializeVerificationSnapshot(
  input: MaterializeInput,
): Promise<MaterializationResult> {
  const invalid = validateMaterializationManifest(input.files);
  if (invalid !== null) {
    return invalid;
  }

  try {
    await input.backend.mkdirAll(
      input.containerRef,
      manifestParentDirs(input.files).map((dir) => `${MATERIALIZATION_WORK_DIR}/${dir}`),
    );
  } catch (error) {
    return fail("write_failed", `物化建目录失败：${String(error)}`);
  }

  for (const entry of input.files) {
    const verified = await input.readBytes(entry);
    if (!verified.ok) {
      return fail(verified.code, `${entry.path}：${verified.reason}`);
    }
    if (verified.bytes.length !== entry.bytes) {
      return fail(
        "attachment_corrupt",
        `${entry.path}：重读字节数 ${verified.bytes.length} ≠ 清单登记 ${entry.bytes}`,
      );
    }
    if (sha256Bytes(verified.bytes) !== entry.sha256) {
      return fail("attachment_corrupt", `${entry.path}：重读字节哈希 ≠ 清单登记 sha256`);
    }
    const target = `${MATERIALIZATION_WORK_DIR}/${entry.path}`;
    try {
      await input.backend.writeFile(input.containerRef, target, verified.bytes);
    } catch (error) {
      return fail("write_failed", `${entry.path}：容器写入失败：${String(error)}`);
    }
  }

  const targets = input.files.map((entry) => `${MATERIALIZATION_WORK_DIR}/${entry.path}`);
  let hashes: Map<string, string>;
  try {
    hashes = await input.backend.sha256OfFiles(input.containerRef, targets);
  } catch (error) {
    return fail("hash_probe_failed", `容器内哈希复核失败：${String(error)}`);
  }
  for (const entry of input.files) {
    const target = `${MATERIALIZATION_WORK_DIR}/${entry.path}`;
    const actual = hashes.get(target);
    if (actual === undefined) {
      return fail(
        "materialization_mismatch",
        `${entry.path}：容器内未找到物化产物（复核哈希缺席）`,
      );
    }
    if (actual !== entry.sha256) {
      return fail(
        "materialization_mismatch",
        `${entry.path}：容器内哈希 ≠ 清单登记（${actual} ≠ ${entry.sha256}）`,
      );
    }
  }

  let totalBytes = 0;
  for (const entry of input.files) {
    totalBytes += entry.bytes;
  }
  return { ok: true, fileCount: input.files.length, totalBytes };
}

/**
 * 默认字节来源：replay 工作区 blob store 的 `readVerified`（长度+哈希双重核验，
 * missing/corrupt 可区分、真 I/O 故障抛错——这里包成结构化结果）。
 */
export function createSnapshotByteReader(dataDir: string): VerifiedByteReader {
  const store = createWorkspaceBlobStore(dataDir);
  return async (entry) => {
    try {
      const blob = await store.readVerified(entry);
      if (blob.state === "ok") {
        return { ok: true, bytes: blob.data };
      }
      return {
        ok: false,
        code: blob.state === "missing" ? "attachment_missing" : "attachment_corrupt",
        reason: blob.reason,
      };
    } catch (error) {
      return {
        ok: false,
        code: "attachment_corrupt",
        reason: `附件读取故障：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
