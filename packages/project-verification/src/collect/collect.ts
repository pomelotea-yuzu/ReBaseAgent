import { findFileSetQuotaViolation } from "@rebaseagent/replay";
import { publishAsset, sha256Hex } from "../records/assets.js";
import { type ProfileManifest, VerificationBodyEventSchema } from "../schema.js";

/**
 * 静止产物采集（R3 tasks 3.6；验收 P17/P18/W01）。
 *
 * 前置：停止事实已确认（3.5 `stopWorkloadsAndConfirm` quiescent=true）、容器存活
 * （采集窗口内仅 supervisor 存活以保留 tmpfs，design D5.5——本模块不启停容器）。
 *
 * 流程（design D5.6，顺序固定）：
 * 1. **非普通对象核查**：/work 下任何链接/特殊对象 ⇒ `artifact_invalid`（不静默跟随）；
 * 2. **内容级双扫**：全树 find + 逐文件 sha256，间隔复扫——两次不一致 ⇒
 *    `artifact_invalid`（停止事实已知时的采集不稳定语义，P18）；
 * 3. **逐文件分类**：输入面（清单锚定）必须哈希不变（W01：workload 改源码冒充修复
 *    ⇒ artifact_invalid）；命中 include 且未被 exclude ⇒ 产物；其余 ⇒ stray（如实
 *    计数、不发布——「只收 profile 允许的普通输出」）；
 * 4. **配额**：R1 文件集合配额复用 + 产物唯一内容 128 MiB（limits 冻结值）；
 * 5. **发布**：宿主侧逐文件重读（cat 字节流）并复核哈希后 `publishAsset` 内容寻址
 *    发布（不可变、同哈希幂等）——产物属于 verification，不成为 Agent 检查点（D5.7）。
 */

/**
 * 产物规则 glob 匹配（首版唯一形态，不引入通用 glob 引擎）：
 * - 形态一：目录前缀后跟斜杠加双星（等于前缀或位于前缀目录下任意深度）；
 * - 形态二：双星斜杠加星点后缀（以后缀结尾）；
 * - 其他形态在清单校验时拒绝（宁可窄，不静默放宽）。
 * ⚠️ 本注释刻意不写出这两种形态的字面量——块注释里「双星斜杠」序列会提前关闭注释
 * （2.4 已踩过同款坑）。
 */
export function matchesArtifactGlob(path: string, glob: string): boolean {
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (glob.startsWith("**/")) {
    return path.endsWith(glob.slice(4));
  }
  return path === glob;
}

/** manifest 内 glob 形态校验：只接受上列两种（含精确路径），其余拒绝。 */
export function artifactGlobViolation(glob: string): string | null {
  const reject = () =>
    `不支持的产物 glob 形态（仅目录前缀加双星、双星引导后缀或精确路径）：${glob}`;
  if (glob.endsWith("/**")) {
    // 目录前缀形态：前缀部分不得再含通配符
    return glob.slice(0, -3).includes("*") ? reject() : null;
  }
  if (glob.startsWith("**/")) {
    // 后缀形态：双星斜杠后必须是「星 + 字面后缀」
    const rest = glob.slice(3);
    return rest.startsWith("*") && !rest.slice(1).includes("*") ? null : reject();
  }
  // 精确路径：完全不含通配符
  return glob.includes("*") ? reject() : null;
}

export interface WorkFileSnapshotEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ArtifactCollectionBackend {
  /** /work 下非普通对象（链接/设备等）；基础设施失败抛错。 */
  listNonRegularObjects(containerRef: string): Promise<string[]>;
  /** 全树普通文件清单（相对 /work 的路径 + 字节大小，规范排序）；基础设施失败抛错。 */
  listWorkFilesWithSizes(
    containerRef: string,
  ): Promise<Array<{ readonly path: string; readonly size: number }>>;
  /** 容器内逐路径 sha256（入参为 /work 绝对路径；缺席路径不在结果中）。 */
  sha256OfFiles(containerRef: string, paths: readonly string[]): Promise<Map<string, string>>;
  /** 宿主侧读取文件字节（单文件配额内；基础设施失败抛错）。 */
  readFile(containerRef: string, path: string): Promise<Uint8Array>;
}

export type ArtifactFailureCode =
  | "artifact_invalid"
  | "input_drifted"
  | "quota_exceeded"
  | "content_corrupt"
  | "backend_error";

export interface ArtifactCollectionSuccess {
  readonly ok: true;
  /** 已发布产物（内容寻址；path 为 /work 相对路径）。 */
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly deduped: boolean;
  }>;
  readonly totalBytes: number;
  readonly uniqueContentBytes: number;
  readonly strayCount: number;
  readonly excludedCount: number;
  readonly scanStable: true;
}

export interface ArtifactCollectionFailure {
  readonly ok: false;
  readonly failure: { readonly code: ArtifactFailureCode; readonly reason: string };
}

export type ArtifactCollectionResult = ArtifactCollectionSuccess | ArtifactCollectionFailure;

export interface CollectArtifactsInput {
  readonly containerRef: string;
  readonly backend: ArtifactCollectionBackend;
  /** 验证数据根（verification-assets 发布根）。 */
  readonly dataRoot: string;
  readonly profile: ProfileManifest;
  /**
   * 输入清单（物化面 + 模板面，调用方合成）：采集时必须逐字节不变（W01/P18）。
   * path 为 /work 相对路径。
   */
  readonly inputManifest: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
  /** 双扫间隔（默认 2000ms，§1.5 静止窗口）。 */
  readonly stabilityIntervalMs?: number;
}

function fail(code: ArtifactFailureCode, reason: string): ArtifactCollectionFailure {
  return { ok: false, failure: { code, reason } };
}

function containerPath(relative: string): string {
  return `/work/${relative}`;
}

export async function collectArtifacts(
  input: CollectArtifactsInput,
): Promise<ArtifactCollectionResult> {
  for (const glob of [
    ...input.profile.artifacts.includeGlobs,
    ...input.profile.artifacts.excludeGlobs,
  ]) {
    const violation = artifactGlobViolation(glob);
    if (violation !== null) {
      return fail("artifact_invalid", violation);
    }
  }

  // 1. 非普通对象（链接/特殊对象）——先于一切采集（P18）
  let nonRegular: string[];
  try {
    nonRegular = await input.backend.listNonRegularObjects(input.containerRef);
  } catch (error) {
    return fail("backend_error", `非普通对象核查失败：${String(error)}`);
  }
  if (nonRegular.length > 0) {
    return fail(
      "artifact_invalid",
      `/work 存在链接或特殊对象（不静默跟随、不发布）：${nonRegular.slice(0, 5).join("、")}`,
    );
  }

  // 2. 内容级双扫（P17 两次一致）
  const scan = async (): Promise<Map<string, WorkFileSnapshotEntry>> => {
    const files = await input.backend.listWorkFilesWithSizes(input.containerRef);
    const hashes = await input.backend.sha256OfFiles(
      input.containerRef,
      files.map((file) => containerPath(file.path)),
    );
    const map = new Map<string, WorkFileSnapshotEntry>();
    for (const file of files) {
      const hash = hashes.get(containerPath(file.path));
      if (hash === undefined) {
        throw new Error(`扫描缺哈希：${file.path}`);
      }
      map.set(file.path, { path: file.path, size: file.size, sha256: hash });
    }
    return map;
  };
  let first: Map<string, WorkFileSnapshotEntry>;
  let second: Map<string, WorkFileSnapshotEntry>;
  try {
    first = await scan();
    await new Promise((resolve) => setTimeout(resolve, input.stabilityIntervalMs ?? 2000));
    second = await scan();
  } catch (error) {
    return fail("backend_error", `静止双扫失败：${String(error)}`);
  }
  const stable =
    first.size === second.size &&
    [...first.entries()].every(([path, entry]) => {
      const other = second.get(path);
      return other !== undefined && other.sha256 === entry.sha256 && other.size === entry.size;
    });
  if (!stable) {
    return fail("artifact_invalid", "两次采集不一致（/work 仍在变化）：不发布任何产物（P17/P18）");
  }

  // 3. 逐文件分类
  const inputsByPath = new Map(input.inputManifest.map((entry) => [entry.path, entry.sha256]));
  const artifacts: WorkFileSnapshotEntry[] = [];
  let strayCount = 0;
  let excludedCount = 0;
  for (const [relative, entry] of first.entries()) {
    const expectedInput = inputsByPath.get(relative);
    if (expectedInput !== undefined) {
      if (expectedInput !== entry.sha256) {
        return fail(
          "input_drifted",
          `${relative}：输入被 workload 修改（采集哈希 ≠ 清单 ${expectedInput.slice(0, 12)}…）——改代码不是修复（P18/W01）`,
        );
      }
      continue; // 输入面：核对后不属于产物
    }
    const included = input.profile.artifacts.includeGlobs.some((glob) =>
      matchesArtifactGlob(relative, glob),
    );
    const excluded = input.profile.artifacts.excludeGlobs.some((glob) =>
      matchesArtifactGlob(relative, glob),
    );
    if (included && !excluded) {
      artifacts.push(entry);
    } else if (included && excluded) {
      excludedCount += 1;
    } else {
      strayCount += 1; // 允许面之外：不发布，如实计数
    }
  }

  // 4. 配额：R1 文件集合配额 + 产物唯一内容预算
  const quota = findFileSetQuotaViolation(
    artifacts.map((entry) => ({ path: entry.path, bytes: entry.size })),
  );
  if (quota !== null) {
    return fail("quota_exceeded", `产物超出 R1 配额：${quota}`);
  }
  const uniqueContent = new Map<string, number>();
  for (const entry of artifacts) {
    uniqueContent.set(entry.sha256, entry.size);
  }
  let uniqueBytes = 0;
  for (const size of uniqueContent.values()) {
    uniqueBytes += size;
  }
  if (uniqueBytes > input.profile.limits.artifactUniqueContentBudgetBytes) {
    return fail(
      "quota_exceeded",
      `产物唯一内容 ${String(uniqueBytes)} B 超过预算 ${String(input.profile.limits.artifactUniqueContentBudgetBytes)} B`,
    );
  }

  // 5. 宿主侧重读复核 + 内容寻址发布
  const entries: Array<{
    path: string;
    size: number;
    sha256: string;
    deduped: boolean;
  }> = [];
  let totalBytes = 0;
  for (const entry of artifacts) {
    let bytes: Uint8Array;
    try {
      bytes = await input.backend.readFile(input.containerRef, containerPath(entry.path));
    } catch (error) {
      return fail("backend_error", `${entry.path}：产物读取失败：${String(error)}`);
    }
    if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      return fail("content_corrupt", `${entry.path}：宿主重读与容器扫描不一致——拒绝发布`);
    }
    const published = publishAsset(input.dataRoot, bytes);
    entries.push({
      path: entry.path,
      size: entry.size,
      sha256: published.sha256,
      deduped: !published.created,
    });
    totalBytes += entry.size;
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    ok: true,
    entries,
    totalBytes,
    uniqueContentBytes: uniqueBytes,
    strayCount,
    excludedCount,
    scanStable: true,
  };
}

/**
 * 采集结果 → 记录层 artifacts 事件（excludedPatterns = manifest 的 exclude 规则本身；
 * schema 校验，编排层直接追加）。
 */
export function artifactsRecordEvent(result: ArtifactCollectionSuccess, profile: ProfileManifest) {
  return VerificationBodyEventSchema.parse({
    type: "artifacts",
    entries: result.entries.map((entry) => ({
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
    })),
    excludedPatterns: [...profile.artifacts.excludeGlobs],
    totalBytes: result.totalBytes,
  });
}
