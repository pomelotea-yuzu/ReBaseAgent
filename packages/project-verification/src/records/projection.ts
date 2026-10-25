import type {
  CheckpointSelector,
  VerificationEnvironment,
  VerificationOutcome,
} from "../schema.js";
import type { VerificationRecordRead } from "./reader.js";

/**
 * 共享白名单记录投影（MCP2 design D3，桌面与 MCP 复用同一事实实现，V02）。
 *
 * 白名单纪律：
 * - **封存门**：可信 terminated/outcome 只在 status=sealed 时投影；unterminated/
 *   corrupt/unsupported_version 一律 terminated=null + 诊断（M05：坏尾/重复终止/
 *   终止后事件不得裁尾出成功——reader 已把这些判为 corrupt，投影不再二次裁决）；
 * - **不外发**：epoch、operationId、容器名称/ID、运行时登记（interrupted 的资源
 *   列表只给**安全计数**）；原始异常文本/堆栈不进投影；
 * - **有界**：detail/reason 给码点有界预览 + 原长度 + 截断标记；
 * - **实际命令**：command_start/end 按序配对（含重复命令——配对歧义的拒绝在资产
 *   定位层 2.3，投影只如实呈现多条）；容器 executable/cwd/argv 是执行事实，外发；
 * - 事件索引只给 type/at/commandId，不给正文。
 */

/** detail/reason 预览的码点上限（超出给原长度与截断标记） */
export const PROJECTION_PREVIEW_MAX_CHARS = 512;

export interface BoundedPreview {
  readonly text: string;
  readonly length: number;
  readonly truncated: boolean;
}

/** 码点有界预览（按 Unicode 码点截断，代理对不切半） */
export function boundedPreview(text: string, max = PROJECTION_PREVIEW_MAX_CHARS): BoundedPreview {
  const chars = [...text];
  return {
    text: chars.length <= max ? text : `${chars.slice(0, max).join("")}…`,
    length: chars.length,
    truncated: chars.length > max,
  };
}

export type ProjectedEventType =
  | "stage"
  | "command_start"
  | "command_end"
  | "stop_requested"
  | "stop_confirmed"
  | "artifacts"
  | "interrupted";

export interface VerificationEventIndexEntry {
  /** 正文事件序号（0 起，按记录内出现顺序） */
  readonly index: number;
  readonly type: ProjectedEventType;
  readonly at: string | null;
  readonly commandId: "typecheck" | "test" | null;
}

export interface ProjectedCommand {
  readonly commandId: "typecheck" | "test";
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number | null;
  readonly stdout: {
    readonly byteLength: number;
    readonly totalBytes: number;
    readonly sha256: string;
    readonly truncated: boolean;
  } | null;
  readonly stderr: {
    readonly byteLength: number;
    readonly totalBytes: number;
    readonly sha256: string;
    readonly truncated: boolean;
  } | null;
}

export interface VerificationProjection {
  readonly verificationId: string;
  readonly status: VerificationRecordRead["status"];
  /**
   * 记录头白名单（meta 缺失/损坏 ⇒ null）。environment 为记录内事实：
   * 缺省保持 null（旧记录未知，不拿当前 manifest 补齐，M04）。
   */
  readonly meta:
    | null
    | {
        readonly runId: string;
        readonly checkpoint: CheckpointSelector;
        readonly snapshotId: string;
        readonly profileId: string;
        readonly manifestVersion: number;
        readonly commandId: "typecheck" | "test";
        readonly planBindingDigest: string;
        readonly createdAt: string;
        readonly environment: VerificationEnvironment | null;
      };
  /** 封存门：仅 sealed 有值；非 sealed 恒 null（可信结局不存在） */
  readonly terminated:
    | null
    | {
        readonly outcome: VerificationOutcome;
        readonly detail: BoundedPreview;
        readonly evidenceComplete: boolean;
        readonly at: string;
      };
  /** corrupt/unsupported_version 的结构化诊断（reader 行号/原因；无堆栈无路径） */
  readonly diagnostic: VerificationRecordRead["error"] | null;
  /** 实际命令（start/end 按序配对；重复命令如实多条） */
  readonly commands: readonly ProjectedCommand[];
  /** 阶段计数（materializing/executing/stopping/collecting/finalizing → 次数） */
  readonly stageCounts: Readonly<Record<string, number>>;
  /** 停止事实计数（M05：不呈现仍运行，只报已记录事实） */
  readonly stopRequested: number;
  readonly stopConfirmed: number;
  /** 中断事实：原因预览 + 安全计数（不给容器名/ID） */
  readonly interrupted:
    | null
    | {
        readonly reason: BoundedPreview;
        readonly stoppedCount: number;
        readonly removedCount: number;
        readonly unconfirmedCount: number;
      };
  /** 产物清单事实（无 artifacts 事件 ⇒ null；与"未采集"区分在资产层 2.3） */
  readonly artifacts:
    | null
    | {
        readonly entries: readonly {
          readonly path: string;
          readonly size: number;
          readonly sha256: string;
        }[];
        readonly excludedPatterns: readonly string[];
        readonly totalBytes: number;
      };
  readonly eventIndex: readonly VerificationEventIndexEntry[];
  readonly sourceStatus: VerificationRecordRead["sourceStatus"];
}

/** 从 reader 读取结果投影白名单事实（纯函数；不触文件系统、不抛原始异常） */
export function projectVerification(record: VerificationRecordRead): VerificationProjection {
  const meta = record.meta;
  const terminated = record.terminated;

  const commands: ProjectedCommand[] = [];
  let currentStart: {
    commandId: "typecheck" | "test";
    executable: string;
    argv: string[];
    cwd: string;
    startedAt: string;
  } | null = null;
  for (const event of record.events) {
    if (event.type === "command_start") {
      currentStart = {
        commandId: event.commandId,
        executable: event.executable,
        argv: [...event.argv],
        cwd: event.cwd,
        startedAt: event.startedAt,
      };
      continue;
    }
    if (event.type === "command_end") {
      const start = currentStart;
      currentStart = null;
      commands.push({
        commandId: event.commandId,
        executable: start?.executable ?? "",
        argv: start?.argv ?? [],
        cwd: start?.cwd ?? "",
        startedAt: start?.startedAt ?? null,
        endedAt: event.endedAt,
        exitCode: event.exitCode,
        signal: event.signal,
        durationMs: event.durationMs,
        stdout: { ...event.stdout },
        stderr: { ...event.stderr },
      });
      continue;
    }
  }

  const stageCounts: Record<string, number> = {};
  const eventIndex: VerificationEventIndexEntry[] = [];
  let stopRequested = 0;
  let stopConfirmed = 0;
  let interrupted: VerificationProjection["interrupted"] = null;
  let artifacts: VerificationProjection["artifacts"] = null;
  for (let index = 0; index < record.events.length; index++) {
    const event = record.events[index] ?? ({} as VerificationRecordRead["events"][number]);
    const commandId = "commandId" in event ? event.commandId : null;
    switch (event.type) {
      case "stage":
        stageCounts[event.phase] = (stageCounts[event.phase] ?? 0) + 1;
        eventIndex.push({ index, type: "stage", at: event.at, commandId: null });
        break;
      case "command_start":
        eventIndex.push({ index, type: "command_start", at: event.startedAt, commandId });
        break;
      case "command_end":
        eventIndex.push({ index, type: "command_end", at: event.endedAt, commandId });
        break;
      case "stop_requested":
        stopRequested += 1;
        eventIndex.push({ index, type: "stop_requested", at: event.at, commandId: null });
        break;
      case "stop_confirmed":
        stopConfirmed += 1;
        eventIndex.push({ index, type: "stop_confirmed", at: event.at, commandId: null });
        break;
      case "artifacts":
        artifacts = {
          entries: event.entries.map((entry) => ({ ...entry })),
          excludedPatterns: [...event.excludedPatterns],
          totalBytes: event.totalBytes,
        };
        eventIndex.push({ index, type: "artifacts", at: null, commandId: null });
        break;
      case "interrupted":
        interrupted = {
          reason: boundedPreview(event.reason),
          stoppedCount: event.stoppedResources.length,
          removedCount: event.removedResources.length,
          unconfirmedCount: event.unconfirmedResources.length,
        };
        eventIndex.push({ index, type: "interrupted", at: event.at, commandId: null });
        break;
    }
  }

  return {
    verificationId: record.verificationId,
    status: record.status,
    meta:
      meta === undefined
        ? null
        : {
            runId: meta.target.runId,
            checkpoint: meta.target.checkpoint,
            snapshotId: meta.target.snapshotId,
            profileId: meta.profileId,
            manifestVersion: meta.manifestVersion,
            commandId: meta.commandId,
            planBindingDigest: meta.planBindingDigest,
            createdAt: meta.createdAt,
            environment: meta.environment ?? null,
          },
    terminated:
      record.status === "sealed" && terminated !== undefined
        ? {
            outcome: terminated.outcome,
            detail: boundedPreview(terminated.detail),
            evidenceComplete: terminated.evidenceComplete,
            at: terminated.at,
          }
        : null,
    diagnostic: record.error ?? null,
    commands,
    stageCounts,
    stopRequested,
    stopConfirmed,
    interrupted,
    artifacts,
    eventIndex,
    sourceStatus: record.sourceStatus,
  };
}
