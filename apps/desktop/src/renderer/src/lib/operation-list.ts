import type { MessageKey, Translator } from "@rebaseagent/i18n";
import type { OperationDiagnostic, OperationKind, OperationRecord } from "@shared/operations";
import type { OperationResultView } from "./operation-result-view";
import {
  buildOperationResultViews,
  requestFactsLineOf,
  resultViewKeyOf,
} from "./operation-result-view";
import type { OperationSession } from "./operation-session";
import { stalePendingOf } from "./operation-session";
import type { ResultReadStore } from "./result-verification";
import type { WaitView } from "./wait-timing";
import { deriveWaitView } from "./wait-timing";

/**
 * U4 任务 4.7：全局栏「操作」入口的**数据派生**（纯函数，可单测）。
 *
 * 三条口径写在这里而不是组件里：
 * 1. **状态只有四种可见值**：`running / settled / notAccepted / unknown`。
 *    不显示进度百分比、不显示"第几步"、不给停止按钮——main 没有这些事实
 *    （spec「不显示虚构阶段、百分比或取消能力」）。`settled` 也**不等于**"运行成功"：
 *    它只是"这条请求收口了"，A/B 部分失败同样是 settled。
 * 2. **两种查询绝不混用**：核对走 `operations:reconcile(operationId)`，
 *    读记录走既有 `runs:get(runId)`。派生行把两个动作分成 `reconcileTarget` 与
 *    `runLinks` 两组字段，组件没有"拿 runId 去核对"或"拿 operationId 去读详情"的写法可写。
 * 3. **未知历史原样呈现**：换过 main 会话后仍挂着的旧提交（`stalePendingOf`）标成
 *    unknown，只给核对动作、不给结果链接——它的结局永久未知，不按列表猜关联。
 */

export type OperationPhase = "running" | "settled" | "notAccepted" | "unknown";

export interface OperationRunLink {
  readonly runId: string;
  /** 该 run 是否已被登记为可信身份（身份 ≠ 文件已归位/可读/封存） */
  readonly note: string;
}

export interface OperationRow {
  readonly key: string;
  readonly phase: OperationPhase;
  /** 类型标签（中文）；未知历史没有类型事实 ⇒ null */
  readonly kindLabel: string | null;
  /** 目标摘要（只有定位 id 与臂数，没有正文） */
  readonly targetText: string;
  /** operationId（核对用的唯一键；完整显示，长文本靠 break-all 不遮挡） */
  readonly operationId: string;
  /**
   * 所属 main 会话 epoch（U5 任务 3.5：结果动作的身份是 `(epoch, operationId, runId)` 三元组，
   * 少了 epoch 就没法按身份回查读取项，也不会 accidentally 拿旧会话的结论去标新会话的账）。
   */
  readonly epoch: string;
  readonly runLinks: ReadonlyArray<OperationRunLink>;
  /**
   * 受控诊断列表（U5 任务 5.1：详情可读诊断）。main 侧已做脱敏与限长
   * （码 ≤64、文案 ≤512、条数 ≤32，`shared/operations` schema strict），这里原样透传，
   * **组件不再校一遍**——正文、密钥、授权与 sourceToken 从结构上就没有进来的通道。
   */
  readonly diagnostics: readonly OperationDiagnostic[];
  /**
   * 请求事实（信封侧）单独一行，与 `result` 里的运行结局**分层呈现、互不覆盖**；
   * running / notAccepted / 未知历史为 null（"零调用未执行"只属于 notAccepted 文案）。
   */
  readonly requestLine: string | null;
  /** 实验号（仅 A/B） */
  readonly experimentId: string | null;
  /** 能否核对：unknown 历史也能（它就是去核对的入口）；已终态也可再核对一次 */
  readonly canReconcile: boolean;
  /** 提示语：状态后面那句人话 */
  readonly hint: string;
  /**
   * U5 任务 5.2 的**真实等待计时**；不传时钟、或没有任何时间事实 ⇒ null（不造数）。
   * 文本由 `lib/wait-timing.ts` 现算——组件与面板都不复算时长。
   */
  readonly wait: WaitView | null;
  /**
   * U5 任务 3.5 的**结果呈现**（含明确动作与诚实说明）；未提供读取项或属未知历史 ⇒ null，
   * 面板退回"只报身份"的形态。⚠️ 它只是呈现：跳转与否由用户点击决定（`lib/operation-result-view`）。
   */
  readonly result: OperationResultView | null;
}

/** 结果呈现的注入参数（store 侧才拿得到的两份会话内数据 + 草稿在场判据） */
export interface OperationRowResults {
  readonly reads: ResultReadStore;
  readonly draftPresentOf: (record: OperationRecord) => boolean;
}

/** U5 任务 5.2：等待计时的时钟注入（组件从 `useWaitClock` 拿读数；不传 ⇒ `wait` 为 null） */
export interface OperationRowClock {
  readonly nowMs: number;
}

const KIND_LABEL_KEYS: Record<OperationKind, MessageKey> = {
  create: "run.kindCreate",
  result: "run.kindResult",
  prompt: "run.kindPrompt",
  proxy: "run.kindProxy",
  modelAb: "run.kindModelAb",
  verificationPrepare: "run.kindVerificationPrepare",
  verification: "run.kindVerification",
};

const PHASE_HINT_KEYS: Record<OperationPhase, MessageKey> = {
  running: "run.phaseHintRunning",
  settled: "run.phaseHintSettled",
  notAccepted: "run.phaseHintNotAccepted",
  unknown: "run.phaseHintUnknown",
};

/** R3 target 摘要的共用定位文案：run + 检查点形态（D6：target run 放 target） */
function verificationTargetText(
  runId: string,
  checkpointKind: "initial" | "step",
  stepSpanId: string | null,
  translator: Translator,
): string {
  const checkpoint =
    checkpointKind === "initial"
      ? translator.t("run.checkpointInitial")
      : translator.t("run.checkpointStep", {
          span: stepSpanId ?? translator.t("run.stepMissing"),
        });
  return translator.t("run.parentCheckpoint", { runId, checkpoint });
}

function targetTextOf(record: OperationRecord, translator: Translator): string {
  const target = record.target;
  if (target === null) return translator.t("run.targetNoFacts");
  switch (target.kind) {
    case "create":
      return translator.t(
        target.mode === "isolated" ? "run.targetIsolatedCreate" : "run.targetChatCreate",
      );
    case "result":
      return translator.t("run.targetResult", {
        parent: target.parentRunId,
        span: target.atSpanId,
        field: target.editField,
        isolated: target.mode === "isolated" ? translator.t("run.targetIsolatedSuffix") : "",
      });
    case "prompt":
      return translator.t("run.targetPrompt", {
        parent: target.parentRunId,
        field: target.editField,
      });
    case "proxy":
      return translator.t("run.targetProxy", {
        parent: target.parentRunId,
        span: target.atSpanId,
      });
    case "modelAb":
      return translator.t("run.targetModelAb", {
        parent: target.parentRunId,
        count: target.armCount,
      });
    case "verificationPrepare":
      return translator.t("run.targetVerificationPrepare", {
        target: verificationTargetText(
          target.runId,
          target.checkpointKind,
          target.stepSpanId,
          translator,
        ),
      });
    case "verification":
      return translator.t("run.targetVerification", {
        target: verificationTargetText(
          target.runId,
          target.checkpointKind,
          target.stepSpanId,
          translator,
        ),
        command: target.commandId,
      });
  }
}

function rowOf(
  record: OperationRecord,
  result: OperationResultView | null,
  submittedAt: number | null,
  clock: OperationRowClock | undefined,
  translator: Translator,
): OperationRow {
  const phase: OperationPhase = record.state;
  return {
    key: `${record.epoch}/${record.operationId}`,
    phase,
    kindLabel: record.target === null ? null : translator.t(KIND_LABEL_KEYS[record.target.kind]),
    targetText: targetTextOf(record, translator),
    operationId: record.operationId,
    epoch: record.epoch,
    // runIds 是身份，不是"可读证明"：note 说清这一点，界面据此显示"读取可能失败"
    runLinks: record.runIds.map((runId) => ({
      runId,
      note: translator.t(phase === "running" ? "run.noteRunning" : "run.noteReadable"),
    })),
    diagnostics: record.diagnostics,
    requestLine: requestFactsLineOf(record, translator),
    experimentId: record.experimentId,
    canReconcile: true,
    hint: translator.t(PHASE_HINT_KEYS[phase]),
    wait:
      clock === undefined
        ? null
        : deriveWaitView({ record, submittedAt, nowMs: clock.nowMs }, translator),
    result,
  };
}

function unknownRow(
  epoch: string,
  operationId: string,
  submittedAt: number | null,
  clock: OperationRowClock | undefined,
  translator: Translator,
): OperationRow {
  return {
    key: `${epoch}/${operationId}`,
    phase: "unknown",
    kindLabel: null,
    targetText: translator.t("run.unknownTarget"),
    operationId,
    epoch,
    runLinks: [],
    diagnostics: [],
    requestLine: null,
    experimentId: null,
    canReconcile: true,
    hint: translator.t(PHASE_HINT_KEYS.unknown),
    // 未知历史只有"本地提交了多久"这一个时间事实（重载后连它也没有 ⇒ null，不造数）
    wait:
      clock === undefined
        ? null
        : deriveWaitView({ record: null, submittedAt, nowMs: clock.nowMs }, translator),
    // 旧会话的操作没有本会话的读取项可依附 ⇒ 不给结果动作（只能核对）
    result: null,
  };
}

/**
 * 入口要显示的行：**新的在前**（用户最关心刚提交的那条），未知历史排在其后。
 * 不按界面开合或本地关联裁剪——快照里有几条就报几条。
 *
 * @param results 可选：U5 3.5 的结果呈现（`{reads, draftPresentOf}`）。不传 ⇒ `result` 为 null，
 *                面板退回"只报身份"的形态（U4 既有用例即走这条路）。
 * @param clock 可选：U5 5.2 的等待计时读数（`{nowMs}`，由可见性受控时钟注入）。
 *              不传 ⇒ `wait` 为 null——时长绝不由组件自算。
 */
export function deriveOperationRows(
  session: OperationSession,
  results: OperationRowResults | undefined,
  clock: OperationRowClock | undefined,
  translator: Translator,
): OperationRow[] {
  const views =
    results === undefined
      ? {}
      : buildOperationResultViews(
          {
            records: session.operations,
            reads: results.reads,
            draftPresentOf: results.draftPresentOf,
          },
          translator,
        );
  // 本地提交时刻只挂在**尚未销账的在飞身份**上（settle 后即从 pending 移除，
  // 终态行的时长因此退回 main startedAt + "自接受起"标注——这是刻意的口径分层）
  const submittedAtOf = (operationId: string): number | null =>
    session.pending.find((one) => one.operationId === operationId)?.submittedAt ?? null;
  const rows = session.operations.map((record) =>
    rowOf(
      record,
      views[resultViewKeyOf(record)] ?? null,
      submittedAtOf(record.operationId),
      clock,
      translator,
    ),
  );
  const stale = stalePendingOf(session).map((one) =>
    unknownRow(one.epoch, one.operationId, one.submittedAt, clock, translator),
  );
  return [...rows.reverse(), ...stale];
}

/**
 * 全局栏按钮上的最小事实：总数 + 要不要盯（没有百分比、没有进度）。
 *
 * `unreadResults`（U5 3.6）是**未读结果通知条数**——它由 `deriveResultNotices` 现算，
 * 同一结论的重复快照不会让它变大 ⇒ "重复状态不重复通知"在这一层也拿不到计数增量。
 */
export function operationBadge(
  rows: readonly OperationRow[],
  unreadResults: number,
  translator: Translator,
): { readonly label: string; readonly attention: boolean } {
  const running = rows.filter((one) => one.phase === "running").length;
  const unknown = rows.filter((one) => one.phase === "unknown").length;
  const attention = running > 0 || unknown > 0 || unreadResults > 0;
  const parts = [translator.t("run.badgeOperations", { count: rows.length })];
  if (running > 0) parts.push(translator.t("run.badgeRunning", { count: running }));
  if (unknown > 0) parts.push(translator.t("run.badgeUnknown", { count: unknown }));
  if (unreadResults > 0) parts.push(translator.t("run.badgeUnread", { count: unreadResults }));
  return { label: parts.join(" · "), attention };
}

/** 是否还有需要盯着的操作（决定要不要继续轮询；与轮询判据同源） */
export function hasWatchableOperation(session: OperationSession): boolean {
  return (
    session.operations.some((record) => record.state === "running") ||
    stalePendingOf(session).length > 0 ||
    session.pending.some((one) => one.epoch === session.epoch)
  );
}
