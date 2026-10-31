import type {
  VerificationCapabilityResult,
  VerificationCheckpoint,
  VerificationGetMeta,
  VerificationGetResult,
  VerificationPreparePlanResult,
} from "@shared/ipc";
import type { OperationRecord } from "@shared/operations";
import { useTranslator } from "../i18n";
import type { ConfirmationRow } from "../lib/execution-confirmation";
import { disclosureLines } from "../lib/execution-confirmation";
import { formatBytes } from "../lib/format";
import type { VerificationComparison } from "../lib/verification-compare";
import type {
  VerificationCompareCandidate,
  VerificationStopNotice,
} from "../lib/verification-entry";
import {
  type VerificationBlocker,
  type VerificationConfirmationDecision,
  blockerLine,
  blockersFor,
  verificationBlockers,
  verificationDecisionLine,
  verificationPrepareDisclosure,
  verificationRecordLine,
  verificationRunDisclosure,
  verificationStopNoticeText,
  verificationTargetLabel,
} from "../lib/verification-entry";
import type { VerificationRecordView } from "../lib/verification-reading";
import { verificationStatusLine } from "../lib/verification-reading";
import type {
  VerificationExportFeedback,
  VerificationOutcomeView,
  VerificationSubmitError,
} from "../store/slices/verification";
import { ConfirmationBlock } from "./ConfirmationBlock";
import { FOCUS_RING } from "./IconButton";

/**
 * R3 任务 5.1/5.2/5.3：文件页检查点侧的**项目验证**面板（展示层，只吃 props）。
 *
 * D01/D02 的呈现面：
 * - **精确输入与当前条件**（D01）：run/检查点/快照/文件数与字节、profile/工具链、
 *   已准备环境、引擎健康、网络/脚本策略（plan.networkScopeNote）、限额与隔离基线
 *   （capability.profileSummary）——数字与事实全部来自 main 的只读核对
 *   （`verification:capability` + `verification:preparePlan`），本组件不发明第二份。
 * - **不可用原因可行动**（D01）：引擎缺席/来源不成立/未准备环境映射成"缺什么、能做什么"。
 * - **准备与执行分开确认**（D02）：两个独立的 ConfirmationBlock 与提交按钮；
 *   已准备环境不等于同意执行。
 * - **计划漂移失效**（D02）：确认判定（confirmed/stale/missing）由连接层现算传入；
 *   stale 就近显示原因，提交按钮禁用——不自动重确认、不自动提交新计划。
 * - **零副作用预览**（D01）：展开面板只发起两个只读 IPC；不下载、不建容器、不调模型。
 *
 * 5.2（D03/D04/D05/D10/M01/M02 的呈现面）：
 * - **操作登记核对区**（D03/M01）：按显式目标匹配到的 R3 登记记录逐条展示
 *   （状态/领域 ID/请求结局来自登记记录，不猜）；会话通信未知 ⇒ 只提示核对（D10）。
 * - **结局分层**（D04）：请求收尾（登记 settled/requestOutcome）、测试结局（outcome）、
 *   证据完整性（evidenceComplete）分行呈现，check_failed 不标成请求失败。
 * - **停止反馈**（D05/D06）：执行在飞时提供定向停止（按钮只在 run 在飞可用；
 *   准备阶段如实说明不可中断）；停止已请求 ⇒ 等待编排确认全部停止；
 *   幂等 no-op 与失败码如实呈现，不伪造取消。
 *
 * 5.3（D09/P13/P16 的呈现面）：
 * - **记录与日志阅读区**：只读**可信验证身份**（登记附件 ∪ 响应），读取零执行零补写；
 *   记录状态（封存/未封存/损坏/版本）如实呈现，未封存不冒充结局；
 * - **有界日志切片**（P13）：显示保留/全观测双口径字节与截断标注；切片正文标注
 *   "不是完整日志"（remaining/续读），不混入上一条正文（身份+代次守卫在 store）；
 * - **附件损坏/缺失**（D09/P16）：R3_LOG_* 稳定码就近呈现，不自动补写。
 * - **显式 selector**：目标（runId+checkpoint）由连接层在打开时显式绑定；本组件只显示
 *   `verificationTargetLabel`，绝不从当前文件选择器推导目标。
 */

/** 领域结局的可读短语（D04：结局 ≠ 请求收尾；原文枚举随行展示） */
export function verificationOutcomeLabel(outcome: string, translator: PanelTranslator): string {
  switch (outcome) {
    case "passed":
      return translator.t("verification.outcomePassed");
    case "check_failed":
      return translator.t("verification.outcomeCheckFailed");
    case "environment_failed":
    case "start_failed":
    case "process_failed":
      return translator.t("verification.outcomeEnvironmentFailed");
    case "timed_out":
    case "output_limit":
    case "cancelled":
      return translator.t("verification.outcomeStopped");
    case "artifact_invalid":
      return translator.t("verification.outcomeArtifactInvalid");
    case "evidence_incomplete":
      return translator.t("verification.outcomeEvidenceIncomplete");
    case "unknown":
      return translator.t("verification.outcomeUnknown");
    default:
      return translator.t("verification.outcomeUnrecognized");
  }
}

export interface VerificationPanelProps {
  readonly runId: string;
  /** 显式目标（打开面板那一刻绑定的检查点；展示用） */
  readonly checkpoint: VerificationCheckpoint;
  /** 当前检查点的可读名（文件页选择器的叫法，与显式目标一致） */
  readonly checkpointLabel: string;
  /** 渲染层早拦：非隔离 run 没有文件世界，入口直接禁用并说明 */
  readonly isolatedEligible: boolean;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;

  readonly capability: VerificationCapabilityResult | null;
  readonly capabilityState: "idle" | "loading" | "ready" | "error";
  readonly capabilityError: { code: string; message: string } | null;
  readonly plan: VerificationPreparePlanResult | null;
  readonly planState: "idle" | "loading" | "ready" | "error";
  readonly planError: { code: string; message: string } | null;
  readonly onRetryCapability: () => void;
  readonly onRetryPlan: () => void;

  readonly commandId: "typecheck" | "test";
  readonly onCommandChange: (commandId: "typecheck" | "test") => void;
  readonly prepareDecision: VerificationConfirmationDecision;
  readonly runDecision: VerificationConfirmationDecision;
  readonly onConfirmPrepare: () => void;
  readonly onConfirmRun: () => void;

  readonly submitting: "idle" | "prepare" | "run";
  readonly submitError: VerificationSubmitError | null;
  readonly lastOutcome: VerificationOutcomeView | null;
  readonly onSubmitPrepare: () => void;
  readonly onSubmitRun: () => void;

  // —— 5.2：操作登记核实与停止反馈（全部来自登记记录，不猜）——
  /** 按显式目标匹配到的 R3 登记记录（本会话已采纳的操作事实） */
  readonly matchedRecords: readonly OperationRecord[];
  /** 操作会话通信未知（D10）：只提示核对，不展示任何"执行中/已结束"猜测 */
  readonly operationsUnknown: boolean;
  /** 在飞 R3 操作身份（提交动作铸出；通道抛错后保留供核对） */
  readonly activeOperation: { kind: "prepare" | "run"; operationId: string } | null;
  readonly stopRequested: boolean;
  readonly stopNotice: VerificationStopNotice | null;
  readonly stopError: VerificationSubmitError | null;
  readonly onStop: () => void;

  // —— 5.3：验证记录与有界日志（只读可信身份；D09/P13/P16）——
  /** 可信验证身份（登记附件 ∪ 响应）；连接层保证不含猜测来源 */
  readonly trustedVerificationIds: readonly string[];
  readonly recordFocus: string | null;
  readonly onFocusRecord: (verificationId: string) => void;
  readonly recordState: "idle" | "loading" | "ready" | "error";
  /** 收窄后的记录视图（lib/verification-reading 的产物；null = 尚未就绪） */
  readonly recordView: VerificationRecordView | null;
  readonly recordStatus: VerificationGetResult["status"] | null;
  /** 记录头（5.5 导出绑定：run/检查点/快照事实）；不可读 ⇒ null */
  readonly recordMeta: VerificationGetMeta | null;
  /** 记录读取的结构化错误（坏尾行号/原因；P15/D09） */
  readonly recordErrorInfo: VerificationGetResult["error"];
  readonly recordError: { code: string; message: string } | null;
  /** 该验证的导出反馈（按 verificationId 留存；光标在别处时不显示） */
  readonly exportFeedback: VerificationExportFeedback | null;
  readonly onExportInput: () => void;
  readonly logIdentity: {
    verificationId: string;
    commandId: "typecheck" | "test";
    stream: "stdout" | "stderr";
  } | null;
  readonly logText: string;
  readonly logMeta: {
    totalBytes: number;
    nextOffset: number;
    remaining: number;
    truncated: boolean;
  } | null;
  readonly logState: "idle" | "loading" | "ready" | "error";
  readonly logError: { code: string; message: string } | null;
  readonly onReadLog: (
    commandId: "typecheck" | "test",
    stream: "stdout" | "stderr",
    mode: "replace" | "append",
  ) => void;

  // —— 5.4：双验证比较（D07/P24/P25：只读记录、显式 A/B）——
  /** 本会话登记附件里的验证身份（跨 run；不从时间/列表猜） */
  readonly compareCandidates: readonly VerificationCompareCandidate[];
  readonly compareLeft: string | null;
  readonly compareRight: string | null;
  readonly compareState: "idle" | "loading" | "ready" | "error";
  readonly compareError: { code: string; message: string } | null;
  readonly comparison: VerificationComparison | null;
  readonly onSelectCompareSide: (side: "left" | "right", verificationId: string | null) => void;
  readonly onClearCompare: () => void;
  /** 只读重试：重新读取两侧记录（不准备/不执行，D03/D04 同款） */
  readonly onRetryCompare: () => void;
  /** 两侧来源 run 不同才可打开运行比较；调用方判据见 WorkspaceFileView */
  readonly canOpenCompareDiff: boolean;
  readonly onOpenCompareDiff: () => void;
}

/** 判定与阻碍的文案映射在 lib（原因码/原因事实 → 当前语言），组件只排版。 */
type PanelTranslator = ReturnType<typeof useTranslator>;

function blockerLines(
  blockers: readonly VerificationBlocker[],
  translator: PanelTranslator,
): readonly string[] {
  return blockers.map((one) => blockerLine(one, translator));
}

function sourceStatusLabel(
  status: "present" | "missing" | "unknown",
  translator: PanelTranslator,
): string {
  switch (status) {
    case "present":
      return translator.t("verification.sourceStatusPresent");
    case "missing":
      return translator.t("verification.sourceStatusMissing");
    case "unknown":
      return translator.t("verification.sourceStatusUnknown");
  }
}

function compareCandidateSourceLine(
  candidate: VerificationCompareCandidate,
  translator: PanelTranslator,
): string {
  const run = candidate.runId ?? translator.t("verification.compareRunUnknown");
  const checkpoint =
    candidate.checkpointKind === null
      ? translator.t("verification.compareCheckpointUnknown")
      : candidate.checkpointKind === "initial"
        ? translator.t("verification.checkpointInitial")
        : translator.t("verification.checkpointStep", {
            stepSpanId: candidate.stepSpanId ?? "?",
          });
  const command = candidate.commandId ?? translator.t("verification.compareCommandUnknown");
  return `${run} · ${checkpoint} · ${command}`;
}

function metaCheckpointLabel(meta: VerificationGetMeta, translator: PanelTranslator): string {
  return meta.checkpoint.kind === "initial"
    ? translator.t("verification.checkpointInitial")
    : translator.t("verification.checkpointStep", { stepSpanId: meta.checkpoint.stepSpanId });
}

/** 5.5：验证输入导出的反馈（W03/W04/D08；不把导出说成测试通过） */
function VerificationExportFeedbackBody({
  feedback,
  expectedSnapshotId,
  translator,
}: {
  feedback: VerificationExportFeedback;
  expectedSnapshotId: string | null;
  translator: PanelTranslator;
}) {
  switch (feedback.kind) {
    case "in-flight":
      return (
        <div
          data-verification-export-feedback="in-flight"
          className="mt-0.5 text-[10px] text-violet-800"
        >
          {translator.t("verification.exportInFlight")}
        </div>
      );
    case "canceled":
      return (
        <div
          data-verification-export-feedback="canceled"
          className="mt-0.5 text-[10px] text-gray-600"
        >
          {translator.t("verification.exportCanceled")}
        </div>
      );
    case "failed":
      return (
        <div data-verification-export-feedback="failed" className="mt-0.5 text-[10px] text-red-700">
          {translator.t("verification.exportFailed", {
            code: feedback.code,
            reason: feedback.reason,
          })}
          {feedback.retained.length > 0 ? (
            <div>
              {translator.t("verification.exportRetained", {
                list: feedback.retained.join("、"),
              })}
            </div>
          ) : null}
        </div>
      );
    case "exported": {
      const outcome = feedback.outcome;
      const matches = expectedSnapshotId !== null && outcome.snapshotId === expectedSnapshotId;
      return (
        <div
          data-verification-export-feedback="exported"
          data-export-snapshot-match={matches ? "true" : "false"}
          className="mt-0.5 rounded border border-emerald-200 bg-white px-1.5 py-1 text-[10px] leading-4 text-gray-700"
        >
          <div>
            {translator.t("verification.exportExported", {
              count: outcome.fileCount,
              bytes: formatBytes(outcome.totalFileBytes),
              dir: outcome.targetDir,
            })}
          </div>
          <div>
            {translator.t("verification.exportSnapshotCompare", {
              expected: expectedSnapshotId ?? translator.t("verification.compareUnknownShort"),
              actual: outcome.snapshotId,
              match: translator.t(
                matches
                  ? "verification.exportSnapshotMatch"
                  : "verification.exportSnapshotMismatch",
              ),
            })}
          </div>
          <div>
            {translator.t("verification.exportPatch", {
              patch:
                outcome.patch.status === "written"
                  ? translator.t("verification.exportPatchWritten", {
                      bytes: outcome.patch.bytes ?? 0,
                    })
                  : outcome.patch.status === "no_text_changes"
                    ? translator.t("verification.exportPatchNone")
                    : outcome.patch.reason === null
                      ? translator.t("verification.exportPatchUnavailableNoReason")
                      : translator.t("verification.exportPatchUnavailable", {
                          reason: outcome.patch.reason,
                        }),
            })}
          </div>
          <div className="text-gray-500">{translator.t("verification.exportRecheck")}</div>
          <div className="text-amber-800">{translator.t("verification.exportNotPass")}</div>
        </div>
      );
    }
  }
}

function compareConditionStateLabel(
  state: "same" | "different" | "unknown",
  translator: PanelTranslator,
): string {
  switch (state) {
    case "same":
      return translator.t("verification.compareStateSame");
    case "different":
      return translator.t("verification.compareStateDifferent");
    case "unknown":
      return translator.t("verification.compareStateUnknown");
  }
}

export function VerificationPanel({
  runId,
  checkpoint,
  checkpointLabel,
  isolatedEligible,
  expanded,
  onToggleExpanded,
  capability,
  capabilityState,
  capabilityError,
  plan,
  planState,
  planError,
  onRetryCapability,
  onRetryPlan,
  commandId,
  onCommandChange,
  prepareDecision,
  runDecision,
  onConfirmPrepare,
  onConfirmRun,
  submitting,
  submitError,
  lastOutcome,
  onSubmitPrepare,
  onSubmitRun,
  matchedRecords,
  operationsUnknown,
  activeOperation,
  stopRequested,
  stopNotice,
  stopError,
  onStop,
  trustedVerificationIds,
  recordFocus,
  onFocusRecord,
  recordState,
  recordView,
  recordStatus,
  recordMeta,
  recordErrorInfo,
  recordError,
  exportFeedback,
  onExportInput,
  logIdentity,
  logText,
  logMeta,
  logState,
  logError,
  onReadLog,
  compareCandidates,
  compareLeft,
  compareRight,
  compareState,
  compareError,
  comparison,
  onSelectCompareSide,
  onClearCompare,
  onRetryCompare,
  canOpenCompareDiff,
  onOpenCompareDiff,
}: VerificationPanelProps) {
  const translator = useTranslator();
  const prepareBlockers = blockersFor(verificationBlockers(capability, translator), "prepare");
  const runBlockers = blockersFor(verificationBlockers(capability, translator), "run");
  const preparing = submitting === "prepare";
  const running = submitting === "run";
  // 提交资格：确认现算判定为 confirmed ∧ 该动作的不可用原因为空（D02：不隐式执行）
  const prepareReady =
    prepareDecision.kind === "confirmed" && prepareBlockers.length === 0 && !preparing;
  const runReady = runDecision.kind === "confirmed" && runBlockers.length === 0 && !running;
  const prepareDisclosure = verificationPrepareDisclosure(
    {
      runId,
      checkpointLabel: verificationTargetLabel(checkpoint, translator),
      capability,
      plan,
    },
    translator,
  );
  const runDisclosure = verificationRunDisclosure(
    {
      runId,
      checkpointLabel: verificationTargetLabel(checkpoint, translator),
      commandId,
      capability,
    },
    translator,
  );
  return (
    <div className="mt-1 min-w-0" data-verification-panel={runId}>
      <button
        type="button"
        data-verification-entry="true"
        disabled={!isolatedEligible}
        aria-expanded={expanded ? "true" : "false"}
        onClick={onToggleExpanded}
        title={
          isolatedEligible
            ? translator.t("verification.entryTitle")
            : translator.t("verification.entryDisabledTitle")
        }
        className={`rounded border border-emerald-300 px-2 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-50 ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        {expanded
          ? translator.t("verification.entryClose")
          : translator.t("verification.entryOpen")}
      </button>
      {!isolatedEligible ? (
        <span className="ml-2 text-[10px] text-gray-400">
          {translator.t("verification.entryNotIsolated")}
        </span>
      ) : null}

      {expanded && isolatedEligible ? (
        <div
          className="mt-1.5 rounded border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[11px] leading-5 text-gray-700"
          data-verification-confirm="true"
        >
          <div className="font-semibold text-gray-800">
            {translator.t("verification.panelHeading", {
              checkpoint: verificationTargetLabel(checkpoint, translator),
              runId,
            })}
          </div>
          <div className="mt-0.5 text-gray-500">
            {translator.t("verification.panelReadonlyNote")}
          </div>

          {/* —— 精确输入与当前条件（D01）—— */}
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] leading-4">
            {conditionRows({
              capability,
              capabilityState,
              plan,
              planState,
              translator,
            }).map((row) => (
              <div key={`${row.label}-${row.value}`} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-gray-500">{row.label}</dt>
                <dd className="min-w-0 break-words text-gray-700">{row.value}</dd>
              </div>
            ))}
          </dl>

          {/* —— 核对异常与重试（核对失败 ≠ 不可用：如实说明）—— */}
          {capabilityError !== null ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {translator.t("verification.capabilityCheckFailed", {
                code: capabilityError.code,
                detail: capabilityError.message,
              })}
              <button
                type="button"
                data-verification-retry-capability="true"
                onClick={onRetryCapability}
                className={`ml-2 rounded border border-amber-300 px-1.5 py-0.5 text-[10px] ${FOCUS_RING}`}
              >
                {translator.t("verification.retryCapability")}
              </button>
            </div>
          ) : null}
          {planError !== null ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {translator.t("verification.planReadFailed", {
                code: planError.code,
                detail: planError.message,
              })}
              <button
                type="button"
                data-verification-retry-plan="true"
                onClick={onRetryPlan}
                className={`ml-2 rounded border border-amber-300 px-1.5 py-0.5 text-[10px] ${FOCUS_RING}`}
              >
                {translator.t("verification.retryPlan")}
              </button>
            </div>
          ) : null}
          {capabilityState === "loading" || planState === "loading" ? (
            <div className="mt-1.5 text-gray-500">
              {translator.t("verification.checkingReadonly")}
            </div>
          ) : null}

          {/* —— 不可用原因（D01：可行动说明就近显示）—— */}
          {prepareBlockers.length > 0 ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {blockerLines(prepareBlockers, translator).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
          {runBlockers.length > 0 ? (
            <div className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800">
              {blockerLines(runBlockers, translator).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}

          {/* —— 两份独立确认（D02：准备与执行许可不互相替代）—— */}
          <ConfirmationBlock
            title={translator.t("verification.prepareBlockTitle")}
            summary={prepareDisclosure.summary}
            rows={disclosureLines(prepareDisclosure, translator)}
            confirmed={prepareDecision.kind === "confirmed"}
            confirmDisabled={capabilityState !== "ready"}
            onConfirm={onConfirmPrepare}
            confirmLabel={translator.t("verification.prepareConfirm")}
            confirmedLabel={translator.t("verification.prepareConfirmed")}
            blocked={verificationDecisionLine(prepareDecision, translator)}
            controlsId="verification-prepare-details"
            tone="emerald"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-verification-submit-prepare="true"
              disabled={!prepareReady}
              onClick={onSubmitPrepare}
              className={`rounded border border-emerald-400 bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-900 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
            >
              {preparing
                ? translator.t("verification.prepareSubmitting")
                : translator.t("verification.prepareSubmit")}
            </button>
            <span className="text-[10px] text-gray-500">
              {translator.t("verification.prepareSubmitHint")}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] font-medium text-gray-600">
              {translator.t("verification.commandLabel")}
            </span>
            {(["typecheck", "test"] as const).map((one) => (
              <button
                key={one}
                type="button"
                data-verification-command={one}
                aria-pressed={commandId === one ? "true" : undefined}
                onClick={() => onCommandChange(one)}
                className={`rounded border px-2 py-0.5 text-[11px] ${FOCUS_RING} ${
                  commandId === one
                    ? "border-gray-800 bg-gray-800 text-white"
                    : "border-gray-300 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {one}
              </button>
            ))}
          </div>
          <ConfirmationBlock
            title={translator.t("verification.runBlockTitle")}
            summary={runDisclosure.summary}
            rows={disclosureLines(runDisclosure, translator)}
            confirmed={runDecision.kind === "confirmed"}
            confirmDisabled={capabilityState !== "ready"}
            onConfirm={onConfirmRun}
            confirmLabel={translator.t("verification.runConfirm")}
            confirmedLabel={translator.t("verification.runConfirmed")}
            blocked={verificationDecisionLine(runDecision, translator)}
            controlsId="verification-run-details"
            tone="emerald"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-verification-submit-run="true"
              disabled={!runReady}
              onClick={onSubmitRun}
              className={`rounded border border-emerald-400 bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-900 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
            >
              {running
                ? translator.t("verification.runSubmitting")
                : translator.t("verification.runSubmit")}
            </button>
            <span className="text-[10px] text-gray-500">
              {translator.t("verification.runSubmitHint")}
            </span>
          </div>

          {/* —— 在飞操作与定向停止（5.2/D05：只停当前 owner；准备阶段如实说明不可中断）—— */}
          {activeOperation !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-orange-300 bg-orange-50 px-2 py-1 text-orange-900"
              data-verification-active-operation="true"
            >
              <div>
                {translator.t(
                  activeOperation.kind === "prepare"
                    ? "verification.activePrepare"
                    : "verification.activeRun",
                )}
              </div>
              {activeOperation.kind === "run" ? (
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    data-verification-stop="true"
                    disabled={stopRequested}
                    onClick={onStop}
                    className={`rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
                  >
                    {translator.t(
                      stopRequested ? "verification.stopRequested" : "verification.stopRequest",
                    )}
                  </button>
                  <span className="text-[10px] text-gray-500">
                    {translator.t("verification.stopHint")}
                  </span>
                </div>
              ) : null}
              {stopRequested ? (
                <div className="mt-1 text-[10px] text-orange-800">
                  {translator.t("verification.stopRequestedNote")}
                </div>
              ) : null}
              {stopNotice !== null ? (
                <div
                  className="mt-1 text-[10px] text-gray-600"
                  data-verification-stop-notice="true"
                >
                  {translator.t("verification.stopNoticeLabel")}
                  <span className="whitespace-pre-wrap break-words">
                    {verificationStopNoticeText(stopNotice, translator)}
                  </span>
                  {stopNotice.kind === "already_settled" && stopNotice.detail !== null ? (
                    <span className="mt-0.5 block whitespace-pre-wrap break-words text-gray-500">
                      {translator.t("detail.rawFailureDetail")}
                      {stopNotice.detail}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {stopError !== null ? (
                <div className="mt-1 text-[10px] text-red-700" data-verification-stop-error="true">
                  {translator.t("verification.stopFailed", {
                    code: stopError.code,
                    detail: stopError.message,
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* —— 操作登记核对区（5.2/D03/M01/D10：只呈现登记事实，不猜）—— */}
          {operationsUnknown ? (
            <div
              className="mt-1.5 rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-800"
              data-verification-operations-unknown="true"
            >
              {translator.t("verification.operationsUnknown")}
            </div>
          ) : matchedRecords.length > 0 ? (
            <div
              className="mt-1.5 rounded border border-gray-200 bg-white px-2 py-1"
              data-verification-records="true"
            >
              <div className="text-[10px] font-medium text-gray-500">
                {translator.t("verification.recordsTitle")}
              </div>
              {matchedRecords.map((record) => (
                <div
                  key={record.operationId}
                  className="mt-0.5 text-[11px] leading-4 text-gray-700"
                >
                  {verificationRecordLine(record, translator)}
                  {record.verificationIds.length > 0 ? (
                    <span className="ml-1 font-code text-[10px] text-gray-500">
                      {translator.t("verification.recordsVerifyLabel", {
                        ids: record.verificationIds.join("、"),
                      })}
                    </span>
                  ) : null}
                  {record.preparationIds.length > 0 ? (
                    <span className="ml-1 font-code text-[10px] text-gray-500">
                      {translator.t("verification.recordsPrepareLabel", {
                        ids: record.preparationIds.join("、"),
                      })}
                    </span>
                  ) : null}
                  {record.errorCode !== null ? (
                    <span className="ml-1 text-red-700">（{record.errorCode}）</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {/* —— 验证记录与有界日志（5.3/D09/P13/P16：只读可信身份；零执行零补写）—— */}
          {trustedVerificationIds.length > 0 ? (
            <div
              className="mt-1.5 rounded border border-sky-200 bg-sky-50/40 px-2 py-1"
              data-verification-reading="true"
            >
              <div className="text-[10px] font-medium text-gray-500">
                {translator.t("verification.readingTitle")}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                {trustedVerificationIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    data-verification-record-focus={id}
                    aria-pressed={recordFocus === id ? "true" : undefined}
                    onClick={() => onFocusRecord(id)}
                    className={`max-w-full break-all rounded border px-1.5 py-0.5 text-left font-code text-[10px] ${FOCUS_RING} ${
                      recordFocus === id
                        ? "border-sky-500 bg-sky-100 text-sky-900"
                        : "border-gray-300 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {id}
                  </button>
                ))}
              </div>

              {recordFocus === null ? (
                <div className="mt-1 text-[10px] text-gray-500">
                  {translator.t("verification.readingPick")}
                </div>
              ) : (
                <div className="mt-1" data-verification-record-view="true">
                  {recordState === "loading" ? (
                    <div className="text-[10px] text-gray-500">
                      {translator.t("verification.readingLoading")}
                    </div>
                  ) : null}
                  {recordError !== null ? (
                    <div className="text-[10px] text-red-700">
                      {translator.t("verification.recordReadFailed", {
                        code: recordError.code,
                        detail: recordError.message,
                      })}
                    </div>
                  ) : null}
                  {recordState === "ready" && recordView !== null && recordStatus !== null ? (
                    <div className="space-y-0.5 text-[11px] leading-4 text-gray-700">
                      <div>{verificationStatusLine(recordStatus, recordErrorInfo, translator)}</div>
                      <div className="text-[10px] text-gray-500">
                        {translator.t("verification.recordEvents", {
                          count: recordView.eventCount,
                        })}
                        {recordView.stages.length > 0
                          ? ` · ${translator.t("verification.recordStages", {
                              stages: recordView.stages.join(" → "),
                            })}`
                          : ""}
                      </div>
                      {recordView.terminated ? (
                        <div>
                          {translator.t("verification.recordOutcome", {
                            outcome: recordView.outcome ?? "",
                            label: verificationOutcomeLabel(recordView.outcome ?? "", translator),
                            detail: recordView.detail ?? "",
                          })}
                          {" · "}
                          {translator.t(
                            recordView.evidenceComplete === true
                              ? "verification.evidenceComplete"
                              : "verification.evidenceIncomplete",
                          )}
                        </div>
                      ) : (
                        <div className="text-amber-800">
                          {translator.t("verification.recordNotSealed")}
                        </div>
                      )}
                      {recordView.commandEnds.map((entry) => (
                        <div
                          key={`${recordFocus}-${entry.commandId}`}
                          className="mt-1 rounded border border-gray-200 bg-white px-1.5 py-1"
                          data-verification-command-end={entry.commandId}
                        >
                          <div>
                            {translator.t("verification.commandEndLine", {
                              commandId: entry.commandId,
                              exit:
                                entry.exitCode === null
                                  ? translator.t("verification.commandExitUnknown")
                                  : translator.t("verification.commandExit", {
                                      exitCode: entry.exitCode,
                                    }),
                              duration: translator.t("verification.commandDuration", {
                                durationMs: entry.durationMs,
                              }),
                            })}
                          </div>
                          <div className="text-[10px] text-gray-500">
                            {translator.t("verification.commandStdout", {
                              bytes: formatBytes(entry.stdoutBytes),
                              extra: entry.stdoutTruncated
                                ? translator.t("verification.commandStreamExtra", {
                                    totalBytes: formatBytes(entry.stdoutTotalBytes),
                                  })
                                : "",
                            })}
                            {" · "}
                            {translator.t("verification.commandStderr", {
                              bytes: formatBytes(entry.stderrBytes),
                              extra: entry.stderrTruncated
                                ? translator.t("verification.commandStreamExtra", {
                                    totalBytes: formatBytes(entry.stderrTotalBytes),
                                  })
                                : "",
                            })}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1">
                            {(["stdout", "stderr"] as const).map((stream) => (
                              <button
                                key={stream}
                                type="button"
                                data-verification-read-log={`${entry.commandId}:${stream}`}
                                onClick={() => onReadLog(entry.commandId, stream, "replace")}
                                className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                              >
                                {translator.t(
                                  stream === "stdout"
                                    ? "verification.readStdout"
                                    : "verification.readStderr",
                                )}
                              </button>
                            ))}
                            <span className="text-[10px] text-gray-400">
                              {translator.t("verification.logSliceHint")}
                            </span>
                          </div>
                        </div>
                      ))}
                      {recordView.commandEnds.length === 0 ? (
                        <div className="text-[10px] text-gray-500">
                          {translator.t("verification.noCommandFacts")}
                        </div>
                      ) : null}

                      {/* —— 5.5 导出所测输入（W03/W04/D08：绑定该验证的精确快照）—— */}
                      {recordMeta !== null ? (
                        <div
                          className="mt-1 rounded border border-slate-300 bg-slate-50 px-1.5 py-1"
                          data-verification-export="true"
                        >
                          <div className="text-[10px] font-medium text-gray-600">
                            {translator.t("verification.exportTitle")}
                          </div>
                          <div className="text-[10px] text-gray-500">
                            {translator.t("verification.exportBinding", {
                              runId: recordMeta.runId,
                              checkpoint: metaCheckpointLabel(recordMeta, translator),
                              snapshotId: recordMeta.snapshotId,
                            })}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              data-verification-export-start="true"
                              disabled={recordStatus !== "sealed"}
                              onClick={onExportInput}
                              className={`rounded border border-slate-400 px-1.5 py-0.5 text-[10px] text-slate-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
                            >
                              {translator.t("verification.exportStart")}
                            </button>
                            {recordStatus === "sealed" ? (
                              <span className="text-[10px] text-gray-500">
                                {translator.t("verification.exportSealedHint")}
                              </span>
                            ) : (
                              <span
                                data-verification-export-blocked="true"
                                className="text-[10px] text-amber-800"
                              >
                                {translator.t("verification.exportBlocked")}
                              </span>
                            )}
                          </div>
                          {exportFeedback !== null ? (
                            <VerificationExportFeedbackBody
                              feedback={exportFeedback}
                              expectedSnapshotId={recordMeta.snapshotId}
                              translator={translator}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* 日志切片视图（身份 + 正文 + 分页事实） */}
                  {logIdentity !== null ? (
                    <div
                      className="mt-1 rounded border border-gray-200 bg-white px-1.5 py-1"
                      data-verification-log-view="true"
                    >
                      <div className="text-[10px] text-gray-500">
                        {logIdentity.verificationId} · {logIdentity.commandId} ·{" "}
                        {logIdentity.stream}
                        {logState === "loading"
                          ? translator.t("verification.logLoadingSuffix")
                          : ""}
                      </div>
                      {logError !== null ? (
                        <div
                          className="mt-0.5 text-[10px] text-red-700"
                          data-verification-log-error="true"
                        >
                          {translator.t("verification.logReadFailed", {
                            code: logError.code,
                            detail: logError.message,
                          })}
                          {logError.code === "R3_LOG_ASSET_CORRUPT"
                            ? translator.t("verification.logAssetCorrupt")
                            : ""}
                          {logError.code === "R3_LOG_ASSET_MISSING"
                            ? translator.t("verification.logAssetMissing")
                            : ""}
                        </div>
                      ) : null}
                      {logState === "ready" && logMeta !== null ? (
                        <>
                          {/* 只读 textarea：原生可聚焦滚动（D11 键盘可达），不引入输入语义 */}
                          <textarea
                            readOnly
                            aria-label={translator.t("verification.logAria")}
                            value={logText}
                            rows={Math.min(12, Math.max(3, logText.split("\n").length))}
                            className="mt-0.5 w-full resize-y overflow-auto whitespace-pre-wrap break-all font-code text-[10px] leading-4 text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1"
                            data-verification-log-text="true"
                          />
                          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-500">
                            <span>
                              {translator.t("verification.logMeta", {
                                total: formatBytes(logMeta.totalBytes),
                                read: formatBytes(logMeta.nextOffset),
                              })}
                              {logMeta.remaining > 0
                                ? translator.t("verification.logRemaining", {
                                    remaining: formatBytes(logMeta.remaining),
                                  })
                                : ""}
                              {logMeta.truncated ? translator.t("verification.logTruncated") : ""}
                            </span>
                            {logMeta.remaining > 0 ? (
                              <button
                                type="button"
                                data-verification-log-continue="true"
                                onClick={() =>
                                  logIdentity === null
                                    ? undefined
                                    : onReadLog(logIdentity.commandId, logIdentity.stream, "append")
                                }
                                className={`rounded border border-gray-300 px-1.5 py-0.5 text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                              >
                                {translator.t("verification.logContinue")}
                              </button>
                            ) : null}
                            {logMeta.remaining === 0 ? (
                              <span>{translator.t("verification.logEnd")}</span>
                            ) : null}
                          </div>
                          {logMeta.truncated || logMeta.remaining > 0 ? (
                            <div className="mt-0.5 text-[10px] text-amber-800">
                              {translator.t("verification.logNotComplete")}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* —— 5.4 修复证据比较（D07/P24/P25：只读记录、显式 A/B、条件未知不合成）—— */}
          {compareCandidates.length > 0 ? (
            <div
              className="mt-1.5 rounded border border-violet-200 bg-violet-50/40 px-2 py-1"
              data-verification-compare="true"
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <div className="text-[10px] font-medium text-gray-500">
                  {translator.t("verification.compareSectionTitle")}
                </div>
                {compareLeft !== null || compareRight !== null ? (
                  <button
                    type="button"
                    data-compare-clear="true"
                    onClick={onClearCompare}
                    className={`rounded border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 ${FOCUS_RING}`}
                  >
                    {translator.t("verification.compareClear")}
                  </button>
                ) : null}
              </div>
              <div className="mt-0.5 grid gap-1 sm:grid-cols-2">
                {(["left", "right"] as const).map((side) => {
                  const selected = side === "left" ? compareLeft : compareRight;
                  const other = side === "left" ? compareRight : compareLeft;
                  return (
                    <div key={side} data-compare-side-selector={side}>
                      <div className="text-[10px] text-gray-500">
                        {translator.t(
                          side === "left"
                            ? "verification.compareSideA"
                            : "verification.compareSideB",
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        {compareCandidates.map((candidate) => {
                          const id = candidate.verificationId;
                          const isSelected = selected === id;
                          const isOther = other === id;
                          const source = compareCandidateSourceLine(candidate, translator);
                          return (
                            <button
                              key={id}
                              type="button"
                              data-compare-side={`${side}:${id}`}
                              aria-pressed={isSelected ? "true" : undefined}
                              disabled={isOther && !isSelected}
                              title={
                                isOther
                                  ? translator.t("verification.compareSelfTitle")
                                  : `${id} (${source})`
                              }
                              onClick={() => onSelectCompareSide(side, isSelected ? null : id)}
                              className={`max-w-full break-all rounded border px-1.5 py-0.5 text-left font-code text-[10px] ${FOCUS_RING} ${
                                isSelected
                                  ? "border-violet-500 bg-violet-100 text-violet-900"
                                  : "border-gray-300 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                              }`}
                            >
                              {id}
                            </button>
                          );
                        })}
                      </div>
                      {selected === null ? null : (
                        <div className="mt-0.5 text-[10px] text-gray-500">
                          {translator.t("verification.compareSourceLabel")}
                          {compareCandidateSourceLine(
                            compareCandidates.find((one) => one.verificationId === selected) ?? {
                              verificationId: selected,
                              runId: null,
                              checkpointKind: null,
                              stepSpanId: null,
                              commandId: null,
                              operationState: null,
                            },
                            translator,
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {compareLeft === null || compareRight === null ? (
                <div className="mt-1 text-[10px] text-gray-500">
                  {translator.t("verification.comparePickBoth")}
                </div>
              ) : (
                <div className="mt-1" data-compare-view="true">
                  {compareState === "loading" ? (
                    <div className="text-[10px] text-gray-500">
                      {translator.t("verification.compareLoading")}
                    </div>
                  ) : null}
                  {compareError !== null ? (
                    <div className="text-[10px] text-red-700" data-compare-error="true">
                      {compareError.code === "R3_COMPARE_SAME_ID"
                        ? translator.t("verification.compareSameId")
                        : translator.t("verification.compareReadFailed", {
                            code: compareError.code,
                            detail: compareError.message,
                          })}
                      <button
                        type="button"
                        data-compare-retry="true"
                        onClick={onRetryCompare}
                        className={`ml-1 rounded border border-gray-300 px-1.5 py-0.5 text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                      >
                        {translator.t("verification.compareRetry")}
                      </button>
                    </div>
                  ) : null}
                  {compareState === "ready" && comparison !== null ? (
                    <>
                      <div
                        data-compare-verdict={comparison.verdict.kind}
                        className={`rounded border px-1.5 py-1 text-[11px] leading-4 ${
                          comparison.verdict.kind === "failed-to-passed"
                            ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                            : comparison.verdict.kind === "same-conditions-other-outcome"
                              ? "border-gray-300 bg-gray-50 text-gray-800"
                              : "border-amber-300 bg-amber-50 text-amber-900"
                        }`}
                      >
                        {comparison.verdict.headline}
                        {comparison.verdict.kind === "conditions-differ" ? (
                          <div className="mt-0.5 text-[10px]">
                            {translator.t("verification.compareDifferences", {
                              list: comparison.verdict.differences.join("、"),
                            })}
                          </div>
                        ) : null}
                        {comparison.verdict.kind === "conditions-unknown" ? (
                          <div className="mt-0.5 text-[10px]">
                            {translator.t("verification.compareUnknowns", {
                              list: comparison.verdict.unknowns.join("、"),
                            })}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-1 grid gap-1 sm:grid-cols-2">
                        {(
                          [
                            ["left", comparison.left],
                            ["right", comparison.right],
                          ] as const
                        ).map(([side, view]) => (
                          <div
                            key={side}
                            data-compare-side-summary={side}
                            className="min-w-0 break-words rounded border border-gray-200 bg-white px-1.5 py-1 text-[10px] leading-4 text-gray-700"
                          >
                            <div className="font-medium">
                              {translator.t("verification.compareSideSummary", {
                                side: translator.t(
                                  side === "left"
                                    ? "verification.compareSideA"
                                    : "verification.compareSideB",
                                ),
                                verificationId: view.verificationId,
                              })}
                            </div>
                            <div>
                              {translator.t("verification.compareSideSource", {
                                runId:
                                  view.runId ?? translator.t("verification.compareRunUnknownShort"),
                                checkpoint:
                                  view.checkpointLabel ??
                                  translator.t("verification.compareCheckpointUnknown"),
                                status: sourceStatusLabel(view.sourceStatus, translator),
                              })}
                            </div>
                            <div>
                              {translator.t("verification.compareSnapshot", {
                                snapshotId:
                                  view.snapshotId ??
                                  translator.t("verification.compareUnknownShort"),
                              })}
                            </div>
                            <div>
                              {translator.t("verification.compareIntervention", {
                                intervention: view.intervention,
                              })}
                            </div>
                            <div>
                              {translator.t("verification.compareOutcome", {
                                outcome:
                                  view.outcome ?? translator.t("verification.compareUnknownShort"),
                                label:
                                  view.outcome === null
                                    ? ""
                                    : translator.t("verification.compareOutcomeLabel", {
                                        label: verificationOutcomeLabel(view.outcome, translator),
                                      }),
                              })}
                              {" · "}
                              {translator.t("verification.compareEvidence", {
                                status:
                                  view.evidenceComplete === null
                                    ? translator.t("verification.evidenceUnknown")
                                    : translator.t(
                                        view.evidenceComplete
                                          ? "verification.evidenceComplete"
                                          : "verification.evidenceIncomplete",
                                      ),
                              })}
                            </div>
                            <div>
                              {translator.t("verification.compareExit", {
                                exit:
                                  view.exitCode === null
                                    ? translator.t("verification.compareUnknownShort")
                                    : view.exitCode,
                                duration:
                                  view.durationMs === null
                                    ? translator.t("verification.compareUnknownShort")
                                    : `${view.durationMs}ms`,
                              })}
                            </div>
                            <div>
                              {view.logBytes === null
                                ? translator.t("verification.compareNoCommandFacts")
                                : translator.t("verification.compareLogs", {
                                    stdout: formatBytes(view.logBytes.stdout),
                                    stderr: formatBytes(view.logBytes.stderr),
                                    stdoutTotal: formatBytes(view.logBytes.stdoutTotal),
                                    stderrTotal: formatBytes(view.logBytes.stderrTotal),
                                  })}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-600">
                        <span>
                          {translator.t("verification.compareCodeSame", {
                            status:
                              comparison.codeSame === null
                                ? translator.t("verification.codeSameUnknown")
                                : translator.t(
                                    comparison.codeSame
                                      ? "verification.codeSameYes"
                                      : "verification.codeSameNo",
                                  ),
                          })}
                        </span>
                        {canOpenCompareDiff ? (
                          <button
                            type="button"
                            data-compare-open-diff="true"
                            onClick={onOpenCompareDiff}
                            className={`rounded border border-gray-300 px-1.5 py-0.5 text-gray-700 hover:bg-gray-50 ${FOCUS_RING}`}
                          >
                            {translator.t("verification.compareOpenDiff")}
                          </button>
                        ) : (
                          <span data-compare-no-diff="true">
                            {translator.t(
                              comparison.left.runId !== null &&
                                comparison.left.runId === comparison.right.runId
                                ? "verification.compareNoDiffSameRun"
                                : "verification.compareNoDiffMissingRun",
                            )}
                          </span>
                        )}
                      </div>

                      <div className="mt-1" data-compare-conditions="true">
                        <div className="text-[10px] text-gray-500">
                          {translator.t("verification.compareConditionsTitle")}
                        </div>
                        {comparison.conditions.map((entry) => (
                          <div
                            key={entry.key}
                            data-compare-condition={entry.key}
                            data-compare-state={entry.state}
                            className="mt-0.5 break-all rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] leading-4"
                          >
                            {translator.t("verification.compareConditionLine", {
                              label: entry.label,
                              left:
                                entry.left ??
                                translator.t("verification.compareConditionUnrecorded"),
                              right:
                                entry.right ??
                                translator.t("verification.compareConditionUnrecorded"),
                            })}
                            <span
                              className={
                                entry.state === "same"
                                  ? "ml-1 text-emerald-700"
                                  : entry.state === "different"
                                    ? "ml-1 text-red-700"
                                    : "ml-1 text-amber-700"
                              }
                            >
                              {compareConditionStateLabel(entry.state, translator)}
                            </span>
                          </div>
                        ))}
                      </div>

                      <ul
                        className="mt-1 list-disc pl-4 text-[10px] leading-4 text-gray-500"
                        data-compare-limitations="true"
                      >
                        {comparison.limitations.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* —— 提交失败（请求层：门内拒绝稳定码 / 本地拒发）—— */}
          {submitError !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-red-400 bg-red-50 px-2 py-1 text-red-800"
              data-verification-submit-error="true"
            >
              <div>
                {translator.t("verification.submitFailedSummary", { code: submitError.code })}
              </div>
              {submitError.message.trim() === "" ? null : (
                <div className="mt-0.5 whitespace-pre-wrap break-words text-red-700">
                  {translator.t("verification.submitRawDetail")}
                  {submitError.message}
                </div>
              )}
            </div>
          ) : null}

          {/* —— 最近一次明确收尾（D04 分层：请求收尾 / 测试结局 / 证据完整性分行）—— */}
          {lastOutcome !== null ? (
            <div
              className="mt-1.5 rounded border-l-2 border-sky-400 bg-sky-50 px-2 py-1 text-sky-900"
              data-verification-outcome="true"
            >
              {lastOutcome.kind === "prepare" ? (
                <div>
                  <div>{translator.t("verification.outcomePrepareRequestDone")}</div>
                  <div>
                    {translator.t("verification.outcomePrepareFacts", {
                      preparationId: lastOutcome.preparationId,
                      imageDigest: lastOutcome.imageDigest,
                    })}
                  </div>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <div>{translator.t("verification.outcomeRunRequestDone")}</div>
                  <div>
                    {translator.t("verification.outcomeTestOutcome", {
                      outcome: lastOutcome.outcome ?? "",
                      label: verificationOutcomeLabel(lastOutcome.outcome ?? "", translator),
                    })}
                  </div>
                  <div>
                    {translator.t("verification.outcomeEvidence", {
                      status:
                        lastOutcome.evidenceComplete === false
                          ? translator.t("verification.outcomeEvidenceIncompleteLong")
                          : translator.t("verification.evidenceComplete"),
                      detail: lastOutcome.detail ?? "",
                    })}
                  </div>
                  {lastOutcome.verificationId !== undefined ? (
                    <div className="text-[10px] text-gray-500">
                      {translator.t("verification.outcomeIdentity", {
                        verificationId: lastOutcome.verificationId,
                      })}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 条件表（精确输入 + 当前条件；capability/plan 缺席时如实说明缺什么） */
function conditionRows({
  capability,
  capabilityState,
  plan,
  planState,
  translator,
}: {
  capability: VerificationCapabilityResult | null;
  capabilityState: VerificationPanelProps["capabilityState"];
  plan: VerificationPreparePlanResult | null;
  planState: VerificationPanelProps["planState"];
  translator: PanelTranslator;
}): readonly ConfirmationRow[] {
  const rows: ConfirmationRow[] = [];
  if (capabilityState === "error") {
    rows.push({
      label: translator.t("verification.conditionCapability"),
      value: translator.t("verification.conditionCapabilityFailed"),
    });
  } else if (capability === null) {
    rows.push({
      label: translator.t("verification.conditionCapability"),
      value: translator.t("verification.conditionCapabilityPending"),
    });
  } else {
    rows.push({
      label: translator.t("verification.fieldExactInput"),
      value:
        capability.source === null
          ? translator.t("verification.sourceNotReady")
          : translator.t("verification.sourceSnapshot", {
              snapshotId: capability.source.snapshotId,
              count: capability.source.fileCount,
              totalBytes: formatBytes(capability.source.totalBytes),
            }),
    });
    rows.push({
      label: translator.t("verification.fieldPrepared"),
      value:
        capability.prepared === null
          ? translator.t("verification.preparedMissing")
          : translator.t("verification.preparedSummary", {
              preparationId: capability.prepared.preparationId,
              imageDigest: capability.prepared.imageDigest,
              node: capability.prepared.toolchain.node,
              typescript: capability.prepared.toolchain.typescript,
            }),
    });
    rows.push({
      label: translator.t("verification.fieldBackend"),
      value: capability.engine.available
        ? translator.t("verification.backendEngine", {
            version:
              capability.engine.engineVersion ?? translator.t("verification.backendVersionUnknown"),
          })
        : translator.t("verification.backendUnavailable", {
            reason: capability.engine.reason ?? translator.t("verification.reasonMissing"),
          }),
    });
    rows.push({
      label: translator.t("verification.fieldPlanToken"),
      value: capability.planToken,
    });
    const summary = capability.profileSummary;
    rows.push({
      label: translator.t("verification.fieldProfile"),
      value: translator.t("verification.profileSummary", {
        profileId: summary.profileId,
        manifestVersion: summary.manifestVersion,
        platform: summary.platform,
        sourceIncludeGlob: summary.sourceIncludeGlob,
      }),
    });
  }
  if (planState === "error") {
    rows.push({
      label: translator.t("verification.fieldPreparePlan"),
      value: translator.t("verification.planPreviewFailed"),
    });
  } else if (plan === null) {
    rows.push({
      label: translator.t("verification.fieldPreparePlan"),
      value: translator.t("verification.planPending"),
    });
  } else {
    rows.push({
      label: translator.t("verification.fieldPreparePlan"),
      value: translator.t("verification.planSummary", {
        count: plan.plan.downloads.length,
        space: formatBytes(plan.plan.spaceEstimateBytes),
      }),
    });
  }
  return rows;
}
