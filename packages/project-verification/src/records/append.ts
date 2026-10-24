import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import type { z } from "zod";
import {
  type InterruptedEvent,
  InterruptedEventSchema,
  PreparationEventSchema,
  VerificationEventSchema,
} from "../schema.js";
import { preparationRecordPath, verificationRecordPath } from "./layout.js";

/**
 * 对**未封存**领域记录追加 interrupted 事实（R3 tasks 3.7 / design D6：启动残留核查
 * 「向未封存领域记录追加 interrupted 与清理事实；保留已有日志，不伪造已完成/已取消」）。
 *
 * 纪律：
 * - **严格门先于写入**：文件存在、以换行结尾（坏尾 = 崩溃半行，追加会破坏 JSONL 帧）、
 *   逐行过全量事件联合、meta 首行且身份一致、**无 terminated**（已封存记录不可变）——
 *   任一不过 ⇒ 不写盘；
 * - **只追加事实，不写终止**：记录保持未封存，读取侧照旧不呈现结局（不伪造
 *   completed/cancelled，P22/P23）；
 * - 整行落盘（与 writer 同纪律）；`probeRecordState` 供核查层**先判定后动手**
 *   （封存/损坏/缺失的异常须在停止任何容器之前发现——先分类后执行）。
 *
 * ⚠️ 本模块只服务启动核查（R3 残留收尾）；常规执行流一律走 writer 的排他新建，
 * 不存在「中途打开旧记录继续写」的路径。
 */

export class RecordAppendError extends Error {
  constructor(
    readonly code: "RECORD_NOT_FOUND" | "RECORD_CORRUPT" | "RECORD_SEALED" | "IO_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RecordAppendError";
  }
}

export type RecordSealProbe =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly state: "unsealed" | "sealed" | "corrupt";
      /** 已有 interrupted 事实（重复核查不二次追加——幂等重入依据）。 */
      readonly hasInterrupted?: boolean;
      readonly reason?: string;
    };

function readLines(file: string): string[] | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (!text.endsWith("\n")) {
    return [];
  }
  return text.split("\n").filter((l) => l.length > 0);
}

/**
 * 只读探测记录状态（固定时点）：缺失 / 未封存 / 已封存 / 损坏（含坏尾、伪 meta、
 * 身份错配——损坏细节进 reason，供阻断诊断）。
 */
export function probeRecordState(
  file: string,
  identityField: "verificationId" | "preparationId",
  expectedId: string,
  fullUnion: z.ZodType,
): RecordSealProbe {
  const lines = readLines(file);
  if (lines === null) {
    return { exists: false };
  }
  if (lines.length === 0) {
    return { exists: true, state: "corrupt", reason: "坏尾（文件未以换行结尾）或空记录" };
  }
  let terminatedSeen = false;
  let hasInterrupted = false;
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (error) {
      return {
        exists: true,
        state: "corrupt",
        reason: `第 ${i} 行不是 JSON（坏尾）：${String(error)}`,
      };
    }
    const checked = fullUnion.safeParse(parsed);
    if (!checked.success) {
      return { exists: true, state: "corrupt", reason: `第 ${i} 行事件形状不合法` };
    }
    const type = (checked.data as { type: string }).type;
    if (type === "interrupted") {
      hasInterrupted = true;
    }
    if (i === 0) {
      if (type !== "meta") {
        return { exists: true, state: "corrupt", reason: "首行不是 meta" };
      }
      const id = (parsed as Record<string, unknown>)[identityField];
      if (id !== expectedId) {
        return {
          exists: true,
          state: "corrupt",
          reason: `meta 身份错配（${identityField}: ${String(id)} ≠ ${expectedId}）`,
        };
      }
    } else if (type === "meta") {
      return { exists: true, state: "corrupt", reason: `第 ${i} 行出现重复 meta` };
    } else if (type === "terminated") {
      terminatedSeen = true;
    }
  }
  return {
    exists: true,
    state: terminatedSeen ? "sealed" : "unsealed",
    hasInterrupted,
  };
}

function appendInterrupted(
  file: string,
  identityField: "verificationId" | "preparationId",
  expectedId: string,
  fullUnion: z.ZodType,
  event: Omit<InterruptedEvent, "type">,
): void {
  const probe = probeRecordState(file, identityField, expectedId, fullUnion);
  if (!probe.exists) {
    throw new RecordAppendError("RECORD_NOT_FOUND", `记录不存在：${file}`);
  }
  if (probe.state === "corrupt") {
    throw new RecordAppendError(
      "RECORD_CORRUPT",
      `记录损坏，不可追加：${probe.reason ?? ""}（${file}）`,
    );
  }
  if (probe.state === "sealed") {
    throw new RecordAppendError("RECORD_SEALED", `记录已封存，不可追加：${file}`);
  }
  const line = InterruptedEventSchema.parse({ ...event, type: "interrupted" });
  let fd: number | null = null;
  try {
    // "a"（追加模式）而非 "r+"——r+ 的写指针在文件开头，会覆盖首行 meta
    fd = openSync(file, "a");
    writeSync(fd, `${JSON.stringify(line)}\n`);
  } catch (error) {
    throw new RecordAppendError("IO_FAILED", `追加 interrupted 失败：${String(error)}`);
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

/** 向未封存验证记录追加 interrupted 事实。任何校验失败都不写盘。 */
export function appendInterruptedToVerificationRecord(
  root: string,
  verificationId: string,
  event: Omit<InterruptedEvent, "type">,
): void {
  appendInterrupted(
    verificationRecordPath(root, verificationId),
    "verificationId",
    verificationId,
    VerificationEventSchema,
    event,
  );
}

/** 向未封存准备记录追加 interrupted 事实。任何校验失败都不写盘。 */
export function appendInterruptedToPreparationRecord(
  root: string,
  preparationId: string,
  event: Omit<InterruptedEvent, "type">,
): void {
  appendInterrupted(
    preparationRecordPath(root, preparationId),
    "preparationId",
    preparationId,
    PreparationEventSchema,
    event,
  );
}
