import type { RunQueryLimitationCode, RunQueryToolErrorCode } from "@rebaseagent/run-query";
import { z } from "zod";
import {
  CONTENT_HEADLINE_MAX,
  CURSOR_MAX,
  LOGICAL_PATH_MAX,
  MESSAGE_MAX,
  RUN_ID_MAX,
  SPAN_ID_MAX,
} from "./limits.js";
import { QUERY_API_VERSION } from "./server.js";
import {
  VERIFICATION_LIMITATION_CODES,
  type VerificationToolErrorCode,
} from "./verification-codes.js";

/**
 * 工具结果信封（design D4）。
 *
 * 成功与失败是**两套判别式形状**，客户端按 `ok` 分支，不用解析中文：
 * - 成功：`apiVersion / ok:true / observedAt / readVersion / data / provenance /
 *   limitations / page? / truncation`；
 * - 失败：`apiVersion / ok:false / error{code,message,ref?,retryable}`。
 *
 * 纪律：
 * - **未知就是未知**：`data` 里缺的事实由调用方传 `null` + 对应 limitation，
 *   本层不补 0、不估算（与共享层的消耗口径同源）。
 * - **来源只能指向真实对象**：`provenance.runs` 带真实身份与完整性标签，
 *   `refs` 用 run/span/自有检查点/逻辑路径，绝不出现宿主路径或 URL。
 * - **limitation 码封闭**：首版只有 D4 表里四项，实现不得自行造码。
 * - 信封由本模块**构造并自检**：形状不合就抛，交给服务层落一句受控文案，
 *   不把半套结构发给客户端。
 */

/** 参与本次结果的每个物理 run 的身份与完整性（renderer/MCP 共用同一判据口径） */
export const ProvenanceRunSchema = z
  .object({
    runId: z.string().min(1).max(RUN_ID_MAX),
    formatVersion: z.number().int().positive(),
    /** 是否已封存（有终止事件）；未封存不等于仍在运行 */
    sealed: z.boolean(),
    /**
     * 父链完整性：ownOnly 截断即 incomplete。
     * **省略 = 本次读取没有判定这一项**（例如 `list_runs` 只扫各自文件、不读父链）——
     * 补齐它等于把"没查过"写成"完整"，违反 design D4「未知保留未知」。
     */
    lineage: z.enum(["complete", "incomplete"]).optional(),
    /** 轨迹是合并前缀还是自有/独立执行；同上，省略 = 未判定 */
    spanScope: z.enum(["resolved", "own"]).optional(),
  })
  .strict();
export type ProvenanceRunInput = z.infer<typeof ProvenanceRunSchema>;

/** 可回查的定位：只允许真实运行、所属 span、自有检查点与逻辑路径 */
export const ProvenanceRefSchema = z
  .object({
    runId: z.string().min(1).max(RUN_ID_MAX),
    spanId: z.string().min(1).max(SPAN_ID_MAX).optional(),
    stepSpanId: z.string().min(1).max(SPAN_ID_MAX).optional(),
    snapshotId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    path: z.string().min(1).max(LOGICAL_PATH_MAX).optional(),
  })
  .strict();
export type ProvenanceRefInput = z.infer<typeof ProvenanceRefSchema>;

/** limitation 码全集：MCP1 既有四码 + MCP2 验证域七码（码封闭，见 design D3/D4） */
export const KNOWN_LIMITATION_CODES = [
  "TERMINATION_NOT_RECORDED",
  "ANCESTOR_NOT_FOUND",
  "BODY_NOT_EXPOSED",
  "REDACTED",
  ...VERIFICATION_LIMITATION_CODES,
] as const;
export type McpLimitationCode = (typeof KNOWN_LIMITATION_CODES)[number];

/** 只提示不导致失败的限制项（码封闭，见 design D3/D4） */
export const LimitationSchema = z
  .object({
    code: z.enum(KNOWN_LIMITATION_CODES),
    ref: z.string().min(1).max(MESSAGE_MAX).optional(),
    message: z.string().min(1).max(MESSAGE_MAX),
  })
  .strict();
export type LimitationInput = z.infer<typeof LimitationSchema>;

const CursorSchema = z.string().min(1).max(CURSOR_MAX);

export const SuccessEnvelopeSchema = z
  .object({
    apiVersion: z.literal(QUERY_API_VERSION),
    ok: z.literal(true),
    observedAt: z.string().min(1),
    readVersion: z.string().min(1),
    data: z.unknown(),
    provenance: z
      .object({
        runs: z.array(ProvenanceRunSchema),
        refs: z.array(ProvenanceRefSchema),
      })
      .strict(),
    limitations: z.array(LimitationSchema),
    page: z.object({ nextCursor: CursorSchema }).strict().optional(),
    truncation: z
      .object({
        truncated: z.boolean(),
        nextCursor: CursorSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type SuccessEnvelope = z.infer<typeof SuccessEnvelopeSchema>;

export const ErrorEnvelopeSchema = z
  .object({
    apiVersion: z.literal(QUERY_API_VERSION),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1).max(MESSAGE_MAX),
        ref: z.string().min(1).max(MESSAGE_MAX).optional(),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export interface SuccessInput {
  readonly data: unknown;
  readonly readVersion: string;
  readonly runs: readonly ProvenanceRunInput[];
  readonly refs?: readonly ProvenanceRefInput[];
  readonly limitations?: readonly LimitationInput[];
  readonly nextCursor?: string;
  readonly truncated?: boolean;
  /** 观测时点：默认取当前 UTC 时刻（测试注入以保证可预测） */
  readonly observedAt?: string;
}

/** 构造并自检成功信封 */
export function buildSuccessEnvelope(input: SuccessInput): SuccessEnvelope {
  return SuccessEnvelopeSchema.parse({
    apiVersion: QUERY_API_VERSION,
    ok: true,
    observedAt: input.observedAt ?? new Date().toISOString(),
    readVersion: input.readVersion,
    data: input.data,
    provenance: {
      runs: [...input.runs],
      refs: [...(input.refs ?? [])],
    },
    limitations: [...(input.limitations ?? [])],
    ...(input.nextCursor === undefined ? {} : { page: { nextCursor: input.nextCursor } }),
    truncation: {
      truncated: input.truncated ?? input.nextCursor !== undefined,
      ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
    },
  });
}

export interface FailureInput {
  readonly code: RunQueryToolErrorCode | VerificationToolErrorCode;
  readonly message: string;
  readonly ref?: string;
  readonly retryable: boolean;
}

/** 构造并自检失败信封：message 必须是受控文案（投影层负责，不接受原始异常文本） */
export function buildErrorEnvelope(input: FailureInput): ErrorEnvelope {
  return ErrorEnvelopeSchema.parse({
    apiVersion: QUERY_API_VERSION,
    ok: false,
    error: {
      code: input.code,
      message: input.message,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      retryable: input.retryable,
    },
  });
}

/** limitation 码判定（实现若自行造码，这里挡住而不是静默发出） */
export function isKnownLimitationCode(code: string): code is McpLimitationCode {
  return (KNOWN_LIMITATION_CODES as readonly string[]).includes(code);
}

export function boundedHeadline(text: string): string {
  const chars = [...text];
  return chars.length <= CONTENT_HEADLINE_MAX
    ? text
    : `${chars.slice(0, CONTENT_HEADLINE_MAX).join("")}…`;
}
