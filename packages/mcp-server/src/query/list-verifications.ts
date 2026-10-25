import { z } from "zod";
import {
  scanVerifications,
  type VerificationScanEntry,
} from "@rebaseagent/project-verification/read";
import { MESSAGE_MAX } from "../limits.js";
import type { ProvenanceVerificationInput } from "../envelope.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import {
  PAGE_LIMIT_DEFAULT,
} from "../limits.js";
import {
  type ListVerificationsArgs,
  requireVerificationContract,
} from "../verification-contracts.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import { takeWindow } from "./projection.js";
import { computeVerificationReadVersion, verificationToolError } from "./verification-support.js";

/**
 * `list_verifications`（MCP2 design D2，tasks 3.1）。
 *
 * 一条线性序列 = **可判定摘要段**（scan 排序：createdAt 倒序 + UTF-16 码元升序，
 * 无可信时间置后；损坏/未知版本以 status 保留其中）+ **读取失败项段**（文件名升序）：
 * - 筛选（runId/status/outcome）只作用于可判定摘要，失败项**不因筛选消失**（M02）；
 * - 每项占分页额度且只出现一次；失败项只给安全文件名与结构化原因，不给宿主路径；
 * - 验证 ID 不进入 list_runs、不增加 run/span/模型消耗（M01）——本工具不碰 traces/。
 */

const VerificationListItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("verification"),
      verificationId: z.string().max(64),
      status: z.enum(["sealed", "unterminated", "corrupt", "unsupported_version"]),
      /** 可信结局（仅 sealed 可能非 null）；历史 outcome 不被列表改写 */
      outcome: z
        .enum([
          "check_failed",
          "passed",
          "environment_failed",
          "start_failed",
          "process_failed",
          "timed_out",
          "output_limit",
          "cancelled",
          "artifact_invalid",
          "evidence_incomplete",
          "unknown",
        ])
        .nullable(),
      runId: z.string().min(1).nullable(),
      commandId: z.enum(["typecheck", "test"]).nullable(),
      createdAt: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unreadable_file"),
      /** 安全文件标识（仅文件名部分）；物理路径永不出现 */
      file: z.string().min(1).max(255),
      reason: z.enum(["UNREADABLE", "CORRUPT", "UNSUPPORTED_VERSION", "INVALID_NAME"]),
      /** 受控说明（固定文案，不含异常原文） */
      message: z.string().min(1).max(MESSAGE_MAX),
    })
    .strict(),
]);
type VerificationListItem = z.infer<typeof VerificationListItemSchema>;

const ListVerificationsDataSchema = z
  .object({
    filter: z
      .object({
        runId: z.string().nullable(),
        status: z.enum(["sealed", "unterminated", "corrupt", "unsupported_version"]).nullable(),
        outcome: z.string().nullable(),
      })
      .strict(),
    items: z.array(VerificationListItemSchema),
    totals: z
      .object({
        matchedVerifications: z.number().int().nonnegative(),
        unreadableFiles: z.number().int().nonnegative(),
        listed: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

interface SequenceEntry {
  readonly item: VerificationListItem;
  readonly provenance: ProvenanceVerificationInput | null;
}

const FAILURE_MESSAGES: Record<"UNREADABLE" | "CORRUPT" | "UNSUPPORTED_VERSION" | "INVALID_NAME", string> = {
  UNREADABLE: "验证记录文件当前不可读（权限/IO），未参与筛选",
  CORRUPT: "验证记录损坏，未参与筛选",
  UNSUPPORTED_VERSION: "验证记录版本不受支持，未参与筛选",
  INVALID_NAME: "文件名不是合法验证标识，未参与筛选",
};

function toSequence(entries: readonly VerificationScanEntry[]): SequenceEntry[] {
  return entries.map((entry): SequenceEntry => {
    if (entry.kind === "record") {
      return {
        item: {
          kind: "verification",
          verificationId: entry.verificationId,
          status: entry.status,
          outcome: entry.outcome ?? null,
          runId: entry.runId ?? null,
          commandId:
            entry.commandId === "typecheck" || entry.commandId === "test"
              ? entry.commandId
              : null,
          createdAt: entry.createdAt ?? null,
        },
        provenance: {
          verificationId: entry.verificationId,
          status: entry.status,
          ...(entry.runId === undefined ? {} : { runId: entry.runId }),
        },
      };
    }
    return {
      item: {
        kind: "unreadable_file",
        file: entry.fileName,
        reason: entry.reason,
        message: FAILURE_MESSAGES[entry.reason],
      },
      provenance: null,
    };
  });
}

export const listVerificationsTool: ToolDefinition = defineTool(
  requireVerificationContract("list_verifications"),
  async (args: ListVerificationsArgs, root: DataRoot) => {
    const requestArgs = withoutCursor(args);
    const readVersion = computeVerificationReadVersion("list_verifications", requestArgs, root);
    const [start] = requireCursorPosition({
      cursor: args.cursor,
      tool: "list_verifications",
      params: requestArgs,
      readVersion,
      kind: "items",
      slots: 1,
    });

    let scanned: readonly VerificationScanEntry[];
    try {
      scanned = scanVerifications(root.dataDir);
    } catch (error) {
      // 目录级枚举失败 → STORAGE_IO（verificationToolError 投影）；其余原样上抛
      const projected = verificationToolError(error);
      throw projected ?? error;
    }
    const sequence: SequenceEntry[] = toSequence(scanned);

    // 筛选只作用于可判定摘要；失败项保留在原位（段尾）
    const matched = sequence.filter((entry) => {
      if (entry.item.kind !== "verification") return true;
      if (args.runId !== undefined && entry.item.runId !== args.runId) return false;
      if (args.status !== undefined && entry.item.status !== args.status) return false;
      if (args.outcome !== undefined && entry.item.outcome !== args.outcome) return false;
      return true;
    });

    const requestedLimit = args.limit ?? PAGE_LIMIT_DEFAULT;
    if (start > matched.length || (args.cursor !== undefined && start >= matched.length)) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }

    const buildPayload = (pageSize: number): ToolPayload => {
      const window = takeWindow(matched.slice(start), Math.min(pageSize, requestedLimit));
      const end = start + window.items.length;
      const nextCursor =
        end < matched.length
          ? issueCursor({
              tool: "list_verifications",
              params: requestArgs,
              readVersion,
              kind: "items",
              position: [end],
            })
          : undefined;
      const data = ListVerificationsDataSchema.parse({
        filter: {
          runId: args.runId ?? null,
          status: args.status ?? null,
          outcome: args.outcome ?? null,
        },
        items: window.items.map((entry) => entry.item),
        totals: {
          matchedVerifications: matched.filter((e) => e.item.kind === "verification").length,
          unreadableFiles: matched.filter((e) => e.item.kind === "unreadable_file").length,
          listed: window.items.length,
          remaining: window.remaining,
          limit: requestedLimit,
        },
      });
      return {
        readVersion,
        data,
        truncated: window.truncated,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        runs: [],
        verifications: window.items
          .map((entry) => entry.provenance)
          .filter((v): v is ProvenanceVerificationInput => v !== null),
        headline: [
          `list_verifications：命中 ${matched.filter((e) => e.item.kind === "verification").length} 条摘要`,
          `不可读文件 ${matched.filter((e) => e.item.kind === "unreadable_file").length} 个`,
          window.truncated
            ? `本页 ${window.items.length} 条，尚有 ${window.remaining} 条`
            : "全部在本页",
        ].join(" / "),
      };
    };

    const initial = buildPayload(requestedLimit);
    const initialCount = Math.min(matched.length - start, requestedLimit);
    if (initialCount === 0) return initial;
    const first = matched[start]?.item;
    return {
      ...initial,
      budget: {
        kind: "items",
        value: initialCount,
        minimum: 1,
        fit: (items) => buildPayload(Math.min(items, requestedLimit)),
        limitRef:
          first === undefined
            ? "tool:list_verifications"
            : first.kind === "verification"
              ? `verification:${first.verificationId}`
              : `file:${first.file}`,
      },
    };
  },
);
