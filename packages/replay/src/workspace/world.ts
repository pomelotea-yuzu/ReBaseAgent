import {
  WorkspaceSnapshotSchema,
  compareLogicalPath,
  findLogicalPathViolation,
} from "@rebaseagent/trace-sdk";
import type { WorkspaceFile, WorkspaceSnapshot } from "@rebaseagent/trace-sdk";
import {
  createWorkspaceSnapshot,
  findSnapshotIdViolation,
} from "@rebaseagent/trace-sdk/workspace-hash";
import type { WorkspaceBlobStore } from "./blob-store.js";
import {
  WorkspaceBlobError,
  createWorkspaceBlobStore,
  hashWorkspaceContent,
} from "./blob-store.js";
import {
  findAppendQuotaViolation,
  findFileSetQuotaViolation,
  findNewContentQuotaViolation,
} from "./quota.js";

/**
 * 隔离文件世界的**实例**（A design §1、§5）：应用层 copy-on-write 的路径映射。
 *
 * 世界 = 一张 `逻辑路径 → {sha256, bytes}` 的映射表 + 一个附件存储。读按当前映射去读**不可变内容**，
 * 写先把内容**持久发布**成新附件、再原子替换映射项。`fork` 只复制映射（不复制文件字节），因此
 * 父世界、子世界、并发兄弟各有各的表，却共享同一份不可变附件。
 *
 * ## 四条硬性质（都有用例钉住）
 *
 * 1. **映射不共享可变状态**：`fork` 出来的是各自独立的表；一方写不影响另一方，也不影响父的起点快照。
 * 2. **冻结快照**：`snapshot()` 每次返回**新对象**（规范序 + 重算 id），之后继续写也不会改动它——
 *    交给 Tracer 落盘的检查点因此永远是"那一刻"的状态。
 * 3. **写失败映射不变**：配额不足、未授权、附件发布失败都在**替换映射之前**返回；失败写入不会留下
 *    半写文件，也不会让另一个世界看见。
 * 4. **授权是每个世界自己的**：`allowFileWrites` 在创建/分叉时**必须显式给出**，不从父世界继承、
 *    不从任何快照字段推导（那是审计标注，不是权限）。未授权的世界对 `writeFile` 一律拒绝。
 *
 * ## 配额的两个派生量（2.5 交付）
 *
 * - **当前快照合计字节**：映射里所有文件大小之和（不去重——同一个内容被两条路径引用要算两份，
 *   因为磁盘上确实是两份"文件"，附件去重只是存储层的优化）。
 * - **本 run 新增内容字节**：本世界写入过的唯一内容，**排除起点快照里已有的哈希**。
 *   排除的理由：那些字节在本 run 之前就已经存在（导入来的或父 run 产出的），把它算进"本 run 新增"
 *   会让每多一级分叉就重复计费一次，而这条配额要防的是**磁盘增长**。
 *
 * ## 不做的事
 *
 * - 不校验引用的附件是否都存在（那是隔离能力预检，4.2）：读的时候才发现 `missing`/`corrupt`。
 * - 不碰源目录：世界建成后只读附件，源的后续变化与运行无关（对应用例"导入后源目录变化不影响运行"）。
 * - 不删内容：没有删除工具（首期只有 `read_file` / `write_file`），陈旧附件留待未来 GC。
 */

/** 创建世界的入参 */
export interface CreateWorkspaceWorldOptions {
  readonly dataDir: string;
  /** 起点清单（导入产出或父检查点）。缺省 = 空世界 */
  readonly snapshot?: WorkspaceSnapshot;
  /**
   * **唯一**的副本写入授权输入：本次请求是否允许写入。必填且无默认值——
   * 默认值会变成"忘了传就等于授权"，而这里恰恰是权限边界。
   */
  readonly allowFileWrites: boolean;
}

export interface CreateWorkspaceWorldFailure {
  readonly code: "invalid_snapshot";
  readonly reason: string;
}

export type CreateWorkspaceWorldResult =
  | { readonly ok: true; readonly value: WorkspaceWorld }
  | { readonly ok: false; readonly failure: CreateWorkspaceWorldFailure };

/** 读文件的结果：要么拿到字节与清单条目，要么是可辨认的数据状态 */
export type WorldReadResult =
  | { readonly ok: true; readonly file: WorkspaceFile; readonly data: Uint8Array }
  | {
      readonly ok: false;
      readonly state: "not_found" | "missing" | "corrupt";
      readonly reason: string;
    };

export type WorldWriteFailureCode =
  | "not_authorized"
  | "invalid_path"
  | "invalid_content"
  | "quota_exceeded"
  | "write_failed";

export interface WorldWriteFailure {
  readonly code: WorldWriteFailureCode;
  readonly reason: string;
}

export type WorldWriteResult =
  | { readonly ok: true; readonly file: WorkspaceFile }
  | { readonly ok: false; readonly failure: WorldWriteFailure };

/** 配额派生量（与 `WORKSPACE_QUOTA` 的三个上限一一对应） */
export interface WorldQuotaUsage {
  readonly fileCount: number;
  readonly snapshotBytes: number;
  readonly newContentBytes: number;
}

/** 世界的读写接口。用 `createWorkspaceWorld` 构造，不要直接 new（构造会跳过起点校验） */
export class WorkspaceWorld {
  readonly dataDir: string;
  readonly store: WorkspaceBlobStore;
  readonly allowFileWrites: boolean;

  /** 本世界自己的映射表（路径 → 清单条目）；`fork` 时复制，之后互不影响 */
  private readonly entries = new Map<string, WorkspaceFile>();
  /** 起点快照里的哈希：用来把"本 run 新增内容"与"本来就有的内容"分开 */
  private readonly inherited: Set<string>;
  /** 本 run 产出的、且不在起点清单里的唯一内容（哈希 → 字节数） */
  private readonly newContent = new Map<string, number>();

  constructor(options: {
    readonly dataDir: string;
    readonly store: WorkspaceBlobStore;
    readonly allowFileWrites: boolean;
    readonly entries: readonly WorkspaceFile[];
    readonly inherited: readonly string[];
  }) {
    this.dataDir = options.dataDir;
    this.store = options.store;
    this.allowFileWrites = options.allowFileWrites;
    for (const file of options.entries) {
      this.entries.set(file.path, { ...file });
    }
    this.inherited = new Set(options.inherited);
  }

  /** 当前清单（规范序的**副本**：调用方改动它不会影响世界） */
  listFiles(): WorkspaceFile[] {
    return [...this.entries.values()]
      .map((file) => ({ ...file }))
      .sort((a, b) => compareLogicalPath(a.path, b.path));
  }

  /**
   * 冻结当前状态成一份检查点：规范序 + 重算 id 的**新对象**。
   *
   * 调用方（Tracer 包装器）在轮末拿它落盘；此后世界继续写，这份快照不受影响。
   */
  snapshot(): WorkspaceSnapshot {
    return createWorkspaceSnapshot(this.listFiles());
  }

  /**
   * 分叉出一个新世界：**复制映射与起点信息，不复制文件字节**，共享同一附件存储。
   *
   * ⚠️ 授权参数**必填且不继承**父世界的值——这正是"授权限定于当前世界"的落点。
   */
  fork(options: { readonly allowFileWrites: boolean }): WorkspaceWorld {
    const entries = this.listFiles();
    return new WorkspaceWorld({
      dataDir: this.dataDir,
      store: this.store,
      allowFileWrites: options.allowFileWrites,
      entries,
      // 子世界的起点就是当前映射：父 run 已经算过的内容不该在子 run 里再算一遍
      inherited: entries.map((file) => file.sha256),
    });
  }

  /** 配额派生量（判定上限用 `WORKSPACE_QUOTA`） */
  quotaUsage(): WorldQuotaUsage {
    let snapshotBytes = 0;
    for (const file of this.entries.values()) {
      snapshotBytes += file.bytes;
    }
    let newContentBytes = 0;
    for (const bytes of this.newContent.values()) {
      newContentBytes += bytes;
    }
    return { fileCount: this.entries.size, snapshotBytes, newContentBytes };
  }

  /** 按当前映射读内容（附件字节会核对长度与哈希；不读源目录） */
  async readFile(path: string): Promise<WorldReadResult> {
    const file = this.entries.get(path);
    if (file === undefined) {
      return { ok: false, state: "not_found", reason: `当前世界内没有这条路径：${path}` };
    }

    const blob = await this.store.readVerified(file);
    if (blob.state !== "ok") {
      return { ok: false, state: blob.state, reason: blob.reason };
    }
    return { ok: true, file: { ...file }, data: blob.data };
  }

  /**
   * 写内容：先做全部检查 → **发布附件** → 再替换映射项。
   *
   * 顺序不能反：映射一旦指向未落盘的内容，世界就会出现"看起来有、实际读不到"的路径。失败路径
   * 一律在替换之前返回，映射与新增内容计数都不变。
   */
  async writeFile(path: string, content: Uint8Array): Promise<WorldWriteResult> {
    if (!(content instanceof Uint8Array)) {
      return failWrite("invalid_content", "写入内容必须是字节（不做隐式字符串转换）");
    }
    const pathViolation = findLogicalPathViolation(path);
    if (pathViolation !== null) {
      return failWrite("invalid_path", pathViolation);
    }
    if (!this.allowFileWrites) {
      return failWrite(
        "not_authorized",
        "本次请求未携带副本写入授权（allowFileWrites），该世界只读",
      );
    }

    const sha256 = hashWorkspaceContent(content);
    const bytes = content.byteLength;

    // 配额按"写完之后"的集合判：失败时附件不发布、映射不变。
    // 新路径走逐条判定（O(1)，不必为每次写入重建整份集合）；覆盖写走整集合判定，
    // 因为合计要减掉被替换掉的那一份，不是简单的追加。
    const existing = this.entries.get(path);
    const quotaViolation =
      existing === undefined
        ? findAppendQuotaViolation(
            { count: this.entries.size, bytes: this.quotaUsage().snapshotBytes },
            { path, bytes },
          )
        : findFileSetQuotaViolation(
            [
              ...[...this.entries.values()].filter((file) => file.path !== path),
              { path, sha256, bytes },
            ].sort((a, b) => compareLogicalPath(a.path, b.path)),
          );
    if (quotaViolation !== null) {
      return failWrite("quota_exceeded", quotaViolation);
    }

    const countsAsNew = !this.inherited.has(sha256) && !this.newContent.has(sha256);
    if (countsAsNew) {
      const newViolation = findNewContentQuotaViolation(this.quotaUsage().newContentBytes + bytes);
      if (newViolation !== null) {
        return failWrite("quota_exceeded", newViolation);
      }
    }

    try {
      await this.store.publish(content);
    } catch (error) {
      return failWrite(
        "write_failed",
        error instanceof WorkspaceBlobError ? error.message : describeError(error),
      );
    }

    // 发布成功之后才改映射：这一步是同步的，中间没有任何可观察的"半写"状态
    this.entries.set(path, { path, sha256, bytes });
    if (countsAsNew) {
      this.newContent.set(sha256, bytes);
    }
    return { ok: true, file: { path, sha256, bytes } };
  }
}

/**
 * 建一个世界。起点清单会先过 schema 与 id 重算两道校验：世界里的映射会成为检查点的事实源，
 * 拿一份被改过的清单造世界等于把错误固化进后续每一条 trace。
 */
export function createWorkspaceWorld(
  options: CreateWorkspaceWorldOptions,
): CreateWorkspaceWorldResult {
  const snapshot = options.snapshot;
  if (snapshot !== undefined) {
    const parsed = WorkspaceSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      return {
        ok: false,
        failure: { code: "invalid_snapshot", reason: `起点清单不合法：${parsed.error.message}` },
      };
    }
    const idViolation = findSnapshotIdViolation(parsed.data);
    if (idViolation !== null) {
      return { ok: false, failure: { code: "invalid_snapshot", reason: idViolation } };
    }
  }

  const entries = snapshot?.files ?? [];
  return {
    ok: true,
    value: new WorkspaceWorld({
      dataDir: options.dataDir,
      store: createWorkspaceBlobStore(options.dataDir),
      allowFileWrites: options.allowFileWrites,
      entries,
      inherited: entries.map((file) => file.sha256),
    }),
  };
}

function failWrite(code: WorldWriteFailureCode, reason: string): WorldWriteResult {
  return { ok: false, failure: { code, reason } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
