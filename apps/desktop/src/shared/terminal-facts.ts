/**
 * U5（unify-run-execution-workflow）任务 1.1：**自有终止事实**与结果身份判据。
 *
 * design D4 的落点。此前"这次执行到底算不算正常结束"只有两处口径：
 * - 列表徽标与概览用 `classifyOutcome`（**展示**用，允许保留未知原值）；
 * - 各执行函数看执行信封的 `ok` / `data.id`（**响应**用）。
 * 两者都不足以支撑 U5 的两件事——按可信身份读取结果、按正常结束清理草稿：
 * `status === "completed"` 只说明**文件已封存**（`reader.ts` 里 events 非空即 completed），
 * IPC `ok` 只说明请求回了话，`requestOutcome === "returned"` 连失败臂都算returned。
 * 于是「成功信封 + 运行 error」「祖先正常结束 + 子运行中断」都会被误读成本次正常结束。
 *
 * 三条不许猜的纪律：
 * 1. **正常结束只认自有终止事件**：末条 `run.event` 必须同时是 `event === "stopped"`
 *    与 `reason === "completed"`。二者缺一（如代理录制的 `stopped/error`、
 *    手工编辑出的 `errored/completed` 矛盾）⇒ 不算正常结束。
 *    展示口径仍走 `classifyOutcome`（那里"矛盾以 reason 为准"），**清理判据比展示严**是刻意的。
 * 2. **自有段由 `leafSpanIds` 界定**：失败定位只认真属于本 run 的 `llm.call`；
 *    祖先共享前缀里的错误调用不得冒充本次原因（复用 `deriveErrorTarget`，不重写一份）。
 * 3. **身份先于事实**：载荷自称的 run id、链条末跳的 run id 都必须等于请求的 runId，
 *    否则这条详情根本不解释本次操作——`events` 不带 run id，归属只能由这两道校验钉住。
 *
 * 未识别的 reason 从哪来：详情侧走 `RunDetailSchema`（`RunEventSchema` 的 reason 是枚举），
 * 非法记录会在**校验阶段**就被拒 ⇒ 结果不可读，本模块不参与、也不放宽 schema；
 * 列表摘要侧 `RunSummary.reason` 是开放字符串，未知原值经 `classifyOutcome` 如实保留。
 * 因此本模块的事件入参刻意用宽形状（`TerminalEventLine`），便于反例测试直接构造。
 */

import type { SpanLine } from "@rebaseagent/trace-sdk";
import { deriveTerminalReason } from "./derive";
import { type Outcome, classifyOutcome } from "./outcome";
import { type ErrorTarget, deriveErrorTarget } from "./overview";

/** 终止事件的最小形状（`RunEventLine` 结构上满足；放宽字面量以便构造反例） */
export interface TerminalEventLine {
  event: string;
  reason: string;
}

/** 自有终止事实的输入：`RunDetail` 的四个相关字段（不要求整份详情，便于单测构造） */
export interface OwnTerminalInput {
  status: "completed" | "crashed";
  /** **本 run 自有**的事件（main 侧三条分支与 `resolveBranch` 都只回叶子自己的） */
  events: ReadonlyArray<TerminalEventLine>;
  /** `getRun` 的（可能含祖先前缀的）展开轨迹 */
  spans: readonly SpanLine[];
  leafSpanIds: readonly string[];
}

/** 自有终止事实：结果核实与草稿收尾的唯一判据来源 */
export interface OwnTerminalFacts {
  /** 末条自有终止事件；`crashed`（无终止事件）⇒ null，不猜 */
  readonly event: TerminalEventLine | null;
  /** 自有终止原因（复用 `deriveTerminalReason`：crashed ⇒ null，不把残留 reason 当终止原因） */
  readonly reason: string | null;
  /** 展示结局（复用 `classifyOutcome`，与列表/概览同源） */
  readonly outcome: Outcome;
  /**
   * 严格正常结束判据（草稿清理的唯一入口条件）：
   * `event === "stopped"` 且 `reason === "completed"`。
   */
  readonly normalEnd: boolean;
  /** 真实自有失败调用（只在 `leafSpanIds` 内找）；非 error 终止或无自有详情时为 null */
  readonly failure: ErrorTarget;
}

/**
 * 自有终止事实。
 *
 * ⚠️ 入参 `events` 必须已经是**本 run 自有**的事件——本函数不看 `chain`，
 * 归属由 `findResultIdentityViolation` 在读取阶段先行确认（两处合一才是完整判据）。
 */
export function deriveOwnTerminalFacts(input: OwnTerminalInput): OwnTerminalFacts {
  const reason = deriveTerminalReason({ status: input.status, events: input.events });
  // crashed 的 events 即便残留也不可信（deriveTerminalReason 已归 null），事件本身同样取 null
  const last = input.status === "crashed" ? undefined : input.events[input.events.length - 1];
  return {
    event: last === undefined ? null : { event: last.event, reason: last.reason },
    reason,
    outcome: classifyOutcome({ status: input.status, reason }),
    normalEnd: last !== undefined && last.event === "stopped" && last.reason === "completed",
    failure: deriveErrorTarget({
      spans: input.spans,
      leafSpanIds: input.leafSpanIds,
      reason,
    }),
  };
}

/** 结果身份核对的输入（`RunDetail` 的相关投影） */
export interface ResultIdentityInput {
  /** 本次核实**请求**的 run id（来自 main 登记的可信 runIds，不来自界面选中项） */
  requestedRunId: string;
  detail: {
    meta: { id: string };
    /** 祖先链（从根到本 run，末跳即本 run） */
    chain: ReadonlyArray<{ meta: { id: string } }>;
  };
}

/**
 * 结果详情的身份违规说明；`null` = 三道核对全过。
 *
 * 违规 ⇒ 这条详情根本不解释本次操作：调用方按「结果不可读」处理，
 * 绝不退回去"用列表里最新的一条"或"用当前选中的运行"顶替。
 */
export function findResultIdentityViolation(input: ResultIdentityInput): string | null {
  if (input.detail.meta.id !== input.requestedRunId) {
    return `结果详情自称的 run（${input.detail.meta.id}）与请求的 run（${input.requestedRunId}）不一致`;
  }
  const lastHop = input.detail.chain[input.detail.chain.length - 1];
  if (lastHop === undefined) {
    return "结果详情缺少自有记录（祖先链为空），无法确认终止事件归属";
  }
  if (lastHop.meta.id !== input.requestedRunId) {
    return `结果详情的末跳记录（${lastHop.meta.id}）与请求的 run 不一致，终止事件归属不成立`;
  }
  return null;
}
