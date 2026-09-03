import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import type { RunEventLine, RunMetaLine, SpanLine } from "./schema.js";
import { BaseTracer, type Tracer } from "./tracer.js";

/**
 * JsonlTracer：Tracer 的文件写入实现。
 *
 * - append-only：每个 span 在 endSpan 时整行写入（startSpan 不落盘，
 *   保证任何时刻文件中只有完整 JSON 行，崩溃不产生半行）
 * - endRun 时 fsync 并封存；封存后任何写入抛错（文件不可变）
 * - 构造时若目标文件已存在且已封存（含终止事件）→ 直接拒绝
 */
export class JsonlTracer extends BaseTracer implements Tracer {
  private readonly file: string;
  private fd: number | null = null;

  constructor(file: string) {
    super();
    this.file = file;
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      if (text.trim().length > 0) {
        // 已有内容：检查是否已封存（含终止事件）
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const last = JSON.parse(lines[lines.length - 1]) as { type?: string };
        if (lines.length > 0 && last.type === "run.event") {
          throw new Error(`trace 文件已封存（run 已结束），不可追加：${this.file}`);
        }
        throw new Error(`trace 文件已存在且非空，拒绝覆盖：${this.file}`);
      }
    }
  }

  protected onMeta(meta: RunMetaLine): void {
    this.fd = openSync(this.file, "a");
    this.appendLine(meta);
  }

  protected onSpan(span: SpanLine): void {
    this.appendLine(span);
  }

  protected onEvent(event: RunEventLine): void {
    this.appendLine(event);
    if (this.fd !== null) {
      fsyncSync(this.fd); // 终止事件落盘后强制刷盘，随后封存
      closeSync(this.fd);
      this.fd = null;
    }
  }

  /** 整行写入（一次 writeSync 一行，保证行原子性） */
  private appendLine(line: RunMetaLine | SpanLine | RunEventLine): void {
    if (this.fd === null) {
      throw new Error("文件未打开（尚未 startRun）或已封存");
    }
    writeSync(this.fd, `${JSON.stringify(line)}\n`);
  }
}
