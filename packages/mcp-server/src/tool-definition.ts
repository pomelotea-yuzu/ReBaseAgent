import type { RunQueryToolErrorCode } from "@rebaseagent/run-query";
import { RunDetailReadError } from "@rebaseagent/run-query";
import {
  type LimitationInput,
  type ProvenanceRefInput,
  type ProvenanceRunInput,
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
import type { ToolContract } from "./tool-contracts.js";

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
 * 出参纪律：`content` 只有一句状态与定位（不复制正文）；完整结构走
 * `structuredContent`，且信封在发出前**自检**（形状不合宁可不发）。
 */

/** 实现层主动宣告的业务失败：只带稳定码与可选定位，不带自造文案 */
export class ToolFailure extends Error {
  readonly code: RunQueryToolErrorCode;
  readonly ref: string | undefined;

  constructor(code: RunQueryToolErrorCode, ref?: string) {
    super(TOOL_ERROR_MESSAGES[code]);
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
  readonly limitations?: readonly LimitationInput[];
  readonly nextCursor?: string;
  readonly truncated?: boolean;
  /** 给 content 的一句话状态/定位（有界，不复制正文） */
  readonly headline: string;
}

export type ToolImplementation<Args> = (args: Args, root: DataRoot) => Promise<ToolPayload>;

export interface DefineToolOptions {
  /** 观测时点注入（测试要求可预测；生产用当前 UTC 时刻） */
  readonly observedAt?: () => string;
}

export function defineTool<Args>(
  contract: ToolContract,
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
        const envelope = buildSuccessEnvelope({
          data: payload.data,
          readVersion: payload.readVersion,
          runs: payload.runs,
          ...(payload.refs === undefined ? {} : { refs: payload.refs }),
          ...(payload.limitations === undefined ? {} : { limitations: payload.limitations }),
          ...(payload.nextCursor === undefined ? {} : { nextCursor: payload.nextCursor }),
          ...(payload.truncated === undefined ? {} : { truncated: payload.truncated }),
          ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt() }),
        });
        return {
          content: [{ type: "text", text: boundedHeadline(payload.headline) }],
          structuredContent: envelope,
        };
      } catch (e) {
        if (e instanceof ToolFailure) {
          return failureResult(
            {
              code: e.code,
              message: TOOL_ERROR_MESSAGES[e.code],
              retryable: retryableOf(e.code),
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
  error: { code: RunQueryToolErrorCode; message: string; retryable: boolean },
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
