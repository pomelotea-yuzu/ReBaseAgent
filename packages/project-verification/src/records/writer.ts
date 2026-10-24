import {
  type PathLike,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import {
  PreparationBodyEventSchema,
  PreparationMetaEventSchema,
  PreparationTerminatedEventSchema,
  VERIFICATION_RECORD_VERSION,
  VerificationBodyEventSchema,
  VerificationMetaEventSchema,
  VerificationTerminatedEventSchema,
} from "../schema.js";
import { preparationRecordPath, verificationRecordPath } from "./layout.js";

/**
 * 版本化 JSONL 记录写入器（验证 / 环境准备两种，规则一致）：
 *
 * - **只追加**：每事件一次 `writeSync` 整行落盘（`\n` 结尾），崩溃不产生半行——与
 *   trace-format「span 整行落盘」同一纪律；
 * - **meta 首行**：`open` 以 `wx` 排他建文件并写 meta（schemaVersion 由写入器钉
 *   `VERIFICATION_RECORD_VERSION`，调用方不可指定版本）；同 ID 文件已存在 ⇒ 拒绝
 *   （每个 verificationId/preparationId 恰一份记录）；
 * - **正文事件**：经 body 联合 schema 校验后追加（meta/terminated 形状在 body 联合中
 *   不存在，天然拒绝——meta 只能是首行、终止只能走 `terminate()`）；
 * - **唯一终止即封存**：`terminate()` 写 terminated 行、fsync、关句柄；此后任何追加/
 *   再终止抛错（文件不可变）。`abortClose()` 只关句柄不写终止——事故现场保持
 *   「未封存」，与 JsonlTracer 的异常清理哲学一致。
 */

function appendLine(fd: number, line: unknown): void {
  writeSync(fd, `${JSON.stringify(line)}\n`);
}

/** open 的公共排他建文件逻辑。 */
function openExclusive(file: PathLike, dir: string): number {
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) {
    throw new Error(`记录文件已存在，拒绝覆盖（记录 ID 必须唯一）：${file}`);
  }
  return openSync(file, "wx");
}

export type VerificationMetaInput = Omit<
  z.input<typeof VerificationMetaEventSchema>,
  "type" | "schemaVersion"
>;

export class VerificationRecordWriter {
  private constructor(
    private readonly file: string,
    private readonly verificationId: string,
    private fd: number | null,
    private sealedState = false,
  ) {}

  static open(root: string, meta: VerificationMetaInput): VerificationRecordWriter {
    const file = verificationRecordPath(root, meta.verificationId);
    const fd = openExclusive(file, dirname(file));
    const line = VerificationMetaEventSchema.parse({
      ...meta,
      type: "meta",
      schemaVersion: VERIFICATION_RECORD_VERSION,
    });
    appendLine(fd, line);
    return new VerificationRecordWriter(file, meta.verificationId, fd);
  }

  get sealed(): boolean {
    return this.sealedState;
  }

  append(event: z.input<typeof VerificationBodyEventSchema>): this {
    if (this.sealedState) {
      throw new Error(`记录已封存（terminated 已写入），不可追加：${this.file}`);
    }
    if (this.fd === null) {
      throw new Error(`记录已关闭：${this.file}`);
    }
    appendLine(this.fd, VerificationBodyEventSchema.parse(event));
    return this;
  }

  terminate(event: Omit<z.input<typeof VerificationTerminatedEventSchema>, "type">): this {
    if (this.sealedState) {
      throw new Error(`记录已封存，不可重复终止：${this.file}`);
    }
    if (this.fd === null) {
      throw new Error(`记录已关闭，无法终止：${this.file}`);
    }
    appendLine(this.fd, VerificationTerminatedEventSchema.parse({ ...event, type: "terminated" }));
    fsyncSync(this.fd); // 终止行落盘后强制刷盘，随后封存
    closeSync(this.fd);
    this.fd = null;
    this.sealedState = true;
    return this;
  }

  /** 异常清理：只关句柄、不写终止——文件保持「未封存」，由读取侧判不完整。 */
  abortClose(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

export type PreparationMetaInput = Omit<
  z.input<typeof PreparationMetaEventSchema>,
  "type" | "schemaVersion"
>;

export class PreparationRecordWriter {
  private constructor(
    private readonly file: string,
    private fd: number | null,
    private sealedState = false,
  ) {}

  static open(root: string, meta: PreparationMetaInput): PreparationRecordWriter {
    const file = preparationRecordPath(root, meta.preparationId);
    const fd = openExclusive(file, dirname(file));
    const line = PreparationMetaEventSchema.parse({
      ...meta,
      type: "meta",
      schemaVersion: VERIFICATION_RECORD_VERSION,
    });
    appendLine(fd, line);
    return new PreparationRecordWriter(file, fd);
  }

  get sealed(): boolean {
    return this.sealedState;
  }

  append(event: z.input<typeof PreparationBodyEventSchema>): this {
    if (this.sealedState) {
      throw new Error(`准备记录已封存，不可追加：${this.file}`);
    }
    if (this.fd === null) {
      throw new Error(`准备记录已关闭：${this.file}`);
    }
    appendLine(this.fd, PreparationBodyEventSchema.parse(event));
    return this;
  }

  terminate(event: Omit<z.input<typeof PreparationTerminatedEventSchema>, "type">): this {
    if (this.sealedState) {
      throw new Error(`准备记录已封存，不可重复终止：${this.file}`);
    }
    if (this.fd === null) {
      throw new Error(`准备记录已关闭，无法终止：${this.file}`);
    }
    appendLine(this.fd, PreparationTerminatedEventSchema.parse({ ...event, type: "terminated" }));
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
    this.sealedState = true;
    return this;
  }

  abortClose(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
