import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * 内容寻址附件存储（隔离文件世界的 blob store）。
 *
 * 布局（A design §1）：`<dataDir>/workspace-blobs/sha256/<64 位小写十六进制哈希>`，
 * 临时文件放同一目录的 `.tmp-*`。**物理路径只能由已校验哈希生成**——工具参数里的逻辑路径
 * 永不参与拼接，因此逻辑路径即便写成 `sha256/<hash>` 也只是世界内的一条普通路径。
 *
 * ## 为什么用异步 fs（本仓其余 fs 都是同步风格）
 *
 * "并发发布同哈希只有一个目标文件、失败方清理自己的临时文件"是设计明文要求的语义。
 * 同步实现里两条发布链根本不会交错，这里就只能靠"先判存在"的顺序逻辑糊过去，用例也测不出
 * 真实竞争。异步实现让 `Promise.all([publish(b), publish(b)])` 真的交错在排他发布那一步上，
 * 用例断言与调度顺序无关（谁先谁后都成立），并发语义才有证据。隔离运行的工具边界本身也是异步的。
 *
 * ## 发布算法（不覆盖既有内容）
 *
 * 1. 目标已存在 → **先验证**（长度 + 哈希）：ok 视为去重命中（`deduped: true`，不写任何文件）；
 *    校验不符则**拒绝覆盖**并报 `corrupt`——缺失/损坏的附件设计上不补写，也不冒险覆盖共享内容。
 * 2. 否则：独占创建临时文件（`wx`）→ 写入 → `fsync` 刷盘 → **排他发布**（先 `link`，
 *    目标已存在即 `EEXIST`；硬链接不可用的卷退化为 `COPYFILE_EXCL` 复制）。
 * 3. 发布失败/竞争失败只清理**本次自己的**临时文件；无论走哪条路径都不动别人的文件。
 *
 * 为什么先写临时文件而不是直接写目标名：目标名一旦出现就被视为完整、可校验的附件。半成品躺在
 * 目标名下会让后续发布因"校验不符且禁止覆盖"而永久卡住。`link` 是把已刷盘的 inode 原子挂进
 * 目标名的动作，不会出现"存在但残缺"的中间态。（退化用 `COPYFILE_EXCL` 的卷上无此保证：
 * 复制中途进程死亡可能留下目标名下的残片——该卷少见的取舍，已在注释里点明。）
 */

/** 数据目录下存放附件的子目录名（与 `traces/` 平级） */
export const WORKSPACE_BLOBS_DIR_NAME = "workspace-blobs";

/** 附件按算法分子目录，便于将来并存其他哈希算法 */
export const WORKSPACE_BLOBS_ALGORITHM_DIR_NAME = "sha256";

/** 64 位小写十六进制哈希——物理路径的唯一合法输入形式 */
const BLOB_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * blob store 的错误。
 * - `invalid`：输入本身不合法（如哈希不是 64 位小写十六进制）——**不是** I/O 故障；
 * - `corrupt`：目标存在但与期望不符，按"禁止覆盖"拒绝；
 * - `io`：真实 I/O 故障（权限、磁盘、目录不可用等），需由调用方决定如何收尾。
 */
export type WorkspaceBlobErrorCode = "invalid" | "corrupt" | "io";

export class WorkspaceBlobError extends Error {
  readonly code: WorkspaceBlobErrorCode;

  constructor(code: WorkspaceBlobErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceBlobError";
    this.code = code;
  }
}

/** 一条附件引用：内容哈希 + 字节数（与快照清单里的 `WorkspaceFile` 同形的最小面） */
export interface BlobEntry {
  readonly sha256: string;
  readonly bytes: number;
}

/** 发布结果 */
export interface PublishedBlob {
  readonly sha256: string;
  readonly bytes: number;
  /** 目标已存在同样内容（无论顺序命中还是并发竞争），本次没有新写入 */
  readonly deduped: boolean;
}

/**
 * 附件读取结果。
 * 只覆盖**可预期的数据状态**：正常、不存在、内容不符。真实 I/O 故障（权限/磁盘）抛
 * `WorkspaceBlobError("io")` —— 那是故障而不是"文件的一种状态"，不该伪装成 `missing`/`corrupt`。
 */
export type BlobReadResult =
  | { readonly state: "ok"; readonly data: Uint8Array }
  | { readonly state: "missing"; readonly reason: string }
  | { readonly state: "corrupt"; readonly reason: string };

/** 仅需状态的校验结果（不返回字节，供"分叉/预检"这类只判可用性的调用方复用） */
export type BlobVerifyResult =
  | { readonly state: "ok" }
  | { readonly state: "missing"; readonly reason: string }
  | { readonly state: "corrupt"; readonly reason: string };

/** 内容哈希（64 位小写十六进制）。与快照清单里的 `sha256` 同一算法，故可直接比对 */
export function hashWorkspaceContent(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 附件存储：一个 dataDir 一个实例；`root` 之外的物理位置一律不碰 */
export class WorkspaceBlobStore {
  /** 附件根目录：`<dataDir>/workspace-blobs/sha256` */
  readonly root: string;

  constructor(readonly dataDir: string) {
    this.root = join(dataDir, WORKSPACE_BLOBS_DIR_NAME, WORKSPACE_BLOBS_ALGORITHM_DIR_NAME);
  }

  /** 哈希 → 物理路径。非法哈希直接抛 `invalid`：**路径只能由已校验哈希生成** */
  blobPath(sha256: string): string {
    assertBlobHash(sha256);
    return join(this.root, sha256);
  }

  /**
   * 发布内容并返回其哈希。同哈希重复发布只保留一份（`deduped: true`），既有内容**不被覆盖**。
   */
  async publish(bytes: Uint8Array): Promise<PublishedBlob> {
    const sha256 = hashWorkspaceContent(bytes);
    const entry: BlobEntry = { sha256, bytes: bytes.byteLength };
    const target = this.blobPath(sha256);

    // ① 已存在先验证：命中即去重；不符则拒绝覆盖（缺失/损坏不补写）
    const existing = await this.verify(entry);
    if (existing.state === "ok") {
      return { sha256, bytes: bytes.byteLength, deduped: true };
    }
    if (existing.state === "corrupt") {
      throw new WorkspaceBlobError("corrupt", `附件已存在但校验不符，拒绝覆盖：${existing.reason}`);
    }

    // ② 写临时文件（独占创建 + 刷盘），再排他发布
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, `.tmp-${sha256.slice(0, 8)}-${randomUUID()}`);
    try {
      await this.writeTempFile(temp, bytes);
      const outcome = await this.linkIntoPlace(temp, target);

      if (outcome === "published") {
        return { sha256, bytes: bytes.byteLength, deduped: false };
      }

      // 并发竞争失败方：目标已被别的调用发布，按去重收尾（同样必须先验证）
      const raced = await this.verify(entry);
      if (raced.state !== "ok") {
        throw new WorkspaceBlobError(
          "corrupt",
          `并发发布后发现既有附件校验不符：${describeFailure(raced)}`,
        );
      }
      return { sha256, bytes: bytes.byteLength, deduped: true };
    } finally {
      // 临时文件**任何**路径都不留：发布成功后内容已由目标名持有（硬链接是同一 inode，
      // 复制是另一份），失败时它是残片。这里只删本次自己那一个路径，别人的文件一律不动。
      await removeQuietly(temp);
    }
  }

  /** 读取并校验附件；`missing` / `corrupt` 是可区分状态，真实 I/O 故障抛错 */
  async readVerified(entry: BlobEntry): Promise<BlobReadResult> {
    const path = this.blobPath(entry.sha256);

    let data: Uint8Array;
    try {
      data = await readFile(path);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return { state: "missing", reason: `附件不存在：${entry.sha256}` };
      }
      throw new WorkspaceBlobError("io", `读取附件失败：${describeError(error)}`, {
        cause: error,
      });
    }

    if (data.byteLength !== entry.bytes) {
      return {
        state: "corrupt",
        reason: `附件长度不符：清单记录 ${entry.bytes} 字节，实际 ${data.byteLength} 字节`,
      };
    }
    const actual = hashWorkspaceContent(data);
    if (actual !== entry.sha256) {
      return {
        state: "corrupt",
        reason: `附件内容哈希不符：清单记录 ${entry.sha256}，实际 ${actual}`,
      };
    }
    return { state: "ok", data };
  }

  /** 只判可用性、不返回字节（分叉预检/清单级核对用） */
  async verify(entry: BlobEntry): Promise<BlobVerifyResult> {
    const result = await this.readVerified(entry);
    return result.state === "ok" ? { state: "ok" } : result;
  }

  /** 独占创建临时文件 → 写入 → 刷盘。`wx` 保证不会复用别人的临时文件 */
  private async writeTempFile(temp: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(bytes);
      // 刷盘：内容先落地，再把名字发布出去（顺序不能反）
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * 排他发布：**只有目标不存在时才成功**。
   *
   * 首选硬链接——把已刷盘的 inode 原子挂进目标名，不会出现"存在但残缺"。
   * 硬链接在部分卷（FAT/exFAT、某些网络盘）不可用，此时退化为 `COPYFILE_EXCL` 复制
   * （目标已存在返回 `EEXIST`，仍是排他创建）。
   *
   * ⚠️ 只有**"该卷不支持硬链接"这一类**错误才走退化路径（见 `LINK_UNSUPPORTED_CODES`）：
   * 磁盘/网络的真实故障（EIO、ENOSPC…）必须原样抛出，否则会被一次注定失败的复制掩盖成
   * 另一种错误，而且"这次到底发布成功没有"也会变得不可判。
   */
  private async linkIntoPlace(temp: string, target: string): Promise<"published" | "exists"> {
    try {
      await link(temp, target);
      return "published";
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        return "exists";
      }
      if (!isLinkUnsupported(error)) {
        throw new WorkspaceBlobError("io", `发布附件失败：${describeError(error)}`, {
          cause: error,
        });
      }
      try {
        await copyFile(temp, target, constants.COPYFILE_EXCL);
        return "published";
      } catch (fallbackError) {
        if (isErrnoCode(fallbackError, "EEXIST")) {
          return "exists";
        }
        throw new WorkspaceBlobError(
          "io",
          `发布附件失败：${describeError(fallbackError)}（硬链接也不可用：${describeError(error)}）`,
          { cause: fallbackError },
        );
      }
    }
  }
}

/** 建一个附件存储实例。生产代码应只从这里拿 store——不接受调用方给的物理路径 */
export function createWorkspaceBlobStore(dataDir: string): WorkspaceBlobStore {
  return new WorkspaceBlobStore(dataDir);
}

function assertBlobHash(sha256: string): void {
  if (!BLOB_HASH_PATTERN.test(sha256)) {
    throw new WorkspaceBlobError(
      "invalid",
      `附件哈希必须是 64 位小写十六进制：${JSON.stringify(sha256)}`,
    );
  }
}

function describeFailure(result: BlobVerifyResult): string {
  return result.state === "ok" ? "" : result.reason;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * "该卷不支持硬链接"这一类错误码——只有它们才触发退化为排他复制。
 *
 * `EPERM`/`EACCES` 在 Windows 上既可能是权限不足也可能是卷不支持；退化尝试会以同样或更明确的
 * 错误失败并向上抛，所以放进来是安全的（不会静默成功）。`EIO`、`ENOSPC` 等**不在**此列：
 * 那是真实故障，必须原样暴露。
 */
const LINK_UNSUPPORTED_CODES = ["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EXDEV", "EMLINK"];

function isLinkUnsupported(error: unknown): boolean {
  return LINK_UNSUPPORTED_CODES.some((code) => isErrnoCode(error, code));
}

/**
 * 尽力删除本次自己的临时文件：失败**不抛**（不能用一个清理失败掩盖原始错误），
 * 也不动同目录的其他文件。残留的 `.tmp-*` 名字不匹配 64 位哈希，永远不会被当成附件读到。
 */
async function removeQuietly(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    // 故意吞掉：清理是尽力而为，且只针对本请求创建的那一个路径
  }
}
