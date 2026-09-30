import { COMPARE_REASON_MAX, CompareRunsRequestSchema } from "../shared/ipc";
import { findIllegalRunIdViolation } from "./run-lineage-read";
import { RunDetailReadError, RunReadContext } from "./run-read-context";

/**
 * U7（improve-branch-comparison）tasks 1.3/1.6：runs:compare 只读比较端点。
 *
 * 不 import electron、可直测；IPC 注册在 ipc.ts（只读通道：不带执行身份、
 * 不占主动槽、不消耗授权、不写 trace/blob/source）。
 *
 * design D3 判据：
 * - 请求形状非法（数量/重复/多余字段）在信封层拒绝；非法 run 标识（穿越/绝对
 *   路径/分隔符）在**任何文件读取之前**整体拒绝——目录外路径连上下文都不建；
 * - 逐项 ready(detail)/unavailable(code, reason)：单侧失败不拖垮其他对象，
 *   合法侧仍完整返回；失败项保留真实 runId 与受控中文原因，不伪空文本、
 *   不降级为 ownOnly、不借另一对象顶替；
 * - 整个请求共享一个 RunReadContext（每物理 run 最多解析一次）；
 * - 当前文件不可读不能偷偷换一个对象——items 顺序恒等于请求顺序。
 */

/** 端点依赖（可注入测试桩） */
export interface CompareEndpointDeps {
  tracesDir: string;
}

/** 逐项不可用稳定码：U6 诊断原样成为码（CURRENT_RUN_NOT_FOUND / ANCESTOR_INVALID /
 *  ANCESTOR_UNREADABLE / LINEAGE_CYCLE / FORK_INVALID）；无诊断的当前 run 失败与
 *  投影失败分别用 RUN_INVALID / FORK_INVALID */
export const COMPARE_RUN_INVALID_CODE = "RUN_INVALID";
/** 兜底码：非 RunDetailReadError 的未知异常（按不可读处理，绝不落缺失分支） */
export const COMPARE_RUN_UNREADABLE_CODE = "RUN_UNREADABLE";

export type CompareEndpointOutcome =
  | { readonly ok: true; readonly items: unknown[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * 只读比较端点。成功时返回逐项结果（按请求顺序）；请求级拒绝返回稳定码与
 * 受控中文原因。不抛异常——信封构造交给 ipc.ts 的统一出口。
 */
export function compareRunsEndpoint(
  deps: CompareEndpointDeps,
  request: unknown,
): CompareEndpointOutcome {
  const parsed = CompareRunsRequestSchema.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: parsed.error.issues.map((issue) => issue.message).join("；"),
    };
  }
  const runIds = parsed.data.runIds;

  // 非法标识在任何文件读取之前拒绝（「越界路径在目录外读取前拒绝」）
  for (const id of runIds) {
    const violation = findIllegalRunIdViolation(id);
    if (violation !== null) {
      return { ok: false, code: "INVALID_ARGUMENT", message: `run 标识非法：${violation}` };
    }
  }

  // 单次读取上下文：整个请求共享，每物理 run 最多解析一次
  const context = new RunReadContext(deps.tracesDir);
  const items = runIds.map((runId) => {
    try {
      const { detail, chainSummaries } = context.readOf(runId);
      return { status: "ready" as const, runId, detail, chainSummaries };
    } catch (e) {
      const code =
        e instanceof RunDetailReadError
          ? (e.diagnostic ?? COMPARE_RUN_INVALID_CODE)
          : COMPARE_RUN_UNREADABLE_CODE;
      // 非异常对象收敛为固定受控文案；异常 message 已是受控中文（run id 可在场，
      // 物理路径/errno/堆栈不出 main 读取层）
      const reason = e instanceof Error ? e.message : "读取失败";
      return { status: "unavailable" as const, runId, code, reason: boundedReason(reason) };
    }
  });
  return { ok: true, items };
}

/** 受控原因有界化：超上限按码点截断（防止超长 run id 撑破响应 schema 边界） */
function boundedReason(message: string): string {
  const chars = [...message];
  if (chars.length <= COMPARE_REASON_MAX) {
    return message;
  }
  return `${chars.slice(0, COMPARE_REASON_MAX).join("")}…`;
}
