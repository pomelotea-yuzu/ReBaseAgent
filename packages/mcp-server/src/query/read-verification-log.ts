import { z } from "zod";
import {
  AssetResolveError,
  classifyAssetBody,
  resolveLogAsset,
  sliceAssetText,
  verifyAsset,
  type VerifiedAsset,
} from "@rebaseagent/project-verification/read";
import { BODY_CHARS_DEFAULT, MESSAGE_MAX } from "../limits.js";
import type { LimitationInput, ProvenanceVerificationInput } from "../envelope.js";
import type { ToolDefinition } from "../server.js";
import type { DataRoot } from "../startup.js";
import {
  type ReadVerificationLogArgs,
  requireVerificationContract,
} from "../verification-contracts.js";
import { ToolFailure, type ToolPayload, defineTool } from "../tool-definition.js";
import { issueCursor, requireCursorPosition, withoutCursor } from "./cursor-io.js";
import {
  assertReadUnchanged,
  computeVerificationReadVersion,
  readRecordOrThrow,
  verificationToolError,
} from "./verification-support.js";

/**
 * `read_verification_log`（MCP2 design D2/D5，tasks 3.3）。
 *
 * - 日志按**验证/命令/流**定位：附件哈希由记录内唯一 command_end 解析，本工具
 *   不接裸 hash/字节 offset（重复 command_end = 定位歧义，受控拒绝，M08）；
 * - 三层事实分开（M10）：capture（执行时保留 vs 观测）、fullAsset（完整核验附件）、
 *   range（本响应码点范围）——读完保留部分不消除执行时丢弃（limitation 常驻）；
 * - 文本按严格 UTF-8 整体解码后码点切片；二进制/非法编码只给元数据（M11）；
 * - 空日志（空串文本）与未记录（LOG_NOT_RECORDED）与缺失（ASSET_MISSING）分开；
 * - 未封存记录内**已验证完整事件**的附件可读（D3），带 VERIFICATION_UNTERMINATED
 *   limitation；坏记录读正文受控拒绝。
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

const CaptureSchema = z
  .object({
    /** 执行时保留字节（command_end.byteLength） */
    retainedBytes: z.number().int().nonnegative(),
    /** 执行时观测字节（command_end.totalBytes；>retained ⇒ 有丢弃） */
    observedBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const LogBodySchema = z.discriminatedUnion("kind", [
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

const ReadVerificationLogDataSchema = z
  .object({
    selector: z
      .object({
        verificationId: z.string().max(64),
        commandId: z.enum(["typecheck", "test"]),
        stream: z.enum(["stdout", "stderr"]),
      })
      .strict(),
    capture: CaptureSchema,
    fullAsset: FullAssetSchema,
    body: LogBodySchema,
  })
  .strict();

export const readVerificationLogTool: ToolDefinition = defineTool(  requireVerificationContract("read_verification_log"),
  async (args: ReadVerificationLogArgs, root: DataRoot): Promise<ToolPayload> => {
    const record = readRecordOrThrow(root, args.verificationId);
    if (record.status === "corrupt" || record.status === "unsupported_version") {
      // 坏记录不可读正文（design D3）：记录状态本身已是 get_verification 的成功诊断
      throw new ToolFailure("VERIFICATION_RECORD_INVALID", `status:${record.status}`);
    }

    let resolved;
    try {
      resolved = resolveLogAsset(record, args.commandId, args.stream);
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
      commandId: args.commandId,
      stream: args.stream,
      hash: resolved.sha256,
    };
    const readVersion = computeVerificationReadVersion(
      "read_verification_log",
      requestArgs,
      root,
      versionExtra,
    );
    // 游标先于附件读取核验（M12）：来源/附件台账已变 ⇒ STALE_CURSOR（从首页重查），
    // 而不是读出半新半旧的附件；篡改/异参仍在 decode 内判 INVALID_ARGUMENT
    const [start] = requireCursorPosition({
      cursor: args.cursor,
      tool: "read_verification_log",
      params: requestArgs,
      readVersion,
      kind: "chars",
      slots: 1,
    });
    try {
      verified = verifyAsset(root.dataDir, resolved.sha256);
      body = classifyAssetBody(root.dataDir, resolved.sha256);
    } catch (error) {
      // 附件缺失/损坏/被顶替 → 稳定码（原始异常不出工具层）
      const projected = verificationToolError(error);
      throw projected ?? error;
    }

    const limitations: LimitationInput[] = [];
    if (resolved.capture.truncated) {
      limitations.push({
        code: "VERIFICATION_CAPTURE_TRUNCATED",
        ref: `asset:${resolved.sha256.slice(0, 12)}`,
        message: `执行时输出被截断：保留 ${String(resolved.capture.byteLength)} / 观测 ${String(resolved.capture.totalBytes)} 字节，丢弃部分不可恢复`,
      });
    }
    if (record.status === "unterminated") {
      limitations.push({
        code: "VERIFICATION_UNTERMINATED",
        ref: `verification:${args.verificationId}`,
        message: "记录未封存：附件来自已落盘的完整 command_end 事件，不承诺代表完整执行",
      });
    }

    if (body.kind === "binary") {
      if (args.cursor !== undefined) throw new ToolFailure("INVALID_ARGUMENT", "cursor");
      const data = ReadVerificationLogDataSchema.parse({
        selector: {
          verificationId: args.verificationId,
          commandId: args.commandId,
          stream: args.stream,
        },
        capture: {
          retainedBytes: resolved.capture.byteLength,
          observedBytes: resolved.capture.totalBytes,
          truncated: resolved.capture.truncated,
        },
        fullAsset: { bytes: verified.size, sha256: resolved.sha256 },
        body: {
          kind: "binary",
          reason: "附件不是严格 UTF-8 文本：只提供字节数与哈希，不外发正文",
        },
      });
      return {
        readVersion,
        data,
        truncated: false,
        runs: [],
        verifications: [
          {
            verificationId: args.verificationId,
            status: record.status,
            commandId: args.commandId,
            stream: args.stream,
            hash: resolved.sha256,
          },
        ],
        limitations,
        headline: `read_verification_log：binary（${String(verified.size)} 字节，未外发正文）`,
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
      const data = ReadVerificationLogDataSchema.parse({
        selector: {
          verificationId: args.verificationId,
          commandId: args.commandId,
          stream: args.stream,
        },
        capture: {
          retainedBytes: resolved.capture.byteLength,
          observedBytes: resolved.capture.totalBytes,
          truncated: resolved.capture.truncated,
        },
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
              tool: "read_verification_log",
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
        verifications: [
          {
            verificationId: args.verificationId,
            status: record.status,
            commandId: args.commandId,
            stream: args.stream,
            hash: resolved.sha256,
          },
        ],
        limitations,
        headline: [
          `read_verification_log：text`,
          `${String(slice.start)}–${String(slice.nextStart)} 码点（共 ${String(slice.totalChars)}）`,
          resolved.capture.truncated ? "capture 截断仍在" : "capture 完整",
        ].join(" / "),
      };
    };

    const initial = buildPayload(args.maxChars);
    // D6/4.1：读后一致性核验（验证/来源/附件台账 + 本附件哈希绑定）
    assertReadUnchanged("read_verification_log", requestArgs, root, versionExtra, readVersion);
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
