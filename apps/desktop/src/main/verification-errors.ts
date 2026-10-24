import type { OperationRunResult } from "./operation-registry";

/**
 * R3 端点业务错误（独立小文件：exec-endpoints 的 toRunResult 与 verification-endpoints
 * 都要认识它，且两者互相 import 会成环——错误类别放中间，两侧各自单向引用）。
 * `code` 是稳定码（进登记 settled/rejected），文案只用于本次响应。
 */
export class VerificationEndpointError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VerificationEndpointError";
  }
}

/** R3 错误 → 登记结局（rejected = 业务拒绝语义）；非 R3 错误返回 null 交回原判定 */
export function verificationRunResultOf(error: unknown): OperationRunResult | null {
  if (error instanceof VerificationEndpointError) {
    return { outcome: "rejected", code: error.code, message: error.message };
  }
  return null;
}
