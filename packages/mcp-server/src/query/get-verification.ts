import { z } from "zod";
import {
  getPreparation,
  projectVerification,
  RecordReadError,
} from "@rebaseagent/project-verification/read";
import { MESSAGE_MAX, PAGE_LIMIT_DEFAULT } from "../limits.js";
import type { LimitationInput, ProvenanceVerificationInput } from "../envelope.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import {
  type GetVerificationArgs,
  requireVerificationContract,
} from "../verification-contracts.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import {
  computeVerificationReadVersion,
  readRecordOrThrow,
  verificationToolError,
} from "./verification-support.js";

/**
 * `get_verification`（MCP2 design D2/D3，tasks 3.2）。
 *
 * - 先给身份/摘要/实际命令/历史环境/分页事件索引，**不默认返回日志、产物正文或
 *   完整原始事件**（正文走 read_verification_log / read_verification_artifact）；
 * - 白名单投影来自共享层 `projectVerification`（V02：桌面同一实现）——epoch/
 *   operationId/容器名/运行时登记不出；detail 给码点有界预览；
 * - **坏记录是成功诊断**（corrupt/unsupported_version 给 status+diagnostic，
 *   terminated=null）；读其正文才受控拒绝（M05）；
 * - provenance：verifications 只带记录内身份；runs 恒空——验证独立存在时
 *   不合成 Agent run/span 或模型消耗（M01/D3）。
 */

const PreviewSchema = z
  .object({
    text: z.string(),
    length: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const GetVerificationDataSchema = z
  .object({
    verificationId: z.string().max(64),
    status: z.enum(["sealed", "unterminated", "corrupt", "unsupported_version"]),
    meta: z
      .object({
        runId: z.string().min(1),
        checkpoint: z.unknown(),
        snapshotId: z.string().min(1),
        profileId: z.string(),
        manifestVersion: z.number().int().positive(),
        commandId: z.enum(["typecheck", "test"]),
        planBindingDigest: z.string().min(1),
        createdAt: z.string().min(1),
        environment: z.unknown(),
      })
      .strict()
      .nullable(),
    terminated: z
      .object({
        outcome: z.string().min(1),
        detail: PreviewSchema,
        evidenceComplete: z.boolean(),
        at: z.string().min(1),
      })
      .strict()
      .nullable(),
    diagnostic: z
      .object({ lineIndex: z.number().int().nonnegative(), reason: z.string().min(1).max(MESSAGE_MAX) })
      .strict()
      .nullable(),
    commands: z.array(
      z
        .object({
          commandId: z.enum(["typecheck", "test"]),
          executable: z.string(),
          argv: z.array(z.string()),
          cwd: z.string(),
          startedAt: z.string().nullable(),
          endedAt: z.string().nullable(),
          exitCode: z.number().int().nullable(),
          signal: z.string().nullable(),
          durationMs: z.number().int().nonnegative().nullable(),
          stdout: z
            .object({
              byteLength: z.number().int().nonnegative(),
              totalBytes: z.number().int().nonnegative(),
              sha256: z.string().min(1),
              truncated: z.boolean(),
            })
            .strict()
            .nullable(),
          stderr: z
            .object({
              byteLength: z.number().int().nonnegative(),
              totalBytes: z.number().int().nonnegative(),
              sha256: z.string().min(1),
              truncated: z.boolean(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    stageCounts: z.record(z.string(), z.number().int().nonnegative()),
    stopRequested: z.number().int().nonnegative(),
    stopConfirmed: z.number().int().nonnegative(),
    interrupted: z
      .object({
        reason: PreviewSchema,
        stoppedCount: z.number().int().nonnegative(),
        removedCount: z.number().int().nonnegative(),
        unconfirmedCount: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    artifactsSummary: z
      .object({
        entryCount: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        excludedPatterns: z.array(z.string().min(1)),
      })
      .strict()
      .nullable(),
    sourceStatus: z.enum(["unknown", "present", "missing"]),
    eventIndex: z.object({
      total: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      items: z.array(
        z
          .object({
            index: z.number().int().nonnegative(),
            type: z.string().min(1),
            at: z.string().nullable(),
            commandId: z.enum(["typecheck", "test"]).nullable(),
          })
          .strict(),
      ),
    }),
  })
  .strict();

export const getVerificationTool: ToolDefinition = defineTool(
  requireVerificationContract("get_verification"),
  async (args: GetVerificationArgs, root: DataRoot): Promise<ToolPayload> => {
    const record = readRecordOrThrow(root, args.verificationId);
    const projected = projectVerification(record);

    const limitations: LimitationInput[] = [];
    if (record.status === "unterminated") {
      limitations.push({
        code: "VERIFICATION_UNTERMINATED",
        ref: `verification:${args.verificationId}`,
        message: "记录未封存：没有可信结局；内容只到已落盘的完整事件为止",
      });
    }
    if (projected.meta !== null && projected.meta.environment === null) {
      limitations.push({
        code: "VERIFICATION_ENVIRONMENT_UNKNOWN",
        ref: `verification:${args.verificationId}`,
        message: "记录未保存环境身份：实际镜像/工具链/限额未知，不以当前环境补齐",
      });
    }
    if (record.sourceStatus === "missing") {
      limitations.push({
        code: "VERIFICATION_SOURCE_MISSING",
        ref: `run:${projected.meta?.runId ?? "unknown"}`,
        message: "来源 run 的 trace 不在数据根：来源状态已标注，验证记录仍可读",
      });
    }
    const preparationId = projected.meta?.environment?.preparationId;
    if (typeof preparationId === "string" && preparationId.length > 0) {
      try {
        getPreparation(root.dataDir, preparationId);
      } catch (error) {
        const projectedError = verificationToolError(error);
        if (projectedError !== null || error instanceof RecordReadError) {
          limitations.push({
            code: "VERIFICATION_PREPARATION_UNAVAILABLE",
            ref: `preparation:${preparationId}`,
            message: "记录引用的准备记录当前不可读：environment 仍按记录原值呈现",
          });
        } else {
          throw error;
        }
      }
    }

    const provenance: ProvenanceVerificationInput = {
      verificationId: args.verificationId,
      status: record.status,
      ...(projected.meta === null
        ? {}
        : {
            runId: projected.meta.runId,
            checkpointKind: projected.meta.checkpoint.kind,
            ...(projected.meta.checkpoint.kind === "step"
              ? { stepSpanId: projected.meta.checkpoint.stepSpanId }
              : {}),
            snapshotId: projected.meta.snapshotId,
            commandId: projected.meta.commandId,
          }),
      ...(projected.meta?.environment?.preparationId === undefined ||
      projected.meta?.environment === null
        ? {}
        : { preparationId: projected.meta.environment.preparationId }),
    };

    const requestArgs = withoutCursor(args);
    const readVersion = computeVerificationReadVersion(
      "get_verification",
      requestArgs,
      root,
      { verificationId: args.verificationId },
    );
    const [start] = requireCursorPosition({
      cursor: args.cursor,
      tool: "get_verification",
      params: requestArgs,
      readVersion,
      kind: "items",
      slots: 1,
    });
    const eventIndex = projected.eventIndex;
    if (start > eventIndex.length || (args.cursor !== undefined && start >= eventIndex.length)) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }

    const buildPayload = (pageSize: number): ToolPayload => {
      const requested = Math.min(pageSize, args.limit ?? PAGE_LIMIT_DEFAULT);
      const page = eventIndex.slice(start, start + requested);
      const end = start + page.length;
      const nextCursor =
        end < eventIndex.length
          ? issueCursor({
              tool: "get_verification",
              params: requestArgs,
              readVersion,
              kind: "items",
              position: [end],
            })
          : undefined;
      const data = GetVerificationDataSchema.parse({
        verificationId: projected.verificationId,
        status: projected.status,
        meta: projected.meta,
        terminated: projected.terminated,
        diagnostic:
          projected.diagnostic == null
            ? null
            : {
                lineIndex: projected.diagnostic.lineIndex,
                reason: projected.diagnostic.reason.slice(0, MESSAGE_MAX),
              },
        commands: projected.commands,
        stageCounts: projected.stageCounts,
        stopRequested: projected.stopRequested,
        stopConfirmed: projected.stopConfirmed,
        interrupted: projected.interrupted,
        artifactsSummary:
          projected.artifacts === null
            ? null
            : {
                entryCount: projected.artifacts.entries.length,
                totalBytes: projected.artifacts.totalBytes,
                excludedPatterns: [...projected.artifacts.excludedPatterns],
              },
        sourceStatus: projected.sourceStatus,
        eventIndex: {
          total: eventIndex.length,
          remaining: eventIndex.length - end,
          limit: requested,
          items: page.map((entry) => ({
            index: entry.index,
            type: entry.type,
            at: entry.at,
            commandId: entry.commandId,
          })),
        },
      });
      return {
        readVersion,
        data,
        truncated: end < eventIndex.length,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        runs: [],
        verifications: [provenance],
        limitations,
        headline: [
          `get_verification：${projected.status}`,
          projected.terminated === null ? "无可信结局" : `结局 ${projected.terminated.outcome}`,
          `命令 ${projected.commands.length} 条 / 事件索引 ${eventIndex.length} 项`,
        ].join(" / "),
      };
    };

    const initial = buildPayload(PAGE_LIMIT_DEFAULT);
    const initialCount = Math.min(eventIndex.length - start, args.limit ?? PAGE_LIMIT_DEFAULT);
    if (initialCount <= 0) return initial;
    return {
      ...initial,
      budget: {
        kind: "items",
        value: initialCount,
        minimum: 1,
        fit: (items) => buildPayload(items),
        limitRef: `verification:${args.verificationId}`,
      },
    };
  },
);
