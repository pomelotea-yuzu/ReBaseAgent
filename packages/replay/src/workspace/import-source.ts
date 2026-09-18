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
import { createWorkspaceBlobStore } from "./blob-store.js";

/**
 * 源目录校验与普通文件采集（A design §3 的前半段）。
 *
 * 这一层只做两件事：**判断这个目录能不能作为隔离世界的来源**，以及**把它里面的普通文件按字节
 * 采集成清单条目**（发布进附件存储）。两遍核对（采集前后集合/内容/标识变化）、导入配额、失败
 * 收尾在 2.4；分支映射与冻结快照在 2.5。这里不写 trace、不建运行、不调用模型。
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
 *   隐式改名，否则世界里的路径会与源目录对不上。
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
 *   才能构造，本期用例未覆盖（由 2.4 的变化/失败路径兜底验证）。
 * - **inode 精度**：文件标识用 `lstat(..., { bigint: true })` 取——实测本机 NTFS 的 ino 已超过
 *   2^53，用 `number` 会静默丢精度，把两个不同文件判成同一个。
 */

/** 采集失败的分类原因码 */
export type SourceImportFailureCode =
  | "invalid_request"
  | "unsuitable_root"
  | "source_not_found"
  | "source_not_a_directory"
  | "source_conflicts_data_dir"
  | "unsupported_entry"
  | "invalid_entry_path"
  | "entry_unreadable";

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
 * 采集期的一条明细。**只活在内存里**（供 2.4 做两遍核对），不进快照、不落盘——
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
  /** 规范序的采集明细（含标识与时间，供两遍核对） */
  readonly entries: readonly SourceFileEntry[];
}

export type CollectSourceResult =
  | { readonly ok: true; readonly value: SourceCollection }
  | { readonly ok: false; readonly failure: SourceImportFailure };

export interface SourceRootRequest {
  readonly source: string;
  readonly dataDir: string;
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
 * 采集源目录下的全部普通文件：独立读取字节、发布到附件存储、返回规范序清单。
 *
 * 内部会再跑一次根校验（设计："导入与执行前仍须校验，不信任调用方预检"）。**单一遍**——
 * 采集前后两次枚举的核对属 2.4，这里把该遍的标识与时间一并返回，2.4 才拿得到对照基准。
 */
export async function collectSourceFiles(request: SourceRootRequest): Promise<CollectSourceResult> {
  const validated = validateSourceRoot(request);
  if (!validated.ok) {
    return { ok: false, failure: validated.failure };
  }

  const { root, dataDir } = validated.value;
  const store = createWorkspaceBlobStore(dataDir);
  const entries: SourceFileEntry[] = [];

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

      // 每个路径各自读取各自发布：hardlink 的两个名字因此得到两条独立条目（内容相同则共享附件），
      // 世界不保留"它们原本是同一个文件"这层身份。
      const published = await store.publish(bytes);
      entries.push({
        path: logical,
        sha256: published.sha256,
        bytes: published.bytes,
        ino: stats.ino,
        // bigint 统计把毫秒也返回成 bigint；毫秒量级在 double 里是精确的，转成 number 更好用
        mtimeMs: Number(stats.mtimeMs),
      });
    }
    return null;
  };

  const failure = await walk(root);
  if (failure !== null) {
    return { ok: false, failure };
  }

  entries.sort((a, b) => compareLogicalPath(a.path, b.path));

  // 名称碰撞（NFC + 小写等价）在导入阶段就拒绝：世界内不能有两条等价路径
  const collision = findLogicalPathCollisionViolation(entries.map((entry) => entry.path));
  if (collision !== null) {
    return { ok: false, failure: { code: "invalid_entry_path", reason: collision } };
  }

  return {
    ok: true,
    value: {
      root,
      files: entries.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      entries,
    },
  };
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
