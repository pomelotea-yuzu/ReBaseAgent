import type { Translator } from "@rebaseagent/i18n";
import {
  AssetResolveError,
  type VerifiedAsset,
  classifyAssetBody,
  resolveArtifactAsset,
  sliceAssetText,
  verifyAsset,
} from "@rebaseagent/project-verification/read";
import { z } from "zod";
import type { LimitationInput, ProvenanceVerificationInput } from "../envelope.js";
import { BODY_CHARS_DEFAULT, MESSAGE_MAX } from "../limits.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import {
  type ReadVerificationArtifactArgs,
  requireVerificationContract,
} from "../verification-contracts.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import {
  assertReadUnchanged,
  computeVerificationReadVersion,
  readRecordOrThrow,
  verificationToolError,
} from "./verification-support.js";

/**
 * `read_verification_artifact`（MCP2 design D2/D4/D5，tasks 3.5）。
 *
 * - path 必须在该验证的**产物清单**内（记录绑定），不接宿主路径/hash/URL（M08）；
 * - 先整体核验形态 + 大小 + SHA-256，再按码点读文本；二进制只给元数据（M11）；
 * - 游标绑定验证/path/hash（D6）；排除规则原样带出；产物不转作输入快照（D4）。
 */

const RangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    unit: z.literal("unicode-code-point"),
  })
  .strict();

const FullAssetSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    sha256: z.string().min(1).max(64),
  })
  .strict();

const ArtifactBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      encoding: z.literal("utf8-text"),
      bodyIn: z.literal("content"),
      range: RangeSchema,
      truncated: z.boolean(),
      remaining: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("binary"),
      reason: z.string().min(1).max(MESSAGE_MAX),
    })
    .strict(),
]);

const ReadVerificationArtifactDataSchema = z
  .object({
    selector: z
      .object({
        verificationId: z.string().max(64),
        path: z.string().min(1),
      })
      .strict(),
    excludedPatterns: z.array(z.string().min(1)),
    fullAsset: FullAssetSchema,
    body: ArtifactBodySchema,
  })
  .strict();

export const readVerificationArtifactTool: ToolDefinition = defineTool(
  requireVerificationContract("read_verification_artifact"),
  async (
    args: ReadVerificationArtifactArgs,
    root: DataRoot,
    translator: Translator,
  ): Promise<ToolPayload> => {
    const record = readRecordOrThrow(root, args.verificationId);
    if (record.status === "corrupt" || record.status === "unsupported_version") {
      throw new ToolFailure("VERIFICATION_RECORD_INVALID", `status:${record.status}`);
    }

    let resolved: ReturnType<typeof resolveArtifactAsset>;
    try {
      resolved = resolveArtifactAsset(record, args.path);
    } catch (error) {
      const projected = verificationToolError(error);
      if (projected !== null) throw projected;
      if (error instanceof AssetResolveError) throw error;
      throw error;
    }
    let verified: VerifiedAsset;
    let body: ReturnType<typeof classifyAssetBody>;
    const requestArgs = withoutCursor(args);
    const versionExtra = {
      verificationId: args.verificationId,
      path: args.path,
      hash: resolved.sha256,
    };
    const readVersion = computeVerificationReadVersion(
      "read_verification_artifact",
      requestArgs,
      root,
      versionExtra,
    );
    // 游标先于附件读取核验（M12）：台账/附件变化 ⇒ STALE_CURSOR，不读半新半旧附件
    const [start] = requireCursorPosition({
      cursor: args.cursor,
      tool: "read_verification_artifact",
      params: requestArgs,
      readVersion,
      kind: "chars",
      slots: 1,
    });
    try {
      verified = verifyAsset(root.dataDir, resolved.sha256);
      body = classifyAssetBody(root.dataDir, resolved.sha256);
    } catch (error) {
      const projected = verificationToolError(error);
      throw projected ?? error;
    }

    const provenance: ProvenanceVerificationInput = {
      verificationId: args.verificationId,
      status: record.status,
      path: args.path,
      hash: resolved.sha256,
    };

    if (body.kind === "binary") {
      if (args.cursor !== undefined) throw new ToolFailure("INVALID_ARGUMENT", "cursor");
      const data = ReadVerificationArtifactDataSchema.parse({
        selector: { verificationId: args.verificationId, path: args.path },
        excludedPatterns: [...resolved.excludedPatterns],
        fullAsset: { bytes: verified.size, sha256: resolved.sha256 },
        body: {
          kind: "binary",
          reason: translator.t("mcp.binaryReason", {
            subject: translator.t("mcp.subjectArtifact"),
          }),
        },
      });
      return {
        readVersion,
        data,
        truncated: false,
        runs: [],
        verifications: [provenance],
        headline: translator.t("mcp.headlineReadArtifactBinary", { size: verified.size }),
      };
    }

    if (start > body.totalChars || (args.cursor !== undefined && start >= body.totalChars)) {
      throw new ToolFailure("INVALID_ARGUMENT", "cursor");
    }

    const buildPayload = (maxChars: number | undefined): ToolPayload => {
      const slice = sliceAssetText(root.dataDir, resolved.sha256, {
        start,
        maxChars: maxChars ?? BODY_CHARS_DEFAULT,
      });
      const data = ReadVerificationArtifactDataSchema.parse({
        selector: { verificationId: args.verificationId, path: args.path },
        excludedPatterns: [...resolved.excludedPatterns],
        fullAsset: { bytes: verified.size, sha256: resolved.sha256 },
        body: {
          kind: "text",
          encoding: "utf8-text",
          bodyIn: "content",
          range: {
            start: slice.start,
            end: slice.nextStart,
            total: slice.totalChars,
            unit: "unicode-code-point",
          },
          truncated: slice.truncated,
          remaining: slice.remaining,
        },
      });
      const nextCursor =
        slice.truncated && slice.nextStart > start
          ? issueCursor({
              tool: "read_verification_artifact",
              params: requestArgs,
              readVersion,
              kind: "chars",
              position: [slice.nextStart],
            })
          : undefined;
      return {
        readVersion,
        data,
        truncated: slice.truncated,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        ...(slice.text === "" ? {} : { contentBodies: [{ at: "body", text: slice.text }] }),
        runs: [],
        verifications: [provenance],
        headline: [
          translator.t("mcp.headlineReadArtifactText"),
          `${args.path} ${translator.t("mcp.summaryCodepointRange", {
            start: slice.start,
            end: slice.nextStart,
            total: slice.totalChars,
          })}`,
        ].join(" / "),
      };
    };

    const initial = buildPayload(args.maxChars);
    // D6/4.1：读后一致性核验（验证/来源/附件台账 + 本附件哈希绑定）
    assertReadUnchanged("read_verification_artifact", requestArgs, root, versionExtra, readVersion);
    const emitted = Math.min(body.totalChars - start, args.maxChars ?? BODY_CHARS_DEFAULT);
    if (emitted <= 0) return initial;
    return {
      ...initial,
      budget: {
        kind: "chars",
        value: emitted,
        minimum: 0,
        fit: (chars) => buildPayload(Math.min(chars, emitted)),
        limitRef: `asset:${resolved.sha256.slice(0, 12)}`,
      },
    };
  },
);
