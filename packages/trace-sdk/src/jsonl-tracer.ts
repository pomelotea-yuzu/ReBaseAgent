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
 *
 * @param options.spanSeqStart span id 起始序号（默认 0 → 首条 s_01）。
 *   fork run 传入父链最大序号以延续编号，保证整条分支链上 span id 全局唯一。
 */
export class JsonlTracer extends BaseTracer implements Tracer {
  private readonly file: string;
  private fd: number | null = null;

  constructor(file: string, options: { spanSeqStart?: number } = {}) {
    super(options);
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

  /**
   * 异常清理：只关闭当前文件句柄，**不写终止事件**。
   *
   * 供编排层的 finally 路径使用（trace 写入失败、导入失败等导致本次编排提前退出）：
   * 已写入的行原样保留 —— 文件保持"未封存"（readRun 判为 crashed）。这是事故现场，
   * 不是可以补一个"成功终止"来圆场的中间态；要收口成 completed/errored 只能走正常
   * `endRun`。幂等：句柄已关闭（含已封存、从未 startRun）时调用无副作用。
   * 调用后本 Tracer 不可再写入（appendLine 按"文件未打开"抛错）。
   */
  dispose(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } finally {
        this.fd = null; // 关闭失败也要置空：句柄状态以本对象视角为准，避免重复 close 抛错
      }
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
