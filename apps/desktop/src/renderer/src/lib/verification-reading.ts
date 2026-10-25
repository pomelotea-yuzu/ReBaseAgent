import type { VerificationGetResult } from "@shared/ipc";

/**
 * R3 任务 5.3：验证记录与日志的**读取侧纯判据**（D09/P13/P16 的渲染半边）。
 *
 * `verification:get` 返回的 `events` 是 `z.array(z.unknown())`——跨进程数据不可信，
 * 展示前必须先收窄成**结构上站得住**的视图（本模块的唯一职责）。判据：
 * - 逐事件结构守卫（typeof/in/数值类型），畸形事件**跳过不猜**（main 侧已过包层
 *   schema；这里的收窄是展示守卫，不是第二套验证）；
 * - 命令条目按 command_end 提取**双口径字节**（保留 byteLength / 全观测 totalBytes +
 *   truncated——P13：截断与丢弃量本身是证据，不得只显示保留量）；
 * - terminated 是**唯一终局**事实：未封存（unterminated）⇒ 不呈现结局。
 */

/** 一条固定命令的执行事实（来自 command_end 事件；双口径字节） */
export interface VerificationCommandEndView {
  readonly commandId: "typecheck" | "test";
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** 已保留资产字节（内容寻址发布的口径） */
  readonly stdoutBytes: number;
  /** 全部观测字节（保留 + 超限丢弃的持续读取计数） */
  readonly stdoutTotalBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrBytes: number;
  readonly stderrTotalBytes: number;
  readonly stderrTruncated: boolean;
}

/** 收窄后的验证记录视图（展示层只吃这个，不再自己摸 events） */
export interface VerificationRecordView {
  readonly eventCount: number;
  readonly commandEnds: readonly VerificationCommandEndView[];
  /** terminated 事件的结局；未封存/损坏 ⇒ null（不呈现结局） */
  readonly outcome: string | null;
  readonly detail: string | null;
  readonly terminated: boolean;
  /** 阶段序列（stage 事件的 phase，按出现顺序） */
  readonly stages: readonly string[];
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 枚举命令守卫（只认 manifest 冻结的两个枚举值） */
function asCommandId(value: unknown): "typecheck" | "test" | null {
  return value === "typecheck" || value === "test" ? value : null;
}

function asNonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 流双口径守卫：缺任一字段即整条流不采信（display-guard） */
function asStreamView(stream: unknown): {
  byteLength: number;
  totalBytes: number;
  truncated: boolean;
} | null {
  if (!isRecordObject(stream)) return null;
  const byteLength = asNonnegativeNumber(stream.byteLength);
  const totalBytes = asNonnegativeNumber(stream.totalBytes);
  if (byteLength === null || totalBytes === null) return null;
  return { byteLength, totalBytes, truncated: stream.truncated === true };
}

export function narrowVerificationRecord(events: readonly unknown[]): VerificationRecordView {
  const commandEnds: VerificationCommandEndView[] = [];
  const stages: string[] = [];
  let outcome: string | null = null;
  let detail: string | null = null;
  let terminated = false;
  for (const event of events) {
    if (!isRecordObject(event)) continue;
    if (event.type === "command_end") {
      const commandId = asCommandId(event.commandId);
      if (commandId === null) continue;
      const stdout = asStreamView(event.stdout);
      const stderr = asStreamView(event.stderr);
      if (stdout === null || stderr === null) continue;
      const exitCode =
        event.exitCode === null || typeof event.exitCode === "number" ? event.exitCode : null;
      const durationMs = asNonnegativeNumber(event.durationMs);
      commandEnds.push({
        commandId,
        exitCode,
        durationMs: durationMs ?? 0,
        stdoutBytes: stdout.byteLength,
        stdoutTotalBytes: stdout.totalBytes,
        stdoutTruncated: stdout.truncated,
        stderrBytes: stderr.byteLength,
        stderrTotalBytes: stderr.totalBytes,
        stderrTruncated: stderr.truncated,
      });
      continue;
    }
    if (event.type === "stage" && typeof event.phase === "string") {
      stages.push(event.phase);
      continue;
    }
    if (
      event.type === "terminated" &&
      typeof event.outcome === "string" &&
      typeof event.detail === "string"
    ) {
      terminated = true;
      outcome = event.outcome;
      detail = event.detail;
    }
  }
  return {
    eventCount: events.length,
    commandEnds,
    outcome,
    detail,
    terminated,
    stages,
  };
}

/** 记录状态的可读名（P15/D09：坏尾/未封存/版本不受支持如实呈现，不冒充可读） */
export function verificationStatusLine(
  status: VerificationGetResult["status"],
  error: VerificationGetResult["error"],
): string {
  switch (status) {
    case "sealed":
      return "已封存（终局事实不可再追加）";
    case "unterminated":
      return "未封存（尚无终止事件：不呈现结局，可能仍在执行或被中断）";
    case "corrupt":
      return `损坏（${error === null ? "坏尾" : `第 ${error.lineIndex + 1} 行：${error.reason}`}）——不能当作通过或失败`;
    case "unsupported_version":
      return "版本不受支持（未知记录版本被拒绝）";
  }
}
