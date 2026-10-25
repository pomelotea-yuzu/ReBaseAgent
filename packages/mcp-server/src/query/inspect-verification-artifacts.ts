import { z } from "zod";
import {
  RecordReadError,
  verifyAsset,
  type VerifiedAsset,
} from "@rebaseagent/project-verification/read";
import { PAGE_LIMIT_DEFAULT } from "../limits.js";
import type { ProvenanceVerificationInput } from "../envelope.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import {
  type InspectVerificationArtifactsArgs,
  requireVerificationContract,
} from "../verification-contracts.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import {
  assertReadUnchanged,
  computeVerificationReadVersion,
  readRecordOrThrow,
} from "./verification-support.js";

/**
 * `inspect_verification_artifacts`（MCP2 design D2，tasks 3.4）。
 *
 * - 清单/排除规则/字节数与**逐项附件可用性**（完整核验形态 + 大小 + SHA-256）；
 * - 未采集（无 artifacts 事件）与合法空清单**分开**：前者受控失败
 *   VERIFICATION_ARTIFACTS_NOT_RECORDED，后者是 entries:[] 的成功；
 * - 多条 artifacts 事件 = 清单歧义，受控拒绝（不取最后一条掩盖，M08 同源纪律）；
 * - 逐项状态 available/missing/corrupt（符号链接顶替/字节改写都归 corrupt）；
 * - 产物不是 Agent 检查点：provenance 只带验证域引用（M09）。
 */

const ArtifactItemSchema = z
  .object({
    path: z.string().min(1),
    /** 记录清单内声明的字节 */
    declaredBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1).max(64),
    availability: z.enum(["available", "missing", "corrupt"]),
    /** 核验到的实际字节数（available 时与 declaredBytes 一致） */
    actualBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

const InspectVerificationArtifactsDataSchema = z
  .object({
    verificationId: z.string().max(64),
    recordStatus: z.enum(["sealed", "unterminated", "corrupt", "unsupported_version"]),
    excludedPatterns: z.array(z.string().min(1)),
    declaredTotalBytes: z.number().int().nonnegative(),
    totals: z
      .object({
        entries: z.number().int().nonnegative(),
        available: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
        corrupt: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(ArtifactItemSchema),
    remaining: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  })
  .strict();

export const inspectVerificationArtifactsTool: ToolDefinition = defineTool(
  requireVerificationContract("inspect_verification_artifacts"),
  async (args: InspectVerificationArtifactsArgs, root: DataRoot): Promise<ToolPayload> => {
    const record = readRecordOrThrow(root, args.verificationId);
    const artifactEvents = record.events.filter((event) => event.type === "artifacts");
    if (artifactEvents.length === 0) {
      // 未采集与合法空清单分开（M09）：受控失败
      throw new ToolFailure(
        "VERIFICATION_ARTIFACTS_NOT_RECORDED",
        `verification:${args.verificationId}`,
      );
    }
    if (artifactEvents.length > 1) {
      throw new ToolFailure(
        "VERIFICATION_PATH_REJECTED",
        `verification:${args.verificationId}`,
      );
    }
    const event = artifactEvents[0];
    if (event?.type !== "artifacts") throw new Error("unreachable");
    const entries = event.entries.map((entry) => ({ ...entry }));

    const requestArgs = withoutCursor(args);
    const readVersion = computeVerificationReadVersion(
      "inspect_verification_artifacts",
      requestArgs,
      root,
      { verificationId: args.verificationId },
    );
    const [start] = requireCursorPosition({
      cursor: args.cursor,
      tool: "inspect_verification_artifacts",
      params: requestArgs,
      readVersion,
      kind: "items",
      slots: 1,
    });
    if (start > entries.length || (args.cursor !== undefined && start >= entries.length)) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }

    const rows = entries.map((entry) => {
      let verified: VerifiedAsset | null = null;
      let availability: "available" | "missing" | "corrupt" = "available";
      try {
        verified = verifyAsset(root.dataDir, entry.sha256);
      } catch (error) {
        availability =
          error instanceof RecordReadError && error.code === "ASSET_MISSING"
            ? "missing"
            : "corrupt";
      }
      return {
        path: entry.path,
        declaredBytes: entry.size,
        sha256: entry.sha256,
        availability,
        actualBytes: verified?.size ?? null,
      };
    });

    const buildPayload = (pageSize: number): ToolPayload => {
      const requested = Math.min(pageSize, args.limit ?? PAGE_LIMIT_DEFAULT);
      const page = rows.slice(start, start + requested);
      const end = start + page.length;
      const nextCursor =
        end < rows.length
          ? issueCursor({
              tool: "inspect_verification_artifacts",
              params: requestArgs,
              readVersion,
              kind: "items",
              position: [end],
            })
          : undefined;
      const count = (state: "available" | "missing" | "corrupt"): number =>
        rows.filter((row) => row.availability === state).length;
      const data = InspectVerificationArtifactsDataSchema.parse({
        verificationId: args.verificationId,
        recordStatus: record.status,
        excludedPatterns: [...event.excludedPatterns],
        declaredTotalBytes: event.totalBytes,
        totals: {
          entries: rows.length,
          available: count("available"),
          missing: count("missing"),
          corrupt: count("corrupt"),
        },
        items: page,
        remaining: rows.length - end,
        limit: requested,
      });
      return {
        readVersion,
        data,
        truncated: end < rows.length,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        runs: [],
        verifications: [
          {
            verificationId: args.verificationId,
            status: record.status,
          } satisfies ProvenanceVerificationInput,
        ],
        headline: [
          `inspect_verification_artifacts：${String(rows.length)} 项`,
          `可用 ${String(count("available"))} / 缺失 ${String(count("missing"))} / 损坏 ${String(count("corrupt"))}`,
        ].join(" / "),
      };
    };

    const initial = buildPayload(PAGE_LIMIT_DEFAULT);
    // D6/4.1：读后一致性核验（逐项核验读取了大量附件，台账必须仍与读取前一致）
    assertReadUnchanged(
      "inspect_verification_artifacts",
      requestArgs,
      root,
      { verificationId: args.verificationId },
      readVersion,
    );
    const initialCount = Math.min(rows.length - start, args.limit ?? PAGE_LIMIT_DEFAULT);
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
