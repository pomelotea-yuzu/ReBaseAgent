import { readRunLineage } from "./run-lineage-read";

/**
 * U6（add-partial-run-reading）tasks §5.1：**共享 main 来源检查**（design D5）。
 *
 * 五类引用父本的主动入口（普通/隔离 result、prompt、代理 messages、model_params/A-B）
 * 在 U4 判重、接受占槽之后，由 main **服务端重读**被引用父本的来源——不信任 renderer
 * 的 completeness 声明，也不信任本会话早先的预检结论（父文件可能在预检后消失）。
 *
 * 判定（单次读取上下文 `readRunLineage`，只读、零写入）：
 * - 完整链校验通过 ⇒ 放行，继续走原有领域门禁（领域门禁不因 complete 绕过）；
 * - 祖先文件确实缺失（唯一结构化缺失形态）⇒ 稳定码 `RUN_LINEAGE_INCOMPLETE`；
 * - 其余一切读取失败（当前 run 缺失/损坏/版本/成环/非法定位/不可读）⇒
 *   稳定码 `RUN_DETAIL_UNREADABLE`。
 *
 * 两种拒绝都发生在授权消费、业务文件写入、工具或模型请求之前；经 `toRunResult`
 * 映射为 `settled/rejected`，runIds 为空，finally 只释放本操作的槽（registry 语义，
 * 本模块不重复处理）。消息全部为受控中文：不透传物理路径、errno 原文或堆栈。
 */

/** 来源类拒绝的稳定码（renderer 侧 `isLineageRejectionCode` 消费同名常量语义） */
export const RUN_SOURCE_REJECTION = {
  incomplete: "RUN_LINEAGE_INCOMPLETE",
  unreadable: "RUN_DETAIL_UNREADABLE",
} as const;

export type RunSourceRejectionCode =
  (typeof RUN_SOURCE_REJECTION)[keyof typeof RUN_SOURCE_REJECTION];

/** 来源门禁的拒绝（携带稳定码与可选缺失 ID；message 已受控，不含路径） */
export class RunSourceRejection extends Error {
  constructor(
    readonly code: RunSourceRejectionCode,
    message: string,
    /** 仅 RUN_LINEAGE_INCOMPLETE 携带（受校验的缺失祖先 run ID）；不可读为 null */
    readonly missingRunId: string | null,
  ) {
    super(message);
    this.name = "RunSourceRejection";
  }
}

/**
 * 校验被引用父本的来源；不成立即抛 `RunSourceRejection`（抛出即拒绝，调用方
 * 无需再判返回值）。放在各通道 `run` 体内「只读配置检查之后、一切副作用之前」。
 */
export function checkRunSource(tracesDir: string, runId: string): void {
  const outcome = readRunLineage(tracesDir, runId);
  if (outcome.ok && outcome.complete) return;
  if (outcome.ok) {
    throw new RunSourceRejection(
      RUN_SOURCE_REJECTION.incomplete,
      `来源不完整：被引用的父本 ${runId} 只能确认自身及可读上游，祖先 run ${outcome.missingRunId} 的文件缺失，不能引用不完整父本执行`,
      outcome.missingRunId,
    );
  }
  throw new RunSourceRejection(
    RUN_SOURCE_REJECTION.unreadable,
    `来源不可读：被引用的父本 ${runId} 的详情读取失败（${outcome.message}）`,
    null,
  );
}
