import type { RunQueryToolErrorCode } from "@rebaseagent/run-query";
import { RunDetailReadError } from "@rebaseagent/run-query";
import { z, type ZodObject, type ZodRawShape } from "zod";
import { type ToolBudget, fitWithinBudget } from "./budget.js";
import { type ContentBodyInput, buildContentText } from "./content-text.js";
import {
  type LimitationInput,
  type ProvenanceRefInput,
  type ProvenanceRunInput,
  type ProvenanceVerificationInput,
  boundedHeadline,
  buildErrorEnvelope,
  buildSuccessEnvelope,
} from "./envelope.js";
import {
  TOOL_ERROR_MESSAGES,
  boundedMessage,
  projectArgumentError,
  projectThrowable,
  retryableOf,
} from "./error-projection.js";
import { MESSAGE_MAX } from "./limits.js";
import type { ToolDefinition, ToolResult } from "./server.js";
import type { DataRoot } from "./startup.js";
import {
  VERIFICATION_RETRYABLE_CODES,
  VERIFICATION_TOOL_ERROR_MESSAGES,
  type VerificationToolErrorCode,
  type McpToolErrorCode,
} from "./verification-codes.js";

/**
 * 工具定义缝：入参校验 → 实现调用 → 信封装配（design D4/D5 的交汇处）。
 *
 * 三层各管一段，避免"哪一层都能造错误"的漂移：
 * - **本层**只认两类业务失败：实现主动抛的 `ToolFailure`（带稳定码），以及共享读取层
 *   的 `RunDetailReadError`（按结构投影）。其余异常**继续上抛**，由服务层的
 *   受控内部错误出口处理——真正的程序缺陷不伪装成业务码。
 * - **服务层**（`server.ts`）负责未知工具名与兜底文案。
 * - **实现层**（4.3–4.7）负责把 `FsBoundaryError`/`TraceReadError` 之类结构化失败
 *   经 `classifyReadFailure` 转成 `ToolFailure`，不让原始异常越到这一层。
 *
 * 出参纪律（6.2 修订，owner 2026-10-23 定稿）：`content` = headline + data 紧凑投影，
 * 且**正文只承载一次**——正文本体只进 content 文本，`structuredContent.data` 对应位
 * 是 `bodyIn:"content"` 指针。完整结构仍走 `structuredContent`，且信封在发出前**自检**
 * （形状不合宁可不发）。预算量的是 content+structuredContent 整体，投影开销自然计入。
 */

/** 稳定码 → 受控文案（MCP1 既有码 + MCP2 验证域码同一张查找面） */
export function toolErrorMessageOf(code: McpToolErrorCode): string {
  return VERIFICATION_TOOL_ERROR_MESSAGES[code as never] ?? TOOL_ERROR_MESSAGES[code as never];
}

/** 可重试判定：MCP1 既有集合 ∪ 验证域集合 */
export function retryableOfCode(code: McpToolErrorCode): boolean {
  return (
    retryableOf(code as RunQueryToolErrorCode) ||
    VERIFICATION_RETRYABLE_CODES.has(code as VerificationToolErrorCode)
  );
}

/** 实现层主动宣告的业务失败：只带稳定码与可选定位，不带自造文案 */
export class ToolFailure extends Error {
  readonly code: McpToolErrorCode;
  readonly ref: string | undefined;

  constructor(code: McpToolErrorCode, ref?: string) {
    super(toolErrorMessageOf(code));
    this.name = "ToolFailure";
    this.code = code;
    this.ref = ref;
  }
}

/** 一次成功查询要装配进信封的全部件 */
export interface ToolPayload {
  /** 本次参与文件字节与参数的摘要（5.2 负责签发与续读核验） */
  readonly readVersion: string;
  readonly data: unknown;
  readonly runs: readonly ProvenanceRunInput[];
  readonly refs?: readonly ProvenanceRefInput[];
  /** MCP2：验证域 provenance（verifications） */
  readonly verifications?: readonly ProvenanceVerificationInput[];
  readonly limitations?: readonly LimitationInput[];
  readonly nextCursor?: string;
  readonly truncated?: boolean;
  /** 给 content 的首行状态/定位（有界；其后紧跟 data 投影，见 buildContentText） */
  readonly headline: string;
  /**
   * 6.2（正文只承载一次）：data 内标 `bodyIn:"content"` 的正文本体，
   * 只进 content 文本；`at` 是自 data 根起的定位路径（如 `body` / `file` / `files.left`）。
   */
  readonly contentBodies?: readonly ContentBodyInput[];
  /**
   * 可选：完整结果超过 64 KiB 时，框架用更小的条目数/码点数重建。
   * 实现只提供单旋钮与重建函数，测量与搜索由 `budget.ts` 统一做。
   */
  readonly budget?: ToolBudget;
}

export type ToolImplementation<Args> = (args: Args, root: DataRoot) => Promise<ToolPayload>;

/** defineTool 接受的契约形状（MCP1 ToolContract 与 MCP2 VerificationToolContract 同构） */
export interface ToolContractLike {
  readonly name: string;
  readonly description: string;
  readonly schema: ZodObject<ZodRawShape>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolDefinition["annotations"];
}

export interface DefineToolOptions {
  /** 观测时点注入（测试要求可预测；生产用当前 UTC 时刻） */
  readonly observedAt?: () => string;
}

export function defineTool<Args>(
  contract: ToolContractLike,
  implement: ToolImplementation<Args>,
  options: DefineToolOptions = {},
): ToolDefinition {
  return {
    name: contract.name,
    description: contract.description,
    inputSchema: contract.inputSchema,
    annotations: contract.annotations,
    async execute(rawArgs, root): Promise<ToolResult> {
      const parsed = contract.schema.safeParse(rawArgs);
      if (!parsed.success) {
        return failureResult(projectArgumentError(parsed.error.issues));
      }
      try {
        const payload = await implement(parsed.data as Args, root);
        /** observedAt 在收窄前后必须一致：它参与字节测量，也参与同参结果稳定性 */
        const observedAt =
          options.observedAt === undefined ? new Date().toISOString() : options.observedAt();
        const toResult = (candidate: ToolPayload): ToolResult => {
          const structuredContent = buildSuccessEnvelope({
            data: candidate.data,
            readVersion: candidate.readVersion,
            runs: candidate.runs,
            ...(candidate.refs === undefined ? {} : { refs: candidate.refs }),
            ...(candidate.verifications === undefined
              ? {}
              : { verifications: candidate.verifications }),
            ...(candidate.limitations === undefined ? {} : { limitations: candidate.limitations }),
            ...(candidate.nextCursor === undefined ? {} : { nextCursor: candidate.nextCursor }),
            ...(candidate.truncated === undefined ? {} : { truncated: candidate.truncated }),
            observedAt,
          });
          return {
            content: [
              {
                type: "text",
                text: buildContentText(
                  boundedHeadline(candidate.headline),
                  candidate.data,
                  candidate.contentBodies ?? [],
                ),
              },
            ],
            structuredContent,
          };
        };
        const fitted = fitWithinBudget(payload, toResult, `tool:${contract.name}`);
        if (!fitted.ok) throw new ToolFailure("RESPONSE_LIMIT", fitted.ref);
        return fitted.result;
      } catch (e) {
        if (e instanceof ToolFailure) {
          return failureResult(
            {
              code: e.code,
              message: toolErrorMessageOf(e.code),
              retryable: retryableOfCode(e.code),
            },
            e.ref,
          );
        }
        if (e instanceof RunDetailReadError) {
          return failureResult(projectThrowable(e));
        }
        throw e;
      }
    },
  };
}

function failureResult(
  error: { code: McpToolErrorCode; message: string; retryable: boolean },
  ref?: string,
): ToolResult {
  const envelope = buildErrorEnvelope({
    code: error.code,
    message: boundedMessage(error.message),
    ...(ref === undefined ? {} : { ref }),
    retryable: error.retryable,
  });
  return {
    // content 只承载"哪个码"，具体一句受控文案在 structuredContent 里
    content: [{ type: "text", text: `${error.code}（本次查询未完成）` }],
    structuredContent: envelope,
    isError: true,
  };
}
