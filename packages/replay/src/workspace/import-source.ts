import { realpathSync, statSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import {
  compareLogicalPath,
  findLogicalPathCollisionViolation,
  findLogicalPathViolation,
  normalizeLogicalPath,
} from "@rebaseagent/trace-sdk";
import type { WorkspaceFile } from "@rebaseagent/trace-sdk";
import type { WorkspaceBlobStore } from "./blob-store.js";
import { createWorkspaceBlobStore, hashWorkspaceContent } from "./blob-store.js";
import { findAppendQuotaViolation, findFileSetQuotaViolation } from "./quota.js";

/**
 * 源目录校验、普通文件采集与导入核对（A design §3）。
 *
 * 分层：
 * - `validateSourceRoot`：这个目录能不能作为隔离世界的来源；
 * - `collectSourceFiles`：**第一遍**采集（读字节、发布附件、记录标识）——单独用它只算半程；
 * - `verifySourceTreeUnchanged`：**第二遍**核对（只读、不写盘）；
 * - `importSourceTree`：**导入入口** = 上面三步 + 导入配额，4.1 的 `createIsolatedRun` 用它。
 *
 * 这一层不写 trace、不建运行、不调用模型（也**不引用任何模型客户端**）。失败时的收尾语义
 * （设计 §8）：**只留孤立附件**——已发布的 blob 不删（它可能与别的运行共享，且"孤立内容不构成
 * 快照"本身是安全状态），临时文件由附件存储自己清。
 *
 * ## 拒什么（fail closed，不静默跳过）
 *
 * - **不合适的根**：UNC 与设备前缀（`\\server\share`、`\\?\C:\…`、`\\.\…`）、磁盘根（`D:\`、`/`）
 *   与驱动器相对形式（`D:`）；
 * - **与数据目录纠缠**：源与 dataDir 相同、或一方是另一方的祖先/后代——数据目录在运行期会被写，
 *   把它包进世界里等于把"世界的底层存储"当成世界内容；
 * - **树内的链接与非常规对象**：符号链接、junction、其他可检测的 reparse 点，以及既不是普通文件
 *   也不是普通目录的条目，一律**拒绝**（既不跟随也不跳过——跳过等于悄悄缩小采集范围）；
 * - **名字不符合逻辑路径契约**：例如 Linux 源里的 `CON`、`a:b.txt`，或长度/深度超限。拒绝而不是
 *   隐式改名，否则世界里的路径会与源目录对不上；
 * - **超出导入配额**：文件数 2000 / 单文件 8 MiB / 合计 64 MiB（上限含边界，零字节文件合法）；
 * - **两次核对之间发生可观察变化**：文件集合、标识（ino）、大小、内容哈希任一不同即拒。
 *
 * ## 根自己若是链接：**解析一次**，而不是拒绝
 *
 * 这是刻意的：设计要求"源目录**包含** symlink/junction 时拒绝"，而根是调用方显式给的入口。
 * 常见合法场景（junction 到别的卷、把项目目录映射过来）不该被拒；**树内的链接**会让"这个目录下的
 * 完整集合"失去确定含义，所以严格拒绝。解析后的根随结果返回，调用方可以据此提示用户。
 *
 * ## 已知边界
 *
 * - **可检测的 reparse**：Node 把符号链接与 junction 都报成 `isSymbolicLink()`（实测：junction
 *   在 `lstat` 与 `withFileTypes` 里都为真），这两种已覆盖；云占位符等其他 reparse 类型没有纯
 *   Node 的检测手段，属本期已知盲区。
 * - **不可读文件**：读取失败一律拒绝（fail closed）；"ACL 拒绝"这类场景在 Windows 上需要改权限
 *   才能构造，本期用例未覆盖。
 * - **inode 精度**：文件标识用 `lstat(..., { bigint: true })` 取——实测本机 NTFS 的 ino 已超过
 *   2^53，用 `number` 会静默丢精度，把两个不同文件判成同一个。
 * - **只比"集合 / 标识 / 大小 / 内容"**：`mtime` 变化但内容没变**不算变化**（被索引器或杀软
 *   "摸过"的目录若因此被拒，导入会变得不可用）；`mtimeMs` 只用于在失败信息里报细节。
 */

/** 采集/导入失败的分类原因码 */
export type SourceImportFailureCode =
  | "invalid_request"
  | "unsuitable_root"
  | "source_not_found"
  | "source_not_a_directory"
  | "source_conflicts_data_dir"
  | "unsupported_entry"
  | "invalid_entry_path"
  | "entry_unreadable"
  | "quota_exceeded"
  | "source_changed";

export interface SourceImportFailure {
  readonly code: SourceImportFailureCode;
  readonly reason: string;
  /** 与具体条目有关时给出源内相对路径（人类可读形式） */
  readonly path?: string;
}

/** 根校验通过后的结果：`root` 是解析后的真实路径，后续采集一律以它为准 */
export interface ValidatedSourceRoot {
  readonly root: string;
  readonly dataDir: string;
}

export type ValidateSourceRootResult =
  | { readonly ok: true; readonly value: ValidatedSourceRoot }
  | { readonly ok: false; readonly failure: SourceImportFailure };

/**
 * 采集期的一条明细。**只活在内存里**（供第二遍核对），不进快照、不落盘——
 * 快照契约只有 `path/sha256/bytes`，因此"链接身份 / 文件标识"不会成为世界状态的一部分。
 */
export interface SourceFileEntry {
  /** 逻辑路径（`/` 分隔，相对根） */
  readonly path: string;
  /** 内容哈希（与快照里的 `sha256` 同一算法） */
  readonly sha256: string;
  readonly bytes: number;
  /** 文件标识（NTFS file index / inode；bigint 以免丢精度） */
  readonly ino: bigint;
  readonly mtimeMs: number;
}

export interface SourceCollection {
  /** 解析后的源根 */
  readonly root: string;
  /** 规范序（UTF-16 代码单元序）的清单条目，可直接用于构造快照 */
  readonly files: readonly WorkspaceFile[];
  /** 规范序的采集明细（含标识与时间，供第二遍核对） */
  readonly entries: readonly SourceFileEntry[];
}

export type CollectSourceResult =
  | { readonly ok: true; readonly value: SourceCollection }
  | { readonly ok: false; readonly failure: SourceImportFailure };

/** 导入结果与采集结果同形（导入成功时返回的正是第一遍那份采集） */
export type ImportSourceResult = CollectSourceResult;

export interface SourceRootRequest {
  readonly source: string;
  readonly dataDir: string;
}

export interface ImportSourceRequest extends SourceRootRequest {
  /**
   * ⚠️ **仅供受控测试**在两次核对之间制造变化（设计把"采集期间变化被拒绝"写成受控测试场景；
   * 没有可控注入点就只能靠竞态，那不算证据）。生产调用方**不得**使用。
   */
  readonly testHooks?: {
    readonly betweenPasses?: () => void | Promise<void>;
  };
}

/**
 * 校验源根：能否把它当作隔离世界的来源。返回解析后的真实路径（根自己是链接时解析一次）。
 *
 * 同步是刻意的：这是一次纯粹的判定，B 侧的选择器也需要在非异步上下文里先问一句"这个目录行不行"。
 * 采集（要读字节、发布附件）才是异步。
 */
export function validateSourceRoot(request: SourceRootRequest): ValidateSourceRootResult {
  const shapeViolation = findRequestShapeViolation(request);
  if (shapeViolation !== null) {
    return fail("invalid_request", shapeViolation);
  }

  const unsuited = findUnsuitableRootViolation(request.source);
  if (unsuited !== null) {
    return fail("unsuitable_root", unsuited);
  }

  const root = realpathSafe(request.source);
  if (root === null) {
    return fail("source_not_found", `源目录不存在或无法解析真实路径：${request.source}`);
  }
  // 解析后的真实路径必须**再**过一次"不适合作根"的判定（7.5 真机发现）：
  // 字面形状挡不住"链接指向磁盘根"——`D:\proj\link` 字面看着是个正常子目录，
  // realpath 之后却是 `D:\`。根的范围决定整个世界的内容，放行等于把整个盘当项目。
  // UNC / 设备形态在 realpath 后同样会在这里被拦下（解析结果可能才显出 UNC 前缀）。
  const resolvedUnsuited = findUnsuitableRootViolation(root);
  if (resolvedUnsuited !== null) {
    return fail("unsuitable_root", `${resolvedUnsuited}（源 ${request.source} 解析后为 ${root}）`);
  }
  if (!isDirectorySync(root)) {
    return fail("source_not_a_directory", `源路径不是目录：${root}`);
  }

  const dataDir = resolveThroughExistingAncestor(request.dataDir);
  if (dataDir === null) {
    return fail("invalid_request", `数据目录路径非法：${request.dataDir}`);
  }

  const relation = describePathRelation(root, dataDir);
  if (relation !== "disjoint") {
    return fail("source_conflicts_data_dir", describeRelationMessage(relation, root, dataDir));
  }

  return { ok: true, value: { root, dataDir } };
}

/**
 * **第一遍采集**：读取源目录下全部普通文件的字节、发布到附件存储、返回规范序清单。
 *
 * ⚠️ 这一遍**不做两遍核对**（第二遍是 `verifySourceTreeUnchanged`）。隔离导入必须走
 * `importSourceTree`——它把三段串起来；单独调本函数只算半程。
 *
 * 两类检查的位置是刻意的：
 * - 配额在**读之前**用 `lstat` 拿到的大小判（`findAppendQuotaViolation`）：一个 2 GiB 的文件
 *   不该先读进内存再被拒；读完后仍对整个集合做一次权威复核（`findFileSetQuotaViolation`），
 *   因为文件可能在 lstat 与 read 之间变大，早期判断会漏。
 * - 链接 / 非常规对象 / 非法名字随时拒（2.3 的既有语义）。
 */
export async function collectSourceFiles(request: SourceRootRequest): Promise<CollectSourceResult> {
  const validated = validateSourceRoot(request);
  if (!validated.ok) {
    return { ok: false, failure: validated.failure };
  }

  const { root, dataDir } = validated.value;
  const store = createWorkspaceBlobStore(dataDir);
  const walk = await walkSourceTree(root, { store, enforceQuota: true });
  if (!walk.ok) {
    return { ok: false, failure: walk.failure };
  }

  const entries = [...walk.entries].sort((a, b) => compareLogicalPath(a.path, b.path));

  // 名称碰撞（NFC + 小写等价）在导入阶段就拒绝：世界内不能有两条等价路径
  const collision = findLogicalPathCollisionViolation(entries.map((entry) => entry.path));
  if (collision !== null) {
    return { ok: false, failure: { code: "invalid_entry_path", reason: collision } };
  }

  const files = entries.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));

  // 权威复核：早期判断用的是 lstat 的大小，这里用的是**实际读到的字节**
  const quotaViolation = findFileSetQuotaViolation(files);
  if (quotaViolation !== null) {
    return { ok: false, failure: { code: "quota_exceeded", reason: quotaViolation } };
  }

  return { ok: true, value: { root, files, entries } };
}

/**
 * **第二遍核对**：重新枚举并逐条比对集合、标识、大小与内容哈希；任何不同都返回 `source_changed`。
 *
 * 只读不写：这一遍**不发布附件**（内容若已变，发布只会留下一个无引用的 blob），也不碰 trace。
 * 比对的四项正是设计列举的"文件集合、大小、标识和内容哈希"；`mtime` 只用于失败信息里的细节。
 */
export async function verifySourceTreeUnchanged(
  root: string,
  expected: readonly SourceFileEntry[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: SourceImportFailure }> {
  const walk = await walkSourceTree(root, { store: null, enforceQuota: false });
  if (!walk.ok) {
    // 第一遍已经放行的树在第二遍被拒 ⇒ 只可能是期间出现了链接/非常规对象/非法名字
    return {
      ok: false,
      failure: {
        code: "source_changed",
        reason: `源目录在两次核对之间发生变化：${walk.failure.reason}`,
        path: walk.failure.path,
      },
    };
  }

  const changed = (path: string, detail: string) => ({
    ok: false as const,
    failure: {
      code: "source_changed" as const,
      reason: `源目录在两次核对之间发生变化（${detail}）：${path}`,
      path,
    },
  });

  const before = new Map(expected.map((entry) => [entry.path, entry]));
  const after = new Map(walk.entries.map((entry) => [entry.path, entry]));

  // 顺序固定：先报消失、再报新增，最后逐条比对——同一份差异永远报同一条
  for (const entry of expected) {
    if (!after.has(entry.path)) {
      return changed(entry.path, "文件消失");
    }
  }
  for (const entry of walk.entries) {
    if (!before.has(entry.path)) {
      return changed(entry.path, "出现新文件");
    }
  }
  for (const entry of walk.entries) {
    const previous = before.get(entry.path);
    if (previous === undefined) {
      continue;
    }
    if (entry.ino !== previous.ino) {
      return changed(entry.path, `文件被替换：标识 ${previous.ino} → ${entry.ino}`);
    }
    if (entry.bytes !== previous.bytes) {
      return changed(entry.path, `大小 ${previous.bytes} → ${entry.bytes} 字节`);
    }
    if (entry.sha256 !== previous.sha256) {
      return changed(
        entry.path,
        `内容哈希 ${previous.sha256.slice(0, 12)}… → ${entry.sha256.slice(0, 12)}…`,
      );
    }
  }

  return { ok: true };
}

/**
 * **导入入口**：校验根 → 第一遍采集（含配额）→ 第二遍核对 → 返回可用来构造快照的采集结果。
 *
 * 拒绝时（无论哪一类）的收尾语义：不写 trace、不建运行、不调用模型；已发布的附件作为**孤立内容**
 * 留在数据目录里（不删——可能与别的运行共享，且孤立内容本身不构成快照），临时文件由附件存储
 * 自行清理。调用方拿到 `ok: false` 后不得继续建运行。
 */
export async function importSourceTree(request: ImportSourceRequest): Promise<ImportSourceResult> {
  const collected = await collectSourceFiles(request);
  if (!collected.ok) {
    return collected;
  }

  await request.testHooks?.betweenPasses?.();

  const verified = await verifySourceTreeUnchanged(collected.value.root, collected.value.entries);
  if (!verified.ok) {
    return { ok: false, failure: verified.failure };
  }

  return collected;
}

interface WalkMode {
  /** 采集模式传入附件存储（会发布）；核对模式传 `null`（只读、不写盘） */
  readonly store: WorkspaceBlobStore | null;
  /** 采集模式在读之前按 `lstat` 大小逐条判配额；核对模式不做（集合差异由比对负责） */
  readonly enforceQuota: boolean;
}

type WalkResult =
  | { readonly ok: true; readonly entries: readonly SourceFileEntry[] }
  | { readonly ok: false; readonly failure: SourceImportFailure };

/** 递归走一遍源目录：两种模式共用同一套"拒什么"规则，差别只在是否发布、是否查配额 */
async function walkSourceTree(root: string, mode: WalkMode): Promise<WalkResult> {
  const entries: SourceFileEntry[] = [];
  let totalBytes = 0;

  const walk = async (dir: string): Promise<SourceImportFailure | null> => {
    const dirents = await readdirSafe(dir);
    if (dirents === null) {
      return {
        code: "entry_unreadable",
        reason: `目录无法枚举（权限不足或采集期间被改动）：${dir}`,
      };
    }

    // 枚举顺序按代码单元序固定：结果与报错都不随 OS 给的顺序变化
    for (const dirent of [...dirents].sort((a, b) => compareLogicalPath(a.name, b.name))) {
      const full = join(dir, dirent.name);
      const logical = normalizeLogicalPath(relative(root, full));

      const pathViolation = findLogicalPathViolation(logical);
      if (pathViolation !== null) {
        return { code: "invalid_entry_path", reason: pathViolation, path: logical };
      }

      const stats = await lstatSafe(full);
      if (stats === null) {
        return {
          code: "entry_unreadable",
          reason: `条目无法读取（权限不足或采集期间被改动）：${logical}`,
          path: logical,
        };
      }

      if (stats.isSymbolicLink()) {
        return {
          code: "unsupported_entry",
          reason: `源目录内不得出现符号链接/junction（不跟随、也不跳过）：${logical}`,
          path: logical,
        };
      }

      if (stats.isDirectory()) {
        const nested = await walk(full);
        if (nested !== null) {
          return nested;
        }
        continue;
      }

      if (!stats.isFile()) {
        return {
          code: "unsupported_entry",
          reason: `源目录内含不受支持的对象（既非普通文件也非普通目录）：${logical}`,
          path: logical,
        };
      }

      if (mode.enforceQuota) {
        const quotaViolation = findAppendQuotaViolation(
          { count: entries.length, bytes: totalBytes },
          { path: logical, bytes: Number(stats.size) },
        );
        if (quotaViolation !== null) {
          return { code: "quota_exceeded", reason: quotaViolation, path: logical };
        }
      }

      let bytes: Uint8Array;
      try {
        bytes = await readFile(full);
      } catch (error) {
        return {
          code: "entry_unreadable",
          reason: `文件读取失败：${logical} —— ${describeError(error)}`,
          path: logical,
        };
      }

      // 每个路径各自读取：hardlink 的两个名字因此得到两条独立条目（内容相同则共享附件），
      // 世界不保留"它们原本是同一个文件"这层身份。
      const sha256 =
        mode.store === null
          ? hashWorkspaceContent(bytes)
          : (await mode.store.publish(bytes)).sha256;

      entries.push({
        path: logical,
        sha256,
        bytes: bytes.byteLength,
        ino: stats.ino,
        // bigint 统计把毫秒也返回成 bigint；毫秒量级在 double 里是精确的，转成 number 更好用
        mtimeMs: Number(stats.mtimeMs),
      });
      totalBytes += bytes.byteLength;
    }
    return null;
  };

  const failure = await walk(root);
  return failure === null ? { ok: true, entries } : { ok: false, failure };
}

function fail(code: SourceImportFailureCode, reason: string): ValidateSourceRootResult {
  return { ok: false, failure: { code, reason } };
}

function findRequestShapeViolation(request: SourceRootRequest): string | null {
  if (typeof request.source !== "string" || request.source.trim().length === 0) {
    return "必须显式提供源目录";
  }
  if (typeof request.dataDir !== "string" || request.dataDir.trim().length === 0) {
    return "必须显式提供数据目录";
  }
  return null;
}

/**
 * 不适合作根的形态：UNC / 设备前缀、驱动器相对形式、磁盘根。
 *
 * UNC 与设备形态在**原始字符串**上先判：那类路径不能交给文件系统去解析（可能去连网络或摸设备）。
 */
function findUnsuitableRootViolation(source: string): string | null {
  const trimmed = source.replace(/[\\/]+$/, "");
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    return `源目录不得是 UNC 或设备路径：${source}`;
  }
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `源目录不得是驱动器相对形式（如 D:），请给出完整目录路径：${source}`;
  }
  const absolute = resolve(source);
  if (parse(absolute).root === absolute) {
    return `源目录不得是磁盘根：${absolute}`;
  }
  return null;
}

function describeRelationMessage(
  relation: Exclude<ReturnType<typeof describePathRelation>, "disjoint">,
  root: string,
  dataDir: string,
): string {
  if (relation === "same") {
    return `源目录不能与数据目录相同：${root}`;
  }
  const which = relation === "source_inside_data" ? "源在数据目录内" : "数据目录在源内";
  return `源目录与数据目录不能互为祖先或后代（${which}）：源 ${root}，数据目录 ${dataDir}`;
}

/** 两个路径的关系（Windows 下大小写不敏感，比较前折叠） */
function describePathRelation(
  a: string,
  b: string,
): "same" | "source_inside_data" | "data_inside_source" | "disjoint" {
  const fold = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const left = fold(a);
  const right = fold(b);
  if (left === right) {
    return "same";
  }
  if (containsPath(left, right)) {
    return "source_inside_data";
  }
  if (containsPath(right, left)) {
    return "data_inside_source";
  }
  return "disjoint";
}

/** `child` 是否在 `parent` 之内（自身不算；跨盘符时 `relative` 给绝对路径，自然判否） */
function containsPath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !parse(rel).root;
}

/**
 * 解析路径的"真实身份"：把已存在的祖先解析掉，再接回不存在的部分。
 *
 * 直接用 `resolve` 会漏掉"祖先里有链接"的情形（两串字面路径看着无关，实际指向同一处），
 * 而 `realpath` 要求整条路径存在——数据目录在首次运行前本来就可能不存在。
 */
function resolveThroughExistingAncestor(target: string): string | null {
  let prefix = resolve(target);
  const trailing: string[] = [];
  for (;;) {
    const resolved = realpathSafe(prefix);
    if (resolved !== null) {
      return join(resolved, ...trailing.reverse());
    }
    const parent = dirname(prefix);
    if (parent === prefix) {
      return null;
    }
    trailing.push(prefix.slice(parent.length + 1));
    prefix = parent;
  }
}

function realpathSafe(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function isDirectorySync(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function readdirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function lstatSafe(target: string) {
  try {
    return await lstat(target, { bigint: true });
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
